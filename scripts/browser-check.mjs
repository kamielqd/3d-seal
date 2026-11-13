/**
 * 浏览器端验收：真等一段时间，读页面文本 + Worker console，判断几何是否真的生成出来。
 *
 * 为什么不用 `chrome --headless --dump-dom --virtual-time-budget=25000`：
 * 虚拟时钟会把 15s 的超时定时器快进，而 wasm 的 fetch/实例化是真实的异步 I/O，
 * 于是 dump 会抢在真实结果之前，永远看到「几何生成超时」——假阴性。
 * 这里用 CDP 连真实时钟，等够时间再取 document.body.innerText。
 *
 * 用法（先起预览 + 带调试端口的 chrome）：
 *   node node_modules/vite/bin/vite.js preview --port 4173 --strictPort
 *   chrome --headless=new --no-sandbox --enable-unsafe-swiftshader --remote-debugging-port=9222 --user-data-dir=%TEMP%\cdp-seal about:blank
 *   node scripts/browser-check.mjs [url] [waitMs] [port]
 *
 * 退出码：0 = 页面出现「N 三角面 · NoError」；1 = 没出现（会打印 console 便于定位）。
 */

const url = process.argv[2] ?? 'http://127.0.0.1:4173/';
const waitMs = Number(process.argv[3] ?? 20000);
const port = Number(process.argv[4] ?? 9222);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function findPage() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page !== undefined) return page;
    } catch {
      /* chrome 还没起来 */
    }
    await sleep(250);
  }
  throw new Error(`CDP ${port} 上没有可用的 page target`);
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
  if (message.method === 'Log.entryAdded') {
    logs.push(`[${message.params.entry.level}] ${message.params.entry.text}`);
  }
  if (message.method === 'Runtime.exceptionThrown') {
    logs.push(`[exception] ${message.params.exceptionDetails?.text ?? ''} ${message.params.exceptionDetails?.exception?.description ?? ''}`);
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
await send('Log.enable');
await send('Page.enable');
await send('Page.navigate', { url });

await sleep(waitMs);

const evaluated = await send('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true });
const text = evaluated.result?.result?.value ?? '';

console.log('=== console ===');
for (const line of logs) console.log(line);

const statusLine = text.split('\n').map((l) => l.trim()).find((l) => /三角面|超时|失败/.test(l)) ?? '(没有状态行)';
console.log('=== 状态 ===');
console.log(statusLine);

const ok = /[0-9]+\s*三角面\s*·\s*NoError/.test(statusLine);
console.log(ok ? '\nPASS' : '\nFAIL');

ws.close();
process.exit(ok ? 0 : 1);
