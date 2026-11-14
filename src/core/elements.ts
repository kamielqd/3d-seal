/**
 * 元素模型（圆形章口径）。
 *
 * 四种元素，全部围绕「大圆」定位：章面直径 D = body.sizeMm，所有 0–100 的滑条
 * 都是 D 的等分百分比（0 = 圆的一侧，100 = 另一侧）。**没有默认元素**：
 * `createDefaultSpec()` 的 layers 是空数组，用户自己添加。
 *
 * 1. 普通文字 `text`      水平/垂直/中心旋转
 * 2. 环绕文字 `ringText`  环绕半径/文字间距/起点角度
 * 3. 边框圆环 `border`    半径/宽度/虚线
 * 4. 图片     `image`     大小/水平/垂直/中心旋转（其余是描摹参数）
 */

export interface Vec2 {
  x: number;
  y: number;
}

export interface PlainTextElement {
  kind: 'text';
  id: string;
  text: string;
  fontId: string;
  fontSizeMm: number;
  bold?: boolean;
  italic?: boolean;
  /** 0 = 最左，100 = 最右（按章面直径等分） */
  xPct: number;
  /** 0 = 最下，100 = 最上 */
  yPct: number;
  /** 文字行绕自身中心旋转，0–360° */
  rotationDeg: number;
}

export interface RingTextElement {
  kind: 'ringText';
  id: string;
  text: string;
  fontId: string;
  fontSizeMm: number;
  bold?: boolean;
  italic?: boolean;
  /** 轨道半径 0–100：100 = 字压在大圆边界上；减小时字号不变，整圈往内收 */
  radiusPct: number;
  /** 字间距 0–100：0 = 全叠在起点，100 = 首尾相接；首字不动，其余字向它收 */
  spacingPct: number;
  /** 首字所在角度 0–360° */
  startDeg: number;
}

export interface RingBorderElement {
  kind: 'border';
  id: string;
  /** 轨道半径 0–100：100 = 圆环外边缘与大圆边界重合 */
  radiusPct: number;
  /** 环宽 0–100：100 = 占满整个大圆（下限由 0.6mm 兜住） */
  widthPct: number;
  /** 虚线 0–100：0 = 实线，100 = 线长 0.6mm、间隔 0.6mm */
  dashPct: number;
}

export interface ImageElement {
  kind: 'image';
  id: string;
  /** 运行时为 dataURL 或 blob URL，不参与序列化 */
  src: string;
  /** 图案大小 0–100：100 = 占满整个大圆 */
  sizePct: number;
  xPct: number;
  yPct: number;
  rotationDeg: number;
  trace: {
    autoThreshold: boolean;
    threshold: number;
    invert: boolean;
    despeckleAreaMm2: number;
    simplifyMm: number;
    mode?: 'silhouette' | 'outline';
    outlineWidthMm?: number;
  };
}

export type Layer = PlainTextElement | RingTextElement | RingBorderElement | ImageElement;
export type TextElement = PlainTextElement | RingTextElement;

export function isTextElement(l: Layer): l is TextElement {
  return l.kind === 'text' || l.kind === 'ringText';
}

export function newLayerId(kind: Layer['kind']): string {
  const prefix = kind === 'text' ? 't' : kind === 'ringText' ? 'r' : kind === 'border' ? 'b' : 'i';
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
}

export function createPlainText(init: Partial<PlainTextElement> = {}): PlainTextElement {
  return {
    kind: 'text',
    id: newLayerId('text'),
    text: '印章工坊',
    fontId: 'smiley-sans',
    fontSizeMm: 6,
    xPct: 50,
    yPct: 50,
    rotationDeg: 0,
    ...init,
  };
}

export function createRingText(init: Partial<RingTextElement> = {}): RingTextElement {
  return {
    kind: 'ringText',
    id: newLayerId('ringText'),
    text: '印章工坊',
    fontId: 'smiley-sans',
    fontSizeMm: 5,
    radiusPct: 72,
    spacingPct: 100,
    startDeg: 0,
    ...init,
  };
}

export function createRingBorder(init: Partial<RingBorderElement> = {}): RingBorderElement {
  return {
    kind: 'border',
    id: newLayerId('border'),
    radiusPct: 96,
    widthPct: 8,
    dashPct: 0,
    ...init,
  };
}

export function createImageElement(src: string, init: Partial<ImageElement> = {}): ImageElement {
  return {
    kind: 'image',
    id: newLayerId('image'),
    src,
    sizePct: 60,
    xPct: 50,
    yPct: 50,
    rotationDeg: 0,
    trace: {
      autoThreshold: true,
      threshold: 0.5,
      invert: false,
      despeckleAreaMm2: 0.2,
      simplifyMm: 0.08,
    },
    ...init,
  };
}
