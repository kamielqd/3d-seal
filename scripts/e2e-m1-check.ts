/**
 * M1 端到端验收：版式 → 实体 → STL/3MF
 * 跑法：node --experimental-strip-types scripts/e2e-m1-check.ts
 *
 * 检查项
 *  1. 默认（阴刻 + 面贴床）buildSeal status 必须 NoError，且三角面 > 0
 *  2. z 约定：阴刻贴床时 z=0 是盖印面；阳刻贴床时字母在 [0, depth]
 *  3. 镜像正确：把图案整体放在 +x，实体上的图案必须出现在 -x
 *  4. 阳刻 + FDM + 有手柄 → bridge.span 必须是 error 级（阻断导出）
 *  5. face-up：无手柄可打、z 最小值精确 0、总高 = depth + T；有手柄直接抛错
 *  6. 三种章体 + 两种手柄都能出
 *  7. STL 字节数 = 84 + 50n，头部三角数一致
 *  8. 3MF 能解压、unit="millimeter"、三角数一致、**只有一个 object**
 */
import fs from 'node:fs';
import opentype from 'opentype.js';
import { unzipSync } from 'fflate';
import { textToPolygons } from '../src/layout/text.ts';
import type { Polygon2D } from '../src/layout/text.ts';
import { buildSeal } from '../src/geometry/pipeline.ts';
import { fromLayoutPolygons } from '../src/core/polygon-bridge.ts';
import { toBinaryStl } from '../src/export/stl.ts';
import { to3mf } from '../src/export/threemf.ts';
import { createDefaultSpec } from '../src/core/spec.ts';
import type { SolidMesh } from '../src/geometry/types.ts';

const fontPath = 'public/fonts/smiley-sans/smiley-sans-subset.ttf';
const fbuf = fs.readFileSync(fontPath);
const font = opentype.parse(fbuf.buffer.slice(fbuf.byteOffset, fbuf.byteOffset + fbuf.byteLength));

let failed = 0;
function check(ok: boolean, label: string, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) failed++;
}

function layout(text: string, sizeMm: number, cx = 0, cy = 0): Polygon2D[] {
  return textToPolygons({ text, font, fontSizeMm: sizeMm, letterSpacingMm: 0.8, centerMm: { x: cx, y: cy } });
}

function meshZ(mesh: SolidMesh) {
  const v = mesh.vertProperties;
  const st = mesh.numProp ?? 3;
  let min = Infinity, max = -Infinity;
  for (let i = 2; i < v.length; i += st) {
    if (v[i] < min) min = v[i];
    if (v[i] > max) max = v[i];
  }
  return { min, max };
}

/** 取 z 在 [zMin,zMax] 区间内顶点的 x 范围 */
function meshXInZ(mesh: SolidMesh, zMin: number, zMax: number) {
  const v = mesh.vertProperties;
  const st = mesh.numProp ?? 3;
  let minX = Infinity, maxX = -Infinity;
  for (let i = 0; i < v.length; i += st) {
    const z = v[i + 2];
    if (z < zMin || z > zMax) continue;
    if (v[i] < minX) minX = v[i];
    if (v[i] > maxX) maxX = v[i];
  }
  return { minX, maxX };
}

const baseSpec = createDefaultSpec();
const thickness = baseSpec.body.baseThicknessMm;
const depth = baseSpec.relief.depthMm;
const noHandle = { ...baseSpec, body: { ...baseSpec.body, handle: 'none' as const } };
// 镜像用例要单独隔离字母：边框环同样落在 [0, depth]，会把 x 包围盒撑满整章
const raisedSpec = {
  ...noHandle,
  body: { ...noHandle.body, border: { ...noHandle.body.border, style: 'none' as const } },
  relief: { ...baseSpec.relief, mode: 'raised' as const },
};
const withHandle = (m: 'raised' | 'engraved') => ({
  ...baseSpec,
  body: { ...baseSpec.body, handle: 'knob' as const },
  relief: { ...baseSpec.relief, mode: m },
});

/* ---------- 1. 默认：阴刻 + 面贴床 ---------- */
check(baseSpec.relief.mode === 'engraved', '默认浮雕模式 = 阴刻', baseSpec.relief.mode);
check(baseSpec.print.orientation === 'face-down', '默认打印取向 = face-down', baseSpec.print.orientation);

const t0 = performance.now();
const mesh = await buildSeal(baseSpec, fromLayoutPolygons(layout('印章工坊', 9)));
const ms = performance.now() - t0;
check(mesh.status === 'NoError', `默认（阴刻）status=${mesh.status}`, `${mesh.triangleCount} 面 / ${ms.toFixed(1)}ms`);
check(mesh.triangleCount > 0 && mesh.triangleCount < 150000, '三角面在 (0, 15万) 内', String(mesh.triangleCount));
const zAll = meshZ(mesh);
check(Math.abs(zAll.min) < 1e-6, '阴刻面贴床：z 最小值精确为 0', zAll.min.toFixed(6));
check(zAll.max > thickness, '阴刻：手柄/章体高于底板', `z max=${zAll.max.toFixed(2)}`);

/* ---------- 2. 阳刻 z 约定：字母在 [0, depth] ---------- */
const raisedMesh = await buildSeal(raisedSpec, fromLayoutPolygons(layout('印', 9, 5, 0)));
const zRaised = meshZ(raisedMesh);
check(Math.abs(zRaised.min) < 1e-6, '阳刻贴床：字母顶面在 z=0', zRaised.min.toFixed(6));
check(
  Math.abs(zRaised.max - (depth + thickness)) < 1e-6,
  '阳刻贴床：总高 = depth + 板厚',
  `${zRaised.max.toFixed(2)} vs ${(depth + thickness).toFixed(2)}`,
);

