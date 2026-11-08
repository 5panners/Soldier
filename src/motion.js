// Motion authoring: biomechanically-driven gait, stances, rifle handling and
// recoil. Every clip is a function of time that returns a PoseSolver spec.
//
// Reference values (see docs/REFERENCES.md):
//  * Walking: stance ≈ 60–62 % of the gait cycle, heel strike with ~15° foot
//    dorsiflexion, heel-off ≈ 40 %, toe-off with ~35–45° heel rise, pelvic
//    rotation ±4–6°, obliquity ±4°, vertical COM excursion ≈ 3–4 cm.
//  * Running: stance ≈ 36–40 %, cadence 160–180 spm, vertical oscillation
//    ≈ 6–8 cm, knee flexion ~20–30° at contact, deep swing-knee flexion.
//  * Load carriage / rifle: increased forward trunk lean, upper body stabilised.
//  * Marksmanship: butt in the shoulder pocket, firm stock (cheek) weld, firing
//    eye on the sight line, support hand under the handguard, firing hand high
//    on the pistol grip, index finger straight outside the guard until firing.

import * as THREE from 'three';
import { V3, qEuler, deg, qPow, localPoint } from './solver.js';
import { SHOULDER_POCKET_LOCAL, UNDERARM_TUCK_LOCAL, RIGHT_EYE_LOCAL, BIND_LOCAL, ANKLE_HEIGHT } from './skeleton.js';
import { WEAPON, rightGrip, leftGrip } from './weapon.js';
import { PoseSolver } from './solver.js';

const G = 9.81;
const TAU = Math.PI * 2;
export const clamp01 = (x) => Math.max(0, Math.min(1, x));
export const smooth = (x) => { x = clamp01(x); return x * x * (3 - 2 * x); };
export const smoother = (x) => { x = clamp01(x); return x * x * x * (x * (x * 6 - 15) + 10); };
const lerp = (a, b, t) => a + (b - a) * t;
const frac = (x) => x - Math.floor(x);
function hermite(p0, v0, p1, v1, T, u) {
  const u2 = u * u, u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * p0 + (u3 - 2 * u2 + u) * T * v0 + (-2 * u3 + 3 * u2) * p1 + (u3 - u2) * T * v1;
}

// --------------------------------------------------------------------------
// Foot geometry (Foot bone local, bind axes): sole contact points
export const HEEL_LOCAL = V3(0, -ANKLE_HEIGHT, -0.060);
export const BALL_LOCAL = V3(0, -ANKLE_HEIGHT, 0.135);

/** foot orientation: pitch (+ = toes up), yaw (+ = toes toward +X), roll */
export const footQuat = (pitch, yaw, roll = 0) => qEuler(-pitch, yaw, roll);

export function footFromPivot(pivot, pivotLocal, pitch, yaw, roll = 0) {
  const quat = footQuat(pitch, yaw, roll);
  const pos = pivot.clone().sub(pivotLocal.clone().applyQuaternion(quat));
  return { pos, quat };
}

// --------------------------------------------------------------------------
// Gait model. phase 0 = heel strike of this foot.

function stanceFoot(phi, g, side) {
  const yaw = side * g.toeOut;
  const x = side * g.footX;
  const heel0 = V3(x, 0, g.zHS);
  if (phi <= g.heelOff) {
    const heel = heel0.clone(); heel.z -= g.L * phi;
    const pitch = phi < g.heelRock ? g.hsPitch * (1 - smooth(phi / g.heelRock)) : 0;
    return { ...footFromPivot(heel, HEEL_LOCAL, pitch, yaw), toe: 0 };
  }
  // ball pivot
  const flat = footFromPivot(heel0.clone().setZ(g.zHS - g.L * g.heelOff), HEEL_LOCAL, 0, yaw);
  const ball = BALL_LOCAL.clone().applyQuaternion(flat.quat).add(flat.pos);
  ball.z -= g.L * (phi - g.heelOff);
  const u = (phi - g.heelOff) / (g.stance - g.heelOff);
  const pitch = -g.toePitch * Math.pow(u, g.heelRisePow ?? 1.6);
  return { ...footFromPivot(ball, BALL_LOCAL, pitch, yaw), toe: -pitch * 0.92 };
}

