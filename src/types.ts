export type MediaKind = "video" | "image";

/** Images accept all five; Flow video currently offers only 16:9 and 9:16. */
export const ASPECT_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4"] as const;
export const VIDEO_ASPECT_RATIOS = ["16:9", "9:16"] as const;
export type AspectRatio = (typeof ASPECT_RATIOS)[number];

export const CAMERA_MOTIONS = [
  "static",
  "pan_left",
  "pan_right",
  "tilt_up",
  "tilt_down",
  "zoom_in",
  "zoom_out",
  "dolly_in",
  "dolly_out",
  "orbit_left",
  "orbit_right",
] as const;
export type CameraMotion = (typeof CAMERA_MOTIONS)[number];

/** How a requested parameter reached Flow. "prompt" = injected as a textual directive because no UI control was found. */
export type AppliedVia = "ui" | "prompt" | "default" | "not_requested" | "failed";

export interface GenerationSpec {
  mediaType: MediaKind;
  prompt: string;
  aspectRatio?: AspectRatio;
  cameraMotion?: CameraMotion;
  outputsCount: number;
  /** Video length in seconds (range depends on the model; read live from Flow). */
  durationSeconds?: number;
  /** Video resolution label as shown by Flow, e.g. "720p" or "360p". */
  resolution?: string;
  model?: string;
  startFrame?: string;
  endFrame?: string;
  referenceImages: string[];
  projectName: string;
  sceneId?: string;
  takeNumber?: number;
  /** Root folder. Files land in <outputDir>/<projectName>/Assets_Flow. */
  outputDir: string;
  flowProjectUrl?: string;
  timeoutSeconds: number;
  overwrite: boolean;
}

export interface MediaProbe {
  format?: string;
  durationSeconds?: number;
  width?: number;
  height?: number;
  codec?: string;
  ffprobeAvailable: boolean;
}

export interface SavedAsset {
  path: string;
  variation: number;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  probe?: MediaProbe;
  /** Small JPEG preview (local path) used by the chat widget and inline image results. */
  thumbnail?: string;
  /** ~320px variant used when several previews travel in one tool result. */
  thumbnailSmall?: string;
}

export interface GenerationResult {
  files: SavedAsset[];
  manifestPath: string;
  finalPrompt: string;
  flowProjectUrl: string;
  /** Model label shown by Flow at submit time (e.g. "Nano Banana 2.1", "Veo 3.1 - Fast"). */
  modelUsed?: string;
  /** Credits Flow announced for this generation ("Generating will use N credits"). */
  creditsEstimated?: number;
  applied: Record<string, AppliedVia>;
  warnings: string[];
}

export type JobStatus = "queued" | "running" | "retry_wait" | "completed" | "failed" | "cancelled" | "interrupted";

export interface JobEvent {
  at: string;
  message: string;
}

export interface JobRecord {
  id: string;
  batchId?: string;
  spec: GenerationSpec;
  status: JobStatus;
  phase?: string;
  attempts: number;
  maxRetries: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  nextRetryAt?: string;
  error?: string;
  errorCode?: string;
  diagnosticScreenshot?: string;
  result?: GenerationResult;
  events: JobEvent[];
}

export interface BatchRecord {
  id: string;
  projectName: string;
  projectDir: string;
  concurrency: number;
  createdAt: string;
  finishedAt?: string;
  jobIds: string[];
}
