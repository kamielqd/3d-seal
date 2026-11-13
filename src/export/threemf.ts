/**
 * 3MF 导出。
 *
 * 3MF 相比 STL 的好处：带单位（millimeter）、带元数据、单位是规范的一部分，
 * 切片软件不会再去猜尺寸。这里直接按 3MF Core 规范拼一个最小可用包
 * （三份 XML + zip），只依赖 fflate 做压缩，不走 @jscadui/3mf-export 的
 * 场景图抽象 —— 我们只有一个实体，自己写更可控也更好调试。
 */

import { zipSync } from 'fflate';
import type { SolidMesh } from '../geometry/types.ts';

export interface ThreeMfOptions {
  title?: string;
  designer?: string;
  /** 生成时间，默认当前时间（ISO 8601）。 */
  createdAt?: string;
  /** zip 压缩等级 0–9，默认 6。 */
  level?: number;
}

const NS_CORE = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';
const REL_TYPE_MODEL = 'http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel';

/**
 * 生成 3MF 包。
 *
 * 坐标原样使用：单位声明为 millimeter，所以 STL 与 3MF 里的数字完全一致。
 */
export function to3mf(mesh: SolidMesh, options: ThreeMfOptions = {}): Uint8Array {
  const title = (options.title ?? '3D 印章').trim() || '3D 印章';
  const designer = options.designer ?? '3D 印章生成器';
  const createdAt = options.createdAt ?? new Date().toISOString();

  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>`;

  const rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="${REL_TYPE_MODEL}"/>
</Relationships>`;

  const model = buildModelXml(mesh, { title, designer, createdAt });

  const encoder = new TextEncoder();
  const level = (options.level ?? 6) as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
  const zipped = zipSync(
    {
      '[Content_Types].xml': encoder.encode(contentTypes),
      '_rels/.rels': encoder.encode(rels),
      '3D/3dmodel.model': encoder.encode(model),
    },
    { level },
  );
  return zipped;
}

/** 生成可直接下载的 Blob。 */
export function to3mfBlob(mesh: SolidMesh, options: ThreeMfOptions = {}): Blob {
  const bytes = to3mf(mesh, options);
  // 复制进独立 ArrayBuffer：BlobPart 不接受 SharedArrayBuffer 视图
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return new Blob([buffer], { type: 'model/3mf' });
}

interface ModelMeta {
  title: string;
  designer: string;
  createdAt: string;
}

function buildModelXml(mesh: SolidMesh, meta: ModelMeta): string {
  const { vertProperties, triVerts, numProp } = mesh;
  const vertexCount = Math.floor(vertProperties.length / numProp);
  const triCount = mesh.triangleCount;

  const parts: string[] = [];
  parts.push('<?xml version="1.0" encoding="UTF-8"?>');
  parts.push(`<model unit="millimeter" xml:lang="zh-CN" xmlns="${NS_CORE}">`);
  parts.push('  <metadata name="Title">' + escapeXml(meta.title) + '</metadata>');
  parts.push('  <metadata name="Designer">' + escapeXml(meta.designer) + '</metadata>');
  parts.push('  <metadata name="Application">3D Seal Generator</metadata>');
  parts.push('  <metadata name="CreationDate">' + escapeXml(meta.createdAt) + '</metadata>');
  parts.push('  <resources>');
  parts.push('    <object id="1" type="model" name="' + escapeXml(meta.title) + '">');
  parts.push('      <mesh>');
  parts.push('        <vertices>');

  for (let i = 0; i < vertexCount; i++) {
    const base = i * numProp;
    parts.push(
      `          <vertex x="${fmt(vertProperties[base]!)}" y="${fmt(vertProperties[base + 1]!)}" z="${fmt(vertProperties[base + 2]!)}"/>`,
    );
  }

  parts.push('        </vertices>');
  parts.push('        <triangles>');
  for (let t = 0; t < triCount; t++) {
    parts.push(
      `          <triangle v1="${triVerts[t * 3]!}" v2="${triVerts[t * 3 + 1]!}" v3="${triVerts[t * 3 + 2]!}"/>`,
    );
  }
  parts.push('        </triangles>');
  parts.push('      </mesh>');
  parts.push('    </object>');
  parts.push('  </resources>');
  parts.push('  <build>');
  parts.push('    <item objectid="1"/>');
  parts.push('  </build>');
  parts.push('</model>');
  return parts.join('\n');
}

/** 3MF 里数值用固定 6 位小数，避免科学计数法（部分切片器不认）。 */
function fmt(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const fixed = value.toFixed(6);
  return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

