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
import { ASPECT_RATIOS, VIDEO_ASPECT_RATIOS, CAMERA_MOTIONS, type CameraMotion, type GenerationSpec, type JobRecord, type MediaKind } from "./types.js";
import { FLOW_ICON_URL, UI_APP_ONLY_META, UI_MIME_TYPE, UI_RESOURCE_URI, UI_TOOL_META, brandIconDataUri, iconDataUri, jobPreview, openLocalFile, readThumbnail, viewerHtml } from "./ui.js";

const VERSION = "1.2.0";
/** Official Flow icon (cached locally after the first download; generic logo if offline). */
const brandIcon = await brandIconDataUri();

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

type ContentBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type ToolResult = { content: ContentBlock[]; isError?: boolean; structuredContent?: Record<string, unknown> };

interface ToolExtra {
  _meta?: { progressToken?: string | number };
  sendNotification: (notification: { method: "notifications/progress"; params: { progressToken: string | number; progress: number; total?: number; message?: string } }) => Promise<void>;
}

/** Text JSON + structuredContent (for the widget) + inline thumbnails (for hosts without MCP Apps). */
/** True when the connected host declared MCP Apps support (io.modelcontextprotocol/ui). */
function hostRendersWidget(): boolean {
  const capabilities = server.server.getClientCapabilities() as { extensions?: Record<string, unknown> } | undefined;
  return Boolean(capabilities?.extensions?.["io.modelcontextprotocol/ui"]);
}

function jobResult(job: JobRecord, extra: Record<string, unknown> = {}): ToolResult {
  const view = { ...jobView(job), ...extra };
  const images: ContentBlock[] = [];
  for (const file of (hostRendersWidget() ? [] : (job.result?.files ?? []).slice(0, 4))) {
    const data = readThumbnail(file.thumbnail);
    if (data) images.push({ type: "image", data, mimeType: "image/jpeg" });
  }
  return {
    content: [{ type: "text", text: JSON.stringify(view, null, 2) }, ...images],
    // The widget renders straight from this (no follow-up call needed).
    structuredContent: hostRendersWidget() && isTerminal(job.status) ? { ...view, preview: jobPreview(job, true) } : view,
    ...(["failed", "cancelled", "interrupted"].includes(job.status) ? { isError: true } : {}),
  };
}

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
  duration_seconds?: number;
  resolution?: string;
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
  if (input.mediaType === "video" && input.aspect_ratio && !(VIDEO_ASPECT_RATIOS as readonly string[]).includes(input.aspect_ratio)) {
    throw new FlowError("validation_error", `Flow video supports ${VIDEO_ASPECT_RATIOS.join(" and ")} only (got ${input.aspect_ratio}).`, ["Use 9:16 for TikTok/Reels/Shorts or 16:9 for YouTube."]);
  }
  if (input.flow_project_url && !isProjectUrl(input.flow_project_url)) {
    throw new FlowError("validation_error", "flow_project_url must be a Flow project URL, e.g. https://flow.google.com/project/<id>.");
  }
  return {
    mediaType: input.mediaType,
    prompt: input.prompt.trim(),
    ...(input.aspect_ratio ? { aspectRatio: input.aspect_ratio } : {}),
    ...(camera ? { cameraMotion: camera } : {}),
    outputsCount: input.outputs_count ?? 1,
    ...(input.mediaType === "video" && input.duration_seconds ? { durationSeconds: input.duration_seconds } : {}),
    ...(input.mediaType === "video" && input.resolution ? { resolution: input.resolution.trim().toLowerCase() } : {}),
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
          ...(job.result.modelUsed ? { model_used: job.result.modelUsed } : {}),
          ...(job.result.creditsEstimated !== undefined ? { credits_used: job.result.creditsEstimated } : {}),
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

async function enqueueAndMaybeWait(spec: GenerationSpec, wait: boolean, waitSeconds: number, maxRetries: number | undefined, extra: ToolExtra): Promise<ToolResult> {
  const job = queue.enqueue(spec, maxRetries !== undefined ? { maxRetries } : {});
  if (!wait) {
    return jobResult(job, { message: "Queued in background. The inline viewer updates live; or poll flow_get_queue_status with job_id." });
  }
  // MCP progress notifications (shown by clients that support them) while we wait.
  const token = extra._meta?.progressToken;
  let lastPhase = "";
  let tick = 0;
  const ticker = token === undefined ? undefined : setInterval(() => {
    const message = job.phase ?? job.status;
    if (message === lastPhase) return;
    lastPhase = message;
    tick += 1;
    extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: tick, message: `Google Flow: ${message}` } }).catch(() => undefined);
  }, 1_500);
  try {
    const finished = await queue.waitFor(job.id, waitSeconds * 1_000);
    if (!isTerminal(finished.status)) {
      return jobResult(finished, { message: `Still ${finished.status} after ${waitSeconds}s. It continues in background; the viewer keeps updating, or poll flow_get_queue_status with job_id '${job.id}'.` });
    }
    return jobResult(finished);
  } finally {
    if (ticker) clearInterval(ticker);
  }
}

