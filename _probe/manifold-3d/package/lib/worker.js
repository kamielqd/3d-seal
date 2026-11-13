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
 * The worker is where everything comes together.
 * It handles worker communication, execution of a model and
 * exporting the final scene as a GLTF-Transform Document or URL encoded
 * Blob.
 *
 * This is an isomorphic module that can be used directly as a JavaScript or
 * TypeScript module.  It can be imported as a web worker, and defines
 * a set of interfaces for communication in that case.
 *
 * @packageDocumentation
 * @group ManifoldCAD
 * @category Core
 */
import { Document } from '@gltf-transform/core';
import * as animation from "./animation.js";
import { bundleCode, setHasOwnWorker, setWasmUrl as setEsbuildWasmUrl } from "./bundler.js";
import { RuntimeError } from "./error.js";
import * as exportModel from "./export-model.js";
import * as garbageCollector from "./garbage-collector.js";
import * as gltfNode from "./gltf-node.js";
import * as levelOfDetail from "./level-of-detail.js";
import * as scenebuilder from "./scene-builder.js";
import { getSourceMappedStackTrace, isWebWorker } from "./util.js";
import { getManifoldModule, setWasmUrl as setManifoldWasmUrl } from "./wasm.js";
const AsyncFunction = Object.getPrototypeOf(async function () { }).constructor;
// Swallow informational logs in testing framework
function log(...args) {
    if (typeof self !== 'undefined' && self.console) {
        self.console.log(...args);
    }
}
/**
 * Clean up any state from the last run.
 *
 * This includes any outstanding Manifold, Mesh or CrossSection objects,
 * even if referenced elsewhere.
 */
export function cleanup() {
    garbageCollector.cleanup();
    scenebuilder.cleanup();
    levelOfDetail.cleanup();
    gltfNode.cleanup();
}
/**
 * Transform a model from code to a GLTF document.
 *
 * @param code A string containing the code to evaluate.
 * @returns A gltf-transform Document.
 */
export async function evaluate(code, options = {}) {
    cleanup();
    const t0 = performance.now();
    const { doNotBundle, ...bundleOpt } = options;
    const bundled = doNotBundle === true ? code : await bundleCode(code, bundleOpt);
    const t1 = performance.now();
    if (doNotBundle !== true) {
        log(`Bundling code took ${((t1 - t0) / 1000).toFixed(2)} seconds`);
    }
    // Customize `manifold-3d/manifoldCAD`.
    // Let models know that they are running inside this worker.
    const manifoldCAD = await import("./manifoldCAD.js");
    const manifoldImport = {
        ...manifoldCAD,
        isManifoldCAD: () => true,
    };
    // If a top level script imports manifoldCAD, track GLTF nodes.
    // Libraries are expected to manage this on their own; if a
    // library somehow doesn't export a GLTF node, it must not
    // show up here.
    const toplevelImport = {
        ...manifoldImport,
        GLTFNode: gltfNode.GLTFNodeTracked,
        getGLTFNodes: gltfNode.getGLTFNodes,
        resetGLTFNodes: gltfNode.resetGLTFNodes,
    };
    // Set up global variables exposed to the model without an import.
    const globals = {
        // These accessors are only available to top level scripts.
        // See ../lib/manifoldCADGlobals.d.ts
        setCircularSegments: levelOfDetail.setCircularSegments,
        setMinCircularAngle: levelOfDetail.setMinCircularAngle,
        setMinCircularEdgeLength: levelOfDetail.setMinCircularEdgeLength,
        resetToCircularDefaults: levelOfDetail.resetToCircularDefaults,
        setAnimationDuration: animation.setAnimationDuration,
        setAnimationFPS: animation.setAnimationFPS,
        setAnimationMode: animation.setAnimationMode,
        // The bundler will swap these objects in when needed.
        _manifold_cad_top_level: toplevelImport,
        _manifold_cad_library: manifoldImport,
        // Bundled code may be referencing files by relative paths.
        // Set runtime value of import.meta.url
        _manifold_runtime_url: options.baseUrl ?? null,
        // While this project is built using ES modules, and we assume models and
        // libraries are ES modules, code executed via `new Function()` or `eval` is
        // treated as commonJS.
        // CommonJS expects 'exports' to exist:
        exports: {},
        // This is where we expect results after running the script.
        module: { exports: { default: null } },
    };
    let result = null;
    try {
        const evalFn = new AsyncFunction(...Object.keys(globals), bundled);
        await evalFn(...Object.values(globals));
        result = globals.module?.exports?.default;
        // If the default export is a function, execute it.  This way libraries can
        // preview their results when run as a top level script, without incurring
        // that overhead when imported into another model.
        if (typeof result === 'function') {
            result = await result();
        }
    }
    catch (error) {
        // "According to step 12 of
        // https://tc39.es/ecma262/#sec-createdynamicfunction, the Function
        // constructor always prefixes the source with additional 2 lines."
        // https://github.com/nodejs/node/issues/43047#issuecomment-1564068099
        const stacktrace = getSourceMappedStackTrace(bundled, error, -2);
        let newError = null;
        const missing = Object.keys(toplevelImport).find((x) => error.message.match(x));
        if (error.name === 'ReferenceError' && missing) {
            newError = new RuntimeError(error, error.message + '.  Import it by adding \`' +
                `import {${missing}} from 'manifold-3d/manifoldCAD';` +
                '\` to the top of your model.');
        }
        else if (error.name === 'ReferenceError' && error.message.match(/glMatrix/)) {
            newError = new RuntimeError(error, 'ManifoldCAD no longer includes gl-matrix directly.  ' +
                'Import it by adding `import * as glMatrix from \'gl-matrix\';` ' +
                'to the top of your model.');
        }
        else {
            newError = new RuntimeError(error);
        }
        newError.manifoldStack = stacktrace;
        throw newError;
    }
    // If we don't actually have a model, complain.
    if (!result || (Array.isArray(result) && !result.length)) {
        if (gltfNode.getGLTFNodes().length) {
            throw new Error('GLTF Nodes were created, but not exported.  ' +
                'Add `const nodes = getGLTFNodes();` and `export default nodes;` ' +
                'to the end of your model.');
        }
        throw new Error('No output as no model was exported.  Add a default export ' +
            '(e.g.: `export default result;`) to the bottom of your model.  ' +
            'The default export must be a `Manifold` or `GLTFNode` object, ' +
            'an array of `Manifold` or `GLTFNode` objects, ' +
            'or a function that returns any of the above.');
    }
    // Create a gltf-transform document.
    const nodes = await gltfNode.anyToGLTFNodeList(result);
    const doc = await scenebuilder.GLTFNodesToGLTFDoc(nodes);
    const t2 = performance.now();
    log(`Manifold took ${((t2 - t1) / 1000).toFixed(2)} seconds`);
    return doc;
}
/**
 * Convert an in-memory GLTF document to a URL encoded blob.
 *
 * @param doc The GLTF document.
 * @param extension The target file extension.
 * @returns A URL encoded blob.
 */
