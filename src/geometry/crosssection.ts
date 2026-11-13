/**
 * manifold-3d 的二维截面封装。
 *
 * 所有轮廓进入这里之前都应该是「外环 CCW、内孔 CW」，单位 mm。
 * 这一层负责：构造 CrossSection、并集、offset、形态学闭运算（最小笔画下限 /
 * 最小间隙下限），以及把结果读回 Polygon2D。
 */

import Module from 'manifold-3d';
import type { ManifoldToplevel, Polygons, SimplePolygon, Vec2 as MVec2 } from 'manifold-3d';
import { closing, offset as offsetSection, segmentsFor } from './morphology.ts';
import { measureMinGapRaster, measureMinStrokeRaster } from './raster.ts';
import { groupContours, normalizePolygons, signedArea } from './polygon.ts';
import type { Contour, Polygon2D, Vec2 } from './types.ts';

export type ManifoldKit = ManifoldToplevel;

let kitPromise: Promise<ManifoldKit> | null = null;

/** 懒加载并复用同一个 wasm 实例。 */
export function getManifold(): Promise<ManifoldKit> {
  if (kitPromise === null) kitPromise = loadKit();
  return kitPromise;
}

async function loadKit(): Promise<ManifoldKit> {
  const factory = Module as unknown as (config?: {
    wasmBinary?: Uint8Array;
    locateFile?: (path: string) => string;
  }) => Promise<ManifoldKit>;

  // 浏览器 / Worker / Node 三种环境：只有前者需要自己把 wasm 喂进去
  const inBrowser =
    typeof document !== 'undefined' ||
    typeof WorkerGlobalScope !== 'undefined' ||
    (typeof self !== 'undefined' && typeof (self as unknown as { postMessage?: unknown }).postMessage === 'function');

  const config: { wasmBinary?: Uint8Array; locateFile?: (path: string) => string } = {};

  if (inBrowser) {
    // 优先自己 fetch 再喂 wasmBinary：不依赖 Emscripten 的路径推断。
    // 模块 Worker 里没有 importScripts，glue 的环境判定会全部落空，
    // 直接表现就是 Module() 永不 settle（不报错也不 resolve）。
    try {
      const { loadManifoldWasmBinary, wasmUrl } = await import('./wasm-asset.ts');
      const binary = await withTimeout(loadManifoldWasmBinary(), 10_000, `manifold.wasm 预取超时：${wasmUrl}`);
      if (binary !== null) {
        config.wasmBinary = binary;
        console.info('[geometry] manifold.wasm 预取完成', wasmUrl, binary.byteLength, 'bytes');
      }
    } catch (error) {
      // 预取失败就退回 locateFile，至少还有一次机会
      console.warn('[geometry] wasm 预取失败，回退 locateFile', error);
      try {
        const asset = await import('./wasm-asset.ts');
        config.locateFile = () => asset.wasmUrl;
      } catch {
        /* 两条都不通就交给 Module() 自己报错 */
      }
    }
  }

  const kit = await withTimeout(
    factory(config),
    25_000,
    'manifold 初始化超时：wasm 已下载但实例化未完成（可能是 Worker 环境判定或内存问题）',
  );
  kit.setup();
  return kit;
}

/** 给可能永远不 settle 的 Promise 加超时，避免 Worker 里静默挂死。 */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/* ------------------------------------------------------------------ */
/* 转换                                                                */
/* ------------------------------------------------------------------ */

export function toManifoldPolygons(polygons: readonly Polygon2D[]): SimplePolygon[] {
  const out: SimplePolygon[] = [];
  for (const polygon of polygons) {
    if (polygon.outer.length >= 3) out.push(toSimple(polygon.outer));
    for (const hole of polygon.holes) {
      if (hole.length >= 3) out.push(toSimple(hole));
    }
  }
  return out;
}

function toSimple(contour: Contour): SimplePolygon {
  return contour.map(([x, y]) => [x, y] as MVec2);
}

function fromSimple(polygon: SimplePolygon): Contour {
  return polygon.map(([x, y]) => [x, y] as Vec2);
}

/** 从 CrossSection 读回 Polygon2D[]，并按环方向重新分组。 */
export function fromCrossSection(_kit: ManifoldKit, section: InstanceType<ManifoldKit['CrossSection']>): Polygon2D[] {
  const raw = section.toPolygons();
  const contours = raw.map(fromSimple).filter((c) => c.length >= 3);
  if (contours.length === 0) return [];

  // Clipper2 依填充规则可能整体给出相反方向：以净面积为羊，必要时整体翻转
  const net = contours.reduce((sum, c) => sum + signedArea(c), 0);
  const oriented = net < 0 ? contours.map((c) => c.slice().reverse()) : contours;
  return groupContours(oriented);
}

