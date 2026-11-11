import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root (works from both src/ and dist/). */
export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export type BrowserMode = "auto" | "cdp" | "launch";

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function browserMode(): BrowserMode {
  const raw = (process.env.FLOW_MCP_BROWSER_MODE ?? "auto").toLowerCase();
  return raw === "cdp" || raw === "launch" ? raw : "auto";
}

const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
const dataDir = process.env.FLOW_MCP_DATA_DIR
  ?? (process.platform === "win32"
    ? path.join(localAppData, "custom-google-flow-mcp")
    : path.join(os.homedir(), ".custom-google-flow-mcp"));

const cdpUrl = (process.env.FLOW_MCP_CDP_URL ?? "http://127.0.0.1:9222").replace(/\/+$/, "");

export const config = {
  flowUrl: process.env.FLOW_MCP_URL ?? "https://flow.google.com/",
  browserMode: browserMode(),
  cdpUrl,
  cdpPort: Number.parseInt(new URL(cdpUrl).port || "9222", 10),
  userDataDir: process.env.FLOW_MCP_USER_DATA_DIR ?? path.join(dataDir, "chrome-profile"),
  browserExecutable: process.env.FLOW_MCP_BROWSER_EXECUTABLE,
  /** Invisible browser by default (no window, no taskbar). FLOW_MCP_HEADLESS=0 shows it. */
  headless: process.env.FLOW_MCP_HEADLESS !== "0",
  /** Close the browser the MCP launched after this many idle seconds (0 = keep open). */
  idleCloseSeconds: intEnv("FLOW_MCP_IDLE_CLOSE_SECONDS", 90, 0, 86_400),
  dataDir,
  logDir: process.env.FLOW_MCP_LOG_DIR ?? path.join(PROJECT_ROOT, "logs"),
  outputRoot: process.env.FLOW_MCP_OUTPUT_ROOT ?? (process.platform === "win32" ? "C:/Projetos" : path.join(os.homedir(), "Projetos")),
  maxConcurrency: intEnv("FLOW_MCP_MAX_CONCURRENCY", 2, 1, 4),
  maxRetries: intEnv("FLOW_MCP_MAX_RETRIES", 3, 0, 10),
  retryBaseMs: intEnv("FLOW_MCP_RETRY_BASE_MS", 15_000, 1_000, 600_000),
  generationTimeoutSeconds: intEnv("FLOW_MCP_GENERATION_TIMEOUT", 600, 60, 3_600),
} as const;

export type AppConfig = typeof config;
