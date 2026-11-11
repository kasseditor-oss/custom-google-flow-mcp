#!/usr/bin/env node
/**
 * Registers this MCP server in Claude Code (user scope, via `claude mcp add-json`)
 * and in Claude Desktop (claude_desktop_config.json). Idempotent: re-running
 * replaces the previous entry. A backup of the Desktop config is kept.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { config, PROJECT_ROOT } from "../config.js";
const say = (message) => process.stdout.write(`${message}\n`);
function option(name) {
    const index = process.argv.indexOf(`--${name}`);
    return index >= 0 ? process.argv[index + 1] : undefined;
}
const name = option("name") ?? "google-flow";
const only = option("only");
const env = {};
const outputRoot = option("output-root");
if (outputRoot)
    env.FLOW_MCP_OUTPUT_ROOT = outputRoot.replace(/\\/g, "/");
const concurrency = option("concurrency");
if (concurrency)
    env.FLOW_MCP_MAX_CONCURRENCY = concurrency;
const REPO_SPEC = "github:kasseditor-oss/custom-google-flow-mcp";
/**
 * When launched through `npx`, the code lives in a disposable npm cache. Copy
 * it to a permanent folder first so the registered path never disappears.
 */
function stableRoot() {
    if (!/[\\/]_npx[\\/]/.test(PROJECT_ROOT))
        return PROJECT_ROOT;
    const prefix = path.join(config.dataDir, "app");
    say(`Installing a permanent copy into ${prefix} ...`);
    mkdirSync(prefix, { recursive: true });
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const result = spawnSync(`${npm} install --prefix "${prefix}" ${REPO_SPEC} --omit=dev --no-audit --no-fund --loglevel=error`, { stdio: "inherit", shell: true });
    if (result.status !== 0) {
        say("✖ Permanent install failed; registering the npx copy instead.");
        return PROJECT_ROOT;
    }
    return path.join(prefix, "node_modules", "custom-google-flow-mcp");
}
/** Stable launcher: node + absolute path (no npx/cmd quirks on Windows). */
const serverEntry = path.join(stableRoot(), "dist", "bin.js");
const entry = {
    type: "stdio",
    command: process.execPath,
    args: [serverEntry],
    env,
};
function installClaudeCode() {
    const json = JSON.stringify(entry);
    const candidates = process.platform === "win32" ? ["claude.exe", "claude"] : ["claude"];
    for (const binary of candidates) {
        spawnSync(binary, ["mcp", "remove", name, "--scope", "user"], { stdio: "ignore" });
        const result = spawnSync(binary, ["mcp", "add-json", name, json, "--scope", "user"], { encoding: "utf8" });
        if (result.error)
            continue;
        if (result.status === 0) {
            say(`✔ Claude Code: '${name}' registered (user scope).`);
            return true;
        }
        say(`✖ Claude Code CLI failed: ${(result.stderr || result.stdout).trim()}`);
        return false;
    }
    say("• Claude Code CLI ('claude') not found in PATH. Register manually with:");
    say(`  claude mcp add-json ${name} '${json}' --scope user`);
    return false;
}
function desktopConfigPath() {
    if (process.platform === "win32") {
        const appData = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
        return path.join(appData, "Claude", "claude_desktop_config.json");
    }
    if (process.platform === "darwin") {
        return path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
    }
    return path.join(os.homedir(), ".config", "Claude", "claude_desktop_config.json");
}
function installClaudeDesktop() {
    const file = desktopConfigPath();
    if (!file || (!existsSync(path.dirname(file)) && only !== "desktop")) {
        say("• Claude Desktop not detected; skipped (use --only desktop to force).");
        return false;
    }
    let config = {};
    if (existsSync(file)) {
        try {
            config = JSON.parse(readFileSync(file, "utf8"));
        }
        catch {
            say(`✖ ${file} is not valid JSON; not touching it.`);
            return false;
        }
        copyFileSync(file, `${file}.bak`);
    }
    else {
        mkdirSync(path.dirname(file), { recursive: true });
    }
    const { type: _type, ...desktopEntry } = entry;
    config.mcpServers = { ...(config.mcpServers ?? {}), [name]: desktopEntry };
    writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    say(`✔ Claude Desktop: '${name}' written to ${file} (restart Claude Desktop).`);
    return true;
}
if (!existsSync(serverEntry)) {
    say(`✖ ${serverEntry} not found. Run 'npm run build' first.`);
    process.exit(1);
}
say(`Server entry: ${serverEntry}`);
if (only !== "desktop")
    installClaudeCode();
if (only !== "code")
    installClaudeDesktop();
say("");
say("Next step — sign in to Google Flow once:");
say(`  "${process.execPath}" "${serverEntry}" auth`);
