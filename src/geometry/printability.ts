/**
 * 可打印性校验：九条规则 + 自动加工记录，全部给出「实测值 + 高亮到具体笔画」。
 *
 * 输入是已经过 prepareSection 的二维截面（外环 CCW / 内孔 CW）、
 * 可选的最终网格（镜像后）、以及 spec 的 body/relief/print。
 *
 * 设计原则（见 docs/printability.md）：
 *   1. 不阻断导出，只分级；error 只留给「结构上印不出来」的情况。
 *   2. 2D 能判的绝不上 3D：笔画/间隙用 0.05mm 栅格 + 精确 EDT 量（raster.ts），
 *      不用 offset 开闭运算——Clipper2 圆角在 0.4mm 尺度有 0.1–0.7mm² 噪声。
 *   3. 每条违规都带 highlight，UI 必须能指出是哪一笔——只弹一句话不算。
 */

import type { BodyConfig, PrintConfig, PrintProcess, ReliefConfig } from '../core/spec.ts';
import type { PrepareReport } from './crosssection.ts';
import type { CS } from './morphology.ts';
import { sectionFromPolygons } from './crosssection.ts';
import { bboxToHighlight, measureMaxStrokeRaster, measureMinGapRaster, measureMinStrokeRaster } from './raster.ts';
import type { Contour, LayerPolygons, SolidMesh, Vec2 } from './types.ts';

export type Severity = 'error' | 'warn' | 'info';

export type PrintRuleId =
  | 'stroke.min'
  | 'gap.min'
  | 'island.min'
  | 'relief.aspect'
  | 'groove.aspect'
  | 'nozzle.feature'
  | 'overhang.angle'
  | 'bridge.span'
  | 'base.flat'
  | 'size.range'
  | 'pattern.bounds'
  | 'auto.fix'
  | 'overlap.samedepth';

export interface ViolationHighlight {
  /** 违规区域的轮廓（mm，镜像前的章面坐标系）；stroke/gap 用 bbox 四角。 */
  polygons?: Vec2[][];
  /** [minX, minY, maxX, maxY]，没有 polygons 时也能画框。 */
  bbox?: [number, number, number, number];
  /** 单个定位点（悬空面、越界点）。 */
  point?: Vec2;
}

export interface Violation {
  rule: PrintRuleId;
  severity: Severity;
  /** 实测值：宽度/间隙 mm，面积 mm²，角度度，计数个。 */
  measured: number;
  limit: number;
  message: string;
  fix?: string;
  highlight?: ViolationHighlight;
}

export interface PrintabilityInput {
  /** 已 prepareSection 的二维图案；没有图案时为 null。 */
  section: CS | null;
  /** 最终实体（镜像后）；只做 2D 规则时可为 null。 */
  solid?: SolidMesh | null;
  body: BodyConfig;
  relief: ReliefConfig;
  print: PrintConfig;
  /** prepareSection 的加工记录，用于解释「已自动合并/加粗」。 */
  prepare?: PrepareReport | null;
}

interface Preset {
  islandAreaMm2: number;
  reliefRatio: number;
  grooveRatio: number;
  checkOverhang: boolean;
  minSizeMm: number;
  maxSizeMm: number;
  minHandleMm: number;
}

const FDM: Preset = {
  islandAreaMm2: 0.5,
  reliefRatio: 2,
  grooveRatio: 1,
  checkOverhang: true,
  minSizeMm: 10,
  maxSizeMm: 60,
  minHandleMm: 8,
};

const RESIN: Preset = {
  islandAreaMm2: 0.1,
  reliefRatio: 3,
  grooveRatio: 1.5,
  checkOverhang: false,
  minSizeMm: 5,
  maxSizeMm: 50,
  minHandleMm: 6,
};

/** 阈值比较容差：栅格半格 0.025 + 舍入。 */
const EPS = 0.01;

/** 阴刻单条槽超过这个宽度，FDM 分离式桥接会塌（0.4–2mm 的槽可桥）。 */
const BRIDGE_GROOVE_LIMIT_MM = 5;

