// Copyright 2024-25 The Manifold Authors.
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
import { createDefaultPropertyResolver } from '@gltf-transform/functions';
import { UnsupportedFormatError } from "./error.js";
import * as export3MF from "./export-3mf.js";
import * as gltfIO from "./gltf-io.js";
import { findExtension, findMimeType, isNode } from "./util.js";
const exporters = [];
register(gltfIO);
register(export3MF);
const documentToPropertyResolver = new Map();
export const cleanup = () => {
    documentToPropertyResolver.clear();
};
function getFormat(identifier) {
    const formats = exporters.flatMap(ex => ex.exportFormats);
    const format = (findMimeType(identifier, formats) ??
        findExtension(identifier, formats));
    if (!format)
        throw new UnsupportedFormatError(identifier, formats);
    return format;
}
function getExporter(identifier) {
    const format = typeof identifier === 'string' ? getFormat(identifier) : identifier;
    return exporters.find(ex => ex.exportFormats.includes(format));
}
/**
 * Returns true if a given extension or mimetype can be exported.
 *
 * @param filetype
 * @param throwOnFailure If true, throw an `UnsupportedFormatException` rather
 *     than return false.
 * @group Management
 */
export function supports(filetype, throwOnFailure) {
    if (throwOnFailure)
        return !!getFormat(filetype);
    try {
        return !!getFormat(filetype);
    }
    catch (e) {
        return false;
    }
}
/**
 * Register an exporter.
 *
 * Supported formats will be inferred.
 * @group Management
 * @param exporter
 */
export function register(exporter) {
    exporters.push(exporter);
}
/**
 * Convert an in-memory GLTF document to a binary Blob.
 *
 * @param doc The GLTF document.
 * @returns A URL encoded blob.
 * @group Low Level Functions
 */
export async function toBlob(doc, options = {}) {
    if (!(options.mimetype || options.extension)) {
        throw new Error('Must specify a mimetype or extension when exporting to a Blob.');
    }
    const format = getFormat((options.mimetype || options.extension));
    const buffer = await getExporter(format).toArrayBuffer(doc, options);
    return new Blob([buffer], { type: format.mimetype });
}
/**
 * Convert an in-memory GLTF document to an ArrayBuffer.
 *
 * @param doc The GLTF document.
 * @returns A URL encoded blob.
 * @group Low Level Functions
 */
export async function toArrayBuffer(doc, options = {}) {
    if (!(options.mimetype || options.extension)) {
        throw new Error('Must specify a mimetype or extension when exporting to a Buffer.');
    }
    const format = getFormat((options.mimetype || options.extension));
    return await getExporter(format).toArrayBuffer(doc, options);
}
/**
 * Write a model to disk.
 * @group Low Level Functions
 */
export async function writeFile(filename, doc, options = {}) {
    if (!isNode()) {
        throw new Error('Must have a filesystem to write files.');
    }
    const fs = await import('node:fs/promises');
    const exporter = getExporter(options.mimetype ?? options.extension ?? filename);
    const buffer = await exporter.toArrayBuffer(doc, options);
    return await fs.writeFile(filename, new Uint8Array(buffer));
}
/**
 * Get or create a PropertyResolver.
 *
 * These are used to proactively de-duplicate when copying properties into a
 * glTF-Transform document.
 *
 * @hidden
 */
export function getPropertyResolver(dst, src) {
    if (!documentToPropertyResolver.has(dst)) {
        documentToPropertyResolver.set(dst, new Map());
    }
    const srcMap = documentToPropertyResolver.get(dst);
    if (!srcMap.has(src)) {
        srcMap.set(src, createDefaultPropertyResolver(dst, src));
    }
    return srcMap.get(src);
}
//# sourceMappingURL=export-model.js.map