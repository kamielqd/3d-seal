/* 临时验收脚本（不属于 src，不会进类型检查/构建）：
 * 实测 layout 管线的「印章工坊」多边形环数与环方向，并顺带自检环形/回文。
 */
import fs from 'node:fs';
import * as opentype from 'opentype.js';
import { textToPolygons, signedArea, bounds } from '../src/layout/text';
import { ringTextPolygons, ringSelfCheck } from '../src/layout/ring';
import { huiwenTextPolygons } from '../src/layout/huiwen';
import type { Polygon2D } from '../src/layout/text';

function loadFont(): opentype.Font {
  const p = 'public/fonts/smiley-sans/smiley-sans-subset.ttf';
  const buf = fs.readFileSync(p);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return opentype.parse(ab);
}

function dir(pg: Polygon2D): string {
  return signedArea(pg.points) > 0 ? 'CCW(外)' : 'CW(内孔)';
}

const font = loadFont();
console.log('字体:', font.numGlyphs, 'glyphs, unitsPerEm', font.unitsPerEm);
console.log('');

// 1) 横排「印章工坊」
const polys = textToPolygons({
  text: '印章工坊',
  font,
  fontSizeMm: 8,
  letterSpacingMm: 0.6,
  centerMm: { x: 0, y: 0 },
});
const bb = bounds(polys);
console.log('=== 横排「印章工坊」 ===');
console.log('环数:', polys.length);
let ccw = 0,
  cw = 0;
polys.forEach((pg, i) => {
  const d = dir(pg);
  if (d.startsWith('CCW')) ccw++;
  else cw++;
  if (i < 12) {
    const b = bounds([pg]);
    console.log(
      `  环#${i}: 点数=${pg.points.length} 方向=${d} 面积=${signedArea(pg.points).toFixed(2)}mm² bbox=(${b.minX.toFixed(1)},${b.minY.toFixed(1)})~(${b.maxX.toFixed(1)},${b.maxY.toFixed(1)})`,
    );
  }
  if (i === 11 && polys.length > 12) console.log(`  ... 其余 ${polys.length - 12} 环略`);
});
console.log(`  合计: 外环(CCW)=${ccw}, 内孔(CW)=${cw}`);
console.log(
  `  整体 bbox: (${bb.minX.toFixed(2)},${bb.minY.toFixed(2)})~(${bb.maxX.toFixed(2)},${bb.maxY.toFixed(2)})  宽=${(bb.maxX - bb.minX).toFixed(2)}mm 高=${(bb.maxY - bb.minY).toFixed(2)}mm`,
);
console.log('');

// 2) 六字环形圆章
const ring = ringTextPolygons({
  text: '印章工坊二号',
  font,
  fontSizeMm: 5,
  letterSpacingMm: 0.6,
  radiusMm: 15,
  startDeg: 90,
  spanDeg: 300,
});
const chk = ringSelfCheck(ring, 15);
console.log('=== 六字环形（r=15mm, span=300°）===');
console.log('字数:', ring.positions.length, 'fits:', ring.fits, `usedSpan=${ring.usedSpanDeg.toFixed(1)}°`);
console.log('字心同半径:', chk.sameRadius, ` 相邻最小中心角差=${chk.minCenterGapDeg.toFixed(1)}°`);
console.log(
  '  位置:',
  ring.positions.map((q) => `${q.char}@${q.angleDeg.toFixed(1)}°`).join('  '),
);
console.log('');

// 3) 四字回文
const hw = huiwenTextPolygons({ text: '印章工坊', font, fontSizeMm: 8, gapMm: 1.5 });
console.log('=== 四字回文 ===');
console.log('isFour:', hw.isFour);
console.log(
  '  槽位:',
  hw.positions.map((q) => `${q.char}→${q.slot}(${q.x.toFixed(1)},${q.y.toFixed(1)})`).join('  '),
);
