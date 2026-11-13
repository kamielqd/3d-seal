/**
 * This module implements the
 * [EXT_mesh_manifold](https://github.com/KhronosGroup/glTF/tree/main/extensions/2.0/Vendor/EXT_mesh_manifold)
 * GLTF extension for [glTF Transform](https://gltf-transform.dev/).  It does
 * not depend on manifold.  Use it where topological correctness is
 * required.
 *
 * A mesh is typically considered manifold when it topologically represents a
 * solid object with well-defined volume, sometimes known as watertight. For the
 * purpose of this extension, a mesh is considered manifold when it is an
 * oriented 2-manifold triangle mesh, meaning for each halfedge (each of the
 * three ordered vertex index pairs around a triangle) there is exactly one
 * other halfedge with swapped vertices, and no other halfedge with the same
 * vertices.
 *
 * > NOTE: This is the same definition as used in the 3D Manufacturing Format
 * (3MF) for maximum interoperability.
 *
 * Manifoldness is critical for reliability of geometric algorithms that operate
 * on solid objects, and so is important in CAD, FEA (Finite Element Analysis),
 * CFD (Computational Fluid Dynamics), and more. However, GPU-friendly formats
 * like glTF with indexed triangles lose manifoldness data because anywhere
 * vertex properties change at an edge (e.g. change of materials, UV swatch, or
 * normals at a crease) the entire vertex must be duplicated and referenced
 * separately. This means the only way to determine linked edges is by merging
 * vertices with identical positions, but this geometric check cannot losslessly
 * recreate the topology, as some separate vertices may happen to coincide in
 * position.
 *
 * This extension allows authors to denote that the contained mesh data is in
 * fact manifold, and adds a small amount of extra data to losslessly recover
 * this manifold mesh by leveraging sparse accessors.
 *
 * It can be imported as `manifold-3d/manifold-gltf`.
 *
 * @packageDocumentation
 * @group glTF Extension
 * @module manifold-gltf
 */
import type { IProperty } from '@gltf-transform/core';
import { Accessor, Extension, ExtensionProperty, PropertyType, ReaderContext, WriterContext } from '@gltf-transform/core';
declare const NAME = "EXT_mesh_manifold";
export interface IManifoldPrimitive extends IProperty {
    mergeIndices: Accessor;
    mergeValues: Accessor;
    indices: Accessor;
    runIndex: number[] | Uint32Array;
}
export declare class ManifoldPrimitive extends ExtensionProperty<IManifoldPrimitive> {
    static EXTENSION_NAME: string;
    extensionName: typeof NAME;
    propertyType: 'ManifoldPrimitive';
    parentTypes: [PropertyType.MESH];
    init(): void;
    getDefaults(): import("@gltf-transform/core").Nullable<IManifoldPrimitive> & {
        manifoldPrimitive: null;
        mergeIndices: null;
        mergeValues: null;
    };
    getMergeIndices(): (import("property-graph").GraphNode<object> & Accessor) | null;
    getMergeValues(): (import("property-graph").GraphNode<object> & Accessor) | null;
    setMerge(indicesAccessor: Accessor, valuesAccessor: Accessor): this;
    getRunIndex(): number[] | Uint32Array<ArrayBufferLike>;
    setRunIndex(runIndex: number[] | Uint32Array): this;
    setIndices(indices: Accessor): this;
    getIndices(): import("property-graph").GraphNode<object> & Accessor;
}
export declare class EXTManifold extends Extension {
    extensionName: string;
    prewriteTypes: PropertyType[];
    static EXTENSION_NAME: string;
    createManifoldPrimitive(): ManifoldPrimitive;
    read(context: ReaderContext): this;
    prewrite(context: WriterContext): this;
    write(context: WriterContext): this;
}
export {};
//# sourceMappingURL=manifold-gltf.d.ts.map