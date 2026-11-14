/**
 * 印章实体管线：二维多边形 → 可打印封闭实体。
 *
 * 契约（与 src/core/spec.ts、src/layout 对齐）：
 *   - 只吃 `Polygon2D[]` + body + relief，不感知「这是圆章还是方章」
 *   - 单位 mm，原点在章面中心
 *   - 最后一步镜像 X（印章盖出来才是正的），镜像后保持外环 CCW
 *
 * ## 结构：刻印片（始终存在）+ 可选把手
 *
 *   刻印片 = `body.shape`（圆/方）× `sizeMm`，厚 `baseThicknessMm`。图案刻在它上面。
 *   把手   = `body.styleId` 指向的 STL 模型，缩放到「足迹 ≤ 0.6× 刻印片」后
 *            贴在片的**背面**并集（沉 0.02mm 嵌入，保证体积相交而不是只共面）。
 *
 * ## z 约定：盖印面贴床（写死，不要改）
 *
 * z=0 是**盖印面**，也就是贴打印床的那一面；z 轴向上长。
 * 理由：印章卖的就是章面的表面质量，贴床那一面最平整；阳刻的凸起朝上，不需要支撑。
 *
 *   阳刻 raised:  图案   z ∈ [0, depth]                        凸起直接立在床上
 *                 刻印片 z ∈ [depth, depth + baseThickness]
 *                 把手   z ∈ [depth + baseThickness − 0.02, …]
 *   阴刻 engraved: 刻印片 z ∈ [0, baseThickness]               章面就是片的面
 *                 槽     z ∈ [0, depth]（从 z=0 往上挖，槽底在 z=depth）
 *                 把手   z ∈ [baseThickness − 0.02, …]
 *
 * `body.handle`（none/knob/bridge）是上一代产品的字段，已不参与生成；
 * `handleSolid` 仍导出但没有任何调用点。
 *
 * 由此推出的不变量（scripts/verify.ts 按这些断言，不写死毫米数）：
 *   - 阳刻 zMin = 0，刻印片占 [depth, depth + baseThickness]
 *   - 阴刻 zMax = baseThickness（无把手时），且存在 z = depth 的槽底平面
 *   - 有把手时总高 = 片厚 + 把手高（阳刻再加 depth）
 *
 * 不做整体 Z 翻转：那会把把手翻到下面。要"背面贴床"只有显式的
 * `orientation: 'face-up'` 分支（刚体旋转 180°），且只对「无把手 + 阳刻」成立。
 */

import type { BodyConfig, PrintConfig, ReliefConfig } from '../core/spec.ts';
import type { LayerFit } from '../core/layout-bridge.ts';
import { isBodyStyleId, loadBody } from './body-library.ts';
import type { BodyStyleId } from './body-library.ts';
import { fromCrossSection, getManifold, prepareSectionWithReport } from './crosssection.ts';
import type { ManifoldKit, PrepareReport } from './crosssection.ts';
import { checkLayerOverlap, checkPrintability } from './printability.ts';
import type { LayerPolygons, Polygon2D, SolidMesh } from './types.ts';
import { SealGeometryError } from './types.ts';

type CS = InstanceType<ManifoldKit['CrossSection']>;
type Solid = InstanceType<ManifoldKit['Manifold']>;

/** 打印取向：face-down = 盖印面贴床（默认）；face-up = 背面贴床、字母朝上（必须无把手）。 */
export type SealOrientation = 'face-down' | 'face-up';

/** buildSeal 需要的 spec 子集。 */
export interface SealBuildSpec {
  body: BodyConfig;
  relief: ReliefConfig;
  print?: PrintConfig;
  /** 不填按 face-down。face-up 只在 handle === 'none' 时允许。 */
  orientation?: SealOrientation;
  /**
   * 文字图层自动适应章面的结果（`layoutFlatWithFit()` 的 `fits`）。
   * 单文字层可以只传那一条（旧调用方），多文字层要传整个数组——
   * 否则文案只会认第一层。用来让校验文案区分「用户把字号设小了」和
   * 「系统替他缩了」——后者不能建议放大字号。
   */
  autoFit?: LayerFit | readonly LayerFit[] | null;
  /**
   * 可选：按图层拆开的多边形。传入才会做「同深度重叠」检测；
   * 几何本身只吃合并后的 polygons，不依赖它。
   */
  layerGroups?: readonly LayerPolygons[];
}

