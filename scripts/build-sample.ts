/**
 * 验收脚本：造一块 40mm 方章 + 合成假字形，导出 STL/3MF，打印面数、status、耗时。
 *
 * 跑法（本机没有全局 node，用 primary-runtime 里的）：
 *   node scripts/build-sample.ts
 * Node 24 直接吃 .ts（类型擦除），不需要 tsx。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDefaultSpec } from '../src/core/spec.ts';
import { buildSeal } from '../src/geometry/pipeline.ts';
import type { Polygon2D, Vec2 } from '../src/geometry/types.ts';
import { toBinaryStl } from '../src/export/stl.ts';
import { to3mf } from '../src/export/threemf.ts';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'out');

/** 一个矩形 → CCW 多边形。 */
function rect(cx: number, cy: number, w: number, h: number): Polygon2D {
  const hw = w / 2;
  const hh = h / 2;
  const outer: Vec2[] = [
    [cx - hw, cy - hh],
    [cx + hw, cy - hh],
    [cx + hw, cy + hh],
    [cx - hw, cy + hh],
  ];
  return { outer, holes: [] };
}

/**
 * 合成一个"像字"的图元组：3×3 笔画网格里挑几条，模拟中文笔画结构。
 * 每个字返回多个矩形（彼此重叠也没关系，二维并集会把它们合起来）。
 */
function fakeGlyph(cx: number, cy: number, size: number, pattern: number): Polygon2D[] {
  const gap = size * 0.08;
  const stroke = (size - gap * 2) / 3;
  const rects: Polygon2D[] = [];
  const cells = [
    [0, 2], [1, 2], [2, 2],
    [0, 1], [1, 1], [2, 1],
    [0, 0], [1, 0], [2, 0],
  ];
  for (let bit = 0; bit < 9; bit++) {
    if ((pattern & (1 << bit)) === 0) continue;
    const cell = cells[bit]!;
    const x = cx + (cell[0]! - 1) * (stroke + gap);
    const y = cy + (cell[1]! - 1) * (stroke + gap);
    rects.push(rect(x, y, stroke, stroke));
  }
  return rects;
}

const spec = {
  ...createDefaultSpec(),
  body: {
    shape: 'square' as const,
    sides: 6,
    sizeMm: 40,
    cornerRadiusMm: 2.5,
    baseThicknessMm: 4,
    border: { style: 'none' as const, widthMm: 1.2, insetMm: 1.2 },
    handle: 'knob' as const,
    handleHeightMm: 16,
    handleDiameterMm: 16,
  },
  relief: { mode: 'raised' as const, depthMm: 1.2 },
  print: { process: 'fdm' as const, minStrokeMm: 0.4, minGapMm: 0.4 },
};

// 四字假字形，2×2 排在章面中心
const glyphSize = 13;
const offset = 8.6;
const polygons: Polygon2D[] = [
  ...fakeGlyph(-offset, offset, glyphSize, 0b111_101_111),
  ...fakeGlyph(offset, offset, glyphSize, 0b101_111_101),
  ...fakeGlyph(-offset, -offset, glyphSize, 0b111_010_111),
  ...fakeGlyph(offset, -offset, glyphSize, 0b100_111_001),
];

async function main(): Promise<void> {
  const t0 = performance.now();
  const mesh = await buildSeal(spec, polygons);
  const buildMs = performance.now() - t0;

  const stl = toBinaryStl(mesh, '3d-seal sample');
  const threeMf = to3mf(mesh, { title: '样章 40mm', designer: '3D 印章生成器' });

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'sample.stl'), Buffer.from(stl));
  writeFileSync(join(outDir, 'sample.3mf'), Buffer.from(threeMf));

  const stlKb = Math.round(stl.byteLength / 1024);
  const mfKb = Math.round(threeMf.byteLength / 1024);
  const ok = mesh.status === 'NoError' && mesh.triangleCount < 10000 && buildMs < 2000;

  console.log(
    JSON.stringify(
      {
        triangles: mesh.triangleCount,
        vertices: mesh.vertProperties.length / mesh.numProp,
        status: mesh.status,
        buildMs: Math.round(buildMs),
        stlKB: stlKb,
        threeMfKB: mfKb,
        outs: ['out/sample.stl', 'out/sample.3mf'],
        pass: ok,
      },
      null,
      1,
    ),
  );

  if (!ok) process.exitCode = 1;
}

await main();
