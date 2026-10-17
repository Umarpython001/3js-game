/**
 * Headless gameplay smoke test for "Don't Spill the Soup!".
 *
 * Drives the production build (vite preview) in Windows Chrome over the
 * Chrome DevTools Protocol using Node's built-in fetch/WebSocket.
 * Run from the project root:
 *   npm run preview -- --port 4173 --strictPort &
 *   "/mnt/c/Program Files/nodejs/node.exe" tools\cdp-smoke.mjs
 *
 * Checks: page loads with no console/page errors, walking does not spill,
 * strafing/tilting spills only 1-2 points at a time (cooldown), reaching the
 * table wins, restart resets, running the soup dry loses, R restarts.
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.SMOKE_URL ?? 'http://localhost:4173/';
const PORT = 9333 + (process.pid % 500);
const results = [];
const errors = [];

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  ok ? pass++ : fail++;
}

// ---------- preflight: is the preview server reachable from Windows? ----------
let reachable = false;
for (const url of [BASE, 'http://127.0.0.1:4173/', 'http://localhost:4173/']) {
  try {
    const r = await fetch(url, { method: 'GET' });
    if (r.ok) { reachable = true; break; }
  } catch { /* try next */ }
}
if (!reachable) {
  console.error('SMOKE ABORT: preview server not reachable (run: npm run preview -- --port 4173 --strictPort)');
  process.exit(2);
}

// ---------- launch headless chrome ----------
const profile = path.join(os.tmpdir(), `soup-smoke-${Date.now()}`);
const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--enable-unsafe-swiftshader',
  '--window-size=1280,800',
  'about:blank',
], { stdio: 'ignore' });

const kill = () => { try { chrome.kill(); } catch { /* already gone */ } };
process.on('exit', kill);

// ---------- connect over CDP ----------
let ws;
let msgId = 0;
const pending = new Map();
const eventHandlers = [];

for (let i = 0; i < 50 && !ws; i++) {
  await sleep(200);
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    if (page) ws = new WebSocket(page.webSocketDebuggerUrl);
  } catch { /* chrome not up yet */ }
}
if (!ws) { console.error('SMOKE ABORT: could not connect to Chrome CDP'); process.exit(2); }
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(m.error.message)) : resolve(m.result);
  } else if (m.method) {
    for (const h of eventHandlers) h(m.method, m.params);
  }
};

function send(method, params = {}) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description ?? ''));
  return r.result.value;
};

