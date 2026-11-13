/**
 * 几何回归测试：填充规则 / 孔保留 / 最小笔画与间隙落地 / 校验高亮。
 * 跑法：node --experimental-strip-types scripts/geometry-regression.ts
 *
 * 覆盖 crosssection.ts:69 的问题：
 *   20×20 方框挖 10×10 孔，保留环方向 + NonZero 后面积必须仍是 300（不是 400）。
 */
import { createDefaultSpec, BODY_STYLES as SPEC_BODY_STYLES } from '../src/core/spec.ts';
import { BODY_STYLES, loadBody, setBodyReader } from '../src/geometry/body-library.ts';
import type { BodyStyleId } from '../src/geometry/body-library.ts';
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
import { lastBuildStats } from '../src/geometry/pipeline.ts';
import { SealGeometryError } from '../src/geometry/types.ts';
import type { Contour, Polygon2D, SolidMesh, Vec2 } from '../src/geometry/types.ts';
import { readFileSync } from 'node:fs';

let failed = 0;
function check(ok: boolean, label: string, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) failed++;
}

const kit: ManifoldKit = await getManifold();
const spec = createDefaultSpec();
// 参数化测试片（plate）：这些基础用例测的是截面/布尔/校验，不该被内置模型影响
(spec.body as { styleId?: string }).styleId = 'plate';

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

/* ---------- 4c. ridge.min / gap.min 共用同一个「设计→已焊到」补语 ---------- */
// 文案路径单元测试：拿原始 0.25mm 截面 + 一条「闭运算前是 0.15mm」的记录，
// 两档都要拼出同一条补语。（端到端那条由 lab print-check 的真字形用例覆盖。）
const noteSection = await sectionFromPolygons(bars);
const noteReport = {
  minStrokeWidthMm: null,
  minGapWidthMm: 0.25,
  thickenedMm: 0,
  weldedGapAreaMm2: 0.69,
  areaBeforeMm2: 52.1,
  gapBeforeMm: 0.15,
  simplifyMm: 0.02,
  notes: [],
};
const noteRidge = checkPrintability({
  section: noteSection,
  solid: null,
  body: spec.body,
  relief: spec.relief,
  print: spec.print,
  prepare: noteReport,
}).find((v) => v.rule === 'ridge.min');
check(
  (noteRidge?.message ?? '').includes('设计间隙 0.15mm') && (noteRidge?.message ?? '').includes('已焊到 0.25mm'),
  'ridge.min 文案带「设计间隙 0.15 → 已焊到 0.25」',
  noteRidge?.message ?? '无',
);
// 把 minStroke 压到 0.2，同一个截面落到 gap.min 那一档，验证它用的是同一条文案
const noteGap = checkPrintability({
  section: noteSection,
  solid: null,
  body: spec.body,
  relief: spec.relief,
  print: { ...spec.print, minStrokeMm: 0.2, minGapMm: 0.6 },
  prepare: noteReport,
}).find((v) => v.rule === 'gap.min');
check(
  (noteGap?.message ?? '').includes('设计间隙 0.15mm') && (noteGap?.message ?? '').includes('已焊到 0.25mm'),
  'gap.min 文案带同一条「设计间隙 → 已焊到」补语',
  noteGap?.message ?? '无',
);
// 没有 prepare 记录时必须整句省略，且不许改判据
const noteNone = checkPrintability({
  section: noteSection,
  solid: null,
  body: spec.body,
  relief: spec.relief,
  print: spec.print,
}).find((v) => v.rule === 'ridge.min');
check(
  noteNone !== undefined && !(noteNone.message ?? '').includes('设计间隙'),
  '没有 prepare 记录时整句省略（判据不变）',
  noteNone?.message ?? '无',
);
noteSection.delete();

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


/* ---------- 7. 打印取向：face-up 只对阳刻有意义 ---------- */
const baseSpec = createDefaultSpec();
(baseSpec.body as { styleId?: string; handle?: string }).styleId = 'plate';
(baseSpec.body as { handle?: string }).handle = 'none';
const plateThickness = (body: { thicknessMm?: number; baseThicknessMm: number }): number =>
  body.thicknessMm ?? body.baseThicknessMm;
