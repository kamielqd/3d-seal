/**
 * 元素清单：章面上的每个可编辑单元（文字层 / 图像层）在列表里一行。
 *
 * 设计对齐常见印章编辑器（元素叠加、可选中、可调顺序），
 * 但保留本职：只做「选中与排序」，不在这里改元素参数——参数在选中后的属性面板里。
 *
 * 顺序 = `spec.layers` 数组顺序，**不是** z 序：所有元素最终按并集进布尔，
 * 前后只影响列表里谁在上、以及同深度重叠检测的先后，不影响盖印结果。
 */

import type { Layer } from '../core/spec.ts';

export interface ElementListProps {
  layers: readonly Layer[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAddText: () => void;
  onAddImage: (file: File) => void;
  onDelete: (id: string) => void;
  onDuplicate: (id: string) => void;
  /** dir = -1 上移，+1 下移 */
  onMove: (id: string, dir: -1 | 1) => void;
}

function layerName(layer: Layer, index: number): string {
  if (layer.kind === 'text') {
    const t = layer.text.trim();
    if (t.length === 0) return `文字 ${index + 1}（空）`;
    return t.length > 10 ? `${t.slice(0, 10)}…` : t;
  }
  return `图像 ${index + 1}`;
}

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '5px 6px',
  borderRadius: 5,
  border: '1px solid #eee7dc',
  background: '#fff',
  marginBottom: 4,
  cursor: 'pointer',
  fontSize: 12,
};

const iconStyle: React.CSSProperties = {
  flex: '0 0 auto',
  width: 20,
  height: 20,
  borderRadius: 4,
  background: '#f3efe7',
  color: '#7a746b',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 11,
  fontWeight: 600,
};

const opBtnStyle: React.CSSProperties = {
  flex: '0 0 auto',
  width: 20,
  height: 20,
  padding: 0,
  border: '1px solid #e6e2da',
  borderRadius: 4,
  background: '#fff',
  color: '#7a746b',
  fontSize: 11,
  lineHeight: 1,
  cursor: 'pointer',
};

export default function ElementList(props: ElementListProps) {
  const { layers, selectedId } = props;
  const textCount = layers.filter((l) => l.kind === 'text').length;

  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
        <span style={{ fontSize: 12, fontWeight: 600 }}>元素（{layers.length}）</span>
        <span style={{ display: 'flex', gap: 4 }}>
          <button
            onClick={props.onAddText}
            style={{ ...opBtnStyle, width: 'auto', padding: '0 6px', fontSize: 11 }}
            title="再加一层文字：可以和已有文字叠放、错开位置"
          >
            ＋文字
          </button>
          <label
            style={{ ...opBtnStyle, width: 'auto', padding: '0 6px', fontSize: 11, lineHeight: '18px' }}
            title="导入图像：自带描摹，不需要先转矢量"
          >
            ＋图片
            <input
              type="file"
              accept="image/*"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) props.onAddImage(f);
                e.target.value = '';
              }}
            />
          </label>
        </span>
      </div>

      {layers.length === 0 && (
        <div style={{ fontSize: 11, color: '#a39c91', lineHeight: 1.5 }}>还没有元素，先加一层文字或图片。</div>
      )}

      {layers.map((l, i) => {
        const active = l.id === selectedId;
        return (
          <div
            key={l.id}
            onClick={() => props.onSelect(l.id)}
            style={{
              ...rowStyle,
              borderColor: active ? '#b3261e' : '#eee7dc',
              background: active ? '#fdf6f5' : '#fff',
            }}
          >
            <span style={{ ...iconStyle, color: active ? '#b3261e' : '#7a746b' }}>
              {l.kind === 'text' ? '文' : '图'}
            </span>
            <span style={{ flex: '0 0 auto', fontSize: 10, color: '#a39c91' }}>{i + 1}</span>
            <span
              style={{
                flex: 1,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                color: active ? '#b3261e' : '#3d3a34',
              }}
            >
              {layerName(l, i)}
            </span>
            <button
              onClick={(e) => { e.stopPropagation(); props.onMove(l.id, -1); }}
              disabled={i === 0}
              style={{ ...opBtnStyle, opacity: i === 0 ? 0.35 : 1 }}
              title="上移一层"
            >
              ↑
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); props.onMove(l.id, 1); }}
              disabled={i === layers.length - 1}
              style={{ ...opBtnStyle, opacity: i === layers.length - 1 ? 0.35 : 1 }}
              title="下移一层"
            >
              ↓
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); props.onDuplicate(l.id); }}
              style={opBtnStyle}
              title="复制这一层"
            >
              ⧉
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); props.onDelete(l.id); }}
              disabled={l.kind === 'text' && textCount <= 1}
              style={{ ...opBtnStyle, opacity: l.kind === 'text' && textCount <= 1 ? 0.35 : 1 }}
              title={l.kind === 'text' && textCount <= 1 ? '至少保留一层文字' : '删除这一层'}
            >
              ✕
            </button>
          </div>
        );
      })}
    </div>
  );
}
