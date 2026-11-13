/**
 * 二维多边形的纯几何工具：面积、环方向、简化、退化段清理、自交检测与修复。
 *
 * 这里不依赖 manifold —— 全部是可单测的纯函数，
 * 只有"修复自交"需要真正的布尔运算，通过注入 `SelfUnion` 回调交给上层
 * （实际由 crosssection.ts 用 CrossSection 实现），避免循环依赖。
 */

import type { Bounds2, Contour, Polygon2D, Vec2 } from './types.ts';

/* ------------------------------------------------------------------ */
/* 基础量                                                              */
/* ------------------------------------------------------------------ */

/** 有向面积（鞋带公式）。CCW 为正，CW 为负。 */
export function signedArea(contour: Contour): number {
  const n = contour.length;
  if (n < 3) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = contour[i]!;
    const [x2, y2] = contour[(i + 1) % n]!;
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

/** 面积（绝对值）。 */
export function contourArea(contour: Contour): number {
  return Math.abs(signedArea(contour));
}

/** 多边形净面积：外环面积减去所有内孔面积。 */
export function polygonArea(polygon: Polygon2D): number {
  let area = contourArea(polygon.outer);
  for (const hole of polygon.holes) area -= contourArea(hole);
  return area;
}

/** 是否逆时针。 */
export function isCCW(contour: Contour): boolean {
  return signedArea(contour) > 0;
}

/** 保证环方向：ccw=true 逆时针，false 顺时针。返回新数组，不改输入。 */
export function orientContour(contour: Contour, ccw: boolean): Contour {
  const already = isCCW(contour);
  return already === ccw ? contour.slice() : contour.slice().reverse();
}

/** 归一化多边形：外环 CCW、内孔 CW。 */
export function normalizePolygon(polygon: Polygon2D): Polygon2D {
  return {
    outer: orientContour(polygon.outer, true),
    holes: polygon.holes.map((hole) => orientContour(hole, false)),
  };
}

/** 批量归一化，并顺手丢掉不成形的环。 */
export function normalizePolygons(polygons: readonly Polygon2D[]): Polygon2D[] {
  const out: Polygon2D[] = [];
  for (const polygon of polygons) {
    const outer = dropDegenerate(polygon.outer);
    if (outer === null) continue;
    const holes: Contour[] = [];
    for (const hole of polygon.holes) {
      const cleaned = dropDegenerate(hole);
      if (cleaned !== null) holes.push(cleaned);
    }
    out.push(normalizePolygon({ outer, holes }));
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 清理                                                                */
/* ------------------------------------------------------------------ */

const EPS = 1e-9;

/**
 * 去掉退化段：重合点、超短边、三点共线的多余点。
 * 退化到不足 3 个点或面积近零时返回 null。
 */
export function dropDegenerate(contour: Contour, minEdgeMm = 1e-4, minAreaMm2 = 1e-6): Contour | null {
  const dedup = dedupePoints(contour, minEdgeMm);
  if (dedup.length < 3) return null;
  const cleaned = dedupePoints(dropCollinear(dedup, minEdgeMm), minEdgeMm);
  if (cleaned.length < 3) return null;
  if (contourArea(cleaned) < minAreaMm2) return null;
  return cleaned;
}

/** 合并相邻重合点（含首尾）。 */
export function dedupePoints(contour: Contour, minEdgeMm = 1e-4): Contour {
  if (contour.length === 0) return [];
  const out: Contour = [];
  const minSq = minEdgeMm * minEdgeMm;
  for (const point of contour) {
    const last = out[out.length - 1];
    if (last !== undefined && distSq(last, point) <= minSq) continue;
    out.push(point);
  }
  while (out.length > 1 && distSq(out[0]!, out[out.length - 1]!) <= minSq) out.pop();
  return out;
}

/** 去掉"几乎共线"的中间点（保留转角）。 */
export function dropCollinear(contour: Contour, toleranceMm = 1e-4): Contour {
  const n = contour.length;
  if (n < 3) return contour.slice();
  const out: Contour = [];
  for (let i = 0; i < n; i++) {
    const prev = contour[(i - 1 + n) % n]!;
    const cur = contour[i]!;
    const next = contour[(i + 1) % n]!;
    if (pointLineDistance(cur, prev, next) > toleranceMm) out.push(cur);
  }
  return out.length >= 3 ? out : contour.slice();
}

function pointLineDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const len = Math.hypot(abx, aby);
  if (len < EPS) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  return Math.abs((p[0] - a[0]) * aby - (p[1] - a[1]) * abx) / len;
}

function distSq(a: Vec2, b: Vec2): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return dx * dx + dy * dy;
}

/* ------------------------------------------------------------------ */
/* 简化（Douglas–Peucker，闭合环）                                      */
/* ------------------------------------------------------------------ */

/**
 * 闭合环的 Ramer–Douglas–Peucker 简化。
 * 距离容差单位 mm；FDM 下 0.02~0.05 足够。
 */
export function simplifyContour(contour: Contour, toleranceMm: number): Contour {
  const n = contour.length;
  if (n <= 3 || toleranceMm <= 0) return contour.slice();

  // 闭合环：先从"最远点对"切成两段，避免起点退化
  let farIndex = 0;
  let farDist = -1;
  for (let i = 1; i < n; i++) {
    const d = distSq(contour[0]!, contour[i]!);
    if (d > farDist) {
      farDist = d;
      farIndex = i;
    }
  }
  const first = rdp(contour.slice(0, farIndex + 1), toleranceMm);
  const second = rdp([...contour.slice(farIndex), contour[0]!], toleranceMm);
  const merged = [...first.slice(0, -1), ...second.slice(0, -1)];
  return merged.length >= 3 ? merged : contour.slice();
}

function rdp(points: Contour, tolerance: number): Contour {
  if (points.length <= 2) return points.slice();
  const first = points[0]!;
  const last = points[points.length - 1]!;
  let index = -1;
  let maxDist = -1;
  for (let i = 1; i < points.length - 1; i++) {
    const d = pointLineDistance(points[i]!, first, last);
    if (d > maxDist) {
      maxDist = d;
      index = i;
    }
  }
  if (index <= 0 || maxDist <= tolerance) return [first, last];
  const left = rdp(points.slice(0, index + 1), tolerance);
  const right = rdp(points.slice(index), tolerance);
  return [...left.slice(0, -1), ...right];
}

/** 简化多边形（外环与内孔同容差）。 */
export function simplifyPolygon(polygon: Polygon2D, toleranceMm: number): Polygon2D {
  return {
    outer: simplifyContour(polygon.outer, toleranceMm),
    holes: polygon.holes.map((hole) => simplifyContour(hole, toleranceMm)),
  };
}

/* ------------------------------------------------------------------ */
/* 自交检测与修复                                                       */
/* ------------------------------------------------------------------ */

export interface Intersection {
  /** 第一条边的起点下标。 */
  edgeA: number;
  /** 第二条边的起点下标。 */
  edgeB: number;
  point: Vec2;
}

/**
 * 找出轮廓的自身相交点（O(n²)，只对小环用；环点数是几百级）。
 */
export function findSelfIntersections(contour: Contour): Intersection[] {
  const n = contour.length;
  const out: Intersection[] = [];
  if (n < 4) return out;
  for (let i = 0; i < n; i++) {
    const a1 = contour[i]!;
    const a2 = contour[(i + 1) % n]!;
    for (let j = i + 1; j < n; j++) {
      // 相邻边共享端点，跳过
      if (j === i || (j + 1) % n === i || j === (i + 1) % n) continue;
      const b1 = contour[j]!;
      const b2 = contour[(j + 1) % n]!;
      const hit = segmentIntersection(a1, a2, b1, b2);
      if (hit !== null) out.push({ edgeA: i, edgeB: j, point: hit });
    }
  }
  return out;
}

export function hasSelfIntersection(contour: Contour): boolean {
  return findSelfIntersections(contour).length > 0;
}

/** 修复自交所需的二维布尔并集：给定轮廓集合，返回互不重叠的多边形。 */
export type SelfUnion = (contours: Contour[]) => Contour[];

/**
 * 修复多边形自交/重叠。
 *
 * 自交无法用纯几何的"就地修补"稳定解决 —— 正确做法是用二维布尔并集
 * 把重叠区域按非零规则重新解算一遍。这里接收注入的 `union` 实现
 * （crosssection.ts 用 manifold 的 CrossSection 提供），无自交时原样返回，
 * 保证纯函数路径也能用。
 */
export function repairSelfIntersections(polygon: Polygon2D, union: SelfUnion): Polygon2D[] {
  const contours = [polygon.outer, ...polygon.holes];
  const dirty = polygon.holes.length === 0 && !hasSelfIntersection(polygon.outer)
    ? false
    : contours.some((c) => hasSelfIntersection(c)) || polygon.holes.length > 0;
  if (!dirty) return [normalizePolygon(polygon)];

  // 注意：这里**不能**把所有环翻成同一方向。孔必须保持 CW，并集用 NonZero 才能算成抵消；
  // 之前统一 orientContour(c, true) 会把孔填实（篆书「回」变实心块的来源之一）。
  const normalized = normalizePolygon(polygon);
  const merged = union([normalized.outer, ...normalized.holes]);
  return groupContours(merged);
}

/**
 * 把一堆互不重叠的轮廓按"谁在谁里面"分组成 外环+内孔 的多边形。
 * 依赖环方向：CCW 认为是外环，CW 认为是孔。
 */
/**
 * 把一堆互不重叠的轮廓按"谁在谁里面"分组成 外环+内孔 的多边形。
 *
 * 外环/内孔**不靠环方向判断**，而是数嵌套深度（偶数层外环、奇数层内孔），
 * 最后再按约定写成外环 CCW / 内孔 CW。这样 manifold 的布尔输出、描摹得到的
 * 像素环、以及被 y 轴翻转过的数据都能正确分组。
 */
export function groupContours(contours: Contour[]): Polygon2D[] {
  const rings = contours.filter((contour) => contour.length >= 3);
  if (rings.length === 0) return [];

  const depths = rings.map((ring, index) => {
    const probe = representativePoint(ring);
    let depth = 0;
    for (let j = 0; j < rings.length; j++) {
      if (j === index) continue;
      if (pointInPolygon(probe, rings[j]!)) depth++;
    }
    return depth;
  });

  const outerEntries = rings
    .map((ring, index) => ({ ring, index, depth: depths[index]!, area: contourArea(ring) }))
    .filter((entry) => entry.depth % 2 === 0);

  // 孔归属：取包含它的面积最小的外环
  const holesByOuter = new Map<number, Contour[]>();
  for (let index = 0; index < rings.length; index++) {
    if (depths[index]! % 2 === 0) continue;
    const hole = rings[index]!;
    const probe = representativePoint(hole);
    let bestIndex = -1;
    let bestArea = Infinity;
    for (const entry of outerEntries) {
      if (entry.depth > depths[index]!) continue;
      if (!pointInPolygon(probe, entry.ring)) continue;
      if (entry.area < bestArea) {
        bestArea = entry.area;
        bestIndex = entry.index;
      }
    }
    if (bestIndex >= 0) {
      const list = holesByOuter.get(bestIndex) ?? [];
      list.push(orientContour(hole, false));
      holesByOuter.set(bestIndex, list);
    }
  }

  const out: Polygon2D[] = [];
  for (const entry of outerEntries) {
    out.push(normalizePolygon({ outer: orientContour(entry.ring, true), holes: holesByOuter.get(entry.index) ?? [] }));
  }
  return out;
}

/**
 * 环内部的一点：首点朝质心方向挪一点点。
 * 直接拿首点判断"是否被别的环包含"在贴边时容易误判，挪过之后稳一些。
 */
export function representativePoint(contour: Contour): Vec2 {
  let cx = 0;
  let cy = 0;
  for (const [x, y] of contour) {
    cx += x;
    cy += y;
  }
  const n = contour.length || 1;
  cx /= n;
  cy /= n;
  const [vx, vy] = contour[0]!;
  return [vx + (cx - vx) * 1e-3, vy + (cy - vy) * 1e-3];
}

export function boundsOf(contour: Contour): Bounds2 {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of contour) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { min: [minX, minY], max: [maxX, maxY] };
}

