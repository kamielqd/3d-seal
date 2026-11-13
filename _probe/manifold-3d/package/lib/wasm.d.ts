/**
 * Convenience functions for instantiating or getting a manifold WASM instance.
 *
 * @packageDocumentation
 * @group ManifoldCAD
 * @category Core
 */
import type { ManifoldToplevel } from '../manifold.d.ts';
/**
 * Tell us how to find `manifold.wasm`.
 * This is important when using a bundler like WebPack.
 *
 * @param url Path to manifold.wasm
 */
export declare function setWasmUrl(url: string): void;
/**
 * Instantiate a new Manifold WASM instance.
 *
 * @returns The newly created instance.
 */
export declare function instantiateManifold(): Promise<ManifoldToplevel>;
/**
 * Instantiate or get the global Manifold WASM instance.
 *
 * @returns A manifold instance.
 */
export declare function getManifoldModule(): Promise<ManifoldToplevel>;
/**
 * Get the global Manifold WASM instance synchronously.
 *
 * @returns A manifold instance.
 */
export declare function getManifoldModuleSync(): ManifoldToplevel | null;
//# sourceMappingURL=wasm.d.ts.map