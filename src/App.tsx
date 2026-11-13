import { useEffect, useMemo, useRef, useState } from 'react';
import Viewer, { type ViewerMesh } from './render/Viewer';
import { createDefaultSpec, type BodyShape, type PrintOrientation, type SealSpec } from './core/spec';
import { layoutFlatPolygons } from './core/layout-bridge';
import { fromLayoutPolygons } from './core/polygon-bridge';
import { toStlBlob } from './export/stl';
import { to3mfBlob } from './export/threemf';
import { listFonts, DEFAULT_FONT_ID } from './layout/fonts';
import { checkMissing } from './layout/missing';
import { renderPreviewToDataURL } from './render/preview2d';
import type { BuildResponse } from './worker/geometry.worker';
import type { SolidMesh } from './geometry/types';
import type { Violation } from './geometry/printability';

export default function App() {
  const [spec, setSpec] = useState<SealSpec>(() => createDefaultSpec());
  const [mesh, setMesh] = useState<ViewerMesh | null>(null);
  const [error, setError] = useState<string>('');
  const [building, setBuilding] = useState(false);
  const [elapsed, setElapsed] = useState<number>(0);
  const [stage, setStage] = useState<string>('');
  const [previewUrl, setPreviewUrl] = useState<string>('');
  const [violations, setViolations] = useState<Violation[]>([]);

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
        const flat = await layoutFlatPolygons(spec);
        if (cancelled) return;
        // 盖印效果：版式输出的是**可读**轮廓，所以 mirror=false（翻一次就印反了）
        try {
          setPreviewUrl(
            renderPreviewToDataURL(flat, {
              sizeMm: spec.body.sizeMm,
              dpi: 180,
              mirror: false,
              paddingMm: 1.5,
              paper: { enabled: true },
              ink: {},
            }),
          );
        } catch {
          setPreviewUrl('');
        }
        const polygons = fromLayoutPolygons(flat);
        if (polygons.length === 0) {
          setMesh(null);
          setError('没有可生成的内容，先输入文字');
          setBuilding(false);
          return;
        }
        const id = ++seqRef.current;
        const res = await new Promise<BuildResponse>((resolve) => {
          pendingRef.current.set(id, resolve);
          worker.postMessage({ id, spec: { body: spec.body, relief: spec.relief, print: spec.print }, polygons });
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
  }, [spec]);

  const textLayer = spec.layers.find((l) => l.kind === 'text');
  const fontId = textLayer && textLayer.kind === 'text' ? textLayer.fontId : DEFAULT_FONT_ID;
  const fontText = textLayer && textLayer.kind === 'text' ? textLayer.text : '';
  const missing = useMemo(() => checkMissing(fontText, fontId), [fontText, fontId]);
  const printIssues = violations.filter((v) => v.severity !== 'info');
  /** 阻断级问题：不允许导出（例如阳刻+手柄的 809mm² 悬空面） */
  const blocking = violations.some((v) => v.severity === 'error');

  const patch = (fn: (s: SealSpec) => void) => {
    setSpec((prev) => {
      const next: SealSpec = structuredClone(prev);
      fn(next);
      return next;
    });
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
    <div style={{ display: 'flex', height: '100vh', fontFamily: 'system-ui, sans-serif', background: '#faf9f7' }}>
      <aside style={{ width: 300, flex: '0 0 300px', padding: 16, overflowY: 'auto', borderRight: '1px solid #e6e2da' }}>
        <h1 style={{ fontSize: 17, margin: '0 0 14px' }}>印章工坊</h1>

        <Field label="章型">
          <select
            value={spec.body.shape}
            onChange={(e) => patch((s) => { s.body.shape = e.target.value as BodyShape; })}
            style={inputStyle}
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
            type="range" min={20} max={45} value={spec.body.sizeMm}
            onChange={(e) => patch((s) => { s.body.sizeMm = Number(e.target.value); })}
            style={{ width: '100%' }}
          />
        </Field>

        <Field label="浮雕">
          <select
            value={spec.relief.mode}
            onChange={(e) => patch((s) => { s.relief.mode = e.target.value as 'raised' | 'engraved'; })}
            style={inputStyle}
          >
            <option value="raised">阳刻（凸）</option>
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

        <Field label="手柄">
          <select
            value={spec.body.handle}
            onChange={(e) => patch((s) => { s.body.handle = e.target.value as SealSpec['body']['handle']; })}
            style={inputStyle}
          >
            <option value="none">无</option>
            <option value="knob">圆钮</option>
            <option value="bridge">桥式</option>
          </select>
        </Field>

        <Field
          label={
            spec.body.handle === 'none'
              ? '打印取向'
              : '打印取向（有手柄时只能盖印面贴床）'
          }
        >
          <select
            value={spec.print.orientation ?? 'face-down'}
            disabled={spec.body.handle !== 'none'}
            onChange={(e) => patch((s) => { s.print.orientation = e.target.value as PrintOrientation; })}
            style={{ ...inputStyle, opacity: spec.body.handle !== 'none' ? 0.55 : 1 }}
          >
            <option value="face-down">盖印面贴床（face-down）</option>
            <option value="face-up" disabled={spec.body.handle !== 'none'}>
              背面贴床、字母朝上（face-up）
            </option>
          </select>
        </Field>

        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button style={btnStyle} disabled={!mesh || blocking} onClick={() => download('stl')}>导出 STL</button>
          <button style={btnStyle} disabled={!mesh || blocking} onClick={() => download('3mf')}>导出 3MF</button>
        </div>
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

        {error && <p style={{ color: '#b3261e', fontSize: 12, marginTop: 12 }}>{error}</p>}
      </aside>

      <main style={{ flex: 1, display: 'flex', minWidth: 0 }}>
        <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
          <Viewer mesh={mesh} orientation={spec.print.orientation ?? 'face-down'} />
          <div style={{ position: 'absolute', left: 12, bottom: 10, fontSize: 12, color: '#7a746b' }}>{status}</div>
          <div style={{ position: 'absolute', left: 12, top: 10, fontSize: 11, color: '#a39c91' }}>
            模型视角（实体已镜像）
          </div>
        </div>

        <div
          style={{
            flex: '0 0 250px',
            borderLeft: '1px solid #e6e2da',
            background: '#fff',
            padding: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <div style={{ fontSize: 12, color: '#7a746b' }}>盖印效果（字是正的）</div>
          {previewUrl ? (
            <img
              src={previewUrl}
              alt="盖印效果预览"
              style={{ width: '100%', borderRadius: 6, border: '1px solid #eee7dc' }}
            />
          ) : (
            <div style={{ fontSize: 12, color: '#b0a99e' }}>—</div>
          )}
          <div style={{ fontSize: 11, color: '#b0a99e', lineHeight: 1.5 }}>
            模型整体是镜像的，扣下去才印得正。这两个视角看起来相反是正常的。
          </div>
        </div>
      </main>
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
