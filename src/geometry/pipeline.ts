/**
 * 印章实体管线：二维多边形 → 可打印封闭实体。
 *
 * 契约（与 src/core/spec.ts、src/layout 对齐）：
 *   - 只吃 `Polygon2D[]` + body + relief，不感知「这是圆章还是方章」
 *   - 单位 mm，原点在章面中心
 *   - 最后一步镜像 X（印章盖出来才是正的），镜像后保持外环 CCW
 *
 * ## z 约定：盖印面贴床（写死，不要改）
 *
 * z=0 是**盖印面**，也就是贴打印床的那一面；z 轴向上长。
 * 理由：印章卖的就是章面的表面质量，贴床那一面最平整；阳刻的凸起朝上，不需要支撑。
 *
 *   阳刻 raised:  图案 z ∈ [0, depth]                          凸起直接立在床上
 *                 底板 z ∈ [depth, depth + baseThickness]
 *   阴刻 engraved: 底板 z ∈ [0, baseThickness]                 章面就是底板面
 *                 槽   z ∈ [0, depth]（从 z=0 往上挖，槽底在 z=depth）
 *
 * 手柄已从产品删除（主体改版为 4 个内置模型 + 测试片）：`handleSolid` 仍导出，
 * 但不再被任何生成路径调用，`body.handle` 只为旧分享链接留字段。
 *
 * 由此推出的不变量（scripts/verify.ts 按这些断言，不写死毫米数）：
 *   - 阳刻 zMax = depth + baseThickness，zMin = 0
 *   - 阴刻 zMax = baseThickness，zMin = 0，且存在 z = depth 的槽底平面
 *
 * 不做整体 Z 翻转：那会把章体翻到下面。要"背面贴床"只有显式的
 * `orientation: 'face-up'` 分支（刚体旋转 180°），而且只对阳刻有意义。
 */

import type { BodyConfig, BodyKind, PrintConfig, ReliefConfig } from '../core/spec.ts';
import type { LayerFit } from '../core/layout-bridge.ts';
import { getBodyStyle, isBodyStyleId, loadBody } from './body-library.ts';
import type { BodyStyleId } from './body-library.ts';
import { fromCrossSection, getManifold, prepareSectionWithReport } from './crosssection.ts';
import type { ManifoldKit, PrepareReport } from './crosssection.ts';
import { checkLayerOverlap, checkPrintability } from './printability.ts';
import type { LayerPolygons, Polygon2D, SolidMesh } from './types.ts';
import { SealGeometryError } from './types.ts';

type CS = InstanceType<ManifoldKit['CrossSection']>;
type Solid = InstanceType<ManifoldKit['Manifold']>;

/** 打印取向：face-down = 盖印面贴床（默认）；face-up = 背面贴床、字母朝上（必须无手柄）。 */
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
  /** 章面形状：外部主体由模型决定，程序章体取 body.shape（polygon 按方形边界处理）。 */
  faceShape: 'square' | 'circle' | 'polygon';
  /** 实际章面足迹 mm（缩放之后；外部主体可能被总高上限压小）。 */
  faceSizeMm: number;
  /** 实际总高 mm（含手柄/柱身）。 */
  heightMm: number;
  /** 总高上限生效时，按足迹本可以做到多大（mm）；没被限制就是 null。 */
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
/* 手柄（已从产品删除，见 handleSolid）                                  */
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
 * 手柄：用截面绕 Z 轴旋转（revolve）生成，坐在背面 `bottomZ` 上。
 *
 * ⚠️ 产品已删除手柄（主体改版为 4 个内置模型 + 测试片）：**没有任何生成路径
 * 再调用它**。保留导出只为旧代码/脚本引用，别在 buildSeal 里重新接上——
 * 默认 spec 里 handle 仍是 'knob'，接上就会让每块测试片悄悄长旋钮。
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
 * 造一枚完整印章。
 *
 * 按 `body.styleId` 分派：
 *   - 4 个内置模型（classic / cylinder / column / dome）→ 模型库路径
 *   - `plate`（测试片）→ 参数化平板：方形 / 圆形 / 正多边形，厚度默认 3mm
 *   - **没有 styleId**：旧 spec 兼容，按测试片处理。新建 spec 一定带 styleId
 *     （默认 classic），所以这条分支只在旧数据和测试里出现。
 *
 * @param spec body / relief / print
 * @param polygons 二维图案（文字与图像已合并），外环 CCW、内孔 CW、单位 mm
 */
