#!/usr/bin/env node
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BrowserSession } from "./browser/session.js";
import { config } from "./config.js";
import { errorText, FlowError } from "./errors.js";
import { FlowGenerator } from "./flow/generator.js";
import { checkSession, healthCheck } from "./health.js";
import { isProjectUrl } from "./flow/urls.js";
import { log } from "./logger.js";
import { updateManifest } from "./output/manifest.js";
import { projectDirectory, resolveOutputRoot } from "./output/naming.js";
import { JobQueue, isTerminal } from "./queue/job-queue.js";
import { ASPECT_RATIOS, CAMERA_MOTIONS, type CameraMotion, type GenerationSpec, type JobRecord, type MediaKind } from "./types.js";

const VERSION = "1.1.0";

// ------------------------------------------------------------------ wiring

const session = new BrowserSession();
const generator = new FlowGenerator(session);
const queue = new JobQueue(config.maxConcurrency);
queue.setExecutor((job, context) => generator.run(job, context));
queue.onJobFinished = async (_job, batch) => {
  if (!batch) return;
  const summary = queue.batchSummary(batch);
  const failures = batch.jobIds
    .map((id) => queue.getJob(id))
    .filter((job): job is JobRecord => Boolean(job) && ["failed", "cancelled", "interrupted"].includes(job!.status))
    .map((job) => ({
      job_id: job.id,
      ...(job.spec.sceneId ? { scene_id: job.spec.sceneId } : {}),
      ...(job.spec.takeNumber ? { take_number: job.spec.takeNumber } : {}),
      error: job.error ?? job.status,
    }));
  await updateManifest(batch.projectDir, batch.projectName, (manifest) => {
    manifest.batches[batch.id] = {
      batch_id: batch.id,
      created_at: batch.createdAt,
      ...(batch.finishedAt ? { finished_at: batch.finishedAt } : {}),
      concurrency: batch.concurrency,
      total: summary.total,
      completed: summary.counts.completed,
      failed: summary.counts.failed + summary.counts.cancelled + summary.counts.interrupted,
      failures,
    };
  });
};

