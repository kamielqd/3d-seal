# 可打印性校验规格 v1

> 输入：`pattern2D: Polygon2D[]`（2D 布尔后的图案）、`solid: Manifold`（镜像后、导出前）、
> `spec.print`（preset + minStroke/minGap）、`spec.relief.depthMm`、`spec.body`。
> 输出：`Violation[]`，**不阻断导出**，只分级提示 + 给出可高亮的几何。
> 依据：DESIGN.md §4.3 / §6；阈值来自 0.4mm 喷嘴的物理下限，不是审美。

## 0. 原则

1. **能不能印出来 > 好不好看**。警告不阻止导出，但高亮必须落在具体那一笔上。
2. 2D 能判的绝不上 3D：笔画宽、间隙、孤岛、深宽比全部在 `CrossSection` 上算，成本是毫秒级。
3. 每条违规都带 `highlight`：`polygons`（该连通域轮廓）/ `bbox` / `point`，UI 直接叠加高亮。
4. 检测网格 `gridMm = 0.05`（40mm 章 = 800×800，EDT 单次 <20ms）。只在 2D 阶段跑一次。

## 1. 预设

| 预设 | minStrokeMm | minGapMm | reliefDepthMm | 适用 |
|---|---|---|---|---|
| `fdm`（默认） | **0.4** | **0.4** | 1.2 | 0.4mm 喷嘴家用机 |
| `resin` | **0.2** | **0.15** | 0.6 | 0.05mm 层高树脂机 |

预设只是初值，`spec.print.minStrokeMm/minGapMm` 可改；UI 必须显示「预设：FDM / 树脂」+ 可编辑。

## 2. 规则表

| ID | 规则 | FDM | 树脂 | 级别 | 检测方法 | 修复建议 |
|---|---|---|---|---|---|---|
| `stroke.min` | 最小笔画宽 | 0.4mm | 0.2mm | warn | `pattern.decompose()` 逐连通域栅格化 → 欧氏距离变换(EDT) → 骨架 = EDT 局部极大像素 → `2×min(骨架EDT)` 即该域最细处 | ① 形态学闭运算 closing(r=minStroke/2) 补断口；② `offset(+Δ)`，Δ=(minStroke−w)/2；③ 重新校验间隙。**禁止先内缩**：实测内缩 0.2mm 让 331mm² 字面掉到 179mm²（46% 细笔画消失） |
| `gap.min` | 笔画最小间隙 | 0.4mm | 0.15mm | warn | 同一栅格对**空区**做 EDT；找相邻不同连通域的「喉部」像素，`gap = d_A + d_B`（两平行壁即精确值），取全局最小 | 优先改字号/字距/字重；差值 <0.1mm 时 `offset(−(minGap−gap)/2)` 微调后**必须**复检 `stroke.min`；否则提示「这两笔会粘连」并高亮两个域 |
| `island.min` | 孤立小岛 | <0.5mm² | <0.1mm² | warn | `decompose()` 每域 `area()`；与 border/主体不相连的域单独标记 | 面积 <0.5mm² 自动删除并提示（用户可见「已忽略 X 个碎点」）；或 `offset(+0.05)` 粘到邻近笔画 |
| `relief.aspect` | 浮雕高宽比 | depth ≤ 2×w | depth ≤ 3×w | warn | `depthMm / 该域 minStroke`；取全体域的最小值 | 降 `depthMm` 或加粗笔画；0.4mm 宽 × 1.2mm 高的墙在 FDM 上会晃、易断 |
| `groove.aspect` | 凹槽深宽比（仅阴刻） | depth ≤ w | depth ≤ 1.5×w | warn | 阴刻时图案是**孔**：`depthMm / min(w, gap)` | 阴刻 1.2mm 深、0.4mm 宽的槽，喷嘴进不去也排不出料；建议 depth ≤0.8mm 或改阳刻 |
| `nozzle.feature` | 亚喷嘴特征 | 0.4mm | 0.2mm | info | 对 pattern 做开运算 opening(r=minStroke/2)，丢弃面积 >0.05mm² 的部分即存在薄特征；同时覆盖 <0.4mm 凹槽（切片器会跳过或架桥糊平） | 提示「该处会被切片器忽略」；提供「加粗到可打印」一键修复 |
| `overhang.angle` | 悬空面 | >60° | 忽略 | info | 遍历 `solid` 三角：朝下且 `n.z < −cos(30°)=−0.866` 的面即与水平夹角 <30°，需支撑 | 手柄球底/颈部；提示「章面朝下打印 + 树状支撑」，或把 handle 改成 `bridge` |
| `base.flat` | 底面/章面平行 | 偏差 ≤0.02mm | 同 | error | `solid` 最低 z 的所有面法线必须是 (0,0,−1)，且 z 值一致（容差 0.02mm）；章面同理由 `baseThicknessMm` 推出 | 偏差通常来自镜像后的浮点误差或手柄穿底：检查 `scale([-1,1,1])` 之后是否又做了变换 |
| `overlap.samedepth` | 同深度图层重叠 | — | — | warn | 调用方按图层传入 `layerGroups`，两两做 2D 交集，重叠 >0.5mm² 才报 | 缩小/移动图层，或让文字避开图案；同深两层必然合并成一整块凹坑 |
| `size.range` | 尺寸可用性 | 10–60mm | 5–50mm | error | `body.sizeMm`；手柄径 ≥8mm；底面积 ≥100mm²（防翘边） | 尺寸越界直接拒绝生成；底面积过小提示加 brim |

> 阳刻/阴刻都用同一套图案度量：阳刻的笔画宽 = 图案厚度，阴刻的孔宽 = 图案厚度；
> 间隙也一样是图案空区。所以只需一份 2D 检测，不按模式分叉。