const sealRect: Polygon2D = { outer: rect(-6, -2, 6, 2), holes: [] };

const raisedSpec = { ...baseSpec, relief: { ...baseSpec.relief, mode: 'raised' as const, depthMm: 1.2 } };
const faceDown = await buildSeal(raisedSpec, [sealRect]);
const bridgeDown = (faceDown.violations ?? []).find((v) => v.rule === 'bridge.span');
check(bridgeDown?.severity === 'error', '阳刻+FDM：底板整片悬空 → bridge.span error', `severity=${bridgeDown?.severity}`);

const faceUpSpec = { ...raisedSpec, orientation: 'face-up' as const };
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
  Math.abs(range.max - (raisedSpec.relief.depthMm + plateThickness(baseSpec.body))) < 0.05,
  'face-up：高度 = depth + 测试片厚度',
  `${range.max} vs ${raisedSpec.relief.depthMm + plateThickness(baseSpec.body)}`,
);
check(
  !(faceUp.violations ?? []).some((v) => v.rule === 'bridge.span'),
  'face-up：没有水平悬空面',
  (faceUp.violations ?? []).map((v) => v.rule).join(',') || '无',
);

// 阴刻本来就是盖印面贴床，翻面只会把它倒过来 → 必须拒绝
let threw = false;
let threwStatus = '';
try {
  await buildSeal({ ...baseSpec, relief: { ...baseSpec.relief, mode: 'engraved' as const }, orientation: 'face-up' }, [
    sealRect,
  ]);
} catch (error) {
  threw = true;
  threwStatus = error instanceof SealGeometryError ? error.status : String(error);
}
check(threw && threwStatus === 'FaceUpRequiresRaised', 'face-up + 阴刻：抛 FaceUpRequiresRaised', threwStatus);


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
/* ---------- 12. 外部主体库：4 个用户模型 ---------- */
// 浏览器里按 BASE_URL fetch；Node 这里用一个只服务 `/xxx` 的 fetch 顶掉（字体也从 public 读）
const nativeFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith('/')) {
    const bytes = readFileSync(new URL(`../public${url}`, import.meta.url));
    return new Response(bytes, { status: 200 });
  }
  return nativeFetch(input, init);
}) as typeof fetch;

/**
 * 近似「印章工坊」四字的图案：4 个 6mm 方框，各带内孔 + 一根竖笔。
 *
 * 这里不用真字形是有原因的：`src/core/layout-bridge.ts` 里 `import '../layout/fonts'`
 * 少了 `.ts` 后缀，Node 的 ESM 解析器直接报 ERR_MODULE_NOT_FOUND（Vite 能容错）。
 * 那属于核心层，不在本文件的改动范围；真字形的端到端覆盖放在浏览器 lab 里做。
 * 对「外部主体」这几条断言来说，图案只要有孔、有细笔、面积够刻就行。
 */
function textLikePolygons(): Polygon2D[] {
  const glyphs: Polygon2D[] = [];
  const boxes = [-10.5, -3.5, 3.5, 10.5];
  for (const cx of boxes) {
    glyphs.push({ outer: rect(cx - 2.5, -3, cx + 2.5, 3), holes: [rect(cx - 1.3, -1.3, cx + 1.3, 1.3, false)] });
    glyphs.push({ outer: rect(cx - 0.35, -2.6, cx + 0.35, 2.6), holes: [] });
  }
  return glyphs;
}

function meshBounds(mesh: SolidMesh) {
  const { vertProperties, numProp } = mesh;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < vertProperties.length; i += numProp) {
    for (let k = 0; k < 3; k++) {
      const value = vertProperties[i + k]!;
      if (value < min[k]!) min[k] = value;
      if (value > max[k]!) max[k] = value;
    }
  }
  return { min, max };
}

