/**
 * 版式引擎 · 中心装饰图案（星形），纯几何求点，不经图像生成再矢量化。
 *
 * 输出 `Vec2[][]`：每个元素是一条闭合环（首尾不重复），单位 mm，原点在图案中心，
 * 外环按逆时针（CCW，signedArea > 0）给出，可直接交给几何层当实心外轮廓。
 *
 * 两种图案：
 *  - 五角星：外接圆半径 R，内圆半径 r = R × 0.382（标准五角星），10 个顶点交替；
 *            单个简单多边形环（星形，关于中心星形可见，角度排序即轮廓）。
 *  - 六芒星：两个等边三角形（一正一倒）外接圆半径 R 叠加；此处给出其**并集轮廓**——
 *            12 个顶点交替（外顶点半径 R、内顶点半径 R/√3），单环、可直接实心填充。
 *            （若需要两个独立三角形，用 `hexagramTriangles`，共 6 个顶点。）
 */

import type { Vec2 } from './text.ts';
import { signedArea } from './text.ts';

export interface OrnamentParams {
  /** 图案外接圆直径（mm）。优先使用；不传则用 faceDiameterMm × 0.28，再不然 8mm。 */
  sizeMm?: number;
  /** 章面外接尺寸（mm），用于推导默认 sizeMm = 0.28 × faceDiameterMm。 */
  faceDiameterMm?: number;
  /** 图案中心（章面坐标，mm），默认原点。 */
  centerMm?: Vec2;
}

/** 推荐的中心图案默认直径：章面直径的 0.28 倍。 */
export function defaultOrnamentSizeMm(faceDiameterMm: number): number {
  return faceDiameterMm * 0.28;
}

/** 解析出实际外接圆直径（mm）。 */
function resolveSizeMm(p: OrnamentParams): number {
  if (p.sizeMm != null && p.sizeMm > 0) return p.sizeMm;
  if (p.faceDiameterMm != null && p.faceDiameterMm > 0) return defaultOrnamentSizeMm(p.faceDiameterMm);
  return 8;
}

function polar(radius: number, angleRad: number): Vec2 {
  return { x: radius * Math.cos(angleRad), y: radius * Math.sin(angleRad) };
}

/** 平移到 centerMm，并规整为逆时针（外环 CCW）。 */
function placeRing(pts: Vec2[], center: Vec2): Vec2[] {
  const moved = pts.map((q) => ({ x: q.x + center.x, y: q.y + center.y }));
  return signedArea(moved) < 0 ? moved.reverse() : moved;
}

/**
 * 五角星：外接圆直径 sizeMm，内圆 r = R × 0.382，10 顶点交替，从正上方起笔。
 * 返回单环 `Vec2[][]`（长度 1，环 10 个顶点，CCW）。
 */
export function starRings(p: OrnamentParams = {}): Vec2[][] {
  const R = resolveSizeMm(p) / 2;
  const r = R * 0.382;
  const center = p.centerMm ?? { x: 0, y: 0 };
  const pts: Vec2[] = [];
  for (let k = 0; k < 10; k++) {
    const ang = Math.PI / 2 + (k * Math.PI) / 5; // 从正上方起，每 36°
    pts.push(polar(k % 2 === 0 ? R : r, ang));
  }
  return [placeRing(pts, center)];
}

/**
 * 六芒星（并集轮廓）：外顶点半径 R、内顶点半径 R/√3，12 顶点交替，从 +x 起笔。
 * 返回单环 `Vec2[][]`（长度 1，环 12 个顶点，CCW）——并集后的实心轮廓。
 */
export function hexagramRings(p: OrnamentParams = {}): Vec2[][] {
  const R = resolveSizeMm(p) / 2;
  const rInner = R / Math.sqrt(3);
  const center = p.centerMm ?? { x: 0, y: 0 };
  const pts: Vec2[] = [];
  for (let k = 0; k < 12; k++) {
    const ang = (k * Math.PI) / 6; // 每 30°
    // k 偶 → 内顶点（0°,60°…）；k 奇 → 外顶点（30°,90°…）
    pts.push(polar(k % 2 === 0 ? rInner : R, ang));
  }
  return [placeRing(pts, center)];
}

/**
 * 六芒星的两个独立等边三角形（一正一倒，外接圆半径 R）。
 * 返回两条各 3 顶点的环（共 6 个顶点）。若几何层自行做并集可用它；
 * 否则直接用 `hexagramRings` 的并集轮廓更省事。
 */
export function hexagramTriangles(p: OrnamentParams = {}): Vec2[][] {
  const R = resolveSizeMm(p) / 2;
  const center = p.centerMm ?? { x: 0, y: 0 };
  const up: Vec2[] = [90, 210, 330].map((d) => polar(R, (d * Math.PI) / 180));
  const down: Vec2[] = [270, 30, 150].map((d) => polar(R, (d * Math.PI) / 180));
  return [placeRing(up, center), placeRing(down, center)];
}

/** 图案类型联合（UI 选择用）。 */
export type OrnamentId = 'star' | 'hexagram';

/** 按 id 取环（几何层统一入口）。 */
export function ornamentRings(id: OrnamentId, p: OrnamentParams = {}): Vec2[][] {
  return id === 'star' ? starRings(p) : hexagramRings(p);
}
