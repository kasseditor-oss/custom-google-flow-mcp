// Builds dist/ui/viewer.html: a single self-contained HTML (MCP Apps view)
// with the official @modelcontextprotocol/ext-apps App bundle inlined, so the
// host iframe needs no network access (default MCP Apps CSP blocks it anyway).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
// The package only exports ESM subpaths; resolve the "app-with-deps" entry directly.
const bundlePath = (() => {
  try {
    return fileURLToPath(import.meta.resolve("@modelcontextprotocol/ext-apps/app-with-deps"));
  } catch {
    return require.resolve("@modelcontextprotocol/ext-apps/app-with-deps");
  }
})();

let bundle = readFileSync(bundlePath, "utf8");
const exportMatch = bundle.match(/export\s*\{([^}]*)\};?\s*$/);
if (!exportMatch) throw new Error("Unexpected ext-apps bundle shape: final export block not found.");
const mapping = exportMatch[1]
  .split(",")
  .map((part) => part.trim())
  .filter(Boolean)
  .map((part) => {
    const [local, exported] = part.split(/\s+as\s+/);
    return `${JSON.stringify((exported ?? local).trim())}:${local.trim()}`;
  })
  .join(",");
bundle = `${bundle.slice(0, exportMatch.index)}\nwindow.McpExtApps={${mapping}};\n`.replace(/<\/script/gi, "<\\/script");

const logo = readFileSync(path.join(root, "ui", "logo.svg"), "utf8").trim();
const logoDataUri = `data:image/svg+xml;base64,${Buffer.from(logo).toString("base64")}`;
const template = readFileSync(path.join(root, "ui", "viewer.html"), "utf8");
const html = template
  .replace("/*__EXT_APPS_BUNDLE__*/", () => bundle)
  .replaceAll("__LOGO_DATA_URI__", logoDataUri);

mkdirSync(path.join(root, "dist", "ui"), { recursive: true });
writeFileSync(path.join(root, "dist", "ui", "viewer.html"), html, "utf8");
writeFileSync(path.join(root, "dist", "ui", "logo.svg"), `${logo}\n`, "utf8");
process.stdout.write(`dist/ui/viewer.html built (${Math.round(html.length / 1024)} KB)\n`);