function meshVolume(mesh: SolidMesh): number {
  const { vertProperties, triVerts, numProp } = mesh;
  let volume = 0;
  for (let t = 0; t < triVerts.length; t += 3) {
    const ia = triVerts[t]! * numProp;
    const ib = triVerts[t + 1]! * numProp;
    const ic = triVerts[t + 2]! * numProp;
    const ax = vertProperties[ia]!, ay = vertProperties[ia + 1]!, az = vertProperties[ia + 2]!;
    const bx = vertProperties[ib]!, by = vertProperties[ib + 1]!, bz = vertProperties[ib + 2]!;
    const cx = vertProperties[ic]!, cy = vertProperties[ic + 1]!, cz = vertProperties[ic + 2]!;
    volume += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return volume;
}

const SIZE_MM = 30;
const librarySpec = (styleId: BodyStyleId) => ({
  ...engravedSpecMini,
  body: { ...baseSpec.body, sizeMm: SIZE_MM, styleId },
  print: { ...spec.print, process: 'fdm' as const, minStrokeMm: 0.4, minGapMm: 0.3 },
});

for (const style of BODY_STYLES) {
  const sealSpec = librarySpec(style.id);
  const polygons = textLikePolygons();
  const mesh = await buildSeal(sealSpec, polygons);
  const b = meshBounds(mesh);
  const footprint = Math.max(b.max[0]! - b.min[0]!, b.max[1]! - b.min[1]!);
  const height = b.max[2]! - b.min[2]!;

  // 母体（同尺寸缩放后）的体积，用来证明图案真的刻进去了
  const mother = await loadBody(style.id);
  const motherBox = mother.boundingBox();
  const footprintCm = Math.max(motherBox.max[0] - motherBox.min[0], motherBox.max[1] - motherBox.min[1]);
  const scale = SIZE_MM / footprintCm;
  const scaledMother = mother.scale([scale, scale, scale]);
  const motherVolume = scaledMother.volume();
  scaledMother.delete();

  // 期望高度：源模型高度（源单位）× 同一个 scale
  const expectedHeight = style.sourceBoxCm.z * scale;

  check(mesh.status === 'NoError', `${style.label}：status NoError`, `${mesh.status}`);
  check(mesh.triangleCount < 20000, `${style.label}：面数 < 2 万`, `${mesh.triangleCount} 面`);
  check(
    Math.abs(footprint - SIZE_MM) < 0.2,
    `${style.label}：底面足迹 ≈ ${SIZE_MM}mm`,
    `${footprint.toFixed(2)}mm（源 ${style.sourceBoxCm.x}cm × ${scale.toFixed(3)}）`,
  );
  check(
    Math.abs(height - expectedHeight) < 0.5,
    `${style.label}：高度 ≈ 源比例 × scale`,
    `${height.toFixed(2)}mm vs 期望 ${expectedHeight.toFixed(2)}mm`,
  );
  check(Math.abs(b.min[2]!) < 0.05, `${style.label}：底面贴 z=0`, `zMin=${b.min[2]!.toFixed(3)}`);
  check(
    meshVolume(mesh) < motherVolume - 1,
    `${style.label}：刻完体积小于母体（真刻进去了）`,
    `${meshVolume(mesh).toFixed(1)} < ${motherVolume.toFixed(1)} mm³（刻掉 ${(motherVolume - meshVolume(mesh)).toFixed(1)}）`,
  );
  check(
    !(mesh.violations ?? []).some((v) => v.severity === 'error'),
    `${style.label}：没有阻断导出的 error`,
    (mesh.violations ?? []).map((v) => `${v.severity}:${v.rule}`).join(',') || '无',
  );

  // 回传：章面形状 / 实际足迹 / 实际总高（UI 面板靠这三个）
  const stats = lastBuildStats();
  check(
    stats?.faceShape === style.faceShape,
    `${style.label}：回传 faceShape = ${style.faceShape}`,
    `faceShape=${stats?.faceShape}`,
  );
  check(
    Math.abs((stats?.faceSizeMm ?? 0) - SIZE_MM) < 0.2,
    `${style.label}：回传 faceSizeMm ≈ ${SIZE_MM}mm`,
    `faceSizeMm=${stats?.faceSizeMm?.toFixed(2)}`,
  );
  check(
    Math.abs((stats?.heightMm ?? 0) - expectedHeight) < 0.5,
    `${style.label}：回传 heightMm ≈ ${expectedHeight.toFixed(2)}mm`,
    `heightMm=${stats?.heightMm?.toFixed(2)}`,
  );
}

/* ---------- 12b. 圆章出界要报错，不能静默削掉 ---------- */
{
  const circleSpec = librarySpec('classic'); // classic 是圆章
  // 30mm 圆章半径 15mm；这条矩形最远点 hypot(16,2)=16.1mm，已经出圆
  const outOfCircle: Polygon2D[] = [{ outer: rect(12, -2, 16, 2), holes: [] }];
  const mesh = await buildSeal(circleSpec, outOfCircle);
  const bounds = (mesh.violations ?? []).find((v) => v.rule === 'pattern.bounds');
  check(
    bounds?.severity === 'error' && (bounds.measured ?? 0) > 15,
    '圆章：图案超出圆形边界 → pattern.bounds error',
    `severity=${bounds?.severity} measured=${bounds?.measured} limit=${bounds?.limit}`,
  );

  // 对照：同一图案放进方章（column）不该报
  const squareSpec = librarySpec('column');
  const squareMesh = await buildSeal(squareSpec, [{ outer: rect(-2, -2, 2, 2), holes: [] }]);
  check(
    !(squareMesh.violations ?? []).some((v) => v.rule === 'pattern.bounds'),
    '方章：同样的图案不误报 pattern.bounds',
    (squareMesh.violations ?? []).map((v) => v.rule).join(',') || '无',
  );
}

/* ---------- 12c. 总高上限：取小 + 明确提示 ---------- */
{
  const tallSpec = {
    ...librarySpec('cylinder'),
    body: { ...baseSpec.body, sizeMm: 30, styleId: 'cylinder' as const, maxHeightMm: 30 },
  };
  const mesh = await buildSeal(tallSpec, textLikePolygons());
  const stats = lastBuildStats();
  check(mesh.status === 'NoError', '总高上限：仍然 NoError', mesh.status);
  check(
    Math.abs((stats?.heightMm ?? 0) - 30) < 0.5,
    '总高上限：总高被压到 30mm',
    `heightMm=${stats?.heightMm?.toFixed(2)}`,
  );
  check(
    Math.abs((stats?.faceSizeMm ?? 0) - 13.9) < 0.5,
    '总高上限：足迹随之缩到 ≈13.9mm（圆柱）',
    `faceSizeMm=${stats?.faceSizeMm?.toFixed(2)}`,
  );
  const note = (mesh.violations ?? []).find((v) => v.rule === 'size.range' && v.message.includes('总高上限'));
  check(
    note !== undefined && note.severity === 'info',
    '总高上限：给出提示（不默默缩小）',
    note?.message.slice(0, 70) ?? '无提示',
  );
}

/* ---------- 12d. 章面上限 100mm ---------- */
{
  const bigSpec = {
    ...engravedSpecMini,
    body: { ...baseSpec.body, sizeMm: 100, cornerRadiusMm: 2, border: { style: 'none' as const, widthMm: 1.2, insetMm: 1.2 } },
  };
  const big = await buildSeal(bigSpec, [{ outer: rect(-6, -2, 6, 2), holes: [] }]);
  check(big.status === 'NoError', '100mm 章面：能出 NoError 实体', `${big.triangleCount} 面 ${big.status}`);
  const thin = (big.violations ?? []).find((v) => v.rule === 'base.thickness');
  check(
    thin?.severity === 'warn' && (thin.measured ?? 0) > 25,
    '100mm 章面 + 2.5mm 底板：有跨厚比提示',
    `measured=${thin?.measured} ${thin?.message.slice(0, 50) ?? '无'}`,
  );
  // 加厚底板后不该再提示
  const thick = await buildSeal(
    { ...bigSpec, body: { ...bigSpec.body, baseThicknessMm: 4.5 } },
    [{ outer: rect(-6, -2, 6, 2), holes: [] }],
  );
  check(
    !(thick.violations ?? []).some((v) => v.rule === 'base.thickness'),
    '100mm 章面 + 4.5mm 底板：跨厚比提示消失',
    (thick.violations ?? []).map((v) => v.rule).join(',') || '无',
  );
}

/* ---------- 12e. 测试片：方 / 圆 / 正六边形，厚 3.00 ---------- */
for (const [label, shape, sides] of [
  ['方形', 'square', 6],
  ['圆形', 'circle', 6],
  ['正六边形', 'polygon', 6],
] as const) {
  const plateBody = {
    ...baseSpec.body,
    styleId: 'plate' as const,
    shape,
    sides,
    sizeMm: 30,
    baseThicknessMm: 3,
    border: { style: 'none' as const, widthMm: 1.2, insetMm: 1.2 },
  };
  const mesh = await buildSeal({ ...engravedSpecMini, body: plateBody }, textLikePolygons());
  const stats = lastBuildStats();
  const b = meshBounds(mesh);
  check(mesh.status === 'NoError', `测试片${label}：status NoError`, `${mesh.triangleCount} 面 ${mesh.status}`);
  check(
    Math.abs((stats?.heightMm ?? 0) - 3) < 0.05,
    `测试片${label}：厚度 3.00±0.05`,
    `heightMm=${stats?.heightMm?.toFixed(3)}`,
  );
  check(Math.abs(b.min[2]!) < 0.05, `测试片${label}：底面贴 z=0`, `zMin=${b.min[2]!.toFixed(3)}`);
  if (shape !== 'polygon') {
    const footprint = Math.max(b.max[0]! - b.min[0]!, b.max[1]! - b.min[1]!);
    check(
      Math.abs(footprint - 30) < 0.05,
      `测试片${label}：足迹 = 30mm`,
      `${footprint.toFixed(2)}mm`,
    );
  }
}

// 阴阳刻在测试片上都成立：阳刻 zMax = depth + 厚度，阴刻 zMax = 厚度
{
  const plateBody = {
    ...baseSpec.body,
    styleId: 'plate' as const,
    shape: 'square' as const,
    sizeMm: 30,
    baseThicknessMm: 3,
    border: { style: 'none' as const, widthMm: 1.2, insetMm: 1.2 },
  };
  const raisedPlate = await buildSeal(
    { ...baseSpec, body: plateBody, relief: { mode: 'raised' as const, depthMm: 1.2 } },
    textLikePolygons(),
  );
  const rb = meshBounds(raisedPlate);
  check(
    Math.abs(rb.max[2]! - (1.2 + 3)) < 0.05,
    '测试片阳刻：zMax = depth + 厚度',
    `zMax=${rb.max[2]!.toFixed(2)} 期望 ${(1.2 + 3).toFixed(2)}`,
  );
  // 浮雕深超过板厚必须拒绝，不能默默穿底
  let deepError: unknown = null;
  try {
    await buildSeal(
      { ...baseSpec, body: plateBody, relief: { mode: 'raised' as const, depthMm: 3.2 } },
      textLikePolygons(),
    );
  } catch (error) {
    deepError = error;
  }
  check(
    deepError instanceof SealGeometryError && deepError.status === 'ReliefDeeperThanPlate',
    '测试片阳刻：浮雕深 > 板厚 → 抛 ReliefDeeperThanPlate',
    deepError instanceof SealGeometryError ? deepError.status : String(deepError),
  );
}

/* ---------- 12f. 注册表口径：spec 的 heightRatio 必须和 STL 实测一致 ---------- */
{
  for (const style of BODY_STYLES) {
    const declared = SPEC_BODY_STYLES.find((entry) => entry.id === style.id);
    if (declared === undefined) continue;
    const measured = style.sourceBoxCm.z / Math.max(style.sourceBoxCm.x, style.sourceBoxCm.y);
    check(
      Math.abs(declared.heightRatio - measured) / Math.max(1e-6, measured) < 0.02,
      `注册表口径：${style.label} 的 heightRatio 与 STL 实测一致`,
      `spec=${declared.heightRatio} 实测=${measured.toFixed(4)}`,
    );
  }
}

// 负向：把 flipUpsideDown 打开（等于把圆角翻到下面），断言必须响——
// 一条永远不触发的守卫等于没有守卫。
const classicStyle = BODY_STYLES.find((style) => style.id === 'classic')!;
classicStyle.flipUpsideDown = true;
setBodyReader(null); // 传 null 恢复 fetch 并清缓存
let orientationError: unknown = null;
try {
  await loadBody('classic');
} catch (error) {
  orientationError = error;
}
classicStyle.flipUpsideDown = false;
setBodyReader(null);
check(
  orientationError instanceof SealGeometryError && orientationError.status === 'BodyBaseNotFlat',
  '朝向守卫：圆角朝下时抛 BodyBaseNotFlat（不是默默出章）',
  orientationError instanceof SealGeometryError
    ? orientationError.message.slice(0, 70)
    : String(orientationError),
);

/* ---------- 12. 四个内置主体：边框 + 阳刻 ---------- */
setBodyReader(async (style) => {
  const buffer = readFileSync(new URL(`../public/bodies/${style.file}`, import.meta.url));
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
});

const libRect: Polygon2D = { outer: rect(-5, -2, 5, 2), holes: [] };
function libSpec(id: string, mode: 'engraved' | 'raised', borderStyle: 'none' | 'thin' = 'thin', process: 'fdm' | 'resin' = 'fdm') {
  return {
    ...baseSpec,
    body: {
      ...baseSpec.body,
      styleId: id,
      sizeMm: 30,
      handle: 'none' as const,
      border: { style: borderStyle, widthMm: 1.2, insetMm: 1.2 },
    },
    relief: { ...baseSpec.relief, mode, depthMm: 1.2 },
    print: { process, minStrokeMm: process === 'fdm' ? 0.4 : 0.2, minGapMm: process === 'fdm' ? 0.4 : 0.15 },
  } as unknown as Parameters<typeof buildSeal>[0];
}
function meshZ(m: SolidMesh) {
  const p = m.vertProperties;
  const st = m.numProp;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < p.length; i += st) {
    if (p[i + 2]! < lo) lo = p[i + 2]!;
    if (p[i + 2]! > hi) hi = p[i + 2]!;
  }
  return { lo: +lo.toFixed(3), hi: +hi.toFixed(3) };
}

