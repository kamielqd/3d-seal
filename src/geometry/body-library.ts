/**
 * 外部印章主体库：读 `public/bodies/*.stl`（用户自制的章体模型）。
 *
 * 三件事必须做对，否则整条管线都是错的：
 *
 * 1. **STL soup 必须先焊接**：这四个文件都是顶点分裂的（每个三角形自带三个顶点），
 *    直接 `new Manifold(Mesh)` 会抛 `Not manifold`。按 1e-4 容差量化坐标合并后
 *    开放边 0、非流形边 0（classic 14352 → 2398 顶点）。焊接顺带丢掉退化三角形。
 * 2. **单位是厘米**：STL 里 2.00 是 20mm。缩放一律由调用方按 `sizeMm` 算，
 *    这里只负责把原始单位换算成 mm（`SOURCE_UNIT_MM`）。
 * 3. **朝向必须守住**：用户要求「平面那一面朝下当刻印面，圆角朝上」。四个模型
 *    现在就是对的，但换模型就可能变成圆角朝下——所以加载时断言「底面足迹 ≈ 最大
 *    足迹」，不满足直接报错，不自动猜、也不自动翻转（要翻就显式设
 *    `flipUpsideDown`，翻完再过同一条断言）。
 *
 * 缓存与 `getManifold()` 同套路：同一个 id 只 fetch/解析一次。
 */

import { getManifold } from './crosssection.ts';
import type { ManifoldKit } from './crosssection.ts';
import { SealGeometryError } from './types.ts';

type Solid = InstanceType<ManifoldKit['Manifold']>;

/** STL 里的长度单位是厘米，几何一律 mm。 */
export const SOURCE_UNIT_MM = 10;

export type BodyStyleId = 'classic' | 'cylinder' | 'column' | 'dome';

export interface BodyStyle {
  id: BodyStyleId;
  /** public/bodies/ 下的文件名。 */
  file: string;
  /** 中文名，UI 直接用。 */
  label: string;
  /** 源文件实测包围盒，**厘米**（STL 原始单位），用于校验与文档。 */
  sourceBoxCm: { x: number; y: number; z: number };
  /**
   * 圆角朝下时才置 true（加载时会先翻转，再走底面断言）。
   * 现在四个模型都是平面朝下，都不需要；不要为了「看起来对」去设它。
   */
  flipUpsideDown?: boolean;
}

export const BODY_STYLES: readonly BodyStyle[] = [
  { id: 'classic', file: 'classic.stl', label: '常见样式', sourceBoxCm: { x: 2.0, y: 2.0, z: 2.03 } },
  { id: 'cylinder', file: 'cylinder.stl', label: '圆柱', sourceBoxCm: { x: 1.248, y: 1.248, z: 2.683 } },
  { id: 'column', file: 'column.stl', label: '立方柱', sourceBoxCm: { x: 1.174, y: 1.174, z: 2.581 } },
  { id: 'dome', file: 'dome.stl', label: '石墩', sourceBoxCm: { x: 2.0, y: 2.0, z: 1.93 } },
];

const STYLE_BY_ID = new Map<string, BodyStyle>(BODY_STYLES.map((style) => [style.id, style]));

export function isBodyStyleId(value: unknown): value is BodyStyleId {
  return typeof value === 'string' && STYLE_BY_ID.has(value);
}

export function getBodyStyle(id: BodyStyleId): BodyStyle {
  const style = STYLE_BY_ID.get(id);
  if (style === undefined) throw new SealGeometryError('外部主体', 'UnknownBodyStyle', `没有这个主体样式：${id}`);
  return style;
}

/* ------------------------------------------------------------------ */
/* STL 解析                                                            */
/* ------------------------------------------------------------------ */

export interface StlGeometry {
  /** 每顶点 3 个 float（未焊接，即 STL 原样的 soup）。 */
  vertProperties: Float32Array;
  triVerts: Uint32Array;
  triangleCount: number;
  format: 'binary' | 'ascii';
}

/**
 * 解析 STL（二进制优先，长度对不上再按 ASCII 解）。
 *
 * 判定方式：二进制 STL 的字节数必须严格等于 `84 + 50 × 三角形数`，
 * 这个等式几乎不会被误命中，比「文件是否以 solid 开头」可靠（很多二进制导出器
 * 也写 solid 开头的 header）。
 */
export function parseStl(buffer: ArrayBuffer): StlGeometry {
  const view = new DataView(buffer);
  if (buffer.byteLength >= 84) {
    const count = view.getUint32(80, true);
    if (84 + count * 50 === buffer.byteLength) return parseBinaryStl(buffer, count);
  }
  return parseAsciiStl(buffer);
}

