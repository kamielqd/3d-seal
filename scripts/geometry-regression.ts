/**
 * 几何回归测试：填充规则 / 孔保留 / 最小笔画与间隙落地 / 校验高亮。
 * 跑法：node --experimental-strip-types scripts/geometry-regression.ts
 *
 * 覆盖 crosssection.ts:69 的问题：
 *   20×20 方框挖 10×10 孔，保留环方向 + NonZero 后面积必须仍是 300（不是 400）。
 */
import { createDefaultSpec } from '../src/core/spec.ts';
import { borderPolygons, borderSection, bodySection, buildSeal } from '../src/geometry/pipeline.ts';
import { TraceEmptyError, combinePolygons, traceImageData, traceLayer } from '../src/geometry/trace.ts';
import type { ImageDataLike } from '../src/geometry/trace.ts';
import { createImageLayer } from '../src/core/spec.ts';
import {
  getManifold,
  prepareSectionWithReport,
  sectionFromContours,
  sectionFromPolygons,
  unionContours,
} from '../src/geometry/crosssection.ts';
import type { ManifoldKit } from '../src/geometry/crosssection.ts';
import { measureMinStrokeRaster } from '../src/geometry/raster.ts';
import { repairSelfIntersections } from '../src/geometry/polygon.ts';
import { checkPrintability } from '../src/geometry/printability.ts';
import type { Contour, Polygon2D, Vec2 } from '../src/geometry/types.ts';

let failed = 0;
function check(ok: boolean, label: string, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) failed++;
}

const kit: ManifoldKit = await getManifold();
const spec = createDefaultSpec();

function rect(x0: number, y0: number, x1: number, y1: number, ccw = true): Contour {
  const pts: Vec2[] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  return ccw ? pts : pts.slice().reverse();
}

type CS = InstanceType<ManifoldKit['CrossSection']>;
function areaOf(section: CS): number {
  const a = section.isEmpty() ? 0 : section.area();
  section.delete();
  return a;
}

/* ---------- 1. 填充规则：孔必须保留 ---------- */
const outer = rect(-10, -10, 10, 10, true);
const hole = rect(-5, -5, 5, 5, false); // 内孔 CW

const contoursArea = areaOf(await sectionFromContours([outer, hole]));
check(Math.abs(contoursArea - 300) < 0.5, 'sectionFromContours 保留孔（NonZero）', `${contoursArea.toFixed(2)}mm²（期望 300，填实=400）`);

const polygonsArea = areaOf(await sectionFromPolygons([{ outer, holes: [hole] }]));
check(Math.abs(polygonsArea - 300) < 0.5, 'sectionFromPolygons 保留孔', `${polygonsArea.toFixed(2)}mm²`);

/* ---------- 2. 自交修复路径（实际触发点） ---------- */
const repaired = repairSelfIntersections({ outer, holes: [hole] }, (contours) => {
  const section = new kit.CrossSection(
    contours.map((c) => c.map(([x, y]) => [x, y] as [number, number])),
    'NonZero',
  );
  const polys = section.toPolygons();
  section.delete();
  return polys.map((p) => p.map(([x, y]) => [x, y] as Vec2));
});
check(
  repaired.length === 1 && repaired[0]!.holes.length === 1,
  'repairSelfIntersections 保留 1 外环 + 1 孔',
  `polys=${repaired.length}, holes=${repaired[0]?.holes.length ?? 0}`,
);

/* ---------- 3. 最小笔画：0.3mm 细条 ---------- */
const thin: Polygon2D = { outer: rect(-0.15, -3, 0.15, 3), holes: [] };
const thinSection = await sectionFromPolygons([thin]);
const measured = measureMinStrokeRaster(thinSection, { limitMm: 1 });
check(Math.abs(measured.sizeMm - 0.3) < 0.06, 'measureMinStroke 测出 0.3mm', `${measured.sizeMm.toFixed(3)}mm`);
thinSection.delete();

