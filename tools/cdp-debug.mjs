/**
 * Debug probe (?debug): inspects why the waiter may not render — layers,
 * culling, draw calls, NDC projection. Run against a ?debug build.
 *   "/mnt/c/Program Files/nodejs/node.exe" tools\cdp-debug.mjs
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = (process.env.SMOKE_URL ?? 'http://localhost:4173/') + '?debug';
const PORT = 9770 + (process.pid % 20);

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(os.tmpdir(), `soup-dbg-${Date.now()}`)}`,
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
const evaluate = async (expression, awaitPromise = false) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
};

const INFO = `(() => {
  const d = window.__soupDebug; if (!d) return 'NO DEBUG HANDLE';
  const { camera, player, scene, renderer } = d;
  let mesh = null, meshes = 0;
  player.traverse((o) => { if (o.isMesh) { meshes++; if (!mesh) mesh = o; } });
  return JSON.stringify({
    cam: camera.position.toArray().map((n) => +n.toFixed(2)),
    player: player.position.toArray().map((n) => +n.toFixed(2)),
    playerVisible: player.visible,
    parent: player.parent && player.parent.type,
    playerLayers: player.layers.mask,
    camLayers: camera.layers.mask,
    meshes,
    firstMesh: mesh ? {
      name: mesh.name || '(anon)',
      frustumCulled: mesh.frustumCulled,
      layers: mesh.layers.mask,
      visible: mesh.visible,
      matVisible: mesh.material.visible,
      opacity: mesh.material.opacity,
      colorWrite: mesh.material.colorWrite,
      matType: mesh.material.type,
      sphere: mesh.geometry.boundingSphere
        ? { c: mesh.geometry.boundingSphere.center.toArray().map((n) => +n.toFixed(2)), r: +mesh.geometry.boundingSphere.radius.toFixed(2) }
        : 'null',
    } : null,
    ndc: player.position.clone().setY(1.2).project(camera).toArray().map((n) => +n.toFixed(3)),
    render: { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles },
    sceneChildren: scene.children.length,
  });
})()`;

const CALLS = `(async () => {
  const { player, renderer } = window.__soupDebug;
  const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  await frame();
  const withW = renderer.info.render.calls;
  player.visible = false;
  await frame();
  const withoutW = renderer.info.render.calls;
  player.visible = true;
  await frame();
  const back = renderer.info.render.calls;
  return JSON.stringify({ withW, withoutW, back });
})()`;

const SHOT_DIR = process.env.SHOT_DIR ?? path.join(os.tmpdir(), 'soup-dbg-shots');

const SUSPECTS = `(() => {
  const { scene, camera, player } = window.__soupDebug;
  const out = [];
  scene.traverse((o) => {
    if (!o.isMesh) return;
    // visible chain
    let v = true, n = o;
    while (n) { if (!n.visible) { v = false; break; } n = n.parent; }
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m) continue;
      const odd = m.depthTest === false || m.colorWrite === false || (m.transparent === true && m.depthWrite !== false && m.opacity >= 0.99);
      if (!odd) continue;
      const p = o.getWorldPosition(player.position.clone());
      out.push({
        visibleInGraph: v,
        pos: p.toArray().map((x) => +x.toFixed(2)),
        distToCam: +p.distanceTo(camera.position).toFixed(2),
        depthTest: m.depthTest,
        depthWrite: m.depthWrite,
        colorWrite: m.colorWrite,
        transparent: m.transparent,
        opacity: m.opacity,
        type: m.type,
        geo: o.geometry && o.geometry.type,
        parentVisible: o.parent && o.parent.visible,
      });
    }
  });
  out.sort((a, b) => a.distToCam - b.distToCam);
  return JSON.stringify(out.slice(0, 25));
})()`;

const NEAR_START = `(() => {
  const { scene, camera, player } = window.__soupDebug;
  const out = [];
  scene.traverse((o) => {
    if (!o.isMesh) return;
    const p = o.getWorldPosition(player.position.clone());
    const camDist = p.distanceTo(camera.position);
    if (camDist > 40) return;
    // world-space bounding box height extent
    o.geometry.computeBoundingBox();
    const bb = o.geometry.boundingBox;
    out.push({
      geo: o.geometry.type,
      pos: p.toArray().map((x) => +x.toFixed(2)),
      bbMin: bb.min.toArray().map((x) => +x.toFixed(2)),
      bbMax: bb.max.toArray().map((x) => +x.toFixed(2)),
      scale: o.scale.toArray().map((x) => +x.toFixed(2)),
      camDist,
      color: o.material && o.material.color ? '#' + o.material.color.getHexString() : '?',
      transparent: o.material ? !!o.material.transparent : '?',
    });
  });
  out.sort((a, b) => a.camDist - b.camDist);
  return JSON.stringify(out.slice(0, 40));
})()`;

try {
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: BASE });
  await sleep(3000);
  console.log('INFO:', await evaluate(INFO));
  console.log('CALLS:', await evaluate(CALLS, true));
  console.log('SUSPECTS:', await evaluate(SUSPECTS));
  console.log('NEAR_START:', await evaluate(NEAR_START));

  const shot = async (name) => {
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(SHOT_DIR, name);
    writeFileSync(file, Buffer.from(data, 'base64'));
    console.log('shot', file);
  };
  mkdirSync(SHOT_DIR, { recursive: true });

  // Baseline: full scene
  await sleep(300);
  await shot('scan-00-baseline.png');

  // Hide one top-level scene child at a time; the shot where the waiter appears
  // identifies the occluder.
  const kidsJson = await evaluate(`(() => {
    const { scene, player } = window.__soupDebug;
    const kids = scene.children.filter((c) => c !== player && !c.isLight && c.visible);
    window.__scanKids = kids;
    return JSON.stringify(kids.map((k, i) => ({ i, type: k.type, name: k.name || '', pos: k.position.toArray().map((n) => +n.toFixed(1)) })));
  })()`);
  console.log('KIDS:', kidsJson);
  const count = JSON.parse(kidsJson).length;
  for (let i = 0; i < count; i++) {
    await evaluate(`(() => { const k = window.__scanKids; k.forEach((c, j) => { c.visible = j !== ${i}; }); return 'ok'; })()`);
    await sleep(250);
    await shot(`scan-${String(i + 1).padStart(2, '0')}-hide.png`);
  }
  await evaluate(`(() => { window.__scanKids.forEach((c) => { c.visible = true; }); return 'restored'; })()`);

  // 1) only the waiter + lights visible: is it drawn where nothing can hide it?
  console.log('isolated:', await evaluate(`(() => {
    const { player, scene } = window.__soupDebug;
    const hidden = [];
    for (const c of scene.children) {
      if (c === player || c.isLight) continue;
      if (c.visible) { hidden.push(c); c.visible = false; }
    }
    window.__hidden = hidden;
    return hidden.length;
  })()`, true));
  await sleep(400);
  await shot('dbg-isolated.png');
  console.log('restored:', await evaluate(`(() => {
    for (const c of window.__hidden) c.visible = true;
    window.__hidden.length = 0;
    return 'ok';
  })()`));

  // 2) full scene but the waiter ignores depth: does it appear on top?
  console.log('depthTest off:', await evaluate(`(() => {
    const { player } = window.__soupDebug;
    let n = 0;
    player.traverse((o) => { if (o.isMesh && o.material) { o.material.depthTest = false; n++; } });
    return n;
  })()`));
  await sleep(400);
  await shot('dbg-nodepth.png');
} catch (e) {
  console.error('probe error:', e);
} finally {
  ws?.close();
  chrome.kill();
}
