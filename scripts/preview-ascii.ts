/* 把光栅结果降采样成 ASCII，便于无图像输入时核对形状/朝向/镂空。 */
import fs from 'node:fs';
import opentype from 'opentype.js';
import { textToPolygons } from '../src/layout/text.ts';
import type { Polygon2D } from '../src/layout/text.ts';
import { rasterizePreview, type RasterResult } from '../src/render/preview2d.ts';

function loadFont(): opentype.Font {
  const buf = fs.readFileSync('public/fonts/smiley-sans/smiley-sans-subset.ttf');
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return opentype.parse(ab);
}
function mirrorX(polys: Polygon2D[]): Polygon2D[] {
  return polys.map((pg) => ({ points: pg.points.map((p) => ({ x: -p.x, y: p.y })) }));
}
function inkRatio(img: RasterResult): number {
  let ink = 0;
  for (let i = 0; i < img.data.length; i += 4) if (img.data[i + 1] < 150) ink++;
  return ink / (img.width * img.height);
}
function ascii(img: RasterResult, cols = 64, rows = 26): string {
  const cw = img.width / cols;
  const ch = img.height / rows;
  const lines: string[] = [];
  for (let r = 0; r < rows; r++) {
    let line = '';
    for (let c = 0; c < cols; c++) {
      let ink = 0;
      let tot = 0;
      const x0 = Math.floor(c * cw);
      const x1 = Math.min(img.width, Math.floor((c + 1) * cw));
      const y0 = Math.floor(r * ch);
      const y1 = Math.min(img.height, Math.floor((r + 1) * ch));
      for (let y = y0; y < y1; y += 2) {
        for (let x = x0; x < x1; x += 2) {
          const g = img.data[(y * img.width + x) * 4 + 1];
          tot++;
          if (g < 150) ink++;
        }
      }
      const f = tot ? ink / tot : 0;
      line += f > 0.5 ? '#' : f > 0.2 ? '+' : f > 0.05 ? '.' : ' ';
    }
    lines.push(line.replace(/\s+$/,''));
  }
  return lines.join('\n');
}

const font = loadFont();
const main = textToPolygons({ text: '印章工坊', font, fontSizeMm: 9, letterSpacingMm: 0.8, centerMm: { x: 0, y: 0 } });
const img1 = rasterizePreview(mirrorX(main), { sizeMm: 40, dpi: 150, mirror: true });
console.log('=== 主图「印章工坊」 墨水占比=', (inkRatio(img1) * 100).toFixed(1), '% ===');
console.log(ascii(img1, 64, 26));

const hui = textToPolygons({ text: '回', font, fontSizeMm: 26, letterSpacingMm: 0, centerMm: { x: 0, y: 0 } });
const img2 = rasterizePreview(mirrorX(hui), { sizeMm: 40, dpi: 150, mirror: true });
console.log('\n=== 「回」 墨水占比=', (inkRatio(img2) * 100).toFixed(1), '% ===');
console.log(ascii(img2, 48, 26));
