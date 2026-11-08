// Full-body pose solver: turns a high-level pose description (pelvis, chest and
// head orientation, foot placements, weapon placement) into local bone rotations,
// using analytic two-bone IK for legs and arms so feet stay planted and both hands
// stay locked to the weapon.

import * as THREE from 'three';
import { BONE_DEFS, BIND_LOCAL, PARENT } from './skeleton.js';

const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3();
const ID = new THREE.Quaternion();

export const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
export const Q = () => new THREE.Quaternion();
/** Euler (radians) -> quaternion. Order YXZ: yaw, then pitch, then roll. */
export function qEuler(pitch = 0, yaw = 0, roll = 0) {
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, roll, 'YXZ'));
}
export const deg = (d) => d * Math.PI / 180;
/** quaternion raised to a power (fraction of its rotation) */
export function qPow(q, f) {
  return new THREE.Quaternion().slerpQuaternions(ID, q, f);
}
/** rotation taking (bindDir, bindRef) frame onto (dir, ref) frame */
export function frameRotation(bindDir, bindRef, dir, ref) {
  const mb = basis(bindDir, bindRef), mt = basis(dir, ref);
  const m = mt.multiply(mb.transpose());
  return new THREE.Quaternion().setFromRotationMatrix(m);
}
function basis(d, r) {
  const x = d.clone().normalize();
  const y = r.clone().addScaledVector(x, -r.dot(x));
  if (y.lengthSq() < 1e-10) y.set(0, 1, 0).addScaledVector(x, -x.y);
  y.normalize();
  const z = new THREE.Vector3().crossVectors(x, y);
  return new THREE.Matrix4().makeBasis(x, y, z);
}
/** swing-twist decomposition: returns twist about unit axis n */
export function twistAbout(q, n) {
  const d = q.x * n.x + q.y * n.y + q.z * n.z;
  const t = new THREE.Quaternion(n.x * d, n.y * d, n.z * d, q.w);
  if (t.lengthSq() < 1e-12) return new THREE.Quaternion();
  return t.normalize();
}

/** Two-bone IK. Returns {mid, end, reachError} */
export function twoBoneIK(root, target, l1, l2, pole) {
  const d = _v1.subVectors(target, root);
  let dist = d.length();
  const dn = d.clone().normalize();
  const maxR = (l1 + l2) * 0.99995, minR = Math.abs(l1 - l2) + 1e-4;
  const reachError = Math.max(0, dist - maxR);
  dist = Math.min(maxR, Math.max(minR, dist));
  const a = (l1 * l1 + dist * dist - l2 * l2) / (2 * dist);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  const pp = pole.clone().addScaledVector(dn, -pole.dot(dn));
  if (pp.lengthSq() < 1e-10) pp.set(0, 0, 1).addScaledVector(dn, -dn.z);
  pp.normalize();
  const mid = root.clone().addScaledVector(dn, a).addScaledVector(pp, h);
  const end = root.clone().addScaledVector(dn, dist);
  return { mid, end, pp, reachError };
}

const CHILD = {
  LeftUpLeg: 'LeftLeg', LeftLeg: 'LeftFoot', RightUpLeg: 'RightLeg', RightLeg: 'RightFoot',
  LeftArm: 'LeftForeArm', LeftForeArm: 'LeftHand', RightArm: 'RightForeArm', RightForeArm: 'RightHand',
  LeftHand: 'LeftHandMiddle1', RightHand: 'RightHandMiddle1',
};
const bindDir = (bone) => BIND_LOCAL[CHILD[bone]].clone().normalize();
const LEN = (bone) => BIND_LOCAL[CHILD[bone]].length();

export class PoseSolver {
  constructor() {
    this.names = BONE_DEFS.map((b) => b[0]);
  }

