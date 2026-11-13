# 印章工坊 · 3D 可打印印章生成器

纯浏览器端的印章建模工具：输入文字或图片，得到**封闭流形**的印章实体，导出 STL / 3MF 直接丢给切片器。

没有后端，不上传任何东西——字体、图片、几何计算全在本机浏览器里完成。

线上地址：部署到 GitHub Pages 后填这里（见下文「部署」）。

## 能做什么

- **章体**：方形 / 圆形 / 正多边形，圆角可调；薄线 / 粗线 / 双线边框；手柄可选（无 / 圆钮 / 桥式）
- **文字**：横排、竖排、环形（字头朝外、自动分配角度）、四字回文（右上→右下→左上→左下）
- **字体**：得意黑（默认）、霞鹜文楷、霞鹜篆书、说文解字小篆、思源黑体，按需加载；也可选本机字体文件
- **图像**：导入图片就地描摹成轮廓，Otsu 自动阈值 / 手动阈值、反相、去噪面积、简化容差都可调
- **浮雕**：阳刻（凸）/ 阴刻（凹），深度可调
- **打印取向**：盖印面贴床（face-down）/ 背面贴床（face-up）
- **打印校验**：笔画宽度、间隙、阴刻槽与料脊深宽比、阳刻悬空、桥接跨度、尺寸范围，分「提示 / 警告 / 阻断」三级，阻断级会禁用导出
- **预览**：3D 立体 + 盖印效果（含二维纸底渲染）
- **导出**：STL（二进制）/ 3MF（`unit="millimeter"`，含 `_rels` 与 `[Content_Types]`）
- **分享**：链接把整份参数编进 URL 的 `#s=`，不进服务器日志；图像图层只保存参数，不包含像素

## 技术要点

| 环节 | 做法 |
| --- | --- |
| 布尔内核 | **manifold-3d**（WASM）。选它是因为 1000 组随机网格全部封闭，`three-bvh-csg` 只有 22/1000 |
| 字形轮廓 | opentype.js 2.0，贝塞尔自适应扁平化（弦高 0.02mm），多环按嵌套深度定向（外环 CCW / 内孔 CW） |
| 图像描摹 | 内置边界追踪（弃用 potrace-wasm：GPLv2 会传染前端分发许可），阈值 + 二维闭运算 + RDP 简化 |
| 预览 | three.js 0.187，模型两视角（镜像实体 / 盖印结果） |
| 计算位置 | Web Worker，主线程不卡；wasm 用 `?url` 取到地址后**自己 fetch 成 `Uint8Array` 通过 `wasmBinary` 传入**（Emscripten 在 ES module worker 里找不到环境，`locateFile` 救不了） |

z 约定：**盖印面贴床**。阳刻图案占 `z∈[0, depth]`，底板占 `z∈[depth, depth+baseThickness]`。最终实体沿 X 轴镜像，所以「看模型」和「看盖印结果」两个视角左右相反，这是对的。

## 本地跑

要求 Node **≥ 22.12**（Vite 8 的下限）。

```bash
npm install
npm run dev          # http://localhost:5173
```

## 构建与部署

```bash
npm run build        # tsc --noEmit && vite build → dist/
npm run preview      # 本地起 dist，验证产物
```

`vite.config.ts` 里 `base: './'`，产物可以放在任意子路径下，不需要按仓库名改配置。

**GitHub Pages**（已配好 `.github/workflows/deploy.yml`）：

1. 推到 GitHub，默认分支 **`main`**（workflow 只在这个分支触发）
2. 仓库 Settings → Pages → Source 选 **GitHub Actions**
3. 之后每次 push 到 `main` 会自动跑 `npm ci` → `typecheck` → `build` → 部署

## 验收脚本

几何和打印校验都是可复跑的脚本，不是「看着对就行」：

```bash
npm run check:verify     # 29 项几何断言：有向体积、镜像、圆章外径、STL/3MF 结构、描摹保孔
npm run check:geometry   # 打印校验与多边形工具：间隙/槽宽/料脊/边框/闭运算/描摹
npm run check:sample     # 生成示例章，写 out/sample.stl + out/sample.3mf（1170 面 · NoError）
npm run check:layout     # 文字排版：环数、环方向、环形字头朝向
```

