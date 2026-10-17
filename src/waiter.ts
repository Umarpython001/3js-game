import * as THREE from 'three';

/**
 * The waiter: a small procedural character built from primitives and animated
 * without skeletons or animation clips (see instructions.md - no rig system,
 * no new dependencies). Limbs are nested Groups so each joint is a pivot.
 *
 * Forward is local +Z, matching the existing movement code
 * (yaw = atan2(vx, vz)), and the ground is y = 0.
 */

// ---------- public types ----------

export type BodyType = 'female' | 'male';
export type HairType = 'short' | 'afro' | 'braids' | 'bun' | 'ponytail' | 'dreads' | 'bald';
export type HatType = 'none' | 'cap' | 'beanie' | 'tophat' | 'crown';
export type AccessoryType = 'none' | 'glasses' | 'earrings' | 'beard' | 'scarf' | 'backpack';

/** Mirrors the documented start.ng character style fields. */
export interface WaiterStyle {
  body: BodyType;
  primaryColor: string;
  secondaryColor: string;
  skinColor: string;
  hairColor: string;
  hair: HairType;
  hat: HatType;
  accessory: AccessoryType;
}

/** Classic waiter look, used when start.ng has no player style (local play). */
export const DEFAULT_WAITER_STYLE: WaiterStyle = {
  body: 'male',
  primaryColor: '#f3efe4',
  secondaryColor: '#2b3040',
  skinColor: '#f0c49b',
  hairColor: '#2c1d13',
  hair: 'short',
  hat: 'none',
  accessory: 'none',
};

/** What the animation needs from the gameplay code, every frame. */
export interface WaiterMotion {
  /** Actual movement speed in units/second (measured displacement). */
  speed: number;
  /** Yaw change this frame in rad/second (signed). */
  turnRate: number;
  /** True while a movement key is held. */
  moving: boolean;
  /** Optional world point the waiter idles looking at (the destination table). */
  lookAt?: THREE.Vector3 | null;
}

export interface Waiter {
  /** Place in the scene. Movement code owns position.x/z and rotation.y. */
  root: THREE.Group;
  /** Gameplay owns .rotation.z (the Q/E tray tilt). */
  trayGroup: THREE.Group;
  /** Gameplay owns slosh rotation (.x/.y) and depletion (.scale.set(s, s, 1)). */
  soupMesh: THREE.Mesh;
  /** Advance the procedural animation. */
  update(dt: number, motion: WaiterMotion): void;
  /** Apply a start.ng character style (partial or unknown values are tolerated). */
  setStyle(style: Partial<WaiterStyle> | null | undefined): void;
  /** 0..1 - lowers the soup surface inside the bowl (radius is gameplay's job). */
  setSoupLevel(fraction01: number): void;
  /** World position of the soup surface, for spawning spill droplets. */
  soupWorldPosition(out: THREE.Vector3): THREE.Vector3;
}

// ---------- proportions ----------

const HIP_Y = 0.9;
const THIGH = 0.45;
const SHIN = 0.42;
const HIP_WIDTH = 0.15;
const SHOULDER_Y = 0.55;
const SHOULDER_X = 0.3;
const UPPER_ARM = 0.3;
const FOREARM = 0.28;
/** Distance the feet travel per full walk cycle - keeps feet from sliding. */
const STRIDE = 1.75;
const MAX_SPEED = 6;

const UP = new THREE.Vector3(0, 1, 0);

// ---------- helpers ----------

const BODIES: BodyType[] = ['female', 'male'];
const HAIRS: HairType[] = ['short', 'afro', 'braids', 'bun', 'ponytail', 'dreads', 'bald'];
const HATS: HatType[] = ['none', 'cap', 'beanie', 'tophat', 'crown'];
const ACCESSORIES: AccessoryType[] = ['none', 'glasses', 'earrings', 'beard', 'scarf', 'backpack'];

function pick<T extends string>(value: unknown, allowed: T[], fallback: T): T {
  return typeof value === 'string' && (allowed as string[]).includes(value) ? (value as T) : fallback;
}

function color(value: unknown, fallback: string): THREE.Color {
  const c = new THREE.Color();
  if (typeof value === 'string' && value.trim() !== '') c.set(value);
  else c.set(fallback);
  if (!Number.isFinite(c.r)) c.set(fallback);
  return c;
}

