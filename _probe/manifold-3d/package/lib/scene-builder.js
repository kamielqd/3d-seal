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
 * The scene builder provides modelling outside of the native
 * capabilities of Manifold WASM.  This includes scene graphs, materials,
 * and animation functions.  In general, the scene builder
 * follows GLTF semantics.
 *
 * @packageDocumentation
 * @group ManifoldCAD
 * @category Core
 */
import { Document, Extension, Material, Node, PropertyType } from '@gltf-transform/core';
import { copyToDocument, dedup, unpartition } from '@gltf-transform/functions';
import { addAnimationToDoc, addMotion, cleanup as cleanupAnimation, cleanupAnimationInDoc, getMorph, morphEnd, morphStart, setMorph } from "./animation.js";
import { cleanup as cleanupDebug, getDebugGLTFMesh, getMaterialByID } from "./debug.js";
import { cleanup as cleanupExport, getPropertyResolver } from "./export-model.js";
import { attributeDefs, writeMesh } from "./gltf-io.js";
import { BaseGLTFNode, CrossSectionGLTFNode, GLTFNode, VisualizationGLTFNode } from "./gltf-node.js";
import { cleanup as cleanupImport } from "./import-model.js";
import { cleanup as cleanupMaterial, getBackupMaterial, getCachedMaterial } from "./material.js";
import { euler2quat } from "./math.js";
import { formatArea, formatLength, formatVolume } from "./util.js";
import { getManifoldModuleSync } from "./wasm.js";
export { getAnimationDuration, getAnimationFPS, getAnimationMode, setAnimationDuration, setAnimationFPS, setAnimationMode, setMorphEnd, setMorphStart } from "./animation.js";
export { only, show } from "./debug.js";
export { GLTFNode } from "./gltf-node.js";
export { getCircularSegments, getMinCircularAngle, getMinCircularEdgeLength, resetToCircularDefaults, setCircularSegments, setMinCircularAngle, setMinCircularEdgeLength } from "./level-of-detail.js";
export { setMaterial } from "./material.js";
/**
 * Reset and garbage collect the scene builder and any
 * encapsulated modules.
 *
 * @group Management Functions
 */
