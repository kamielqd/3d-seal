/**
 * 版式引擎 · 文字 → 二维多边形环（纯 2D，无 DOM、无字体加载）
 *
 * 契约（DESIGN §13）：
 *  - 输出 Polygon2D[]：每个元素是一条闭合环；
 *  - 外环逆时针（CCW，signedArea > 0），内孔顺时针（CW，signedArea < 0）；
 *  - 单位 mm，原点在章面中心（+x 右、+y 上）。
 *
 * 字体解析交给 fonts.ts / worker；本文件只接收已解析的 opentype.Font 对象。
 */

import type { Glyph } from 'opentype.js';
import type { Vec2 } from '../core/spec.ts';

export type { Vec2 };

/** 最小字体接口：既接受 opentype.Font，也接受多分片 FontSet（说文 block1/block2）。 */
export interface GlyphFont {
  unitsPerEm: number;
  charToGlyph(ch: string): Glyph;
}

/** 单条闭合环：首尾不重复，顺序即环方向。 */
export interface Polygon2D {
  points: Vec2[];
}

export interface FlattenOptions {
  /** 贝塞尔自适应扁平化的弦高误差，单位 mm，默认 0.05（0.02 仅用于高清导出） */
  toleranceMm?: number;
}

export interface TextBlockParams {
  text: string;
  /** 已解析的字体对象（opentype.Font 或 FontSet） */
  font: GlyphFont;
  fontSizeMm: number;
  /** 字距，单位 mm */
  letterSpacingMm?: number;
  /** 文字块中心（章面中心为原点，mm），默认 (0,0) */
  centerMm?: Vec2;
  /** 整体旋转（度） */
  rotateDeg?: number;
  /** 整体缩放 */
  scale?: number;
  toleranceMm?: number;
  /**
   * 横排：单行最大宽度（mm）。超过则自动换行，换行后整块按墨迹包围盒重新居中。
   * 不传（或 <=0）保持单行（向后兼容）。
   */
  maxWidthMm?: number;
  /**
   * 竖排：单列最大高度（mm）。超过则自动换列（自右向左），整块按包围盒重新居中。
   * 不传（或 <=0）保持单列（向后兼容）。
   */
  maxHeightMm?: number;
  /** 行高倍数：行/列间距 = fontSizeMm × lineHeight，默认 1.15 */
  lineHeight?: number;
}

/** 默认弦高误差 0.05mm：0.4mm 喷嘴下点数/网格已足够；0.02 仅用于「高清导出」，不设为默认。 */
export const DEFAULT_TOLERANCE_MM = 0.05;

/** opentype 路径指令（用宽松类型，避免 @types 版本差异导致的联合收窄问题） */
interface PathCmd {
  type: string;
  x?: number;
  y?: number;
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
}

const warned = new Set<string>();
function warnMissing(ch: string): void {
  if (warned.has(ch)) return;
  warned.add(ch);
  // 缺字（opentype 返回 .notdef，index 0）：不绘制方框，交由 UI 用 checkMissing 拦截。
  // eslint-disable-next-line no-console
  console.warn(`[layout] 字体缺少字形「${ch}」，已跳过不绘制（应由 checkMissing 拦截）`);
}

/* ------------------------------------------------------------------ */
/* 贝塞尔自适应扁平化                                                   */
/* ------------------------------------------------------------------ */

function mid(a: Vec2, b: Vec2): Vec2 {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** 点到线段所在直线的垂距 */
function distPointLine(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len;
}

function flattenQuad(p0: Vec2, p1: Vec2, p2: Vec2, tol: number, out: Vec2[]): void {
  if (distPointLine(p1, p0, p2) <= tol) {
    out.push(p2);
    return;
  }
  const p01 = mid(p0, p1);
  const p12 = mid(p1, p2);
  const m = mid(p01, p12);
  flattenQuad(p0, p01, m, tol, out);
  flattenQuad(m, p12, p2, tol, out);
}

function flattenCubic(
  p0: Vec2,
  p1: Vec2,
  p2: Vec2,
  p3: Vec2,
  tol: number,
  out: Vec2[],
): void {
  const d = Math.max(distPointLine(p1, p0, p3), distPointLine(p2, p0, p3));
  if (d <= tol) {
    out.push(p3);
    return;
  }
  const p01 = mid(p0, p1);
  const p12 = mid(p1, p2);
  const p23 = mid(p2, p3);
  const p012 = mid(p01, p12);
  const p123 = mid(p12, p23);
  const m = mid(p012, p123);
  flattenCubic(p0, p01, p012, m, tol, out);
  flattenCubic(m, p123, p23, p3, tol, out);
}

function dedupeRing(pts: Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  const eps = 1e-9;
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > eps) out.push(p);
  }
  // 若首尾重合，去掉尾部重复点（闭合环约定首尾不重复）
  if (out.length > 1) {
    const a = out[0];
    const b = out[out.length - 1];
    if (Math.hypot(a.x - b.x, a.y - b.y) <= eps) out.pop();
  }
  return out;
}