const preparedThin = await prepareSectionWithReport([thin], { minStrokeMm: 0.4, minGapMm: 0.4, simplifyMm: 0 });
const after = measureMinStrokeRaster(preparedThin.section, { limitMm: 1 });
check(after.sizeMm >= 0.38, 'prepareSection 把 0.3mm 外扩到 ≥0.4mm', `厚度 ${after.sizeMm.toFixed(3)}mm，外扩 ${preparedThin.report.thickenedMm.toFixed(3)}mm`);

const thinViolations = checkPrintability({
  section: preparedThin.section,
  solid: null,
  body: spec.body,
  relief: spec.relief,
  print: spec.print,
  prepare: preparedThin.report,
});
check(
  !thinViolations.some((v) => v.rule === 'stroke.min'),
  '外扩后 stroke.min 不再告警',
  `violations=${thinViolations.map((v) => v.rule).join(',') || '无'}`,
);
preparedThin.section.delete();

/* ---------- 4. 宽度去重：gap < minStroke → ridge.min，不再出 gap.min ---------- */
const bars: Polygon2D[] = [
  { outer: rect(-1.25, -3, -0.75, 3), holes: [] },
  { outer: rect(-0.5, -3, 0, 3), holes: [] },
];
const gapSection = await sectionFromPolygons(bars);
const gapViolations = checkPrintability({
  section: gapSection,
  solid: null,
  body: spec.body,
  relief: spec.relief,
  print: spec.print,
});
const ridge = gapViolations.find((v) => v.rule === 'ridge.min');
check(
  ridge !== undefined && ridge.severity === 'info' && Math.abs(ridge.measured - 0.25) < 0.06,
  '0.25mm 间隙（< minStroke）由 ridge.min 捕获（info）',
  `rule=${ridge?.rule ?? '无'} severity=${ridge?.severity ?? '-'} measured=${ridge?.measured ?? '-'}`,
);
check(
  !gapViolations.some((v) => v.rule === 'gap.min'),
  '同一处宽度不再重复出 gap.min',
  gapViolations.map((v) => v.rule).join(',') || '无',
);
check(Boolean(ridge?.highlight?.polygons?.length), 'ridge.min 带高亮多边形', `polygons=${ridge?.highlight?.polygons?.length ?? 0}`);
gapSection.delete();

/* ---------- 4b. minStroke ≤ gap < minGap → 只出 gap.min（info） ---------- */
const wideBars: Polygon2D[] = [
  { outer: rect(-1.475, -3, -0.975, 3), holes: [] },
  { outer: rect(-0.525, -3, -0.025, 3), holes: [] },
];
const wideGapSection = await sectionFromPolygons(wideBars);
const wideGapViolations = checkPrintability({
  section: wideGapSection,
  solid: null,
  body: spec.body,
  relief: spec.relief,
  // minGap 拉到 0.6，让 0.45mm 落进「比参考值窄、但还没窄过一条挤出线」的中间带
  print: { ...spec.print, minStrokeMm: 0.4, minGapMm: 0.6 },
});
const gapInfo = wideGapViolations.find((v) => v.rule === 'gap.min');
check(
  gapInfo !== undefined && gapInfo.severity === 'info' && Math.abs(gapInfo.measured - 0.45) < 0.06,
  '0.45mm 间隙（minStroke ≤ gap < minGap）由 gap.min 捕获（info）',
  `rule=${gapInfo?.rule ?? '无'} severity=${gapInfo?.severity ?? '-'} measured=${gapInfo?.measured ?? '-'}`,
);
check(
  !wideGapViolations.some((v) => v.rule === 'ridge.min'),
  '中间带不出 ridge.min',
  wideGapViolations.map((v) => v.rule).join(',') || '无',
);
wideGapSection.delete();

