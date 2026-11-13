import { useEffect, useMemo, useRef, useState } from 'react';
import Viewer, { type ViewerMesh } from './render/Viewer.tsx';
import {
  BODY_STYLES,
  createDefaultSpec,
  createImageLayer,
  serializeSpec,
  deserializeSpec,
  type BodyShape,
  type ImageLayer,
  type PrintOrientation,
  type SealSpec,
} from './core/spec.ts';
import { layoutFlatWithFit, type LayerFit } from './core/layout-bridge.ts';
import { fromLayoutPolygons } from './core/polygon-bridge.ts';
import { toStlBlob } from './export/stl.ts';
import { to3mfBlob } from './export/threemf.ts';
import { listFonts, DEFAULT_FONT_ID } from './layout/fonts.ts';
import { checkMissing } from './layout/missing.ts';
import { renderPreviewToDataURL } from './render/preview2d.ts';
import About from './ui/About.tsx';
import { BODY_THUMBS } from './ui/body-thumbs.ts';
import { PRESETS } from './core/presets.ts';
import type { BuildResponse, ImagePayload } from './worker/geometry.worker.ts';
import type { SolidMesh } from './geometry/types.ts';
import type { Violation } from './geometry/printability.ts';

export default function App() {
  const [spec, setSpec] = useState<SealSpec>(() => specFromHash() ?? createDefaultSpec());
  /** 当前套用的预设 id；任何手动改动都会清掉，避免「显示是预设、实际已被改过」 */
  const [activePreset, setActivePreset] = useState<string | undefined>();
  const [mesh, setMesh] = useState<ViewerMesh | null>(null);
  const [error, setError] = useState<string>('');
  const [notice, setNotice] = useState<string>('');
  const [building, setBuilding] = useState(false);
  const [elapsed, setElapsed] = useState<number>(0);
  const [stage, setStage] = useState<string>('');
  const [previewUrl, setPreviewUrl] = useState<string>('');
  const [violations, setViolations] = useState<Violation[]>([]);
  /** 每个文字图层的实际字号（自动适应章面后可能小于设定值） */
  const [fits, setFits] = useState<LayerFit[]>([]);
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
        const { polygons: flat, fits: layerFits } = await layoutFlatWithFit(spec);
        if (cancelled) return;
        setFits(layerFits);
        // 盖印效果：版式输出的是**可读**轮廓，所以 mirror=false（翻一次就印反了）
        const paintInk = (rings: typeof flat) => {
          try {
            setPreviewUrl(
              renderPreviewToDataURL(rings, {
                sizeMm: spec.body.sizeMm,
                dpi: 180,
                mirror: false,
                paddingMm: 1.5,
                paper: { enabled: true },
                ink: {},
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
        const images: Record<string, ImagePayload> = {};
        for (const l of spec.layers) {
          if (l.kind !== 'image') continue;
          const img = imagesRef.current.get(l.id);
          if (img) images[l.id] = img;
        }
        if (polygons.length === 0 && Object.keys(images).length === 0) {
          setMesh(null);
          setError('没有可生成的内容：先输入文字或导入图像');
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
            images,
            // 自动适应章面的结果：几何侧据此把文案从「建议放大字号」换成「系统替你缩过」
            autoFit: layerFits[0],
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

  const textLayer = spec.layers.find((l) => l.kind === 'text');
  const fontId = textLayer && textLayer.kind === 'text' ? textLayer.fontId : DEFAULT_FONT_ID;
  const fontText = textLayer && textLayer.kind === 'text' ? textLayer.text : '';
  const missing = useMemo(() => checkMissing(fontText, fontId), [fontText, fontId]);
  const printIssues = violations.filter((v) => v.severity !== 'info');
  /** 提示级：不影响出实体/导出，但用户该知道（如四字印必然出现的 0.17mm 窄缝） */
  const hints = violations.filter((v) => v.severity === 'info');
  /** 阻断级问题：不允许导出（例如阳刻+手柄的 809mm² 悬空面） */
  const blocking = violations.some((v) => v.severity === 'error');
  const imageLayers = spec.layers.filter((l): l is ImageLayer => l.kind === 'image');
  /** 选了外部主体样式：形制由模型自带，只保留章面尺寸与阴刻 */
  const libStyle = spec.body.styleId;
  const libStyleDef = libStyle ? BODY_STYLES.find((s) => s.id === libStyle) : undefined;
  /** 外部主体只按底面缩放，高度随模型比例走 */
  const libHeightMm = libStyleDef ? Math.round(spec.body.sizeMm * libStyleDef.heightRatio * 10) / 10 : null;

  const patch = (fn: (s: SealSpec) => void) => {
    setActivePreset(undefined);
    setSpec((prev) => {
      const next: SealSpec = structuredClone(prev);
      fn(next);
      return next;
    });
  };

  const updateImage = (id: string, fn: (l: ImageLayer) => void) => {
    patch((s) => {
      const l = s.layers.find((x) => x.kind === 'image' && x.id === id);
      if (l && l.kind === 'image') fn(l);
    });
  };

  const removeImage = (id: string) => {
    imagesRef.current.delete(id);
    patch((s) => { s.layers = s.layers.filter((x) => x.id !== id); });
    setImageVersion((v) => v + 1);
  };

  const pickImage = async (file: File | null) => {
    if (!file) return;
    setError('');
    try {
      const data = await decodeToImageData(file);
      const layer = createImageLayer(URL.createObjectURL(file));
      imagesRef.current.set(layer.id, data);
      patch((s) => { s.layers.push(layer); });
      setImageVersion((v) => v + 1);
    } catch (e) {
      setError(`图像读取失败：${e instanceof Error ? e.message : String(e)}`);
    }
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
    <div style={{ display: 'flex', flexDirection: narrow ? 'column-reverse' : 'row', height: '100vh', fontFamily: 'system-ui, sans-serif', background: '#faf9f7' }}>
      <aside
        style={{
          width: narrow ? '100%' : 300,
          flex: narrow ? '0 0 46vh' : '0 0 300px',
          minHeight: 0,
          boxSizing: 'border-box',
          padding: 16,
          overflowY: 'auto',
          borderRight: narrow ? 'none' : '1px solid #e6e2da',
          borderTop: narrow ? '1px solid #e6e2da' : 'none',
        }}
      >
        <h1 style={{ fontSize: 17, margin: '0 0 10px' }}>印章工坊</h1>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
          {PRESETS.map((p) => (
            <button
              key={p.id}
              title={p.note}
              onClick={() => {
                setSpec(p.build());
                setActivePreset(p.id);
              }}
              style={{
                ...miniBtnStyle,
                padding: '5px 9px',
                fontSize: 12,
                ...(activePreset === p.id
                  ? { borderColor: '#b3261e', color: '#b3261e', background: '#fdf3f2' }
                  : {}),
              }}
            >
              {p.name}
            </button>
          ))}
        </div>
        <div style={{ fontSize: 11, color: '#a39c91', marginBottom: 14, lineHeight: 1.5 }}>
          预设按 FDM 能直接打配：阴刻 + 盖印面贴床。阳刻只有「平装阳刻」那套不用支撑。
        </div>

        <Field label="主体样式">
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button
              title="方形 / 圆形 / 正多边形，形制可自由调"
              onClick={() => patch((s) => { delete s.body.styleId; })}
              style={bodyTileStyle(!libStyle)}
            >
              <span style={{ fontSize: 18, lineHeight: '30px', color: libStyle ? '#7a746b' : '#b3261e' }}>◻</span>
              <span style={{ fontSize: 10 }}>参数化</span>
            </button>
            {BODY_STYLES.map((st) => (
              <button
                key={st.id}
                title={st.note}
                onClick={() =>
                  patch((s) => {
                    s.body.styleId = st.id;
                    // 外部主体自带平面刻印面朝下，且只支持阴刻
                    s.relief.mode = 'engraved';
                    s.print.orientation = 'face-down';
                  })
                }
                style={bodyTileStyle(libStyle === st.id)}
              >
                <span
                  style={{
                    display: 'block',
                    width: 30,
                    height: 30,
                    color: libStyle === st.id ? '#b3261e' : '#7a746b',
                  }}
                  // SVG 由 temp/gen-thumbs.mjs 生成，内容可控（只有 path）
                  dangerouslySetInnerHTML={{ __html: BODY_THUMBS[st.id] }}
                />
                <span style={{ fontSize: 10 }}>{st.name}</span>
              </button>
            ))}
          </div>
        </Field>

        {libStyle && (
          <div style={{ ...warnStyle, borderColor: '#e6ded0', background: '#faf7f1' }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>
              用内置主体：{libStyleDef?.name}
            </div>
            <div style={{ lineHeight: 1.5, opacity: 0.85 }}>
              形制由模型自带，章型 / 边框 / 手柄不可调；章面尺寸决定整体等比缩放。平面朝下当刻印面，
              只能阴刻。
            </div>
            {libHeightMm !== null && (
              <div style={{ lineHeight: 1.5, marginTop: 2, opacity: 0.85 }}>
                {spec.body.sizeMm}mm 章面 → 总高约 <strong>{libHeightMm}mm</strong>
                {libHeightMm > 50 ? '（原模型是瘦高型，想矮一点就调小章面）' : ''}
              </div>
            )}
          </div>
        )}

        <Field label="章型">
          <select
            value={spec.body.shape}
            disabled={Boolean(libStyle)}
            onChange={(e) => patch((s) => { s.body.shape = e.target.value as BodyShape; })}
            style={{ ...inputStyle, opacity: libStyle ? 0.55 : 1 }}
          >
            <option value="square">方形</option>
            <option value="circle">圆形</option>
            <option value="polygon">正多边形</option>
          </select>
        </Field>

        {spec.body.shape === 'polygon' && (
          <Field label={`边数 ${spec.body.sides}`}>
            <input
              type="range" min={3} max={12} value={spec.body.sides}
              onChange={(e) => patch((s) => { s.body.sides = Number(e.target.value); })}
              style={{ width: '100%' }}
            />
          </Field>
        )}

        <Field label={`章面尺寸 ${spec.body.sizeMm}mm`}>
          <input
            type="range" min={20} max={100} step={1} value={spec.body.sizeMm}
            onChange={(e) => patch((s) => { s.body.sizeMm = Number(e.target.value); })}
            style={{ width: '100%' }}
          />
          <div style={{ fontSize: 10.5, color: '#a39c91', lineHeight: 1.4, marginTop: 2 }}>
            正方形＝边长，圆形＝直径，正多边形＝外接圆直径
          </div>
        </Field>

        <Field label="边框">
          <select
            value={spec.body.border.style}
            disabled={Boolean(libStyle)}
            onChange={(e) =>
              patch((s) => {
                const style = e.target.value as SealSpec['body']['border']['style'];
                s.body.border.style = style;
                // 每种形制的合理默认宽度；宽度是真值，style 不参与换算
                s.body.border.widthMm =
                  style === 'none' ? s.body.border.widthMm
                    : style === 'thin' ? 0.8
                    : style === 'thick' ? 1.6
                    : 1.2;
              })
            }
            style={{ ...inputStyle, opacity: libStyle ? 0.55 : 1 }}
          >
            <option value="none">无边框</option>
            <option value="thin">单线（细）</option>
            <option value="thick">单线（粗）</option>
            <option value="double">双线</option>
          </select>
        </Field>

        {spec.body.border.style !== 'none' && (
          <>
            <Field label={`边框宽度 ${spec.body.border.widthMm}mm`}>
              <input
                type="range" min={0.4} max={3} step={0.1} value={spec.body.border.widthMm}
                onChange={(e) => patch((s) => { s.body.border.widthMm = Number(e.target.value); })}
                style={{ width: '100%' }}
              />
            </Field>
            <Field label={`边框内缩 ${spec.body.border.insetMm}mm`}>
              <input
                type="range" min={0.3} max={5} step={0.1} value={spec.body.border.insetMm}
                onChange={(e) => patch((s) => { s.body.border.insetMm = Number(e.target.value); })}
                style={{ width: '100%' }}
              />
            </Field>
          </>
        )}

        <Field label="浮雕">
          <select
            value={spec.relief.mode}
            onChange={(e) => patch((s) => { s.relief.mode = e.target.value as 'raised' | 'engraved'; })}
            style={inputStyle}
          >
            <option value="raised" disabled={Boolean(libStyle)}>
              阳刻（凸）{libStyle ? ' — 外部主体不支持' : ''}
            </option>
            <option value="engraved">阴刻（凹）</option>
          </select>
        </Field>

        <Field label={`浮雕深度 ${spec.relief.depthMm}mm`}>
          <input
            type="range" min={0.4} max={2} step={0.1} value={spec.relief.depthMm}
            onChange={(e) => patch((s) => { s.relief.depthMm = Number(e.target.value); })}
            style={{ width: '100%' }}
          />
        </Field>

        <Field label="文字">
          <input
            value={textLayer && textLayer.kind === 'text' ? textLayer.text : ''}
            onChange={(e) =>
              patch((s) => {
                const l = s.layers.find((x) => x.kind === 'text');
                if (l && l.kind === 'text') l.text = e.target.value;
              })
            }
            style={inputStyle}
          />
        </Field>

        {missing.missing.length > 0 && (
          <div style={warnStyle}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>
              {fontId === 'shuowen' ? '说文未收' : '该字体缺'}：{missing.missing.join(' ')}
            </div>
            <div style={{ opacity: 0.85, lineHeight: 1.5 }}>
              {missing.missing
                .map((ch) =>
                  missing.suggestions[ch]?.length
                    ? `${ch}→${missing.suggestions[ch].join('/')}`
                    : `${ch}无可换字`,
                )
                .join('　')}
            </div>
            <div style={{ marginTop: 4, opacity: 0.7 }}>
              整章换字体或换词，不逐字混排（混排盖出来是废品）。
            </div>
          </div>
        )}

        <Field label="字体">
          <select
            value={fontId}
            onChange={(e) =>
              patch((s) => {
                const l = s.layers.find((x) => x.kind === 'text');
                if (l && l.kind === 'text') l.fontId = e.target.value;
              })
            }
            style={inputStyle}
          >
            {listFonts().map((f) => (
              <option key={f.id} value={f.id}>{f.name}</option>
            ))}
          </select>
        </Field>

        <Field label="排列">
          <select
            value={textLayer && textLayer.kind === 'text' ? textLayer.layout : 'horizontal'}
            onChange={(e) =>
              patch((s) => {
                const l = s.layers.find((x) => x.kind === 'text');
                if (l && l.kind === 'text') l.layout = e.target.value as typeof l.layout;
              })
            }
            style={inputStyle}
          >
            <option value="horizontal">横排</option>
            <option value="vertical">竖排</option>
            <option value="ring">环形</option>
            <option value="huiwen">回文（四字）</option>
          </select>
        </Field>

        <Field label={`字号 ${textLayer && textLayer.kind === 'text' ? textLayer.fontSizeMm : 7}mm`}>
          <input
            type="range" min={3} max={14} step={0.5}
            value={textLayer && textLayer.kind === 'text' ? textLayer.fontSizeMm : 7}
            onChange={(e) => patch((s) => {
              const l = s.layers.find((x) => x.kind === 'text');
              if (l && l.kind === 'text') l.fontSizeMm = Number(e.target.value);
            })}
            style={{ width: '100%' }}
          />
        </Field>

        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, marginBottom: 10, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={!(textLayer && textLayer.kind === 'text' && textLayer.autoFit === false)}
            onChange={(e) =>
              patch((s) => {
                const l = s.layers.find((x) => x.kind === 'text');
                if (l && l.kind === 'text') l.autoFit = e.target.checked;
              })
            }
          />
          自动适应章面（字多时等比缩小，塞不下的字不会探出章面）
        </label>

        {fits.some((f) => f.fitted) && (
          <div style={{ ...warnStyle, borderColor: '#e6ded0', background: '#faf7f1' }}>
            {fits
              .filter((f) => f.fitted)
              .map((f) => (
                <div key={f.layerId} style={{ lineHeight: 1.5 }}>
                  字号 {f.requestedFontMm}mm 排不下，已按章面缩到{' '}
                  <strong>{f.effectiveFontMm}mm</strong>。想要更大就减少字数、放大章面，或关掉自动适应自己调。
                </div>
              ))}
          </div>
        )}

        <Field label="图像（可选，图片不出本机）">
          <input
            type="file"
            accept="image/*"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              void pickImage(f);
              e.target.value = '';
            }}
            style={{ fontSize: 12, width: '100%' }}
          />
        </Field>

        {imageLayers.map((l) => (
          <div key={l.id} style={cardStyle}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <strong style={{ fontSize: 12 }}>图像图层</strong>
              <button onClick={() => removeImage(l.id)} style={miniBtnStyle}>移除</button>
            </div>
            {l.src ? (
              <img
                src={l.src}
                alt="图像图层"
                style={{ width: '100%', borderRadius: 4, border: '1px solid #eee7dc', marginBottom: 8 }}
              />
            ) : (
              <div style={hintStyle}>分享链接不含像素，请重新导入这张图</div>
            )}

            <Field label={`图案宽度 ${l.widthMm}mm`}>
              <input
                type="range" min={5} max={40} step={1} value={l.widthMm}
                onChange={(e) => updateImage(l.id, (x) => { x.widthMm = Number(e.target.value); })}
                style={{ width: '100%' }}
              />
            </Field>

            <Field label={`位置 X ${l.anchor.x.toFixed(2)}　Y ${l.anchor.y.toFixed(2)}（相对章面半径）`}>
              <input
                type="range" min={-1} max={1} step={0.02} value={l.anchor.x}
                onChange={(e) => updateImage(l.id, (x) => { x.anchor.x = Number(e.target.value); })}
                style={{ width: '100%' }}
              />
              <input
                type="range" min={-1} max={1} step={0.02} value={l.anchor.y}
                onChange={(e) => updateImage(l.id, (x) => { x.anchor.y = Number(e.target.value); })}
                style={{ width: '100%' }}
              />
            </Field>

            <Field label={`旋转 ${l.transform.rotateDeg}°　缩放 ${l.transform.scale.toFixed(2)}`}>
              <input
                type="range" min={-180} max={180} step={1} value={l.transform.rotateDeg}
                onChange={(e) => updateImage(l.id, (x) => { x.transform.rotateDeg = Number(e.target.value); })}
                style={{ width: '100%' }}
              />
              <input
                type="range" min={0.2} max={2} step={0.05} value={l.transform.scale}
                onChange={(e) => updateImage(l.id, (x) => { x.transform.scale = Number(e.target.value); })}
                style={{ width: '100%' }}
              />
            </Field>

            <Field label={l.trace.autoThreshold ? '阈值：自动（Otsu）' : `阈值 ${l.trace.threshold.toFixed(2)}`}>
              <input
                type="range" min={0.05} max={0.95} step={0.05} value={l.trace.threshold}
                disabled={l.trace.autoThreshold}
                onChange={(e) =>
                  updateImage(l.id, (x) => {
                    x.trace.threshold = Number(e.target.value);
                    x.trace.autoThreshold = false;
                  })
                }
                style={{ width: '100%', opacity: l.trace.autoThreshold ? 0.45 : 1 }}
              />
              <label style={checkRowStyle}>
                <input
                  type="checkbox" checked={l.trace.autoThreshold}
                  onChange={(e) => updateImage(l.id, (x) => { x.trace.autoThreshold = e.target.checked; })}
                />
                自动阈值（Otsu）
              </label>
              <label style={checkRowStyle}>
                <input
                  type="checkbox" checked={l.trace.invert}
                  onChange={(e) => updateImage(l.id, (x) => { x.trace.invert = e.target.checked; })}
                />
                反相（深色当墨）
              </label>
            </Field>

            <Field label="描摹方式">
              <select
                value={l.trace.mode ?? 'silhouette'}
                onChange={(e) => updateImage(l.id, (x) => { x.trace.mode = e.target.value as 'silhouette' | 'outline'; })}
                style={inputStyle}
              >
                <option value="silhouette">实心块</option>
                <option value="outline">线框（等宽环，线稿风）</option>
              </select>
            </Field>

            <Field label={`去噪：丢弃小于 ${l.trace.despeckleAreaMm2}mm² 的碎块`}>
              <input
                type="range" min={0} max={10} step={0.5} value={l.trace.despeckleAreaMm2}
                onChange={(e) => updateImage(l.id, (x) => { x.trace.despeckleAreaMm2 = Number(e.target.value); })}
                style={{ width: '100%' }}
              />
            </Field>
          </div>
        ))}

        <Field label="手柄">
          <select
            value={spec.body.handle}
            disabled={Boolean(libStyle)}
            onChange={(e) => patch((s) => { s.body.handle = e.target.value as SealSpec['body']['handle']; })}
            style={{ ...inputStyle, opacity: libStyle ? 0.55 : 1 }}
          >
            <option value="none">无</option>
            <option value="knob">圆钮</option>
            <option value="bridge">桥式</option>
          </select>
        </Field>

        <Field
          label={
            libStyle
              ? '打印取向（内置主体只能盖印面贴床）'
              : spec.body.handle === 'none'
                ? '打印取向'
                : '打印取向（有手柄时只能盖印面贴床）'
          }
        >
          <select
            value={spec.print.orientation ?? 'face-down'}
            disabled={spec.body.handle !== 'none' || Boolean(libStyle)}
            onChange={(e) => patch((s) => { s.print.orientation = e.target.value as PrintOrientation; })}
            style={{ ...inputStyle, opacity: spec.body.handle !== 'none' || libStyle ? 0.55 : 1 }}
          >
            <option value="face-down">盖印面贴床（face-down）</option>
            <option value="face-up" disabled={spec.body.handle !== 'none' || Boolean(libStyle)}>
              背面贴床、字母朝上（face-up）
            </option>
          </select>
        </Field>

        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button style={btnStyle} disabled={!mesh || blocking} onClick={() => download('stl')}>导出 STL</button>
          <button style={btnStyle} disabled={!mesh || blocking} onClick={() => download('3mf')}>导出 3MF</button>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button style={btnStyle} onClick={() => { void share(); }}>复制分享链接</button>
        </div>
        {notice && <p style={{ color: '#2e7d32', fontSize: 12, marginTop: 8, lineHeight: 1.5 }}>{notice}</p>}
        {blocking && (
          <p style={{ color: '#b3261e', fontSize: 12, marginTop: 8, lineHeight: 1.5 }}>
            有阻断级问题，导出已禁用——先按上面的提示改（切阴刻，或把手柄设为「无」后改成 face-up）。
          </p>
        )}

        {printIssues.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: 12, color: '#7a746b', marginBottom: 4 }}>
              打印校验（{printIssues.length}）
            </div>
            {printIssues.map((v, i) => (
              <div key={`${v.rule}-${i}`} style={{ ...violationStyle, color: v.severity === 'error' ? '#b3261e' : '#8a5a00' }}>
                <strong>{v.rule}</strong>　{v.message}
              </div>
            ))}
          </div>
        )}

        {hints.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: 12, color: '#7a746b', marginBottom: 4 }}>
              提示（{hints.length}）· 不影响导出
            </div>
            {hints.map((v, i) => (
              <div key={`hint-${v.rule}-${i}`} style={{ ...violationStyle, color: '#7a746b' }}>
                <strong>{v.rule}</strong>　{v.message}
              </div>
            ))}
          </div>
        )}

        {error && <p style={{ color: '#b3261e', fontSize: 12, marginTop: 12 }}>{error}</p>}

        <div style={{ marginTop: 18, paddingTop: 12, borderTop: '1px solid #eeeae1' }}>
          <button
            onClick={() => setShowAbout(true)}
            style={{ ...miniBtnStyle, padding: '5px 10px' }}
          >
            字体与授权
          </button>
        </div>
      </aside>

      <main style={{ flex: 1, display: 'flex', flexDirection: narrow ? 'column' : 'row', minWidth: 0, minHeight: 0 }}>
        <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
          <Viewer
            mesh={mesh}
            orientation={spec.print.orientation ?? 'face-down'}
            minHeight={narrow ? 240 : 420}
            sizeMm={spec.body.sizeMm}
          />
          <div style={{ position: 'absolute', left: 12, bottom: 10, fontSize: 12, color: '#7a746b' }}>{status}</div>
          <div style={{ position: 'absolute', left: 12, top: 10, fontSize: 11, color: '#a39c91' }}>
            模型视角（实体已镜像）
          </div>
        </div>

        <div
          style={{
            flex: narrow ? '0 0 auto' : '0 0 250px',
            minHeight: narrow ? 100 : 0,
            borderLeft: narrow ? 'none' : '1px solid #e6e2da',
            borderTop: narrow ? '1px solid #e6e2da' : 'none',
            background: '#fff',
            padding: 12,
            boxSizing: 'border-box',
            display: 'flex',
            flexDirection: narrow ? 'row' : 'column',
            alignItems: narrow ? 'center' : 'stretch',
            gap: 10,
          }}
        >
          <div style={{ fontSize: 12, color: '#7a746b', whiteSpace: 'nowrap' }}>盖印效果（字是正的）</div>
          {previewUrl ? (
            <img
              src={previewUrl}
              alt="盖印效果预览"
              style={{
                width: narrow ? 96 : '100%',
                borderRadius: 6,
                border: '1px solid #eee7dc',
                flex: '0 0 auto',
              }}
            />
          ) : (
            <div style={{ fontSize: 12, color: '#b0a99e' }}>—</div>
          )}
          {!narrow && (
            <div style={{ fontSize: 11, color: '#b0a99e', lineHeight: 1.5 }}>
              模型整体是镜像的，扣下去才印得正。这两个视角看起来相反是正常的。
            </div>
          )}
        </div>
      </main>
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

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '6px 8px',
  border: '1px solid #ddd7cc',
  borderRadius: 6,
  background: '#fff',
  fontSize: 13,
};

const btnStyle: React.CSSProperties = {
  flex: 1,
  padding: '8px 10px',
  borderRadius: 6,
  border: '1px solid #ddd7cc',
  background: '#fff',
  cursor: 'pointer',
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

const cardStyle: React.CSSProperties = {
  marginTop: 10,
  padding: '10px 10px 2px',
  border: '1px solid #e6e2da',
  borderRadius: 8,
  background: '#fff',
};

const miniBtnStyle: React.CSSProperties = {
  padding: '3px 8px',
  fontSize: 11,
  borderRadius: 5,
  border: '1px solid #e0d8c9',
  background: '#faf7f1',
  cursor: 'pointer',
};

const hintStyle: React.CSSProperties = {
  fontSize: 11,
  color: '#a39c91',
  marginBottom: 8,
  lineHeight: 1.5,
};

const checkRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 5,
  fontSize: 12,
  marginTop: 4,
  color: '#5a5348',
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
