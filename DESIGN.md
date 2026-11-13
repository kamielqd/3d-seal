# 3D 印章生成器 · 方案设计（v0.2）

> 浏览器端、纯静态、可部署 GitHub Pages 的「可打印实体印章」生成器。
> v0.2（2026-11-13）：把两轮调研的**本机实测数据**全部并入，v0.1 里靠估算写的项（potrace、WOFF2、手翻环序、0.02mm 扁平化）已按实测结论改掉。
> 配套文档：[可打印性校验规则](docs/printability.md) · [Worker 协议](docs/worker-protocol.md)

## 1. 目标与约束

**做什么**：让用户输入文字/图像，选形状与版式，实时看到可打印的 3D 印章模型，导出 3MF/STL 交给切片软件。

**不做什么**：不做「电子印章 PNG 生成器」（已有大量同类），不做公章仿真（法律风险），不做云端存储。

**硬约束**

| 约束 | 含义 |
|---|---|
| 纯前端 | 无后端、无数据库、无账号；所有计算在浏览器完成 |
| 静态托管 | Vite 构建产物直接丢 GitHub Pages，`base` 需可配置 |
| 可打印 | 输出必须是封闭流形；参数以 mm 计；默认值面向真实打印 |
| 隐私 | 用户上传的图像与字体**不上传**，仅在本机内存中处理 |

**GitHub Pages 带来的两条硬限制**

- 设不了 `COOP/COEP` 响应头 → **没有 SharedArrayBuffer** → manifold 只能用单线程版。多线程方案（`manifold-3d` 的 threaded 构建）直接排除。
- 但这**只影响 manifold 的多核并行，不影响 Web Worker**。字体解析、布尔、导出仍然全部在 Worker 里跑，主线程只留排版与 three.js 渲染。别把「单线程」理解成「不用 Worker」。

## 2. 分层架构

```
┌──────────────────────────────────────────────┐
│ UI 层        参数面板 / 3D 视口 / 图层列表     │
│              盖印效果预览（Canvas 2D）         │
├──────────────────────────────────────────────┤
│ 状态层       SealSpec（唯一数据源）+ 撤销重做   │
│              变更订阅 → 触发增量重建            │
├──────────────────────────────────────────────┤
│ 版式引擎     把 SealSpec 变成「一组二维图元」   │
│  （主线程）   文字排布 / 环形分配 / 回文 / 边框  │
├──────────────────────────────────────────────┤
│ 几何引擎     图元 → 多边形环 → 布尔 → 实体网格  │
│  (Worker)    manifold-3d WASM + opentype.js    │
├──────────────────────────────────────────────┤
│ 导出层       3MF（默认）/ STL（兼容）/ PNG 预览 │
└──────────────────────────────────────────────┘
```

关键设计：**版式引擎与几何引擎解耦**。版式产出纯二维多边形，几何引擎不关心「这是圆章还是方章」。新增章型只需写版式，不动几何。

排版留在主线程的理由：纯数学运算 <1ms，放主线程才能让拖参数时文字位置立即跟手；字形取轮廓（几十 ms，且要解析字体文件）才进 Worker。

## 3. 数据结构：SealSpec

所有状态收敛成一个可序列化对象，好处：URL 分享、撤销重做、增量重建都只依赖它。

```ts
interface SealSpec {
  version: 1;
  body: {
    shape: 'square' | 'circle' | 'polygon';
    sides?: number;          // polygon: 3~12
    sizeMm: number;          // 外接尺寸
    cornerRadiusMm?: number;
    baseThicknessMm: number;
    border: { style: 'none' | 'thin' | 'thick' | 'double';
              widthMm: number; insetMm: number };
    handle: 'none' | 'knob' | 'bridge' | 'custom';
    handleHeightMm: number;
  };
  relief: { mode: 'raised' | 'engraved'; depthMm: number };
  layers: Layer[];           // 文字层与图像层，有序
  print: { process: 'fdm' | 'resin';
           minStrokeMm: number; minGapMm: number;
           units: 'mm' };
}

type Layer =
  | { kind: 'text'; id: string; text: string; fontId: string;
      layout: 'horizontal' | 'vertical' | 'ring' | 'huiwen';
      fontSizeMm: number; letterSpacingMm: number;
      ringStartDeg?: number; ringSpanDeg?: number;
      anchor: { x: number; y: number };   // 归一化坐标 -1~1
      transform: { rotateDeg: number; scale: number }; }
  | { kind: 'image'; id: string; src: 'uploaded' | 'builtin';
      trace: { threshold: number; invert: boolean; despeckle: number;
               simplify: number; mode: 'outline' | 'silhouette' };
      anchor: { x: number; y: number };
      transform: { rotateDeg: number; scale: number; flipX: boolean }; };
```

