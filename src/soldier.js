// Flat-shaded low-poly soldier: helmet + headset, ballistic glasses, combat shirt,
// plate carrier with pouches, assault pack, battle belt, knee pads, gloves, boots.
// Built in the T-pose bind space as ONE skinned mesh (single material/palette).

import * as THREE from 'three';
import { MeshBuilder, frameRing, flatMaterial } from './meshkit.js';
import { BONE_INDEX as BI, BIND_WORLD as BW, PARENT, buildSkeletonBones } from './skeleton.js';
import { buildRifle, rightGrip } from './weapon.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const w1 = (name) => [[BI[name], 1]];
const wm = (...pairs) => pairs.map(([n, w]) => [BI[n], w]);

// Torso weighting by height (tent functions centred in each bone's region)
const TORSO = [['Hips', 0.95], ['Spine', 1.13], ['Spine1', 1.255], ['Spine2', 1.40], ['Neck', 1.545]];
function torsoW(p) {
  const y = p.y;
  if (y <= TORSO[0][1]) return w1('Hips');
  for (let i = 0; i < TORSO.length - 1; i++) {
    const [a, ya] = TORSO[i], [b, yb] = TORSO[i + 1];
    if (y <= yb) { const t = (y - ya) / (yb - ya); return wm([a, 1 - t], [b, t]); }
  }
  return w1('Neck');
}
// Rigid-ish torso (for hard gear: less flex) – compress blends toward the nearest bone
function gearW(p) {
  const w = torsoW(p);
  if (w.length === 2) {
    const t = w[1][1];
    const s = t < 0.5 ? 0.5 * Math.pow(2 * t, 2) : 1 - 0.5 * Math.pow(2 * (1 - t), 2);
    return [[w[0][0], 1 - s], [w[1][0], s]];
  }
  return w;
}

// Build proportions: a stocky, well-muscled infantryman in body armour.
export const BUILD = { torsoW: 1.12, torsoD: 1.10, leg: 1.14, arm: 1.16, hand: 1.08, boot: 1.08, head: 1.03 };
export const HEAD_SCALE = 1.10; // face/skull size (not the helmet)
export const HEAD_DROP = 0.037; // short, thick neck (head modelled 3.7 cm lower than the original design)

export function buildSoldierGeometry() {
  const B = new MeshBuilder();
  // torso, neck and gear: built at nominal size then widened about the spine axis
  const T = new MeshBuilder();
  buildTorso(T);
  buildGear(T);
  B.append(T, (p) => p.set(p.x * BUILD.torsoW, p.y, p.z * BUILD.torsoD));
  // head + helmet: lowered onto the shorter neck
  const H = new MeshBuilder();
  buildHeadAndHelmet(H);
  B.append(H, (p) => p.set(p.x * BUILD.head, (p.y - 1.665) * BUILD.head + 1.665 - HEAD_DROP, p.z * BUILD.head));
  for (const side of ['Left', 'Right']) {
    buildLeg(B, side);
    buildArm(B, side);
    const HB = new MeshBuilder();
    buildHand(HB, side);
    const wr = BW[`${side}Hand`];
    B.append(HB, (p) => p.sub(wr).multiplyScalar(BUILD.hand).add(wr));
  }
  return B.build();
}

// ------------------------------------------------------------------------- torso
function buildTorso(B) {
  const up = V(0, 1, 0), sx = V(1, 0, 0);
  const R = [
    // y, rx, rz(front/back half-depth), z centre
    [0.835, 0.115, 0.095, 0.0],
    [0.90, 0.160, 0.112, 0.0],
    [0.98, 0.168, 0.110, 0.0],
    [1.06, 0.152, 0.100, 0.005],
    [1.15, 0.150, 0.102, 0.008],
    [1.24, 0.165, 0.112, 0.008],
    [1.33, 0.180, 0.118, 0.006],
    [1.41, 0.186, 0.112, 0.0],
    [1.465, 0.150, 0.085, -0.005],
    [1.50, 0.075, 0.065, -0.005],
  ];
  const rings = R.map(([y, rx, rz, zc]) => frameRing(V(0, y, zc), up, sx, rx, rz, 10, { phase: 0 }));
  const cols = ['fabricDark', 'fabric', 'fabric', 'fabric', 'fabric', 'fabric', 'fabric', 'fabric', 'fabric'];
  B.loft(rings, cols, torsoW, { capStart: true, capEnd: true });
  // neck
  const nr = [
    frameRing(V(0, 1.47, -0.008), up, sx, 0.062, 0.060, 8),
    frameRing(V(0, 1.515, -0.002), up, sx, 0.057, 0.057, 8),
    frameRing(V(0, 1.565, 0.008), up, sx, 0.054, 0.058, 8),
  ];
  B.loft(nr, ['skin', 'skin'], [wm(['Spine2', 0.5], ['Neck', 0.5]), w1('Neck'), wm(['Neck', 0.4], ['Head', 0.6])], { capStart: false, capEnd: false });
}