export async function buildSeal(spec: SealBuildSpec, polygons: readonly Polygon2D[]): Promise<SolidMesh> {
  const kit = await getManifold();
  const styleId = readAnyBodyStyle(spec.body);
  if (styleId !== null && styleId !== 'plate') {
    return buildSealWithLibraryBody(kit, spec, polygons, styleId);
  }
  return buildSealWithPlate(kit, spec, polygons);
}

/** `plate`（参数化测试片）+ 4 个内置模型，统称主体样式。 */
function readAnyBodyStyle(body: BodyConfig): BodyKind | null {
  // 直接按结构化类型读，避免和 spec.ts 里将来收窄的 styleId 类型打架
  const raw = (body as { readonly styleId?: unknown }).styleId;
  if (raw === 'plate') return 'plate';
  return isBodyStyleId(raw) ? raw : null;
}

/** 测试片参数：形状 / 边数 / 厚度。字段还没进 spec 时按结构化类型读并给默认值。 */
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
 * 测试片：一块厚 `thicknessMm` 的平板（方/圆/正多边形），没有手柄、没有边框。
 *
 * z 约定与整枚印章一致（盖印面贴床，z=0）：
 *   阳刻：图案 z∈[0, depth]，平板 z∈[depth, depth+T]
 *   阴刻：平板 z∈[0, T]，槽从 z=0 往上挖 depth
 * 最后镜像 X。
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
      '测试片',
      'ReliefDeeperThanPlate',
      `浮雕深 ${depth}mm 接近/超过测试片厚度 ${thickness}mm：阳刻会直接穿底。把深度降到 ${Math.max(0.2, thickness - 0.4).toFixed(1)}mm 以下，或加厚测试片。`,
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
  ensureStatus(plate, '测试片挤出');
  let solid: Solid = plate;

  // 注意：这里**不再**接手柄。主体改版后只有 4 个内置模型 + 测试片，UI 已删掉手柄
  // 选择器，但默认 spec 里仍是 handle: 'knob'——在这里接上会让每块测试片都悄悄长
  // 出一根 16mm 旋钮，「3mm 测试片」直接不成立。`body.handle` 只为旧链接留字段。

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

  // 4) 镜像 X：印章必须镜像，盖出来才是正的
  const mirrored = solid.mirror([1, 0, 0]);
  solid.delete();
  solid = mirrored;

  // 4.5) 打印取向。
  //
  // ⚠️ 产品决策：打印方向固定「刻印面贴床」（face-down），UI 的选择器要删。
  //    这里的 face-up 分支现在**只为「平装阳刻」预设保留**（阳刻贴床时底板整片
  //    悬空、拆不掉支撑，必须翻面打）。等用户答复「阳刻要不要保留」后：
  //      - 保留阳刻 → 这个分支由该预设内部自动选择，不再暴露成用户选项；
  //      - 删掉阳刻 → 连同这个分支一起删。
  //    在那之前不要重构它，也不要让别的入口传 face-up。
  const orientation: SealOrientation = spec.orientation ?? 'face-down';
  if (orientation === 'face-up') {
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

  return finishSeal({
    kit,
    spec,
    solid,
    polygons,
    prepared,
    prepareReport,
    bodyShape: `plate:${params.shape}`,
    orientation,
    printBody: { ...body, shape: params.shape, sizeMm: body.sizeMm },
  });
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
   * 外部主体要用模型自己的形状（圆/方）和缩放后的真实足迹，
   * 否则 `checkPatternBounds` / `checkSize` 会按方形和用户设的名义尺寸判。
   */
  printBody: BodyConfig;
  /** 总高上限压过足迹时，记录「不限高能到多大」；未受限为 null。 */
  faceSizeWithoutHeightLimitMm?: number | null;
}): Promise<SolidMesh> {
  const { kit, spec, polygons, solid } = args;
  const relief = spec.relief;
  let prepared = args.prepared;

  const mesh = toSolidMesh(kit, solid, '最终实体');
  const status = mesh.status;

  // 实际总高：直接从网格量，两条路径都准（含手柄/柱身）
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
    faceSizeWithoutHeightLimitMm: args.faceSizeWithoutHeightLimitMm ?? null,
  };

  // 5) 可打印性校验：2D 看笔画/间隙/孤岛/深宽比，3D 看悬空/底面/尺寸。
  //    不阻断导出，只把结果挂在 mesh 上让 UI 高亮。
  //    注意用 printBody（有效章体）：外部主体的形状/实际足迹与 body 不同。
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

