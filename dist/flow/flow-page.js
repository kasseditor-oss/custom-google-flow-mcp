import { access } from "node:fs/promises";
import { config } from "../config.js";
import { firstVisible, pressEscape, requireSelector, resolveSelector, sleep, visibleCount, visibleTexts } from "../dom.js";
import { FlowError } from "../errors.js";
import { log } from "../logger.js";
import { sniffContentType } from "../output/probe.js";
import { CAMERA_MOTION_VOCAB, ICON_TAGS, PATTERNS, SELECTORS, TEXT, anyText, withIcon } from "../selectors.js";
import { canonicalProjectUrl, isFlowUrl, isLandingUrl, isProjectUrl } from "./urls.js";
import { flattenKeys, mediaLocator, mediaSnapshots, nudgeVideos, selectNewMedia, stableBaseline } from "./media.js";
const RATIO_SYNONYMS = {
    "16:9": ["16:9", "Paisagem", "Horizontal", "Landscape", "Widescreen"],
    "9:16": ["9:16", "Retrato", "Vertical", "Portrait"],
    "1:1": ["1:1", "Quadrado", "Square"],
};
const CROP_CONFIRM = ["Cortar e salvar", "Recortar e salvar", "Salvar", "Concluir", "Concluído", "Confirmar", "Usar imagem", "Crop and save", "Save", "Done", "Confirm", "Use image"];
const ICON_WORDS = /\b(?:arrow_drop_down|expand_more|check|crop_16_9|crop_9_16|crop_landscape|crop_portrait|crop_square|videocam|image)\b/gi;
export function cleanLabel(value) {
    return value.replace(ICON_WORDS, " ").replace(/[🍌]/g, " ").replace(/\s+/g, " ").trim();
}
export function normalizeId(value) {
    return cleanLabel(value)
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/^gemini\s+/, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}
function parseOutputCount(value) {
    const match = cleanLabel(value).match(/^(?:x\s*)?([1-4])(?:\s*x)?(?:\s+(?:sa[ií]das?|outputs?|resultados?|v[ií]deos?|imagens?|images?|videos?))?$/i);
    return match?.[1] ? Number.parseInt(match[1], 10) : undefined;
}
/**
 * High-level operations on one Google Flow tab. Every DOM lookup goes through
 * src/selectors.ts so UI drift is fixed in one place.
 */