export const exportBlobURL = async (doc, extension) => {
    const t0 = performance.now();
    const blob = await exportModel.toBlob(doc, { extension });
    const blobURL = URL.createObjectURL(blob);
    const t1 = performance.now();
    log(`Exporting ${extension.toUpperCase()} took ${(Math.round((t1 - t0) / 10) / 100).toLocaleString()} seconds`);
    return blobURL;
};
/**
 * Set up message handlers and logging when run as a web worker.
 */
const initializeWebWorker = () => {
    const interceptConsole = () => {
        console.debug('Intercepting console.log() in manifoldCAD worker.');
        if (self.console) {
            self.console.log = function (...args) {
                let message = '';
                for (const arg of args) {
                    if (arg == null) {
                        message += 'undefined';
                    }
                    else if (typeof arg == 'object') {
                        message += JSON.stringify(arg, null, 4);
                    }
                    else {
                        message += arg.toString();
                    }
                }
                self.postMessage({ type: 'log', message });
            };
        }
        ;
    };
    const sendError = (error) => {
        // Log the error / stack trace to the console.
        console.error(error);
        if (error.cause)
            console.error('Caused by:', error.cause);
        if (error.manifoldStack)
            console.error('manifoldStack:', error.manifoldStack);
        self.postMessage({
            type: 'error',
            name: error.name,
            message: error.message,
            stack: error.manifoldStack ?? error.stack
        });
    };
    const handleInitialize = async (message) => {
        try {
            console.debug('Initializing ManifoldCAD worker.');
            if (message.manifoldWasmUrl)
                setManifoldWasmUrl(message.manifoldWasmUrl);
            if (message.esbuildWasmUrl)
                setEsbuildWasmUrl(message.esbuildWasmUrl);
            setHasOwnWorker(message.esbuildHasOwnWorker === true);
            await getManifoldModule();
            interceptConsole();
            self.postMessage({ type: 'ready' });
            console.debug('Successfully initialized ManifoldCAD worker!');
        }
        catch (error) {
            sendError(error);
        }
    };
    let gltfdoc = null;
    const handleEvaluate = async (message) => {
        try {
            const { code, ...options } = message;
            gltfdoc = await evaluate(message.code, options);
            self.postMessage({ type: 'done' });
        }
        catch (error) {
            sendError(error);
        }
    };
    const handleExport = async (message) => {
        try {
            self.postMessage({
                type: 'blob',
                extension: message.extension,
                blobURL: await exportBlobURL(gltfdoc, message.extension)
            });
        }
        catch (error) {
            sendError(error);
        }
    };
    self.onmessage = async (e) => {
        const message = e.data;
        if (message.type === 'initialize') {
            handleInitialize(message);
        }
        else if (message.type === 'evaluate') {
            handleEvaluate(message);
        }
        else if (message.type === 'export') {
            handleExport(message);
        }
    };
};
if (isWebWorker())
    initializeWebWorker();
//# sourceMappingURL=worker.js.map