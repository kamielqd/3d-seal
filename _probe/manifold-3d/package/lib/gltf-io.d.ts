/**
 * Convert between in-memory glTF-transform documents and their serialized
 * formats. This module also includes some utilities for conversion between glTF
 * meshes and manifold meshes.
 *
 * @packageDocumentation
 * @group ManifoldCAD
 * @category Input/Output
 * @groupDescription Import
 * These properties implement the {@link lib/import-model!Importer | Importer}
 * interface. Through this interface, manifoldCAD can determine when to use this
 * module to import a model.
 * @groupDescription Export
 * These properties implement the {@link lib/export-model!Exporter | Exporter}
 * interface. Through this interface, manifoldCAD can determine when to use this
 * module to export a model.
 */
import * as GLTFTransform from '@gltf-transform/core';
import type { Mesh as ManifoldMesh, MeshOptions } from '../manifold.d.ts';
/**
 * @group Import
 * @readonly
 */
export declare const importFormats: {
    extension: string;
    mimetype: string;
}[];
/**
 * @group Export
 * @readonly
 */
export declare const exportFormats: {
    extension: string;
    mimetype: string;
}[];
export declare const attributeDefs: {
    POSITION: {
        type: GLTFTransform.GLTF.AccessorType;
        components: number;
    };
    NORMAL: {
        type: GLTFTransform.GLTF.AccessorType;
        components: number;
    };
    TANGENT: {
        type: GLTFTransform.GLTF.AccessorType;
        components: number;
    };
    TEXCOORD_0: {
        type: GLTFTransform.GLTF.AccessorType;
        components: number;
    };
    TEXCOORD_1: {
        type: GLTFTransform.GLTF.AccessorType;
        components: number;
    };
    COLOR_0: {
        type: GLTFTransform.GLTF.AccessorType;
        components: number;
    };
    JOINTS_0: {
        type: GLTFTransform.GLTF.AccessorType;
        components: number;
    };
    WEIGHTS_0: {
        type: GLTFTransform.GLTF.AccessorType;
        components: number;
    };
    SKIP_1: {
        type: null;
        components: number;
    };
    SKIP_2: {
        type: null;
        components: number;
    };
    SKIP_3: {
        type: null;
        components: number;
    };
    SKIP_4: {
        type: null;
        components: number;
    };
};
export type Attribute = keyof (typeof attributeDefs);
export interface Properties {
    material: GLTFTransform.Material;
    attributes: Attribute[];
}
/**
 * Call this first to register the manifold extension so that readMesh and
 * writeMesh will work.
 */
export declare function setupIO(io: GLTFTransform.WebIO): GLTFTransform.WebIO;
/**
 * Read an input mesh into Manifold-compatible data structures, whether it
 * contains the EXT_mesh_manifold extension or not.
 *
 * @param mesh The Mesh to read.
 * @param attributes An array of attributes representing the order of desired
 *     properties returned in the vertProperties array of the output mesh. If
 *     omitted, this will be populated with the union of all attributes defined
 *     in the primitives of the input mesh. If present, the first entry must be
 *     'POSITION', and any attributes in the primitives that are not included in
 *     this list will be ignored, while those in the list but not defined in a
 *     primitive will be populated with zeros.
 * @returns The returned mesh is suitable for initializing a Manifold or Mesh of
 *     the Manifold library if desired. See Manifold documentation if you prefer
 *     to use these GL arrays in a different library. The runProperties array
 *     gives the Material and attributes list associated with each triangle run,
 *     which in turn corresponds to a primitive of the input mesh. These
 *     attributes are the intersection of the attributes present on the
 *     primitive and those requested in the attributes input.
 */
export declare function readMesh(mesh: GLTFTransform.Mesh, attributes?: Attribute[]): {
    mesh: MeshOptions;
    runProperties: Properties[];
} | null;
/**
 * Write a Manifold Mesh into a glTF Mesh object, using the EXT_mesh_manifold
 * extension to allow for lossless roundtrip of the manifold mesh through the
 * glTF file.
 *
 * @param doc The glTF Document to which this Mesh will be added.
 * @param manifoldMesh The Manifold Mesh to convert to glTF.
 * @param id2properties A map from originalID to Properties that include the
 *     glTF Material and the set of attributes to output. All triangle runs with
 *     the same originalID will be combined into a single output primitive. Any
 *     originalIDs not found in the map will have the glTF default material and
 *     no attributes beyond 'POSITION'. Each attributes array must correspond to
 *     the manifoldMesh vertProperties, thus the first attribute must always be
 *     'POSITION'. Any properties that should not be output for a given
 *     primitive must use the 'SKIP_*' attributes.
 * @param EXT_mesh_manifold If false, emit a plain glTF mesh.  In this case,
 *     the mesh is not required to be fully manifold when written.  Use this
 *     to write explicitly non-manifold meshes, e.g.: CrossSections.
 * @returns The glTF Mesh to add to the Document.
 */
export declare function writeMesh(doc: GLTFTransform.Document, manifoldMesh: ManifoldMesh, id2properties: Map<number, Properties>, EXT_mesh_manifold?: boolean): GLTFTransform.Mesh;
/**
 * Helper function to dispose of a Mesh, useful when replacing an existing Mesh
 * with one from writeMesh.
 */
export declare function disposeMesh(mesh: GLTFTransform.Mesh): void;
/**
 * Helper function to download an image and apply it to the given texture.
 *
 * @param texture The texture to update
 * @param uri The location of the image to download
 */
export declare function loadTexture(texture: GLTFTransform.Texture, uri: string): Promise<void>;
/**
 * @group Export
 */
export declare function toArrayBuffer(doc: GLTFTransform.Document): Promise<ArrayBuffer>;
/**
 * @group Import
 */
export declare function fromArrayBuffer(buffer: ArrayBuffer): Promise<GLTFTransform.Document>;
//# sourceMappingURL=gltf-io.d.ts.map