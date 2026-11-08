// Clip library. Each clip is a list of PoseSolver specs sampled at FPS.
// Locomotion is IN-PLACE (the ground moves under the character at `speed` m/s);
// vertical motion (bob, jump) is baked into the Hips track.

import * as THREE from 'three';
import { V3, qEuler, deg, PoseSolver } from './solver.js';
const crawlSolver = new PoseSolver();
import { BIND_LOCAL, LEG_UPPER, LEG_LOWER } from './skeleton.js';
import {
  STANCES, COMBAT_FEET, GRIPS, FINGERS_L, calibrate, gaitFoot, footFromPivot, footQuat, BALL_LOCAL,
  placeWeapon, rightFingers, periodicSpring, oneShotSpring, secondDerivative, periodicSmooth,
  RECOIL_FAST, RECOIL_BODY, smooth, smoother, hermite, lerp, TAU, G, clav, footBasis, HEEL_LOCAL,
} from './motion.js';
import { leftGrip, rightGrip } from './weapon.js';

export const FPS = 60;
const DT = 1 / FPS;
const LEG_R = (LEG_UPPER + LEG_LOWER) * 0.985;

// ------------------------------------------------------------------ helpers
const KP = (yaw, out) => V3(Math.sin(yaw) + out, 0, Math.cos(yaw)).normalize();
const cloneFeet = (f) => ({
  Left: { pos: f.Left.pos.clone(), quat: f.Left.quat.clone(), toe: f.Left.toe || 0 },
  Right: { pos: f.Right.pos.clone(), quat: f.Right.quat.clone(), toe: f.Right.toe || 0 },
});
const STAND_KNEES = { Left: KP(deg(8), 0.12), Right: KP(deg(-30), -0.10) };

/** shallow-copy a stance and override fields */
const derive = (st, o) => ({ ...st, ...o });

/** Blend two stances (for transitions). Weapon placement is blended in world space. */
export function blendStance(a, b, t, arc = null) {
  const sl = (qa, qb) => qa.clone().slerp(qb, t);
  return {
    hipsPos: a.hipsPos.clone().lerp(b.hipsPos, t),
    hipsQ: sl(a.hipsQ, b.hipsQ),
    chestQ: sl(a.chestQ, b.chestQ),
    clavicle: { Left: sl(a.clavicle.Left, b.clavicle.Left), Right: sl(a.clavicle.Right, b.clavicle.Right) },
    neckLocal: sl(a.neckLocal, b.neckLocal),
    headLocal: sl(a.headLocal, b.headLocal),
    elbowPole: { Left: a.elbowPole.Left.clone().lerp(b.elbowPole.Left, t), Right: a.elbowPole.Right.clone().lerp(b.elbowPole.Right, t) },
    leftGrip: { pos: a.leftGrip.pos.clone().lerp(b.leftGrip.pos, t), quat: sl(a.leftGrip.quat, b.leftGrip.quat) },
    trigger: lerp(a.trigger, b.trigger, t),
    modeA: a.mode, modeB: b.mode, modeT: t, arc,
    feet: blendFeet(a.feet || COMBAT_FEET, b.feet || COMBAT_FEET, t),
    kneePole: {
      Left: (a.kneePole || STAND_KNEES).Left.clone().lerp((b.kneePole || STAND_KNEES).Left, t).normalize(),
      Right: (a.kneePole || STAND_KNEES).Right.clone().lerp((b.kneePole || STAND_KNEES).Right, t).normalize(),
    },
  };
}

/** Blend foot placements; a foot that has to move is lifted along an arc (a real step, not a slide). */
function blendFeet(fa, fb, t) {
  const out = {};
  for (const s of ['Left', 'Right']) {
    const a = fa[s], b = fb[s];
    const d = a.pos.distanceTo(b.pos);
    // the moving foot steps a little later and faster than the body moves
    const u = d > 0.03 ? smoother((t - 0.1) / 0.75) : t;
    const pos = a.pos.clone().lerp(b.pos, u);
    if (d > 0.03) pos.y += Math.min(0.09, 0.35 * d) * Math.sin(Math.PI * u);
    out[s] = { pos, quat: a.quat.clone().slerp(b.quat, u), toe: lerp(a.toe || 0, b.toe || 0, u) };
  }
  return out;
}

function weaponFor(W, st, o) {
  let w;
  if (st.modeA) {
    const wa = placeWeapon(W, st.modeA, o.kick), wb = placeWeapon(W, st.modeB, o.kick);
    w = { pos: wa.pos.lerp(wb.pos, st.modeT), quat: wa.quat.slerp(wb.quat, st.modeT) };
    if (st.arc) w.pos.add(st.arc.clone().applyQuaternion(W.Spine2.quat).multiplyScalar(Math.sin(Math.PI * st.modeT)));
  } else {
    w = placeWeapon(W, st.mode, o.kick);
  }
  if (o.lag) { // inertial lag (metres, + = weapon drops relative to the chest)
    w.pos.add(V3(0, -o.lag, 0).applyQuaternion(W.Spine2.quat));
    w.quat.multiply(qEuler(o.lag * 9, 0, 0)); // muzzle dips with the lag
  }
  if (o.lagX) { // sideways inertia: rifle swings a little against the weight shift
    w.pos.add(V3(-o.lagX, 0, 0).applyQuaternion(W.Spine2.quat));
    w.quat.multiply(qEuler(0, -o.lagX * 6, o.lagX * 10));
  }
  return w;
}