/** 生成过程中的统计，便于日志与验收。 */
export interface BuildStats {
  triangles: number;
  status: string;
  bodyShape: string;
  relief: string;
  orientation: SealOrientation;
  /** 图案来源多边形数量。 */
  polygonCount: number;
  /** 章面形状：由刻印片决定（body.shape；polygon 按方形边界处理）。 */
  faceShape: 'square' | 'circle' | 'polygon';
  /** 实际章面足迹 mm：就是刻印片的 sizeMm（总高上限不再压章面，只压把手）。 */
  faceSizeMm: number;
  /** 实际总高 mm（刻印片 + 把手；阳刻含抬高）。 */
  heightMm: number;
  /** 把手样式；null = 无把手（只有刻印片）。 */
  handleStyleId: BodyStyleId | null;
  /** 把手缩放后的底面足迹 mm（0 = 无把手）。 */
  handleFaceMm: number;
  /** 把手缩放后的高度 mm，不含刻印片（0 = 无把手）。 */
  handleHeightMm: number;
  /**
   * 旧口径遗留：过去章面会被总高上限压小，记「不限高能到多大」。
   * 现在总高上限只压把手、不压章面，这个值恒为 null；字段留着是为了 UI 旧代码不炸。
   */
  faceSizeWithoutHeightLimitMm: number | null;
}

let lastStats: BuildStats | null = null;

/** 最近一次 buildSeal 的统计（同步读取，给 UI/脚本看）。 */
export function lastBuildStats(): BuildStats | null {
  return lastStats;
}

/* ------------------------------------------------------------------ */
/* 章体                                                                */
/* ------------------------------------------------------------------ */

/** 依据 body 配置造章面轮廓。 */
export function bodySection(kit: ManifoldKit, body: BodyConfig): CS {
  const size = Math.max(1, body.sizeMm);
  const half = size / 2;
  const radius = Math.max(0, Math.min(body.cornerRadiusMm, half * 0.98));

  let section: CS;
  switch (body.shape) {
    case 'circle':
      section = kit.CrossSection.circle(half, segmentsForCircle(half));
      break;
    case 'polygon': {
      const sides = Math.max(3, Math.min(12, Math.round(body.sides)));
      section = kit.CrossSection.circle(half, sides * 2).hull();
      break;
    }
    case 'square':
    default:
      section = kit.CrossSection.square([size, size], true);
      break;
  }

  if (radius > 0 && body.shape !== 'circle') {
    // 内缩再外扩 = 圆角（Minkowski 圆）：方章/多边形都能用
    const eroded = section.offset(-radius, 'Round', 2, segmentsForCircle(radius));
    const rounded = eroded.offset(radius, 'Round', 2, segmentsForCircle(radius));
    eroded.delete();
    section.delete();
    section = rounded;
  }
  return section;
}

function segmentsForCircle(radiusMm: number): number {
  return Math.min(128, Math.max(24, Math.ceil((Math.PI * 2 * radiusMm) / 0.6)));
}

/* ------------------------------------------------------------------ */
/* 旧版手柄（已无调用点，见 handleSolid）                                */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 边框                                                                */
/* ------------------------------------------------------------------ */

/**
 * 边框环：贴章面内缘的一圈（double 为两圈），深度与图案相同。
 *
 * 直接复用章面轮廓做 offset：方章/多边形用 Miter 保持直角，圆章不受影响。
 * 返回 null 表示「没有边框」或「放不下」（inset 太大、环为空）。
 *
 * 边框在 prepareSection 之后才和图案合并（见 buildSeal 第 3b 步），
 * 否则闭运算会按最小间隙把细边框加粗、或和文字焊成一片。
 */