function parseBinaryStl(buffer: ArrayBuffer, count: number): StlGeometry {
  const view = new DataView(buffer);
  const vertProperties = new Float32Array(count * 9);
  const triVerts = new Uint32Array(count * 3);
  let out = 0;
  for (let t = 0; t < count; t++) {
    // 跳过法线（12 字节），只取三个顶点；法线不可信，一律用几何判朝向
    const base = 84 + t * 50 + 12;
    for (let v = 0; v < 3; v++) {
      const offset = base + v * 12;
      vertProperties[out++] = view.getFloat32(offset, true);
      vertProperties[out++] = view.getFloat32(offset + 4, true);
      vertProperties[out++] = view.getFloat32(offset + 8, true);
      triVerts[t * 3 + v] = t * 3 + v;
    }
  }
  return { vertProperties, triVerts, triangleCount: count, format: 'binary' };
}

function parseAsciiStl(buffer: ArrayBuffer): StlGeometry {
  const text = new TextDecoder().decode(new Uint8Array(buffer));
  const vertexRe = /vertex\s+(-?[\d.eE+]+)\s+(-?[\d.eE+]+)\s+(-?[\d.eE+]+)/g;
  const values: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = vertexRe.exec(text)) !== null) {
    values.push(Number(match[1]), Number(match[2]), Number(match[3]));
  }
  const vertexCount = values.length / 3;
  if (vertexCount === 0 || vertexCount % 3 !== 0) {
    throw new SealGeometryError('外部主体', 'BadStl', `STL 解析失败：既不是合法二进制（84+50n），也读不到 ASCII 顶点（读到的顶点数 ${vertexCount}）。`);
  }
  return {
    vertProperties: new Float32Array(values),
    triVerts: new Uint32Array(vertexCount).map((_, index) => index),
    triangleCount: vertexCount / 3,
    format: 'ascii',
  };
}

/* ------------------------------------------------------------------ */
/* 焊接（STL soup → 共享顶点）                                          */
/* ------------------------------------------------------------------ */

export interface WeldedMesh {
  vertProperties: Float32Array;
  triVerts: Uint32Array;
  triangleCount: number;
  /** 焊接前顶点数（含重复）。 */
  before: number;
  /** 焊接后顶点数。 */
  after: number;
  /** 焊接后塌成一条线/一个点的三角形数（已丢弃）。 */
  droppedTriangles: number;
}

/**
 * 按坐标量化焊接顶点（默认 1e-4，模型原始单位）。
 *
 * 量化而不是 KD 树：STL 里的重复顶点通常是同一串 float，四舍五入到 1e-4 后
 * key 必然相同，够用且 O(n)。
 */
export function weldStlSoup(
  vertProperties: Float32Array,
  triVerts: Uint32Array,
  tolerance = 1e-4,
): WeldedMesh {
  const vertexCount = Math.floor(vertProperties.length / 3);
  const scale = 1 / tolerance;
  const lookup = new Map<string, number>();
  const remap = new Uint32Array(vertexCount);
  const positions: number[] = [];

  for (let i = 0; i < vertexCount; i++) {
    const x = vertProperties[i * 3]!;
    const y = vertProperties[i * 3 + 1]!;
    const z = vertProperties[i * 3 + 2]!;
    const key = `${Math.round(x * scale)}|${Math.round(y * scale)}|${Math.round(z * scale)}`;
    let index = lookup.get(key);
    if (index === undefined) {
      index = positions.length / 3;
      lookup.set(key, index);
      positions.push(x, y, z);
    }
    remap[i] = index;
  }

  const kept: number[] = [];
  let dropped = 0;
  for (let t = 0; t < triVerts.length; t += 3) {
    const a = remap[triVerts[t]!]!;
    const b = remap[triVerts[t + 1]!]!;
    const c = remap[triVerts[t + 2]!]!;
    if (a === b || b === c || a === c) {
      dropped++;
      continue;
    }
    kept.push(a, b, c);
  }

  return {
    vertProperties: new Float32Array(positions),
    triVerts: new Uint32Array(kept),
    triangleCount: kept.length / 3,
    before: vertexCount,
    after: positions.length / 3,
    droppedTriangles: dropped,
  };
}

/* ------------------------------------------------------------------ */
/* 加载：fetch → 解析 → 焊接 → Manifold（缓存）                          */
/* ------------------------------------------------------------------ */

const meshCache = new Map<BodyStyleId, WeldedMesh>();
const solidCache = new Map<BodyStyleId, Solid>();

/** 自定义字节来源：Node 测试用（浏览器里走 fetch）。 */
export type BodyReader = (style: BodyStyle) => Promise<ArrayBuffer>;

let customReader: BodyReader | null = null;

/** 覆盖字节来源（传 null 恢复 fetch）。脚本里用 fs 读，避免依赖 dev server。 */
export function setBodyReader(reader: BodyReader | null): void {
  customReader = reader;
  meshCache.clear();
  solidCache.clear();
}

/** 静态资源根：和 src/layout/fonts.ts 一个写法，Pages 子路径下才不 404。 */
function assetBase(): string {
  const env = (import.meta as unknown as { env?: { BASE_URL?: string } }).env;
  const base = env?.BASE_URL ?? '/';
  return base.endsWith('/') ? base : `${base}/`;
}

