import * as THREE from 'three';
import { floorTexture, wallTexture, woodTexture, glowTexture } from './textures';

export interface RestaurantOptions {
  /** Room width (x) and length (z) in world units. */
  width: number;
  length: number;
  /** Floor position of the destination table. */
  target: THREE.Vector3;
}

export interface Restaurant {
  /** Everything the restaurant is made of; add this to the scene. */
  root: THREE.Group;
  /** Destination table centre (floor level) - the win check should use this. */
  target: THREE.Vector3;
  /** Delivery radius that the floor marker visualises. */
  targetRadius: number;
  /** Pulses the marker, sways the plants. Call once per frame. */
  update(dt: number, elapsed: number, cameraPos?: THREE.Vector3): void;
}

const WALL_H = 5;
const TABLE_H = 0.78;

/** Small helper: a box mesh with sensible shadow flags. */
function box(
  w: number,
  h: number,
  d: number,
  mat: THREE.Material,
  x = 0,
  y = 0,
  z = 0,
  shadow: 'both' | 'receive' | 'none' = 'both'
): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.castShadow = shadow !== 'none' && shadow !== 'receive';
  m.receiveShadow = shadow !== 'none';
  return m;
}

function cyl(
  rt: number,
  rb: number,
  h: number,
  seg: number,
  mat: THREE.Material,
  x = 0,
  y = 0,
  z = 0
): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/** Glowing "reserved" card that tells the player where to go. */
function reservedSignTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#3a1210';
  ctx.fillRect(0, 0, 256, 128);
  ctx.strokeStyle = '#e8b64c';
  ctx.lineWidth = 8;
  ctx.strokeRect(8, 8, 240, 112);
  ctx.fillStyle = '#f6d68a';
  ctx.font = 'bold 52px system-ui, Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('RESERVED', 128, 66);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** One dining chair, merged so every chair is a single mesh. */
function chairGeometry(): THREE.BufferGeometry {
  const seat = new THREE.BoxGeometry(0.52, 0.09, 0.52).translate(0, TABLE_H * 0.62, 0);
  const back = new THREE.BoxGeometry(0.52, 0.62, 0.08).translate(0, TABLE_H * 0.62 + 0.34, -0.22);
  const postL = new THREE.BoxGeometry(0.08, TABLE_H * 0.62, 0.08).translate(-0.2, TABLE_H * 0.31, -0.2);
  const postR = postL.clone().translate(0.4, 0, 0);
  const legFL = new THREE.BoxGeometry(0.08, TABLE_H * 0.62, 0.08).translate(-0.2, TABLE_H * 0.31, 0.2);
  const legFR = legFL.clone().translate(0.4, 0, 0);
  const parts = [seat, back, postL, postR, legFL, legFR];
  const merged = mergeSimple(parts);
  parts.forEach((p) => p.dispose());
  return merged;
}

