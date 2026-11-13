/**
 * 图像描摹验收页（只在 lab 构建里出现，不进正式 bundle）。
 *
 * 走的是浏览器真实路径：fetch → createImageBitmap → OffscreenCanvas.getImageData
 * → trace.ts（内置边界追踪 + 二维闭运算）→ 叠回去画对比图。
 *
 * 结果写进 window.__LAB_RESULTS__，由 scripts/trace-lab-check.mjs 通过 CDP 取走。
 */

import lineartUrl from './fixtures/lineart.png?url';
import holesUrl from './fixtures/shape-holes.png?url';
import silhouetteUrl from './fixtures/silhouette-aa.png?url';
import noiseUrl from './fixtures/scan-noise.png?url';

import { traceImageData, lastTraceStats } from '../src/geometry/trace.ts';
import type { TraceStats } from '../src/geometry/trace.ts';
import type { Polygon2D } from '../src/geometry/types.ts';

/** 320px 的图映射到 40mm 章面 → 0.125 mm/px。 */
const MM_PER_PX = 0.125;

const DEFAULTS = {
  autoThreshold: true,
  threshold: 0.5,
  invert: false,
  mmPerPx: MM_PER_PX,
  simplifyMm: 0.08,
  minStrokeMm: 0.4,
  minGapMm: 0.4,
  despeckleAreaMm2: 0.2,
} as const;

type Params = {
  autoThreshold: boolean;
  threshold: number;
  invert: boolean;
  mmPerPx: number;
  simplifyMm: number;
  minStrokeMm: number;
  minGapMm: number;
  despeckleAreaMm2: number;
};

interface Fixture {
  id: string;
  label: string;
  url?: string;
  /** 没有 png 的图用 canvas 现画（抗锯齿边必须是 canvas 生成的才真实）。 */
  draw?: (context: OffscreenCanvasRenderingContext2D, size: number) => void;
}

const FIXTURES: Fixture[] = [
  { id: 'lineart', label: '纯线稿（1~2px 细线）', url: lineartUrl },
  { id: 'shape-holes', label: '实心图形 + 4 个孔', url: holesUrl },
  { id: 'silhouette-aa', label: '抗锯齿/模糊剪影', url: silhouetteUrl },
  { id: 'scan-noise', label: '带噪点扫描件', url: noiseUrl },
  {
    id: 'lineart-aa',
    label: '线稿带灰边（抗锯齿导出）',
    draw: (context, size) => {
      const center = size / 2;
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, size, size);
      context.strokeStyle = '#111111';
      context.lineCap = 'round';
      // 外框
      context.lineWidth = 3;
      context.strokeRect(24, 24, size - 48, size - 48);
      // 圆环 + 辐条：1.2px 细线，边缘必然带灰
      context.lineWidth = 1.2;
      context.beginPath();
      context.arc(center, center, center - 60, 0, Math.PI * 2);
      context.stroke();
      for (let i = 0; i < 4; i++) {
        const angle = (Math.PI / 2) * i + Math.PI / 4;
        context.beginPath();
        context.moveTo(center, center);
        context.lineTo(center + Math.cos(angle) * (center - 60), center + Math.sin(angle) * (center - 60));
        context.stroke();
      }
    },
  },
];

/** 每个图跑几个变体：自动 vs 三档手动，加两个参数敏感度。 */
const VARIANTS: { id: string; label: string; patch: Partial<Params> }[] = [
  { id: 'default', label: 'Otsu（默认）', patch: {} },
  { id: 'manual-0.35', label: '手动 0.35', patch: { autoThreshold: false, threshold: 0.35 } },
  { id: 'manual-0.50', label: '手动 0.50', patch: { autoThreshold: false, threshold: 0.5 } },
  { id: 'manual-0.65', label: '手动 0.65', patch: { autoThreshold: false, threshold: 0.65 } },
  { id: 'simp-fine', label: 'simplify 0.02', patch: { simplifyMm: 0.02 } },
  { id: 'desp-big', label: 'despeckle 1.5', patch: { despeckleAreaMm2: 1.5 } },
];

/** 去噪阈值扫描：看多大面积会开始吞掉真实图元。 */
const DESPECKLE_SWEEP = [0.05, 0.2, 0.5, 1, 1.5, 2, 3];

interface RunResult {
  fixture: string;
  label: string;
  variant: string;
  variantLabel: string;
  autoThreshold: boolean;
  ms: number;
  polygons: number;
  holes: number;
  points: number;
  areaMm2: number;
  thresholdUsed: number;
  otsu: TraceStats['otsu'];
  inkFraction: number;
  droppedAreasMm2: number[];
  keptAreasMm2: number[];
  polygonsData?: Polygon2D[];
}

const logElement = document.getElementById('log')!;
const sheet = document.getElementById('sheet') as HTMLCanvasElement;

