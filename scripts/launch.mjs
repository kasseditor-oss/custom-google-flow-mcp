#!/usr/bin/env node
// Plugin/zero-setup launcher: installs runtime dependencies next to the code on
// first run (output goes to stderr, never stdout, so the MCP stdio stream stays
// clean) and then starts the server. dist/ is committed, so no build is needed.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const required = ["@modelcontextprotocol/sdk", "playwright-core", "zod"];
const missing = required.filter((name) => !existsSync(path.join(root, "node_modules", name, "package.json")));

if (missing.length) {
  process.stderr.write(`[custom-google-flow-mcp] first run: installing ${missing.join(", ")}...\n`);
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const run = (args) => process.platform === "win32"
    ? spawnSync(`${npm} ${args.join(" ")}`, { cwd: root, stdio: ["ignore", 2, 2], shell: true })
    : spawnSync(npm, args, { cwd: root, stdio: ["ignore", 2, 2] });
  const flags = ["--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"];
  let result = run(["ci", ...flags]);
  if (result.status !== 0) result = run(["install", ...flags]);
  if (result.status !== 0) {
    process.stderr.write("[custom-google-flow-mcp] npm install failed. Run `npm install --omit=dev` in " + root + "\n");
    process.exit(1);
  }
}

await import(pathToFileURL(path.join(root, "dist", "bin.js")).href);