function normalize(style: Partial<WaiterStyle> | null | undefined): WaiterStyle {
  const s = style ?? {};
  return {
    body: pick(s.body, BODIES, DEFAULT_WAITER_STYLE.body),
    primaryColor: color(s.primaryColor, DEFAULT_WAITER_STYLE.primaryColor).getStyle(),
    secondaryColor: color(s.secondaryColor, DEFAULT_WAITER_STYLE.secondaryColor).getStyle(),
    skinColor: color(s.skinColor, DEFAULT_WAITER_STYLE.skinColor).getStyle(),
    hairColor: color(s.hairColor, DEFAULT_WAITER_STYLE.hairColor).getStyle(),
    hair: pick(s.hair, HAIRS, DEFAULT_WAITER_STYLE.hair),
    hat: pick(s.hat, HATS, DEFAULT_WAITER_STYLE.hat),
    accessory: pick(s.accessory, ACCESSORIES, DEFAULT_WAITER_STYLE.accessory),
  };
}

function mesh(
  geo: THREE.BufferGeometry,
  mat: THREE.Material,
  x = 0,
  y = 0,
  z = 0,
  shadow = true
): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = shadow;
  m.receiveShadow = false;
  return m;
}

/** Sphere helper - used for joints, hands and soft body parts. */
function ball(r: number, mat: THREE.Material, x = 0, y = 0, z = 0, seg = 12): THREE.Mesh {
  return mesh(new THREE.SphereGeometry(r, seg, Math.max(8, seg - 4)), mat, x, y, z);
}

/** Capsule-ish limb: a rounded box keeps the silhouette chunky and readable. */
function limb(len: number, thick: number, mat: THREE.Material): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.CapsuleGeometry(thick, Math.max(0.01, len - thick * 2), 4, 8), mat);
  m.position.y = -len / 2;
  m.castShadow = true;
  return m;
}

