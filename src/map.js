// Test map: a desert military base. Airfield (runway, taxiway, apron, two hangars, control tower),
// helipad, vehicle hard standing with workshops, a container yard and fuel point, a MOUT village of
// shoot houses for building-clearance drills (glass windows, internal stairs), a 25/50/100 m firing
// range with reactive targets, lookout towers with ladders, sandbag positions, HESCO, a perimeter
// fence with a gate, and dunes outside the wire.
//
// Everything static is merged into a handful of meshes (one per material). Solids are registered as
// colliders { type: 'box', x, z, hx, hz, yaw, bot, top, walk? } or { type: 'circle', ... }: the app's
// groundH stands the soldier on the highest surface at his level, so floors, stairs, roofs and
// platforms are all walkable. Glass panes and range targets are separate, interactive meshes.
// Coordinates: metres, +Z north, +X east, spawn at the origin facing north.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);

// ------------------------------------------------------------------ terrain
export const BASE = { x0: -230, x1: 230, z0: -225, z1: 200 };
/** Desert ground height: flat inside the base, rising into dunes outside the wire. */
export function terrainH(x, z) {
  const m = 25; // flat margin outside the fence
  const ox = Math.max(BASE.x0 - m - x, x - BASE.x1 - m, 0), oz = Math.max(BASE.z0 - m - z, z - BASE.z1 - m, 0);
  const o = Math.hypot(ox, oz);
  if (o <= 0) return 0;
  const k = Math.min(1, o / 60), e = k * k * (3 - 2 * k);
  const d = 3.2 + 2.2 * Math.sin(x * 0.021 + z * 0.013) * Math.cos(z * 0.017 - 0.4) + 1.3 * Math.sin(x * 0.057 - z * 0.041 + 1.1)
    + 0.6 * Math.sin(x * 0.11 + z * 0.09);
  return e * Math.max(0.3, d) * (0.6 + 0.4 * Math.min(1, o / 150));
}

function canvasTex(size, draw, repeat = 1) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat, repeat);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}
function sandTexture() {
  return canvasTex(256, (g, n) => {
    g.fillStyle = '#d1b689'; g.fillRect(0, 0, n, n);
    let seed = 11; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 2200; i++) {
      g.fillStyle = ['#c9ad7f', '#d8be93', '#c2a575', '#dcc59c', '#bfa171'][i % 5];
      g.fillRect(rnd() * n, rnd() * n, 1 + rnd() * 4, 1 + rnd() * 3);
    }
    g.strokeStyle = 'rgba(150,120,80,0.10)'; g.lineWidth = 2;
    for (let y = 8; y < n; y += 22) { g.beginPath(); for (let x = 0; x <= n; x += 8) g.lineTo(x, y + 4 * Math.sin(x * 0.05 + y)); g.stroke(); }
  });
}

/**
 * Build the map. Returns { root, ground, groundTex, glass, targets, colliders, walls, ladders,
 * terrainH, update(dt), onHit(hit, dir) }.
 */