/** Stance (+ options) -> PoseSolver spec */
export function specFrom(st, o = {}) {
  const chestQ = st.chestQ;
  const spec = {
    hips: { pos: st.hipsPos.clone(), quat: st.hipsQ.clone() },
    chest: chestQ.clone(),
    spineDist: [0.27, 0.34, 0.39],
    feet: o.feet || cloneFeet(st.feet || COMBAT_FEET),
    kneePole: o.kneePole || st.kneePole || STAND_KNEES,
    clavicle: st.clavicle,
    weapon: (ctx) => weaponFor(ctx.W, st, o),
    grips: { Right: GRIPS.right, Left: st.leftGrip },
    elbowPole: {
      Left: st.elbowPole.Left.clone().applyQuaternion(chestQ).normalize(),
      Right: st.elbowPole.Right.clone().applyQuaternion(chestQ).normalize(),
    },
    fingers: { Right: rightFingers(o.trigger ?? st.trigger), Left: FINGERS_L.cup },
    twistShare: 0.6,
  };
  if (o.headWorld) spec.head = o.headWorld;
  else { spec.neckLocal = st.neckLocal; spec.headLocal = st.headLocal; }
  return spec;
}

// ------------------------------------------------------------------ gaits
export const GAITS = {
  walk: {
    T: 1.10, v: 1.25, stance: 0.62, heelRock: 0.10, heelOff: 0.40, zHS: 0.31, footX: 0.112, toeOut: deg(7),
    hsPitch: deg(16), toePitch: deg(38), heelRisePow: 1.6, lift: 0.07, liftSkew: 0.75, kickBack: -0.03,
    swingInset: 0.012, landVy: 0.15, pitchEase: 2.4, swingToe: deg(6),
    hips: (p) => ({
      // vertical: lowest just after heel strike (loading response), highest at mid-stance;
      // a touch of 1st harmonic keeps left/right steps from being mirror-perfect
      pos: V3(-0.020 * Math.cos(TAU * (p - 0.30)),
        0.905 + 0.019 * Math.cos(2 * TAU * (p - 0.31)) + 0.003 * Math.cos(TAU * (p - 0.2)),
        -0.009 * Math.cos(2 * TAU * (p - 0.30))),
      yaw: deg(-4) + deg(5.5) * Math.cos(TAU * (p - 0.02)), roll: -deg(4) * Math.cos(TAU * (p - 0.24)),
      pitch: deg(6) + deg(1.6) * Math.cos(2 * TAU * (p - 0.08)),
    }),
    lag: { freq: 3.6, zeta: 0.42, gain: 0.6 },
    lagX: { freq: 2.6, zeta: 0.5, gain: 0.5 },
  },
  run: {
    T: 0.68, v: 3.2, stance: 0.34, heelRock: 0.05, heelOff: 0.14, zHS: 0.23, footX: 0.075, toeOut: deg(5),
    hsPitch: deg(10), toePitch: deg(40), heelRisePow: 1.3, lift: 0.28, liftSkew: 0.55, kickBack: -0.20,
    swingInset: 0.008, landVy: 0.55, pitchEase: 2.0, swingPitchBias: deg(-8), swingToe: deg(4),
    hips: (p) => ({
      pos: V3(-0.010 * Math.cos(TAU * (p - 0.17)), 0.905 - 0.032 * Math.cos(2 * TAU * (p - 0.17)), -0.012 * Math.cos(2 * TAU * (p - 0.17))),
      yaw: deg(-5) + deg(7) * Math.cos(TAU * p), roll: -deg(4) * Math.cos(TAU * (p - 0.17)),
      pitch: deg(10) + deg(2) * Math.cos(2 * TAU * (p - 0.2)),
    }),
    lag: { freq: 4.8, zeta: 0.45, gain: 0.45 },
  },
  adsWalk: {
    T: 1.20, v: 0.9, stance: 0.64, heelRock: 0.12, heelOff: 0.42, zHS: 0.25, footX: 0.12, toeOut: deg(10),
    hsPitch: deg(12), toePitch: deg(28), heelRisePow: 1.6, lift: 0.06, liftSkew: 0.8, kickBack: -0.02,
    swingInset: 0.01, landVy: 0.1, pitchEase: 2.4, swingToe: deg(4),
    hips: (p) => ({
      pos: V3(-0.012 * Math.cos(TAU * (p - 0.30)), 0.875 + 0.006 * Math.cos(2 * TAU * (p - 0.32)), -0.004 * Math.cos(2 * TAU * (p - 0.3))),
      yaw: deg(-16) + deg(4) * Math.cos(TAU * p), roll: -deg(2.5) * Math.cos(TAU * (p - 0.25)),
      pitch: deg(9) + deg(0.8) * Math.cos(2 * TAU * (p - 0.1)),
    }),
    lag: { freq: 5.5, zeta: 0.7, gain: 0.12 },
  },
  crouchWalk: {
    T: 1.24, v: 0.85, stance: 0.66, heelRock: 0.10, heelOff: 0.42, zHS: 0.30, footX: 0.14, toeOut: deg(12),
    hsPitch: deg(10), toePitch: deg(32), heelRisePow: 1.5, lift: 0.08, liftSkew: 0.7, kickBack: -0.02,
    swingInset: 0.015, landVy: 0.12, pitchEase: 2.2, swingToe: deg(5),
    hips: (p) => ({
      pos: V3(-0.022 * Math.cos(TAU * (p - 0.30)), 0.64 + 0.014 * Math.cos(2 * TAU * (p - 0.31)), -0.01 - 0.008 * Math.cos(2 * TAU * (p - 0.3))),
      yaw: deg(-10) + deg(6) * Math.cos(TAU * p), roll: -deg(4.5) * Math.cos(TAU * (p - 0.24)),
      pitch: deg(24) + deg(1.5) * Math.cos(2 * TAU * (p - 0.1)),
    }),
    lag: { freq: 3.8, zeta: 0.5, gain: 0.45 },
    lagX: { freq: 2.6, zeta: 0.5, gain: 0.4 },
  },
};
for (const g of Object.values(GAITS)) g.L = g.v * g.T;

function hipsReachBound(hipsPos, hipsQ, feet) {
  let bound = Infinity;
  for (const s of ['Left', 'Right']) {
    const o = BIND_LOCAL[`${s}UpLeg`].clone().applyQuaternion(hipsQ);
    const a = feet[s].pos;
    const dx = hipsPos.x + o.x - a.x, dz = hipsPos.z + o.z - a.z;
    const d2 = dx * dx + dz * dz;
    const b = a.y - o.y + Math.sqrt(Math.max(0, LEG_R * LEG_R - d2));
    bound = Math.min(bound, b);
  }
  return bound;
}

