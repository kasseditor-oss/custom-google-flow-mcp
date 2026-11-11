import { access } from "node:fs/promises";
import path from "node:path";
import { FlowError } from "../errors.js";
export const ASSETS_FOLDER = "Assets_Flow";
/** Filesystem-safe segment that editors (Premiere/Resolve/AE) handle well. */
export function sanitizeSegment(value, fallback = "Untitled") {
    const cleaned = value
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
        .replace(/[^a-zA-Z0-9 _.-]/g, "")
        .trim()
        .replace(/\s+/g, "_")
        .replace(/_+/g, "_")
        .replace(/^[.]+|[.]+$/g, "")
        .slice(0, 80);
    return cleaned || fallback;
}
const pad2 = (value) => String(value).padStart(2, "0");
/** "1" -> "01", "12" -> "12", "intro" -> "intro", "3b" -> "3b". */
export function formatSceneId(sceneId) {
    const trimmed = sceneId.trim();
    return /^\d+$/.test(trimmed) ? pad2(Number.parseInt(trimmed, 10)) : sanitizeSegment(trimmed, "00");
}
export function resolveOutputRoot(outputDir) {
    if (!path.isAbsolute(outputDir)) {
        throw new FlowError("validation_error", `output_dir must be an absolute path. Received: ${outputDir}`);
    }
    return path.resolve(outputDir);
}
export function projectDirectory(outputRoot, projectName) {
    return path.join(resolveOutputRoot(outputRoot), sanitizeSegment(projectName, "Flow_Project"));
}
export function assetsDirectory(outputRoot, projectName) {
    return path.join(projectDirectory(outputRoot, projectName), ASSETS_FOLDER);
}
/** Scene_01_Take_02 (video) / Scene_01_Take_02 (image) / Video_20261111-153000 when no scene is given. */
export function assetBaseName(input) {
    if (input.sceneId) {
        return `Scene_${formatSceneId(input.sceneId)}_Take_${pad2(input.takeNumber ?? 1)}`;
    }
    const stamp = input.createdAt.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    const prefix = input.mediaType === "video" ? "Video" : "Image";
    return input.takeNumber ? `${prefix}_Take_${pad2(input.takeNumber)}_${stamp}` : `${prefix}_${stamp}`;
}
async function exists(file) {
    try {
        await access(file);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Final file path. Multiple outputs get _v1.._v4. Existing files are never
 * overwritten unless `overwrite` is set; instead _alt2, _alt3... is appended.
 */
export async function uniqueAssetPath(input) {
    const variationSuffix = input.variationCount > 1 ? `_v${input.variation}` : "";
    const stem = `${input.baseName}${variationSuffix}`;
    let candidate = path.join(input.directory, `${stem}${input.extension}`);
    if (input.overwrite && !input.reserved.has(candidate)) {
        input.reserved.add(candidate);
        return candidate;
    }
    let attempt = 2;
    while (input.reserved.has(candidate) || (await exists(candidate))) {
        candidate = path.join(input.directory, `${stem}_alt${attempt}${input.extension}`);
        attempt += 1;
    }
    input.reserved.add(candidate);
    return candidate;
}
