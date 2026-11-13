/**
 * 打印校验验收页（lab 专用，不进正式包）。
 *
 * 用**真实字形**（layout → 几何多边形）+ 真实实体（buildSeal）跑 checkPrintability，
 * 验证四件事：
 *   1. 阴刻的深宽比按槽宽判，不再拿料脊（gap）当槽宽
 *   2. relief.aspect 只在阳刻出
 *   3. 新增 ridge.min：阴刻料脊 < minStroke 时给 warn，且同一处不再出 gap.min
 *   4. 字少了 / 章面大了，ridge.min 消失
 *
 * 结果写进 window.__PRINT_RESULTS__，由 scripts/print-check.mjs 通过 CDP 取走。
 */

import { createDefaultSpec, createTextLayer } from '../src/core/spec.ts';
import type { SealSpec } from '../src/core/spec.ts';
import { layoutToGeometryPolygons } from '../src/core/layout-bridge.ts';
import { bodySection, borderSection, buildSeal } from '../src/geometry/pipeline.ts';
import { getManifold, prepareSectionWithReport, sectionFromPolygons } from '../src/geometry/crosssection.ts';
import { measureMinGapRaster, measureMinStrokeRaster } from '../src/geometry/raster.ts';

const logElement = document.getElementById('log')!;
function log(line: string): void {
  logElement.textContent += `\n${line}`;
}
logElement.textContent = 'running…';

const TEXT = '印章工坊';

function makeSpec(text: string, sizeMm: number, mode: 'raised' | 'engraved', fontSizeMm = 7): SealSpec {
  const base = createDefaultSpec();
  return {
    ...base,
    body: { ...base.body, shape: 'square', sizeMm, cornerRadiusMm: 2 },
    relief: { mode, depthMm: 1.2 },
    layers: [createTextLayer({ text, fontSizeMm, layout: 'horizontal' })],
    print: { ...base.print, process: 'fdm', minStrokeMm: 0.4, minGapMm: 0.3 },
  };
}

interface Case {
  id: string;
  label: string;
  spec: SealSpec;
}

const CASES: Case[] = [
  { id: 'four-30-engraved', label: '四字 / 30mm / 阴刻 / 字号7', spec: makeSpec(TEXT, 30, 'engraved') },
  { id: 'two-30-engraved', label: '两字 / 30mm / 阴刻 / 字号7', spec: makeSpec('印章', 30, 'engraved') },
  { id: 'four-40-engraved', label: '四字 / 40mm / 阴刻 / 字号7', spec: makeSpec(TEXT, 40, 'engraved') },
  { id: 'two-30-font12', label: '两字 / 30mm / 阴刻 / 字号12', spec: makeSpec('印章', 30, 'engraved', 12) },
  { id: 'four-30-raised', label: '四字 / 30mm / 阳刻 / 字号7', spec: makeSpec(TEXT, 30, 'raised') },
  // 焊接比例的另一端：章面挤、字号小，字形必然糊在一起
  { id: 'six-25-engraved', label: '六字 / 25mm / 阴刻 / 字号3.5', spec: makeSpec('印章工坊印鉴', 25, 'engraved', 3.5) },
  { id: 'four-20-engraved', label: '四字 / 20mm / 阴刻 / 字号4.5', spec: makeSpec(TEXT, 20, 'engraved', 4.5) },
];

interface CaseResult {
  id: string;
  label: string;
  triangles: number;
  status: string;
  ms: number;
  polygons: number;
  violations: { rule: string; severity: string; measured: number; limit: number; message: string }[];
  warns: number;
  infos: number;
  errors: number;
  /** 诊断：仅图案（不含边框）的 2D 实测，用来定位间隙来自字形内部还是边框。 */
  rawGap: { sizeMm: number; atLimit: boolean; bbox: [number, number, number, number] | null };
  patternGap: { sizeMm: number; atLimit: boolean; bbox: [number, number, number, number] | null };
  patternStroke: { sizeMm: number; atLimit: boolean };
  /** 诊断：图案 + 边框（与 buildSeal 交给 checkPrintability 的 section 一致）。 */
  mergedGap: { sizeMm: number; atLimit: boolean; bbox: [number, number, number, number] | null };
  /** 闭运算焊接：焊掉面积 / 闭运算前面积。 */
  weld: { weldedMm2: number; areaBeforeMm2: number; ratioPercent: number; gapBeforeMm: number | null };
}

