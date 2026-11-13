/**
 * 几何引擎的公共类型。
 *
 * 单位一律 mm；二维坐标系原点在章面中心，+X 向右、+Y 向上；
 * 三维坐标系 z 轴朝上，z=0 为印章底面（贴打印床的那一面）。
 *
 * 环方向约定（与 src/layout 的契约一致）：
 *   - 外环逆时针（CCW，有向面积为正）
 *   - 内孔顺时针（CW，有向面积为负）
 */

import type { Violation } from './printability.ts';

/** 二维点，[x, y]，单位 mm。 */
export type Vec2 = readonly [number, number];

/** 一条闭合轮廓。首尾点不重复（末点不回到首点）。 */
export type Contour = Vec2[];

/** 一个带孔的多边形：一条外环 + 若干内孔。 */
export interface Polygon2D {
  outer: Contour;
  holes: Contour[];
}

/** 一个图层（文字/图像）的多边形：用于跨图层重叠检测。 */
export interface LayerPolygons {
  id: string;
  kind: 'text' | 'image';
  polygons: Polygon2D[];
}

/** 二维包围盒。 */
export interface Bounds2 {
  min: Vec2;
  max: Vec2;
}

/**
 * 三角网格。
 *
 * `vertProperties` 是交错存储的顶点属性，每点 `numProp` 个 float，
 * 前三个固定为 x/y/z。`triVerts` 是三角形索引，每个三角形三个下标，
 * 按逆时针（从外部看）排列。
 */
export interface SolidMesh {
  vertProperties: Float32Array;
  triVerts: Uint32Array;
  /** 每顶点属性个数，至少 3（x/y/z）。 */
  numProp: number;
  /** 三角形数量。 */
  triangleCount: number;
  /** manifold 的封闭性状态，正常为 'NoError'。 */
  status: string;
  /** 打印校验结果（docs/printability.md），UI 据此高亮。 */
  violations?: Violation[];
  /** 生成过程中的可选诊断信息。 */
  notes?: string[];
}

/** 几何异常：带上 manifold 的 status 与出错阶段，便于 UI 给出可读提示。 */
export class SealGeometryError extends Error {
  readonly status: string;
  readonly stage: string;

  constructor(stage: string, status: string, detail?: string) {
    super(
      detail ??
        `几何生成失败（${stage}）：manifold 报告 ${status}。请检查文字轮廓是否有自相交或极细笔画。`,
    );
    this.name = 'SealGeometryError';
    this.stage = stage;
    this.status = status;
  }
}

/** 便捷构造：点。 */
export const v2 = (x: number, y: number): Vec2 => [x, y];
