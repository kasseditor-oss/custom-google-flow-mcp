import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { config } from "./config.js";

/**
 * stdout is reserved for the MCP stdio protocol. Every log line goes to
 * stderr (shown by MCP clients as server logs) and to logs/server.log.
 */
type Level = "debug" | "info" | "warn" | "error";

const debugEnabled = process.env.FLOW_MCP_DEBUG === "1";
let logFile: string | undefined;
try {
  mkdirSync(config.logDir, { recursive: true });
  logFile = path.join(config.logDir, "server.log");
} catch {
  logFile = undefined;
}

function write(level: Level, message: string, extra?: unknown): void {
  if (level === "debug" && !debugEnabled) return;
  const suffix = extra === undefined
    ? ""
    : ` ${extra instanceof Error ? extra.stack ?? extra.message : safeJson(extra)}`;
  const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${message}${suffix}\n`;
  process.stderr.write(line);
  if (logFile) {
    try {
      appendFileSync(logFile, line, "utf8");
    } catch {
      // Logging must never break the server.
    }
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const log = {
  debug: (message: string, extra?: unknown) => write("debug", message, extra),
  info: (message: string, extra?: unknown) => write("info", message, extra),
  warn: (message: string, extra?: unknown) => write("warn", message, extra),
  error: (message: string, extra?: unknown) => write("error", message, extra),
};