/* ------------------------------------------------------------------ */
/* 外部主体                                                            */
/* ------------------------------------------------------------------ */

/**
 * 外部主体路径：模型库里的章体 + 边框 + 阴刻/阳刻图案。
 *
 *   - 缩放：底面足迹缩到 `body.sizeMm`（源单位是 cm），居中到原点、底面 z=0
 *   - 边框：从**实体本身**在 z=0.05 切一片当基准（模型底部不是配置里的方圆），
 *     再按 border 参数取环；在 `prepareSection` 之后合并，和测试片路径同一条规则
 *   - 阴刻：图案 + 边框挤出成柱体，从 z=-0.02 切到 depth，与母体求差
 *   - 阳刻：图案 + 边框从 z=-depth 挤到 +0.02 与母体并集，再整体上移 depth——
 *     字母贴床、母体落到 depth 之上。抬高这段算进总高预算（见 scaleByHeight）
 *   - 手柄：模型自带形制，`body.handle` 在这里不生效
 *   - 打印取向：强制盖印面贴床（模型是实心的，翻面只会把它倒过来）
 *   - 最后照旧镜像 X
 */
async function buildSealWithLibraryBody(
  kit: ManifoldKit,
  spec: SealBuildSpec,
  polygons: readonly Polygon2D[],
  styleId: BodyStyleId,
): Promise<SolidMesh> {
  const body = spec.body;
  const relief = spec.relief;
  const print = spec.print;
  const depth = Math.max(0.2, relief.depthMm);
  const raised = relief.mode !== 'engraved';

  // 共享缓存实例，不能 delete；下面只用它派生新实体
  const source = await loadBody(styleId);
  const style = getBodyStyle(styleId);
  const sourceBox = source.boundingBox();
  const footprintCm = Math.max(sourceBox.max[0] - sourceBox.min[0], sourceBox.max[1] - sourceBox.min[1]);
  const sourceHeightCm = Math.max(1e-6, sourceBox.max[2] - sourceBox.min[2]);
  if (!(footprintCm > 0)) {
    throw new SealGeometryError('外部主体', 'EmptyBody', `${styleId} 的底面足迹为 0，无法缩放。`);
  }

  // 缩放取小：足迹 ≤ sizeMm，且总高 ≤ maxHeightMm（都按 mm 算）。
  //
  // ⚠️ 阳刻时母体要整体抬高 `depth`（图案从 z=0 长到母体底部），所以总高预算
  //    **必须扣掉这段**：上限是硬约束，只管母体本身会让抬高后的总高冲破它。
  //
  // 源坐标单位是 cm，乘 k 之后坐标直接变成 mm（2.00cm 的底座 × 15 = 30mm）
  const scaleByFootprint = body.sizeMm / footprintCm;
  const maxHeightMm = readMaxHeightMm(body);
  const heightBudgetMm = maxHeightMm === null ? Number.POSITIVE_INFINITY : maxHeightMm - (raised ? depth : 0);
  const scaleByHeight =
    maxHeightMm === null ? Number.POSITIVE_INFINITY : Math.max(1e-3, heightBudgetMm) / sourceHeightCm;
  const scale = Math.min(scaleByFootprint, scaleByHeight);

  const actualFaceMm = footprintCm * scale;
  const heightLimited = scaleByHeight < scaleByFootprint - 1e-9;
  // 按足迹缩会得到多高（只在被限高时用来解释原因；阳刻时含抬高那段）
  const heightIfFootprintScaled = sourceHeightCm * scaleByFootprint + (raised ? depth : 0);

  const scaled = source.scale([scale, scale, scale]);
  const scaledBox = scaled.boundingBox();
  const placed = scaled.translate([
    -(scaledBox.min[0] + scaledBox.max[0]) / 2,
    -(scaledBox.min[1] + scaledBox.max[1]) / 2,
    -scaledBox.min[2],
  ]);
  scaled.delete();
  ensureStatus(placed, '主体缩放');
  let solid: Solid = placed;

  // 图案 → 阴刻槽 / 阳刻凸台（和程序底板同一段逻辑）
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

  // 边框：外部主体的章面形状不是配置里的方圆，必须从**实体本身**取轮廓，
  // 在底面以上 0.05mm 处切一片当基准，再按 border 生成环（与程序底板同参数）。
  let border: CS | null = null;
  if (body.border.style !== 'none') {
    const face = solid.slice(0.05);
    if (!face.isEmpty()) border = borderSection(face, body.border);
    face.delete();
  }
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

  const hasPattern = prepared !== null && !prepared.isEmpty();
  if (hasPattern) {
    const overlap = 0.02;
    if (raised) {
      // 凸台从 z=-depth 长到 +overlap，与母体底面搭接；之后整体上移 depth
      const stamp = prepared!.extrude(depth + overlap).translate([0, 0, -depth]);
      const next = solid.add(stamp);
      solid.delete();
      stamp.delete();
      ensureStatus(next, '阳刻并集');
      solid = next;
    } else {
      // 槽从 z=0 往上挖；刀体向下多出 overlap，避免与 z=0 共面
      const cutter = prepared!.extrude(depth + overlap).translate([0, 0, -overlap]);
      const next = solid.subtract(cutter);
      solid.delete();
      cutter.delete();
      ensureStatus(next, '阴刻差集');
      solid = next;
    }
  }

  // 阳刻：整体抬回 z=0（字母/边框的盖印面贴床），底板落到 depth 之上
  if (raised && hasPattern) {
    const lifted = solid.translate([0, 0, depth]);
    solid.delete();
    solid = lifted;
    ensureStatus(solid, '阳刻抬回床面');
  }

  // 镜像 X：印章必须镜像，盖出来才是正的
  const mirrored = solid.mirror([1, 0, 0]);
  solid.delete();
  solid = mirrored;

  // 有效章体：形状来自模型（圆/方），尺寸是缩放后的**实际**足迹。
  // 不这么做的话 checkPatternBounds 会按方形判圆章（高估 41%），
  // checkSize 会按用户设的名义尺寸判（把被限高的章体当超限/合规判错）。
  const printBody: BodyConfig = {
    ...body,
    shape: style.faceShape,
    sizeMm: actualFaceMm,
    // 外部主体的手柄是模型自带的，`body.handle` 在这里不生效；置 none 是为了
    // 不让旧分享链接里的 handle/handleDiameterMm 触发无关的「手柄直径太小」提示。
    handle: 'none',
  };

  const mesh = await finishSeal({
    kit,
    spec,
    solid,
    polygons,
    prepared,
    prepareReport,
    bodyShape: `library:${styleId}`,
    // 外部主体是实心模型，face-up 翻面只会把它倒过来，所以固定贴床
    orientation: 'face-down',
    printBody,
    faceSizeWithoutHeightLimitMm: heightLimited ? body.sizeMm : null,
  });

  // 总高上限生效时必须明说，不能默默把章面缩小
  if (heightLimited) {
    mesh.violations = [
      ...(mesh.violations ?? []),
      {
        rule: 'size.range',
        severity: 'info',
        measured: Math.round(actualFaceMm * 100) / 100,
        limit: body.sizeMm,
        message:
          `章面被总高上限压到 ${actualFaceMm.toFixed(1)}mm（你要 ${body.sizeMm}mm，总高上限 ${maxHeightMm}mm` +
          `${raised ? `，其中 ${depth.toFixed(1)}mm 是阳刻抬高` : ''}）：` +
          `${style.label} 源模型偏高瘦，按足迹缩会到 ${heightIfFootprintScaled.toFixed(1)}mm 高。` +
          `想要更大的章面就调高总高上限，或换更扁的模型。`,
        fix: 'fix:fitPattern',
      },
    ];
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

