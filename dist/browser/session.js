import { chromium } from "playwright-core";
import { config } from "../config.js";
import { FlowError } from "../errors.js";
import { log } from "../logger.js";
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { cdpUserAgent, closeBrowserAt, isCdpReachable, launchChrome, startWindowHider, waitForCdp } from "./chrome.js";
import { isFlowUrl } from "../flow/urls.js";
import { FlowPage } from "../flow/flow-page.js";
/**
 * Hybrid browser connection:
 *  - "cdp":    attach to an already running Chrome on FLOW_MCP_CDP_URL (default :9222).
 *  - "launch": start real Chrome with the dedicated profile + CDP port, then attach.
 *  - "auto":   attach if reachable, otherwise launch.
 * A browser the MCP launched itself runs hidden (FLOW_MCP_HIDE_MODE) and is closed
 * after FLOW_MCP_IDLE_CLOSE_SECONDS without work; it is relaunched on demand.
 * A visible browser the user opened is never closed.
 */
export class BrowserSession {
    browser;
    connecting;
    kind;
    holds = 0;
    idleTimer;
    loginFlow;
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
    /** Quits the browser only if this MCP launched it. */
    async closeLaunched(reason) {
        if (reason === "shutdown" && this.loginFlow) {
            // Don't leave an orphaned sign-in window behind when the MCP exits.
            await closeBrowserAt(config.cdpUrl);
            rmSync(ownerMarker(), { force: true });
            return;
        }
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
    /** True while the visible Google sign-in window is open. */
    get loginInProgress() {
        return Boolean(this.loginFlow);
    }
    /** Whether login_required can be solved by opening the sign-in window automatically. */
    get canInteractiveLogin() {
        return config.autoLogin && this.kind !== "cdp_attached";
    }
    /**
     * Google sign-in is needed: closes the hidden browser, reopens the SAME profile
     * as a normal visible window on Flow, waits until the user has signed in, then
     * closes it. The next request relaunches the browser hidden with the saved cookies.
     * Concurrent callers share one sign-in window.
     */
    interactiveLogin() {
        this.loginFlow ??= this.runInteractiveLogin().finally(() => {
            this.loginFlow = undefined;
        });
        return this.loginFlow;
    }
    async runInteractiveLogin() {
        if (!this.canInteractiveLogin) {
            throw new FlowError("login_required", "Google Flow is not signed in in the automation Chrome profile.", [
                this.kind === "cdp_attached"
                    ? "Sign in to Google in the Chrome window you opened (the MCP is attached to it), then retry."
                    : "Run `npm run auth` in custom-google-flow-mcp, sign in to Google in the window that opens, then retry.",
            ]);
        }
        log.info("Google sign-in required: opening a visible browser window for the user.");
        clearTimeout(this.idleTimer);
        this.browser = undefined;
        this.kind = undefined;
        await closeBrowserAt(config.cdpUrl);
        launchChrome({ url: config.flowUrl, headless: false, hidden: false });
        await waitForCdp(config.cdpUrl);
        mkdirSync(config.dataDir, { recursive: true });
        writeFileSync(ownerMarker(), JSON.stringify({ launchedAt: new Date().toISOString(), pid: process.pid, hideMode: "visible-login" }), "utf8");
        let browser;
        try {
            browser = await chromium.connectOverCDP(config.cdpUrl, { timeout: 30_000 });
            const context = browser.contexts()[0];
            if (!context)
                throw new FlowError("browser_error", "Chrome exposed no default browser context over CDP.");
            const deadline = Date.now() + config.loginTimeoutSeconds * 1_000;
            let signedInSince = 0;
            let last = "";
            while (Date.now() < deadline) {
                if (!browser.isConnected()) {
                    throw new FlowError("login_required", "The sign-in window was closed before Google sign-in finished.", [
                        "Retry the request; the sign-in window will open again.",
                    ]);
                }
                const tab = context.pages().find((page) => !page.isClosed() && isFlowUrl(page.url()));
                const state = tab ? await FlowPage.for(tab).accessState().catch(() => undefined) : undefined;
                const line = state ? `signedIn=${state.signedIn} workspace=${state.workspaceAvailable} (${state.pageKind})` : "waiting";
                if (line !== last) {
                    log.info(`Sign-in window: ${line}`);
                    last = line;
                }
                if (state?.workspaceAvailable)
                    return;
                // Signed in but still on the landing page: give redirects a moment, then accept.
                if (state?.signedIn) {
                    signedInSince ||= Date.now();
                    if (Date.now() - signedInSince > 6_000)
                        return;
                }
                else {
                    signedInSince = 0;
                }
                await new Promise((resolve) => setTimeout(resolve, 2_000));
            }
            throw new FlowError("login_required", `Google sign-in was not completed within ${config.loginTimeoutSeconds}s.`, [
                "Retry the request and sign in in the window that opens.",
            ]);
        }
        finally {
            // Back to invisible: quit the visible browser (cookies are flushed on a clean quit).
            await closeBrowserAt(config.cdpUrl);
            rmSync(ownerMarker(), { force: true });
            log.info("Sign-in window closed; the browser will reopen hidden on the next request.");
        }
    }
    async context() {
        // Never attach to the visible sign-in window; wait until it is done.
        if (this.loginFlow)
            await this.loginFlow.catch(() => undefined);
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
            // Re-attaching to our own hidden browser (e.g. after an MCP restart): make sure a hider is running.
            if (this.kind === "cdp_launched" && (config.hideMode === "hidden" || config.hideMode === "offscreen"))
                startWindowHider();
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
        const hidden = config.hideMode === "hidden" || config.hideMode === "offscreen";
        launchChrome({ url: "about:blank", headless: config.headless, hidden, ...(config.headless && userAgent ? { userAgent } : {}) });
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
        writeFileSync(ownerMarker(), JSON.stringify({ launchedAt: new Date().toISOString(), pid: process.pid, hideMode: config.hideMode }), "utf8");
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
