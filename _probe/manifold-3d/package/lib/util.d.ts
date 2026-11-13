/**
 * Are we in a web worker?
 *
 * @returns A boolean.
 */
export declare const isWebWorker: () => boolean;
/**
 * Are we in Node?
 *
 * @returns A boolean.
 */
export declare const isNode: () => boolean;
/**
 * Attempt to parse a stack trace from a dynamically created function.
 *
 *  This makes the stack trace more readable at the potential cost of confusion
 * if a manifoldCAD user is also constructing new Functions within their model.
 *
 * @internal
 */
export declare const parseStackTrace: (stack: string) => {
    line: number;
    column: number;
    methodName: string | null;
}[];
export declare const getSourceMappedStackTrace: (code: string, error: Error, lineOffset?: number) => string | undefined;
export declare const findExtension: (extension: string, list: Array<{
    extension: string;
}>) => {
    extension: string;
} | null | undefined;
export declare const findMimeType: (mimetype: string, list: Array<{
    mimetype: string;
}>) => {
    mimetype: string;
} | undefined;
export declare function formatLength(mm: number): string;
export declare function formatArea(mm2: number): string;
export declare function formatVolume(mm3: number): string;
/**
 * Wraps `fetch` with retry-on-transient-failure and throws `FetchError` on
 * non-2xx. Retries on HTTP 5xx, HTTP 429, and `TypeError` (network errors
 * like "Failed to fetch"); returns immediately on other 4xx so typo'd URLs
 * fail fast. AbortError and other exceptions propagate untouched.
 *
 * Exponential backoff: 200ms, 600ms; ~800ms worst-case added latency.
 */
export declare function fetchWithRetry(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
//# sourceMappingURL=util.d.ts.map