export function gaitFoot(phi, g, side) {
  phi = frac(phi);
  if (phi < g.stance) return { ...stanceFoot(phi, g, side), planted: true };
  // swing
  const T = g.T, Ts = (1 - g.stance) * T;
  const e = 1e-3;
  const s0 = stanceFoot(g.stance, g, side), s0b = stanceFoot(g.stance - e, g, side);
  const v0 = s0.pos.clone().sub(s0b.pos).divideScalar(e * T);
  const s1 = stanceFoot(0, g, side);
  const v1 = V3(0, -g.landVy, -g.L / T);
  const u = (phi - g.stance) / (1 - g.stance);
  const pos = V3(
    hermite(s0.pos.x, 0, s1.pos.x, 0, Ts, u) - side * g.swingInset * Math.sin(Math.PI * u),
    hermite(s0.pos.y, v0.y, s1.pos.y, v1.y, Ts, u),
    hermite(s0.pos.z, v0.z, s1.pos.z, v1.z, Ts, u),
  );
  // clearance / heel-kick shaping (zero at both ends, zero slope at ends)
  const bump = Math.pow(Math.sin(Math.PI * Math.pow(u, g.liftSkew)), 2);
  pos.y += g.lift * bump;
  pos.z += g.kickBack * Math.pow(Math.sin(Math.PI * Math.pow(u, 0.7)), 2) * (1 - u);
  const pe = 1 - Math.pow(1 - u, g.pitchEase ?? 2.4);
  let pitch = lerp(-g.toePitch, g.hsPitch, pe) + (g.swingPitchBias || 0) * Math.sin(Math.PI * u);
  const yaw = side * g.toeOut;
  const toe = s0.toe * (1 - smooth(u * 3)) + (g.swingToe || 0) * Math.sin(Math.PI * u);
  return { pos, quat: footQuat(pitch, yaw), toe, planted: false };
}

// --------------------------------------------------------------------------
// Spring for secondary (inertial) motion, steady-state over a loop.

/** Steady-state response of a damped spring to a periodic acceleration signal. */
export function periodicSpring(accel, dt, freq = 3.2, zeta = 0.55, cycles = 6) {
  const n = accel.length, w = TAU * freq;
  let x = 0, v = 0;
  const out = new Array(n).fill(0);
  for (let c = 0; c < cycles; c++) {
    for (let i = 0; i < n; i++) {
      const sub = 4;
      for (let k = 0; k < sub; k++) {
        const h = dt / sub;
        const a = -w * w * x - 2 * zeta * w * v - accel[i];
        v += a * h; x += v * h;
      }
      if (c === cycles - 1) out[i] = x;
    }
  }
  return out;
}
/** Same, one-shot (non periodic) */
export function oneShotSpring(accel, dt, freq = 3.2, zeta = 0.55) {
  const w = TAU * freq; let x = 0, v = 0;
  return accel.map((a0) => {
    for (let k = 0; k < 4; k++) { const h = dt / 4; const a = -w * w * x - 2 * zeta * w * v - a0; v += a * h; x += v * h; }
    return x;
  });
}
export function secondDerivative(arr, dt, periodic = true) {
  const n = arr.length;
  return arr.map((_, i) => {
    const a = periodic ? arr[(i - 1 + n) % n] : arr[Math.max(0, i - 1)];
    const b = periodic ? arr[(i + 1) % n] : arr[Math.min(n - 1, i + 1)];
    return (a - 2 * arr[i] + b) / (dt * dt);
  });
}
export function periodicSmooth(arr, sigma) {
  const n = arr.length, r = Math.ceil(sigma * 3), ker = [];
  let sum = 0;
  for (let k = -r; k <= r; k++) { const w = Math.exp(-(k * k) / (2 * sigma * sigma)); ker.push(w); sum += w; }
  return arr.map((_, i) => {
    let s = 0; for (let k = -r; k <= r; k++) s += arr[((i + k) % n + n) % n] * ker[k + r]; return s / sum;
  });
}

