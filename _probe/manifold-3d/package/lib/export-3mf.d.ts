/**
 * Serialize in memory glTF-transform documents to 3MF.
 * @packageDocumentation
 * @group ManifoldCAD
 * @category Input/Output
 * @groupDescription Export
 * These properties implement the {@link lib/export-model!Exporter | Exporter}
 * interface. Through this interface, manifoldCAD can determine when to use this
 * module to export a model.
 */
import * as GLTFTransform from '@gltf-transform/core';
import type { Mat4 } from '../manifold-global-types.d.ts';
import type { ExportOptions } from './export-model.ts';
/**
 * @group Export
 */
export declare const exportFormats: {
    extension: string;
    mimetype: string;
}[];
/**
 * @hidden
 * Exported for unit tests.
 */
export interface Child3MF {
    objectID: string;
    transform?: Mat4 | Array<string>;
}
/**
 * @hidden
 * Exported for unit tests.
 */
export interface Component3MF {
    id: string;
    children: Array<Child3MF>;
    name?: string;
    transform?: Mat4 | Array<string>;
}
export interface Header {
    unit?: 'micron' | 'millimeter' | 'centimeter' | 'inch' | 'foot' | 'meter';
    title?: string;
    author?: string;
    description?: string;
    application?: string;
    creationDate?: string;
    license?: string;
    modificationDate?: string;
}
export interface Export3MFOptions extends ExportOptions {
    mimetype?: string;
    header?: Header;
}
/**
 * Sort 3MF components topologically.
 *
 * Some 3MF parsers (like PrusaSlicer and descendants) expect child nodes to be
 * defined before their parents.  This function sorts the component list
 * accordingly.
 *
 * This is a version of Kahn's algorithm -- a stripped down breadth first
 * search.  It finds root nodes, adds them to the result, then removes them from
 * the graph.  It moves on to their children, which are now root nodes
 * themselves.
 *
 * Rinse, lather, repeat, and the final result is a list of nodes ordered by
 * generation.  Order within a generation is not guaranteed, and is not required
 * in this particular case.
 *
 * @hidden
 * Exported for unit tests.
 */
export declare const toposort: (unsorted: Component3MF[]) => Component3MF[];
/**
 * Convert a GLTF-Transform document to a 3MF model.
 *
 * 3MF files are more sophisticated than STL files; they can encode meshes,
 * components and build items.
 *
 * 3MF components are like a scene graph.  Each component can have multiple
 * children, and does have its own transformation matrix.
 * This is flexible enough to allow putting several parts in the same file
 * (multiple components, each with a mesh) as well as multi-material files (a
 * tree containing multiple meshes, each for a particular material).
 *
 * Finally, build items define what the slicer software actually sees.
 * ManifoldCAD doesn't have an equivalent comprehension.  We assume that top
 * level objects -- nodes with no parents -- are build objects.
 *
 * @param doc The GLTF document to convert.
 * @returns A blob containing the converted model.
 * @group Export
 */
export declare function toArrayBuffer(doc: GLTFTransform.Document, options?: Export3MFOptions): Promise<ArrayBuffer>;
//# sourceMappingURL=export-3mf.d.ts.map