export function pointInBounds(p: Vec2, b: Bounds2): boolean {
  return p[0] >= b.min[0] && p[0] <= b.max[0] && p[1] >= b.min[1] && p[1] <= b.max[1];
}

/** 射线法判断点是否在多边形内（边界点行为不保证，用于孔归属足够）。 */
export function pointInPolygon(p: Vec2, contour: Contour): boolean {
  let inside = false;
  const n = contour.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [xi, yi] = contour[i]!;
    const [xj, yj] = contour[j]!;
    const intersect = yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function segmentIntersection(a1: Vec2, a2: Vec2, b1: Vec2, b2: Vec2): Vec2 | null {
  const rx = a2[0] - a1[0];
  const ry = a2[1] - a1[1];
  const sx = b2[0] - b1[0];
  const sy = b2[1] - b1[1];
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-12) return null;
  const t = ((b1[0] - a1[0]) * sy - (b1[1] - a1[1]) * sx) / denom;
  const u = ((b1[0] - a1[0]) * ry - (b1[1] - a1[1]) * rx) / denom;
  const eps = 1e-9;
  if (t <= eps || t >= 1 - eps || u <= eps || u >= 1 - eps) return null;
  return [a1[0] + t * rx, a1[1] + t * ry];
}

/* ------------------------------------------------------------------ */
/* 边界适配：接住 src/layout 的环表示                                    */
/* ------------------------------------------------------------------ */

