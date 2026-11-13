/**
 * 版式引擎 · 四字回文定位（方章专用）
 *
 * 传统方章四字回文读序：右上 → 右下 → 左上 → 左下（先右列自上而下，再左列自上而下）。
 * 每字直立、按包围盒居中到所在格心。
 *
 * 坐标：章面中心为原点，+x 右、+y 上（与 text.ts 一致）。
 * 注意：最终「盖章为正」由几何管线最后一步 X 轴镜像负责（DESIGN §4.2）；本层只按版式坐标摆放。
 */

import type { Vec2, GlyphFont } from './text';
import {
  type Polygon2D,
  centerPolygons,
  glyphToPolygons,
  transformPolygons,
} from './text';

export interface HuiwenParams {
  text: string;
  font: GlyphFont;
  fontSizeMm: number;
  /** 字与字之间的间隙（mm），用于推导格心间距 */
  gapMm?: number;
  /** 直接指定相邻格心间距（mm），优先于 fontSizeMm + gapMm */
  cellStepMm?: number;
  /** 章面中心（mm） */
  centerMm?: Vec2;
  toleranceMm?: number;
}

export type HuiwenSlot = '右上' | '右下' | '左上' | '左下';

export interface HuiwenCharPos {
  char: string;
  slot: HuiwenSlot;
  x: number;
  y: number;
}

export interface HuiwenResult {
  polygons: Polygon2D[];
  positions: HuiwenCharPos[];
  /** 是否正好四个字（多于四个只取前四个，少于四个按序占位） */
  isFour: boolean;
}

/** 四字回文读序对应的列/行符号：col>0=右，row>0=上 */
const SLOTS: { slot: HuiwenSlot; sx: 1 | -1; sy: 1 | -1 }[] = [
  { slot: '右上', sx: 1, sy: 1 },
  { slot: '右下', sx: 1, sy: -1 },
  { slot: '左上', sx: -1, sy: 1 },
  { slot: '左下', sx: -1, sy: -1 },
];

export function huiwenTextPolygons(p: HuiwenParams): HuiwenResult {
  const all = Array.from(p.text).filter((c) => c.trim() !== '');
  const chars = all.slice(0, 4);
  const center = p.centerMm ?? { x: 0, y: 0 };
  const step = p.cellStepMm ?? p.fontSizeMm + Math.max(0, p.gapMm ?? 0);
  const d = step / 2;

  const polygons: Polygon2D[] = [];
  const positions: HuiwenCharPos[] = [];

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const slot = SLOTS[i];
    const px = center.x + slot.sx * d;
    const py = center.y + slot.sy * d;

    const glyph = p.font.charToGlyph(ch);
    const gp = glyphToPolygons(glyph, p.fontSizeMm, { toleranceMm: p.toleranceMm });
    if (gp.length > 0) {
      const centered = centerPolygons(gp);
      polygons.push(...transformPolygons(centered, { dx: px, dy: py }));
    }
    positions.push({ char: ch, slot: slot.slot, x: px, y: py });
  }

  return { polygons, positions, isFour: all.length === 4 };
}

/** 便捷：只取多边形 */
export function huiwenPolygons(p: HuiwenParams): Polygon2D[] {
  return huiwenTextPolygons(p).polygons;
}