/**
 * 轮廓集合 → CrossSection（构造时自带一次并集，顺带修复自交与重叠）。
 *
 * 关键：**保留每条轮廓的原始环方向**，用 NonZero 填充规则。
 * 之前这里把所有轮廓翻成 CCW 再用 'Positive'，孔也被算成正向 → 孔被填实
 * （20×20 挖 10×10 孔：正确面积 300，翻向后面变成 400）。篆书轮廓最容易走到这里。
 */
export async function sectionFromContours(contours: readonly Contour[]): Promise<InstanceType<ManifoldKit['CrossSection']>> {
  const kit = await getManifold();
  const polygons: SimplePolygon[] = contours
    .filter((c) => c.length >= 3)
    .map((c) => toSimple(c));
  return new kit.CrossSection(polygons, 'NonZero');
}

/** Polygon2D[] → CrossSection（进入前统一归一化，保证外环 CCW / 内孔 CW）。 */
export async function sectionFromPolygons(polygons: readonly Polygon2D[]): Promise<InstanceType<ManifoldKit['CrossSection']>> {
  const kit = await getManifold();
  const normalized = normalizePolygons(polygons);
  return new kit.CrossSection(toManifoldPolygons(normalized) as Polygons, 'NonZero');
}

/**
 * SelfUnion 实现：把可能自交/重叠的一组轮廓做二维布尔并集。
 * 供 polygon.repairSelfIntersections 注入使用。
 */
export async function unionContours(contours: readonly Contour[]): Promise<Contour[]> {
  const kit = await getManifold();
  const section = await sectionFromContours(contours);
  const result = fromCrossSection(kit, section);
  section.delete();
  return result.flatMap((p) => [p.outer, ...p.holes]);
}

/* ------------------------------------------------------------------ */
/* 运算                                                                */
/* ------------------------------------------------------------------ */

/** 圆角半径对应的圆分段数（转出到 morphology，保持旧引用可用）。 */
export { segmentsFor };

/**
 * 形态学闭运算：先膨胀后腐蚀，焊死窄于 2r 的缝隙。
 *
 * 注意：闭运算**不会加粗笔画**——它只填缝、补断口、封小孔。
 * 笔画下限要靠 offset 外扩（见 prepareSection 的第二步）。
 */
export function morphologicalClose(
  _kit: ManifoldKit,
  section: InstanceType<ManifoldKit['CrossSection']>,
  minStrokeMm: number,
  minGapMm = minStrokeMm,
): InstanceType<ManifoldKit['CrossSection']> {
  const radius = Math.max(minStrokeMm, minGapMm) / 2;
  if (radius <= 0) return section;
  return closing(section, radius);
}

/** 外扩 / 内缩（正数外扩）。 */
export function inflate(
  _kit: ManifoldKit,
  section: InstanceType<ManifoldKit['CrossSection']>,
  deltaMm: number,
): InstanceType<ManifoldKit['CrossSection']> {
  return offsetSection(section, deltaMm);
}

/** 批量并集。 */
export async function unionSections(
  sections: readonly Promise<InstanceType<ManifoldKit['CrossSection']>>[] | readonly InstanceType<ManifoldKit['CrossSection']>[],
): Promise<InstanceType<ManifoldKit['CrossSection']>> {
  const kit = await getManifold();
  const resolved = await Promise.all(sections as Promise<InstanceType<ManifoldKit['CrossSection']>>[]);
  if (resolved.length === 0) return new kit.CrossSection([] as Polygons, 'Positive');
  let acc = resolved[0]!;
  for (let i = 1; i < resolved.length; i++) {
    const next = acc.add(resolved[i]!);
    if (acc !== resolved[0]) acc.delete();
    acc = next;
  }
  return acc;
}

/** prepareSection 的加工记录：解释「哪些参数真的动了几何」。 */
export interface PrepareReport {
  /** 实测最小笔画宽 mm；null 表示 ≥ minStrokeMm（未做全量测量）。 */
  minStrokeWidthMm: number | null;
  /** 实测最小间隙 mm；null 表示 ≥ minGapMm。 */
  minGapWidthMm: number | null;
  /** 为达最小笔画下限而整体外扩的量 mm（0 表示未外扩）。 */
  thickenedMm: number;
  /** 闭运算焊掉的缝隙总面积 mm²（>0 表示有窄缝被合并）。 */
  weldedGapAreaMm2: number;
  /** 简化容差 mm。 */
  simplifyMm: number;
  notes: string[];
}

