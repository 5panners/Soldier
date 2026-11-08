// Low-poly, flat-shaded mesh construction kit with per-vertex skin weights and a
// palette texture (one material, one draw call, engine-friendly UV colouring).

import * as THREE from 'three';

export const PALETTE = {
  skin: '#c89a78',
  skinShade: '#a87b5c',
  hair: '#3b2f25',
  lip: '#9c6b55',
  eye: '#1d1f22',
  fabric: '#6f6a4c',      // trousers / combat shirt (olive-khaki)
  fabricDark: '#57543c',
  fabricLight: '#827c5b',
  camo1: '#4e5236',
  camo2: '#8a7f5a',
  vest: '#7d6e4f',        // coyote plate carrier
  vestDark: '#64583f',
  vestLight: '#93835f',
  webbing: '#4d4535',
  boot: '#3a3128',
  bootSole: '#1f1b17',
  glove: '#2c2b28',
  gloveLight: '#3e3c37',
  helmet: '#6e6448',
  helmetDark: '#4f4835',
  pad: '#2f2e2a',
  black: '#17181a',
  gunmetal: '#26282b',
  gunLight: '#3a3d41',
  gunTan: '#8b7a5a',
  lens: '#2f6a7a',
  lensRed: '#ff3b24',
  radio: '#34352f',
  strap: '#3d3a2f',
  brass: '#b08d3c',
  white: '#e8e6df',
};

const GRID = 8;
const NAMES = Object.keys(PALETTE);
const UVS = {};
NAMES.forEach((n, i) => {
  const col = i % GRID, row = Math.floor(i / GRID);
  UVS[n] = [(col + 0.5) / GRID, (row + 0.5) / GRID];
});

let _paletteTexture = null;
/** 8x8 palette texture (flipY=false, glTF convention: v=0 is the top row). */
export function paletteTexture() {
  if (_paletteTexture) return _paletteTexture;
  const size = GRID * 4;
  const data = new Uint8Array(size * size * 4);
  NAMES.forEach((n, i) => {
    const c = new THREE.Color(PALETTE[n]); // sRGB hex -> linear internally
    const srgb = c.clone().convertLinearToSRGB();
    const col = i % GRID, row = Math.floor(i / GRID);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
      const px = col * 4 + x, py = row * 4 + y;
      const o = (py * size + px) * 4;
      data[o] = Math.round(srgb.r * 255);
      data[o + 1] = Math.round(srgb.g * 255);
      data[o + 2] = Math.round(srgb.b * 255);
      data[o + 3] = 255;
    }
  });
  let tex;
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(size, size);
    img.data.set(data);
    ctx.putImageData(img, 0, 0);
    tex = new THREE.CanvasTexture(canvas);
  } else {
    tex = new THREE.DataTexture(data, size, size);
    tex.needsUpdate = true;
  }
  tex.flipY = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.name = 'SoldierPalette';
  return tex;
}

export function flatMaterial(name = 'Soldier') {
  const m = new THREE.MeshStandardMaterial({
    map: paletteTexture(),
    flatShading: true,
    roughness: 0.82,
    metalness: 0.0,
  });
  m.name = name;
  return m;
}

const tmp = new THREE.Vector3();

/**
 * Accumulates triangles. Weights: either an array [[boneIndex, w], ...] or a
 * function (worldPos: Vector3) => [[boneIndex, w], ...].
 */
export class MeshBuilder {
  constructor() {
    this.pos = []; this.uv = []; this.si = []; this.sw = [];
  }

  _w(weights, p) {
    let w = typeof weights === 'function' ? weights(p) : weights;
    if (!w) w = [[0, 1]];
    w = w.filter((e) => e[1] > 1e-4).sort((a, b) => b[1] - a[1]).slice(0, 4);
    const sum = w.reduce((s, e) => s + e[1], 0) || 1;
    const idx = [0, 0, 0, 0], wt = [0, 0, 0, 0];
    w.forEach((e, i) => { idx[i] = e[0]; wt[i] = e[1] / sum; });
    return [idx, wt];
  }

  tri(a, b, c, color, weights) {
    const uv = UVS[color];
    if (!uv) throw new Error('Unknown palette colour ' + color);
    // skip degenerate
    tmp.subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
    if (tmp.lengthSq() < 1e-14) return;
    for (const p of [a, b, c]) {
      this.pos.push(p.x, p.y, p.z);
      this.uv.push(uv[0], uv[1]);
      const [i, w] = this._w(weights, p);
      this.si.push(...i); this.sw.push(...w);
    }
  }

