/**
 * @group ManifoldCAD
 * @packageDocumentation
 */
import type { Vec3 } from '../manifold.d.ts';
/**
 * A quaternion in `XYZW` order.
 *
 * ManifoldCAD, like OpenGL and many other libraries represent quaternions in
 * `XYZW` order, with the scalar last. This differs from most math textbooks
 * (and just as many other libraries) that use `WXYZ` order.
 */
export type Quat = [number, number, number, number];
export type Vec4 = Quat;
/**
 * Convert Euler (Tait-Bryan) angles to a quaternion.
 *
 * From the reference frame of the model being rotated, rotations are applied in
 * *z-y'-x"* order. That is yaw first, then pitch and finally roll.
 *
 * From the global reference frame, a model will be rotated in *x-y-z* order.
 * That is about the global X axis, then global Y axis, and finally global Z.
 *
 * This matches the behaviour of `Manifold.rotate()`.
 *
 * @param rotation [X, Y, Z] rotation in degrees.
 */
export declare function euler2quat(rotation: Vec3): Quat;
/**
 * Multiply two quaternions together.  This is useful for stacking rotations.
 */
export declare function multiplyQuat(a: Quat, b: Quat): Quat;
/**
 * Calculate the distance between two vectors.
 */
export declare function distanceVec3(a: Vec3, b: Vec3): number;
//# sourceMappingURL=math.d.ts.map