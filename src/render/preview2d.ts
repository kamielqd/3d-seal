/**
 * 盖印效果预览（2D）—— 给用户看「盖出来是什么样」。
 *
 * 输入：Polygon2D[]，**坐标空间由 `mirror` 显式声明**（见 PreviewOptions.mirror）。
 * 输出：离屏 canvas（可 toDataURL / convertToBlob）或纯像素缓冲。
 *
 * 设计要点：
 *  - 填充用「逐扫描线 evenodd」，不依赖环方向，天然保证内孔（回/日）镂空；
 *  - `mirror` 必须显式传：传 `true` 表示输入是「已镜像的印章浮雕」（模型空间），翻一次得到盖印结果；
 *    传 `false` 表示输入已是盖印视角，原样绘制。**不给默认值**——默认值正是「版式可读轮廓被当成
 *    模型空间、预览整体翻反」这类 bug 的来源；
 *  - 纸张底色 + 噪点（可关）；墨迹非纯色：边缘轻微不规则 + 低频浓淡 + 少量飞白；
 *  - 支持 dpi（默认 300）与画布 mm 尺寸。
 */

import type { Polygon2D } from '../layout/text';

export interface PaperStyle {
  /** 是否绘制纸张底色（关掉则背景透明），默认 true */
  enabled?: boolean;
  /** 纸张底色，hex，默认 #f4ece0 */
  color?: string;
  /** 纸面噪点强度 0~1，默认 0.06 */
  noise?: number;
}

export interface InkStyle {
  /** 墨色 hex，默认 #b23b2e */
  color?: string;
  /** 整体不透明度 0~1，默认 0.92 */
  opacity?: number;
  /** 边缘不规则 0~1，默认 0.5 */
  edgeIrregularity?: number;
  /** 浓淡不均（mottle）0~1，默认 0.35 */
  mottle?: number;
  /** 飞白（随机露纸）0~1，默认 0.12 */
  flyWhite?: number;
}

export interface PreviewOptions {
  /** 画布尺寸（mm）：数字=正方形；或宽高 */
  sizeMm: number | { width: number; height: number };
  /** 分辨率，默认 300 */
  dpi?: number;
  /**
   * 输入的坐标空间，**必填，无默认值**：
   * - `true`  → 输入是「已镜像的印章浮雕」（模型空间，例如几何层网格的俯视投影），翻一次得到盖印结果；
   * - `false` → 输入已是盖印视角（例如 layout 直接输出的可读轮廓），原样绘制。
   */
  mirror: boolean;
  /** 四周留白（mm），默认 2 */
  paddingMm?: number;
  /**
   * 阴刻（凹）时必填：章面轮廓环（外环 CCW）。
   * 阴刻的盖印结果是「图案留白、其余上墨」，所以要用 evenodd 把章面填满再把图案挖掉；
   * 不传就还是按「图案上墨」画，阴刻场景下会完全画反。
   */
  faceRing?: Polygon2D;
  /** true = 阴刻，配合 faceRing 使用 */
  engraved?: boolean;
  paper?: PaperStyle;
  ink?: InkStyle;
}

export interface RasterResult {
  width: number;
  height: number;
  /** RGBA，长度 width*height*4 */
  data: Uint8ClampedArray;
}

/**
 * 沿 X 轴翻转一组轮廓，得到镜像副本。
 * 版式层输出的是**可读**轮廓；几何层与「模型视角」用的是它的镜像，
 * 需要进模型空间时统一调这个，别在调用处手写 map。
 */
export function mirrorPolygonsX(polys: readonly Polygon2D[]): Polygon2D[] {
  return polys.map((p) => ({ points: p.points.map((pt) => ({ x: -pt.x, y: pt.y })) }));
}

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}
function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0 || 1e-9));
  return t * t * (3 - 2 * t);
}

