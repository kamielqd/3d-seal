/**
 * 四主体 × 三文字 落地验收（浏览器真机路径，CDP 连 headless chrome 9222）。
 *
 * 走 UI：点主体样式小方块、改「文字」输入框（React 原生 setter + input 事件）。
 * 指标：钩住 worker 的 BuildResponse.mesh，自己算 bbox / zMin / 体积；面数/状态/耗时取自 UI 状态行。
 * 母体体积：外部主体 STL 在 sizeMm=30 下的体积（同一套 STL 解析 + 缩放口径 k=sizeMm/足迹）。
 *
 * 产出：控制台 12 行表 + temp/body-acceptance.json + temp/accept-<style>.png
 */
import { readFileSync, writeFileSync } from 'node:fs';

const CDP_HTTP = 'http://127.0.0.1:9222';
const APP_URL_SUBSTR = 'localhost:5173';
const SIZE_MM = 30;
const TEXTS = [
  { key: '4char', text: '印章工坊' },
  { key: '1char', text: '福' },
  { key: '7char', text: '吉祥如意万事顺' },
];
const STYLES = [
  { id: 'classic', idx: 0, expHeight: 30.5 },
  { id: 'cylinder', idx: 1, expHeight: 64.5 },
  { id: 'column', idx: 2, expHeight: 65.9 },
  { id: 'dome', idx: 3, expHeight: 29.0 },
];

/* ---------- 母体体积（STL 源单位 × k³） ---------- */
function parseStl(path) {
  const buf = readFileSync(path);
  const head = buf.subarray(0, 80).toString('ascii');
  const isAscii = /^\s*solid/.test(head) && buf.subarray(0, 512).toString('ascii').includes('facet');
  const verts = [];
  const tris = [];
  if (!isAscii) {
    const n = buf.readUInt32LE(80);
    let off = 84;
    for (let i = 0; i < n; i++) {
      off += 12;
      const base = verts.length / 3;
      for (let k = 0; k < 3; k++) {
        verts.push(buf.readFloatLE(off), buf.readFloatLE(off + 4), buf.readFloatLE(off + 8));
        off += 12;
      }
      off += 2;
      tris.push(base, base + 1, base + 2);
    }
  } else {
    const text = buf.toString('ascii');
    const re = /vertex\s+(-?[\d.eE+]+)\s+(-?[\d.eE+]+)\s+(-?[\d.eE+]+)/g;
    let m;
    while ((m = re.exec(text))) verts.push(+m[1], +m[2], +m[3]);
    for (let i = 0; i + 2 < verts.length / 3; i += 3) tris.push(i, i + 1, i + 2);
  }
  return { verts, tris };
}
function motherVolumeMM3(id) {
  const { verts, tris } = parseStl(`public/bodies/${id}.stl`);
  let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
  for (let i = 0; i < verts.length; i += 3) {
    const x = verts[i], y = verts[i + 1];
    if (x < minx) minx = x; if (x > maxx) maxx = x;
    if (y < miny) miny = y; if (y > maxy) maxy = y;
  }
  const footprint = Math.max(maxx - minx, maxy - miny);
  const k = SIZE_MM / footprint;
  let vol = 0;
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t] * 3, b = tris[t + 1] * 3, c = tris[t + 2] * 3;
    const ax = verts[a], ay = verts[a + 1], az = verts[a + 2];
    const bx = verts[b], by = verts[b + 1], bz = verts[b + 2];
    const cx = verts[c], cy = verts[c + 1], cz = verts[c + 2];
    vol += (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6;
  }
  return Math.abs(vol) * k * k * k;
}

/* ---------- 极简 CDP 客户端 ---------- */
class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.ready = new Promise((res, rej) => {
      this.ws.addEventListener('open', () => res());
      this.ws.addEventListener('error', (e) => rej(e));
    });
    this.ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id != null && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) rej(new Error(JSON.stringify(msg.error)));
        else res(msg.result);
      }
    });
  }
  async send(method, params = {}) {
    await this.ready;
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('CDP timeout ' + method)); } }, 30000);
    });
  }
  close() { try { this.ws.close(); } catch {} }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 注入页面的钩子 ---------- */