  quad(a, b, c, d, color, weights) { // CCW seen from outside
    this.tri(a, b, c, color, weights);
    this.tri(a, c, d, color, weights);
  }

  poly(points, color, weights) { // convex fan, CCW
    for (let i = 1; i < points.length - 1; i++) this.tri(points[0], points[i], points[i + 1], color, weights);
  }

  /**
   * Loft between rings (each an array of N points, ordered CCW when looking down
   * the loft direction from start toward end... i.e. right-handed about the axis).
   * colors: single colour or array per segment. weights: per-ring array or function.
   */
  loft(rings, colors, weights, { capStart = true, capEnd = true } = {}) {
    const n = rings[0].length;
    for (let r = 0; r < rings.length - 1; r++) {
      const A = rings[r], B = rings[r + 1];
      const col = Array.isArray(colors) ? colors[Math.min(r, colors.length - 1)] : colors;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const wf = typeof weights === 'function' ? weights : (p) => null;
        if (typeof weights === 'function') {
          this.quad(A[i], A[j], B[j], B[i], col, weights);
        } else {
          // per-ring weights: apply ring weights by vertex membership
          const wa = weights[r], wb = weights[r + 1];
          this._triW(A[i], A[j], B[j], col, wa, wa, wb);
          this._triW(A[i], B[j], B[i], col, wa, wb, wb);
        }
      }
    }
    const capCol = (i) => (Array.isArray(colors) ? colors[i] : colors);
    if (capStart) {
      const ring = rings[0];
      const w = typeof weights === 'function' ? weights : weights[0];
      const pts = [...ring].reverse();
      this.poly(pts, capCol(0), w);
    }
    if (capEnd) {
      const ring = rings[rings.length - 1];
      const w = typeof weights === 'function' ? weights : weights[weights.length - 1];
      this.poly(ring, capCol(Array.isArray(colors) ? colors.length - 1 : 0), w);
    }
  }

  _triW(a, b, c, color, wa, wb, wc) {
    const uv = UVS[color];
    tmp.subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
    if (tmp.lengthSq() < 1e-14) return;
    for (const [p, w] of [[a, wa], [b, wb], [c, wc]]) {
      this.pos.push(p.x, p.y, p.z);
      this.uv.push(uv[0], uv[1]);
      const [i, ww] = this._w(w, p);
      this.si.push(...i); this.sw.push(...ww);
    }
  }

  /** Oriented box from centre, half-extents and optional quaternion; taper scales the +Y face. */
  box(center, size, color, weights, { quat = null, taperTop = [1, 1], taperBottom = [1, 1], colors = null } = {}) {
    const hx = size[0] / 2, hy = size[1] / 2, hz = size[2] / 2;
    const c = [];
    for (const y of [-1, 1]) for (const z of [-1, 1]) for (const x of [-1, 1]) {
      const t = y > 0 ? taperTop : taperBottom;
      const p = new THREE.Vector3(x * hx * t[0], y * hy, z * hz * t[1]);
      if (quat) p.applyQuaternion(quat);
      c.push(p.add(center));
    }
    // index: (y,z,x) -> y*4 + z*2 + x  ; x,y,z in {0,1}
    const I = (x, y, z) => c[y * 4 + z * 2 + x];
    const col = (k) => (colors && colors[k]) || color;
    this.quad(I(0, 0, 1), I(1, 0, 1), I(1, 1, 1), I(0, 1, 1), col('front'), weights); // +Z
    this.quad(I(1, 0, 0), I(0, 0, 0), I(0, 1, 0), I(1, 1, 0), col('back'), weights);  // -Z
    this.quad(I(1, 0, 1), I(1, 0, 0), I(1, 1, 0), I(1, 1, 1), col('left'), weights);  // +X
    this.quad(I(0, 0, 0), I(0, 0, 1), I(0, 1, 1), I(0, 1, 0), col('right'), weights); // -X
    this.quad(I(0, 1, 1), I(1, 1, 1), I(1, 1, 0), I(0, 1, 0), col('top'), weights);   // +Y
    this.quad(I(0, 0, 0), I(1, 0, 0), I(1, 0, 1), I(0, 0, 1), col('bottom'), weights); // -Y
  }

  /** Low-poly ellipsoid. */
  ellipsoid(center, radii, color, weights, { w = 8, h = 6, quat = null, cutBelow = null } = {}) {
    const rings = [];
    for (let j = 1; j < h; j++) {
      const phi = Math.PI * j / h; // 0 top .. PI bottom
      const ring = [];
      for (let i = 0; i < w; i++) {
        const th = 2 * Math.PI * i / w;
        const p = new THREE.Vector3(
          Math.sin(phi) * Math.cos(th) * radii[0],
          Math.cos(phi) * radii[1],
          -Math.sin(phi) * Math.sin(th) * radii[2]);
        if (quat) p.applyQuaternion(quat);
        ring.push(p.add(center));
      }
      rings.push(ring);
    }
    const top = new THREE.Vector3(0, radii[1], 0); if (quat) top.applyQuaternion(quat); top.add(center);
    const bot = new THREE.Vector3(0, -radii[1], 0); if (quat) bot.applyQuaternion(quat); bot.add(center);
    for (let i = 0; i < w; i++) {
      const j = (i + 1) % w;
      this.tri(top, rings[0][i], rings[0][j], color, weights);
    }
    for (let r = 0; r < rings.length - 1; r++) {
      for (let i = 0; i < w; i++) {
        const j = (i + 1) % w;
        this.quad(rings[r][i], rings[r + 1][i], rings[r + 1][j], rings[r][j], color, weights);
      }
    }
    const last = rings[rings.length - 1];
    for (let i = 0; i < w; i++) {
      const j = (i + 1) % w;
      this.tri(bot, last[j], last[i], color, weights);
    }
  }

  /** Cylinder/prism between two points. */
  cylinder(a, b, r0, r1, color, weights, { n = 8, caps = true, roll = 0, scaleX = 1 } = {}) {
    const rings = [ring(a, b, r0, n, roll, scaleX), ring(b, a, r1, n, roll, scaleX, true)];
    this.loft(rings, color, typeof weights === 'function' ? weights : [weights, weights], { capStart: caps, capEnd: caps });
  }

  /** Append another builder's triangles, transforming positions with xf(Vector3) (in place). */
  append(o, xf = null) {
    const v = new THREE.Vector3();
    for (let i = 0; i < o.pos.length; i += 3) {
      v.set(o.pos[i], o.pos[i + 1], o.pos[i + 2]);
      if (xf) xf(v);
      this.pos.push(v.x, v.y, v.z);
    }
    this.uv.push(...o.uv); this.si.push(...o.si); this.sw.push(...o.sw);
  }

  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(this.si, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(this.sw, 4));
    g.computeVertexNormals(); // non-indexed => true face normals (flat)
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }

  buildStatic() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.computeVertexNormals();
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }
}

