/**
 * 硬校验：不看"跑通了"，而是验证几何本身对不对。
 *
 * 所有 z 断言都从 spec 推出来（depthMm / baseThicknessMm），不写死毫米数。
 * 约定见 src/geometry/pipeline.ts 文件头：**盖印面贴床**，z = 0 是贴床面。
 *   阳刻：图案 z∈[0, depth]，底板 z∈[depth, depth+base]
 *   阴刻：底板 z∈[0, base]，槽从 z=0 挖到 depth
 *
 *   1. 有向体积 > 0（法线朝外，切片软件才认实体）
 *   2. 底板顶面 = depth + base（阳刻）/ base（阴刻），盖印面在 z=0
 *   3. 镜像：把图案放在 +X，出模后图案必须在 -X；放 -X 则必须到 +X
 *   4. STL 字节数 = 84 + 50n，三角形数一致
 *   5. 3MF 解包后 unit="millimeter"，三角形数一致
 */

import { createDefaultSpec } from '../src/core/spec.ts';
import type { SealSpec } from '../src/core/spec.ts';
import { buildSeal } from '../src/geometry/pipeline.ts';
import type { Polygon2D, SolidMesh } from '../src/geometry/types.ts';
import { fromRings } from '../src/geometry/polygon.ts';
import { traceImageData } from '../src/geometry/trace.ts';
import { toBinaryStl } from '../src/export/stl.ts';
import { to3mf } from '../src/export/threemf.ts';
import { unzipSync, strFromU8 } from 'fflate';

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
}

function baseSpec(overrides: Partial<SealSpec> = {}): SealSpec {
  const spec = createDefaultSpec();
  return {
    ...spec,
    body: {
      ...spec.body,
      shape: 'square',
      sizeMm: 30,
      cornerRadiusMm: 2,
      baseThicknessMm: 4,
      // 图案/镜像校验一律用无手柄章体：手柄比章面高，会污染 z 极值与重心
      handle: 'none',
      handleHeightMm: 14,
      handleDiameterMm: 14,
    },
    relief: { mode: 'raised', depthMm: 1.2 },
    print: { process: 'fdm', minStrokeMm: 0.4, minGapMm: 0.4 },
    ...overrides,
  };
}

function rectAt(cx: number, cy: number, w = 6, h = 6): Polygon2D {
  const hw = w / 2;
  const hh = h / 2;
  return {
    outer: [
      [cx - hw, cy - hh],
      [cx + hw, cy - hh],
      [cx + hw, cy + hh],
      [cx - hw, cy + hh],
    ],
    holes: [],
  };
}

/** 有向体积：法线朝外时为正。 */
function signedVolume(mesh: SolidMesh): number {
  const { vertProperties, triVerts, numProp } = mesh;
  let volume = 0;
  for (let t = 0; t < mesh.triangleCount; t++) {
    const i0 = triVerts[t * 3]!;
    const i1 = triVerts[t * 3 + 1]!;
    const i2 = triVerts[t * 3 + 2]!;
    const ax = vertProperties[i0 * numProp]!;
    const ay = vertProperties[i0 * numProp + 1]!;
    const az = vertProperties[i0 * numProp + 2]!;
    const bx = vertProperties[i1 * numProp]!;
    const by = vertProperties[i1 * numProp + 1]!;
    const bz = vertProperties[i1 * numProp + 2]!;
    const cx = vertProperties[i2 * numProp]!;
    const cy = vertProperties[i2 * numProp + 1]!;
    const cz = vertProperties[i2 * numProp + 2]!;
    volume += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return volume;
}

function bounds(mesh: SolidMesh): { min: [number, number, number]; max: [number, number, number] } {
  const { vertProperties, numProp } = mesh;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < vertProperties.length; i += numProp) {
    for (let k = 0; k < 3; k++) {
      const value = vertProperties[i + k]!;
      if (value < min[k]!) min[k] = value;
      if (value > max[k]!) max[k] = value;
    }
  }
  return { min, max };
}

/**
 * z 极值附近那一圈顶点的 XY 范围。
 *
 * 不写死 z：管线可能把盖印面放在 z=0（面朝床）或把图案放在顶部，两种约定下
 * 「贴某个 z 极值的一层顶点」都是同一批面。靠 XY 跨度区分它是不是图案——
 * 章面那圈总是铺满整个 sizeMm，图案那圈只有一个图案那么大。
 */
