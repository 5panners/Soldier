// Clip library. Each clip is a list of PoseSolver specs sampled at FPS.
// Locomotion is IN-PLACE (the ground moves under the character at `speed` m/s);
// vertical motion (bob, jump) is baked into the Hips track.

import * as THREE from 'three';
import { V3, qEuler, deg } from './solver.js';
import { BIND_LOCAL, LEG_UPPER, LEG_LOWER } from './skeleton.js';
import {
  STANCES, COMBAT_FEET, GRIPS, FINGERS_L, calibrate, gaitFoot, footFromPivot, footQuat, BALL_LOCAL,
  placeWeapon, rightFingers, periodicSpring, oneShotSpring, secondDerivative, periodicSmooth,
  RECOIL_FAST, RECOIL_BODY, smooth, smoother, hermite, lerp, TAU, G, clav,
} from './motion.js';

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
  };
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
  return w;
}

/** Stance (+ options) -> PoseSolver spec */
export function specFrom(st, o = {}) {
  const chestQ = st.chestQ;
  const spec = {
    hips: { pos: st.hipsPos.clone(), quat: st.hipsQ.clone() },
    chest: chestQ.clone(),
    spineDist: [0.27, 0.34, 0.39],
    feet: o.feet || cloneFeet(COMBAT_FEET),
    kneePole: o.kneePole || STAND_KNEES,
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
      pos: V3(-0.018 * Math.cos(TAU * (p - 0.30)), 0.925 + 0.016 * Math.cos(2 * TAU * (p - 0.32)), -0.008 * Math.cos(2 * TAU * (p - 0.30))),
      yaw: deg(-4) + deg(5) * Math.cos(TAU * p), roll: -deg(3.5) * Math.cos(TAU * (p - 0.25)),
      pitch: deg(5) + deg(1.2) * Math.cos(2 * TAU * (p - 0.1)),
    }),
    lag: { freq: 4.2, zeta: 0.5, gain: 0.55 },
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

  const frames = rows.map((r, i) => {
    const u = upper(r.p, r.h);
    const st = derive(u.st, { hipsPos: V3(r.h.pos.x, ys[i], r.h.pos.z), hipsQ: r.quat });
    const kneePole = {
      Left: V3(0, 0, 1).applyQuaternion(r.feet.Left.quat).add(V3(0.12, 0, 0)).normalize(),
      Right: V3(0, 0, 1).applyQuaternion(r.feet.Right.quat).add(V3(-0.12, 0, 0)).normalize(),
    };
    const spec = specFrom(st, { feet: r.feet, kneePole, lag: lag[i], headWorld: u.headWorld, trigger: u.trigger });
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

// ------------------------------------------------------------------ library
export function buildClipLibrary() {
  calibrate();
  const LR = STANCES.lowReady, HIP = STANCES.hip, ADS = STANCES.ads;
  const clips = [];

  clips.push(standingLoop('Idle', LR, 4.0, idleLike(LR, { breath: 1, sway: 1, look: true })));
  clips.push(standingLoop('HipFire_Idle', HIP, 4.0, idleLike(HIP, { breath: 0.8, sway: 0.6 })));
  clips.push(standingLoop('ADS_Idle', ADS, 4.0, idleLike(ADS, { breath: 0.3, sway: 0.25 })));

  // Walking with the rifle at the low ready, upper body stabilised
  clips.push(locomotion('Walk', GAITS.walk, (p, h) => ({
    st: derive(LR, {
      chestQ: qEuler(deg(9) + deg(0.6) * Math.cos(2 * TAU * (p - 0.3)), deg(-12) - 0.15 * (h.yaw - deg(-4)), deg(1) - 0.3 * h.roll),
    }),
    headWorld: qEuler(deg(6), deg(-1), 0),
  })));

  // Running: compact carry, muzzle down-left, strong forward lean, thorax counter-rotation
  const RUN_ST = derive(LR, {
    mode: { ...LR.mode, rel: qEuler(deg(36), deg(28), deg(-20)), offset: V3(0.01, -0.035, 0.03) },
    clavicle: { Left: clav('Left', 3, 20), Right: clav('Right', 3, 4) },
    elbowPole: { Left: V3(0.25, -1, -0.35), Right: V3(-0.45, -1, -0.6) },
  });
  clips.push(locomotion('Run', GAITS.run, (p, h) => ({
    st: derive(RUN_ST, {
      chestQ: qEuler(deg(15) + deg(1.2) * Math.cos(2 * TAU * (p - 0.2)), deg(-13) - 0.35 * (h.yaw - deg(-5)), deg(1) - 0.3 * h.roll),
    }),
    headWorld: qEuler(deg(3), deg(-1), 0),
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

  clips.push(...jumpClips());
  return clips;
}
