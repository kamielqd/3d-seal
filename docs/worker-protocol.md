# Worker 消息协议 v1

> 目标：主线程只做 React / three.js / 交互；**字体解析、描摹、布尔、镜像、导出全在 Worker**。
> 依据：manifold-3d 只有单线程 wasm（Pages 无 COOP/COEP → 无 SharedArrayBuffer），但 Worker 照用，
> 主线程不会被 200ms 的布尔拖住。协议用 `postMessage` + Transferable，零拷贝回传网格。

## 0. 边界

- 一个 module worker（`src/worker/geometry.worker.ts`），**串行**处理任务；新 build 到达时取消旧任务。
- `layout`（环形/回文排版）留在主线程：它是纯数学（<1ms），并且要同步响应拖拽。
  Worker 只提供 `outline`：字形 → 轮廓多边形。二者分工保证 `src/layout/` 可单测、不依赖 wasm。
- 契约不变：layout 出 `Polygon2D[]` → worker 只吃 `Polygon2D[]` + body + relief。

## 1. 消息总表

主 → Worker：

| type | 载荷 | 说明 |
|---|---|---|
| `init` | `{wasmUrl?: string}` | 加载 wasm 并 `setup()`，幂等 |
| `font:ensure` | `{fontId, shards: ShardRef[]}` | 拉取并解析字体分块，命中缓存则秒回 |
| `outline` | `{fontId, text, sizeMm}` | 文本 → 每字轮廓（**不排版**） |
| `build` | `{spec, polygons, options}` | 2D 图案 → 实体网格 + 校验 |
| `export` | `{format: '3mf' \| 'stl', buildId}` | 导出**上一次 build 的已镜像网格** |
| `cancel` | `{targetId}` | 幂等；已完成的任务忽略 |

Worker → 主：

| type | 载荷 | 说明 |
|---|---|---|
| `ready` | `{protocol: 1, manifold: '3.5.5', initMs}` | init 完成 |
| `font:ready` | `{fontId, shards, bytes, glyphCount, parseMs}` | 分块就绪 |
| `font:error` | `{fontId, shards, code, message}` | 404 / 解析失败 / 超时 |
| `outline:done` | `{id, glyphs, missing}` | 见 §4 |
| `build:progress` | `{id, stage, pct}` | 阶段级，不是逐三角 |
| `build:done` | `{id, buildId, mesh, stats, violations}` | mesh 的 buffer 全部 transfer |
| `build:error` | `{id, stage, code, message, detail?}` | 见 §7 |
| `export:done` | `{id, format, buffer, filename, bytes}` | buffer transfer |
| `cancelled` | `{id, stage}` | 取消生效点 |

所有请求带 `id`（`crypto.randomUUID()`），响应原样带回；`export` 用 `buildId` 而不是 `id`，因为导出对象是网格不是任务。

## 2. 任务生命周期

```
main: debounce 150ms
  → build(id=A) ──────────────► worker: 若 B 在跑则 cancel(B)
                                    init? → flatten → boolean2d → extrude → boolean3d
                                    → mirror → validate → simplify → mesh
  ◄── build:progress (0.05 / 0.25 / 0.35 / 0.5 / 0.8 / 0.9)
  ◄── build:done (mesh transfer)         ← 主线程立刻渲染预览
  → export(buildId) ──────────► worker: 3MF/STL 序列化（复用缓存网格）
  ◄── export:done (ArrayBuffer transfer)
```

规则：
- **同时只有一个 build**；最新请求赢，旧的发 `cancelled`。
- `export` 不重新计算、不重新镜像：直接序列化 cache 里的网格。
- `build:done` 之后 worker 保留网格 + `buildId`（最多 1 份），供导出和「改格式再导」复用。

## 3. 镜像与导出的先后（硬规则）

```
pattern2D → extrude → 3D 布尔 → scale([-1,1,1]) → status 校验 → simplify → getMesh
                                   ↑ 唯一一次镜像            ↓
                              violations（3D 部分）      build:done
                                                          ↓
                                              export(3mf|stl) → 直接写文件
```

1. 镜像**只在 build 里做一次**，用 `Manifold.scale([-1,1,1])`；禁止手工翻转 2D 环序（法线朝内的头号来源）。
2. 镜像后必须 `status()` 检查（实测负行列式变换后 volume 仍为正、`NoError`，但要当门禁用）。
3. 导出层**不允许**再做任何变换：STL/3MF 写的就是已镜像网格。
4. z=0 恒为贴床面；face-up 是镜像后整体绕 X 翻转 180° 再落回 z=0，不移动图案；导出只有一份网格。
5. 预览显示同一份已镜像网格，但 UI 明确标注「模型视角 / 盖印效果」两种视角。

## 4. 字体分块加载接口

```ts
export interface ShardRef { shardId: string; url: string; ttfBytes: number; ranges: [number, number][]; }
export interface GlyphOutline {
  char: string;
  glyphIndex: number;          // 0 = .notdef，必须由 missing 暴露
  advanceMm: number;
  contours: [number, number][][]; // 字体单位已换算 mm，y 轴向上，原点在基线起点
}
```

流程：
1. 主线程读 `public/fonts/manifest.json`（构建期由 fonttools 生成）：
   `[{ fontId, family, style, license, shards: ShardRef[] }]`。
2. 用户输入文本 → 主线程把码位与 `ranges` 求交，选出**需要的最少分块**。
3. `font:ensure {fontId, shards}`：worker `fetch(url, {signal})` → `opentype.parse(buffer)` → 缓存
   `Map<shardId, Font>`，按字节 LRU，上限 **32MB**（说文体 3.67MB/块，解析后堆占用约 1.5–2×）。
