/** Codes worth retrying with exponential backoff. */
const RETRYABLE = new Set([
    "rate_limited",
    "server_error",
    "generation_failed",
    "generation_timeout",
    "browser_error",
    "download_failed",
]);
export class FlowError extends Error {
    code;
    suggestions;
    diagnosticScreenshot;
    constructor(code, message, suggestions = [], diagnosticScreenshot) {
        super(message);
        this.code = code;
        this.suggestions = suggestions;
        this.diagnosticScreenshot = diagnosticScreenshot;
        this.name = "FlowError";
    }
}
export function toFlowError(error) {
    if (error instanceof FlowError)
        return error;
    const message = error instanceof Error ? error.message : String(error);
    // Playwright raises plain Errors for crashed targets / closed pages.
    if (/Target (?:page, context or browser )?(?:has been )?closed|browser has disconnected|ECONNREFUSED/i.test(message)) {
        return new FlowError("browser_error", message);
    }
    if (/Timeout \d+ms exceeded/i.test(message))
        return new FlowError("ui_changed", message);
    return new FlowError("internal_error", message);
}
export function isRetryable(error) {
    return RETRYABLE.has(toFlowError(error).code);
}
export function errorText(error) {
    const flowError = toFlowError(error);
    const lines = [`Error (${flowError.code}): ${flowError.message}`];
    if (flowError.diagnosticScreenshot)
        lines.push(`Diagnostic screenshot: ${flowError.diagnosticScreenshot}`);
    if (flowError.suggestions.length) {
        lines.push("Suggestions:", ...flowError.suggestions.map((value) => `- ${value}`));
    }
    return lines.join("\n");
}
