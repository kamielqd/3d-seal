/**
 * 栅格化 + 欧氏距离变换：测量最小笔画宽与最小间隙。
 *
 * 为什么不用 offset 的开/闭运算量：Clipper2 的圆角偏置在尖角处会产生
 * 0.1–0.7mm² 的面积噪声（随半径平方增长），在 0.4mm 这个尺度上和真实
 * 细笔画同量级，实测会把 0.5mm 的正常笔画误判成 0.22mm。
 *
 * 栅格路线：0.05mm/格 + Felzenszwalb 精确 EDT + 中轴（局部极大）判定：
 *   - 笔画宽 ≈ 2×(到最近空像素的距离) − 1 格；
 *   - 细小材料的面积按「中轴长度 × 宽度」累计，低于阈值视为笔尖收笔，忽略；
 *   - 间隙 = 中脊上量对面向两侧材料的实际跨度（不是 2×最近距离，那会在内角误报）。
 *
 * 坐标：栅格 (px,py) → mm = (x0 + (px+0.5)*grid, y0 + (py+0.5)*grid)。
 */

import type { CS } from './morphology.ts';
import type { Vec2 } from './types.ts';

export interface RasterGrid {
  gridMm: number;
  w: number;
  h: number;
  x0: number;
  y0: number;
  /** 1 = 有材料 */
  mask: Uint8Array;
}

const INF = 1e20;

/** 把 CrossSection 按偶奇规则扫描线填充成栅格。 */
export function rasterize(section: CS, gridMm = 0.05): RasterGrid {
  const rings = section.toPolygons();
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const ring of rings) {
    for (const [x, y] of ring) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (!Number.isFinite(minX)) {
    return { gridMm, w: 1, h: 1, x0: 0, y0: 0, mask: new Uint8Array(1) };
  }

  // 控制栅格总量：大章自动放粗，避免 2000×2000 的 EDT
  let grid = gridMm;
  for (let guard = 0; guard < 6; guard++) {
    const w = Math.ceil((maxX - minX) / grid) + 4;
    const h = Math.ceil((maxY - minY) / grid) + 4;
    if (w * h <= 2_400_000) break;
    grid *= 1.25;
  }

  const w = Math.ceil((maxX - minX) / grid) + 4;
  const h = Math.ceil((maxY - minY) / grid) + 4;
  const x0 = minX - 2 * grid;
  const y0 = minY - 2 * grid;
  const mask = new Uint8Array(w * h);

  const xs: number[] = [];
  for (let py = 0; py < h; py++) {
    const y = y0 + (py + 0.5) * grid;
    xs.length = 0;
    for (const ring of rings) {
      const n = ring.length;
      for (let i = 0; i < n; i++) {
        const a = ring[i]!;
        const b = ring[(i + 1) % n]!;
        const [ax, ay] = a;
        const [bx, by] = b;
        if (ay === by) continue;
        if ((ay <= y && y < by) || (by <= y && y < ay)) {
          xs.push(ax + ((y - ay) * (bx - ax)) / (by - ay));
        }
      }
    }
    if (xs.length < 2) continue;
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const from = Math.max(0, Math.ceil((xs[i]! - x0) / grid - 0.5));
      const to = Math.min(w - 1, Math.floor((xs[i + 1]! - x0) / grid - 0.5));
      for (let px = from; px <= to; px++) mask[py * w + px] = 1;
    }
  }

  return { gridMm: grid, w, h, x0, y0, mask };
}

/** 到最近 target 像素的欧氏距离（单位：格）。target=0 求「材料内到空区的距离」。 */
export function distanceTransform(mask: Uint8Array, w: number, h: number, target: 0 | 1): Float64Array {
  const f = new Float64Array(Math.max(w, h));
  const d = new Float64Array(Math.max(w, h));
  const v = new Int32Array(Math.max(w, h) + 1);
  const z = new Float64Array(Math.max(w, h) + 1);
  const out = new Float64Array(w * h);

  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = mask[y * w + x] === target ? 0 : INF;
    edt1d(f, d, v, z, h);
    for (let y = 0; y < h; y++) out[y * w + x] = d[y]!;
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = out[y * w + x]!;
    edt1d(f, d, v, z, w);
    for (let x = 0; x < w; x++) out[y * w + x] = Math.sqrt(d[x]!);
  }
  return out;
}

