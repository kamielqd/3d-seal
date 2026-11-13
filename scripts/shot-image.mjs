/**
 * 端到端验证图像导入：把一张 PNG 塞进 file input，等模型重建，然后截图。
 * 用法：node scripts/shot-image.mjs <url> <png> <outPrefix> [port]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const url = process.argv[2] ?? 'http://127.0.0.1:4173/';
const imagePath = resolve(process.argv[3] ?? 'temp/trace-test.png');
const prefix = process.argv[4] ?? 'temp/img';
const port = Number(process.argv[5] ?? 9222);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findPage() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page;
    } catch {
      /* not ready */
    }
    await sleep(250);
  }
  throw new Error('CDP 上没有 page target');
}

const page = await findPage();
const ws = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
let seq = 0;
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value;
};

await send('Page.enable');
await send('Runtime.enable');
await send('DOM.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url });

for (let i = 0; i < 120; i++) {
  await sleep(250);
  const t = await evalJs('document.body.innerText');
  if (/三角面/.test(t ?? '')) break;
}
console.log('初始:', (await evalJs("(document.body.innerText.split('\\n').find(l=>/三角面/.test(l))||'').trim()")));

// 清空文字，只留图像，避免两者叠在一起看不清
await evalJs(`(() => {
  const ta = document.querySelectorAll('input')[0];
  return true;
})()`);

const doc = await send('DOM.getDocument');
const q = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: 'input[type=file]' });
if (!q.result?.nodeId) throw new Error('找不到 file input');
const set = await send('DOM.setFileInputFiles', { nodeId: q.result.nodeId, files: [imagePath] });
if (set.error) throw new Error(`setFileInputFiles 失败：${JSON.stringify(set.error)}`);
console.log('已注入图片:', imagePath);

// 等图像图层出现，再等一次完整重建（状态行里带 «三角面» 会刷新，但不能靠它判断是否已重建）
let ok = false;
for (let i = 0; i < 160; i++) {
  await sleep(250);
  const t = await evalJs('document.body.innerText');
  if (/图像图层/.test(t ?? '')) {
    ok = true;
    break;
  }
}
await sleep(3000); // 防抖 250ms + 描摹 + 布尔，给足时间
const line = await evalJs("(document.body.innerText.split('\\n').find(l=>/三角面|失败|没有可生成/.test(l))||'').trim()");
console.log('重建后:', line || '(无状态行)');
const violations = await evalJs(
  "Array.from(document.querySelectorAll('div')).filter(d=>/^(stroke|gap|island|relief|groove|nozzle|overhang|base|size|bridge|pattern|auto)\\./.test(d.innerText||'')).map(d=>d.innerText.replace(/\\s+/g,' ')).join(' | ')",
);
console.log('校验:', violations || '(无)');

mkdirSync(dirname(`${prefix}-iso.png`), { recursive: true });
await sleep(600);
let shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(`${prefix}-iso.png`, Buffer.from(shot.result.data, 'base64'));

await evalJs("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('看章面'))?.click()");
await sleep(900);
shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(`${prefix}-face.png`, Buffer.from(shot.result.data, 'base64'));
console.log('saved', `${prefix}-iso.png`, `${prefix}-face.png`);
ws.close();
process.exit(ok ? 0 : 1);