const preparedGap = await prepareSectionWithReport(bars, { minStrokeMm: 0.4, minGapMm: 0.4, simplifyMm: 0 });
check(preparedGap.report.weldedGapAreaMm2 > 0, 'prepareSection 闭运算焊掉窄缝', `${preparedGap.report.weldedGapAreaMm2.toFixed(2)}mm²`);
preparedGap.section.delete();

/* ---------- 5. 「回」：两层环，孔不能填实 ---------- */
const huiPolys: Polygon2D[] = [
  { outer: rect(-10, -10, 10, 10), holes: [rect(-6, -6, 6, 6, false)] },
  { outer: rect(-3, -3, 3, 3), holes: [rect(-1.2, -1.2, 1.2, 1.2, false)] },
];
const huiArea = areaOf(await sectionFromPolygons(huiPolys));
check(Math.abs(huiArea - 286.24) < 0.5, '回字形（两层环）面积正确', `${huiArea.toFixed(2)}mm²（期望 286.24）`);

/* ---------- 6. unionContours：外环 + 孔 → 两条环 ---------- */
const merged = await unionContours([outer, hole]);
check(merged.length === 2, 'unionContours 返回 外环+孔 两条环', `rings=${merged.length}`);


/* ---------- 7. 打印取向：face-up 只允许无手柄 ---------- */
const baseSpec = createDefaultSpec();
const sealRect: Polygon2D = { outer: rect(-6, -2, 6, 2), holes: [] };

const raisedSpec = { ...baseSpec, relief: { ...baseSpec.relief, mode: 'raised' as const, depthMm: 1.2 } };
const faceDown = await buildSeal(raisedSpec, [sealRect]);
const bridgeDown = (faceDown.violations ?? []).find((v) => v.rule === 'bridge.span');
check(bridgeDown?.severity === 'error', '阳刻+FDM+有手柄：bridge.span 升为 error', `severity=${bridgeDown?.severity}`);

const faceUpSpec = { ...raisedSpec, body: { ...raisedSpec.body, handle: 'none' as const }, orientation: 'face-up' as const };
const faceUp = await buildSeal(faceUpSpec, [sealRect]);
const zs = () => {
  const p = faceUp.vertProperties;
  const st = faceUp.numProp;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < p.length; i += st) {
    if (p[i + 2]! < min) min = p[i + 2]!;
    if (p[i + 2]! > max) max = p[i + 2]!;
  }
  return { min: +min.toFixed(4), max: +max.toFixed(3) };
};
const range = zs();
check(range.min === 0, 'face-up：z 最小值 = 0（贴床）', JSON.stringify(range));
check(
  Math.abs(range.max - (raisedSpec.relief.depthMm + raisedSpec.body.baseThicknessMm)) < 0.05,
  'face-up：高度 = depth + 底板厚',
  `${range.max} vs ${baseSpec.relief.depthMm + baseSpec.body.baseThicknessMm}`,
);
check(
  !(faceUp.violations ?? []).some((v) => v.rule === 'bridge.span'),
  'face-up：没有水平悬空面',
  (faceUp.violations ?? []).map((v) => v.rule).join(',') || '无',
);

let threw = false;
try {
  await buildSeal({ ...raisedSpec, orientation: 'face-up' }, [sealRect]);
} catch {
  threw = true;
}
check(threw, 'face-up + 手柄：直接抛错（不允许导出）');


/* ---------- 8. 阴刻 bridge.span 按「最宽单条槽」判，不按面积 ---------- */
const engravedSpec = { ...baseSpec, relief: { ...baseSpec.relief, mode: 'engraved' as const } };
const engraved = await buildSeal(engravedSpec, [sealRect]);
check(
  !(engraved.violations ?? []).some((v) => v.rule === 'bridge.span'),
  '阴刻窄槽（≤4mm）不产生 bridge.span',
  (engraved.violations ?? []).map((v) => v.rule).join(',') || '无',
);

