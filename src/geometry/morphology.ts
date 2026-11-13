/**
 * 形态学与「最小特征」测量。
 *
 * 这一层只做 CrossSection 的膨胀/腐蚀/开闭运算与半径二分，不涉及业务规则，
 * 供 crosssection.prepareSection 与 printability.checkPrintability 共用。
 *
 * 为什么用 offset 而不是栅格距离变换：
 *   - Clipper2 的 offset 是精确的圆弧偏置，测量误差 ~0.005mm，不受网格分辨率影响；
 *   - 免去 800×800 栅格化和 EDT 代码，包体与 CPU 都更省；
 *   - 差值区域（少了哪些笔画、粘住了哪些缝）直接就是高亮多边形。
 *
 * 半径语义：
 *   - 开运算 opening(r) = 腐蚀 r 再膨胀 r，会**抹掉**窄于 2r 的笔画/凸起；
 *   - 闭运算 closing(r) = 膨胀 r 再腐蚀 r，会**焊死**窄于 2r 的缝隙/孔。
 *   所以「最小笔画宽 w」= 使 opening 不丢料的最大 2r；「最小间隙 g」同理用 closing。
 */

import type { ManifoldKit } from './crosssection.ts';

export type CS = InstanceType<ManifoldKit['CrossSection']>;

/** 圆角偏置的圆分段数：小半径不必切太细。 */
export function segmentsFor(radiusMm: number): number {
  const raw = Math.ceil((Math.PI * 2 * Math.max(radiusMm, 0.01)) / 0.35);
  return Math.min(96, Math.max(8, raw));
}

/** 外扩 / 内缩（正数外扩），返回新对象，调用方负责 delete。 */
export function offset(section: CS, deltaMm: number): CS {
  if (deltaMm === 0) return section;
  return section.offset(deltaMm, 'Round', 2, segmentsFor(Math.abs(deltaMm)));
}

/** 开运算 opening(r)：抹掉窄于 2r 的笔画。 */
export function opening(section: CS, radiusMm: number): CS {
  if (radiusMm <= 0) return section;
  const eroded = offset(section, -radiusMm);
  if (eroded.isEmpty()) return eroded;
  const dilated = offset(eroded, radiusMm);
  eroded.delete();
  return dilated;
}

/** 闭运算 closing(r)：焊死窄于 2r 的缝隙。 */
export function closing(section: CS, radiusMm: number): CS {
  if (radiusMm <= 0) return section;
  const dilated = offset(section, radiusMm);
  if (dilated.isEmpty()) return dilated;
  const eroded = offset(dilated, -radiusMm);
  dilated.delete();
  return eroded;
}

/** 面积差（mm²），用于判断开/闭运算是否真的改变了形状。 */
export function areaDelta(a: CS, b: CS): number {
  return Math.abs(a.area() - b.area());
}

export interface FeatureMeasurement {
  /** 实测最小特征尺寸（mm）。达到搜索上限时是下限值，见 atLimit。 */
  sizeMm: number;
  /** true 表示实测 ≥ 搜索上限，真实值可能更大。 */
  atLimit: boolean;
  /** 使该特征消失的半径（mm），供报告使用。 */
  radiusMm: number;
  /** 在 sizeMm 阈值下被抹掉/焊上的区域，即高亮多边形（可能为空）。 */
  highlight: CS | null;
}

export interface MeasureOptions {
  /** 搜索上限（mm）。一般取 print.minStrokeMm 或 depth / 允许比值。 */
  limitMm: number;
  /** 面积容差 mm²：小于它认为形状没变（吸收浮点与圆角抖动）。 */
  epsilonMm2?: number;
  /** 二分次数，8 次 ≈ limit/256 精度。 */
  iterations?: number;
  /** 高亮区域的最小面积 mm²，过滤掉尖角碎屑。 */
  highlightMinAreaMm2?: number;
}

/**
 * 测量最小笔画宽（opening 判定）。
 */
export function measureMinStroke(section: CS, options: MeasureOptions): FeatureMeasurement {
  return measure(section, options, 'open');
}

/**
 * 测量最小间隙（closing 判定）。孔洞窄于下限也算「间隙」——印不出来。
 */
export function measureMinGap(section: CS, options: MeasureOptions): FeatureMeasurement {
  return measure(section, options, 'close');
}

function measure(section: CS, options: MeasureOptions, mode: 'open' | 'close'): FeatureMeasurement {
  // 圆角偏置会在尖角处制造 ~0.86r² 的面积噪声（r=0.35 时约 0.026mm²），
  // 容差必须高于它，否则 0.3mm 的细条会被量成 0.18mm。
  const epsilon = options.epsilonMm2 ?? 0.05;
  const iterations = options.iterations ?? 8;
  const highlightMin = options.highlightMinAreaMm2 ?? 0.05;
  const maxR = Math.max(options.limitMm, 0.01) / 2;

  if (section.isEmpty()) {
    return { sizeMm: options.limitMm, atLimit: true, radiusMm: 0, highlight: null };
  }

  // 上限处不改变形状 → 最小特征 ≥ limit，无需二分
  const atLimit = changedArea(section, maxR, mode);
  if (atLimit <= epsilon) {
    return { sizeMm: options.limitMm, atLimit: true, radiusMm: 0, highlight: null };
  }

  let lo = 0; // 不改变
  let hi = maxR; // 改变
  for (let i = 0; i < iterations; i++) {
    const mid = (lo + hi) / 2;
    if (changedArea(section, mid, mode) <= epsilon) lo = mid;
    else hi = mid;
  }

  const radiusMm = lo;
  // 高亮取上限半径处（= 阈值的一半）：把所有违规的笔画/缝隙一起圈出来，
  // 而不是只圈出最小的那一处。
  const highlight = highlightAt(section, maxR, mode, highlightMin);
  return { sizeMm: radiusMm * 2, atLimit: false, radiusMm, highlight };
}

/** 该半径下形状改变了多少面积（mm²）。 */
function changedArea(section: CS, radiusMm: number, mode: 'open' | 'close'): number {
  const shaped = mode === 'open' ? opening(section, radiusMm) : closing(section, radiusMm);
  const delta = areaDelta(section, shaped);
  shaped.delete();
  return delta;
}

/** 在上限半径处取「被抹掉/被焊上」的区域，作为高亮多边形。 */
function highlightAt(section: CS, radiusMm: number, mode: 'open' | 'close', minAreaMm2: number): CS | null {
  if (radiusMm <= 0) return null;
  const shaped = mode === 'open' ? opening(section, radiusMm) : closing(section, radiusMm);
  // 开运算 = 变小（被抹掉的笔画 = section − opened）；闭运算 = 变大（被焊上的缝 = closed − section）
  const diff = mode === 'open' ? section.subtract(shaped) : shaped.subtract(section);
  shaped.delete();
  if (diff.isEmpty()) {
    diff.delete();
    return null;
  }
  const parts: CS[] = [];
  for (const piece of diff.decompose()) {
    if (piece.area() >= minAreaMm2) parts.push(piece);
    else piece.delete();
  }
  diff.delete();
  if (parts.length === 0) return null;
  let acc = parts[0]!;
  for (let i = 1; i < parts.length; i++) {
    const next = acc.add(parts[i]!);
    if (acc !== parts[0]) acc.delete();
    parts[i]!.delete();
    acc = next;
  }
  return acc;
}