export interface PrepareOptions {
  minStrokeMm?: number;
  minGapMm?: number;
  simplifyMm?: number;
}

/**
 * 把多边形集合整理成"可直接挤出"的截面。
 *
 * **minStroke 与 minGap 是两条独立约束，落地方式不同**：
 *   1. `minGapMm` → 闭运算 `closing(minGap/2)`：把窄于 minGap 的缝隙/小孔直接焊死。
 *      间隙不能靠"缩小笔画"实现（内缩 0.2mm 实测掉 46% 细笔画），只能让它们合并。
 *   2. `minStrokeMm` → 先测量最细笔画 w，若 w < minStroke 再整体 `offset((minStroke−w)/2)`。
 *      只在真的违规时才加粗，正常字体不会被平白变粗。
 *   3. 外扩会吃掉间隙 → 再闭一次保证 minGap 成立；这次闭掉的部分记入报告，
 *      由 printability 生成「笔画被合并」提示，不静默破坏字形。
 *
 * 顺序固定：闭（保间隙）→ 测最细笔画 → 胀（保笔画）→ 再闭 → 简化。
 */
export async function prepareSection(
  polygons: readonly Polygon2D[],
  options: PrepareOptions = {},
): Promise<InstanceType<ManifoldKit['CrossSection']>> {
  const result = await prepareSectionWithReport(polygons, options);
  return result.section;
}

export async function prepareSectionWithReport(
  polygons: readonly Polygon2D[],
  options: PrepareOptions = {},
): Promise<{ section: InstanceType<ManifoldKit['CrossSection']>; report: PrepareReport }> {
  const minStrokeMm = options.minStrokeMm ?? 0;
  const minGapMm = options.minGapMm ?? 0;
  const simplifyMm = options.simplifyMm ?? 0.02;

  const report: PrepareReport = {
    minStrokeWidthMm: null,
    minGapWidthMm: null,
    thickenedMm: 0,
    weldedGapAreaMm2: 0,
    simplifyMm,
    notes: [],
  };

  let section = await sectionFromPolygons(polygons);
  const areaOf = (s: InstanceType<ManifoldKit['CrossSection']>): number => (s.isEmpty() ? 0 : s.area());

  // 1) 间隙下限：闭运算焊死窄缝（闭运算只填缝，不加粗笔画）
  if (minGapMm > 0 && !section.isEmpty()) {
    const closed = closing(section, minGapMm / 2);
    const welded = areaOf(closed) - areaOf(section);
    if (welded > 0.01) {
      report.weldedGapAreaMm2 += welded;
      report.notes.push(`闭运算焊接窄缝 ${welded.toFixed(2)}mm²（窄于 ${minGapMm}mm）`);
    }
    section.delete();
    section = closed;
  }

  // 2) 笔画下限：测量 → 只对违规的截面整体外扩
  if (minStrokeMm > 0 && !section.isEmpty()) {
    const stroke = measureMinStrokeRaster(section, { limitMm: minStrokeMm, gridMm: 0.05 });
    if (!stroke.atLimit && stroke.sizeMm < minStrokeMm - 1e-3) {
      const delta = (minStrokeMm - stroke.sizeMm) / 2;
      const grown = offsetSection(section, delta);
      section.delete();
      section = grown;
      report.thickenedMm = delta;
      report.minStrokeWidthMm = stroke.sizeMm;
      report.notes.push(`最细笔画 ${stroke.sizeMm.toFixed(2)}mm → 外扩 ${delta.toFixed(2)}mm 后达标`);

      // 3) 外扩吃掉了间隙 → 再闭一次
      if (minGapMm > 0 && !section.isEmpty()) {
        const reclosed = closing(section, minGapMm / 2);
        const welded = areaOf(reclosed) - areaOf(section);
        if (welded > 0.01) {
          report.weldedGapAreaMm2 += welded;
          report.notes.push(`加粗后再次焊接 ${welded.toFixed(2)}mm²`);
        }
        section.delete();
        section = reclosed;
      }
    }

    // 4) 复测最终间隙，供 printability/UI 引用真实值
    if (minGapMm > 0 && !section.isEmpty()) {
      const finalGap = measureMinGapRaster(section, { limitMm: minGapMm, gridMm: 0.05 });
      report.minGapWidthMm = finalGap.atLimit ? null : finalGap.sizeMm;
    }
  }

  if (simplifyMm > 0 && !section.isEmpty()) {
    const simplified = section.simplify(simplifyMm);
    section.delete();
    section = simplified;
  }

  return { section, report };
}




