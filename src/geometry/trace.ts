/**
 * 图像描摹：ImageData → 二值掩膜 → 轮廓 → 简化 → 闭运算 → Polygon2D[]。
 *
 * 全流程纯 JS（内置边界追踪），Node 里也能跑，浏览器里走同一条代码路径。
 * 不走 potrace：GPLv2 会传染静态站分发许可，且曲线拟合对 FDM 精度没有收益。
 *
 * 注意：不是"高度图浮雕"——那条路会把相邻笔画糊成一片，印章用不了。
 *
 * 阈值有两种来源：
 *   - 手动：`threshold`（0~1），像素灰度 < threshold*255 判为墨
 *   - 自动：`autoThreshold: true` 时用 Otsu 找双峰之间那个谷底，忽略 `threshold`
 *     （背景有渐变/曝光不均的图，手动阈值差 0.15 面积就能差 2.5 倍，必须自动）
 */

import { groupContours, simplifyContour } from './polygon.ts';
import { prepareSection, fromCrossSection, getManifold, sectionFromPolygons } from './crosssection.ts';
import type { ImageLayer } from '../core/spec.ts';
import type { Polygon2D, Vec2 } from './types.ts';

/** 与 DOM 的 ImageData 兼容的最小结构（Node 里传普通对象即可）。 */
export interface ImageDataLike {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

export interface TraceOptions {
  /** Otsu 自动阈值；true 时忽略 `threshold`。默认 false。 */
  autoThreshold?: boolean;
  /** 0~1，默认 0.5。autoThreshold 为 true 时只在 Otsu 不可靠时兜底。 */
  threshold?: number;
  /** 反相：深色背景上的浅色图案时打开。 */
  invert?: boolean;
  /** 1 像素对应多少 mm，默认 1（即按像素当 mm 用，调用方自己给缩放）。 */
  mmPerPx?: number;
  /** 简化容差（mm），默认 0.08。 */
  simplifyMm?: number;
  /** 最小笔画（mm），默认 0（不修正；FDM 建议 0.4）。 */
  minStrokeMm?: number;
  /** 最小间隙（mm），默认同 minStroke。 */
  minGapMm?: number;
  /** 去噪：面积小于该值（mm²）的孤岛直接丢掉，默认 0.2。 */
  despeckleAreaMm2?: number;
}

/** Otsu 的结果，给 UI 提示与验收用。 */
export interface OtsuResult {
  /** 归一化阈值 0~1（灰度 < threshold*255 判为墨）。 */
  threshold: number;
  /** 组间方差占总方差的比例（0~1）：越大越"双峰"，阈值越可信。 */
  eta: number;
  /** 判定为墨的像素占比。 */
  inkFraction: number;
  /** 未参与统计的透明像素占比。 */
  transparentFraction: number;
  /** eta/占比都在合理区间才算可靠；不可靠时退回手动阈值。 */
  reliable: boolean;
}

/** 最近一次 traceImageData 的统计，便于日志、UI 提示与验收。 */
export interface TraceStats {
  /** 实际用到的阈值（Otsu 或手动）。 */
  thresholdUsed: number;
  /** 调用方是否要求了自动阈值。 */
  autoRequested: boolean;
  /** autoRequested 时 Otsu 的结果；否则 null。 */
  otsu: OtsuResult | null;
  /** 掩膜里墨像素占比。 */
  inkFraction: number;
  /** 边界追踪出的原始环数。 */
  loops: number;
  /** 简化后、去噪前的轮廓数。 */
  contours: number;
  /** 被 despeckleAreaMm2 丢掉的轮廓面积（mm²，升序）——决定阈值别调大过最小那批。 */
  droppedAreasMm2: number[];
  /** 保留的轮廓面积（mm²，升序）。 */
  keptAreasMm2: number[];
  polygons: number;
  holes: number;
  points: number;
}

let lastStats: TraceStats | null = null;

/** 最近一次 traceImageData 的统计（同步读取，给 UI/脚本看）。 */
export function lastTraceStats(): TraceStats | null {
  return lastStats;
}

/** 灰度（Rec.601，和浏览器 canvas 转灰度的常用系数一致）。 */
function grayAt(data: ArrayLike<number>, p: number): number {
  const r = data[p]!;
  const g = data[p + 1] ?? r;
  const b = data[p + 2] ?? r;
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/* ------------------------------------------------------------------ */
/* 位图 → 掩膜                                                         */
/* ------------------------------------------------------------------ */

/** 灰度 + 阈值 → 二值掩膜（1 = 墨/实心）。 */
export function buildMask(image: ImageDataLike, threshold = 0.5, invert = false): Uint8Array {
  const { data, width, height } = image;
  const mask = new Uint8Array(width * height);
  const cut = Math.round(Math.max(0, Math.min(1, threshold)) * 255);
  for (let i = 0, p = 0; i < width * height; i++, p += 4) {
    const alpha = data[p + 3];
    if (alpha !== undefined && alpha < 128) {
      mask[i] = 0;
      continue;
    }
    const gray = grayAt(data, p);
    const ink = invert ? gray >= cut : gray < cut;
    mask[i] = ink ? 1 : 0;
  }
  return mask;
}

/* ------------------------------------------------------------------ */
/* Otsu 自动阈值                                                       */
/* ------------------------------------------------------------------ */

/**
 * Otsu 大津法：在 256 级灰度直方图上找让「类间方差 / 总方差」最大的切点。
 *
 * 对背景有渐变、曝光不均的图，手动阈值是碰运气（实测同一张剪影 0.35→404.8mm²、
 * 0.65→1025.4mm²），Otsu 把切点放在两个灰度簇的谷底，面积就稳住了。
 *
 * 透明像素（alpha < 128）不参与统计——它们在掩膜里恒为背景。
 */
export function otsuThreshold(image: ImageDataLike): OtsuResult {
  const { data, width, height } = image;
  const total = width * height;
  const hist = new Float64Array(256);
  let opaque = 0;

  for (let i = 0, p = 0; i < total; i++, p += 4) {
    const alpha = data[p + 3];
    if (alpha !== undefined && alpha < 128) continue;
    hist[Math.round(grayAt(data, p))]!++;
    opaque++;
  }

  const transparentFraction = total === 0 ? 0 : 1 - opaque / total;
  if (opaque === 0) {
    return { threshold: 0.5, eta: 0, inkFraction: 0, transparentFraction, reliable: false };
  }

  // 概率直方图
  for (let i = 0; i < 256; i++) hist[i]! /= opaque;

  let muTotal = 0;
  for (let i = 0; i < 256; i++) muTotal += i * hist[i]!;

  let w0 = 0;
  let sum0 = 0;
  let bestBetween = 0;
  // 双尖峰二值图（只有 0 和 255）在 t=0..254 上类间方差完全相等，取第一个最大值会
  // 把阈值压到 0，带灰边的抗锯齿线稿就被削瘦。所以记住等值区间，最后取中点。
  let tieFrom = -1;
  let tieTo = -1;
  for (let t = 0; t < 255; t++) {
    w0 += hist[t]!;
    sum0 += t * hist[t]!;
    const w1 = 1 - w0;
    if (w0 <= 0 || w1 <= 0) continue;
    const mu0 = sum0 / w0;
    const mu1 = (muTotal - sum0) / w1;
    const between = w0 * w1 * (mu0 - mu1) * (mu0 - mu1);
    const eps = bestBetween * 1e-9 + 1e-12;
    if (between > bestBetween + eps) {
      bestBetween = between;
      tieFrom = t;
      tieTo = t;
    } else if (between >= bestBetween - eps) {
      tieTo = t;
    }
  }

  let variance = 0;
  for (let i = 0; i < 256; i++) {
    const d = i - muTotal;
    variance += d * d * hist[i]!;
  }

  const eta = variance > 0 ? bestBetween / variance : 0;
  // 类 0 = [0..t] 判为墨；掩膜用 gray < cut，故 cut = t + 1。等值时取区间中点。
  const cut = tieFrom < 0 ? 128 : Math.round((tieFrom + tieTo) / 2) + 1;
  let inkFraction = 0;
  for (let i = 0; i < cut; i++) inkFraction += hist[i]!;
  const reliable = eta >= 0.15 && inkFraction > 0.0005 && inkFraction < 0.9995;

  return {
    threshold: Math.min(1, cut / 255),
    eta: Math.round(eta * 1000) / 1000,
    inkFraction: Math.round(inkFraction * 10000) / 10000,
    transparentFraction: Math.round(transparentFraction * 10000) / 10000,
    reliable,
  };
}

/* ------------------------------------------------------------------ */
/* 内置边界追踪                                                        */
/* ------------------------------------------------------------------ */

/**
 * 把二值掩膜的外边界连成闭合折线（像素坐标，1 像素 = 1 单位）。
 *
 * 做法：对每个"墨像素与空像素之间"的格子边建线段，再沿端点把线段串成环。
 * 二值图里每个顶点恰好有两条边界边，所以串环是确定的；遇到退化图（对角
 * 相接）时按 4 连通处理，保证不会串错环。
 */
export function traceMask(mask: Uint8Array, width: number, height: number): Vec2[][] {
  const at = (x: number, y: number): number =>
    x < 0 || y < 0 || x >= width || y >= height ? 0 : (mask[y * width + x] ?? 0);

  type Edge = [number, number, number, number];
  const edges: Edge[] = [];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (at(x, y) === 0) continue;
      if (at(x, y - 1) === 0) edges.push([x, y, x + 1, y]);
      if (at(x + 1, y) === 0) edges.push([x + 1, y, x + 1, y + 1]);
      if (at(x, y + 1) === 0) edges.push([x + 1, y + 1, x, y + 1]);
      if (at(x - 1, y) === 0) edges.push([x, y + 1, x, y]);
    }
  }