## 3. 输出结构

```ts
export type Severity = 'error' | 'warn' | 'info';
export type PrintRuleId =
  | 'stroke.min' | 'gap.min' | 'island.min' | 'relief.aspect'
  | 'groove.aspect' | 'nozzle.feature' | 'overhang.angle'
  | 'base.flat' | 'size.range';

export interface Violation {
  rule: PrintRuleId;
  severity: Severity;
  /** 实测值 mm / mm² / 度 */
  measured: number;
  limit: number;
  message: string;            // 用户可读，中文，带数字
  fix?: string;               // 一键修复的 action id，没有则不显示按钮
  highlight?: {
    polygons?: [number, number][][];  // 该连通域，mm 坐标（未镜像前的章面坐标系）
    bbox?: [number, number, number, number];
    point?: [number, number];
  };
}
```

`highlight` 用**镜像前**的章面坐标：预览层本来就显示镜像前的模型视角，避免再翻一次。

## 4. 执行顺序与性能

```
pattern2D (2D 布尔结果)
  → decompose()                    // 连通域，<2ms
  → 一次栅格化 0.05mm              // 800×800，~3ms
  → 一次 EDT（两遍扫描）           // ~10ms，stroke 与 gap 共用
  → 逐域判 6 条 2D 规则
  → solid 生成后判 overhang / base.flat / size（3D 部分只遍历三角，<5ms）
```

预算：整套校验 **<30ms**，跟着 build 一起跑，不需要单独防抖。

## 5. 修复动作（UI 按钮）

| action | 行为 | 会改 spec 吗 |
|---|---|---|
| `fix:close` | closing(minStroke/2) 预处理器，重跑 2D | 否（管线选项） |
| `fix:thicken` | offset(+Δ) 至达标 | 否 |
| `fix:dropIslands` | 删除 <阈值 的域 | 否 |
| `fix:reduceDepth` | `relief.depthMm` 降到合规值 | 是 |
| `fix:switchRelief` | 阴刻 → 阳刻 | 是 |

「否」的修复只影响本次生成的几何，不动用户参数；「是」的改为用户显式点击才改。

## 2.1 实现口径（与代码一致）

- **栅格**：`raster.ts` 把 `CrossSection` 按偶奇规则扫描线填充，`gridMm = 0.05`；栅格总量超过 240 万格时自动放粗（大章/复杂图像）。
- **距离变换**：Felzenszwalb 精确 EDT，两遍（列/行）。
- **笔画宽**：材料内每像素到最近空像素的距离 `d`（格），宽 = `2d × grid`；只取**中轴**（四邻域极大）像素，避免把厚笔画的边界算成细线。
- **细材料面积**：沿中轴累计 `宽 × grid`；小于 `0.15mm²` 视为**笔尖收笔**，忽略——否则任何撇捺收笔都会被报成 0.1mm 细线。
- **间隙**：空区到最近实体的 EDT 中脊，`gap = (2d − 1) × grid`；要求两侧都有材料，排除图外空白。
- **精度**：±0.05mm（半格）。阈值比较留了 `0.01` 的容差，0.3mm 细条实测 0.300mm、0.25mm 缝实测 0.250mm。
- **高亮**：`stroke.min` / `gap.min` 返回违规区域的 **bbox**（四角多边形）+ 面积；`island.min` 直接返回该连通域的轮廓。逐笔描边留给预览层，几何层不重复生成轮廓。
- **`auto.fix`**：`prepareSection` 的自动加工记录（焊缝面积、外扩量）作为 `info` 级违规返回，UI 显示「已自动处理」，不静默改字形。

## 2.2 `prepareSection` 里 minStroke / minGap 各自怎么落地

```
section = 归一化 + NonZero 并集
if minGap > 0:     closing(minGap/2)        // 焊死窄于 minGap 的缝，只填缝、不加粗笔画
if minStroke > 0:  w = 实测最细笔画（栅格 EDT）
                   if w < minStroke:  offset(+ (minStroke − w)/2)   // 整体外扩，只在违规时做
if minGap > 0:     closing(minGap/2)        // 外扩会吃掉间隙，再焊一次
simplify(0.02)
```

两条约束的物理含义不同，不能合并成一个参数：
- **间隙**只能靠「合并」解决——两笔间隔小于喷嘴，切片器会架桥糊平，唯一可打印的结果就是让它们连成一片；
- **笔画**只能靠「加粗」解决——向内缩会让细笔画整条消失（实测 0.2mm 内缩掉 46% 面积）；
- 加粗必然吃掉间隙，所以最后必须再闭一次；这一步焊掉多少面积写进 `PrepareReport.weldedGapAreaMm2`，由 UI 提示「已合并」。

## 2.3 z 轴约定（2026-11-13 修订）

**z=0 是盖印面（贴打印床的那一面）**，不是底板背面。

| 模式 | 字母/槽 | 底板 | 手柄 |
|---|---|---|---|
| 阳刻 | 字母 z∈[0, depth] | z∈[depth, depth+T] | z∈[depth+T−base, depth+T+H] |
| 阴刻 | 槽从 z=0 挖到 depth | z∈[0, T] | z∈[T−base, T+H] |

- 镜像仍是 `mirror([1,0,0])`；z 轴不翻。整体 Z 翻转会把旋钮手柄翻到床下，禁止。
- `base.flat` 改判「盖印面在 z=0 且法线朝下」，不再只看最低面。
- `overhang.angle` 排除贴床面与纯水平面；新增 `bridge.span` 单独统计**水平悬空面**。
- 阴刻朝下可打印（槽是小跨度桥）；阳刻朝下时底板是整片悬空，实测 30×30 章面有 **809mm²** 水平悬空面——这是该取向的物理代价，必须由支撑或裙边解决。
