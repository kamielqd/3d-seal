/**
 * 把各图层的 layout 输出收集成几何层要的多边形列表。
 * layout 输出 { points: Vec2[] }，几何层要 { outer, holes }，中间由 polygon-bridge 归组。
 */
import { ensureFont, resolveFontId } from '../layout/fonts.ts';
import { textToPolygons, verticalTextToPolygons, type GlyphFont } from '../layout/text.ts';
import { ringTextPolygons } from '../layout/ring.ts';
import { huiwenTextPolygons } from '../layout/huiwen.ts';
import { fromLayoutPolygons } from './polygon-bridge.ts';
import type { Layer, SealSpec, TextLayer } from './spec.ts';
import type { Polygon2D as GeomPolygon } from '../geometry/types.ts';

export interface LayoutPolygon {
  points: { x: number; y: number }[];
}

/** anchor(-1~1) → 章面内坐标系(mm) */
function anchorToMm(anchor: { x: number; y: number }, sizeMm: number) {
  const half = sizeMm / 2;
  return { x: anchor.x * half * 0.75, y: anchor.y * half * 0.75 };
}

async function fontFor(layer: TextLayer): Promise<GlyphFont> {
  // 传入 layer.text：说文等多分片字体只加载命中该文本的分片（分片按需）
  const set = await ensureFont(resolveFontId(layer.fontId), layer.text);
  return set as unknown as GlyphFont;
}

/** 文字实测包围盒（mm，章面坐标系）。 */
function measure(polys: LayoutPolygon[]): { w: number; h: number } {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of polys) {
    for (const { x, y } of p.points) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (!Number.isFinite(minX)) return { w: 0, h: 0 };
  return { w: maxX - minX, h: maxY - minY };
}

/**
 * 章面可用尺寸（mm）。留边考虑边框内缩与线宽，圆章/多边形在文字所在高度处的
 * 弦长小于直径，按内切方形保守折算——宁可缩得小一点，也不让笔画探出章面。
 */
function fitBoxMm(spec: SealSpec): { w: number; h: number } {
  const b = spec.body;
  // 除了边框占位，还要留一条笔画宽的 clearance：只减「边框内缩+线宽」时，
  // 排满的字会正好贴到边框内沿（实测最外笔画离边框只剩 0.15mm）。
  const clearance = Math.max(0.3, spec.print?.minStrokeMm ?? 0.4);
  const margin = Math.max(b.border.insetMm + b.border.widthMm, b.sizeMm * 0.06) + clearance;
  const usable = Math.max(4, b.sizeMm - margin * 2);
  const factor = b.shape === 'square' ? 1 : b.shape === 'circle' ? 0.86 : 0.8;
  return { w: usable * factor, h: usable * factor };
}

export interface LayerFit {
  layerId: string;
  /** 用户设的字号 */
  requestedFontMm: number;
  /** 实际排出来的字号（自动适应后可能更小） */
  effectiveFontMm: number;
  /** 是否因为塞不下而缩过 */
  fitted: boolean;
}

/**
 * 排一个文字图层，必要时等比缩字号与字距让它塞进章面。
 *
 * 宽度和字高都随字号线性变化（字距也一起缩），所以量一次包围盒就能算出精确比例，
 * 不需要迭代。环形版式自己按半径分配角度、不会超框，不参与适应。
 */
async function layoutTextWithFit(
  layer: TextLayer,
  spec: SealSpec,
): Promise<{ polygons: LayoutPolygon[]; fit: LayerFit }> {
  const font = await fontFor(layer);
  const centerMm = anchorToMm(layer.anchor, spec.body.sizeMm);

  const build = (fontSizeMm: number, letterSpacingMm: number): LayoutPolygon[] => {
    const base = {
      text: layer.text,
      font,
      fontSizeMm,
      letterSpacingMm,
      centerMm,
      rotateDeg: layer.transform.rotateDeg,
      scale: layer.transform.scale,
    };

    switch (layer.layout) {
      case 'vertical':
        return verticalTextToPolygons(base) as unknown as LayoutPolygon[];
      case 'huiwen':
        return huiwenTextPolygons({
          text: layer.text,
          font,
          fontSizeMm,
          gapMm: letterSpacingMm,
          centerMm,
        }).polygons as unknown as LayoutPolygon[];
      case 'ring': {
        // 字心落在「章面半径减去字高余量」的圆上
        const radiusMm = Math.max(
          1,
          spec.body.sizeMm / 2 - spec.body.border.insetMm - spec.body.border.widthMm - fontSizeMm * 0.55,
        );
        const res = ringTextPolygons({
          text: layer.text,
          font,
          fontSizeMm,
          letterSpacingMm,
          radiusMm,
          startDeg: layer.ringStartDeg,
          spanDeg: layer.ringSpanDeg,
          centerMm,
        });
        return res.polygons as unknown as LayoutPolygon[];
      }
      case 'horizontal':
      default:
        return textToPolygons(base) as unknown as LayoutPolygon[];
    }
  };

  const requested = layer.fontSizeMm;
  const first = build(requested, layer.letterSpacingMm);
  const makeFit = (fitted: boolean, effectiveFontMm: number): LayerFit => ({
    layerId: layer.id,
    requestedFontMm: requested,
    effectiveFontMm,
    fitted,
  });

  if (layer.autoFit === false || layer.layout === 'ring') return { polygons: first, fit: makeFit(false, requested) };

  const box = fitBoxMm(spec);
  const m = measure(first);
  const k = Math.min(1, m.w > 0 ? box.w / m.w : 1, m.h > 0 ? box.h / m.h : 1);
  if (k >= 0.995) return { polygons: first, fit: makeFit(false, requested) };

  // 等比缩字号与字距：两者同时乘 k，包围盒也正好缩到 k 倍
  const effective = Math.round(requested * k * 100) / 100;
  return {
    polygons: build(effective, layer.letterSpacingMm * k),
    fit: makeFit(true, effective),
  };
}


/** 所有文字图层 → 版式层原始平铺环（**可读**未镜像，盖印预览与缺字提示都用它）。 */
export async function layoutFlatPolygons(spec: SealSpec): Promise<LayoutPolygon[]> {
  return (await layoutFlatWithFit(spec)).polygons;
}

/** 同上，另外带每个文字图层的「实际字号」，面板用来显示「7mm → 4.4mm 已适应章面」。 */
export async function layoutFlatWithFit(
  spec: SealSpec,
): Promise<{ polygons: LayoutPolygon[]; fits: LayerFit[] }> {
  const polygons: LayoutPolygon[] = [];
  const fits: LayerFit[] = [];
  for (const layer of spec.layers as Layer[]) {
    if (layer.kind !== 'text') continue;
    if (!layer.text.trim()) continue;
    const { polygons: polys, fit } = await layoutTextWithFit(layer, spec);
    polygons.push(...polys);
    fits.push(fit);
  }
  return { polygons, fits };
}

/** 所有文字图层 → 几何层多边形（外环 CCW / 内孔 CW，嵌套结构） */
export async function layoutToGeometryPolygons(spec: SealSpec): Promise<GeomPolygon[]> {
  return fromLayoutPolygons(await layoutFlatPolygons(spec));
}
