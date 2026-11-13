/**
 * Import 3MF models into manifoldCAD.
 *
 * @packageDocumentation
 * @group ManifoldCAD
 * @category Input/Output
 */
import * as GLTFTransform from '@gltf-transform/core';
export declare const importFormats: {
    extension: string;
    mimetype: string;
}[];
/**
 * Parse a 3MF ArrayBuffer into a gltf-transform Document.
 *
 * Note: 3MF files store geometry in millimetres with +Z up, while glTF uses
 * metres with +Y up. This importer normalizes geometry to glTF conventions so
 * the shared import pipeline can apply `importTransform()` consistently across
 * all formats.
 */
export declare function fromArrayBuffer(buffer: ArrayBuffer): Promise<GLTFTransform.Document>;
//# sourceMappingURL=import-3mf.d.ts.map