import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { FlowError, isRetryable, toFlowError } from "../errors.js";
import { log } from "../logger.js";
import type { BatchRecord, GenerationResult, GenerationSpec, JobRecord, JobStatus } from "../types.js";

export interface ExecutionContext {
  signal: AbortSignal;
  setPhase: (phase: string) => void;
}

export type Executor = (job: JobRecord, context: ExecutionContext) => Promise<GenerationResult>;

const TERMINAL: ReadonlySet<JobStatus> = new Set(["completed", "failed", "cancelled", "interrupted"]);
const MAX_EVENTS = 40;
const MAX_STORED_JOBS = 1_000;

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL.has(status);
}

/**
 * In-process async job queue with:
 *  - global concurrency cap + per-batch concurrency
 *  - exponential backoff with jitter for retryable failures (rate limit, 5xx, timeouts)
 *  - persistence to <dataDir>/jobs.json (running jobs become "interrupted" after a restart)
 */
export class JobQueue {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly batches = new Map<string, BatchRecord>();
  private readonly running = new Map<string, AbortController>();
  private readonly waiters = new Map<string, Array<(job: JobRecord) => void>>();
  private readonly retryTimers = new Map<string, NodeJS.Timeout>();
  private readonly storeFile = path.join(config.dataDir, "jobs.json");
  private saveTimer: NodeJS.Timeout | undefined;
  private executor: Executor | undefined;

  constructor(private readonly globalLimit: number = config.maxConcurrency) {
    this.load();
  }

  setExecutor(executor: Executor): void {
    this.executor = executor;
  }

  /** Called whenever a job reaches a terminal state. */
  onJobFinished: ((job: JobRecord, batch?: BatchRecord) => void | Promise<void>) | undefined;

  // ------------------------------------------------------------- public API

  enqueue(spec: GenerationSpec, options: { batchId?: string; maxRetries?: number } = {}): JobRecord {
    const job: JobRecord = {
      id: randomUUID(),
      ...(options.batchId ? { batchId: options.batchId } : {}),
      spec,
      status: "queued",
      attempts: 0,
      maxRetries: options.maxRetries ?? config.maxRetries,
      createdAt: new Date().toISOString(),
      events: [],
    };
    this.jobs.set(job.id, job);
    this.event(job, "queued");
    this.schedulePump();
    return job;
  }

  createBatch(input: { projectName: string; projectDir: string; concurrency: number; specs: GenerationSpec[]; maxRetries?: number }): BatchRecord {
    const batch: BatchRecord = {
      id: `batch_${new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14)}_${randomUUID().slice(0, 6)}`,
      projectName: input.projectName,
      projectDir: input.projectDir,
      concurrency: Math.max(1, Math.min(input.concurrency, this.globalLimit)),
      createdAt: new Date().toISOString(),
      jobIds: [],
    };
    this.batches.set(batch.id, batch);
    for (const spec of input.specs) {
      const job = this.enqueue(spec, { batchId: batch.id, ...(input.maxRetries !== undefined ? { maxRetries: input.maxRetries } : {}) });
      batch.jobIds.push(job.id);
    }
    this.save();
    return batch;
  }

  getJob(id: string): JobRecord | undefined {
    return this.jobs.get(id);
  }

  getBatch(id: string): BatchRecord | undefined {
    return this.batches.get(id);
  }

  listJobs(): JobRecord[] {
    return [...this.jobs.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  listBatches(): BatchRecord[] {
    return [...this.batches.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  get limit(): number {
    return this.globalLimit;
  }

  get runningCount(): number {
    return this.running.size;
  }

  /** Resolves when the job is terminal, or with its current state after `timeoutMs`. */
  waitFor(jobId: string, timeoutMs: number): Promise<JobRecord> {
    const job = this.jobs.get(jobId);
    if (!job) return Promise.reject(new FlowError("validation_error", `Unknown job ${jobId}`));
    if (isTerminal(job.status)) return Promise.resolve(job);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const list = this.waiters.get(jobId) ?? [];
        this.waiters.set(jobId, list.filter((item) => item !== done));
        resolve(job);
      }, timeoutMs);
      const done = (finished: JobRecord) => {
        clearTimeout(timer);
        resolve(finished);
      };
      this.waiters.set(jobId, [...(this.waiters.get(jobId) ?? []), done]);
    });
  }

  /** Cancels a job or every unfinished job of a batch. */
  cancel(id: string): string[] {
    const ids = this.batches.get(id)?.jobIds ?? (this.jobs.has(id) ? [id] : []);
    if (!ids.length) throw new FlowError("validation_error", `No job or batch with id ${id}`);
    const cancelled: string[] = [];
    for (const jobId of ids) {
      const job = this.jobs.get(jobId);
      if (!job || isTerminal(job.status)) continue;
      const controller = this.running.get(jobId);
      if (controller) controller.abort();
      else this.finish(job, "cancelled", { error: "Cancelled by user." });
      clearTimeout(this.retryTimers.get(jobId));
      this.retryTimers.delete(jobId);
      cancelled.push(jobId);
    }
    return cancelled;
  }

  batchSummary(batch: BatchRecord) {
    const jobs = batch.jobIds.map((id) => this.jobs.get(id)).filter((job): job is JobRecord => Boolean(job));
    const count = (status: JobStatus) => jobs.filter((job) => job.status === status).length;
    const done = jobs.filter((job) => isTerminal(job.status)).length;
    return {
      batch_id: batch.id,
      project_name: batch.projectName,
      project_dir: batch.projectDir,
      concurrency: batch.concurrency,
      created_at: batch.createdAt,
      finished_at: batch.finishedAt,
      total: jobs.length,
      progress_percent: jobs.length ? Math.round((done / jobs.length) * 100) : 100,
      counts: {
        queued: count("queued"),
        running: count("running"),
        retry_wait: count("retry_wait"),
        completed: count("completed"),
        failed: count("failed"),
        cancelled: count("cancelled"),
        interrupted: count("interrupted"),
      },
      done: done === jobs.length,
    };
  }

