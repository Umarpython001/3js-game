import * as THREE from 'three';

/**
 * Small, generated textures. Nothing is loaded from disk, so the build stays
 * self-contained and there is no risk of a missing asset on start.ng.
 * Every texture is created once and cached.
 */

function makeCanvas(size: number): { c: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d')!;
  return { c, ctx };
}

function finish(c: HTMLCanvasElement, repeatX: number, repeatY: number): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatX, repeatY);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

const cache = new Map<string, THREE.Texture>();

function cached(key: string, build: () => THREE.Texture): THREE.Texture {
  const hit = cache.get(key);
  if (hit) return hit;
  const tex = build();
  cache.set(key, tex);
  return tex;
}

/** Adds a little noise so flat Lambert surfaces do not look like plastic. */
function speckle(ctx: CanvasRenderingContext2D, size: number, amount: number, alpha: number) {
  for (let i = 0; i < amount; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const v = Math.random();
    ctx.fillStyle = `rgba(${v > 0.5 ? '255,255,255' : '60,40,25'},${alpha})`;
    ctx.fillRect(x, y, 2, 2);
  }
}

/**
 * Chequered restaurant floor. The texture covers a 4m x 4m patch of
 * 1m tiles (4x4 tiles per patch) with grout lines and a warm pattern.
 */
export function floorTexture(): THREE.Texture {
  return cached('floor', () => {
    const size = 512;
    const { c, ctx } = makeCanvas(size);
    const tiles = 4;
    const t = size / tiles;

    ctx.fillStyle = '#8a6444';
    ctx.fillRect(0, 0, size, size); // grout

    for (let y = 0; y < tiles; y++) {
      for (let x = 0; x < tiles; x++) {
        const dark = (x + y) % 2 === 1;
        const base = dark ? [222, 205, 176] : [238, 226, 203];
        ctx.fillStyle = `rgb(${base[0]},${base[1]},${base[2]})`;
        ctx.fillRect(x * t + 3, y * t + 3, t - 6, t - 6);
        // inner highlight so tiles read as slightly beveled
        ctx.fillStyle = dark ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.35)';
        ctx.fillRect(x * t + 3, y * t + 3, t - 6, 4);
        // small corner motif on the light tiles
        if (!dark) {
          ctx.strokeStyle = 'rgba(150,110,70,0.35)';
          ctx.lineWidth = 2;
          ctx.strokeRect(x * t + t * 0.28, y * t + t * 0.28, t * 0.44, t * 0.44);
        }
      }
    }
    speckle(ctx, size, 2600, 0.06);
    return finish(c, 1, 1);
  });
}

/** Warm plaster for the walls, with a very subtle vertical banding. */
export function wallTexture(): THREE.Texture {
  return cached('wall', () => {
    const size = 256;
    const { c, ctx } = makeCanvas(size);
    ctx.fillStyle = '#f0dcc0';
    ctx.fillRect(0, 0, size, size);
    for (let x = 0; x < size; x += 16) {
      ctx.fillStyle = `rgba(190,150,110,${0.03 + Math.random() * 0.05})`;
      ctx.fillRect(x, 0, 8, size);
    }
    speckle(ctx, size, 1400, 0.05);
    return finish(c, 1, 1);
  });
}

/** Straight-grained wood for tables, chairs and the counter. */
export function woodTexture(): THREE.Texture {
  return cached('wood', () => {
    const size = 256;
    const { c, ctx } = makeCanvas(size);
    ctx.fillStyle = '#8b5a2b';
    ctx.fillRect(0, 0, size, size);
    for (let i = 0; i < 90; i++) {
      const y = Math.random() * size;
      const h = 1 + Math.random() * 3;
      ctx.fillStyle = `rgba(${Math.random() > 0.5 ? '190,140,90' : '105,65,35'},${0.18 + Math.random() * 0.2})`;
      ctx.fillRect(0, y, size, h);
    }
    // a few knots
    for (let i = 0; i < 4; i++) {
      ctx.strokeStyle = 'rgba(90,55,30,0.35)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(Math.random() * size, Math.random() * size, 8 + Math.random() * 12, 4 + Math.random() * 6, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    speckle(ctx, size, 900, 0.06);
    return finish(c, 1, 1);
  });
}

/** Soft radial blob used as a cheap contact-shadow / glow decal. */
export function glowTexture(): THREE.Texture {
  return cached('glow', () => {
    const size = 128;
    const { c, ctx } = makeCanvas(size);
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.45, 'rgba(255,255,255,0.55)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  });
}
