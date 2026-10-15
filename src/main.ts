import * as THREE from 'three';
import './style.css';

// ---------- Config ----------
const SPILL_THRESHOLD = 0.35; // rad of combined tilt that causes a spill
const SPILL_AMOUNT = 10; // percentage points lost per spill
const SPILL_COOLDOWN = 1.0; // seconds
const MOVE_SPEED = 6;
const BALANCE_SPEED = 1.6; // rad/s for Q/E
const FLOOR_W = 22;
const FLOOR_L = 30;
const START_POS = new THREE.Vector3(0, 0, 12);
const TABLE_POS = new THREE.Vector3(0, 0, -12);

// ---------- Renderer / Scene ----------
const canvas = document.getElementById('game') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87ceeb);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 200);

scene.add(new THREE.AmbientLight(0xffffff, 0.7));
const sun = new THREE.DirectionalLight(0xffffff, 1.0);
sun.position.set(8, 15, 8);
sun.castShadow = true;
scene.add(sun);

// ---------- Kitchen: floor + table ----------
const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(FLOOR_W, FLOOR_L),
  new THREE.MeshLambertMaterial({ color: 0xf5deb3 })
);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

// Simple tile lines for kitchen feel
const grid = new THREE.GridHelper(Math.max(FLOOR_W, FLOOR_L), 22, 0xcc9966, 0xddbb88);
grid.position.y = 0.01;
scene.add(grid);

// Table at far end (target)
const table = new THREE.Group();
const woodMat = new THREE.MeshLambertMaterial({ color: 0x8b5a2b });
const tableTop = new THREE.Mesh(new THREE.BoxGeometry(5, 0.4, 2.5), woodMat);
tableTop.position.y = 1.0;
tableTop.castShadow = true;
table.add(tableTop);
const legGeo = new THREE.BoxGeometry(0.3, 1.0, 0.3);
for (const [lx, lz] of [[-2.2, -1], [2.2, -1], [-2.2, 1], [2.2, 1]] as const) {
  const leg = new THREE.Mesh(legGeo, woodMat);
  leg.position.set(lx, 0.5, lz);
  table.add(leg);
}
// Tablecloth marker / target zone
const zone = new THREE.Mesh(
  new THREE.RingGeometry(1.4, 2.0, 32),
  new THREE.MeshBasicMaterial({ color: 0x00cc44, side: THREE.DoubleSide })
);
zone.rotation.x = -Math.PI / 2;
zone.position.y = 0.02;
table.add(zone);
table.position.copy(TABLE_POS);
scene.add(table);

// Back wall for kitchen feel
const wall = new THREE.Mesh(
  new THREE.BoxGeometry(FLOOR_W, 5, 0.5),
  new THREE.MeshLambertMaterial({ color: 0xffe4c4 })
);
wall.position.set(0, 2.5, -FLOOR_L / 2 - 0.5);
scene.add(wall);

// ---------- Cartoon chef ----------
const chef = new THREE.Group();

const skinMat = new THREE.MeshLambertMaterial({ color: 0xffcc99 });
const coatMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
const hatMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
const pantsMat = new THREE.MeshLambertMaterial({ color: 0x333388 });

const body = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.7, 1.2, 16), coatMat);
body.position.y = 1.1;
body.castShadow = true;
chef.add(body);

const head = new THREE.Mesh(new THREE.SphereGeometry(0.42, 20, 16), skinMat);
head.position.y = 2.0;
head.castShadow = true;
chef.add(head);

// Eyes
const eyeMat = new THREE.MeshBasicMaterial({ color: 0x222222 });
for (const ex of [-0.15, 0.15]) {
  const eye = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 8), eyeMat);
  eye.position.set(ex, 2.05, 0.36);
  chef.add(eye);
}

// Chef hat: brim + puffy top
const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 0.15, 16), hatMat);
brim.position.y = 2.35;
chef.add(brim);
const puff = new THREE.Mesh(new THREE.SphereGeometry(0.42, 16, 12), hatMat);
puff.position.y = 2.65;
puff.scale.y = 0.8;
chef.add(puff);

// Legs
for (const lx of [-0.25, 0.25]) {
  const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.6, 10), pantsMat);
  leg.position.set(lx, 0.3, 0);
  chef.add(leg);
}

// Arms reaching forward holding tray
const armGeo = new THREE.CylinderGeometry(0.13, 0.13, 0.9, 10);
for (const ax of [-0.5, 0.5]) {
  const arm = new THREE.Mesh(armGeo, coatMat);
  arm.position.set(ax, 1.35, 0.45);
  arm.rotation.x = Math.PI / 2 - 0.25;
  chef.add(arm);
}

// ---------- Tray + bowl + soup (attached to chef) ----------
const trayGroup = new THREE.Group();
trayGroup.position.set(0, 1.45, 1.1); // held in front of chef
chef.add(trayGroup);

const tray = new THREE.Mesh(
  new THREE.CylinderGeometry(0.85, 0.85, 0.08, 24),
  new THREE.MeshLambertMaterial({ color: 0xcccccc })
);
tray.castShadow = true;
trayGroup.add(tray);

