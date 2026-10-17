/**
 * Diagnostic probe: loads the game, captures EVERY console message (the waiter
 * module logs its first N frames), and reports scene state for debugging.
 * Run: "/mnt/c/Program Files/nodejs/node.exe" tools\cdp-probe.mjs
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.SMOKE_URL ?? 'http://localhost:4173/';
const PORT = 9700 + (process.pid % 90);

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(os.tmpdir(), `soup-probe-${Date.now()}`)}`,
  '--no-first-run', '--no-default-browser-check', '--enable-unsafe-swiftshader',
  '--window-size=1280,800', 'about:blank',
], { stdio: 'ignore' });
process.on('exit', () => { try { chrome.kill(); } catch { /* gone */ } });

let ws;
for (let i = 0; i < 50 && !ws; i++) {
  await sleep(200);
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    if (page) ws = new WebSocket(page.webSocketDebuggerUrl);
  } catch { /* not up */ }
}
if (!ws) { console.error('CDP unreachable'); process.exit(2); }
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 0;
const pending = new Map();
const logs = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(m.error.message)) : resolve(m.result);
  } else if (m.method === 'Runtime.consoleAPICalled') {
    logs.push(`[${m.params.type}] ` + m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
  } else if (m.method === 'Runtime.exceptionThrown') {
    logs.push(`[exception] ${m.params.exceptionDetails.text} ${m.params.exceptionDetails.exception?.description ?? ''}`);
  }
};
const send = (method, params = {}) => {
  const reqId = ++id;
  ws.send(JSON.stringify({ id: reqId, method, params }));
  return new Promise((resolve, reject) => pending.set(reqId, { resolve, reject }));
};

try {
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: BASE });
  await sleep(3000);
  const ev = await send('Runtime.evaluate', {
    returnByValue: true,
    expression: `JSON.stringify({
      game: window.__soupGame ? { pos: window.__soupGame.position, soup: window.__soupGame.soup } : null,
      canvasSize: (() => { const c = document.getElementById('game'); return c ? [c.width, c.height] : null; })(),
    })`,
  });
  console.log('state:', ev.result.value);
} finally {
  console.log('--- console messages ---');
  for (const l of logs.slice(0, 60)) console.log(l);
  console.log(`(${logs.length} total)`);
  ws?.close();
  chrome.kill();
}
