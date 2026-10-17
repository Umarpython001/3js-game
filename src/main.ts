import * as THREE from 'three';
import './style.css';
import { createRestaurant } from './environment';
import { createWaiter } from './waiter';
import { createSpillFx } from './spill-fx';
import { getPlayer, watchPlayer, signInUrl } from './startng';

// ---------- Config ----------
const SPILL_THRESHOLD = 0.35; // rad of combined tilt that causes a spill
const SPILL_AMOUNTS = [1, 1, 2] as const; // percentage points lost per spill (1-2%, not 10%)
const SPILL_COOLDOWN = 0.9; // seconds between spill events (never one per frame)
const MOVE_SPEED = 6;
const BALANCE_SPEED = 1.6; // rad/s for Q/E
const TURN_RATE_REF = 8; // rad/s counted as a "sharp" turn
const ACCEL_REF = 36; // velocity impulse of an abrupt start/stop (frame-rate independent)
const ACCEL_SMOOTH = 6; // decay rate of the measured impulse (units/s)
const FLOOR_W = 22;
const FLOOR_L = 30;
const START_POS = new THREE.Vector3(0, 0, 12);
const TABLE_POS = new THREE.Vector3(0, 0, -12);

// ---------- Renderer / Scene ----------
const canvas = document.getElementById('game') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x241a13);
scene.fog = new THREE.FogExp2(0x3d2c1e, 0.016);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 200);

// ---------- Restaurant (floor, walls, tables, chairs, lights, decor) ----------
const restaurant = createRestaurant({ width: FLOOR_W, length: FLOOR_L, target: TABLE_POS });
scene.add(restaurant.root);

// ---------- Waiter (model + procedural walk animation) ----------
const waiter = createWaiter();
const player = waiter.root; // movement code owns player.position / rotation.y
const { trayGroup, soupMesh } = waiter;
player.position.copy(START_POS);
player.rotation.y = Math.PI; // face the table (-z)
scene.add(player);

// Spill visuals: droplets, puddle stains and a splash ring.
const spillFx = createSpillFx(scene);

const spillPos = new THREE.Vector3();

function spawnSpill() {
  waiter.soupWorldPosition(spillPos);
  spillFx.splash(spillPos, 0.7);
  spillFx.spawn(spillPos, 0.6);
}

// ---------- start.ng player character ----------
// Optional: falls back to the default waiter whenever start.ng does not answer.
function applyPlayer(playerInfo: Awaited<ReturnType<typeof getPlayer>>): void {
  if (playerInfo?.style) waiter.setStyle(playerInfo.style);
  const chip = document.getElementById('player-chip');
  const nameEl = document.getElementById('player-name');
  const signInEl = document.getElementById('player-signin') as HTMLAnchorElement | null;
  if (!chip || !nameEl) return;
  if (!playerInfo) {
    chip.classList.add('hidden');
    return;
  }
  nameEl.textContent = playerInfo.name;
  if (signInEl) {
    signInEl.hidden = playerInfo.signedIn;
    signInEl.href = signInUrl();
  }
  chip.classList.remove('hidden');
}
void getPlayer().then(applyPlayer);
watchPlayer(applyPlayer);

// ---------- Input ----------
const keys = new Set<string>();
window.addEventListener('keydown', (e) => {
  keys.add(e.key.toLowerCase());
  if (e.key.toLowerCase() === 'r') restart();
});
window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));

// ---------- UI ----------
const soupPctEl = document.getElementById('soup-pct')!;
const soupBarEl = document.getElementById('soup-bar')!;
const tiltEl = document.getElementById('tilt-pct')!;
const messageEl = document.getElementById('message')!;
const messageTextEl = document.getElementById('message-text')!;
document.getElementById('restart')!.addEventListener('click', restart);

// ---------- Game state ----------
let soup = 100;
let trayTilt = 0; // player-controlled roll (Q/E), radians
let slosh = 0; // smoothed soup lag
let sloshVel = 0;
let spillTimer = 0;
let gameOver: 'win' | 'lose' | null = null;
let elapsed = 0;
let prevVx = 0; // input velocity of the previous frame (abrupt stop/turn detection)
let prevVz = 0;
let accelImpulse = 0; // smoothed velocity impulse, decays over ~0.5 s

