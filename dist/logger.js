import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { config } from "./config.js";
const debugEnabled = process.env.FLOW_MCP_DEBUG === "1";
let logFile;
try {
    mkdirSync(config.logDir, { recursive: true });
    logFile = path.join(config.logDir, "server.log");
}
catch {
    logFile = undefined;
}
function write(level, message, extra) {
    if (level === "debug" && !debugEnabled)
        return;
    const suffix = extra === undefined
        ? ""
        : ` ${extra instanceof Error ? extra.stack ?? extra.message : safeJson(extra)}`;
    const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${message}${suffix}\n`;
    process.stderr.write(line);
    if (logFile) {
        try {
            appendFileSync(logFile, line, "utf8");
        }
        catch {
            // Logging must never break the server.
        }
    }
}
function safeJson(value) {
    try {
        return JSON.stringify(value);
    }
    catch {
        return String(value);
    }
}
export const log = {
    debug: (message, extra) => write("debug", message, extra),
    info: (message, extra) => write("info", message, extra),
    warn: (message, extra) => write("warn", message, extra),
    error: (message, extra) => write("error", message, extra),
};