/** opentype Path → 多条扁平化闭合环（保留原始环方向，待后面按嵌套定方向） */
function pathToRings(path: { commands: PathCmd[] }, tol: number): Vec2[][] {
  const rings: Vec2[][] = [];
  let cur: Vec2[] | null = null;
  let cx = 0;
  let cy = 0;
  const cmds = (path.commands ?? []) as PathCmd[];
  for (const c of cmds) {
    if (c.type === 'M') {
      if (cur && cur.length > 1) rings.push(cur);
      cur = [{ x: c.x ?? 0, y: c.y ?? 0 }];
      cx = c.x ?? 0;
      cy = c.y ?? 0;
    } else if (c.type === 'L') {
      if (!cur) cur = [{ x: cx, y: cy }];
      const p = { x: c.x ?? 0, y: c.y ?? 0 };
      cur.push(p);
      cx = p.x;
      cy = p.y;
    } else if (c.type === 'Q') {
      if (!cur) cur = [{ x: cx, y: cy }];
      const end = { x: c.x ?? 0, y: c.y ?? 0 };
      flattenQuad({ x: cx, y: cy }, { x: c.x1 ?? 0, y: c.y1 ?? 0 }, end, tol, cur);
      cx = end.x;
      cy = end.y;
    } else if (c.type === 'C') {
      if (!cur) cur = [{ x: cx, y: cy }];
      const end = { x: c.x ?? 0, y: c.y ?? 0 };
      flattenCubic(
        { x: cx, y: cy },
        { x: c.x1 ?? 0, y: c.y1 ?? 0 },
        { x: c.x2 ?? 0, y: c.y2 ?? 0 },
        end,
        tol,
        cur,
      );
      cx = end.x;
      cy = end.y;
    } else if (c.type === 'Z' || c.type === 'z') {
      if (cur && cur.length > 1) rings.push(cur);
      cur = null;
    }
  }
  if (cur && cur.length > 1) rings.push(cur);
  return rings.map(dedupeRing).filter((r) => r.length >= 3);
}

/* ------------------------------------------------------------------ */
/* 环方向与嵌套判定                                                     */
/* ------------------------------------------------------------------ */

/** 有符号面积：>0 为逆时针（CCW），<0 为顺时针（CW） */
export function signedArea(pts: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

function pointInPolygon(pt: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    const intersect =
      a.y > pt.y !== b.y > pt.y &&
      pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x;
    if (intersect) inside = !inside;
  }
  return inside;
}

function centroid(pts: Vec2[]): Vec2 {
  let x = 0;
  let y = 0;
  for (const p of pts) {
    x += p.x;
    y += p.y;
  }
  return { x: x / pts.length, y: y / pts.length };
}

function interiorPoint(pts: Vec2[]): Vec2 {
  const c = centroid(pts);
  if (pointInPolygon(c, pts)) return c;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const bc = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
  if (pointInPolygon(bc, pts)) return bc;
  return pts[0];
}

/**
 * 把同一字形的多条环按嵌套深度定方向：
 * 深度为偶数 → 外环 → CCW；深度为奇数 → 内孔 → CW。
 * 这样「回」「日」这类带内孔的字能正确拆成外环 + 内孔。
 */