export function cleanup() {
    cleanupAnimation();
    cleanupDebug();
    cleanupMaterial();
    cleanupImport();
    cleanupExport();
}
// Swallow informational logs in testing framework
function log(...args) {
    if (typeof self !== 'undefined' && self.console) {
        self.console.log(...args);
    }
}
function applyTransformation(doc, sourceNode, targetNode) {
    // Animation Motion
    const pos = addMotion(doc, 'translation', sourceNode, targetNode);
    if (pos != null) {
        targetNode.setTranslation(pos);
    }
    const rot = addMotion(doc, 'rotation', sourceNode, targetNode);
    if (rot != null) {
        targetNode.setRotation(euler2quat(rot));
    }
    const scale = addMotion(doc, 'scale', sourceNode, targetNode);
    if (scale != null) {
        targetNode.setScale(scale);
    }
}
function writeManifold(doc, node, nodeDef, backupMaterial = {}) {
    if (nodeDef.name)
        node.setName(nodeDef.name);
    const manifold = nodeDef.manifold;
    var normalIdx = -1;
    if (nodeDef.material?.attributes != null) {
        const { attributes } = nodeDef.material;
        if (attributes.includes('NORMAL')) {
            normalIdx = 0;
            for (const attribute of attributes) {
                if (attribute === 'NORMAL')
                    break;
                normalIdx += attributeDefs[attribute].components;
            }
        }
    }
    const manifoldMesh = manifold.getMesh(normalIdx);
    // Log this conversion
    const name = nodeDef.name ? `"${nodeDef.name}"` : 'object';
    log(`Exporting Manifold ${name} as mesh:`);
    log(`  Triangles: ${manifold.numTri().toLocaleString()}`);
    const box = manifold.boundingBox();
    const size = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
        size[i] = box.max[i] - box.min[i];
    }
    log(`  Bounding Box: X = ${formatLength(size[0])}, Y = ${formatLength(size[1])}, Z = ${formatLength(size[2])}`);
    log(`  Genus: ${manifold.genus().toLocaleString()}`);
    log(`  Volume: ${formatVolume(manifold.volume())}`);
    // Material
    const id2properties = new Map();
    for (const id of manifoldMesh.runOriginalID) {
        // This manifold object was not imported.
        const material = getMaterialByID(id) || backupMaterial;
        id2properties.set(id, {
            material: getCachedMaterial(doc, material),
            attributes: ['POSITION', ...material.attributes ?? []]
        });
    }
    // Animation Morph
    const morph = getMorph(manifold);
    const inputPositions = morphStart(manifoldMesh, morph);
    // Core
    const mesh = writeMesh(doc, manifoldMesh, id2properties);
    node.setMesh(mesh);
    // Animation Morph
    morphEnd(doc, manifoldMesh, mesh, inputPositions, morph);
    // If we're using a debug mode (`show` or `only`), check
    // to see if this mesh requires special handling.
    const debugNodes = getDebugGLTFMesh(doc, manifoldMesh, id2properties, backupMaterial);
    for (const debugNode of debugNodes) {
        node.addChild(debugNode);
    }
}
function writeCrossSection(doc, node, nodeDef) {
    node.setName(nodeDef.name || `CrossSection_${nodeDef.runID}`);
    const cs = nodeDef.crossSection;
    const { Mesh, triangulate } = getManifoldModuleSync(); // Lazy instantiation.
    const polygons = cs.toPolygons();
    const triangles = triangulate(polygons);
    // Log this conversion.
    log(`Exporting CrossSection ${nodeDef.name ? `"${nodeDef.name}"` : 'object'} as mesh:`);
    log(`  Triangles: ${triangles.length.toLocaleString()}`);
    const box = cs.bounds();
    const size = [0, 0];
    for (let i = 0; i < 2; i++) {
        size[i] = box.max[i] - box.min[i];
    }
    log(`  Bounding Box: X = ${formatLength(size[0])}, Y = ${formatLength(size[1])}`);
    log(`  Area: ${formatArea(cs.area())}`);
    // Material.
    const id2properties = new Map();
    id2properties.set(nodeDef.runID, {
        material: getCachedMaterial(doc, {
            baseColorFactor: [1, 0, 1],
            ...(nodeDef.material ?? {}),
            doubleSided: true
        }),
        // CrossSection does not have vertex attributes beyond position.
        attributes: ['POSITION']
    });
    // Convert geometry to a Mesh.
    const manifoldMesh = new Mesh({
        numProp: 3, // Position only.
        vertProperties: new Float32Array(polygons.flat().map((v) => ([...v, 0])).flat()),
        triVerts: new Uint32Array(triangles.flat()),
        runIndex: new Uint32Array([0, 3 * (triangles.length)]),
        runOriginalID: new Uint32Array(triangles.length).fill(nodeDef.runID)
    });
    // And finally export the mesh.
    const mesh = writeMesh(doc, manifoldMesh, id2properties, false);
    node.setMesh(mesh);
}
/**
 * Clone a given node in `doc`, retaining materials.
 */
function cloneNode(toNode, fromNode) {
    toNode.setMesh(fromNode.getMesh());
    fromNode.listChildren().forEach((child) => {
        const clone = child.clone();
        toNode.addChild(clone);
    });
}
/**
 * Clone a given node in `doc`, replacing materials.
 */
function cloneNodeNewMaterial(doc, toNode, fromNode, newMaterial, oldMaterial) {
    cloneNode(toNode, fromNode);
    const oldMesh = fromNode.getMesh();
    const newMesh = doc.createMesh();
    toNode.setMesh(newMesh);
    oldMesh.listPrimitives().forEach((primitive) => {
        const newPrimitive = primitive.clone();
        if (primitive.getMaterial() === oldMaterial) {
            newPrimitive.setMaterial(newMaterial);
        }
        newMesh.addPrimitive(newPrimitive);
    });
    // Track cloned meshes for easier export, later.
    newMesh.setExtras({ clonedFrom: oldMesh });
}
/**
 * Write a Manifold or CrossSection object, reusing previous conversions if
 * possible.
 */