  /**
   * spec: {
   *   hips: {pos, quat}, chest: quat(world Spine2), spineDist:[3],
   *   head: quat(world) | headRel: quat (relative to chest), neckFrac,
   *   clavicle: {Left: quat, Right: quat} (local offsets),
   *   feet: {Left:{pos(ankle), quat, toe}, Right:{...}}, kneePole:{Left: V3, Right: V3},
   *   weapon: (ctx) => {pos, quat} (world),
   *   grips: {Right:{pos,quat}, Left:{pos,quat}} (weapon space) ; leftOff: bool,
   *   elbowPole: {Left: V3, Right: V3} (world),
   *   fingers: {Right:{index:[3], middle:[3], thumb:[3], spread}, Left:{...}},
   *   twistShare: 0.55,
   * }
   */
  solve(spec) {
    const L = {}; // local quats
    const W = {}; // world {pos, quat}
    for (const n of this.names) L[n] = new THREE.Quaternion();

    const setWorld = (name) => {
      const p = PARENT[name];
      if (!p) { W[name] = { pos: spec.hips.pos.clone(), quat: L[name].clone() }; return; }
      const pw = W[p];
      W[name] = {
        pos: BIND_LOCAL[name].clone().applyQuaternion(pw.quat).add(pw.pos),
        quat: pw.quat.clone().multiply(L[name]),
      };
    };
    const setLocalFromWorld = (name, worldQ) => {
      const p = PARENT[name];
      L[name] = W[p].quat.clone().invert().multiply(worldQ);
      setWorld(name);
    };

    // ---- pelvis
    L.Hips.copy(spec.hips.quat);
    setWorld('Hips');

    // ---- spine: distribute hips->chest delta
    const dist = spec.spineDist || [0.28, 0.34, 0.38];
    const delta = spec.hips.quat.clone().invert().multiply(spec.chest);
    let acc = 0;
    ['Spine', 'Spine1', 'Spine2'].forEach((n, i) => {
      // fractional rotations about the same axis compose exactly
      const a0 = acc, a1 = acc + dist[i];
      L[n] = qPow(delta, a0).invert().multiply(qPow(delta, a1));
      acc = a1;
      setWorld(n);
    });

    // ---- clavicles
    for (const s of ['Left', 'Right']) {
      L[`${s}Shoulder`] = (spec.clavicle && spec.clavicle[s]) ? spec.clavicle[s].clone() : new THREE.Quaternion();
      setWorld(`${s}Shoulder`);
    }

    // ---- neck / head
    const chestQ = W.Spine2.quat;
    const headWorld = spec.headRel ? chestQ.clone().multiply(spec.headRel) : (spec.head || chestQ).clone();
    const hd = chestQ.clone().invert().multiply(headWorld);
    if (spec.neckLocal && spec.headLocal) {
      // explicit cervical posture (allows head protraction / 'turtling' for a cheek weld)
      L.Neck = spec.neckLocal.clone(); setWorld('Neck');
      L.Head = spec.headLocal.clone(); setWorld('Head');
    } else {
      const nf = spec.neckFrac ?? 0.45;
      L.Neck = qPow(hd, nf); setWorld('Neck');
      L.Head = qPow(hd, nf).invert().multiply(hd); setWorld('Head');
    }
    L.HeadTop_End.identity(); setWorld('HeadTop_End');

    // ---- weapon placement
    let weapon = spec.weapon && !spec.cradle ? spec.weapon({ W, spec }) : null;

    // ---- legs
    const reach = {};
    for (const s of ['Left', 'Right']) {
      const f = spec.feet[s];
      setWorld(`${s}UpLeg`);
      const root = W[`${s}UpLeg`].pos;
      const l1 = LEN(`${s}UpLeg`), l2 = LEN(`${s}Leg`);
      const pole = (spec.kneePole && spec.kneePole[s]) || new THREE.Vector3(0, 0, 1).applyQuaternion(f.quat);
      const ik = twoBoneIK(root, f.pos, l1, l2, pole);
      reach[s] = ik.reachError;
      const bindPole = new THREE.Vector3(0, 0, 1);
      const upQ = frameRotation(bindDir(`${s}UpLeg`), bindPole, ik.mid.clone().sub(root), ik.pp);
      setLocalFromWorld(`${s}UpLeg`, upQ);
      const loQ = frameRotation(bindDir(`${s}Leg`), bindPole, ik.end.clone().sub(ik.mid), ik.pp);
      setLocalFromWorld(`${s}Leg`, loQ);
      setLocalFromWorld(`${s}Foot`, f.quat);
      // toe: positive = toes bent up relative to the foot (dorsiflexion of MTP)
      L[`${s}ToeBase`] = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -(f.toe || 0));
      setWorld(`${s}ToeBase`);
      setWorld(`${s}Toe_End`);
    }

