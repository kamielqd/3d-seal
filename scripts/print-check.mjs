/**
 * 打印校验验收：用 CDP 真在 Chrome 里跑 lab/print-check.html，取回每组的校验结果。
 *
 * 用法（先构建 lab、起预览、起带调试端口的 chrome）：
 *   node node_modules/vite/bin/vite.js build --config vite.lab.config.ts
 *   node node_modules/vite/bin/vite.js preview --config vite.lab.config.ts --port 4174 --strictPort
 *   chrome --headless=new --no-sandbox --enable-unsafe-swiftshader --remote-debugging-port=9224 --user-data-dir=%TEMP%\cdp-print about:blank
 *   node scripts/print-check.mjs http://localhost:4174/print-check.html 120000 9224
 *
 * 产物：out/print-check.json
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const url = process.argv[2] ?? 'http://localhost:4174/print-check.html';
const timeoutMs = Number(process.argv[3] ?? 120000);
const port = Number(process.argv[4] ?? 9224);

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
    expression: 'window.__PRINT_RESULTS__ ?? null',
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
  console.error('超时：页面没有产出 __PRINT_RESULTS__');
  const text = await send('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true });
  console.error(text.result?.result?.value ?? '');
  process.exit(1);
}

if (results.error !== undefined) {
  console.error('页面报错：', results.error);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'print-check.json'), JSON.stringify(results, null, 2));

console.log('\n=== 每组校验结果 ===');
for (const run of results.results) {
  const rules = run.violations.map((v) => `${v.severity}:${v.rule}(${v.measured})`).join(' ') || '无';
  console.log(`${run.label.padEnd(18)} ${String(run.triangles).padStart(5)} 面 ${run.status} ${String(run.ms).padStart(5)}ms  块=${run.polygons}`);
  console.log(`   ${rules}`);
}

console.log('\n=== 验收 ===');
for (const check of results.checks) console.log(`${check.ok ? 'PASS' : 'FAIL'}  ${check.name}  —  ${check.detail}`);
console.log('\n统计：out/print-check.json');

ws.close();
process.exit(results.ok ? 0 : 1);