// ------------------------------------------------------------------------- head
function buildHeadAndHelmet(B) {
  const H = w1('Head');
  const c = V(0, 1.665, 0.012);
  // face and skull are built separately and scaled up as a unit (the helmet keeps its size)
  const F = new MeshBuilder();
  // skull / face
  F.ellipsoid(c, [0.078, 0.102, 0.094], 'skin', H, { w: 10, h: 7 });
  // jaw / chin
  F.box(V(0, 1.598, 0.050), [0.090, 0.050, 0.075], 'skin', H, { taperBottom: [0.72, 0.8] });
  F.box(V(0, 1.586, 0.088), [0.050, 0.030, 0.020], 'skinShade', H);
  // nose
  const nb = V(0, 1.668, 0.100);
  F.poly([V(-0.014, 1.652, 0.098), V(0.014, 1.652, 0.098), V(0, 1.660, 0.122)], 'skinShade', H);
  F.poly([V(0, 1.690, 0.103), V(-0.014, 1.652, 0.098), V(0, 1.660, 0.122)], 'skin', H);
  F.poly([V(0, 1.690, 0.103), V(0, 1.660, 0.122), V(0.014, 1.652, 0.098)], 'skin', H);
  void nb;
  // mouth
  F.box(V(0, 1.623, 0.096), [0.034, 0.005, 0.006], 'lip', H);
  // ears
  for (const s of [-1, 1]) F.box(V(0.079 * s, 1.665, 0.0), [0.016, 0.045, 0.03], 'skinShade', H);
  // ballistic glasses
  for (const s of [-1, 1]) F.box(V(0.032 * s, 1.684, 0.098), [0.044, 0.024, 0.008], 'black', H, { quat: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0.18 * s, 0)) });
  F.box(V(0, 1.690, 0.104), [0.016, 0.008, 0.006], 'black', H);
  for (const s of [-1, 1]) F.box(V(0.074 * s, 1.688, 0.05), [0.006, 0.006, 0.09], 'black', H);
  // stubble / jaw shade sides
  for (const s of [-1, 1]) F.box(V(0.052 * s, 1.612, 0.04), [0.016, 0.04, 0.06], 'skinShade', H);

  B.append(F, (p) => p.sub(c).multiplyScalar(HEAD_SCALE).add(c));
  // helmet shell (high-cut): dome rings
  const hc = V(0, 1.690, 0.004);
  const rx = 0.112, ry = 0.112, rz = 0.124;
  const n = 12, rows = 5;
  const rings = [];
  for (let j = 1; j <= rows; j++) {
    const phi = (Math.PI / 2) * (j / rows) * 1.02;
    const ring = [];
    for (let i = 0; i < n; i++) {
      const th = (2 * Math.PI * i) / n;
      const x = Math.sin(phi) * Math.cos(th) * rx;
      const z = Math.sin(phi) * Math.sin(th) * rz;
      let y = Math.cos(phi) * ry;
      // high cut over the ears, brim higher at the front
      if (j === rows) {
        const front = Math.max(0, Math.sin(th)); // z>0
        const side = Math.abs(Math.cos(th));
        y += 0.018 * front + 0.02 * side * side;
      }
      ring.push(V(hc.x + x, hc.y + y, hc.z + z));
    }
    rings.push(ring);
  }
  const top = V(hc.x, hc.y + ry, hc.z);
  for (let i = 0; i < n; i++) B.tri(top, rings[0][(i + 1) % n], rings[0][i], 'helmet', H);
  for (let r = 0; r < rings.length - 1; r++)
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      B.quad(rings[r][i], rings[r][j], rings[r + 1][j], rings[r + 1][i], r % 2 ? 'helmet' : 'helmetDark', H);
    }
  // inner rim (underside) so the shell has thickness when seen from below
  const rim = rings[rows - 1];
  const inner = rim.map((p) => p.clone().sub(hc).multiplyScalar(0.92).add(hc).add(V(0, 0.006, 0)));
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    B.quad(rim[i], rim[j], inner[j], inner[i], 'helmetDark', H);
  }
  // NVG shroud, side rails, rear counterweight pouch
  B.box(V(0, 1.735, 0.122), [0.05, 0.035, 0.022], 'black', H, { quat: new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.35, 0, 0)) });
  for (const s of [-1, 1]) {
    B.box(V(0.108 * s, 1.705, 0.012), [0.014, 0.022, 0.12], 'helmetDark', H);
    // headset ear cups
    B.cylinder(V(0.083 * s, 1.664, 0.0), V(0.112 * s, 1.664, 0.0), 0.040, 0.034, 'radio', H, { n: 8 });
    B.box(V(0.109 * s, 1.700, 0.0), [0.01, 0.05, 0.015], 'radio', H);
  }
  B.box(V(0, 1.712, -0.122), [0.07, 0.045, 0.03], 'vestDark', H, { quat: new THREE.Quaternion().setFromEuler(new THREE.Euler(0.4, 0, 0)) });
  // mic boom (right)
  B.cylinder(V(-0.10, 1.655, 0.02), V(-0.045, 1.625, 0.095), 0.004, 0.004, 'black', H, { n: 4 });
  B.box(V(-0.04, 1.623, 0.098), [0.014, 0.012, 0.016], 'black', H);
}