function createNodeFromCache(doc, nodeDef, source2node) {
    const node = doc.createNode(nodeDef.name);
    applyTransformation(doc, nodeDef, node);
    if (nodeDef instanceof GLTFNode) {
        setMorph(doc, node, nodeDef.manifold);
    }
    const cacheKey = () => {
        if (nodeDef instanceof CrossSectionGLTFNode) {
            return nodeDef.crossSection;
        }
        return nodeDef.manifold;
    };
    const cachedNodes = source2node.get(cacheKey());
    const material = getBackupMaterial(nodeDef);
    if (cachedNodes == null) {
        // Cache miss.
        if (nodeDef instanceof CrossSectionGLTFNode) {
            writeCrossSection(doc, node, nodeDef);
        }
        else {
            writeManifold(doc, node, nodeDef, material);
        }
        const cachedNodes = new Map();
        cachedNodes.set(material, node);
        source2node.set(cacheKey(), cachedNodes);
    }
    else {
        // Cache hit...
        const cachedNode = cachedNodes.get(material);
        if (cachedNode == null) {
            // ...but not for this material.
            const [oldMaterial, oldNode] = cachedNodes.entries().next().value;
            cloneNodeNewMaterial(doc, node, oldNode, getCachedMaterial(doc, material), getCachedMaterial(doc, oldMaterial));
            cachedNodes.set(material, node);
        }
        else {
            // ...for this exact material.
            cloneNode(node, cachedNode);
        }
    }
    return node;
}
/**
 * Copy part of a glTF document (on nodeDef) into doc.
 *
 * At the time of writing, `copyToDocument()` is flagged as experimental in
 * glTF-Transform. It has a few limitations.   These are not show-stoppers, but
 * do require some cleanup.
 *
 *    * It creates multiple buffers.  Under the hood, it just copies the
 *      original buffer into the new document.  It is unclear whether it copies
 *      the entire buffer, or only the sections of the buffer that are relevant.
 *      ManifoldCAD users will likely import all geometry within a file anyhow,
 *      so buffer duplication is an issue for future investigation.
 *      This can be remediated through `unpartition()`.
 *    * It will try to use a PropertyResolver to deduplicate. However certain
 *      properties like textures) are not deduplicated yet.
 *      This can be fixed with `dedup()`.
 */
function copyNodeToDocument(doc, nodeDef) {
    const sourceDoc = nodeDef.document;
    let targetNode = null;
    // Get a property resolver, to deduplicate what we can.
    const resolve = getPropertyResolver(doc, sourceDoc);
    // Ensure that any extensions applied to the
    // source document are carried through.
    for (const sourceExtension of sourceDoc.getRoot().listExtensionsUsed()) {
        const ctor = sourceExtension.constructor;
        const targetExtension = doc.createExtension(ctor);
        if (sourceExtension.isRequired())
            targetExtension.setRequired(true);
    }
    if (nodeDef.node) {
        const sourceNode = nodeDef.node;
        copyToDocument(doc, sourceDoc, [sourceNode], resolve);
        targetNode = resolve(sourceNode);
    }
    else {
        targetNode = doc.createNode();
        for (const sourceNode of sourceDoc.getRoot().listNodes()) {
            copyToDocument(doc, sourceDoc, [sourceNode], resolve);
            if (sourceNode.getParentNode())
                continue;
            targetNode.addChild(resolve(sourceNode));
        }
    }
    if (nodeDef.name)
        targetNode.setName(nodeDef.name);
    applyTransformation(doc, nodeDef, targetNode);
    return targetNode;
}
/**
 * Scale and transform exported geometry, by wrapping it a top level node with a
 * transformation.
 *
 * glTF has a defined scale of 1:1 metre.
 * ManifoldCAD has a defined scale of 1:1 mm.
 *
 * glTF defines up as '+Y'.
 * ManifoldCAD defines up as '+Z'.
 *
 * See also `importTransform()` in `import-model.ts`.
 */
