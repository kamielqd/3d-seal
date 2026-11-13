/**
 * 版式层 ↔ 几何层的多边形桥。
 *
 * 问题：两个模块各有一个 `Polygon2D`，名字一样、结构不同——
 *   - `src/layout/text.ts`  → `{ points: {x,y}[] }`，**平铺**环，孔也是独立一环，靠有向面积区分；
 *   - `src/geometry/types.ts` → `{ outer: [x,y][], holes: [x,y][][] }`，**嵌套**结构。
 *
 * 约定：**版式层输出的平铺环是唯一契约**（DESIGN §13 契约 1），
 * 几何层保持自己的嵌套结构不变，转换只在这一个文件里做。
 * 这样不会出现「两个 Polygon2D 各自演化」的坑，也不会为了统一类型去改 geometry 整个模块。
 *
 * 单次 build 只调一次，成本是 O(环数²) 的包含判定，实测可忽略。
 */

import { groupContours } from '../geometry/polygon.ts';
import type { Contour, Polygon2D as GeometryPolygon } from '../geometry/types.ts';
import type { Polygon2D as LayoutPolygon } from '../layout/text.ts';

/** 版式层平铺环 → 几何层「外环+内孔」多边形。 */
export function fromLayoutPolygons(polygons: readonly LayoutPolygon[]): GeometryPolygon[] {
  const contours: Contour[] = [];
  for (const polygon of polygons) {
    const pts = polygon?.points;
    if (!pts || pts.length < 3) continue;
    contours.push(pts.map((p) => [p.x, p.y] as const));
  }
  return groupContours(contours);
}

/** 版式层平铺环 → 几何层的扁平轮廓列表（不需要分组时用，例如只做统计）。 */
export function toContours(polygons: readonly LayoutPolygon[]): Contour[] {
  const out: Contour[] = [];
  for (const polygon of polygons) {
    const pts = polygon?.points;
    if (!pts || pts.length < 3) continue;
    out.push(pts.map((p) => [p.x, p.y] as const));
  }
  return out;
}