// ------------------------------------------------------------------------- legs
function buildLeg(B, side) {
  const s = side === 'Left' ? 1 : -1;
  const P = side;
  const hip = BW[`${P}UpLeg`], knee = BW[`${P}Leg`], ank = BW[`${P}Foot`];
  const down = V(0, -1, 0), sx = V(1, 0, 0);
  const at = (y) => { // centre line x by height
    if (y >= knee.y) { const t = (hip.y - y) / (hip.y - knee.y); return hip.x + (knee.x - hip.x) * t; }
    const t = (knee.y - y) / (knee.y - ank.y); return knee.x + (ank.x - knee.x) * t;
  };
  const rows = [
    // y, rx, rz, zoff, weights
    [0.965, 0.088, 0.098, 0.0, wm(['Hips', 0.75], [`${P}UpLeg`, 0.25])],
    [0.88, 0.090, 0.095, 0.0, wm(['Hips', 0.25], [`${P}UpLeg`, 0.75])],
    [0.76, 0.080, 0.086, 0.004, w1(`${P}UpLeg`)],
    [0.63, 0.067, 0.072, 0.008, w1(`${P}UpLeg`)],
    [0.555, 0.059, 0.064, 0.008, wm([`${P}UpLeg`, 0.8], [`${P}Leg`, 0.2])],
    [0.51, 0.057, 0.060, 0.004, wm([`${P}UpLeg`, 0.5], [`${P}Leg`, 0.5])],
    [0.465, 0.056, 0.060, -0.002, wm([`${P}UpLeg`, 0.2], [`${P}Leg`, 0.8])],
    [0.37, 0.058, 0.066, -0.010, w1(`${P}Leg`)],
    [0.31, 0.049, 0.055, -0.004, w1(`${P}Leg`)],
    [0.272, 0.0575, 0.064, 0.0, w1(`${P}Leg`)], // trousers bloused over the boot top
  ];
  const rings = rows.map(([y, rx, rz, zo]) => frameRing(V(at(y), y, zo), down, sx, rx * BUILD.leg, rz * BUILD.leg, 8, { phase: Math.PI / 8 }));
  B.loft(rings, ['fabric', 'fabric', 'fabricLight', 'fabric', 'fabric', 'fabric', 'fabric', 'fabric', 'fabricDark'], rows.map((r) => r[4]), { capStart: false, capEnd: true });
  // cargo pocket on thigh side
  B.box(V(at(0.72) + s * 0.08 * BUILD.leg, 0.72, 0.01), [0.024, 0.13, 0.10], 'fabricDark', w1(`${P}UpLeg`));
  // knee pad
  B.box(V(at(0.51), 0.505, 0.062 * BUILD.leg), [0.085 * BUILD.leg, 0.10, 0.03], 'pad', wm([`${P}Leg`, 0.85], [`${P}UpLeg`, 0.15]), { taperTop: [0.9, 1], taperBottom: [0.85, 1] });
  B.box(V(at(0.51), 0.505, 0.079 * BUILD.leg), [0.06 * BUILD.leg, 0.07, 0.01], 'black', wm([`${P}Leg`, 0.85], [`${P}UpLeg`, 0.15]));

  // boot shaft: a tall (about 22 cm), rounded 12-sided tube from the padded collar to the ankle,
  // flaring slightly at the top and closing in over the instep
  const bootRows = [
    [0.296, 0.0575, 0.063, 0.000, w1(`${P}Leg`)],
    [0.286, 0.0535, 0.059, 0.000, w1(`${P}Leg`)],
    [0.235, 0.0525, 0.058, 0.000, w1(`${P}Leg`)],
    [0.18, 0.0535, 0.060, 0.000, wm([`${P}Leg`, 0.85], [`${P}Foot`, 0.15])],
    [0.135, 0.054, 0.062, 0.002, wm([`${P}Leg`, 0.55], [`${P}Foot`, 0.45])],
    [0.095, 0.055, 0.068, 0.006, wm([`${P}Leg`, 0.25], [`${P}Foot`, 0.75])],
  ];
  const brings = bootRows.map(([y, rx, rz, zo]) => frameRing(V(ank.x, y, zo), down, sx, rx * BUILD.boot, rz * BUILD.boot, 12, { phase: Math.PI / 12 }));
  B.loft(brings, 'boot', bootRows.map((r) => r[4]), { capStart: true, capEnd: false });
  // foot: one continuous rounded loft from the heel to the toe (rounded heel, instep rising to the
  // ankle, rounded toe), with a matching sole and a deeper heel block
  const F = w1(`${P}Foot`), T = w1(`${P}ToeBase`);
  const footStations = [ // z, half width, upper centre y, upper half height, sole centre y, sole half height
    // chunky flat sole (no raised heel): a thick, even 2.8 cm band all the way round
    [-0.083, 0.014, 0.052, 0.020, 0.014, 0.014],
    [-0.074, 0.030, 0.054, 0.030, 0.014, 0.014],
    [-0.058, 0.044, 0.057, 0.036, 0.014, 0.014],
    [-0.030, 0.050, 0.058, 0.038, 0.014, 0.014],
    [0.020, 0.052, 0.060, 0.038, 0.014, 0.014],
    [0.070, 0.052, 0.057, 0.036, 0.014, 0.014],
    [0.120, 0.0505, 0.050, 0.033, 0.014, 0.014],
    [0.135, 0.050, 0.044, 0.034, 0.014, 0.014],
    [0.170, 0.0505, 0.043, 0.033, 0.014, 0.014], [0.200, 0.0485, 0.041, 0.031, 0.014, 0.014],
    [0.224, 0.043, 0.038, 0.028, 0.014, 0.014], [0.241, 0.034, 0.034, 0.023, 0.014, 0.014],
    [0.251, 0.022, 0.030, 0.016, 0.014, 0.014], [0.256, 0.010, 0.026, 0.009, 0.014, 0.014],
  ];
  const fw = footStations.map(([z]) => (z < 0.13 ? F : T));
  const fRing = (z, hw, yc, hh, grow = 0) => frameRing(V(ank.x, yc, z), V(0, 0, 1), V(1, 0, 0), (hw + grow) * BUILD.boot, hh, 14, { phase: Math.PI / 14 });
  B.loft(footStations.map(([z, hw, yc, hh]) => fRing(z, hw, yc, hh)), 'boot', fw, { capStart: true, capEnd: true });
  B.loft(footStations.map(([z, hw, , , sy, sh]) => fRing(z, hw, sy, sh, 0.006)), 'bootSole', fw, { capStart: true, capEnd: true });
}