function log(line: string): void {
  logElement.textContent += `\n${line}`;
}
logElement.textContent = 'running…';
log('');

async function loadImageData(fixture: Fixture): Promise<{ data: ImageData; width: number; height: number }> {
  if (fixture.draw !== undefined) {
    const size = 320;
    const canvas = new OffscreenCanvas(size, size);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (context === null) throw new Error('拿不到 OffscreenCanvas 2d 上下文');
    fixture.draw(context, size);
    return { data: context.getImageData(0, 0, size, size), width: size, height: size };
  }

  const response = await fetch(fixture.url!);
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (context === null) throw new Error('拿不到 OffscreenCanvas 2d 上下文');
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  return {
    data: context.getImageData(0, 0, canvas.width, canvas.height),
    width: canvas.width,
    height: canvas.height,
  };
}

function polygonArea(polygon: Polygon2D): number {
  const ringArea = (ring: readonly (readonly [number, number])[]): number => {
    let sum = 0;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!;
      const b = ring[(i + 1) % ring.length]!;
      sum += a[0] * b[1] - b[0] * a[1];
    }
    return Math.abs(sum / 2);
  };
  return ringArea(polygon.outer) - polygon.holes.reduce((sum, hole) => sum + ringArea(hole), 0);
}

function polygonPoints(polygon: Polygon2D): number {
  return polygon.outer.length + polygon.holes.reduce((sum, hole) => sum + hole.length, 0);
}

async function runTrace(
  fixture: Fixture,
  image: { data: ImageData; width: number; height: number },
  params: Params,
  label: string,
  variant: string,
  keepPolygons: boolean,
): Promise<RunResult> {
  const started = performance.now();
  const polygons = await traceImageData(image.data, params);
  const ms = performance.now() - started;
  const stats = lastTraceStats();

  const result: RunResult = {
    fixture: fixture.id,
    label: fixture.label,
    variant,
    variantLabel: label,
    ms: Math.round(ms * 10) / 10,
    polygons: polygons.length,
    holes: polygons.reduce((sum, p) => sum + p.holes.length, 0),
    points: polygons.reduce((sum, p) => sum + polygonPoints(p), 0),
    areaMm2: Math.round(polygons.reduce((sum, p) => sum + polygonArea(p), 0) * 10) / 10,
    thresholdUsed: stats?.thresholdUsed ?? params.threshold,
    autoThreshold: params.autoThreshold,
    otsu: stats?.otsu ?? null,
    inkFraction: stats?.inkFraction ?? 0,
    droppedAreasMm2: stats?.droppedAreasMm2 ?? [],
    keptAreasMm2: stats?.keptAreasMm2 ?? [],
  };
  if (keepPolygons) result.polygonsData = polygons;
  return result;
}

