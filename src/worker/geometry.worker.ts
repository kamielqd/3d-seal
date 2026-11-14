/// <reference lib="webworker" />
/**
 * 几何 Worker：把「文字多边形 + 图像位图」变成封闭实体网格。
 *
 * 放在 Worker 里的原因：布尔、描摹、网格化动辄几百毫秒，主线程会被拖成幻灯片。
 * 文字排版仍在主线程（纯数学 <1ms，要跟手）；这里只吃排好的轮廓。
 */
import { buildSeal, borderPolygons, lastBuildStats, type BuildStats } from '../geometry/pipeline.ts';
import { fromCrossSection, getManifold, inflate, sectionFromPolygons } from '../geometry/crosssection.ts';
import { combinePolygons, traceLayer } from '../geometry/trace.ts';
import type { Polygon2D } from '../geometry/types.ts';
import type { SealBuildSpec } from '../geometry/pipeline.ts';
import type { Violation } from '../geometry/printability.ts';
import type { Layer } from '../core/spec.ts';

/** 位图像素（ImageData 的结构子集，可直接 postMessage 过线） */
export interface ImagePayload {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

import type { LayerFit } from '../core/layout-bridge.ts';

export interface BuildRequest {
  id: number;
  spec: SealBuildSpec & { layers?: Layer[] };
  polygons: Polygon2D[];
  /**
   * 按文字图层 id 分组的轮廓。给了就用它分组做重叠/出界诊断；
   * 不给（旧调用方）则所有文字算一组，文字层之间的重叠查不出来。
   */
  polygonsByLayer?: Record<string, Polygon2D[]>;
  /** 按图层 id 索引的位图；没有像素的图像图层会被跳过（例如从分享链接打开） */
  images?: Record<string, ImagePayload>;
  /** 文字图层自动适应章面的结果；没有或 null 表示没缩过。多层时传整组 */
  autoFit?: LayerFit | readonly LayerFit[] | null;
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
  /** 本次构建的实际尺寸（章面足迹/总高/形状），UI 用来显示「设 30 得 20」 */
  stats?: BuildStats | null;
  mesh?: {
    vertProperties: Float32Array;
    triVerts: Uint32Array;
    numProp: number;
    triangleCount: number;
    status: string;
    /** 可打印性违规（docs/printability.md），不含 auto.fix 记录 */
    violations: Violation[];
  };
  /**
   * 参与建模的二维轮廓（**可读、未镜像**，含图像描摹结果），给盖印效果预览用。
   * 只传点，几个 KB；不然主线程得自己再描摹一遍图像。
   */
  previewRings?: Array<{ points: Array<{ x: number; y: number }> }>;
}

const ctx = self as unknown as DedicatedWorkerGlobalScope;

function stage(id: number, s: string): void {
  const msg: BuildProgress = { type: 'stage', id, stage: s };
  ctx.postMessage(msg);
}

ctx.onmessage = async (ev: MessageEvent<BuildRequest>) => {
  const { id, spec, polygons, polygonsByLayer, images, autoFit } = ev.data;
  try {
    stage(id, '初始化 manifold');
    await getManifold();

    // 图像图层：位图 → 轮廓，和文字轮廓扁平拼接（真正的并集在 prepareSection 里一次做）
    const imageGroups: Polygon2D[][] = [];
    const layerGroups: Array<{ id: string; kind: 'text' | 'image'; polygons: Polygon2D[] }> = [];
    // 文字图层按层分组：合并成一组的话「两层文字压在一起」既不会报重叠、也没法按层量出界
    const textGroups = polygonsByLayer
      ? Object.entries(polygonsByLayer).filter(([, polys]) => polys.length > 0)
      : [];
    if (textGroups.length > 0) {
      for (const [layerId, polys] of textGroups) {
        layerGroups.push({ id: layerId, kind: 'text', polygons: polys });
      }
    } else if (polygons.length > 0) {
      layerGroups.push({ id: 'text', kind: 'text', polygons });
    }
    for (const layer of spec.layers ?? []) {
      if (layer.kind !== 'image') continue;
      const image = images?.[layer.id];
      if (!image) continue;
      stage(id, '描摹图像');
      const imagePolys = await traceLayer(layer, image, {
        bodySizeMm: spec.body.sizeMm,
        mode: layer.trace.mode ?? 'silhouette',
        outlineWidthMm: layer.trace.outlineWidthMm,
      });
      imageGroups.push(imagePolys);
      // 保留每层自己的轮廓，几何层才能判断「哪块属于哪层」，做重叠检测
      layerGroups.push({ id: layer.id, kind: 'image', polygons: imagePolys });
    }
    // 伪粗体：字体文件里没有 Bold，就把这一层的轮廓整体外扩一档
    // （外扩量按字号给，7mm 字号约 +0.14mm/边，笔画大致翻一倍粗）
    let mergedSource: Polygon2D[] = polygons;
    if (polygonsByLayer) {
      let boldCount = 0;
      for (const layer of spec.layers ?? []) {
        if (layer.kind !== 'text' || layer.bold !== true) continue;
        const polys = polygonsByLayer[layer.id];
        if (!polys || polys.length === 0) continue;
        const delta = Math.max(0.02, Math.min(0.3, 0.02 * layer.fontSizeMm));
        const section = await sectionFromPolygons(polys);
        const grown = inflate(await getManifold(), section, delta);
        section.delete();
        const fat = fromCrossSection(await getManifold(), grown);
        grown.delete();
        if (fat.length === 0) continue;
        polygonsByLayer[layer.id] = fat;
        const grp = layerGroups.find((g) => g.id === layer.id);
        if (grp) grp.polygons = fat;
        boldCount += 1;
      }
      // 外扩后必须用「按层重建」的并集，否则加粗只作用于分组、不作用于最终图案
      if (boldCount > 0) mergedSource = Object.values(polygonsByLayer).flat();
    }

    const all = combinePolygons(mergedSource, ...imageGroups);

    // 边框和实体同源（同一个 borderSection），所以预览里也必须有，否则「模型有边框、预览没有」
    const borderRings = await borderPolygons(spec.body);

    stage(id, 'manifold 就绪，开始布尔');
    const mesh = await buildSeal(
      {
        ...spec,
        orientation: spec.print?.orientation ?? 'face-down',
        autoFit: autoFit ?? null,
        layerGroups: layerGroups.length >= 2 ? layerGroups : undefined,
      },
      all,
    );
    const payload: BuildResponse = {
      id,
      ok: true,
      stats: lastBuildStats(),
      mesh: {
        vertProperties: mesh.vertProperties,
        triVerts: mesh.triVerts,
        numProp: mesh.numProp,
        triangleCount: mesh.triangleCount,
        status: mesh.status,
        violations: mesh.violations ?? [],
      },
      previewRings: [
        ...all.flatMap((p) => [
          { points: p.outer.map(([x, y]) => ({ x, y })) },
          ...p.holes.map((h) => ({ points: h.map(([x, y]) => ({ x, y })) })),
        ]),
        ...borderRings.flatMap((p) => [
          { points: p.outer.map(([x, y]) => ({ x, y })) },
          ...p.holes.map((h) => ({ points: h.map(([x, y]) => ({ x, y })) })),
        ]),
      ],
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