    // ---- arms
    const handErr = {};
    const solveArm = (s, handT, elbowTarget) => {
      setWorld(`${s}Arm`);
      const root = W[`${s}Arm`].pos;
      const l1 = LEN(`${s}Arm`), l2 = LEN(`${s}ForeArm`);
      if (!handT) { // relaxed arm hanging
        handT = { pos: root.clone().add(new THREE.Vector3(0, -(l1 + l2) * 0.97, 0.05)), quat: W.Spine2.quat.clone() };
      }
      let mid, end, pp;
      if (elbowTarget) {
        // elbow placed toward a target (e.g. planted on the ground), forearm aimed at the hand target
        mid = root.clone().add(elbowTarget.clone().sub(root).normalize().multiplyScalar(l1));
        end = mid.clone().add(handT.pos.clone().sub(mid).normalize().multiplyScalar(l2));
        const line = end.clone().sub(root).normalize();
        pp = mid.clone().sub(root).addScaledVector(line, -mid.clone().sub(root).dot(line));
        if (pp.lengthSq() < 1e-10) pp.set(0, -1, 0); pp.normalize();
        handErr[s] = end.distanceTo(handT.pos);
      } else {
        const pole = (spec.elbowPole && spec.elbowPole[s]) || new THREE.Vector3(0, -0.5, -1);
        const ik = twoBoneIK(root, handT.pos, l1, l2, pole);
        mid = ik.mid; end = ik.end; pp = ik.pp;
        handErr[s] = ik.reachError;
      }
      const bindPole = new THREE.Vector3(0, 0, -1);
      const upQ = frameRotation(bindDir(`${s}Arm`), bindPole, mid.clone().sub(root), pp);
      setLocalFromWorld(`${s}Arm`, upQ);
      let foreQ = frameRotation(bindDir(`${s}ForeArm`), bindPole, end.clone().sub(mid), pp);
      // distribute forearm twist (pronation/supination) between forearm and wrist
      const handLocal = foreQ.clone().invert().multiply(handT.quat);
      const tw = twistAbout(handLocal, bindDir(`${s}ForeArm`));
      foreQ = foreQ.multiply(qPow(tw, spec.twistShare ?? 0.6));
      setLocalFromWorld(`${s}ForeArm`, foreQ);
      setLocalFromWorld(`${s}Hand`, handT.quat);
    };
    const gripTarget = (s, g) => ({
      pos: g.pos.clone().applyQuaternion(weapon.quat).add(weapon.pos),
      quat: weapon.quat.clone().multiply(g.quat),
    });
    let order = ['Left', 'Right'];
    if (spec.cradle) {
      // Crawling: right forearm planted -> right hand -> weapon follows the hand; left hand
      // slides along the handguard to wherever its planted forearm reaches.
      const c = spec.cradle;
      solveArm('Right', c.rightHand, c.elbow.Right);
      handErr.Right = 0; // the rifle is placed from wherever the right hand ends up
      const hw = W.RightHand;
      const gi = new THREE.Matrix4().compose(spec.grips.Right.pos, spec.grips.Right.quat, new THREE.Vector3(1, 1, 1)).invert();
      const m = new THREE.Matrix4().compose(hw.pos, hw.quat, new THREE.Vector3(1, 1, 1)).multiply(gi);
      weapon = { pos: new THREE.Vector3(), quat: new THREE.Quaternion() };
      m.decompose(weapon.pos, weapon.quat, new THREE.Vector3());
      setWorld('LeftArm');
      const l1 = LEN('LeftArm'), l2 = LEN('LeftForeArm');
      const e = W.LeftArm.pos.clone().add(c.elbow.Left.clone().sub(W.LeftArm.pos).normalize().multiplyScalar(l1));
      let bestZ = 0.3, bestD = Infinity;
      for (let z = 0.16; z <= 0.46; z += 0.005) {
        const gp = gripTarget('Left', c.leftGrip(z)).pos;
        const d = 0.3 * Math.abs(gp.distanceTo(e) - l2) + 3 * Math.max(0, gp.distanceTo(W.LeftArm.pos) - (l1 + l2) * 0.97);
        if (d < bestD) { bestD = d; bestZ = z; }
      }
      // hand stays on the handguard; the elbow is pulled toward its planted target
      const saved = spec.elbowPole;
      spec.elbowPole = { ...(saved || {}), Left: c.elbow.Left.clone().sub(W.LeftArm.pos) };
      solveArm('Left', gripTarget('Left', c.leftGrip(bestZ)), null);
      spec.elbowPole = saved;
      order = [];
    }
    for (const s of order) {
      let handT = null;
      if (weapon && spec.grips && spec.grips[s] && !(s === 'Left' && spec.leftOff)) handT = gripTarget(s, spec.grips[s]);
      else if (spec.freeHand && spec.freeHand[s]) handT = spec.freeHand[s](W, weapon);
      if (spec.handBlend && spec.handBlend[s] && handT && spec.freeHand && spec.freeHand[s]) {
        // blend between the grip and a free-hand target (e.g. a hand planted on a wall)
        const alt = spec.freeHand[s](W, weapon), t = spec.handBlend[s];
        handT = { pos: handT.pos.clone().lerp(alt.pos, t), quat: handT.quat.clone().slerp(alt.quat, t) };
      }
      solveArm(s, handT, spec.elbowTarget && spec.elbowTarget[s]);
    }