浏览器侧（需要真实时钟，**不要用 `--virtual-time-budget`**，虚拟时钟会把超时定时器快进，修好了也报超时）：

```bash
npm run build && npm run preview            # 4173
chrome --headless=new --remote-debugging-port=9222 --user-data-dir=%TEMP%\cdp-seal about:blank
node scripts/browser-check.mjs http://localhost:4173/ 25000 9222
node scripts/shot.mjs http://localhost:4173/ temp/app.png 9222   # 截图
```

实验室页面（独立构建，不进正式包）：

```bash
npm run build:lab && npm run preview:lab    # 4174
node scripts/print-check.mjs                # 打印校验 13 组用例
node scripts/trace-lab-check.mjs            # 图像描摹 9 组用例
```

## 目录

```
src/
  geometry/     manifold 单例、多边形工具、章体与浮雕管线、图像描摹、打印校验
  layout/       字体注册与加载、文字排版（横排/竖排/环形/回文）、缺字检查
  core/         SealSpec 类型与默认值、图层桥接、预设模板
  export/       STL / 3MF 编码
  render/       three.js 视图、二维盖印预览
  worker/       几何 worker
  ui/           字体与授权页等界面块
scripts/        验收脚本、字体子集化、描摹基准
lab/            不进正式包的实验室页面
public/fonts/   字体子集 + 各自授权原文
docs/           worker 协议、打印校验说明、排版基线
DESIGN.md       设计与决策记录（为什么这样做）
```

## 字体与授权

页面右下角「字体与授权」可点开随包的授权原文。所有字体都可商用，但**说文解字要署名**（政府资料开放授权条款第 1 版，非 OFL）。

| 字体 | 授权 | 随包文件 | 体积 |
| --- | --- | --- | --- |
| 得意黑 Smiley Sans（默认） | OFL-1.1 | `smiley-sans-subset.ttf`，GB2312 一级 3755 字 + 标点 | 993 KB |
| 霞鹜文楷 LXGW WenKai | OFL-1.1 | `lxgw-wenkai-subset.ttf`，3755 字 | 1.78 MB |
| 霞鹜篆书 LxgwSeal | OFL-1.1 | `lxgw-seal.ttf`，全量 75 个主题字 | 228 KB |
| 说文解字（小篆） | **OGDL-1.0** | `shuowen-block1/2.ttf`，按字频分片按需加载，需署名 | 3.65 MB |
| 思源黑体 Source Han Sans CN | OFL-1.1 | `source-han-sans-subset.otf`，3755 字 | 966 KB |

文档里的字体文件带 `OFL.txt`；说文的出处与授权写在 `public/fonts/shuowen/SOURCE.txt`（来源：全字库 CNS11643）。

## 已知限制

- **四字 30mm 阴刻**：字间距设计值约 0.15mm，闭运算会焊到约 0.30mm 的料脊，比一条挤出线还细，印出来笔画会轻微粘连。这是「字数 ÷ 章面」的固有取舍，参数救不回来——加大章面、少排几个字，或换「平装阳刻」预设（阳刻时这条窄缝是地面上的沟，不受 0.4mm 挤出线限制）。
- **阳刻 + 手柄**是阻断级组合：底板整片悬空。要么去掉手柄改用 face-up，要么切回阴刻。
- 树脂只做了参数预设（`process: 'resin'`），没有实测过。
- 3MF 只做了结构级校验（zip 结构、单位、三角形数、水密），没有在真实切片器里打开验证。
- 分享链接不含图像像素，收到链接的人需要自己重新导入图片。
- 字体只收 TTF / OTF。

更多设计取舍见 [DESIGN.md](DESIGN.md)，打印校验判据见 [docs/printability.md](docs/printability.md)，worker 消息格式见 [docs/worker-protocol.md](docs/worker-protocol.md)。