// ------------------------------------------------------------------------- arms
function buildArm(B, side) {
  const s = side === 'Left' ? 1 : -1;
  const P = side;
  const ax = V(s, 0, 0), sideV = V(0, 1, 0);
  const sh = BW[`${P}Arm`], el = BW[`${P}ForeArm`], wr = BW[`${P}Hand`];
  const rows = [
    // x (abs), rx (vertical), rz (depth), weights, yoff
    [0.105, 0.070, 0.070, wm(['Spine2', 0.7], [`${P}Shoulder`, 0.3]), -0.01],
    [0.16, 0.074, 0.070, wm(['Spine2', 0.2], [`${P}Shoulder`, 0.45], [`${P}Arm`, 0.35]), -0.005],
    [0.215, 0.066, 0.064, wm([`${P}Shoulder`, 0.15], [`${P}Arm`, 0.85]), -0.004],
    [0.31, 0.056, 0.056, w1(`${P}Arm`), -0.004],
    [0.43, 0.049, 0.050, wm([`${P}Arm`, 0.85], [`${P}ForeArm`, 0.15]), -0.002],
    [0.475, 0.047, 0.050, wm([`${P}Arm`, 0.5], [`${P}ForeArm`, 0.5]), 0.0],
    [0.52, 0.048, 0.050, wm([`${P}Arm`, 0.1], [`${P}ForeArm`, 0.9]), 0.0],
    [0.60, 0.044, 0.046, w1(`${P}ForeArm`), 0.0],
    [0.695, 0.036, 0.038, w1(`${P}ForeArm`), 0.0],
    [0.730, 0.034, 0.040, wm([`${P}ForeArm`, 0.75], [`${P}Hand`, 0.25]), 0.0],
    [0.755, 0.026, 0.040, wm([`${P}ForeArm`, 0.35], [`${P}Hand`, 0.65]), 0.0],
  ];
  const rings = rows.map(([x, rx, rz, , yo]) => frameRing(V(x * s, sh.y + yo, sh.z), ax, sideV, rx * BUILD.arm, rz * BUILD.arm, 8, { phase: Math.PI / 8 }));
  B.loft(rings, ['fabric', 'fabric', 'fabric', 'fabric', 'fabric', 'fabric', 'fabricLight', 'fabric', 'glove', 'glove'], rows.map((r) => r[3]), { capStart: false, capEnd: true });
  // shoulder pocket patch (upper arm)
  B.box(V(0.28 * s, sh.y + 0.0, sh.z + 0.0), [0.06, 0.08 * BUILD.arm, 0.118 * BUILD.arm], 'fabricDark', w1(`${P}Arm`));
  // elbow pad (sleeve reinforcement)
  B.box(V(0.475 * s, sh.y, sh.z - 0.042 * BUILD.arm), [0.06, 0.07, 0.016], 'fabricDark', wm([`${P}Arm`, 0.5], [`${P}ForeArm`, 0.5]));
  void el; void wr;
}

