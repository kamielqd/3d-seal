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
 *   手柄:         坐在底板背面（阳刻 z = depth + T，阴刻 z = T），
 *                 向下嵌 base 与底板搭接，所以手柄顶面 = 底板顶面 − 嵌深 + handleHeight
 *
 * 由此推出的不变量（scripts/verify.ts 按这些断言，不写死毫米数）：
 *   - 阳刻 zMax = depth + baseThickness，zMin = 0
 *   - 阴刻 zMax = baseThickness，zMin = 0，且存在 z = depth 的槽底平面
 *   - 加手柄后 zMax = 底板顶面 − 嵌深 + handleHeightMm
 *
 * 不做整体 Z 翻转：那会把旋钮手柄翻到下面。要"背面贴床"只有显式的
 * `orientation: 'face-up'` 分支（刚体旋转 180°，要求 handle === 'none'）。
 */

import type { BodyConfig, PrintConfig, ReliefConfig } from '../core/spec.ts';
import { getManifold, prepareSectionWithReport } from './crosssection.ts';
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
/* 手柄                                                               */
/* ------------------------------------------------------------------ */

/**
 * 手柄：用截面绕 Z 轴旋转（revolve）生成，坐在背面 `bottomZ` 上。
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
 * @param spec body / relief / print
 * @param polygons 二维图案（文字与图像已合并），外环 CCW、内孔 CW、单位 mm
 */
export async function buildSeal(spec: SealBuildSpec, polygons: readonly Polygon2D[]): Promise<SolidMesh> {
  const kit = await getManifold();
  const body = spec.body;
  const relief = spec.relief;
  const print = spec.print;

  const thickness = Math.max(0.8, body.baseThicknessMm);
  const depth = Math.max(0.2, relief.depthMm);
  const raised = relief.mode !== 'engraved';

  // z 轴约定：z=0 = 盖印面（贴打印床的那一面，盖出来接触纸）
  //   阳刻：字母 z∈[0, depth]，底板 z∈[depth, depth+T]，手柄在底板背面
  //   阴刻：底板 z∈[0, T]，槽从 z=0 往上挖 depth，手柄在 z=T 背面
  // 这样阳刻的字母柱立在床上、底板横跨在上面（桥接跨度=字缝），无需支撑；
  // 整体 Z 翻转会把旋钮手柄翻到下面，不能用。
  const plateBottom = raised ? depth : 0;
  const plateTop = plateBottom + thickness;

  // 1) 底板
  const faceSection = bodySection(kit, body);
  const plateExtruded = faceSection.extrude(thickness);
  faceSection.delete();
  const plate = plateExtruded.translate([0, 0, plateBottom]);
  plateExtruded.delete();
  ensureStatus(plate, '底板挤出');

  // 2) 手柄：坐在背面（plateTop）上，向下嵌入 base 与底板搭接
  const handle = handleSolid(kit, body, plateTop);
  let solid: Solid = plate;
  if (handle !== null) {
    const next = plate.add(handle);
    plate.delete();
    handle.delete();
    solid = next;
    ensureStatus(solid, '底板与手柄合并');
  }

  // 3) 图案：二维阶段先闭运算（保间隙）+ 测量外扩（保笔画），再一次性挤出
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

    if (!prepared.isEmpty()) {
      // 与底板搭接 0.02mm，避免共面布尔退化
      const overlap = 0.02;

      if (raised) {
        // 字母从 z=0 长到 depth+overlap，与底板在 [depth, depth+overlap] 搭接
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
  }

  // 4) 镜像 X：印章必须镜像，盖出来才是正的
  const mirrored = solid.mirror([1, 0, 0]);
  solid.delete();
  solid = mirrored;

  // 4.5) 打印取向：face-up = 整体绕 X 轴翻转 180° 后重新落回 z=0（刚体旋转，不改环方向）。
  //      阳刻贴床时底板整片悬空，无手柄时可翻面：背面贴床、字母朝上，悬空面为 0。
  const orientation: SealOrientation = spec.orientation ?? 'face-down';
  if (orientation === 'face-up') {
    if (body.handle !== 'none') {
      throw new SealGeometryError(
        '打印取向',
        'FaceUpRequiresNoHandle',
        '面朝上打印必须去掉手柄：请把手柄设为「无」，或切回「盖印面贴床」并改用阴刻。',
      );
    }
    const flipped = solid.rotate([180, 0, 0]).translate([0, 0, plateTop]);
    solid.delete();
    solid = flipped;
    ensureStatus(solid, '面朝上翻转');
  }

  const mesh = toSolidMesh(kit, solid, '最终实体');
  const status = mesh.status;
  lastStats = {
    triangles: mesh.triangleCount,
    status,
    bodyShape: body.shape,
    relief: relief.mode,
    orientation,
    polygonCount: polygons.length,
  };

  // 5) 可打印性校验：2D 看笔画/间隙/孤岛/深宽比，3D 看悬空/底面/尺寸。
  //    不阻断导出，只把结果挂在 mesh 上让 UI 高亮。
  try {
    mesh.violations = checkPrintability({
      section: prepared,
      solid: mesh,
      body,
      relief,
      print: print ?? { process: 'fdm', minStrokeMm: 0.4, minGapMm: 0.4 },
      prepare: prepareReport,
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