为什么 anchor 用归一化坐标：形状尺寸一变，版式自动跟随，用户不用重排。

## 4. 几何管线

### 4.1 二维阶段（快，可高频重算）

```
text  → opentype.js charToGlyph → Path
      ① 判 glyph.index === 0 → 缺字，直接抛 MISSING_GLYPH（不能靠 path 为空判断：豆腐块也有 path）
      ② 归一化：把 MmLlQqCcZzHhVv 全部展开为绝对 M/L/C/Z
          （opentype 2.0 会输出 H/V 和相对指令；flatten 只认绝对 MLCZ，不归一化就丢笔画）
      ③ 自适应扁平化，**默认误差 0.05mm**（喷嘴 0.4mm，0.05 已远超需求）；0.02mm 只在「高清导出」开关下用，点数量约 +20%
      ④ 拆子路径 → 环方向归一（外环 CCW / 内孔 CW）
      （复合字形由 opentype 的 componentGlyph 自动展开，不需要特殊处理）

image → 位图 → 灰度 → 阈值/反相 → marching squares（网格 0.1mm）
      → 边界追踪成闭合环 → simplify(DP, 0.1mm)
      → 丢弃零面积环（<1e-4 mm²）
```

**图像描摹不用 potrace**：`esm-potrace-wasm` 内核是 GPL-2.0，打进静态 bundle 等于整个项目受 GPL 约束，不值得。自研 marching squares 约 150 行，网格 0.1mm，产出的锯齿在 0.4mm 喷嘴尺度下看不出来；平滑贝塞尔对印章线条不是刚需。备选 `imagetracerjs`（Unlicense，11.7KB gz）只在自研版出问题时装上。

**高度图浮雕直接否掉**：印章要共面着墨，高度不齐盖不实。

```
【最小笔画修正】closing(0.2) 先补缝，再 offset(+Δ) 外扩到 >= minStrokeMm
    ★ 只许外扩，禁止内缩：实测向内 offset 0.2mm 会让文字面积从 331mm² 掉到 179mm²，
      约 46% 的细笔画直接消失。要变细只能改字号/字重，不能靠几何层缩。

allShapes = [border] ∪ textShapes ∪ imageShapes
pattern2D = CrossSection.ofPolygons(allShapes, 'NonZero')   // 2D 裁剪比 3D 布尔快一个数量级
```

环方向不需要额外修复：`CrossSection.ofPolygons` 按 fill-rule 自己处理内外环，外环 +1 / 内孔 −1 会自然交替（实测「回日国」20mm 出 11 个环，回 4、国 4、印 2）。`polygon.ts` 不做 earcut 那套三角化，只负责去重、清洗退化点、丢掉零面积环。

**为什么先做 2D 布尔**：文字笔画重叠、图像与原边框相交，都在二维解决；三维只做「挤出 + 一次差集」，网格质量最好。

### 4.2 三维阶段（Worker 内，顺序是硬规则）

```
boolean2d → extrude → boolean3d → scale([-1,1,1]) → status → simplify(0.01) → getMesh → 导出
```

```
body   = extrude(bodyOutline, baseThicknessMm) ∪ handle
raised : solid = body ∪ extrude(pattern2D, depthMm)
engraved: solid = body − extrude(pattern2D, depthMm)
經 scale([-1,1,1]) 镜像后 solid.status 必须仍为 NoError，且 volume > 0
```

**镜像只在 pipeline 最后一步做一次，并且交给 Manifold 的 `scale([-1,1,1])`**。实测镜像后 volume 仍为正、status 仍为 NoError、环方向与法线由 manifold 自己纠正。

