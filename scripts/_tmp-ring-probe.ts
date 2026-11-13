import fs from 'node:fs';
import opentype from 'opentype.js';
import { ringTextPolygons } from '../src/layout/ring.ts';
const buf = fs.readFileSync('public/fonts/smiley-sans/smiley-sans-subset.ttf');
const font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
for (const [text, r, fs_] of [['吉祥如意万事顺', 14, 6], ['吉祥如意万事顺', 14, 5], ['吉祥如意', 14, 6.5]]) {
  const res = ringTextPolygons({ text, font, fontSizeMm: fs_, letterSpacingMm: 1, radiusMm: r, startDeg: -90, spanDeg: 360, centerMm: { x: 0, y: 0 } });
  let maxR = 0;
  for (const p of res.polygons) for (const pt of p.points) maxR = Math.max(maxR, Math.hypot(pt.x, pt.y));
  console.log(`text=${text} 字号=${fs_} r=${r} → 最远半径 ${maxR.toFixed(2)}mm  fits=${res.fits} usedSpan=${res.usedSpanDeg?.toFixed?.(1) ?? res.usedSpanDeg}`);
}

