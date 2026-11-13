/**
 * 二进制 STL 导出。
 *
 * 格式：80 字节头 + uint32 三角形数 + 每个三角形 50 字节
 * （12 字节法线 + 3×12 字节顶点 + uint16 属性）。
 *
 * 不依赖任何库：切片软件全都吃这个格式，作为兜底导出路径。
 */

import type { SolidMesh } from '../geometry/types.ts';

const HEADER_BYTES = 80;
const TRI_BYTES = 50;

/**
 * 生成二进制 STL。
 *
 * @param mesh 实体网格（顶点属性前三个是 x/y/z）
 * @param title 写进 80 字节头的标记，最长 79 个 ASCII 字符
 */
export function toBinaryStl(mesh: SolidMesh, title = '3d-seal'): ArrayBuffer {
  const triangles = mesh.triangleCount;
  const buffer = new ArrayBuffer(HEADER_BYTES + 4 + triangles * TRI_BYTES);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  for (let i = 0; i < Math.min(title.length, HEADER_BYTES); i++) {
    const code = title.charCodeAt(i);
    bytes[i] = code < 128 ? code : 63; // 非 ASCII 用 '?'
  }
  view.setUint32(HEADER_BYTES, triangles, true);

  const { vertProperties, triVerts, numProp } = mesh;
  let offset = HEADER_BYTES + 4;

  for (let t = 0; t < triangles; t++) {
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

    let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;

    view.setFloat32(offset, nx, true);
    view.setFloat32(offset + 4, ny, true);
    view.setFloat32(offset + 8, nz, true);
    view.setFloat32(offset + 12, ax, true);
    view.setFloat32(offset + 16, ay, true);
    view.setFloat32(offset + 20, az, true);
    view.setFloat32(offset + 24, bx, true);
    view.setFloat32(offset + 28, by, true);
    view.setFloat32(offset + 32, bz, true);
    view.setFloat32(offset + 36, cx, true);
    view.setFloat32(offset + 40, cy, true);
    view.setFloat32(offset + 44, cz, true);
    view.setUint16(offset + 48, 0, true);
    offset += TRI_BYTES;
  }

  return buffer;
}

/** 生成可直接下载的 Blob。 */
export function toStlBlob(mesh: SolidMesh, title = '3d-seal'): Blob {
  return new Blob([toBinaryStl(mesh, title)], { type: 'model/stl' });
}