  // ------------------------------------------------------------- scheduling

  private schedulePump(): void {
    setImmediate(() => this.pump());
  }

  private pump(): void {
    if (!this.executor) return;
    while (this.running.size < this.globalLimit) {
      const next = this.nextEligible();
      if (!next) return;
      void this.run(next);
    }
  }

  private nextEligible(): JobRecord | undefined {
    for (const job of this.listJobs()) {
      if (job.status !== "queued") continue;
      if (job.batchId) {
        const batch = this.batches.get(job.batchId);
        const active = batch ? batch.jobIds.filter((id) => this.running.has(id)).length : 0;
        if (batch && active >= batch.concurrency) continue;
      }
      return job;
    }
    return undefined;
  }

  private async run(job: JobRecord): Promise<void> {
    const controller = new AbortController();
    this.running.set(job.id, controller);
    job.status = "running";
    job.attempts += 1;
    job.startedAt ??= new Date().toISOString();
    delete job.nextRetryAt;
    this.event(job, `attempt ${job.attempts}/${job.maxRetries + 1} started`);
    try {
      const result = await this.executor!(job, {
        signal: controller.signal,
        setPhase: (phase) => {
          if (job.phase !== phase) {
            job.phase = phase;
            this.event(job, phase);
          }
        },
      });
      this.finish(job, "completed", { result });
    } catch (raw) {
      const error = toFlowError(raw);
      if (error.diagnosticScreenshot) job.diagnosticScreenshot = error.diagnosticScreenshot;
      if (controller.signal.aborted || error.code === "cancelled") {
        this.finish(job, "cancelled", { error: "Cancelled by user." });
      } else if (isRetryable(error) && job.attempts <= job.maxRetries) {
        const delay = this.backoff(job.attempts, error.code === "rate_limited");
        job.status = "retry_wait";
        job.error = error.message;
        job.errorCode = error.code;
        job.nextRetryAt = new Date(Date.now() + delay).toISOString();
        this.event(job, `${error.code}: ${error.message} — retry in ${Math.round(delay / 1000)}s`);
        log.warn(`Job ${job.id} failed (${error.code}); retry ${job.attempts}/${job.maxRetries} in ${Math.round(delay / 1000)}s`);
        const timer = setTimeout(() => {
          this.retryTimers.delete(job.id);
          if (job.status === "retry_wait") {
            job.status = "queued";
            this.schedulePump();
          }
        }, delay);
        this.retryTimers.set(job.id, timer);
      } else {
        this.finish(job, "failed", { error: error.message, errorCode: error.code });
      }
    } finally {
      this.running.delete(job.id);
      this.save();
      this.schedulePump();
    }
  }

  /** base * 2^(attempt-1), doubled for rate limits, capped at 10 min, +0-25% jitter. */
  private backoff(attempt: number, rateLimited: boolean): number {
    const raw = config.retryBaseMs * 2 ** (attempt - 1) * (rateLimited ? 2 : 1);
    const capped = Math.min(raw, 10 * 60_000);
    return Math.round(capped * (1 + Math.random() * 0.25));
  }

  private finish(job: JobRecord, status: JobStatus, patch: Partial<JobRecord>): void {
    Object.assign(job, patch);
    job.status = status;
    job.finishedAt = new Date().toISOString();
    if (status === "completed") {
      delete job.error;
      delete job.errorCode;
    }
    delete job.phase;
    this.event(job, status === "failed" ? `failed: ${job.error}` : status);
    for (const resolve of this.waiters.get(job.id) ?? []) resolve(job);
    this.waiters.delete(job.id);

    const batch = job.batchId ? this.batches.get(job.batchId) : undefined;
    if (batch && batch.jobIds.every((id) => isTerminal(this.jobs.get(id)?.status ?? "failed"))) {
      batch.finishedAt = new Date().toISOString();
      log.info(`Batch ${batch.id} finished.`);
    }
    Promise.resolve(this.onJobFinished?.(job, batch)).catch((error) => log.error("onJobFinished hook failed", error));
    this.save();
  }

  private event(job: JobRecord, message: string): void {
    job.events.push({ at: new Date().toISOString(), message });
    if (job.events.length > MAX_EVENTS) job.events.splice(0, job.events.length - MAX_EVENTS);
  }

  // ------------------------------------------------------------ persistence

  private load(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.storeFile, "utf8")) as { jobs?: JobRecord[]; batches?: BatchRecord[] };
      for (const batch of parsed.batches ?? []) this.batches.set(batch.id, batch);
      for (const job of parsed.jobs ?? []) {
        if (!isTerminal(job.status)) {
          job.status = "interrupted";
          job.error = "MCP server restarted while this job was pending. Re-submit it if needed.";
          job.finishedAt = new Date().toISOString();
        }
        this.jobs.set(job.id, job);
      }
    } catch {
      // First run.
    }
  }

  private save(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 300);
  }

  flush(): void {
    try {
      mkdirSync(path.dirname(this.storeFile), { recursive: true });
      const jobs = this.listJobs().slice(-MAX_STORED_JOBS);
      const keep = new Set(jobs.map((job) => job.batchId).filter(Boolean));
      const batches = this.listBatches().filter((batch) => keep.has(batch.id));
      writeFileSync(this.storeFile, JSON.stringify({ jobs, batches }, null, 2), "utf8");
    } catch (error) {
      log.warn("Could not persist job store", error);
    }
  }
}
