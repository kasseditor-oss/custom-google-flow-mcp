/**
 * Flow moved from labs.google/fx/tools/flow to flow.google.com (labs URLs now
 * redirect). Both hosts are accepted everywhere.
 */
export const FLOW_HOST_RE = /^https:\/\/(?:flow\.google\.com|labs\.google)(?:\/|$)/i;
export const PROJECT_PATH_RE = /\/project\/[^/?#]+/i;
export function isFlowUrl(url) {
    return FLOW_HOST_RE.test(url);
}
export function isProjectUrl(url) {
    if (!isFlowUrl(url))
        return false;
    try {
        return PROJECT_PATH_RE.test(new URL(url).pathname);
    }
    catch {
        return false;
    }
}
export function isLandingUrl(url) {
    try {
        const parsed = new URL(url);
        return isFlowUrl(url) && /^\/(?:[a-z-]{2,5}\/)?about\/?$/i.test(parsed.pathname);
    }
    catch {
        return false;
    }
}
/** Strips /edit/<id>, query and hash so the URL identifies the project itself. */
export function canonicalProjectUrl(raw) {
    try {
        const url = new URL(raw);
        const match = url.pathname.match(/^(.*?\/project\/[^/]+)/i);
        if (!match)
            return raw;
        url.pathname = match[1];
        url.search = "";
        url.hash = "";
        return url.href;
    }
    catch {
        return raw;
    }
}
