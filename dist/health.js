import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { isCdpReachable } from "./browser/chrome.js";
import { config } from "./config.js";
import { probeSelector } from "./dom.js";
import { errorText } from "./errors.js";
import { FlowPage } from "./flow/flow-page.js";
import { isFlowUrl } from "./flow/urls.js";
import { HEALTH_CHECK_KEYS } from "./selectors.js";
const HOME_KEYS = ["newProjectButton", "projectLink", "accountAvatar", "signInButton"];
async function withPage(session, useTemporaryTab, fn) {
    const page = useTemporaryTab ? await session.newPage() : await session.primaryPage();
    try {
        return await fn(page);
    }
    finally {
        if (useTemporaryTab)
            await page.close().catch(() => undefined);
    }
}
function nextStep(access) {
    if (!access)
        return "Browser connection failed. Run `npm run auth` in custom-google-flow-mcp.";
    if (!access.signedIn)
        return "Not signed in. Run `npm run auth` and sign in to Google in the Chrome window.";
    if (!access.workspaceAvailable)
        return "Signed in but Flow workspace unavailable. Open Flow in the Chrome window and accept its terms.";
    return "Ready. Use flow_generate_video / flow_generate_image / flow_generate_batch.";
}
export async function checkSession(session, busy) {
    const reachable = await isCdpReachable(config.cdpUrl);
    const report = {
        browser: { mode: config.browserMode, cdp_url: config.cdpUrl, cdp_reachable_before: reachable, connection: undefined, user_data_dir: config.userDataDir },
        ready: false,
        next_step: "",
    };
    await withPage(session, busy, async (page) => {
        report.browser.connection = session.connectionKind;
        const flow = FlowPage.for(page);
        if (!isFlowUrl(page.url()))
            await flow.gotoFlow();
        report.access = await flow.waitForAccess(12_000);
        const account = await flow.accountLabel();
        if (account)
            report.account = account;
    });
    report.ready = Boolean(report.access?.workspaceAvailable);
    report.next_step = nextStep(report.access);
    return report;
}
export async function healthCheck(session, options) {
    const report = {
        checked_at: new Date().toISOString(),
        browser: { mode: config.browserMode, cdp_url: config.cdpUrl, cdp_reachable_before: await isCdpReachable(config.cdpUrl), connection: undefined, user_data_dir: config.userDataDir },
        ready: false,
        next_step: "",
        selectors: [],
        failures: [],
        ok: false,
    };
    let screenshotTaken;
    try {
        await withPage(session, options.busy, async (page) => {
            report.browser.connection = session.connectionKind;
            const flow = FlowPage.for(page);
            if (!isFlowUrl(page.url()))
                await flow.gotoFlow();
            let access = await flow.waitForAccess(12_000);
            if (access.workspaceAvailable && options.openProject && access.pageKind !== "project") {
                await flow.ensureProject().catch((error) => report.failures.push(`Could not open a project: ${errorText(error)}`));
                access = await flow.accessState();
            }
            report.access = access;
            const account = await flow.accountLabel();
            if (account)
                report.account = account;
            if (!access.signedIn)
                report.failures.push("Session is not signed in to Google.");
            else if (!access.workspaceAvailable)
                report.failures.push("Flow workspace is not available for this account.");
            const keys = access.pageKind === "project" ? HEALTH_CHECK_KEYS : HOME_KEYS;
            for (const key of keys)
                report.selectors.push(await probeSelector(page, key));
            for (const probe of report.selectors) {
                if (probe.critical && !probe.found)
                    report.failures.push(`Critical selector '${probe.key}' (${probe.description}) not found.`);
            }
            if (report.failures.length)
                screenshotTaken = await capture(flow);
        });
    }
    catch (error) {
        report.failures.push(errorText(error));
    }
    if (screenshotTaken)
        report.screenshot = screenshotTaken;
    report.ready = Boolean(report.access?.workspaceAvailable);
    report.ok = report.failures.length === 0;
    report.next_step = report.ok
        ? nextStep(report.access)
        : `${nextStep(report.access)} Inspect the screenshot (if any) and update src/selectors.ts for missing keys.`;
    return report;
}
/** Saves ./logs/error-debug.png (latest) plus a timestamped copy for history. */
async function capture(flow) {
    await mkdir(config.logDir, { recursive: true });
    const latest = path.join(config.logDir, "error-debug.png");
    const saved = await flow.screenshot(latest);
    if (saved) {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        await copyFile(latest, path.join(config.logDir, `error-debug-${stamp}.png`)).catch(() => undefined);
    }
    return saved;
}
