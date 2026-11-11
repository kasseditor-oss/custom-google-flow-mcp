import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { config, PROJECT_ROOT } from "../config.js";
import { FlowError } from "../errors.js";
import { log } from "../logger.js";
/** Last-resort: Chromium builds downloaded by Playwright (newest first). */
function playwrightChromium(root) {
    try {
        return readdirSync(root)
            .filter((name) => /^chromium-\d+$/.test(name))
            .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]))
            .flatMap((name) => [path.join(root, name, "chrome-win64", "chrome.exe"), path.join(root, name, "chrome-win", "chrome.exe")]);
    }
    catch {
        return [];
    }
}
function candidates() {
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
export function findChromeExecutable() {
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
export async function isCdpReachable(cdpUrl, timeoutMs = 1_500) {
    try {
        const response = await fetch(`${cdpUrl}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
        return response.ok;
    }
    catch {
        return false;
    }
}
export async function waitForCdp(cdpUrl, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await isCdpReachable(cdpUrl, 1_000))
            return;
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
/** Asks the browser on `cdpUrl` to quit (Browser.close) and waits until the port is free. */
export async function closeBrowserAt(cdpUrl, timeoutMs = 10_000) {
    try {
        const { chromium } = await import("playwright-core");
        const browser = await chromium.connectOverCDP(cdpUrl, { timeout: 5_000 });
        const session = await browser.newBrowserCDPSession();
        await session.send("Browser.close").catch(() => undefined);
    }
    catch {
        // Already gone.
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && (await isCdpReachable(cdpUrl, 500))) {
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
}
/** Reads the browser's real User-Agent from /json/version. */
export async function cdpUserAgent(cdpUrl) {
    try {
        const response = await fetch(`${cdpUrl}/json/version`, { signal: AbortSignal.timeout(2_000) });
        const data = (await response.json());
        return data["User-Agent"];
    }
    catch {
        return undefined;
    }
}
/**
 * While this file exists the dedicated browser is meant to be visible (sign-in):
 * any window hider still running from a previous hidden launch exits instead of
 * hiding the sign-in window.
 */
export function visibleFlag() {
    return path.join(config.dataDir, "browser-visible.flag");
}
/** Starts scripts/hide-windows.ps1, which keeps the dedicated browser's windows hidden until it quits. */
export function startWindowHider() {
    const script = path.join(PROJECT_ROOT, "scripts", "hide-windows.ps1");
    if (process.platform !== "win32" || !existsSync(script))
        return;
    const hider = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", script, "-ProfileDir", config.userDataDir, "-VisibleFlag", visibleFlag()], 
    // A detached PowerShell with ignored stdio exits immediately on Windows; keep pipes and drain them.
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    hider.stdout?.resume();
    hider.stderr?.on("data", (chunk) => log.debug(`window hider: ${chunk.toString().trim()}`));
    hider.on("error", (error) => log.warn("Window hider failed to start", error));
    hider.unref();
    hider.stdout?.unref?.();
    hider.stderr?.unref?.();
}
export function launchChrome(options) {
    const executable = findChromeExecutable();
    mkdirSync(config.userDataDir, { recursive: true });
    mkdirSync(config.dataDir, { recursive: true });
    const visible = !options.hidden && !options.headless;
    if (visible)
        writeFileSync(visibleFlag(), new Date().toISOString(), "utf8");
    else
        rmSync(visibleFlag(), { force: true });
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
        ...(options.headless ? ["--headless=new", "--window-size=1600,1000", "--mute-audio"] : ["--window-size=1600,1000"]),
        // Hidden/off-screen: a real browser window placed far outside the desktop (and hidden via Win32 on Windows).
        // Translate / crash-restore bubbles are separate windows that Chrome clamps onto a real
        // monitor (e.g. a second screen at x<0), so suppress them in hidden mode.
        ...(options.hidden
            ? ["--window-position=-32000,-32000", "--mute-audio", "--disable-features=Translate", "--hide-crash-restore-bubble"]
            : []),
        // Visible (sign-in): force the window back on-screen even if the profile remembers the off-screen position.
        ...(visible ? ["--window-position=80,60"] : []),
        ...(options.userAgent ? [`--user-agent=${options.userAgent}`] : []),
        options.url,
    ];
    // Start the hider first so it is already running when the first window appears.
    if (options.hidden)
        startWindowHider();
    log.info(`Launching Chrome: ${executable} (profile ${config.userDataDir}, CDP port ${config.cdpPort})`);
    const child = spawn(executable, args, {
        detached: options.detached ?? true,
        stdio: "ignore",
        windowsHide: Boolean(options.headless),
    });
    child.on("error", (error) => log.error("Chrome process error", error));
    child.unref();
    return child.pid;
}