/**
 * Ring of n points around axis a->b at point a, radius r (number or [rx, rz]).
 * Points are CCW when looking from a toward b... ordered so loft faces point outward.
 */
export function ring(a, b, r, n = 8, roll = 0, scaleX = 1, atEnd = false) {
  const axis = new THREE.Vector3().subVectors(atEnd ? a : b, atEnd ? b : a).normalize();
  const center = a;
  // pick a stable perpendicular
  const ref = Math.abs(axis.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
  const u = new THREE.Vector3().crossVectors(ref, axis).normalize();
  const w = new THREE.Vector3().crossVectors(axis, u).normalize();
  const rx = Array.isArray(r) ? r[0] : r, rz = Array.isArray(r) ? r[1] : r;
  const pts = [];
  for (let i = 0; i < n; i++) {
    const th = roll + 2 * Math.PI * i / n;
    pts.push(center.clone()
      .addScaledVector(u, Math.cos(th) * rx * scaleX)
      .addScaledVector(w, Math.sin(th) * rz));
  }
  return pts;
}

/**
 * Elliptical ring in a plane given by an explicit frame: centre, axis (loft dir),
 * side (the 'x' radius direction). Ordered CCW about +axis.
 */
export function frameRing(center, axis, side, rx, rz, n = 8, opts = {}) {
  const ax = axis.clone().normalize();
  const u = side.clone().addScaledVector(ax, -side.dot(ax)).normalize();
  const w = new THREE.Vector3().crossVectors(ax, u);
  const pts = [];
  const flatBack = opts.flatBack ?? 1; // squash for -w half
  for (let i = 0; i < n; i++) {
    const th = (opts.phase ?? 0) + 2 * Math.PI * i / n;
    let s = Math.sin(th) * rz;
    if (s < 0) s *= flatBack;
    pts.push(center.clone().addScaledVector(u, Math.cos(th) * rx).addScaledVector(w, s));
  }
  // CCW about +axis: u -> w with w = axis x u gives CCW. Loft quads (A[i],A[j],B[j],B[i])
  // then face outward when lofting along +axis.
  return pts;
}
