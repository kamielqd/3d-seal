/**
 * 画布编辑器：叠在「盖印效果」预览图上的一层交互 SVG。
 *
 * 为什么叠 SVG 而不是重写渲染：预览是逐扫描线算出来的墨迹位图（阴刻要把图案以外的
 * 部分涂满），那套算法是对的、也够快；这里只补「看得见、抓得住、拖得动」，
 * 不重复实现墨迹渲染。
 *
 * 坐标：viewBox 用 mm、原点在章面中心、y 向上（内层 g 做 scale(1,-1)），
 * 与 `renderPreviewToDataURL` 的布局一致（画布 mm = 章面 + 2×padding）。
 */

import { useRef, useState } from 'react';

export interface CanvasPolygon {
  points: { x: number; y: number }[];
}

export interface CanvasLayer {
  id: string;
  kind: 'text' | 'image';
  /** 该层在「可读」坐标系下的轮廓（未镜像，和盖印预览同向） */
  rings: readonly CanvasPolygon[];
  /** 当前锚点，拖动时以它为基准算增量 */
  anchor: { x: number; y: number };
}

export interface CanvasEditorProps {
  sizeMm: number;
  /** 与预览渲染保持一致的画布留白（mm） */
  paddingMm: number;
  shape: 'square' | 'circle' | 'polygon';
  sides: number;
  layers: readonly CanvasLayer[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** 拖动把新位置写回；单位是 anchor（-1~1，1 ≈ 章面四分之三处） */
  onAnchor: (id: string, x: number, y: number) => void;
}

/** anchor 单位 → mm：与 layout-bridge 的 anchorToMm 保持一致 */
function anchorToMmFactor(sizeMm: number): number {
  return (sizeMm / 2) * 0.75;
}

function ringsToPath(rings: readonly CanvasPolygon[]): string {
  let d = '';
  for (const ring of rings) {
    if (ring.points.length < 3) continue;
    const p = ring.points;
    d += `M${p[0].x.toFixed(3)} ${p[0].y.toFixed(3)}`;
    for (let i = 1; i < p.length; i++) d += `L${p[i].x.toFixed(3)} ${p[i].y.toFixed(3)}`;
    d += 'Z';
  }
  return d;
}

function boundsOf(rings: readonly CanvasPolygon[]) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rings) {
    for (const p of r.points) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  if (!Number.isFinite(minX)) return null;
  return { minX, minY, maxX, maxY };
}

interface DragState {
  id: string;
  pointerId: number;
  /** 按下时的世界坐标（mm，y 向上） */
  startX: number;
  startY: number;
  /** 按下时的 anchor，增量都相对它算 */
  baseX: number;
  baseY: number;
  /**
   * 拖动目标 anchor。几何是异步重算的（250ms 防抖 + 建模），轮廓会落后于手指，
   * 所以画面上额外补偿「目标 − 当前 anchor」的位移，等重算回来自然收敛为 0。
   */
  desiredX: number;
  desiredY: number;
}

const SNAP = 0.03;