async function diagnose(spec: SealSpec, polygons: Awaited<ReturnType<typeof layoutToGeometryPolygons>>) {
  const kit = await getManifold();
  // 原始字形（闭运算之前）
  const raw = await sectionFromPolygons(polygons);
  const rawGap = measureMinGapRaster(raw, { limitMm: 1.0, gridMm: 0.05 });
  raw.delete();

  const prepared = await prepareSectionWithReport(polygons, { minStrokeMm: 0.4, minGapMm: 0.3, simplifyMm: 0.02 });
  const gap = measureMinGapRaster(prepared.section, { limitMm: 0.4, gridMm: 0.05 });
  const stroke = measureMinStrokeRaster(prepared.section, { limitMm: 0.4, gridMm: 0.05 });

  const face = bodySection(kit, spec.body);
  const ring = borderSection(face, spec.body.border);
  face.delete();
  let mergedGap = { sizeMm: 0, atLimit: true, bbox: null as [number, number, number, number] | null };
  if (ring !== null) {
    const merged = prepared.section.add(ring);
    ring.delete();
    const mergedMeasure = measureMinGapRaster(merged, { limitMm: 0.4, gridMm: 0.05 });
    mergedGap = { sizeMm: mergedMeasure.sizeMm, atLimit: mergedMeasure.atLimit, bbox: mergedMeasure.bbox };
    merged.delete();
  }
  prepared.section.delete();

  return {
    rawGap: { sizeMm: rawGap.sizeMm, atLimit: rawGap.atLimit, bbox: rawGap.bbox },
    patternGap: { sizeMm: gap.sizeMm, atLimit: gap.atLimit, bbox: gap.bbox },
    patternStroke: { sizeMm: stroke.sizeMm, atLimit: stroke.atLimit },
    mergedGap,
    weld: {
      weldedMm2: prepared.report.weldedGapAreaMm2,
      areaBeforeMm2: prepared.report.areaBeforeMm2,
      ratioPercent:
        prepared.report.areaBeforeMm2 > 0
          ? (prepared.report.weldedGapAreaMm2 / prepared.report.areaBeforeMm2) * 100
          : 0,
      gapBeforeMm: prepared.report.gapBeforeMm,
    },
  };
}