function bandBounds(
  mesh: SolidMesh,
  side: 'min' | 'max',
  tolerance = 0.05,
): { xMin: number; xMax: number; yMin: number; yMax: number; count: number } {
  const { vertProperties, numProp } = mesh;
  let zMin = Infinity;
  let zMax = -Infinity;
  for (let i = 0; i < vertProperties.length; i += numProp) {
    const z = vertProperties[i + 2]!;
    if (z < zMin) zMin = z;
    if (z > zMax) zMax = z;
  }
  const cut = side === 'min' ? zMin + tolerance : zMax - tolerance;
  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  let count = 0;
  for (let i = 0; i < vertProperties.length; i += numProp) {
    const z = vertProperties[i + 2]!;
    const inBand = side === 'min' ? z <= cut : z >= cut;
    if (!inBand) continue;
    const x = vertProperties[i]!;
    const y = vertProperties[i + 1]!;
    if (x < xMin) xMin = x;
    if (x > xMax) xMax = x;
    if (y < yMin) yMin = y;
    if (y > yMax) yMax = y;
    count++;
  }
  return { xMin, xMax, yMin, yMax, count };
}

/** 某个 z 高度附近那一圈顶点（验证槽底、台阶这类水平面）。 */
function verticesAtZ(
  mesh: SolidMesh,
  z: number,
  tolerance = 0.02,
): { count: number; xMin: number; xMax: number; cx: number; width: number } {
  const { vertProperties, numProp } = mesh;
  let xMin = Infinity;
  let xMax = -Infinity;
  let count = 0;
  for (let i = 0; i < vertProperties.length; i += numProp) {
    if (Math.abs(vertProperties[i + 2]! - z) > tolerance) continue;
    const x = vertProperties[i]!;
    if (x < xMin) xMin = x;
    if (x > xMax) xMax = x;
    count++;
  }
  if (count === 0) return { count: 0, xMin: 0, xMax: 0, cx: Number.NaN, width: 0 };
  return {
    count,
    xMin,
    xMax,
    cx: (xMin + xMax) / 2,
    width: xMax - xMin,
  };
}

/**
 * 图案那一层：z 两个极值层里 XY 跨度小的那层（章面那层铺满整个 sizeMm）。
 *
 * 不写死 z：管线把图案放在 z=0（贴床）还是放在顶部，都能认出来。
 */
function patternBandOf(mesh: SolidMesh): { side: 'min' | 'max'; cx: number; width: number; plateSpan: number } {
  const min = bandBounds(mesh, 'min');
  const max = bandBounds(mesh, 'max');
  const minSpan = min.xMax - min.xMin;
  const maxSpan = max.xMax - max.xMin;
  const patternIsMin = minSpan <= maxSpan;
  const pattern = patternIsMin ? min : max;
  return {
    side: patternIsMin ? 'min' : 'max',
    cx: (pattern.xMin + pattern.xMax) / 2,
    width: pattern.xMax - pattern.xMin,
    plateSpan: patternIsMin ? maxSpan : minSpan,
  };
}