/* ---------- 3. 镜像：图案放在 +x，字母柱必须在 -x ---------- */
const letters = meshXInZ(raisedMesh, -1e-6, depth * 0.5);
check(
  letters.maxX < 0,
  '镜像：+x 的图案在实体上落在 -x',
  `字母柱 x∈[${letters.minX.toFixed(2)}, ${letters.maxX.toFixed(2)}]`,
);

/* ---------- 4. bridge.span 分级 ---------- */
const raisedWithHandle = await buildSeal(withHandle('raised'), fromLayoutPolygons(layout('印章工坊', 9)));
const bridgeErr = (raisedWithHandle.violations ?? []).filter((v) => v.rule === 'bridge.span' && v.severity === 'error');
check(bridgeErr.length === 1, '阳刻+手柄 → bridge.span 为 error 级', bridgeErr[0]?.message.slice(0, 40) ?? '缺失');

const engravedWithHandle = await buildSeal(withHandle('engraved'), fromLayoutPolygons(layout('印章工坊', 9)));
const engravedBridge = (engravedWithHandle.violations ?? []).filter((v) => v.rule === 'bridge.span');
check(engravedBridge.every((v) => v.severity !== 'error'), '阴刻+手柄 → 不产生阻断级 bridge.span', String(engravedBridge.length));

/* ---------- 5. face-up ---------- */
const faceUpMesh = await buildSeal(
  { ...raisedSpec, orientation: 'face-up' },
  fromLayoutPolygons(layout('印章工坊', 9)),
);
const zUp = meshZ(faceUpMesh);
check(Math.abs(zUp.min) < 1e-6, 'face-up：z 最小值精确为 0', zUp.min.toFixed(6));
check(
  Math.abs(zUp.max - (depth + thickness)) < 1e-6,
  'face-up：总高 = depth + 板厚（字母朝上）',
  `${zUp.max.toFixed(2)} vs ${(depth + thickness).toFixed(2)}`,
);

let faceUpThrew = false;
try {
  await buildSeal({ ...withHandle('raised'), orientation: 'face-up' }, fromLayoutPolygons(layout('印', 9)));
} catch {
  faceUpThrew = true;
}
check(faceUpThrew, 'face-up + 有手柄 → 直接抛错，不产出半成品');

/* ---------- 6. 章体与手柄 ---------- */
const shapes: Array<[string, Record<string, unknown>]> = [
  ['圆章（阴刻）', { shape: 'circle' }],
  ['正八边形（阴刻）', { shape: 'polygon', sides: 8 }],
  ['方章圆角（阴刻）', { shape: 'square', cornerRadiusMm: 3 }],
  ['方章+旋钮手柄（阴刻）', { shape: 'square', handle: 'knob' }],
  ['方章+桥形手柄（阴刻）', { shape: 'square', handle: 'bridge' }],
];
for (const [label, patch] of shapes) {
  const spec = { ...baseSpec, body: { ...baseSpec.body, ...patch } };
  try {
    const m = await buildSeal(spec, fromLayoutPolygons(layout('印章工坊', 9)));
    const z = meshZ(m);
    check(m.status === 'NoError' && m.triangleCount > 0 && Math.abs(z.min) < 1e-6, `${label} 生成并贴床`, `${m.triangleCount} 面`);
  } catch (e) {
    check(false, `${label} 生成`, e instanceof Error ? e.message : String(e));
  }
}

/* ---------- 7. STL ---------- */
const stl = toBinaryStl(mesh);
const expectBytes = 84 + 50 * mesh.triangleCount;
check(stl.byteLength === expectBytes, 'STL 字节数 = 84 + 50n', `${stl.byteLength} vs ${expectBytes} (${(stl.byteLength / 1024).toFixed(1)}KB)`);
const dv = new DataView(stl);
check(dv.getUint32(80, true) === mesh.triangleCount, 'STL 头部三角数一致', String(dv.getUint32(80, true)));
fs.mkdirSync('temp', { recursive: true });
fs.writeFileSync('temp/m1-seal.stl', Buffer.from(stl));

/* ---------- 8. 3MF ---------- */
const tmf = to3mf(mesh);
fs.writeFileSync('temp/m1-seal.3mf', Buffer.from(tmf));
check(tmf.length > 0, '3MF 已生成', `${tmf.length}B (STL ${stl.byteLength}B，小 ${(stl.byteLength / tmf.length).toFixed(1)}×)`);
try {
  const files = unzipSync(tmf);
  const names = Object.keys(files);
  const modelName = names.find((n) => n.endsWith('.model')) ?? '';
  const xml = new TextDecoder().decode(files[modelName] ?? new Uint8Array());
  check(/unit\s*=\s*"millimeter"/.test(xml), '3MF model 头带 unit="millimeter"');
  const triCount = (xml.match(/<triangle\b/g) ?? []).length;
  check(triCount === mesh.triangleCount, '3MF 三角数与实体一致', `${triCount} vs ${mesh.triangleCount}`);
  const objects = (xml.match(/<object\b/g) ?? []).length;
  check(objects === 1, '3MF 只有一个 object（不把多版塞进同一文件）', `${objects} 个`);
} catch (e) {
  check(false, '3MF 可解压', e instanceof Error ? e.message : String(e));
}

console.log(`\n产物：temp/m1-seal.stl（${(stl.byteLength / 1024).toFixed(1)}KB） temp/m1-seal.3mf（${(tmf.length / 1024).toFixed(1)}KB）`);
console.log(failed === 0 ? `\n全部通过（${new Date().toISOString()}）` : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