// --------------------------------------------------------------------------
// Recoil impulse response (normalised to peak 1)

function makeRecoil(freq, zeta) {
  const w = TAU * freq, wd = w * Math.sqrt(1 - zeta * zeta);
  const f = (t) => (t <= 0 ? 0 : Math.exp(-zeta * w * t) * Math.sin(wd * t));
  const tp = Math.atan(wd / (zeta * w)) / wd;
  const norm = f(tp);
  return (t) => f(t) / norm;
}
export const RECOIL_FAST = makeRecoil(7.5, 0.5);
export const RECOIL_BODY = makeRecoil(4.0, 0.6);

// --------------------------------------------------------------------------
// Hands / fingers

export { hermite, lerp, frac, TAU, G };
export const GRIPS = {
  right: rightGrip(),
  leftCup: leftGrip(0.31, 'cup'),
  leftAds: leftGrip(0.285, 'cup'),
  leftFar: leftGrip(0.355, 'cup'),
  leftNear: leftGrip(0.27, 'cup'),
  leftLow: leftGrip(0.235, 'cup'),
};

const FINGERS_R = {
  rest: { index: [0.08, 0.10, 0.05], middle: [1.30, 1.45, 0.85], thumb: [0.35, 0.45, 0.30], thumbOpp: 0.75 },
  trigger: { index: [0.55, 0.85, 0.40], middle: [1.30, 1.45, 0.85], thumb: [0.35, 0.45, 0.30], thumbOpp: 0.75 },
  pulled: { index: [0.80, 1.05, 0.50], middle: [1.30, 1.45, 0.85], thumb: [0.35, 0.45, 0.30], thumbOpp: 0.75 },
};
export const FINGERS_L = {
  cup: { index: [0.60, 0.75, 0.45], middle: [0.85, 0.95, 0.60], thumb: [0.25, 0.25, 0.15], thumbOpp: 0.15 },
};
export function rightFingers(trigger) { // 0 = straight (discipline), 1 = on trigger, 2 = pulled
  const a = trigger <= 1 ? FINGERS_R.rest : FINGERS_R.trigger;
  const b = trigger <= 1 ? FINGERS_R.trigger : FINGERS_R.pulled;
  const t = trigger <= 1 ? trigger : trigger - 1;
  const mix = (x, y) => x.map((v, i) => lerp(v, y[i], t));
  return { index: mix(a.index, b.index), middle: a.middle, thumb: a.thumb, thumbOpp: a.thumbOpp };
}

// --------------------------------------------------------------------------
// Upper-body carry modes. Weapon placement is expressed relative to the chest
// (Spine2) so the rifle rides with the torso, anchored at the shoulder pocket
// (clavicle space) or tucked under the arm.

export function clav(side, elev, protract) {
  const s = side === 'Left' ? 1 : -1;
  return qEuler(0, -s * deg(protract), s * deg(elev));
}

/**
 * mode: { anchor: 'pocket'|'tuck', contact: V3 (weapon space point at anchor),
 *         rel: Quaternion (weapon orientation in chest space), offset: V3 (chest space) }
 * kick: { rot: Quaternion (weapon space), back: metres }
 */
export function placeWeapon(W, mode, kick) {
  const chestQ = W.Spine2.quat;
  const anchor = mode.anchor === 'pocket'
    ? localPoint(W, 'RightShoulder', SHOULDER_POCKET_LOCAL)
    : localPoint(W, 'Spine2', UNDERARM_TUCK_LOCAL);
  if (mode.offset) anchor.add(mode.offset.clone().applyQuaternion(chestQ));
  let quat = chestQ.clone().multiply(mode.rel);
  if (kick && kick.rot) quat = quat.multiply(kick.rot);
  const pos = anchor.sub(mode.contact.clone().applyQuaternion(quat));
  if (kick && kick.back) pos.add(new THREE.Vector3(0, 0, -kick.back).applyQuaternion(quat));
  if (kick && kick.lift) pos.add(new THREE.Vector3(0, kick.lift, 0).applyQuaternion(chestQ));
  return { pos, quat };
}

