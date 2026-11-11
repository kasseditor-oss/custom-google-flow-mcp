import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../config.js";
import { FlowError } from "../errors.js";
import { log } from "../logger.js";

/** Last-resort: Chromium builds downloaded by Playwright (newest first). */
function playwrightChromium(root: string): string[] {
  try {
    return readdirSync(root)
      .filter((name) => /^chromium-\d+$/.test(name))
      .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]))
      .flatMap((name) => [path.join(root, name, "chrome-win64", "chrome.exe"), path.join(root, name, "chrome-win", "chrome.exe")]);
  } catch {
    return [];
  }
}

function candidates(): string[] {
  const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  if (process.platform === "win32") {
    return [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      path.join(local, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(local, "Chromium", "Application", "chrome.exe"),
      "C:\\Program Files\\Chromium\\Application\\chrome.exe",
      "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
      path.join(local, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      ...playwrightChromium(path.join(local, "ms-playwright")),
    ];
  }
  if (process.platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
  }
  return ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
}

export function findChromeExecutable(): string {
  if (config.browserExecutable) {
    if (!existsSync(config.browserExecutable)) {
      throw new FlowError("browser_error", `FLOW_MCP_BROWSER_EXECUTABLE does not exist: ${config.browserExecutable}`);
    }
    return config.browserExecutable;
  }
  const found = candidates().find((candidate) => existsSync(candidate));
  if (!found) {
    throw new FlowError("browser_error", "Google Chrome / Chromium was not found.", [
      "Install Google Chrome or set FLOW_MCP_BROWSER_EXECUTABLE to chrome.exe.",
    ]);
  }
  return found;
}

export async function isCdpReachable(cdpUrl: string, timeoutMs = 1_500): Promise<boolean> {
  try {
    const response = await fetch(`${cdpUrl}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok;
  } catch {
    return false;
  }
}

export async function waitForCdp(cdpUrl: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isCdpReachable(cdpUrl, 1_000)) return;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new FlowError("browser_error", `Chrome did not expose CDP at ${cdpUrl} within ${timeoutMs / 1000}s.`, [
    `Another Chrome may already be using the profile ${config.userDataDir} without --remote-debugging-port. Close it and retry.`,
  ]);
}

/**
 * Launches a *real* Chrome (not Playwright's automation build) with a dedicated
 * user-data-dir and a remote-debugging port. Because Chrome is started as a
 * normal process (no --enable-automation), Google sign-in works and the session
 * persists in the profile, avoiding repeated 2FA prompts.
 *
 * Note: Chrome 136+ refuses --remote-debugging-port on the *default* profile,
 * which is why a dedicated user-data-dir is required.
 */
export function launchChrome(options: { url: string; headless?: boolean; detached?: boolean }): number | undefined {
  const executable = findChromeExecutable();
  mkdirSync(config.userDataDir, { recursive: true });
  const args = [
    `--remote-debugging-port=${config.cdpPort}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${config.userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    // Keep background tabs (concurrent workers) running at full speed.
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--lang=pt-BR",
    ...(options.headless ? ["--headless=new", "--window-size=1600,1000"] : ["--window-size=1600,1000"]),
    options.url,
  ];
  log.info(`Launching Chrome: ${executable} (profile ${config.userDataDir}, CDP port ${config.cdpPort})`);
  const child = spawn(executable, args, {
    detached: options.detached ?? true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.on("error", (error) => log.error("Chrome process error", error));
  child.unref();
  return child.pid;
}
