/**
 * 图像图层的运行时缓存与描摹入口。
 *
 * 为什么要单独一层：ImageData 不可能进 SealSpec（也不可能进 URL），
 * 但每次重建几何都要用同一张图的同一份像素。这里按 layer.id 缓存解码结果，
 * 避免用户拖一次滑块就重新解码一次图片。
 */
import type { ImageLayer } from './spec';
import type { Polygon2D } from '../geometry/types';
import { traceImageData, lastTraceStats, type ImageDataLike, type TraceStats } from '../geometry/trace';

const bitmapCache = new Map<string, ImageDataLike>();
const inflight = new Map<string, Promise<ImageDataLike>>();

/** 浏览器端把 File/Blob 解成 ImageDataLike */
export async function decodeImageSource(src: string | Blob): Promise<ImageDataLike> {
  const blob = typeof src === 'string' ? await (await fetch(src)).blob() : src;
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 OffscreenCanvas 2D 上下文');
  ctx.drawImage(bitmap, 0, 0);
  const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  bitmap.close();
  return { data: data.data, width: data.width, height: data.height };
}

/** 取某个图像图层的像素；同一 id 只解码一次 */
export async function ensureImageData(layer: ImageLayer): Promise<ImageDataLike | null> {
  if (!layer.src) return null;
  const cached = bitmapCache.get(layer.id);
  if (cached) return cached;
  const running = inflight.get(layer.id);
  if (running) return running;

  const task = decodeImageSource(layer.src)
    .then((img) => {
      bitmapCache.set(layer.id, img);
      inflight.delete(layer.id);
      return img;
    })
    .catch((err) => {
      inflight.delete(layer.id);
      throw err;
    });
  inflight.set(layer.id, task);
  return task;
}

export function forgetImage(layerId: string): void {
  bitmapCache.delete(layerId);
  inflight.delete(layerId);
}

export interface TracedImage {
  polygons: Polygon2D[];
  stats: TraceStats | null;
  /** 实际使用的 mm/px，UI 可以显示给用户看 */
  mmPerPx: number;
  pixelWidth: number;
  pixelHeight: number;
}

/**
 * 把图像图层描摹成多边形。
 * mmPerPx 由 layer.widthMm 和图片像素宽度推出来——用户调的是「图片实际多宽」，
 * 而不是「每像素多少毫米」，后者不可预期。
 */
export async function traceImageLayer(
  layer: ImageLayer,
  print: { minStrokeMm: number; minGapMm: number },
): Promise<TracedImage | null> {
  const img = await ensureImageData(layer);
  if (!img) return null;

  const mmPerPx = layer.widthMm / img.width;
  const polygons = await traceImageData(img, {
    autoThreshold: layer.trace.autoThreshold,
    threshold: layer.trace.threshold,
    invert: layer.trace.invert,
    mmPerPx,
    simplifyMm: layer.trace.simplifyMm,
    despeckleAreaMm2: layer.trace.despeckleAreaMm2,
    minStrokeMm: print.minStrokeMm,
    minGapMm: print.minGapMm,
  });

  // 描摹结果以图片中心为原点；再按 anchor / 缩放 / 旋转落到章面上
  const halfW = (img.width * mmPerPx) / 2;
  const halfH = (img.height * mmPerPx) / 2;
  const scale = layer.transform.scale;
  const rad = (layer.transform.rotateDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  const placed = polygons.map((poly) => ({
    outer: poly.outer.map(([x, y]) => {
      const lx = (x - halfW) * scale;
      const ly = (y - halfH) * scale;
      return [cos * lx - sin * ly, sin * lx + cos * ly] as const;
    }),
    holes: poly.holes.map((hole) =>
      hole.map(([x, y]) => {
        const lx = (x - halfW) * scale;
        const ly = (y - halfH) * scale;
        return [cos * lx - sin * ly, sin * lx + cos * ly] as const;
      }),
    ),
  }));

  return {
    polygons: placed as unknown as Polygon2D[],
    stats: lastTraceStats(),
    mmPerPx,
    pixelWidth: img.width,
    pixelHeight: img.height,
  };
}