export function classifyRings(rings: Vec2[][]): Polygon2D[] {
  const out: Polygon2D[] = [];
  for (let i = 0; i < rings.length; i++) {
    const probe = interiorPoint(rings[i]);
    let depth = 0;
    for (let j = 0; j < rings.length; j++) {
      if (i !== j && pointInPolygon(probe, rings[j])) depth++;
    }
    const wantCCW = depth % 2 === 0;
    const isCCW = signedArea(rings[i]) > 0;
    let pts = rings[i].slice();
    if (isCCW !== wantCCW) pts = pts.reverse();
    out.push({ points: pts });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 基础图元 → 多边形                                                    */
/* ------------------------------------------------------------------ */

/** 单个字形 → 多边形环（局部坐标，基线原点，单位 mm，方向已归一） */
export function glyphToPolygons(
  glyph: Glyph,
  fontSizeMm: number,
  opts: FlattenOptions = {},
): Polygon2D[] {
  const tol = opts.toleranceMm ?? DEFAULT_TOLERANCE_MM;
  let path: { commands: PathCmd[] };
  try {
    path = glyph.getPath(0, 0, fontSizeMm) as unknown as { commands: PathCmd[] };
  } catch {
    return [];
  }
  // opentype 的 getPath 用屏幕坐标：y 向下、基线之上为负值。
  // 本项目约定 +y 向上（打印/数学坐标），这里统一取反，
  // 否则整个字是上下颠倒的（字形左右对称时肉眼很难发现）。
  path = {
    commands: path.commands.map((c) => ({
      ...c,
      y: c.y == null ? c.y : -c.y,
      y1: c.y1 == null ? c.y1 : -c.y1,
      y2: c.y2 == null ? c.y2 : -c.y2,
    })),
  } as unknown as { commands: PathCmd[] };
  const rings = pathToRings(path, tol);
  if (rings.length === 0) return [];
  return classifyRings(rings);
}

/** 字形前进宽度（mm） */
export function measureAdvanceMm(glyph: Glyph, fontSizeMm: number, unitsPerEm: number): number {
  const adv = glyph.advanceWidth ?? 0;
  return (adv * fontSizeMm) / unitsPerEm;
}

export interface Placement {
  dx?: number;
  dy?: number;
  rotateRad?: number;
  scale?: number;
}

/** 对多边形做「缩放 → 旋转 → 平移」，环方向随旋转保持（不翻转） */
export function transformPolygons(polys: Polygon2D[], pl: Placement): Polygon2D[] {
  const s = pl.scale ?? 1;
  const a = pl.rotateRad ?? 0;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const dx = pl.dx ?? 0;
  const dy = pl.dy ?? 0;
  return polys.map((pg) => ({
    points: pg.points.map((p) => {
      const x = p.x * s;
      const y = p.y * s;
      return { x: cos * x - sin * y + dx, y: sin * x + cos * y + dy };
    }),
  }));
}

export interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function bounds(polys: Polygon2D[]): BBox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const pg of polys) {
    for (const p of pg.points) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX, minY, maxX, maxY };
}

/** 把一组多边形整体平移，使其包围盒中心落在原点 */
export function centerPolygons(polys: Polygon2D[]): Polygon2D[] {
  if (polys.length === 0) return polys;
  const bb = bounds(polys);
  const cx = (bb.minX + bb.maxX) / 2;
  const cy = (bb.minY + bb.maxY) / 2;
  return polys.map((pg) => ({
    points: pg.points.map((p) => ({ x: p.x - cx, y: p.y - cy })),
  }));
}

/* ------------------------------------------------------------------ */
/* 线性排版（横排 / 竖排）                                              */
/* ------------------------------------------------------------------ */

