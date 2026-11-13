/**
 * Exceptions, and where to find them.
 *
 * @packageDocumentation
 * @group ManifoldCAD
 * @category Core
 */
import type { BuildFailure, Location, Message } from 'esbuild-wasm';
export declare class BundlerError extends Error {
    location?: Location;
    error: Message;
    manifoldStack?: string;
    constructor(failure: BuildFailure, options?: ErrorOptions);
    get name(): string;
    get message(): string;
}
export declare class RuntimeError extends Error {
    manifoldStack?: string;
    cause: Error;
    constructor(cause: Error, message?: string, options?: ErrorOptions);
    get name(): string;
}
export declare class UnsupportedFormatError extends Error {
    constructor(identifier: string, supported: Array<{
        mimetype: string;
        extension: string;
    }>);
}
export declare class ImportError extends Error {
}
/**
 * Thrown when an HTTP fetch performed by ManifoldCAD's bundler or model/texture
 * loaders returns a non-2xx response. Carries the status and response body so
 * callers can distinguish transient (5xx, 429) from permanent (4xx) failures.
 */
export declare class FetchError extends Error {
    readonly status: number;
    readonly statusText: string;
    readonly url: string;
    readonly body?: string | undefined;
    constructor(status: number, statusText: string, url: string, body?: string | undefined);
}
//# sourceMappingURL=error.d.ts.map