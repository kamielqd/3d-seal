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
import { layoutFlatWithFit, layoutToGeometryPolygons } from '../src/core/layout-bridge.ts';
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
    body: {
      ...base.body,
      shape: 'square',
      sizeMm,
      cornerRadiusMm: 2,
      // 这个 lab 只验「图案 → 判据」，把手不参与任何一条：显式关掉，
      // 免得每例都多算 4800 个三角面、还让 bridge.span 的面积跟着把手变。
      styleId: 'plate',
    },
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

interface CaseDef {
  id: string;
  text: string;
  sizeMm: number;
  mode: 'raised' | 'engraved';
  fontSizeMm?: number;
  /** 额外的括号说明，比如「自动适应」。 */
  suffix?: string;
}

/**
 * 用例定义：**label 一律从输入算出来，不手写**。
 *
 * 曾经手写成「七字」，字串却是 6 个字（'印章工坊印鉴'），量出 4.88mm 和真机
 * 4.21mm 对不上，白折腾一轮。凡是能从未知输入算出来的，都不要手写。
 */
const CASE_DEFS: CaseDef[] = [
  { id: 'four-30-engraved', text: TEXT, sizeMm: 30, mode: 'engraved' },
  { id: 'two-30-engraved', text: '印章', sizeMm: 30, mode: 'engraved' },
  { id: 'four-40-engraved', text: TEXT, sizeMm: 40, mode: 'engraved' },
  { id: 'two-30-font12', text: '印章', sizeMm: 30, mode: 'engraved', fontSizeMm: 12 },
  { id: 'four-30-raised', text: TEXT, sizeMm: 30, mode: 'raised' },
  // 焊接比例的另一端：章面挤、字号小，字形必然糊在一起
  { id: 'six-25-engraved', text: '印章工坊印鉴', sizeMm: 25, mode: 'engraved', fontSizeMm: 3.5 },
  { id: 'four-20-engraved', text: TEXT, sizeMm: 20, mode: 'engraved', fontSizeMm: 4.5 },
  // 文字自动适应章面：7 个字 7mm 会被等比缩到 ~4mm
  { id: 'seven-30-autofit', text: '印章工坊印鉴藏', sizeMm: 30, mode: 'engraved', suffix: '（自动适应）' },
  // 最小章面尺寸的实测依据：10mm 到底还能不能刻（minSizeMm 现在是 10）
  { id: 'four-10-min', text: TEXT, sizeMm: 10, mode: 'engraved' },
  { id: 'two-10-min', text: '印章', sizeMm: 10, mode: 'engraved' },
];