/**
 * In-place locomotion cycle. upper(p, hips) returns {st, headWorld?} for the upper body.
 */
function locomotion(name, g, upper, meta = {}) {
  const N = Math.round(g.T * FPS);
  const rows = [];
  for (let i = 0; i < N; i++) {
    const p = i / N;
    const R = gaitFoot(p, g, -1), L = gaitFoot(p + 0.5, g, 1);
    const h = g.hips(p);
    const quat = qEuler(h.pitch, h.yaw, h.roll);
    rows.push({ p, feet: { Left: L, Right: R }, h, quat, y: h.pos.y });
  }
  // keep the legs within reach (slight knee bend everywhere), then smooth periodically
  let ys = rows.map((r) => Math.min(r.y, hipsReachBound(r.h.pos, r.quat, r.feet)));
  ys = periodicSmooth(ys, 1.5);
  ys = ys.map((y, i) => Math.min(y, hipsReachBound(rows[i].h.pos, rows[i].quat, rows[i].feet) + 0.002));
  ys = periodicSmooth(ys, 0.8);
  const acc = secondDerivative(ys, DT, true);
  const lag = periodicSpring(acc, DT, g.lag.freq, g.lag.zeta).map((x) => x * g.lag.gain);
  let lagX = rows.map(() => 0);
  if (g.lagX) {
    const ax = secondDerivative(rows.map((r) => r.h.pos.x), DT, true);
    lagX = periodicSpring(ax, DT, g.lagX.freq, g.lagX.zeta).map((x) => x * g.lagX.gain);
  }

  const frames = rows.map((r, i) => {
    const u = upper(r.p, r.h);
    const st = derive(u.st, { hipsPos: V3(r.h.pos.x, ys[i], r.h.pos.z), hipsQ: r.quat });
    const kneePole = {
      Left: V3(0, 0, 1).applyQuaternion(r.feet.Left.quat).add(V3(0.12, 0, 0)).normalize(),
      Right: V3(0, 0, 1).applyQuaternion(r.feet.Right.quat).add(V3(-0.12, 0, 0)).normalize(),
    };
    const spec = specFrom(st, { feet: r.feet, kneePole, lag: lag[i], lagX: lagX[i], headWorld: u.headWorld, trigger: u.trigger });
    spec.planted = { Left: r.feet.Left.planted, Right: r.feet.Right.planted };
    return spec;
  });
  frames.push(frames[0]); // closed loop: last key == first key
  return { name, duration: g.T, loop: true, speed: g.v, frames, ...meta };
}

// ------------------------------------------------------------------ standing loops
function breathing(t, period = 4.0) { return Math.sin((TAU * t) / period); }

function standingLoop(name, base, duration, fn, meta = {}) {
  const N = Math.round(duration * FPS);
  const frames = [];
  for (let i = 0; i <= N; i++) {
    const t = (i % N) * DT;
    frames.push(fn(t, base));
  }
  return { name, duration, loop: true, speed: 0, frames, ...meta };
}

function idleLike(st, amp) {
  return (t) => {
    const b = breathing(t);
    const sway = Math.sin(TAU * t / 4 + 1.1);
    const s = derive(st, {
      hipsPos: st.hipsPos.clone().add(V3(0.010 * amp.sway * sway, 0.002 * amp.breath * b, 0)),
      hipsQ: st.hipsQ.clone().multiply(qEuler(0, 0, deg(0.8) * amp.sway * sway)),
      chestQ: st.chestQ.clone().multiply(qEuler(-deg(0.7) * amp.breath * b, deg(0.3) * amp.sway * sway, -deg(0.6) * amp.sway * sway)),
      clavicle: {
        Left: st.clavicle.Left.clone().multiply(qEuler(0, 0, deg(1.0) * amp.breath * b)),
        Right: st.clavicle.Right.clone().multiply(qEuler(0, 0, -deg(1.0) * amp.breath * b)),
      },
    });
    if (amp.look) {
      // slow scan: hold, glance left, hold, glance back (smooth, loopable)
      const ph = (t / 4) % 1;
      const look = smoother((ph - 0.15) / 0.2) - smoother((ph - 0.6) / 0.25);
      s.headLocal = st.headLocal.clone().multiply(qEuler(deg(-2) * look, deg(14) * look, 0));
    }
    return specFrom(s);
  };
}

function staticPose(name, st) {
  const f = specFrom(st);
  return { name, duration: 1 / FPS, loop: true, speed: 0, frames: [f, f], pose: true };
}

// ------------------------------------------------------------------ firing
/** periodic recoil sum for automatic fire (period P) */
function autoRecoil(fn, t, P) { let s = 0; for (let n = 0; n < 12; n++) s += fn((t % P) + n * P); return s; }

function firingKick(R, B, cfg) {
  return {
    kick: { rot: qEuler(-deg(cfg.climb) * R, deg(cfg.yaw) * R, deg(cfg.roll) * R), back: cfg.back * R },
    chest: qEuler(-deg(cfg.chest) * B, -deg(cfg.chestYaw) * B, 0),
    hipsBack: cfg.hips * B,
  };
}
const ADS_RECOIL = { climb: 2.2, yaw: 0.35, roll: 0.5, back: 0.020, chest: 1.3, chestYaw: 0.7, hips: 0.006 };
const HIP_RECOIL = { climb: 4.5, yaw: 0.8, roll: 1.2, back: 0.030, chest: 1.6, chestYaw: 1.0, hips: 0.008 };

function fireFrame(st, R, B, cfg, trig) {
  const k = firingKick(R, B, cfg);
  const s = derive(st, {
    chestQ: st.chestQ.clone().multiply(k.chest),
    hipsPos: st.hipsPos.clone().add(V3(0, 0, -k.hipsBack)),
    clavicle: { Left: st.clavicle.Left, Right: st.clavicle.Right.clone().multiply(qEuler(0, -deg(3) * B, 0)) },
    neckLocal: st.neckLocal.clone().multiply(qEuler(-deg(0.4) * B, 0, 0)),
  });
  return specFrom(s, { kick: k.kick, trigger: trig });
}