// --------------------------------------------------------------------------
// Standing stances (all share the same foot placement so transitions need no step)

const ANK = ANKLE_HEIGHT;
export const COMBAT_FEET = {
  Left: { pos: V3(0.125, ANK, 0.115), quat: footQuat(0, deg(8)), toe: 0 },
  Right: { pos: V3(-0.150, ANK, -0.125), quat: footQuat(0, deg(-24)), toe: 0 },
};
const KNEE_POLE = (yaw, out) => V3(Math.sin(yaw) + out, 0, Math.cos(yaw)).normalize();

function standingBase(o) {
  return {
    hips: { pos: o.hipsPos.clone(), quat: o.hipsQ.clone() },
    chest: o.chestQ.clone(),
    spineDist: [0.27, 0.34, 0.39],
    feet: {
      Left: { ...COMBAT_FEET.Left, pos: COMBAT_FEET.Left.pos.clone() },
      Right: { ...COMBAT_FEET.Right, pos: COMBAT_FEET.Right.pos.clone() },
    },
    kneePole: { Left: KNEE_POLE(deg(4), 0.12), Right: KNEE_POLE(deg(-30), -0.10) },
  };
}

/** The three base upper-body modes, each with its own reference stance. */
export const STANCES = {
  lowReady: {
    hipsPos: V3(-0.012, 0.938, -0.005), hipsQ: qEuler(deg(4), deg(-14), 0),
    chestQ: qEuler(deg(8), deg(-12), deg(1)),
    head: qEuler(deg(7), deg(2), 0),
    clavicle: { Left: clav('Left', 2, 18), Right: clav('Right', 2, 2) },
    mode: {
      anchor: 'pocket', contact: WEAPON.BUTT.clone().add(V3(0, 0.01, 0.02)),
      rel: qEuler(deg(30), deg(22), deg(-12)), offset: V3(0.0, -0.025, 0.02),
    },
    leftGrip: GRIPS.leftLow,
    elbowPole: { Left: V3(0.35, -1, -0.25), Right: V3(-0.55, -1, -0.45) },
    trigger: 0,
  },
  hip: {
    hipsPos: V3(-0.02, 0.905, 0.0), hipsQ: qEuler(deg(9), deg(-20), 0),
    chestQ: qEuler(deg(16), deg(-15), deg(2)),
    head: qEuler(deg(2), deg(-1), 0),
    clavicle: { Left: clav('Left', 0, 14), Right: clav('Right', -4, -6) },
    mode: null, // computed: tucked, aimed level at world forward
    aim: { yaw: deg(1.5), pitch: deg(-1) },
    leftGrip: GRIPS.leftCup,
    elbowPole: { Left: V3(0.30, -1, -0.15), Right: V3(-0.25, -0.65, -1) },
    trigger: 1,
  },
  ads: {
    hipsPos: V3(-0.02, 0.915, 0.0), hipsQ: qEuler(deg(8), deg(-28), 0),
    chestQ: qEuler(deg(10), deg(-25), deg(1)),
    head: null, // calibrated so the right eye sits on the sight line
    clavicle: { Left: clav('Left', 3, 18), Right: null },
    mode: null, // computed: butt in pocket, aimed at world forward
    aim: { yaw: 0, pitch: 0 },
    leftGrip: GRIPS.leftAds,
    elbowPole: { Left: V3(0.25, -1, 0.05), Right: V3(-0.85, -0.75, -0.15) },
    trigger: 1,
  },
};

const solver = new PoseSolver();

