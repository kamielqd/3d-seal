import { useEffect, useMemo, useRef, useState } from 'react';
import Viewer, { type ViewerMesh } from './render/Viewer.tsx';
import {
  BODY_STYLES,
  createDefaultSpec,
  createImageElement,
  createPlainText,
  createRingText,
  createRingBorder,
  cloneLayer,
  serializeSpec,
  deserializeSpec,
  isTextElement,
  type BodyShape,
  type BodyStyleId,
  type ImageElement,
  type HandleKind,
  type Layer,
  type SealSpec,
} from './core/spec.ts';
import { layoutFlatWithFit } from './core/layout-bridge.ts';
import { fromLayoutPolygons } from './core/polygon-bridge.ts';
import { toStlBlob } from './export/stl.ts';
import { to3mfBlob } from './export/threemf.ts';
import { listFonts, DEFAULT_FONT_ID } from './layout/fonts.ts';
import { checkMissing } from './layout/missing.ts';
import { renderPreviewToDataURL } from './render/preview2d.ts';
import About from './ui/About.tsx';
import ElementList from './ui/ElementList.tsx';
import CanvasEditor from './ui/CanvasEditor.tsx';
import { BODY_THUMBS } from './ui/body-thumbs.ts';
import type { BuildResponse, ImagePayload } from './worker/geometry.worker.ts';
import type { SolidMesh } from './geometry/types.ts';
import type { Violation } from './geometry/printability.ts';
import type { BuildStats } from './geometry/pipeline.ts';

/** 把手候选：无把手 + 4 个内置模型。'plate' 不再出现在 UI，只作旧链接兼容 */
const HANDLE_OPTIONS: ReadonlyArray<{ id: HandleKind; name: string; note: string }> = [
  { id: 'none', name: '无把手', note: '只出 4mm 刻印片，不接把手' },
  ...BODY_STYLES.filter((s) => s.id !== 'plate').map((s) => ({
    id: s.id as HandleKind,
    name: s.name,
    note: s.note,
  })),
];