function restart() {
  soup = 100;
  trayTilt = 0;
  slosh = 0;
  sloshVel = 0;
  spillTimer = 0;
  prevVx = 0;
  prevVz = 0;
  accelImpulse = 0;
  gameOver = null;
  elapsed = 0;
  player.position.copy(START_POS);
  player.rotation.y = Math.PI; // face the table (-z)
  trayGroup.rotation.z = 0; // snap tray visual back (loop would only lerp it)
  soupMesh.rotation.set(-Math.PI / 2, 0, 0);
  soupMesh.scale.set(1, 1, 1);
  waiter.setSoupLevel(1);
  spillFx.clear();
  messageEl.classList.add('hidden');
  updateUI(0);
}

function updateUI(totalTilt: number) {
  soupPctEl.textContent = `${Math.max(0, Math.round(soup))}%`;
  soupBarEl.style.width = `${Math.max(0, soup)}%`;
  const deg = Math.round(Math.abs(totalTilt) * (180 / Math.PI));
  tiltEl.textContent = `${deg}°`;
  tiltEl.style.color = Math.abs(totalTilt) > SPILL_THRESHOLD * 0.7 ? '#ff6666' : '#ffdd88';
}

function endGame(result: 'win' | 'lose') {
  gameOver = result;
  messageTextEl.textContent =
    result === 'win'
      ? `🎉 You served the soup! ${Math.round(soup)}% left!`
      : `💦 All soup spilled! You lose.`;
  messageEl.classList.remove('hidden');
}

// ---------- Main loop ----------
const clock = new THREE.Clock();
// Follow camera: pulled in and lowered from the original (0, 8.5, 8.5) so the
// waiter reads clearly (verified with tools/cdp-shots.mjs, see §4 of the comms file).
// Still above the 5-unit ceiling line, so the cutaway tricks in environment.ts hold.
const camOffset = new THREE.Vector3(0, 6.6, 7.2);

