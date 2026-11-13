/**
 * Assign glTF materials to manifoldCAD models.
 *
 * @packageDocumentation
 * @group ManifoldCAD
 * @category Modelling
 */
import * as GLTFTransform from '@gltf-transform/core';
import type { Manifold } from '../manifold.d.ts';
import type { GLTFMaterial } from './gltf-node.ts';
import { BaseGLTFNode } from './gltf-node.ts';
export declare function cleanup(): void;
/**
 * Return a shallow copy of the input manifold with the given material
 * properties applied. They will be carried along through operations.
 *
 * @param manifold The input object.
 * @param material A set of material properties to apply to this manifold.
 */
export declare function setMaterial(manifold: Manifold, material: GLTFMaterial): Manifold;
/**
 * @internal
 */
export declare const getMaterialByID: (id: number) => GLTFMaterial | undefined;
/**
 * @internal
 */
export declare const setMaterialByID: (id: number, material: GLTFMaterial) => void;
/**
 * Recurse up the scene graph to find a material.
 * @internal
 */
export declare function getBackupMaterial(node?: BaseGLTFNode): GLTFMaterial;
/**
 *
 * @internal
 */
export declare function getCachedMaterial(doc: GLTFTransform.Document, matDef: GLTFMaterial): GLTFTransform.Material;
//# sourceMappingURL=material.d.ts.map