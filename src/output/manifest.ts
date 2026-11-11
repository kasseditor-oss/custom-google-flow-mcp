import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { log } from "../logger.js";
import type { AppliedVia, GenerationSpec, SavedAsset } from "../types.js";

export interface ManifestEntry {
  job_id: string;
  batch_id?: string;
  scene_id?: string;
  take_number?: number;
  variation: number;
  media_type: GenerationSpec["mediaType"];
  file: string;
  relative_file: string;
  prompt: string;
  final_prompt_sent: string;
  parameters: {
    aspect_ratio?: string;
    camera_motion?: string;
    outputs_count: number;
    duration_seconds?: number;
    resolution?: string;
    model?: string;
    /** Flow's UI does not expose seeds; recorded explicitly for traceability. */
    seed: string | null;
    start_frame?: string;
    end_frame?: string;
    reference_images: string[];
    applied_via: Record<string, AppliedVia>;
  };
  flow_project_url: string;
  attempts: number;
  generated_at: string;
  sha256: string;
  size_bytes: number;
  content_type: string;
  probe?: SavedAsset["probe"];
}

export interface ManifestBatch {
  batch_id: string;
  created_at: string;
  finished_at?: string;
  concurrency: number;
  total: number;
  completed: number;
  failed: number;
  failures: Array<{ job_id: string; scene_id?: string; take_number?: number; error: string }>;
}

export interface ProjectManifest {
  schema_version: 1;
  generator: "custom-google-flow-mcp";
  project_name: string;
  project_dir: string;
  created_at: string;
  updated_at: string;
  entries: ManifestEntry[];
  batches: Record<string, ManifestBatch>;
}

const MANIFEST_FILE = "manifest.json";
const chains = new Map<string, Promise<unknown>>();

export function manifestPath(projectDir: string): string {
  return path.join(projectDir, MANIFEST_FILE);
}

async function load(file: string, projectName: string, projectDir: string): Promise<ProjectManifest> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as ProjectManifest;
    parsed.entries ??= [];
    parsed.batches ??= {};
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
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

async function atomicWrite(file: string, content: string): Promise<void> {
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, content, "utf8");
  try {
    await rename(temp, file);
  } catch {
    // Windows may refuse rename while another program holds the file open.
    await writeFile(file, content, "utf8");
    await rename(temp, `${temp}.stale`).catch(() => undefined);
  }
}

/** Serialized read-modify-write of <projectDir>/manifest.json (safe under concurrent workers). */
export async function updateManifest(
  projectDir: string,
  projectName: string,
  mutate: (manifest: ProjectManifest) => void,
): Promise<string> {
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
  } finally {
    if (chains.get(file) === next) chains.delete(file);
  }
}
