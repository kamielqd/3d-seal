/**
 * SealSpec —— 全应用唯一的数据源。
 * 所有 UI 改动只修改这个对象；版式引擎与几何引擎都只读它。
 * 之所以把所有状态收敛成一个可序列化对象：URL 分享、撤销重做、增量重建都只依赖它。
 */

export type BodyShape = 'square' | 'circle' | 'polygon';
/**
 * 内置外部主体（`public/bodies/*.stl`）。
 *
 * 这些是用户自己建的章体模型：平面朝下当刻印面、圆角朝上。选中后：
 * - `sizeMm` 仍是**底面尺寸**，整个模型等比缩放（高度随模型比例走）
 * - `shape` / `border` / `handle` 全部忽略，形制由模型自带
 * - 只支持阴刻（阳刻要在面上挖整个凹坑，会切穿底座）
 */
export type BodyStyleId = 'classic' | 'cylinder' | 'column' | 'dome';
/** 主体种类：4 个内置模型 + 参数化测试片。styleId 缺省时按旧 spec 处理成 plate。 */
export type BodyKind = BodyStyleId | 'plate';
export type BorderStyle = 'none' | 'thin' | 'thick' | 'double';
export type HandleStyle = 'none' | 'knob' | 'bridge';
export type ReliefMode = 'raised' | 'engraved';
export type TextLayout = 'horizontal' | 'vertical' | 'ring' | 'huiwen';
/** 环形章中心图案（纯几何，来自 layout/ornaments） */
export type RingOrnament = 'none' | 'star' | 'hexagram';
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
  /** 选了外部主体样式就忽略上面的 shape/border/handle，只保留 sizeMm（底面尺寸） */
  styleId?: BodyKind;
}

/** 主体样式清单（UI 用；几何侧按 id 去 public/bodies 取对应 STL）。 */
export const BODY_STYLES: ReadonlyArray<{
  id: BodyKind;
  name: string;
  note: string;
  /**
   * 总高 / 底面尺寸。模型只按底面缩放到 sizeMm，高度随这个比例走——
   * 圆柱、立方柱是瘦高型（1.17cm 宽、2.6cm 高），30mm 章面下会到 65mm 高。
   */
  heightRatio: number;
}> = [
  { id: 'classic', name: '常见样式', note: '方底座 + 颈 + 球钮，最像传统印章', heightRatio: 1.017 },
  { id: 'cylinder', name: '圆柱', note: '细高圆柱，握柱子盖', heightRatio: 2.150 },
  { id: 'column', name: '立方柱', note: '细高方柱，握柱子盖', heightRatio: 2.198 },
  { id: 'dome', name: '石墩', note: '圆鼓身 + 双层台座，敦实', heightRatio: 0.965 },
  { id: 'plate', name: '测试片', note: '3mm 厚平板，可设方形/圆形/正多边形，用来试印或做薄章', heightRatio: 0.1 },
];

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
  /**
   * 文字塞不下章面时自动等比缩字号与字距（默认开）。
   * 缩过之后包围盒会落在章面内，`pattern.bounds` 不再报错，导出也不会被禁用；
   * 实际生效的字号由 `layoutFlatWithFit()` 回传，面板上要如实显示。
   */
  autoFit?: boolean;
  lineHeight: number;
  /** ring 专用 */
  ringStartDeg: number;
  ringSpanDeg: number;
  /**
   * 环形章的中心图案。当作普通图案参与布尔（阴刻即刻掉），不是凸起浮雕。
   * 只在 layout === 'ring' 时生效。
   */
  ringOrnament?: RingOrnament;
  /** 中心图案外接尺寸（mm）；不传按章面直径的 0.28 倍 */
  ringOrnamentSizeMm?: number;
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
  /**
   * 间隙比笔画宽度的下限放宽一档，因为这两个数不是一回事：
   * 0.4mm 是「喷嘴挤出的线能不能站住」的保守下限；间隙只决定两笔会不会粘连。
   * 30mm 章面排四字（字号约 7mm）时间隙必然落在 0.17mm 级——间隙随字号等比缩放，
   * 调字距/换字体都救不回来，卡 0.4 只会让最常见的四字印永远报警。
   * 真正会焊死的是 0.2mm 以下；0.3mm 只是笔画边缘略糊，盖印时肉眼几乎看不出。
   * 所以判定仍按此值，但 `gap.min` 在 printability 里是 `info` 提示，不拦导出。
   */
  minGapMm: 0.3,
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
      styleId: 'classic',
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
    ringStartDeg: 90,
    ringSpanDeg: 240,
    anchor: { x: 0, y: 0 },
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
