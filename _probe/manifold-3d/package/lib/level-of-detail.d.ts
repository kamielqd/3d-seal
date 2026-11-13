/**
 * Set an angle constraint when calculating the number of segments in a circle.
 * The number of segments will be rounded
 * up to the nearest factor of four.
 *
 * @param angle The minimum angle in degrees between consecutive segments. The
 * angle will increase if the the segments hit the minimum edge length.
 * Default is 10 degrees.
 */
export declare function setMinCircularAngle(angle: number): void;
/**
 * Set a length constraint when calculating the number segments in a circle.
 * The number of segments will be rounded
 * up to the nearest factor of four.
 *
 * @param length The minimum length of segments. The length will
 * increase if the the segments hit the minimum angle. Default is 1.0.
 */
export declare function setMinCircularEdgeLength(length: number): void;
/**
 * Set the default number of segments in a circle.
 * Overrides the edge length and angle
 * constraints and sets the number of segments to exactly this value.
 *
 * @param segments Number of circular segments. Default is 0, meaning no
 * constraint is applied.
 */
export declare function setCircularSegments(segments: number): void | undefined;
/**
 * Reset the circular construction parameters to their defaults if
 * `setMinCircularAngle()`, `setMinCircularEdgeLength()`, or
 * `setCircularSegments()` have been called.
 */
export declare function resetToCircularDefaults(): void;
/**
 * Get the current angle constraint.
 *
 * @returns The minimum angle in degrees between consecutive segments. The
 * angle will increase if the the segments hit the minimum edge length.
 * Default is 10 degrees.
 */
export declare function getMinCircularAngle(): number;
/**
 * Get the current edge length constraint.
 *
 * @returns The minimum length of segments. The length will
 * increase if the the segments hit the minimum angle. Default is 1.0.
 */
export declare function getMinCircularEdgeLength(): number;
/**
 * Determine the appropriate number of segments for a given radius.
 *
 * @param radius For a given radius of circle, determine how many default
 * segments there will be.
 */
export declare function getCircularSegments(radius: number): number;
/**
 * @internal
 */
export declare const cleanup: () => void;
//# sourceMappingURL=level-of-detail.d.ts.map