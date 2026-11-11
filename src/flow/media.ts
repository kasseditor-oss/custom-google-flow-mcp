import type { Locator, Page } from "playwright-core";
import { SELECTORS } from "../selectors.js";
import type { MediaKind } from "../types.js";

/** Identity of one rendered media element (ported from the base repo's exact-asset tracking). */
export interface MediaSnapshot {
  index: number;
  keys: string[];
  ready: boolean;
  sourceUrl?: string;
}

export function mediaLocator(page: Page, type: MediaKind): Locator {
  return type === "video" ? SELECTORS.generatedVideo.strategies[0]!.locate(page) : SELECTORS.generatedImage.strategies[0]!.locate(page);
}

export function flattenKeys(snapshots: MediaSnapshot[]): string[] {
  return [...new Set(snapshots.flatMap((snapshot) => snapshot.keys))];
}

/** Media whose identity keys do not overlap the pre-submit baseline. */
export function selectNewMedia(snapshots: MediaSnapshot[], baselineKeys: string[]): MediaSnapshot[] {
  const baseline = new Set(baselineKeys);
  return snapshots.filter((snapshot) => snapshot.keys.length > 0 && !snapshot.keys.some((key) => baseline.has(key)));
}

/**
 * NOTE: the callback runs inside the browser. It must stay self-contained
 * (no references to module scope). Compile with tsc, not tsx/esbuild keepNames.
 */
export async function mediaSnapshots(page: Page, type: MediaKind): Promise<MediaSnapshot[]> {
  return mediaLocator(page, type).evaluateAll((elements) => elements.map((element, index) => {
    const keys: string[] = [];
    let sourceUrl: string | undefined;
    const addUrl = (raw: string | null | undefined) => {
      if (!raw) return;
      try {
        if (sourceUrl === undefined) sourceUrl = new URL(raw, window.location.href).href;
      } catch {
        // ignore
      }
      keys.push(`url:${raw}`);
      if (!raw.startsWith("blob:")) {
        try {
          const parsed = new URL(raw, window.location.href);
          const originalCount = Array.from(parsed.searchParams).length;
          for (const name of Array.from(parsed.searchParams.keys())) {
            if (/^(?:x-goog-|signature$|sig$|expire$|expires$|token$|key-pair-id$)/i.test(name)) parsed.searchParams.delete(name);
          }
          parsed.hash = "";
          parsed.searchParams.sort();
          if (Array.from(parsed.searchParams).length > 0 || originalCount === 0) keys.push(`url-stable:${parsed.toString()}`);
        } catch {
          // ignore
        }
      }
    };

    if (element instanceof HTMLVideoElement) {
      addUrl(element.currentSrc);
      addUrl(element.getAttribute("src"));
      addUrl(element.poster);
      element.querySelectorAll("source").forEach((source) => addUrl(source.src || source.getAttribute("src")));
    } else if (element instanceof HTMLImageElement) {
      addUrl(element.currentSrc);
      addUrl(element.getAttribute("src"));
    }

    let current: Element | null = element;
    for (let depth = 0; current && depth < 6; depth += 1, current = current.parentElement) {
      for (const attribute of ["data-asset-id", "data-generation-id", "data-media-id", "data-media-key"]) {
        const value = current.getAttribute(attribute);
        if (value) keys.push(`${attribute}:${value}`);
      }
    }

    if (!keys.length) {
      const html = element as HTMLElement;
      if (!html.dataset.flowMcpAssetKey) html.dataset.flowMcpAssetKey = `dom:${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      keys.push(html.dataset.flowMcpAssetKey);
    }

    const ready = element instanceof HTMLVideoElement
      ? element.readyState >= 1 && Number.isFinite(element.duration) && element.duration > 0
      : element instanceof HTMLImageElement && element.complete && element.naturalWidth >= 256;
    const unique = Array.from(new Set(keys));
    return sourceUrl ? { index, keys: unique, ready, sourceUrl } : { index, keys: unique, ready };
  }));
}

/** Waits until the gallery stops changing so pre-existing assets are all in the baseline. */
export async function stableBaseline(page: Page, type: MediaKind): Promise<MediaSnapshot[]> {
  const deadline = Date.now() + 4_000;
  let previous = "";
  let stableRounds = 0;
  let snapshots: MediaSnapshot[] = [];
  while (Date.now() < deadline && stableRounds < 2) {
    snapshots = await mediaSnapshots(page, type);
    const signature = JSON.stringify(snapshots.map((snapshot) => snapshot.keys).sort());
    stableRounds = signature === previous ? stableRounds + 1 : 0;
    previous = signature;
    if (stableRounds < 2) await page.waitForTimeout(400);
  }
  return snapshots;
}

/** Nudges lazily-loaded <video> elements to fetch metadata so readiness can be detected. */
export async function nudgeVideos(page: Page): Promise<void> {
  await mediaLocator(page, "video").evaluateAll((elements) => {
    for (const element of elements) {
      if (element instanceof HTMLVideoElement && element.readyState < 1 && (element.networkState === 0 || element.networkState === 3)) {
        element.preload = "metadata";
        element.load();
      }
    }
  }).catch(() => undefined);
}