export function borderSection(base: CS, border: BodyConfig['border']): CS | null {
  if (border.style === 'none') return null;
  // widthMm 是唯一真值来源，不按 style 做任何隐藏换算；宽度 0 视为没有边框
  const width = Math.max(0, border.widthMm);
  if (width <= 0) return null;
  const inset = Math.max(0, border.insetMm);
  const segments = segmentsForCircle(width);

  let ring = ringAt(base, inset, width, segments);
  if (border.style === 'double') {
    // 双线：间距取边框宽（下限 0.8mm），避免两条线糊在一起
    const gap = Math.max(0.8, width);
    const inner = ringAt(base, inset + width + gap, width, segments);
    if (inner !== null) {
      if (ring === null) {
        ring = inner;
      } else {
        const merged = ring.add(inner);
        ring.delete();
        inner.delete();
        ring = merged;
      }
    }
  }
  if (ring !== null && ring.isEmpty()) {
    ring.delete();
    return null;
  }
  return ring;
}

/** 在 base 内缩 inset 处取一圈宽 width 的环。 */
function ringAt(base: CS, insetMm: number, widthMm: number, segments: number): CS | null {
  const outer = base.offset(-insetMm, 'Miter', 2, segments);
  if (outer.isEmpty()) {
    outer.delete();
    return null;
  }
  const inner = outer.offset(-widthMm, 'Miter', 2, segments);
  const ring = outer.subtract(inner);
  outer.delete();
  inner.delete();
  if (ring.isEmpty()) {
    ring.delete();
    return null;
  }
  return ring;
}

/**
 * 给预览用的边框轮廓：与 buildSeal 实际合并进实体的那圈边框同源同参数，
 * 避免「模型有边框、盖印预览没有」。返回 mm 坐标；没有边框或放不下时返回 []。
 */
export async function borderPolygons(body: BodyConfig): Promise<Polygon2D[]> {
  const kit = await getManifold();
  const base = bodySection(kit, body);
  const ring = borderSection(base, body.border);
  base.delete();
  if (ring === null) return [];
  const polygons = fromCrossSection(kit, ring);
  ring.delete();
  return polygons;
}

/**
 * 旧版手柄：用截面绕 Z 轴旋转（revolve）生成，坐在背面 `bottomZ` 上。
 *
 * ⚠️ 新一代的「把手」是 `body.styleId` 指向的 STL 模型（见 buildSeal 第 3 步），
 * 和这个函数无关。`body.handle` 只为旧分享链接留字段，**没有任何生成路径再调用它**；
 * 保留导出只为旧代码/脚本引用，别在 buildSeal 里重新接上。
 *
 * 轮廓坐标 (x=半径, y=高度)，x>=0；manifold 会绕 Y 轴旋转后把 Y 摆成 Z 轴，
 * 所以这里直接在 (半径, 高度) 平面里画侧影线。
 *
 * @param bottomZ 底板背面高度（阳刻 depth+T，阴刻 T）；手柄向下嵌 base 与之搭接
 */