async function run(): Promise<void> {
  const results: CaseResult[] = [];

  for (const testCase of CASES) {
    const started = performance.now();
    const polygons = await layoutToGeometryPolygons(testCase.spec);
    const mesh = await buildSeal(testCase.spec, polygons);
    const ms = performance.now() - started;

    const violations = (mesh.violations ?? []).map((v) => ({
      rule: String(v.rule),
      severity: String(v.severity),
      measured: Number(v.measured),
      limit: Number(v.limit),
      message: v.message,
    }));

    const result: CaseResult = {
      id: testCase.id,
      label: testCase.label,
      triangles: mesh.triangleCount,
      status: String(mesh.status),
      ms: Math.round(ms),
      polygons: polygons.length,
      violations,
      warns: violations.filter((v) => v.severity === 'warn').length,
      infos: violations.filter((v) => v.severity === 'info').length,
      errors: violations.filter((v) => v.severity === 'error').length,
      ...(await diagnose(testCase.spec, polygons)),
    };
    results.push(result);

    log(`${testCase.label}  ${result.triangles} 面 ${result.status} ${result.ms}ms  块=${result.polygons}`);
    log(
      `   原始字形缝 ${result.rawGap.sizeMm.toFixed(3)}${result.rawGap.atLimit ? '(≥上限)' : ''}  ` +
        `笔画 ${result.patternStroke.sizeMm.toFixed(3)}${result.patternStroke.atLimit ? '(≥上限)' : ''}  ` +
        `闭运算后缝 ${result.patternGap.sizeMm.toFixed(3)}${result.patternGap.atLimit ? '(≥上限)' : ''}  ` +
        `含边框 ${result.mergedGap.sizeMm.toFixed(3)}${result.mergedGap.atLimit ? '(≥上限)' : ''}`,
    );
    for (const v of violations) {
      log(`   ${v.severity.padEnd(5)} ${v.rule.padEnd(14)} measured=${v.measured} limit=${v.limit}`);
      log(`         ${v.message}`);
    }
  }

  const at = (id: string): CaseResult | undefined => results.find((r) => r.id === id);
  const has = (id: string, rule: string): boolean => (at(id)?.violations ?? []).some((v) => v.rule === rule);
  const ridgeOf = (id: string) => (at(id)?.violations ?? []).find((v) => v.rule === 'ridge.min');

  const four30 = at('four-30-engraved');
  const ridge = ridgeOf('four-30-engraved');
  const warnRules = (four30?.violations ?? []).filter((v) => v.severity === 'warn').map((v) => v.rule);

  const four30raw = at('four-30-engraved')?.rawGap.sizeMm ?? 0;
  const weldOf = (id: string) => (at(id)?.violations ?? []).find((v) => v.rule === 'weld.ratio');
  const checks = [
    {
      name: '默认四字30阴刻：0 条 amber（ridge.min 已降 info）',
      ok: warnRules.length === 0,
      detail: `ambers=[${warnRules.join(',')}] infos=[${(four30?.violations ?? []).filter((v) => v.severity === 'info').map((v) => v.rule).join(',')}]`,
    },
    {
      name: '默认四字30阴刻：提示里有 ridge.min 0.30mm + auto.fix',
      ok: has('four-30-engraved', 'ridge.min') && has('four-30-engraved', 'auto.fix'),
      detail: `ridge=${ridge?.measured} auto.fix=${has('four-30-engraved', 'auto.fix')}`,
    },
    {
      name: 'ridge.min 是 info（不是 warn）',
      ok: ridge?.severity === 'info',
      detail: `severity=${ridge?.severity}`,
    },
    {
      name: 'ridge.min 文案带「设计 X → 已焊到 Y」',
      ok: (ridge?.message ?? '').includes('设计间隙') && (ridge?.message ?? '').includes('已焊到'),
      detail: ridge?.message ?? '无',
    },
    {
      name: '四字30阴刻：原始字形缝 ≈0.15mm（与你的基线一致）',
      ok: four30raw >= 0.1 && four30raw <= 0.2,
      detail: `原始=${four30raw.toFixed(3)}`,
    },
    {
      name: '四字30阴刻：闭运算把 0.15 抬成 ≈0.30（= minGap 量级），报告值来自修复后几何',
      ok: ridge !== undefined && ridge.measured >= 0.25 && ridge.measured <= 0.35,
      detail: `原始=${four30raw.toFixed(3)} → 报告=${ridge?.measured}`,
    },
    {
      name: '默认四字30阴刻：不触发 weld.ratio（1.32% < 5%）',
      ok: weldOf('four-30-engraved') === undefined,
      detail: `焊掉 ${(at('four-30-engraved')?.weld.ratioPercent ?? 0).toFixed(2)}%`,
    },
    {
      name: '六字25mm（字号3.5）：触发 weld.ratio warn',
      ok: weldOf('six-25-engraved')?.severity === 'warn',
      detail: `measured=${weldOf('six-25-engraved')?.measured}% limit=${weldOf('six-25-engraved')?.limit}% 实测 ${(at('six-25-engraved')?.weld.ratioPercent ?? 0).toFixed(2)}%`,
    },
    {
      name: '四字20mm（字号4.5）：也触发 weld.ratio warn',
      ok: weldOf('four-20-engraved')?.severity === 'warn',
      detail: `measured=${weldOf('four-20-engraved')?.measured}% 实测 ${(at('four-20-engraved')?.weld.ratioPercent ?? 0).toFixed(2)}%`,
    },
    {
      name: '四字30阴刻：不再出 gap.min（同一宽度只说一次）',
      ok: !has('four-30-engraved', 'gap.min'),
      detail: (four30?.violations ?? []).map((v) => v.rule).join(',') || '无',
    },
    {
      name: '四字30阴刻：groove.aspect 不因 0.5mm 槽误报（1.2/0.5=2.4 ≤ 2.5）',
      ok: !has('four-30-engraved', 'groove.aspect'),
      detail: (four30?.violations ?? []).find((v) => v.rule === 'groove.aspect')?.message ?? '未报',
    },
    {
      name: '四字30阴刻：relief.aspect 不在阴刻出现（判据对象错了）',
      ok: !has('four-30-engraved', 'relief.aspect'),
      detail: (four30?.violations ?? []).find((v) => v.rule === 'relief.aspect')?.message ?? '未报',
    },
    {
      name: 'ridge.min 与字数/章面/字号无关（两字30、四字40、字号12 都还在 ≈0.30）',
      ok:
        has('two-30-engraved', 'ridge.min') &&
        has('four-40-engraved', 'ridge.min') &&
        has('two-30-font12', 'ridge.min'),
      detail:
        `两字30=${(at('two-30-engraved')?.violations ?? []).find((v) => v.rule === 'ridge.min')?.measured ?? '-'} ` +
        `四字40=${(at('four-40-engraved')?.violations ?? []).find((v) => v.rule === 'ridge.min')?.measured ?? '-'} ` +
        `字号12=${(at('two-30-font12')?.violations ?? []).find((v) => v.rule === 'ridge.min')?.measured ?? '-'}`,
    },
    {
      name: '四字30阳刻：不出 groove.aspect（槽规则只管阴刻）',
      ok: !has('four-30-raised', 'groove.aspect'),
      detail: (at('four-30-raised')?.violations ?? []).map((v) => v.rule).join(',') || '无',
    },
  ];

  const payload = {
    ok: checks.every((c) => c.ok),
    relief: { depthMm: 1.2, minStrokeMm: 0.4, minGapMm: 0.3 },
    results,
    checks,
  };
  (window as unknown as { __PRINT_RESULTS__: unknown }).__PRINT_RESULTS__ = payload;

  log('');
  for (const check of checks) log(`${check.ok ? 'PASS' : 'FAIL'}  ${check.name}  —  ${check.detail}`);
  log(payload.ok ? '\n全部通过' : '\n有失败项');
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
  (window as unknown as { __PRINT_RESULTS__: unknown }).__PRINT_RESULTS__ = { ok: false, error: message };
  log(`ERROR ${message}`);
});