**禁止手工翻转 2D 环序做镜像** —— 那正是「实体看着对、切片软件显示法线朝内」的头号来源。导出层禁止任何额外变换，STL/3MF 写出去的就是已镜像的网格。

预览用同一份网格，UI 上明确标「模型视角 / 盖印效果」两个视角，避免用户以为模型本身反了。

### 4.3 库选型与实测数据（2026-11-13 本机实测，非估算）

| 项 | 实测结论 |
|---|---|
| 布尔内核 | `manifold-3d@3.5.5`，Apache-2.0；wasm **530KB / 201KB gz** + glue 18.7KB gz，Node 初始化 **9.4ms** |
| 性能 | 40mm 章体+手柄+126 笔画 → 4,074 面，挤出+布尔 25ms；「回日国」20mm → 504 面 / 0.9ms，并底板 13.6ms / 544 面 |
| 面数余量 | 距 15 万上限约 30 倍 |
| 封闭性 | `status` 全程 `NoError`，**可直接当生成门禁** |
| 与 three.js | 手写 `BufferGeometry ↔ Manifold`（vertProperties/triVerts）几十行，**不需要 three-bvh-csg** |
| 3MF | 同一 544 面：STL **27,284B** vs 3MF **6,281B**，3MF 头带 `unit="millimeter"`，生成 12.4ms |
| 3MF 库 | `@jscadui/3mf-export`（MIT，3.5KB / 1.4KB gz）+ `fflate`（22KB gz）。`three-3mf-exporter` 要拖 jszip+fast-xml-parser、manifold 自带 export-3mf 要 gltf-transform，都更重 |
| STL | 无依赖，手写 `84 + 50n` 字节 |
| 取消粒度 | manifold 的延迟 CSG 忽略 ExecutionContext，只有 `status()`/`refine*`/`hull()` 能观察取消 → 只在阶段边界和每次布尔后查，最坏延迟 ~50ms，足够；不给逐三角加回调 |

**导出默认 3MF，STL 作为兼容选项**：体积差 4.3 倍，且 3MF 自带毫米单位，切片器不用再问尺寸。

### 4.4 管线最终形态

```
字体/图片 → 轮廓 → 归一化+扁平化 → 环方向归一 → 丢退化环
→ CrossSection 闭运算(0.2) + offset 外扩(到 0.4mm 下限)
→ extrude → 与章体/手柄做一次 3D 布尔 → scale([-1,1,1])
→ status 门禁 → simplify → 预览 mesh + 3MF/STL
```

**最大风险不是封闭性，是「封闭但印不出来」**：笔画 <0.4mm、间隙 <0.4mm、阴刻槽深宽比过大、浮雕悬空。这些靠 §6 的校验规则兜，不靠肉眼。

第二风险是脏输入：重复点、零面积环会让 `ofPolygons` 抛错。`polygon.ts` 必须先清洗，错了就 `sanitize → 重试一次 → 仍失败报 GEOM_DEGENERATE`。

## 5. 版式引擎要点

| 版式 | 算法 |
|---|---|
| 横排 | 字宽累加 + 字距，整体居中到 anchor |
| 竖排 | 同上，轴旋转 90°；传统方章为**右起**（第一字在右） |
| 环形 | 总角度 = Σ(字宽/r + 间隙/r)，均分后每字绕圆心旋转，字头朝外 |
| 回文 | 四字按 右上→右下→左上→左下 定位，方章专用 |

环形排版公式（字心落在半径 r 的圆上）：
`angle_i = start + (Σ_{j<i} (w_j + gap)) / r`
每字旋转角 = `angle_i - 90°`，使字头指向圆心外侧。

## 6. 可打印性校验

**不阻断导出**（除硬错误），按等级提示，并把违规**高亮到具体笔画**——用户必须看见是哪一笔有问题，而不是读一条警告。完整规则见 [docs/printability.md](docs/printability.md)。

