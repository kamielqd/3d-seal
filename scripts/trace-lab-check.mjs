/**
 * 浏览器端描摹验收：用 CDP 真的在 Chrome 里跑 lab/trace-lab.html，
 * 取回每组参数的统计和那张「输入 → 描摹叠加」对比图。
 *
 * 用法（先构建 lab、起预览、起带调试端口的 chrome）：
 *   node node_modules/vite/bin/vite.js build --config vite.lab.config.ts
 *   node node_modules/vite/bin/vite.js preview --config vite.lab.config.ts --port 4174 --strictPort
 *   chrome --headless=new --no-sandbox --enable-unsafe-swiftshader --remote-debugging-port=9222 --user-data-dir=%TEMP%\cdp-lab about:blank
 *   node scripts/trace-lab-check.mjs http://127.0.0.1:4174/lab/trace-lab.html 90000 9222
 *
 * 产物：out/trace-compare.png（对比图）、out/trace-lab.json（统计）
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const url = process.argv[2] ?? 'http://127.0.0.1:4174/lab/trace-lab.html';
const timeoutMs = Number(process.argv[3] ?? 90000);
const port = Number(process.argv[4] ?? 9222);

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'out');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function findPage() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((target) => target.type === 'page');
      if (page !== undefined) return page;
    } catch {
      /* chrome 还没起 */
    }
    await sleep(250);
  }
  throw new Error(`CDP ${port} 上没有可用 page target`);
}

const page = await findPage();
const ws = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
const logs = [];
let nextId = 0;

ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id !== undefined && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
    return;
  }
  if (message.method === 'Runtime.consoleAPICalled') {
    const text = (message.params.args ?? [])
      .map((arg) => arg.value ?? arg.description ?? arg.unserializableValue ?? '')
      .join(' ');
    logs.push(`[${message.params.type}] ${text}`);
  }
  if (message.method === 'Runtime.exceptionThrown') {
    logs.push(`[exception] ${message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails?.text ?? ''}`);
  }
});

const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });

await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));
await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url });

const deadline = Date.now() + timeoutMs;
let results = null;
while (Date.now() < deadline) {
  await sleep(500);
  const probe = await send('Runtime.evaluate', {
    expression: 'window.__LAB_RESULTS__ ?? null',
    returnByValue: true,
  });
  const value = probe.result?.result?.value;
  if (value !== null && value !== undefined) {
    results = value;
    break;
  }
}

for (const line of logs) console.log(line);

if (results === null) {
  console.error('超时：页面没有产出 __LAB_RESULTS__');
  const text = await send('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true });
  console.error(text.result?.result?.value ?? '');
  process.exit(1);
}

if (results.error !== undefined) {
  console.error('页面报错：', results.error);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
const sheetBase64 = String(results.sheet ?? '').replace(/^data:image\/png;base64,/, '');
writeFileSync(join(outDir, 'trace-compare.png'), Buffer.from(sheetBase64, 'base64'));
const { sheet: _sheet, ...rest } = results;
writeFileSync(join(outDir, 'trace-lab.json'), JSON.stringify(rest, null, 2));

console.log('\n=== 统计（默认 = Otsu）===');
for (const run of results.runs) {
  const otsu = run.otsu === null ? 'manual' : `otsu η=${run.otsu.eta}`;
  console.log(
    `${run.fixture.padEnd(14)} ${String(run.variant).padEnd(12)} ${String(run.ms).padStart(7)}ms ` +
      `thr=${String(run.thresholdUsed).padEnd(5)} ${otsu.padEnd(14)} ` +
      `polygons=${String(run.polygons).padStart(3)} holes=${String(run.holes).padStart(2)} ` +
      `points=${String(run.points).padStart(5)} area=${String(run.areaMm2).padStart(7)}mm²`,
  );
}

console.log('\n=== 去噪阈值扫描（lineart）===');
for (const step of results.sweep ?? []) {
  console.log(
    `despeckle=${String(step.despeckleAreaMm2).padEnd(5)}mm²  polygons=${String(step.polygons).padStart(2)} ` +
      `hole=${step.holes} points=${String(step.points).padStart(4)} area=${String(step.areaMm2).padStart(6)}mm² ` +
      `吞掉=${step.dropped} (最大 ${step.maxDroppedMm2}mm²) 最小保留=${step.minKeptMm2}mm²`,
  );
}

console.log('\n=== 阈值稳定性（软边剪影面积）===');
for (const run of results.runs.filter((r) => r.fixture === 'silhouette-aa')) {
  console.log(`  ${String(run.variantLabel).padEnd(16)} 阈值=${String(run.thresholdUsed).padEnd(5)} area=${run.areaMm2}mm²`);
}
console.log(`  手动三档极差倍数 = ${results.silhouetteSpread}x`);

console.log('\n=== 验收 ===');
for (const check of results.checks) console.log(`${check.ok ? 'PASS' : 'FAIL'}  ${check.name}  —  ${check.detail}`);
console.log(`\n对比图：out/trace-compare.png\n统计：out/trace-lab.json`);

ws.close();
process.exit(results.ok ? 0 : 1);
