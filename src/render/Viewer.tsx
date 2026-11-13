import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export interface ViewerMesh {
  vertProperties: Float32Array;
  triVerts: Uint32Array;
  numProp: number;
  triangleCount: number;
  status: string;
}

export type Orientation = 'face-down' | 'face-up';

/** 把 manifold 的交错顶点缓冲转成 three 的 BufferGeometry */
function toGeometry(mesh: ViewerMesh): THREE.BufferGeometry {
  const { vertProperties, triVerts, numProp } = mesh;
  const count = vertProperties.length / numProp;
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const o = i * numProp;
    pos[i * 3] = vertProperties[o];
    pos[i * 3 + 1] = vertProperties[o + 1];
    pos[i * 3 + 2] = vertProperties[o + 2];
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(new THREE.BufferAttribute(new Uint32Array(triVerts), 1));
  geo.computeVertexNormals();
  return geo;
}

type ViewMode = 'iso' | 'face' | 'back';

/**
 * 相机预设。
 *
 * 模型在场景里被 rotation.x = -π/2 立起来：模型 z → 世界 y，
 * 所以 face-down 时盖印面（z=0）落在世界 y≈0 的**下侧**，要从下往上看；
 * face-up 时正好相反。这就是「换个取向就看不见字了」的原因，必须给预设。
 *
 * face 视角故意带一点 +z 偏移（16），避免相机视线与 up 平行导致 lookAt 退化。
 */
function preset(view: ViewMode, orientation: Orientation): { pos: [number, number, number]; target: [number, number, number] } {
  const faceDown = orientation !== 'face-up';
  if (view === 'face') {
    return { pos: [0, faceDown ? -52 : 52, 16], target: [0, 2, 0] };
  }
  if (view === 'back') {
    return { pos: [0, faceDown ? 52 : -52, 16], target: [0, faceDown ? 10 : 2, 0] };
  }
  return { pos: [48, 42, 62], target: [0, 0, 8] };
}

export default function Viewer({ mesh, orientation = 'face-down' }: { mesh: ViewerMesh | null; orientation?: Orientation }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<ViewMode>('iso');
  const stateRef = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
    model: THREE.Mesh | null;
    grid: THREE.GridHelper;
    raf: number;
  } | null>(null);

  // 初始化场景（只做一次）
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(host.clientWidth, host.clientHeight);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf2f0ec);

    const camera = new THREE.PerspectiveCamera(38, host.clientWidth / host.clientHeight, 0.5, 5000);
    camera.position.set(48, 42, 62);
    camera.lookAt(0, 0, 0);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.target.set(0, 0, 8);

    scene.add(new THREE.HemisphereLight(0xffffff, 0x9aa0a6, 1.1));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(40, 60, 80);
    scene.add(key);
    // 从下方照一盏：看章面时灯在上面会把凹槽照成一团黑
    const under = new THREE.DirectionalLight(0xffffff, 1.1);
    under.position.set(-20, -70, 30);
    scene.add(under);
    const fill = new THREE.DirectionalLight(0xffffff, 0.5);
    fill.position.set(-50, -30, 20);
    scene.add(fill);

    const grid = new THREE.GridHelper(200, 40, 0xd6d2ca, 0xe4e0d8);
    grid.position.y = -0.01;
    scene.add(grid);

    host.appendChild(renderer.domElement);

    const tick = () => {
      controls.update();
      renderer.render(scene, camera);
      const s = stateRef.current;
      if (s) s.raf = requestAnimationFrame(tick);
    };

    stateRef.current = { renderer, scene, camera, controls, model: null, grid, raf: requestAnimationFrame(tick) };

    const onResize = () => {
      if (!host.clientWidth || !host.clientHeight) return;
      camera.aspect = host.clientWidth / host.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(host.clientWidth, host.clientHeight);
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(host);

    return () => {
      ro.disconnect();
      const s = stateRef.current;
      if (s) cancelAnimationFrame(s.raf);
      controls.dispose();
      renderer.dispose();
      host.removeChild(renderer.domElement);
      stateRef.current = null;
    };
  }, []);

  // 视角 / 取向变化 → 重设相机
  useEffect(() => {
    const s = stateRef.current;
    if (!s) return;
    const { pos, target } = preset(view, orientation);
    s.camera.position.set(pos[0], pos[1], pos[2]);
    s.controls.target.set(target[0], target[1], target[2]);
    s.controls.update();
    // 相机跑到床面以下时，网格会挡在章面前面糊成一片白线；看章面时必须隐藏
    s.grid.visible = pos[1] > 0;
  }, [view, orientation]);

  // 网格更新
  useEffect(() => {
    const s = stateRef.current;
    if (!s) return;
    if (s.model) {
      s.scene.remove(s.model);
      s.model.geometry.dispose();
      (s.model.material as THREE.Material).dispose();
      s.model = null;
    }
    if (!mesh) return;

    const geo = toGeometry(mesh);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xd94f4f,
      roughness: 0.55,
      metalness: 0.05,
      flatShading: false,
    });
    const m = new THREE.Mesh(geo, mat);
    // manifold 用 z 向上，three 默认 y 向上
    m.rotation.x = -Math.PI / 2;
    s.scene.add(m);
    s.model = m;
  }, [mesh]);

  const faceLabel = orientation === 'face-up' ? '看章面（朝上）' : '看章面（朝下）';

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', minHeight: 420 }}>
      <div ref={hostRef} style={{ width: '100%', height: '100%' }} />
      <div style={{ position: 'absolute', right: 12, top: 10, display: 'flex', gap: 6 }}>
        {([
          ['iso', '立体'],
          ['face', faceLabel],
          ['back', '看背面'],
        ] as Array<[ViewMode, string]>).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setView(id)}
            style={{
              padding: '5px 9px',
              fontSize: 12,
              borderRadius: 6,
              cursor: 'pointer',
              border: `1px solid ${view === id ? '#c9c0b0' : '#ddd7cc'}`,
              background: view === id ? '#fdf6ec' : 'rgba(255,255,255,0.9)',
              color: view === id ? '#5a4a2a' : '#5a5348',
            }}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