function singleShot(name, st, cfg, duration = 0.5, shotT = 0.06) {
  const N = Math.round(duration * FPS), frames = [];
  for (let i = 0; i <= N; i++) {
    const t = i * DT;
    const R = RECOIL_FAST(t - shotT), B = RECOIL_BODY(t - shotT - 0.008);
    // trigger: press (1->2) just before the shot, release ~0.12 s later
    const trig = 1 + smooth((t - (shotT - 0.05)) / 0.05) - smooth((t - (shotT + 0.08)) / 0.08);
    frames.push(fireFrame(st, R, B, cfg, trig));
  }
  return { name, duration, loop: false, speed: 0, frames, shots: [shotT] };
}

function autoFire(name, st, cfg, rpm = 700, shots = 7) {
  const P = 60 / rpm, duration = P * shots;
  const N = Math.round(duration * FPS), frames = [];
  for (let i = 0; i <= N; i++) {
    const t = (i % N) * duration / N;
    const R = autoRecoil(RECOIL_FAST, t, P), B = autoRecoil(RECOIL_BODY, t + P - 0.008, P);
    frames.push(fireFrame(st, R * 0.75, B * 0.55, cfg, 2));
  }
  return { name, duration, loop: true, speed: 0, frames, shots: Array.from({ length: shots }, (_, k) => k * P), rpm };
}

// ------------------------------------------------------------------ transitions
function transition(name, a, b, duration, arc = null, meta = {}) {
  const N = Math.round(duration * FPS), frames = [];
  for (let i = 0; i <= N; i++) {
    const u = i / N;
    const t = smoother(u);
    const st = blendStance(a, b, t, arc);
    // finger leaves the trigger while the weapon moves (trigger discipline)
    const trig = a.trigger * (1 - smooth(u / 0.25)) + b.trigger * smooth((u - 0.7) / 0.3);
    frames.push(specFrom(st, { trigger: trig }));
  }
  return { name, duration, loop: false, speed: 0, frames, ...meta };
}

// ------------------------------------------------------------------ jump
/**
 * Standing jump with rifle: anticipation crouch, explosive extension with heel rise,
 * ballistic flight (g = 9.81), knee tuck, toe-first landing and absorption.
 */
function jumpTimeline() {
  const st = STANCES.lowReady;
  const T = { crouch0: 0.10, crouch1: 0.40, take: 0.62, land: 1.12, low: 1.32, end: 1.85 };
  const flight = T.land - T.take;
  const v0 = (G * flight) / 2;           // take-off velocity for symmetric flight
  const yTake = 1.00, yLow = 0.73, yLand = 0.74, yStand = st.hipsPos.y;
  const hipsY = (t) => {
    if (t < T.crouch0) return yStand;
    if (t < T.crouch1) return hermite(yStand, 0, yLow, 0, T.crouch1 - T.crouch0, (t - T.crouch0) / (T.crouch1 - T.crouch0));
    if (t < T.take) return hermite(yLow, 0, yTake, v0, T.take - T.crouch1, (t - T.crouch1) / (T.take - T.crouch1));
    if (t < T.land) { const tau = t - T.take; return yTake + v0 * tau - 0.5 * G * tau * tau; }
    if (t < T.low) return hermite(yTake, -v0, yLand, 0, T.low - T.land, (t - T.land) / (T.low - T.land));
    return hermite(yLand, 0, yStand, 0, T.end - T.low, Math.min(1, (t - T.low) / (T.end - T.low)));
  };
  // body lean / crouch amount 0..1
  const crouch = (t) => {
    if (t < T.crouch0) return 0;
    if (t < T.take) return smooth((t - T.crouch0) / (T.crouch1 - T.crouch0)) * (1 - smooth((t - T.crouch1 - 0.06) / (T.take - T.crouch1 - 0.06)));
    if (t < T.land) return 0.15 * Math.sin(Math.PI * (t - T.take) / flight);
    if (t < T.low) return smooth((t - T.land) / (T.low - T.land)) * 0.9;
    return 0.9 * (1 - smoother((t - T.low) / (T.end - T.low)));
  };
  // heel rise (push-off) and landing toe-first: foot pitch (negative = heel up)
  const footPitch = (t) => {
    if (t < T.crouch1 + 0.08) return 0;
    if (t < T.take) return -deg(38) * smooth((t - T.crouch1 - 0.08) / (T.take - T.crouch1 - 0.08));
    if (t < T.land) { const u = (t - T.take) / flight; return lerp(-deg(38), -deg(20), smooth(u)) + deg(12) * Math.sin(Math.PI * u); }
    return -deg(20) * (1 - smooth((t - T.land) / 0.08));
  };
  return { T, v0, hipsY, crouch, footPitch, flight, yTake };
}

function groundFoot(side, pitch) {
  const f = COMBAT_FEET[side];
  // ball contact point on the ground for this stance foot
  const ball = BALL_LOCAL.clone().applyQuaternion(f.quat).add(f.pos);
  const e = new THREE.Euler().setFromQuaternion(f.quat, 'YXZ');
  const fp = footFromPivot(ball, BALL_LOCAL, pitch, e.y);
  return { pos: fp.pos, quat: fp.quat, toe: Math.max(0, -pitch) * 0.9 };
}

