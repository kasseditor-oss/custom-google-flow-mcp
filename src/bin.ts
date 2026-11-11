#!/usr/bin/env node
/**
 * Single entry point:
 *   custom-google-flow-mcp            -> MCP server (stdio)
 *   custom-google-flow-mcp auth       -> open dedicated Chrome and wait for Google sign-in
 *   custom-google-flow-mcp chrome     -> only start the dedicated Chrome with CDP
 *   custom-google-flow-mcp install    -> register the server in Claude Code / Claude Desktop
 */
const command = process.argv[2];

switch (command) {
  case "auth":
    await import("./cli/auth.js");
    break;
  case "chrome":
    process.argv.push("--no-wait");
    await import("./cli/auth.js");
    break;
  case "install":
  case "setup":
    await import("./cli/install.js");
    break;
  case "help":
  case "--help":
  case "-h":
    process.stdout.write(
      [
        "custom-google-flow-mcp — Google Flow MCP server",
        "",
        "  (no args)   run the MCP server over stdio",
        "  install     register in Claude Code (user scope) and Claude Desktop",
        "              options: --name <id> --output-root <dir> --concurrency <n> --only code|desktop",
        "  auth        open the dedicated Chrome profile and sign in to Google Flow",
        "  chrome      only start the dedicated Chrome with remote debugging",
        "",
      ].join("\n"),
    );
    break;
  default:
    await import("./index.js");
}