/**
 * 点可以是元组 [x, y]，也可以是 {x, y} 对象。
 *
 * 版式引擎（src/layout）用的是 core/spec 的 `Vec2 = {x, y}`，几何引擎内部用
 * 元组（做面积/相交计算更省内存）。两边在边界上通过 `toVec2` 统一，
 * 谁都不用改自己的内部表示。
 */
export type PointLike = Vec2 | { x: number; y: number };

export function toVec2(point: PointLike): Vec2 {
  const maybe = point as { x?: number; y?: number };
  if (typeof maybe.x === 'number' && typeof maybe.y === 'number') return [maybe.x, maybe.y];
  const tuple = point as readonly [number, number];
  return [tuple[0], tuple[1]];
}

/**
 * 版式输出（`{ points: Vec2[] }[]`，一条环一个元素，靠方向区分外环/内孔）
 * → 几何输入（外环 + 内孔分组）。
 */
export function fromRings(rings: readonly { points: readonly PointLike[] }[]): Polygon2D[] {
  const contours = rings
    .map((ring) => ring.points.map(toVec2))
    .filter((contour) => contour.length >= 3);
  return groupContours(contours);
}

/** 几何多边形 → 版式环列表（给预览/回填用）。 */
export function toRings(polygons: readonly Polygon2D[]): Contour[] {
  const out: Contour[] = [];
  for (const polygon of polygons) {
    out.push(orientContour(polygon.outer, true));
    for (const hole of polygon.holes) out.push(orientContour(hole, false));
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 变换                                                                */
/* ------------------------------------------------------------------ */

export function transformContour(contour: Contour, scale: number, rotateDeg: number, tx = 0, ty = 0): Contour {
  const rad = (rotateDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return contour.map(([x, y]) => {
    const sx = x * scale;
    const sy = y * scale;
    return [sx * cos - sy * sin + tx, sx * sin + sy * cos + ty] as Vec2;
  });
}