| ID | 规则 | FDM | 树脂 | 检测 | 修复 |
|---|---|---|---|---|---|
| `stroke.min` | 最小笔画宽 | 0.4 | 0.2 | 连通域栅格化 0.05mm → EDT → 骨架局部极大值最小值×2 | closing(0.2) → offset(+Δ)，**禁止内缩** |
| `gap.min` | 笔画间隙 | 0.4 | 0.15 | 空区 EDT，相邻域喉部 d_A+d_B | 改字号/字距/字重 |
| `island.min` | 孤立小岛 | <0.5mm² | <0.1mm² | decompose + area | 自动删除或 offset(+0.05) 粘连 |
| `relief.aspect` | 浮雕高宽比 | depth ≤ 2×w | ≤3×w | depth / 域最小笔画 | 降 depth 或加粗 |
| `groove.aspect` | **阴刻槽深宽比** | depth ≤ w | ≤1.5×w | depth / min(w,gap) | 1.2mm 深 × 0.4mm 宽的槽喷嘴进不去，建议 ≤0.8mm 或改阳刻 |
| `nozzle.feature` | 亚喷嘴特征 | 0.4 | 0.2 | opening(0.2) 丢失面积 >0.05mm² | 提示「切片器会跳过」+ 一键加粗 |
| `overhang.angle` | 悬空面 | >60° | 忽略 | 朝下面 n.z < −0.866 的面积 | 章面朝下 / 加支撑 / 换 bridge 手柄 |
| `base.flat` | 底面平行 | ≤0.02mm | 同 | 最低 z 面法线/高度一致 | **error**，通常是镜像后又被别的变换动过 |
| `size.range` | 尺寸 | 10–60mm | 5–50mm | 读 spec | 越界拒绝生成 |

两条实现要点：

- **阳刻与阴刻共用同一套度量**：阳刻看笔画厚度、阴刻看孔宽，间隙都取图案空区，不用按模式分叉检测。
- 阴刻必须单独加 `groove.aspect`。全表 2D 检测共用一次 800×800 EDT，**<30ms**，可以跟着每次重建跑。

## 7. 字体策略

**结论：只用 TTF 分块，不碰 WOFF2，不做 CSS unicode-range 分片。**

- opentype.js **不支持 WOFF2**，配 `wawoff2` 要多带 ~1.4MB wasm，换来的只是字体体积减半——而字体本来就按需拉，不值。
- CSS `unicode-range` 只影响 `@font-face` 的文本渲染，对 opentype.js 取轮廓**无效**（整包 parse，没有按字形懒加载）。所以分片必须在**构建期切成多个合法子集字体**，运行时按需 fetch + parse。
- UI 里的字体预览不另装 `@font-face`：直接用 opentype.js 的 path 画到 canvas。**同一份轮廓两处复用，省掉整个第二份字体负载。**

### 7.1 字体清单与授权

| 字体 | 授权 | 风格 | 覆盖 | 体积 | 加载 |
|---|---|---|---|---|---|
| 得意黑 Smiley Sans | OFL-1.1 | 黑体 | GB2312 6763 + 通规 8105（实 8335） | 3500 子集 TTF 0.94MB（6763 档 1.77MB） | **首屏常驻** |
| 全字库说文解字 | 政府资料开放授权 OGDL v1（需署名） | 小篆 | **6750 字形**，GB2312 一级只覆盖 2699/3755 | 源 9.9MB → 分两块 1.27MB + 2.27MB | 篆书模式按需 |
| 霞鹜篆书 LXGWSeal | OFL-1.1 | 小篆 | **仅 75 字**（节庆/生肖/干支/节气/朝代/五行） | 222KB | 主题字，随篆书模式 |
| 思源宋体 Noto Serif SC | OFL-1.1 | 宋体 | 全 CJK | 3500 子集约 1MB（估） | 按需 |

**授权是发布硬闸，不是可选项**：

- 崇羲篆體 CC BY-**ND** 3.0 直接排除——ND 禁改作，子集化和嵌入都有法律风险。
- 「免费商用」≠「可嵌入分发」。OFL 明确允许嵌入与再分发；站酷、阿里普惠、OPPO Sans 这类未明确授予字体重分发权，不能打包，只能拿授权或服务端出图。
- 必须做一个「字体与授权」页面：说文按 OGDL 要求署名，OFL 字体随页附授权文本。这是上线前检查项。