function exportTransform(doc) {
    // GLTF has a defined scale of 1:1 metre.
    const mm2m = 1 / 1000;
    const wrapper = doc.createNode('wrapper');
    wrapper.setRotation(euler2quat([-90, 0, 0]));
    wrapper.setScale([mm2m, mm2m, mm2m]);
    doc.createScene().addChild(wrapper);
    return wrapper;
}
/**
 * Convert a Manifold object into a GLTF-Transform Document.
 *
 * @group Management Functions
 * @param manifold The Manifold object
 * @returns An in-memory GLTF-Transform Document
 */
export async function manifoldToGLTFDoc(manifold) {
    const node = new GLTFNode();
    node.manifold = manifold;
    return await GLTFNodesToGLTFDoc([node]);
}
/**
 * Convert a list of GLTF Nodes into a GLTF-Transform Document.
 *
 * @group Management Functions
 * @param nodes A list of GLTF Nodes
 * @returns An in-memory GLTF-Transform Document
 */
export async function GLTFNodesToGLTFDoc(nodes) {
    const doc = new Document();
    doc.createBuffer();
    addAnimationToDoc(doc);
    const node2gltf = new Map();
    const source2node = new Map();
    let manifoldNodes = 0;
    let visualizationNodes = 0;
    let crossSectionNodes = 0;
    let noGeometryNodes = 0;
    // First, create a node in the GLTF document for each ManifoldCAD node.
    for (const nodeDef of nodes) {
        let node = null;
        if (nodeDef.isEmpty()) {
            // No geometry here.  Create the node anyhow as it may contain
            // transformations.
            node = doc.createNode(nodeDef.name);
            applyTransformation(doc, nodeDef, node);
            ++noGeometryNodes;
        }
        else if (nodeDef instanceof VisualizationGLTFNode) {
            // Copy from another glTF document in memory.
            node = copyNodeToDocument(doc, nodeDef);
            ++visualizationNodes;
        }
        else {
            // Manifold or CrossSection Object.
            // Previous meshes and materials are cached in `source2node`.
            node = createNodeFromCache(doc, nodeDef, source2node);
            if (nodeDef instanceof GLTFNode)
                ++manifoldNodes;
            if (nodeDef instanceof CrossSectionGLTFNode)
                ++crossSectionNodes;
        }
        node2gltf.set(nodeDef, node);
    }
    // Step through each node and set its parent.
    // Nodes without parents are added directly to the root.
    const root = exportTransform(doc);
    for (const nodeDef of nodes) {
        const gltfNode = node2gltf.get(nodeDef);
        const { parent } = nodeDef;
        if (parent) {
            node2gltf.get(parent).addChild(gltfNode);
        }
        else {
            root.addChild(gltfNode);
        }
    }
    log(`Total glTF nodes: ${nodes.length}`);
    if (manifoldNodes) {
        log(`  Manifold meshes: ${manifoldNodes}`);
    }
    if (crossSectionNodes) {
        log(`  CrossSection meshes: ${crossSectionNodes}`);
    }
    if (visualizationNodes) {
        log(`  Visualization-only (imported) nodes: ${visualizationNodes}`);
    }
    if (noGeometryNodes) {
        log(`  Nodes without geometry: ${noGeometryNodes}`);
    }
    cleanupAnimationInDoc();
    // `copyToDocument()` creates multiple buffers.  Under the hood, it just
    // copies the original buffer into the new document.
    // `unpartition()` merges those buffers together.
    await doc.transform(unpartition());
    // `copyToDocument()` will try to use a PropertyResolver to deduplicate.
    // However, it's an experimental feature in general, and certain properties
    // (like textures) are not deduplicated yet.
    await doc.transform(dedup({
        keepUniqueNames: true,
        propertyTypes: [PropertyType.TEXTURE, PropertyType.MATERIAL, PropertyType.MESH]
    }));
    return doc;
}
//# sourceMappingURL=scene-builder.js.map