  const key = (x: number, y: number): string => `${x},${y}`;
  const from = new Map<string, Edge[]>();
  for (const edge of edges) {
    const k = key(edge[0], edge[1]);
    const list = from.get(k);
    if (list === undefined) from.set(k, [edge]);
    else list.push(edge);
  }

  const used = new Set<Edge>();
  const loops: Vec2[][] = [];

  for (const start of edges) {
    if (used.has(start)) continue;
    const loop: Vec2[] = [];
    let current: Edge | undefined = start;
    let guard = 0;
    while (current !== undefined && !used.has(current) && guard++ < edges.length + 4) {
      used.add(current);
      loop.push([current[0], current[1]]);
      const nextList = from.get(key(current[2], current[3]));
      current = nextList?.find((candidate) => !used.has(candidate));
    }
    if (loop.length >= 4) loops.push(loop);
  }
  return loops;
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

/**
 * 图像 → 多边形。
 *
 * 产出的环已归一化（外环 CCW、内孔 CW），单位 mm，原点在图像中心。
 * 统计落在 `lastTraceStats()`。
 */
export async function traceImageData(image: ImageDataLike, options: TraceOptions = {}): Promise<Polygon2D[]> {
  const mmPerPx = options.mmPerPx ?? 1;
  const simplifyMm = options.simplifyMm ?? 0.08;
  const invert = options.invert ?? false;
  const manual = Math.max(0, Math.min(1, options.threshold ?? 0.5));

  const autoRequested = options.autoThreshold === true;
  const otsu = autoRequested ? otsuThreshold(image) : null;
  // Otsu 不可靠（单峰图、几乎全墨/全空）时退回手动值，别把整张图判成一片
  const threshold = otsu !== null && otsu.reliable ? otsu.threshold : manual;

  const mask = buildMask(image, threshold, invert);

  let ink = 0;
  for (let i = 0; i < mask.length; i++) ink += mask[i]!;

  const loops = traceMask(mask, image.width, image.height);

  // 像素坐标 → mm，原点移到图像中心。
  // y 取反后环方向会整体反转（像素系 CCW → mm 系 CW），必须 reverse 回来，
  // 否则 groupContours 会把所有外环当孔，产出空数组。
  const halfW = image.width / 2;
  const halfH = image.height / 2;
  const contours: Vec2[][] = loops.map((loop) =>
    loop
      .map(([x, y]) => [(x - halfW) * mmPerPx, (halfH - y) * mmPerPx] as Vec2)
      .reverse(),
  );

  const simplified = contours
    .map((contour) => simplifyContour(contour, simplifyMm))
    .filter((contour) => contour.length >= 3);

  // 去噪：按面积过滤小岛（先按 mm 面积粗筛，再用布尔闭运算兜底）
  const minArea = options.despeckleAreaMm2 ?? 0.2;
  const kept: Vec2[][] = [];
  const droppedAreas: number[] = [];
  const keptAreas: number[] = [];
  for (const contour of simplified) {
    const area = Math.abs(shoelace(contour));
    if (area >= minArea) {
      kept.push(contour);
      keptAreas.push(area);
    } else {
      droppedAreas.push(area);
    }
  }

  let polygons = groupContours(kept);

  const minStroke = options.minStrokeMm ?? 0;
  if (minStroke > 0 && polygons.length > 0) {
    const kit = await getManifold();
    const section = await prepareSection(polygons, {
      minStrokeMm: minStroke,
      minGapMm: options.minGapMm ?? minStroke,
      simplifyMm,
    });
    polygons = fromCrossSection(kit, section);
    section.delete();
  }

  const round = (value: number): number => Math.round(value * 10000) / 10000;
  lastStats = {
    thresholdUsed: Math.round(threshold * 1000) / 1000,
    autoRequested,
    otsu,
    inkFraction: mask.length === 0 ? 0 : round(ink / mask.length),
    loops: loops.length,
    contours: simplified.length,
    droppedAreasMm2: droppedAreas.map((area) => round(area)).sort((a, b) => a - b),
    keptAreasMm2: keptAreas.map((area) => round(area)).sort((a, b) => a - b),
    polygons: polygons.length,
    holes: polygons.reduce((sum, polygon) => sum + polygon.holes.length, 0),
    points: polygons.reduce(
      (sum, polygon) => sum + polygon.outer.length + polygon.holes.reduce((s, hole) => s + hole.length, 0),
      0,
    ),
  };

  // 空结果必须显式报错，不能静默返回空数组让用户拿到一枚空章
  if (polygons.length === 0) {
    throw new TraceEmptyError(emptySuggestion(lastStats, { threshold, despeckleAreaMm2: minArea }), lastStats);
  }

  return polygons;
}

function shoelace(contour: Vec2[]): number {
  let sum = 0;
  for (let i = 0; i < contour.length; i++) {
    const a = contour[i]!;
    const b = contour[(i + 1) % contour.length]!;
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return sum / 2;
}

/* ------------------------------------------------------------------ */
/* 图层接入：ImageLayer + 位图 → 章面坐标下的 Polygon2D[]              */
/* ------------------------------------------------------------------ */

/** 描摹结果为空：带用户可执行的阈值建议，不让空章静默通过。 */
export class TraceEmptyError extends Error {
  readonly code = 'TRACE_EMPTY';
  readonly suggestion: string;
  readonly stats: TraceStats | null;

  constructor(suggestion: string, stats: TraceStats | null) {
    super(`图像描摹结果为空。${suggestion}`);
    this.name = 'TraceEmptyError';
    this.suggestion = suggestion;
    this.stats = stats;
  }
}

export interface LayerPlacement {
  /** 章面尺寸（mm），用来把图片按比例缩进章面。 */
  bodySizeMm: number;
  /** 轮廓模式下的线宽（mm），默认 0.6。 */
  outlineWidthMm?: number;
  /** 描摹模式：silhouette（实心，默认）或 outline（实心转等宽环）。 */
  mode?: 'silhouette' | 'outline';
}

function emptySuggestion(stats: TraceStats | null, cfg: { threshold: number; despeckleAreaMm2: number }): string {
  const manual = cfg.threshold;
  if (stats === null) return '图像没有产生任何轮廓：检查图片是否透明，或是否整张纯白/纯黑。';
  if (stats.inkFraction < 0.001) {
    return `阈值 ${stats.thresholdUsed} 把整张图判成了背景：降低阈值（如 ${Math.max(0, manual - 0.15).toFixed(2)}）或勾选「反相」。`;
  }
  if (stats.inkFraction > 0.99) {
    return `阈值 ${stats.thresholdUsed} 把整张图判成了墨：提高阈值（如 ${Math.min(1, manual + 0.15).toFixed(2)}）或勾选「反相」。`;
  }
  if (stats.keptAreasMm2.length === 0 && stats.droppedAreasMm2.length > 0) {
    return `所有轮廓都被去噪阈值 ${cfg.despeckleAreaMm2}mm² 丢掉了：调小去噪面积或提高图片分辨率。`;
  }
  return '没有可描摹的闭合轮廓：换一张对比度更高的图，或改用「轮廓」模式。';
}

/**
 * ImageLayer + 位图 → 章面坐标下的 Polygon2D[]。
 *
 * - 缩放：物理宽度 = layer.widthMm × layer.transform.scale（mm/px 由它和像素宽度推出）
 * - 位置/旋转：先绕图像中心旋转，再按 anchor（-1~1，相对章面半径）平移
 * - mode='outline'：实心块转成等宽闭环线（印章里常见的「线框图案」）
 * - 空结果抛 TraceEmptyError（code=TRACE_EMPTY），message 里直接带建议
 */
export async function traceLayer(
  layer: ImageLayer,
  image: ImageDataLike,
  placement: LayerPlacement,
): Promise<Polygon2D[]> {
  const widthPx = image.width || 1;
  const scale = layer.transform.scale > 0 ? layer.transform.scale : 1;
  const widthMm = layer.widthMm > 0 ? layer.widthMm : Math.max(1, placement.bodySizeMm * 0.6);
  const mmPerPx = (widthMm * scale) / widthPx;

  let polygons = await traceImageData(image, {
    autoThreshold: layer.trace.autoThreshold,
    threshold: layer.trace.threshold,
    invert: layer.trace.invert,
    despeckleAreaMm2: layer.trace.despeckleAreaMm2,
    simplifyMm: layer.trace.simplifyMm,
    mmPerPx,
    // 最小笔画/间隙统一由 pipeline 的 prepareSection 处理，这里不重复做
    minStrokeMm: 0,
  });

  if (polygons.length > 0 && (placement.mode ?? 'silhouette') === 'outline') {
    polygons = await toOutline(polygons, placement.outlineWidthMm ?? 0.6);
  }

  const rad = (layer.transform.rotateDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = (layer.anchor.x * placement.bodySizeMm) / 2;
  const dy = (layer.anchor.y * placement.bodySizeMm) / 2;
  const place = (contour: Vec2): Vec2 =>
    [contour[0] * cos - contour[1] * sin + dx, contour[0] * sin + contour[1] * cos + dy];

  const placed: Polygon2D[] = polygons.map((polygon) => ({
    outer: polygon.outer.map(place),
    holes: polygon.holes.map((hole) => hole.map(place)),
  }));

  if (placed.length === 0) {
    throw new TraceEmptyError(emptySuggestion(lastStats, { threshold: layer.trace.threshold, despeckleAreaMm2: layer.trace.despeckleAreaMm2 }), lastStats);
  }
  return placed;
}

/** 实心 → 等宽闭环线：ring = 形状 − 内缩(width)。 */
async function toOutline(polygons: Polygon2D[], widthMm: number): Promise<Polygon2D[]> {
  const kit = await getManifold();
  const section = await sectionFromPolygons(polygons);
  const inset = section.offset(-Math.max(0.1, widthMm), 'Round', 2, 16);
  const ring = section.subtract(inset);
  const result = fromCrossSection(kit, ring);
  section.delete();
  inset.delete();
  ring.delete();
  return result;
}

/**
 * 合并文字图层与图像图层的多边形。
 *
 * 这里只做**扁平化**：真正的布尔并集在 pipeline.prepareSection 里一次完成，
 * 避免同一份几何被 union 两遍。调用方把各层结果拼起来传进 buildSeal 即可。
 */
export function combinePolygons(...groups: readonly Polygon2D[][]): Polygon2D[] {
  const out: Polygon2D[] = [];
  for (const group of groups) {
    for (const polygon of group) {
      if (polygon.outer.length >= 3) out.push(polygon);
    }
  }
  return out;
}