function edt1d(f: Float64Array, d: Float64Array, v: Int32Array, z: Float64Array, n: number): void {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    while (s <= z[k]!) {
      k--;
      s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1]! < q) k++;
    const dv = q - v[k]!;
    d[q] = dv * dv + f[v[k]!]!;
  }
}

/**
 * 最大笔画/槽宽：材料 EDT 的最大值 ×2 = 最宽的一处（阴刻里就是最宽的单条槽）。
 * FDM 桥接能力看的是「单条跨度」，不是总面积。
 */
export function measureMaxStrokeRaster(section: CS, options: { gridMm?: number } = {}): FeatureMeasurement {
  const raster = rasterize(section, options.gridMm ?? 0.05);
  const { mask, w, h, gridMm: grid, x0, y0 } = raster;
  const dist = distanceTransform(mask, w, h, 0);
  let best = 0;
  let bx = 0;
  let by = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (mask[i] !== 1) continue;
      const width = 2 * dist[i]! * grid;
      if (width > best) {
        best = width;
        bx = x;
        by = y;
      }
    }
  }
  if (best <= 0) return { sizeMm: 0, atLimit: true, areaMm2: 0, bbox: null };
  const mx = x0 + (bx + 0.5) * grid;
  const my = y0 + (by + 0.5) * grid;
  return { sizeMm: best, atLimit: false, areaMm2: 0, bbox: [mx, my, mx, my] };
}

export interface FeatureMeasurement {
  /** 实测最小特征尺寸 mm。atLimit=true 时是下限。 */
  sizeMm: number;
  atLimit: boolean;
  /** 违规区域的包围盒（mm），用于 UI 高亮。 */
  bbox: [number, number, number, number] | null;
  /** 参与判定的材料/空区面积 mm²（帮助判断量级）。 */
  areaMm2: number;
}

export interface MeasureOptions {
  limitMm: number;
  gridMm?: number;
  /** 细材料面积下限 mm²：低于此值视为笔尖收笔，忽略。 */
  minMaterialMm2?: number;
}

/**
 * 最小笔画宽：中轴（EDT 局部极大）上宽度小于 limit 的「材料条」。
 * 细材料面积 = Σ(该中轴像素处的宽度 × 格距)，过滤掉笔尖。
 */
export function measureMinStrokeRaster(section: CS, options: MeasureOptions): FeatureMeasurement {
  const raster = rasterize(section, options.gridMm ?? 0.05);
  const { mask, w, h, gridMm: grid, x0, y0 } = raster;
  const dist = distanceTransform(mask, w, h, 0);
  const minMaterial = options.minMaterialMm2 ?? 0.15;

  let atLimit = true;
  let size = options.limitMm;
  let areaSum = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  // 第一遍：找所有「细」中轴像素，按 8 邻接聚类
  const thin = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (mask[i] !== 1) continue;
      const d = dist[i]!;
      if (d < 1.5) continue; // 贴着边界的像素不是中轴
      // 局部极大（>= 八邻域）
      let isMax = true;
      for (let dy = -1; dy <= 1 && isMax; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          if (dist[i + dy * w + dx]! > d + 1e-9) {
            isMax = false;
            break;
          }
        }
      }
      if (!isMax) continue;
      // 材料宽 = 2d 格：d 是到最近空像素格心的距离
      const width = 2 * d * grid;
      if (width < options.limitMm) thin[i] = 1;
    }
  }

  // 第二遍：连通域累计材料面积
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  for (let i = 0; i < thin.length; i++) {
    if (thin[i] !== 1 || seen[i] === 1) continue;
    stack.length = 0;
    stack.push(i);
    seen[i] = 1;
    let material = 0;
    let localMin = Infinity;
    let bMinX = Infinity;
    let bMinY = Infinity;
    let bMaxX = -Infinity;
    let bMaxY = -Infinity;
    while (stack.length > 0) {
      const j = stack.pop()!;
      const px = j % w;
      const py = (j - px) / w;
      const width = 2 * dist[j]! * grid;
      material += width * grid;
      if (width < localMin) localMin = width;
      const mx = x0 + (px + 0.5) * grid;
      const my = y0 + (py + 0.5) * grid;
      if (mx < bMinX) bMinX = mx;
      if (mx > bMaxX) bMaxX = mx;
      if (my < bMinY) bMinY = my;
      if (my > bMaxY) bMaxY = my;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = px + dx;
          const ny = py + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const k = ny * w + nx;
          if (thin[k] === 1 && seen[k] !== 1) {
            seen[k] = 1;
            stack.push(k);
          }
        }
      }
    }
    if (material < minMaterial) continue;
    atLimit = false;
    areaSum += material;
    if (localMin < size) size = localMin;
    if (bMinX < minX) minX = bMinX;
    if (bMinY < minY) minY = bMinY;
    if (bMaxX > maxX) maxX = bMaxX;
    if (bMaxY > maxY) maxY = bMaxY;
  }

  return {
    sizeMm: size,
    atLimit,
    areaMm2: areaSum,
    bbox: Number.isFinite(minX) ? [minX, minY, maxX, maxY] : null,
  };
}

