import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { sleep } from "../dom.js";
import { FlowError, toFlowError } from "../errors.js";
import { log } from "../logger.js";
import { updateManifest } from "../output/manifest.js";
import { assetBaseName, assetsDirectory, projectDirectory, uniqueAssetPath } from "../output/naming.js";
import { extensionFor, probeMedia, sha256 } from "../output/probe.js";
import { FlowPage } from "./flow-page.js";
import { flattenKeys, mediaSnapshots } from "./media.js";
const RATIO_WORDS = { "16:9": "horizontal widescreen", "9:16": "vertical portrait", "1:1": "square" };
/**
 * Executes one generation job on a worker tab. Slot 0 reuses the user's Flow
 * tab/project; extra concurrent slots open their own tab with a *new* Flow
 * project so galleries never mix (exact asset attribution stays correct).
 */
export class FlowGenerator {
    session;
    slots = [];
    pending = new Map();
    constructor(session) {
        this.session = session;
    }
    get busyWorkers() {
        return this.slots.filter((slot) => slot.busy).length;
    }
    acquire() {
        let slot = this.slots.find((candidate) => !candidate.busy);
        if (!slot) {
            slot = { id: this.slots.length, busy: false };
            this.slots.push(slot);
        }
        slot.busy = true;
        return slot;
    }
    async run(job, context) {
        const slot = this.acquire();
        try {
            return await this.execute(job, slot, context);
        }
        catch (raw) {
            const error = toFlowError(raw);
            if (error.code === "cancelled")
                throw error;
            const screenshot = slot.flow && !slot.flow.page.isClosed()
                ? await slot.flow.screenshot(path.join(config.logDir, `job-${job.id.slice(0, 8)}-attempt${job.attempts}.png`))
                : undefined;
            if (error.code === "browser_error") {
                slot.flow = undefined;
                this.session.forget();
            }
            throw new FlowError(error.code, error.message, error.suggestions, screenshot ?? error.diagnosticScreenshot);
        }
        finally {
            slot.busy = false;
        }
    }
    async flowFor(slot) {
        if (slot.flow && !slot.flow.page.isClosed() && this.session.isConnected)
            return slot.flow;
        const page = slot.id === 0 ? await this.session.primaryPage() : await this.session.newPage();
        slot.flow = FlowPage.for(page);
        slot.autoApproveChecked = false;
        return slot.flow;
    }
    async execute(job, slot, context) {
        const spec = job.spec;
        const abortCheck = () => {
            if (context.signal.aborted)
                throw new FlowError("cancelled", "Job cancelled.");
        };
        context.setPhase(`connecting (worker ${slot.id})`);
        const flow = await this.flowFor(slot);
        await flow.ensureReady();
        abortCheck();
        const pending = this.pending.get(job.id);
        let ready;
        let finalPrompt;
        let applied;
        let warnings;
        let projectUrl;
        if (pending) {
            // Resume: credits were already spent on a previous attempt.
            context.setPhase("resuming previous submission");
            projectUrl = await flow.ensureProject({ projectUrl: pending.projectUrl });
            ({ finalPrompt, applied, warnings } = pending);
            if (pending.ready?.length) {
                ready = await this.relocate(flow, spec, pending.ready);
            }
            else {
                const resumeContext = {
                    mediaType: spec.mediaType,
                    baseline: [],
                    baselineKeys: pending.baselineKeys,
                    baselineLines: new Set((await flow.page.locator("body").innerText().catch(() => "")).split(/\n+/).map((l) => l.trim())),
                    submittedAt: Date.now(),
                    promptText: pending.finalPrompt,
                };
                ready = await flow.waitForMedia(resumeContext, pending.expected, spec.timeoutSeconds, {
                    signal: context.signal,
                    onProgress: (message) => context.setPhase(`generating: ${message}`),
                });
                pending.ready = ready;
            }
        }
        else {
            context.setPhase("opening Flow project");
            slot.projectUrl = await flow.ensureProject({
                ...(spec.flowProjectUrl ? { projectUrl: spec.flowProjectUrl } : slot.projectUrl ? { projectUrl: slot.projectUrl } : {}),
                createNew: !spec.flowProjectUrl && !slot.projectUrl && slot.id > 0,
            });
            projectUrl = slot.projectUrl;
            if (!slot.autoApproveChecked) {
                await flow.ensureAutoApprove();
                slot.autoApproveChecked = true;
            }
            abortCheck();
            context.setPhase("configuring");
            const mode = spec.mediaType === "image"
                ? "image"
                : spec.startFrame || spec.endFrame
                    ? "frames_to_video"
                    : spec.referenceImages.length
                        ? "ingredients_to_video"
                        : "text_to_video";
            applied = { mode: await flow.selectMode(mode) };
            const configured = await flow.configure({
                media: spec.mediaType,
                ...(spec.aspectRatio ? { aspectRatio: spec.aspectRatio } : {}),
                outputsCount: spec.outputsCount,
                ...(spec.model ? { model: spec.model } : {}),
            });
            Object.assign(applied, configured.applied);
            warnings = [...configured.warnings];
            const directives = [];
            if (spec.startFrame || spec.endFrame) {
                context.setPhase("uploading frames");
                const frames = await flow.attachFrames(spec.startFrame, spec.endFrame);
                applied.start_frame = frames.start;
                applied.end_frame = frames.end;
                if (frames.directive) {
                    directives.push(frames.directive);
                    warnings.push("Dedicated start/end frame slots not found; frames attached as ingredients with a prompt directive.");
                }
            }
            if (spec.referenceImages.length) {
                context.setPhase("uploading ingredients");
                applied.reference_images = await flow.attachReferences(spec.referenceImages);
            }
            if (spec.mediaType === "video" && spec.cameraMotion) {
                const camera = await flow.applyCameraMotion(spec.cameraMotion);
                applied.camera_motion = camera.via;
                if (camera.directive)
                    directives.push(camera.directive);
            }
            else {
                applied.camera_motion = "not_requested";
            }
            if (applied.aspect_ratio === "prompt" && spec.aspectRatio) {
                directives.push(`Aspect ratio ${spec.aspectRatio} (${RATIO_WORDS[spec.aspectRatio]}).`);
            }
            abortCheck();
            const agentUi = await flow.isAgentUi();
            const noun = spec.mediaType === "video" ? (spec.outputsCount === 1 ? "video" : "videos") : spec.outputsCount === 1 ? "image" : "images";
            const prefix = agentUi || applied.outputs_count !== "ui" ? `Create exactly ${spec.outputsCount === 1 ? "one" : spec.outputsCount} ${noun}: ` : "";
            finalPrompt = `${prefix}${spec.prompt.trim()}${directives.length ? `\n\n${directives.join(" ")}` : ""}`;
            context.setPhase("submitting");
            await flow.fillPrompt(finalPrompt);
            const submitContext = await flow.prepareSubmit(spec.mediaType, finalPrompt);
            await flow.submit(submitContext);
            // From here on credits are spent: remember enough to resume instead of resubmitting.
            const record = {
                projectUrl: projectUrl,
                baselineKeys: submitContext.baselineKeys,
                expected: spec.outputsCount,
                finalPrompt,
                applied,
                warnings,
            };
            this.pending.set(job.id, record);
            context.setPhase("generating");
            try {
                ready = await flow.waitForMedia(submitContext, spec.outputsCount, spec.timeoutSeconds, {
                    signal: context.signal,
                    onProgress: (message) => context.setPhase(`generating: ${message}`),
                });
            }
            catch (error) {
                const code = toFlowError(error).code;
                // Flow explicitly rejected the generation: next attempt must resubmit.
                if (["rate_limited", "server_error", "policy_blocked", "insufficient_credits", "cancelled"].includes(code))
                    this.pending.delete(job.id);
                throw error;
            }
            record.ready = ready;
            if (ready.length < spec.outputsCount)
                warnings.push(`Flow delivered ${ready.length} of ${spec.outputsCount} requested outputs.`);
        }
        abortCheck();
        context.setPhase("downloading");
        const files = await this.save(flow, job, ready);
        const manifestPath = await this.writeManifest(job, files, finalPrompt, projectUrl, applied);
        this.pending.delete(job.id);
        return { files, manifestPath, finalPrompt, flowProjectUrl: projectUrl, applied, warnings };
    }
    /** After a reload, finds the same assets again by identity keys. */
    async relocate(flow, spec, previous) {
        for (let attempt = 0; attempt < 10; attempt += 1) {
            const current = await mediaSnapshots(flow.page, spec.mediaType);
            const matches = previous
                .map((old) => current.find((candidate) => candidate.keys.some((key) => old.keys.includes(key))))
                .filter((match) => Boolean(match));
            if (matches.length === previous.length)
                return matches;
            await sleep(1_500);
        }
        throw new FlowError("download_failed", "Previously generated assets could not be found again in the Flow project.", [
            `Open the Flow project and download manually. Known keys: ${flattenKeys(previous).slice(0, 3).join(", ")}`,
        ]);
    }
    async save(flow, job, media) {
        const spec = job.spec;
        const directory = assetsDirectory(spec.outputDir, spec.projectName);
        await mkdir(directory, { recursive: true });
        const baseName = assetBaseName({
            ...(spec.sceneId ? { sceneId: spec.sceneId } : {}),
            ...(spec.takeNumber ? { takeNumber: spec.takeNumber } : {}),
            mediaType: spec.mediaType,
            createdAt: new Date(job.createdAt),
        });
        const reserved = new Set();
        const saved = [];
        for (let index = 0; index < media.length; index += 1) {
            const { buffer, contentType } = await flow.fetchMedia(media[index], spec.mediaType);
            const file = await uniqueAssetPath({
                directory,
                baseName,
                extension: extensionFor(contentType, spec.mediaType),
                variation: index + 1,
                variationCount: media.length,
                overwrite: spec.overwrite,
                reserved,
            });
            await writeFile(file, buffer);
            const probe = await probeMedia(file);
            saved.push({ path: file, variation: index + 1, contentType, sizeBytes: buffer.length, sha256: sha256(buffer), probe });
            log.info(`Saved ${file} (${(buffer.length / 1_048_576).toFixed(1)} MB)`);
        }
        return saved;
    }
    async writeManifest(job, files, finalPrompt, projectUrl, applied) {
        const spec = job.spec;
        const projectDir = projectDirectory(spec.outputDir, spec.projectName);
        const generatedAt = new Date().toISOString();
        return updateManifest(projectDir, spec.projectName, (manifest) => {
            for (const file of files) {
                const entry = {
                    job_id: job.id,
                    ...(job.batchId ? { batch_id: job.batchId } : {}),
                    ...(spec.sceneId ? { scene_id: spec.sceneId } : {}),
                    ...(spec.takeNumber ? { take_number: spec.takeNumber } : {}),
                    variation: file.variation,
                    media_type: spec.mediaType,
                    file: file.path,
                    relative_file: path.relative(projectDir, file.path).split(path.sep).join("/"),
                    prompt: spec.prompt,
                    final_prompt_sent: finalPrompt,
                    parameters: {
                        ...(spec.aspectRatio ? { aspect_ratio: spec.aspectRatio } : {}),
                        ...(spec.cameraMotion ? { camera_motion: spec.cameraMotion } : {}),
                        outputs_count: spec.outputsCount,
                        ...(spec.model ? { model: spec.model } : {}),
                        seed: null,
                        ...(spec.startFrame ? { start_frame: spec.startFrame } : {}),
                        ...(spec.endFrame ? { end_frame: spec.endFrame } : {}),
                        reference_images: spec.referenceImages,
                        applied_via: applied,
                    },
                    flow_project_url: projectUrl,
                    attempts: job.attempts,
                    generated_at: generatedAt,
                    sha256: file.sha256,
                    size_bytes: file.sizeBytes,
                    content_type: file.contentType,
                    ...(file.probe ? { probe: file.probe } : {}),
                };
                manifest.entries.push(entry);
            }
        });
    }
}