/** Build the solver spec for a standing stance. */
export function stanceSpec(st, overrides = {}) {
  const base = standingBase(st);
  const mode = st.mode;
  const spec = {
    ...base,
    clavicle: st.clavicle,
    weapon: (ctx) => placeWeapon(ctx.W, mode, overrides.kick),
    grips: { Right: GRIPS.right, Left: st.leftGrip },
    elbowPole: {
      Left: st.elbowPole.Left.clone().applyQuaternion(st.chestQ).normalize(),
      Right: st.elbowPole.Right.clone().applyQuaternion(st.chestQ).normalize(),
    },
    fingers: { Right: rightFingers(st.trigger), Left: FINGERS_L.cup },
    neckFrac: st.neckFrac ?? 0.45,
  };
  if (st.neckLocal) { spec.neckLocal = st.neckLocal; spec.headLocal = st.headLocal; }
  if (st.headRel) spec.headRel = st.headRel; else spec.head = st.head;
  return spec;
}

/** Weapon orientation (chest space) that points the barrel at a world yaw/pitch for a given chest orientation. */
export function relForWorldAim(chestQ, yaw, pitch, cant = 0) {
  return chestQ.clone().invert().multiply(qEuler(pitch, yaw, cant));
}

// ---- Nelder–Mead (small, deterministic) ----
export function nelderMead(f, x0, step = 0.1, iters = 400) {
  const n = x0.length;
  let pts = [x0.slice()];
  for (let i = 0; i < n; i++) { const p = x0.slice(); p[i] += Array.isArray(step) ? step[i] : step; pts.push(p); }
  let vals = pts.map(f);
  for (let it = 0; it < iters; it++) {
    const idx = vals.map((v, i) => i).sort((a, b) => vals[a] - vals[b]);
    pts = idx.map((i) => pts[i]); vals = idx.map((i) => vals[i]);
    const c = new Array(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) c[j] += pts[i][j] / n;
    const worst = pts[n];
    const xr = c.map((v, j) => v + (v - worst[j])); const fr = f(xr);
    if (fr < vals[0]) {
      const xe = c.map((v, j) => v + 2 * (v - worst[j])); const fe = f(xe);
      if (fe < fr) { pts[n] = xe; vals[n] = fe; } else { pts[n] = xr; vals[n] = fr; }
    } else if (fr < vals[n - 1]) { pts[n] = xr; vals[n] = fr; }
    else {
      const xc = c.map((v, j) => v + 0.5 * (worst[j] - v)); const fc = f(xc);
      if (fc < vals[n]) { pts[n] = xc; vals[n] = fc; }
      else for (let i = 1; i <= n; i++) { pts[i] = pts[i].map((v, j) => pts[0][j] + 0.5 * (v - pts[0][j])); vals[i] = f(pts[i]); }
    }
  }
  const best = vals.indexOf(Math.min(...vals));
  return { x: pts[best], f: vals[best] };
}

/** Eye position in weapon space for a solved pose. */
export function eyeInWeapon(res) {
  const eye = localPoint(res.world, 'Head', RIGHT_EYE_LOCAL);
  const inv = res.weapon.quat.clone().invert();
  return eye.sub(res.weapon.pos).applyQuaternion(inv);
}

let calibrated = false;
/**
 * Calibrate ADS and hip-fire stances:
 *  - ADS: butt seated in the shoulder pocket, barrel at world forward, then solve
 *    head/neck orientation + clavicle elevation so the RIGHT EYE lies exactly on
 *    the optic's sight line (cheek weld) with a sensible eye relief.
 *  - Hip: stock clamped under the right arm, barrel level at world forward.
 */