/**
 * 最小间隙：空区 EDT 的局部极大 ×2（两壁之间的中脊就是间隙）。
 * 只统计「夹在材料之间」的中脊：中脊两侧至少各有一个方向能碰到材料。
 *
 * 缝宽必须量**对面两侧的实际跨度**，不能用 2×最近距离：
 * d 只是到最近材料的距离，碰不到对面那一壁。边框/「口」字形内角到自己的
 * 拐角只有 2 格（0.1mm），对面墙却在 12mm 外，用 2d-1 会把每个内角都误报成
 * 「0.1mm 级窄缝」（实测默认边框环给出 4 个角 × 0.15mm 的假阳性）。
 */
export function measureMinGapRaster(section: CS, options: MeasureOptions): FeatureMeasurement {
  const raster = rasterize(section, options.gridMm ?? 0.05);
  const { mask, w, h, gridMm: grid, x0, y0 } = raster;
  const dist = distanceTransform(mask, w, h, 1);

  let atLimit = true;
  let size = options.limitMm;
  let areaSum = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (let y = 2; y < h - 2; y++) {
    for (let x = 2; x < w - 2; x++) {
      const i = y * w + x;
      if (mask[i] === 1) continue;
      const d = dist[i]!;
      if (d < 1.5) continue;
      // 中脊：四邻域都不比自己大（平台像素也算）
      const isMax = dist[i + 1]! <= d && dist[i - 1]! <= d && dist[i + w]! <= d && dist[i - w]! <= d;
      if (!isMax) continue;

      // 两个方向各量到对面材料的格数，取更窄的那一对当缝宽（只接受两侧都有材料）
      const spanX = runToMaterial(mask, w, h, x, y, -1, 0) + runToMaterial(mask, w, h, x, y, 1, 0);
      const spanY = runToMaterial(mask, w, h, x, y, 0, -1) + runToMaterial(mask, w, h, x, y, 0, 1);
      const span = Math.min(spanX, spanY);
      if (!Number.isFinite(span)) continue;

      // 空区宽 = span-1 格：两侧各让半格的格心几何
      const gap = (span - 1) * grid;
      if (gap < grid || gap >= options.limitMm) continue;
      atLimit = false;
      areaSum += gap * grid;
      if (gap < size) size = gap;
      const mx = x0 + (x + 0.5) * grid;
      const my = y0 + (y + 0.5) * grid;
      if (mx < minX) minX = mx;
      if (mx > maxX) maxX = mx;
      if (my < minY) minY = my;
      if (my > maxY) maxY = my;
    }
  }

  return {
    sizeMm: size,
    atLimit,
    areaMm2: areaSum,
    bbox: Number.isFinite(minX) ? [minX, minY, maxX, maxY] : null,
  };
}

/** 从 (x,y) 沿 (dx,dy) 走几格碰到材料；碰不到返回 Infinity。 */
function runToMaterial(mask: Uint8Array, w: number, h: number, x: number, y: number, dx: number, dy: number): number {
  for (let k = 1; ; k++) {
    const nx = x + dx * k;
    const ny = y + dy * k;
    if (nx < 0 || ny < 0 || nx >= w || ny >= h) return Infinity;
    if (mask[ny * w + nx] === 1) return k;
  }
}

/** 把 bbox 转成 highlight 结构需要的点集（四个角）。 */
export function bboxToHighlight(bbox: [number, number, number, number] | null): Vec2[][] | undefined {
  if (bbox === null) return undefined;
  const [minX, minY, maxX, maxY] = bbox;
  return [[[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]]];
}
