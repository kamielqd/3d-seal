/**
 * 只给打包器看的 wasm 资源入口。
 *
 * Vite 会把 `?url` 变成「产出到 assets/、带 hash 的 URL」。
 *
 * 用法注意：**只能用动态 import**（见 crosssection.loadKit）。
 * 静态 import 会让 Node 端脚本（build-sample / verify）在解析阶段就报
 * `ERR_PACKAGE_PATH_NOT_EXPORTED`，因为 Node 不认识 Vite 的 `?url` 说明符。
 */

import manifoldWasmUrl from 'manifold-3d/manifold.wasm?url';

/** 打包产物里 wasm 的最终 URL（相对 base）。 */
export const wasmUrl: string = manifoldWasmUrl;

export default manifoldWasmUrl;

/**
 * 把 wasm 二进制自己取回来。
 *
 * 为什么不让 Emscripten 自己去找：打包后 glue 里那套
 * `scriptDirectory` / `locateFile` 的路径推断在 Worker 里不可靠
 * （模块 Worker 没有 importScripts，环境判定会全部落空），
 * 表现是 `Module()` 的 Promise 永远不 settle —— 不报错、不 resolve。
 * 自己 fetch 再通过 `wasmBinary` 喂进去，就完全没有路径推断参与。
 */
export async function loadManifoldWasmBinary(): Promise<Uint8Array | null> {
  if (typeof fetch !== 'function') return null;
  const response = await fetch(manifoldWasmUrl);
  if (!response.ok) {
    throw new Error(`manifold.wasm 下载失败：HTTP ${response.status} ${manifoldWasmUrl}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength < 1024) {
    throw new Error(`manifold.wasm 体积异常：${bytes.byteLength} 字节`);
  }
  return bytes;
}