for (const id of ['classic', 'cylinder', 'column', 'dome']) {
  const plain = await buildSeal(libSpec(id, 'engraved', 'none'), [libRect]);
  const bordered = await buildSeal(libSpec(id, 'engraved', 'thin'), [libRect]);
  check(bordered.status === 'NoError' && bordered.triangleCount > plain.triangleCount, `${id}：边框接入实体（面数增加）`, `${plain.triangleCount} → ${bordered.triangleCount}`);

  const raised = await buildSeal(libSpec(id, 'raised'), [libRect]);
  const zr = meshZ(raised);
  check(raised.status === 'NoError' && zr.lo === 0, `${id}：阳刻可生成且贴床 z=0`, JSON.stringify(zr));
  const fdmVerdict = (raised.violations ?? []).filter((v) => v.rule === 'bridge.span');
  check(fdmVerdict.length === 0 || fdmVerdict.every((v) => v.severity === 'error'), `${id}：阳刻+FDM 若报 bridge.span 必须是 error（不能当可打印）`, fdmVerdict.map((v) => v.severity).join(','));

  const raisedResin = await buildSeal(libSpec(id, 'raised', 'thin', 'resin'), [libRect]);
  const resinVerdict = (raisedResin.violations ?? []).filter((v) => v.rule === 'bridge.span');
  check(raisedResin.status === 'NoError' && resinVerdict.every((v) => v.severity !== 'error'), `${id}：阳刻+树脂不阻断`, resinVerdict.map((v) => v.severity).join(',') || '无');
}
/* ---------- 12h. 外部主体：边框宽度真进几何 + 阳刻总高预算 ---------- */
{
  const classic = BODY_STYLES.find((style) => style.id === 'classic')!;
  // 用实测包围盒算比例，不用注册表里四舍五入过的 sourceBoxCm（2.03 vs 2.033）
  const mother = await loadBody(classic.id);
  const motherBox = mother.boundingBox();
  const motherFootCm = Math.max(motherBox.max[0] - motherBox.min[0], motherBox.max[1] - motherBox.min[1]);
  const motherHeightCm = motherBox.max[2] - motherBox.min[2];
  const motherHeightMm = motherHeightCm * (SIZE_MM / motherFootCm);

  // 边框宽度必须真的改变几何：0.8 与 1.6 刻掉的材料差一个环面积。
  // 只比面数不可靠（同一圈环换宽度拓扑可能不变），所以比体积。
  const atWidth = async (widthMm: number) => {
    const base = libSpec('classic', 'engraved', 'thin');
    const spec = { ...base, body: { ...base.body, border: { style: 'thin' as const, widthMm, insetMm: 1.2 } } };
    return await buildSeal(spec, [libRect]);
  };
  const w08 = await atWidth(0.8);
  const w16 = await atWidth(1.6);
  const v08 = meshVolume(w08);
  const v16 = meshVolume(w16);
  check(
    v08 - v16 > 30,
    '外部主体 · 边框宽度 0.8 vs 1.6 确实变了（体积差一个环）',
    `0.8: ${v08.toFixed(0)} / 1.6: ${v16.toFixed(0)} mm³（差 ${(v08 - v16).toFixed(0)}）`,
  );

  // 阳刻：总高 = depth + 源比例高度（抬高那段必须真的在实体里）
  const raised = await buildSeal(libSpec('classic', 'raised', 'none'), [libRect]);
  const rz = meshZ(raised);
  check(
    Math.abs(rz.hi - (1.2 + motherHeightMm)) < 0.05,
    '外部主体 · 阳刻：总高 = depth + 源比例高度',
    `${rz.hi.toFixed(2)} vs ${(1.2 + motherHeightMm).toFixed(2)}`,
  );

  // 总高预算必须扣掉阳刻抬高：上限 30 → 母体只有 28.8 可长
  const cappedBase = libSpec('classic', 'raised', 'none');
  const capped = await buildSeal(
    { ...cappedBase, body: { ...cappedBase.body, maxHeightMm: 30 } },
    [libRect],
  );
  const cappedStats = lastBuildStats();
  check(
    Math.abs((cappedStats?.heightMm ?? 0) - 30) < 0.05,
    '外部主体 · 阳刻 + 总高上限：抬高那段也计入预算（总高正好 30）',
    `heightMm=${cappedStats?.heightMm?.toFixed(2)}`,
  );
  const expectedFaceMm = ((30 - 1.2) / motherHeightCm) * motherFootCm;
  check(
    Math.abs((cappedStats?.faceSizeMm ?? 0) - expectedFaceMm) < 0.2,
    '外部主体 · 阳刻 + 总高上限：足迹按 (上限 − 抬高) 反推',
    `faceSizeMm=${cappedStats?.faceSizeMm?.toFixed(2)} vs ${expectedFaceMm.toFixed(2)}`,
  );
  const cappedNote = (capped.violations ?? []).find(
    (v) => v.rule === 'size.range' && v.message.includes('总高上限'),
  );
  check(
    cappedNote?.message.includes('阳刻抬高') === true,
    '外部主体 · 阳刻 + 总高上限：文案说清「其中 1.2mm 是阳刻抬高」',
    cappedNote?.message.slice(0, 80) ?? '无 size.range 提示',
  );
}

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
