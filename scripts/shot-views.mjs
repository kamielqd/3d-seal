/**
 * 截两张图：默认视角 + 点「看章面」后的章面视角。用 CDP。
 * 用法：node scripts/shot-views.mjs [url] [outPrefix] [port]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const url = process.argv[2] ?? 'http://127.0.0.1:4173/';
const prefix = process.argv[3] ?? 'temp/view';
const port = Number(process.argv[4] ?? 9222);
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

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url });

let text = '';
for (let i = 0; i < 120; i++) {
  await sleep(250);
  const r = await send('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true });
  text = r.result?.result?.value ?? '';
  if (/三角面/.test(text)) break;
}
console.log('状态行:', (text.split('\n').find((l) => /三角面|超时|失败/.test(l)) ?? '').trim() || '(未出现)');

mkdirSync(dirname(`${prefix}-iso.png`), { recursive: true });
for (const [suffix, label] of [['iso', '立体'], ['face', '看章面']]) {
  const click = await send('Runtime.evaluate', {
    expression: `(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('${label}'));
      if (!b) return 'no-button';
      b.click();
      return 'clicked';
    })()`,
    returnByValue: true,
  });
  const clicked = click.result?.result?.value;
  if (clicked === 'no-button') console.log(`按钮「${label}」没找到`);
  await sleep(900);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${prefix}-${suffix}.png`, Buffer.from(shot.result.data, 'base64'));
  console.log('saved', `${prefix}-${suffix}.png`, clicked);
}
ws.close();
process.exit(0);
