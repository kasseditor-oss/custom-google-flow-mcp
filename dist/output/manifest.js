import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { log } from "../logger.js";
const MANIFEST_FILE = "manifest.json";
const chains = new Map();
export function manifestPath(projectDir) {
    return path.join(projectDir, MANIFEST_FILE);
}
async function load(file, projectName, projectDir) {
    try {
        const parsed = JSON.parse(await readFile(file, "utf8"));
        parsed.entries ??= [];
        parsed.batches ??= {};
        return parsed;
    }
    catch (error) {
        if (error.code !== "ENOENT") {
            // Corrupt manifest: keep a backup instead of silently discarding history.
            const backup = `${file}.corrupt-${Date.now()}.bak`;
            await rename(file, backup).catch(() => undefined);
            log.warn(`manifest.json was unreadable; moved to ${backup}`);
        }
        const now = new Date().toISOString();
        return {
            schema_version: 1,
            generator: "custom-google-flow-mcp",
            project_name: projectName,
            project_dir: projectDir,
            created_at: now,
            updated_at: now,
            entries: [],
            batches: {},
        };
    }
}
async function atomicWrite(file, content) {
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, content, "utf8");
    try {
        await rename(temp, file);
    }
    catch {
        // Windows may refuse rename while another program holds the file open.
        await writeFile(file, content, "utf8");
        await rename(temp, `${temp}.stale`).catch(() => undefined);
    }
}
/** Serialized read-modify-write of <projectDir>/manifest.json (safe under concurrent workers). */
export async function updateManifest(projectDir, projectName, mutate) {
    const file = manifestPath(projectDir);
    const previous = chains.get(file) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
        await mkdir(projectDir, { recursive: true });
        const manifest = await load(file, projectName, projectDir);
        mutate(manifest);
        manifest.updated_at = new Date().toISOString();
        await atomicWrite(file, `${JSON.stringify(manifest, null, 2)}\n`);
        return file;
    });
    chains.set(file, next);
    try {
        return await next;
    }
    finally {
        if (chains.get(file) === next)
            chains.delete(file);
    }
}