function jumpFrame(t, J, ext = {}) {
  const st = STANCES.lowReady;
  const c = J.crouch(t);
  const y = ext.hipsY !== undefined ? ext.hipsY : J.hipsY(t);
  const fp = J.footPitch(t);
  const feet = {};
  const inAir = ext.inAir ?? (t > J.T.take && t < J.T.land);
  for (const s of ['Left', 'Right']) {
    if (!inAir) feet[s] = groundFoot(s, fp);
    else {
      // legs follow the pelvis: interpolate take-off -> landing leg extension, plus knee tuck
      const u = ext.u ?? (t - J.T.take) / J.flight;
      const g0 = groundFoot(s, -deg(38)), g1 = groundFoot(s, -deg(20));
      const d0 = g0.pos.y - J.yTake, d1 = g1.pos.y - J.yTake;
      const tuck = (ext.tuck ?? 0.24) * Math.pow(Math.sin(Math.PI * u), 1.3);
      const pos = g0.pos.clone().lerp(g1.pos, u);
      pos.y = y + lerp(d0, d1, u) + tuck;
      pos.z += 0.05 * Math.sin(Math.PI * u) * (s === 'Left' ? 1 : 0.6);
      const e = new THREE.Euler().setFromQuaternion(COMBAT_FEET[s].quat, 'YXZ');
      feet[s] = { pos, quat: footQuat(fp, e.y), toe: deg(6) };
    }
  }
  const s = derive(st, {
    hipsPos: V3(st.hipsPos.x, y, st.hipsPos.z + 0.04 * c),
    hipsQ: st.hipsQ.clone().multiply(qEuler(deg(20) * c, 0, 0)),
    chestQ: st.chestQ.clone().premultiply(qEuler(deg(22) * c, 0, 0)),
    clavicle: {
      Left: st.clavicle.Left.clone().multiply(qEuler(0, 0, deg(4) * c)),
      Right: st.clavicle.Right.clone().multiply(qEuler(0, 0, -deg(4) * c)),
    },
  });
  return specFrom(s, { feet, lag: ext.lag || 0, headWorld: qEuler(deg(6) - deg(10) * c, deg(2), 0) });
}

function jumpClips() {
  const J = jumpTimeline();
  const N = Math.round(J.T.end * FPS);
  const ys = [];
  for (let i = 0; i <= N; i++) ys.push(J.hipsY(i * DT));
  const acc = secondDerivative(ys, DT, false).map((a, i) => {
    const t = i * DT; return t > J.T.take && t < J.T.land ? a + G : a; // weapon is also in free fall
  });
  const lag = oneShotSpring(acc, DT, 4.5, 0.5).map((x) => Math.max(-0.03, Math.min(0.03, x * 0.5)));
  const full = [];
  for (let i = 0; i <= N; i++) full.push(jumpFrame(i * DT, J, { lag: lag[i] }));
  const iTake = Math.round(J.T.take * FPS), iLand = Math.round(J.T.land * FPS);
  const clips = [
    { name: 'Jump', duration: J.T.end, loop: false, speed: 0, frames: full, events: { takeoff: J.T.take, land: J.T.land } },
    { name: 'Jump_Start', duration: iTake * DT, loop: false, speed: 0, frames: full.slice(0, iTake + 1) },
    { name: 'Jump_Land', duration: (N - iLand) * DT, loop: false, speed: 0, frames: full.slice(iLand) },
  ];
  // Jump_Air: in-place airborne loop (pelvis held at take-off height, legs tucked, gentle drift)
  const D = 0.8, NA = Math.round(D * FPS), air = [];
  for (let i = 0; i <= NA; i++) {
    const t = (i % NA) * DT;
    const w = Math.sin(TAU * t / D);
    air.push(jumpFrame(0, J, { hipsY: J.yTake, inAir: true, u: 0.5 + 0.06 * w, tuck: 0.2 + 0.02 * w, lag: 0.004 * w }));
  }
  clips.push({ name: 'Jump_Air', duration: D, loop: true, speed: 0, frames: air });
  return clips;
}

// ------------------------------------------------------------------ natural upper body
/**
 * Upper body for carry-mode locomotion. Instead of a rigidly stabilised 'turret' the
 * thorax counter-rotates against the pelvis, leans into the weight transfer, dips on
 * each loading response, the shoulders bounce slightly after each footfall and the
 * head nods a little and settles (gaze stabilisation is good but not perfect).
 */
function lively(base, c) {
  const ph = c.phase || 0;
  return (p, h) => {
    const q = p - ph;
    const chestQ = qEuler(
      deg(c.pitch) + deg(c.pitchAmp) * Math.cos(2 * TAU * (q - 0.12)),
      deg(c.yaw) - c.counter * (h.yaw - deg(c.pelvisYaw0)),
      deg(c.roll) - 0.35 * h.roll + deg(c.rollAmp) * Math.cos(TAU * (q - 0.36)),
    );
    const e = deg(c.clavAmp) * Math.cos(2 * TAU * (q - 0.2));
    const st = derive(base, {
      chestQ,
      clavicle: {
        Left: base.clavicle.Left.clone().multiply(qEuler(0, 0, -e)),
        Right: base.clavicle.Right.clone().multiply(qEuler(0, 0, e)),
      },
    });
    const headWorld = qEuler(
      deg(c.headPitch) + deg(c.headAmp) * Math.cos(2 * TAU * (q - 0.17)),
      deg(-1) + deg(1.4) * Math.sin(TAU * (q - 0.05)),
      deg(0.9) * Math.sin(TAU * (q - 0.25)),
    );
    return { st, headWorld };
  };
}

// ------------------------------------------------------------------ key-framed transitions
const qlog = (q) => {
  const sg = q.w < 0 ? -1 : 1;
  const w = Math.min(1, Math.abs(q.w)), sn = Math.sqrt(Math.max(0, 1 - w * w));
  if (sn < 1e-8) return V3(0, 0, 0);
  return V3(q.x * sg, q.y * sg, q.z * sg).multiplyScalar((2 * Math.acos(w)) / sn);
};
const qexp = (v) => {
  const a = v.length();
  return a < 1e-9 ? new THREE.Quaternion() : new THREE.Quaternion().setFromAxisAngle(v.clone().divideScalar(a), a);
};
/** C1 cardinal (Hermite) interpolation of vectors through keys at times ts; ends have zero velocity. */
function hermiteKeys(ts, vs, t, tension = 0.85) {
  let i = 0;
  while (i < ts.length - 2 && t > ts[i + 1]) i++;
  const t0 = ts[i], t1 = ts[i + 1], h = t1 - t0;
  const u = Math.min(1, Math.max(0, (t - t0) / h));
  const tan = (k) => (k <= 0 || k >= ts.length - 1 ? V3() : vs[k + 1].clone().sub(vs[k - 1]).divideScalar(ts[k + 1] - ts[k - 1]).multiplyScalar(tension));
  const m0 = tan(i), m1 = tan(i + 1);
  const u2 = u * u, u3 = u2 * u;
  return vs[i].clone().multiplyScalar(2 * u3 - 3 * u2 + 1).addScaledVector(m0, (u3 - 2 * u2 + u) * h)
    .addScaledVector(vs[i + 1], -2 * u3 + 3 * u2).addScaledVector(m1, (u3 - u2) * h);
}
function hermiteQuats(ts, qs, t) {
  const ref = qs[0].clone(), inv = ref.clone().invert();
  const logs = qs.map((q) => qlog(inv.clone().multiply(q)));
  return ref.multiply(qexp(hermiteKeys(ts, logs, t)));
}