/** Minimal geometry merge (positions/normals/uvs only) to avoid an extra import. */
function mergeSimple(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const attrs = ['position', 'normal', 'uv'] as const;
  let vertexCount = 0;
  let indexCount = 0;
  for (const g of geos) {
    vertexCount += g.attributes.position.count;
    indexCount += g.index ? g.index.count : g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  const arrays: Record<string, Float32Array> = {};
  for (const a of attrs) arrays[a] = new Float32Array(vertexCount * 3);
  const indices = new Uint32Array(indexCount);
  let vOff = 0;
  let iOff = 0;
  for (const g of geos) {
    const count = g.attributes.position.count;
    for (const a of attrs) {
      const attr = g.attributes[a] as THREE.BufferAttribute | undefined;
      const size = attr ? attr.itemSize : 3;
      for (let i = 0; i < count; i++) {
        for (let c = 0; c < 3; c++) {
          arrays[a][(vOff + i) * 3 + c] = attr ? attr.array[i * size + c] : c === 2 ? 0 : 0;
        }
      }
    }
    if (g.index) {
      for (let i = 0; i < g.index.count; i++) indices[iOff + i] = g.index.array[i] + vOff;
      iOff += g.index.count;
    } else {
      for (let i = 0; i < count; i++) indices[iOff + i] = vOff + i;
      iOff += count;
    }
    vOff += count;
  }
  for (const a of attrs) out.setAttribute(a, new THREE.BufferAttribute(arrays[a], 3));
  out.setIndex(new THREE.BufferAttribute(indices, 1));
  out.computeBoundingSphere();
  return out;
}

interface PendingChair {
  x: number;
  z: number;
  yaw: number;
}

export function createRestaurant(opts: RestaurantOptions): Restaurant {
  const { width, length } = opts;
  const root = new THREE.Group();
  const halfW = width / 2;
  const halfL = length / 2;

  // ---------- shared materials ----------
  const floorMat = new THREE.MeshLambertMaterial({ map: floorTexture() });
  (floorMat.map as THREE.Texture).repeat.set(width / 4, length / 4);

  const wallMat = new THREE.MeshLambertMaterial({ map: wallTexture() });
  (wallMat.map as THREE.Texture).repeat.set(width / 6, WALL_H / 3);

  const woodMat = new THREE.MeshLambertMaterial({ map: woodTexture() });
  const darkWoodMat = new THREE.MeshLambertMaterial({ color: 0x6d4526 });
  const wainscotMat = new THREE.MeshLambertMaterial({ color: 0x8a5a34 });
  const trimMat = new THREE.MeshLambertMaterial({ color: 0xf3e2c4 });
  const brassMat = new THREE.MeshPhongMaterial({ color: 0xd8a94a, shininess: 60, specular: 0x88aa66 });
  const clothMat = new THREE.MeshLambertMaterial({ color: 0xf4efe2 });
  const rugMat = new THREE.MeshLambertMaterial({ color: 0x9c3b3b });
  const glassMat = new THREE.MeshBasicMaterial({ color: 0xfff0c8 });
  const shadeMat = new THREE.MeshLambertMaterial({
    color: 0x2f6b4f,
    emissive: 0x1d3a2c,
    side: THREE.DoubleSide,
  });
  const bulbMat = new THREE.MeshBasicMaterial({ color: 0xffe9b0 });
  const coneMat = new THREE.MeshBasicMaterial({
    color: 0xffd9a0,
    transparent: true,
    opacity: 0.06,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  const leafMat = new THREE.MeshLambertMaterial({ color: 0x3f7d46 });
  const potMat = new THREE.MeshLambertMaterial({ color: 0xa8563a });

  // ---------- floor ----------
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(width, length), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  root.add(floor);

  // Dark inlaid border so the walking lane reads as a runner carpet
  const runner = new THREE.Mesh(new THREE.PlaneGeometry(6.4, length - 3), new THREE.MeshLambertMaterial({ color: 0xb06a3f }));
  runner.rotation.x = -Math.PI / 2;
  runner.position.set(0, 0.012, 0.5);
  runner.receiveShadow = true;
  root.add(runner);
  const runnerEdge = new THREE.Mesh(
    new THREE.PlaneGeometry(6.9, length - 3),
    new THREE.MeshLambertMaterial({ color: 0x8a4f2c })
  );
  runnerEdge.rotation.x = -Math.PI / 2;
  runnerEdge.position.set(0, 0.008, 0.5);
  runnerEdge.receiveShadow = true;
  root.add(runnerEdge);

  // Rug near the entrance
  const rug = cyl(2.4, 2.4, 0.02, 28, rugMat, 0, 0.02, halfL - 3.4);
  rug.castShadow = false;
  root.add(rug);

  // ---------- walls ----------
  // The follow camera sits above the ceiling and behind (+z of) the player, so the
  // ceiling is single-sided facing down (culled from a top-down camera, still
  // correct from inside the room) and the near wall hides itself when the camera
  // is outside it. Both are ordinary cutaway tricks - nothing else changes.
  const nearWall: THREE.Object3D[] = [];
  const wallGeoms: [number, number, number, number, number, number][] = [
    [width, WALL_H, 0.5, 0, WALL_H / 2, -halfL - 0.25],
    [width, WALL_H, 0.5, 0, WALL_H / 2, halfL + 0.25],
    [0.5, WALL_H, length, -halfW - 0.25, WALL_H / 2, 0],
    [0.5, WALL_H, length, halfW + 0.25, WALL_H / 2, 0],
  ];
  wallGeoms.forEach(([w, h, d, x, y, z], index) => {
    const isNear = index === 1; // the +z wall, closest to the camera
    const holder = isNear ? new THREE.Group() : root;
    if (isNear) root.add(holder);
    const side = w === 0.5 ? d : w;
    const thickness = w === 0.5 ? w : d;
    holder.add(box(w, h, d, wallMat, x, y, z, 'receive'));
    // wainscot band + rail + skirting
    holder.add(box(side, 1.0, thickness, wainscotMat, x, 0.5, z, 'receive'));
    holder.add(box(side, 0.12, thickness + 0.06, darkWoodMat, x, 1.05, z, 'receive'));
    holder.add(box(side, 0.18, thickness + 0.06, darkWoodMat, x, 0.09, z, 'receive'));
    holder.add(box(side, 0.3, thickness + 0.1, trimMat, x, WALL_H - 0.35, z, 'none'));
    if (isNear) nearWall.push(holder);
  });

  // Ceiling: normal points down, so a camera above it sees straight through.
  const ceiling = new THREE.Mesh(
    new THREE.PlaneGeometry(width, length),
    new THREE.MeshLambertMaterial({ color: 0xf6e7cd })
  );
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.y = WALL_H;
  root.add(ceiling);
  // (No ceiling beams: the follow camera looks down through the ceiling, where
  // they would just draw bars across the play area.)

  // ---------- windows (left wall) ----------
  const windowMat = new THREE.MeshLambertMaterial({ color: 0xf7ecd2 });
  for (const wz of [-length * 0.3, 0, length * 0.3]) {
    const frame = box(0.24, 2.4, 4.2, trimMat, -halfW + 0.1, 2.5, wz, 'receive');
    root.add(frame);
    const pane = new THREE.Mesh(new THREE.PlaneGeometry(3.9, 2.1), glassMat);
    pane.rotation.y = Math.PI / 2;
    pane.position.set(-halfW + 0.02, 2.5, wz);
    root.add(pane);
    // mullions
    root.add(box(0.3, 0.12, 4.2, trimMat, -halfW + 0.12, 2.5, wz, 'none'));
    root.add(box(0.3, 2.4, 0.12, trimMat, -halfW + 0.12, 2.5, wz, 'none'));
    // light pooling on the floor under the window
    const pool = new THREE.Mesh(
      new THREE.PlaneGeometry(4.6, 3.4),
      new THREE.MeshBasicMaterial({
        map: glowTexture(),
        color: 0xffe6b0,
        transparent: true,
        opacity: 0.25,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
    );
    pool.rotation.x = -Math.PI / 2;
    pool.position.set(-halfW + 1.9, 0.02, wz);
    root.add(pool);
  }

  // ---------- framed pictures (right wall) ----------
  const frameColors = [0xc0553f, 0x3f6f8a, 0x7a9a4f, 0xb08a3a];
  frameColors.forEach((col, i) => {
    const pz = -length * 0.32 + i * (length * 0.21);
    const f = box(0.16, 1.5, 1.2, darkWoodMat, halfW - 0.02, 2.6, pz, 'receive');
    root.add(f);
    const art = box(0.06, 1.2, 0.92, new THREE.MeshLambertMaterial({ color: col }), halfW - 0.12, 2.6, pz, 'receive');
    root.add(art);
  });

  // ---------- kitchen pass (back wall, left of the target) ----------
  const pass = new THREE.Group();
  pass.position.set(-7, 0, -halfL + 0.9);
  pass.add(box(6.4, 1.05, 1.2, wainscotMat, 0, 0.52, 0));
  pass.add(box(6.8, 0.14, 1.5, darkWoodMat, 0, 1.12, 0));
  pass.add(box(6.4, 1.0, 0.16, trimMat, 0, 2.0, -0.5));
  for (let i = 0; i < 5; i++) {
    const plate = cyl(0.26, 0.24, 0.05, 14, windowMat, -2.4 + i * 1.2, 1.72, -0.36);
    pass.add(plate);
  }
  const heatLamp = cyl(0.18, 0.34, 0.3, 12, brassMat, 2.2, 1.5, -0.34);
  pass.add(heatLamp);
  const heatGlow = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 8), bulbMat);
  heatGlow.position.set(2.2, 1.36, -0.34);
  pass.add(heatGlow);
  root.add(pass);

  // ---------- dining tables + chairs ----------
  const chairs: PendingChair[] = [];
  const diningTable = (x: number, z: number, round: boolean) => {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    const topR = round ? 0.85 : 1.35;
    const top = cyl(topR, topR, 0.1, round ? 24 : 4, woodMat, 0, TABLE_H, 0);
    if (!round) top.rotation.y = Math.PI / 4;
    g.add(top);
    g.add(cyl(0.16, 0.22, TABLE_H - 0.05, 12, darkWoodMat, 0, (TABLE_H - 0.05) / 2, 0));
    g.add(cyl(0.5, 0.6, 0.08, 16, darkWoodMat, 0, 0.04, 0));
    // cloth + centrepiece
    const cloth = cyl(topR + 0.06, topR + 0.22, 0.5, round ? 24 : 4, clothMat, 0, TABLE_H - 0.24, 0);
    if (!round) cloth.rotation.y = Math.PI / 4;
    cloth.castShadow = false;
    g.add(cloth);
    g.add(cyl(0.05, 0.07, 0.16, 8, leafMat, 0, TABLE_H + 0.13, 0));
    const bloom = new THREE.Mesh(new THREE.SphereGeometry(0.13, 10, 8), new THREE.MeshLambertMaterial({ color: 0xe88a4a }));
    bloom.position.set(0, TABLE_H + 0.26, 0);
    g.add(bloom);
    root.add(g);
    const side = Math.sign(x) || 1;
    if (round) {
      chairs.push({ x: x - side * 1.4, z, yaw: side > 0 ? -Math.PI / 2 : Math.PI / 2 });
    } else {
      chairs.push({ x, z: z - 1.95, yaw: 0 });
      chairs.push({ x, z: z + 1.95, yaw: Math.PI });
    }
  };

  diningTable(-6.6, -length * 0.17, false);
  diningTable(6.6, -length * 0.17, false);
  diningTable(-6.6, length * 0.14, false);
  diningTable(6.6, length * 0.14, false);
  diningTable(-7.4, -halfL + 3.6, true);
  diningTable(7.4, -halfL + 3.6, true);

  const chairMesh = new THREE.InstancedMesh(chairGeometry(), woodMat, chairs.length);
  chairMesh.castShadow = true;
  chairMesh.receiveShadow = true;
  const m4 = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const scaleV = new THREE.Vector3(1, 1, 1);
  chairs.forEach((c, i) => {
    quat.setFromEuler(new THREE.Euler(0, c.yaw, 0));
    m4.compose(new THREE.Vector3(c.x, 0, c.z), quat, scaleV);
    chairMesh.setMatrixAt(i, m4);
  });
  chairMesh.instanceMatrix.needsUpdate = true;
  root.add(chairMesh);

  // ---------- plants (gently swaying) ----------
  const plantTops: THREE.Object3D[] = [];
  const plant = (x: number, z: number, s: number) => {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.scale.setScalar(s);
    g.add(cyl(0.42, 0.3, 0.6, 14, potMat, 0, 0.3, 0));
    g.add(cyl(0.44, 0.44, 0.1, 14, darkWoodMat, 0, 0.62, 0));
    const top = new THREE.Group();
    top.position.y = 0.62;
    for (let i = 0; i < 5; i++) {
      const leaf = new THREE.Mesh(new THREE.SphereGeometry(0.34, 10, 8), leafMat);
      leaf.scale.set(1, 0.55, 1);
      const a = (i / 5) * Math.PI * 2;
      leaf.position.set(Math.cos(a) * 0.24, 0.32 + (i % 2) * 0.26, Math.sin(a) * 0.24);
      leaf.castShadow = true;
      top.add(leaf);
    }
    g.add(top);
    plantTops.push(top);
    root.add(g);
  };
  plant(-halfW + 1.5, halfL - 2.2, 1.1);
  plant(halfW - 1.5, halfL - 2.2, 1);
  plant(halfW - 1.6, -halfL + 2.2, 0.9);

  // ---------- pendant lamps ----------
  const coneGroup = new THREE.Group();
  const lampSpots: { x: number; z: number }[] = [
    { x: -6.6, z: -length * 0.17 },
    { x: 6.6, z: length * 0.14 },
    { x: 0, z: -length * 0.02 },
  ];
  for (const spot of [...lampSpots, { x: 6.6, z: -length * 0.17 }, { x: -6.6, z: length * 0.14 }]) {
    const cordLen = WALL_H - 3.4;
    const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, cordLen, 6), darkWoodMat);
    cord.position.set(spot.x, WALL_H - cordLen / 2, spot.z);
    coneGroup.add(cord);
    const shade = new THREE.Mesh(new THREE.ConeGeometry(0.52, 0.5, 16, 1, true), shadeMat);
    shade.position.set(spot.x, 3.15, spot.z);
    coneGroup.add(shade);
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.13, 10, 8), bulbMat);
    bulb.position.set(spot.x, 2.98, spot.z);
    coneGroup.add(bulb);
    const cone = new THREE.Mesh(new THREE.ConeGeometry(1.5, 2.6, 14, 1, true), coneMat);
    cone.position.set(spot.x, 1.7, spot.z);
    coneGroup.add(cone);
  }
  root.add(coneGroup);

  // ---------- lighting ----------
  const hemi = new THREE.HemisphereLight(0xffeccc, 0x6b4a33, 0.75);
  root.add(hemi);

  const sun = new THREE.DirectionalLight(0xfff0d2, 1.15);
  sun.position.set(12, 20, 14);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -halfW - 6;
  sun.shadow.camera.right = halfW + 6;
  sun.shadow.camera.top = halfL + 6;
  sun.shadow.camera.bottom = -halfL - 6;
  sun.shadow.camera.near = 4;
  sun.shadow.camera.far = 70;
  sun.shadow.camera.updateProjectionMatrix();
  sun.shadow.bias = -0.0008;
  sun.shadow.normalBias = 0.03;
  root.add(sun);
  root.add(sun.target);

  for (const spot of lampSpots) {
    const lamp = new THREE.PointLight(0xffc98a, 26, 13, 2);
    lamp.position.set(spot.x, 2.9, spot.z);
    root.add(lamp);
  }

  // ---------- destination table ----------
  const target = opts.target.clone();
  const targetRadius = 2.6;
  const targetGroup = new THREE.Group();
  targetGroup.position.copy(target);

  const reservedCloth = new THREE.MeshLambertMaterial({ color: 0xb8332f });
  const tTop = cyl(1.15, 1.15, 0.12, 26, woodMat, 0, TABLE_H, 0);
  targetGroup.add(tTop);
  targetGroup.add(cyl(0.18, 0.24, TABLE_H - 0.06, 14, darkWoodMat, 0, (TABLE_H - 0.06) / 2, 0));
  targetGroup.add(cyl(0.58, 0.7, 0.1, 18, darkWoodMat, 0, 0.05, 0));
  const skirt = cyl(1.24, 1.5, 0.62, 26, reservedCloth, 0, TABLE_H - 0.3, 0);
  skirt.castShadow = false;
  targetGroup.add(skirt);
  const sign = new THREE.Mesh(
    new THREE.PlaneGeometry(0.9, 0.45),
    new THREE.MeshBasicMaterial({ map: reservedSignTexture(), side: THREE.DoubleSide })
  );
  sign.position.set(0, TABLE_H + 0.36, 0);
  sign.rotation.x = -0.18;
  targetGroup.add(sign);
  const signStand = box(0.08, 0.36, 0.08, brassMat, 0, TABLE_H + 0.14, 0);
  targetGroup.add(signStand);
  // candle on the reserved table for a warm accent
  targetGroup.add(cyl(0.05, 0.06, 0.2, 8, trimMat, 0.62, TABLE_H + 0.16, 0.32));
  const flame = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 6), bulbMat);
  flame.scale.y = 1.7;
  flame.position.set(0.62, TABLE_H + 0.3, 0.32);
  targetGroup.add(flame);
  root.add(targetGroup);

  const spotLight = new THREE.PointLight(0xffb066, 22, 9, 2);
  spotLight.position.set(target.x, 2.5, target.z);
  root.add(spotLight);

  // pulsing floor marker showing the delivery zone
  const ringMat = new THREE.MeshBasicMaterial({
    color: 0xffb347,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  const ring = new THREE.Mesh(new THREE.RingGeometry(targetRadius - 0.55, targetRadius, 40), ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(target.x, 0.03, target.z);
  root.add(ring);

  const glowMat = new THREE.MeshBasicMaterial({
    map: glowTexture(),
    color: 0xffa64d,
    transparent: true,
    opacity: 0.4,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const markerGlow = new THREE.Mesh(new THREE.PlaneGeometry(targetRadius * 2.4, targetRadius * 2.4), glowMat);
  markerGlow.rotation.x = -Math.PI / 2;
  markerGlow.position.set(target.x, 0.022, target.z);
  root.add(markerGlow);

  // floating chevron above the table
  const chevron = new THREE.Group();
  const chevronMat = new THREE.MeshLambertMaterial({
    color: 0xffc061,
    emissive: 0x7a4a12,
    transparent: true,
    opacity: 0.95,
  });
  const coneMark = new THREE.Mesh(new THREE.ConeGeometry(0.34, 0.6, 4), chevronMat);
  coneMark.rotation.x = Math.PI;
  coneMark.position.y = 0.3;
  chevron.add(coneMark);
  const ringMark = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.06, 8, 20), chevronMat);
  ringMark.rotation.x = Math.PI / 2;
  chevron.add(ringMark);
  chevron.position.set(target.x, 2.2, target.z);
  root.add(chevron);

  // ---------- per-frame motion ----------
  const ringBase = 1;
  return {
    root,
    target,
    targetRadius,
    update(_dt: number, elapsed: number, cameraPos?: THREE.Vector3): void {
      // Hide the near wall when the follow camera is outside the room, so it
      // never blocks the view. `cameraPos` is optional for older call sites.
      if (cameraPos && nearWall.length) {
        const outside = cameraPos.z > halfL + 0.25;
        for (const part of nearWall) part.visible = !outside;
      }
      const pulse = 0.5 + 0.5 * Math.sin(elapsed * 2.2);
      ringMat.opacity = 0.28 + pulse * 0.4;
      ring.scale.setScalar(ringBase + pulse * 0.045);
      glowMat.opacity = 0.22 + pulse * 0.26;
      chevron.position.y = 2.05 + Math.sin(elapsed * 1.8) * 0.16;
      chevron.rotation.y = elapsed * 0.8;
      for (let i = 0; i < plantTops.length; i++) {
        const top = plantTops[i];
        top.rotation.z = Math.sin(elapsed * 0.9 + i * 1.7) * 0.05;
        top.rotation.x = Math.cos(elapsed * 0.7 + i) * 0.04;
      }
      flame.scale.setScalar(0.9 + Math.sin(elapsed * 9) * 0.12);
    },
  };
}