// ----------------------------------------------------------------- helpers

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function ok(value: unknown): ToolResult {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

function failed(error: unknown): ToolResult {
  log.warn("Tool failed", error instanceof Error ? error.message : error);
  return { content: [{ type: "text", text: errorText(error) }], isError: true };
}

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

function validateImage(file: string, field: string): string {
  if (!path.isAbsolute(file)) throw new FlowError("validation_error", `${field} must be an absolute path: ${file}`);
  const resolved = path.resolve(file);
  if (!existsSync(resolved) || !statSync(resolved).isFile()) throw new FlowError("validation_error", `${field} not found: ${resolved}`);
  if (!IMAGE_EXTENSIONS.has(path.extname(resolved).toLowerCase())) {
    throw new FlowError("validation_error", `${field} must be .png, .jpg, .jpeg or .webp: ${resolved}`);
  }
  return resolved;
}

const CAMERA_ALIASES: Record<string, CameraMotion> = { pan: "pan_right", tilt: "tilt_up", zoom: "zoom_in", dolly: "dolly_in", orbit: "orbit_right" };
const normalizeCamera = (value?: string): CameraMotion | undefined =>
  value ? (CAMERA_ALIASES[value] ?? (value as CameraMotion)) : undefined;

interface SpecInput {
  mediaType: MediaKind;
  prompt: string;
  aspect_ratio?: (typeof ASPECT_RATIOS)[number];
  camera_motion?: string;
  outputs_count?: number;
  model?: string;
  start_frame?: string;
  end_frame?: string;
  reference_images?: string[];
  project_name?: string;
  scene_id?: string | number;
  take_number?: number;
  output_dir?: string;
  flow_project_url?: string;
  timeout_seconds?: number;
  overwrite?: boolean;
}

function buildSpec(input: SpecInput): GenerationSpec {
  const outputDir = resolveOutputRoot(input.output_dir ?? config.outputRoot);
  const camera = input.mediaType === "video" ? normalizeCamera(input.camera_motion) : undefined;
  if (input.flow_project_url && !isProjectUrl(input.flow_project_url)) {
    throw new FlowError("validation_error", "flow_project_url must be a Flow project URL, e.g. https://flow.google.com/project/<id>.");
  }
  return {
    mediaType: input.mediaType,
    prompt: input.prompt.trim(),
    ...(input.aspect_ratio ? { aspectRatio: input.aspect_ratio } : {}),
    ...(camera ? { cameraMotion: camera } : {}),
    outputsCount: input.outputs_count ?? 1,
    ...(input.model ? { model: input.model } : {}),
    ...(input.start_frame ? { startFrame: validateImage(input.start_frame, "start_frame") } : {}),
    ...(input.end_frame ? { endFrame: validateImage(input.end_frame, "end_frame") } : {}),
    referenceImages: (input.reference_images ?? []).map((file, index) => validateImage(file, `reference_images[${index}]`)),
    projectName: input.project_name?.trim() || "Flow_Project",
    ...(input.scene_id !== undefined && String(input.scene_id).trim() ? { sceneId: String(input.scene_id).trim() } : {}),
    ...(input.take_number ? { takeNumber: input.take_number } : {}),
    outputDir,
    ...(input.flow_project_url ? { flowProjectUrl: input.flow_project_url } : {}),
    timeoutSeconds: input.timeout_seconds ?? config.generationTimeoutSeconds,
    overwrite: input.overwrite ?? false,
  };
}

function jobView(job: JobRecord, verbose = false) {
  return {
    job_id: job.id,
    ...(job.batchId ? { batch_id: job.batchId } : {}),
    status: job.status,
    ...(job.phase ? { phase: job.phase } : {}),
    media_type: job.spec.mediaType,
    scene_id: job.spec.sceneId,
    take_number: job.spec.takeNumber,
    prompt: job.spec.prompt.length > 140 ? `${job.spec.prompt.slice(0, 140)}…` : job.spec.prompt,
    attempts: job.attempts,
    max_retries: job.maxRetries,
    ...(job.nextRetryAt ? { next_retry_at: job.nextRetryAt } : {}),
    ...(job.error ? { error: job.error, error_code: job.errorCode } : {}),
    ...(job.diagnosticScreenshot ? { diagnostic_screenshot: job.diagnosticScreenshot } : {}),
    ...(job.result
      ? {
          files: job.result.files.map((file) => file.path),
          manifest: job.result.manifestPath,
          flow_project_url: job.result.flowProjectUrl,
          applied_via: job.result.applied,
          warnings: job.result.warnings,
          ...(verbose ? { final_prompt_sent: job.result.finalPrompt, file_details: job.result.files } : {}),
        }
      : {}),
    created_at: job.createdAt,
    ...(job.startedAt ? { started_at: job.startedAt } : {}),
    ...(job.finishedAt ? { finished_at: job.finishedAt } : {}),
    ...(verbose ? { events: job.events } : {}),
  };
}

async function enqueueAndMaybeWait(spec: GenerationSpec, wait: boolean, waitSeconds: number, maxRetries?: number): Promise<ToolResult> {
  const job = queue.enqueue(spec, maxRetries !== undefined ? { maxRetries } : {});
  if (!wait) {
    return ok({ ...jobView(job), message: "Queued in background. Poll flow_get_queue_status with job_id." });
  }
  const finished = await queue.waitFor(job.id, waitSeconds * 1_000);
  const view = jobView(finished);
  if (!isTerminal(finished.status)) {
    return ok({ ...view, message: `Still ${finished.status} after ${waitSeconds}s. It continues in background; poll flow_get_queue_status with job_id '${job.id}'.` });
  }
  if (finished.status !== "completed") return { ...ok(view), isError: true };
  return ok(view);
}

// ------------------------------------------------------------------ schemas

const zPrompt = z.string().min(3).max(5_000).describe("Prompt text (any language; English often gives the best Veo results).");
const zAspect = z.enum(ASPECT_RATIOS).optional().describe("Aspect ratio set in Flow's UI: 16:9 (horizontal), 9:16 (vertical), 1:1 (square). If the control is missing it is added to the prompt.");
const zCamera = z
  .enum([...CAMERA_MOTIONS, "pan", "tilt", "zoom", "dolly", "orbit"])
  .optional()
  .describe("Camera movement. Applied via Flow's camera control when present, otherwise as a cinematic prompt directive. Aliases: pan=pan_right, tilt=tilt_up, zoom=zoom_in, dolly=dolly_in, orbit=orbit_right.");
const zOutputs = z.number().int().min(1).max(4).default(1).describe("Number of variations (1-4). Multiple outputs are saved as _v1.._v4.");
const zModel = z.string().min(2).max(80).optional().describe("Optional model name as shown in Flow (e.g. 'Veo 3.1 - Fast', 'Veo 3.1 - Quality', 'Nano Banana Pro'). Omit to keep Flow's current default.");
const zProject = z.string().min(1).max(80).default("Flow_Project").describe("Project name. Files go to <output_dir>/<project_name>/Assets_Flow/ and manifest.json to <output_dir>/<project_name>/.");
const zScene = z.union([z.string().max(40), z.number().int().min(0)]).optional().describe("Scene id. Numbers are zero-padded: 1 -> Scene_01.");
const zTake = z.number().int().min(1).max(999).optional().describe("Take number: 2 -> Take_02.");
const zOutputDir = z.string().optional().describe(`Absolute root folder for projects. Default: ${config.outputRoot}`);
const zFlowProject = z.string().url().optional().describe("Optional existing Flow project URL to generate inside. Default: most recent project (worker 1) or a new project (extra workers).");
const zTimeout = z.number().int().min(60).max(3_600).optional().describe(`Max seconds to wait for Flow to render (default ${config.generationTimeoutSeconds}).`);
const zWait = z.boolean().default(true).describe("true = wait for the result (up to wait_timeout_seconds). false = return job_id immediately.");
const zWaitTimeout = z.number().int().min(5).max(1_800).default(300).describe("Max seconds this tool call blocks before returning a job_id to poll.");
const zOverwrite = z.boolean().default(false).describe("Overwrite existing files with the same name. Default false appends _alt2, _alt3...");
const zRetries = z.number().int().min(0).max(10).optional().describe(`Retries with exponential backoff on rate limit / server errors (default ${config.maxRetries}).`);
const zImagePath = (what: string) => z.string().optional().describe(`Absolute path to a local .png/.jpg/.webp used as ${what}.`);
const zRefs = z.array(z.string()).max(3).optional().describe("Absolute paths to local images used as ingredients (character / scenery / style references).");

const namingShape = {
  project_name: zProject,
  scene_id: zScene,
  take_number: zTake,
  output_dir: zOutputDir,
  overwrite: zOverwrite,
};

// ------------------------------------------------------------------- server

const server = new McpServer(
  { name: "custom-google-flow-mcp", version: VERSION },
  {
    instructions: [
      "Automates Google Flow (flow.google.com, formerly labs.google/fx/tools/flow) in the user's own logged-in Chrome via CDP.",
      "Start with flow_check_session. If not ready, tell the user to run `npm run auth` in the custom-google-flow-mcp folder and sign in.",
      "Generations consume the user's Flow credits. Videos take 1-5 min: prefer wait=false for long work and poll flow_get_queue_status.",
      "For storyboards use flow_generate_batch. Files are saved as <output_dir>/<project_name>/Assets_Flow/Scene_XX_Take_YY.ext with manifest.json.",
      "If something fails with ui_changed, call flow_health_check and look at the returned screenshot.",
      "Never operate the Flow website with generic browser tools while jobs run in this MCP.",
    ].join("\n"),
  },
);

server.registerTool(
  "flow_check_session",
  {
    title: "Check Google Flow session",
    description: "Connects to Chrome (CDP on :9222, launching the dedicated profile if needed) and reports whether Google Flow is signed in and the workspace is ready. Spends no credits.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async () => {
    try {
      return ok(await checkSession(session, generator.busyWorkers > 0));
    } catch (error) {
      return failed(error);
    }
  },
);

server.registerTool(
  "flow_health_check",
  {
    title: "Health check (session + selectors + screenshot)",
    description: "Verifies login, opens a Flow project, probes every key DOM selector (reporting which fallback strategy matched) and, if anything fails, saves a diagnostic screenshot to ./logs/error-debug.png and returns its path. Spends no credits.",
    inputSchema: {
      open_project: z.boolean().default(true).describe("Open (most recent) project so editor selectors can be probed."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ open_project }) => {
    try {
      return ok(await healthCheck(session, { busy: generator.busyWorkers > 0, openProject: open_project }));
    } catch (error) {
      return failed(error);
    }
  },
);

server.registerTool(
  "flow_generate_video",
  {
    title: "Generate video (text-to-video)",
    description: "Generates a video in Google Flow from text, with aspect ratio, camera motion, variation count and editor-ready naming (Scene_01_Take_02.mp4) plus manifest.json. Consumes Flow credits.",
    inputSchema: {
      prompt: zPrompt,
      aspect_ratio: zAspect,
      camera_motion: zCamera,
      outputs_count: zOutputs,
      model: zModel,
      ...namingShape,
      flow_project_url: zFlowProject,
      timeout_seconds: zTimeout,
      max_retries: zRetries,
      wait: zWait,
      wait_timeout_seconds: zWaitTimeout,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  async (input) => {
    try {
      const spec = buildSpec({ ...input, mediaType: "video" });
      return await enqueueAndMaybeWait(spec, input.wait, input.wait_timeout_seconds, input.max_retries);
    } catch (error) {
      return failed(error);
    }
  },
);

server.registerTool(
  "flow_image_to_video",
  {
    title: "Generate video from images (frames / ingredients)",
    description: "Uploads local images to Flow as Start Frame, End Frame and/or ingredient references (character/scenery), then generates a video. Uses Frames-to-Video when frames are given, Ingredients-to-Video for references. Consumes Flow credits.",
    inputSchema: {
      prompt: zPrompt,
      start_frame: zImagePath("the START (first) frame"),
      end_frame: zImagePath("the END (last) frame"),
      reference_images: zRefs,
      aspect_ratio: zAspect,
      camera_motion: zCamera,
      outputs_count: zOutputs,
      model: zModel,
      ...namingShape,
      flow_project_url: zFlowProject,
      timeout_seconds: zTimeout,
      max_retries: zRetries,
      wait: zWait,
      wait_timeout_seconds: zWaitTimeout,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  async (input) => {
    try {
      if (!input.start_frame && !input.end_frame && !input.reference_images?.length) {
        throw new FlowError("validation_error", "Provide at least one of start_frame, end_frame or reference_images.");
      }
      const spec = buildSpec({ ...input, mediaType: "video" });
      return await enqueueAndMaybeWait(spec, input.wait, input.wait_timeout_seconds, input.max_retries);
    } catch (error) {
      return failed(error);
    }
  },
);

server.registerTool(
  "flow_generate_image",
  {
    title: "Generate image (Nano Banana / Imagen in Flow)",
    description: "Generates still images inside Google Flow and downloads them at the full resolution Flow serves, with editor-ready naming and manifest.json. Optional reference images. Consumes Flow credits.",
    inputSchema: {
      prompt: zPrompt,
      aspect_ratio: zAspect,
      outputs_count: zOutputs,
      model: zModel,
      reference_images: zRefs,
      ...namingShape,
      flow_project_url: zFlowProject,
      timeout_seconds: zTimeout,
      max_retries: zRetries,
      wait: zWait,
      wait_timeout_seconds: zWaitTimeout,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  async (input) => {
    try {
      const spec = buildSpec({ ...input, mediaType: "image" });
      return await enqueueAndMaybeWait(spec, input.wait, input.wait_timeout_seconds, input.max_retries);
    } catch (error) {
      return failed(error);
    }
  },
);

const zScene_ = z.object({
  take_number: z.number().int().min(1).max(999).optional().describe("Take number (default: position in the list)."),
  scene_id: zScene.describe("Scene id (default: 1)."),
  prompt: zPrompt,
  media_type: z.enum(["video", "image"]).default("video"),
  aspect_ratio: zAspect,
  camera_motion: zCamera,
  outputs_count: z.number().int().min(1).max(4).optional(),
  model: zModel,
  start_frame: zImagePath("the START frame"),
  end_frame: zImagePath("the END frame"),
  reference_images: zRefs,
});

server.registerTool(
  "flow_generate_batch",
  {
    title: "Batch storyboard queue",
    description: "Queues a full storyboard (list of takes) and returns a batch_id immediately. Runs in background with configurable concurrency (1-4 workers, each in its own Flow tab/project), automatic retry with exponential backoff on rate limits / server errors, and writes every result + a batch summary to <output_dir>/<project_name>/manifest.json. Poll flow_get_queue_status. Consumes Flow credits.",
    inputSchema: {
      project_name: z.string().min(1).max(80).describe("Project name (folder name)."),
      output_dir: zOutputDir,
      scenes: z.array(zScene_).min(1).max(200).describe("Takes to generate, e.g. [{ take_number: 1, prompt: '...', aspect_ratio: '16:9' }]."),
      concurrency: z.number().int().min(1).max(4).default(1).describe(`Simultaneous generations (capped by FLOW_MCP_MAX_CONCURRENCY=${config.maxConcurrency}).`),
      max_retries: zRetries,
      default_aspect_ratio: zAspect,
      default_camera_motion: zCamera,
      default_outputs_count: z.number().int().min(1).max(4).default(1),
      default_model: zModel,
      flow_project_url: zFlowProject,
      timeout_seconds: zTimeout,
      overwrite: zOverwrite,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  async (input) => {
    try {
      const specs = input.scenes.map((scene, index) => {
        const camera = scene.camera_motion ?? input.default_camera_motion;
        const aspect = scene.aspect_ratio ?? input.default_aspect_ratio;
        const model = scene.model ?? input.default_model;
        return buildSpec({
          mediaType: scene.media_type,
          prompt: scene.prompt,
          ...(aspect ? { aspect_ratio: aspect } : {}),
          ...(camera ? { camera_motion: camera } : {}),
          outputs_count: scene.outputs_count ?? input.default_outputs_count,
          ...(model ? { model } : {}),
          ...(scene.start_frame ? { start_frame: scene.start_frame } : {}),
          ...(scene.end_frame ? { end_frame: scene.end_frame } : {}),
          ...(scene.reference_images ? { reference_images: scene.reference_images } : {}),
          project_name: input.project_name,
          scene_id: scene.scene_id ?? 1,
          take_number: scene.take_number ?? index + 1,
          ...(input.output_dir ? { output_dir: input.output_dir } : {}),
          ...(input.flow_project_url ? { flow_project_url: input.flow_project_url } : {}),
          ...(input.timeout_seconds ? { timeout_seconds: input.timeout_seconds } : {}),
          overwrite: input.overwrite,
        });
      });
      const first = specs[0]!;
      const projectDir = projectDirectory(first.outputDir, first.projectName);
      const batch = queue.createBatch({
        projectName: first.projectName,
        projectDir,
        concurrency: input.concurrency,
        specs,
        ...(input.max_retries !== undefined ? { maxRetries: input.max_retries } : {}),
      });
      await updateManifest(projectDir, first.projectName, (manifest) => {
        manifest.batches[batch.id] = {
          batch_id: batch.id,
          created_at: batch.createdAt,
          concurrency: batch.concurrency,
          total: specs.length,
          completed: 0,
          failed: 0,
          failures: [],
        };
      });
      return ok({
        ...queue.batchSummary(batch),
        job_ids: batch.jobIds,
        manifest: path.join(projectDir, "manifest.json"),
        message: `Queued ${specs.length} takes. Poll flow_get_queue_status with batch_id '${batch.id}'.`,
      });
    } catch (error) {
      return failed(error);
    }
  },
);

server.registerTool(
  "flow_get_queue_status",
  {
    title: "Queue / batch / job status",
    description: "Non-blocking progress report. With batch_id: batch progress + each take. With job_id: one job (verbose). With neither: overview of running/queued work and recent batches.",
    inputSchema: {
      batch_id: z.string().optional(),
      job_id: z.string().optional(),
      verbose: z.boolean().default(false).describe("Include event history and full prompt sent."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ batch_id, job_id, verbose }) => {
    try {
      if (job_id) {
        const job = queue.getJob(job_id);
        if (!job) throw new FlowError("validation_error", `Unknown job_id ${job_id}`);
        return ok(jobView(job, true));
      }
      if (batch_id) {
        const batch = queue.getBatch(batch_id);
        if (!batch) throw new FlowError("validation_error", `Unknown batch_id ${batch_id}`);
        return ok({
          ...queue.batchSummary(batch),
          manifest: path.join(batch.projectDir, "manifest.json"),
          jobs: batch.jobIds.map((id) => queue.getJob(id)).filter((job): job is JobRecord => Boolean(job)).map((job) => jobView(job, verbose)),
        });
      }
      const jobs = queue.listJobs();
      const active = jobs.filter((job) => !isTerminal(job.status));
      return ok({
        workers: { limit: queue.limit, running: queue.runningCount },
        active_jobs: active.map((job) => jobView(job, verbose)),
        recent_finished: jobs.filter((job) => isTerminal(job.status)).slice(-10).map((job) => jobView(job)),
        batches: queue.listBatches().slice(-10).map((batch) => queue.batchSummary(batch)),
      });
    } catch (error) {
      return failed(error);
    }
  },
);

server.registerTool(
  "flow_cancel",
  {
    title: "Cancel job or batch",
    description: "Cancels a queued/running job, or every unfinished take of a batch. A generation already submitted to Flow may still finish on Flow's side (credits already spent).",
    inputSchema: { id: z.string().describe("job_id or batch_id") },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
  async ({ id }) => {
    try {
      const cancelled = queue.cancel(id);
      return ok({ cancelled, count: cancelled.length });
    } catch (error) {
      return failed(error);
    }
  },
);

// -------------------------------------------------------------------- start

function shutdown(reason: string): void {
  log.info(`Shutting down (${reason}). Chrome is left running to keep the session warm.`);
  queue.flush();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.stdin.on("close", () => shutdown("stdin closed"));
process.on("unhandledRejection", (reason) => log.error("Unhandled rejection", reason));

const transport = new StdioServerTransport();
await server.connect(transport);
log.info(`custom-google-flow-mcp ${VERSION} ready on stdio (browser mode ${config.browserMode}, CDP ${config.cdpUrl}, output root ${config.outputRoot}).`);