export function checkPrintability(input: PrintabilityInput): Violation[] {
  const out: Violation[] = [];
  const preset = input.print.process === 'resin' ? RESIN : FDM;
  const minStrokeMm = Math.max(0.05, input.print.minStrokeMm);
  const minGapMm = Math.max(0.05, input.print.minGapMm);
  const depthMm = Math.max(0, input.relief.depthMm);

  const section = input.section;

  // 搜索上限 0.7mm：超过这个宽度不可能违规，栅格也不必再看。
  const widthLimitMm = Math.min(0.7, Math.max(minStrokeMm, depthMm / preset.reliefRatio, 0.1));
  const gapLimitMm = Math.min(0.7, Math.max(minGapMm, depthMm / preset.grooveRatio, 0.1));

  let minWidthMm: number | null = null;
  let minGapWidthMm: number | null = null;

  if (section !== null && !section.isEmpty()) {
    const stroke = measureMinStrokeRaster(section, { limitMm: widthLimitMm, gridMm: 0.05 });
    const strokeAtLimit = stroke.atLimit;
    minWidthMm = stroke.atLimit ? widthLimitMm : stroke.sizeMm;

    if (!stroke.atLimit && stroke.sizeMm < minStrokeMm - EPS) {
      out.push({
        rule: 'stroke.min',
        severity: 'warn',
        measured: round2(stroke.sizeMm),
        limit: minStrokeMm,
        message: `最细笔画 ${round2(stroke.sizeMm)}mm，低于 ${minStrokeMm}mm 下限（涉及 ${round2(stroke.areaMm2)}mm² 材料）：切片器会跳过或断开。`,
        fix: 'fix:thicken',
        highlight: { polygons: bboxToHighlight(stroke.bbox), bbox: stroke.bbox ?? undefined },
      });
    }

    const gap = measureMinGapRaster(section, { limitMm: gapLimitMm, gridMm: 0.05 });
    minGapWidthMm = gap.atLimit ? gapLimitMm : gap.sizeMm;

    if (!gap.atLimit && gap.sizeMm < minGapMm - EPS) {
      const welded = input.prepare?.weldedGapAreaMm2 ?? 0;
      const advice = welded > 0.01
        ? `闭运算已合并 ${round2(welded)}mm² 窄缝，再合会把相邻笔画焊死；想彻底拉开只能少排几个字、放大章面或换窄字体。`
        : '想彻底拉开只能少排几个字、放大章面或换窄字体。';
      out.push({
        rule: 'gap.min',
        // 提示级，不是警告：间隙只影响两笔会不会粘连，不影响出实体、导出和打印。
        // 30mm 章面排四字时间隙必然是 0.17mm 级（随字号等比缩放，调字距无解），
        // 卡成 warn 等于让最常见的场景永远挂黄条，用户很快就会学会无视它。
        severity: 'info',
        measured: round2(gap.sizeMm),
        limit: minGapMm,
        message: `最窄间隙 ${round2(gap.sizeMm)}mm，窄于参考值 ${minGapMm}mm：两笔边缘可能轻微粘连，盖出来略糊。${advice}`,
        fix: 'fix:space',
        highlight: { polygons: bboxToHighlight(gap.bbox), bbox: gap.bbox ?? undefined },
      });
    }

    out.push(...checkIslands(section, preset));

    // 亚喷嘴特征：不重复量（offset 计数有圆角噪声），汇总上面的违规类别
    const subNozzle = out.filter((v) => v.rule === 'stroke.min' || v.rule === 'gap.min').length;
    if (subNozzle > 0) {
      out.push({
        rule: 'nozzle.feature',
        severity: 'info',
        measured: subNozzle,
        limit: 0,
        message: `有 ${subNozzle} 类亚喷嘴特征（<${minStrokeMm}mm）：切片器可能跳过或架桥糊平，已在预览高亮。`,
      });
    }

    // 深宽比：只在拿到真实最小宽度时判（atLimit = 没有细到违规的笔画，视为通过）
    if (depthMm > 0 && !strokeAtLimit && minWidthMm !== null) {
      const ratio = depthMm / Math.max(minWidthMm, 0.05);
      if (ratio > preset.reliefRatio + EPS) {
        out.push({
          rule: 'relief.aspect',
          severity: 'warn',
          measured: round2(ratio),
          limit: preset.reliefRatio,
          message: `浮雕深宽比 ${round2(ratio)}（${depthMm}mm 深 / ${round2(minWidthMm)}mm 宽），超过 ${preset.reliefRatio}：细高墙会晃、易断。`,
          fix: 'fix:reduceDepth',
        });
      }
    }

    if (input.relief.mode === 'engraved' && depthMm > 0 && !strokeAtLimit) {
      const narrowest = Math.min(minWidthMm ?? depthMm, minGapWidthMm ?? depthMm);
      const ratio = depthMm / Math.max(narrowest, 0.05);
      if (ratio > preset.grooveRatio + EPS) {
        out.push({
          rule: 'groove.aspect',
          severity: 'warn',
          measured: round2(ratio),
          limit: preset.grooveRatio,
          message: `阴刻槽深宽比 ${round2(ratio)}（${depthMm}mm 深 / ${round2(narrowest)}mm 宽），超过 ${preset.grooveRatio}：喷嘴进不去，排料也会塌。`,
          fix: 'fix:switchRelief',
        });
      }
    }

    // 阴刻：槽顶要横跨「最宽的单条槽」。0.4–2mm 的槽 FDM 能分离式桥接，
    // 只有宽槽（>5mm）才需要提示；这和阳刻整片底板悬空是两件事，不能混判。
    if (input.relief.mode === 'engraved' && input.print.process === 'fdm') {
      const groove = measureMaxStrokeRaster(section, { gridMm: 0.05 });
      if (!groove.atLimit && groove.sizeMm > BRIDGE_GROOVE_LIMIT_MM) {
        out.push({
          rule: 'bridge.span',
          severity: 'warn',
          measured: round2(groove.sizeMm),
          limit: BRIDGE_GROOVE_LIMIT_MM,
          message: `最宽槽 ${round2(groove.sizeMm)}mm，槽顶要横跨这个宽度：FDM 桥不住（>${BRIDGE_GROOVE_LIMIT_MM}mm），建议把图案拆细或降低浮雕深度。`,
          highlight: { bbox: groove.bbox ?? undefined },
        });
      }
    }

    out.push(...checkPatternBounds(section, input.body));
  }

  if (input.solid) {
    out.push(...check3D(input.solid, input.body, input.relief, input.print.process, preset));
  }

  out.push(...checkSize(input.body, preset));

  // 自动加工记录：告诉用户「已经替你合并/加粗了」，避免静默改字形
  for (const note of input.prepare?.notes ?? []) {
    out.push({
      rule: 'auto.fix',
      severity: 'info',
      measured: 0,
      limit: 0,
      message: `已自动处理：${note}`,
    });
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* 2D 规则                                                             */
/* ------------------------------------------------------------------ */

/** 孤立小岛：面积过小的独立连通域（阳刻是弱凸起，阴刻是易堵小孔）。 */
function checkIslands(section: CS, preset: Preset): Violation[] {
  const out: Violation[] = [];
  let parts: CS[] = [];
  try {
    parts = section.decompose();
  } catch {
    return out;
  }
  try {
    for (const part of parts) {
      const area = part.isEmpty() ? 0 : part.area();
      if (area > 0 && area < preset.islandAreaMm2 - EPS) {
        const highlight = toHighlight(part);
        out.push({
          rule: 'island.min',
          severity: 'warn',
          measured: round2(area),
          limit: preset.islandAreaMm2,
          message: `孤立碎块 ${round2(area)}mm²，小于 ${preset.islandAreaMm2}mm²：容易断在章面上或堵住阴刻孔。`,
          fix: 'fix:dropIslands',
          highlight,
        });
      }
    }
  } finally {
    for (const part of parts) part.delete();
  }
  return out;
}



/** 图案超出章面：几何仍然合法，但会悬空/掉件。 */
function checkPatternBounds(section: CS, body: BodyConfig): Violation[] {
  let contours: Contour[];
  try {
    contours = section.toPolygons().map((p) => p.map(([x, y]) => [x, y] as Vec2));
  } catch {
    return [];
  }
  if (contours.length === 0) return [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  /** 图案上真实的离圆心最远距离（顶点级，不是包围盒角点） */
  let maxRadius = 0;
  for (const c of contours) {
    for (const [x, y] of c) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const d = Math.hypot(x, y);
      if (d > maxRadius) maxRadius = d;
    }
  }

  const half = Math.max(1, body.sizeMm) / 2;
  let limitX = half;
  let limitY = half;
  if (body.shape === 'circle') {
    // 圆章按真实顶点半径判。**不能用包围盒角点**：
    // 环形排版的外接矩形四角在 √2 倍半径处，用角点会把合法的圆章环形文字
    // 误判成超出 4~5mm 并 card 成 error 级、阻断导出（实测 4 字环章报 21.83mm，实际最远 17mm）。
    const r = maxRadius;
    if (r > half + EPS) {
      return [{
        rule: 'pattern.bounds',
        severity: 'error',
        measured: round2(r),
        limit: half,
        message: `图案最远点距圆心 ${round2(r)}mm，超出圆章半径 ${round2(half)}mm：会悬空、印不出来。`,
        fix: 'fix:fitPattern',
        highlight: { bbox: [minX, minY, maxX, maxY] },
      }];
    }
    return [];
  }
  if (body.shape === 'polygon') {
    const sides = Math.max(3, Math.min(12, Math.round(body.sides)));
    limitX = half * Math.cos(Math.PI / sides);
    limitY = limitX;
  }
  const overX = Math.max(0, -minX - limitX, maxX - limitX);
  const overY = Math.max(0, -minY - limitY, maxY - limitY);
  if (overX > EPS || overY > EPS) {
    return [{
      rule: 'pattern.bounds',
      severity: 'error',
      measured: round2(Math.max(overX, overY)),
      limit: 0,
      message: `图案超出章面 ${round2(Math.max(overX, overY))}mm：边缘笔画会悬空。`,
      fix: 'fix:fitPattern',
      highlight: { bbox: [minX, minY, maxX, maxY] },
    }];
  }
  return [];
}

/* ------------------------------------------------------------------ */
/* 3D 规则                                                             */
/* ------------------------------------------------------------------ */

function check3D(mesh: SolidMesh, body: BodyConfig, relief: ReliefConfig, process: PrintProcess, preset: Preset): Violation[] {
  const out: Violation[] = [];
  const pos = mesh.vertProperties;
  const stride = mesh.numProp >= 3 ? mesh.numProp : 3;

  let minZ = Infinity;
  for (let i = 0; i < pos.length; i += stride) {
    const z = pos[i + 2] ?? 0;
    if (z < minZ) minZ = z;
  }

  if (preset.checkOverhang) {
    const over = collectOverhang(mesh, stride, minZ);
    if (over.slopeAreaMm2 > 1) {
      out.push({
        rule: 'overhang.angle',
        severity: 'info',
        measured: round2(over.slopeAreaMm2),
        limit: 60,
        message: `有 ${round2(over.slopeAreaMm2)}mm² 悬空斜面（与水平夹角 <30°）：需要支撑，或把手柄改成桥形。`,
        highlight: over.slopeHighlight,
      });
    }
    // 阳刻：水平朝下、又不贴床的面 = 整片底板悬空，面积大了 FDM 架不住。
    // 阴刻由 2D 的「最宽单条槽」判断，不走这条面积判据。
    if (relief.mode === 'raised' && over.bridgeAreaMm2 > 20) {
      // 阳刻 + FDM + 有手柄：贴床时底板整片悬空、1.2mm 缝里拆不掉支撑 → 不允许导出
      const blocks = relief.mode === 'raised' && process === 'fdm' && body.handle !== 'none';
      out.push({
        rule: 'bridge.span',
        severity: blocks ? 'error' : 'warn',
        measured: round2(over.bridgeAreaMm2),
        limit: 20,
        message: blocks
          ? `有 ${round2(over.bridgeAreaMm2)}mm² 水平悬空面：FDM 贴床时底板整片悬在字母上方，支撑拆不掉，已阻止导出。请切换阴刻，或选「平装无手柄」后按面朝上打印。`
          : `有 ${round2(over.bridgeAreaMm2)}mm² 水平悬空面：FDM 无法一次架桥，需要支撑（阳刻盖印面朝下时，底板整片悬在字母上方）。`,
        fix: blocks ? 'fix:switchRelief' : undefined,
        highlight: over.bridgeHighlight,
      });
    }
  }

  const flat = checkBaseFlat(mesh, stride, minZ);
  if (!flat.ok) {
    out.push({
      rule: 'base.flat',
      severity: 'error',
      measured: round2(flat.deviationMm),
      limit: 0.02,
      message: `盖印面异常（z=0 平面偏差 ${round2(flat.deviationMm)}mm）：打印会翘边、盖印会歪。`,
      highlight: flat.highlight,
    });
  }

  // 浮雕深度与章体厚度：浮雕比底板深就穿底
  if (relief.depthMm > body.baseThicknessMm - 0.2) {
    out.push({
      rule: 'relief.aspect',
      severity: 'error',
      measured: round2(relief.depthMm),
      limit: round2(body.baseThicknessMm - 0.2),
      message: `浮雕深 ${relief.depthMm}mm 超过底板厚度 ${body.baseThicknessMm}mm：会直接穿底。`,
      fix: 'fix:reduceDepth',
    });
  }

  return out;
}

function collectOverhang(
  mesh: SolidMesh,
  stride: number,
  minZ: number,
): {
  slopeAreaMm2: number;
  bridgeAreaMm2: number;
  slopeHighlight?: ViolationHighlight;
  bridgeHighlight?: ViolationHighlight;
} {
  const pos = mesh.vertProperties;
  const tris = mesh.triVerts;
  const cosLimit = -Math.cos((30 * Math.PI) / 180); // n.z < -0.866 → 与水平夹角 <30°
  let slopeArea = 0;
  let slopeX = 0;
  let slopeY = 0;
  let slopeCount = 0;
  let bridgeArea = 0;
  let bridgeX = 0;
  let bridgeY = 0;
  let bridgeCount = 0;
  for (let t = 0; t < tris.length; t += 3) {
    const ia = tris[t]! * stride;
    const ib = tris[t + 1]! * stride;
    const ic = tris[t + 2]! * stride;
    const az = pos[ia + 2]!;
    const bz = pos[ib + 2]!;
    const cz = pos[ic + 2]!;
    // 贴床面（z≈minZ）的面不算悬空
    if (az <= minZ + 0.02 && bz <= minZ + 0.02 && cz <= minZ + 0.02) continue;

    const ax = pos[ia]!;
    const ay = pos[ia + 1]!;
    const bx = pos[ib]!;
    const by = pos[ib + 1]!;
    const cx = pos[ic]!;
    const cy = pos[ic + 1]!;
    const ux = bx - ax;
    const uy = by - ay;
    const uz = bz - az;
    const vx = cx - ax;
    const vy = cy - ay;
    const vz = cz - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-9) continue;
    const unitZ = nz / len;
    const triArea = len / 2;
    if (unitZ < -0.995) {
      // 纯水平朝下 = 桥接：阳刻盖印面朝下时，整片底板悬在字母上方
      bridgeArea += triArea;
      bridgeX += (ax + bx + cx) / 3;
      bridgeY += (ay + by + cy) / 3;
      bridgeCount++;
    } else if (unitZ < cosLimit) {
      slopeArea += triArea;
      slopeX += (ax + bx + cx) / 3;
      slopeY += (ay + by + cy) / 3;
      slopeCount++;
    }
  }
  return {
    slopeAreaMm2: slopeArea,
    bridgeAreaMm2: bridgeArea,
    slopeHighlight: slopeCount > 0 ? { point: [slopeX / slopeCount, slopeY / slopeCount] as [number, number] } : undefined,
    bridgeHighlight: bridgeCount > 0 ? { point: [bridgeX / bridgeCount, bridgeY / bridgeCount] as [number, number] } : undefined,
  };
}

function checkBaseFlat(
  mesh: SolidMesh,
  stride: number,
  minZ: number,
): { ok: boolean; deviationMm: number; highlight?: ViolationHighlight } {
  const pos = mesh.vertProperties;
  const tris = mesh.triVerts;
  let deviation = 0;
  let badX = 0;
  let badY = 0;
  let bad = 0;
  let bedFaces = 0;

  for (let t = 0; t < tris.length; t += 3) {
    const idx = [tris[t]! * stride, tris[t + 1]! * stride, tris[t + 2]! * stride];
    const zs = idx.map((i) => pos[i + 2]!);
    if (!zs.every((z) => z <= minZ + 0.02)) continue;

    bedFaces++;
    const [ax, ay] = [pos[idx[0]!]!, pos[idx[0]! + 1]!];
    const [bx, by] = [pos[idx[1]!]!, pos[idx[1]! + 1]!];
    const [cx, cy] = [pos[idx[2]!]!, pos[idx[2]! + 1]!];
    const nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const deviationHere = Math.max(...zs) - minZ;
    if (deviationHere > deviation) deviation = deviationHere;
    // 法线z分量应为负（朝下）：叉积符号约定随手性，这里只要求 |nz| 足够大且同向
    if (Math.abs(nz) < 1e-9) {
      bad++;
      badX += (ax + bx + cx) / 3;
      badY += (ay + by + cy) / 3;
    }
  }

  // 盖印面必须真的落在 z=0：没有贴床面，说明图案/底板整体偏移了
  if (bedFaces === 0 || Math.abs(minZ) > 0.05) {
    return { ok: false, deviationMm: Math.abs(minZ) };
  }

  if (bad > 0) {
    return {
      ok: false,
      deviationMm: 0.02,
      highlight: { point: [badX / bad, badY / bad] },
    };
  }
  return { ok: deviation <= 0.02, deviationMm: deviation };
}

/* ------------------------------------------------------------------ */
/* 尺寸                                                                */
/* ------------------------------------------------------------------ */

function checkSize(body: BodyConfig, preset: Preset): Violation[] {
  const out: Violation[] = [];
  if (body.sizeMm < preset.minSizeMm || body.sizeMm > preset.maxSizeMm) {
    out.push({
      rule: 'size.range',
      severity: 'error',
      measured: round2(body.sizeMm),
      limit: preset.maxSizeMm,
      message: `章面 ${body.sizeMm}mm 超出 ${preset.minSizeMm}–${preset.maxSizeMm}mm 可用范围。`,
    });
  }

  const area = faceAreaMm2(body);
  if (area < 100) {
    out.push({
      rule: 'size.range',
      severity: 'warn',
      measured: round2(area),
      limit: 100,
      message: `章面面积 ${round2(area)}mm² 偏小：首层容易翘边，建议加 brim。`,
    });
  }

  if (body.handle !== 'none' && body.handleDiameterMm < preset.minHandleMm) {
    out.push({
      rule: 'size.range',
      severity: 'warn',
      measured: round2(body.handleDiameterMm),
      limit: preset.minHandleMm,
      message: `手柄直径 ${body.handleDiameterMm}mm 小于 ${preset.minHandleMm}mm：按压时容易断。`,
    });
  }
  return out;
}

function faceAreaMm2(body: BodyConfig): number {
  const r = Math.max(1, body.sizeMm) / 2;
  switch (body.shape) {
    case 'circle':
      return Math.PI * r * r;
    case 'polygon': {
      const n = Math.max(3, Math.min(12, Math.round(body.sides)));
      return 0.5 * n * r * r * Math.sin((2 * Math.PI) / n);
    }
    case 'square':
    default:
      return body.sizeMm * body.sizeMm;
  }
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function toHighlight(section: CS | null): ViolationHighlight | undefined {
  if (section === null || section.isEmpty()) return undefined;
  try {
    const rings = section.toPolygons();
    const polygons: Vec2[][] = [];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const ring of rings) {
      const contour: Vec2[] = [];
      for (const [x, y] of ring) {
        contour.push([x, y] as Vec2);
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      if (contour.length >= 3) polygons.push(contour);
    }
    if (polygons.length === 0) return undefined;
    return { polygons, bbox: [minX, minY, maxX, maxY] };
  } catch {
    return undefined;
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/* ------------------------------------------------------------------ */
/* 跨图层重叠                                                          */
/* ------------------------------------------------------------------ */

/** 两层在同深度重叠超过该面积才提示（mm²）。 */
const OVERLAP_LIMIT_MM2 = 0.5;

/**
 * 同深度图层重叠检测。
 *
 * 当前 spec 只有一个全局 relief depth，文字与图像必然同深；两层重叠时二维并集
 * 会把它们连成一片凹坑，边界彻底消失。这不是几何 bug（布尔结果是对的），
 * 而是用户看不出来的设计问题，所以只给 warn + 高亮重叠区域。
 */
export async function checkLayerOverlap(groups: readonly LayerPolygons[]): Promise<Violation[]> {
  const active = groups.filter((group) => group.polygons.length > 0);
  if (active.length < 2) return [];

  const out: Violation[] = [];
  const sections = await Promise.all(active.map((group) => sectionFromPolygons(group.polygons)));
  try {
    for (let i = 0; i < active.length; i++) {
      for (let j = i + 1; j < active.length; j++) {
        const inter = sections[i]!.intersect(sections[j]!);
        const area = inter.isEmpty() ? 0 : inter.area();
        if (area > OVERLAP_LIMIT_MM2) {
          out.push({
            rule: 'overlap.samedepth',
            severity: 'warn',
            measured: round2(area),
            limit: OVERLAP_LIMIT_MM2,
            message: `${layerName(active[i]!.kind)}与${layerName(active[j]!.kind)}在同一深度重叠 ${round2(area)}mm²：凹槽会连成一片、边界消失；建议缩小/移动图层，或让文字避开图案。`,
            highlight: toHighlight(inter),
          });
        }
        inter.delete();
      }
    }
  } finally {
    for (const section of sections) section.delete();
  }
  return out;
}

function layerName(kind: LayerPolygons['kind']): string {
  return kind === 'text' ? '文字' : '图像';
}
