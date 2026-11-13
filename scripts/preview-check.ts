/* 临时验收脚本：无头渲染盖印预览，输出 PNG（自带极简 PNG 编码器，用 node zlib）。 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import opentype from 'opentype.js';
import { textToPolygons, bounds } from '../src/layout/text.ts';
import type { Polygon2D } from '../src/layout/text.ts';
import { rasterizePreview, type RasterResult } from '../src/render/preview2d.ts';

function loadFont(): opentype.Font {
  const p = 'public/fonts/smiley-sans/smiley-sans-subset.ttf';
  const buf = fs.readFileSync(p);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return opentype.parse(ab);
}

/** 模拟「已镜像的最终印章浮雕」：x → -x */
function mirrorX(polys: Polygon2D[]): Polygon2D[] {
  return polys.map((pg) => ({ points: pg.points.map((p) => ({ x: -p.x, y: p.y })) }));
}

/* ---- 极简 PNG 编码（RGBA, filter 0） ---- */
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}
function encodePNG(img: RasterResult): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0);
  ihdr.writeUInt32BE(img.height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const stride = img.width * 4;
  const raw = Buffer.alloc((stride + 1) * img.height);
  for (let y = 0; y < img.height; y++) {
    raw[y * (stride + 1)] = 0; // filter none
    Buffer.from(img.data.buffer, img.data.byteOffset + y * stride, stride).copy(
      raw,
      y * (stride + 1) + 1,
    );
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

const font = loadFont();

// 1) 「印章工坊」主图
const readable = textToPolygons({
  text: '印章工坊',
  font,
  fontSizeMm: 9,
  letterSpacingMm: 0.8,
  centerMm: { x: 0, y: 0 },
});
const png1 = rasterizePreview(mirrorX(readable), {
  sizeMm: 40,
  dpi: 300,
  mirror: true,
  paddingMm: 2,
  paper: { enabled: true, color: '#f4ece0', noise: 0.06 },
  ink: { color: '#b23b2e', opacity: 0.92, edgeIrregularity: 0.55, mottle: 0.35, flyWhite: 0.12 },
});
const dir = 'temp';
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(`${dir}/preview-yinzhanggongfang.png`, encodePNG(png1));
const b = bounds(readable);
console.log(
  `主图 PNG: temp/preview-yinzhanggongfang.png  ${png1.width}x${png1.height}px @300dpi 40mm`,
);
console.log(`  图案 bbox 宽=${(b.maxX - b.minX).toFixed(1)}mm 高=${(b.maxY - b.minY).toFixed(1)}mm`);

// 2) 「回」内孔镂空检查
const hui = textToPolygons({
  text: '回',
  font,
  fontSizeMm: 26,
  letterSpacingMm: 0,
  centerMm: { x: 0, y: 0 },
});
const png2 = rasterizePreview(mirrorX(hui), {
  sizeMm: 40,
  dpi: 200,
  mirror: true,
  paddingMm: 2,
  paper: { enabled: true, color: '#f4ece0', noise: 0.04 },
  ink: { opacity: 0.92, edgeIrregularity: 0.4, mottle: 0.25, flyWhite: 0.08 },
});
fs.writeFileSync(`${dir}/preview-hui.png`, encodePNG(png2));

// 统计中心区域 ink 像素占比（ink 绿通道明显低于纸）
function inkRatio(img: RasterResult, cx: number, cy: number, half: number): number {
  let ink = 0;
  let tot = 0;
  for (let y = cy - half; y <= cy + half; y++) {
    for (let x = cx - half; x <= cx + half; x++) {
      if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
      const o = (y * img.width + x) * 4;
      const g = img.data[o + 1];
      tot++;
      if (g < 150) ink++;
    }
  }
  return tot ? ink / tot : 0;
}
const cxp = (png2.width / 2) | 0;
const cyp = (png2.height / 2) | 0;
const centerInk = inkRatio(png2, cxp, cyp, 4);
const bandInk = inkRatio(png2, cxp, cyp - Math.round((26 / 2 / 25.4) * 200), 3); // 上方笔画带
console.log(`「回」中心 ink 占比 = ${(centerInk * 100).toFixed(1)}%  (应≈0，表示中间镂空)`);
console.log(`「回」上方笔画带 ink 占比 = ${(bandInk * 100).toFixed(1)}%  (应>0，表示笔画实)`);
console.log('回字 PNG: temp/preview-hui.png');