// ------------------------------------------------------------------------- hands
function buildHand(B, side) {
  const s = side === 'Left' ? 1 : -1;
  const P = side;
  const wr = BW[`${P}Hand`];
  const H = w1(`${P}Hand`);
  const ax = V(s, 0, 0), zs = V(0, 0, 1);
  // palm: rounded loft from the wrist to the knuckles
  const palmRows = [[0.010, 0.040, 0.017], [0.040, 0.045, 0.0165], [0.070, 0.0475, 0.0150], [0.094, 0.0475, 0.0125]];
  const palm = palmRows.map(([dx, hz, hy]) => frameRing(V(wr.x + dx * s, wr.y - 0.002, wr.z - 0.0015), ax, zs, hz, hy, 10, { phase: Math.PI / 10 }));
  B.loft(palm, 'glove', palmRows.map(() => H), { capStart: false, capEnd: true });
  // knuckle armour (back of the hand) and the thenar pad at the base of the thumb
  B.box(V(wr.x + 0.080 * s, wr.y + 0.015, wr.z - 0.0015), [0.026, 0.008, 0.086], 'gloveLight', H, { taperTop: [1, 0.9] });
  B.ellipsoid(V(wr.x + 0.034 * s, wr.y - 0.010, wr.z + 0.030), [0.026, 0.014, 0.020], 'glove', H, { w: 8, h: 5 });
  const ext = (name, len) => {
    const p = BW[name], par = BW[PARENT[name]];
    return p.clone().add(p.clone().sub(par).normalize().multiplyScalar(len));
  };
  // A finger is one smooth loft through its three phalanges: slightly swollen at each joint,
  // tapering and closing into a rounded fingertip. Weights blend across the joints.
  const finger = (nodes, bones, radii, flat = 0.9) => {
    // nodes: base, joint 2, joint 3, tip (4 points); bones: 3 bone names; radii: base, j2, j3, tip
    const stations = []; // [position, radius scale, weights]
    const wj = (i) => (i === 0 ? w1(bones[0]) : wm([bones[i - 1], 0.5], [bones[i], 0.5]));
    for (let k = 0; k < 3; k++) {
      const a = nodes[k], b = nodes[k + 1];
      const r0 = radii[k], r1 = radii[k + 1];
      stations.push([a.clone(), r0 * (k ? 1.06 : 1.0), k ? wj(k) : w1(bones[0])]);
      stations.push([a.clone().lerp(b, 0.45), (r0 + r1) * 0.5 * 0.97, w1(bones[k])]);
      stations.push([a.clone().lerp(b, 0.82), (r0 + r1) * 0.5 * 0.97, w1(bones[k])]);
    }
    stations.push([nodes[3].clone(), radii[3], w1(bones[2])]);
    const nose = nodes[3].clone().add(nodes[3].clone().sub(nodes[2]).normalize().multiplyScalar(radii[3] * 0.55));
    stations.push([nose, radii[3] * 0.55, w1(bones[2])]);
    const rings = stations.map(([pt, r], i) => {
      const nxt = stations[Math.min(stations.length - 1, i + 1)][0], prv = stations[Math.max(0, i - 1)][0];
      return frameRing(pt, nxt.clone().sub(prv), zs, r, r * flat, 8, { phase: Math.PI / 8 });
    });
    B.loft(rings, 'glove', stations.map((x) => x[2]), { capStart: false, capEnd: true });
  };
  // index (own bone chain, so it can lie along or pull the trigger)
  const I = [1, 2, 3].map((k) => BW[`${P}HandIndex${k}`]);
  finger([I[0], I[1], I[2], ext(`${P}HandIndex3`, 0.026)], [1, 2, 3].map((k) => `${P}HandIndex${k}`), [0.0105, 0.0098, 0.0092, 0.0085]);
  // middle, ring and little fingers share the Middle chain (they curl together); each is its own
  // finger, side by side, with the natural length differences
  const M = [1, 2, 3].map((k) => BW[`${P}HandMiddle${k}`]);
  const mTip = ext(`${P}HandMiddle3`, 0.026);
  const chain = [M[0], M[1], M[2], mTip];
  const mBones = [1, 2, 3].map((k) => `${P}HandMiddle${k}`);
  const dz0 = wr.z + 0.003 - M[0].z; // middle finger sits at hz + 0.003
  for (const [zOff, len, r] of [[0.003, 1.0, 0.0105], [-0.017, 0.94, 0.0098], [-0.036, 0.78, 0.0088]]) {
    const base = chain[0].clone();
    const nodes = chain.map((c) => c.clone().sub(base).multiplyScalar(len).add(base));
    const dz = wr.z + zOff - base.z;
    nodes.forEach((n) => { n.z += dz; });
    void dz0;
    finger(nodes, mBones, [r, r * 0.95, r * 0.9, r * 0.82]);
  }
  // thumb: thicker, three phalanges
  const Th = [1, 2, 3].map((k) => BW[`${P}HandThumb${k}`]);
  finger([Th[0], Th[1], Th[2], ext(`${P}HandThumb3`, 0.026)], [1, 2, 3].map((k) => `${P}HandThumb${k}`), [0.0140, 0.0125, 0.0112, 0.0102], 0.95);
}

