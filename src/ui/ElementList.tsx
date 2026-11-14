/**
 * 元素清单：四种元素（普通文字 / 环绕文字 / 边框 / 图片）各一行。
 *
 * - 文字类元素直接在卡片上改字
 * - 拖动排序，不用上下箭头
 * - 默认没有任何元素，全靠下面四个「＋」加
 */

import { useRef, useState } from 'react';
import type { Layer } from '../core/spec.ts';
import { isTextElement } from '../core/elements.ts';

export interface ElementListProps {
  layers: readonly Layer[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAddText: () => void;
  onAddRingText: () => void;
  onAddBorder: () => void;
  onAddImage: (file: File) => void;
  onDelete: (id: string) => void;
  onDuplicate: (id: string) => void;
  onReorder: (id: string, index: number) => void;
  onRename: (id: string, text: string) => void;
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
  fontSize: 10,
  fontWeight: 600,
  cursor: 'grab',
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

const KIND_ICON: Record<Layer['kind'], string> = {
  text: '文',
  ringText: '环',
  border: '圈',
  image: '图',
};

function layerLabel(layer: Layer, index: number): string {
  if (isTextElement(layer)) return layer.text.trim() === '' ? `（空）文字 ${index + 1}` : layer.text;
  if (layer.kind === 'border') return `边框 ${layer.widthPct}%`;
  return `图像 ${index + 1}`;
}

export default function ElementList(props: ElementListProps) {
  const { layers, selectedId } = props;
  const [dragId, setDragId] = useState<string | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const dragIdRef = useRef<string | null>(null);

  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
        <span style={{ fontSize: 12, fontWeight: 600 }}>元素（{layers.length}）</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, marginBottom: 8 }}>
        <button style={{ ...opBtnStyle, width: 'auto', height: 24 }} onClick={props.onAddText}>＋ 文字</button>
        <button style={{ ...opBtnStyle, width: 'auto', height: 24 }} onClick={props.onAddRingText}>＋ 环绕文字</button>
        <button style={{ ...opBtnStyle, width: 'auto', height: 24 }} onClick={props.onAddBorder}>＋ 边框</button>
        <label style={{ ...opBtnStyle, width: 'auto', height: 24, textAlign: 'center', lineHeight: '22px' }}>
          ＋ 图片
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
      </div>

      {layers.length === 0 && (
        <div style={{ fontSize: 11, color: '#a39c91', lineHeight: 1.5 }}>
          还没有元素。用上面的按钮加文字、环绕文字、边框或图片。
        </div>
      )}

      {layers.map((l, i) => {
        const active = l.id === selectedId;
        const dragging = dragId === l.id;
        return (
          <div
            key={l.id}
            draggable
            onDragStart={(e) => {
              setDragId(l.id);
              dragIdRef.current = l.id;
              e.dataTransfer.effectAllowed = 'move';
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setOverIndex(i);
            }}
            onDragEnd={() => {
              dragIdRef.current = null;
              setDragId(null);
              setOverIndex(null);
            }}
            onDrop={(e) => {
              e.preventDefault();
              const moved = dragIdRef.current;
              if (moved && moved !== l.id) props.onReorder(moved, i);
              dragIdRef.current = null;
              setDragId(null);
              setOverIndex(null);
            }}
            onClick={() => props.onSelect(l.id)}
            style={{
              ...rowStyle,
              borderColor: active ? '#b3261e' : overIndex === i && dragId ? '#b8860b' : '#eee7dc',
              background: active ? '#fdf6f5' : '#fff',
              opacity: dragging ? 0.45 : 1,
            }}
          >
            <span style={{ ...iconStyle, color: active ? '#b3261e' : '#7a746b' }} title="拖动排序">
              {KIND_ICON[l.kind]}
            </span>

            {isTextElement(l) ? (
              <input
                value={l.text}
                onClick={(e) => e.stopPropagation()}
                onFocus={() => props.onSelect(l.id)}
                onChange={(e) => props.onRename(l.id, e.target.value)}
                placeholder={l.kind === 'ringText' ? '环绕文字' : '输入文字'}
                style={{
                  flex: 1,
                  minWidth: 0,
                  border: 'none',
                  background: 'transparent',
                  padding: '1px 2px',
                  fontSize: 12,
                  color: active ? '#b3261e' : '#3d3a34',
                  outline: active ? '1px solid #e8c9c4' : 'none',
                  borderRadius: 3,
                }}
              />
            ) : (
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: active ? '#b3261e' : '#3d3a34' }}>
                {layerLabel(l, i)}
              </span>
            )}

            <button onClick={(e) => { e.stopPropagation(); props.onDuplicate(l.id); }} style={opBtnStyle} title="复制">⧉</button>
            <button onClick={(e) => { e.stopPropagation(); props.onDelete(l.id); }} style={opBtnStyle} title="删除">✕</button>
          </div>
        );
      })}
    </div>
  );
}
