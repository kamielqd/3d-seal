// 验收入口：用真实字体排版 → 光栅化成「盖印效果」位图（无头环境）
// 目的：验证字形取向（上下颠倒 / 镜像）与内孔镂空
import fs from 'node:fs';
import * as otRaw from 'opentype.js';
import { textToPolygons } from '../src/layout/text';
import { rasterizePreview } from '../src/render/preview2d';

const ot = (otRaw as unknown as { default: typeof otRaw }).default ?? otRaw;

export function build(text: string, opts?: { mirror?: boolean; dpi?: number; sizeMm?: number }) {
  const buf = fs.readFileSync('public/fonts/smiley-sans/smiley-sans-subset.ttf');
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const font = (ot as unknown as { parse: (b: ArrayBuffer) => unknown }).parse(ab) as Parameters<
    typeof textToPolygons
  >[0]['font'];

  const polys = textToPolygons({
    font,
    text,
    fontSizeMm: 9,
    letterSpacingMm: 0.8,
  });

  // mirror=false：layout 输出本身即「盖印结果」（印章模型是镜像的，压一次又翻回正）
  const r = rasterizePreview(polys, {
    sizeMm: opts?.sizeMm ?? 40,
    dpi: opts?.dpi ?? 300,
    mirror: opts?.mirror ?? false,
  });

  return { width: r.width, height: r.height, data: Array.from(r.data), ringCount: polys.length };
}
