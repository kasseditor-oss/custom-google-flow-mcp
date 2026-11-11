#!/usr/bin/env node
/**
 * npm run auth   -> opens the dedicated Chrome profile with CDP on :9222 and waits until you are signed in to Flow.
 * npm run chrome -> only starts that Chrome (no waiting), e.g. after a reboot.
 *
 * Chrome is started as a normal process (not an automation build), so Google
 * sign-in / 2FA works and the session persists inside the dedicated profile.
 */
import { chromium } from "playwright-core";
import { closeBrowserAt, isCdpReachable, launchChrome, waitForCdp } from "../browser/chrome.js";
import { rmSync } from "node:fs";
import { config } from "../config.js";
import { ownerMarker } from "../browser/session.js";
import { FlowPage } from "../flow/flow-page.js";
import { isFlowUrl } from "../flow/urls.js";
const noWait = process.argv.includes("--no-wait");
const say = (message) => process.stdout.write(`${message}\n`);
async function main() {
    say(`Profile : ${config.userDataDir}`);
    say(`CDP     : ${config.cdpUrl}`);
    if (await isCdpReachable(config.cdpUrl)) {
        // It may be the MCP's invisible (headless) instance; restart it with a window.
        say("Closing the running background browser so it can reopen with a window...");
        await closeBrowserAt(config.cdpUrl);
    }
    rmSync(ownerMarker(), { force: true });
    launchChrome({ url: config.flowUrl, headless: false });
    await waitForCdp(config.cdpUrl);
    say("Browser started.");
    if (noWait) {
        say("Done. Leave this Chrome window open (you can minimize it).");
        return;
    }
    const browser = await chromium.connectOverCDP(config.cdpUrl);
    const context = browser.contexts()[0];
    if (!context)
        throw new Error("No browser context exposed over CDP.");
    let page = context.pages().find((candidate) => isFlowUrl(candidate.url()));
    if (!page) {
        page = await context.newPage();
        await page.goto(config.flowUrl, { waitUntil: "domcontentloaded" });
    }
    await page.bringToFront().catch(() => undefined);
    say("");
    say("==> In the Chrome window: sign in with your Google account (2FA if asked),");
    say("    then make sure the Flow workspace opens (accept terms / 'Create with Flow' if shown).");
    say("    Waiting up to 10 minutes...");
    const deadline = Date.now() + 10 * 60_000;
    let last = "";
    while (Date.now() < deadline) {
        const flowTab = context.pages().find((candidate) => !candidate.isClosed() && isFlowUrl(candidate.url()));
        if (flowTab) {
            const state = await FlowPage.for(flowTab).accessState().catch(() => undefined);
            const line = state ? `signedIn=${state.signedIn} workspace=${state.workspaceAvailable} (${state.pageKind})` : "checking...";
            if (line !== last) {
                say(`    ${line}`);
                last = line;
            }
            if (state?.workspaceAvailable) {
                say("");
                say("OK! Google Flow session is ready and saved in the dedicated profile.");
                say("Closing this window. From now on the MCP opens the browser invisibly when");
                say("it needs Google Flow and closes it again when idle.");
                await closeBrowserAt(config.cdpUrl);
                process.exit(0);
            }
        }
        await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
    say("Timed out waiting for sign-in. Run `npm run auth` again.");
    process.exit(1);
}
main().catch((error) => {
    process.stderr.write(`auth failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
});