const wideGroove = await buildSeal(engravedSpec, [{ outer: rect(-4, -4, 4, 4), holes: [] }]);
const wide = (wideGroove.violations ?? []).find((v) => v.rule === 'bridge.span');
check(wide?.severity === 'warn' && wide.measured >= 7.5, '阴刻 8mm 宽槽：bridge.span warn 且按槽宽计', `measured=${wide?.measured}`);

/* ---------- 8b. 焊接比例：焊掉太多图案面积才算事故（比料脊宽度有分辨力） ---------- */
const engravedPrint = { ...spec.print, minStrokeMm: 0.4, minGapMm: 0.3 };
const engravedSpecMini = { ...spec, relief: { ...spec.relief, mode: 'engraved' as const, depthMm: 1.2 } };
{
  // 6 根 0.8mm 宽、间隙 0.1mm 的竖条：闭运算会把 5 条缝全焊上，焊掉约 3mm² / 28.8mm² ≈ 10%
  const tightBars: Polygon2D[] = [];
  for (let i = 0; i < 6; i++) {
    const x0 = -3 + i * 0.9;
    tightBars.push({ outer: rect(x0, -3, x0 + 0.8, 3), holes: [] });
  }
  const tightPrep = await prepareSectionWithReport(tightBars, { minStrokeMm: 0.4, minGapMm: 0.3, simplifyMm: 0 });
  const tightViolations = checkPrintability({
    section: tightPrep.section,
    solid: null,
    body: engravedSpecMini.body,
    relief: engravedSpecMini.relief,
    print: engravedPrint,
    prepare: tightPrep.report,
  });
  const weld = tightViolations.find((v) => v.rule === 'weld.ratio');
  check(
    weld?.severity === 'warn' && (weld.measured ?? 0) > 5,
    '焊接比例：6×0.8mm 竖条（缝 0.1mm）→ weld.ratio warn',
    `measured=${weld?.measured}% limit=${weld?.limit}% 焊掉 ${tightPrep.report.weldedGapAreaMm2.toFixed(2)}mm² / 前面积 ${tightPrep.report.areaBeforeMm2.toFixed(2)}mm²`,
  );
  tightPrep.section.delete();

  // 对照：宽松排布（缝 0.5mm）不该报
  const looseBars: Polygon2D[] = [];
  for (let i = 0; i < 6; i++) {
    const x0 = -3 + i * 1.3;
    looseBars.push({ outer: rect(x0, -3, x0 + 0.8, 3), holes: [] });
  }
  const loosePrep = await prepareSectionWithReport(looseBars, { minStrokeMm: 0.4, minGapMm: 0.3, simplifyMm: 0 });
  const looseViolations = checkPrintability({
    section: loosePrep.section,
    solid: null,
    body: engravedSpecMini.body,
    relief: engravedSpecMini.relief,
    print: engravedPrint,
    prepare: loosePrep.report,
  });
  check(
    !looseViolations.some((v) => v.rule === 'weld.ratio'),
    '焊接比例：同样 6 条但缝 0.5mm → 不报 weld.ratio',
    `焊掉 ${loosePrep.report.weldedGapAreaMm2.toFixed(2)}mm² / 前面积 ${loosePrep.report.areaBeforeMm2.toFixed(2)}mm²`,
  );
  loosePrep.section.delete();
}