function angleDiff(a: number, b: number): number {
  let diff = a - b;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return diff;
}

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  elapsed += dt;

  if (!gameOver) {
    const prevX = player.position.x;
    const prevZ = player.position.z;
    const prevYaw = player.rotation.y;

    // --- Movement (WASD / arrows), camera-relative = world axes ---
    let ix = 0;
    let iz = 0;
    if (keys.has('w') || keys.has('arrowup')) iz -= 1;
    if (keys.has('s') || keys.has('arrowdown')) iz += 1;
    if (keys.has('a') || keys.has('arrowleft')) ix -= 1;
    if (keys.has('d') || keys.has('arrowright')) ix += 1;
    const len = Math.hypot(ix, iz) || 1;
    const vx = (ix / len) * MOVE_SPEED;
    const vz = (iz / len) * MOVE_SPEED;
    const moving = ix !== 0 || iz !== 0;

    // Sudden start / stop / direction change: an impulse that decays smoothly.
    // (invDt is 0 when dt is 0, so a zero delta can never produce NaN.)
    const invDt = dt > 0 ? 1 / dt : 0;
    const instAccel = Math.hypot(vx - prevVx, vz - prevVz) * invDt;
    accelImpulse += (instAccel - accelImpulse) * Math.min(1, ACCEL_SMOOTH * dt);
    prevVx = vx;
    prevVz = vz;

    player.position.x = THREE.MathUtils.clamp(player.position.x + vx * dt, -FLOOR_W / 2 + 1, FLOOR_W / 2 - 1);
    player.position.z = THREE.MathUtils.clamp(player.position.z + vz * dt, -FLOOR_L / 2 + 1, FLOOR_L / 2 - 1);

    // Face movement direction
    if (moving) {
      const targetYaw = Math.atan2(vx, vz);
      const diff = angleDiff(targetYaw, player.rotation.y);
      player.rotation.y += diff * Math.min(1, 10 * dt);
    }

    // --- Waiter animation: legs, arms, body bob, turn banking ---
    // invDt guard (Agent B's 14:38 request): dt can be 0 on the first frame,
    // and 0/0 = NaN would poison the rig. invDt is defined in the block above.
    const speed = Math.hypot(player.position.x - prevX, player.position.z - prevZ) * invDt;
    const turnRate = angleDiff(player.rotation.y, prevYaw) * invDt;
    waiter.update(dt, { speed, turnRate, moving, lookAt: restaurant.target });

    // --- Tray balance (Q/E) ---
    if (keys.has('q')) trayTilt -= BALANCE_SPEED * dt;
    if (keys.has('e')) trayTilt += BALANCE_SPEED * dt;
    trayTilt = THREE.MathUtils.clamp(trayTilt, -0.5, 0.5);

    // --- Soup tilt simulation ---
    // Strafing induces roll; balance is player-controlled via Q/E.
    const moveTiltZ = moving ? THREE.MathUtils.clamp(-vx * 0.09, -0.45, 0.45) : 0;
    const totalTilt = trayTilt + moveTiltZ;

    // Smooth slosh spring for visual lag
    const target = THREE.MathUtils.clamp(-totalTilt * 0.8, -0.5, 0.5);
    sloshVel += (target - slosh) * 30 * dt;
    sloshVel *= 1 - 2.5 * dt;
    slosh += sloshVel * dt;

    // Animate tray + soup smoothly.
    // NOTE: soup is a uniform circle, so an in-plane spin (rotation.z) would be
    // invisible. Roll must go on rotation.y to visibly tilt the surface.
    trayGroup.rotation.z += (trayTilt - trayGroup.rotation.z) * Math.min(1, 12 * dt);
    soupMesh.rotation.y = slosh;
    soupMesh.rotation.x = -Math.PI / 2 + slosh * 0.4;
    // Shrink soup slightly as it depletes
    const s = 0.4 + 0.6 * (soup / 100);
    soupMesh.scale.set(s, s, 1);
    waiter.setSoupLevel(soup / 100);

    // --- Spilling ---
    // Pressure model: tilt dominates (so strafing/balance still matter), while
    // sharp turns and abrupt stops only cause a spill when the tray is already
    // noticeably off balance. Ordinary walking stays under the threshold.
    spillTimer -= dt;
    const tiltComponent = Math.abs(totalTilt) / SPILL_THRESHOLD; // 1.0 = at threshold
    const turnComponent = Math.min(1, Math.abs(turnRate) / TURN_RATE_REF);
    const accelComponent = Math.min(1, accelImpulse / ACCEL_REF);
    const maneuver = Math.max(turnComponent, accelComponent);
    const spillNow =
      spillTimer <= 0 &&
      (tiltComponent >= 1 || (tiltComponent >= 0.6 && maneuver >= 0.7));
    if (spillNow) {
      // Small spills: mostly 1%, occasionally 2%; a really hard jolt spills 2%.
      const hardEvent = tiltComponent >= 1.5 || maneuver >= 1;
      const amount = hardEvent ? 2 : SPILL_AMOUNTS[Math.floor(Math.random() * SPILL_AMOUNTS.length)];
      soup = THREE.MathUtils.clamp(soup - amount, 0, 100);
      spillTimer = SPILL_COOLDOWN;
      spawnSpill();
    }

    updateUI(totalTilt);

    // --- Win / lose ---
    const distToTable = player.position.distanceTo(restaurant.target);
    if (soup <= 0) {
      endGame('lose');
    } else if (distToTable < restaurant.targetRadius) {
      endGame('win');
    }
  }

  // --- Restaurant ambience + spill particles ---
  // camera.position lets the restaurant hide its near wall when the follow
  // camera is outside the room (optional third arg, see environment.ts).
  restaurant.update(dt, elapsed, camera.position);
  spillFx.update(dt);

  // --- Follow camera ---
  const desired = player.position.clone().add(camOffset);
  camera.position.lerp(desired, Math.min(1, 4 * dt));
  camera.lookAt(player.position.x, 1.2, player.position.z - 2);

  renderer.render(scene, camera);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

restart();
camera.position.copy(START_POS).add(camOffset); // avoid opening swoop from origin

// Read-only handle for the automated smoke test (tools/cdp-smoke.mjs).
// Exposes state only; it can never change how the game plays.
(window as unknown as { __soupGame?: object }).__soupGame = {
  get position() {
    const p = player.position;
    return { x: p.x, y: p.y, z: p.z };
  },
  get soup() {
    return soup;
  },
  get state() {
    return gameOver;
  },
};

// Diagnostics, only with ?debug — never active in normal play.
if (new URLSearchParams(location.search).has('debug')) {
  (window as unknown as { __soupDebug?: object }).__soupDebug = { camera, player, scene, renderer };
}

animate();