/**
 * Multi-key transition: body, feet and head flow smoothly through every key (C1, no
 * stops at intermediate keys); the rifle blends between the carry modes of adjacent keys.
 */
function keyClip(name, keys, meta = {}) {
  const ts = keys.map((k) => k.t), S = keys.map((k) => k.st);
  const duration = ts[ts.length - 1];
  const N = Math.round(duration * FPS), frames = [];
  const P = (f) => S.map(f);
  for (let n = 0; n <= N; n++) {
    const t = (n / N) * duration;
    let i = 0; while (i < ts.length - 2 && t > ts[i + 1]) i++;
    const u = smoother((t - ts[i]) / (ts[i + 1] - ts[i]));
    const a = S[i], b = S[i + 1];
    const feet = {}, kneePole = {}, clavicle = {}, elbowPole = {};
    for (const s of ['Left', 'Right']) {
      feet[s] = {
        pos: hermiteKeys(ts, P((k) => (k.feet || COMBAT_FEET)[s].pos), t),
        quat: hermiteQuats(ts, P((k) => (k.feet || COMBAT_FEET)[s].quat), t),
        toe: lerp((a.feet || COMBAT_FEET)[s].toe || 0, (b.feet || COMBAT_FEET)[s].toe || 0, u),
      };
      kneePole[s] = hermiteKeys(ts, P((k) => (k.kneePole || STAND_KNEES)[s]), t).normalize();
      clavicle[s] = hermiteQuats(ts, P((k) => k.clavicle[s]), t);
      elbowPole[s] = a.elbowPole[s].clone().lerp(b.elbowPole[s], u);
    }
    const st = {
      hipsPos: hermiteKeys(ts, P((k) => k.hipsPos), t),
      hipsQ: hermiteQuats(ts, P((k) => k.hipsQ), t),
      chestQ: hermiteQuats(ts, P((k) => k.chestQ), t),
      neckLocal: hermiteQuats(ts, P((k) => k.neckLocal), t),
      headLocal: hermiteQuats(ts, P((k) => k.headLocal), t),
      clavicle, elbowPole,
      leftGrip: { pos: a.leftGrip.pos.clone().lerp(b.leftGrip.pos, u), quat: a.leftGrip.quat.clone().slerp(b.leftGrip.quat, u) },
      trigger: Math.min(a.trigger, b.trigger) * (u < 0.5 ? a.trigger : b.trigger),
      modeA: a.mode, modeB: b.mode, modeT: u, arc: a.arc || null,
    };
    frames.push(specFrom(st, { feet, kneePole }));
  }
  return { name, duration, loop: false, speed: 0, frames, ...meta };
}

// ------------------------------------------------------------------ crawl
/**
 * High crawl (FM 3-21.75): body off the ground, weight on the forearms and lower legs,
 * rifle cradled in the arms with the muzzle off the ground. Right elbow advances with the
 * left knee, then left elbow with right knee. Forearms and shins are planted contacts that
 * move backward at exactly the crawl speed (in place), so nothing slides.
 */