/* ---------- 8c. 阴刻深宽比按槽宽：0.5 不报（2.4），0.4 报（3.0） ---------- */
for (const [widthMm, shouldWarn] of [
  [0.5, false],
  [0.4, true],
] as const) {
  const grooveSection = await sectionFromPolygons([{ outer: rect(-widthMm / 2, -3, widthMm / 2, 3), holes: [] }]);
  const grooveViolations = checkPrintability({
    section: grooveSection,
    solid: null,
    body: engravedSpecMini.body,
    relief: engravedSpecMini.relief,
    print: engravedPrint,
  });
  const aspect = grooveViolations.find((v) => v.rule === 'groove.aspect');
  check(
    shouldWarn ? aspect !== undefined : aspect === undefined,
    `阴刻 ${widthMm}mm 槽 / 1.2 深（比 ${(1.2 / widthMm).toFixed(1)}）${shouldWarn ? '要报' : '不报'} groove.aspect`,
    `rule=${aspect?.rule ?? '无'} measured=${aspect?.measured ?? '-'} limit=${aspect?.limit ?? '-'}`,
  );
  check(
    !grooveViolations.some((v) => v.rule === 'relief.aspect'),
    `阴刻 ${widthMm}mm 槽不出 relief.aspect（墙规则不判槽）`,
    grooveViolations.map((v) => v.rule).join(',') || '无',
  );
  grooveSection.delete();
}

/* ---------- 9. 图像描摹：方向 / 孔 / 空结果 / 图层放置 ---------- */function bitmap(w: number, h: number, ink: (x: number, y: number) => boolean): ImageDataLike {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      const v = ink(x, y) ? 0 : 255;
      data[p] = v;
      data[p + 1] = v;
      data[p + 2] = v;
      data[p + 3] = 255;
    }
  }
  return { data, width: w, height: h };
}

const square = bitmap(20, 20, (x, y) => x >= 5 && x < 15 && y >= 5 && y < 15);
const squarePolys = await traceImageData(square, { mmPerPx: 1, simplifyMm: 0 });
check(squarePolys.length === 1 && squarePolys[0]!.holes.length === 0, '10×10 方块 → 1 外环无孔', `polys=${squarePolys.length}`);
check(Math.abs(Math.abs(shoelace(squarePolys[0]!.outer)) - 100) < 2, '方块面积 ≈100mm²', `${Math.abs(shoelace(squarePolys[0]!.outer)).toFixed(1)}`);

const donut = bitmap(20, 20, (x, y) => {
  const outer = x >= 3 && x < 17 && y >= 3 && y < 17;
  const inner = x >= 8 && x < 12 && y >= 8 && y < 12;
  return outer && !inner;
});
const donutPolys = await traceImageData(donut, { mmPerPx: 1, simplifyMm: 0 });
check(donutPolys.length === 1 && donutPolys[0]!.holes.length === 1, '甜甜圈 → 1 外环 + 1 孔', `holes=${donutPolys[0]?.holes.length ?? 0}`);

let traceErr: unknown = null;
try {
  await traceImageData(bitmap(20, 20, () => false), { threshold: 0.5 });
} catch (error) {
  traceErr = error;
}
check(traceErr instanceof TraceEmptyError && traceErr.code === 'TRACE_EMPTY', '空图 → TRACE_EMPTY', traceErr instanceof TraceEmptyError ? traceErr.suggestion : String(traceErr));

const layer = createImageLayer('', { anchor: { x: 0.5, y: 0 }, transform: { rotateDeg: 0, scale: 1 } });
const placed = await traceLayer(layer, square, { bodySizeMm: 30 });
const xs = placed.flatMap((p) => p.outer.map(([x]) => x));
check(Math.abs((Math.min(...xs) + Math.max(...xs)) / 2 - 7.5) < 0.2, 'traceLayer：anchor(0.5,0) 把图案中心移到 x=7.5', `center=${((Math.min(...xs) + Math.max(...xs)) / 2).toFixed(2)}`);

const outlineLayer = createImageLayer('', { widthMm: 20, anchor: { x: 0, y: 0 }, transform: { rotateDeg: 0, scale: 1 } });
const ring = await traceLayer(outlineLayer, square, { bodySizeMm: 20, mode: 'outline', outlineWidthMm: 0.6 });
const ringArea = ring.reduce((sum, p) => sum + Math.abs(shoelace(p.outer)) - p.holes.reduce((s, h) => s + Math.abs(shoelace(h)), 0), 0);
check(ringArea > 10 && ringArea < 40, 'outline 模式：实心块变成等宽环', `环面积≈${ringArea.toFixed(1)}mm²`);

