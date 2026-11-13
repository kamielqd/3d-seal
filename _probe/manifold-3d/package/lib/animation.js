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
 * Allow manifoldCAD models to specify glTF animations and morphs.
 * @packageDocumentation
 * @group ManifoldCAD
 * @category Modelling
 */
import { Accessor, Animation, AnimationSampler, Document, Mesh as GLTFMesh, Node } from '@gltf-transform/core';
import { BaseGLTFNode } from "./gltf-node.js";
import { euler2quat } from "./math.js";
let animationMode = 'loop';
let animationDuration = 1;
let animationFPS = 30;
/**
 * Set the animation repeat mode.
 *
 * @param mode 'loop' or 'ping-pong'
 */
export function setAnimationMode(mode) {
    animationMode = mode;
}
/**
 * Get the current animation repeat mode.
 */
export function getAnimationMode() {
    return animationMode;
}
/**
 * Set the duration of the animation, in seconds.
 *
 * @param duration in seconds.
 */
export function setAnimationDuration(duration) {
    animationDuration = duration;
}
;
/**
 * Get the current duruation of the animation, in seconds.
 */
export function getAnimationDuration() {
    return animationDuration;
}
/**
 * Set the animation frame rate.
 *
 * @param fps in frames per second.
 */
export function setAnimationFPS(fps) {
    animationFPS = fps;
}
;
/**
 * Get the current animation frame rate.
 */
export function getAnimationFPS() {
    return animationFPS;
}
const manifold2morph = new Map();
let animation;
let timesAccessor;
let weightsAccessor;
let weightsSampler;
let hasAnimation;
export function cleanup() {
    manifold2morph.clear();
    animationMode = 'loop';
    animationDuration = 1;
    animationFPS = 30;
}
/**
 *
 * @internal
 */
export function addMotion(doc, type, node, out) {
    const motion = node[type];
    if (motion == null) {
        return null;
    }
    if (typeof motion !== 'function') {
        return motion;
    }
    const nFrames = timesAccessor.getCount();
    const nEl = type == 'rotation' ? 4 : 3;
    const frames = new Float32Array(nEl * nFrames);
    for (let i = 0; i < nFrames; ++i) {
        const x = i / (nFrames - 1);
        const m = motion(animationMode !== 'ping-pong' ? x :
            (1 - Math.cos(x * 2 * Math.PI)) / 2);
        frames.set(nEl === 4 ? euler2quat(m) : m, nEl * i);
    }
    const framesAccessor = doc.createAccessor(node.name + ' ' + type + ' frames')
        .setBuffer(doc.getRoot().listBuffers()[0])
        .setArray(frames)
        .setType(nEl === 4 ? Accessor.Type.VEC4 : Accessor.Type.VEC3);
    const sampler = doc.createAnimationSampler()
        .setInput(timesAccessor)
        .setOutput(framesAccessor)
        .setInterpolation('LINEAR');
    const channel = doc.createAnimationChannel()
        .setTargetPath(type)
        .setTargetNode(out)
        .setSampler(sampler);
    animation.addSampler(sampler);
    animation.addChannel(channel);
    hasAnimation = true;
    return motion(0);
}
/**
 *
 * @internal
 */
export function setMorph(doc, node, manifold) {
    if (manifold2morph.has(manifold)) {
        const channel = doc.createAnimationChannel()
            .setTargetPath('weights')
            .setTargetNode(node)
            .setSampler(weightsSampler);
        animation.addChannel(channel);
        hasAnimation = true;
    }
}
/**
 *
 * @internal
 */
export const getMorph = (manifold) => manifold2morph.get(manifold);
/**
 *
 * @internal
 */
export function morphStart(manifoldMesh, morph) {
    const inputPositions = [];
    if (morph == null) {
        return inputPositions;
    }
    for (let i = 0; i < manifoldMesh.numVert; ++i) {
        for (let j = 0; j < 3; ++j)
            inputPositions[i * 3 + j] =
                manifoldMesh.vertProperties[i * manifoldMesh.numProp + j];
    }
    if (morph.start) {
        for (let i = 0; i < manifoldMesh.numVert; ++i) {
            const vertProp = manifoldMesh.vertProperties;
            const offset = i * manifoldMesh.numProp;
            const pos = inputPositions.slice(offset, offset + 3);
            morph.start(pos);
            for (let j = 0; j < 3; ++j)
                vertProp[offset + j] = pos[j];
        }
    }
    return inputPositions;
}
/**
 *
 * @internal
 */