// ------------------------------------------------------------------------- gear
function buildGear(B) {
  // Plate carrier: front & back plates
  B.box(V(0, 1.30, 0.128), [0.30, 0.31, 0.055], 'vest', gearW, { taperTop: [0.92, 1], taperBottom: [1, 1], colors: { top: 'vestLight' } });
  B.box(V(0, 1.30, -0.128), [0.30, 0.32, 0.05], 'vest', gearW, { taperTop: [0.92, 1], colors: { top: 'vestLight' } });
  // cummerbund (sides)
  for (const s of [-1, 1]) {
    B.box(V(0.168 * s, 1.20, 0.0), [0.04, 0.13, 0.25], 'vestDark', gearW);
    // shoulder straps
    B.box(V(0.095 * s, 1.462, 0.0), [0.07, 0.03, 0.26], 'vestDark', gearW, { taperTop: [1, 0.9] });
  }
  // front: triple mag pouch + admin pouch + molle lines
  for (let i = -1; i <= 1; i++) {
    B.box(V(i * 0.083, 1.205, 0.172), [0.072, 0.12, 0.042], 'vestLight', gearW, { colors: { top: 'vestDark' } });
    B.box(V(i * 0.083, 1.262, 0.175), [0.074, 0.018, 0.046], 'vestDark', gearW); // flap
  }
  B.box(V(0, 1.335, 0.163), [0.16, 0.08, 0.025], 'vestDark', gearW);
  for (const y of [1.385, 1.415]) B.box(V(0, y, 0.157), [0.26, 0.008, 0.008], 'webbing', gearW);
  // radio pouch (back left) + antenna, assault pack
  B.box(V(0.10, 1.25, -0.205), [0.075, 0.15, 0.06], 'radio', gearW);
  B.cylinder(V(0.12, 1.33, -0.21), V(0.13, 1.55, -0.24), 0.004, 0.003, 'black', gearW, { n: 4 });
  B.box(V(-0.02, 1.27, -0.215), [0.22, 0.30, 0.08], 'vestDark', gearW, { taperTop: [0.9, 0.8], colors: { back: 'vest' } });
  B.box(V(-0.02, 1.25, -0.262), [0.16, 0.16, 0.02], 'vest', gearW);
  // tourniquet on left shoulder strap
  B.box(V(0.10, 1.40, 0.13), [0.03, 0.08, 0.03], 'black', gearW);

  // Battle belt
  const up = V(0, 1, 0), sx = V(1, 0, 0);
  const belt = [frameRing(V(0, 0.965, 0.0), up, sx, 0.178, 0.124, 12), frameRing(V(0, 1.025, 0.002), up, sx, 0.172, 0.12, 12)];
  B.loft(belt, 'webbing', (p) => w1('Hips'), { capStart: false, capEnd: false });
  // belt buckle and pouches
  B.box(V(0, 0.995, 0.126), [0.06, 0.045, 0.012], 'black', w1('Hips'));
  B.box(V(0.17, 0.975, 0.06), [0.04, 0.10, 0.07], 'vestDark', w1('Hips')); // left: med pouch
  B.box(V(0.16, 0.96, -0.08), [0.05, 0.12, 0.08], 'webbing', w1('Hips'));   // dump pouch
  B.box(V(-0.175, 0.985, 0.03), [0.04, 0.09, 0.065], 'vestDark', w1('Hips')); // right: mag pouch
  B.box(V(-0.12, 0.975, -0.13), [0.08, 0.075, 0.04], 'vestDark', w1('Hips'));
  // groin protector / fly
  B.box(V(0, 0.90, 0.112), [0.08, 0.06, 0.012], 'fabricDark', w1('Hips'));
}

