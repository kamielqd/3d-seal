/**
 * 元素 → 几何多边形。
 *
 * 四种元素都按「大圆」定位：章面直径 D = body.sizeMm，滑条 0–100 是 D 的等分。
 * 输出仍然是 { points } 平铺环，交给 polygon-bridge 归组。
 */
import { ensureFont, resolveFontId } from '../layout/fonts.ts';
import { textToPolygons, type GlyphFont } from '../layout/text.ts';
import { ringTextPolygons } from '../layout/ring.ts';
import { fromLayoutPolygons } from './polygon-bridge.ts';
import type { Layer, SealSpec } from './spec.ts';
import { isTextElement } from './elements.ts';
import type { PlainTextElement, RingTextElement, RingBorderElement, ImageElement } from './elements.ts';
import type { Polygon2D as GeomPolygon } from '../geometry/types.ts';

export interface LayoutPolygon {
  points: { x: number; y: number }[];
  /** 这圈轮廓属于哪个元素（几何侧按层做重叠/出界诊断时用） */
  layerId?: string;
}

/** 兼容旧接口：几何侧只关心「这层有没有被缩字号」，现在永远是 false */
export interface LayerFit {
  layerId: string;
  requestedFontMm: number;
  effectiveFontMm: number;
  fitted: boolean;
}

/** 0–100 的百分比 → 相对圆心 mm（0 = -D/2，100 = +D/2） */
function pctToMm(pct: number, sizeMm: number): number {
  return (Math.max(0, Math.min(100, pct)) / 100 - 0.5) * sizeMm;
}

async function fontFor(el: { fontId: string; text: string }): Promise<GlyphFont> {
  const set = await ensureFont(resolveFontId(el.fontId), el.text);
  return set as unknown as GlyphFont;
}

const GAP_MM = 0.6;

/** 普通文字：按百分比定位 + 绕自身中心旋转；行宽用圆的可用宽度折行 */
async function layoutPlainText(el: PlainTextElement, spec: SealSpec): Promise<LayoutPolygon[]> {
  const D = spec.body.sizeMm;
  const font = await fontFor(el);
  const centerMm = { x: pctToMm(el.xPct, D), y: pctToMm(el.yPct, D) };
  // 行宽不能超过圆心那一条弦：保守取 0.92D，超了就折行
  const maxWidthMm = D * 0.92;
  const polys = textToPolygons({
    text: el.text,
    font,
    fontSizeMm: el.fontSizeMm,
    letterSpacingMm: GAP_MM,
    centerMm,
    rotateDeg: el.rotationDeg,
    scale: 1,
    maxWidthMm,
    lineHeight: 1.15,
  }) as unknown as LayoutPolygon[];
  return polys;
}

/**
 * 环绕文字。
 *
 * 半径 0–100：100 = 字压在**大圆边界**上；减小时字号不变，整圈往内收。
 * 间距 0–100：0 = 全部叠在起点，100 = 首尾相接（每字步进一个字号）。
 */
async function layoutRingText(el: RingTextElement, spec: SealSpec): Promise<LayoutPolygon[]> {
  const D = spec.body.sizeMm;
  const R = D / 2;
  const radiusPct = Math.max(0, Math.min(100, el.radiusPct));
  // 让 100 时字的**外沿**刚好贴到大圆：轨道半径 = R - 半个字高
  const radiusMm = Math.max(0.5, (radiusPct / 100) * R - el.fontSizeMm * 0.5);

  const chars = [...el.text].filter((ch) => ch.trim() !== '');
  const n = Math.max(1, chars.length);
  // 每个字沿弧线的步进：100 表示按一个字号平铺（首尾相接），0 表示全部叠在一起
  const stepMm = el.fontSizeMm * (Math.max(0, Math.min(100, el.spacingPct)) / 100);
  const stepDeg = (stepMm / radiusMm) * (180 / Math.PI);
  const spanDeg = stepDeg * n;

  const font = await fontFor(el);
  const res = ringTextPolygons({
    text: el.text,
    font,
    fontSizeMm: el.fontSizeMm,
    letterSpacingMm: 0,
    radiusMm,
    // ringTextPolygons 的 startDeg 是**弧心**，这里把首字放到 el.startDeg 上
    startDeg: el.startDeg + spanDeg / 2,
    spanDeg,
    centerMm: { x: 0, y: 0 },
  });
  return res.polygons as unknown as LayoutPolygon[];
}

