/**
 * The scene builder provides modelling outside of the native
 * capabilities of Manifold WASM.  This includes scene graphs, materials,
 * and animation functions.  In general, the scene builder
 * follows GLTF semantics.
 *
 * @packageDocumentation
 * @group ManifoldCAD
 * @category Core
 */
import { Document } from '@gltf-transform/core';
import type { Manifold } from '../manifold.d.ts';
import { BaseGLTFNode } from './gltf-node.ts';
export { getAnimationDuration, getAnimationFPS, getAnimationMode, setAnimationDuration, setAnimationFPS, setAnimationMode, setMorphEnd, setMorphStart } from './animation.ts';
export { only, show } from './debug.ts';
export type { GLTFAttribute, GLTFMaterial } from './gltf-node.ts';
export { GLTFNode } from './gltf-node.ts';
export { getCircularSegments, getMinCircularAngle, getMinCircularEdgeLength, resetToCircularDefaults, setCircularSegments, setMinCircularAngle, setMinCircularEdgeLength } from './level-of-detail.ts';
export { setMaterial } from './material.ts';
/**
 * Reset and garbage collect the scene builder and any
 * encapsulated modules.
 *
 * @group Management Functions
 */
export declare function cleanup(): void;
/**
 * Convert a Manifold object into a GLTF-Transform Document.
 *
 * @group Management Functions
 * @param manifold The Manifold object
 * @returns An in-memory GLTF-Transform Document
 */
export declare function manifoldToGLTFDoc(manifold: Manifold): Promise<Document>;
/**
 * Convert a list of GLTF Nodes into a GLTF-Transform Document.
 *
 * @group Management Functions
 * @param nodes A list of GLTF Nodes
 * @returns An in-memory GLTF-Transform Document
 */
export declare function GLTFNodesToGLTFDoc(nodes: Array<BaseGLTFNode>): Promise<Document>;
//# sourceMappingURL=scene-builder.d.ts.map