const HOOK = `
(() => {
  const Orig = window.Worker;
  window.__buildCount = 0;
  window.__lastResp = null;
  window.Worker = class extends Orig {
    constructor(url, opts) {
      super(url, opts);
      this.addEventListener('message', (ev) => {
        const d = ev.data;
        if (!d || d.type === 'stage' || d.type === 'ready') return;
        if (typeof d.id === 'number') { window.__lastResp = d; window.__buildCount++; }
      });
    }
  };
  window.__metrics = function () {
    const d = window.__lastResp;
    if (!d) return { ok: null };
    if (!d.ok || !d.mesh) return { ok: false, error: d.error || '', code: d.code || '', stage: d.stage || '', id: d.id };
    const m = d.mesh, vp = m.vertProperties, np = m.numProp || 3, tv = m.triVerts;
    let minx=1e9,miny=1e9,minz=1e9,maxx=-1e9,maxy=-1e9,maxz=-1e9;
    for (let i=0;i<vp.length;i+=np){const x=vp[i],y=vp[i+1],z=vp[i+2];if(x<minx)minx=x;if(x>maxx)maxx=x;if(y<miny)miny=y;if(y>maxy)maxy=y;if(z<minz)minz=z;if(z>maxz)maxz=z;}
    let vol=0;
    for (let t=0;t<tv.length;t+=3){const a=tv[t]*np,b=tv[t+1]*np,c=tv[t+2]*np;const ax=vp[a],ay=vp[a+1],az=vp[a+2],bx=vp[b],by=vp[b+1],bz=vp[b+2],cx=vp[c],cy=vp[c+1],cz=vp[c+2];vol+=(ax*(by*cz-bz*cy)+ay*(bz*cx-bx*cz)+az*(bx*cy-by*cx))/6;}
    return { ok:true, id:d.id, triangleCount:m.triangleCount, status:m.status,
      zMin:minz, zMax:maxz, height:maxz-minz,
      footprintX:maxx-minx, footprintY:maxy-miny,
      footprint:Math.max(maxx-minx,maxy-miny), volume:Math.abs(vol),
      violations: Array.isArray(m.violations) ? m.violations.map(v=>({rule:v.rule, severity:v.severity})) : [] };
  };
  window.__statusText = function () {
    const divs=[...document.querySelectorAll('div')];
    for (const e of divs) { const t=(e.textContent||'').trim(); if (e.children.length===0 && /三角面/.test(t)) return t; }
    return '';
  };
})();
`;

/* ---------- 页面 UI 操作（React 原生 setter + 事件） ---------- */
const setTextExpr = (text) => `(() => {
  const el=[...document.querySelectorAll('input')].find(i=>i.type!=='range'&&i.type!=='file'&&i.type!=='checkbox');
  if(!el) return 'no-text-input';
  const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
  s.call(el, ${JSON.stringify(text)});
  el.dispatchEvent(new Event('input',{bubbles:true}));
  return el.value;
})()`;

const setFontExpr = (id) => `(() => {
  const sel=[...document.querySelectorAll('select')].find(s=>[...s.options].some(o=>o.value===${JSON.stringify(id)}));
  if(!sel) return 'no-font-select';
  const s=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;
  s.call(sel, ${JSON.stringify(id)});
  sel.dispatchEvent(new Event('change',{bubbles:true}));
  return sel.value;
})()`;

const setSizeExpr = (mm) => `(() => {
  const el=[...document.querySelectorAll('input[type=range]')].find(i=>i.min==='20'&&i.max==='45');
  if(!el) return 'no-size';
  const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
  s.call(el, ${JSON.stringify(String(mm))});
  el.dispatchEvent(new Event('input',{bubbles:true}));
  el.dispatchEvent(new Event('change',{bubbles:true}));
  return el.value;
})()`;

const clickStyleExpr = (idx) => `(() => {
  const btns=[...document.querySelectorAll('button')].filter(b=>b.querySelector('svg'));
  if(btns.length<4) return 'only '+btns.length+' svg buttons';
  btns[${idx}].click();
  return btns.length;
})()`;