function finalizeBlock(polys: Polygon2D[], p: TextBlockParams): Polygon2D[] {
  if (polys.length === 0) return polys;
  const bb = bounds(polys);
  const cx = (bb.minX + bb.maxX) / 2;
  const cy = (bb.minY + bb.maxY) / 2;
  const center = p.centerMm ?? { x: 0, y: 0 };
  const s = p.scale ?? 1;
  const a = ((p.rotateDeg ?? 0) * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return polys.map((pg) => ({
    points: pg.points.map((pt) => {
      const x = (pt.x - cx) * s;
      const y = (pt.y - cy) * s;
      return { x: cos * x - sin * y + center.x, y: sin * x + cos * y + center.y };
    }),
  }));
}

function glyphRingsForChar(
  font: GlyphFont,
  ch: string,
  fontSizeMm: number,
  tol: number | undefined,
): { polys: Polygon2D[]; advanceMm: number } {
  const glyph = font.charToGlyph(ch);
  const advanceMm = measureAdvanceMm(glyph, fontSizeMm, font.unitsPerEm);
  if (glyph.index === 0) {
    // 缺字：不画 .notdef 方框，交给 UI 依据 checkMissing 拦截（不许静默降级成方框）
    warnMissing(ch);
    return { polys: [], advanceMm };
  }
  const polys = glyphToPolygons(glyph, fontSizeMm, { toleranceMm: tol });
  return { polys, advanceMm };
}

/** 默认行高倍数（行距 = 字号 × 该值） */
export const DEFAULT_LINE_HEIGHT = 1.15;

/** 不允许出现在行首/列首的标点（遇到就把上一个字挪下来） */
const LINE_START_PUNCT = new Set(Array.from('，。、；：！？'));

function isLineStartPunct(ch: string): boolean {
  return LINE_START_PUNCT.has(ch);
}

interface CharInfo {
  ch: string;
  polys: Polygon2D[];
  advanceMm: number;
}

function buildCharInfos(
  font: GlyphFont,
  chars: string[],
  fontSizeMm: number,
  tol: number | undefined,
): CharInfo[] {
  return chars.map((ch) => {
    const { polys, advanceMm } = glyphRingsForChar(font, ch, fontSizeMm, tol);
    return { ch, polys, advanceMm };
  });
}

/** 一组字（按前进宽度计）的连线宽：Σadvance + 字距×(n-1) */
function runAdvanceWidth(infos: CharInfo[], idxs: number[], spacing: number): number {
  let w = 0;
  for (let k = 0; k < idxs.length; k++) w += infos[idxs[k]].advanceMm;
  return w + spacing * Math.max(0, idxs.length - 1);
}

/**
 * 横排：逐字按前进宽度累加 + 字距。
 *
 * - 居中：**按墨迹包围盒**把整块平移到 `centerMm`（不再用字宽累加居中——
 *   汉字左右边距与末字字距会让墨迹重心偏离字宽中点，竖直方向更要按 bbox 居中）。
 * - 换行：给了 `maxWidthMm` 且单行超宽就贪心换行，行距 = fontSizeMm × lineHeight；
 *   换行后整块按 bbox 重新居中。行首是标点时把上一行最后一个字挪下来。
 * - 不传 `maxWidthMm` 时行为等同旧的单行排版（向后兼容）。
 */
export function textToPolygons(p: TextBlockParams): Polygon2D[] {
  const fontSizeMm = p.fontSizeMm;
  const spacing = p.letterSpacingMm ?? 0;
  const lineHeight = p.lineHeight ?? DEFAULT_LINE_HEIGHT;
  const infos = buildCharInfos(p.font, Array.from(p.text), fontSizeMm, p.toleranceMm);
  if (infos.length === 0) return [];
  const maxWidth = p.maxWidthMm != null && p.maxWidthMm > 0 ? p.maxWidthMm : Infinity;

  // 1) 贪心分行（按前进宽度；advance 一般 ≥ 墨迹宽，保证墨迹不会超框）
  const lines: number[][] = [];
  {
    let cur: number[] = [];
    for (let i = 0; i < infos.length; i++) {
      if (cur.length === 0) {
        cur.push(i);
        continue;
      }
      const tentative = runAdvanceWidth(infos, [...cur, i], spacing);
      if (tentative <= maxWidth + 1e-9) {
        cur.push(i);
      } else {
        lines.push(cur);
        cur = [i];
      }
    }
    if (cur.length > 0) lines.push(cur);
  }

  // 2) 行首标点：把上一行最后一个字挪到下一行行首（上一行需 >1 字）
  for (let li = 1; li < lines.length; li++) {
    let guard = 0;
    while (
      lines[li].length > 0 &&
      lines[li - 1].length > 1 &&
      isLineStartPunct(infos[lines[li][0]].ch) &&
      guard++ < 64
    ) {
      const moved = lines[li - 1].pop() as number;
      lines[li].unshift(moved);
    }
  }

  // 3) 逐行摆放：行内按基线对齐（y=0 为基线），行间基线相距 fontSizeMm × lineHeight
  const lineStep = fontSizeMm * lineHeight;
  const nLines = lines.length;
  const out: Polygon2D[] = [];
  for (let li = 0; li < nLines; li++) {
    const idxs = lines[li];
    const baselineY = ((nLines - 1) / 2 - li) * lineStep;
    const linePolys: Polygon2D[] = [];
    let cursor = 0;
    for (const i of idxs) {
      const inf = infos[i];
      if (inf.ch.trim() !== '' && inf.polys.length > 0) {
        linePolys.push(...transformPolygons(inf.polys, { dx: cursor, dy: 0 }));
      }
      cursor += inf.advanceMm + spacing;
    }
    if (linePolys.length === 0) continue;
    // 行内按墨迹水平居中，基线落到 baselineY
    const lb = bounds(linePolys);
    const shiftX = -((lb.minX + lb.maxX) / 2);
    for (const pg of linePolys) {
      out.push({ points: pg.points.map((pt) => ({ x: pt.x + shiftX, y: pt.y + baselineY })) });
    }
  }

  return finalizeBlock(out, p);
}

/**
 * 竖排：字身直立、自上而下，每字按包围盒居中到其格心。
 *
 * - 居中：整块按墨迹包围盒平移回 `centerMm`。
 * - 换列：给了 `maxHeightMm` 且单列超高就贪心换列（列自右向左），
 *   列间距 = fontSizeMm × lineHeight；换列后整块按 bbox 重新居中。
 *   列首是标点时把上一列最后一个字挪下来。
 * - 不传 `maxHeightMm` 时行为等同旧的单列排版（向后兼容）。
 */
export function verticalTextToPolygons(p: TextBlockParams): Polygon2D[] {
  const fontSizeMm = p.fontSizeMm;
  const spacing = p.letterSpacingMm ?? 0;
  const lineHeight = p.lineHeight ?? DEFAULT_LINE_HEIGHT;
  const infos = buildCharInfos(p.font, Array.from(p.text), fontSizeMm, p.toleranceMm);
  if (infos.length === 0) return [];
  const charStep = fontSizeMm + spacing; // 同列上下相邻字的中心距
  const maxHeight = p.maxHeightMm != null && p.maxHeightMm > 0 ? p.maxHeightMm : Infinity;

  // 1) 贪心分列：一列高度 ≈ 首末字心跨度 + 一个字高
  const columns: number[][] = [];
  {
    let cur: number[] = [];
    for (let i = 0; i < infos.length; i++) {
      if (cur.length === 0) {
        cur.push(i);
        continue;
      }
      const newCount = cur.length + 1;
      const h = charStep * (newCount - 1) + fontSizeMm;
      if (h <= maxHeight + 1e-9) {
        cur.push(i);
      } else {
        columns.push(cur);
        cur = [i];
      }
    }
    if (cur.length > 0) columns.push(cur);
  }

  // 2) 列首标点：把上一列最后一个字挪到下一列列首（上一列需 >1 字）
  for (let ci = 1; ci < columns.length; ci++) {
    let guard = 0;
    while (
      columns[ci].length > 0 &&
      columns[ci - 1].length > 1 &&
      isLineStartPunct(infos[columns[ci][0]].ch) &&
      guard++ < 64
    ) {
      const moved = columns[ci - 1].pop() as number;
      columns[ci].unshift(moved);
    }
  }

  // 3) 逐列摆放：列自右向左，列内自上而下
  const colStep = fontSizeMm * lineHeight;
  const nCols = columns.length;
  const out: Polygon2D[] = [];
  for (let ci = 0; ci < nCols; ci++) {
    const idxs = columns[ci];
    const colX = ((nCols - 1) / 2 - ci) * colStep; // ci=0 最右（x 最大）
    const k = idxs.length;
    for (let a = 0; a < k; a++) {
      const inf = infos[idxs[a]];
      if (inf.ch.trim() === '' || inf.polys.length === 0) continue;
      const centered = centerPolygons(inf.polys);
      const cellY = ((k - 1) / 2 - a) * charStep;
      out.push(...transformPolygons(centered, { dx: colX, dy: cellY }));
    }
  }

  return finalizeBlock(out, p);
}