function crawlClip(PR) {
  const T = 1.6, v = 0.22, L = v * T, PL = 0.7;
  const N = Math.round(T * FPS);
  const limb = (phase, x, z0, y0, lift) => (p) => {
    p = ((p - phase) % 1 + 1) % 1;
    if (p < PL) return { pos: V3(x, y0, z0 - L * p), planted: true };
    const u = (p - PL) / (1 - PL);
    return { pos: V3(x, y0 + lift * Math.pow(Math.sin(Math.PI * u), 1.2), lerp(z0 - L * PL, z0, smoother(u))), planted: false };
  };
  const elbowR = limb(0.0, -0.20, 0.14, 0.045, 0.07), elbowL = limb(0.5, 0.20, 0.14, 0.045, 0.07);
  const ankleL = limb(0.02, 0.17, -0.97, 0.075, 0.09), ankleR = limb(0.52, -0.17, -0.97, 0.075, 0.09);
  const shoeQ = footBasis(V3(0, -0.3, -1), V3(0, -1, 0.3));
  const base = derive(PR, {
    clavicle: { Left: clav('Left', 8, 28), Right: clav('Right', 8, 12) },
  });
  const frames = [];
  const kneeH = (hipsPos, hipsQ, s, ankle, pole) => {
    const j = BIND_LOCAL[`${s}UpLeg`].clone().applyQuaternion(hipsQ).add(hipsPos);
    const d = j.distanceTo(ankle), l1 = LEG_UPPER, l2 = LEG_LOWER;
    if (d >= l1 + l2) return j.y + (ankle.y - j.y) * (l1 / (l1 + l2));
    const dn = ankle.clone().sub(j).normalize();
    const a = (l1 * l1 + d * d - l2 * l2) / (2 * d), h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
    const pp = pole.clone().addScaledVector(dn, -pole.dot(dn)).normalize();
    return j.y + dn.y * a + pp.y * h;
  };
  for (let n = 0; n <= N; n++) {
    const p = (n % N) / N;
    const ER = elbowR(p), EL = elbowL(p), AL = ankleL(p), AR = ankleR(p);
    const hipsQ = qEuler(deg(84), deg(6) * Math.sin(TAU * p), deg(5) * Math.sin(TAU * (p - 0.1)));
    const kneePole = { Left: V3(0.25, -1, 0.15).normalize(), Right: V3(-0.25, -1, 0.15).normalize() };
    // pelvis height: planted shins keep their knees on the ground (~6.5 cm); a swinging
    // knee must clear it. Knee height falls monotonically as the pelvis lowers.
    const hx = 0.0, hz = -0.56 + 0.02 * Math.cos(2 * TAU * p);
    const solveY = (s, ankle, target) => {
      let lo = 0.10, hi = 0.60;
      for (let it = 0; it < 30; it++) {
        const y = (lo + hi) / 2;
        if (kneeH(V3(hx, y, hz), hipsQ, s, ankle, kneePole[s]) > target) hi = y; else lo = y;
      }
      return (lo + hi) / 2;
    };
    const yL = solveY('Left', AL.pos, AL.planted ? 0.065 : 0.085);
    const yR = solveY('Right', AR.pos, AR.planted ? 0.065 : 0.085);
    const hy = Math.max(yL, yR);
    // chest pitch chosen so the shoulders sit one upper-arm length above the planted forearms
    let cLo = deg(80), cHi = deg(120), chestQ = null;
    for (let it = 0; it < 18; it++) {
      const cp = (cLo + cHi) / 2;
      chestQ = qEuler(cp, -deg(4) * Math.sin(TAU * p), -deg(7) * Math.sin(TAU * (p - 0.05)));
      const r = crawlSolver.solve(specFrom(derive(base, { hipsPos: V3(hx, hy, hz), hipsQ, chestQ }), { headWorld: qEuler(deg(22), 0, 0) }));
      const sh = (r.world.LeftArm.pos.y + r.world.RightArm.pos.y) / 2;
      if (sh > 0.33) cLo = cp; else cHi = cp;
    }
    const st = derive(base, { hipsPos: V3(hx, hy, hz), hipsQ, chestQ });
    const feet = {
      Left: { pos: AL.pos, quat: shoeQ.clone(), toe: deg(15) },
      Right: { pos: AR.pos, quat: shoeQ.clone(), toe: deg(15) },
    };
    const spec = specFrom(st, { feet, kneePole, headWorld: qEuler(deg(22), 0, 0), trigger: 0 });
    // rifle cradled across both forearms (roughly parallel to the shoulders, muzzle to the
    // left, lying on its side so the magazine clears the ground); it swings with the elbows
    const dR = V3(0.22, 0.12, 0.97).normalize(), dL = V3(-0.22, 0.12, 0.97).normalize();
    const hR = ER.pos.clone().addScaledVector(dR, 0.255), hL = EL.pos.clone().addScaledVector(dL, 0.255);
    const across = hL.clone().sub(hR);
    const yaw = deg(80) + 0.3 * (Math.atan2(across.x, across.z) - deg(90));
    const wq = qEuler(deg(4), yaw, deg(-75));
    spec.cradle = {
      elbow: { Left: EL.pos, Right: ER.pos },
      rightHand: { pos: hR, quat: wq.clone().multiply(GRIPS.right.quat) },
      leftGrip: (z) => leftGrip(z, 'cup'),
    };
    frames.push(spec);
  }
  return { name: 'Prone_Crawl', duration: T, loop: true, speed: v, frames };
}

