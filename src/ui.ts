/**
 * MCP Apps (io.modelcontextprotocol/ui) integration: an inline chat widget that
 * shows "generating in Google Flow…" with live progress, then the generated
 * images / video posters, like hosted creative connectors do.
 *
 * Hosts without MCP Apps support simply ignore the _meta and still get text +
 * inline image content blocks.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config, PROJECT_ROOT } from "./config.js";
import { FlowError } from "./errors.js";
import type { JobRecord } from "./types.js";

export const UI_RESOURCE_URI = "ui://google-flow/viewer.html";
export const UI_MIME_TYPE = "text/html;profile=mcp-app";

/** Tool _meta linking a tool to the widget (new nested key + legacy flat key). */
export const UI_TOOL_META = { ui: { resourceUri: UI_RESOURCE_URI }, "ui/resourceUri": UI_RESOURCE_URI };
/** Tools only the widget may call (hidden from the model where supported). */
export const UI_APP_ONLY_META = { ui: { resourceUri: UI_RESOURCE_URI, visibility: ["app"] } };

let cachedHtml: string | undefined;
/** Widget HTML. When the official Flow icon is cached locally, it replaces the generic built-in logo. */
export function viewerHtml(brandIcon?: string): string {
  if (!cachedHtml) {
    const file = path.join(PROJECT_ROOT, "dist", "ui", "viewer.html");
    if (!existsSync(file)) throw new FlowError("internal_error", `UI bundle missing: ${file}. Run npm run build.`);
    cachedHtml = readFileSync(file, "utf8");
  }
  const fallback = iconDataUri();
  return brandIcon && fallback ? cachedHtml.replaceAll(fallback, brandIcon) : cachedHtml;
}

/**
 * Official Google Flow app icon, downloaded from Google's public static host on
 * the user's machine and cached locally. It is never shipped in this repository.
 */
export const FLOW_ICON_URL = "https://www.gstatic.com/aitestkitchen/website/flow/favicon/flow_icon_192.png";
let brandIconPromise: Promise<string | undefined> | undefined;
export function brandIconDataUri(): Promise<string | undefined> {
  brandIconPromise ??= (async () => {
    const file = path.join(config.dataDir, "brand", "flow_icon_192.png");
    try {
      if (!existsSync(file)) {
        const response = await fetch(process.env.FLOW_MCP_BRAND_ICON_URL ?? FLOW_ICON_URL, { signal: AbortSignal.timeout(4_000) });
        const body = Buffer.from(await response.arrayBuffer());
        // Only accept a real PNG.
        if (!response.ok || body.subarray(1, 4).toString("ascii") !== "PNG") return undefined;
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, body);
      }
      return `data:image/png;base64,${readFileSync(file).toString("base64")}`;
    } catch {
      return undefined;
    }
  })();
  return brandIconPromise;
}

let cachedIcon: string | undefined;
/** Server/tool icon as a data URI (MCP `icons`). */
export function iconDataUri(): string | undefined {
  if (cachedIcon) return cachedIcon;
  for (const candidate of [path.join(PROJECT_ROOT, "dist", "ui", "logo.svg"), path.join(PROJECT_ROOT, "ui", "logo.svg")]) {
    if (existsSync(candidate)) {
      // Same encoding as scripts/build-ui.mjs (trimmed), so viewerHtml() can swap it.
      cachedIcon = `data:image/svg+xml;base64,${Buffer.from(readFileSync(candidate, "utf8").trim()).toString("base64")}`;
      return cachedIcon;
    }
  }
  return undefined;
}

export function readThumbnail(file: string | undefined): string | undefined {
  if (!file || !existsSync(file)) return undefined;
  try {
    return readFileSync(file).toString("base64");
  } catch {
    return undefined;
  }
}

export function jobPreview(job: JobRecord, includeThumbnails: boolean) {
  return {
    job_id: job.id,
    ...(job.batchId ? { batch_id: job.batchId } : {}),
    status: job.status,
    ...(job.phase ? { phase: job.phase } : {}),
    media_type: job.spec.mediaType,
    aspect_ratio: job.spec.aspectRatio,
    model: job.result?.modelUsed ?? job.spec.model,
    ...(job.result?.creditsEstimated !== undefined ? { credits: job.result.creditsEstimated } : {}),
    ...(job.spec.durationSeconds ? { duration_seconds: job.spec.durationSeconds } : {}),
    ...(job.spec.resolution ? { resolution: job.spec.resolution } : {}),
    project_name: job.spec.projectName,
    scene_id: job.spec.sceneId,
    take_number: job.spec.takeNumber,
    prompt: job.spec.prompt,
    attempts: job.attempts,
    ...(job.nextRetryAt ? { next_retry_at: job.nextRetryAt } : {}),
    ...(job.error ? { error: job.error, error_code: job.errorCode } : {}),
    warnings: job.result?.warnings ?? [],
    files: (job.result?.files ?? []).map((file) => {
      const many = (job.result?.files.length ?? 0) > 1;
      const thumb = includeThumbnails ? readThumbnail(many ? file.thumbnailSmall ?? file.thumbnail : file.thumbnail) : undefined;
      return {
        path: file.path,
        name: path.basename(file.path),
        variation: file.variation,
        ...(file.probe?.width ? { width: file.probe.width, height: file.probe.height } : {}),
        ...(file.probe?.durationSeconds ? { duration: file.probe.durationSeconds } : {}),
        ...(thumb ? { thumbnail: `data:image/jpeg;base64,${thumb}` } : {}),
      };
    }),
  };
}

/** Opens (or reveals in the file manager) a file that this server generated. */
export function openLocalFile(file: string, reveal: boolean): void {
  if (!existsSync(file)) throw new FlowError("validation_error", `File not found: ${file}`);
  const options = { detached: true, stdio: "ignore" as const, windowsHide: true };
  let child;
  if (process.platform === "win32") {
    child = reveal
      ? spawn("explorer.exe", [`/select,${file}`], options)
      : spawn("cmd.exe", ["/d", "/c", "start", '""', `"${file}"`], { ...options, windowsVerbatimArguments: true });
  } else if (process.platform === "darwin") {
    child = spawn("open", reveal ? ["-R", file] : [file], options);
  } else {
    child = spawn("xdg-open", [reveal ? path.dirname(file) : file], options);
  }
  child.on("error", () => undefined);
  child.unref();
}
