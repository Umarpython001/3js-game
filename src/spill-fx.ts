import * as THREE from 'three';

/**
 * Lightweight spill visuals: pooled droplets in a single InstancedMesh,
 * fading puddle decals on the floor and a brief expanding splash ring.
 * Gameplay decides *when* soup is lost; this module only shows it.
 */

const MAX_DROPS = 60;
const MAX_PUDDLES = 14;
const DROPLET_GEO = new THREE.IcosahedronGeometry(0.055, 0);
const DROP_COLOR = new THREE.Color(0xf2600f);

export interface SpillFx {
  /** Throw `strength` (0..1) worth of droplets from a world position. */
  spawn(at: THREE.Vector3, strength?: number): void;
  /** Brief expanding ring, for a splash right at the bowl. */
  splash(at: THREE.Vector3, strength?: number): void;
  /** Advances the particles. Call once per frame. */
  update(dt: number): void;
  /** Remove everything (used by restart). */
  clear(): void;
}

export function createSpillFx(scene: THREE.Scene, floorY = 0): SpillFx {
  const drops = new THREE.InstancedMesh(
    DROPLET_GEO,
    new THREE.MeshLambertMaterial({ color: DROP_COLOR, emissive: 0x40170a }),
    MAX_DROPS
  );
  drops.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  drops.frustumCulled = false;
  drops.castShadow = false;
  drops.count = MAX_DROPS;
  scene.add(drops);

  interface Drop {
    pos: THREE.Vector3;
    vel: THREE.Vector3;
    life: number;
    size: number;
    active: boolean;
  }
  const pool: Drop[] = [];
  for (let i = 0; i < MAX_DROPS; i++) {
    pool.push({
      pos: new THREE.Vector3(0, -50, 0),
      vel: new THREE.Vector3(),
      life: 0,
      size: 1,
      active: false,
    });
  }
  let cursor = 0;

  // puddles: flat discs that fade out where the soup hit the floor
  const puddleGeo = new THREE.CircleGeometry(0.32, 14);
  const puddles: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; life: number; max: number }[] = [];
  for (let i = 0; i < MAX_PUDDLES; i++) {
    const mat = new THREE.MeshBasicMaterial({ color: 0xc94a0c, transparent: true, opacity: 0, depthWrite: false });
    const mesh = new THREE.Mesh(puddleGeo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = 0.02;
    mesh.visible = false;
    scene.add(mesh);
    puddles.push({ mesh, mat, life: 0, max: 1 });
  }
  let puddleCursor = 0;

  // splash ring
  const ringMesh = new THREE.Mesh(
    new THREE.RingGeometry(0.06, 0.1, 20),
    new THREE.MeshBasicMaterial({
      color: 0xffb066,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    })
  );
  ringMesh.rotation.x = -Math.PI / 2;
  ringMesh.visible = false;
  scene.add(ringMesh);
  let ringLife = 0;

  const m4 = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const scaleV = new THREE.Vector3();
  const hidden = new THREE.Matrix4().makeScale(0, 0, 0);

  function addPuddle(x: number, z: number, size: number): void {
    const p = puddles[puddleCursor];
    puddleCursor = (puddleCursor + 1) % puddles.length;
    p.mesh.position.set(x, floorY + 0.02, z);
    p.mesh.scale.setScalar(size);
    p.mesh.visible = true;
    p.life = 4.5;
    p.max = 4.5;
  }

  return {
    spawn(at: THREE.Vector3, strength = 0.5): void {
      const s = THREE.MathUtils.clamp(strength, 0.1, 1);
      const count = Math.round(THREE.MathUtils.lerp(3, 9, s));
      for (let i = 0; i < count; i++) {
        const d = pool[cursor];
        cursor = (cursor + 1) % pool.length;
        d.active = true;
        d.life = 0.8 + Math.random() * 0.4;
        d.size = (0.55 + Math.random() * 0.7) * (0.6 + 0.6 * s);
        d.pos.set(
          at.x + (Math.random() - 0.5) * 0.28,
          at.y + (Math.random() - 0.2) * 0.12,
          at.z + (Math.random() - 0.5) * 0.28
        );
        const a = Math.random() * Math.PI * 2;
        const sp = 0.5 + Math.random() * 1.3 * s;
        d.vel.set(Math.cos(a) * sp * 0.5, 0.4 + Math.random() * 0.9, Math.sin(a) * sp * 0.5);
      }
    },

    splash(at: THREE.Vector3, strength = 0.5): void {
      ringMesh.position.set(at.x, at.y + 0.005, at.z);
      ringMesh.visible = true;
      ringLife = 0.32;
      ringMesh.material.opacity = 0.8;
      ringMesh.scale.setScalar(0.5 + strength * 0.8);
    },

    update(dt: number): void {
      const d = Math.min(dt, 0.05);
      for (let i = 0; i < pool.length; i++) {
        const drop = pool[i];
        if (!drop.active) {
          m4.copy(hidden);
          drops.setMatrixAt(i, m4);
          continue;
        }
        drop.vel.y -= 11 * d;
        drop.pos.addScaledVector(drop.vel, d);
        if (drop.pos.y < floorY + 0.03) {
          // lands: leave a small stain and stop simulating
          if (Math.random() < 0.5) addPuddle(drop.pos.x, drop.pos.z, 0.5 + Math.random() * 0.6);
          drop.active = false;
          m4.copy(hidden);
          drops.setMatrixAt(i, m4);
          continue;
        }
        drop.life -= d;
        if (drop.life <= 0) {
          drop.active = false;
          m4.copy(hidden);
          drops.setMatrixAt(i, m4);
          continue;
        }
        const stretch = 1 + Math.min(1.4, Math.abs(drop.vel.y) * 0.12);
        scaleV.set(drop.size, drop.size * stretch, drop.size);
        m4.compose(drop.pos, quat, scaleV);
        drops.setMatrixAt(i, m4);
      }
      drops.instanceMatrix.needsUpdate = true;

      for (const p of puddles) {
        if (p.life <= 0) continue;
        p.life -= d;
        const t = Math.max(0, p.life / p.max);
        p.mat.opacity = t * 0.5;
        if (p.life <= 0) p.mesh.visible = false;
      }

      if (ringLife > 0) {
        ringLife -= d;
        ringMesh.scale.multiplyScalar(1 + d * 6);
        ringMesh.material.opacity = Math.max(0, ringLife / 0.32) * 0.7;
        if (ringLife <= 0) ringMesh.visible = false;
      }
    },

    clear(): void {
      for (let i = 0; i < pool.length; i++) {
        pool[i].active = false;
        drops.setMatrixAt(i, hidden);
      }
      drops.instanceMatrix.needsUpdate = true;
      for (const p of puddles) {
        p.life = 0;
        p.mesh.visible = false;
        p.mat.opacity = 0;
      }
      ringLife = 0;
      ringMesh.visible = false;
    },
  };
}