export function buildMap() {
  const root = new THREE.Group(); root.name = 'Map';
  const glassGroup = new THREE.Group(); glassGroup.name = 'Glass';
  const targetGroup = new THREE.Group(); targetGroup.name = 'Targets';
  const fxGroup = new THREE.Group();
  root.add(glassGroup, targetGroup, fxGroup);
  const COLL = [], WALLS = [], LADDERS = [], OCC = [];
  const fx = [], targets = [];

  // ---------------------------------------------------------------- materials
  const mat = (color, o = {}) => new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.92, ...o });
  const hescoTex = canvasTex(64, (g, n) => {
    g.fillStyle = '#b8a27a'; g.fillRect(0, 0, n, n);
    g.strokeStyle = '#7d6f55'; g.lineWidth = 2;
    for (let i = 0; i <= n; i += 16) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, n); g.stroke(); g.beginPath(); g.moveTo(0, i); g.lineTo(n, i); g.stroke(); }
  });
  const fenceTex = canvasTex(64, (g, n) => {
    g.clearRect(0, 0, n, n); g.strokeStyle = 'rgba(150,155,160,1)'; g.lineWidth = 2;
    for (let i = -n; i < 2 * n; i += 16) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i + n, n); g.stroke(); g.beginPath(); g.moveTo(i + n, 0); g.lineTo(i, n); g.stroke(); }
  });
  const M = {
    asphalt: mat('#4a4844'), asphaltDark: mat('#3c3a37'), concrete: mat('#c4bcab'), concreteDark: mat('#a59d8c'),
    white: mat('#ece9df'), yellow: mat('#d8ad35'), red: mat('#b8322a'), plaster: mat('#cdb68e'), plasterDark: mat('#b09a72'),
    trim: mat('#8f7a58'), roof: mat('#9b8a6c'), hesco: mat('#ffffff', { map: hescoTex }), sandbag: mat('#ad9a6f'), sandbagDark: mat('#9b8860'),
    wood: mat('#7a5c3a'), steel: mat('#646b70', { roughness: 0.6, metalness: 0.25 }), steelDark: mat('#3f4448', { roughness: 0.6, metalness: 0.3 }),
    corrugated: mat('#9a9c98', { roughness: 0.7, metalness: 0.2 }), tan: mat('#b9a47c'), tanDark: mat('#94825f'), olive: mat('#5d6343'),
    tyre: mat('#232323'), canvas: mat('#9a8d68'), berm: mat('#b8935f'), rust: mat('#8b4a2e'), blue: mat('#3e5d78'), green: mat('#56684a'),
    sky: mat('#2a3439', { roughness: 0.2, metalness: 0.4 }), // tinted vehicle / aircraft glazing (static)
    board: mat('#d9cfb2'), silhouette: mat('#4b5e40'), orange: mat('#d9702a'), bush: mat('#7f7a4c'), bushDark: mat('#6a6740'),
    rock: mat('#a78b68'), heliBody: mat('#6f6a55'), light: mat('#fff3c4', { emissive: '#fff0b0', emissiveIntensity: 0.8 }),
    fence: new THREE.MeshStandardMaterial({ map: fenceTex, transparent: true, alphaTest: 0.4, side: THREE.DoubleSide, roughness: 0.6, metalness: 0.4 }),
  };
  const glassMat = new THREE.MeshStandardMaterial({ color: '#a9cbd6', transparent: true, opacity: 0.28, roughness: 0.05, metalness: 0.2, side: THREE.DoubleSide, depthWrite: false });

  // ---------------------------------------------------------------- merged static geometry
  const parts = new Map();
  const put = (geo, m) => {
    const g = geo.index ? geo.toNonIndexed() : geo;
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    if (!g.attributes.normal) g.computeVertexNormals();
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
    if (!parts.has(m)) parts.set(m, []);
    parts.get(m).push(g);
  };
  const occ = (x, z, hx, hz) => OCC.push([x - hx, x + hx, z - hz, z + hz]);
  const coll = (x, z, hx, hz, yaw, bot, top, o = {}) => {
    COLL.push({ type: 'box', x, z, hx, hz, yaw, bot, top, walk: !!o.walk });
    const r = Math.hypot(hx, hz); occ(x, z, Math.abs(yaw) > 1e-3 ? r : hx, Math.abs(yaw) > 1e-3 ? r : hz);
  };
  /** Box centred at (cx, cy, cz) with size (sx, sy, sz), turned by yaw about Y. Solid unless o.coll === false. */
  const box = (cx, cy, cz, sx, sy, sz, m, o = {}) => {
    const g = new THREE.BoxGeometry(sx, sy, sz);
    if (o.rx || o.rz) g.applyQuaternion(new THREE.Quaternion().setFromEuler(new THREE.Euler(o.rx || 0, 0, o.rz || 0)));
    if (o.yaw) g.rotateY(o.yaw);
    g.translate(cx, cy, cz);
    put(g, m);
    if (o.coll !== false) coll(cx, cz, sx / 2, sz / 2, o.yaw || 0, cy - sy / 2, cy + sy / 2, o);
  };
  /** Axis-aligned box from corner ranges. */
  const boxR = (x0, x1, y0, y1, z0, z1, m, o = {}) => box((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, x1 - x0, y1 - y0, z1 - z0, m, o);
  /** Flat horizontal plane (markings, pads, roads); no collider. */
  const flat = (cx, cz, sx, sz, y, m, yaw = 0) => {
    const g = new THREE.PlaneGeometry(sx, sz); g.rotateX(-Math.PI / 2); if (yaw) g.rotateY(yaw); g.translate(cx, y, cz); put(g, m);
    occ(cx, cz, sx / 2, sz / 2);
  };
  const cyl = (x, y, z, r0, r1, h, m, o = {}) => {
    const g = new THREE.CylinderGeometry(r0, r1, h, o.seg || 10, 1, !!o.open);
    if (o.rx || o.rz) g.applyQuaternion(new THREE.Quaternion().setFromEuler(new THREE.Euler(o.rx || 0, 0, o.rz || 0)));
    if (o.yaw) g.rotateY(o.yaw);
    g.translate(x, y, z); put(g, m);
  };
  /** Local builder: parts placed in an object's own frame (vehicles, aircraft). */
  const local = (x, z, yaw, y = 0) => {
    const T = new THREE.Matrix4().compose(V(x, y, z), new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), yaw), V(1, 1, 1));
    return {
      box(cx, cy, cz, sx, sy, sz, m, o = {}) {
        const g = new THREE.BoxGeometry(sx, sy, sz);
        if (o.rx || o.ry || o.rz) g.applyQuaternion(new THREE.Quaternion().setFromEuler(new THREE.Euler(o.rx || 0, o.ry || 0, o.rz || 0)));
        g.translate(cx, cy, cz); g.applyMatrix4(T); put(g, m);
      },
      cyl(cx, cy, cz, r0, r1, h, m, o = {}) {
        const g = new THREE.CylinderGeometry(r0, r1, h, o.seg || 12);
        g.applyQuaternion(new THREE.Quaternion().setFromEuler(new THREE.Euler(o.rx || 0, o.ry || 0, o.rz || 0)));
        g.translate(cx, cy, cz); g.applyMatrix4(T); put(g, m);
      },
      wheel(cx, cy, cz, r, w) { this.cyl(cx, cy, cz, r, r, w, M.tyre, { rz: Math.PI / 2, seg: 12 }); this.cyl(cx, cy, cz, r * 0.55, r * 0.55, w + 0.02, M.steelDark, { rz: Math.PI / 2, seg: 8 }); },
    };
  };

  // ---------------------------------------------------------------- glass (breakable panes)
  const pane = (cx, cy, cz, w, h, alongX) => {
    const g = new THREE.PlaneGeometry(w, h);
    if (!alongX) g.rotateY(Math.PI / 2);
    const m = new THREE.Mesh(g, glassMat);
    m.position.set(cx, cy, cz); m.renderOrder = 2;
    m.userData.glass = { w, h, alongX };
    glassGroup.add(m);
  };

  // ---------------------------------------------------------------- walls with doors and windows
  /**
   * Straight wall along X or Z from (ax, az) to (bx, bz), thickness t, from y0 to y0 + h.
   * openings: [{ at (metres from a, centre), w, bot, top, glass }] (a door: bot 0, top 2.1).
   */
  const wall = (ax, az, bx, bz, y0, h, t, m, openings = [], o = {}) => {
    const alongX = Math.abs(bx - ax) > Math.abs(bz - az);
    const len = alongX ? Math.abs(bx - ax) : Math.abs(bz - az);
    const sgn = alongX ? Math.sign(bx - ax) : Math.sign(bz - az);
    const at = (s) => (alongX ? [ax + sgn * s, az] : [ax, az + sgn * s]);
    const piece = (s0, s1, y1, y2) => {
      if (s1 - s0 < 0.01 || y2 - y1 < 0.01) return;
      const [cx, cz] = at((s0 + s1) / 2);
      if (alongX) box(cx, (y1 + y2) / 2, cz, s1 - s0, y2 - y1, t, m, o); else box(cx, (y1 + y2) / 2, cz, t, y2 - y1, s1 - s0, m, o);
    };
    let cur = 0;
    for (const op of [...openings].sort((p, q) => p.at - q.at)) {
      const s0 = op.at - op.w / 2, s1 = op.at + op.w / 2;
      piece(cur, s0, y0, y0 + h);
      if (op.bot > 0) piece(s0, s1, y0, y0 + op.bot);
      if (op.top < h) piece(s0, s1, y0 + op.top, y0 + h);
      const [cx, cz] = at(op.at);
      if (op.glass) {
        pane(cx, y0 + (op.bot + op.top) / 2, cz, op.w - 0.04, op.top - op.bot - 0.04, alongX);
        // frame: sill and head
        if (alongX) { box(cx, y0 + op.bot + 0.03, cz, op.w, 0.06, t + 0.06, M.trim, { coll: false }); box(cx, y0 + op.top - 0.03, cz, op.w, 0.06, t + 0.02, M.trim, { coll: false }); }
        else { box(cx, y0 + op.bot + 0.03, cz, t + 0.06, 0.06, op.w, M.trim, { coll: false }); box(cx, y0 + op.top - 0.03, cz, t + 0.02, 0.06, op.w, M.trim, { coll: false }); }
      }
      cur = s1;
    }
    piece(cur, len, y0, y0 + h);
  };
  const door = (at, w = 1.0) => ({ at, w, bot: 0, top: 2.1 });
  const win = (at, w = 1.2, bot = 0.9, top = 2.0) => ({ at, w, bot, top, glass: true });

  /** Straight flight of walkable treads rising along +X / -X / +Z / -Z from (x, z). Returns the run length. */
  const stairs = (x, z, dir, width, n, rise, run, m, rail = 0) => {
    // dir: 'x+', 'x-', 'z+', 'z-'; rail: which side gets a banister (+1 / -1 across the flight, 0 none)
    const ax = dir[0] === 'x', s = dir[1] === '+' ? 1 : -1;
    for (let i = 0; i < n; i++) {
      const a = i * run, b = (i + 1) * run, top = (i + 1) * rise;
      if (ax) boxR(Math.min(x + s * a, x + s * b), Math.max(x + s * a, x + s * b), 0, top, z - width / 2, z + width / 2, m, { walk: true });
      else boxR(x - width / 2, x + width / 2, 0, top, Math.min(z + s * a, z + s * b), Math.max(z + s * a, z + s * b), m, { walk: true });
      if (rail && i >= 3) { // invisible banister keeps him on the flight above 0.8 m
        const off = rail * (width / 2 + 0.1);
        if (ax) COLL.push({ type: 'box', x: x + s * (a + b) / 2, z: z + off, hx: run / 2, hz: 0.1, yaw: 0, bot: 0, top: top + 1.0 });
        else COLL.push({ type: 'box', x: x + off, z: z + s * (a + b) / 2, hx: 0.1, hz: run / 2, yaw: 0, bot: 0, top: top + 1.0 });
      }
    }
    if (rail) { // handrail on posts
      const off = rail * (width / 2 + 0.1), L = n * run, H = n * rise;
      const a0 = 3 * run, y0 = 4 * rise + 0.95, y1 = H + 0.95, len = Math.hypot(L - a0, y1 - y0), ang = Math.atan2(y1 - y0, L - a0);
      const mid = (a0 + L) / 2;
      if (ax) box(x + s * mid, (y0 + y1) / 2, z + off, len, 0.06, 0.06, M.steel, { coll: false, rz: s * ang });
      else box(x + off, (y0 + y1) / 2, z + s * mid, 0.06, 0.06, len, M.steel, { coll: false, rx: -s * ang });
      for (let i = 3; i < n; i += 2) {
        const a = (i + 0.5) * run, hgt = (i + 1) * rise + 0.95;
        if (ax) box(x + s * a, hgt / 2, z + off, 0.05, hgt, 0.05, M.steel, { coll: false }); else box(x + off, hgt / 2, z + s * a, 0.05, hgt, 0.05, M.steel, { coll: false });
      }
    }
    return n * run;
  };

  /** Vertical ladder on a south-facing face at z = zFace (the climber faces +Z), rungs 0.04 + 0.3 k above base. */
  const ladder = (x, zFace, base, top, platformZ) => {
    const LZ = zFace - 0.12;
    for (const sx of [-0.27, 0.27]) box(x + sx, base + (top - base + 1.1) / 2, LZ, 0.06, top - base + 1.1, 0.06, M.steel, { coll: false });
    for (let k = 0; base + 0.04 + 0.3 * k < top + 0.9; k++) cyl(x, base + 0.04 + 0.3 * k, LZ, 0.018, 0.018, 0.54, M.steel, { rz: Math.PI / 2, seg: 6 });
    for (let y = base + 1.5; y < top; y += 2.5) for (const sx of [-0.27, 0.27]) box(x + sx, y, (LZ + zFace) / 2, 0.05, 0.05, Math.abs(zFace - LZ) + 0.04, M.steel, { coll: false });
    LADDERS.push({ x, rungZ: LZ, base, top, hipZ: LZ - 0.42, platformZ });
  };

  /** Sandbag wall from a to b (straight), `rows` bags high, one or two bags thick. Solid. */
  let bagSeed = 5; const bagRnd = () => ((bagSeed = (bagSeed * 16807) % 2147483647) / 2147483647);
  const sandbags = (ax, az, bx, bz, rows = 6, thick = 1) => {
    const len = Math.hypot(bx - ax, bz - az), yaw = Math.atan2(bx - ax, bz - az) - Math.PI / 2;
    const dx = (bx - ax) / len, dz = (bz - az) / len, nx = -dz, nz = dx;
    const L = 0.55, H = 0.15, D = 0.32;
    for (let r = 0; r < rows; r++) {
      const off = r % 2 ? L / 2 : 0;
      for (let k = 0; k < thick; k++) {
        for (let s = -off; s < len - 0.05; s += L) {
          const a = Math.max(0, s), b = Math.min(len, s + L), c = (a + b) / 2, w = b - a;
          if (w < 0.12) continue;
          const kk = (k - (thick - 1) / 2) * D;
          const g = new THREE.BoxGeometry(w - 0.02, H * (0.92 + 0.12 * bagRnd()), D - 0.02);
          g.rotateY(yaw + (bagRnd() - 0.5) * 0.08);
          g.translate(ax + dx * c + nx * kk, H * (r + 0.5), az + dz * c + nz * kk);
          put(g, (r + k) % 3 ? M.sandbag : M.sandbagDark);
        }
      }
    }
    coll(ax + (bx - ax) / 2, az + (bz - az) / 2, len / 2, (D * thick) / 2, yaw, 0, rows * H);
  };
  /** Line of HESCO blast-wall units (1 m cubes, 1.37 m high) from a to b. */
  const hesco = (ax, az, bx, bz, h = 1.37) => {
    const len = Math.hypot(bx - ax, bz - az), yaw = Math.atan2(bx - ax, bz - az) - Math.PI / 2, n = Math.max(1, Math.round(len));
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n, g = new THREE.BoxGeometry(len / n - 0.04, h, 1.0);
      g.rotateY(yaw); g.translate(ax + (bx - ax) * t, h / 2, az + (bz - az) * t); put(g, M.hesco);
    }
    coll((ax + bx) / 2, (az + bz) / 2, len / 2, 0.5, yaw, 0, h);
  };
  /** Chain-link fence with posts and three strands of barbed wire. Solid. */
  const fence = (ax, az, bx, bz) => {
    const len = Math.hypot(bx - ax, bz - az), yaw = Math.atan2(bx - ax, bz - az) - Math.PI / 2;
    const g = new THREE.PlaneGeometry(len, 2.4); const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * len / 0.6, uv.getY(i) * 2.4 / 0.6);
    g.rotateY(yaw); g.translate((ax + bx) / 2, 1.2, (az + bz) / 2); put(g, M.fence);
    const n = Math.ceil(len / 4);
    for (let i = 0; i <= n; i++) { const t = i / n; box(ax + (bx - ax) * t, 1.4, az + (bz - az) * t, 0.08, 2.8, 0.08, M.steel, { coll: false }); }
    for (const y of [2.5, 2.65, 2.8]) box((ax + bx) / 2, y, (az + bz) / 2, len, 0.015, 0.015, M.steelDark, { coll: false, yaw });
    coll((ax + bx) / 2, (az + bz) / 2, len / 2, 0.08, yaw, 0, 2.8);
  };
  const rock = (x, z, R) => {
    const y = terrainH(x, z), g = new THREE.DodecahedronGeometry(R, 0);
    g.scale(1, 0.7, 1); g.rotateY(x * 1.7); g.translate(x, y + R * 0.25, z); put(g, M.rock);
    COLL.push({ type: 'circle', x, z, r: R * 0.85, top: y + R * 0.95, base: y - R * 0.4, R });
    occ(x, z, R, R);
  };
  const bush = (x, z, s) => {
    const y = terrainH(x, z), g = new THREE.IcosahedronGeometry(s, 0);
    g.scale(1.2, 0.55, 1.1); g.rotateY(x); g.translate(x, y + s * 0.35, z); put(g, (Math.floor(x * 7 + z) & 1) ? M.bush : M.bushDark);
  };

  // ================================================================ ground
  const groundTex = sandTexture();
  groundTex.repeat.set(500, 500); // 2 m tiles (the viewer scrolls this texture under in-place clips)
  const gg = new THREE.PlaneGeometry(1000, 1000, 250, 250); gg.rotateX(-Math.PI / 2);
  { const p = gg.attributes.position; for (let i = 0; i < p.count; i++) p.setY(i, terrainH(p.getX(i), p.getZ(i))); gg.computeVertexNormals(); }
  const ground = new THREE.Mesh(gg, new THREE.MeshStandardMaterial({ map: groundTex, roughness: 1 }));
  ground.receiveShadow = true; ground.name = 'Ground';

  // ================================================================ roads
  flat(0, -105, 8, 230, 0.02, M.asphalt);          // main north-south road, gate to airfield
  flat(70, 0, 260, 8, 0.021, M.asphalt);           // east-west road (stops short of the MOUT village)
  for (let z = -215; z < 8; z += 8) flat(0, z + 2, 0.15, 3, 0.03, M.white);
  for (let x = -56; x < 196; x += 8) if (Math.abs(x) > 6) flat(x + 2, 0, 3, 0.15, 0.031, M.white);
  flat(-40, -40, 6, 72, 0.019, M.asphaltDark);     // track to the MOUT village and the range
  flat(-63, -76, 52, 6, 0.019, M.asphaltDark);
  flat(85, 8, 6, 8, 0.019, M.asphaltDark);         // spur to the vehicle park

  // ================================================================ airfield
  const RZ = 163;
  flat(0, RZ, 400, 26, 0.02, M.asphalt);                                     // runway 09/27
  for (const z of [RZ - 12.4, RZ + 12.4]) flat(0, z, 396, 0.5, 0.03, M.white); // edge lines
  for (let x = -170; x < 170; x += 30) flat(x + 7, RZ, 15, 0.7, 0.03, M.white); // centreline
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 8; i++) flat(sx * 190, RZ - 9.1 + i * 2.6, 14, 1.6, 0.03, M.white); // threshold bars
    for (const dz of [-5, 5]) flat(sx * 140, RZ + dz, 30, 3, 0.03, M.white);               // aiming points
    for (let i = 0; i < 9; i++) box(sx * 201, 0.25, RZ - 12 + i * 3, 0.3, 0.5, 0.3, M.light, { coll: false }); // end lights
  }
  flat(-52, 133, 16, 34, 0.02, M.asphalt);                                    // taxiway
  for (let z = 118; z < 150; z += 4) flat(-52, z, 0.3, 2.5, 0.03, M.yellow);
  flat(-60, 101, 140, 30, 0.022, M.concrete);                                 // apron
  for (const x of [-30, -10]) { flat(x, 106, 0.3, 16, 0.032, M.yellow); flat(x, 98, 8, 0.3, 0.032, M.yellow); }

  // hangars: 30 x 26 x 10 m, open to the apron (north)
  const hangar = (x0, z0) => {
    const x1 = x0 + 30, z1 = z0 + 26, H = 10;
    flat((x0 + x1) / 2, (z0 + z1) / 2, 30, 26, 0.022, M.concreteDark);
    wall(x0, z0, x1, z0, 0, H, 0.3, M.corrugated, [door(6, 1.1), win(15, 3, 6.5, 8.5), win(22, 3, 6.5, 8.5)]);
    wall(x0, z0, x0, z1, 0, H, 0.3, M.corrugated, [win(6, 3, 6.5, 8.5), win(13, 3, 6.5, 8.5), win(20, 3, 6.5, 8.5)]);
    wall(x1, z0, x1, z1, 0, H, 0.3, M.corrugated, [door(4, 1.1), win(13, 3, 6.5, 8.5), win(20, 3, 6.5, 8.5)]);
    boxR(x0 - 0.2, x1 + 0.2, H, H + 0.4, z0 - 0.2, z1 + 0.2, M.corrugated);   // roof
    boxR(x0, x1, H - 1.2, H, z1 - 0.3, z1, M.steelDark);                        // door header beam
    for (let x = x0 + 5; x < x1; x += 5) box(x, H - 0.6, (z0 + z1) / 2, 0.25, 0.5, 26, M.steelDark, { coll: false }); // trusses
  };
  hangar(-125, 58); hangar(-85, 58);
  // light aircraft in hangar A (generic two-seat trainer)
  {
    const A = local(-110, 70, 0);
    A.box(0, 1.3, 0, 1.2, 1.2, 6.5, M.white); A.box(0, 1.55, 1.4, 1.1, 0.7, 1.4, M.sky);
    A.box(0, 1.4, 0.6, 10.5, 0.14, 1.6, M.white); A.box(0, 1.7, -3.0, 0.1, 1.4, 1.1, M.white); A.box(0, 1.35, -3.0, 3.4, 0.1, 0.9, M.white);
    A.box(0, 1.3, 3.35, 0.1, 1.9, 0.12, M.steelDark); A.cyl(0, 1.3, 3.3, 0.3, 0.5, 0.4, M.red, { rx: Math.PI / 2 });
    for (const sx of [-1.2, 1.2]) { A.box(sx, 0.6, 0.6, 0.08, 0.9, 0.08, M.steelDark); A.wheel(sx, 0.3, 0.6, 0.3, 0.16); }
    A.wheel(0, 0.25, 2.6, 0.22, 0.12);
    coll(-110, 70, 5.2, 3.6, 0, 0, 2.4);
  }

  // control tower: 6 x 6 m base, glass cab with its floor 8 m up, ladder on the south face
  {
    const x0 = 22, x1 = 28, z0 = 97, z1 = 103, F = 8.0;
    boxR(x0, x1, 0, F, z0, z1, M.plaster);
    for (let y = 2.2; y < F; y += 2.6) for (const zz of [z0 - 0.02, z1 + 0.02]) box(25, y, zz, 4.4, 1.1, 0.04, M.sky, { coll: false });
    boxR(x0 - 0.3, x1 + 0.3, F - 0.25, F, z0 - 0.3, z1 + 0.3, M.concreteDark);             // cab floor (walkable)
    const cabWall = (ax, az, bx, bz, ops) => wall(ax, az, bx, bz, F, 2.8, 0.12, M.steelDark, ops);
    const glassRun = (len) => [0, 1, 2].map((i) => ({ at: len / 6 + i * len / 3, w: len / 3 - 0.18, bot: 0.9, top: 2.5, glass: true }));
    cabWall(x0 - 0.3, z1 + 0.3, x1 + 0.3, z1 + 0.3, glassRun(6.6));
    cabWall(x0 - 0.3, z0 - 0.3, x0 - 0.3, z1 + 0.3, glassRun(6.6));
    cabWall(x1 + 0.3, z0 - 0.3, x1 + 0.3, z1 + 0.3, glassRun(6.6));
    cabWall(x0 - 0.3, z0 - 0.3, x1 + 0.3, z0 - 0.3, [{ at: 1.5, w: 2.0, bot: 0.9, top: 2.5, glass: true }, door(3.3, 1.2), { at: 5.1, w: 2.0, bot: 0.9, top: 2.5, glass: true }]);
    boxR(x0 - 0.8, x1 + 0.8, F + 2.8, F + 3.1, z0 - 0.8, z1 + 0.8, M.roof);                  // cab roof
    cyl(27, F + 4.2, 101, 0.04, 0.04, 2.2, M.steel); box(27, F + 5.2, 101, 0.6, 0.06, 0.06, M.steel, { coll: false }); // mast
    box(24, 1.05, z0 - 0.05, 1.1, 2.1, 0.06, M.steelDark, { coll: false });                // (closed) ground door
    ladder(25.0, z0 - 0.3, 0, F, z0 + 0.9);
  }

  // helipad with a parked utility helicopter (generic design) and a windsock
  {
    const hx = 75, hz = 108;
    const disc = new THREE.CircleGeometry(12, 40); disc.rotateX(-Math.PI / 2); disc.translate(hx, 0.022, hz); put(disc, M.concrete); occ(hx, hz, 12, 12);
    const ring = new THREE.RingGeometry(10.1, 10.7, 40); ring.rotateX(-Math.PI / 2); ring.translate(hx, 0.03, hz); put(ring, M.yellow);
    flat(hx - 2.2, hz, 0.9, 6, 0.032, M.white); flat(hx + 2.2, hz, 0.9, 6, 0.032, M.white); flat(hx, hz, 3.5, 0.9, 0.032, M.white);
    for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2; box(hx + Math.cos(a) * 12.3, 0.12, hz + Math.sin(a) * 12.3, 0.25, 0.24, 0.25, M.light, { coll: false }); }
    const Hc = local(hx + 6, hz + 2, 0.4);
    Hc.box(0, 1.55, 0.3, 2.0, 1.8, 5.0, M.heliBody); Hc.box(0, 1.6, 2.9, 1.8, 1.4, 1.4, M.sky); Hc.box(0, 2.55, -0.2, 1.4, 0.5, 2.6, M.heliBody);
    Hc.cyl(0, 1.9, -4.4, 0.18, 0.42, 5.2, M.heliBody, { rx: Math.PI / 2 }); Hc.box(0, 2.6, -6.8, 0.12, 1.6, 0.9, M.heliBody); Hc.box(0.15, 2.8, -7.0, 0.05, 1.5, 0.15, M.steelDark);
    Hc.box(0, 2.0, -5.9, 2.2, 0.08, 0.6, M.heliBody); Hc.cyl(0, 3.0, -0.2, 0.12, 0.12, 0.5, M.steelDark);
    for (let i = 0; i < 4; i++) Hc.box(0, 3.25, -0.2, 0.35, 0.05, 15, M.steelDark, { ry: (i * Math.PI) / 4 + 0.3 });
    for (const sx of [-1.1, 1.1]) { Hc.box(sx, 0.12, 0.4, 0.1, 0.1, 4.6, M.steelDark); Hc.box(sx * 0.9, 0.45, 1.6, 0.08, 0.7, 0.08, M.steelDark); Hc.box(sx * 0.9, 0.45, -0.8, 0.08, 0.7, 0.08, M.steelDark); }
    coll(hx + 6 + Math.sin(0.4) * 0.3, hz + 2 + Math.cos(0.4) * 0.3, 1.2, 3.6, 0.4, 0, 3.2);
    cyl(hx - 16, 3, hz + 6, 0.06, 0.06, 6, M.steel); cyl(hx - 15.2, 5.6, hz + 6, 0.35, 0.18, 1.6, M.orange, { rz: Math.PI / 2 });
  }

  // ================================================================ vehicle park and workshops
  flat(85, 45, 90, 60, 0.023, M.concrete);
  for (let x = 45; x <= 125; x += 10) flat(x, 30, 0.2, 14, 0.033, M.yellow);
  const workshop = (x0) => {
    const x1 = x0 + 34, z0 = 56, z1 = 72, H = 7;
    wall(x0, z1, x1, z1, 0, H, 0.3, M.corrugated, [win(6, 2.5, 3.5, 5), win(17, 2.5, 3.5, 5), win(28, 2.5, 3.5, 5)]);
    wall(x0, z0, x0, z1, 0, H, 0.3, M.corrugated, [door(3), win(9, 3, 1.0, 2.2)]);
    wall(x1, z0, x1, z1, 0, H, 0.3, M.corrugated, [win(8, 3, 3.5, 5)]);
    // front: three bays with the roller doors raised, an office at the west end with a glazed front
    wall(x0, z0, x1, z0, 0, H, 0.3, M.corrugated, [{ at: 5, w: 3.0, bot: 0.9, top: 2.2, glass: true }, door(8.4, 1.0), { at: 14.5, w: 6.5, bot: 0, top: 5.4 }, { at: 22.2, w: 6.5, bot: 0, top: 5.4 }, { at: 29.9, w: 6.5, bot: 0, top: 5.4 }]);
    for (const at of [14.5, 22.2, 29.9]) box(x0 + at, 6.0, z0 - 0.35, 6.6, 0.9, 0.4, M.steelDark, { coll: false }); // rolled-up doors
    wall(x0 + 10, z0, x0 + 10, z1, 0, 3.0, 0.15, M.plaster, [door(5)]);                                         // office partition
    boxR(x0, x0 + 10, 3.0, 3.15, z0, z1, M.plaster);                                                            // office ceiling
    boxR(x0 - 0.4, x1 + 0.4, H, H + 0.3, z0 - 1.2, z1 + 0.4, M.corrugated);                                     // roof (with canopy)
    flat((x0 + x1) / 2, (z0 + z1) / 2, 34, 16, 0.024, M.concreteDark);
    for (const at of [18.4, 26.0]) box(x0 + at, 1.0, z0 + 8, 0.3, 2.0, 0.3, M.steelDark);                      // columns
    boxR(x0 + 12, x0 + 32, 0, 1.0, z1 - 1.0, z1 - 0.3, M.steel);                                                // workbenches
    for (let i = 0; i < 6; i++) boxR(x0 + 12.5 + i * 3.2, x0 + 14.3 + i * 3.2, 0, 1.9, z1 - 0.9, z1 - 0.35, i % 2 ? M.red : M.steelDark); // tool cabinets
    boxR(x0 + 20, x0 + 24.4, 0, 0.45, z0 + 4, z0 + 9, M.steelDark);                                             // vehicle lift
  };
  workshop(45); workshop(91);

  // vehicles (generic, original designs): cargo trucks, light patrol vehicles, a wheeled APC
  const truck = (x, z, yaw, m = M.tan) => {
    const T = local(x, z, yaw);
    T.box(0, 1.0, 0, 2.2, 0.3, 7.6, M.steelDark);                       // chassis
    T.box(0, 1.85, 2.75, 2.45, 1.5, 2.0, m); T.box(0, 2.35, 3.76, 2.2, 0.6, 0.04, M.sky); T.box(0, 1.45, 3.95, 2.3, 0.8, 0.6, m);
    T.box(0, 1.55, -1.1, 2.5, 0.6, 5.0, m); T.box(0, 2.6, -1.1, 2.5, 1.6, 5.0, M.canvas);
    for (const zz of [2.9, -0.4, -1.9]) for (const sx of [-1.12, 1.12]) T.wheel(sx, 0.55, zz, 0.55, 0.38);
    coll(x + Math.sin(yaw) * 0.2, z + Math.cos(yaw) * 0.2, 1.3, 4.0, yaw, 0, 3.4);
  };
  const patrol = (x, z, yaw, m = M.tan) => {
    const T = local(x, z, yaw);
    T.box(0, 0.95, 0, 2.15, 0.7, 4.8, m); T.box(0, 1.6, -0.4, 2.05, 0.7, 2.6, m); T.box(0, 1.65, 0.95, 1.9, 0.55, 0.06, M.sky, { rx: -0.35 });
    T.box(0, 1.15, 1.9, 2.1, 0.3, 1.0, m, { rx: 0.15 }); T.cyl(0, 2.1, -0.6, 0.45, 0.45, 0.25, M.steelDark, { seg: 12 });
    for (const zz of [1.55, -1.55]) for (const sx of [-1.02, 1.02]) T.wheel(sx, 0.48, zz, 0.48, 0.34);
    coll(x, z, 1.1, 2.45, yaw, 0, 2.3);
  };
  const apc = (x, z, yaw) => {
    const T = local(x, z, yaw);
    T.box(0, 1.45, 0, 2.8, 1.2, 7.2, M.tan); T.box(0, 1.25, 3.85, 2.6, 0.9, 0.8, M.tan, { rx: 0.5 }); T.box(0, 2.25, -0.4, 2.4, 0.4, 5.6, M.tanDark);
    T.cyl(0, 2.65, 0.2, 0.8, 0.9, 0.5, M.tanDark, { seg: 8 }); T.box(0, 2.75, 1.6, 0.12, 0.12, 2.4, M.steelDark);
    for (const zz of [2.6, 1.0, -1.0, -2.6]) for (const sx of [-1.32, 1.32]) T.wheel(sx, 0.6, zz, 0.6, 0.4);
    coll(x, z, 1.5, 3.9, yaw, 0, 2.9);
  };
  truck(50, 30, 0); truck(60, 30, 0, M.olive); truck(70, 30, 0);
  patrol(85, 30, 0); patrol(95, 30, 0, M.olive); patrol(105, 30, 0);
  apc(115, 30, 0); apc(125, 31, 0.05);
  truck(66, 63, Math.PI);   // in a workshop bay
  patrol(113, 63, Math.PI);

  // fuel point and container yard
  {
    for (const z of [22, 30]) { cyl(150, 1.6, z, 1.3, 1.3, 8, M.white, { rx: Math.PI / 2, seg: 14 }); coll(150, z, 1.3, 4.0, 0, 0, 2.9); for (const dz of [-2.5, 2.5]) box(150, 0.4, z + dz, 2.0, 0.8, 0.4, M.concreteDark, { coll: false }); }
    hesco(143, 16, 157, 16, 1.0); hesco(143, 36, 157, 36, 1.0); hesco(143, 16, 143, 36, 1.0); // bund
    box(140.6, 0.9, 26, 0.8, 1.8, 0.6, M.yellow); // pump
    const cols = [M.rust, M.blue, M.green, M.tan, M.rust, M.olive];
    let ci = 0;
    for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) {
      const x = 168 + c * 2.9, z = 46 + r * 8, stack = (r + c) % 3 === 0 ? 2 : 1;
      for (let s = 0; s < stack; s++) {
        const m = cols[ci++ % cols.length];
        box(x, 1.3 + s * 2.6, z, 2.44, 2.6, 6.06, m);
        for (let k = -2; k <= 2; k++) box(x + 1.23, 1.3 + s * 2.6, z + k * 1.1, 0.04, 2.3, 0.08, M.steelDark, { coll: false });
      }
    }
  }

  // ================================================================ accommodation / HQ blocks by the spawn
  const block = (x0, z0, len) => {
    const x1 = x0 + len, z1 = z0 + 9, H = 3.4, w = [];
    for (let a = 2.5; a < len - 1; a += 4) w.push(win(a, 1.4));
    wall(x0, z0, x1, z0, 0, H, 0.25, M.plaster, [...w.filter((o) => Math.abs(o.at - len / 2) > 2), door(len / 2, 1.4)]);
    wall(x0, z1, x1, z1, 0, H, 0.25, M.plaster, w);
    wall(x0, z0, x0, z1, 0, H, 0.25, M.plaster, [door(4.5)]); wall(x1, z0, x1, z1, 0, H, 0.25, M.plaster, [win(4.5)]);
    wall(x0 + len / 2 - 2, z0, x0 + len / 2 - 2, z1, 0, H, 0.15, M.plasterDark, [door(6.5)]);
    wall(x0 + len / 2 + 2, z0, x0 + len / 2 + 2, z1, 0, H, 0.15, M.plasterDark, [door(6.5)]);
    boxR(x0 - 0.5, x1 + 0.5, H, H + 0.25, z0 - 0.5, z1 + 0.5, M.roof);
    flat((x0 + x1) / 2, (z0 + z1) / 2, len, 9, 0.025, M.concreteDark);
  };
  block(-32, -22, 26); block(16, -22, 26); block(16, 12, 26);
  // flagpole and water tower
  cyl(10, 5, 8, 0.07, 0.05, 10, M.steel); box(10.9, 9.2, 8, 1.6, 1.0, 0.02, M.olive, { coll: false });
  COLL.push({ type: 'circle', x: 10, z: 8, r: 0.12, top: 10, base: 0, R: 0.1 });
  {
    for (const [sx, sz] of [[-1.6, -1.6], [1.6, -1.6], [-1.6, 1.6], [1.6, 1.6]]) box(-60 + sx, 4, 30 + sz, 0.25, 8, 0.25, M.steel);
    cyl(-60, 9.6, 30, 2.6, 2.6, 3.2, M.white, { seg: 16 }); cyl(-60, 11.6, 30, 0.3, 2.7, 0.8, M.white, { seg: 16 });
  }

  // ================================================================ MOUT village (shoot houses)
  // a walled compound (1 m walls you can vault) with five buildings for room-clearing drills
  {
    const X0 = -160, X1 = -70, Z0 = -72, Z1 = 12;
    flat((X0 + X1) / 2, (Z0 + Z1) / 2, X1 - X0, Z1 - Z0, 0.012, M.concreteDark);
    const lowWall = (ax, az, bx, bz) => {
      const len = Math.hypot(bx - ax, bz - az), alongX = Math.abs(bx - ax) > Math.abs(bz - az);
      boxR(Math.min(ax, bx) - (alongX ? 0 : 0.125), Math.max(ax, bx) + (alongX ? 0 : 0.125), 0, 0.96, Math.min(az, bz) - (alongX ? 0.125 : 0), Math.max(az, bz) + (alongX ? 0.125 : 0), M.plasterDark);
      boxR(Math.min(ax, bx) - (alongX ? 0 : 0.145), Math.max(ax, bx) + (alongX ? 0 : 0.145), 0.96, 1.0, Math.min(az, bz) - (alongX ? 0.145 : 0), Math.max(az, bz) + (alongX ? 0.145 : 0), M.plaster, { coll: false });
      WALLS.push({ x: (ax + bx) / 2, z: (az + bz) / 2, yaw: alongX ? 0 : Math.PI / 2, half: len / 2 });
    };
    // perimeter with gaps (gate on the east, a breach on the north)
    lowWall(X0, Z0, -125, Z0); lowWall(-119, Z0, X1, Z0);
    lowWall(X0, Z1, -110, Z1); lowWall(-104, Z1, X1, Z1);
    lowWall(X0, Z0, X0, Z1); lowWall(X1, Z0, X1, -34); lowWall(X1, -26, X1, Z1);
    // internal low walls (courtyards)
    lowWall(-120, -40, -100, -40); lowWall(-95, -20, -95, 0);

    // B1: single-storey house, 3 rooms
    {
      const x0 = -152, x1 = -140, z0 = -64, z1 = -54, H = 3.0;
      wall(x0, z0, x1, z0, 0, H, 0.25, M.plaster, [door(3), win(8.5)]);
      wall(x0, z1, x1, z1, 0, H, 0.25, M.plaster, [win(3), win(9)]);
      wall(x0, z0, x0, z1, 0, H, 0.25, M.plaster, [win(5)]);
      wall(x1, z0, x1, z1, 0, H, 0.25, M.plaster, [door(7.5), win(3)]);
      wall(-146, z0, -146, z1, 0, H, 0.15, M.plasterDark, [door(5)]);
      wall(-146, -59, x1, -59, 0, H, 0.15, M.plasterDark, [door(3)]);
      boxR(x0 - 0.2, x1 + 0.2, H, H + 0.2, z0 - 0.2, z1 + 0.2, M.roof);
      wall(x0 - 0.2, z0 - 0.2, x1 + 0.2, z0 - 0.2, H + 0.2, 0.5, 0.15, M.plasterDark, [], { coll: false });
    }
    // B2: two-storey house with an internal stair (rises east along the north wall)
    {
      const x0 = -132, x1 = -118, z0 = -64, z1 = -54, H = 3.2, H2 = 6.4;
      wall(x0, z0, x1, z0, 0, H2, 0.25, M.plaster, [door(3), win(7), win(11.5), win(3, 1.2, H + 0.9, H + 2.0), win(7, 1.2, H + 0.9, H + 2.0), win(11.5, 1.2, H + 0.9, H + 2.0)]);
      wall(x0, z1, x1, z1, 0, H2, 0.25, M.plaster, [win(9.5), win(3, 1.2, H + 0.9, H + 2.0), win(11, 1.2, H + 0.9, H + 2.0)]);
      wall(x0, z0, x0, z1, 0, H2, 0.25, M.plaster, [win(5), win(5, 1.2, H + 0.9, H + 2.0)]);
      wall(x1, z0, x1, z1, 0, H2, 0.25, M.plaster, [door(3.5), win(7), win(5, 1.2, H + 0.9, H + 2.0)]);
      wall(-125, z0, -125, -57.5, 0, H, 0.15, M.plasterDark, [door(2.5)]);           // ground floor partition
      const sx = -131.6, sz = -55.0;                                                  // stair: 16 treads x 0.2 m
      const run = stairs(sx, sz, 'x+', 1.4, 16, 0.2, 0.28, M.concreteDark, -1);
      // upper floor with the stairwell open above the upper part of the flight
      boxR(x0, x1, H - 0.2, H, z0, sz - 0.75, M.concreteDark);
      boxR(sx + run, x1, H - 0.2, H, sz - 0.75, z1, M.concreteDark);
      boxR(x0, sx + 0.8, H - 0.2, H, sz - 0.75, z1, M.concreteDark);
      wall(-125, z0, -125, sz - 0.8, H, H, 0.15, M.plasterDark, [door(3)]);          // upper partition
      boxR(x0 - 0.2, x1 + 0.2, H2, H2 + 0.2, z0 - 0.2, z1 + 0.2, M.roof);
    }
    // B3: corridor building, rooms either side
    {
      const x0 = -152, x1 = -132, z0 = -40, z1 = -28, H = 3.0;
      wall(x0, z0, x1, z0, 0, H, 0.25, M.plaster, [win(3), win(8), win(13), win(17.5)]);
      wall(x0, z1, x1, z1, 0, H, 0.25, M.plaster, [win(3), win(10), win(17)]);
      wall(x0, z0, x0, z1, 0, H, 0.25, M.plaster, [door(6, 1.2)]);
      wall(x1, z0, x1, z1, 0, H, 0.25, M.plaster, [door(6, 1.2)]);
      wall(x0, -35, x1, -35, 0, H, 0.15, M.plasterDark, [door(3), door(8.5), door(13), door(17.5)]);
      wall(x0, -33, x1, -33, 0, H, 0.15, M.plasterDark, [door(3.5), door(10), door(16.5)]);
      for (const x of [-146, -141, -136.5]) wall(x, z0, x, -35, 0, H, 0.15, M.plasterDark);
      for (const x of [-145, -138]) wall(x, -33, x, z1, 0, H, 0.15, M.plasterDark);
      boxR(x0 - 0.2, x1 + 0.2, H, H + 0.2, z0 - 0.2, z1 + 0.2, M.roof);
    }
    // B4 and B5: single-room huts and a two-room block in the courtyard
    const hut = (x0, z0, w, d, ops) => {
      const x1 = x0 + w, z1 = z0 + d, H = 2.8;
      wall(x0, z0, x1, z0, 0, H, 0.25, M.plaster, ops.s || []); wall(x0, z1, x1, z1, 0, H, 0.25, M.plaster, ops.n || []);
      wall(x0, z0, x0, z1, 0, H, 0.25, M.plaster, ops.w || []); wall(x1, z0, x1, z1, 0, H, 0.25, M.plaster, ops.e || []);
      if (ops.split) wall(x0 + w / 2, z0, x0 + w / 2, z1, 0, H, 0.15, M.plasterDark, [door(d / 2)]);
      boxR(x0 - 0.3, x1 + 0.3, H, H + 0.2, z0 - 0.3, z1 + 0.3, M.roof);
    };
    hut(-112, -32, 6, 6, { s: [door(3)], e: [win(3)], n: [win(3)] });
    hut(-102, -14, 6, 6, { w: [door(3)], s: [win(3)], n: [win(2)] });
    hut(-125, -12, 12, 7, { s: [door(3), win(9)], n: [win(3), win(9)], e: [door(3.5)], split: true });
    // sandbag fighting positions at the compound corners
    sandbags(-157, 6, -150, 6, 6, 2); sandbags(-157, 6, -157, 0, 6, 2);
    sandbags(-77, -66, -77, -60, 6, 2); sandbags(-84, -66, -77, -66, 6, 2);
  }

  // ================================================================ firing range (shooters face south)
  {
    const FL = -82, X0 = -152, X1 = -92, lanes = 6, LW = (X1 - X0) / lanes;
    flat((X0 + X1) / 2, FL - 2, X1 - X0 + 8, 6, 0.024, M.concrete);             // firing point pad
    for (let x = X0 - 2; x <= X1 + 2; x += 6) box(x, 1.4, FL - 1, 0.15, 2.8, 0.15, M.steel);          // shelter posts
    boxR(X0 - 3, X1 + 3, 2.8, 2.95, FL - 3.5, FL + 1, M.corrugated);                                  // shelter roof
    for (let i = 0; i < lanes; i++) {
      const cx = X0 + LW * (i + 0.5);
      box(cx, 0.45, FL - 4.2, 1.6, 0.9, 0.7, M.wood);                                // firing bench
      sandbags(cx - 2.5, FL - 5, cx - 1.1, FL - 5, 5, 1); sandbags(cx + 1.1, FL - 5, cx + 2.5, FL - 5, 5, 1);
      box(X0 + LW * i, 0.6, FL - 6, 0.1, 1.2, 0.1, M.white, { coll: false });       // lane marker post
      box(X0 + LW * i, 1.25, FL - 6, 0.5, 0.35, 0.04, i % 2 ? M.red : M.yellow, { coll: false });
      for (const d of [25, 50, 100]) {
        const z = FL - 5 - d;
        box(cx, 0.25, z + 0.6, 2.2, 0.5, 0.6, M.berm);                                // target mantlet
        const pivot = new THREE.Group(); pivot.position.set(cx, 0.5, z); targetGroup.add(pivot);
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.6, 0.08), M.wood); post.position.y = 0.3; pivot.add(post);
        const s = new THREE.Shape();
        s.moveTo(-0.32, 0); s.lineTo(0.32, 0); s.lineTo(0.32, 0.55); s.quadraticCurveTo(0.3, 0.68, 0.14, 0.7);
        s.lineTo(0.1, 0.74); s.quadraticCurveTo(0.15, 0.98, 0, 1.0); s.quadraticCurveTo(-0.15, 0.98, -0.1, 0.74);
        s.lineTo(-0.14, 0.7); s.quadraticCurveTo(-0.3, 0.68, -0.32, 0.55); s.closePath();
        const sil = new THREE.Mesh(new THREE.ShapeGeometry(s, 6), M.silhouette); sil.position.set(0, 0.6, 0.012); sil.material.side = THREE.DoubleSide;
        const back = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.15, 0.02), M.board); back.position.set(0, 1.12, 0);
        pivot.add(back, sil);
        const T = { pivot, state: 'up', t: 0, ang: 0 };
        targets.push(T);
        for (const m of [sil, back, post]) m.userData.target = T;
        pivot.traverse((o) => { o.castShadow = true; });
      }
    }
    // stop butt (backstop berm) and side berms
    const berm = (cx, cz, w, d, h, yaw = 0) => {
      const g = new THREE.CylinderGeometry(0.5, 1, 1, 4, 1); g.rotateY(Math.PI / 4); g.scale(w / 1.414, h, d / 1.414); g.rotateY(yaw); g.translate(cx, h / 2, cz); put(g, M.berm);
      coll(cx, cz, w * 0.4, d * 0.4, yaw, 0, h * 0.8);
    };
    berm((X0 + X1) / 2, FL - 125, X1 - X0 + 24, 16, 8);
    berm(X0 - 8, FL - 60, 6, 110, 3.5); berm(X1 + 8, FL - 60, 6, 110, 3.5);
    cyl(X1 + 6, 4, FL + 2, 0.06, 0.06, 8, M.steel); box(X1 + 6.6, 7.4, FL + 2, 1.2, 0.7, 0.02, M.red, { coll: false }); // range flag
    // range control hut with a glazed front
    wall(X0 - 10, FL - 3, X0 - 5, FL - 3, 0, 2.8, 0.2, M.plaster, [win(2.5, 3.0, 0.9, 2.1)]);
    wall(X0 - 10, FL + 2, X0 - 5, FL + 2, 0, 2.8, 0.2, M.plaster, [door(2.5)]);
    wall(X0 - 10, FL - 3, X0 - 10, FL + 2, 0, 2.8, 0.2, M.plaster, [win(2.5)]);
    wall(X0 - 5, FL - 3, X0 - 5, FL + 2, 0, 2.8, 0.2, M.plaster, [win(2.5)]);
    boxR(X0 - 10.3, X0 - 4.7, 2.8, 3.0, FL - 3.3, FL + 2.3, M.roof);
  }

  // ================================================================ perimeter, gate, towers
  {
    const { x0, x1, z0, z1 } = BASE;
    fence(x0, z0, -7, z0); fence(7, z0, x1, z0); fence(x1, z0, x1, z1); fence(x1, z1, x0, z1); fence(x0, z1, x0, z0);
    // gate: chicane of HESCO, sandbagged sangars, a boom barrier, guard hut
    hesco(-30, z0 + 8, -7, z0 + 8); hesco(7, z0 + 8, 30, z0 + 8);
    hesco(-4, z0 + 16, 12, z0 + 16); hesco(-12, z0 + 24, 4, z0 + 24);
    for (const sx of [-1, 1]) {
      const cx = sx * 10, cz = z0 + 3;
      sandbags(cx - 1.6, cz - 1.6, cx + 1.6, cz - 1.6, 8, 2); sandbags(cx - 1.6, cz - 1.6, cx - 1.6, cz + 1.6, 8, 2); sandbags(cx + 1.6, cz - 1.6, cx + 1.6, cz + 1.6, 8, 2);
      boxR(cx - 1.9, cx + 1.9, 2.2, 2.35, cz - 1.9, cz + 1.9, M.corrugated, { coll: false });
      for (const [px, pz] of [[-1.7, -1.7], [1.7, -1.7], [-1.7, 1.7], [1.7, 1.7]]) box(cx + px, 1.1, cz + pz, 0.1, 2.2, 0.1, M.wood, { coll: false });
    }
    box(0, 1.0, z0 + 1, 12, 0.12, 0.12, M.white, { coll: false }); for (let x = -5; x < 6; x += 2) box(x, 1.0, z0 + 1, 1, 0.13, 0.13, M.red, { coll: false });
    box(-7.5, 0.55, z0 + 1, 0.4, 1.1, 0.4, M.steelDark);
    // lookout towers: legs, 6 m platform with a sandbag parapet, corrugated roof, ladder on the south face
    const tower = (cx, cz) => {
      const P = 6.0, half = 1.7;
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(cx + sx * (half - 0.15), P / 2, cz + sz * (half - 0.15), 0.25, P, 0.25, M.wood);
      for (const sz of [-1, 1]) { box(cx, 2.5, cz + sz * (half - 0.15), 3.2, 0.12, 0.12, M.wood, { coll: false, rz: 0.9 }); box(cx, 2.5, cz + sz * (half - 0.15), 3.2, 0.12, 0.12, M.wood, { coll: false, rz: -0.9 }); }
      boxR(cx - half, cx + half, P - 0.25, P, cz - half, cz + half, M.wood);   // platform floor
      const bagsAt = (ax, az, bx, bz) => {
        const len = Math.hypot(bx - ax, bz - az), alongX = Math.abs(bx - ax) > Math.abs(bz - az);
        for (let r = 0; r < 7; r++) for (let s = (r % 2) * 0.27; s < len - 0.1; s += 0.55) {
          const a = s, b = Math.min(len, s + 0.55), c = (a + b) / 2;
          const g = new THREE.BoxGeometry(alongX ? b - a - 0.02 : 0.3, 0.14, alongX ? 0.3 : b - a - 0.02);
          g.translate(alongX ? Math.min(ax, bx) + c : ax, P + 0.07 + r * 0.15, alongX ? az : Math.min(az, bz) + c); put(g, r % 3 ? M.sandbag : M.sandbagDark);
        }
        coll((ax + bx) / 2, (az + bz) / 2, alongX ? len / 2 : 0.15, alongX ? 0.15 : len / 2, 0, P, P + 1.05);
      };
      bagsAt(cx - half + 0.15, cz + half - 0.15, cx + half - 0.15, cz + half - 0.15);
      bagsAt(cx - half + 0.15, cz - half + 0.15, cx - half + 0.15, cz + half - 0.15);
      bagsAt(cx + half - 0.15, cz - half + 0.15, cx + half - 0.15, cz + half - 0.15);
      bagsAt(cx - half + 0.15, cz - half + 0.15, cx - 0.55, cz - half + 0.15);
      bagsAt(cx + 0.55, cz - half + 0.15, cx + half - 0.15, cz - half + 0.15);
      for (const [px, pz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) box(cx + px * (half - 0.1), P + 1.25, cz + pz * (half - 0.1), 0.1, 2.5, 0.1, M.wood, { coll: false });
      boxR(cx - half - 0.4, cx + half + 0.4, P + 2.5, P + 2.6, cz - half - 0.4, cz + half + 0.4, M.corrugated);
      ladder(cx, cz - half, 0, P, cz - half + 0.9);
    };
    tower(-12, z0 + 8.5); tower(12, z0 + 8.5);   // gate towers
    tower(x0 + 10, z0 + 10); tower(x1 - 10, z0 + 10); tower(x0 + 10, z1 - 12); tower(x1 - 10, z1 - 12); tower(x1 - 10, -60); tower(x0 + 10, -20);
    // HESCO around the helipad edge and the tower bases
    hesco(58, 92, 58, 124); hesco(92, 92, 92, 124);
  }
  // sandbag ring near the spawn point (a ready position by the road junction)
  sandbags(-12, 6, -6, 6, 7, 2); sandbags(-12, 6, -12, 11, 7, 2); sandbags(-12, 11, -6, 11, 7, 2);

  // ================================================================ desert scatter
  {
    let seed = 21; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const free = (x, z, m) => !OCC.some(([a, b, c, d]) => x > a - m && x < b + m && z > c - m && z < d + m);
    for (let i = 0; i < 900; i++) {
      const x = (rnd() - 0.5) * 900, z = (rnd() - 0.5) * 900;
      if (!free(x, z, 3)) continue;
      const inside = x > BASE.x0 && x < BASE.x1 && z > BASE.z0 && z < BASE.z1;
      if (inside && rnd() < 0.6) continue;
      if (rnd() < 0.18) rock(x, z, 0.4 + rnd() * 1.2); else bush(x, z, 0.3 + rnd() * 0.6);
    }
  }

  // ---------------------------------------------------------------- merge static meshes
  const statics = [];
  for (const [m, list] of parts) {
    const g = mergeGeometries(list, false);
    const mesh = new THREE.Mesh(g, m); statics.push(mesh);
    mesh.castShadow = m !== M.fence; mesh.receiveShadow = true;
    root.add(mesh);
  }
  // interior lights for the buildings you clear
  for (const [x, y, z] of [[-146, 2.6, -59], [-125, 2.8, -59], [-125, 5.9, -59], [-142, 2.6, -34]]) {
    const l = new THREE.PointLight('#ffe7c2', 10, 12, 1.6); l.position.set(x, y, z); root.add(l);
  }

  // ---------------------------------------------------------------- interaction
  const shardGeo = new THREE.BufferGeometry().setFromPoints([V(0, 0, 0), V(0.06, 0.02, 0), V(0.02, 0.08, 0)]);
  shardGeo.computeVertexNormals();
  /** A round through a pane: it shatters (shards fall, the pane is gone). Returns true if glass was hit. */
  function breakGlass(mesh, point, dir) {
    if (!mesh.userData.glass || !mesh.parent) return false;
    const { w, h, alongX } = mesh.userData.glass;
    mesh.parent.remove(mesh);
    const n = Math.min(40, Math.round(w * h * 14));
    for (let i = 0; i < n; i++) {
      const s = new THREE.Mesh(shardGeo, glassMat);
      const u = (Math.random() - 0.5) * w, v = (Math.random() - 0.5) * h;
      s.position.copy(mesh.position).add(alongX ? V(u, v, 0) : V(0, v, u));
      s.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
      const vel = dir.clone().multiplyScalar(0.6 + Math.random() * 1.2).add(V((Math.random() - 0.5) * 0.8, Math.random() * 0.6, (Math.random() - 0.5) * 0.8));
      s.raycast = () => {}; fxGroup.add(s); fx.push({ o: s, vel, spin: V(Math.random() * 10, Math.random() * 10, Math.random() * 10), t: 0, life: 4 });
    }
    return true;
  }
  /** Range targets fall back when hit and pop up again a few seconds later. */
  function hitTarget(obj) {
    const T = obj.userData.target;
    if (!T || T.state !== 'up') return false;
    T.state = 'falling'; T.t = 0; return true;
  }
  function update(dt) {
    for (let i = fx.length - 1; i >= 0; i--) {
      const e = fx[i]; e.t += dt;
      e.vel.y -= 9.81 * dt; e.o.position.addScaledVector(e.vel, dt);
      e.o.rotation.x += e.spin.x * dt; e.o.rotation.y += e.spin.y * dt;
      const g = terrainH(e.o.position.x, e.o.position.z);
      if (e.o.position.y < g + 0.01) { e.o.position.y = g + 0.01; e.vel.multiplyScalar(0); e.spin.multiplyScalar(0); }
      if (e.t > e.life) { fxGroup.remove(e.o); fx.splice(i, 1); }
    }
    for (const T of targets) {
      T.t += dt;
      if (T.state === 'falling') { T.ang = Math.min(1.45, T.ang + dt * 9); if (T.ang >= 1.45) { T.state = 'down'; T.t = 0; } }
      else if (T.state === 'down' && T.t > 3.0) T.state = 'rising';
      else if (T.state === 'rising') { T.ang = Math.max(0, T.ang - dt * 3); if (T.ang <= 0) T.state = 'up'; }
      T.pivot.rotation.x = -T.ang; // falls away from the firing line (south)
    }
  }
  /** Called with each bullet hit; returns true if the round carries on (through glass). */
  function onHit(hit, dir) {
    if (!hit.object) return false;
    if (breakGlass(hit.object, hit.point, dir)) return true;
    hitTarget(hit.object);
    return false;
  }

  return { root, statics, glass: glassGroup, targets: targetGroup, ground, groundTex, colliders: COLL, walls: WALLS, ladders: LADDERS, terrainH, update, onHit, materials: M };
}