/** Build the full rigged soldier: { root, mesh, skeleton, bones, rifle, socket } */
export function buildSoldier() {
  const { root, bones, list } = buildSkeletonBones();
  // Weapon socket bone on the right hand: rifle placed so the hand holds the grip.
  const g = rightGrip();
  const inv = new THREE.Matrix4().compose(g.pos, g.quat, new THREE.Vector3(1, 1, 1)).invert();
  const socket = new THREE.Bone();
  socket.name = 'Weapon_R';
  inv.decompose(socket.position, socket.quaternion, new THREE.Vector3());
  bones.RightHand.add(socket);
  list.push(socket);

  const skeleton = new THREE.Skeleton(list);
  const geometry = buildSoldierGeometry();
  const mesh = new THREE.SkinnedMesh(geometry, flatMaterial('Soldier'));
  mesh.name = 'SoldierMesh';
  mesh.castShadow = true;
  mesh.receiveShadow = false;
  mesh.frustumCulled = false;

  const group = new THREE.Group();
  group.name = 'Soldier';
  group.add(root);
  group.add(mesh);
  root.updateMatrixWorld(true);
  mesh.bind(skeleton);

  const rifle = buildRifle();
  socket.add(rifle);
  bones.Weapon_R = socket;
  return { group, root, mesh, skeleton, bones, rifle, socket };
}
