/// <reference lib="webworker" />
/**
 * 几何 Worker：把「文字多边形 + 图像位图」变成封闭实体网格。
 *
 * 放在 Worker 里的原因：布尔、描摹、网格化动辄几百毫秒，主线程会被拖成幻灯片。
 * 文字排版仍在主线程（纯数学 <1ms，要跟手）；这里只吃排好的轮廓。
 */
import { buildSeal } from '../geometry/pipeline';
import { getManifold } from '../geometry/crosssection';
import { combinePolygons, traceLayer } from '../geometry/trace';
import type { Polygon2D } from '../geometry/types';
import type { SealBuildSpec } from '../geometry/pipeline';
import type { Violation } from '../geometry/printability';
import type { Layer } from '../core/spec';

/** 位图像素（ImageData 的结构子集，可直接 postMessage 过线） */
export interface ImagePayload {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface BuildRequest {
  id: number;
  spec: SealBuildSpec & { layers?: Layer[] };
  polygons: Polygon2D[];
  /** 按图层 id 索引的位图；没有像素的图像图层会被跳过（例如从分享链接打开） */
  images?: Record<string, ImagePayload>;
}

export interface BuildProgress {
  type: 'stage';
  id: number;
  stage: string;
}

export interface BuildResponse {
  id: number;
  ok: boolean;
  error?: string;
  /** 结构化错误码（TRACE_EMPTY / GEOM_DEGENERATE / NON_MANIFOLD …） */
  code?: string;
  stage?: string;
  mesh?: {
    vertProperties: Float32Array;
    triVerts: Uint32Array;
    numProp: number;
    triangleCount: number;
    status: string;
    /** 可打印性违规（docs/printability.md），不含 auto.fix 记录 */
    violations: Violation[];
  };
}

const ctx = self as unknown as DedicatedWorkerGlobalScope;

function stage(id: number, s: string): void {
  const msg: BuildProgress = { type: 'stage', id, stage: s };
  ctx.postMessage(msg);
}

ctx.onmessage = async (ev: MessageEvent<BuildRequest>) => {
  const { id, spec, polygons, images } = ev.data;
  try {
    stage(id, '初始化 manifold');
    await getManifold();

    // 图像图层：位图 → 轮廓，和文字轮廓扁平拼接（真正的并集在 prepareSection 里一次做）
    const imageGroups: Polygon2D[][] = [];
    for (const layer of spec.layers ?? []) {
      if (layer.kind !== 'image') continue;
      const image = images?.[layer.id];
      if (!image) continue;
      stage(id, '描摹图像');
      imageGroups.push(
        await traceLayer(layer, image, {
          bodySizeMm: spec.body.sizeMm,
          mode: layer.trace.mode ?? 'silhouette',
          outlineWidthMm: layer.trace.outlineWidthMm,
        }),
      );
    }
    const all = combinePolygons(polygons, ...imageGroups);

    stage(id, 'manifold 就绪，开始布尔');
    const mesh = await buildSeal(
      { ...spec, orientation: spec.print?.orientation ?? 'face-down' },
      all,
    );
    const payload: BuildResponse = {
      id,
      ok: true,
      mesh: {
        vertProperties: mesh.vertProperties,
        triVerts: mesh.triVerts,
        numProp: mesh.numProp,
        triangleCount: mesh.triangleCount,
        status: mesh.status,
        violations: mesh.violations ?? [],
      },
    };
    ctx.postMessage(payload, [mesh.vertProperties.buffer, mesh.triVerts.buffer]);
  } catch (err) {
    const e = err as { code?: string; stage?: string; message?: string };
    const payload: BuildResponse = {
      id,
      ok: false,
      code: e?.code,
      stage: e?.stage,
      error: err instanceof Error ? err.message : String(err),
    };
    ctx.postMessage(payload);
  }
};

// 模块加载完成的信号：如果主线程收不到这个，说明 Worker 脚本本身没跑起来
ctx.postMessage({ type: 'ready' });