### 7.2 分块与加载

- 首屏**只装得意黑**一款（gzip 约 0.55MB），其余全部按需。得意黑的覆盖到通规 8105，日常用不会缺字。
- **说文切成两块**，按现代汉语字频（清华 6763 字频表，`hanzipinlv`）定：首块 1000 高频字 **1.27MB / 0.93MB gz**，其余 1596 字 **2.27MB / 1.65MB gz**。合计 3.54MB / ≈2.58MB gz，只在用户把字体切成篆书时才加载，首块之外懒加载。清单与脚本均可复现：`src/layout/data/shuowen-block{1,2}.txt`、`scripts/gen-shuowen-blocks.py`。
- 简体输入靠**构建期生成的简→繁映射表**（只保留 3500 常用字范围，1316 条，**15.4KB / 7.2KB gzip**），运行时不引 opencc 整包。
- Worker 侧：`manifest.json` 给 `{fontId, shards:[{id,url,ttfBytes,ranges}]}`，按输入码位求「最少分块组合」→ `font:ensure` → 解析后按字节 LRU 缓存（上限 32MB，移动端可下调）。未命中报 `FONT_NOT_LOADED`，**不做隐式网络请求**。
- 生僻字兜底：用户本地选 TTF/OTF，`opentype.parse(ArrayBuffer)` 直接解析，不上传。

### 7.3 缺字策略：不混排

说文的覆盖率只有 72%（按 GB2312 一级 3755 字算，缺 1056；按字频前 3500 算可渲染 2596 字、**74%**，缺 904）——缺的全是《说文》未收的后起字：的、个、们、你、他、她、这、那、吗、呢、为、坊…。注意两套常用字集口径不同，**运行时一律以「该字不在字型 cmap」逐字判定**，这两张统计表只作参考。真实印章内容好很多——百家姓前 100 覆盖 93，吉语基本全中（福禄寿喜 / 吉祥如意 / 长命百岁 / 万事如意 / 招财进宝 / 恭喜发财 / 龙凤呈祥 / 紫气东来 都是 4/4），个别缺（财源广进缺「源」、前程似锦缺「前似」、花好月圆缺「花」）。

**规则：回退只能整章发生，不能逐字发生。**

- 一个章里同时出现篆书和宋体，盖出来是废品。自动逐字补位比不补更糟。
- 做法：输入后逐字检查，缺的字在输入框标红 + 右侧列「说文未收此字」+ 推荐替换词（源→原）。宁可让用户换词。
- Worker 只返回 `missing[]`，**回退决策在主线程**，且只有两个选项：整章换字体，或让用户改词。

**验收用例：「印章工坊」用说文模式必然缺「坊」**，降级提示能否正确出现，就是这条链路的测试。

## 8. 体积与性能预算

**首屏（gzip）**

| 项 | 体积 |
|---|---|
| manifold wasm + glue | 220KB |
| opentype.js 2.0 | 66KB |
| 3MF 导出（3mf-export + fflate） | 25KB |
| 应用壳（React 19 + three 0.187） | ~200KB（估） |
| 得意黑 3500 子集 TTF | ~550KB |
| **合计** | **≈1.05MB** |

**按需**

| 项 | 体积 |
|---|---|
| 说文首块 1000 字 | 1.27MB / 0.93MB gz |
| 说文剩余 1596 字 | 2.27MB / 1.65MB gz |
| 霞鹜篆书全量 | 222KB |
| 思源宋体 3500 子集 | ~1MB |
| 简→繁映射表 | 7.2KB gz |

**性能目标**

| 指标 | 目标 |
|---|---|
| 首次加载（gzip，含得意黑） | < 1.2MB |
| 改参数 → 预览刷新 | < 500ms（Worker 计算 + transfer 传输） |
| 几何内核单次布尔 | 20–50ms，取消最坏延迟 ~50ms |
| 导出 3MF（40mm 章） | < 2s（主要是组装，不是布尔） |
| 三角面规模 | 3 万–15 万 |
| 2D 可打印性检测 | < 30ms |

## 9. 里程碑

