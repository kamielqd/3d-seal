/**
 * Import models into manifoldCAD.
 *
 * ManifoldCAD uses [gltf-transform](https://gltf-transform.dev/) internally to
 * represent scenes. Importers must convert their models to in-memory
 * gltf-transform Documents.
 *
 * The high level functions `importModel()` and `importManifold()` will import
 * models as display-only and full manifold objects respectively.  These
 * functions are available in manifoldCAD.
 *
 * @packageDocumentation
 * @group ManifoldCAD
 * @category Input/Output
 * @groupDescription Low Level Functions
 * These functions are not available within manifoldCAD, but can be used when
 * including manifold in another project.
 */
import * as GLTFTransform from '@gltf-transform/core';
import type { Manifold } from '../manifold.d.ts';
import { VisualizationGLTFNode } from './gltf-node.ts';
/**
 * @group Management
 * @inline
 * @hidden
 */
export interface ImportFormat {
    extension: string;
    mimetype: string;
}
/**
 * Through this interface, manifoldCAD can infer what formats each importer may
 * support.
 * @group Management
 */
export interface Importer {
    /**
     * Some importers may support multiple variations of a format.  List each of
     * them by extension and MIME type.
     * @readonly
     */
    importFormats: Array<ImportFormat>;
    /**
     * Given a buffer, return a glTF-transform document.
     * @function
     */
    fromArrayBuffer: (buffer: ArrayBuffer, options?: ImportOptions) => Promise<GLTFTransform.Document>;
}
/**
 * @group Management
 * @inline
 * @internal
 */
export interface ImportOptions {
    /**
     * Use `mimetype` to determine the format of the imported model, rather than
     * inferring it.
     */
    mimetype?: string;
    /**
     * When an imported model is not manifold, try closing gaps smaller than
     * tolerance in an effort to make it manifold.
     */
    tolerance?: number;
}
export declare const cleanup: () => void;
/**
 * @internal
 */
export declare const getDocumentByID: (runID: number) => GLTFTransform.Document | null;
/**
 * Returns true if a given extension or mimetype can be imported.
 *
 * @param filetype
 * @param throwOnFailure If true, throw an `UnsupportedFormatException` rather
 *     than return false.
 * @group Management
 */
export declare function supports(filetype: string, throwOnFailure?: boolean): boolean;
/**
 * Register an importer.
 *
 * Supported formats will be inferred.
 * @group Management
 */
export declare function register(importer: Importer): void;
/**
 * Import a model, for display only.
 */
export declare function importModel(source: string | Blob | URL | ArrayBuffer, options?: ImportOptions): Promise<VisualizationGLTFNode>;
/**
 * Import a model, and convert it to a Manifold object for manipulation.
 *
 * The original imported model may consist of an entire tree of nodes, each of
 * which may or may not be manifold.  This method will convert each child node,
 * and then union the results together.  If a child node has no mesh, the mesh
 * has no geometry, or the mesh is not manifold, that child node will be
 * silently excluded.
 */
export declare function importManifold(source: string | Blob | URL | ArrayBuffer, options?: ImportOptions): Promise<Manifold>;
/**
 * Resolve and read a model, be it a file, a URL or a Blob.
 *
 * @group Low Level Functions
 */
export declare function readModel(source: string | Blob | URL | ArrayBuffer, options?: ImportOptions): Promise<GLTFTransform.Document>;
/**
 * Fetch a model over HTTP/HTTPS.
 *
 * @group Low Level Functions
 */
export declare function fetchModel(uri: string, options?: ImportOptions): Promise<GLTFTransform.Document>;
/**
 * Read a model from a Blob.
 *
 * @group Low Level Functions
 */
export declare function fromBlob(blob: Blob, options?: ImportOptions): Promise<GLTFTransform.Document>;
/**
 * Read a model from an ArrayBuffer.
 *
 * @group Low Level Functions
 */
export declare function fromArrayBuffer(buffer: ArrayBuffer, identifier: string): Promise<GLTFTransform.Document>;
/**
 * Read a model from disk.
 * @group Low Level Functions
 */
export declare function readFile(filename: string, options?: ImportOptions): Promise<GLTFTransform.Document>;
/**
 * Convert a gltf-transform Node and its descendants into a Manifold object.
 *
 * The original imported model may consist of an entire tree of nodes, each of
 * which may or may not be manifold.  This method will convert each child node,
 * and then union the results together.  If a child node has no mesh, the mesh
 * has no geometry, or the mesh is not manifold, that child node will be
 * silently excluded.
 *
 * Other errors will be re-thrown for the caller to handle.
 *
 * @group Low Level Functions
 */
export declare function gltfDocToManifold(document: GLTFTransform.Document, node?: GLTFTransform.Node, tolerance?: number): Manifold;
//# sourceMappingURL=import-model.d.ts.map