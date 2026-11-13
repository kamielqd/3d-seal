/* 生成「印章工坊」版式回归基线（得意黑，DEFAULT_TOLERANCE_MM=0.05）。
 * 输出 docs/layout-baseline.json（机器比对）与 docs/layout-baseline.txt（人读）。
 * 后面几何/布尔接上后，用它比对环数、环方向、面积、包围盒是否漂移。
 */
import fs from 'node:fs';
import opentype from 'opentype.js';
import {
  textToPolygons,
  signedArea,
  bounds,
  DEFAULT_TOLERANCE_MM,
  type Polygon2D,
} from '../src/layout/text.ts';
import { ringTextPolygons, ringSelfCheck } from '../src/layout/ring.ts';
import { huiwenTextPolygons } from '../src/layout/huiwen.ts';

function loadFont(): opentype.Font {
  const p = 'public/fonts/smiley-sans/smiley-sans-subset.ttf';
  const buf = fs.readFileSync(p);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return opentype.parse(ab);
}

function ringInfo(pg: Polygon2D, i: number) {
  const b = bounds([pg]);
  const area = signedArea(pg.points);
  return {
    index: i,
    dir: area > 0 ? 'CCW' : 'CW',
    kind: area > 0 ? 'outer' : 'hole',
    points: pg.points.length,
    area: Number(area.toFixed(3)),
    bbox: [
      Number(b.minX.toFixed(3)),
      Number(b.minY.toFixed(3)),
      Number(b.maxX.toFixed(3)),
      Number(b.maxY.toFixed(3)),
    ],
  };
}

const font = loadFont();
const TEXT = '印章工坊';
const FONT_SIZE = 8;
const SPACING = 0.6;

const polys = textToPolygons({
  text: TEXT,
  font,
  fontSizeMm: FONT_SIZE,
  letterSpacingMm: SPACING,
  centerMm: { x: 0, y: 0 },
});
const outer = polys.filter((p) => signedArea(p.points) > 0).length;
const inner = polys.length - outer;
const bb = bounds(polys);

const ring = ringTextPolygons({
  text: '印章工坊二号',
  font,
  fontSizeMm: 5,
  letterSpacingMm: 0.6,
  radiusMm: 15,
  startDeg: 90,
  spanDeg: 300,
});
const ringChk = ringSelfCheck(ring, 15);

const hw = huiwenTextPolygons({ text: TEXT, font, fontSizeMm: 8, gapMm: 1.5 });

const baseline = {
  case: TEXT,
  font: 'smiley-sans',
  toleranceMm: DEFAULT_TOLERANCE_MM,
  textBlocks: { fontSizeMm: FONT_SIZE, letterSpacingMm: SPACING },
  summary: {
    ringCount: polys.length,
    outerCCW: outer,
    innerCW: inner,
    bbox: {
      minX: Number(bb.minX.toFixed(3)),
      minY: Number(bb.minY.toFixed(3)),
      maxX: Number(bb.maxX.toFixed(3)),
      maxY: Number(bb.maxY.toFixed(3)),
      width: Number((bb.maxX - bb.minX).toFixed(3)),
      height: Number((bb.maxY - bb.minY).toFixed(3)),
    },
  },
  rings: polys.map(ringInfo),
  ring6: {
    text: '印章工坊二号',
    chars: ring.positions.length,
    fits: ring.fits,
    usedSpanDeg: Number(ring.usedSpanDeg.toFixed(2)),
    sameRadius: ringChk.sameRadius,
    minCenterGapDeg: Number(ringChk.minCenterGapDeg.toFixed(2)),
  },
  huiwen: {
    isFour: hw.isFour,
    slots: hw.positions.map((q) => ({ char: q.char, slot: q.slot, x: q.x, y: q.y })),
  },
};

fs.mkdirSync('docs', { recursive: true });
fs.writeFileSync('docs/layout-baseline.json', JSON.stringify(baseline, null, 2) + '\n');

const lines: string[] = [];
lines.push(`# 版式回归基线：横排「${TEXT}」（得意黑，tolerance=${DEFAULT_TOLERANCE_MM}mm）`);
lines.push('');
lines.push(`- 环数：${polys.length}（外环 CCW=${outer}，内孔 CW=${inner}）`);
lines.push(
  `- 整体 bbox：(${bb.minX.toFixed(2)},${bb.minY.toFixed(2)})~(${bb.maxX.toFixed(2)},${bb.maxY.toFixed(2)})  宽=${(bb.maxX - bb.minX).toFixed(2)}mm 高=${(bb.maxY - bb.minY).toFixed(2)}mm`,
);
lines.push('');
lines.push('| 环# | 方向 | 点数 | 面积(mm²) | bbox |');
lines.push('|---|---|---|---|---|');
for (const r of baseline.rings) {
  lines.push(
    `| ${r.index} | ${r.dir} | ${r.points} | ${r.area} | (${r.bbox[0]},${r.bbox[1]})~(${r.bbox[2]},${r.bbox[3]}) |`,
  );
}
lines.push('');
lines.push(`六字环：fits=${ring.fits} 同半径=${ringChk.sameRadius} usedSpan=${ring.usedSpanDeg.toFixed(1)}° 最小中心角差=${ringChk.minCenterGapDeg.toFixed(1)}°`);
lines.push(`回文：isFour=${hw.isFour}  槽位=${hw.positions.map((q) => `${q.char}→${q.slot}`).join(' ')}`);
fs.writeFileSync('docs/layout-baseline.txt', lines.join('\n') + '\n');

console.log(`baseline: rings=${polys.length} outer=${outer} inner=${inner} ` +
  `w=${(bb.maxX - bb.minX).toFixed(2)} h=${(bb.maxY - bb.minY).toFixed(2)}`);
console.log('wrote docs/layout-baseline.json and docs/layout-baseline.txt');