| 阶段 | 交付 | 验收 |
|---|---|---|
| M1 | 方章 + 横排文字 + 阳/阴刻 + 3MF/STL + 镜像 | **几何链路已验收通过**：`scripts/e2e-m1-check.ts` 18 项全绿——方章阳刻 1628 面 / 56ms、阴刻 1944 面、三种章体+两种手柄均 NoError、镜像正确（+x 图案落在 −8.31~−1.70）、STL 81,484B = 84+50n、3MF 18,191B（比 STL 小 4.5×）且 `unit="millimeter"`、三角数一致。**待补：UI 与 Worker 串起来** |
| M2 | 圆章环形文字 + 正多边形 + 竖排/回文 | 六字圆章外圈不重叠、字头朝外 |
| M3 | 图像导入（marching squares 描摹）+ 图层拖动缩放 | 黑白线稿导入后可正常浮雕，洞正确挖空 |
| M4 | 可打印性校验 + 工艺预设 + 笔画高亮 | 故意把笔画调细能触发 `stroke.min` 并高亮到那一笔 |
| M5 | 篆书模式（说文分块加载 + 缺字提示）+ URL 分享 + 预设模板 | 「印章工坊」在说文模式下正确报缺「坊」 |

## 10. 风险

| 风险 | 影响 | 对策 |
|---|---|---|
| 中文字体体积 | 首屏爆炸 | 只常驻得意黑；说文分两块按需；用户上传兜底 |
| 篆书覆盖率仅 72% | 卖点打折 | 不混排 + 缺字提示 + 替换词建议；吉语/姓氏实测覆盖够用 |
| 封闭但印不出来 | 用户白打一次 | §6 全表校验 + 高亮到笔画，默认值按 FDM 0.4 喷嘴 |
| 布尔运算退化 | 生成破面 | sanitize→重试一次；`status` 卡门禁；失败降级提示而非静默出坏模型 |
| 移动端 WASM 内存 | 崩溃 | 限制面数；LRU 32MB 可下调；超限降精度提示 |
| 图像描摹质量 | 效果差 | 阈值/反相/去噪/简化四个可调项 |
| 字体授权 | 法律风险 | 排除 ND；上线前过一遍「字体与授权」页 |

## 11. 已定决策（2026-11-13）

| 决策 | 结论 |
|---|---|
| 范围 | **一次性做完整**：方/圆/正多边形、横排/竖排/环形/回文、图像导入、阳刻阴刻、手柄造型、3D 预览、3MF + STL、分享链接 |
| 工艺取向 | **FDM 为主**：默认笔画 ≥0.4mm、间隙 ≥0.4mm、浮雕 1.2mm、章面 25–40mm；树脂作可切预设（0.2 / 0.15） |
| 技术路线 | Vite + React + TS；three.js 渲染；manifold-3d 布尔；opentype.js 取字形；几何全部在 Worker |
| 布尔内核 | manifold-3d，**唯一选择**（1000 组基准全部输出封闭流形，three-bvh-csg 仅 22/1000） |
| 镜像 | 最后一步做一次 `scale([-1,1,1])` 或 `mirror([1,0,0])`（实测等价），**禁止手工翻转 2D 环序**，导出层无变换 |
| 导出 | **3MF 默认** + STL 兼容 |
| 图像描摹 | 自研 marching squares（EvenOdd），**不用 potrace**（GPL） |
| 字体加载 | 只用 TTF 分块；不碰 WOFF2/wawoff2；预览复用 opentype path，不装第二份字体 |
| 缺字 | **不混排**，整章决策 |
| 部署 | GitHub Pages，`base: './'` 相对路径，无后端 |

## 12. 仍未定

1. 是否要「盖印效果」模拟（纸张纹理 + 墨迹不均）——M5 之后再定，不影响架构
2. 是否要多语言（英日韩）——直接影响字体包体，默认只做 CJK

（v0.1 的「篆书是硬需求还是加分项」已结案：做，但必须按需加载 + 支持缺字降级。）

## 13. 分工与文件归属

仓库已初始化（Vite + React 19 + TS + three 0.187 + manifold-3d 3.5.5 + opentype.js 2.0），`npm run build` 通过。

