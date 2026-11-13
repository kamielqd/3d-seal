/* 复核 ring 字头朝向 & huiwen 槽位方向（y-up 数据下）。 */
import fs from 'node:fs';
import otRaw from 'opentype.js';
import { glyphToPolygons, centerPolygons, transformPolygons } from '../src/layout/text.ts';
import { ringTextPolygons, ringSelfCheck } from '../src/layout/ring.ts';
import { huiwenTextPolygons } from '../src/layout/huiwen.ts';

const ot = (otRaw as unknown as { default: typeof otRaw }).default ?? otRaw;
function loadFont() {
  const buf = fs.readFileSync('public/fonts/smiley-sans/smiley-sans-subset.ttf');
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return (ot as any).parse(ab);
}

const font = loadFont();
const text = '印章工坊二号';
const radius = 15;
const startDeg = 90;
const res = ringTextPolygons({ text, font, fontSizeMm: 5, letterSpacingMm: 0.6, radiusMm: radius, startDeg, spanDeg: 300 });
const chk = ringSelfCheck(res, radius);
console.log('=== ring 六字 ===');
console.log('count', res.positions.length, 'fits', res.fits, 'sameRadius', chk.sameRadius, 'minGapDeg', chk.minCenterGapDeg.toFixed(2));

// 逐字判断「字头朝外」：取该字局部最高点(顶)与最低点(底)，按同样的旋转+平移后，
// 比较它们到环心的距离——顶部应比底部更远离环心（朝外）。
const chars = Array.from(text);
let outwardOk = 0;
for (let i = 0; i < res.positions.length; i++) {
  const pos = res.positions[i];
  const glyph = font.charToGlyph(chars[i]);
  const gp = glyphToPolygons(glyph, res.fontSizeMm); // 已是 y-up
  const c = centerPolygons(gp);
  // 找局部顶/底点
  let top = { x: 0, y: -Infinity };
  let bot = { x: 0, y: Infinity };
  for (const pg of c) for (const p of pg.points) { if (p.y > top.y) top = p; if (p.y < bot.y) bot = p; }
  const rot = (pos.angleDeg * Math.PI) / 180 - Math.PI / 2;
  const cos = Math.cos(rot), sin = Math.sin(rot);
  const apply = (pt: { x: number; y: number }) => ({ x: cos * pt.x - sin * pt.y + pos.x, y: sin * pt.x + cos * pt.y + pos.y });
  const T = apply(top), B = apply(bot);
  const dTop = Math.hypot(T.x, T.y), dBot = Math.hypot(B.x, B.y);
  const ok = dTop > dBot - 1e-6;
  if (ok) outwardOk++;
  console.log(`  ${chars[i]} @${pos.angleDeg.toFixed(1)}°  dTop=${dTop.toFixed(2)} dBot=${dBot.toFixed(2)}  字头朝外=${ok}`);
}
console.log(`结论: ${outwardOk}/${res.positions.length} 个字头朝外`);

console.log('\n=== huiwen 槽位 ===');
const hw = huiwenTextPolygons({ text: '印章工坊', font, fontSizeMm: 8, gapMm: 1.5 });
for (const p of hw.positions) {
  const dir = `${p.x > 0 ? '右' : '左'}${p.y > 0 ? '上' : '下'}`;
  console.log(`  ${p.char} → 槽位声明=${p.slot}  坐标=(${p.x.toFixed(2)},${p.y.toFixed(2)}) 实测方向=${dir}  ${dir === p.slot ? 'OK' : '✗不符'}`);
}