const bowl = new THREE.Mesh(
  new THREE.CylinderGeometry(0.55, 0.35, 0.35, 20),
  new THREE.MeshLambertMaterial({ color: 0x2266cc })
);
bowl.position.y = 0.22;
trayGroup.add(bowl);

// Soup surface: orange circle inside bowl
const soupMesh = new THREE.Mesh(
  new THREE.CircleGeometry(0.48, 24),
  new THREE.MeshLambertMaterial({ color: 0xff5500 })
);
soupMesh.rotation.x = -Math.PI / 2;
soupMesh.position.y = 0.40; // level with the rim so the surface stays visible
trayGroup.add(soupMesh);

chef.position.copy(START_POS);
scene.add(chef);

// Spill droplets pool (simple visual: orange spheres that fall and fade)
const droplets: { mesh: THREE.Mesh; vel: number; life: number }[] = [];
const dropletGeo = new THREE.SphereGeometry(0.09, 8, 8);
const dropletMat = new THREE.MeshBasicMaterial({ color: 0xff5500 });

function spawnSpill() {
  for (let i = 0; i < 6; i++) {
    const m = new THREE.Mesh(dropletGeo, dropletMat);
    const worldPos = new THREE.Vector3();
    soupMesh.getWorldPosition(worldPos);
    m.position.copy(worldPos);
    m.position.x += (Math.random() - 0.5) * 0.6;
    m.position.z += (Math.random() - 0.5) * 0.6;
    scene.add(m);
    droplets.push({ mesh: m, vel: 0, life: 1.2 });
  }
}

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

function restart() {
  soup = 100;
  trayTilt = 0;
  slosh = 0;
  sloshVel = 0;
  spillTimer = 0;
  gameOver = null;
  elapsed = 0;
  chef.position.copy(START_POS);
  chef.rotation.y = Math.PI; // face the table (-z)
  trayGroup.rotation.z = 0; // snap tray visual back (loop would only lerp it)
  soupMesh.rotation.set(-Math.PI / 2, 0, 0);
  soupMesh.scale.set(1, 1, 1);
  for (const d of droplets) scene.remove(d.mesh);
  droplets.length = 0;
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
const camOffset = new THREE.Vector3(0, 8.5, 8.5);

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  elapsed += dt;

  if (!gameOver) {
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

    chef.position.x = THREE.MathUtils.clamp(chef.position.x + vx * dt, -FLOOR_W / 2 + 1, FLOOR_W / 2 - 1);
    chef.position.z = THREE.MathUtils.clamp(chef.position.z + vz * dt, -FLOOR_L / 2 + 1, FLOOR_L / 2 - 1);

    // Face movement direction
    if (moving) {
      const targetYaw = Math.atan2(vx, vz);
      let diff = targetYaw - chef.rotation.y;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      chef.rotation.y += diff * Math.min(1, 10 * dt);
    }

    // --- Tray balance (Q/E) ---
    if (keys.has('q')) trayTilt -= BALANCE_SPEED * dt;
    if (keys.has('e')) trayTilt += BALANCE_SPEED * dt;
    trayTilt = THREE.MathUtils.clamp(trayTilt, -0.5, 0.5);

    // --- Soup tilt simulation ---
    // Strafing induces roll; wobble forces constant small corrections.
    const moveTiltZ = moving ? THREE.MathUtils.clamp(-vx * 0.09, -0.45, 0.45) : 0;
    const wobble = Math.sin(elapsed * 2.5) * 0.06 + Math.sin(elapsed * 3.7) * 0.04;
    const totalTilt = trayTilt + moveTiltZ + wobble;

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

    // --- Spilling ---
    spillTimer -= dt;
    if (Math.abs(totalTilt) > SPILL_THRESHOLD && spillTimer <= 0) {
      soup = Math.max(0, soup - SPILL_AMOUNT);
      spillTimer = SPILL_COOLDOWN;
      spawnSpill();
    }

    updateUI(totalTilt);

    // --- Win / lose ---
    const distToTable = chef.position.distanceTo(TABLE_POS);
    if (soup <= 0) {
      endGame('lose');
    } else if (distToTable < 2.6) {
      endGame('win');
    }
  }

  // --- Droplets fall ---
  for (let i = droplets.length - 1; i >= 0; i--) {
    const d = droplets[i];
    d.vel += 12 * dt;
    d.mesh.position.y -= d.vel * dt;
    d.life -= dt;
    if (d.mesh.position.y < 0.05 || d.life <= 0) {
      scene.remove(d.mesh);
      droplets.splice(i, 1);
    }
  }

  // --- Follow camera ---
  const desired = chef.position.clone().add(camOffset);
  camera.position.lerp(desired, Math.min(1, 4 * dt));
  camera.lookAt(chef.position.x, 1.2, chef.position.z - 2);

  renderer.render(scene, camera);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

restart();
camera.position.copy(START_POS).add(camOffset); // avoid opening swoop from origin
animate();
