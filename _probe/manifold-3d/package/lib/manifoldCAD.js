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
import * as debug from "./debug.js";
import { garbageCollectFunction, garbageCollectManifold } from "./garbage-collector.js";
import * as material from "./material.js";
import { getManifoldModule } from "./wasm.js";
export { getAnimationDuration, getAnimationFPS, getAnimationMode, setMorphEnd, setMorphStart } from "./animation.js";
export { CrossSectionGLTFNode, GLTFNode, VisualizationGLTFNode } from "./gltf-node.js";
export { importManifold, importModel } from "./import-model.js";
export { getCircularSegments, getMinCircularAngle, getMinCircularEdgeLength } from "./level-of-detail.js";
const manifoldWasm = garbageCollectManifold(await getManifoldModule());
const { Mesh, Manifold, CrossSection, triangulate } = manifoldWasm;
// These methods are not intrinsic to manifold itself, but provided by the scene
// builder.
const show = garbageCollectFunction(debug.show);
const only = garbageCollectFunction(debug.only);
const setMaterial = garbageCollectFunction(material.setMaterial);
const getGLTFNodes = () => [];
const resetGLTFNodes = () => { };
// False whenever this module is imported directly.  The bundler will replace
// this with a function that returns true.
const isManifoldCAD = () => false;
export { Mesh, Manifold, CrossSection, triangulate, show, only, setMaterial, getGLTFNodes, resetGLTFNodes, isManifoldCAD };
//# sourceMappingURL=manifoldCAD.js.map