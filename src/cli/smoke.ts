#!/usr/bin/env node
/**
 * Protocol smoke test: spawns the built server over stdio, performs the MCP
 * handshake, lists tools and calls flow_get_queue_status (no browser, no credits).
 */
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PROJECT_ROOT } from "../config.js";

const EXPECTED = [
  "flow_check_session",
  "flow_health_check",
  "flow_generate_video",
  "flow_image_to_video",
  "flow_generate_image",
  "flow_generate_batch",
  "flow_get_queue_status",
  "flow_cancel",
];

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(PROJECT_ROOT, "dist", "index.js")],
  stderr: "pipe",
});
const client = new Client({ name: "smoke", version: "1.0.0" });
await client.connect(transport);
const info = client.getServerVersion();
const { tools } = await client.listTools();
const names = tools.map((tool) => tool.name);
const missing = EXPECTED.filter((name) => !names.includes(name));
const status = await client.callTool({ name: "flow_get_queue_status", arguments: {} });
const invalid = await client.callTool({ name: "flow_image_to_video", arguments: { prompt: "test prompt" } });
process.stdout.write(`${JSON.stringify({
  server: info,
  tools: names,
  missing,
  queueStatusOk: !status.isError,
  validationRejected: Boolean(invalid.isError),
}, null, 2)}\n`);
await client.close();
process.exit(missing.length || status.isError || !invalid.isError ? 1 : 0);