4. `outline` 命中缓存才回；未命中直接报 `FONT_NOT_LOADED`，由主线程先 ensure（不做隐式网络请求，
   避免慢网络下 build 卡在字体上）。
5. 缺字降级：`missing[]` 由调用方决定回退链（篆 → 宋 → 提示），worker 不猜。
6. 超时 10s；失败回退到上一个已加载字体，并让 UI 显示「篆书暂不可用」。

**TTF only**：opentype.js 不支持 WOFF2，wawoff2 会多带 1.4MB wasm，已否决（DESIGN §7）。
Pages 有 gzip，TTF 分块（说文常用 3500 档 3.67MB → gzip 后约 1.6MB）可接受。

## 5. build 请求/结果

```ts
export interface BuildRequest {
  id: string;
  spec: {
    body: BodyConfig; relief: ReliefConfig; print: PrintConfig;
    /** 可选：按图层拆开的多边形，只有传了才做同深度重叠检测 */
    layerGroups?: { id: string; kind: 'text' | 'image'; polygons: Polygon2D[] }[];
    /** 不填 = face-down（盖印面贴床）；face-up 仅 handle==='none'，否则 build:error */
    orientation?: 'face-down' | 'face-up';
  };
  /** 已按契约归一：外环 CCW、内孔 CW，mm，原点章面中心 */
  polygons: [number, number][][];
  options?: { toleranceMm?: number; simplifyMm?: number; flattenMm?: number };
}

export interface BuildResult {
  id: string;
  buildId: string;
  mesh: { positions: Float32Array; indices: Uint32Array }; // 已镜像
  stats: {
    triangles: number; vertices: number; volumeMm3: number;
    status: 'NoError' | string; genus: number;
    ms: { total: number; boolean2d: number; boolean3d: number; mesh: number };
  };
  violations: Violation[];   // docs/printability.md
}
```

约束与拒绝条件：
- `polygons.length > 2000` 或总点数 > 200k → `GEOM_TOO_COMPLEX`（先提示简化/降字号）。
- `triangles > 150_000` → 仍返回，但 `build:error` 级别 `TOO_MANY_TRIANGLES`（验收红线）。
- 所有坐标已是 mm，worker 内**不再做像素换算**。

## 6. 进度与取消

阶段与 pct（阶段边界发一次，合并 150ms 节流）：

| pct | stage | 典型耗时（40mm 章） |
|---|---|---|
| 0.05 | `flatten`（主线程已完成，实际是 sanitize） | <5ms |
| 0.25 | `boolean2d` | 10–30ms |
| 0.35 | `extrude` | 5–10ms |
| 0.50 | `boolean3d` | 20–50ms |
| 0.80 | `mirror` | <1ms |
| 0.90 | `validate+simplify+mesh` | 10–30ms |
| 1.00 | `done` | — |

**取消粒度**：manifold 的延迟布尔（CSG 树）忽略 `ExecutionContext`，只有 `status()`/`refine*`/`hull()`
这类 eager 操作能观察取消。因此：
- 取消只在**阶段边界**和**每次布尔后的 `status()`** 生效；
- 单次布尔实测 20–50ms，最坏取消延迟 ~50ms，交互上够用；
- 不给每个三角面写检查，避免 wasm 回调开销。

> 不要因为「单线程」就不开 Worker：单线程指的是 manifold 没有多核并行，跟主线程是否被阻塞是两件事。

## 7. 错误码

| code | 触发 | UI 处理 |
|---|---|---|
| `WASM_INIT` | wasm 拉取/编译失败 | 全屏错误 + 重试 |
| `FONT_NOT_LOADED` | outline 前未 ensure | 自动 ensure 后重试一次 |
| `FONT_MISSING` | 所有回退字体都缺该字 | 高亮该字，提示换字 |
| `GEOM_DEGENERATE` | ofPolygons 抛出（重复点/零面积/自交） | 自动 sanitize 重试一次，仍失败则提示具体图层 |
| `NON_MANIFOLD` | `status() !== 'NoError'` | 阻止导出，附 status 值 |
| `TRACE_EMPTY` | 描摹结果为空（阈值/反相问题） | 提示调阈值 |
| `GEOM_TOO_COMPLEX` | 点数/环数超限 | 提示简化/降字号 |
| `TOO_MANY_TRIANGLES` | >15 万面 | 警告但允许导出 |

## 8. 性能目标（worker 内，不含网络）

| 项 | 目标 | 实测依据 |
|---|---|---|
| init（wasm 201KB gz） | <300ms | Node 9.4ms + 浏览器 fetch/compile |
| outline（9.7MB TTF） | <150ms | 实测 120ms（SimHei，Node） |
| build（40mm、6 字） | <800ms | 见 §6 合计 ~100ms；复杂图像留余量 |
| export 3MF（544 面） | <30ms | 实测 12.4ms |

首帧策略：`init` 在空闲时预热；用户第一次编辑前完成，避免首次 build 多等 300ms。

### 4.1 图像图层（M3）

```
ImageLayer + ImageData
  → traceLayer(layer, image, { bodySizeMm })      // 宽度用 layer.widthMm，含 anchor/rotate/autoThreshold
  → combinePolygons(textPolys, imagePolys)        // 扁平合并；真正的并集在 prepareSection 一次完成
  → buildSeal(...)
```

- 空结果由 `traceImageData` 抛 `TraceEmptyError`（`code='TRACE_EMPTY'`），`message`/`suggestion` 直接给可执行建议（阈值 ±0.15、反相、去噪面积、换图）。
- `mode='outline'` 在 placement 里传，实心块转 0.6mm 等宽环；`silhouette` 为默认。
- 描摹不做最小笔画修正，统一交给 pipeline 的 prepareSection（避免同一份几何被处理两遍）。