// ------------------------------------------------------------------ schemas

const zPrompt = z.string().min(3).max(5_000).describe("Prompt text (any language; English often gives the best Veo results).");
const zAspect = z.enum(ASPECT_RATIOS).optional().describe("Image aspect ratio: 16:9, 4:3, 1:1, 3:4 or 9:16. Set in Flow's UI (falls back to a prompt directive if the control is missing).");
const zCamera = z
  .enum([...CAMERA_MOTIONS, "pan", "tilt", "zoom", "dolly", "orbit"])
  .optional()
  .describe("Camera movement. Applied via Flow's camera control when present, otherwise as a cinematic prompt directive. Aliases: pan=pan_right, tilt=tilt_up, zoom=zoom_in, dolly=dolly_in, orbit=orbit_right.");
const zOutputs = z.number().int().min(1).max(4).optional().describe("How many variations to generate (1-4). DEFAULT 1: only set this when the user explicitly asks for more. Multiple outputs are saved as _v1.._v4.");
const zDuration = z.number().int().min(1).max(60).optional().describe("Video length in seconds. Flow's allowed range depends on the model (e.g. Omni 1.2 Flash: 3-15 s) and is checked live; omit to keep Flow's current length.");
const zResolution = z.string().regex(/^\d{3,4}p$/i).optional().describe("Video resolution as offered by Flow, e.g. '720p' or '360p' (cheaper). Omit to keep Flow's current setting.");
const zAskOptions = z.boolean().optional().describe("If true (default when the client supports it), unspecified options (quantity, and for video: format, length) are asked to the user in a dialog showing the credit cost before generating. Set false to skip the dialog and use defaults.");
const zVideoAspect = z.enum(VIDEO_ASPECT_RATIOS).optional().describe("Video format: 9:16 = vertical (TikTok, Reels, Shorts); 16:9 = horizontal (YouTube). Omit to keep Flow's current setting.");
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
  {
    name: "custom-google-flow-mcp",
    title: "Google Flow",
    version: VERSION,
    ...(brandIcon
      ? {
          icons: [
            { src: FLOW_ICON_URL, mimeType: "image/png", sizes: ["192x192"] },
            { src: brandIcon, mimeType: "image/png", sizes: ["192x192"] },
          ],
        }
      : iconDataUri() ? { icons: [{ src: iconDataUri()!, mimeType: "image/svg+xml", sizes: ["any"] }] } : {}),
  },
  {
    instructions: [
      "Automates Google Flow (flow.google.com, formerly labs.google/fx/tools/flow) in the user's own logged-in Chrome via CDP.",
      "Start with flow_check_session. The browser runs invisibly; if Google sign-in is needed a Chrome window opens by itself for the user to sign in, then it hides again (fallback: `npm run auth` in the custom-google-flow-mcp folder).",
      "Generations consume the user's Flow credits. Videos take 1-5 min: prefer wait=false for long work and poll flow_get_queue_status.",
      "For storyboards use flow_generate_batch. Files are saved as <output_dir>/<project_name>/Assets_Flow/Scene_XX_Take_YY.ext with manifest.json.",
      "If something fails with ui_changed, call flow_health_check and look at the returned screenshot.",
      "Never operate the Flow website with generic browser tools while jobs run in this MCP.",
    ].join("\n"),
  },
);

// ------------------------------------------------- options dialog & estimate

const ASK_OPTIONS = (process.env.FLOW_MCP_ASK_OPTIONS ?? "auto").toLowerCase() !== "never";

function cancelledByUser(): ToolResult {
  const view = { status: "cancelled", message: "The user closed the options dialog; nothing was generated and no credits were spent." };
  return { content: [{ type: "text", text: JSON.stringify(view, null, 2) }], structuredContent: view };
}

interface OptionInputs {
  outputs_count?: number;
  aspect_ratio?: string;
  duration_seconds?: number;
  resolution?: string;
  ask_options?: boolean;
}

/**
 * When the user did not say how many outputs (and, for video, which format and
 * length), asks them in a native MCP dialog (elicitation) that shows the credit
 * cost Flow announces. Clients without elicitation, ask_options=false or
 * FLOW_MCP_ASK_OPTIONS=never simply use the defaults (1 output, Flow's current
 * format/length). Mutates `spec` with the chosen values.
 */