const CASES: Case[] = CASE_DEFS.map((def) => {
  const fontSizeMm = def.fontSizeMm ?? 7;
  const modeLabel = def.mode === 'engraved' ? '阴刻' : '阳刻';
  return {
    id: def.id,
    label: `${def.text.length}字 / ${def.sizeMm}mm / ${modeLabel} / 字号${fontSizeMm}${def.suffix ?? ''}`,
    spec: makeSpec(def.text, def.sizeMm, def.mode, fontSizeMm),
  };
});

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
  /** prepareSection 的整体外扩量（笔画不足时会被自动加粗）。 */
  thickenedMm: number;
  /** 文字排完后的 XY 半宽（max(|x|,|y|)），用来验 clearance。 */
  textHalfExtentMm: number;
  /** 边框内沿的半宽（章面半宽 − 内缩 − 线宽）。 */
  borderInnerMm: number;
  /** 文字自动适应章面的结果。 */
  fit: { requestedFontMm: number; effectiveFontMm: number; fitted: boolean } | null;
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
    thickenedMm: prepared.report.thickenedMm,
    fit: null,
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
    const { fits } = await layoutFlatWithFit(testCase.spec);
    const autoFit = fits[0] ?? null;
    const polygons = await layoutToGeometryPolygons(testCase.spec);
    const mesh = await buildSeal({ ...testCase.spec, autoFit }, polygons);
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
      textHalfExtentMm: (() => {
        let extent = 0;
        for (const polygon of polygons) {
          for (const ring of [polygon.outer, ...polygon.holes]) {
            for (const [x, y] of ring) {
              extent = Math.max(extent, Math.abs(x), Math.abs(y));
            }
          }
        }
        return extent;
      })(),
      borderInnerMm:
        testCase.spec.body.sizeMm / 2 - testCase.spec.body.border.insetMm - testCase.spec.body.border.widthMm,
      fit:
        autoFit === null
          ? null
          : {
              requestedFontMm: autoFit.requestedFontMm,
              effectiveFontMm: autoFit.effectiveFontMm,
              fitted: autoFit.fitted,
            },
    };
    results.push(result);

    log(`${testCase.label}  ${result.triangles} 面 ${result.status} ${result.ms}ms  块=${result.polygons}`);
    if (result.fit !== null) {
      log(`   字号 ${result.fit.requestedFontMm}mm → ${result.fit.effectiveFontMm.toFixed(2)}mm（fitted=${result.fit.fitted}）`);
    }
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
    {
      name: '七字：自动适应把字号明显缩小（fitted=true 且明显小于设定值）',
      ok: (() => {
        const fit = at('seven-30-autofit')?.fit;
        return fit !== null && fit !== undefined && fit.fitted && fit.effectiveFontMm < fit.requestedFontMm - 0.5;
      })(),
      detail: `字号 ${at('seven-30-autofit')?.fit?.requestedFontMm}mm → ${at('seven-30-autofit')?.fit?.effectiveFontMm.toFixed(2)}mm`,
    },
    {
      name: '七字：缩字号后至少有规则开口（判据没哑）',
      ok: (at('seven-30-autofit')?.violations ?? []).some((v) => v.rule === 'weld.ratio' || v.rule === 'groove.aspect' || v.rule === 'ridge.min'),
      detail: (at('seven-30-autofit')?.violations ?? []).map((v) => `${v.severity}:${v.rule}`).join(',') || '无',
    },
    {
      name: '七字：文案说明「是系统缩的」，且不再建议放大字号',
      ok: (() => {
        const list = at('seven-30-autofit')?.violations ?? [];
        const withAdvice = list.filter((v) => v.rule === 'ridge.min' || v.rule === 'gap.min' || v.rule === 'weld.ratio');
        return (
          withAdvice.length > 0 &&
          withAdvice.every((v) => !v.message.includes('放大字号')) &&
          withAdvice.every((v) => v.message.includes('已自动把字号'))
        );
      })(),
      detail: (at('seven-30-autofit')?.violations ?? []).find((v) => v.rule === 'weld.ratio')?.message ?? '无 weld.ratio',
    },
    {
      name: '四字（没缩过）：文案里不出现「已自动把字号」',
      ok: (four30?.violations ?? []).every((v) => !v.message.includes('已自动把字号')),
      detail: ridge?.message.slice(0, 40) ?? '无',
    },
    {
      name: 'clearance：所有 fitted=true 的用例，文字到边框内沿 ≥ 0.35mm',
      // 最小间隙量不出 clearance（它被字内/字间缝主导），只能直接量几何距离。
      // 这条守住 fitBoxMm 的留边：谁把 margin 改小了，这里立刻红。
      ok: results.every((run) => {
        if (run.fit?.fitted !== true) return true;
        return run.borderInnerMm - run.textHalfExtentMm >= 0.35;
      }),
      detail:
        results
          .filter((run) => run.fit?.fitted === true)
          .map((run) => `${run.label}：${run.borderInnerMm.toFixed(2)} − ${run.textHalfExtentMm.toFixed(2)} = ${(run.borderInnerMm - run.textHalfExtentMm).toFixed(2)}mm`)
          .join(' | ') || '无 fitted 用例',
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
