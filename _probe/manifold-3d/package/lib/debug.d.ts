/**
 * Use material properties (like transparency and colour) to debug manifoldCAD
 * models.
 * @packageDocumentation
 * @group ManifoldCAD
 * @category Modelling
 */
import { Document } from '@gltf-transform/core';
import type { Manifold, Mesh } from '../manifold.d.ts';
import type { Properties } from './gltf-io.ts';
import type { GLTFMaterial } from './gltf-node.ts';
export declare function cleanup(): void;
/**
 * Override materials when debugging.
 *
 * When a mesh is flagged with `only`, we set the `ghost` global.
 * Everything gets rendered in the GHOST material, while the flagged
 * mesh is added as a debug node.
 *
 * @param id The `originalID` of the mesh.
 */
export declare const getMaterialByID: (id: number) => GLTFMaterial | undefined;
/**
 * Wrap any shape object with this method to display it and any copies in
 * transparent red. This is particularly useful for debugging `subtract()` as it
 * will allow you find the object even if it doesn't currently intersect the
 * result.
 *
 * @param manifold The object to show - returned for chaining.
 */
export declare function show(manifold: Manifold): Manifold;
/**
 * Wrap any shape object with this method to display it and any copies as the
 * result, while ghosting out the final result in transparent gray. Helpful for
 * debugging as it allows you to see objects that may be hidden in the interior
 * of the result. Multiple objects marked `only()` will all be shown.
 *
 * @param manifold The object to show - returned for chaining.
 */
export declare function only(manifold: Manifold): Manifold;
/**
 *
 * @internal
 */
export declare const getDebugGLTFMesh: (doc: Document, manifoldMesh: Mesh, id2properties: Map<number, Properties>, backupMaterial?: GLTFMaterial) => import("@gltf-transform/core").Node[];
//# sourceMappingURL=debug.d.ts.map