async function askOptions(spec: GenerationSpec, input: OptionInputs): Promise<"ok" | "cancelled"> {
  if (!ASK_OPTIONS || input.ask_options === false) return "ok";
  if (!server.server.getClientCapabilities()?.elicitation) return "ok";
  const isVideo = spec.mediaType === "video";
  const askCount = input.outputs_count === undefined;
  const askAspect = isVideo && !input.aspect_ratio;
  const askDuration = isVideo && !input.duration_seconds;
  const askResolution = isVideo && !input.resolution;
  if (!askCount && !askAspect && !askDuration && !askResolution) return "ok";

  const estimate = await generator.estimate({
    mediaType: spec.mediaType,
    ...(spec.aspectRatio ? { aspectRatio: spec.aspectRatio } : {}),
    outputsCount: 1,
    ...(spec.model ? { model: spec.model } : {}),
    ...(spec.durationSeconds ? { durationSeconds: spec.durationSeconds } : {}),
    ...(spec.resolution ? { resolution: spec.resolution } : {}),
  }).catch((error) => {
    log.warn("Cost estimate failed; asking without it", error instanceof Error ? error.message : error);
    return undefined;
  });

  const properties: Record<string, Record<string, unknown>> = {};
  if (askCount) {
    properties.outputs_count = {
      type: "string",
      title: isVideo ? "Quantos vídeos?" : "Quantas imagens?",
      enum: ["1", "2", "3", "4"],
      enumNames: ["1", "2", "3", "4"],
      default: "1",
    };
  }
  if (askAspect) {
    properties.aspect_ratio = {
      type: "string",
      title: "Formato",
      enum: ["9:16", "16:9"],
      enumNames: ["9:16 — vertical (TikTok, Reels, Shorts)", "16:9 — horizontal (YouTube)"],
      default: "16:9",
    };
  }
  if (askDuration) {
    const range = estimate?.durationRange;
    properties.duration_seconds = {
      type: "integer",
      title: range ? `Duração em segundos (${range.min}–${range.max})` : "Duração em segundos",
      ...(range ? { minimum: range.min, maximum: range.max } : { minimum: 1, maximum: 60 }),
      default: range ? Math.min(Math.max(8, range.min), range.max) : 8,
    };
  }
  if (askResolution && estimate?.resolutions && estimate.resolutions.length > 1) {
    properties.resolution = {
      type: "string",
      title: "Resolução",
      enum: estimate.resolutions,
      enumNames: estimate.resolutions,
      default: estimate.resolutions.includes("720p") ? "720p" : estimate.resolutions[estimate.resolutions.length - 1],
    };
  }

  const what = isVideo ? "vídeo" : "imagem";
  const costLine = estimate?.credits !== undefined
    ? `Custo com as opções atuais (1 ${what}): ${estimate.credits} créditos${isVideo ? " — muda com duração, resolução e quantidade" : ""}.`
    : "O custo exato aparece no resultado.";
  const message = [
    `Google Flow · ${isVideo ? "gerar vídeo" : "gerar imagem"}${estimate?.model ? ` com ${estimate.model}` : ""}.`,
    costLine,
    "Escolha as opções (ou cancele para não gastar créditos):",
  ].join("\n");

  let result;
  try {
    result = await server.server.elicitInput(
      { message, requestedSchema: { type: "object", properties: properties as never, required: [] } },
      { timeout: 300_000 },
    );
  } catch (error) {
    log.warn("Options dialog failed; using defaults", error instanceof Error ? error.message : error);
    return "ok";
  }
  if (result.action !== "accept") return "cancelled";
  const content = (result.content ?? {}) as Record<string, unknown>;
  const count = Number(content.outputs_count);
  if (askCount && Number.isInteger(count) && count >= 1 && count <= 4) spec.outputsCount = count;
  if (askAspect && (content.aspect_ratio === "9:16" || content.aspect_ratio === "16:9")) spec.aspectRatio = content.aspect_ratio;
  const seconds = Number(content.duration_seconds);
  if (askDuration && Number.isInteger(seconds) && seconds > 0) spec.durationSeconds = seconds;
  if (askResolution && typeof content.resolution === "string" && /^\d{3,4}p$/i.test(content.resolution)) spec.resolution = content.resolution.toLowerCase();
  return "ok";
}