export function calibrate() {
  if (calibrated) return STANCES;
  const ads = STANCES.ads;
  const relAim = relForWorldAim(ads.chestQ, ads.aim.yaw, ads.aim.pitch, 0);
  const pen = (v, lo, hi) => (v < lo ? (lo - v) ** 2 : v > hi ? (v - hi) ** 2 : 0);
  // x = [neckPitch, neckRoll, neckYaw, headPitch, headYaw, headRoll, clavElev, clavProtract, buttUp]
  const unpack = (x) => {
    const [np, nr, ny, hp, hy, hr, elev, prot, buttUp] = x;
    return {
      ...ads,
      neckLocal: qEuler(np, ny, nr),
      headLocal: qEuler(hp, hy, hr),
      clavicle: { Left: ads.clavicle.Left, Right: clav('Right', elev, prot) },
      mode: { anchor: 'pocket', contact: WEAPON.BUTT.clone().add(V3(0, -buttUp, 0.004)), rel: relAim.clone() },
    };
  };
  const evalAds = (x) => {
    const [np, nr, ny, hp, hy, hr, elev, prot, buttUp] = x;
    const st = unpack(x);
    const res = solver.solve(stanceSpec(st));
    const e = eyeInWeapon(res);
    const perp2 = e.x * e.x + (e.y - WEAPON.SIGHT_Y) * (e.y - WEAPON.SIGHT_Y);
    const relief = pen(e.z, -0.25, -0.13);
    // gaze: head forward axis should look down the barrel
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(res.world.Head.quat);
    const wf = new THREE.Vector3(0, 0, 1).applyQuaternion(res.weapon.quat);
    const gaze = 1 - fwd.dot(wf);
    // anatomical comfort ranges (radians / degrees for clavicle)
    const comfort = pen(np, deg(0), deg(42)) + pen(nr, deg(-4), deg(14)) + pen(ny, deg(-10), deg(25))
      + pen(hp, deg(-25), deg(22)) + pen(hy, deg(-10), deg(20)) + pen(hr, deg(-4), deg(14))
      + 1e-4 * (pen(elev, 0, 26) + pen(prot, -6, 16)) + 0.5 * pen(buttUp, -0.01, 0.035);
    const reg = 0.004 * (np * np + hp * hp) + 0.01 * (nr * nr + ny * ny + hy * hy + hr * hr) + 1e-6 * (elev * elev + prot * prot) + 0.2 * buttUp * buttUp;
    const reach = (res.handErr.Left + res.handErr.Right) * 80;
    return 6000 * perp2 + 40 * relief + 0.3 * gaze + 80 * comfort + reg + reach;
  };
  let best = null;
  for (const start of [
    [deg(30), deg(6), deg(10), deg(-5), deg(5), deg(8), 18, 4, 0.025],
    [deg(36), deg(10), deg(15), deg(-12), deg(0), deg(4), 22, 0, 0.03],
    [deg(24), deg(4), deg(5), deg(4), deg(8), deg(10), 14, 8, 0.02],
  ]) {
    let r = nelderMead(evalAds, start, [deg(6), deg(4), deg(5), deg(6), deg(5), deg(5), 4, 4, 0.008], 1500);
    r = nelderMead(evalAds, r.x, [deg(2), deg(2), deg(2), deg(2), deg(2), deg(2), 1.5, 1.5, 0.003], 1500);
    if (!best || r.f < best.f) best = r;
  }
  const st = unpack(best.x);
  ads.neckLocal = st.neckLocal;
  ads.headLocal = st.headLocal;
  const k = ['neckPitch', 'neckRoll', 'neckYaw', 'headPitch', 'headYaw', 'headRoll', 'elev', 'prot', 'buttUp'];
  ads.calib = Object.fromEntries(k.map((n, i) => [n, best.x[i]]));
  ads.calib.cost = best.f;
  ads.clavicle = st.clavicle;
  ads.mode = st.mode;

  const hip = STANCES.hip;
  hip.mode = {
    anchor: 'tuck', contact: V3(0, 0.072, -0.215),
    rel: relForWorldAim(hip.chestQ, hip.aim.yaw, hip.aim.pitch, deg(-4)),
  };
  // explicit cervical locals for the other stances (so every stance can be blended)
  for (const st of [STANCES.lowReady, hip]) {
    const hd = st.chestQ.clone().invert().multiply(st.head);
    st.neckLocal = qPow(hd, 0.45);
    st.headLocal = qPow(hd, 0.45).invert().multiply(hd);
  }
  calibrated = true;
  return STANCES;
}