约定：**谁负责的文件谁改，跨文件接口变更先在群里说一声**，避免同时改同一个文件。

| 负责人 | 目录/文件 | 内容 | 验收 |
|---|---|---|---|
| 小新 | `src/layout/` | 字体加载与子集、`fonts.ts`、`text.ts`（字形→多边形）、`ring.ts`（环形排版）、`huiwen.ts`、`data/shuowen-block*.txt`、`data/simp-trad.json` | 输入「印章工坊」能产出环方向正确的多边形环；圆章六字不重叠且字头朝外 |
| 小橙 | `src/geometry/`、`src/export/` | `polygon.ts`、`boolean2d.ts`、`pipeline.ts`、`printability.ts`、`stl.ts`、`threemf.ts`、`trace.ts`。**字形扁平化归 `layout/text.ts`，`geometry` 只收现成 `Polygon2D[]`，不再有 `flatten.ts`** | 导出的文件在切片软件里是封闭实体；面数 <15 万；40mm 章 <2s |
| Chief | `src/App.tsx`、`src/ui/`、`src/render/`、`src/worker/`、`src/core/` | 状态与撤销重做、参数面板、图层列表、three.js 视口、Worker 编排、URL 分享、部署配置 | 改参数 500ms 内刷新预览；分享链接能还原参数 |

**跨模块契约（改动需同步全组）**

1. `layout` 输出 `Polygon2D[]`：**外环 CCW、内孔 CW**，单位 mm，原点在章面中心。环方向与贝塞尔扁平化（默认 0.05mm）都只在这一层定，下游不许翻环、不许重新扁平化。
2. `geometry` 只接收 `Polygon2D[]` + `BodyConfig` + `ReliefConfig`，不感知「圆章/方章」。
3. 镜像只在 `pipeline` 最后一步做一次：`scale([-1,1,1])` 与 `mirror([1,0,0])` **实测完全等价**（体积同为 +800、status 均 NoError、两者差集体积 0，`_probe/mirror-check.mjs`），用哪个都行；导出层禁止任何变换。
4. `status !== NoError` 时禁止导出（`NON_MANIFOLD`）。`GEOM_DEGENERATE` 自动 sanitize 重试一次，`TOO_MANY_TRIANGLES` 只警告。
5. 字体只走**已加载分块**，未命中报 `FONT_NOT_LOADED`，Worker 不做隐式网络请求。
6. 缺字由 `layout`/Worker 返回 `missing[]`，**回退决策在主线程且只能整章切换**。
7. 所有尺寸单位统一 mm，不用像素。

## 14. 已定技术决策（2026-11-13 追加）

| 决策 | 结论与理由 |
|---|---|
| 两种 Polygon2D 并存 | layout 用 `{points: Vec2[]}`（一个字形多条环，扁平列表天然合适），几何层用 `{outer, holes}`（嵌套分组是几何概念）。桥接集中在 `src/core/polygon-bridge.ts`，**不强行统一** |
| potrace-wasm 弃用 | GPLv2，静态站打进 bundle 会传染整个前端的分发许可；内置边界追踪已验证可出「1 外环 + 1 内孔」，够用 |
| 镜像实现 | 用 `Manifold.mirror()` 由内核处理朝向，不手翻环 |
| 浮雕与章体 | 浮雕先嵌入 0.02mm 再布尔，避免共面退化 |
| 闭运算参数 | `grow = max(minStroke, minGap) / 2` |
| 当前阻塞 | 浏览器 Worker 内 `getManifold()` 不 resolve（Node 侧正常），已加阶段日志定位 |
8. 消息与错误码契约见 [docs/worker-protocol.md](docs/worker-protocol.md)，校验规则见 [docs/printability.md](docs/printability.md)。
9. **两个 `Polygon2D` 不是同一个类型**：`layout` 是平铺环 `{points:{x,y}[]}`（孔也是独立一环，靠有向面积区分），`geometry` 是嵌套 `{outer,holes}`。**唯一契约是 layout 的平铺环**，转换只在 `src/core/polygon-bridge.ts` 里做（`fromLayoutPolygons()`），`geometry` 保持自己的结构不变。任何一方都不要为了「统一类型」去改对方的模块。