const fetchReader: BodyReader = async (style) => {
  const url = `${assetBase()}bodies/${style.file}`;
  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    throw new SealGeometryError(
      '外部主体',
      'BodyFetchFailed',
      `读取主体模型失败：${url}（${error instanceof Error ? error.message : String(error)}）`,
    );
  }
  if (!response.ok) {
    throw new SealGeometryError('外部主体', 'BodyFetchFailed', `读取主体模型失败：${url} 返回 ${response.status}。`);
  }
  return await response.arrayBuffer();
};

/** 解析并焊接后的顶点/索引（缓存，不产生 manifold 实体）。 */
export async function loadBodyMesh(id: BodyStyleId): Promise<WeldedMesh> {
  const cached = meshCache.get(id);
  if (cached !== undefined) return cached;
  const style = getBodyStyle(id);
  const bytes = await (customReader ?? fetchReader)(style);
  const parsed = parseStl(bytes);
  const welded = weldStlSoup(parsed.vertProperties, parsed.triVerts);
  meshCache.set(id, welded);
  return welded;
}

/**
 * 取主体实体（已焊接、已按需翻转）。
 *
 * **返回的是共享缓存实例，调用方不得 `delete()`**；布尔运算会返回新实例，
 * 直接拿它去 add/subtract 即可。
 */
export async function loadBody(id: BodyStyleId): Promise<Solid> {
  const cached = solidCache.get(id);
  if (cached !== undefined) return cached;

  const style = getBodyStyle(id);
  const data = await loadBodyMesh(id);
  const kit = await getManifold();

  let solid: Solid;
  try {
    solid = new kit.Manifold(
      new kit.Mesh({ numProp: 3, vertProperties: data.vertProperties, triVerts: data.triVerts }),
    );
  } catch (error) {
    throw new SealGeometryError(
      '外部主体',
      'BodyNotManifold',
      `${style.label} 焊接后仍不是闭合流形（${error instanceof Error ? error.message : String(error)}）：模型可能有洞或非流形边。`,
    );
  }

  const status = solid.status();
  if (status !== 'NoError') {
    solid.delete();
    throw new SealGeometryError('外部主体', 'BodyNotManifold', `${style.label} 焊接后状态是 ${status}：模型可能不是闭合实体。`);
  }

  if (style.flipUpsideDown === true) {
    const flipped = solid.rotate([180, 0, 0]);
    solid.delete();
    solid = flipped;
  }

  assertFlatBase(style, solid);
  solidCache.set(id, solid);
  return solid;
}

/** 底面足迹与最大足迹允许的相对偏差（超出就说明这个模型圆角朝下）。 */
const BASE_FLAT_TOLERANCE = 0.01;
/** 用来取「底面附近」顶点的高度窗口，占模型总高的比例。 */
const BASE_WINDOW_RATIO = 0.005;

/**
 * 断言「平面那一面朝下」。
 *
 * 做法：在 `z = zmin + 0.5% 高` 处取真实横截面（`Manifold.slice`），算它的 XY 足迹，
 * 和整体 XY 包围盒比。圆角朝下的模型在这个高度上只有一个小圆盘，足迹会明显小于
 * 最大足迹，偏差 > 1% 就报错。
 *
 * **不自动翻转**：朝向错了应该由人改注册表（`flipUpsideDown: true`），不是猜。
 */
function assertFlatBase(style: BodyStyle, solid: Solid): void {
  const box = solid.boundingBox();
  const height = Math.max(1e-6, box.max[2] - box.min[2]);
  const fullFootprint = Math.max(box.max[0] - box.min[0], box.max[1] - box.min[1]);
  if (!(fullFootprint > 0)) {
    throw new SealGeometryError('外部主体', 'EmptyBody', `${style.label} 的 XY 足迹为 0，无法判朝向。`);
  }

  const sliceZ = box.min[2] + Math.max(1e-6, height * BASE_WINDOW_RATIO);
  const section = solid.slice(sliceZ);
  let baseFootprint = 0;
  if (!section.isEmpty()) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const ring of section.toPolygons()) {
      for (const [x, y] of ring) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (Number.isFinite(minX)) baseFootprint = Math.max(maxX - minX, maxY - minY);
  }
  section.delete();

  const deviation = 1 - baseFootprint / fullFootprint;
  if (deviation > BASE_FLAT_TOLERANCE) {
    throw new SealGeometryError(
      '外部主体',
      'BodyBaseNotFlat',
      `${style.label} 在底面 0.5% 高处的截面足迹只有最大足迹的 ${((1 - deviation) * 100).toFixed(1)}%` +
        `（${baseFootprint.toFixed(3)} vs ${fullFootprint.toFixed(3)}，差 ${(deviation * 100).toFixed(1)}%）：` +
        `这个模型看起来是圆角朝下、平面朝上。刻印面必须是平面那一面，请确认模型朝向；` +
        `确实需要翻转的话，在注册表里给 ${style.id} 设 flipUpsideDown: true。`,
    );
  }
}