export function handleSolid(kit: ManifoldKit, body: BodyConfig, bottomZ: number): Solid | null {
  if (body.handle === 'none') return null;

  const height = Math.max(1, body.handleHeightMm);
  const radius = Math.max(1.5, body.handleDiameterMm / 2);
  const base = Math.max(0.6, Math.min(radius * 0.9, body.baseThicknessMm));

  const profile: number[][] = body.handle === 'bridge'
    ? [
        [0, 0],
        [radius, 0],
        [radius, height * 0.28],
        [radius * 0.92, height * 0.55],
        [radius * 0.86, height],
        [0, height],
      ]
    : [
        [0, 0],
        [radius * 0.98, 0],
        [radius, height * 0.22],
        [radius * 0.82, height * 0.62],
        [radius * 0.56, height],
        [0, height],
      ];

  const contour = profile.map(([x, y]) => [x!, y!] as [number, number]);
  const section = new kit.CrossSection([contour], 'Positive');
  const solid = section.revolve(segmentsForCircle(radius));
  section.delete();
  return solid.translate([0, 0, bottomZ - base]);
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

/**
 * 造一枚完整印章：**刻印片（始终存在）+ 可选把手**。
 *
 *   - 刻印片：`body.shape`（圆/方/正多边形）× `sizeMm`，厚 `baseThicknessMm`（默认 4mm）。
 *     图案刻在这片上，阴刻/阳刻照旧。
 *   - 把手：`body.styleId` 指向 4 个内置模型之一时，缩放后贴在刻印片**背面**并集。
 *     `'none'` / `'plate'` / 缺省 → 无把手，整个印章就是一片刻印片。
 *
 * 旧的「把 STL 模型当整章」那条路已删除：产品里印章 = 刻印片 + 把手，刻印片必须在。
 *
 * @param spec body / relief / print
 * @param polygons 二维图案（文字与图像已合并），外环 CCW、内孔 CW、单位 mm
 */
export async function buildSeal(spec: SealBuildSpec, polygons: readonly Polygon2D[]): Promise<SolidMesh> {
  const kit = await getManifold();
  return buildSealWithPlate(kit, spec, polygons);
}

/**
 * 把 `body.styleId` 读成把手 id（null = 无把手）。
 *
 * spec 侧正在把 `BodyKind` 从 `BodyStyleId | 'plate'` 改成 `BodyStyleId | 'none'`，
 * 这里两种旧值都认：`'none'` / `'plate'` / 缺省 都是「没有把手」。
 * 按结构化类型读，避免和 spec.ts 的收窄同步打架。
 */
function readHandleStyle(body: BodyConfig): BodyStyleId | null {
  const raw = (body as { readonly styleId?: unknown }).styleId;
  if (raw === 'none' || raw === 'plate' || raw === undefined || raw === null) return null;
  return isBodyStyleId(raw) ? raw : null;
}

/** 刻印片参数：形状 / 边数 / 厚度。字段还没进 spec 时按结构化类型读并给默认值。 */
export interface PlateParams {
  shape: 'square' | 'circle' | 'polygon';
  sides: number;
  thicknessMm: number;
  cornerRadiusMm: number;
}

function readPlateParams(body: BodyConfig): PlateParams {
  const raw = body as BodyConfig & { readonly thicknessMm?: unknown };
  const shape = body.shape === 'circle' ? 'circle' : body.shape === 'polygon' ? 'polygon' : 'square';
  const thickness =
    typeof raw.thicknessMm === 'number' && Number.isFinite(raw.thicknessMm) && raw.thicknessMm > 0
      ? raw.thicknessMm
      : Math.max(0.8, body.baseThicknessMm);
  return {
    shape,
    sides: Math.max(3, Math.min(12, Math.round(body.sides))),
    thicknessMm: Math.max(0.8, thickness),
    cornerRadiusMm: shape === 'square' ? Math.max(0, body.cornerRadiusMm) : 0,
  };
}

/**
 * 把手底面足迹 ≤ 刻印片足迹的这个比例。
 *
 * 为什么 0.6 站得住：把手包围盒对角线 ≤ 0.6D × √2 ≈ 0.85D < D，
 * 所以**哪怕方把手配圆片**，把手任何一个角都不会伸到刻印片外，
 * 不会出现「把手边缘悬空、没有材料接住」的唇边。换模型也不用重新调这个数。
 */
const HANDLE_FOOTPRINT_RATIO = 0.6;

/** 总高预算扣完刻印片（和阳刻抬高）后，低于这个高度就不出把手——压成薄饼比没有更糟。 */
const MIN_HANDLE_HEIGHT_MM = 3;

/** 把手底面沉进刻印片背面的深度：保证两个实体真的体积相交，而不是只共面。 */
const HANDLE_EMBED_MM = 0.02;

/**
 * 刻印片（+ 可选把手）：一块厚 `thicknessMm` 的平板（方/圆/正多边形），图案刻在它上面，
 * 有把手时把手贴在它的背面。
 *
 * z 约定（盖印面贴床，z=0）：
 *   阴刻：刻印片 z∈[0, T]，槽从 z=0 往上挖 depth，把手坐在 z=T−0.02 起
 *   阳刻：图案 z∈[0, depth]，刻印片 z∈[depth, depth+T]，把手坐在 z=depth+T−0.02 起
 *
 * 最后镜像 X（把手跟着一起镜像；四个模型都对称，看不出差别）。
 */
async function buildSealWithPlate(
  kit: ManifoldKit,
  spec: SealBuildSpec,
  polygons: readonly Polygon2D[],
): Promise<SolidMesh> {
  const body = spec.body;
  const relief = spec.relief;
  const print = spec.print;
  const params = readPlateParams(body);

  const thickness = params.thicknessMm;
  const depth = Math.max(0.2, relief.depthMm);
  const raised = relief.mode !== 'engraved';

  if (raised && depth > thickness - 0.2) {
    throw new SealGeometryError(
      '刻印片',
      'ReliefDeeperThanPlate',
      `浮雕深 ${depth}mm 接近/超过刻印片厚度 ${thickness}mm：阳刻会直接穿底。把深度降到 ${Math.max(0.2, thickness - 0.4).toFixed(1)}mm 以下，或加厚刻印片。`,
    );
  }

  const plateBottom = raised ? depth : 0;
  const plateTop = plateBottom + thickness;

  // 1) 平板：复用 bodySection（它已经处理方/圆/正多边形 + 圆角）
  const faceSection = bodySection(kit, body);
  // 边框：形制件，和图案同深度但**不参与** prepareSection 的闭运算（否则细边框会被加粗、
  // 或和文字焊成一片）。先在平板上取出边框截面，等图案处理完再合并。
  let border: CS | null = borderSection(faceSection, body.border);
  const plateExtruded = faceSection.extrude(thickness);
  faceSection.delete();
  const plate = plateExtruded.translate([0, 0, plateBottom]);
  plateExtruded.delete();
  ensureStatus(plate, '刻印片挤出');
  let solid: Solid = plate;

  // 手柄（`body.handle`）是上一代产品的字段，已不参与生成；现在只有 `body.styleId`
  // 指向的 STL 把手会接在这片背面（见下面第 3 步）。

  // 2) 图案：二维阶段先闭运算（保间隙）+ 测量外扩（保笔画），再一次性挤出
  let prepared: CS | null = null;
  let prepareReport: PrepareReport | null = null;
  if (polygons.length > 0) {
    const prep = await prepareSectionWithReport(polygons, {
      minStrokeMm: print?.minStrokeMm ?? 0.4,
      minGapMm: print?.minGapMm ?? 0.4,
      simplifyMm: 0.02,
    });
    prepared = prep.section;
    prepareReport = prep.report;
  }

  // 2b) 合并边框（在 prepareSection 之后，理由见上面 border 的注释）
  if (border !== null && !border.isEmpty()) {
    if (prepared === null || prepared.isEmpty()) {
      prepared?.delete();
      prepared = border;
    } else {
      const merged = prepared.add(border);
      prepared.delete();
      border.delete();
      prepared = merged;
    }
    border = null;
  } else {
    border?.delete();
    border = null;
  }

  if (prepared !== null && !prepared.isEmpty()) {
    // 与底板搭接 0.02mm，避免共面布尔退化
    const overlap = 0.02;

    if (raised) {
      // 字母/边框从 z=0 长到 depth+overlap，与底板在 [depth, depth+overlap] 搭接
      const stamp = prepared.extrude(depth + overlap);
      const next = solid.add(stamp);
      solid.delete();
      stamp.delete();
      ensureStatus(next, '阳刻并集');
      solid = next;
    } else {
      // 槽从盖印面 z=0 往上挖；刀体向下多出 overlap，避免与 z=0 共面
      const cutter = prepared.extrude(depth + overlap).translate([0, 0, -overlap]);
      const next = solid.subtract(cutter);
      solid.delete();
      cutter.delete();
      ensureStatus(next, '阴刻差集');
      solid = next;
    }
  }

  // 3) 把手：贴在刻印片**背面**并集。
  //
  // 缩放取小（都按 mm）：
  //   ① 足迹 ≤ 0.6 × 刻印片足迹（对角线论证见 HANDLE_FOOTPRINT_RATIO）
  //   ② 总高 ≤ maxHeightMm —— 预算 = 上限 − 刻印片 − 阳刻抬高。
  //      上限约束的是**成品实际高度**，不是把手本身的高度，所以阳刻抬高必须扣掉。
  const handleStyle = readHandleStyle(body);
  let handleStats: { styleId: BodyStyleId; faceMm: number; heightMm: number; limitedByHeight: boolean } | null = null;
  let handleBudgetMm: number | null = null; // 非 null 且 < MIN_HANDLE_HEIGHT_MM → 没出把手
  if (handleStyle !== null) {
    const maxHeightMm = readMaxHeightMm(body);
    const budgetMm = maxHeightMm === null ? Number.POSITIVE_INFINITY : maxHeightMm - plateTop;
    if (budgetMm < MIN_HANDLE_HEIGHT_MM) {
      handleBudgetMm = budgetMm;
    } else {
      // 共享缓存实例，不能 delete；只用它派生新实体
      const handleSource = await loadBody(handleStyle);
      const handleBox = handleSource.boundingBox();
      const footCm = Math.max(handleBox.max[0] - handleBox.min[0], handleBox.max[1] - handleBox.min[1]);
      const heightCm = Math.max(1e-6, handleBox.max[2] - handleBox.min[2]);
      if (!(footCm > 0)) {
        throw new SealGeometryError('把手', 'EmptyBody', `${handleStyle} 的底面足迹为 0，无法缩放。`);
      }
      const scaleByFootprint = (body.sizeMm * HANDLE_FOOTPRINT_RATIO) / footCm;
      const scaleByHeight = maxHeightMm === null ? Number.POSITIVE_INFINITY : budgetMm / heightCm;
      const handleScale = Math.min(scaleByFootprint, scaleByHeight);

      const scaled = handleSource.scale([handleScale, handleScale, handleScale]);
      const scaledBox = scaled.boundingBox();
      // 居中 + 底面沉 HANDLE_EMBED_MM 进片背面：不是「怕共面报错」，是保证体积真相交
      // （模型底面只保证足迹、不保证平面度，精确共面遇到 0.01 翘曲会留缝）
      const moved = scaled.translate([
        -(scaledBox.min[0] + scaledBox.max[0]) / 2,
        -(scaledBox.min[1] + scaledBox.max[1]) / 2,
        plateTop - HANDLE_EMBED_MM - scaledBox.min[2],
      ]);
      scaled.delete();
      const merged = solid.add(moved);
      solid.delete();
      moved.delete();
      ensureStatus(merged, '把手并集');
      solid = merged;

      handleStats = {
        styleId: handleStyle,
        faceMm: footCm * handleScale,
        heightMm: scaledBox.max[2] - scaledBox.min[2],
        limitedByHeight: scaleByHeight < scaleByFootprint - 1e-9,
      };
    }
  }

  // 4) 镜像 X：印章必须镜像，盖出来才是正的
  const mirrored = solid.mirror([1, 0, 0]);
  solid.delete();
  solid = mirrored;

  // 4.5) 打印取向。
  //
  // ⚠️ 产品决策：打印方向固定「刻印面贴床」（face-down），UI 没有选择器。
  //    这里的 face-up 分支只服务「平装阳刻」预设（阳刻贴床时刻印片整片悬空、
  //    拆不掉支撑，必须翻面打），而且**必须无把手**——翻面后把手全在床面以下。
  const orientation: SealOrientation = spec.orientation ?? 'face-down';
  if (orientation === 'face-up') {
    if (handleStyle !== null) {
      throw new SealGeometryError(
        '打印取向',
        'FaceUpRequiresNoHandle',
        '面朝上打印必须不带把手：翻面后把手会整个落到床面以下。请把把手设为「无」，或改用「刻印面贴床」。',
      );
    }
    if (raised) {
      const flipped = solid.rotate([180, 0, 0]).translate([0, 0, plateTop]);
      solid.delete();
      solid = flipped;
      ensureStatus(solid, '面朝上翻转');
    } else {
      // 阴刻本来就是盖印面贴床，翻面只会把它倒过来
      throw new SealGeometryError(
        '打印取向',
        'FaceUpRequiresRaised',
        '面朝上打印只对阳刻有意义（阳刻贴床会把底板整片悬空）。阴刻请用「刻印面贴床」。',
      );
    }
  }

  const mesh = await finishSeal({
    kit,
    spec,
    solid,
    polygons,
    prepared,
    prepareReport,
    bodyShape: handleStats === null ? `plate:${params.shape}` : `plate:${params.shape}+${handleStats.styleId}`,
    orientation,
    // 图案刻在这片平板上的：形状/尺寸都由片决定（把手不影响章面）
    printBody: { ...body, shape: params.shape, sizeMm: body.sizeMm, handle: 'none' },
    handle: handleStats,
  });

  // 把手的两条提示：被总高上限压过 / 预算不够干脆没出。都要明说，
  // 不能默默把把手缩成薄饼，更不能默默让它消失。
  if (handleStats !== null && handleStats.limitedByHeight) {
    const maxHeightMm = readMaxHeightMm(body) ?? 0;
    const budgetMm = maxHeightMm - plateTop;
    mesh.violations = [
      ...(mesh.violations ?? []),
      {
        rule: 'size.range',
        severity: 'info',
        measured: Math.round(handleStats.heightMm * 10) / 10,
        limit: Math.round(budgetMm * 10) / 10,
        message:
          `把手被总高上限压到 ${handleStats.heightMm.toFixed(1)}mm 高、${handleStats.faceMm.toFixed(1)}mm 宽` +
          `（上限 ${maxHeightMm}mm − 刻印片 ${thickness.toFixed(1)}mm` +
          `${raised ? ` − 阳刻抬高 ${depth.toFixed(1)}mm` : ''} = ${budgetMm.toFixed(1)}mm）：` +
          `想要更粗的把手就调高总高上限。`,
        fix: 'fix:fitPattern',
      },
    ];
  }
  if (handleBudgetMm !== null) {
    const maxHeightMm = readMaxHeightMm(body) ?? 0;
    mesh.violations = [
      ...(mesh.violations ?? []),
      {
        rule: 'size.range',
        severity: 'info',
        measured: Math.max(0, Math.round(handleBudgetMm * 10) / 10),
        limit: MIN_HANDLE_HEIGHT_MM,
        message:
          `总高上限 ${maxHeightMm}mm 扣掉刻印片 ${thickness.toFixed(1)}mm` +
          `${raised ? `和阳刻抬高 ${depth.toFixed(1)}mm` : ''} 后只剩 ${Math.max(0, handleBudgetMm).toFixed(1)}mm，` +
          `放不下 ≥${MIN_HANDLE_HEIGHT_MM}mm 的把手：已只出 ${thickness.toFixed(1)}mm 刻印片。调高总高上限就会接上把手。`,
        fix: 'fix:fitPattern',
      },
    ];
  }
  return mesh;
}

/**
 * 收尾：转实体网格 → 统计 → 可打印性校验 → 跨图层重叠。
 *
 * 两条主体路径（程序生成的底板 / 外部模型库）共用这一份，避免校验口径分叉。
 * 会接管并释放 `solid` 与 `prepared` 的所有权。
 */
async function finishSeal(args: {
  kit: ManifoldKit;
  spec: SealBuildSpec;
  solid: Solid;
  polygons: readonly Polygon2D[];
  prepared: CS | null;
  prepareReport: PrepareReport | null;
  bodyShape: string;
  orientation: SealOrientation;
  /**
   * 传给可打印性校验的「有效章体」：章面形状与实际尺寸。
   * 现在图案就刻在刻印片上，所以形状/尺寸都取自片（`body.shape` × `sizeMm`），
   * 把手不影响章面。
   */
  printBody: BodyConfig;
  /** 旧口径遗留：章面不再被总高上限压小，这个值恒为 null。 */
  faceSizeWithoutHeightLimitMm?: number | null;
  /** 本枚印章接的把手（无把手时为 null/缺省）。 */
  handle?: { styleId: BodyStyleId; faceMm: number; heightMm: number } | null;
}): Promise<SolidMesh> {
  const { kit, spec, polygons, solid } = args;
  const relief = spec.relief;
  let prepared = args.prepared;

  const mesh = toSolidMesh(kit, solid, '最终实体');
  const status = mesh.status;

  // 实际总高：直接从网格量（片 + 把手 + 阳刻抬高都在里面）
  let heightMin = Infinity;
  let heightMax = -Infinity;
  for (let i = 0; i < mesh.vertProperties.length; i += mesh.numProp) {
    const z = mesh.vertProperties[i + 2]!;
    if (z < heightMin) heightMin = z;
    if (z > heightMax) heightMax = z;
  }

  lastStats = {
    triangles: mesh.triangleCount,
    status,
    bodyShape: args.bodyShape,
    relief: relief.mode,
    orientation: args.orientation,
    polygonCount: polygons.length,
    faceShape: args.printBody.shape,
    faceSizeMm: args.printBody.sizeMm,
    heightMm: Number.isFinite(heightMax) ? Math.round((heightMax - heightMin) * 100) / 100 : 0,
    handleStyleId: args.handle?.styleId ?? null,
    handleFaceMm: Math.round((args.handle?.faceMm ?? 0) * 100) / 100,
    handleHeightMm: Math.round((args.handle?.heightMm ?? 0) * 100) / 100,
    faceSizeWithoutHeightLimitMm: args.faceSizeWithoutHeightLimitMm ?? null,
  };

  // 5) 可打印性校验：2D 看笔画/间隙/孤岛/深宽比，3D 看悬空/底面/尺寸。
  //    不阻断导出，只把结果挂在 mesh 上让 UI 高亮。
  //    注意用 printBody（有效章体）：图案刻在片上，形状/尺寸取自片而不是把手。
  try {
    mesh.violations = checkPrintability({
      section: prepared,
      solid: mesh,
      body: args.printBody,
      relief,
      print: spec.print ?? { process: 'fdm', minStrokeMm: 0.4, minGapMm: 0.4 },
      prepare: args.prepareReport,
      autoFit: spec.autoFit ?? null,
    });
  } catch (error) {
    mesh.violations = [{
      rule: 'stroke.min',
      severity: 'info',
      measured: 0,
      limit: 0,
      message: `打印校验未完成（不影响导出）：${error instanceof Error ? error.message : String(error)}`,
    }];
  } finally {
    prepared?.delete();
    prepared = null;
  }

  // 6) 跨图层重叠（只有调用方给了分层信息才做）：同深度两层重叠会合并成一整块凹坑
  if (spec.layerGroups !== undefined && spec.layerGroups.length > 1) {
    try {
      mesh.violations = [
        ...(mesh.violations ?? []),
        ...(await checkLayerOverlap(spec.layerGroups)),
      ];
    } catch {
      // 重叠检测失败不影响主结果
    }
  }

  solid.delete();

  if (status !== 'NoError') {
    throw new SealGeometryError('最终实体', status);
  }
  if (mesh.triangleCount === 0) {
    throw new SealGeometryError('最终实体', status, '几何生成结果为空（可能图案完全落在章面之外）。');
  }
  return mesh;
}

/** body 上可能带的 maxHeightMm（spec 由协调层维护，这里按结构化类型读）。 */
function readMaxHeightMm(body: BodyConfig): number | null {
  const raw = (body as BodyConfig & { readonly maxHeightMm?: unknown }).maxHeightMm;
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : null;
}

/** 把 manifold 实体转成 SolidMesh，并做封闭性检查。 */
export function toSolidMesh(_kit: ManifoldKit, solid: Solid, stage: string): SolidMesh {
  const status = solid.status();
  if (status !== 'NoError') throw new SealGeometryError(stage, status);
  const mesh = solid.getMesh();
  return {
    vertProperties: mesh.vertProperties,
    triVerts: mesh.triVerts,
    numProp: mesh.numProp,
    triangleCount: mesh.triVerts.length / 3,
    status,
  };
}

function ensureStatus(solid: Solid, stage: string): void {
  const status = solid.status();
  if (status !== 'NoError') throw new SealGeometryError(stage, status);
}

