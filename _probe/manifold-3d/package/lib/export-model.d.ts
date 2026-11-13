/**
 * Export models out of manifoldCAD.
 *
 * ManifoldCAD uses [gltf-transform](https://gltf-transform.dev/) internally to
 * represent scenes. Exporters must accept in-memory gltf-transform Documents.
 *
 * Exporters and importers can each accept one or more type of file.
 * Each format must have a defined extension and mime type.  In the case of
 * duplicates, order is not guaranteed. While an implementation may support both
 * import and export of a format, this is not required.  At the time of writing,
 * manifoldCAD supports both import and export of glTF, but only exports 3mf.
 *
 * @packageDocumentation
 * @group ManifoldCAD
 * @category Input/Output
 */
import * as GLTFTransform from '@gltf-transform/core';
/**
 * @group Management
 * @inline
 * @hidden
 */
export interface ExportFormat {
    extension: string;
    mimetype: string;
}
/**
 * Through this interface, manifoldCAD can infer what formats each exporter may
 * support.
 * @group Management
 */
export interface Exporter {
    exportFormats: Array<ExportFormat>;
    toArrayBuffer: (doc: GLTFTransform.Document, options?: ExportOptions) => Promise<ArrayBuffer>;
}
/**
 * @group Management
 * @inline
 * @hidden
 */
export interface ExportOptions {
    /**
     * Use `mimetype` to determine the format of the imported model, rather than
     * inferring it.  If both `extension` and `mimetype` are specified, `mimetype`
     * will be used.
     */
    mimetype?: string;
    /**
     * Use `extension` to determine the format of the imported model, rather than
     * inferring it.  If both `extension` and `mimetype` are specified, `mimetype`
     * will be used.
     */
    extension?: string;
}
export declare const cleanup: () => void;
/**
 * Returns true if a given extension or mimetype can be exported.
 *
 * @param filetype
 * @param throwOnFailure If true, throw an `UnsupportedFormatException` rather
 *     than return false.
 * @group Management
 */
export declare function supports(filetype: string, throwOnFailure: false): boolean;
/**
 * Register an exporter.
 *
 * Supported formats will be inferred.
 * @group Management
 * @param exporter
 */
export declare function register(exporter: Exporter): void;
/**
 * Convert an in-memory GLTF document to a binary Blob.
 *
 * @param doc The GLTF document.
 * @returns A URL encoded blob.
 * @group Low Level Functions
 */
export declare function toBlob(doc: GLTFTransform.Document, options?: ExportOptions): Promise<Blob>;
/**
 * Convert an in-memory GLTF document to an ArrayBuffer.
 *
 * @param doc The GLTF document.
 * @returns A URL encoded blob.
 * @group Low Level Functions
 */
export declare function toArrayBuffer(doc: GLTFTransform.Document, options?: ExportOptions): Promise<ArrayBuffer>;
/**
 * Write a model to disk.
 * @group Low Level Functions
 */
export declare function writeFile(filename: string, doc: GLTFTransform.Document, options?: ExportOptions): Promise<void>;
/**
 * Get or create a PropertyResolver.
 *
 * These are used to proactively de-duplicate when copying properties into a
 * glTF-Transform document.
 *
 * @hidden
 */
export declare function getPropertyResolver(dst: GLTFTransform.Document, src: GLTFTransform.Document): GLTFTransform.PropertyResolver<any>;
//# sourceMappingURL=export-model.d.ts.map