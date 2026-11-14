/**
 * 把各图层的 layout 输出收集成几何层要的多边形列表。
 * layout 输出 { points: Vec2[] }，几何层要 { outer, holes }，中间由 polygon-bridge 归组。
 */
import { ensureFont, resolveFontId } from '../layout/fonts.ts';
import { textToPolygons, verticalTextToPolygons, type GlyphFont } from '../layout/text.ts';
import { ringTextPolygons } from '../layout/ring.ts';
import { huiwenTextPolygons } from '../layout/huiwen.ts';
import { defaultOrnamentSizeMm, ornamentRings } from '../layout/ornaments.ts';
import { fromLayoutPolygons } from './polygon-bridge.ts';
import type { Layer, SealSpec, TextLayer } from './spec.ts';
import type { Polygon2D as GeomPolygon } from '../geometry/types.ts';

export interface LayoutPolygon {
  points: { x: number; y: number }[];
  /**
   * 这圈轮廓属于哪个图层。几何侧要按层做重叠/出界诊断时靠它分组；
   * 2D 渲染不需要，可忽略。
   */
  layerId?: string;
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

/** 章面形状：内置主体里 column 是方章，其余三个（常见样式/圆柱/石墩）都是圆章。 */
function faceShapeOf(spec: SealSpec): { shape: 'square' | 'circle' | 'polygon'; sides: number } {
  const id = spec.body.styleId;
  if (id) return { shape: id === 'column' ? 'square' : 'circle', sides: spec.body.sides };
  return { shape: spec.body.shape, sides: spec.body.sides };
}

/**
 * 章面可用尺寸（mm）。语义：`sizeMm` 对正方形是**边长**、对圆形是**直径**、
 * 对正多边形是**外接圆直径**。
 *
 * 圆章不能按直径留边：文字占一条高 `bandMm` 的横带，能用的宽度是那条弦
 * `2√(R²-(band/2)²)`，比直径窄；多边形同理用内切圆。留边 = 边框内缩 + 线宽
 * + 一条笔画宽的 clearance（实测最外笔画离边框只剩 0.15mm 就是漏了这一条）。
 */
function fitBoxMm(spec: SealSpec, bandMm: number): { w: number; h: number } {
  const b = spec.body;
  const { shape, sides } = faceShapeOf(spec);
  const clearance = Math.max(0.3, spec.print?.minStrokeMm ?? 0.4);
  const margin = Math.max(b.border.insetMm + b.border.widthMm, b.sizeMm * 0.06) + clearance;
  const size = b.sizeMm;

  let usableW: number;
  let usableH: number;
  if (shape === 'square') {
    usableW = size - margin * 2;
    usableH = size - margin * 2;
  } else if (shape === 'circle') {
    const R = size / 2;
    const half = Math.min(R * 0.95, Math.max(bandMm, 1) / 2);
    usableW = 2 * Math.sqrt(Math.max(0, R * R - half * half)) - margin * 2;
    usableH = R * 1.7 - margin * 2;
  } else {
    const inR = (size / 2) * Math.cos(Math.PI / Math.max(3, sides)); // 内切圆半径
    usableW = inR * 2 - margin * 2;
    usableH = inR * 2 - margin * 2;
  }
  return { w: Math.max(4, usableW), h: Math.max(4, usableH) };
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
    // 换行上限：按当前字号估一条文字带的高度，先问 fit 箱子要宽度/高度，
    // 超了就在版式层折行（而不是一路缩到看不清）
    const band = fontSizeMm * (layer.lineHeight || 1.15);
    const box = fitBoxMm(spec, band);
    const lineHeight = layer.lineHeight || 1.15;

    switch (layer.layout) {
      case 'vertical':
        return verticalTextToPolygons({
          ...base,
          maxHeightMm: box.h,
          lineHeight,
        }) as unknown as LayoutPolygon[];
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
        const rings = res.polygons as unknown as LayoutPolygon[];
        // 中心图案：纯几何环，当普通图案并进去（阴刻即刻掉）
        const orn = layer.ringOrnament ?? 'none';
        if (orn === 'none') return rings;
        const sizeMm = layer.ringOrnamentSizeMm ?? defaultOrnamentSizeMm(spec.body.sizeMm);
        const ornRings = ornamentRings(orn, { sizeMm, centerMm });
        return [...rings, ...ornRings.map((r) => ({ points: r.map((p) => ({ x: p.x, y: p.y })) }))];
      }
      case 'horizontal':
      default:
        return textToPolygons({
          ...base,
          maxWidthMm: box.w,
          lineHeight,
        }) as unknown as LayoutPolygon[];
    }
  };

  const requested = layer.fontSizeMm;
  /** 伪斜体：整层按 12° 斜切（字体文件里没有 Italic 也能斜） */
  const shear = (polys: LayoutPolygon[]): LayoutPolygon[] => {
    if (layer.italic !== true) return polys;
    const k = Math.tan((12 * Math.PI) / 180);
    return polys.map((p) => ({
      ...p,
      points: p.points.map((q) => ({ x: q.x + k * q.y, y: q.y })),
    }));
  };
  // 斜切放在量包围盒之前，自动适应才算得准
  const first = shear(build(requested, layer.letterSpacingMm));
  const makeFit = (fitted: boolean, effectiveFontMm: number): LayerFit => ({
    layerId: layer.id,
    requestedFontMm: requested,
    effectiveFontMm,
    fitted,
  });

  if (layer.autoFit === false || layer.layout === 'ring') return { polygons: first, fit: makeFit(false, requested) };

  const m = measure(first);
  // 圆章可用宽度取决于文字横带的高度，所以拿实测高度算弦长，再乘比例
  const box = fitBoxMm(spec, m.h);
  const k = Math.min(1, box.w > 0 && m.w > 0 ? box.w / m.w : 1, box.h > 0 && m.h > 0 ? box.h / m.h : 1);
  if (k >= 0.995) return { polygons: first, fit: makeFit(false, requested) };

  // 等比缩字号与字距：两者同时乘 k，包围盒也正好缩到 k 倍
  const effective = Math.round(requested * k * 100) / 100;
  return {
    polygons: shear(build(effective, layer.letterSpacingMm * k)),
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
    // 打上图层 id：worker 按它分组，文字图层之间的重叠才检得出来
    polygons.push(...polys.map((p) => ({ ...p, layerId: layer.id })));
    fits.push(fit);
  }
  return { polygons, fits };
}

/** 所有文字图层 → 几何层多边形（外环 CCW / 内孔 CW，嵌套结构） */
export async function layoutToGeometryPolygons(spec: SealSpec): Promise<GeomPolygon[]> {
  return fromLayoutPolygons(await layoutFlatPolygons(spec));
}