export default function CanvasEditor(props: CanvasEditorProps) {
  const { sizeMm, paddingMm, layers, selectedId } = props;
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);

  const pad = paddingMm;
  const side = sizeMm + pad * 2;
  const half = sizeMm / 2;
  const factor = anchorToMmFactor(sizeMm);

  /** 屏幕坐标 → 世界坐标（mm，y 向上）。SVG 内层做了 y 翻转，所以这里再翻回来 */
  const toWorld = (clientX: number, clientY: number) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const p = pt.matrixTransform(ctm.inverse());
    return { x: p.x, y: -p.y };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const now = toWorld(e.clientX, e.clientY);
    let x = drag.baseX + (now.x - drag.startX) / factor;
    let y = drag.baseY + (now.y - drag.startY) / factor;
    // 吸附中线：离中心 3% 以内直接归零，手抖也能摆正
    if (Math.abs(x) < SNAP) x = 0;
    if (Math.abs(y) < SNAP) y = 0;
    x = Math.max(-1, Math.min(1, x));
    y = Math.max(-1, Math.min(1, y));
    setDrag({ ...drag, desiredX: x, desiredY: y });
    props.onAnchor(drag.id, x, y);
  };

  const endDrag = () => setDrag(null);

  const faceOutline =
    props.shape === 'circle' ? (
      <circle
        cx={0} cy={0} r={half}
        fill="none" stroke="#c9c2b6" strokeWidth={sizeMm * 0.006}
        strokeDasharray={`${sizeMm * 0.02} ${sizeMm * 0.015}`}
      />
    ) : props.shape === 'polygon' ? (
      (() => {
        const n = Math.max(3, Math.min(12, props.sides));
        const pts: string[] = [];
        for (let i = 0; i < n; i++) {
          const a = Math.PI / 2 + (i * 2 * Math.PI) / n;
          pts.push(`${(Math.cos(a) * half).toFixed(3)},${(Math.sin(a) * half).toFixed(3)}`);
        }
        return (
          <polygon
            points={pts.join(' ')}
            fill="none" stroke="#c9c2b6" strokeWidth={sizeMm * 0.006}
            strokeDasharray={`${sizeMm * 0.02} ${sizeMm * 0.015}`}
          />
        );
      })()
    ) : (
      <rect
        x={-half} y={-half} width={sizeMm} height={sizeMm}
        fill="none" stroke="#c9c2b6" strokeWidth={sizeMm * 0.006}
        strokeDasharray={`${sizeMm * 0.02} ${sizeMm * 0.015}`}
      />
    );

  const selected = layers.find((l) => l.id === selectedId);
  const selBox = selected ? boundsOf(selected.rings) : null;

  return (
    <svg
      ref={svgRef}
      data-canvas-editor="1"
      viewBox={`${-side / 2} ${-side / 2} ${side} ${side}`}
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', touchAction: 'none' }}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <g transform="scale(1,-1)">
        {faceOutline}
        <line x1={-half} y1={0} x2={half} y2={0} stroke="#e2dbcd" strokeWidth={sizeMm * 0.003} />
        <line x1={0} y1={-half} x2={0} y2={half} stroke="#e2dbcd" strokeWidth={sizeMm * 0.003} />

        {layers.map((layer) => {
          const d = ringsToPath(layer.rings);
          if (d === '') return null;
          const active = layer.id === selectedId;
          // 拖动中的视觉补偿：轮廓落后于手指时不要「手感断掉」
          const lagX = drag && drag.id === layer.id ? (drag.desiredX - layer.anchor.x) * factor : 0;
          const lagY = drag && drag.id === layer.id ? (drag.desiredY - layer.anchor.y) * factor : 0;
          return (
            <g key={layer.id} transform={lagX || lagY ? `translate(${lagX.toFixed(3)} ${lagY.toFixed(3)})` : undefined}>
              {active && (
                <path d={d} fill="#b3261e" fillOpacity={0.14} pointerEvents="none" />
              )}
              {/* 热区：细笔画按真实宽度点不中，用一条宽透明描边把命中区撑开 */}
              <path
                d={d}
                fill="transparent"
                stroke="transparent"
                strokeWidth={sizeMm * 0.06}
                style={{ cursor: drag?.id === layer.id ? 'grabbing' : 'grab' }}
                onPointerDown={(e) => {
                  const p = toWorld(e.clientX, e.clientY);
                  props.onSelect(layer.id);
                  setDrag({
                    id: layer.id,
                    pointerId: e.pointerId,
                    startX: p.x,
                    startY: p.y,
                    baseX: layer.anchor.x,
                    baseY: layer.anchor.y,
                    desiredX: layer.anchor.x,
                    desiredY: layer.anchor.y,
                  });
                  // 指针捕获挂在 SVG 根部：拖动中元素随重算重建，挂在自己身上会丢
                  svgRef.current?.setPointerCapture?.(e.pointerId);
                }}
              />
            </g>
          );
        })}

        {selBox && (() => {
          const lagX = drag && drag.id === selected?.id ? (drag.desiredX - selected.anchor.x) * factor : 0;
          const lagY = drag && drag.id === selected?.id ? (drag.desiredY - selected.anchor.y) * factor : 0;
          return (
            <rect
              x={selBox.minX + lagX} y={selBox.minY + lagY}
              width={Math.max(0.4, selBox.maxX - selBox.minX)}
              height={Math.max(0.4, selBox.maxY - selBox.minY)}
              fill="none" stroke="#b3261e" strokeWidth={sizeMm * 0.005}
              strokeDasharray={`${sizeMm * 0.012} ${sizeMm * 0.01}`}
              pointerEvents="none"
            />
          );
        })()}
      </g>
    </svg>
  );
}