const key = async (type, k, code, vk) =>
  send('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });

const press = async (k, code, vk) => { await key('keyDown', k, code, vk); };
const release = async (k, code, vk) => { await key('keyUp', k, code, vk); };

const HOLD = { w: ['w', 'KeyW', 87], a: ['a', 'KeyA', 65], s: ['s', 'KeyS', 83], d: ['d', 'KeyD', 68], e: ['e', 'KeyE', 69], q: ['q', 'KeyQ', 81], r: ['r', 'KeyR', 82] };
const hold = (k) => press(...HOLD[k]);
const letGo = (k) => release(...HOLD[k]);

const snapshot = () => evaluate(`(() => {
  const g = (id) => document.getElementById(id);
  const msg = g('message');
  return {
    pct: g('soup-pct')?.textContent,
    bar: g('soup-bar')?.style.width,
    tilt: g('tilt-pct')?.textContent,
    messageShown: msg ? !msg.classList.contains('hidden') : null,
    messageText: g('message-text')?.textContent ?? '',
    chipHidden: g('player-chip')?.classList.contains('hidden') ?? null,
    canvas: !!g('game'),
  };
})()`);

// read-only game handle exposed by main.ts for testing
const game = () => evaluate(`window.__soupGame ? { pos: window.__soupGame.position, soup: window.__soupGame.soup, state: window.__soupGame.state } : null`);

const pct = async () => Number((await snapshot()).pct?.replace('%', ''));

// collect console errors / page exceptions
eventHandlers.push((method, params) => {
  if (method === 'Runtime.exceptionThrown') {
    errors.push(`exception: ${params.exceptionDetails.text} ${params.exceptionDetails.exception?.description ?? ''}`);
  }
  if (method === 'Runtime.consoleAPICalled' && params.type === 'error') {
    errors.push(`console.error: ${params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`);
  }
  if (method === 'Log.entryAdded' && params.entry.level === 'error') {
    errors.push(`log: ${params.entry.text}`);
  }
});

try {
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: BASE });
  await sleep(2500);

  // --- 1. load sanity ---
  const s0 = await snapshot();
  check('page loads (canvas + HUD present)', s0.canvas && s0.pct === '100%', JSON.stringify(s0));
  check('local play has no player (chip hidden, game still runs)', s0.chipHidden === true, `chipHidden=${s0.chipHidden}`);

  // --- 2. ordinary walking must not spill and must actually move the waiter ---
  const posBefore = await game();
  await hold('w');
  await sleep(2000);
  const pctWalk = await pct();
  const posAfter = await game();
  check('walking forward moves the waiter toward the table',
    !!posBefore && !!posAfter && posAfter.pos.z < posBefore.pos.z - 5,
    `z ${posBefore?.pos.z?.toFixed(1)} -> ${posAfter?.pos.z?.toFixed(1)}`);
  check('walking forward loses no soup', pctWalk === 100, `soup=${pctWalk}%`);
  await letGo('w');
  await sleep(300);

  // --- 3. strafing tilts the tray and spills 1-2 points only ---
  const pctBeforeStrafe = await pct();
  await hold('a');
  await sleep(700);
  const tiltStrafe = await evaluate(`document.getElementById('tilt-pct').textContent`);
  check('strafing shows tray tilt', Number.parseInt(tiltStrafe) > 0, `tilt=${tiltStrafe}`);
  await letGo('a');
  await sleep(400);
  const pctAfterStrafe = await pct();
  const lostStrafe = pctBeforeStrafe - pctAfterStrafe;
  check('a spill removes 1-2 points (not 10)', lostStrafe >= 1 && lostStrafe <= 2, `lost=${lostStrafe} (${pctBeforeStrafe}% -> ${pctAfterStrafe}%)`);

  // --- 4. tilt key spills gradually with cooldown (never drains in one frame) ---
  await hold('e');
  await sleep(1300);
  const pctTilt = await pct();
  await letGo('e');
  const lostTilt = pctAfterStrafe - pctTilt;
  check('sustained tilt loses only a few points per second', lostTilt >= 1 && lostTilt <= 6, `lost=${lostTilt} over 1.3s -> ${pctTilt}%`);

  // --- 5. reaching the table wins (restart first so the path is straight) ---
  await evaluate(`document.getElementById('restart').click()`);
  await sleep(300);
  await hold('w');
  let won = false;
  let lastPos = null;
  for (let i = 0; i < 40 && !won; i++) {
    await sleep(250);
    const s = await snapshot();
    lastPos = await game();
    won = s.messageShown && s.messageText.includes('served');
  }
  await letGo('w');
  check('walking to the table triggers the win', won,
    won ? 'win message shown' : `no win after 10s (pos=${JSON.stringify(lastPos?.pos)}, state=${lastPos?.state})`);
  const winSnap = await snapshot();
  check('win keeps remaining soup in the message', /(\d+)% left/.test(winSnap.messageText), winSnap.messageText);

  // --- 6. restart button resets everything ---
  await evaluate(`document.getElementById('restart').click()`);
  await sleep(400);
  const sRestart = await snapshot();
  check('restart resets soup to 100% and hides the message', sRestart.pct === '100%' && !sRestart.messageShown, JSON.stringify(sRestart));

  // --- 7. running dry loses ---
  await hold('e');
  await hold('a');
  let lost = false;
  for (let i = 0; i < 120 && !lost; i++) {
    await sleep(1000);
    const s = await snapshot();
    if (s.messageShown) lost = s.messageText.includes('spilled');
    if (i === 30 && !lost) {
      const p = await pct();
      if (p >= 100) { errors.push('soup did not drop at all during 30s of hard tilt+strafe'); break; }
    }
  }
  await letGo('e');
  await letGo('a');
  check('losing every drop triggers the lose message', lost, lost ? 'lose message shown' : 'never reached 0%');

  // --- 8. keyboard restart (R) ---
  await press('r', 'KeyR', 82);
  await sleep(150);
  await release('r', 'KeyR', 82);
  await sleep(300);
  const sFinal = await snapshot();
  check('R key restarts the game', sFinal.pct === '100%' && !sFinal.messageShown, JSON.stringify(sFinal));
} catch (e) {
  errors.push(`harness: ${e?.stack ?? e}`);
} finally {
  check('no console/page errors', errors.length === 0, errors.slice(0, 5).join(' | '));
  console.log('\n=== SMOKE TEST RESULTS ===');
  for (const r of results) console.log(r);
  console.log(`\n${pass} passed, ${fail} failed`);
  if (errors.length) { console.log('\nErrors:'); for (const e of errors) console.log(' - ' + e); }
  ws?.close();
  kill();
  process.exit(fail === 0 ? 0 : 1);
}
