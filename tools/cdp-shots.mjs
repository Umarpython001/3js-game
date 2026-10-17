/**
 * Captures gameplay screenshots through the Chrome DevTools Protocol so the
 * agent can visually verify the restaurant, the waiter and the walk pose.
 * Run: npm run preview -- --port 4173 --strictPort &
 *      "/mnt/c/Program Files/nodejs/node.exe" tools\cdp-shots.mjs
 * Output: /tmp/opencode/shots/*.png (or $SHOT_DIR)
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.SMOKE_URL ?? 'http://localhost:4173/';
const PORT = 9900 + (process.pid % 80);
const OUT = process.env.SHOT_DIR ?? path.join(os.tmpdir(), 'soup-shots');
mkdirSync(OUT, { recursive: true });

const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(os.tmpdir(), `soup-shots-${Date.now()}`)}`,
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
  } catch { /* not up yet */ }
}
if (!ws) { console.error('cannot reach CDP'); process.exit(2); }
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(m.error.message)) : resolve(m.result);
  }
};
const send = (method, params = {}) => {
  const reqId = ++id;
  ws.send(JSON.stringify({ id: reqId, method, params }));
  return new Promise((resolve, reject) => pending.set(reqId, { resolve, reject }));
};
const key = (type, k, code, vk) => send('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });

async function shot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(OUT, name);
  writeFileSync(file, Buffer.from(data, 'base64'));
  console.log('saved', file);
}

try {
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: BASE });
  await sleep(2500);
  await shot('01-start.png');

  // walking pose (mid-stride)
  await key('keyDown', 'w', 'KeyW', 87);
  await sleep(950);
  await shot('02-walking.png');
  await key('keyUp', 'w', 'KeyW', 87);

  // turn/strafe to see the tray tilt
  await key('keyDown', 'a', 'KeyA', 65);
  await sleep(500);
  await shot('03-strafe-tilt.png');
  await key('keyUp', 'a', 'KeyA', 65);
  await sleep(200);

  // walk to the destination table and capture the win (restart first so the
  // path is straight — the strafe step above moves the waiter sideways)
  await send('Runtime.evaluate', { expression: `document.getElementById('restart').click()` });
  await sleep(300);
  await key('keyDown', 'w', 'KeyW', 87);
  await sleep(4200);
  await shot('04-at-table.png');
  await key('keyUp', 'w', 'KeyW', 87);
  await sleep(500);
  await shot('05-win.png');

  const state = await send('Runtime.evaluate', {
    expression: 'JSON.stringify({pos: window.__soupGame.position, soup: window.__soupGame.soup, state: window.__soupGame.state})',
    returnByValue: true,
  });
  console.log('state:', state.result.value);
} catch (e) {
  console.error('shot harness error:', e);
  process.exitCode = 1;
} finally {
  ws?.close();
  chrome.kill();
}
