import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { config } from "../config.js";
import { FlowError } from "../errors.js";
import { log } from "../logger.js";
import { isCdpReachable, launchChrome, waitForCdp } from "./chrome.js";
import { isFlowUrl } from "../flow/urls.js";

export type ConnectionKind = "cdp_attached" | "cdp_launched";

/**
 * Hybrid browser connection:
 *  - "cdp":    attach to an already running Chrome on FLOW_MCP_CDP_URL (default :9222).
 *  - "launch": start real Chrome with the dedicated profile + CDP port, then attach.
 *  - "auto":   attach if reachable, otherwise launch.
 * The MCP never closes a Chrome it attached to, and leaves a launched Chrome
 * running so the logged-in session stays warm between MCP restarts.
 */
export class BrowserSession {
  private browser: Browser | undefined;
  private connecting: Promise<BrowserContext> | undefined;
  private kind: ConnectionKind | undefined;

  get connectionKind(): ConnectionKind | undefined {
    return this.kind;
  }

  get isConnected(): boolean {
    return Boolean(this.browser?.isConnected());
  }

  async context(): Promise<BrowserContext> {
    if (this.browser?.isConnected()) {
      const existing = this.browser.contexts()[0];
      if (existing) return existing;
    }
    this.connecting ??= this.connect().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async connect(): Promise<BrowserContext> {
    const reachable = await isCdpReachable(config.cdpUrl);
    if (!reachable) {
      if (config.browserMode === "cdp") {
        throw new FlowError("browser_error", `No Chrome is listening on ${config.cdpUrl} (FLOW_MCP_BROWSER_MODE=cdp).`, [
          "Run `npm run auth` (or `npm run chrome`) inside custom-google-flow-mcp to start Chrome with the debugging port.",
          `Or start Chrome manually: chrome.exe --remote-debugging-port=${config.cdpPort} --user-data-dir="${config.userDataDir}"`,
        ]);
      }
      launchChrome({ url: config.flowUrl, headless: config.headless });
      await waitForCdp(config.cdpUrl);
      this.kind = "cdp_launched";
    } else {
      this.kind = "cdp_attached";
    }

    try {
      this.browser = await chromium.connectOverCDP(config.cdpUrl, { timeout: 30_000 });
    } catch (error) {
      throw new FlowError("browser_error", `connectOverCDP(${config.cdpUrl}) failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.browser.on("disconnected", () => {
      log.warn("Chrome CDP connection lost; it will be re-established on the next request.");
      this.browser = undefined;
    });
    const context = this.browser.contexts()[0];
    if (!context) throw new FlowError("browser_error", "Chrome exposed no default browser context over CDP.");
    log.info(`Connected to Chrome over CDP (${this.kind}) at ${config.cdpUrl}.`);
    return context;
  }

  /** Reuses an open Flow tab when possible (keeps the user's working tab), else opens one. */
  async primaryPage(): Promise<Page> {
    const context = await this.context();
    const existing = context.pages().find((page) => !page.isClosed() && isFlowUrl(page.url()));
    if (existing) return preparePage(existing);
    const blank = context.pages().find((page) => !page.isClosed() && /^(?:about:blank|chrome:\/\/newtab)/.test(page.url()));
    return preparePage(blank ?? (await context.newPage()));
  }

  async newPage(): Promise<Page> {
    const context = await this.context();
    return preparePage(await context.newPage());
  }

  /**
   * Forgets the connection without closing the user's Chrome. We deliberately
   * do not call browser.close(): over CDP it can terminate the real browser.
   * The websocket is released when the MCP process exits.
   */
  forget(): void {
    this.browser = undefined;
  }
}

function preparePage(page: Page): Page {
  page.setDefaultTimeout(15_000);
  page.setDefaultNavigationTimeout(60_000);
  return page;
}
