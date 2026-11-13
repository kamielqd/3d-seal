/**
 * SealSpec —— 全应用唯一的数据源。
 * 所有 UI 改动只修改这个对象；版式引擎与几何引擎都只读它。
 * 之所以把所有状态收敛成一个可序列化对象：URL 分享、撤销重做、增量重建都只依赖它。
 */

export type BodyShape = 'square' | 'circle' | 'polygon';
export type BorderStyle = 'none' | 'thin' | 'thick' | 'double';
export type HandleStyle = 'none' | 'knob' | 'bridge';
export type ReliefMode = 'raised' | 'engraved';
export type TextLayout = 'horizontal' | 'vertical' | 'ring' | 'huiwen';
export type PrintProcess = 'fdm' | 'resin';

/** 打印取向：face-down = 盖印面贴床；face-up = 背面贴床、字母朝上（必须无手柄）。 */
export type PrintOrientation = 'face-down' | 'face-up';

export interface Vec2 {
  x: number;
  y: number;
}

export interface BodyConfig {
  shape: BodyShape;
  /** polygon 专用，3~12 */
  sides: number;
  /** 章面外接尺寸（mm）：方章为边长，圆章为直径，多边形为外接圆直径 */
  sizeMm: number;
  cornerRadiusMm: number;
  baseThicknessMm: number;
  border: {
    style: BorderStyle;
    widthMm: number;
    insetMm: number;
  };
  handle: HandleStyle;
  handleHeightMm: number;
  handleDiameterMm: number;
}

export interface ReliefConfig {
  mode: ReliefMode;
  /** 浮雕深度 mm */
  depthMm: number;
}

/** 归一下坐标：-1~1 表示章面的内切范围，形状尺寸变化时自动跟随 */
export interface Anchor {
  x: number;
  y: number;
}

export interface Transform {
  rotateDeg: number;
  scale: number;
}

export interface TextLayer {
  kind: 'text';
  id: string;
  text: string;
  fontId: string;
  layout: TextLayout;
  fontSizeMm: number;
  letterSpacingMm: number;
  lineHeight: number;
  /** ring 专用 */
  ringStartDeg: number;
  ringSpanDeg: number;
  anchor: Anchor;
  transform: Transform;
}

export interface ImageLayer {
  kind: 'image';
  id: string;
  /** 运行时为 dataURL 或 blob URL，不参与序列化 */
  src: string;
  /**
   * 图像在章面上的物理宽度（mm）。描摹时的 mm/px 由它和图片像素宽度推出来，
   * 不让用户在 UI 上直接调 mm/px（不可预期）。
   */
  widthMm: number;
  trace: {
    /** Otsu 自动阈值；true 时忽略 threshold */
    autoThreshold: boolean;
    threshold: number;
    invert: boolean;
    /** 去噪：小于该面积(mm²)的岛直接丢弃 */
    despeckleAreaMm2: number;
    /** 简化容差 mm */
    simplifyMm: number;
    /** 描摹模式：silhouette = 实心（默认），outline = 实心转等宽环（线稿风） */
    mode?: 'silhouette' | 'outline';
    /** outline 模式的线宽（mm），默认 0.6 */
    outlineWidthMm?: number;
  };
  anchor: Anchor;
  transform: Transform;
}

export type Layer = TextLayer | ImageLayer;

export interface PrintConfig {
  process: PrintProcess;
  minStrokeMm: number;
  minGapMm: number;
  /**
   * 打印取向：
   * - `face-down`（默认）：盖印面贴床。阴刻可用；阳刻会让底板整片悬空，FDM 打不出来。
   * - `face-up`：背面贴床、字母朝上，零悬空。**只允许无手柄**（打了手柄就没法贴床了）。
   */
  orientation?: PrintOrientation;
}

export interface SealSpec {
  version: 1;
  body: BodyConfig;
  relief: ReliefConfig;
  layers: Layer[];
  print: PrintConfig;
}

/* ------------------------------------------------------------------ */
/* 默认值：面向 FDM，家用机可打印                                     */
/* ------------------------------------------------------------------ */

export const FDM_LIMITS = {
  minStrokeMm: 0.4,
  minGapMm: 0.4,
  reliefDepthMm: 1.2,
} as const;

export const RESIN_LIMITS = {
  minStrokeMm: 0.2,
  minGapMm: 0.2,
  reliefDepthMm: 0.6,
} as const;

export function uid(prefix = 'l'): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
}

export function createDefaultSpec(): SealSpec {
  return {
    version: 1,
    body: {
      shape: 'square',
      sides: 6,
      sizeMm: 30,
      cornerRadiusMm: 2,
      baseThicknessMm: 2.5,
      border: { style: 'thin', widthMm: 1.2, insetMm: 1.2 },
      handle: 'knob',
      handleHeightMm: 16,
      handleDiameterMm: 16,
    },
    // 默认阴刻：贴床零支撑，是 FDM 上唯一不用支撑就能打的组合（见 DESIGN §6 bridge.span）
    relief: { mode: 'engraved', depthMm: FDM_LIMITS.reliefDepthMm },
    layers: [createTextLayer()],
    print: { process: 'fdm', ...{ minStrokeMm: FDM_LIMITS.minStrokeMm, minGapMm: FDM_LIMITS.minGapMm }, orientation: 'face-down' },
  };
}

export function createTextLayer(init: Partial<TextLayer> = {}): TextLayer {
  return {
    kind: 'text',
    id: uid('t'),
    text: '印章工坊',
    fontId: 'smiley-sans',
    layout: 'horizontal',
    fontSizeMm: 7,
    letterSpacingMm: 0.6,
    lineHeight: 1.15,
    ringStartDeg: -90,
    ringSpanDeg: 240,
    anchor: { x: 0, y: 0.15 },
    transform: { rotateDeg: 0, scale: 1 },
    ...init,
  };
}

export function createImageLayer(src: string, init: Partial<ImageLayer> = {}): ImageLayer {
  return {
    kind: 'image',
    id: uid('i'),
    src,
    widthMm: 18,
    trace: {
      autoThreshold: true,
      threshold: 0.5,
      invert: false,
      despeckleAreaMm2: 0.2,
      simplifyMm: 0.08,
    },
    anchor: { x: 0, y: 0 },
    transform: { rotateDeg: 0, scale: 1 },
    ...init,
  };
}

/* ------------------------------------------------------------------ */
/* 序列化：分享链接用（不含图片二进制）                               */
/* ------------------------------------------------------------------ */

export function serializeSpec(spec: SealSpec): string {
  const stripped: SealSpec = {
    ...spec,
    layers: spec.layers.map((l) => (l.kind === 'image' ? { ...l, src: '' } : l)),
  };
  return JSON.stringify(stripped);
}

export function deserializeSpec(raw: string): SealSpec | null {
  try {
    const parsed = JSON.parse(raw) as SealSpec;
    if (!parsed || parsed.version !== 1 || !parsed.body || !Array.isArray(parsed.layers)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
