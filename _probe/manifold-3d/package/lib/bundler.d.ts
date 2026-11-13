import * as esbuild from 'esbuild-wasm';
export declare const setWasmUrl: (url: string) => void;
export declare const setHasOwnWorker: (x: boolean) => void;
/**
 * These content delivery networks provide NPM modules as ES modules,
 * whether they were published that way or not.
 */
export declare const cdnUrlHelpers: {
    [key: string]: (specifier: string) => string;
};
export interface BundlerOptions {
    jsCDN?: string;
    fetchRemotePackages?: boolean;
    filename?: string;
    files?: Record<string, string>;
    resolveDir?: string;
}
/**
 * This is a plugin for esbuild that has three functions:
 *   * It resolves NPM packages to urls served by various CDNs.
 *   * It fetches imports from http/https urls.
 *   * It provides evaluation context to npm packages.
 *
 * ManifoldCAD libraries can include `manifold-3d/manifoldCAD` to get access to
 * the evaluator context.  Outside of the evaluator, this involves importing a
 * module.  Inside the evaluator, imports are in the global namespace.  The
 * imported module will not be able to see the actual evaluator context.  Here,
 * we will swap it out for an object we will inject at evaluation time.
 */
export declare const esbuildManifoldPlugin: (options?: BundlerOptions) => esbuild.Plugin;
export declare const bundleFile: (entrypoint: string, options?: BundlerOptions) => Promise<string>;
export declare const bundleCode: (code: string, options?: BundlerOptions) => Promise<string>;
//# sourceMappingURL=bundler.d.ts.map