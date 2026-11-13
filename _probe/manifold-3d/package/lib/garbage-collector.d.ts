import type { ManifoldToplevel } from '../manifold.d.ts';
/**
 * Delete any objects tagged for garbage collection.
 */
export declare const cleanup: () => void;
/**
 * Intercept function calls for garbage collection.
 *
 * The returned object of the call will be added to the garbage collection list.
 * When `cleanup()` called, the `delete()` method on that object will be called.
 *
 * @param originalFn
 * @returns
 */
export declare const garbageCollectFunction: (originalFn: any) => any;
/**
 * Set up garbage collection for a white listed set of methods belonging
 * to the Manifold WASM module.
 */
export declare const garbageCollectManifold: (target: ManifoldToplevel) => ManifoldToplevel;
//# sourceMappingURL=garbage-collector.d.ts.map