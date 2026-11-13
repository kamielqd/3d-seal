// Copyright 2025 The Manifold Authors.
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
import { getManifoldModuleSync } from "./wasm.js";
const nodes = new Array();
/**
 * The abstract class from which other classes inherit.  Common methods and
 * properties live here.
 * @group Scene Graph
 */
export class BaseGLTFNode {
    /** @internal */
    _parent;
    name;
    // Internally, gltf-transform stores transformations as separate translation,
    // rotation and scale vectors.  It can convert those vectors to and from a
    // transformation matrix as needed.
    translation;
    /**
     * From the reference frame of the model being rotated, rotations are applied
     * in *z-y'-x"* order. That is yaw first, then pitch and finally roll.
     *
     * From the global reference frame, a model will be rotated in *x-y-z* order.
     * That is about the global X axis, then global Y axis, and finally global Z.
     *
     * This matches the behaviour of `Manifold.rotate()`.
     */
    rotation;
    scale;
    constructor(parent) {
        this._parent = parent;
    }
    get parent() {
        return this._parent;
    }
    /**
     * Does this node have any geometry that needs to be converted on export?
     * @internal
     */
    isEmpty() {
        return true;
    }
}
/**
 * Position a manifold model for later export.
 * @group Scene Graph
 */
export class GLTFNode extends BaseGLTFNode {
    manifold;
    material;
    clone(newParent) {
        const copy = new GLTFNode(newParent ?? this.parent);
        Object.assign(copy, this);
        return copy;
    }
    isEmpty() {
        return this.manifold?.isEmpty() ?? true;
    }
}
/**
 * Track created GLTFNodes for top level scripts.
 *
 */
export class GLTFNodeTracked extends GLTFNode {
    constructor(parent) {
        super(parent);
        nodes.push(this);
    }
    clone(newParent) {
        const copy = new GLTFNodeTracked(newParent ?? this.parent);
        Object.assign(copy, this);
        return copy;
    }
}
/**
 * Include an imported model for visualization purposes.
 *
 * These nodes contain models that will be exported into the final GLTF
 * document.  They have not been converted into Manifold objects and cannot be
 * modified. They can only be transformed (rotation, scale, translation) or
 * displayed.
 *
 * This is useful for viewing ManifoldCAD models in the context of a larger
 * assembly.
 *
 * GLTF objects meeting the `manifold-gltf` extension will still be manifold
 * when exported.
 *
 * @group Scene Graph
 */
export class VisualizationGLTFNode extends BaseGLTFNode {
    /** @internal */
    node;
    /** @internal */
    document;
    /** @internal */
    uri;
    constructor(parent) {
        super(parent);
    }
    clone(newParent) {
        const copy = new VisualizationGLTFNode(newParent ?? this.parent);
        Object.assign(copy, this);
        return copy;
    }
    isEmpty() {
        return !this.document;
    }
}
/**
 * Display a CrossSection in 3D space.
 *
 * A CrossSection object is two dimensional.  Attaching it as a node
 * allows it to be included in the final exported file, complete with
 * transformations.
 *
 * > [!NOTE]
 * >
 * > CrossSections are not -- and can never be -- manifold.  That means
 * > some exporters (like `.3mf`) will just skip over them entirely.
 *
 * @group Scene Graph
 */
export class CrossSectionGLTFNode extends BaseGLTFNode {
    crossSection;
    material;
    _runid;
    constructor(parent) {
        super(parent);
    }
    clone(newParent) {
        const copy = new CrossSectionGLTFNode(newParent ?? this.parent);
        Object.assign(copy, this);
        return copy;
    }
    isEmpty() {
        return this.crossSection?.isEmpty() ?? true;
    }
    /**
     * Get the runID for this node.
     * If there is no runID set, lazily assign one.
     *
     * We don't need these for regular operations, but they do help when
     * converting to meshes for export.
     * @internal
     */
    get runID() {
        if (this._runid === undefined) {
            this._runid = getManifoldModuleSync().Manifold.reserveIDs(1);
        }
        return this._runid;
    }
}
/**
 * Get a list of GLTF nodes that have been created in this model.
 *
 * This function only works in scripts directly evaluated by the manifoldCAD
 * website or CLI. When called in an imported library it will always return an
 * empty array, and nodes created in libraries will not be included in the
 * result. This is intentional; libraries must not create geometry as a side
 * effect.
 *
 * @returns An array of GLTFNodes.
 */
export function getGLTFNodes() {
    return nodes;
}
;
/**
 * Clear the list of cached GLTF nodes.
 *
 * This function only works in scripts directly evaluated by the manifoldCAD
 * website or CLI.  When called in an imported library it will have no
 * effect.
 */
export function resetGLTFNodes() {
    nodes.length = 0;
}
;
/**
 * @internal
 */
export const cleanup = () => {
    resetGLTFNodes();
};
/**
 * Map various types to a flat array of GLTFNodes
 *
 * @param any An object or array of models.
 * @returns An array of GLTFNodes.
 */
export async function anyToGLTFNodeList(any) {
    if (Array.isArray(any)) {
        return await any.map(anyToGLTFNodeList)
            .reduce(async (acc, cur) => ([...(await acc), ...(await cur)]), new Promise(resolve => resolve([])));
    }
    else if (any instanceof BaseGLTFNode) {
        return [any];
    }
    else if (any.constructor.name === 'Manifold') {
        const node = new GLTFNode();
        node.manifold = any;
        return [node];
    }
    else if (any.constructor.name === 'CrossSection') {
        const node = new CrossSectionGLTFNode();
        node.crossSection = any;
        return [node];
    }
    throw new Error('Cannot convert model to GLTFNode!');
}
//# sourceMappingURL=gltf-node.js.map