/* ---------- 主流程 ---------- */
async function main() {
  // 找页面 target
  const list = await (await fetch(`${CDP_HTTP}/json/list`)).json();
  const target = list.find((t) => t.type === 'page' && String(t.url).includes(APP_URL_SUBSTR));
  if (!target) throw new Error('找不到 localhost:5173 的页面 target');
  const cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: HOOK });

  const evalExpr = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('eval异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result?.value;
  };

  // 刷新应用钩子
  await cdp.send('Page.reload', { ignoreCache: true });
  // 等初始默认构建完成
  const waitSettled = async (prev) => {
    let last = -1, stable = 0;
    for (let i = 0; i < 200; i++) {
      const c = (await evalExpr('window.__buildCount||0')) || 0;
      if (c > prev && c === last) stable++; else stable = 0;
      last = c;
      if (c > prev && stable >= 3) return c;
      await sleep(120);
    }
    return last;
  };
  await sleep(1500);
  let base = (await evalExpr('window.__buildCount||0')) || 0;

  const mother = {};
  for (const s of STYLES) mother[s.id] = motherVolumeMM3(s.id);

  const rows = [];
  for (const st of STYLES) {
    for (const tx of TEXTS) {
      const prev = (await evalExpr('window.__buildCount||0')) || 0;
      // UI 操作：先设字体/尺寸，再点主体样式，最后改文字
      await evalExpr(setFontExpr('smiley-sans'));
      await evalExpr(setSizeExpr(SIZE_MM));
      await evalExpr(clickStyleExpr(st.idx));
      await evalExpr(setTextExpr(tx.text));
      await waitSettled(prev);

      const m = await evalExpr('window.__metrics()');
      const statusText = await evalExpr('window.__statusText()');
      let ms = null, triUI = null, statusUI = null;
      const mt = /(\d+)\s*三角面\s*·\s*([^·]+?)\s*·\s*(\d+)\s*ms/.exec(statusText || '');
      if (mt) { triUI = Number(mt[1]); statusUI = mt[2].trim(); ms = Number(mt[3]); }

      const tri = m && m.ok ? m.triangleCount : triUI;
      const status = m && m.ok ? m.status : (m && m.ok === false ? `ERR:${m.code || m.stage || m.error || ''}` : (statusUI || 'FAIL'));
      const footprint = m && m.ok ? m.footprint : null;
      const height = m && m.ok ? m.height : null;
      const zMin = m && m.ok ? m.zMin : null;
      const engravedVol = m && m.ok ? m.volume : null;
      const motherVol = mother[st.id];
      const removed = engravedVol != null ? motherVol - engravedVol : null;

      const viol = (m && m.violations) || [];
      const violStr = viol.length ? viol.map((v) => `${v.rule}(${v.severity})`).join('; ') : '-';
      const blocking = viol.some((v) => v.severity === 'error');

      // 判定
      const pass =
        status === 'NoError' &&
        tri != null && tri < 20000 &&
        footprint != null && Math.abs(footprint - SIZE_MM) <= 0.2 &&
        height != null && Math.abs(height - st.expHeight) <= 0.5 &&
        removed != null && removed > 0 &&
        zMin != null && Math.abs(zMin) <= 1e-3;

      const row = {
        style: st.id,
        text: tx.text,
        triangleCount: tri,
        footprint: footprint != null ? +footprint.toFixed(2) : null,
        height: height != null ? +height.toFixed(2) : null,
        expHeight: st.expHeight,
        zMin: zMin != null ? +zMin.toFixed(3) : null,
        motherVolume: +motherVol.toFixed(1),
        engravedVolume: engravedVol != null ? +engravedVol.toFixed(1) : null,
        removedVolume: removed != null ? +removed.toFixed(1) : null,
        status,
        violations: violStr,
        blocking,
        ms,
        pass,
      };
      rows.push(row);
      console.log(
        `${st.id.padEnd(9)} ${tx.key.padEnd(6)} tri=${String(tri).padStart(5)} foot=${row.footprint} h=${row.height}(exp${st.expHeight}) ` +
          `母=${row.motherVolume} 刻掉=${row.removedVolume} zMin=${row.zMin} ${status} viol=[${violStr}] blocking=${blocking} ${ms}ms ${pass ? 'PASS' : 'FAIL'}`,
      );

      // 每种样式第一组（4字）截一张
      if (tx.key === '4char') {
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
        writeFileSync(`temp/accept-${st.id}.png`, Buffer.from(shot.data, 'base64'));
      }
    }
  }

  writeFileSync('temp/body-acceptance.json', JSON.stringify({ generatedAt: new Date().toISOString(), sizeMm: SIZE_MM, rows }, null, 2));
  const passCount = rows.filter((r) => r.pass).length;
  console.log(`\n通过 ${passCount}/${rows.length}`);
  cdp.close();
}

main().catch((e) => { console.error('验收脚本失败：', e); process.exit(1); });