    for (const s of ['Left', 'Right']) {
      // fingers
      const F = (spec.fingers && spec.fingers[s]) || {};
      const palm = new THREE.Vector3(0, -1, 0);
      for (const fn of ['Index', 'Middle', 'Thumb']) {
        const key = fn.toLowerCase();
        const curls = F[key] || [0.2, 0.2, 0.15];
        for (let k = 1; k <= 3; k++) {
          const bn = `${s}Hand${fn}${k}`;
          const child = k < 3 ? `${s}Hand${fn}${k + 1}` : null;
          const dir = child ? BIND_LOCAL[child].clone().normalize() : BIND_LOCAL[bn].clone().normalize();
          const ax = new THREE.Vector3().crossVectors(dir, palm).normalize();
          let q = new THREE.Quaternion().setFromAxisAngle(ax, curls[k - 1] || 0);
          if (fn === 'Thumb' && k === 1) {
            // opposition: swing thumb under the palm around the hand axis
            const handAxis = bindDir(`${s}Hand`);
            const opp = new THREE.Quaternion().setFromAxisAngle(handAxis, (F.thumbOpp ?? 0.3) * (s === 'Right' ? 1 : -1));
            q = opp.multiply(q);
          }
          L[bn] = q;
        }
      }
      for (const fn of ['Index', 'Middle', 'Thumb']) for (let k = 1; k <= 3; k++) setWorld(`${s}Hand${fn}${k}`);
    }

    return { local: L, world: W, hipsPos: spec.hips.pos.clone(), weapon, reach, handErr };
  }
}

/** Forward kinematics from local quats + hips position (for validation). */
export function forwardKinematics(local, hipsPos) {
  const W = {};
  for (const [name, parent] of BONE_DEFS) {
    if (!parent) W[name] = { pos: hipsPos.clone(), quat: local[name].clone() };
    else {
      const pw = W[parent];
      W[name] = {
        pos: BIND_LOCAL[name].clone().applyQuaternion(pw.quat).add(pw.pos),
        quat: pw.quat.clone().multiply(local[name]),
      };
    }
  }
  return W;
}

export function localPoint(world, bone, p) {
  return p.clone().applyQuaternion(world[bone].quat).add(world[bone].pos);
}
