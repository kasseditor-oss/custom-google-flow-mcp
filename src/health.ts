import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright-core";
import { BrowserSession } from "./browser/session.js";
import { log } from "./logger.js";
import { isCdpReachable } from "./browser/chrome.js";
import { config } from "./config.js";
import { probeSelector, resolveSelector, type SelectorProbe } from "./dom.js";
import { errorText } from "./errors.js";
import { FlowPage, type AccessState } from "./flow/flow-page.js";
import { isFlowUrl } from "./flow/urls.js";
import { HEALTH_CHECK_KEYS, type SelectorKey } from "./selectors.js";

export interface SessionReport {
  browser: {
    mode: string;
    cdp_url: string;
    cdp_reachable_before: boolean;
    connection: string | undefined;
    user_data_dir: string;
  };
  access?: AccessState;
  account?: string;
  ready: boolean;
  next_step: string;
}

export interface HealthReport extends SessionReport {
  checked_at: string;
  selectors: SelectorProbe[];
  failures: string[];
  ok: boolean;
  screenshot?: string;
}

const HOME_KEYS: SelectorKey[] = ["newProjectButton", "projectLink", "accountAvatar", "signInButton"];

async function withPage<T>(session: BrowserSession, useTemporaryTab: boolean, fn: (page: Page) => Promise<T>): Promise<T> {
  session.hold();
  try {
    const page = useTemporaryTab ? await session.newPage() : await session.primaryPage();
    try {
      return await fn(page);
    } finally {
      if (useTemporaryTab) await page.close().catch(() => undefined);
    }
  } finally {
    session.release();
  }
}

function nextStep(access: AccessState | undefined): string {
  if (!access) return "Browser connection failed. Run `npm run auth` in custom-google-flow-mcp.";
  if (!access.signedIn) return "Not signed in. Run `npm run auth` and sign in to Google in the Chrome window.";
  if (!access.workspaceAvailable) return "Signed in but Flow workspace unavailable. Open Flow in the Chrome window and accept its terms.";
  return "Ready. Use flow_generate_video / flow_generate_image / flow_generate_batch.";
}

export async function checkSession(session: BrowserSession, busy: boolean): Promise<SessionReport> {
  const reachable = await isCdpReachable(config.cdpUrl);
  const report: SessionReport = {
    browser: { mode: config.browserMode, cdp_url: config.cdpUrl, cdp_reachable_before: reachable, connection: undefined, user_data_dir: config.userDataDir },
    ready: false,
    next_step: "",
  };
  await withPage(session, busy, async (page) => {
    report.browser.connection = session.connectionKind;
    const flow = FlowPage.for(page);
    if (!isFlowUrl(page.url())) await flow.gotoFlow();
    report.access = await flow.waitForAccess(12_000);
    const account = await flow.accountLabel();
    if (account) report.account = account;
  });
  report.ready = Boolean(report.access?.workspaceAvailable);
  report.next_step = nextStep(report.access);
  if (report.access && !report.access.signedIn && session.canInteractiveLogin) {
    // Open the visible sign-in window in the background; it hides itself again once signed in.
    void session.interactiveLogin().catch((error) => log.warn("Interactive sign-in did not complete", error));
    report.next_step = "Not signed in: a Chrome window was opened for Google sign-in. Ask the user to sign in there; it closes by itself afterwards and work continues invisibly. Then call flow_check_session again.";
  }
  return report;
}

export async function healthCheck(session: BrowserSession, options: { busy: boolean; openProject: boolean }): Promise<HealthReport> {
  const report: HealthReport = {
    checked_at: new Date().toISOString(),
    browser: { mode: config.browserMode, cdp_url: config.cdpUrl, cdp_reachable_before: await isCdpReachable(config.cdpUrl), connection: undefined, user_data_dir: config.userDataDir },
    ready: false,
    next_step: "",
    selectors: [],
    failures: [],
    ok: false,
  };
  let screenshotTaken: string | undefined;
  try {
    await withPage(session, options.busy, async (page) => {
      report.browser.connection = session.connectionKind;
      const flow = FlowPage.for(page);
      if (!isFlowUrl(page.url())) await flow.gotoFlow();
      let access = await flow.waitForAccess(12_000);
      if (access.workspaceAvailable && options.openProject && access.pageKind !== "project") {
        await flow.ensureProject().catch((error) => report.failures.push(`Could not open a project: ${errorText(error)}`));
        access = await flow.accessState();
      }
      report.access = access;
      const account = await flow.accountLabel();
      if (account) report.account = account;
      if (!access.signedIn) report.failures.push("Session is not signed in to Google.");
      else if (!access.workspaceAvailable) report.failures.push("Flow workspace is not available for this account.");

      const keys = access.pageKind === "project" ? HEALTH_CHECK_KEYS : HOME_KEYS;
      // The project SPA re-renders after navigation; wait for the editor before probing.
      if (access.pageKind === "project") await resolveSelector(page, "promptInput", { timeoutMs: 20_000 });
      let probes: SelectorProbe[] = [];
      for (let attempt = 0; attempt < 3; attempt += 1) {
        probes = [];
        for (const key of keys) probes.push(await probeSelector(page, key));
        if (probes.every((probe) => !probe.critical || probe.found)) break;
        await page.waitForTimeout(2_500);
      }
      report.selectors.push(...probes);
      for (const probe of report.selectors) {
        if (probe.critical && !probe.found) report.failures.push(`Critical selector '${probe.key}' (${probe.description}) not found.`);
      }
      if (report.failures.length) screenshotTaken = await capture(flow);
    });
  } catch (error) {
    report.failures.push(errorText(error));
  }
  if (screenshotTaken) report.screenshot = screenshotTaken;
  report.ready = Boolean(report.access?.workspaceAvailable);
  report.ok = report.failures.length === 0;
  report.next_step = report.ok
    ? nextStep(report.access)
    : `${nextStep(report.access)} Inspect the screenshot (if any) and update src/selectors.ts for missing keys.`;
  return report;
}

/** Saves ./logs/error-debug.png (latest) plus a timestamped copy for history. */
async function capture(flow: FlowPage): Promise<string | undefined> {
  await mkdir(config.logDir, { recursive: true });
  const latest = path.join(config.logDir, "error-debug.png");
  const saved = await flow.screenshot(latest);
  if (saved) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await copyFile(latest, path.join(config.logDir, `error-debug-${stamp}.png`)).catch(() => undefined);
  }
  return saved;
}