async function runAll(): Promise<void> {
  const runs: RunResult[] = [];
  const sweep: {
    fixture: string;
    despeckleAreaMm2: number;
    polygons: number;
    holes: number;
    points: number;
    areaMm2: number;
    dropped: number;
    maxDroppedMm2: number;
    minKeptMm2: number;
  }[] = [];
  const images = new Map<string, { data: ImageData; width: number; height: number }>();

  for (const fixture of FIXTURES) {
    images.set(fixture.id, await loadImageData(fixture));
    log(`载入 ${fixture.id}：${images.get(fixture.id)!.width}×${images.get(fixture.id)!.height}`);
  }

  for (const fixture of FIXTURES) {
    const image = images.get(fixture.id)!;
    for (const variant of VARIANTS) {
      const params: Params = { ...DEFAULTS, ...variant.patch };
      const result = await runTrace(
        fixture,
        image,
        params,
        variant.label,
        variant.id,
        variant.id === 'default' || variant.id === 'manual-0.50',
      );
      runs.push(result);
      log(
        `${fixture.id.padEnd(14)} ${variant.label.padEnd(16)} ${String(result.ms).padStart(6)}ms  ` +
          `thr=${String(result.thresholdUsed).padEnd(5)} polygons=${String(result.polygons).padStart(3)} ` +
          `holes=${String(result.holes).padStart(2)} points=${String(result.points).padStart(5)} ` +
          `area=${String(result.areaMm2).padStart(6)}mm²`,
      );
    }
  }

  // ---- 去噪阈值扫描（线稿：辐条是小图元，最先被吞）----
  {
    const fixture = FIXTURES.find((f) => f.id === 'lineart')!;
    const image = images.get(fixture.id)!;
    for (const despeckleAreaMm2 of DESPECKLE_SWEEP) {
      const result = await runTrace(
        fixture,
        image,
        { ...DEFAULTS, despeckleAreaMm2 },
        `despeckle ${despeckleAreaMm2}`,
        `sweep-${despeckleAreaMm2}`,
        false,
      );
      sweep.push({
        fixture: fixture.id,
        despeckleAreaMm2,
        polygons: result.polygons,
        holes: result.holes,
        points: result.points,
        areaMm2: result.areaMm2,
        dropped: result.droppedAreasMm2.length,
        maxDroppedMm2: result.droppedAreasMm2.length === 0 ? 0 : Math.max(...result.droppedAreasMm2),
        minKeptMm2: result.keptAreasMm2.length === 0 ? 0 : Math.min(...result.keptAreasMm2),
      });
      log(
        `sweep lineart   despeckle=${String(despeckleAreaMm2).padEnd(5)} ` +
          `polygons=${result.polygons} area=${result.areaMm2}mm² 吞掉=${result.droppedAreasMm2.length} ` +
          `最大吞掉=${result.droppedAreasMm2.length === 0 ? 0 : Math.max(...result.droppedAreasMm2)}mm² ` +
          `最小保留=${result.keptAreasMm2.length === 0 ? 0 : Math.min(...result.keptAreasMm2)}mm²`,
      );
    }
  }

  // ---- 对比图：4 行 × 3 列（原图 | Otsu | 手动 0.5）----
  const cell = 320;
  const labelHeight = 46;
  const gap = 14;
  const columns = 3;
  sheet.width = cell * columns + gap * (columns + 1);
  sheet.height = (cell + labelHeight) * FIXTURES.length + gap * (FIXTURES.length + 1);

  const context = sheet.getContext('2d')!;
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, sheet.width, sheet.height);
  context.font = '12px system-ui, sans-serif';
  context.textBaseline = 'middle';

  const overlapLeft = gap * 2 + cell;

  for (let row = 0; row < FIXTURES.length; row++) {
    const fixture = FIXTURES[row]!;
    const image = images.get(fixture.id)!;
    const top = gap + row * (cell + labelHeight + gap);

    const source = document.createElement('canvas');
    source.width = image.width;
    source.height = image.height;
    source.getContext('2d')!.putImageData(image.data, 0, 0);
    const scale = cell / image.width;

    const cells: { run: RunResult | null; x: number; title: string }[] = [
      { run: null, x: gap, title: `输入：${fixture.label}` },
      {
        run: runs.find((r) => r.fixture === fixture.id && r.variant === 'default') ?? null,
        x: overlapLeft,
        title: '描摹：Otsu 自动阈值（默认）',
      },
      {
        run: runs.find((r) => r.fixture === fixture.id && r.variant === 'manual-0.50') ?? null,
        x: overlapLeft + cell + gap,
        title: '描摹：手动 threshold 0.5',
      },
    ];

    for (const column of cells) {
      context.drawImage(source, column.x, top, cell, cell);

      if (column.run !== null) {
        const toPx = (point: readonly [number, number]): [number, number] => [
          column.x + (point[0] / MM_PER_PX + image.width / 2) * scale,
          top + (image.height / 2 - point[1] / MM_PER_PX) * scale,
        ];

        for (const polygon of column.run.polygonsData ?? []) {
          context.beginPath();
          polygon.outer.forEach((point, index) => {
            const [x, y] = toPx(point);
            if (index === 0) context.moveTo(x, y);
            else context.lineTo(x, y);
          });
          context.closePath();
          context.strokeStyle = 'rgba(0, 140, 60, 0.95)';
          context.lineWidth = 1;
          context.stroke();
          context.fillStyle = 'rgba(0, 170, 80, 0.18)';
          context.fill();

          for (const hole of polygon.holes) {
            context.beginPath();
            hole.forEach((point, index) => {
              const [x, y] = toPx(point);
              if (index === 0) context.moveTo(x, y);
              else context.lineTo(x, y);
            });
            context.closePath();
            context.strokeStyle = 'rgba(200, 40, 40, 0.95)';
            context.stroke();
            context.fillStyle = 'rgba(255, 255, 255, 0.85)';
            context.fill();
          }
        }
      }

      const run = column.run;
      const detail =
        run === null
          ? ''
          : `${run.polygons} 块 / ${run.holes} 孔 / ${run.points} 点 · ${run.areaMm2}mm² · ${run.ms}ms`;
      const sub =
        run === null
          ? ''
          : `阈值 ${run.thresholdUsed}${run.otsu === null ? '（手动）' : `（Otsu η=${run.otsu.eta}）`} · 墨 ${(run.inkFraction * 100).toFixed(1)}%`;

      context.fillStyle = '#333';
      context.fillText(column.title, column.x + 2, top + cell + 11);
      if (detail !== '') {
        context.fillStyle = '#555';
        context.fillText(detail, column.x + 2, top + cell + 24);
      }
      if (sub !== '') {
        context.fillStyle = '#888';
        context.font = '11px system-ui, sans-serif';
        context.fillText(sub, column.x + 2, top + cell + 39);
        context.font = '12px system-ui, sans-serif';
      }
    }
  }

  const at = (fixture: string, variant: string): RunResult | undefined =>
    runs.find((r) => r.fixture === fixture && r.variant === variant);

  const silhouette = FIXTURES.find((f) => f.id === 'silhouette-aa')!;
  const silhouetteAreas = ['manual-0.35', 'manual-0.50', 'manual-0.65'].map((v) => at(silhouette.id, v)?.areaMm2 ?? 0);
  const spread = Math.max(...silhouetteAreas) / Math.max(1, Math.min(...silhouetteAreas));

  const checks = [
    {
      name: '多孔图形出正确 holes（Otsu 期望 4）',
      ok: (at('shape-holes', 'default')?.holes ?? 0) >= 4,
      detail: `holes=${at('shape-holes', 'default')?.holes}`,
    },
    {
      name: 'Otsu 与手动 0.5 在多孔图上结论一致（面积差 <10%）',
      ok: (() => {
        const auto = at('shape-holes', 'default')?.areaMm2 ?? 0;
        const manual = at('shape-holes', 'manual-0.50')?.areaMm2 ?? 0;
        return manual > 0 && Math.abs(auto - manual) / manual < 0.1;
      })(),
      detail: `auto=${at('shape-holes', 'default')?.areaMm2} manual=${at('shape-holes', 'manual-0.50')?.areaMm2}`,
    },
    {
      name: '软边剪影：Otsu 落进手动 0.35~0.65 之间且不被极值带走',
      ok: (() => {
        const auto = at(silhouette.id, 'default')?.areaMm2 ?? 0;
        const low = Math.min(...silhouetteAreas);
        const high = Math.max(...silhouetteAreas);
        return auto >= low * 0.9 && auto <= high * 1.1;
      })(),
      detail: `auto=${at(silhouette.id, 'default')?.areaMm2} 手动区间=${Math.min(...silhouetteAreas)}~${Math.max(...silhouetteAreas)}`,
    },
    {
      name: '细线没被吃干净（lineart 至少 1 块且面积 > 0）',
      ok: (() => {
        const run = at('lineart', 'default');
        return run !== undefined && run.polygons >= 1 && run.areaMm2 > 0;
      })(),
      detail: `area=${at('lineart', 'default')?.areaMm2}mm²`,
    },
    {
      name: '噪点被压住（scan-noise 默认块数 <= 40）',
      ok: (at('scan-noise', 'default')?.polygons ?? 999) <= 40,
      detail: `polygons=${at('scan-noise', 'default')?.polygons}`,
    },
    {
      name: '抗锯齿线稿：Otsu 阈值不被"双尖峰"压到 0（>=0.35）',
      ok: (at('lineart-aa', 'default')?.thresholdUsed ?? 0) >= 0.35,
      detail: `thr=${at('lineart-aa', 'default')?.thresholdUsed}`,
    },
    {
      name: '抗锯齿线稿：Otsu 让笔画连成整体（块数 <= 2）',
      ok: (at('lineart-aa', 'default')?.polygons ?? 99) <= 2,
      detail: `polygons=${at('lineart-aa', 'default')?.polygons}`,
    },
    {
      name: '抗锯齿线稿：手动 0.5 会断线（块数明显多于 Otsu）',
      ok: (at('lineart-aa', 'manual-0.50')?.polygons ?? 0) > (at('lineart-aa', 'default')?.polygons ?? 99),
      detail: `manual=${at('lineart-aa', 'manual-0.50')?.polygons} auto=${at('lineart-aa', 'default')?.polygons}`,
    },
    {
      name: '点数可控（全部 < 20000）',
      ok: runs.every((r) => r.points < 20000),
      detail: `max=${Math.max(...runs.map((r) => r.points))}`,
    },
  ];

  const results = {
    ok: checks.every((c) => c.ok),
    mmPerPx: MM_PER_PX,
    defaults: DEFAULTS,
    silhouetteSpread: Math.round(spread * 100) / 100,
    runs,
    sweep,
    checks,
    sheet: sheet.toDataURL('image/png'),
  };
  (window as unknown as { __LAB_RESULTS__: unknown }).__LAB_RESULTS__ = results;

  log('');
  for (const check of checks) log(`${check.ok ? 'PASS' : 'FAIL'}  ${check.name}  —  ${check.detail}`);
  log(results.ok ? '\n全部通过' : '\n有失败项');
}

runAll().catch((error: unknown) => {
  const message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
  (window as unknown as { __LAB_RESULTS__: unknown }).__LAB_RESULTS__ = { ok: false, error: message };
  log(`ERROR ${message}`);
});