export function morphEnd(doc, manifoldMesh, mesh, inputPositions, morph) {
    if (morph == null) {
        return;
    }
    mesh.setWeights([0]);
    mesh.listPrimitives().forEach((primitive, i) => {
        if (morph.end) {
            for (let i = 0; i < manifoldMesh.numVert; ++i) {
                const pos = inputPositions.slice(3 * i, 3 * (i + 1));
                morph.end(pos);
                inputPositions.splice(3 * i, 3, ...pos);
            }
        }
        const startPosition = primitive.getAttribute('POSITION').getArray();
        const array = new Float32Array(startPosition.length);
        const offset = manifoldMesh.runIndex[i];
        for (let j = 0; j < array.length; ++j) {
            array[j] = inputPositions[offset + j] - startPosition[j];
        }
        const morphAccessor = doc.createAccessor(mesh.getName() + ' morph target')
            .setBuffer(doc.getRoot().listBuffers()[0])
            .setArray(array)
            .setType(Accessor.Type.VEC3);
        const morphTarget = doc.createPrimitiveTarget().setAttribute('POSITION', morphAccessor);
        primitive.addTarget(morphTarget);
    });
}
/**
 * Apply a morphing animation to the input manifold. Specify the start
 * function which will be applied to the vertex positions of the first frame and
 * linearly interpolated across the length of the overall animation. This
 * animation will only be shown if this manifold is used directly on a GLTFNode.
 *
 * @param manifold The object to add morphing animation to.
 * @param func A warping function to apply to the first animation frame.
 */
export function setMorphStart(manifold, func) {
    const morph = manifold2morph.get(manifold);
    if (morph != null) {
        morph.start = func;
    }
    else {
        manifold2morph.set(manifold, { start: func });
    }
}
/**
 * Apply a morphing animation to the input manifold. Specify the end
 * function which will be applied to the vertex positions of the last frame and
 * linearly interpolated across the length of the overall animation. This
 * animation will only be shown if this manifold is used directly on a GLTFNode.
 *
 * @param manifold The object to add morphing animation to.
 * @param func A warping function to apply to the last animation frame.
 */
export function setMorphEnd(manifold, func) {
    const morph = manifold2morph.get(manifold);
    if (morph != null) {
        morph.end = func;
    }
    else {
        manifold2morph.set(manifold, { end: func });
    }
}
/**
 *
 * @internal
 */
export function addAnimationToDoc(doc) {
    const buffer = doc.getRoot().listBuffers()[0];
    animation = doc.createAnimation('');
    hasAnimation = false;
    const nFrames = Math.round(animationDuration * animationFPS) + 1;
    const times = new Float32Array(nFrames);
    const weights = new Float32Array(nFrames);
    for (let i = 0; i < nFrames; ++i) {
        const x = i / (nFrames - 1);
        times[i] = x * animationDuration;
        weights[i] =
            animationMode !== 'ping-pong' ? x : (1 - Math.cos(x * 2 * Math.PI)) / 2;
    }
    timesAccessor = doc.createAccessor('animation times')
        .setBuffer(buffer)
        .setArray(times)
        .setType(Accessor.Type.SCALAR);
    weightsAccessor = doc.createAccessor('animation weights')
        .setBuffer(buffer)
        .setArray(weights)
        .setType(Accessor.Type.SCALAR);
    weightsSampler = doc.createAnimationSampler()
        .setInput(timesAccessor)
        .setOutput(weightsAccessor)
        .setInterpolation('LINEAR');
    animation.addSampler(weightsSampler);
}
/**
 *
 * @internal
 */
export function cleanupAnimationInDoc() {
    if (!hasAnimation) {
        timesAccessor.dispose();
        weightsAccessor.dispose();
        weightsSampler.dispose();
        animation.dispose();
    }
}
//# sourceMappingURL=animation.js.map