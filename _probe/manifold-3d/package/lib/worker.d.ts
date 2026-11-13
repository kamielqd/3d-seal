/**
 * The worker is where everything comes together.
 * It handles worker communication, execution of a model and
 * exporting the final scene as a GLTF-Transform Document or URL encoded
 * Blob.
 *
 * This is an isomorphic module that can be used directly as a JavaScript or
 * TypeScript module.  It can be imported as a web worker, and defines
 * a set of interfaces for communication in that case.
 *
 * @packageDocumentation
 * @group ManifoldCAD
 * @category Core
 */
import { Document } from '@gltf-transform/core';
export type MessageType = 'initialize' | 'evaluate' | 'export' | 'ready' | 'done' | 'error' | 'log' | 'blob';
export interface Message {
    type: MessageType;
}
export declare namespace MessageToWorker {
    /**
     * Initialize the web worker.
     * If this message is not sent, the worker will
     * be initialized when first evaluating a model.
     *
     * The worker will respond with `MessageFromWorker.Ready`
     * or `MessageFromWorker.Error`.
     */
    interface Initialize extends Message {
        type: 'initialize';
        manifoldWasmUrl?: string;
        esbuildWasmUrl?: string;
        esbuildHasOwnWorker?: boolean;
    }
    /**
     * Evaluate a ManifoldCAD script.
     *
     * The worker will respond with `MessageFromWorker.Done`
     * or `MessageFromWorker.Error`.
     *
     * `filename` doesn't have much meaning at the moment, but it
     * is useful for ensuring effective error messages later.
     *
     */
    interface Evaluate extends Message {
        type: 'evaluate';
        code: string;
        filename?: string;
        doNotBundle?: boolean;
        jsCDN?: string;
        fetchRemotePackages?: boolean;
        files?: Record<string, string>;
        baseUrl?: string;
    }
    /**
     * Export an evaluated model as a URL encoded Blob.
     *
     * The worker will respond with `MessageFromWorker.Blob`
     * or `MessageFromWorker.Error`.
     */
    interface Export extends Message {
        type: 'export';
        extension: string;
    }
}
export declare namespace MessageFromWorker {
    /**
     * The worker is instantiated and ready.
     */
    interface Ready extends Message {
        type: 'ready';
    }
    /**
     * The worker has successfully evaluated a model.
     */
    interface Done extends Message {
        type: 'done';
    }
    /**
     * The worker has encountered an error.
     *
     * After an error, the state of the worker is undefined.
     * Discard it and re-instantiate.
     *
     * The stack trace format is platform dependant.  Errors
     * should be formatted into something vaguely node-ish.
     */
    interface Error extends Message {
        type: 'error';
        message: string;
        name?: string;
        stack?: string;
    }
    /**
     * The worker has emitted a log message.
     *
     * This is not an error condition.  Log messages may
     * be sent at any time.
     */
    interface Log extends Message {
        type: 'log';
        message: string;
    }
    /**
     * The worker has successfully exported a model
     * as a URL encoded Blob.
     */
    interface Blob extends Message {
        type: 'blob';
        blobURL: string;
        extension: string;
    }
}
/**
 * Clean up any state from the last run.
 *
 * This includes any outstanding Manifold, Mesh or CrossSection objects,
 * even if referenced elsewhere.
 */
export declare function cleanup(): void;
/**
 * If `bundle` is set to false, the worker will not bundle code,
 * and assume that it has already been bundled.  An undefined
 * value will be treated by default as true.
 */
export interface evaluateOptions {
    filename?: string;
    doNotBundle?: boolean;
    jsCDN?: string;
    fetchRemotePackages?: boolean;
    baseUrl?: string;
}
/**
 * Transform a model from code to a GLTF document.
 *
 * @param code A string containing the code to evaluate.
 * @returns A gltf-transform Document.
 */
export declare function evaluate(code: string, options?: evaluateOptions): Promise<Document>;
/**
 * Convert an in-memory GLTF document to a URL encoded blob.
 *
 * @param doc The GLTF document.
 * @param extension The target file extension.
 * @returns A URL encoded blob.
 */
export declare const exportBlobURL: (doc: Document, extension: string) => Promise<string>;
//# sourceMappingURL=worker.d.ts.map