check(combinePolygons(squarePolys, placed).length === squarePolys.length + placed.length, 'combinePolygons 扁平合并', '');

/* ---------- 10. 同深度图层重叠 ---------- */
const textGroup = { id: 't1', kind: 'text' as const, polygons: [sealRect] };
const imgGroup = { id: 'i1', kind: 'image' as const, polygons: [{ outer: rect(0, -3, 4, 3), holes: [] }] };
const overlapMesh = await buildSeal(
  { ...engravedSpec, layerGroups: [textGroup, imgGroup] },
  combinePolygons(textGroup.polygons, imgGroup.polygons),
);
const overlap = (overlapMesh.violations ?? []).find((v) => v.rule === 'overlap.samedepth');
check(overlap?.severity === 'warn' && overlap.measured >= 10, '文字/图像同深度重叠 → overlap.samedepth warn', `measured=${overlap?.measured}mm²`);
check(Boolean(overlap?.highlight?.bbox), '重叠提示带高亮框', '');

/* ---------- 11. 边框环 ---------- */
const squareBody = { ...baseSpec.body, cornerRadiusMm: 0 };
const baseSec = bodySection(await getManifold(), squareBody);
const thinRing = borderSection(baseSec, { style: 'thin', widthMm: 1.2, insetMm: 1.2 });
check(thinRing !== null && Math.abs(thinRing.area() - 126.72) < 2, 'thin 边框面积 ≈126.7mm²', thinRing ? `${thinRing.area().toFixed(2)}` : 'null');
thinRing?.delete();
const doubleRing = borderSection(baseSec, { style: 'double', widthMm: 1.2, insetMm: 1.2 });
check(doubleRing !== null && Math.abs(doubleRing.area() - 230.4) < 3, 'double 边框 = 两圈', doubleRing ? `${doubleRing.area().toFixed(2)}` : 'null');
doubleRing?.delete();
check(borderSection(baseSec, { style: 'none', widthMm: 1.2, insetMm: 1.2 }) === null, 'style=none 不生成边框');
const thickRing = borderSection(baseSec, { style: 'thick', widthMm: 1.6, insetMm: 1.2 });
check(thickRing !== null && Math.abs(thickRing.area() - 166.4) < 2, 'thick 按 widthMm=1.6 实算，无隐藏下限', thickRing ? `${thickRing.area().toFixed(1)}mm²` : 'null');
thickRing?.delete();

const previewRing = await borderPolygons(squareBody);
const previewArea = previewRing.reduce(
  (sum, p) => sum + Math.abs(shoelace(p.outer)) - p.holes.reduce((s, h) => s + Math.abs(shoelace(h)), 0),
  0,
);
check(previewRing.length === 1 && Math.abs(previewArea - 126.72) < 2, 'borderPolygons 与实体边框同源同面积', `${previewArea.toFixed(1)}mm²`);
baseSec.delete();

const noBorder = await buildSeal({ ...engravedSpec, body: { ...engravedSpec.body, cornerRadiusMm: 0, border: { style: 'none', widthMm: 1.2, insetMm: 1.2 } } }, [sealRect]);
const withBorder = await buildSeal({ ...engravedSpec, body: { ...engravedSpec.body, cornerRadiusMm: 0, border: { style: 'thin', widthMm: 1.2, insetMm: 1.2 } } }, [sealRect]);
check(withBorder.status === 'NoError' && withBorder.triangleCount > noBorder.triangleCount, '边框参与实体：面数增加且 NoError', `${noBorder.triangleCount} → ${withBorder.triangleCount}`);
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);

function shoelace(contour: readonly [number, number][]): number {
  let sum = 0;
  for (let i = 0; i < contour.length; i++) {
    const a = contour[i]!;
    const b = contour[(i + 1) % contour.length]!;
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return sum / 2;
}
