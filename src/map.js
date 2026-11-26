// Test map: "Camp Edelweiss", a fictional training garrison in a forested alpine valley.
// Main gate with guard booth, flags and sign; HQ and a tactical operations centre (TOC) with a
// furnished interior; barracks; a motor pool with an arched workshop; an airfield with arched
// hangars, an apron of parked helicopters, a control tower and a runway; a training area with a
// ruined village and clearance buildings in the woods; a firing range; lookout towers; and forest,
// meadows, hills, mountains and a village with a church on the hillside outside the wire.
//
// Static geometry is merged per material; trees are instanced in tiles. Solids are registered as
// colliders { type: 'box', x, z, hx, hz, yaw, bot, top, walk? } or { type: 'circle', ... } and the
// app stands the soldier on the highest surface at his level. Glass panes and range targets are
// separate, interactive meshes. Metres; +Z north, +X east; the soldier spawns inside the main gate.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const sm = (t) => { t = Math.min(1, Math.max(0, t)); return t * t * (3 - 2 * t); };

// ------------------------------------------------------------------ terrain
export const BASE = { x0: -190, x1: 190, z0: -160, z1: 190 };
export const SPAWN = { x: 0, z: -132, yaw: 0 };
const TRAIN = { x0: -186, x1: -62, z0: -152, z1: 40 }; // training area (gently rolling, wooded)
/** Ground height: flat in the camp, rolling in the training area, hills and valleys outside the wire. */
export function terrainH(x, z) {
  let h = 0;
  if (x > TRAIN.x0 && x < TRAIN.x1 && z > TRAIN.z0 && z < TRAIN.z1) {
    const e = sm(Math.min(x - TRAIN.x0, TRAIN.x1 - x, z - TRAIN.z0, TRAIN.z1 - z) / 12);
    h = e * (0.45 * Math.sin(x * 0.11) * Math.cos(z * 0.09) + 0.3 * Math.sin(x * 0.05 + z * 0.07 + 1));
    // the village square and the track are levelled
    const vx = x + 118, vz = z + 45;
    h *= sm((Math.hypot(vx, vz) - 26) / 10);
  }
  const m = 14;
  const ox = Math.max(BASE.x0 - m - x, x - BASE.x1 - m, 0), oz = Math.max(BASE.z0 - m - z, z - BASE.z1 - m, 0);
  const o = Math.hypot(ox, oz);
  if (o <= 0) return h;
  const e = sm(o / 160);
  let hills = 26 + 18 * Math.sin(x * 0.0062 + 1.1) * Math.cos(z * 0.0055 - 0.3) + 9 * Math.sin(x * 0.017 - z * 0.012 + 0.4)
    + 3.5 * Math.sin(x * 0.043 + z * 0.037) + 1.2 * Math.sin(x * 0.11 - z * 0.09);
  // the valley road south to the village stays low and gentle
  if (z < BASE.z0) hills *= 0.35 + 0.65 * sm((Math.abs(x - roadX(z)) - 14) / 60);
  return h + e * Math.max(1.5, hills) * (0.45 + 0.55 * sm(o / 420));
}
/** Centre line of the road from the main gate south through the valley to the village. */
export function roadX(z) { return z > -170 ? 0 : 18 * Math.sin((z + 170) * 0.012) + 0.03 * (z + 170) * Math.sin((z + 170) * 0.004); }