server.registerTool(
  "flow_estimate_cost",
  {
    title: "Estimate Google Flow credits",
    description: "Shows how many credits a generation will use BEFORE generating (Flow's own 'Generating will use N credits'), plus the live options for the current model: allowed video length range, resolutions and formats. Configures Flow's settings panel but never submits, so it spends no credits.",
    inputSchema: {
      media_type: z.enum(["video", "image"]).default("video"),
      aspect_ratio: z.enum(ASPECT_RATIOS).optional(),
      outputs_count: z.number().int().min(1).max(4).default(1),
      duration_seconds: zDuration,
      resolution: zResolution,
      model: zModel,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  async (input) => {
    try {
      if (input.media_type === "video" && input.aspect_ratio && !(VIDEO_ASPECT_RATIOS as readonly string[]).includes(input.aspect_ratio)) {
        throw new FlowError("validation_error", `Flow video supports ${VIDEO_ASPECT_RATIOS.join(" and ")} only.`);
      }
      const estimate = await generator.estimate({
        mediaType: input.media_type,
        ...(input.aspect_ratio ? { aspectRatio: input.aspect_ratio } : {}),
        outputsCount: input.outputs_count,
        ...(input.model ? { model: input.model } : {}),
        ...(input.duration_seconds ? { durationSeconds: input.duration_seconds } : {}),
        ...(input.resolution ? { resolution: input.resolution.toLowerCase() } : {}),
      });
      return ok({
        media_type: input.media_type,
        outputs_count: input.outputs_count,
        ...(input.duration_seconds ? { duration_seconds: input.duration_seconds } : {}),
        ...(input.resolution ? { resolution: input.resolution } : {}),
        credits: estimate.credits ?? null,
        model: estimate.model,
        allowed: {
          ...(estimate.durationRange ? { duration_seconds: estimate.durationRange } : {}),
          ...(estimate.resolutions ? { resolutions: estimate.resolutions } : {}),
          ...(estimate.aspectRatios ? { aspect_ratios: estimate.aspectRatios } : {}),
        },
        note: estimate.credits === undefined ? "Flow did not display a credit cost for this configuration." : "Credits as displayed by Flow before generating.",
      });
    } catch (error) {
      return failed(error);
    }
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
      aspect_ratio: zVideoAspect,
      duration_seconds: zDuration,
      resolution: zResolution,
      camera_motion: zCamera,
      outputs_count: zOutputs,
      model: zModel,
      ask_options: zAskOptions,
      ...namingShape,
      flow_project_url: zFlowProject,
      timeout_seconds: zTimeout,
      max_retries: zRetries,
      wait: zWait,
      wait_timeout_seconds: zWaitTimeout,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    _meta: UI_TOOL_META,
  },
  async (input, extra) => {
    try {
      const spec = buildSpec({ ...input, mediaType: "video" });
      if ((await askOptions(spec, input)) === "cancelled") return cancelledByUser();
      return await enqueueAndMaybeWait(spec, input.wait, input.wait_timeout_seconds, input.max_retries, extra as unknown as ToolExtra);
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
      aspect_ratio: zVideoAspect,
      duration_seconds: zDuration,
      resolution: zResolution,
      camera_motion: zCamera,
      outputs_count: zOutputs,
      model: zModel,
      ask_options: zAskOptions,
      ...namingShape,
      flow_project_url: zFlowProject,
      timeout_seconds: zTimeout,
      max_retries: zRetries,
      wait: zWait,
      wait_timeout_seconds: zWaitTimeout,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    _meta: UI_TOOL_META,
  },
  async (input, extra) => {
    try {
      if (!input.start_frame && !input.end_frame && !input.reference_images?.length) {
        throw new FlowError("validation_error", "Provide at least one of start_frame, end_frame or reference_images.");
      }
      const spec = buildSpec({ ...input, mediaType: "video" });
      if ((await askOptions(spec, input)) === "cancelled") return cancelledByUser();
      return await enqueueAndMaybeWait(spec, input.wait, input.wait_timeout_seconds, input.max_retries, extra as unknown as ToolExtra);
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
      ask_options: zAskOptions,
      ...namingShape,
      flow_project_url: zFlowProject,
      timeout_seconds: zTimeout,
      max_retries: zRetries,
      wait: zWait,
      wait_timeout_seconds: zWaitTimeout,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    _meta: UI_TOOL_META,
  },
  async (input, extra) => {
    try {
      const spec = buildSpec({ ...input, mediaType: "image" });
      if ((await askOptions(spec, input)) === "cancelled") return cancelledByUser();
      return await enqueueAndMaybeWait(spec, input.wait, input.wait_timeout_seconds, input.max_retries, extra as unknown as ToolExtra);
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
    _meta: UI_TOOL_META,
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
      const summary = {
        ...queue.batchSummary(batch),
        job_ids: batch.jobIds,
        manifest: path.join(projectDir, "manifest.json"),
        message: `Queued ${specs.length} takes. The inline viewer shows live progress; or poll flow_get_queue_status with batch_id '${batch.id}'.`,
      };
      return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }], structuredContent: summary };
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

// ----------------------------------------------------------- MCP Apps (UI)

server.registerResource(
  "google-flow-viewer",
  UI_RESOURCE_URI,
  {
    title: "Google Flow viewer",
    description: "Inline widget: live generation progress and generated media previews.",
    mimeType: UI_MIME_TYPE,
  },
  async () => ({
    contents: [{
      uri: UI_RESOURCE_URI,
      mimeType: UI_MIME_TYPE,
      text: (log.info(`Host requested the widget resource ${UI_RESOURCE_URI}.`), viewerHtml((await brandIconDataUri()) ?? brandIcon)),
      _meta: { ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: [] } } },
    }],
  }),
);

server.registerTool(
  "flow_preview",
  {
    title: "Viewer: job/batch preview",
    description: "Used by the inline Google Flow viewer to poll progress and fetch thumbnails. Not needed by the model; use flow_get_queue_status instead.",
    inputSchema: {
      job_id: z.string().optional(),
      batch_id: z.string().optional(),
      thumbnails_for: z.array(z.string()).optional().describe("Batch only: job ids whose thumbnails should be included."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    _meta: UI_APP_ONLY_META,
  },
  async ({ job_id, batch_id, thumbnails_for }) => {
    try {
      if (batch_id) {
        const batch = queue.getBatch(batch_id);
        if (!batch) throw new FlowError("validation_error", `Unknown batch_id ${batch_id}`);
        const wanted = new Set(thumbnails_for ?? []);
        const jobs = batch.jobIds.map((id) => queue.getJob(id)).filter((job): job is JobRecord => Boolean(job));
        const data = { kind: "batch", ...queue.batchSummary(batch), jobs: jobs.map((job) => jobPreview(job, wanted.has(job.id))) };
        return { content: [{ type: "text" as const, text: `${data.progress_percent}%` }], structuredContent: data };
      }
      if (!job_id) throw new FlowError("validation_error", "job_id or batch_id is required.");
      const job = queue.getJob(job_id);
      if (!job) throw new FlowError("validation_error", `Unknown job_id ${job_id}`);
      const data = { kind: "job", done: isTerminal(job.status), jobs: [jobPreview(job, true)] };
      return { content: [{ type: "text" as const, text: job.status }], structuredContent: data };
    } catch (error) {
      return failed(error);
    }
  },
);

server.registerTool(
  "flow_open_file",
  {
    title: "Viewer: open generated file",
    description: "Used by the inline viewer's Open / Folder buttons. Opens a file generated by this server with the default app, or reveals it in the file manager.",
    inputSchema: {
      path: z.string(),
      reveal: z.boolean().default(false),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    _meta: UI_APP_ONLY_META,
  },
  async ({ path: file, reveal }) => {
    try {
      // Only files produced by this server can be opened.
      const known = queue.listJobs().some((job) => job.result?.files.some((asset) => asset.path === file));
      if (!known) throw new FlowError("validation_error", "Only files generated by this MCP can be opened.");
      openLocalFile(file, reveal);
      return ok({ opened: file, reveal });
    } catch (error) {
      return failed(error);
    }
  },
);

// -------------------------------------------------------------------- start

let shuttingDown = false;
function shutdown(reason: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`Shutting down (${reason}).`);
  queue.flush();
  // Close the invisible browser this MCP launched; never a browser the user opened.
  const force = setTimeout(() => process.exit(0), 4_000);
  session.closeLaunched("shutdown").finally(() => {
    clearTimeout(force);
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.stdin.on("close", () => shutdown("stdin closed"));
process.on("unhandledRejection", (reason) => log.error("Unhandled rejection", reason));

server.server.oninitialized = () => {
  const client = server.server.getClientVersion();
  const capabilities = server.server.getClientCapabilities() as Record<string, unknown> | undefined;
  log.info(`Client connected: ${client?.name ?? "?"} ${client?.version ?? ""} | MCP Apps widget: ${hostRendersWidget() ? "supported" : "NOT declared"} | elicitation: ${capabilities?.elicitation ? "yes" : "no"} | capabilities: ${JSON.stringify(capabilities ?? {})}`);
};

const transport = new StdioServerTransport();
await server.connect(transport);
log.info(`custom-google-flow-mcp ${VERSION} ready on stdio (browser mode ${config.browserMode}, CDP ${config.cdpUrl}, output root ${config.outputRoot}).`);