function parseHex(c: string): { r: number; g: number; b: number } {
  let s = c.trim().replace(/^#/, '');
  if (s.length === 3) s = s.split('').map((ch) => ch + ch).join('');
  const n = parseInt(s, 16);
  if (Number.isNaN(n)) return { r: 0, g: 0, b: 0 };
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function hash2(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
  return s - Math.floor(s);
}
function fade(t: number): number {
  return t * t * (3 - 2 * t);
}
/** 平滑值噪声，返回 0~1 */
function valueNoise(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const v00 = hash2(xi, yi);
  const v10 = hash2(xi + 1, yi);
  const v01 = hash2(xi, yi + 1);
  const v11 = hash2(xi + 1, yi + 1);
  const u = fade(xf);
  const v = fade(yf);
  return v00 * (1 - u) * (1 - v) + v10 * u * (1 - v) + v01 * (1 - u) * v + v11 * u * v;
}

/* ------------------------------------------------------------------ */
/* 纯像素光栅化（不依赖 canvas，可无头运行/单测）                       */
/* ------------------------------------------------------------------ */

export function rasterizePreview(inputPolys: Polygon2D[], opts: PreviewOptions): RasterResult {
  // 阴刻：先把章面整个填上墨，再用 evenodd 把图案挖空（图案的孔会重新变回有墨）
  const polys =
    opts.engraved && opts.faceRing
      ? [opts.faceRing, ...inputPolys]
      : inputPolys;
  const dpi = opts.dpi ?? 300;
  const pad = opts.paddingMm ?? 2;
  const size =
    typeof opts.sizeMm === 'number'
      ? { width: opts.sizeMm, height: opts.sizeMm }
      : opts.sizeMm;
  const Wmm = Math.max(1, size.width) + pad * 2;
  const Hmm = Math.max(1, size.height) + pad * 2;
  const scale = dpi / 25.4;
  const w = Math.max(1, Math.round(Wmm * scale));
  const h = Math.max(1, Math.round(Hmm * scale));
  const mirror = opts.mirror;

  // 世界坐标(mm, y 上, 原点居中) → 像素坐标(x 右, y 下)
  const toPx = (x: number, y: number): { x: number; y: number } => {
    const wx = mirror ? -x : x;
    return { x: w / 2 + wx * scale, y: h / 2 - y * scale };
  };

  // 把所有环展开成像素空间边表
  interface Edge {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  }
  const edges: Edge[] = [];
  for (const poly of polys) {
    const pts = poly.points;
    if (pts.length < 3) continue;
    for (let i = 0; i < pts.length; i++) {
      const a = toPx(pts[i].x, pts[i].y);
      const b = toPx(pts[(i + 1) % pts.length].x, pts[(i + 1) % pts.length].y);
      edges.push({ x0: a.x, y0: a.y, x1: b.x, y1: b.y });
    }
  }

  // 覆盖率（0~1），逐扫描线 evenodd + 2x 纵向超采样近似抗锯齿
  const coverage = new Float32Array(w * h);
  const SS = 2;
  const xs: number[] = [];
  for (let py = 0; py < h; py++) {
    for (let s = 0; s < SS; s++) {
      const sy = py + (s + 0.5) / SS;
      xs.length = 0;
      for (const e of edges) {
        if (e.y0 > sy !== e.y1 > sy) {
          const t = (sy - e.y0) / (e.y1 - e.y0);
          xs.push(e.x0 + t * (e.x1 - e.x0));
        }
      }
      if (xs.length < 2) continue;
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const xa = Math.max(0, xs[k]);
        const xb = Math.min(w, xs[k + 1]);
        if (xb <= xa) continue;
        const ia = Math.floor(xa);
        const ib = Math.ceil(xb);
        for (let x = ia; x < ib; x++) {
          const cov = Math.min(xb, x + 1) - Math.max(xa, x);
          if (cov > 0) coverage[py * w + x] += cov / SS;
        }
      }
    }
  }

  // 颜色与墨迹参数
  const paper = opts.paper ?? {};
  const paperOn = paper.enabled ?? true;
  const paperCol = parseHex(paper.color ?? '#f4ece0');
  const paperNoise = clamp01(paper.noise ?? 0.06);

  const ink = opts.ink ?? {};
  const inkCol = parseHex(ink.color ?? '#b23b2e');
  const inkOpacity = clamp01(ink.opacity ?? 0.92);
  const edgeIr = clamp01(ink.edgeIrregularity ?? 0.5);
  const mottle = clamp01(ink.mottle ?? 0.35);
  const fly = clamp01(ink.flyWhite ?? 0.12);

  const data = new Uint8ClampedArray(w * h * 4);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      const cov = coverage[idx];

      // 墨迹 alpha
      let a = 0;
      if (cov > 0) {
        const edgeNoise = (valueNoise(x * 0.18, y * 0.18) - 0.5) * edgeIr * 1.2;
        a = clamp01(cov + edgeNoise * Math.min(1, cov * 2));
        a = smoothstep(0.15, 0.85, a);
      }
      if (a > 0) {
        // 低频浓淡
        const m = 1 - mottle * (0.5 - 0.5 * valueNoise(x * 0.05 + 11.3, y * 0.05 + 7.7));
        a *= m;
        // 飞白：稀疏地把一部分墨点变淡（露纸）
        if (fly > 0) {
          const fh = hash2(Math.floor(x / 1.3) + 3.1, Math.floor(y / 1.3) + 9.7);
          if (fh < fly * 0.12) a *= 0.15;
        }
        a *= inkOpacity;
        a = clamp01(a);
      }

      const o = idx * 4;
      if (a > 0) {
        if (paperOn) {
          const pn = (hash2(x * 1.7, y * 1.7) - 0.5) * 2 * paperNoise * 22;
          const pr = clamp255(paperCol.r + pn);
          const pg = clamp255(paperCol.g + pn);
          const pb = clamp255(paperCol.b + pn);
          data[o] = pr * (1 - a) + inkCol.r * a;
          data[o + 1] = pg * (1 - a) + inkCol.g * a;
          data[o + 2] = pb * (1 - a) + inkCol.b * a;
          data[o + 3] = 255;
        } else {
          data[o] = inkCol.r;
          data[o + 1] = inkCol.g;
          data[o + 2] = inkCol.b;
          data[o + 3] = Math.round(a * 255);
        }
      } else if (paperOn) {
        const pn = (hash2(x * 1.7, y * 1.7) - 0.5) * 2 * paperNoise * 22;
        data[o] = clamp255(paperCol.r + pn);
        data[o + 1] = clamp255(paperCol.g + pn);
        data[o + 2] = clamp255(paperCol.b + pn);
        data[o + 3] = 255;
      } else {
        data[o + 3] = 0;
      }
    }
  }

  return { width: w, height: h, data };
}

