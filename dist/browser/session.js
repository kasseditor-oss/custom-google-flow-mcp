import { chromium } from "playwright-core";
import { config } from "../config.js";
import { FlowError } from "../errors.js";
import { log } from "../logger.js";
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { cdpUserAgent, closeBrowserAt, isCdpReachable, launchChrome, waitForCdp } from "./chrome.js";
import { isFlowUrl } from "../flow/urls.js";
/**
 * Hybrid browser connection:
 *  - "cdp":    attach to an already running Chrome on FLOW_MCP_CDP_URL (default :9222).
 *  - "launch": start real Chrome with the dedicated profile + CDP port, then attach.
 *  - "auto":   attach if reachable, otherwise launch.
 * A browser the MCP launched itself runs headless (invisible) and is closed
 * after FLOW_MCP_IDLE_CLOSE_SECONDS without work; it is relaunched on demand.
 * A visible browser the user opened is never closed.
 */
export class BrowserSession {
    browser;
    connecting;
    kind;
    holds = 0;
    idleTimer;
    /** Marks the browser as in use (prevents idle close). */
    hold() {
        this.holds += 1;
        clearTimeout(this.idleTimer);
    }
    /** Releases a hold; when nothing uses the browser, schedules the idle close. */
    release() {
        this.holds = Math.max(0, this.holds - 1);
        if (this.holds > 0 || config.idleCloseSeconds <= 0 || this.kind !== "cdp_launched")
            return;
        clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => void this.closeLaunched("idle"), config.idleCloseSeconds * 1_000);
        this.idleTimer.unref();
    }
    /** Quits the browser only if this MCP launched it (headless). */
    async closeLaunched(reason) {
        if (this.holds > 0 || this.kind !== "cdp_launched")
            return;
        clearTimeout(this.idleTimer);
        this.browser = undefined;
        this.kind = undefined;
        await closeBrowserAt(config.cdpUrl);
        rmSync(ownerMarker(), { force: true });
        log.info(`Closed the background browser (${reason}).`);
    }
    get connectionKind() {
        return this.kind;
    }
    get isConnected() {
        return Boolean(this.browser?.isConnected());
    }
    async context() {
        if (this.browser?.isConnected()) {
            const existing = this.browser.contexts()[0];
            if (existing)
                return existing;
        }
        this.connecting ??= this.connect().finally(() => {
            this.connecting = undefined;
        });
        return this.connecting;
    }
    async connect() {
        const reachable = await isCdpReachable(config.cdpUrl);
        if (!reachable) {
            if (config.browserMode === "cdp") {
                throw new FlowError("browser_error", `No Chrome is listening on ${config.cdpUrl} (FLOW_MCP_BROWSER_MODE=cdp).`, [
                    "Run `npm run auth` (or `npm run chrome`) inside custom-google-flow-mcp to start Chrome with the debugging port.",
                    `Or start Chrome manually: chrome.exe --remote-debugging-port=${config.cdpPort} --user-data-dir="${config.userDataDir}"`,
                ]);
            }
            await this.launch();
            this.kind = "cdp_launched";
        }
        else {
            // A background browser left by a previous MCP process is ours to manage too.
            this.kind = existsSync(ownerMarker()) ? "cdp_launched" : "cdp_attached";
        }
        try {
            this.browser = await chromium.connectOverCDP(config.cdpUrl, { timeout: 30_000 });
        }
        catch (error) {
            throw new FlowError("browser_error", `connectOverCDP(${config.cdpUrl}) failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        this.browser.on("disconnected", () => {
            log.warn("Chrome CDP connection lost; it will be re-established on the next request.");
            this.browser = undefined;
        });
        const context = this.browser.contexts()[0];
        if (!context)
            throw new FlowError("browser_error", "Chrome exposed no default browser context over CDP.");
        log.info(`Connected to Chrome over CDP (${this.kind}) at ${config.cdpUrl}.`);
        return context;
    }
    /**
     * Launches the dedicated profile. Headless Chrome advertises "HeadlessChrome"
     * in its User-Agent, which Google may treat differently, so the real UA is
     * learned once, cached, and passed with --user-agent.
     */
    async launch() {
        const uaFile = path.join(config.dataDir, "user-agent.txt");
        let userAgent;
        try {
            userAgent = readFileSync(uaFile, "utf8").trim() || undefined;
        }
        catch {
            userAgent = undefined;
        }
        launchChrome({ url: "about:blank", headless: config.headless, ...(userAgent ? { userAgent } : {}) });
        await waitForCdp(config.cdpUrl);
        if (config.headless && !userAgent) {
            const detected = await cdpUserAgent(config.cdpUrl);
            if (detected && /HeadlessChrome/i.test(detected)) {
                userAgent = detected.replace(/HeadlessChrome/gi, "Chrome");
                mkdirSync(config.dataDir, { recursive: true });
                writeFileSync(uaFile, userAgent, "utf8");
                log.info("Learned browser User-Agent; relaunching headless with a normal UA.");
                await closeBrowserAt(config.cdpUrl);
                launchChrome({ url: "about:blank", headless: true, userAgent });
                await waitForCdp(config.cdpUrl);
            }
        }
        mkdirSync(config.dataDir, { recursive: true });
        writeFileSync(ownerMarker(), JSON.stringify({ launchedAt: new Date().toISOString(), pid: process.pid, headless: config.headless }), "utf8");
    }
    /** Reuses an open Flow tab when possible (keeps the user's working tab), else opens one. */
    async primaryPage() {
        const context = await this.context();
        const existing = context.pages().find((page) => !page.isClosed() && isFlowUrl(page.url()));
        if (existing)
            return preparePage(existing);
        const blank = context.pages().find((page) => !page.isClosed() && /^(?:about:blank|chrome:\/\/newtab)/.test(page.url()));
        return preparePage(blank ?? (await context.newPage()));
    }
    async newPage() {
        const context = await this.context();
        return preparePage(await context.newPage());
    }
    /**
     * Forgets the connection without closing the user's Chrome. We deliberately
     * do not call browser.close(): over CDP it can terminate the real browser.
     * The websocket is released when the MCP process exits.
     */
    forget() {
        this.browser = undefined;
    }
}
/** Exists while a browser launched by the MCP (not by the user) is running. */
export function ownerMarker() {
    return path.join(config.dataDir, "browser-owner.json");
}
function preparePage(page) {
    page.setDefaultTimeout(15_000);
    page.setDefaultNavigationTimeout(60_000);
    return page;
}