// ------------------------------------------------------------------ library
export function buildClipLibrary() {
  calibrate();
  const LR = STANCES.lowReady, HIP = STANCES.hip, ADS = STANCES.ads;
  const clips = [];

  clips.push(standingLoop('Idle', LR, 4.0, idleLike(LR, { breath: 1, sway: 1, look: true })));
  clips.push(standingLoop('HipFire_Idle', HIP, 4.0, idleLike(HIP, { breath: 0.8, sway: 0.6 })));
  clips.push(standingLoop('ADS_Idle', ADS, 4.0, idleLike(ADS, { breath: 0.3, sway: 0.25 })));

  // Walking with the rifle at the low ready, upper body stabilised
  clips.push(locomotion('Walk', GAITS.walk, lively(LR, {
    pitch: 9, yaw: -12, roll: 1, pelvisYaw0: -4, counter: 0.45, pitchAmp: 1.1, rollAmp: 1.4, clavAmp: 1.6, headPitch: 6, headAmp: 1.3,
  })));

  // Running: compact carry, muzzle down-left, strong forward lean, thorax counter-rotation
  const RUN_ST = derive(LR, {
    mode: { ...LR.mode, rel: qEuler(deg(36), deg(28), deg(-20)), offset: V3(0.01, -0.035, 0.03) },
    clavicle: { Left: clav('Left', 3, 28), Right: clav('Right', 3, 4) },
    elbowPole: { Left: V3(0.25, -1, -0.35), Right: V3(-0.45, -1, -0.6) },
  });
  clips.push(locomotion('Run', GAITS.run, lively(RUN_ST, {
    pitch: 15, yaw: -13, roll: 1, pelvisYaw0: -5, counter: 0.6, pitchAmp: 1.8, rollAmp: 1.6, clavAmp: 2.5, headPitch: 3, headAmp: 1.8, phase: 0.06,
  })));

  // Aiming while walking: 'Groucho' heel-to-toe walk, chest world-locked, cheek weld kept
  clips.push(locomotion('ADS_Walk', GAITS.adsWalk, () => ({ st: ADS })));

  // Hip-fire posture while walking (stock clamped under the arm)
  clips.push(locomotion('HipFire_Walk', GAITS.adsWalk, () => ({ st: derive(HIP, { chestQ: qEuler(deg(14), deg(-15), deg(2)) }) })));

  // Static reference poses (also used as additive references for recoil layering)
  clips.push(staticPose('Idle_Pose', LR));
  clips.push(staticPose('HipFire_Pose', HIP));
  clips.push(staticPose('ADS_Pose', ADS));

  // Firing
  clips.push(singleShot('ADS_Fire', ADS, ADS_RECOIL));
  clips.push(autoFire('ADS_Fire_Auto', ADS, ADS_RECOIL));
  clips.push(singleShot('HipFire_Fire', HIP, HIP_RECOIL));
  clips.push(autoFire('HipFire_Fire_Auto', HIP, HIP_RECOIL));

  // Transitions between carry modes
  clips.push(transition('Idle_To_ADS', LR, ADS, 0.32));
  clips.push(transition('ADS_To_Idle', ADS, LR, 0.40));
  clips.push(transition('Idle_To_HipFire', LR, HIP, 0.30, V3(-0.05, 0.02, 0.04)));
  clips.push(transition('HipFire_To_Idle', HIP, LR, 0.35, V3(-0.05, 0.02, 0.04)));
  clips.push(transition('HipFire_To_ADS', HIP, ADS, 0.28, V3(-0.03, 0.02, 0.02)));
  clips.push(transition('ADS_To_HipFire', ADS, HIP, 0.28, V3(-0.03, 0.02, 0.02)));

  // ---------------------------------------------------------------- crouch
  const CR = STANCES.crouch, CRA = STANCES.crouchAds, PR = STANCES.prone;
  clips.push(standingLoop('Crouch_Idle', CR, 4.0, idleLike(CR, { breath: 1, sway: 0.6, look: true })));
  clips.push(locomotion('Crouch_Walk', GAITS.crouchWalk, lively(derive(CR, { feet: undefined }), {
    pitch: 24, yaw: -11, roll: 1, pelvisYaw0: -10, counter: 0.45, pitchAmp: 1.2, rollAmp: 1.5, clavAmp: 1.5, headPitch: 2, headAmp: 1.2,
  })));
  clips.push(standingLoop('Crouch_ADS_Idle', CRA, 4.0, idleLike(CRA, { breath: 0.3, sway: 0.2 })));
  clips.push(locomotion('Crouch_ADS_Walk', GAITS.crouchWalk, () => ({ st: derive(CRA, { feet: undefined }) })));
  clips.push(singleShot('Crouch_ADS_Fire', CRA, ADS_RECOIL));
  clips.push(autoFire('Crouch_ADS_Fire_Auto', CRA, ADS_RECOIL));
  clips.push(staticPose('Crouch_Pose', CR));
  clips.push(staticPose('Crouch_ADS_Pose', CRA));
  clips.push(transition('Stand_To_Crouch', LR, CR, 0.45));
  clips.push(transition('Crouch_To_Stand', CR, LR, 0.50));
  clips.push(transition('Crouch_To_Crouch_ADS', CR, CRA, 0.32));
  clips.push(transition('Crouch_ADS_To_Crouch', CRA, CR, 0.40));

  // ---------------------------------------------------------------- prone
  const PRONE_RECOIL = { climb: 1.4, yaw: 0.3, roll: 0.3, back: 0.014, chest: 0.6, chestYaw: 0.4, hips: 0.003 };
  clips.push(standingLoop('Prone_Idle', PR, 4.0, idleLike(PR, { breath: 0.45, sway: 0 })));
  clips.push(singleShot('Prone_Fire', PR, PRONE_RECOIL));
  clips.push(autoFire('Prone_Fire_Auto', PR, PRONE_RECOIL));
  clips.push(staticPose('Prone_Pose', PR));
  clips.push(crawlClip(PR));
  // getting down: crouch -> both knees -> fall forward onto the forearms -> legs back -> aim
  const KNEEL = derive(CR, {
    hipsPos: V3(-0.02, 0.50, -0.06), hipsQ: qEuler(deg(6), deg(-10), 0), chestQ: qEuler(deg(26), deg(-10), 0),
    feet: {
      Left: { pos: V3(0.12, 0.165, -0.44), quat: footBasis(V3(0, -1, 0.12), V3(0, 0.12, 1)), toe: deg(40) },
      Right: { pos: V3(-0.14, 0.165, -0.46), quat: footBasis(V3(0, -1, 0.12), V3(0, 0.12, 1)), toe: deg(40) },
    },
    kneePole: { Left: V3(0.1, -0.6, 1).normalize(), Right: V3(-0.1, -0.6, 1).normalize() },
  });
  const DOWN = derive(PR, {
    hipsPos: V3(0.0, 0.36, -0.30), hipsQ: qEuler(deg(48), deg(-12), 0), chestQ: qEuler(deg(66), deg(-10), deg(1)),
    feet: { Left: { ...KNEEL.feet.Left, pos: KNEEL.feet.Left.pos.clone().add(V3(0.02, 0, -0.08)) }, Right: { ...KNEEL.feet.Right, pos: KNEEL.feet.Right.pos.clone().add(V3(-0.02, 0, -0.08)) } },
    kneePole: { Left: V3(0.15, -1, 0.5).normalize(), Right: V3(-0.15, -1, 0.5).normalize() },
    trigger: 0,
  });
  const LIE = derive(PR, {
    hipsPos: V3(0.04, 0.19, -0.48), hipsQ: qEuler(deg(80), deg(-13), deg(2)), chestQ: qEuler(deg(57), deg(-9), deg(2)), trigger: 0,
    feet: { Left: { ...PR.feet.Left, pos: PR.feet.Left.pos.clone().add(V3(-0.02, 0.01, 0.10)) }, Right: { ...PR.feet.Right, pos: PR.feet.Right.pos.clone().add(V3(0.03, 0.01, 0.10)) } },
  });
  clips.push(keyClip('Stand_To_Prone', [
    { t: 0, st: LR }, { t: 0.30, st: CR }, { t: 0.62, st: KNEEL }, { t: 1.0, st: DOWN }, { t: 1.36, st: LIE }, { t: 1.75, st: PR },
  ]));
  clips.push(keyClip('Prone_To_Stand', [
    { t: 0, st: PR }, { t: 0.35, st: LIE }, { t: 0.75, st: DOWN }, { t: 1.15, st: KNEEL }, { t: 1.5, st: CR }, { t: 1.9, st: LR },
  ]));

  clips.push(...jumpClips());
  return clips;
}