/* ------------------------------------------------------------------ */
/* Canvas 封装（浏览器）                                                */
/* ------------------------------------------------------------------ */

export function renderPreviewToCanvas(
  polys: Polygon2D[],
  opts: PreviewOptions,
): HTMLCanvasElement | OffscreenCanvas {
  const { width, height, data } = rasterizePreview(polys, opts);
  let canvas: HTMLCanvasElement | OffscreenCanvas;
  if (typeof OffscreenCanvas !== 'undefined') {
    canvas = new OffscreenCanvas(width, height);
  } else if (typeof document !== 'undefined') {
    canvas = document.createElement('canvas');
  } else {
    throw new Error('当前环境既无 OffscreenCanvas 也无 document，无法创建画布');
  }
  canvas.width = width;
  canvas.height = height;
  const ctx = (canvas as HTMLCanvasElement).getContext('2d') as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
  if (!ctx) throw new Error('无法获取 2D 上下文');
  const clamped = new Uint8ClampedArray(width * height * 4);
  clamped.set(data);
  const image = new ImageData(clamped, width, height);
  (ctx as CanvasRenderingContext2D).putImageData(image, 0, 0);
  return canvas;
}

/** 直接在浏览器里拿到 PNG dataURL（dpi 默认 300，画布按 mm） */
export function renderPreviewToDataURL(
  polys: Polygon2D[],
  opts: PreviewOptions,
  type: 'image/png' | 'image/jpeg' = 'image/png',
): string {
  if (typeof document === 'undefined') {
    throw new Error('renderPreviewToDataURL 需要浏览器 DOM 环境；无头场景请用 rasterizePreview 自行编码');
  }
  const { width, height, data } = rasterizePreview(polys, opts);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法获取 2D 上下文');
  const clamped = new Uint8ClampedArray(width * height * 4);
  clamped.set(data);
  ctx.putImageData(new ImageData(clamped, width, height), 0, 0);
  return canvas.toDataURL(type);
}
