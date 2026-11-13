/**
 * Allow manifoldCAD models to specify glTF animations and morphs.
 * @packageDocumentation
 * @group ManifoldCAD
 * @category Modelling
 */
import { Document, Mesh as GLTFMesh, Node } from '@gltf-transform/core';
import type { Manifold, Mesh, Vec3 } from '../manifold.d.ts';
import { BaseGLTFNode } from './gltf-node.ts';
/**
 * @hidden
 * @inline
 */
export type AnimationMode = 'loop' | 'ping-pong';
/**
 * Set the animation repeat mode.
 *
 * @param mode 'loop' or 'ping-pong'
 */
export declare function setAnimationMode(mode: AnimationMode): void;
/**
 * Get the current animation repeat mode.
 */
export declare function getAnimationMode(): AnimationMode;
/**
 * Set the duration of the animation, in seconds.
 *
 * @param duration in seconds.
 */
export declare function setAnimationDuration(duration: number): void;
/**
 * Get the current duruation of the animation, in seconds.
 */
export declare function getAnimationDuration(): number;
/**
 * Set the animation frame rate.
 *
 * @param fps in frames per second.
 */
export declare function setAnimationFPS(fps: number): void;
/**
 * Get the current animation frame rate.
 */
export declare function getAnimationFPS(): number;
/**
 *
 * @internal
 */
export interface Morph {
    start?: (v: Vec3) => void;
    end?: (v: Vec3) => void;
}
export declare function cleanup(): void;
/**
 *
 * @internal
 */
export declare function addMotion(doc: Document, type: 'translation' | 'rotation' | 'scale', node: BaseGLTFNode, out: Node): Vec3 | null;
/**
 *
 * @internal
 */
export declare function setMorph(doc: Document, node: Node, manifold: Manifold): void;
/**
 *
 * @internal
 */
export declare const getMorph: (manifold: Manifold) => Morph | undefined;
/**
 *
 * @internal
 */
export declare function morphStart(manifoldMesh: Mesh, morph?: Morph): number[];
/**
 *
 * @internal
 */
export declare function morphEnd(doc: Document, manifoldMesh: Mesh, mesh: GLTFMesh, inputPositions: number[], morph?: Morph): void;
/**
 * Apply a morphing animation to the input manifold. Specify the start
 * function which will be applied to the vertex positions of the first frame and
 * linearly interpolated across the length of the overall animation. This
 * animation will only be shown if this manifold is used directly on a GLTFNode.
 *
 * @param manifold The object to add morphing animation to.
 * @param func A warping function to apply to the first animation frame.
 */
export declare function setMorphStart(manifold: Manifold, func: (v: Vec3) => void): void;
/**
 * Apply a morphing animation to the input manifold. Specify the end
 * function which will be applied to the vertex positions of the last frame and
 * linearly interpolated across the length of the overall animation. This
 * animation will only be shown if this manifold is used directly on a GLTFNode.
 *
 * @param manifold The object to add morphing animation to.
 * @param func A warping function to apply to the last animation frame.
 */
export declare function setMorphEnd(manifold: Manifold, func: (v: Vec3) => void): void;
/**
 *
 * @internal
 */
export declare function addAnimationToDoc(doc: Document): void;
/**
 *
 * @internal
 */
export declare function cleanupAnimationInDoc(): void;
//# sourceMappingURL=animation.d.ts.map