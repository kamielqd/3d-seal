/**
 * 元素清单：章面上的每个可编辑单元（文字层 / 图像层）在列表里一行。
 *
 * - 文字直接在这张卡片上改（选中后在卡片里编辑，而不是去右侧属性区再找一个「文字」输入框）
 * - 排序用拖动，不用上下箭头：拖到哪一行前面就插到哪
 * - 顺序 = `spec.layers` 数组顺序，不是 z 序：元素最终按并集进布尔
 */

import { useRef, useState } from 'react';
import type { Layer } from '../core/spec.ts';

export interface ElementExtra {
  id: string;
  /** 图标字：圈 / ✦ 这类单字 */
  icon: string;
  label: string;
  active: boolean;
  onSelect: () => void;
  /** 不可删除的固定元素（外圈就是这样，删到无边框等价于「无」） */
  onDelete?: () => void;
  onDuplicate?: () => void;
}

export interface ElementListProps {
  layers: readonly Layer[];
  selectedId: string | null;
  /** 非图层类元素：外圈、中心图案 */
  extras?: readonly ElementExtra[];
  onSelect: (id: string) => void;
  onAddText: () => void;
  onAddImage: (file: File) => void;
  onDelete: (id: string) => void;
  onDuplicate: (id: string) => void;
  /** 把 id 移到 index 位置（拖动排序用） */
  onReorder: (id: string, index: number) => void;
  /** 文字层改字 */
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
  fontSize: 11,
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

export default function ElementList(props: ElementListProps) {
  const { layers, selectedId, extras = [] } = props;
  const textCount = layers.filter((l) => l.kind === 'text').length;
  const [dragId, setDragId] = useState<string | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  /** 同一次拖拽里 dragstart 与 drop 可能挤在同一帧，state 还没刷，用 ref 兜底 */
  const dragIdRef = useRef<string | null>(null);

  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
        <span style={{ fontSize: 12, fontWeight: 600 }}>元素（{layers.length + extras.length}）</span>
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
            <span
              style={{ ...iconStyle, color: active ? '#b3261e' : '#7a746b' }}
              title="拖动排序"
            >
              {l.kind === 'text' ? '文' : '图'}
            </span>

            {l.kind === 'text' ? (
              <input
                value={l.text}
                onClick={(e) => e.stopPropagation()}
                onFocus={() => props.onSelect(l.id)}
                onChange={(e) => props.onRename(l.id, e.target.value)}
                placeholder="输入文字"
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
                图像 {i + 1}
              </span>
            )}

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

      {extras.map((ex) => (
        <div
          key={ex.id}
          onClick={ex.onSelect}
          style={{
            ...rowStyle,
            borderColor: ex.active ? '#b3261e' : '#eee7dc',
            background: ex.active ? '#fdf6f5' : '#fff',
            cursor: 'pointer',
          }}
        >
          <span style={{ ...iconStyle, color: ex.active ? '#b3261e' : '#7a746b', cursor: 'pointer' }}>{ex.icon}</span>
          <span
            style={{
              flex: 1,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              color: ex.active ? '#b3261e' : '#3d3a34',
            }}
          >
            {ex.label}
          </span>
          {ex.onDelete && (
            <button
              onClick={(e) => { e.stopPropagation(); ex.onDelete?.(); }}
              style={opBtnStyle}
              title="关掉这个元素"
            >
              ✕
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
