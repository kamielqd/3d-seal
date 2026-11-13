/**
 * 端到端验证图像导入：CDP 上传本地图片 → 等模型重建 → 读状态 + 截图。
 * 用法：node scripts/image-e2e.mjs [url] [pngPath] [outPng] [port]
 */
import { writeFileSync } from 'node:fs';

const url = process.argv[2] ?? 'http://127.0.0.1:4173/';
const img = process.argv[3] ?? 'temp/test-image.png';
const out = process.argv[4] ?? 'temp/image-e2e.png';
const port = Number(process.argv[5] ?? 9222);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findPage() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page;
    } catch {}
    await sleep(250);
  }
  throw new Error('no page target');
}

const page = await findPage();
const ws = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
let seq = 0;
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
});
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });

const evalText = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value;
};

await send('Page.enable');
await send('DOM.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url });

// 等初始模型出来
let text = '';
for (let i = 0; i < 120; i++) {
  await sleep(250);
  text = (await evalText('document.body.innerText')) ?? '';
  if (/三角面/.test(text)) break;
}
console.log('初始状态:', (text.split('\n').find((l) => /三角面/.test(l)) ?? '').trim());

// 找 file input 并上传
const doc = await send('DOM.getDocument', { depth: -1 });
const q = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: 'input[type=file]' });
if (!q.result?.nodeId) {
  console.log('页面上没有 input[type=file]');
  process.exit(2);
}
await send('DOM.setFileInputFiles', { nodeId: q.result.nodeId, files: [img] });
console.log('已选择文件:', img);

// 等状态行变化或出现图像相关提示
let after = '';
let changed = false;
const before = text;
for (let i = 0; i < 80; i++) {
  await sleep(250);
  after = (await evalText('document.body.innerText')) ?? '';
  if (after !== before && /三角面/.test(after)) {
    changed = true;
    // 再等一拍，等模型重建完
    await sleep(1500);
    after = (await evalText('document.body.innerText')) ?? '';
    break;
  }
}

const status = (after.split('\n').find((l) => /三角面|超时|失败|错误/.test(l)) ?? '').trim();
console.log('上传后状态:', status || '(未变化)');
const imgHints = after.split('\n').filter((l) => /图像|描摹|阈值|去噪|丢弃|轮廓/.test(l)).slice(0, 6);
if (imgHints.length) console.log('图像相关提示:\n  ' + imgHints.join('\n  '));

const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
console.log('saved', out);
ws.close();
process.exit(changed ? 0 : 1);
