/**
 * 分享链接：把 SealSpec 编码进 URL。
 *
 * 限制：图像图层没法塞进 URL（二进制太大、也不该上传），
 * 所以分享时会丢掉图像层，并在返回值里明确告诉调用方丢了几个。
 */
import { deserializeSpec, serializeSpec, type SealSpec } from './spec';

const PARAM = 's';

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export interface EncodedShare {
  query: string;
  /** 因为无法序列化而被丢弃的图像图层数量 */
  droppedImages: number;
}

export function encodeSpecForUrl(spec: SealSpec): EncodedShare {
  const textLayers = spec.layers.filter((l) => l.kind === 'text');
  const droppedImages = spec.layers.length - textLayers.length;
  const stripped: SealSpec = { ...spec, layers: textLayers };
  return { query: `${PARAM}=${toBase64Url(serializeSpec(stripped))}`, droppedImages };
}

export function decodeSpecFromQuery(search: string): SealSpec | null {
  const params = new URLSearchParams(search);
  const raw = params.get(PARAM);
  if (!raw) return null;
  try {
    return deserializeSpec(fromBase64Url(raw));
  } catch {
    return null;
  }
}

export function buildShareUrl(spec: SealSpec, base?: string): EncodedShare & { url: string } {
  const { query, droppedImages } = encodeSpecForUrl(spec);
  const url = base ?? `${location.origin}${location.pathname}`;
  return { url: `${url}?${query}`, query, droppedImages };
}

/** 读取当前地址栏里的 spec（没有或解析失败返回 null） */
export function readSpecFromLocation(): SealSpec | null {
  return decodeSpecFromQuery(location.search);
}

/** 复制到剪贴板；不可用时返回 false，让调用方走「手动复制」提示 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
