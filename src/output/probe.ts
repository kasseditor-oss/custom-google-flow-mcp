import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import type { MediaKind, MediaProbe } from "../types.js";

const execFileAsync = promisify(execFile);

export function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export function extensionFor(contentType: string, mediaType: MediaKind): string {
  const normalized = contentType.toLowerCase().split(";", 1)[0]?.trim() ?? "";
  const map: Record<string, string> = {
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "video/quicktime": ".mov",
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
  };
  return map[normalized] ?? (mediaType === "video" ? ".mp4" : ".png");
}

/** Detects the real container from magic bytes (Flow sometimes serves octet-stream). */
export function sniffContentType(buffer: Buffer): string | undefined {
  if (buffer.length < 12) return undefined;
  if (buffer.subarray(4, 8).toString("ascii") === "ftyp") {
    return buffer.subarray(8, 12).toString("ascii").startsWith("qt") ? "video/quicktime" : "video/mp4";
  }
  if (buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) return "video/webm";
  if (buffer[0] === 0x89 && buffer.subarray(1, 4).toString("ascii") === "PNG") return "image/png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return "image/jpeg";
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (buffer.subarray(0, 3).toString("ascii") === "GIF") return "image/gif";
  return undefined;
}

/** Optional ffprobe metadata (duration/resolution/codec). Silent if ffprobe is not installed. */
export async function probeMedia(file: string): Promise<MediaProbe> {
  try {
    const { stdout } = await execFileAsync(
      "ffprobe",
      ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file],
      { timeout: 20_000, maxBuffer: 2_000_000, windowsHide: true },
    );
    const parsed = JSON.parse(stdout) as {
      format?: { format_name?: string; duration?: string };
      streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number; duration?: string }>;
    };
    const stream = parsed.streams?.find((item) => item.codec_type === "video");
    const duration = Number(stream?.duration ?? parsed.format?.duration);
    return {
      ffprobeAvailable: true,
      ...(parsed.format?.format_name ? { format: parsed.format.format_name } : {}),
      ...(Number.isFinite(duration) ? { durationSeconds: duration } : {}),
      ...(stream?.width ? { width: stream.width } : {}),
      ...(stream?.height ? { height: stream.height } : {}),
      ...(stream?.codec_name ? { codec: stream.codec_name } : {}),
    };
  } catch {
    return { ffprobeAvailable: false };
  }
}