export default function App() {
  const [spec, setSpec] = useState<SealSpec>(() => specFromHash() ?? createDefaultSpec());
  const [mesh, setMesh] = useState<ViewerMesh | null>(null);
  const [error, setError] = useState<string>('');
  const [notice, setNotice] = useState<string>('');
  const [building, setBuilding] = useState(false);
  const [elapsed, setElapsed] = useState<number>(0);
  const [stage, setStage] = useState<string>('');
  const [previewUrl, setPreviewUrl] = useState<string>('');
  const [violations, setViolations] = useState<Violation[]>([]);
  /** 本次构建的实际尺寸：章面足迹 / 总高 / 形状（被总高上限压过时和设定值不同） */
  const [stats, setStats] = useState<BuildStats | null>(null);
  /** 每个文字图层的实际字号（自动适应章面后可能小于设定值） */
  /** 右栏：元素属性 / 章体设置 */
  const [inspectorTab, setInspectorTab] = useState<'element' | 'body'>('element');
  /** 底部状态栏：展开打印校验明细 */
  const [issuesOpen, setIssuesOpen] = useState(false);
  /** 中间舞台：画布（编辑） / 3D 预览（看实体） */
  const [viewTab, setViewTab] = useState<'canvas' | '3d'>('canvas');
  /** 元素清单里选中的层；为空时退回第一层 */
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** 每个文字层的可读轮廓（叠在预览图上做拖拽与框选） */
  const [layerRings, setLayerRings] = useState<Record<string, { points: { x: number; y: number }[] }[]>>({});
  /** 图像图层 id → 像素；不进 state，避免每次拖参数都深拷贝几 MB */
  const imagesRef = useRef<Map<string, ImageData>>(new Map());
  const [imageVersion, setImageVersion] = useState(0);
  const [showAbout, setShowAbout] = useState(false);
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 820px)').matches,
  );

  // 窄屏：侧栏挪到下方，否则 300px 侧栏会把 3D 视图挤没
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 820px)');
    const onChange = () => setNarrow(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const workerRef = useRef<Worker | null>(null);
  const workerErrRef = useRef<string>('');
  const seqRef = useRef(0);
  const pendingRef = useRef<Map<number, (r: BuildResponse) => void>>(new Map());

  useEffect(() => {
    const w = new Worker(new URL('./worker/geometry.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (ev: MessageEvent<BuildResponse | { type: 'ready' } | { type: 'stage'; stage: string }>) => {
      const data = ev.data as { type?: string; id?: number; stage?: string };
      if (data.type === 'ready') {
        setStage('worker 就绪');
        return;
      }
      if (data.type === 'stage') {
        setStage(data.stage ?? '');
        return;
      }
      const res = ev.data as BuildResponse;
      const cb = pendingRef.current.get(res.id);
      if (cb) {
        pendingRef.current.delete(res.id);
        cb(res);
      }
    };
    // Worker 加载期（例如 wasm 初始化）失败不会走到 onmessage，这里兜住
    w.onerror = (ev) => {
      const msg = `Worker 启动失败：${ev.message || '脚本加载错误'}`;
      workerErrRef.current = msg;
      setBuilding(false);
      setError(msg);
    };
    w.onmessageerror = () => {
      workerErrRef.current = 'Worker 消息反序列化失败';
      setBuilding(false);
      setError('Worker 消息反序列化失败');
    };
    workerRef.current = w;
    return () => {
      w.terminate();
      workerRef.current = null;
    };
  }, []);

  // 参数变化 → 排版 → 几何（防抖 250ms）
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      const worker = workerRef.current;
      if (!worker) return;
      setBuilding(true);
      setError('');
      const t0 = performance.now();
      try {
        const { polygons: flat } = await layoutFlatWithFit(spec);
        if (cancelled) return;
        // 盖印效果：版式输出的是**可读**轮廓，所以 mirror=false（翻一次就印反了）
        const paintInk = (rings: typeof flat) => {
          try {
            setPreviewUrl(
              renderPreviewToDataURL(rings, {
                sizeMm: spec.body.sizeMm,
                dpi: 600,
                mirror: false,
                paddingMm: 1.5,
                // 画布要看得清字形与凹槽，所以不要纸纹和飞白：那些只在「盖印效果」展示时好看
                paper: { enabled: false },
                ink: { flyWhite: 0, mottle: 0.06, edgeIrregularity: 0 },
                // 阴刻是「图案留白、其余上墨」，不传 faceRing 会把盖印效果整个画反
                engraved: spec.relief.mode === 'engraved',
                faceRing: faceRingOf(spec),
              }),
            );
          } catch {
            setPreviewUrl('');
          }
        };
        paintInk(flat);
        const polygons = fromLayoutPolygons(flat);
        // 按图层分组：worker 要把文字层之间的重叠也查出来（合并成一组就没有「两层」可言了）
        const byLayer = new Map<string, typeof flat>();
        for (const p of flat) {
          if (!p.layerId) continue;
          const list = byLayer.get(p.layerId);
          if (list) list.push(p);
          else byLayer.set(p.layerId, [p]);
        }
        const polygonsByLayer: Record<string, ReturnType<typeof fromLayoutPolygons>> = {};
        for (const [layerId, rings] of byLayer) polygonsByLayer[layerId] = fromLayoutPolygons(rings);
        // 画布编辑用：每层的可读轮廓（与盖印预览同向，不是镜像后的）
        const ringsByLayer: Record<string, { points: { x: number; y: number }[] }[]> = {};
        for (const [layerId, rings] of byLayer) {
          ringsByLayer[layerId] = rings.map((r) => ({ points: r.points }));
        }
        setLayerRings(ringsByLayer);
        const images: Record<string, ImagePayload> = {};
        for (const l of spec.layers) {
          if (l.kind !== 'image') continue;
          const img = imagesRef.current.get(l.id);
          if (img) images[l.id] = img;
        }
        if (polygons.length === 0 && Object.keys(images).length === 0) {
          setMesh(null);
          setError('还没有任何元素：用左边的「＋ 文字 / 环绕文字 / 边框 / 图片」加一个');
          setBuilding(false);
          return;
        }
        const id = ++seqRef.current;
        const res = await new Promise<BuildResponse>((resolve) => {
          pendingRef.current.set(id, resolve);
          worker.postMessage({
            id,
            spec: { body: spec.body, relief: spec.relief, print: spec.print, layers: spec.layers },
            polygons,
            polygonsByLayer,
            images,
            // 自动适应章面已停用：字号永远是用户设的值，没有「系统替你缩过」这回事
            autoFit: null,
          });
          // 兜底：几何引擎初始化失败时不会回消息，不能一直转圈
          setTimeout(() => {
            if (pendingRef.current.has(id)) {
              pendingRef.current.delete(id);
              resolve({ id, ok: false, error: workerErrRef.current || '几何生成超时（manifold wasm 可能未正确加载）' });
            }
          }, 15000);
        });
        if (cancelled) return;
        if (res.ok && res.mesh) {
          setMesh(res.mesh);
          setViolations(res.mesh.violations ?? []);
          setStats(res.stats ?? null);
          setElapsed(performance.now() - t0);
          // 图像描摹结果只有 worker 有，盖印效果要在建模回来后补画一遍
          if (res.previewRings && res.previewRings.length > 0) {
            paintInk(res.previewRings);
          }
        } else {
          setMesh(null);
          setViolations([]);
          setError(res.error ?? '几何生成失败');
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setBuilding(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [spec, imageVersion]);

  /** 选中的元素；被删掉时退回第一个 */
  const selectedLayer: Layer | undefined =
    spec.layers.find((l) => l.id === selectedId) ?? spec.layers[0];
  const textLayer = selectedLayer && isTextElement(selectedLayer) ? selectedLayer : undefined;
  const selectedImage = selectedLayer && selectedLayer.kind === 'image' ? selectedLayer : undefined;
  const selectedBorder = selectedLayer && selectedLayer.kind === 'border' ? selectedLayer : undefined;
  const editedId = selectedLayer?.id ?? null;
  const fontId = textLayer ? textLayer.fontId : DEFAULT_FONT_ID;
  const fontText = textLayer ? textLayer.text : '';
  const missing = useMemo(() => checkMissing(fontText, fontId), [fontText, fontId]);
  const printIssues = violations.filter((v) => v.severity !== 'info');
  const hints = violations.filter((v) => v.severity === 'info');
  const blocking = violations.some((v) => v.severity === 'error');
  /** 把手：'none' / 'plate' / 缺省都算无把手 */
  const handleId: HandleKind = (() => {
    const raw = spec.body.styleId;
    return raw && raw !== 'plate' ? raw : 'none';
  })();
  const handleDef = handleId === 'none' ? undefined : BODY_STYLES.find((s) => s.id === handleId);

  /** 画布线框：只有普通文字和图片能拖（环绕文字靠半径/角度定位，边框没有位置） */
  const canvasLayers = spec.layers
    .filter((l) => l.kind === 'text' || l.kind === 'image')
    .map((l) => ({
      id: l.id,
      kind: (l.kind === 'image' ? 'image' : 'text') as 'text' | 'image',
      rings: layerRings[l.id] ?? [],
      anchor: { x: (l.xPct - 50) / 50, y: (l.yPct - 50) / 50 },
    }));

  const patch = (fn: (s: SealSpec) => void) => {
    setSpec((prev) => {
      const next: SealSpec = structuredClone(prev);
      fn(next);
      return next;
    });
  };

  const updateImage = (id: string, fn: (l: ImageElement) => void) => {
    patch((s) => {
      const l = s.layers.find((x) => x.id === id);
      if (l && l.kind === 'image') fn(l);
    });
  };

  const pickImage = async (file: File | null) => {
    if (!file) return;
    setError('');
    try {
      const data = await decodeToImageData(file);
      const layer = createImageElement(URL.createObjectURL(file));
      imagesRef.current.set(layer.id, data);
      patch((s) => { s.layers.push(layer); });
      setSelectedId(layer.id);
      setImageVersion((v) => v + 1);
    } catch (e) {
      setError('图像读取失败：' + (e instanceof Error ? e.message : String(e)));
    }
  };

  const addPlainText = () => {
    const el = createPlainText();
    patch((s) => { s.layers.push(el); });
    setSelectedId(el.id);
  };

  const addRingText = () => {
    const el = createRingText();
    patch((s) => { s.layers.push(el); });
    setSelectedId(el.id);
  };

  const addBorder = () => {
    const el = createRingBorder();
    patch((s) => { s.layers.push(el); });
    setSelectedId(el.id);
  };

  const duplicateLayer = (id: string) => {
    const src = spec.layers.find((l) => l.id === id);
    if (!src) return;
    const copy = cloneLayer(src);
    // 位置类元素错开一点，避免完全重叠看不出是两份
    if ('xPct' in copy) {
      copy.xPct = Math.min(100, copy.xPct + 6);
      copy.yPct = Math.min(100, copy.yPct + 6);
    }
    if (src.kind === 'image') {
      const px = imagesRef.current.get(src.id);
      if (px) imagesRef.current.set(copy.id, px);
    }
    patch((s) => {
      const i = s.layers.findIndex((l) => l.id === id);
      s.layers.splice(i + 1, 0, copy);
    });
    setSelectedId(copy.id);
    if (src.kind === 'image') setImageVersion((v) => v + 1);
  };

  const deleteLayer = (id: string) => {
    const target = spec.layers.find((l) => l.id === id);
    if (!target) return;
    if (target.kind === 'image') imagesRef.current.delete(id);
    const rest = spec.layers.filter((l) => l.id !== id);
    patch((s) => { s.layers = s.layers.filter((l) => l.id !== id); });
    if (selectedId === id) setSelectedId(rest[0]?.id ?? null);
    if (target.kind === 'image') setImageVersion((v) => v + 1);
  };

  /** 卡片上直接改字（普通文字与环绕文字都支持） */
  const renameLayer = (id: string, text: string) => {
    patch((s) => {
      const l = s.layers.find((x) => x.id === id);
      if (l && isTextElement(l)) l.text = text;
    });
  };

  const reorderLayer = (id: string, index: number) => {
    patch((s) => {
      const from = s.layers.findIndex((l) => l.id === id);
      if (from < 0) return;
      const [row] = s.layers.splice(from, 1);
      const to = Math.max(0, Math.min(s.layers.length, index));
      s.layers.splice(to, 0, row);
    });
  };

  const updateLayer = (id: string, fn: (l: Layer) => void) => {
    patch((s) => {
      const l = s.layers.find((x) => x.id === id);
      if (l) fn(l);
    });
  };

  const share = async () => {
    const bytes = new TextEncoder().encode(serializeSpec(spec));
    const url = `${location.origin}${location.pathname}#s=${bytesToBase64(bytes)}`;
    history.replaceState(null, '', url);
    try {
      await navigator.clipboard.writeText(url);
      setNotice('分享链接已复制（参数不含图像像素，图片需重新导入）');
    } catch {
      setNotice('链接已写入地址栏，手动复制即可');
    }
    setTimeout(() => setNotice(''), 5000);
  };

  const download = (kind: 'stl' | '3mf') => {
    if (!mesh) return;
    const solid: SolidMesh = {
      vertProperties: mesh.vertProperties,
      triVerts: mesh.triVerts,
      numProp: mesh.numProp,
      triangleCount: mesh.triangleCount,
      status: mesh.status,
    };
    const blob = kind === 'stl' ? toStlBlob(solid) : to3mfBlob(solid);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `seal-${spec.body.sizeMm}mm.${kind}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const status = useMemo(() => {
    if (!mesh) return building ? `生成中… ${stage}` : stage || '无模型';
    return `${mesh.triangleCount} 三角面 · ${mesh.status} · ${elapsed.toFixed(0)}ms`;
  }, [mesh, building, elapsed, stage]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', fontFamily: 'system-ui, sans-serif', background: '#faf9f7', minHeight: 0, overflow: 'hidden' }}>
      <header
        style={{
          flex: '0 0 auto',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '8px 14px',
          background: '#fff',
          borderBottom: '1px solid #e6e2da',
        }}
      >
        <span style={{ fontSize: 14, fontWeight: 600 }}>印章工坊</span>
        <span style={{ fontSize: 11, color: '#a39c91' }}>3D 可打印印章生成器</span>
        <div style={{ display: 'flex', gap: 4, marginLeft: 10 }}>
          {([['circle', '圆章'], ['square', '方章']] as const).map(([shape, label]) => (
            <button
              key={shape}
              onClick={() => patch((s) => { s.body.shape = shape as BodyShape; })}
              style={{
                ...miniBtnStyle,
                padding: '5px 14px',
                fontSize: 12,
                ...(spec.body.shape === shape
                  ? { borderColor: '#b3261e', color: '#b3261e', background: '#fdf3f2' }
                  : {}),
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 11, color: '#7a746b' }}>
            {spec.body.sizeMm}mm · {stats ? `总高 ${stats.heightMm.toFixed(1)}mm` : '—'}
          </span>
          <button
            onClick={() => download('stl')}
            disabled={!mesh || blocking}
            style={{
              padding: '6px 12px',
              borderRadius: 6,
              border: '1px solid #b3261e',
              background: blocking ? '#c9c2b6' : '#b3261e',
              color: '#fff',
              fontSize: 12.5,
              cursor: blocking ? 'not-allowed' : 'pointer',
            }}
          >
            导出 STL
          </button>
        </div>
      </header>

      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: 'grid',
          gridTemplateColumns: narrow ? '1fr' : '260px minmax(0, 1fr) 320px',
          gridTemplateRows: narrow ? 'minmax(0, 1fr) auto auto' : 'minmax(0, 1fr)',
        }}
      >
      <aside
        style={{
          gridColumn: narrow ? '1' : '3',
          gridRow: narrow ? '3' : '1',
          minHeight: 0,
          boxSizing: 'border-box',
          padding: 16,
          overflowY: 'auto',
          overflowX: 'hidden',
          background: '#fff',
          borderLeft: narrow ? 'none' : '1px solid #e6e2da',
          borderTop: narrow ? '1px solid #e6e2da' : 'none',
        }}
      >
        <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
          {([['element', '排版'], ['body', '章体设置']] as const).map(([tab, label]) => (
            <button
              key={tab}
              onClick={() => setInspectorTab(tab)}
              style={{
                flex: 1,
                padding: '6px 0',
                fontSize: 12,
                cursor: 'pointer',
                borderRadius: 6,
                border: `1px solid ${inspectorTab === tab ? '#b3261e' : '#e6e2da'}`,
                background: inspectorTab === tab ? '#fdf3f2' : '#fff',
                color: inspectorTab === tab ? '#b3261e' : '#7a746b',
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {inspectorTab === 'body' && (
          <>
        <Field label="把手">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, minmax(0, 1fr))', gap: 6 }}>
            {HANDLE_OPTIONS.map((st) => (
              <button
                key={st.id}
                title={st.note}
                onClick={() =>
                  patch((s) => {
                    s.body.styleId = st.id;
                    // 有把手时阳刻贴床会整片悬空、翻面又会让把手穿床，所以选把手就回到阴刻
                    if (st.id !== 'none') s.relief.mode = 'engraved';
                  })
                }
                style={{ ...bodyTileStyle(handleId === st.id), width: 'auto' }}
              >
                {st.id === 'none' ? (
                  <span
                    style={{
                      display: 'block',
                      width: 30,
                      height: 30,
                      lineHeight: '30px',
                      textAlign: 'center',
                      fontSize: 18,
                      color: handleId === st.id ? '#b3261e' : '#7a746b',
                    }}
                  >
                    ◻
                  </span>
                ) : (
                  <span
                    style={{
                      display: 'block',
                      width: 30,
                      height: 30,
                      color: handleId === st.id ? '#b3261e' : '#7a746b',
                    }}
                    // SVG 由 temp/gen-thumbs.mjs 生成，内容只有 path
                    dangerouslySetInnerHTML={{ __html: BODY_THUMBS[st.id as BodyStyleId] }}
                  />
                )}
                <span style={{ fontSize: 10 }}>{st.name}</span>
              </button>
            ))}
          </div>
          <div style={{ fontSize: 10.5, color: '#a39c91', marginTop: 4, lineHeight: 1.4 }}>
            刻印片固定 4mm 厚、形状由顶部圆章/方章决定；把手贴在刻印片背面。选「无把手」就只出刻印片。
          </div>
        </Field>

        {handleId !== 'none' && (
          <div style={{ ...warnStyle, borderColor: '#e6ded0', background: '#faf7f1' }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>把手：{handleDef?.name}</div>
            <div style={{ lineHeight: 1.5, opacity: 0.85 }}>
              刻印片 {spec.body.sizeMm}mm · 厚 {spec.body.baseThicknessMm}mm
              {stats ? `，总高 ${stats.heightMm.toFixed(1)}mm` : ''}
              {stats?.handleHeightMm
                ? `（把手 ${stats.handleFaceMm?.toFixed(1)}mm 宽 / ${stats.handleHeightMm.toFixed(1)}mm 高）`
                : ''}
            </div>
            <div style={{ lineHeight: 1.5, marginTop: 2, opacity: 0.7 }}>
              把手宽度按刻印片的 0.6 倍缩放，任何形状都不会伸出片外。
            </div>
          </div>
        )}

          </>
        )}

        {inspectorTab === 'element' && (
          <>
            {!selectedLayer && (
              <div style={{ fontSize: 11.5, color: '#a39c91', lineHeight: 1.7 }}>
                还没有选中元素。<br />
                用左边的「＋ 文字 / 环绕文字 / 边框 / 图片」加一个，选中后这里出它的设置。
              </div>
            )}

            {textLayer && (
              <>
                <Field label="文字属性">
                  <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                    <select
                      value={fontId}
                      onChange={(e) =>
                        patch((s) => {
                          const l = s.layers.find((x) => x.id === editedId);
                          if (l && isTextElement(l)) l.fontId = e.target.value;
                        })
                      }
                      style={{ ...inputStyle, flex: 1, minWidth: 0, padding: '4px 6px', fontSize: 12 }}
                    >
                      {listFonts().map((f) => (
                        <option key={f.id} value={f.id}>{f.name}</option>
                      ))}
                    </select>
                    <select
                      value={String(textLayer.fontSizeMm)}
                      onChange={(e) =>
                        patch((s) => {
                          const l = s.layers.find((x) => x.id === editedId);
                          if (l && isTextElement(l)) l.fontSizeMm = Number(e.target.value);
                        })
                      }
                      style={{ width: 62, padding: '4px 2px', fontSize: 12, border: '1px solid #ddd7cc', borderRadius: 6, background: '#fff' }}
                    >
                      {[3, 3.5, 4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5, 8, 9, 10, 11, 12, 14].map((v) => (
                        <option key={v} value={v}>{v}</option>
                      ))}
                    </select>
                    <button
                      title="加粗"
                      onClick={() =>
                        patch((s) => {
                          const l = s.layers.find((x) => x.id === editedId);
                          if (l && isTextElement(l)) l.bold = l.bold !== true;
                        })
                      }
                      style={{
                        width: 30, height: 28, borderRadius: 6, cursor: 'pointer',
                        border: `1px solid ${textLayer.bold === true ? '#b3261e' : '#ddd7cc'}`,
                        background: textLayer.bold === true ? '#fdf3f2' : '#fff',
                        color: textLayer.bold === true ? '#b3261e' : '#3d3a34',
                        fontWeight: 700, fontSize: 13,
                      }}
                    >
                      B
                    </button>
                    <button
                      title="斜体"
                      onClick={() =>
                        patch((s) => {
                          const l = s.layers.find((x) => x.id === editedId);
                          if (l && isTextElement(l)) l.italic = l.italic !== true;
                        })
                      }
                      style={{
                        width: 30, height: 28, borderRadius: 6, cursor: 'pointer',
                        border: `1px solid ${textLayer.italic === true ? '#b3261e' : '#ddd7cc'}`,
                        background: textLayer.italic === true ? '#fdf3f2' : '#fff',
                        color: textLayer.italic === true ? '#b3261e' : '#3d3a34',
                        fontStyle: 'italic', fontSize: 14, fontFamily: 'Georgia, serif',
                      }}
                    >
                      I
                    </button>
                  </div>
                </Field>

                {missing.missing.length > 0 && (
                  <div style={warnStyle}>
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>
                      {fontId === 'shuowen' ? '说文未收' : '该字体缺'}：{missing.missing.join(' ')}
                    </div>
                  </div>
                )}

                {textLayer.kind === 'text' ? (
                  <>
                    {slider(`水平位置 ${textLayer.xPct}`, textLayer.xPct, 0, 100, 1, (v) =>
                      updateLayer(textLayer.id, (l) => { if (l.kind === 'text') l.xPct = v; }))}
                    {slider(`垂直位置 ${textLayer.yPct}`, textLayer.yPct, 0, 100, 1, (v) =>
                      updateLayer(textLayer.id, (l) => { if (l.kind === 'text') l.yPct = v; }))}
                    {slider(`中心旋转 ${textLayer.rotationDeg}°`, textLayer.rotationDeg, 0, 360, 1, (v) =>
                      updateLayer(textLayer.id, (l) => { if (l.kind === 'text') l.rotationDeg = v; }))}
                    <div style={{ fontSize: 10.5, color: '#a39c91', lineHeight: 1.5 }}>
                      0 = 最左/最下，100 = 最右/最上（按章面直径等分）。
                    </div>
                  </>
                ) : (
                  <>
                    {slider(`环绕半径 ${textLayer.radiusPct}`, textLayer.radiusPct, 0, 100, 1, (v) =>
                      updateLayer(textLayer.id, (l) => { if (l.kind === 'ringText') l.radiusPct = v; }))}
                    {slider(`文字间距 ${textLayer.spacingPct}`, textLayer.spacingPct, 0, 100, 1, (v) =>
                      updateLayer(textLayer.id, (l) => { if (l.kind === 'ringText') l.spacingPct = v; }))}
                    {slider(`起点角度 ${textLayer.startDeg}°`, textLayer.startDeg, 0, 360, 1, (v) =>
                      updateLayer(textLayer.id, (l) => { if (l.kind === 'ringText') l.startDeg = v; }))}
                    <div style={{ fontSize: 10.5, color: '#a39c91', lineHeight: 1.5 }}>
                      半径 100 = 字压在大圆边界上；间距 0 = 全部叠在起点，100 = 首尾相接。
                    </div>
                  </>
                )}
              </>
            )}

            {selectedBorder && (
              <>
                {slider(`半径 ${selectedBorder.radiusPct}`, selectedBorder.radiusPct, 0, 100, 1, (v) =>
                  updateLayer(selectedBorder.id, (l) => { if (l.kind === 'border') l.radiusPct = v; }))}
                {slider(`宽度 ${selectedBorder.widthPct}`, selectedBorder.widthPct, 0, 100, 1, (v) =>
                  updateLayer(selectedBorder.id, (l) => { if (l.kind === 'border') l.widthPct = v; }))}
                {slider(`虚线 ${selectedBorder.dashPct}`, selectedBorder.dashPct, 0, 100, 1, (v) =>
                  updateLayer(selectedBorder.id, (l) => { if (l.kind === 'border') l.dashPct = v; }))}
                <div style={{ fontSize: 10.5, color: '#a39c91', lineHeight: 1.5 }}>
                  半径 100 = 环的外边缘贴住大圆；宽度 100 = 占满整个圆（最小 0.6mm）；虚线 100 = 线 0.6mm、隔 0.6mm。
                </div>
              </>
            )}

            {selectedImage && (
              <>
                {selectedImage.src && (
                  <img
                    src={selectedImage.src}
                    alt="图像元素"
                    style={{ width: '100%', borderRadius: 4, border: '1px solid #eee7dc', marginBottom: 8 }}
                  />
                )}
                {slider(`大小 ${selectedImage.sizePct}`, selectedImage.sizePct, 0, 100, 1, (v) =>
                  updateImage(selectedImage.id, (x) => { x.sizePct = v; }))}
                {slider(`水平位置 ${selectedImage.xPct}`, selectedImage.xPct, 0, 100, 1, (v) =>
                  updateImage(selectedImage.id, (x) => { x.xPct = v; }))}
                {slider(`垂直位置 ${selectedImage.yPct}`, selectedImage.yPct, 0, 100, 1, (v) =>
                  updateImage(selectedImage.id, (x) => { x.yPct = v; }))}
                {slider(`中心旋转 ${selectedImage.rotationDeg}°`, selectedImage.rotationDeg, 0, 360, 1, (v) =>
                  updateImage(selectedImage.id, (x) => { x.rotationDeg = v; }))}
                <Field label="描摹方式">
                  <select
                    value={selectedImage.trace.mode ?? 'silhouette'}
                    onChange={(e) => updateImage(selectedImage.id, (x) => { x.trace.mode = e.target.value as 'silhouette' | 'outline'; })}
                    style={inputStyle}
                  >
                    <option value="silhouette">实心块</option>
                    <option value="outline">线框（等宽环）</option>
                  </select>
                </Field>
              </>
            )}
          </>
        )}
      </aside>

      <aside
        style={{
          gridColumn: '1',
          gridRow: narrow ? '2' : '1',
          minHeight: 0,
          boxSizing: 'border-box',
          padding: 14,
          overflowY: 'auto',
          background: '#fff',
          borderRight: narrow ? 'none' : '1px solid #e6e2da',
          borderTop: narrow ? '1px solid #e6e2da' : 'none',
        }}
      >
        <ElementList
          layers={spec.layers}
          selectedId={selectedLayer?.id ?? null}
          onSelect={setSelectedId}
          onAddText={addPlainText}
          onAddRingText={addRingText}
          onAddBorder={addBorder}
          onAddImage={(f) => { void pickImage(f); }}
          onDelete={deleteLayer}
          onDuplicate={duplicateLayer}
          onReorder={reorderLayer}
          onRename={renameLayer}
        />
      </aside>

      <main style={{ gridColumn: narrow ? '1' : '2', gridRow: '1', display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, background: '#faf9f7' }}>
        <div style={{ display: 'flex', gap: 6, padding: '10px 16px 0', alignItems: 'flex-end' }}>
          {(['canvas', '3d'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setViewTab(tab)}
              style={{
                fontSize: 12,
                padding: '5px 12px',
                cursor: 'pointer',
                borderRadius: '6px 6px 0 0',
                border: `1px solid ${viewTab === tab ? '#e6e2da' : 'transparent'}`,
                borderBottomColor: viewTab === tab ? '#faf9f7' : 'transparent',
                background: viewTab === tab ? '#faf9f7' : 'transparent',
                color: viewTab === tab ? '#3d3a34' : '#7a746b',
              }}
            >
              {tab === 'canvas' ? '画布' : '3D 预览'}
            </button>
          ))}
          <div style={{ marginLeft: 'auto', fontSize: 11, color: '#a39c91', paddingBottom: 3 }}>
            {viewTab === 'canvas' ? '按住元素拖动；虚线是章面轮廓，细十字是中线' : '模型视角（实体已镜像）'}
          </div>
        </div>

        {viewTab === 'canvas' ? (
          <div style={{ flex: 1, minHeight: 0, display: 'grid', placeItems: 'center', padding: 18, overflow: 'hidden' }}>
            {previewUrl ? (
              <div
                style={{
                  position: 'relative',
                  width: 'min(100%, 58vh)',
                  aspectRatio: '1 / 1',
                  borderRadius: 8,
                  border: '1px solid #eee7dc',
                  background: '#fff',
                  overflow: 'hidden',
                }}
              >
                <img src={previewUrl} alt="盖印效果预览" style={{ width: '100%', display: 'block' }} />
                <CanvasEditor
                  sizeMm={spec.body.sizeMm}
                  paddingMm={1.5}
                  shape={spec.body.shape}
                  sides={spec.body.sides}
                  layers={canvasLayers}
                  selectedId={selectedLayer?.id ?? null}
                  onSelect={setSelectedId}
                  onAnchor={(id, x, y) =>
                    updateLayer(id, (l) => {
                      if ('xPct' in l) {
                        l.xPct = Math.max(0, Math.min(100, 50 + x * 50));
                        l.yPct = Math.max(0, Math.min(100, 50 + y * 50));
                      }
                    })
                  }
                />
              </div>
            ) : (
              <div style={{ fontSize: 12, color: '#b0a99e' }}>—</div>
            )}
          </div>
        ) : (
          <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
            <Viewer
              mesh={mesh}
              orientation={spec.print.orientation ?? 'face-down'}
              minHeight={narrow ? 240 : 420}
              sizeMm={spec.body.sizeMm}
            />
            <div style={{ position: 'absolute', left: 12, bottom: 10, fontSize: 12, color: '#7a746b' }}>{status}</div>
          </div>
        )}
      </main>
      </div>

      {issuesOpen && (
        <div
          style={{
            flex: '0 0 auto',
            maxHeight: '30vh',
            overflowY: 'auto',
            borderTop: '1px solid #e6e2da',
            background: '#fffdf9',
            padding: '10px 14px',
          }}
        >
          {printIssues.length > 0 && (
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 12, color: '#7a746b', marginBottom: 4 }}>打印校验（{printIssues.length}）</div>
              {printIssues.map((v, i) => (
                <div key={`${v.rule}-${i}`} style={{ ...violationStyle, color: v.severity === 'error' ? '#b3261e' : '#8a5a00' }}>
                  <strong>{v.rule}</strong>　{v.message}
                </div>
              ))}
            </div>
          )}
          {hints.length > 0 && (
            <div>
              <div style={{ fontSize: 12, color: '#7a746b', marginBottom: 4 }}>提示（{hints.length}）· 不影响导出</div>
              {hints.map((v, i) => (
                <div key={`hint-${v.rule}-${i}`} style={{ ...violationStyle, color: '#7a746b' }}>
                  <strong>{v.rule}</strong>　{v.message}
                </div>
              ))}
            </div>
          )}
          {printIssues.length === 0 && hints.length === 0 && (
            <div style={{ fontSize: 12, color: '#2e7d32' }}>没有可打印性问题。</div>
          )}
        </div>
      )}

      <footer
        style={{
          flex: '0 0 auto',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '6px 12px',
          borderTop: '1px solid #e6e2da',
          background: '#fff',
          fontSize: 11.5,
          color: '#7a746b',
          minHeight: 38,
          boxSizing: 'border-box',
        }}
      >
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: error || blocking ? '#b3261e' : '#2e7d32',
            display: 'inline-block',
          }}
        />
        <span>
          {spec.body.sizeMm}mm · {status}
          {stats ? ` · 总高 ${stats.heightMm.toFixed(1)}mm` : ''}
        </span>
        <button
          onClick={() => setIssuesOpen((v) => !v)}
          style={{ ...miniBtnStyle, padding: '3px 8px', color: printIssues.length > 0 ? '#b3261e' : '#7a746b' }}
        >
          {printIssues.length + hints.length} 条提示 {issuesOpen ? '▾' : '▸'}
        </button>
        {notice && <span style={{ color: '#2e7d32' }}>{notice}</span>}
        {error && <span style={{ color: '#b3261e' }}>{error}</span>}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button style={miniBtnStyle} onClick={() => { void share(); }}>复制分享链接</button>
          <button style={miniBtnStyle} disabled={!mesh || blocking} onClick={() => download('3mf')}>导出 3MF</button>
          <button style={miniBtnStyle} onClick={() => setShowAbout(true)}>字体与授权</button>
        </div>
      </footer>

      {showAbout && <About onClose={() => setShowAbout(false)} />}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 12, color: '#7a746b', marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}

/** 0–100 / 0–360 的默认滑条：元素参数几乎都是这种「一条滑条 + 数值」的形状 */
function slider(
  label: string,
  value: number,
  min: number,
  max: number,
  step: number,
  onChange: (v: number) => void,
) {
  return (
    <Field label={label}>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ width: '100%' }}
      />
    </Field>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '6px 8px',
  border: '1px solid #ddd7cc',
  borderRadius: 6,
  background: '#fff',
  fontSize: 13,
};

const warnStyle: React.CSSProperties = {
  marginTop: 10,
  padding: '8px 10px',
  borderRadius: 6,
  border: '1px solid #e8c9a0',
  background: '#fdf6ec',
  color: '#8a5a00',
  fontSize: 12,
};

const violationStyle: React.CSSProperties = {
  fontSize: 12,
  lineHeight: 1.5,
  marginBottom: 4,
};

/** 主体样式小方块：选中用朱红描边 + 浅底 */
const bodyTileStyle = (active: boolean): React.CSSProperties => ({
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 2,
  width: 56,
  height: 56,
  padding: 2,
  borderRadius: 8,
  border: `1px solid ${active ? '#b3261e' : '#e6e2da'}`,
  background: active ? '#fdf3f2' : '#fff',
  color: active ? '#b3261e' : '#5f5a52',
  cursor: 'pointer',
  lineHeight: 1,
});


const miniBtnStyle: React.CSSProperties = {
  padding: '3px 8px',
  fontSize: 11,
  borderRadius: 5,
  border: '1px solid #e0d8c9',
  background: '#faf7f1',
  cursor: 'pointer',
};



/**
 * 图片 → ImageData，长边限制 720px。
 *
 * 为什么要缩：描摹的 mm/px 由「物理宽度 / 像素宽」推出来，4000px 的手机照片
 * 在 18mm 章面上是 0.0045mm/px，marching squares 会产出几十万点，
 * 直接把 worker 的布尔撑爆。720px 在 40mm 章面上仍有 ~0.055mm/px，比喷嘴细一倍。
 */
async function decodeToImageData(file: File, maxSide = 720): Promise<ImageData> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 2D 画布');
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  return ctx.getImageData(0, 0, w, h);
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

/** 从 `#s=<base64>` 还原 spec；分享链接里没有图像像素，图像图层只剩参数 */
function specFromHash(): SealSpec | null {
  const m = /#s=([^&]+)/.exec(location.hash);
  if (!m) return null;
  try {
    const raw = new TextDecoder().decode(
      Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0)),
    );
    return deserializeSpec(raw);
  } catch {
    return null;
  }
}

/** 章面轮廓环（阴刻盖印预览要拿它铺满墨底）；圆角忽略，误差在 0.1mm 内肉眼不可见 */
function faceRingOf(spec: SealSpec): { points: Array<{ x: number; y: number }> } {
  const half = spec.body.sizeMm / 2;
  const b = spec.body;
  if (b.shape === 'circle') {
    const n = 96;
    return {
      points: Array.from({ length: n }, (_, i) => {
        const a = (i / n) * Math.PI * 2;
        return { x: Math.cos(a) * half, y: Math.sin(a) * half };
      }),
    };
  }
  if (b.shape === 'polygon') {
    const n = Math.max(3, Math.min(12, Math.round(b.sides)));
    return {
      points: Array.from({ length: n }, (_, i) => {
        const a = (i / n) * Math.PI * 2 + Math.PI / 2;
        return { x: Math.cos(a) * half, y: Math.sin(a) * half };
      }),
    };
  }
  return {
    points: [
      { x: -half, y: -half },
      { x: half, y: -half },
      { x: half, y: half },
      { x: -half, y: half },
    ],
  };
}
