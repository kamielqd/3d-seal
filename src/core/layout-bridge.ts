/**
 * 把各图层的 layout 输出收集成几何层要的多边形列表。
 * layout 输出 { points: Vec2[] }，几何层要 { outer, holes }，中间由 polygon-bridge 归组。
 */
import { ensureFont, resolveFontId } from '../layout/fonts';
import { textToPolygons, verticalTextToPolygons, type GlyphFont } from '../layout/text';
import { ringTextPolygons } from '../layout/ring';
import { huiwenTextPolygons } from '../layout/huiwen';
import { fromLayoutPolygons } from './polygon-bridge';
import type { Layer, SealSpec, TextLayer } from './spec';
import type { Polygon2D as GeomPolygon } from '../geometry/types';

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

async function layoutText(layer: TextLayer, spec: SealSpec): Promise<LayoutPolygon[]> {
  const font = await fontFor(layer);
  const centerMm = anchorToMm(layer.anchor, spec.body.sizeMm);
  const base = {
    text: layer.text,
    font,
    fontSizeMm: layer.fontSizeMm,
    letterSpacingMm: layer.letterSpacingMm,
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
        fontSizeMm: layer.fontSizeMm,
        gapMm: layer.letterSpacingMm,
        centerMm,
      }).polygons as unknown as LayoutPolygon[];
    case 'ring': {
      // 字心落在「章面半径减去字高余量」的圆上
      const radiusMm = Math.max(
        1,
        spec.body.sizeMm / 2 - spec.body.border.insetMm - spec.body.border.widthMm - layer.fontSizeMm * 0.55,
      );
      const res = ringTextPolygons({
        text: layer.text,
        font,
        fontSizeMm: layer.fontSizeMm,
        letterSpacingMm: layer.letterSpacingMm,
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
}

/** 所有文字图层 → 版式层原始平铺环（**可读**未镜像，盖印预览与缺字提示都用它）。 */
export async function layoutFlatPolygons(spec: SealSpec): Promise<LayoutPolygon[]> {
  const all: LayoutPolygon[] = [];
  for (const layer of spec.layers as Layer[]) {
    if (layer.kind !== 'text') continue;
    if (!layer.text.trim()) continue;
    all.push(...(await layoutText(layer, spec)));
  }
  return all;
}

/** 所有文字图层 → 几何层多边形（外环 CCW / 内孔 CW，嵌套结构） */
export async function layoutToGeometryPolygons(spec: SealSpec): Promise<GeomPolygon[]> {
  return fromLayoutPolygons(await layoutFlatPolygons(spec));
}
