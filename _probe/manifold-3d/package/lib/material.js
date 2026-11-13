// Copyright 2022-2025 The Manifold Authors.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
/**
 * Assign glTF materials to manifoldCAD models.
 *
 * @packageDocumentation
 * @group ManifoldCAD
 * @category Modelling
 */
import * as GLTFTransform from '@gltf-transform/core';
import { KHRMaterialsUnlit } from '@gltf-transform/extensions';
import { copyToDocument } from '@gltf-transform/functions';
import { getPropertyResolver } from "./export-model.js";
import { BaseGLTFNode, CrossSectionGLTFNode, GLTFNode } from "./gltf-node.js";
import { getDocumentByID } from "./import-model.js";
const defaultMaterial = {
    roughness: 0.2,
    metallic: 1,
    baseColorFactor: [1, 1, 0],
    alpha: 1,
    unlit: false,
    doubleSided: false
};
const id2material = new Map();
const materialCache = new Map();
export function cleanup() {
    id2material.clear();
    materialCache.clear();
}
/**
 * Return a shallow copy of the input manifold with the given material
 * properties applied. They will be carried along through operations.
 *
 * @param manifold The input object.
 * @param material A set of material properties to apply to this manifold.
 */
export function setMaterial(manifold, material) {
    const out = manifold.asOriginal();
    id2material.set(out.originalID(), material);
    return out;
}
/**
 * @internal
 */
export const getMaterialByID = (id) => {
    return id2material.get(id);
};
/**
 * @internal
 */
export const setMaterialByID = (id, material) => {
    id2material.set(id, material);
};
/**
 * Recurse up the scene graph to find a material.
 * @internal
 */
export function getBackupMaterial(node) {
    if (node != null &&
        (node instanceof GLTFNode || node instanceof CrossSectionGLTFNode)) {
        if (node.material == null) {
            return getBackupMaterial(node.parent);
        }
        return node.material;
    }
    return {};
}
function copyImportedMaterial(doc, matIn = {}) {
    if (!matIn.sourceMaterial || !matIn.sourceRunID) {
        return null;
    }
    // This is an imported material, attached to an existing document.
    // We need to copy it into place.
    const sourceDoc = getDocumentByID(matIn.sourceRunID);
    const sourceMaterial = matIn.sourceMaterial;
    const resolve = getPropertyResolver(doc, sourceDoc);
    copyToDocument(doc, sourceDoc, [sourceMaterial], resolve);
    return resolve(sourceMaterial);
}
function makeDefaultMaterial(doc, matIn = {}) {
    const { roughness, metallic, baseColorFactor, alpha, unlit, doubleSided } = {
        ...defaultMaterial,
        ...matIn
    };
    const material = copyImportedMaterial(doc, matIn) ?? doc.createMaterial(matIn.name ?? '');
    if (unlit) {
        const unlit = doc.createExtension(KHRMaterialsUnlit).createUnlit();
        material.setExtension('KHR_materials_unlit', unlit);
    }
    if (alpha < 1) {
        material.setAlphaMode(GLTFTransform.Material.AlphaMode.BLEND);
    }
    return material.setRoughnessFactor(roughness)
        .setMetallicFactor(metallic)
        .setBaseColorFactor([...baseColorFactor, alpha])
        .setDoubleSided(!!doubleSided || alpha < 1);
}
/**
 *
 * @internal
 */
export function getCachedMaterial(doc, matDef) {
    if (!materialCache.has(matDef)) {
        materialCache.set(matDef, makeDefaultMaterial(doc, matDef));
    }
    return materialCache.get(matDef);
}
//# sourceMappingURL=material.js.map