const instances = new WeakMap();
export class FlowPage {
    page;
    networkErrors = [];
    constructor(page) {
        this.page = page;
        page.on("response", (response) => this.onResponse(response));
    }
    /** One wrapper (and one network listener) per tab. */
    static for(page) {
        let flow = instances.get(page);
        if (!flow) {
            flow = new FlowPage(page);
            instances.set(page, flow);
        }
        return flow;
    }
    /** Reads the signed-in account label from the avatar's aria-label, if exposed. */
    async accountLabel() {
        const avatar = await resolveSelector(this.page, "accountAvatar");
        if (!avatar)
            return undefined;
        const label = await avatar.locator.getAttribute("aria-label").catch(() => null)
            ?? await avatar.locator.getAttribute("alt").catch(() => null);
        return label?.trim() || undefined;
    }
    onResponse(response) {
        const status = response.status();
        if (status !== 429 && status < 500)
            return;
        const url = response.url();
        if (!/flow\.google\.com|labs\.google|aisandbox|googleapis\.com/i.test(url))
            return;
        this.networkErrors.push({ status, url, at: Date.now() });
        if (this.networkErrors.length > 50)
            this.networkErrors.shift();
        log.debug(`Flow network error ${status} ${url}`);
    }
    // ---------------------------------------------------------------- session
    async gotoFlow(url = config.flowUrl) {
        await this.page.goto(url, { waitUntil: "domcontentloaded" });
        await this.page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
    }
    async accessState() {
        const url = this.page.url();
        if (/accounts\.google\.com/i.test(url))
            return { url, signedIn: false, workspaceAvailable: false, pageKind: "signed_out" };
        if (isLandingUrl(url)) {
            // Public landing (flow.google.com/about): logged-out users get a ServiceLogin link.
            const loginLink = await resolveSelector(this.page, "signInButton", { allowHidden: true });
            const avatar = await resolveSelector(this.page, "accountAvatar");
            const signedIn = Boolean(avatar) || !loginLink;
            return { url, signedIn, workspaceAvailable: false, pageKind: signedIn ? "landing_or_unavailable" : "signed_out" };
        }
        const inProject = isProjectUrl(url);
        const prompt = await resolveSelector(this.page, "promptInput");
        if (inProject && prompt)
            return { url, signedIn: true, workspaceAvailable: true, pageKind: "project" };
        const signIn = await resolveSelector(this.page, "signInButton");
        if (signIn)
            return { url, signedIn: false, workspaceAvailable: false, pageKind: "signed_out" };
        const projects = await resolveSelector(this.page, "projectLink", { allowHidden: true });
        const newProject = await resolveSelector(this.page, "newProjectButton");
        if (prompt || projects || newProject)
            return { url, signedIn: true, workspaceAvailable: true, pageKind: inProject ? "project" : "home" };
        const avatar = await resolveSelector(this.page, "accountAvatar");
        return { url, signedIn: Boolean(avatar), workspaceAvailable: false, pageKind: avatar ? "landing_or_unavailable" : "signed_out" };
    }
    async waitForAccess(timeoutMs = 15_000) {
        const deadline = Date.now() + timeoutMs;
        let state = await this.accessState();
        while (!state.workspaceAvailable && Date.now() < deadline) {
            await sleep(700);
            state = await this.accessState();
        }
        return state;
    }
    /** Navigates to Flow if needed and asserts the user is logged in with workspace access. */
    async ensureReady() {
        if (!isFlowUrl(this.page.url()))
            await this.gotoFlow();
        let state = await this.waitForAccess();
        if (state.signedIn && !state.workspaceAvailable) {
            // Signed in but parked on the landing page: press "Create with Google Flow" once.
            const enter = await resolveSelector(this.page, "enterAppButton");
            if (enter) {
                await enter.locator.click().catch(() => undefined);
                await this.page.waitForLoadState("domcontentloaded").catch(() => undefined);
                state = await this.waitForAccess(20_000);
            }
        }
        if (!state.signedIn) {
            throw new FlowError("login_required", "Google Flow is not signed in in the automation Chrome profile.", [
                "Run `npm run auth` in custom-google-flow-mcp, sign in to Google in the window that opens, then retry.",
            ]);
        }
        if (!state.workspaceAvailable) {
            throw new FlowError("flow_access_unavailable", "Signed in, but Flow shows its landing page instead of the workspace (account may lack Flow access).", [
                "Open the Chrome window, click 'Create with Flow' / accept terms once, then retry.",
            ]);
        }
        return state;
    }
    /** Opens a given project URL, or the most recent project, or creates a new one. Returns the project URL. */
    async ensureProject(options = {}) {
        if (options.projectUrl) {
            if (canonicalProjectUrl(this.page.url()) !== canonicalProjectUrl(options.projectUrl)) {
                await this.gotoFlow(options.projectUrl);
            }
            if (await resolveSelector(this.page, "promptInput", { timeoutMs: 20_000 }))
                return canonicalProjectUrl(this.page.url());
            throw new FlowError("ui_changed", `Opened ${options.projectUrl} but the prompt editor did not appear.`);
        }
        if (!options.createNew && isProjectUrl(this.page.url()) && (await resolveSelector(this.page, "promptInput", { timeoutMs: 3_000 }))) {
            return canonicalProjectUrl(this.page.url());
        }
        if (isProjectUrl(this.page.url()))
            await this.gotoFlow();
        if (!options.createNew) {
            const recent = await resolveSelector(this.page, "projectLink", { timeoutMs: 6_000 });
            if (recent) {
                await recent.locator.click();
                if (await resolveSelector(this.page, "promptInput", { timeoutMs: 25_000 }))
                    return canonicalProjectUrl(this.page.url());
            }
        }
        const create = await requireSelector(this.page, "newProjectButton", { timeoutMs: 10_000, last: true });
        await create.locator.click();
        await requireSelector(this.page, "promptInput", { timeoutMs: 30_000 });
        await this.page.waitForURL((url) => isProjectUrl(url.href), { timeout: 15_000 }).catch(() => undefined);
        return canonicalProjectUrl(this.page.url());
    }
    // --------------------------------------------------------------- settings
    async openSettings() {
        const alreadyOpen = await firstVisible([this.page.locator('[role="tablist"]'), SELECTORS.autoApproveRadio.strategies[0].locate(this.page)]);
        if (alreadyOpen)
            return true;
        const button = await resolveSelector(this.page, "settingsButton", { timeoutMs: 2_000, last: true });
        if (!button)
            return false;
        await button.locator.click();
        await sleep(500);
        return Boolean(await firstVisible([
            this.page.locator('[role="tablist"]'),
            this.page.locator('[role="dialog"], [role="menu"], [role="listbox"]'),
            SELECTORS.autoApproveRadio.strategies[0].locate(this.page),
        ]));
    }
    async closeSettings(save) {
        if (save) {
            const saveButton = await resolveSelector(this.page, "saveButton", { last: true });
            if (saveButton) {
                await saveButton.locator.click().catch(() => undefined);
                await sleep(400);
                return;
            }
        }
        const close = await resolveSelector(this.page, "closeButton", { last: true });
        if (close)
            await close.locator.click().catch(() => undefined);
        else
            await pressEscape(this.page);
        await sleep(250);
    }
    /** Disables Flow Agent's per-generation credit confirmation (non-fatal if absent). */
    async ensureAutoApprove() {
        try {
            if (!(await this.openSettings()))
                return false;
            const radio = await resolveSelector(this.page, "autoApproveRadio");
            if (!radio) {
                await this.closeSettings(false);
                return false;
            }
            if ((await radio.locator.getAttribute("aria-checked")) !== "true" && !(await radio.locator.isChecked().catch(() => false))) {
                await radio.locator.click();
                await this.closeSettings(true);
                log.info("Enabled Flow AUTO_APPROVE (no repeated credit confirmations).");
            }
            else {
                await this.closeSettings(false);
            }
            return true;
        }
        catch (error) {
            log.warn("Could not verify AUTO_APPROVE setting; continuing.", error);
            await pressEscape(this.page);
            return false;
        }
    }
    /** Detects whether the agent-style UI (tablists in the settings panel) is present. */
    async isAgentUi() {
        return Boolean(await resolveSelector(this.page, "settingsButton")) && Boolean(await resolveSelector(this.page, "autoApproveRadio", { allowHidden: true }));
    }
    async selectMode(mode) {
        const words = {
            text_to_video: TEXT.textToVideo,
            frames_to_video: TEXT.framesToVideo,
            ingredients_to_video: TEXT.ingredientsToVideo,
            image: TEXT.createImage,
        }[mode];
        const selector = await resolveSelector(this.page, "modeSelector");
        if (!selector)
            return "default";
        const current = await selector.locator.innerText().catch(() => "");
        if (anyText(words).test(current))
            return "ui";
        try {
            await selector.locator.click();
            await sleep(300);
            const option = await firstVisible([
                this.page.getByRole("option", { name: anyText(words) }),
                this.page.getByRole("menuitem", { name: anyText(words) }),
                this.page.getByText(anyText(words, true)),
            ]);
            if (!option) {
                await pressEscape(this.page);
                return "default";
            }
            await option.click();
            await sleep(500);
            return "ui";
        }
        catch (error) {
            log.warn(`Mode selection '${mode}' failed`, error);
            await pressEscape(this.page);
            return "failed";
        }
    }
    /** Picks one tab from the media-specific tablist (agent UI). Image settings come first, video last. */
    async chooseTab(media, groupMatch, choose) {
        const lists = this.page.locator('[role="tablist"], [role="radiogroup"]');
        const groups = [];
        const count = await lists.count().catch(() => 0);
        for (let index = 0; index < count; index += 1) {
            const list = lists.nth(index);
            if (!(await list.isVisible().catch(() => false)))
                continue;
            const text = (await list.innerText().catch(() => "")).replace(/\s+/g, " ");
            if (groupMatch(text))
                groups.push(list);
        }
        const group = media === "image" ? groups[0] : groups.at(-1);
        if (!group)
            return false;
        const tabs = group.locator('[role="tab"], [role="radio"], button');
        const tabCount = await tabs.count();
        for (let index = 0; index < tabCount; index += 1) {
            const tab = tabs.nth(index);
            if (choose(await tab.innerText().catch(() => ""))) {
                await tab.click();
                await sleep(200);
                return true;
            }
        }
        return false;
    }
    /** Classic dropdown fallback: open control named `controlWords`, pick option matching `choose`. */
    async chooseFromDropdown(controlWords, choose) {
        const control = await firstVisible([
            this.page.getByRole("combobox", { name: anyText(controlWords) }),
            this.page.getByRole("button", { name: anyText(controlWords) }),
            this.page.locator(controlWords.map((word) => `[aria-label*="${word}" i]`).join(", ")),
        ]);
        if (!control)
            return false;
        await control.click();
        await sleep(300);
        const options = this.page.locator('[role="option"], [role="menuitem"], [role="menuitemradio"], [role="radio"]');
        const count = await options.count();
        for (let index = 0; index < count; index += 1) {
            const option = options.nth(index);
            if (!(await option.isVisible().catch(() => false)))
                continue;
            if (choose(await option.innerText().catch(() => ""))) {
                await option.click();
                await sleep(200);
                return true;
            }
        }
        await pressEscape(this.page);
        return false;
    }
    async listModels(media) {
        const dropdowns = SELECTORS.modelDropdown.strategies[0].locate(this.page);
        const target = media === "image" ? await firstVisible([dropdowns]) : await firstVisible([dropdowns], 20, true);
        if (!target)
            return [];
        await target.click();
        await sleep(300);
        const labels = (await visibleTexts(this.page.locator('[role="menuitem"], [role="option"], [role="menuitemradio"]')))
            .map(cleanLabel)
            .filter((label) => /veo|omni|banana|imagen|gemini/i.test(label));
        await pressEscape(this.page);
        return labels;
    }
    async chooseModel(media, requested) {
        const wanted = normalizeId(requested);
        const dropdowns = SELECTORS.modelDropdown.strategies[0].locate(this.page);
        const target = media === "image" ? await firstVisible([dropdowns]) : await firstVisible([dropdowns], 20, true);
        if (!target)
            return false;
        if (normalizeId(await target.innerText().catch(() => "")).includes(wanted))
            return true;
        await target.click();
        await sleep(300);
        const items = this.page.locator('[role="menuitem"], [role="option"], [role="menuitemradio"]');
        const count = await items.count();
        let fallback = null;
        for (let index = 0; index < count; index += 1) {
            const item = items.nth(index);
            if (!(await item.isVisible().catch(() => false)))
                continue;
            const id = normalizeId(await item.innerText().catch(() => ""));
            if (id === wanted) {
                await item.click();
                return true;
            }
            if (!fallback && id.includes(wanted))
                fallback = item;
        }
        if (fallback) {
            await fallback.click();
            return true;
        }
        await pressEscape(this.page);
        return false;
    }
    /**
     * Applies aspect ratio / outputs / model. Returns how each one was applied.
     * Unapplied aspect ratio and output count fall back to prompt directives.
     */
    async configure(input) {
        const applied = {
            aspect_ratio: input.aspectRatio ? "failed" : "not_requested",
            outputs_count: "failed",
            model: input.model ? "failed" : "not_requested",
        };
        const warnings = [];
        const opened = await this.openSettings();
        try {
            if (input.model) {
                if (await this.chooseModel(input.media, input.model))
                    applied.model = "ui";
                else {
                    const available = await this.listModels(input.media).catch(() => []);
                    throw new FlowError("unsupported_option", `Model '${input.model}' was not found for ${input.media}.`, available.length ? [`Available: ${available.join(", ")}`] : ["Omit model to use Flow's default."]);
                }
            }
            if (input.aspectRatio) {
                const synonyms = RATIO_SYNONYMS[input.aspectRatio];
                const matches = (text) => anyText(synonyms).test(cleanLabel(text));
                const viaTab = opened && (await this.chooseTab(input.media, (text) => /\d+:\d+|paisagem|retrato|landscape|portrait/i.test(text), matches));
                const ok = viaTab || (await this.chooseFromDropdown(TEXT.aspectRatio, matches));
                applied.aspect_ratio = ok ? "ui" : "prompt";
                if (!ok)
                    warnings.push(`Aspect ratio ${input.aspectRatio} control not found; added as prompt directive.`);
            }
            const outputMatch = (text) => parseOutputCount(text) === input.outputsCount;
            const viaTab = opened && (await this.chooseTab(input.media, (text) => text.split(/\s+/).some((part) => parseOutputCount(part) !== undefined), outputMatch));
            const outputsOk = viaTab || (await this.chooseFromDropdown(TEXT.outputs, outputMatch));
            applied.outputs_count = outputsOk ? "ui" : "prompt";
        }
        finally {
            if (opened)
                await this.closeSettings(true);
            await pressEscape(this.page);
        }
        return { applied, warnings };
    }
    // ------------------------------------------------------------- uploads
    async handleCropDialog() {
        const confirm = await firstVisible([
            this.page.locator('[role="dialog"]').getByRole("button", { name: anyText(CROP_CONFIRM) }),
            this.page.getByRole("button", { name: anyText(["Cortar e salvar", "Recortar e salvar", "Crop and save"]) }),
        ]);
        if (confirm) {
            await confirm.click().catch(() => undefined);
            await sleep(800);
        }
    }
    /** Clicks `trigger`, handles the native file chooser (or an intermediate "Upload" menu), sets one file. */
    async uploadVia(trigger, file) {
        if (trigger) {
            let chooser = this.page.waitForEvent("filechooser", { timeout: 5_000 }).catch(() => null);
            await trigger.click().catch(() => undefined);
            let fileChooser = await chooser;
            if (!fileChooser) {
                const upload = await resolveSelector(this.page, "uploadMenuItem", { timeoutMs: 2_000 });
                if (upload) {
                    chooser = this.page.waitForEvent("filechooser", { timeout: 5_000 }).catch(() => null);
                    await upload.locator.click().catch(() => undefined);
                    fileChooser = await chooser;
                }
            }
            if (fileChooser) {
                await fileChooser.setFiles(file);
                await this.afterUpload();
                return true;
            }
        }
        const input = await resolveSelector(this.page, "fileInput", { allowHidden: true, last: true });
        if (!input)
            return false;
        await input.locator.setInputFiles(file);
        await this.afterUpload();
        return true;
    }
    async afterUpload() {
        await sleep(1_200);
        await this.handleCropDialog();
        // Wait for upload spinners to settle.
        const spinner = this.page.locator('[role="progressbar"], mat-progress-spinner, [aria-busy="true"]');
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline && (await visibleCount(spinner, 10)) > 0)
            await sleep(500);
    }
    async attachFrames(start, end) {
        const result = {
            start: start ? "failed" : "not_requested",
            end: end ? "failed" : "not_requested",
        };
        const fallbackFiles = [];
        if (start) {
            await access(start);
            const slot = await resolveSelector(this.page, "startFrameSlot", { timeoutMs: 2_000 });
            if (slot && (await this.uploadVia(slot.locator, start)))
                result.start = "ui";
            else
                fallbackFiles.push(start);
        }
        if (end) {
            await access(end);
            const slot = await resolveSelector(this.page, "endFrameSlot", { timeoutMs: 2_000 });
            if (slot && (await this.uploadVia(slot.locator, end)))
                result.end = "ui";
            else
                fallbackFiles.push(end);
        }
        if (fallbackFiles.length) {
            // No dedicated frame slots: attach as ingredients and describe their role in the prompt.
            const attached = await this.attachReferences(fallbackFiles);
            if (attached === "ui") {
                const parts = [];
                if (start && result.start !== "ui") {
                    result.start = "prompt";
                    parts.push("the first attached image as the exact opening frame");
                }
                if (end && result.end !== "ui") {
                    result.end = "prompt";
                    parts.push(`the ${start && result.start === "prompt" ? "second" : "attached"} image as the exact final frame`);
                }
                result.directive = `Use ${parts.join(" and ")}.`;
            }
        }
        return result;
    }
    async attachReferences(files) {
        if (!files.length)
            return "not_requested";
        for (const file of files) {
            await access(file).catch(() => {
                throw new FlowError("validation_error", `Reference file not found: ${file}`);
            });
        }
        for (const file of files) {
            const add = await resolveSelector(this.page, "addMediaButton", { timeoutMs: 2_000 });
            const ok = await this.uploadVia(add?.locator ?? null, file);
            if (!ok) {
                throw new FlowError("ui_changed", "Could not find a way to upload reference images (no add-media button or file input).", [
                    "Run flow_health_check and update addMediaButton/fileInput in src/selectors.ts.",
                ]);
            }
        }
        return "ui";
    }
    async applyCameraMotion(motion) {
        const vocab = CAMERA_MOTION_VOCAB[motion];
        const button = await resolveSelector(this.page, "cameraControlButton");
        if (button) {
            try {
                await button.locator.click();
                await sleep(400);
                const option = await firstVisible([
                    this.page.getByRole("option", { name: anyText(vocab.labels) }),
                    this.page.getByRole("menuitem", { name: anyText(vocab.labels) }),
                    this.page.getByRole("radio", { name: anyText(vocab.labels) }),
                    this.page.getByRole("button", { name: anyText(vocab.labels) }),
                    this.page.locator(vocab.labels.map((label) => `[aria-label*="${label}" i]`).join(", ")),
                ]);
                if (option) {
                    await option.click();
                    await sleep(300);
                    await pressEscape(this.page);
                    return { via: "ui" };
                }
            }
            catch (error) {
                log.debug("Camera control UI failed, falling back to prompt directive", error);
            }
            await pressEscape(this.page);
        }
        return { via: "prompt", directive: `Camera: ${vocab.directive}` };
    }
    // -------------------------------------------------------------- prompt
    async fillPrompt(text) {
        const editor = (await requireSelector(this.page, "promptInput", { timeoutMs: 10_000, last: true })).locator;
        const tag = await editor.evaluate((element) => element.tagName.toLowerCase());
        if (tag === "textarea" || tag === "input") {
            await editor.fill(text);
        }
        else {
            await editor.click();
            await this.page.keyboard.press("ControlOrMeta+A");
            await this.page.keyboard.press("Delete");
            await this.page.keyboard.insertText(text);
        }
        await sleep(200);
        const value = tag === "textarea" || tag === "input" ? await editor.inputValue().catch(() => "") : await editor.innerText().catch(() => "");
        if (!value.trim())
            throw new FlowError("ui_changed", "Prompt editor did not accept the text.");
    }
    async bodyLines() {
        const body = await this.page.locator("body").innerText().catch(() => "");
        return body.split(/\n+/).map((line) => line.trim()).filter(Boolean);
    }
    async prepareSubmit(mediaType, promptText) {
        const baseline = await stableBaseline(this.page, mediaType);
        return {
            mediaType,
            baseline,
            baselineKeys: flattenKeys(baseline),
            baselineLines: new Set(await this.bodyLines()),
            submittedAt: Date.now(),
            promptText,
        };
    }
    /** Clicks Generate and handles the agent credit-approval step if it appears. */
    async submit(context) {
        const checkIcons = this.page.locator(ICON_TAGS).filter({ hasText: /^check$/ });
        const approvalBaseline = await visibleCount(checkIcons);
        const button = (await requireSelector(this.page, "generateButton", { timeoutMs: 5_000, last: true })).locator;
        const enabledDeadline = Date.now() + 10_000;
        while (!(await button.isEnabled().catch(() => true)) && Date.now() < enabledDeadline)
            await sleep(400);
        if (!(await button.isEnabled().catch(() => true))) {
            throw new FlowError("generation_failed", "Generate button stayed disabled (upload still processing or prompt rejected).");
        }
        context.submittedAt = Date.now();
        this.networkErrors = [];
        await button.click();
        await sleep(800);
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline) {
            await this.throwIfFailed(context);
            // Agent UI: a new "check" (approve) button appears for credit confirmation.
            if ((await visibleCount(checkIcons)) > approvalBaseline) {
                const check = await firstVisible([checkIcons], 50, true);
                const approve = check?.locator("xpath=ancestor::button[1]");
                if (approve && (await approve.isVisible().catch(() => false))) {
                    await approve.click().catch(() => undefined);
                    log.info("Approved Flow credit confirmation.");
                    return;
                }
            }
            // Classic UI: confirmation dialog.
            const dialogConfirm = await firstVisible([
                this.page.locator('[role="dialog"], [role="alertdialog"]').getByRole("button", { name: anyText(["Continuar", "Confirmar", "Gerar", "Continue", "Confirm", "Generate"]) }),
            ]);
            if (dialogConfirm) {
                await dialogConfirm.click().catch(() => undefined);
                return;
            }
            // Generation visibly started: new media placeholder or progress indicator.
            const progress = await firstVisible([this.page.getByText(/^\d{1,3}\s?%$/), this.page.locator('[role="progressbar"]')]);
            if (progress)
                return;
            if ((await mediaLocator(this.page, context.mediaType).count().catch(() => 0)) > context.baseline.length)
                return;
            if (Date.now() - context.submittedAt > 8_000)
                return; // assume started; waitForMedia keeps watching for errors
            await sleep(700);
        }
    }
    /** Classifies only text that appeared after submit (avoids matching old prompts in the history). */
    async throwIfFailed(context) {
        const recentNetwork = this.networkErrors.filter((entry) => entry.at >= context.submittedAt && /generat|video|image|batch|aisandbox/i.test(entry.url));
        if (recentNetwork.some((entry) => entry.status === 429)) {
            throw new FlowError("rate_limited", "Flow API returned HTTP 429 (rate limit).");
        }
        const newText = (await this.bodyLines())
            .filter((line) => !context.baselineLines.has(line) && !context.promptText.includes(line) && line.length < 400)
            .join("\n");
        if (newText) {
            if (PATTERNS.credits.test(newText))
                throw new FlowError("insufficient_credits", `Flow reports insufficient credits: ${excerpt(newText, PATTERNS.credits)}`);
            if (PATTERNS.policy.test(newText))
                throw new FlowError("policy_blocked", `Flow blocked the prompt by policy: ${excerpt(newText, PATTERNS.policy)}`, ["Rephrase the prompt; retrying the same text will not help."]);
            if (PATTERNS.rateLimit.test(newText))
                throw new FlowError("rate_limited", `Flow rate limit: ${excerpt(newText, PATTERNS.rateLimit)}`);
            if (PATTERNS.failure.test(newText))
                throw new FlowError("server_error", `Flow reported a generation failure: ${excerpt(newText, PATTERNS.failure)}`);
            if (PATTERNS.login.test(newText))
                throw new FlowError("login_required", "Flow session expired during generation.");
        }
        if (recentNetwork.filter((entry) => entry.status >= 500).length >= 3) {
            throw new FlowError("server_error", `Flow API returned repeated 5xx errors (${recentNetwork.map((e) => e.status).join(", ")}).`);
        }
    }
    async waitForMedia(context, expected, timeoutSeconds, options = {}) {
        const deadline = Date.now() + timeoutSeconds * 1_000;
        let lastReport = "";
        let bestSoFar = [];
        let stableSince;
        while (Date.now() < deadline) {
            if (options.signal?.aborted)
                throw new FlowError("cancelled", "Job cancelled.");
            await this.throwIfFailed(context);
            if (context.mediaType === "video")
                await nudgeVideos(this.page);
            const candidates = selectNewMedia(await mediaSnapshots(this.page, context.mediaType), context.baselineKeys);
            const ready = [];
            for (const candidate of candidates) {
                if (candidate.ready || (await this.isSourceReady(candidate, context.mediaType)))
                    ready.push(candidate);
            }
            const percent = await this.page.getByText(/^\d{1,3}\s?%$/).first().innerText({ timeout: 500 }).catch(() => "");
            const report = `${ready.length}/${expected} ready${percent ? ` (Flow progress ${percent.trim()})` : ""}`;
            if (report !== lastReport) {
                options.onProgress?.(report);
                lastReport = report;
            }
            if (ready.length >= expected)
                return ready.slice(0, expected).sort((a, b) => a.index - b.index);
            // Flow sometimes delivers fewer outputs than requested (e.g. one blocked). Accept after 60s of stability.
            if (ready.length > 0 && ready.length === bestSoFar.length) {
                stableSince ??= Date.now();
                if (Date.now() - stableSince > 60_000 && !percent)
                    return ready.sort((a, b) => a.index - b.index);
            }
            else {
                stableSince = undefined;
            }
            bestSoFar = ready;
            await sleep(2_500);
        }
        if (bestSoFar.length)
            return bestSoFar;
        throw new FlowError("generation_timeout", `No new ${context.mediaType} appeared within ${timeoutSeconds}s.`);
    }
    async isSourceReady(candidate, type) {
        if (!candidate.sourceUrl || candidate.sourceUrl.startsWith("blob:"))
            return false;
        try {
            const response = await this.page.context().request.head(candidate.sourceUrl, { timeout: 8_000 });
            const contentType = response.headers()["content-type"]?.toLowerCase() ?? "";
            const ok = response.ok() && contentType.startsWith(`${type}/`);
            await response.dispose();
            return ok;
        }
        catch {
            return false;
        }
    }
    // ------------------------------------------------------------ download
    /** Fetches the asset bytes using the logged-in session (blob: via page, https: via context request). */
    async fetchMedia(snapshot, type) {
        if (!snapshot.sourceUrl) {
            return this.downloadViaMenu(snapshot, type);
        }
        try {
            let contentType;
            let buffer;
            if (snapshot.sourceUrl.startsWith("blob:")) {
                const captured = await this.page.evaluate(async (url) => {
                    const response = await fetch(url);
                    if (!response.ok)
                        throw new Error(`HTTP ${response.status}`);
                    const bytes = new Uint8Array(await response.arrayBuffer());
                    let binary = "";
                    for (let index = 0; index < bytes.length; index += 32_768) {
                        binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(index, index + 32_768)));
                    }
                    return { base64: btoa(binary), contentType: response.headers.get("content-type") ?? "" };
                }, snapshot.sourceUrl);
                buffer = Buffer.from(captured.base64, "base64");
                contentType = captured.contentType;
            }
            else {
                const response = await this.page.context().request.get(snapshot.sourceUrl, { timeout: 180_000 });
                if (!response.ok())
                    throw new FlowError("download_failed", `HTTP ${response.status()} downloading asset.`);
                buffer = await response.body();
                contentType = response.headers()["content-type"] ?? "";
                await response.dispose();
            }
            contentType = contentType.toLowerCase();
            if (!contentType.startsWith(`${type}/`))
                contentType = sniffContentType(buffer) ?? contentType;
            if (!contentType.startsWith(`${type}/`)) {
                throw new FlowError("download_failed", `Expected ${type}/*, got '${contentType || "unknown"}'.`);
            }
            return { buffer, contentType };
        }
        catch (error) {
            log.warn("Direct fetch failed; trying Flow's download menu.", error);
            return this.downloadViaMenu(snapshot, type);
        }
    }
    /** Fallback: right-click / more_vert -> Download, capturing the browser download event. */
    async downloadViaMenu(snapshot, type) {
        const media = mediaLocator(this.page, type).nth(snapshot.index);
        await media.scrollIntoViewIfNeeded().catch(() => undefined);
        await media.dispatchEvent("contextmenu", { button: 2 }).catch(() => undefined);
        await sleep(300);
        let item = await resolveSelector(this.page, "downloadMenuItem", { timeoutMs: 1_500 });
        if (!item) {
            await pressEscape(this.page);
            await media.hover().catch(() => undefined);
            const more = await firstVisible([
                media.locator("xpath=ancestor-or-self::*[position() <= 5]//button").filter({ has: this.page.locator(ICON_TAGS, { hasText: /^more_vert$|^more_horiz$/ }) }),
                withIcon(this.page, /^more_vert$|^more_horiz$/, "button"),
            ], 20, true);
            if (more)
                await more.click().catch(() => undefined);
            item = await resolveSelector(this.page, "downloadMenuItem", { timeoutMs: 2_000 });
        }
        if (!item)
            throw new FlowError("download_failed", "Asset has no fetchable URL and Flow's download menu was not found.");
        const downloadPromise = this.page.waitForEvent("download", { timeout: 120_000 });
        await item.locator.click();
        // Some versions open a resolution submenu; prefer original / non-upscaled entries.
        const submenu = await firstVisible([
            this.page.getByRole("menuitem", { name: /original|tamanho original|full size|720p|1080p|gif/i }),
        ]);
        if (submenu)
            await submenu.click().catch(() => undefined);
        const download = await downloadPromise;
        const file = await download.path();
        if (!file)
            throw new FlowError("download_failed", "Browser download did not produce a file.");
        const { readFile } = await import("node:fs/promises");
        const buffer = await readFile(file);
        const contentType = sniffContentType(buffer) ?? (type === "video" ? "video/mp4" : "image/png");
        return { buffer, contentType };
    }
    async screenshot(file) {
        try {
            await this.page.screenshot({ path: file, fullPage: false });
            return file;
        }
        catch {
            return undefined;
        }
    }
}
function excerpt(text, pattern) {
    const line = text.split("\n").find((value) => pattern.test(value)) ?? text;
    return line.slice(0, 200);
}