// ------------------------------------------------------------------ textures
function canvasTex(w, h, draw, srgb = true) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const grassTex = () => canvasTex(256, 256, (g, n) => {
  g.fillStyle = '#7f9a55'; g.fillRect(0, 0, n, n);
  for (let i = 0; i < 3200; i++) { g.fillStyle = ['#76914d', '#88a35c', '#6f8a47', '#93ac66', '#7c9850', '#a0ad6a'][i % 6]; g.fillRect(rnd() * n, rnd() * n, 1 + rnd() * 3, 2 + rnd() * 4); }
});
const textTex = (w, h, bg, lines) => canvasTex(w, h, (g) => {
  g.fillStyle = bg; g.fillRect(0, 0, w, h);
  for (const [txt, y, size, col, font] of lines) { g.fillStyle = col; g.font = `${font || 'bold'} ${size}px sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(txt, w / 2, y); }
});

/**
 * Build the map. Returns { root, statics, sky, ground, groundTex, glass, targets, colliders, walls,
 * ladders, npcs, spawn, terrainH, update(dt), onHit(hit, dir) }.
 */
export function buildMap() {
  const root = new THREE.Group(); root.name = 'Map';
  const glassGroup = new THREE.Group(); glassGroup.name = 'Glass';
  const targetGroup = new THREE.Group(); targetGroup.name = 'Targets';
  const fxGroup = new THREE.Group();
  const live = new THREE.Group(); // separate, non-merged meshes (screens, flags, lamps)
  root.add(glassGroup, targetGroup, fxGroup, live);
  const COLL = [], WALLS = [], LADDERS = [], OCC = [], NPCS = [];
  const fx = [], targets = [], flags = [], smoke = [];

  // ---------------------------------------------------------------- materials
  const mat = (color, o = {}) => new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.9, ...o });
  const fenceTex = canvasTex(64, 64, (g, n) => {
    g.clearRect(0, 0, n, n); g.strokeStyle = 'rgba(160,165,170,1)'; g.lineWidth = 2;
    for (let i = -n; i < 2 * n; i += 16) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i + n, n); g.stroke(); g.beginPath(); g.moveTo(i + n, 0); g.lineTo(i, n); g.stroke(); }
  });
  const gravelTex = canvasTex(128, 128, (g, n) => {
    g.fillStyle = '#9a9182'; g.fillRect(0, 0, n, n);
    for (let i = 0; i < 1400; i++) { g.fillStyle = ['#8a8172', '#aaa190', '#7e7668', '#b5ad9c'][i % 4]; g.fillRect(rnd() * n, rnd() * n, 1 + rnd() * 2, 1 + rnd() * 2); }
  });
  const M = {
    asphalt: mat('#47484a'), asphaltDark: mat('#3a3b3d'), concrete: mat('#b9b7ae'), concreteDark: mat('#9c9a92'), apron: mat('#a7a59d'),
    gravel: mat('#ffffff', { map: gravelTex }), dirt: mat('#7d6a4f'), mud: mat('#6b5b44'),
    white: mat('#ecebe4'), yellow: mat('#d9b13a'), red: mat('#b3332b'), black: mat('#222326'),
    wallLight: mat('#d9d2c2'), wallBeige: mat('#c9bc9f'), wallGrey: mat('#a9aba7'), plaster: mat('#cfc6b2'), plasterDark: mat('#aea590'),
    roofDark: mat('#4a4d52'), roofRed: mat('#9c4a32'), roofGreen: mat('#4f5a4a'), trim: mat('#6d665a'), interior: mat('#7d8184'), floorTile: mat('#8e9091'), ceiling: mat('#a9acad'),
    wood: mat('#6e5236'), woodLight: mat('#8f7150'), steel: mat('#6b7276', { roughness: 0.6, metalness: 0.3 }), steelDark: mat('#3b4044', { roughness: 0.6, metalness: 0.35 }),
    galv: mat('#a3a8aa', { roughness: 0.55, metalness: 0.4 }), hangar: mat('#7e8579', { roughness: 0.7, metalness: 0.2, side: THREE.DoubleSide }),
    od: mat('#4b5236'), odDark: mat('#3a4029'), odLight: mat('#5d6545'), tyre: mat('#1f2021'), canvas: mat('#6d6a4c'),
    glassDark: mat('#28323a', { roughness: 0.15, metalness: 0.5 }), sandbag: mat('#8e8461'), sandbagDark: mat('#7c7354'),
    jersey: mat('#c2c0b8'), rock: mat('#8c8a84'), rockDark: mat('#6f6e69'), rubble: mat('#9c968b'), soot: mat('#3d3935'),
    board: mat('#d9cfb2'), silhouette: mat('#3f5135'), orange: mat('#d9702a'), berm: mat('#6f6247'),
    lamp: mat('#fff6d8', { emissive: '#fff1c4', emissiveIntensity: 1.2 }), ledGreen: mat('#7cff9a', { emissive: '#4cff7a', emissiveIntensity: 1.0 }),
    houseWhite: mat('#e8e4da'), church: mat('#ece8de'), onion: mat('#3f5e46'), chairBlack: mat('#26282b'), desk: mat('#59595b'), rack: mat('#1d1f22'),
    fence: new THREE.MeshStandardMaterial({ map: fenceTex, transparent: true, alphaTest: 0.4, side: THREE.DoubleSide, roughness: 0.6, metalness: 0.4 }),
  };
  const glassMat = new THREE.MeshStandardMaterial({ color: '#b9d2dc', transparent: true, opacity: 0.3, roughness: 0.05, metalness: 0.3, side: THREE.DoubleSide, depthWrite: false });

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
    const r = Math.abs(yaw) > 1e-3 ? Math.hypot(hx, hz) : 0; occ(x, z, r || hx, r || hz);
  };
  const xform = (g, o) => {
    if (o.rx || o.rz || o.ry) g.applyQuaternion(new THREE.Quaternion().setFromEuler(new THREE.Euler(o.rx || 0, o.ry || 0, o.rz || 0)));
    if (o.yaw) g.rotateY(o.yaw);
    return g;
  };
  /** Box centred at (cx, cy, cz), size (sx, sy, sz), turned by yaw. Solid unless o.coll === false. */
  const box = (cx, cy, cz, sx, sy, sz, m, o = {}) => {
    const g = xform(new THREE.BoxGeometry(sx, sy, sz), o); g.translate(cx, cy, cz); put(g, m);
    if (o.coll !== false) coll(cx, cz, sx / 2, sz / 2, o.yaw || 0, cy - sy / 2, cy + sy / 2, o);
  };
  const boxR = (x0, x1, y0, y1, z0, z1, m, o = {}) => box((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, x1 - x0, y1 - y0, z1 - z0, m, o);
  /** Flat plane at height y (markings, pads, roads); no collider. */
  const flat = (cx, cz, sx, sz, y, m, yaw = 0, noOcc = false) => {
    const g = new THREE.PlaneGeometry(sx, sz); { const uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * sx / 3, uv.getY(i) * sz / 3); }
    g.rotateX(-Math.PI / 2); if (yaw) g.rotateY(yaw); g.translate(cx, y, cz); put(g, m);
    if (!noOcc) occ(cx, cz, Math.abs(yaw) > 0.01 ? Math.hypot(sx, sz) / 2 : sx / 2, Math.abs(yaw) > 0.01 ? Math.hypot(sx, sz) / 2 : sz / 2);
  };
  const cyl = (x, y, z, r0, r1, h, m, o = {}) => {
    const g = xform(new THREE.CylinderGeometry(r0, r1, h, o.seg || 10, 1, !!o.open, o.ts || 0, o.tl || Math.PI * 2), o); g.translate(x, y, z); put(g, m);
  };
  /** Local builder: parts placed in an object's own frame (vehicles, aircraft, furniture). */
  const local = (x, z, yaw, y = 0) => {
    const T = new THREE.Matrix4().compose(V(x, y, z), new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), yaw), V(1, 1, 1));
    const L = {
      T,
      box(cx, cy, cz, sx, sy, sz, m, o = {}) { const g = xform(new THREE.BoxGeometry(sx, sy, sz), o); g.translate(cx, cy, cz); g.applyMatrix4(T); put(g, m); },
      cyl(cx, cy, cz, r0, r1, h, m, o = {}) { const g = xform(new THREE.CylinderGeometry(r0, r1, h, o.seg || 12, 1, !!o.open), o); g.translate(cx, cy, cz); g.applyMatrix4(T); put(g, m); },
      sph(cx, cy, cz, r, sx, sy, sz, m, d = 1) { const g = new THREE.IcosahedronGeometry(r, d); g.scale(sx, sy, sz); g.translate(cx, cy, cz); g.applyMatrix4(T); put(g, m); },
      wheel(cx, cy, cz, r, w) { L.cyl(cx, cy, cz, r, r, w, M.tyre, { rz: Math.PI / 2, seg: 14 }); L.cyl(cx + Math.sign(cx) * 0.01, cy, cz, r * 0.55, r * 0.55, w + 0.02, M.steelDark, { rz: Math.PI / 2, seg: 8 }); },
      /** collider for the object, in its own frame */
      coll(cx, cz, hx, hz, top, bot = 0) { const p = V(cx, 0, cz).applyMatrix4(T); coll(p.x, p.z, hx, hz, yaw, y + bot, y + top); },
      pt(cx, cy, cz) { return V(cx, cy, cz).applyMatrix4(T); },
    };
    return L;
  };

  // ---------------------------------------------------------------- glass, walls, roofs
  const pane = (cx, cy, cz, w, h, alongX) => {
    const g = new THREE.PlaneGeometry(w, h); if (!alongX) g.rotateY(Math.PI / 2);
    const m = new THREE.Mesh(g, glassMat); m.position.set(cx, cy, cz); m.renderOrder = 2;
    m.userData.glass = { w, h, alongX }; glassGroup.add(m);
  };
  /**
   * Straight wall along X or Z from (ax, az) to (bx, bz), thickness t, from y0 up h.
   * openings: [{ at (metres from a, centre), w, bot, top, glass, frame }].
   */
  const wall = (ax, az, bx, bz, y0, h, t, m, openings = [], o = {}) => {
    const alongX = Math.abs(bx - ax) > Math.abs(bz - az);
    const len = alongX ? Math.abs(bx - ax) : Math.abs(bz - az), sgn = alongX ? Math.sign(bx - ax) : Math.sign(bz - az);
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
      const fr = (dx, dy, dz, sx, sy, sz) => (alongX ? box(cx + dx, y0 + dy, cz + dz, sx, sy, sz, M.trim, { coll: false }) : box(cx + dz, y0 + dy, cz + dx, sz, sy, sx, M.trim, { coll: false }));
      if (op.glass) {
        pane(cx, y0 + (op.bot + op.top) / 2, cz, op.w - 0.04, op.top - op.bot - 0.04, alongX);
        fr(0, op.bot - 0.03, 0, op.w + 0.12, 0.08, t + 0.1); fr(0, op.top + 0.03, 0, op.w + 0.1, 0.07, t + 0.04);
        fr(0, (op.bot + op.top) / 2, 0, 0.05, op.top - op.bot, 0.05); // mullion
      } else if (op.frame !== false && op.bot === 0) {
        fr(-op.w / 2 - 0.03, op.top / 2, 0, 0.06, op.top, t + 0.04); fr(op.w / 2 + 0.03, op.top / 2, 0, 0.06, op.top, t + 0.04); fr(0, op.top + 0.03, 0, op.w + 0.12, 0.06, t + 0.04);
      }
      cur = s1;
    }
    piece(cur, len, y0, y0 + h);
  };
  const door = (at, w = 1.0, top = 2.1) => ({ at, w, bot: 0, top });
  const win = (at, w = 1.2, bot = 0.9, top = 2.0) => ({ at, w, bot, top, glass: true });
  /** Pitched (gable) roof over a rectangle, ridge along X (or Z); pitch rise in metres. Solid as a slab. */
  const gableRoof = (x0, x1, z0, z1, y, rise, m, alongX = true, over = 0.4, gableM = null) => {
    const L = (alongX ? x1 - x0 : z1 - z0) + 2 * over, W = (alongX ? z1 - z0 : x1 - x0) + 2 * over;
    const s = new THREE.Shape(); s.moveTo(-W / 2, 0); s.lineTo(W / 2, 0); s.lineTo(0, rise); s.closePath();
    const g = new THREE.ExtrudeGeometry(s, { depth: L, bevelEnabled: false });
    g.translate(0, 0, -L / 2); if (alongX) g.rotateY(Math.PI / 2); g.translate((x0 + x1) / 2, y, (z0 + z1) / 2); put(g, m);
    // gable end walls under the roof
    if (gableM) {
      const W2 = alongX ? z1 - z0 : x1 - x0, s2 = new THREE.Shape(); s2.moveTo(-W2 / 2, 0); s2.lineTo(W2 / 2, 0); s2.lineTo(0, rise * W2 / W); s2.closePath();
      for (const e of [0, 1]) {
        const g2 = new THREE.ExtrudeGeometry(s2, { depth: 0.2, bevelEnabled: false }); g2.translate(0, 0, -0.1); if (alongX) g2.rotateY(Math.PI / 2);
        g2.translate(alongX ? (e ? x1 : x0) : (x0 + x1) / 2, y, alongX ? (z0 + z1) / 2 : (e ? z1 : z0)); put(g2, gableM);
      }
    }
    coll((x0 + x1) / 2, (z0 + z1) / 2, (x1 - x0) / 2 + over, (z1 - z0) / 2 + over, 0, y, y + 0.3);
  };
  /** Quonset / arched roof shell (half cylinder) along X or Z. */
  const archShell = (cx, cz, span, len, m, alongX = false, rise = null) => {
    const r = span / 2, g = new THREE.CylinderGeometry(r, r, len, 28, 1, true, 0, Math.PI);
    g.rotateZ(Math.PI / 2); // axis along X, the half-cylinder arching over the top
    if (rise) g.scale(1, rise / r, 1);
    if (!alongX) g.rotateY(Math.PI / 2);
    g.translate(cx, 0, cz); put(g, m);
    // ribs
    for (let k = -len / 2 + 2; k < len / 2; k += 4) {
      const rib = new THREE.TorusGeometry(r, 0.08, 4, 20, Math.PI); if (rise) rib.scale(1, rise / r, 1);
      if (alongX) rib.rotateY(Math.PI / 2); rib.translate(cx + (alongX ? k : 0), 0, cz + (alongX ? 0 : k)); put(rib, M.steelDark);
    }
  };

  // ---------------------------------------------------------------- stairs, ladders, sandbags, fence, barriers
  const stairs = (x, z, dir, width, n, rise, run, m, rail = 0) => {
    const ax = dir[0] === 'x', s = dir[1] === '+' ? 1 : -1;
    for (let i = 0; i < n; i++) {
      const a = i * run, b = (i + 1) * run, top = (i + 1) * rise;
      if (ax) boxR(Math.min(x + s * a, x + s * b), Math.max(x + s * a, x + s * b), 0, top, z - width / 2, z + width / 2, m, { walk: true });
      else boxR(x - width / 2, x + width / 2, 0, top, Math.min(z + s * a, z + s * b), Math.max(z + s * a, z + s * b), m, { walk: true });
      if (rail && i >= 3) {
        const off = rail * (width / 2 + 0.1);
        if (ax) COLL.push({ type: 'box', x: x + s * (a + b) / 2, z: z + off, hx: run / 2, hz: 0.1, yaw: 0, bot: 0, top: top + 1.0 });
        else COLL.push({ type: 'box', x: x + off, z: z + s * (a + b) / 2, hx: 0.1, hz: run / 2, yaw: 0, bot: 0, top: top + 1.0 });
      }
    }
    if (rail) {
      const off = rail * (width / 2 + 0.1), L = n * run, H = n * rise, a0 = 3 * run, y0 = 4 * rise + 0.95, y1 = H + 0.95;
      const len = Math.hypot(L - a0, y1 - y0), ang = Math.atan2(y1 - y0, L - a0), mid = (a0 + L) / 2;
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
    for (const sx of [-0.27, 0.27]) box(x + sx, base + (top - base + 1.1) / 2, LZ, 0.06, top - base + 1.1, 0.06, M.galv, { coll: false });
    for (let k = 0; base + 0.04 + 0.3 * k < top + 0.9; k++) cyl(x, base + 0.04 + 0.3 * k, LZ, 0.018, 0.018, 0.54, M.galv, { rz: Math.PI / 2, seg: 6 });
    for (let y = base + 1.5; y < top; y += 2.5) for (const sx of [-0.27, 0.27]) box(x + sx, y, (LZ + zFace) / 2, 0.05, 0.05, Math.abs(zFace - LZ) + 0.04, M.galv, { coll: false });
    LADDERS.push({ x, rungZ: LZ, base, top, hipZ: LZ - 0.42, platformZ });
  };
  let bagSeed = 5; const bagRnd = () => ((bagSeed = (bagSeed * 16807) % 2147483647) / 2147483647);
  const sandbags = (ax, az, bx, bz, rows = 6, thick = 1, y0 = 0) => {
    const len = Math.hypot(bx - ax, bz - az), yaw = Math.atan2(bx - ax, bz - az) - Math.PI / 2;
    const dx = (bx - ax) / len, dz = (bz - az) / len, nx = -dz, nz = dx, L = 0.55, H = 0.15, D = 0.32;
    for (let r = 0; r < rows; r++) for (let k = 0; k < thick; k++) for (let s = -(r % 2 ? L / 2 : 0); s < len - 0.05; s += L) {
      const a = Math.max(0, s), b = Math.min(len, s + L), c = (a + b) / 2, w = b - a;
      if (w < 0.12) continue;
      const kk = (k - (thick - 1) / 2) * D, g = new THREE.BoxGeometry(w - 0.02, H * (0.92 + 0.12 * bagRnd()), D - 0.02);
      g.rotateY(yaw + (bagRnd() - 0.5) * 0.08); g.translate(ax + dx * c + nx * kk, y0 + H * (r + 0.5), az + dz * c + nz * kk);
      put(g, (r + k) % 3 ? M.sandbag : M.sandbagDark);
    }
    coll((ax + bx) / 2, (az + bz) / 2, len / 2, (D * thick) / 2, yaw, y0, y0 + rows * H);
  };
  /** Concrete jersey barrier (3 m) centred at (x, z), turned by yaw. */
  const jersey = (x, z, yaw = 0, len = 3) => {
    const s = new THREE.Shape(); s.moveTo(-0.3, 0); s.lineTo(0.3, 0); s.lineTo(0.3, 0.08); s.lineTo(0.12, 0.3); s.lineTo(0.08, 0.82); s.lineTo(-0.08, 0.82); s.lineTo(-0.12, 0.3); s.lineTo(-0.3, 0.08); s.closePath();
    const g = new THREE.ExtrudeGeometry(s, { depth: len - 0.04, bevelEnabled: false }); g.translate(0, 0, -(len - 0.04) / 2); g.rotateY(Math.PI / 2 + yaw); g.translate(x, 0, z); put(g, M.jersey);
    coll(x, z, len / 2, 0.3, yaw, 0, 0.82);
  };
  /** Security fence: concrete posts with angled barbed-wire outriggers, chain-link mesh. Solid. */
  const fence = (ax, az, bx, bz, h = 2.6) => {
    const len = Math.hypot(bx - ax, bz - az), yaw = Math.atan2(bx - ax, bz - az) - Math.PI / 2, nx = -(bz - az) / len, nz = (bx - ax) / len;
    const g = new THREE.PlaneGeometry(len, h); const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * len / 0.55, uv.getY(i) * h / 0.55);
    g.rotateY(yaw); g.translate((ax + bx) / 2, h / 2, (az + bz) / 2); put(g, M.fence);
    const n = Math.ceil(len / 3);
    for (let i = 0; i <= n; i++) {
      const t = i / n, px = ax + (bx - ax) * t, pz = az + (bz - az) * t;
      box(px, h / 2 + 0.1, pz, 0.12, h + 0.2, 0.12, M.concrete, { coll: false });
      box(px - nx * 0.2, h + 0.3, pz - nz * 0.2, 0.05, 0.6, 0.05, M.galv, { coll: false, yaw, rx: 0.6 });
    }
    for (let k = 0; k < 3; k++) box((ax + bx) / 2 - nx * (0.08 + k * 0.13), h + 0.12 + k * 0.17, (az + bz) / 2 - nz * (0.08 + k * 0.13), len, 0.015, 0.015, M.steelDark, { coll: false, yaw });
    box((ax + bx) / 2, h, (az + bz) / 2, len, 0.04, 0.04, M.galv, { coll: false, yaw });
    coll((ax + bx) / 2, (az + bz) / 2, len / 2, 0.1, yaw, 0, h + 0.4);
  };
  const streetLight = (x, z, yaw = 0, h = 7) => {
    const L = local(x, z, yaw, groundAt(x, z));
    L.cyl(0, h / 2, 0, 0.07, 0.11, h, M.galv, { seg: 8 }); L.box(0, h - 0.05, 0.7, 0.06, 0.06, 1.4, M.galv); L.box(0, h - 0.12, 1.35, 0.3, 0.1, 0.55, M.steelDark); L.box(0, h - 0.18, 1.35, 0.24, 0.02, 0.45, M.lamp);
    coll(x, z, 0.12, 0.12, 0, 0, h);
  };
  const floodMast = (x, z, h = 16, yaw = 0) => {
    const L = local(x, z, yaw);
    L.cyl(0, h / 2, 0, 0.12, 0.22, h, M.galv, { seg: 8 }); L.box(0, h, 0, 1.8, 0.1, 0.4, M.galv);
    for (const sx of [-0.65, 0, 0.65]) { L.box(sx, h + 0.25, 0.15, 0.5, 0.4, 0.25, M.steelDark, { rx: 0.4 }); L.box(sx, h + 0.17, 0.3, 0.42, 0.32, 0.02, M.lamp, { rx: 0.4 }); }
    coll(x, z, 0.22, 0.22, 0, 0, h);
  };
  const flag = (x, z, h, tex, yaw = 0) => {
    cyl(x, h / 2, z, 0.05, 0.07, h, M.galv, { seg: 8 }); cyl(x, h + 0.05, z, 0.08, 0.08, 0.1, M.yellow, { seg: 8 });
    COLL.push({ type: 'circle', x, z, r: 0.08, top: h, base: 0, R: 0.05 });
    const g = new THREE.PlaneGeometry(1.8, 1.08, 12, 4); g.translate(0.9, 0, 0);
    const fl = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ map: tex, side: THREE.DoubleSide, roughness: 0.8 }));
    fl.position.set(x + 0.06, h - 0.6, z); fl.rotation.y = yaw; fl.castShadow = true; live.add(fl);
    flags.push({ mesh: fl, base: g.attributes.position.array.slice(), ph: x * 0.3 });
  };
  const groundAt = (x, z) => terrainH(x, z);
  /** A soldier standing (or sitting) here, posed with one of the soldier's own clips; solid. */
  const npc = (x, z, yaw, clip, y = 0) => { NPCS.push({ x, z, yaw, clip, y }); COLL.push({ type: 'circle', x, z, r: 0.3, top: groundAt(x, z) + y + 1.8, base: -99, R: 0 }); };

  // trees: instanced conifers and broadleaf trees, in 200 m tiles so whole tiles can be culled
  const treeSpots = { conifer: [], broad: [] };
  const tree = (x, z, s, kind = 'conifer', collide = true) => {
    treeSpots[kind].push([x, groundAt(x, z) - 0.1, z, s, rnd() * 6.28]);
    if (collide) COLL.push({ type: 'circle', x, z, r: 0.25 * s + 0.1, top: groundAt(x, z) + 8 * s, base: -99, R: 0 });
  };

  // ================================================================ ground, sky, mountains
  const groundTex = grassTex(); groundTex.repeat.set(1100, 1100); // 2 m tiles (the viewer scrolls this texture)
  const gg = new THREE.PlaneGeometry(2200, 2200, 330, 330); gg.rotateX(-Math.PI / 2);
  {
    const p = gg.attributes.position, col = new Float32Array(p.count * 3), c = new THREE.Color();
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), z = p.getZ(i), h = terrainH(x, z); p.setY(i, h);
      const meadow = 0.5 + 0.5 * Math.sin(x * 0.013 + 2) * Math.cos(z * 0.011);
      c.setRGB(0.95 + 0.12 * meadow, 1.0 + 0.04 * meadow, 0.85 + 0.1 * (1 - meadow));
      if (h > 30) c.multiplyScalar(0.9);
      col.set([c.r, c.g, c.b], i * 3);
    }
    gg.setAttribute('color', new THREE.BufferAttribute(col, 3)); gg.computeVertexNormals();
  }
  const ground = new THREE.Mesh(gg, new THREE.MeshStandardMaterial({ map: groundTex, vertexColors: true, roughness: 1 }));
  ground.receiveShadow = true; ground.name = 'Ground';

  const sky = new THREE.Group(); sky.name = 'Sky';
  {
    const sg = new THREE.SphereGeometry(5000, 32, 16), p = sg.attributes.position, col = new Float32Array(p.count * 3);
    const lo = new THREE.Color('#e7eef1'), mid = new THREE.Color('#b8d0e3'), hi = new THREE.Color('#6f9cc8');
    for (let i = 0; i < p.count; i++) {
      const t = Math.max(0, p.getY(i) / 5000), c = t < 0.12 ? lo.clone().lerp(mid, t / 0.12) : mid.clone().lerp(hi, Math.min(1, (t - 0.12) / 0.6));
      col.set([c.r, c.g, c.b], i * 3);
    }
    sg.setAttribute('color', new THREE.BufferAttribute(col, 3));
    sky.add(new THREE.Mesh(sg, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false })));
    // clouds: soft clusters of flattened blobs
    const cm = new THREE.MeshLambertMaterial({ color: '#ffffff', emissive: '#8a96a4', fog: false, transparent: true, opacity: 0.92 }), cg = [];
    for (let i = 0; i < 26; i++) {
      const a = rnd() * 6.28, r = 900 + rnd() * 2200, cx = Math.cos(a) * r, cz = Math.sin(a) * r, cy = 420 + rnd() * 260;
      for (let k = 0; k < 7; k++) { const g = new THREE.IcosahedronGeometry(60 + rnd() * 70, 1); g.scale(1.6, 0.45, 1.1); g.translate(cx + (rnd() - 0.5) * 220, cy + rnd() * 30, cz + (rnd() - 0.5) * 120); cg.push(g); }
    }
    sky.add(new THREE.Mesh(mergeGeometries(cg), cm));
    // mountain ranges: a ring of peaks, forested slopes, rock and snow on top
    const mg = new THREE.CylinderGeometry(3000, 3900, 1, 260, 10, true), mp = mg.attributes.position, mc = new Float32Array(mp.count * 3);
    const cc = new THREE.Color();
    for (let i = 0; i < mp.count; i++) {
      const x = mp.getX(i), z = mp.getZ(i), y0 = mp.getY(i) + 0.5, a = Math.atan2(z, x);
      const ridge = 360 + 230 * Math.sin(a * 3 + 0.7) + 150 * Math.sin(a * 7 - 1.3) + 70 * Math.sin(a * 13 + 0.4) + 22 * Math.sin(a * 31);
      const k = 1 - y0; // 0 at the outer foot ... 1 at the inner crest row
      const h = Math.max(0, ridge * Math.pow(Math.sin(Math.PI * Math.min(1, y0 * 1.1)), 1.4) * (0.85 + 0.15 * Math.sin(a * 23 + y0 * 5)));
      const rr = Math.hypot(x, z), rs = (3000 + 900 * k) / rr;
      mp.setXYZ(i, x * rs, h - 60, z * rs);
      if (h > 560) cc.set('#f2f4f6'); else if (h > 430) cc.set('#6d7275'); else if (h > 200) cc.set('#30432c'); else cc.set('#2c4027');
      cc.lerp(new THREE.Color('#a7bac9'), h > 560 ? 0.12 : 0.35); // aerial perspective
      mc.set([cc.r, cc.g, cc.b], i * 3);
    }
    mg.setAttribute('color', new THREE.BufferAttribute(mc, 3)); mg.computeVertexNormals();
    const mm = new THREE.Mesh(mg, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, side: THREE.DoubleSide, fog: false }));
    sky.add(mm);
  }

  // ================================================================ AREA BUILDERS
  // (filled in below, one area at a time)
  buildCountryside();
  buildPerimeterAndGate();
  buildHQ();
  buildBarracks();
  buildMotorPool();
  buildAirfield();
  buildTrainingArea();
  buildRange();

  // ---------------------------------------------------------------- countryside
  function buildCountryside() {
    // road from the gate south through the valley to the village
    const pts = [];
    for (let z = -160; z >= -520; z -= 6) pts.push([roadX(z), z]);
    for (let i = 0; i < pts.length - 1; i++) {
      const [x0, z0] = pts[i], [x1, z1] = pts[i + 1], len = Math.hypot(x1 - x0, z1 - z0), yaw = Math.atan2(x1 - x0, z1 - z0);
      const g = new THREE.PlaneGeometry(7, len + 0.4, 2, 1); g.rotateX(-Math.PI / 2); g.rotateY(yaw); g.translate((x0 + x1) / 2, 0, (z0 + z1) / 2);
      const p = g.attributes.position; for (let k = 0; k < p.count; k++) p.setY(k, terrainH(p.getX(k), p.getZ(k)) + 0.06);
      put(g, M.asphalt);
    }
    // the village on the hillside to the south: white houses with red roofs and a church with an onion dome
    const vx = 60, vz = -560;
    const house = (x, z, w, d, yaw) => {
      const L = local(x, z, yaw, groundAt(x, z) - 0.3);
      L.box(0, 2.2, 0, w, 4.4, d, M.houseWhite);
      const s = new THREE.Shape(); s.moveTo(-d / 2 - 0.5, 0); s.lineTo(d / 2 + 0.5, 0); s.lineTo(0, 2.6); s.closePath();
      const g = new THREE.ExtrudeGeometry(s, { depth: w + 1, bevelEnabled: false }); g.translate(0, 4.4, -(w + 1) / 2); g.rotateY(Math.PI / 2); g.applyMatrix4(L.T); put(g, M.roofRed);
      for (let k = -1; k <= 1; k++) for (const fy of [1.3, 3.3]) L.box(k * w / 3.2, fy, d / 2 + 0.01, 0.8, 0.9, 0.02, M.glassDark);
    };
    for (let i = 0; i < 26; i++) {
      const a = rnd() * 6.28, r = 12 + rnd() * 60;
      house(vx + Math.cos(a) * r, vz + Math.sin(a) * r * 0.7, 8 + rnd() * 5, 7 + rnd() * 3, rnd() * 0.5 - 0.25);
    }
    { // church
      const y = groundAt(vx, vz + 30) - 0.3, L = local(vx, vz + 30, 0.2, y);
      L.box(0, 4, 0, 9, 8, 18, M.church);
      const s = new THREE.Shape(); s.moveTo(-5, 0); s.lineTo(5, 0); s.lineTo(0, 4); s.closePath();
      const g = new THREE.ExtrudeGeometry(s, { depth: 19, bevelEnabled: false }); g.translate(0, 8, -9.5); g.applyMatrix4(L.T); put(g, M.roofRed);
      L.box(0, 10, 10.5, 4.2, 20, 4.2, M.church); L.box(0, 20.5, 10.5, 4.6, 1, 4.6, M.roofRed);
      L.sph(0, 23.2, 10.5, 2.4, 1, 1.15, 1, M.onion, 1); L.cyl(0, 26, 10.5, 0.3, 0.9, 2, M.onion, { seg: 8 }); L.cyl(0, 28, 10.5, 0.06, 0.06, 2.4, M.yellow, { seg: 6 });
      for (const fy of [14, 17]) L.box(0, fy, 12.62, 1.2, 1.6, 0.04, M.black);
    }
    // forests over the hills, meadows near the wire and along the valley road
    for (let i = 0; i < 42000; i++) {
      const x = (rnd() - 0.5) * 2000, z = (rnd() - 0.5) * 2000;
      const ox = Math.max(BASE.x0 - x, x - BASE.x1, 0), oz = Math.max(BASE.z0 - z, z - BASE.z1, 0), o = Math.hypot(ox, oz);
      if (o < 30) continue;
      if (z < BASE.z0 && Math.abs(x - roadX(z)) < 40 + 0.05 * (BASE.z0 - z)) continue; // valley floor and road
      if (Math.hypot(x - vx, z - vz) < 110) continue; // the village
      const dens = 0.5 + 0.5 * Math.sin(x * 0.011 + 0.5) * Math.cos(z * 0.0093 - 0.2) + 0.25 * Math.sin(x * 0.031 + z * 0.027);
      if (rnd() > dens * dens * 1.1) continue;
      tree(x, z, 0.8 + rnd() * 0.8, rnd() < 0.82 ? 'conifer' : 'broad', o < 220);
    }
  }

  // ---------------------------------------------------------------- perimeter, gate, towers
  function buildPerimeterAndGate() {
    const { x0, x1, z0, z1 } = BASE;
    // perimeter fence with the main gate opening on the south side
    fence(x0, z0, -6, z0); fence(6, z0, x1, z0); fence(x1, z0, x1, z1); fence(x1, z1, x0, z1); fence(x0, z1, x0, z0);
    // gravel forecourt and the camp's main road
    flat(0, z0 - 8, 30, 34, 0.04, M.gravel);
    flat(0, -40, 9, 240, 0.05, M.asphalt);                 // main road north to the airfield
    for (let z = -150; z < 75; z += 9) flat(0, z, 0.15, 3.5, 0.06, M.white, 0, true);
    for (const sx of [-1, 1]) { flat(sx * 4.7, -40, 0.25, 240, 0.055, M.concreteDark, 0, true); } // kerbs
    // gate: boom barrier, guard booth, jersey-barrier lanes and chicane, halt sign, lights
    const gz = z0 + 2;
    box(-4.6, 0.5, gz, 0.45, 1.0, 0.45, M.steelDark);                                          // barrier pedestal
    for (let i = 0; i < 9; i++) box(-4.2 + i * 0.95, 0.95, gz, 0.95, 0.09, 0.09, i % 2 ? M.white : M.red, { coll: false });
    box(4.6, 0.45, gz, 0.2, 0.9, 0.2, M.steelDark, { coll: false });                         // barrier rest
    { // guard booth with windows all round
      const bx0 = 6.2, bx1 = 9.4, bz0 = gz - 1.4, bz1 = gz + 1.4, H = 2.6;
      boxR(bx0 - 0.2, bx1 + 0.2, 0, 0.25, bz0 - 0.2, bz1 + 0.2, M.concrete);
      wall(bx0, bz0, bx1, bz0, 0.25, H, 0.12, M.wallLight, [win(1.6, 2.4, 0.95, 2.2)]);
      wall(bx0, bz1, bx1, bz1, 0.25, H, 0.12, M.wallLight, [win(1.6, 2.4, 0.95, 2.2)]);
      wall(bx0, bz0, bx0, bz1, 0.25, H, 0.12, M.wallLight, [win(1.4, 2.0, 0.95, 2.2)]);
      wall(bx1, bz0, bx1, bz1, 0.25, H, 0.12, M.wallLight, [door(1.4, 0.9)]);
      boxR(bx0 - 0.5, bx1 + 0.5, 2.85, 3.05, bz0 - 0.5, bz1 + 0.5, M.roofDark);
      boxR(bx0 + 0.15, bx0 + 0.75, 0.25, 1.05, bz0 + 0.2, bz1 - 0.2, M.desk);
      box(bx1 + 0.4, 2.4, gz, 0.4, 0.3, 0.6, M.lamp, { coll: false });
    }
    for (const sx of [-1, 1]) for (let k = 0; k < 4; k++) jersey(sx * 5.5, gz - 5 - k * 3.05, Math.PI / 2);   // approach lanes
    jersey(-2, gz + 9, 0); jersey(3, gz + 15, 0); jersey(-2.5, gz + 21, 0);                                // chicane
    box(-3.2, 1.6, gz - 14, 0.08, 3.2, 0.08, M.galv, { coll: false });
    { const st = new THREE.Mesh(new THREE.CircleGeometry(0.45, 8), new THREE.MeshStandardMaterial({ map: textTex(128, 128, '#b3332b', [['HALT', 64, 36, '#ffffff']]), roughness: 0.6 })); st.position.set(-3.2, 2.9, gz - 14.05); st.rotation.y = Math.PI; live.add(st); }
    streetLight(-7, gz + 1, 0); streetLight(8, gz + 6, Math.PI); floodMast(-18, gz + 4, 12, 0.4);
    // camp sign and flags outside the gate
    {
      const sx = -13, sz = z0 - 9;
      for (const dx of [-2.1, 2.1]) box(sx + dx, 1.3, sz, 0.18, 2.6, 0.18, M.galv);
      box(sx, 2.05, sz, 4.6, 1.3, 0.12, M.white, { coll: false });
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(4.4, 1.15), new THREE.MeshStandardMaterial({ map: textTex(512, 134, '#f2f1ec', [['CAMP EDELWEISS', 56, 54, '#1d2a3a'], ['TRAINING GARRISON', 108, 30, '#2b3a4c', '600']]), roughness: 0.7 }));
      sign.position.set(sx, 2.05, sz - 0.07); sign.rotation.y = Math.PI; live.add(sign);
      const usFlag = canvasTex(256, 144, (g, w, h) => {
        for (let i = 0; i < 13; i++) { g.fillStyle = i % 2 ? '#ffffff' : '#b22234'; g.fillRect(0, (i * h) / 13, w, h / 13 + 1); }
        g.fillStyle = '#3c3b6e'; g.fillRect(0, 0, w * 0.4, (h * 7) / 13);
        g.fillStyle = '#ffffff'; for (let r = 0; r < 9; r++) for (let c = 0; c < (r % 2 ? 5 : 6); c++) g.fillRect(6 + c * 16.5 + (r % 2 ? 8 : 0), 4 + r * 8.3, 3, 3);
      });
      const deFlag = canvasTex(256, 144, (g, w, h) => { g.fillStyle = '#000000'; g.fillRect(0, 0, w, h / 3); g.fillStyle = '#dd0000'; g.fillRect(0, h / 3, w, h / 3); g.fillStyle = '#ffce00'; g.fillRect(0, (2 * h) / 3, w, h / 3 + 1); });
      flag(sx - 6, sz + 3, 8.5, usFlag, -0.3); flag(sx + 7, sz + 3, 8.5, deFlag, -0.3);
    }
    // concrete T-walls inside the gate, and the patrol vehicle on duty
    for (const sx of [-1, 1]) for (let k = 0; k < 10; k++) {
      const x = sx * (13 + k * 1.25);
      box(x, 1.8, gz + 6, 1.2, 3.6, 0.25, M.jersey); box(x, 0.2, gz + 6, 1.2, 0.4, 1.2, M.jersey, { coll: false });
    }
    mrap(12, gz + 12, Math.PI);
    npc(3.2, gz - 1.6, Math.PI, 'Idle'); npc(-2.6, gz - 2.6, Math.PI + 0.4, 'HipFire_Idle'); npc(10.8, gz + 0.6, -Math.PI / 2, 'Idle');
    // lookout towers at the corners and over the gate
    tower(-22, z0 + 7); tower(22, z0 + 7);
    tower(x0 + 8, z0 + 8); tower(x1 - 8, z0 + 8); tower(x0 + 8, z1 - 8); tower(x1 - 8, z1 - 8); tower(x1 - 8, 20); tower(x0 + 8, 60);
  }
  /** Lookout tower: timber legs and bracing, a 6 m platform with a sandbag parapet, a roof, ladder on the south face. */
  function tower(cx, cz) {
    const P = 6.0, half = 1.7;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(cx + sx * (half - 0.15), P / 2, cz + sz * (half - 0.15), 0.25, P, 0.25, M.wood);
    for (const sz of [-1, 1]) for (const r of [0.9, -0.9]) { box(cx, 2.0, cz + sz * (half - 0.15), 3.2, 0.12, 0.12, M.wood, { coll: false, rz: r }); box(cx, 4.4, cz + sz * (half - 0.15), 3.2, 0.12, 0.12, M.wood, { coll: false, rz: r }); }
    for (const sx of [-1, 1]) for (const r of [0.9, -0.9]) box(cx + sx * (half - 0.15), 3.2, cz, 0.12, 0.12, 3.2, M.wood, { coll: false, rx: r });
    boxR(cx - half, cx + half, P - 0.25, P, cz - half, cz + half, M.woodLight);
    sandbags(cx - half + 0.15, cz + half - 0.15, cx + half - 0.15, cz + half - 0.15, 7, 1, P);
    sandbags(cx - half + 0.15, cz - half + 0.15, cx - half + 0.15, cz + half - 0.15, 7, 1, P);
    sandbags(cx + half - 0.15, cz - half + 0.15, cx + half - 0.15, cz + half - 0.15, 7, 1, P);
    sandbags(cx - half + 0.15, cz - half + 0.15, cx - 0.5, cz - half + 0.15, 7, 1, P);
    sandbags(cx + 0.5, cz - half + 0.15, cx + half - 0.15, cz - half + 0.15, 7, 1, P);
    for (const [px, pz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) box(cx + px * (half - 0.1), P + 1.3, cz + pz * (half - 0.1), 0.1, 2.6, 0.1, M.wood, { coll: false });
    const rg = new THREE.ExtrudeGeometry((() => { const s2 = new THREE.Shape(); s2.moveTo(-half - 0.5, 0); s2.lineTo(half + 0.5, 0); s2.lineTo(0, 0.7); s2.closePath(); return s2; })(), { depth: 2 * half + 1, bevelEnabled: false });
    rg.translate(0, P + 2.6, -half - 0.5); rg.translate(cx, 0, cz); put(rg, M.roofDark);
    box(cx + 1.2, P + 2.2, cz + 1.2, 0.4, 0.3, 0.4, M.lamp, { coll: false });
    ladder(cx, cz - half, 0, P, cz - half + 0.9);
  }
  /** Mine-resistant patrol vehicle (generic) with a gunner's turret. */
  function mrap(x, z, yaw, m = M.od) {
    const L = local(x, z, yaw);
    L.box(0, 1.05, 0, 2.3, 0.5, 6.0, M.steelDark);                                   // chassis / V-hull
    L.box(0, 0.75, 0, 1.4, 0.5, 5.4, M.steelDark, { rz: 0 });
    L.box(0, 1.85, 0.2, 2.5, 1.4, 4.0, m); L.box(0, 1.55, 2.75, 2.4, 0.9, 1.5, m, { rx: 0.12 });
    L.box(0, 2.0, 2.22, 2.2, 0.75, 0.05, M.glassDark, { rx: -0.25 });
    for (const sx of [-1.26, 1.26]) { L.box(sx, 2.05, 0.9, 0.03, 0.6, 1.1, M.glassDark); L.box(sx, 2.05, -0.5, 0.03, 0.6, 0.9, M.glassDark); }
    L.box(0, 2.0, -2.15, 2.4, 1.3, 0.4, m); L.cyl(0, 1.9, -2.5, 0.55, 0.55, 0.3, M.tyre, { rx: Math.PI / 2, seg: 14 }); // rear door + spare
    L.cyl(0, 2.7, 0.1, 0.65, 0.7, 0.25, m, { seg: 12 });                              // turret ring
    L.box(0, 3.15, 0.65, 1.3, 0.7, 0.08, m); L.box(-0.6, 3.1, 0.35, 0.08, 0.6, 0.6, m); L.box(0.6, 3.1, 0.35, 0.08, 0.6, 0.6, m); // gunner shield
    L.box(0, 3.1, 1.1, 0.08, 0.1, 1.1, M.black); L.box(0, 3.0, 0.55, 0.2, 0.25, 0.5, M.black);   // machine gun
    L.box(0, 2.62, 1.6, 0.6, 0.04, 0.3, M.steelDark); L.box(-1.0, 2.9, -1.6, 0.04, 1.4, 0.04, M.steelDark); // antennas
    for (const zz of [1.9, -1.6]) for (const sx of [-1.12, 1.12]) L.wheel(sx, 0.62, zz, 0.62, 0.42);
    L.box(0, 1.4, 3.55, 2.2, 0.4, 0.15, M.steelDark);                                // bumper
    L.coll(0, 0.1, 1.25, 3.1, 3.3);
  }

  // ---------------------------------------------------------------- HQ and the tactical operations centre
  function buildHQ() {
    // TOC: a windowless block west of the main road; furnished interior (desks, monitors, wall screens, racks)
    const x0 = -42, x1 = -20, z0 = -112, z1 = -96, H = 3.6;
    flat((x0 + x1) / 2 - 2, (z0 + z1) / 2, 30, 24, 0.03, M.gravel);
    flat(-12, (z0 + z1) / 2, 15, 3, 0.05, M.concreteDark);                                     // path from the road
    wall(x0, z0, x1, z0, 0, H, 0.3, M.wallGrey);
    wall(x0, z1, x1, z1, 0, H, 0.3, M.wallGrey);
    wall(x0, z0, x0, z1, 0, H, 0.3, M.wallGrey);
    wall(x1, z0, x1, z1, 0, H, 0.3, M.wallGrey, [door(8, 1.2, 2.2)]);
    boxR(x0 + 0.15, x1 - 0.15, 0.0, 0.07, z0 + 0.15, z1 - 0.15, M.floorTile, { coll: false });
    boxR(x0 + 0.15, x1 - 0.15, H - 0.2, H - 0.1, z0 + 0.15, z1 - 0.15, M.ceiling);            // ceiling
    boxR(x0 - 0.4, x1 + 0.4, H, H + 0.3, z0 - 0.4, z1 + 0.4, M.roofDark);                       // flat roof
    // interior skin (dark), light panels, cable trays
    for (const [a0, a1, b0, b1] of [[x0 + 0.16, x1 - 0.16, z0 + 0.16, z0 + 0.18], [x0 + 0.16, x1 - 0.16, z1 - 0.18, z1 - 0.16], [x0 + 0.16, x0 + 0.18, z0 + 0.16, z1 - 0.16]]) boxR(a0, a1, 0.04, H - 0.2, b0, b1, M.interior, { coll: false });
    for (let x = x0 + 3; x < x1 - 1; x += 4.5) for (const z of [z0 + 4, z1 - 4]) box(x, H - 0.22, z, 1.2, 0.04, 0.3, M.lamp, { coll: false });
    for (const z of [z0 + 1.2, z1 - 1.2]) box((x0 + x1) / 2, H - 0.45, z, x1 - x0 - 1, 0.06, 0.35, M.steel, { coll: false });
    // wall screens and the TOC sign on the west wall
    const scr = (x, y, z, w, h, kind, yaw) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: screenTex(kind), toneMapped: false }));
      m.position.set(x, y, z); m.rotation.y = yaw; live.add(m);
    };
    for (let i = 0; i < 4; i++) { const z = z0 + 2.6 + i * 3.6; box(x0 + 0.24, 2.05, z, 0.06, 1.0, 1.8, M.black, { coll: false }); scr(x0 + 0.28, 2.05, z, 1.7, 0.92, ['map', 'feed', 'feed2', 'sat'][i], Math.PI / 2); }
    { const sg = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 0.6), new THREE.MeshStandardMaterial({ map: textTex(512, 118, '#e9e6dc', [['CAMP EDELWEISS', 42, 36, '#1d2a3a'], ['TOC', 88, 40, '#1d2a3a']]), roughness: 0.7 }));
      sg.position.set(x0 + 0.27, 3.0, (z0 + z1) / 2); sg.rotation.y = Math.PI / 2; live.add(sg); }
    // two rows of operator desks facing the screens, three monitors each, chairs and operators
    const kinds = ['map', 'feed', 'data', 'sat', 'feed2', 'data'];
    let k = 0;
    for (const dx of [5.0, 9.5]) for (const dz of [-4.5, 0, 4.5]) {
      const cx = x0 + dx, cz = (z0 + z1) / 2 + dz;
      boxR(cx - 0.4, cx + 0.4, 0.72, 0.76, cz - 1.5, cz + 1.5, M.desk); for (const e of [-1.4, 1.4]) boxR(cx - 0.38, cx + 0.38, 0.04, 0.72, cz + e - 0.04, cz + e + 0.04, M.steelDark, { coll: false });
      coll(cx, cz, 0.4, 1.5, 0, 0, 0.76);
      for (const m of [-0.95, 0, 0.95]) {
        box(cx - 0.18, 0.86, cz + m, 0.08, 0.2, 0.08, M.black, { coll: false }); box(cx - 0.16, 1.12, cz + m, 0.04, 0.38, 0.62, M.black, { coll: false });
        scr(cx - 0.135, 1.12, cz + m, 0.58, 0.34, kinds[k++ % kinds.length], Math.PI / 2);
        box(cx + 0.15, 0.775, cz + m, 0.16, 0.015, 0.45, M.black, { coll: false });
      }
      for (const m of [-0.8, 0.8]) chair(cx + 0.85, cz + m, -Math.PI / 2);
      npc(cx + 0.78, cz - 0.8, -Math.PI / 2, 'Seated_Desk');
      if (dz === 0) npc(cx + 0.78, cz + 0.8, -Math.PI / 2, 'Seated_Desk');
    }
    npc(x0 + 13.5, z1 - 2.2, -Math.PI / 2 - 0.3, 'Idle');                                      // watch officer
    // server racks along the north wall with blinking status lights
    for (let i = 0; i < 5; i++) {
      const cx = x0 + 9 + i * 0.75, cz = z1 - 0.75;
      box(cx, 1.0, cz, 0.62, 2.0, 0.95, M.rack);
      const f = new THREE.Mesh(new THREE.PlaneGeometry(0.56, 1.85), new THREE.MeshBasicMaterial({ map: rackTex(), toneMapped: false }));
      f.position.set(cx, 1.0, cz - 0.48); f.rotation.y = Math.PI; live.add(f);
    }
    boxR(x1 - 3.4, x1 - 0.5, 0, 0.9, z0 + 0.4, z0 + 1.2, M.steelDark);                         // map table / radios
    const lt = new THREE.PointLight('#dbe8ff', 22, 20, 1.2); lt.position.set((x0 + x1) / 2, H - 0.5, (z0 + z1) / 2); live.add(lt);
    // outside: AC units, generator, antenna mast, satellite dish, sandbags at the door
    for (let i = 0; i < 3; i++) { box(x0 + 4 + i * 5, 0.5, z0 - 0.8, 1.0, 1.0, 0.7, M.wallLight); box(x0 + 4 + i * 5, 0.5, z0 - 1.16, 0.6, 0.6, 0.02, M.steelDark, { coll: false }); }
    { const G = local(x0 - 3, z0 + 4, 0); G.box(0, 0.8, 0, 1.6, 1.4, 3.2, M.od); G.box(0, 1.55, 1.2, 0.2, 0.3, 0.2, M.black); G.coll(0, 0, 0.8, 1.6, 1.5); }
    cyl(x0 + 3, H + 6, z1 - 2, 0.08, 0.12, 12, M.galv, { seg: 8 });
    for (const y of [H + 4, H + 8, H + 11]) box(x0 + 3, y, z1 - 2, 1.2, 0.04, 0.04, M.galv, { coll: false });
    { const D = local(x1 - 4, z1 - 3, -0.6, H + 0.3); D.cyl(0, 0.6, 0, 0.08, 0.1, 1.2, M.galv); D.sph(0, 1.5, 0.3, 1.1, 1, 1, 0.35, M.white, 2); D.cyl(0, 1.5, 1.1, 0.03, 0.03, 1.4, M.galv, { rx: Math.PI / 2 }); }
    sandbags(x1 + 0.6, z0 + 5.2, x1 + 0.6, z0 + 6.8, 6, 1); sandbags(x1 + 0.6, z0 + 9.2, x1 + 0.6, z0 + 10.8, 6, 1);
    // camo net over the generator
    camoNet(x0 - 3, z0 + 4, 5, 6, 2.6);

    // HQ: two storeys, pitched roof, glazed windows, a porch and flags, east of the main road
    {
      const hx0 = 14, hx1 = 40, hz0 = -114, hz1 = -102, F = 3.3;
      const ws = []; for (let a = 2; a < 25; a += 3) ws.push(win(a, 1.3)), ws.push(win(a, 1.3, F + 0.9, F + 2.0));
      boxR(hx0 + 0.3, hx1 - 0.3, 0, 2 * F, hz0 + 0.3, hz1 - 0.3, M.interior);                // (closed building: solid core)
      wall(hx0, hz0, hx1, hz0, 0, 2 * F, 0.3, M.wallBeige, ws.filter((o) => Math.abs(o.at - 13) > 1.2 || o.bot > F));
      wall(hx0, hz1, hx1, hz1, 0, 2 * F, 0.3, M.wallBeige, ws);
      wall(hx0, hz0, hx0, hz1, 0, 2 * F, 0.3, M.wallBeige, [win(6, 1.3), win(6, 1.3, F + 0.9, F + 2.0)]);
      wall(hx1, hz0, hx1, hz1, 0, 2 * F, 0.3, M.wallBeige, [win(6, 1.3), win(6, 1.3, F + 0.9, F + 2.0)]);
      box(hx0 + 13, 1.1, hz1 + 0.17, 1.6, 2.2, 0.04, M.wood, { coll: false });                // front door (closed)
      boxR(hx0 + 11, hx0 + 15, 0, 0.35, hz1, hz1 + 2.5, M.concrete);                           // porch
      boxR(hx0 + 11, hx0 + 15, 2.8, 3.0, hz1, hz1 + 2.5, M.roofDark, { coll: false });
      for (const dx of [11.2, 14.8]) box(hx0 + dx, 1.5, hz1 + 2.3, 0.15, 2.8, 0.15, M.white, { coll: false });
      gableRoof(hx0, hx1, hz0, hz1, 2 * F, 3.0, M.roofDark, true, 0.5, M.wallBeige);
      const nameTex = textTex(512, 96, '#1f2c3b', [['HEADQUARTERS', 48, 44, '#f1ede2']]);
      const ns = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 0.6), new THREE.MeshStandardMaterial({ map: nameTex })); ns.position.set(hx0 + 13, 3.25, hz1 + 2.52); live.add(ns);
      const camp = canvasTex(256, 144, (g, w, h) => { g.fillStyle = '#3e5a3a'; g.fillRect(0, 0, w, h); g.fillStyle = '#ffffff'; g.font = 'bold 22px sans-serif'; g.textAlign = 'center'; g.fillText('EDELWEISS', w / 2, h - 18); for (let i = 0; i < 6; i++) { g.beginPath(); g.ellipse(w / 2 + Math.cos(i * 1.047) * 18, 58 + Math.sin(i * 1.047) * 18, 14, 7, i * 1.047, 0, 6.3); g.fill(); } g.fillStyle = '#e6c84a'; g.beginPath(); g.arc(w / 2, 58, 9, 0, 6.3); g.fill(); });
      flag(hx0 + 9, hz1 + 7, 9, camp, 0.3);
      flat(hx0 + 13, hz1 + 4.5, 5, 9, 0.05, M.concreteDark);
      for (let i = 0; i < 4; i++) flat(hx0 + 2 + i * 3, hz1 + 9, 2.6, 5, 0.05, M.asphalt);
      mrap(hx0 + 3.5, hz1 + 9, 0, M.odLight); mrap(hx0 + 22, hz1 + 9.5, 0.05);
    }
    // camp road network
    flat(80, -80, 160, 8, 0.05, M.asphalt);         // east road past the barracks
    flat(-40, -60, 72, 7, 0.05, M.asphalt);         // west road to the training area
    flat(80, 0, 160, 8, 0.05, M.asphalt);           // motor pool road
    for (let x = 8; x < 160; x += 9) { flat(x, -80, 3.5, 0.15, 0.06, M.white, 0, true); flat(x, 0, 3.5, 0.15, 0.06, M.white, 0, true); }
    for (let x = -5; x > -76; x -= 9) flat(x, -60, 3.5, 0.15, 0.06, M.white, 0, true);
    for (let z = -150; z < 60; z += 30) { streetLight(-5.5, z, Math.PI / 2); streetLight(5.5, z + 15, -Math.PI / 2); }
    for (let z = -60; z < 62; z += 11) for (const sx of [-1, 1]) if (Math.abs(z + 60) > 6 && Math.abs(z) > 6) tree(sx * 9, z + sx * 3, 0.8 + rnd() * 0.3, 'broad');
    for (let x = 14; x < 160; x += 13) tree(x, -88.5, 0.8 + rnd() * 0.3, 'broad');
    for (let x = 20; x < 160; x += 30) { streetLight(x, -84.5, 0); streetLight(x + 15, 4.5, Math.PI); }
  }
  function chair(x, z, yaw) {
    const L = local(x, z, yaw);
    L.cyl(0, 0.25, 0, 0.03, 0.03, 0.4, M.steel, { seg: 6 }); L.box(0, 0.47, 0, 0.5, 0.08, 0.5, M.chairBlack); L.box(0, 0.8, -0.24, 0.46, 0.6, 0.06, M.chairBlack);
    for (let i = 0; i < 5; i++) L.box(Math.cos(i * 1.26) * 0.2, 0.05, Math.sin(i * 1.26) * 0.2, 0.06, 0.05, 0.4, M.black, { ry: -i * 1.26 });
  }
  function camoNet(cx, cz, w, d, h) {
    const tex = canvasTex(128, 128, (g, n) => { g.clearRect(0, 0, n, n); for (let i = 0; i < 260; i++) { g.fillStyle = ['#4a5a34', '#5b6b3e', '#3c4a2c', '#6b6a44'][i % 4]; g.beginPath(); g.ellipse(rnd() * n, rnd() * n, 3 + rnd() * 7, 2 + rnd() * 5, rnd() * 3, 0, 6.3); g.fill(); } });
    const g = new THREE.PlaneGeometry(w, d, 8, 8); g.rotateX(-Math.PI / 2);
    const p = g.attributes.position; for (let i = 0; i < p.count; i++) { const x = p.getX(i) / (w / 2), z = p.getZ(i) / (d / 2); p.setY(i, h - 0.5 * (x * x + z * z) + 0.1 * Math.sin(i)); }
    g.computeVertexNormals(); g.translate(cx, 0, cz);
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ map: tex, transparent: true, alphaTest: 0.3, side: THREE.DoubleSide, roughness: 1 })); m.castShadow = true; live.add(m);
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) box(cx + sx * (w / 2 - 0.2), (h - 1) / 2, cz + sz * (d / 2 - 0.2), 0.06, h - 1, 0.06, M.wood, { coll: false });
  }
  function screenTex(kind) {
    return canvasTex(256, 160, (g, w, h) => {
      if (kind === 'map' || kind === 'sat') {
        g.fillStyle = kind === 'map' ? '#2c4a33' : '#3d4a36'; g.fillRect(0, 0, w, h);
        for (let i = 0; i < 40; i++) { g.strokeStyle = kind === 'map' ? `rgba(160,200,140,${0.3 + rnd() * 0.3})` : 'rgba(120,130,100,0.6)'; g.beginPath(); const y = rnd() * h; g.moveTo(0, y); for (let x = 0; x <= w; x += 16) g.lineTo(x, y + Math.sin(x * 0.05 + i) * 10); g.stroke(); }
        g.strokeStyle = 'rgba(255,255,255,0.25)'; for (let x = 0; x < w; x += 32) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); } for (let y = 0; y < h; y += 32) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
        for (let i = 0; i < 9; i++) { g.fillStyle = i % 3 ? '#4aa3ff' : '#ff4a4a'; const x = 20 + rnd() * (w - 40), y = 20 + rnd() * (h - 40); g.fillRect(x - 6, y - 4, 12, 8); }
        g.strokeStyle = '#ffd84a'; g.lineWidth = 2; g.beginPath(); g.moveTo(30, h - 20); g.lineTo(110, 70); g.lineTo(200, 50); g.stroke();
      } else if (kind === 'feed' || kind === 'feed2') {
        g.fillStyle = '#2f3430'; g.fillRect(0, 0, w, h);
        for (let i = 0; i < 70; i++) { g.fillStyle = `rgba(${90 + rnd() * 60},${100 + rnd() * 60},${80 + rnd() * 40},0.7)`; g.fillRect(rnd() * w, rnd() * h, 6 + rnd() * 40, 4 + rnd() * 26); }
        g.fillStyle = '#d9d9d9'; g.fillRect(kind === 'feed' ? 120 : 60, 70, 16, 10);
        g.strokeStyle = '#ffffff'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(w / 2 - 20, h / 2); g.lineTo(w / 2 + 20, h / 2); g.moveTo(w / 2, h / 2 - 20); g.lineTo(w / 2, h / 2 + 20); g.stroke(); g.strokeRect(w / 2 - 30, h / 2 - 22, 60, 44);
        g.fillStyle = '#ffffff'; g.font = '10px monospace'; g.fillText('UAS-2  ALT 1200  32U PV 1243 8812', 6, 12); g.fillText('REC  ' + (kind === 'feed' ? '14:22:07Z' : '14:22:09Z'), 6, h - 6);
      } else {
        g.fillStyle = '#0f1a24'; g.fillRect(0, 0, w, h); g.font = '10px monospace';
        for (let r = 0; r < 13; r++) { g.fillStyle = r === 0 ? '#ffd84a' : ['#8fd18f', '#d8e2ea', '#d8e2ea', '#ff8a6a'][r % 4]; g.fillText(r === 0 ? 'UNIT    GRID       STATUS  TIME' : `${['A1', 'B2', 'C3', 'HQ', 'R7'][r % 5]}-${10 + r}  32U ${Math.floor(1000 + rnd() * 8999)} ${Math.floor(1000 + rnd() * 8999)}  ${['OK', 'MOVE', 'HOLD', 'OK'][r % 4]}  14:${10 + r}`, 6, 14 + r * 11.5); }
      }
    });
  }
  function rackTex() {
    return canvasTex(64, 200, (g, w, h) => {
      g.fillStyle = '#16181b'; g.fillRect(0, 0, w, h);
      for (let y = 4; y < h; y += 9) { g.fillStyle = '#2a2d31'; g.fillRect(3, y, w - 6, 7); for (let i = 0; i < 6; i++) { g.fillStyle = rnd() < 0.6 ? '#46ff7a' : rnd() < 0.5 ? '#ffb030' : '#3aa0ff'; g.fillRect(6 + i * 4, y + 2, 2, 2); } }
    });
  }

  // ---------------------------------------------------------------- barracks
  function barracks(cx, cz, len = 36, dep = 11) {
    const x0 = cx - len / 2, x1 = cx + len / 2, z0 = cz - dep / 2, z1 = cz + dep / 2, H = 3.2;
    boxR(x0 + 0.3, x1 - 0.3, 0, H, z0 + 0.3, z1 - 0.3, M.interior);
    const ws = []; for (let a = 2.5; a < len - 1; a += 3.2) if (Math.abs(a - len / 2) > 1.4) ws.push(win(a, 1.3));
    wall(x0, z0, x1, z0, 0, H, 0.3, M.wallBeige, [...ws, door(len / 2, 1.2)]);
    wall(x0, z1, x1, z1, 0, H, 0.3, M.wallBeige, [...ws, door(len / 2, 1.2)]);
    wall(x0, z0, x0, z1, 0, H, 0.3, M.wallBeige, [win(dep / 2, 1.3)]); wall(x1, z0, x1, z1, 0, H, 0.3, M.wallBeige, [door(dep / 2, 1.1)]);
    for (const z of [z0 - 0.17, z1 + 0.17]) box(cx, 1.1, z, 1.15, 2.2, 0.04, M.wood, { coll: false });
    for (const [z, s] of [[z0, -1], [z1, 1]]) { boxR(cx - 1.4, cx + 1.4, 0, 0.3, Math.min(z, z + s * 1.8), Math.max(z, z + s * 1.8), M.concrete); boxR(cx - 1.5, cx + 1.5, 2.6, 2.75, Math.min(z, z + s * 1.8), Math.max(z, z + s * 1.8), M.roofDark, { coll: false }); }
    gableRoof(x0, x1, z0, z1, H, 2.4, M.roofDark, true, 0.45, M.wallBeige);
    for (let i = 0; i < 3; i++) { const x = x0 + 6 + i * 11; box(x, 0.45, z1 + 0.6, 0.9, 0.9, 0.6, M.wallLight); }
    for (const x of [x0 + 0.4, x1 - 0.4]) for (const z of [z0 - 0.2, z1 + 0.2]) box(x, H / 2, z, 0.1, H, 0.1, M.galv, { coll: false });
  }
  function buildBarracks() {
    for (const [cx, cz] of [[34, -138], [80, -138], [34, -60], [80, -60], [126, -60], [34, -34], [80, -34], [126, -34]]) barracks(cx, cz);
    // picnic tables, smoking shelter, portable toilets, a gym frame
    for (let i = 0; i < 4; i++) {
      const L = local(52 + i * 3.2, -96, 0); L.box(0, 0.75, 0, 0.9, 0.06, 2.0, M.woodLight); L.box(-0.6, 0.45, 0, 0.3, 0.05, 2.0, M.woodLight); L.box(0.6, 0.45, 0, 0.3, 0.05, 2.0, M.woodLight);
      for (const z of [-0.8, 0.8]) L.box(0, 0.37, z, 1.4, 0.74, 0.08, M.wood); L.coll(0, 0, 0.75, 1.0, 0.78);
    }
    for (let i = 0; i < 5; i++) { const L = local(110 + i * 1.4, -96, Math.PI); L.box(0, 1.15, 0, 1.2, 2.3, 1.2, i % 2 ? M.odLight : M.od); L.box(0, 2.35, 0, 1.25, 0.1, 1.25, M.white); L.box(0, 1.1, 0.61, 0.8, 1.9, 0.02, M.black); L.coll(0, 0, 0.6, 0.6, 2.4); }
    { const L = local(140, -96, 0); for (const sx of [-1.5, 1.5]) for (const sz of [-1, 1]) L.box(sx, 1.2, sz, 0.1, 2.4, 0.1, M.galv); L.box(0, 2.45, 0, 3.4, 0.1, 2.4, M.roofDark); L.box(0, 0.45, 0.8, 2.8, 0.06, 0.4, M.woodLight); L.coll(0, 0, 1.6, 1.1, 2.5, 2.3); }
  }

  // ---------------------------------------------------------------- motor pool
  function cargoTruck(x, z, yaw, m = M.od) {
    const L = local(x, z, yaw);
    L.box(0, 1.0, 0, 2.2, 0.3, 8.0, M.steelDark);
    L.box(0, 2.0, 2.9, 2.45, 1.6, 2.1, m); L.box(0, 2.5, 3.96, 2.2, 0.7, 0.04, M.glassDark); L.box(0, 1.5, 4.25, 2.35, 0.9, 0.7, m); L.box(0, 1.35, 4.62, 1.6, 0.6, 0.05, M.black);
    L.box(0, 1.55, -1.1, 2.5, 0.6, 5.3, m); L.box(0, 2.7, -1.1, 2.48, 1.7, 5.25, M.canvas); for (let i = 0; i < 5; i++) L.box(0, 3.56, -3.5 + i * 1.2, 2.5, 0.04, 0.05, M.odDark);
    for (const zz of [3.0, -0.4, -1.95]) for (const sx of [-1.1, 1.1]) L.wheel(sx, 0.58, zz, 0.58, 0.4);
    L.box(0, 3.0, 3.2, 0.5, 0.15, 0.4, M.black); L.coll(0, 0.2, 1.3, 4.2, 3.6);
  }
  function tanker(x, z, yaw) {
    const L = local(x, z, yaw);
    L.box(0, 1.0, 0, 2.2, 0.3, 8.5, M.steelDark); L.box(0, 2.0, 3.1, 2.45, 1.6, 2.1, M.od); L.box(0, 2.5, 4.16, 2.2, 0.7, 0.04, M.glassDark); L.box(0, 1.5, 4.45, 2.35, 0.9, 0.7, M.od);
    L.cyl(0, 2.15, -1.0, 1.1, 1.1, 5.6, M.odLight, { rx: Math.PI / 2, seg: 16 }); L.box(0, 3.3, -1.0, 0.6, 0.12, 4.5, M.steelDark);
    for (const zz of [3.2, -0.5, -2.1]) for (const sx of [-1.1, 1.1]) L.wheel(sx, 0.58, zz, 0.58, 0.4);
    L.coll(0, 0.4, 1.3, 4.4, 3.4);
  }
  function apc8(x, z, yaw, m = M.od) {
    const L = local(x, z, yaw);
    L.box(0, 1.5, -0.2, 2.9, 1.3, 7.0, m); L.box(0, 1.35, 3.6, 2.7, 1.0, 1.1, m, { rx: 0.55 }); L.box(0, 2.2, -0.6, 2.6, 0.2, 5.6, m);
    for (const sx of [-1.48, 1.48]) L.box(sx, 1.65, -0.2, 0.06, 0.9, 6.6, M.odDark);
    L.box(0.3, 2.55, 0.3, 1.2, 0.5, 1.4, M.odDark); L.box(0.3, 2.7, 1.3, 0.1, 0.1, 1.4, M.black); L.box(-0.2, 2.75, 0.4, 0.3, 0.3, 0.3, M.glassDark); // remote weapon station
    L.box(-0.9, 2.4, 1.8, 0.5, 0.3, 0.6, M.odDark); L.box(-1.2, 3.0, -3.3, 0.04, 1.8, 0.04, M.steelDark); L.box(1.2, 2.6, -3.3, 0.04, 1.2, 0.04, M.steelDark);
    L.box(0, 1.7, -3.75, 2.2, 1.2, 0.1, M.odDark);
    for (const zz of [2.55, 1.15, -1.45, -2.85]) for (const sx of [-1.35, 1.35]) L.wheel(sx, 0.6, zz, 0.6, 0.42);
    L.coll(0, -0.1, 1.5, 3.9, 2.9);
  }
  function buildMotorPool() {
    flat(112, 30, 120, 52, 0.04, M.concrete);
    for (let x = 60; x <= 160; x += 6) flat(x, 18, 0.15, 10, 0.055, M.yellow, 0, true);
    // arched maintenance shed (open at the south end), with a vehicle on the lift inside
    const wx = 150, wz0 = 26, wz1 = 56, span = 18;
    archShell(wx, (wz0 + wz1) / 2, span, wz1 - wz0, M.hangar, false, 7.5);
    for (const sx of [-1, 1]) coll(wx + sx * (span / 2 - 0.3), (wz0 + wz1) / 2, 0.3, (wz1 - wz0) / 2, 0, 0, 4);
    endWall(wx, wz1, span, 7.5, M.hangar, null);                         // closed back
    endWall(wx, wz0, span, 7.5, M.hangar, 11);                           // open front with a big door frame
    flat(wx, (wz0 + wz1) / 2, span - 1, wz1 - wz0, 0.05, M.concreteDark);
    boxR(wx - 2.2, wx + 2.2, 0, 0.45, wz0 + 9, wz0 + 15, M.steelDark); mrap(wx, wz0 + 12, Math.PI, M.odLight);
    for (let i = 0; i < 5; i++) boxR(wx + 6.4, wx + 8.2, 0, 1.9, wz0 + 6 + i * 3, wz0 + 7.6 + i * 3, i % 2 ? M.red : M.steelDark);
    boxR(wx - 8.3, wx - 6.5, 0, 0.95, wz0 + 6, wz0 + 18, M.steel);
    const sl = new THREE.PointLight('#fff2d8', 8, 22, 1.4); sl.position.set(wx, 6, (wz0 + wz1) / 2); live.add(sl);
    // the park: rows of vehicles
    cargoTruck(60, 30, Math.PI); cargoTruck(66, 30, Math.PI, M.odLight); cargoTruck(72, 30, Math.PI);
    tanker(80, 31, Math.PI); tanker(86, 31, Math.PI);
    apc8(96, 32, Math.PI); apc8(103, 32, Math.PI, M.odLight); apc8(110, 32, Math.PI);
    mrap(119, 31, Math.PI); mrap(125, 31, Math.PI, M.odLight); mrap(131, 31, Math.PI);
    camoNet(103, 32, 22, 10, 4.2);
    // containers and a fuel point
    const cols = [M.od, M.odLight, M.steel, M.od, M.rack];
    for (let r = 0; r < 2; r++) for (let c = 0; c < 6; c++) { const st = (r + c) % 3 === 0 ? 2 : 1; for (let k2 = 0; k2 < st; k2++) { const x = 60 + c * 6.6, z = 50 + r * 3.0; box(x, 1.3 + k2 * 2.6, z, 6.06, 2.6, 2.44, cols[(r * 6 + c + k2) % cols.length]); for (let q = -2; q <= 2; q++) box(x + q * 1.15, 1.3 + k2 * 2.6, z - 1.23, 0.08, 2.3, 0.04, M.steelDark, { coll: false }); } }
    for (const dz of [-3, 3]) { cyl(170, 1.5, 8 + dz, 1.2, 1.2, 6.5, M.white, { rz: Math.PI / 2, seg: 16 }); coll(170, 8 + dz, 3.3, 1.2, 0, 0, 2.7); }
    for (const [ax, az, bx, bz] of [[165, 2, 175, 2], [165, 14, 175, 14]]) sandbags(ax, az, bx, bz, 4, 2);
    floodMast(62, 12, 14); floodMast(160, 12, 14);
  }
  /** End wall of an arched shed: semicircular infill with an optional central door opening of width dw. */
  function endWall(cx, z, span, rise, m, dw) {
    const s = new THREE.Shape(), r = span / 2;
    s.moveTo(-r, 0); for (let i = 0; i <= 24; i++) { const a = Math.PI - (i / 24) * Math.PI; s.lineTo(Math.cos(a) * r, Math.sin(a) * rise); } s.closePath();
    if (dw) { const hole = new THREE.Path(); const dh = rise * 0.8; hole.moveTo(-dw / 2, 0.01); hole.lineTo(dw / 2, 0.01); hole.lineTo(dw / 2, dh); hole.lineTo(-dw / 2, dh); hole.closePath(); s.holes.push(hole); }
    const g = new THREE.ExtrudeGeometry(s, { depth: 0.25, bevelEnabled: false }); g.translate(cx, 0, z - 0.125); put(g, m);
    if (dw) { const side = (span - dw) / 2; coll(cx - r + side / 2, z, side / 2, 0.15, 0, 0, rise * 0.7); coll(cx + r - side / 2, z, side / 2, 0.15, 0, 0, rise * 0.7); coll(cx, z, dw / 2, 0.15, 0, rise * 0.8, rise); }
    else coll(cx, z, r, 0.15, 0, 0, rise);
  }

  // ---------------------------------------------------------------- airfield
  function attackHeli(x, z, yaw) {
    const L = local(x, z, yaw), m = M.odDark;
    L.box(0, 1.55, 0.6, 1.0, 1.4, 5.2, m); L.box(0, 1.25, 3.3, 0.8, 0.9, 1.0, m, { rx: 0.3 });          // fuselage, nose
    L.box(0, 2.35, 2.0, 0.85, 0.55, 1.1, M.glassDark, { rx: -0.15 }); L.box(0, 2.45, 0.9, 0.85, 0.65, 1.1, M.glassDark, { rx: -0.1 }); // tandem canopy
    L.cyl(0, 1.75, -4.0, 0.22, 0.45, 5.4, m, { rx: Math.PI / 2 }); L.box(0, 2.5, -6.6, 0.12, 1.6, 1.0, m, { rx: -0.25 }); L.box(0, 1.85, -6.4, 2.0, 0.08, 0.6, m);
    for (const sx of [-1, 1]) { L.box(sx * 0.75, 2.15, -0.2, 0.55, 0.55, 2.4, m); L.box(sx * 1.3, 1.6, 0.4, 1.6, 0.12, 0.8, m); L.cyl(sx * 1.8, 1.4, 0.4, 0.22, 0.22, 1.4, M.olive || m, { rx: Math.PI / 2 }); L.box(sx * 0.9, 0.35, 1.4, 0.12, 0.7, 0.12, M.steelDark); L.wheel(sx * 0.9, 0.3, 1.4, 0.3, 0.18); }
    L.box(0, 0.9, 3.5, 0.3, 0.3, 0.6, M.black); L.box(0, 0.75, 3.9, 0.08, 0.08, 1.0, M.black);          // chin gun
    L.cyl(0, 2.75, 0.3, 0.12, 0.15, 0.5, M.steelDark); for (let i = 0; i < 4; i++) L.box(0, 3.05, 0.3, 0.45, 0.05, 14.5, M.black, { ry: i * Math.PI / 4 + 0.25 });
    L.box(0.2, 2.5, -6.9, 0.05, 1.6, 0.18, M.black); L.wheel(0, 0.22, -6.2, 0.2, 0.12);
    L.coll(0, 0, 0.8, 4.0, 3.0);
  }
  function utilityHeli(x, z, yaw) {
    const L = local(x, z, yaw), m = M.od;
    L.box(0, 1.6, 0.3, 2.2, 1.9, 5.2, m); L.box(0, 1.6, 3.2, 2.0, 1.6, 1.2, M.glassDark); L.box(0, 1.3, 3.9, 1.8, 0.8, 0.6, m, { rx: 0.4 });
    L.box(0, 2.85, 0.0, 1.5, 0.6, 3.0, m); L.cyl(0, 2.0, -4.6, 0.25, 0.55, 5.4, m, { rx: Math.PI / 2 }); L.box(0, 2.9, -7.0, 0.14, 1.8, 1.2, m, { rx: -0.3 }); L.box(0, 2.1, -6.6, 2.4, 0.08, 0.6, m);
    for (const sx of [-1.12, 1.12]) L.box(sx, 1.55, 0.6, 0.03, 1.2, 1.6, M.odDark);
    L.cyl(0, 3.25, 0.1, 0.13, 0.15, 0.5, M.steelDark); for (let i = 0; i < 4; i++) L.box(0, 3.55, 0.1, 0.5, 0.05, 16, M.black, { ry: i * Math.PI / 4 + 0.6 });
    for (const sx of [-1.2, 1.2]) { L.box(sx, 0.15, 0.8, 0.12, 0.12, 4.8, M.steelDark); L.box(sx * 0.85, 0.45, 1.8, 0.1, 0.6, 0.1, M.steelDark); L.box(sx * 0.85, 0.45, -0.6, 0.1, 0.6, 0.1, M.steelDark); }
    L.coll(0, 0, 1.2, 3.6, 3.4);
  }
  function buildAirfield() {
    // apron, helicopter pads, runway
    flat(0, 103, 200, 66, 0.045, M.apron);
    for (let x = -96; x <= 96; x += 12) flat(x, 103, 0.08, 66, 0.055, M.concreteDark, 0, true);        // slab joints
    for (let z = 76; z <= 130; z += 9) flat(0, z, 200, 0.08, 0.055, M.concreteDark, 0, true);
    const pad = (x, z) => {
      const ring = new THREE.RingGeometry(6.2, 6.6, 32); ring.rotateX(-Math.PI / 2); ring.translate(x, 0.06, z); put(ring, M.yellow);
      flat(x - 1.8, z, 0.6, 4.6, 0.065, M.white, 0, true); flat(x + 1.8, z, 0.6, 4.6, 0.065, M.white, 0, true); flat(x, z, 3.0, 0.6, 0.065, M.white, 0, true);
    };
    const spots = [[-60, 112, 'a'], [-36, 112, 'a'], [-12, 112, 'u'], [12, 112, 'u'], [36, 112, 'a'], [60, 112, 'a'], [-48, 88, 'u'], [24, 88, 'a']];
    for (const [x, z, k2] of spots) { pad(x, z); if (k2 === 'a') attackHeli(x, z, Math.PI + 0.15); else utilityHeli(x, z, Math.PI - 0.1); }
    flat(0, 172, 360, 22, 0.045, M.asphalt);
    for (const z of [161.6, 182.4]) flat(0, z, 356, 0.4, 0.055, M.white, 0, true);
    for (let x = -160; x < 160; x += 24) flat(x + 6, 172, 12, 0.5, 0.055, M.white, 0, true);
    for (const sx of [-1, 1]) for (let i = 0; i < 7; i++) flat(sx * 170, 165 + i * 2.3, 10, 1.3, 0.055, M.white, 0, true);
    flat(0, 150, 10, 34, 0.045, M.asphalt);                                                           // taxiway
    // arched hangars (Quonset) on the west side, open to the apron
    for (const hz of [80, 118]) {
      const hx = -125, span = 26, len = 34;
      archShell(hx, hz, span, len, M.hangar, true, 11);
      for (const sz of [-1, 1]) coll(hx, hz + sz * (span / 2 - 0.3), len / 2, 0.3, 0, 0, 5);
      endWallX(hx - len / 2, hz, span, 11, M.hangar, null); endWallX(hx + len / 2, hz, span, 11, M.hangar, 18);
      flat(hx, hz, len, span - 1, 0.05, M.concreteDark);
      const hl = new THREE.PointLight('#fff2d8', 8, 30, 1.4); hl.position.set(hx, 9, hz); live.add(hl);
    }
    utilityHeli(-128, 118, Math.PI / 2); attackHeli(-126, 80, Math.PI / 2);
    // control tower with a glass cab reached by its ladder (south face)
    {
      const tx0 = 84, tx1 = 90, tz0 = 132, tz1 = 138, F = 9.0;
      boxR(tx0, tx1, 0, F, tz0, tz1, M.wallLight);
      for (let y = 2.4; y < F; y += 2.8) for (const zz of [tz0 - 0.02, tz1 + 0.02]) box((tx0 + tx1) / 2, y, zz, 4.2, 1.1, 0.04, M.glassDark, { coll: false });
      boxR(tx0 - 0.5, tx1 + 0.5, F - 0.25, F, tz0 - 0.5, tz1 + 0.5, M.concreteDark);
      const run = (len) => [0, 1, 2].map((i) => ({ at: len / 6 + i * len / 3, w: len / 3 - 0.16, bot: 0.9, top: 2.55, glass: true }));
      wall(tx0 - 0.5, tz1 + 0.5, tx1 + 0.5, tz1 + 0.5, F, 2.9, 0.12, M.steelDark, run(7));
      wall(tx0 - 0.5, tz0 - 0.5, tx0 - 0.5, tz1 + 0.5, F, 2.9, 0.12, M.steelDark, run(7));
      wall(tx1 + 0.5, tz0 - 0.5, tx1 + 0.5, tz1 + 0.5, F, 2.9, 0.12, M.steelDark, run(7));
      wall(tx0 - 0.5, tz0 - 0.5, tx1 + 0.5, tz0 - 0.5, F, 2.9, 0.12, M.steelDark, [{ at: 1.6, w: 2.2, bot: 0.9, top: 2.55, glass: true }, door(3.5, 1.2), { at: 5.4, w: 2.2, bot: 0.9, top: 2.55, glass: true }]);
      boxR(tx0 - 1.0, tx1 + 1.0, F + 2.9, F + 3.2, tz0 - 1.0, tz1 + 1.0, M.roofDark);
      cyl(tx1 - 1, F + 5, tz1 - 1, 0.04, 0.05, 3.6, M.galv); box(tx1 - 1, F + 6.6, tz1 - 1, 0.04, 0.04, 1.0, M.galv, { coll: false });
      boxR(tx0 + 0.5, tx1 - 0.5, F, F + 0.9, tz1 - 0.9, tz1 + 0.3, M.desk);
      ladder(87, tz0 - 0.5, 0, F, tz0 + 0.6);
    }
    // apron lights, windsock, fuel truck, ground power carts
    for (const x of [-95, -30, 30, 95]) floodMast(x, 70.5, 16, Math.PI);
    cyl(102, 3.5, 150, 0.06, 0.06, 7, M.galv); cyl(102.9, 6.6, 150, 0.4, 0.2, 1.8, M.orange, { rz: Math.PI / 2 });
    tanker(70, 92, Math.PI / 2);
    for (const [x, z] of [[-24, 100], [48, 100]]) { const L = local(x, z, 0.3); L.box(0, 0.6, 0, 1.4, 0.8, 2.2, M.yellow); for (const sx of [-0.6, 0.6]) for (const zz of [-0.8, 0.8]) L.wheel(sx, 0.2, zz, 0.2, 0.12); L.coll(0, 0, 0.7, 1.1, 1.0); }
    // operations buildings beside the apron
    for (const [cx, cz] of [[60, 58], [100, 58]]) barracks(cx, cz, 30, 10);
  }
  function endWallX(x, cz, span, rise, m, dw) {
    const s = new THREE.Shape(), r = span / 2;
    s.moveTo(-r, 0); for (let i = 0; i <= 24; i++) { const a = Math.PI - (i / 24) * Math.PI; s.lineTo(Math.cos(a) * r, Math.sin(a) * rise); } s.closePath();
    if (dw) { const hole = new THREE.Path(), dh = rise * 0.8; hole.moveTo(-dw / 2, 0.01); hole.lineTo(dw / 2, 0.01); hole.lineTo(dw / 2, dh); hole.lineTo(-dw / 2, dh); hole.closePath(); s.holes.push(hole); }
    const g = new THREE.ExtrudeGeometry(s, { depth: 0.25, bevelEnabled: false }); g.translate(0, 0, -0.125); g.rotateY(Math.PI / 2); g.translate(x, 0, cz); put(g, m);
    if (dw) { const side = (span - dw) / 2; coll(x, cz - r + side / 2, 0.15, side / 2, 0, 0, rise * 0.7); coll(x, cz + r - side / 2, 0.15, side / 2, 0, 0, rise * 0.7); coll(x, cz, 0.15, dw / 2, 0, rise * 0.8, rise); }
    else coll(x, cz, 0.15, r, 0, 0, rise);
  }

  // ---------------------------------------------------------------- training area: ruined village in the woods
  function buildTrainingArea() {
    const { x0, x1, z0, z1 } = TRAIN;
    // dirt track from the west road into the woods and through the village
    const track = [];
    for (let t = 0; t <= 1.0001; t += 0.02) { const x = -76 + (-170 + 76) * t, z = -60 + 30 * Math.sin(t * 3.2) - 10 * t; track.push([x, z]); }
    for (let i = 0; i < track.length - 1; i++) {
      const [ax, az] = track[i], [bx, bz] = track[i + 1], len = Math.hypot(bx - ax, bz - az), yaw = Math.atan2(bx - ax, bz - az);
      const g = new THREE.PlaneGeometry(5, len + 0.5, 3, 2); { const uv = g.attributes.uv; for (let k2 = 0; k2 < uv.count; k2++) uv.setXY(k2, uv.getX(k2) * 1.6, uv.getY(k2) * len / 3); }
      g.rotateX(-Math.PI / 2); g.rotateY(yaw); g.translate((ax + bx) / 2, 0, (az + bz) / 2);
      const p = g.attributes.position; for (let k2 = 0; k2 < p.count; k2++) p.setY(k2, terrainH(p.getX(k2), p.getZ(k2)) + 0.05); put(g, M.dirt); occ((ax + bx) / 2, (az + bz) / 2, 3, 3);
      if (i % 3 === 0) for (const side of [-1, 1]) { const nx = Math.cos(yaw) * side, nz = -Math.sin(yaw) * side; rockAt(ax + nx * (3.4 + rnd() * 1.5), az + nz * (3.4 + rnd() * 1.5), 0.35 + rnd() * 0.7); }
    }
    // the village square
    const vx = -118, vz = -45;
    { const disc = new THREE.CircleGeometry(24, 32); disc.rotateX(-Math.PI / 2); disc.translate(vx, 0.04, vz); put(disc, M.mud); occ(vx, vz, 24, 24); }
    ruin(vx - 14, vz + 10, 9, 7, 0.55); ruin(vx + 6, vz + 14, 8, 6, 0.35); ruin(vx + 16, vz - 4, 7, 7, 0.6); ruin(vx - 16, vz - 12, 8, 6, 0.4); ruin(vx + 2, vz - 18, 10, 7, 0.25);
    // two intact buildings for clearance drills
    clearanceHouse2(vx - 2, vz + 0.5);
    clearanceHouse1(vx + 16, vz + 16);
    // rubble, a wrecked car, low stone walls you can vault, the APC and a patrol
    for (let i = 0; i < 9; i++) rubble(vx + (rnd() - 0.5) * 40, vz + (rnd() - 0.5) * 40, 1 + rnd() * 1.6);
    { const L = local(vx - 6, vz - 6, 0.7); L.box(0, 0.7, 0, 1.8, 0.6, 4.2, M.soot); L.box(0, 1.25, -0.3, 1.6, 0.55, 2.0, M.soot); for (const sx of [-0.85, 0.85]) for (const zz of [-1.3, 1.3]) L.cyl(sx, 0.32, zz, 0.32, 0.32, 0.2, M.rust || M.soot, { rz: Math.PI / 2 }); L.coll(0, 0, 0.9, 2.1, 1.5); }
    for (const [ax, az, bx, bz] of [[vx - 30, vz - 26, vx - 18, vz - 26], [vx + 22, vz + 28, vx + 34, vz + 28], [vx - 34, vz + 20, vx - 34, vz + 32]]) stoneWall(ax, az, bx, bz);
    apc8(vx + 30, vz - 14, -1.2, M.odLight);
    smokeAt(vx - 14, vz + 10); smokeAt(vx + 16, vz - 4, 0.7);
    npc(vx + 26, vz - 18, -1.4, 'ADS_Idle'); npc(vx + 34, vz - 20, -1.2, 'Idle'); npc(vx + 36, vz - 10, -1.6, 'Crouch_ADS_Idle'); npc(vx + 24, vz - 9, -1.3, 'HipFire_Idle');
    // the woods: trees on the rolling ground around the village
    for (let i = 0; i < 1400; i++) {
      const x = x0 + 4 + rnd() * (x1 - x0 - 8), z = z0 + 4 + rnd() * (z1 - z0 - 8);
      if (Math.hypot(x - vx, z - vz) < 34) continue;
      if (OCC.some(([a, b, c, d]) => x > a - 2 && x < b + 2 && z > c - 2 && z < d + 2)) continue;
      if (rnd() < 0.35) continue;
      tree(x, z, 0.7 + rnd() * 0.6, rnd() < 0.6 ? 'conifer' : 'broad');
      if (rnd() < 0.08) rockAt(x + 2, z + 1, 0.4 + rnd() * 0.9);
    }
  }
  function smokeAt(x, z, k = 1) {
    const tex = canvasTex(64, 64, (g, n) => { const gr = g.createRadialGradient(n / 2, n / 2, 2, n / 2, n / 2, n / 2); gr.addColorStop(0, 'rgba(255,255,255,0.9)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, n, n); });
    for (let i = 0; i < 26; i++) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: '#8e8c88', transparent: true, depthWrite: false, opacity: 0.5 }));
      sp.raycast = () => {}; live.add(sp);
      smoke.push({ sp, x, z, y0: groundAt(x, z) + 2, t: (i / 26) * 9, k });
    }
  }
  function rockAt(x, z, R) {
    const y = groundAt(x, z), g = new THREE.DodecahedronGeometry(R, 0); g.scale(1.2, 0.7, 1); g.rotateY(x * 1.7 + z); g.translate(x, y + R * 0.2, z); put(g, R > 0.7 ? M.rockDark : M.rock);
    COLL.push({ type: 'circle', x, z, r: R * 0.9, top: y + R * 0.9, base: y - R * 0.5, R }); occ(x, z, R, R);
  }
  function rubble(x, z, s) {
    const y = groundAt(x, z);
    for (let i = 0; i < 14; i++) { const g = new THREE.BoxGeometry(0.2 + rnd() * 0.5, 0.12 + rnd() * 0.25, 0.2 + rnd() * 0.4); g.rotateY(rnd() * 3); g.rotateX(rnd() * 0.6); g.translate(x + (rnd() - 0.5) * s * 1.6, y + rnd() * s * 0.35, z + (rnd() - 0.5) * s * 1.6); put(g, i % 3 ? M.rubble : M.plasterDark); }
    COLL.push({ type: 'circle', x, z, r: s * 0.7, top: y + s * 0.4, base: y - 0.2, R: s * 0.5 });
  }
  function stoneWall(ax, az, bx, bz) {
    const len = Math.hypot(bx - ax, bz - az), alongX = Math.abs(bx - ax) > Math.abs(bz - az), y = groundAt((ax + bx) / 2, (az + bz) / 2);
    boxR(Math.min(ax, bx) - (alongX ? 0 : 0.125), Math.max(ax, bx) + (alongX ? 0 : 0.125), y, y + 1.0, Math.min(az, bz) - (alongX ? 0.125 : 0), Math.max(az, bz) + (alongX ? 0.125 : 0), M.rockDark);
    WALLS.push({ x: (ax + bx) / 2, z: (az + bz) / 2, yaw: alongX ? 0 : Math.PI / 2, half: len / 2 });
  }
  /** A shelled house: jagged walls with blown-out openings, a broken gable, charred rafters and rubble. */
  function ruin(cx, cz, w, d, dmg) {
    const x0 = cx - w / 2, x1 = cx + w / 2, z0 = cz - d / 2, z1 = cz + d / 2, H = 5.2;
    const jag = (ax, az, bx, bz, ops) => {
      const alongX = Math.abs(bx - ax) > Math.abs(bz - az), len = alongX ? Math.abs(bx - ax) : Math.abs(bz - az);
      wall(ax, az, bx, bz, 0, H * (0.65 - dmg * 0.2), 0.3, M.plaster, ops.map((o) => ({ ...o, glass: false, frame: false, top: Math.min(o.top, H * (0.65 - dmg * 0.2) - 0.05) })));
      // ragged upper course: blocks of varying height along the top
      for (let s2 = 0; s2 < len - 0.4; s2 += 0.8) {
        if (rnd() < dmg * 0.8) continue;
        const hh = H * (0.65 - dmg * 0.2), top = hh + rnd() * (H - hh) * (1 - dmg), a = Math.min(len, s2 + 0.8);
        if (ops.some((o) => s2 + 0.4 > o.at - o.w / 2 && s2 + 0.4 < o.at + o.w / 2 && o.top > hh - 0.1)) continue;
        if (alongX) boxR(Math.min(ax, bx) + s2, Math.min(ax, bx) + a, hh, top, az - 0.15, az + 0.15, rnd() < 0.3 ? M.soot : M.plaster);
        else boxR(ax - 0.15, ax + 0.15, hh, top, Math.min(az, bz) + s2, Math.min(az, bz) + a, rnd() < 0.3 ? M.soot : M.plaster);
      }
    };
    jag(x0, z0, x1, z0, [door(w / 2, 1.1), { at: w / 4, w: 1.2, bot: 0.9, top: 2.0 }]);
    jag(x0, z1, x1, z1, [{ at: w / 3, w: 1.6, bot: 0.5, top: 2.2 }, { at: (2 * w) / 3, w: 1.2, bot: 0.9, top: 2.0 }]);
    jag(x0, z0, x0, z1, [{ at: d / 2, w: 1.2, bot: 0.9, top: 2.0 }]);
    jag(x1, z0, x1, z1, [door(d / 2, 1.0)]);
    // surviving gable end and rafters
    { const s2 = new THREE.Shape(); s2.moveTo(-d / 2, 0); s2.lineTo(d / 2, 0); s2.lineTo(0.6, 2.1); s2.lineTo(-0.3, 1.4); s2.closePath();
      const g = new THREE.ExtrudeGeometry(s2, { depth: 0.3, bevelEnabled: false }); g.translate(0, H, -0.15); g.rotateY(Math.PI / 2); g.translate(x0, 0, cz); put(g, M.plaster); }
    for (let i = 0; i < 4; i++) if (rnd() > dmg * 0.6) box(x0 + 1 + i * (w - 2) / 3, H + 0.8, cz - d / 4, 0.12, 0.12, d * 0.62, M.soot, { coll: false, rx: 0.55 });
    if (dmg < 0.45) { const g = new THREE.BoxGeometry(w * 0.6, 0.08, d * 0.55); g.rotateX(0.55); g.translate(cx + w * 0.15, H + 0.9, cz - d / 4); put(g, M.roofRed); }
    rubble(cx + (rnd() - 0.5) * w * 0.5, cz + (rnd() - 0.5) * d * 0.5, 1.2 + dmg); rubble(x1 + 1.2, cz + (rnd() - 0.5) * d, 1.0);
  }
  /** Intact two-storey house with an internal stair, glazed windows and several rooms. */
  function clearanceHouse2(cx, cz) {
    const x0 = cx - 7, x1 = cx + 7, z0 = cz - 5, z1 = cz + 5, H = 3.2;
    wall(x0, z0, x1, z0, 0, 2 * H, 0.25, M.plaster, [door(3), win(7), win(11.5), win(3, 1.2, H + 0.9, H + 2), win(7, 1.2, H + 0.9, H + 2), win(11.5, 1.2, H + 0.9, H + 2)]);
    wall(x0, z1, x1, z1, 0, 2 * H, 0.25, M.plaster, [win(9.5), win(3, 1.2, H + 0.9, H + 2), win(11, 1.2, H + 0.9, H + 2)]);
    wall(x0, z0, x0, z1, 0, 2 * H, 0.25, M.plaster, [win(5), win(5, 1.2, H + 0.9, H + 2)]);
    wall(x1, z0, x1, z1, 0, 2 * H, 0.25, M.plaster, [door(3.5), win(7), win(5, 1.2, H + 0.9, H + 2)]);
    wall(cx + 0.5, z0, cx + 0.5, cz + 1.5, 0, H, 0.15, M.plasterDark, [door(2.5)]);
    const sx = x0 + 0.4, sz = z1 - 1.0;
    const run = stairs(sx, sz, 'x+', 1.4, 16, 0.2, 0.28, M.concreteDark, -1);
    boxR(x0, x1, H - 0.2, H, z0, sz - 0.75, M.concreteDark); boxR(sx + run, x1, H - 0.2, H, sz - 0.75, z1, M.concreteDark); boxR(x0, sx + 0.8, H - 0.2, H, sz - 0.75, z1, M.concreteDark);
    wall(cx + 0.5, z0, cx + 0.5, sz - 0.8, H, H, 0.15, M.plasterDark, [door(2.4)]);
    gableRoof(x0, x1, z0, z1, 2 * H, 2.6, M.roofRed, true, 0.4, M.plaster);
    const l1 = new THREE.PointLight('#ffe7c2', 6, 10, 1.6); l1.position.set(cx, 2.7, cz); live.add(l1);
  }
  /** Intact single-storey house with three rooms. */
  function clearanceHouse1(cx, cz) {
    const x0 = cx - 6, x1 = cx + 6, z0 = cz - 5, z1 = cz + 5, H = 3.0;
    wall(x0, z0, x1, z0, 0, H, 0.25, M.plaster, [door(3), win(8.5)]);
    wall(x0, z1, x1, z1, 0, H, 0.25, M.plaster, [win(3), win(9)]);
    wall(x0, z0, x0, z1, 0, H, 0.25, M.plaster, [win(5)]);
    wall(x1, z0, x1, z1, 0, H, 0.25, M.plaster, [door(7.5), win(3)]);
    wall(cx, z0, cx, z1, 0, H, 0.15, M.plasterDark, [door(5)]);
    wall(cx, cz, x1, cz, 0, H, 0.15, M.plasterDark, [door(3)]);
    gableRoof(x0, x1, z0, z1, H, 2.2, M.roofRed, true, 0.4, M.plaster);
  }

  // ---------------------------------------------------------------- firing range (shooters face east)
  function buildRange() {
    const FL = 60, Z0 = -157, Z1 = -127, lanes = 5, LW = (Z1 - Z0) / lanes;
    flat(FL - 3, (Z0 + Z1) / 2, 7, Z1 - Z0 + 6, 0.05, M.concrete);
    for (let z = Z0 - 2; z <= Z1 + 2; z += 6) box(FL - 3, 1.4, z, 0.15, 2.8, 0.15, M.galv);
    boxR(FL - 6.5, FL + 0.5, 2.8, 2.95, Z0 - 3, Z1 + 3, M.roofDark);
    for (let i = 0; i < lanes; i++) {
      const cz = Z0 + LW * (i + 0.5);
      box(FL - 1.0, 0.45, cz, 0.7, 0.9, 1.6, M.woodLight);
      sandbags(FL + 0.2, cz - 2.4, FL + 0.2, cz - 1.1, 4, 1); sandbags(FL + 0.2, cz + 1.1, FL + 0.2, cz + 2.4, 4, 1);
      for (const d2 of [25, 50, 100]) target(FL + d2, cz, -Math.PI / 2);
    }
    const g = new THREE.CylinderGeometry(0.5, 1, 1, 4, 1); g.rotateY(Math.PI / 4); g.scale(16 / 1.414, 7, (Z1 - Z0 + 20) / 1.414); g.translate(FL + 116, 3.5, (Z0 + Z1) / 2); put(g, M.berm);
    coll(FL + 116, (Z0 + Z1) / 2, 6, (Z1 - Z0 + 16) / 2, 0, 0, 6);
    cyl(FL - 7, 4, Z1 + 4, 0.06, 0.06, 8, M.galv); box(FL - 7, 7.4, Z1 + 4.6, 0.02, 0.7, 1.2, M.red, { coll: false });
  }
  /** Reactive range target facing along +Z of its own frame (turned by yaw); falls away when hit. */
  function target(x, z, yaw) {
    box(x - Math.sin(yaw) * -0.6, 0.25, z - Math.cos(yaw) * -0.6, 2.0, 0.5, 0.6, M.berm, { yaw });
    const pivot = new THREE.Group(); pivot.position.set(x, 0.5, z); pivot.rotation.y = yaw; targetGroup.add(pivot);
    const tilt = new THREE.Group(); pivot.add(tilt);
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.6, 0.08), M.wood); post.position.y = 0.3; tilt.add(post);
    const s = new THREE.Shape();
    s.moveTo(-0.32, 0); s.lineTo(0.32, 0); s.lineTo(0.32, 0.55); s.quadraticCurveTo(0.3, 0.68, 0.14, 0.7);
    s.lineTo(0.1, 0.74); s.quadraticCurveTo(0.15, 0.98, 0, 1.0); s.quadraticCurveTo(-0.15, 0.98, -0.1, 0.74);
    s.lineTo(-0.14, 0.7); s.quadraticCurveTo(-0.3, 0.68, -0.32, 0.55); s.closePath();
    const sil = new THREE.Mesh(new THREE.ShapeGeometry(s, 6), M.silhouette); sil.position.set(0, 0.6, 0.015); M.silhouette.side = THREE.DoubleSide;
    const back = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.15, 0.02), M.board); back.position.set(0, 1.12, 0);
    tilt.add(back, sil);
    const T = { pivot, tilt, state: 'up', t: 0, ang: 0 }; targets.push(T);
    for (const m of [sil, back, post]) { m.userData.target = T; m.castShadow = true; }
  }

  // ---------------------------------------------------------------- instanced trees
  {
    const conifer = (() => {
      const parts2 = [], c = new THREE.Color();
      const add = (g, color) => { const n = g.attributes.position.count, cols = new Float32Array(n * 3); c.set(color); for (let i = 0; i < n; i++) cols.set([c.r, c.g, c.b], i * 3); g.setAttribute('color', new THREE.BufferAttribute(cols, 3)); parts2.push(g.index ? g.toNonIndexed() : g); };
      const t = new THREE.CylinderGeometry(0.12, 0.2, 2.4, 5, 1, true); t.translate(0, 1.2, 0); add(t, '#5a4330');
      [[3.6, 2.2, 2.2], [5.8, 1.6, 1.8], [7.8, 0.95, 1.5]].forEach(([y, r, h], i) => { const g = new THREE.ConeGeometry(r, h * 1.6, 7, 1, true); g.translate(0, y - 0.6, 0); add(g, ['#2f4a2c', '#36532f', '#416137'][i]); });
      return mergeGeometries(parts2.map((g) => { g.deleteAttribute('uv'); return g; }));
    })();
    const broad = (() => {
      const parts2 = [], c = new THREE.Color();
      const add = (g, color) => { const n = g.attributes.position.count, cols = new Float32Array(n * 3); c.set(color); for (let i = 0; i < n; i++) cols.set([c.r, c.g, c.b], i * 3); g.setAttribute('color', new THREE.BufferAttribute(cols, 3)); parts2.push(g.index ? g.toNonIndexed() : g); };
      const t = new THREE.CylinderGeometry(0.14, 0.22, 3.2, 6); t.translate(0, 1.6, 0); add(t, '#5b4a36');
      const a = new THREE.IcosahedronGeometry(2.3, 0); a.scale(1, 0.9, 1); a.translate(0, 4.4, 0); add(a, '#4f6e35');
      const b = new THREE.IcosahedronGeometry(1.6, 0); b.translate(0.9, 5.6, 0.4); add(b, '#5a7a3c');
      return mergeGeometries(parts2.map((g) => { g.deleteAttribute('uv'); return g; }));
    })();
    const tm = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.95 });
    for (const [kind, geo] of [['conifer', conifer], ['broad', broad]]) {
      const tiles = new Map();
      for (const s of treeSpots[kind]) { const k = `${Math.floor(s[0] / 200)},${Math.floor(s[2] / 200)}`; if (!tiles.has(k)) tiles.set(k, []); tiles.get(k).push(s); }
      for (const list of tiles.values()) {
        const im = new THREE.InstancedMesh(geo, tm, list.length), m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), col = new THREE.Color();
        list.forEach(([x, y, z, s, r], i) => {
          q.setFromAxisAngle(V(0, 1, 0), r); m4.compose(V(x, y, z), q, V(s, s * (0.9 + 0.25 * ((x * 13 + z) % 1 + 1) % 1), s)); im.setMatrixAt(i, m4);
          col.setHSL(0.27 + 0.04 * Math.sin(x + z), 0.35, 0.5 + 0.12 * Math.sin(x * 0.7 - z)); im.setColorAt(i, col.multiplyScalar(1.6));
        });
        im.computeBoundingSphere(); im.castShadow = true; im.receiveShadow = true;
        root.add(im);
      }
    }
  }

  // ---------------------------------------------------------------- merge static meshes
  const statics = [];
  for (const [m, list] of parts) {
    const g = mergeGeometries(list, false), mesh = new THREE.Mesh(g, m);
    statics.push(mesh); mesh.castShadow = m !== M.fence; mesh.receiveShadow = true; root.add(mesh);
  }

  // ---------------------------------------------------------------- interaction
  const shardGeo = new THREE.BufferGeometry().setFromPoints([V(0, 0, 0), V(0.06, 0.02, 0), V(0.02, 0.08, 0)]); shardGeo.computeVertexNormals();
  function breakGlass(mesh, point, dir) {
    if (!mesh.userData.glass || !mesh.parent) return false;
    const { w, h, alongX } = mesh.userData.glass;
    mesh.parent.remove(mesh);
    const n = Math.min(40, Math.round(w * h * 14));
    for (let i = 0; i < n; i++) {
      const s = new THREE.Mesh(shardGeo, glassMat), u = (Math.random() - 0.5) * w, v = (Math.random() - 0.5) * h;
      s.position.copy(mesh.position).add(alongX ? V(u, v, 0) : V(0, v, u)); s.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
      const vel = dir.clone().multiplyScalar(0.6 + Math.random() * 1.2).add(V((Math.random() - 0.5) * 0.8, Math.random() * 0.6, (Math.random() - 0.5) * 0.8));
      s.raycast = () => {}; fxGroup.add(s); fx.push({ o: s, vel, spin: V(Math.random() * 10, Math.random() * 10, Math.random() * 10), t: 0, life: 4, floor: point.y - 3 });
    }
    return true;
  }
  function hitTarget(obj) { const T = obj.userData.target; if (!T || T.state !== 'up') return false; T.state = 'falling'; T.t = 0; return true; }
  let clock = 0;
  function update(dt) {
    clock += dt;
    for (let i = fx.length - 1; i >= 0; i--) {
      const e = fx[i]; e.t += dt; e.vel.y -= 9.81 * dt; e.o.position.addScaledVector(e.vel, dt);
      e.o.rotation.x += e.spin.x * dt; e.o.rotation.y += e.spin.y * dt;
      const g = Math.max(e.floor, terrainH(e.o.position.x, e.o.position.z));
      if (e.o.position.y < g + 0.01) { e.o.position.y = g + 0.01; e.vel.set(0, 0, 0); e.spin.set(0, 0, 0); }
      if (e.t > e.life) { fxGroup.remove(e.o); fx.splice(i, 1); }
    }
    for (const T of targets) {
      T.t += dt;
      if (T.state === 'falling') { T.ang = Math.min(1.45, T.ang + dt * 9); if (T.ang >= 1.45) { T.state = 'down'; T.t = 0; } }
      else if (T.state === 'down' && T.t > 3.0) T.state = 'rising';
      else if (T.state === 'rising') { T.ang = Math.max(0, T.ang - dt * 3); if (T.ang <= 0) T.state = 'up'; }
      T.tilt.rotation.x = -T.ang;
    }
    for (const p of smoke) { // smoke drifts up and away on the breeze, swelling and fading
      p.t = (p.t + dt) % 9; const u = p.t / 9;
      p.sp.position.set(p.x + u * 14 * p.k, p.y0 + u * 22 * p.k, p.z + u * 5 * p.k);
      const sc = (2 + u * 9) * p.k; p.sp.scale.set(sc, sc, 1); p.sp.material.opacity = 0.55 * Math.sin(Math.PI * Math.min(1, u * 1.2));
    }
    for (const f of flags) { // flags ripple in the breeze
      const p = f.mesh.geometry.attributes.position;
      for (let i = 0; i < p.count; i++) { const x = f.base[i * 3]; p.setZ(i, Math.sin(x * 2.2 - clock * 4 + f.ph) * 0.12 * x / 1.8); }
      p.needsUpdate = true;
    }
  }
  function onHit(hit, dir) {
    if (!hit.object) return false;
    if (breakGlass(hit.object, hit.point, dir)) return true;
    hitTarget(hit.object); return false;
  }

  return { root, statics, sky, ground, groundTex, glass: glassGroup, targets: targetGroup, colliders: COLL, walls: WALLS, ladders: LADDERS, npcs: NPCS, spawn: SPAWN, terrainH, update, onHit };
}
