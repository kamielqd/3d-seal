/**
 * 几何回归测试：填充规则 / 孔保留 / 最小笔画与间隙落地 / 校验高亮。
 * 跑法：node --experimental-strip-types scripts/geometry-regression.ts
 *
 * 覆盖 crosssection.ts:69 的问题：
 *   20×20 方框挖 10×10 孔，保留环方向 + NonZero 后面积必须仍是 300（不是 400）。
 */
import { createDefaultSpec } from '../src/core/spec.ts';
import { buildSeal } from '../src/geometry/pipeline.ts';
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

/* ---------- 4. 间隙：两条 0.5mm 宽、间隔 0.25mm ---------- */
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
const gap = gapViolations.find((v) => v.rule === 'gap.min');
check(gap !== undefined, '0.25mm 间隙被 gap.min 捕获', gap?.message ?? '未捕获');
check(Boolean(gap?.highlight?.polygons?.length), 'gap.min 带高亮多边形', `polygons=${gap?.highlight?.polygons?.length ?? 0}`);
gapSection.delete();

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

/* ---------- 9. 图像描摹：方向 / 孔 / 空结果 / 图层放置 ---------- */
function bitmap(w: number, h: number, ink: (x: number, y: number) => boolean): ImageDataLike {
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