/** 圆环（实线 / 虚线）。虚线 0 实心，100 = 线长 0.6mm、间隔 0.6mm */
function layoutBorder(el: RingBorderElement, spec: SealSpec): LayoutPolygon[] {
  const D = spec.body.sizeMm;
  const R = D / 2;
  // 100% 半径 = 环的外边缘贴到大圆；环宽 100 = 占满整个大圆
  const outerR = Math.max(0.2, (Math.max(0, Math.min(100, el.radiusPct)) / 100) * R);
  const widthMm = Math.max(0.6, (Math.max(0, Math.min(100, el.widthPct)) / 100) * D);
  const innerR = Math.max(0, outerR - widthMm);

  const dash = Math.max(0, Math.min(100, el.dashPct)) / 100;
  if (dash <= 0.001) {
    // 实心环：外圈 CCW + 内圈 CW
    return [circlePoints(outerR, 1), circlePoints(Math.max(0, innerR), -1)];
  }

  // 虚线：线长 0.6mm、间隔 0.6mm 对应 dash=1；dash 越小越接近实线
  const period = GAP_MM + GAP_MM;
  const dashMm = GAP_MM * dash;
  const gapMm = period * dash - dashMm + (1 - dash) * 0;
  const segLen = Math.max(0.05, dashMm);
  const spacing = Math.max(segLen + 0.05, dashMm + Math.max(0.05, (GAP_MM * dash)));
  void gapMm;
  const midR = (outerR + innerR) / 2;
  const circumference = 2 * Math.PI * midR;
  const count = Math.max(4, Math.floor(circumference / spacing));
  const step = (2 * Math.PI) / count;
  const half = (segLen / midR) / 2;

  const out: LayoutPolygon[] = [];
  for (let i = 0; i < count; i++) {
    const a0 = i * step - half;
    const a1 = i * step + half;
    out.push({
      points: [
        { x: Math.cos(a0) * outerR, y: Math.sin(a0) * outerR },
        { x: Math.cos(a1) * outerR, y: Math.sin(a1) * outerR },
        { x: Math.cos(a1) * innerR, y: Math.sin(a1) * innerR },
        { x: Math.cos(a0) * innerR, y: Math.sin(a0) * innerR },
      ],
    });
  }
  return out;
}

function circlePoints(r: number, dir: 1 | -1, segments = 96): LayoutPolygon {
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (dir * i * 2 * Math.PI) / segments;
    pts.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
  }
  return { points: pts };
}

/** 图片：大小 0–100 = 占满大圆的百分比，位置/旋转同普通文字 */
function imageTraceOptions(el: ImageElement, spec: SealSpec) {
  return {
    bodySizeMm: spec.body.sizeMm,
    widthMm: (Math.max(0, Math.min(100, el.sizePct)) / 100) * spec.body.sizeMm,
    centerMm: { x: pctToMm(el.xPct, spec.body.sizeMm), y: pctToMm(el.yPct, spec.body.sizeMm) },
    rotateDeg: el.rotationDeg,
    mode: el.trace.mode ?? 'silhouette',
    outlineWidthMm: el.trace.outlineWidthMm,
  };
}

/* ------------------------------------------------------------------ */
/* 对外的汇总接口                                                       */
/* ------------------------------------------------------------------ */

/** 所有文字类元素 → 版式多边形（**可读**未镜像）。图片由 worker 描摹，不走这里。 */
export async function layoutFlatWithFit(
  spec: SealSpec,
): Promise<{ polygons: LayoutPolygon[]; fits: LayerFit[] }> {
  const polygons: LayoutPolygon[] = [];
  const fits: LayerFit[] = [];
  for (const layer of spec.layers) {
    if (!isTextElement(layer)) continue;
    if (layer.text.trim() === '') continue;
    const polys =
      layer.kind === 'ringText'
        ? await layoutRingText(layer, spec)
        : await layoutPlainText(layer, spec);
    polygons.push(...polys.map((p) => ({ ...p, layerId: layer.id })));
    fits.push({
      layerId: layer.id,
      requestedFontMm: layer.fontSizeMm,
      effectiveFontMm: layer.fontSizeMm,
      fitted: false,
    });
  }
  // 边框是一圈纯几何，不依赖字体，单独排
  for (const layer of spec.layers) {
    if (layer.kind !== 'border') continue;
    polygons.push(...layoutBorder(layer, spec).map((p) => ({ ...p, layerId: layer.id })));
  }
  return { polygons, fits };
}

export async function layoutFlatPolygons(spec: SealSpec): Promise<LayoutPolygon[]> {
  return (await layoutFlatWithFit(spec)).polygons;
}

/** 所有元素 → 几何层多边形（外环 CCW / 内孔 CW，嵌套结构） */
export async function layoutToGeometryPolygons(spec: SealSpec): Promise<GeomPolygon[]> {
  return fromLayoutPolygons(await layoutFlatPolygons(spec));
}

export { imageTraceOptions };
export type { PlainTextElement, RingTextElement, RingBorderElement, ImageElement };
export type { Layer };