export function createWaiter(style?: Partial<WaiterStyle> | null): Waiter {
  // ---------- materials (owned by this waiter, recoloured by setStyle) ----------
  const topMat = new THREE.MeshLambertMaterial({ color: 0xffffff }); // shirt / top
  const bottomMat = new THREE.MeshLambertMaterial({ color: 0x2b3040 }); // trousers / skirt
  const skinMat = new THREE.MeshLambertMaterial({ color: 0xf0c49b });
  const hairMat = new THREE.MeshLambertMaterial({ color: 0x2c1d13 });
  const apronMat = new THREE.MeshLambertMaterial({ color: 0xf6efdc, side: THREE.DoubleSide });
  const trimMat = new THREE.MeshLambertMaterial({ color: 0xfffdf6 });
  const shoeMat = new THREE.MeshLambertMaterial({ color: 0x211d1a });
  const accentMat = new THREE.MeshLambertMaterial({ color: 0x1d2436 }); // bow tie / scarf
  const metalMat = new THREE.MeshPhongMaterial({ color: 0xd9dde2, shininess: 70, specular: 0x9099a6 });
  const bowlMat = new THREE.MeshPhongMaterial({
    color: 0xf7f4ec,
    shininess: 50,
    specular: 0x666f7a,
    side: THREE.DoubleSide,
  });
  const soupMat = new THREE.MeshLambertMaterial({ color: 0xf2600f, emissive: 0x501800 });
  const eyeMat = new THREE.MeshBasicMaterial({ color: 0x20181a });

  // ---------- rig ----------
  const root = new THREE.Group();
  const body = new THREE.Group();
  body.position.y = HIP_Y;
  root.add(body);

  // hips / skirt (kept narrow so the legs read as legs, not a barrel)
  const pelvis = mesh(new THREE.CylinderGeometry(0.235, 0.26, 0.22, 14), bottomMat, 0, -0.03, 0);
  body.add(pelvis);
  const skirt = mesh(new THREE.CylinderGeometry(0.26, 0.4, 0.32, 16), bottomMat, 0, -0.14, 0);
  skirt.visible = false;
  body.add(skirt);

  // torso
  const torso = new THREE.Group();
  torso.position.y = 0.06;
  body.add(torso);
  const chest = mesh(new THREE.CylinderGeometry(0.29, 0.25, 0.56, 16), topMat, 0, 0.28, 0);
  torso.add(chest);
  const shoulders = mesh(new THREE.SphereGeometry(0.2, 12, 10), topMat, 0, 0.54, 0);
  shoulders.scale.set(1.45, 0.75, 1);
  torso.add(shoulders);
  // collar
  const collar = mesh(new THREE.CylinderGeometry(0.16, 0.19, 0.09, 12), trimMat, 0, 0.58, 0);
  torso.add(collar);
  // waistcoat: open down the middle so the shirt (the start.ng primary colour)
  // stays visible, and the whole thing stops reading as one white blob
  const vestMat = new THREE.MeshLambertMaterial({ color: 0x2b3040, side: THREE.DoubleSide });
  const vest = mesh(
    new THREE.CylinderGeometry(0.312, 0.3, 0.42, 16, 1, true, 0.7, Math.PI * 2 - 1.4),
    vestMat,
    0,
    0.37,
    0
  );
  torso.add(vest);
  const vestLapelL = mesh(new THREE.BoxGeometry(0.1, 0.3, 0.05), vestMat, -0.12, 0.4, 0.245);
  vestLapelL.rotation.z = 0.12;
  const vestLapelR = vestLapelL.clone();
  vestLapelR.position.x = 0.12;
  vestLapelR.rotation.z = -0.12;
  torso.add(vestLapelL, vestLapelR);
  // apron bow at the small of the back - the clearest "waiter" cue from behind
  const bowKnot = mesh(new THREE.SphereGeometry(0.055, 8, 6), apronMat, 0, 0.06, -0.3);
  const bowTailL = mesh(new THREE.BoxGeometry(0.1, 0.07, 0.04), apronMat, -0.09, 0.06, -0.29);
  bowTailL.rotation.z = 0.4;
  const bowTailR = mesh(new THREE.BoxGeometry(0.1, 0.07, 0.04), apronMat, 0.09, 0.06, -0.29);
  bowTailR.rotation.z = -0.4;
  torso.add(bowKnot, bowTailL, bowTailR);
  // bow tie
  const bow = new THREE.Group();
  bow.position.set(0, 0.53, 0.2);
  const bowL = mesh(new THREE.SphereGeometry(0.075, 8, 6), accentMat, -0.075, 0, 0);
  bowL.scale.set(1, 0.7, 0.5);
  const bowR = bowL.clone();
  bowR.position.x = 0.075;
  bow.add(bowL, bowR, mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.05, 8), accentMat, 0, 0, 0.01));
  torso.add(bow);

  // apron: a curved shell that wraps the front, plus bib and shoulder straps
  const apronSkirt = mesh(
    new THREE.CylinderGeometry(0.3, 0.335, 0.5, 14, 1, true, -0.85, 1.7),
    apronMat,
    0,
    0.02,
    0
  );
  torso.add(apronSkirt);
  const apronBib = mesh(
    new THREE.CylinderGeometry(0.3, 0.315, 0.2, 14, 1, true, -0.5, 1.0),
    apronMat,
    0,
    0.28,
    0
  );
  torso.add(apronBib);
  const strapL = mesh(new THREE.BoxGeometry(0.05, 0.26, 0.04), apronMat, -0.13, 0.56, 0.17);
  strapL.rotation.z = 0.3;
  const strapR = strapL.clone();
  strapR.position.x = 0.13;
  strapR.rotation.z = -0.3;
  torso.add(strapL, strapR);

  // neck + head
  const head = new THREE.Group();
  head.position.set(0, 0.66, 0);
  torso.add(head);
  const neck = mesh(new THREE.CylinderGeometry(0.09, 0.1, 0.14, 10), skinMat, 0, 0.5, 0);
  torso.add(neck);
  const skull = ball(0.21, skinMat, 0, 0.16, 0, 16);
  head.add(skull);
  // face (+Z is forward)
  const eyeL = ball(0.042, eyeMat, -0.078, 0.175, 0.155, 8);
  const eyeR = ball(0.042, eyeMat, 0.078, 0.175, 0.155, 8);
  head.add(eyeL, eyeR);
  const nose = ball(0.032, skinMat, 0, 0.135, 0.195, 8);
  head.add(nose);
  for (const ex of [-0.075, 0.075]) {
    const ear = ball(0.045, skinMat, ex, 0.16, 0.01, 8);
    ear.scale.set(0.5, 1, 0.8);
    head.add(ear);
  }

  // ---------- hair variants (built once, toggled by setStyle) ----------
  // Parented to the torso at the head's position (adding them to `head` as
  // well would offset them twice and float them above the skull).
  const hairGroup = new THREE.Group();
  hairGroup.position.copy(head.position);
  torso.add(hairGroup);
  const hairVariants = new Map<HairType, THREE.Group>();
  /**
   * Hair cap. `tilt` leans the opening backwards so the rim sits above the eyes
   * at the front while still covering the nape - without it, short hair looks
   * like a swim cap from behind.
   */
  const capOf = (r: number, y: number, theta: number, tilt = -0.42) => {
    const g = new THREE.SphereGeometry(r, 16, 10, 0, Math.PI * 2, 0, theta);
    const m = new THREE.Mesh(g, hairMat);
    m.position.y = y;
    m.rotation.x = tilt;
    m.castShadow = true;
    return m;
  };
  {
    const g = new THREE.Group();
    g.add(capOf(0.222, 0.16, Math.PI * 0.58));
    hairVariants.set('short', g);
  }
  {
    const g = new THREE.Group();
    const puff = capOf(0.27, 0.18, Math.PI * 0.55);
    puff.scale.set(1, 0.95, 1);
    g.add(puff);
    hairVariants.set('afro', g);
  }
  {
    const g = new THREE.Group();
    g.add(capOf(0.225, 0.16, Math.PI * 0.58));
    for (let i = 0; i < 6; i++) {
      const a = Math.PI * (0.25 + (i / 5) * 0.5) + Math.PI * 1.05;
      const braid = mesh(new THREE.CapsuleGeometry(0.045, 0.22, 3, 6), hairMat,
        Math.sin(a) * 0.18, 0.08 - Math.cos(a) * 0.06, Math.cos(a) * 0.18);
      braid.rotation.x = Math.PI;
      braid.castShadow = true;
      g.add(braid);
    }
    hairVariants.set('braids', g);
  }
  {
    const g = new THREE.Group();
    g.add(capOf(0.225, 0.16, Math.PI * 0.58));
    const bun = ball(0.1, hairMat, 0, 0.24, -0.16, 10);
    g.add(bun);
    hairVariants.set('bun', g);
  }
  {
    const g = new THREE.Group();
    g.add(capOf(0.225, 0.16, Math.PI * 0.58));
    const tail = mesh(new THREE.CapsuleGeometry(0.06, 0.26, 3, 8), hairMat, 0, 0.08, -0.24);
    tail.rotation.x = 1.9;
    g.add(tail);
    hairVariants.set('ponytail', g);
  }
  {
    const g = new THREE.Group();
    g.add(capOf(0.228, 0.16, Math.PI * 0.6));
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      const d = mesh(new THREE.CapsuleGeometry(0.04, 0.24, 3, 6), hairMat,
        Math.sin(a) * 0.19, 0.02, Math.cos(a) * 0.19);
      g.add(d);
    }
    hairVariants.set('dreads', g);
  }
  {
    const g = new THREE.Group();
    hairVariants.set('bald', g);
  }
  for (const g of hairVariants.values()) {
    g.visible = false;
    hairGroup.add(g);
  }

  // ---------- hat variants ----------
  const hatGroup = new THREE.Group();
  hatGroup.position.copy(head.position);
  torso.add(hatGroup);
  const hatVariants = new Map<HatType, THREE.Group>();
  const dome = (r: number, y: number, theta: number, mat: THREE.Material) => {
    const m = new THREE.Mesh(new THREE.SphereGeometry(r, 14, 10, 0, Math.PI * 2, 0, theta), mat);
    m.position.y = y;
    m.castShadow = true;
    return m;
  };
  {
    const g = new THREE.Group();
    const mat = new THREE.MeshLambertMaterial({ color: 0x24304a });
    g.add(dome(0.225, 0.17, Math.PI * 0.52, mat));
    const brim = mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.03, 14, 1, false, -0.9, 1.8), mat, 0, 0.19, 0.07);
    brim.rotation.x = -0.12;
    g.add(brim);
    hatVariants.set('cap', g);
  }
  {
    const g = new THREE.Group();
    const mat = new THREE.MeshLambertMaterial({ color: 0xc4503f });
    g.add(dome(0.23, 0.17, Math.PI * 0.5, mat));
    g.add(ball(0.06, mat, 0, 0.4, 0, 8));
    hatVariants.set('beanie', g);
  }
  {
    const g = new THREE.Group();
    const mat = new THREE.MeshLambertMaterial({ color: 0x1b1b20 });
    g.add(mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.04, 16), mat, 0, 0.32, 0));
    g.add(mesh(new THREE.CylinderGeometry(0.19, 0.2, 0.38, 14), mat, 0, 0.52, 0));
    g.add(mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.07, 14), new THREE.MeshLambertMaterial({ color: 0x8a2f34 }), 0, 0.4, 0));
    hatVariants.set('tophat', g);
  }
  {
    const g = new THREE.Group();
    const mat = new THREE.MeshLambertMaterial({ color: 0xe0b53f, emissive: 0x3a2a05 });
    g.add(mesh(new THREE.CylinderGeometry(0.21, 0.22, 0.1, 12), mat, 0, 0.32, 0));
    const gemMat = new THREE.MeshLambertMaterial({ color: 0xd94a4a });
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const spike = mesh(new THREE.ConeGeometry(0.05, 0.16, 6), mat, Math.sin(a) * 0.18, 0.44, Math.cos(a) * 0.18);
      g.add(spike);
      g.add(ball(0.035, gemMat, Math.sin(a) * 0.18, 0.53, Math.cos(a) * 0.18, 6));
    }
    hatVariants.set('crown', g);
  }
  {
    const g = new THREE.Group();
    hatVariants.set('none', g);
  }
  for (const g of hatVariants.values()) {
    g.visible = false;
    hatGroup.add(g);
  }

  // ---------- accessories ----------
  const accessoryGroup = new THREE.Group();
  accessoryGroup.position.copy(head.position);
  torso.add(accessoryGroup);
  const accessoryVariants = new Map<AccessoryType, THREE.Group>();
  {
    const g = new THREE.Group();
    const mat = new THREE.MeshLambertMaterial({ color: 0x2a2a30 });
    for (const ex of [-0.085, 0.085]) {
      const lens = mesh(new THREE.TorusGeometry(0.058, 0.014, 6, 14), mat, ex, 0.185, 0.185);
      g.add(lens);
    }
    g.add(mesh(new THREE.BoxGeometry(0.06, 0.014, 0.014), mat, 0, 0.185, 0.19));
    accessoryVariants.set('glasses', g);
  }
  {
    const g = new THREE.Group();
    const mat = new THREE.MeshLambertMaterial({ color: 0xe8c15a });
    for (const ex of [-0.21, 0.21]) g.add(ball(0.035, mat, ex, 0.14, 0.01, 6));
    accessoryVariants.set('earrings', g);
  }
  {
    const g = new THREE.Group();
    const mat = new THREE.MeshLambertMaterial({ color: 0x3b2a1d });
    const beard = mesh(new THREE.SphereGeometry(0.185, 14, 10, 0, Math.PI * 2, Math.PI * 0.55, Math.PI * 0.45), mat, 0, 0.13, 0);
    beard.scale.set(1, 1.15, 1.05);
    g.add(beard);
    const moustache = mesh(new THREE.BoxGeometry(0.13, 0.035, 0.05), mat, 0, 0.12, 0.19);
    g.add(moustache);
    accessoryVariants.set('beard', g);
  }
  {
    const g = new THREE.Group();
    const mat = new THREE.MeshLambertMaterial({ color: 0xb03a3a });
    const scarf = mesh(new THREE.TorusGeometry(0.13, 0.045, 6, 14), mat, 0, -0.02, 0);
    scarf.rotation.x = Math.PI / 2;
    g.add(scarf);
    const tail = mesh(new THREE.BoxGeometry(0.11, 0.26, 0.04), mat, 0.05, -0.16, 0.11);
    tail.rotation.z = 0.2;
    g.add(tail);
    accessoryVariants.set('scarf', g);
  }
  {
    const g = new THREE.Group();
    const mat = new THREE.MeshLambertMaterial({ color: 0x35404f });
    const pack = mesh(new THREE.BoxGeometry(0.3, 0.34, 0.18), mat, 0, 0.34, -0.24);
    g.add(pack);
    g.add(mesh(new THREE.BoxGeometry(0.24, 0.1, 0.1), new THREE.MeshLambertMaterial({ color: 0x27303c }), 0, 0.4, -0.34));
    accessoryVariants.set('backpack', g);
  }
  {
    const g = new THREE.Group();
    accessoryVariants.set('none', g);
  }
  for (const g of accessoryVariants.values()) {
    g.visible = false;
    accessoryGroup.add(g);
  }

  // ---------- arms ----------
  function buildArm(side: 1 | -1) {
    const shoulder = new THREE.Group();
    shoulder.position.set(side * SHOULDER_X, SHOULDER_Y, 0);
    torso.add(shoulder);
    const upper = limb(UPPER_ARM, 0.075, topMat);
    shoulder.add(upper);
    const elbow = new THREE.Group();
    elbow.position.y = -UPPER_ARM;
    shoulder.add(elbow);
    const fore = limb(FOREARM, 0.065, skinMat);
    elbow.add(fore);
    const hand = new THREE.Group();
    hand.position.y = -FOREARM;
    elbow.add(hand);
    const palm = ball(0.075, skinMat, 0, -0.03, 0, 10);
    palm.scale.set(1, 0.85, 1.15);
    hand.add(palm);
    return { shoulder, elbow, hand };
  }
  const armL = buildArm(-1); // tray arm
  const armR = buildArm(1); // free arm

  // ---------- legs ----------
  interface Leg {
    hip: THREE.Group;
    knee: THREE.Group;
    foot: THREE.Group;
    trouser: THREE.Mesh;
    bareShin: THREE.Mesh;
  }
  function buildLeg(side: 1 | -1): Leg {
    const hip = new THREE.Group();
    hip.position.set(side * HIP_WIDTH, -0.02, 0);
    body.add(hip);
    const thigh = limb(THIGH, 0.095, bottomMat);
    hip.add(thigh);
    const knee = new THREE.Group();
    knee.position.y = -THIGH;
    hip.add(knee);
    const trouser = limb(SHIN, 0.085, bottomMat);
    knee.add(trouser);
    const bareShin = limb(SHIN, 0.07, skinMat);
    bareShin.visible = false;
    knee.add(bareShin);
    const foot = new THREE.Group();
    foot.position.y = -SHIN + 0.06;
    knee.add(foot);
    const shoe = mesh(new THREE.BoxGeometry(0.17, 0.12, 0.3), shoeMat, 0, -0.02, 0.05);
    foot.add(shoe);
    const toe = mesh(new THREE.SphereGeometry(0.085, 8, 6), shoeMat, 0, -0.02, 0.17);
    toe.scale.set(1, 0.7, 1);
    foot.add(toe);
    return { hip, knee, foot, trouser, bareShin };
  }
  const legL = buildLeg(-1);
  const legR = buildLeg(1);

  // ---------- tray, bowl, soup ----------
  // trayPivot hangs off the hand and counter-rotates so the tray stays level
  // while the arm and body move; the player's own tilt is applied to trayGroup.
  const trayPivot = new THREE.Group();
  armL.hand.add(trayPivot);
  trayPivot.position.set(0, -0.02, 0.04);

  const trayGroup = new THREE.Group();
  trayPivot.add(trayGroup);
  const tray = mesh(new THREE.CylinderGeometry(0.4, 0.38, 0.045, 24), metalMat, 0, 0.03, 0);
  trayGroup.add(tray);
  const trayRim = mesh(new THREE.TorusGeometry(0.4, 0.022, 6, 24), metalMat, 0, 0.055, 0);
  trayRim.rotation.x = Math.PI / 2;
  trayGroup.add(trayRim);
  const cloth = mesh(new THREE.CylinderGeometry(0.3, 0.32, 0.02, 18), apronMat, 0, 0.06, 0);
  trayGroup.add(cloth);

  const bowlGroup = new THREE.Group();
  bowlGroup.position.set(0, 0.06, 0);
  trayGroup.add(bowlGroup);
  // bowl profile: foot -> belly -> rim (lathe, 24 segments)
  const profile = [
    new THREE.Vector2(0.001, 0),
    new THREE.Vector2(0.09, 0.005),
    new THREE.Vector2(0.17, 0.05),
    new THREE.Vector2(0.235, 0.14),
    new THREE.Vector2(0.26, 0.23),
    new THREE.Vector2(0.245, 0.235),
  ];
  const bowl = mesh(new THREE.LatheGeometry(profile, 24), bowlMat, 0, 0, 0);
  bowlGroup.add(bowl);
  const bowlRim = mesh(new THREE.TorusGeometry(0.253, 0.018, 6, 24), new THREE.MeshLambertMaterial({ color: 0x3c6ea5 }), 0, 0.232, 0);
  bowlRim.rotation.x = Math.PI / 2;
  bowlGroup.add(bowlRim);

  // Soup surface: a flat disc in the XY plane. Gameplay code tilts it with
  // rotation.x/-y and scales it down as the bowl empties (same contract as the
  // original single-file version).
  const soupMesh = new THREE.Mesh(new THREE.CircleGeometry(0.21, 24), soupMat);
  soupMesh.position.y = 0.16;
  soupMesh.rotation.x = -Math.PI / 2; // flat; main.ts re-applies this each frame
  soupMesh.castShadow = false;
  bowlGroup.add(soupMesh);
  const SOUP_FULL_Y = 0.185;
  const SOUP_EMPTY_Y = 0.055;

  // ---------- style handling ----------
  let lookYaw = 0;
  let lookPitch = 0;

  function applyStyle(next: WaiterStyle): void {
    topMat.color.set(next.primaryColor);
    bottomMat.color.set(next.secondaryColor);
    skinMat.color.set(next.skinColor);
    hairMat.color.set(next.hairColor);
    accentMat.color.set(next.secondaryColor).multiplyScalar(0.75);
    // waistcoat reads as a dark uniform piece, but keeps a hint of the colour
    vestMat.color.set(next.primaryColor).lerp(new THREE.Color(0x15181f), 0.78);
    for (const [k, v] of hairVariants) v.visible = k === next.hair;
    for (const [k, v] of hatVariants) v.visible = k === next.hat;
    for (const [k, v] of accessoryVariants) v.visible = k === next.accessory;
    const female = next.body === 'female';
    skirt.visible = female;
    pelvis.visible = !female;
    for (const leg of [legL, legR]) {
      leg.trouser.visible = !female;
      leg.bareShin.visible = female;
    }
    shoulders.scale.set(female ? 1.28 : 1.45, 0.75, 1);
    chest.scale.set(female ? 0.92 : 1, 1, female ? 0.92 : 1);
    apronSkirt.scale.set(female ? 0.94 : 1, 1, female ? 0.94 : 1);
    apronBib.scale.set(female ? 0.94 : 1, 1, female ? 0.94 : 1);
  }
  applyStyle(normalize(style));

  // ---------- animation state ----------
  let phase = 0;
  let gait = 0; // 0 = idle pose, 1 = full walk
  let elapsed = 0;
  let bank = 0;
  let lean = 0;

  const localDir = new THREE.Vector3();

  const api: Waiter = {
    root,
    trayGroup,
    soupMesh,

    setStyle(next: Partial<WaiterStyle> | null | undefined): void {
      applyStyle(normalize(next));
    },

    setSoupLevel(fraction01: number): void {
      const f = THREE.MathUtils.clamp(fraction01, 0, 1);
      soupMesh.position.y = THREE.MathUtils.lerp(SOUP_EMPTY_Y, SOUP_FULL_Y, f);
      soupMesh.visible = f > 0.02;
    },

    soupWorldPosition(out: THREE.Vector3): THREE.Vector3 {
      return soupMesh.getWorldPosition(out);
    },

    update(dt: number, motion: WaiterMotion): void {
      // Be defensive: the gameplay code measures speed/turnRate by dividing by
      // dt, which yields NaN when dt is 0 (or non-finite). A single NaN would
      // poison every transform below and the character would vanish.
      const d = Number.isFinite(dt) ? Math.min(dt, 0.05) : 0;
      elapsed += d;

      const speed = Number.isFinite(motion.speed) ? Math.max(0, motion.speed) : 0;
      const turnRate = Number.isFinite(motion.turnRate) ? motion.turnRate : 0;
      const norm = THREE.MathUtils.clamp(speed / MAX_SPEED, 0, 1.25);
      const walking = motion.moving && speed > 0.15;
      // ease in/out so stopping settles into the idle pose instead of snapping
      const rate = walking ? 9 : 12;
      gait += (Number(walking) - gait) * Math.min(1, rate * d);
      gait = THREE.MathUtils.clamp(gait, 0, 1);

      // Stride frequency is derived from real speed, so the feet never slide.
      if (speed > 0.02) phase += (d * speed) / STRIDE * Math.PI * 2;

      const swing = Math.sin(phase);
      const legAmp = (0.3 + 0.32 * norm) * gait;
      const kneeAmp = (0.35 + 0.8 * norm) * gait;
      const idleKnee = 0.07;

      function poseLeg(leg: Leg, ph: number): void {
        const s = Math.sin(ph);
        // hip swings forward on the positive half of the cycle
        leg.hip.rotation.x = -s * legAmp;
        // knee bends during the swing-forward half
        const bend = Math.max(0, -Math.sin(ph + 0.6)) * kneeAmp;
        leg.knee.rotation.x = bend + idleKnee * (1 - gait);
        // keep the sole roughly flat, plus a little toe roll
        leg.foot.rotation.x = -leg.knee.rotation.x - s * 0.22 * gait;
      }
      poseLeg(legL, phase);
      poseLeg(legR, phase + Math.PI);

      // body bob (twice per stride) + idle breathing
      const bob = (0.015 + 0.055 * norm) * (0.5 - 0.5 * Math.cos(phase * 2)) * gait;
      const breathe = Math.sin(elapsed * 1.7) * 0.012 * (1 - gait * 0.6);
      body.position.y = HIP_Y + bob + breathe;

      // lean into the run, bank into turns, sway with the stride
      const bankTarget = THREE.MathUtils.clamp(-turnRate * 0.16, -0.22, 0.22);
      bank += (bankTarget - bank) * Math.min(1, 8 * d);
      const leanTarget = 0.03 + 0.13 * norm;
      lean += (leanTarget - lean) * Math.min(1, 6 * d);
      body.rotation.x = lean;
      body.rotation.z = bank + swing * 0.035 * gait;

      // torso counter-twist against the legs, shoulder roll
      const twist = swing * 0.12 * gait - turnRate * 0.08;
      torso.rotation.y = THREE.MathUtils.lerp(torso.rotation.y, twist, Math.min(1, 10 * d));
      shoulders.rotation.z = -swing * 0.06 * gait;

      // arms: opposite phase to the legs, tray arm much calmer
      const armAmp = (0.16 + 0.4 * norm) * gait;
      const carryL = { shoulder: -0.55, elbow: -0.62 };
      const carryR = { shoulder: -0.18, elbow: -0.42 };
      armL.shoulder.rotation.x = carryL.shoulder + swing * armAmp * 0.45;
      armL.shoulder.rotation.z = -0.16 - gait * 0.02;
      armL.elbow.rotation.x = carryL.elbow - swing * armAmp * 0.2;
      armR.shoulder.rotation.x = carryR.shoulder - swing * armAmp;
      armR.shoulder.rotation.z = 0.14;
      armR.elbow.rotation.x = carryR.elbow + Math.max(0, swing) * armAmp * 0.5;

      // head: steady against the bob, and glances at the target while standing
      let wantYaw = 0;
      let wantPitch = 0;
      if (motion.lookAt) {
        localDir.copy(motion.lookAt).sub(root.position);
        localDir.applyAxisAngle(UP, -root.rotation.y);
        if (localDir.z > 0.1) {
          wantYaw = THREE.MathUtils.clamp(Math.atan2(localDir.x, localDir.z), -0.75, 0.75);
          const flat = Math.hypot(localDir.x, localDir.z);
          wantPitch = THREE.MathUtils.clamp(-Math.atan2(localDir.y - 1.7, flat), -0.3, 0.3);
        }
      }
      const glance = 1 - gait;
      lookYaw += (wantYaw * glance - lookYaw) * Math.min(1, 2.2 * d);
      lookPitch += (wantPitch * glance - lookPitch) * Math.min(1, 2.2 * d);
      head.rotation.y = lookYaw - torso.rotation.y * 0.45;
      head.rotation.x = lookPitch - lean * 0.6;
      head.rotation.z = -bank * 0.7 + swing * 0.03 * gait;

      // tray stays level: cancel the pitch/roll the body and arm added
      trayPivot.rotation.x = -(body.rotation.x + armL.shoulder.rotation.x + armL.elbow.rotation.x);
      trayPivot.rotation.z = -(body.rotation.z + armL.shoulder.rotation.z * 0.6);
      // tiny float so the tray is not welded to the hand
      trayPivot.position.y = -0.02 + Math.sin(elapsed * 2.2) * 0.004;
    },
  };

  return api;
}
