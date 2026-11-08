// Bake clip definitions (lists of solver specs) into THREE.AnimationClips.

import * as THREE from 'three';
import { BONE_DEFS } from './skeleton.js';
import { PoseSolver, forwardKinematics } from './solver.js';
import { buildClipLibrary, FPS } from './clips.js';

const solver = new PoseSolver();

export function bakeClip(def) {
  const n = def.frames.length;
  const times = new Float32Array(n);
  for (let i = 0; i < n; i++) times[i] = i === n - 1 ? def.duration : i / FPS;
  const quats = {};
  for (const [name] of BONE_DEFS) quats[name] = new Float32Array(n * 4);
  const hips = new Float32Array(n * 3);
  const metrics = { footErr: 0, handErr: 0, legReach: 0, frames: n };
  const poses = [];
  const prev = {};
  def.frames.forEach((spec, i) => {
    const res = solver.solve(spec);
    for (const [name] of BONE_DEFS) {
      const q = res.local[name];
      if (prev[name] && prev[name].dot(q) < 0) q.set(-q.x, -q.y, -q.z, -q.w); // hemisphere continuity
      prev[name] = q;
      q.toArray(quats[name], i * 4);
    }
    res.hipsPos.toArray(hips, i * 3);
    // metrics
    const W = forwardKinematics(res.local, res.hipsPos);
    for (const s of ['Left', 'Right']) {
      metrics.footErr = Math.max(metrics.footErr, W[`${s}Foot`].pos.distanceTo(spec.feet[s].pos));
      metrics.handErr = Math.max(metrics.handErr, res.handErr[s] || 0);
      metrics.legReach = Math.max(metrics.legReach, res.reach[s] || 0);
    }
    poses.push(res);
  });
  const tracks = [];
  const constant = (arr, stride) => {
    for (let i = stride; i < arr.length; i++) if (Math.abs(arr[i] - arr[i % stride]) > 1e-6) return false;
    return true;
  };
  const tEnds = new Float32Array([0, def.duration]);
  for (const [name] of BONE_DEFS) {
    const a = quats[name];
    if (constant(a, 4)) tracks.push(new THREE.QuaternionKeyframeTrack(`${name}.quaternion`, tEnds, [...a.slice(0, 4), ...a.slice(0, 4)]));
    else tracks.push(new THREE.QuaternionKeyframeTrack(`${name}.quaternion`, times, a));
  }
  tracks.push(new THREE.VectorKeyframeTrack('Hips.position', times, hips));
  const clip = new THREE.AnimationClip(def.name, def.duration, tracks);
  clip.userData = { loop: def.loop, speed: def.speed || 0, shots: def.shots || [], events: def.events || {}, rpm: def.rpm, rootMotion: def.rootMotion, obstacle: def.obstacle };
  return { clip, metrics, poses };
}

export function bakeAll() {
  const defs = buildClipLibrary();
  return defs.map((d) => ({ def: d, ...bakeClip(d) }));
}
