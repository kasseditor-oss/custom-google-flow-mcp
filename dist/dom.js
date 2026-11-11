import { FlowError } from "./errors.js";
import { log } from "./logger.js";
import { SELECTORS } from "./selectors.js";
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function isVisible(locator) {
    return locator.isVisible().catch(() => false);
}
/** First visible element among candidate locators (checks up to `perLocator` matches each). */
export async function firstVisible(locators, perLocator = 20, fromEnd = false) {
    for (const locator of locators) {
        const count = await locator.count().catch(() => 0);
        const limit = Math.min(count, perLocator);
        for (let step = 0; step < limit; step += 1) {
            const index = fromEnd ? count - 1 - step : step;
            const candidate = locator.nth(index);
            if (await isVisible(candidate))
                return candidate;
        }
    }
    return null;
}
export async function visibleCount(locator, max = 100) {
    const count = Math.min(await locator.count().catch(() => 0), max);
    let visible = 0;
    for (let index = 0; index < count; index += 1) {
        if (await isVisible(locator.nth(index)))
            visible += 1;
    }
    return visible;
}
export async function visibleTexts(locator, max = 100) {
    const values = [];
    const count = Math.min(await locator.count().catch(() => 0), max);
    for (let index = 0; index < count; index += 1) {
        const candidate = locator.nth(index);
        if (!(await isVisible(candidate)))
            continue;
        const text = (await candidate.innerText().catch(() => "")).trim();
        if (text)
            values.push(text);
    }
    return [...new Set(values)];
}
function defOf(keyOrDef) {
    return typeof keyOrDef === "string" ? SELECTORS[keyOrDef] : keyOrDef;
}
/**
 * Tries every strategy in order and returns the first visible match.
 * Polls until `timeoutMs` elapses. `last` picks the last visible match (useful
 * for "the newest" button when several exist).
 */
export async function resolveSelector(page, keyOrDef, options = {}) {
    const selector = defOf(keyOrDef);
    const deadline = Date.now() + (options.timeoutMs ?? 0);
    do {
        for (const strategy of selector.strategies) {
            let locator;
            try {
                locator = strategy.locate(page);
            }
            catch {
                continue;
            }
            if (options.allowHidden) {
                const count = await locator.count().catch(() => 0);
                if (count > 0)
                    return { locator: options.last ? locator.last() : locator.first(), strategy: strategy.label };
                continue;
            }
            const match = await firstVisible([locator], 20, options.last ?? false);
            if (match) {
                if (strategy !== selector.strategies[0]) {
                    log.debug(`Selector '${selector.key}' healed via fallback strategy '${strategy.label}'.`);
                }
                return { locator: match, strategy: strategy.label };
            }
        }
        if (Date.now() >= deadline)
            break;
        await sleep(400);
    } while (Date.now() < deadline);
    return null;
}
export async function requireSelector(page, key, options = {}) {
    const resolved = await resolveSelector(page, key, options);
    if (!resolved) {
        const selector = SELECTORS[key];
        throw new FlowError("ui_changed", `Could not locate '${selector.key}' (${selector.description}). Tried: ${selector.strategies.map((s) => s.label).join(" | ")}.`, ["Run flow_health_check to capture a diagnostic screenshot.", "Update the strategies for this key in src/selectors.ts."]);
    }
    return resolved;
}
/** Non-throwing probe used by the health check. */
export async function probeSelector(page, key) {
    const selector = SELECTORS[key];
    for (const strategy of selector.strategies) {
        const locator = strategy.locate(page);
        const visible = await visibleCount(locator, 30);
        if (visible > 0) {
            return { key, description: selector.description, critical: selector.critical, found: true, visibleCount: visible, strategy: strategy.label };
        }
    }
    // Hidden-but-attached (e.g. <input type=file>) still counts as present.
    for (const strategy of selector.strategies) {
        const count = await strategy.locate(page).count().catch(() => 0);
        if (count > 0) {
            return { key, description: selector.description, critical: selector.critical, found: true, visibleCount: 0, strategy: strategy.label, attachedOnly: true };
        }
    }
    return { key, description: selector.description, critical: selector.critical, found: false, visibleCount: 0 };
}
export async function pressEscape(page, times = 1) {
    for (let index = 0; index < times; index += 1) {
        await page.keyboard.press("Escape").catch(() => undefined);
        await sleep(120);
    }
}
