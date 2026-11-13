/**
 * 版式引擎 · 环形排版（圆章/多边形章的外圈文字）
 *
 * 把每个字按「弧长」摆到半径 radiusMm 的圆上，字心落在同一半径；
 * 每字绕自身中心旋转 (angle - 90°)，使字头指向圆外。
 * 整段文字以 startDeg 为**中心**对称铺开（占角 = min(span, 需要角)，起点 = startDeg - 占角/2），
 * 字数少时不会把空隙堆在一侧。字数变化时自动按实际前进宽度重算角度；若总张角超过给定 span，
 * 则等比缩小字号与字距以适配（不重叠、不越界）。
 */

import type { Vec2, GlyphFont } from './text.ts';
import {
  type Polygon2D,
  centerPolygons,
  glyphToPolygons,
  measureAdvanceMm,
  transformPolygons,
} from './text.ts';

export interface RingParams {
  text: string;
  font: GlyphFont;
  fontSizeMm: number;
  /** 字距，沿弧长的间隙（mm） */
  letterSpacingMm?: number;
  /** 字心所在圆半径（mm） */
  radiusMm: number;
  /** 文字弧的**中心**角度（度，0=+x 方向，逆时针为正，默认 90=正上方）；整段以它为中心对称铺开 */
  startDeg?: number;
  /** 允许占用的总张角（度）。<=0 表示不限制（仅保证不自交，即 <=360°） */
  spanDeg?: number;
  /** 圆心（章面坐标，mm） */
  centerMm?: Vec2;
  toleranceMm?: number;
}

export interface RingCharPos {
  char: string;
  angleDeg: number;
  x: number;
  y: number;
}

export interface RingResult {
  polygons: Polygon2D[];
  positions: RingCharPos[];
  /** 是否在给定 span 内放得下（放不下时已自动缩放，fits 表示缩放后是否仍满足 span） */
  fits: boolean;
  /** 实际占用张角（度） */
  usedSpanDeg: number;
  /** 实际使用的字号（放不下时会比入参小） */
  fontSizeMm: number;
}

/**
 * 环形排版。返回多边形环（外环 CCW / 内孔 CW）与每字位置。
 */
export function ringTextPolygons(p: RingParams): RingResult {
  const chars = Array.from(p.text).filter((c) => c.trim() !== '');
  const n = chars.length;
  const center = p.centerMm ?? { x: 0, y: 0 };
  const startRad = ((p.startDeg ?? 90) * Math.PI) / 180;
  const r = Math.max(1e-6, p.radiusMm);
  const gap0 = Math.max(0, p.letterSpacingMm ?? 0);
  const spanRad = p.spanDeg && p.spanDeg > 0 ? (p.spanDeg * Math.PI) / 180 : Infinity;

  if (n === 0) {
    return { polygons: [], positions: [], fits: true, usedSpanDeg: 0, fontSizeMm: p.fontSizeMm };
  }

  // 读取前进宽度（mm），随后可能按比例缩放
  const advanceOf = (chs: string[], size: number): number[] =>
    chs.map((ch) => measureAdvanceMm(p.font.charToGlyph(ch), size, p.font.unitsPerEm));

  let fontSize = p.fontSizeMm;
  let gap = gap0;
  let advances = advanceOf(chars, fontSize);
  const totalLinear = (adv: number[], g: number): number =>
    adv.reduce((a, b) => a + b, 0) + g * Math.max(0, n - 1);

  let sweep = totalLinear(advances, gap) / r;
  let fits = true;
  if (spanRad !== Infinity && sweep > spanRad) {
    // 线性缩放：advance 与 gap 都随缩放因子成比例，一次即可落到 span
    const factor = spanRad / sweep;
    fontSize *= factor;
    gap *= factor;
    advances = advanceOf(chars, fontSize);
    sweep = totalLinear(advances, gap) / r;
    fits = sweep <= spanRad + 1e-9;
  } else if (sweep > Math.PI * 2) {
    // 未给 span，但整圈放不下 → 视为不 fit（不强缩，交给调用方决定）
    fits = false;
  }

  const polygons: Polygon2D[] = [];
  const positions: RingCharPos[] = [];
  // 以 startDeg 为**中心**对称铺开：占角 sweep，起点 = startDeg - sweep/2。
  // 这样字数少、span 大时不会把空隙全堆在一侧（旧行为：从 startDeg 起单向铺开）。
  const startAngleCenter = startRad - sweep / 2;
  let acc = 0; // 沿弧长的累计长度（mm）
  for (let i = 0; i < n; i++) {
    const ch = chars[i];
    const adv = advances[i];
    const centerLinear = acc + adv / 2;
    const angle = startAngleCenter + centerLinear / r;
    const rot = angle - Math.PI / 2; // 字头朝外
    const px = center.x + r * Math.cos(angle);
    const py = center.y + r * Math.sin(angle);

    const glyph = p.font.charToGlyph(ch);
    const gp = glyphToPolygons(glyph, fontSize, { toleranceMm: p.toleranceMm });
    if (gp.length > 0) {
      const centered = centerPolygons(gp); // 字心移到原点
      polygons.push(...transformPolygons(centered, { rotateRad: rot, dx: px, dy: py }));
    }
    positions.push({
      char: ch,
      angleDeg: (angle * 180) / Math.PI,
      x: px,
      y: py,
    });
    acc += adv + gap;
  }

  const used = (acc - gap) / r; // 去掉末尾多加的一个 gap
  return {
    polygons,
    positions,
    fits,
    usedSpanDeg: (used * 180) / Math.PI,
    fontSizeMm: fontSize,
  };
}

/** 便捷：只取多边形（几何管线用） */
export function ringPolygons(p: RingParams): Polygon2D[] {
  return ringTextPolygons(p).polygons;
}

/** 校验辅助：字心是否都在同一半径、相邻字最小中心角差（供测试/自检） */
export function ringSelfCheck(res: RingResult, radiusMm: number): {
  sameRadius: boolean;
  minCenterGapDeg: number;
} {
  let sameRadius = true;
  for (const pos of res.positions) {
    const rr = Math.hypot(pos.x, pos.y);
    if (Math.abs(rr - radiusMm) > 1e-3) sameRadius = false;
  }
  let minGap = 180;
  const angles = res.positions.map((q) => q.angleDeg).sort((a, b) => a - b);
  for (let i = 1; i < angles.length; i++) {
    minGap = Math.min(minGap, angles[i] - angles[i - 1]);
  }
  if (angles.length > 1) {
    // 首尾环绕
    const wrap = 360 - (angles[angles.length - 1] - angles[0]);
    if (wrap < minGap) minGap = wrap;
  }
  return { sameRadius, minCenterGapDeg: minGap };
}