async function main(): Promise<void> {
  // ---- z 约定（盖印面贴床，见 pipeline.ts 文件头）----
  // 所有期望值都从这两条推：底板顶面 = depth + base（阳刻）/ base（阴刻）。
  const spec = baseSpec();
  const sizeMm = spec.body.sizeMm;
  const baseT = spec.body.baseThicknessMm;
  const depth = spec.relief.depthMm;
  const plateTopRaised = depth + baseT;
  const plateTopEngraved = baseT;
  const PATTERN_X = 8; // 合成图案放在 +X，镜像后必须落到 -X
  const PATTERN_W = 6;

  // ---- 阳刻 ----
  const raised = await buildSeal(spec, [rectAt(PATTERN_X, 0, PATTERN_W, PATTERN_W)]);
  const b1 = bounds(raised);
  const v1 = signedVolume(raised);
  check('阳刻 status', raised.status === 'NoError', raised.status);
  check('体积为正（法线朝外）', v1 > 0, `volume=${v1.toFixed(2)} mm³`);
  check(
    '底板顶面高度 = depth + base',
    Math.abs(b1.max[2] - plateTopRaised) < 0.02,
    `zMax=${b1.max[2].toFixed(3)} 期望=${plateTopRaised.toFixed(3)}（depth=${depth} + base=${baseT}）`,
  );
  check(
    '阳刻盖印面贴床（最低点 z=0）',
    Math.abs(b1.min[2]) < 0.02,
    `zMin=${b1.min[2].toFixed(3)}`,
  );

  const patternA = patternBandOf(raised);
  check(
    '阳刻图案长在盖印面一侧（z=0 那层）',
    patternA.side === 'min',
    `图案层在 ${patternA.side === 'min' ? 'z=0 侧 ✓' : 'zMax 侧 ✗'}（zMin=${b1.min[2].toFixed(2)} zMax=${b1.max[2].toFixed(2)}）`,
  );
  check(
    '镜像：图案放 +8 → 出模在 -8',
    Math.abs(patternA.cx + PATTERN_X) < 0.5 && Math.abs(patternA.width - PATTERN_W) < 0.5,
    `cx=${patternA.cx.toFixed(2)} width=${patternA.width.toFixed(2)}（章面层跨度=${patternA.plateSpan.toFixed(1)}mm，应≈${sizeMm}）`,
  );

  // 反向：放 -8 必须跑到 +8，才能证明是"镜像"而不是"没动"
  const flipped = await buildSeal(spec, [rectAt(-PATTERN_X, 0, PATTERN_W, PATTERN_W)]);
  const patternB = patternBandOf(flipped);
  check(
    '镜像：图案放 -8 → 出模在 +8（不是没动）',
    Math.abs(patternB.cx - PATTERN_X) < 0.5,
    `cx=${patternB.cx.toFixed(2)} width=${patternB.width.toFixed(2)}`,
  );

  // ---- 阴刻 ----
  const engraved = await buildSeal(baseSpec({ relief: { mode: 'engraved', depthMm: depth } }), [
    rectAt(PATTERN_X, 0, PATTERN_W, PATTERN_W),
  ]);
  const b2 = bounds(engraved);
  check('阴刻 status', engraved.status === 'NoError', engraved.status);
  check(
    '阴刻底板顶面高度 = base',
    Math.abs(b2.max[2] - plateTopEngraved) < 0.02,
    `zMax=${b2.max[2].toFixed(3)} 期望=${plateTopEngraved.toFixed(3)}`,
  );
  check('阴刻盖印面也在 z=0', Math.abs(b2.min[2]) < 0.02, `zMin=${b2.min[2].toFixed(3)}`);
  const groove = verticesAtZ(engraved, depth, 0.03);
  check(
    '阴刻槽底平面在 z = depth，且落在图案位置',
    groove.count >= 4 && Math.abs(groove.cx + PATTERN_X) < 0.5 && Math.abs(groove.width - PATTERN_W) < 0.5,
    `顶点=${groove.count} cx=${groove.cx.toFixed(2)} width=${groove.width.toFixed(2)} z=${depth}`,
  );
  const engravedVolume = signedVolume(engraved);
  check('阴刻体积 < 阳刻体积', engravedVolume < v1, `${engravedVolume.toFixed(2)} < ${v1.toFixed(2)}`);

  // ---- 圆章 + 正多边形 ----
  const circleSize = 38;
  const circle = await buildSeal(baseSpec({ body: { ...spec.body, shape: 'circle', sizeMm: circleSize } }), [
    rectAt(6, 0, 5, 5),
  ]);
  check('圆章 status', circle.status === 'NoError', circle.status);
  const b3 = bounds(circle);
  check(
    '圆章外径 = sizeMm',
    Math.abs(b3.max[0] - b3.min[0] - circleSize) < 0.4,
    `dx=${(b3.max[0] - b3.min[0]).toFixed(2)} 期望=${circleSize}`,
  );

  const hex = await buildSeal(baseSpec({ body: { ...spec.body, shape: 'polygon', sides: 6, sizeMm: 36 } }), [
    rectAt(5, 0, 5, 5),
  ]);
  check('六边形章 status', hex.status === 'NoError', hex.status);

  // ---- 手柄：坐在底板背面（z = 底板顶面），向下嵌 base 与底板搭接 ----
  const handleHeightMm = 14;
  const handleBody = { ...spec.body, handle: 'knob' as const, handleHeightMm };
  const withHandle = await buildSeal(baseSpec({ body: handleBody }), [rectAt(6, 0, 5, 5)]);
  const bHandle = bounds(withHandle);
  // 与 handleSolid 同一条公式：嵌深 base = min(半径*0.9, baseThickness)
  const knobRadius = handleBody.handleDiameterMm / 2;
  const embed = Math.max(0.6, Math.min(knobRadius * 0.9, baseT));
  const expectedHandleTop = plateTopRaised - embed + handleHeightMm;
  check('手柄章 status', withHandle.status === 'NoError', withHandle.status);
  check(
    '手柄顶面 = 底板顶面 − 嵌深 + 手柄高',
    Math.abs(bHandle.max[2] - expectedHandleTop) < 0.05,
    `zMax=${bHandle.max[2].toFixed(2)} 期望=${expectedHandleTop.toFixed(2)}（${plateTopRaised} − ${embed.toFixed(2)} + ${handleHeightMm}）`,
  );
  check(
    '手柄不超出章面 XY',
    Math.abs(bHandle.max[0]) <= sizeMm / 2 + 0.01 && Math.abs(bHandle.min[0]) <= sizeMm / 2 + 0.01,
    `x=${bHandle.min[0].toFixed(2)}~${bHandle.max[0].toFixed(2)} 上限=±${(sizeMm / 2).toFixed(1)}`,
  );

  // ---- 导出 ----
  const stl = toBinaryStl(raised, 'verify');
  check(
    'STL 字节数 = 84 + 50n',
    stl.byteLength === 84 + 50 * raised.triangleCount,
    `${stl.byteLength} vs ${84 + 50 * raised.triangleCount}`,
  );
  const stlView = new DataView(stl);
  check('STL 头里的三角形数', stlView.getUint32(80, true) === raised.triangleCount, `${stlView.getUint32(80, true)}`);

  const mf = to3mf(raised, { title: '校验章' });
  const entries = unzipSync(mf);
  const modelXml = strFromU8(entries['3D/3dmodel.model']!);
  check('3MF 含单位 millimeter', modelXml.includes('unit="millimeter"'), 'unit attr');
  const triCountInXml = (modelXml.match(/<triangle /g) ?? []).length;
  check('3MF 三角形数一致', triCountInXml === raised.triangleCount, `${triCountInXml} vs ${raised.triangleCount}`);
  check('3MF 含元数据标题', modelXml.includes('校验章'), 'metadata');
  check('3MF 含 rels 与 content-types', entries['_rels/.rels'] !== undefined && entries['[Content_Types].xml'] !== undefined, 'zip 结构');

  // ---- 边界适配：接 src/layout 的环表示（{x,y} 对象 + 平铺环列表）----
  const layoutRings = [
    { points: [{ x: -6, y: -6 }, { x: 6, y: -6 }, { x: 6, y: 6 }, { x: -6, y: 6 }] },
    { points: [{ x: -2, y: -2 }, { x: -2, y: 2 }, { x: 2, y: 2 }, { x: 2, y: -2 }] },
  ];
  const adapted = fromRings(layoutRings);
  check('layout 环 → 几何多边形', adapted.length === 1 && adapted[0]!.holes.length === 1, `polygons=${adapted.length} holes=${adapted[0]?.holes.length ?? 0}`);
  const adaptedSolid = await buildSeal(baseSpec(), adapted);
  check('适配后的多边形能出实体', adaptedSolid.status === 'NoError', `${adaptedSolid.triangleCount} 面`);

  // ---- 图像描摹：40×40 的白底黑框（带孔）----
  const size = 40;
  const pixels = new Uint8ClampedArray(size * size * 4).fill(255);
  const setInk = (x: number, y: number): void => {
    const p = (y * size + x) * 4;
    pixels[p] = 0;
    pixels[p + 1] = 0;
    pixels[p + 2] = 0;
  };
  for (let y = 8; y < 32; y++) {
    for (let x = 8; x < 32; x++) setInk(x, y);
  }
  for (let y = 15; y < 25; y++) {
    for (let x = 15; x < 25; x++) {
      const p = (y * size + x) * 4;
      pixels[p] = 255;
      pixels[p + 1] = 255;
      pixels[p + 2] = 255;
    }
  }
  const traced = await traceImageData(
    { data: pixels, width: size, height: size },
    { mmPerPx: 0.5, threshold: 0.5, simplifyMm: 0.02, minStrokeMm: 0.4 },
  );
  check('描摹出轮廓', traced.length >= 1, `polygons=${traced.length}`);
  const tracedHoles = traced.reduce((sum, p) => sum + p.holes.length, 0);
  check('描摹保住内孔', tracedHoles >= 1, `holes=${tracedHoles}`);
  const tracedSolid = await buildSeal(baseSpec(), traced);
  check('描摹结果能出实体', tracedSolid.status === 'NoError', `${tracedSolid.triangleCount} 面`);

  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  —  ${r.detail}`);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  if (failed.length > 0) process.exitCode = 1;
}

await main();
