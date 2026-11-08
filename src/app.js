// Soldier Simulator: animation viewer + playable third-person sandbox + GLB export.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { buildSoldier } from './soldier.js';
import { bakeAll } from './bake.js';
import { leftGrip } from './weapon.js';
import { twoBoneIK, frameRotation, twistAbout, qPow } from './solver.js';
import { BIND_LOCAL, RIGHT_EYE_LOCAL } from './skeleton.js';
import { exportGLB } from './export.js';

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);

// ------------------------------------------------------------------ renderer / scene
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: params.has('shot') });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
$('#view').appendChild(renderer.domElement);

const scene = new THREE.Scene();
const SKY = new THREE.Color('#a9bfcf');
scene.background = SKY;
scene.fog = new THREE.Fog(SKY, 25, 90);
scene.add(new THREE.HemisphereLight('#e4edf5', '#5d5646', 1.25));
const sun = new THREE.DirectionalLight('#fff1dc', 2.6);
sun.position.set(4, 8, 5);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -4, right: 4, top: 4, bottom: -4, near: 0.5, far: 30 });
sun.shadow.bias = -0.0004;
scene.add(sun, sun.target);

// ground: tiled texture so in-place locomotion can scroll it under the feet
function groundTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#7b8763'; g.fillRect(0, 0, 256, 256);
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 1400; i++) {
    g.fillStyle = ['#72805b', '#84906b', '#6d7956', '#8b936f'][i % 4];
    g.fillRect(rnd() * 256, rnd() * 256, 2 + rnd() * 5, 2 + rnd() * 5);
  }
  g.strokeStyle = 'rgba(40,50,35,0.35)'; g.lineWidth = 2;
  g.strokeRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(60, 60);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
const gtex = groundTexture();
const ground = new THREE.Mesh(new THREE.PlaneGeometry(120, 120), new THREE.MeshStandardMaterial({ map: gtex, roughness: 1 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

// scattered low-poly props (for the play mode / sense of motion)
const props = new THREE.Group();
{
  const mat = new THREE.MeshStandardMaterial({ color: '#8d8a7c', flatShading: true, roughness: 1 });
  const crate = new THREE.MeshStandardMaterial({ color: '#7a6847', flatShading: true, roughness: 0.9 });
  let seed = 3; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 70; i++) {
    const r = 6 + rnd() * 40, a = rnd() * Math.PI * 2;
    const m = i % 3 === 0
      ? new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), crate)
      : new THREE.Mesh(new THREE.DodecahedronGeometry(0.3 + rnd() * 0.7, 0), mat);
    m.position.set(Math.cos(a) * r, i % 3 === 0 ? 0.5 : 0.1, Math.sin(a) * r);
    m.rotation.y = rnd() * 6;
    m.castShadow = m.receiveShadow = true;
    props.add(m);
  }
  // range targets downrange
  const tmat = new THREE.MeshStandardMaterial({ color: '#d8d2bf', flatShading: true });
  const dark = new THREE.MeshStandardMaterial({ color: '#2b2b2b', flatShading: true });
  for (let i = -2; i <= 2; i++) {
    const t = new THREE.Group();
    const board = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.75, 0.03), tmat);
    board.position.y = 1.35; t.add(board);
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.035, 10), dark);
    ring.rotation.x = Math.PI / 2; ring.position.set(0, 1.45, 0.005); t.add(ring);
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.05, 1.0, 0.05), crate);
    post.position.y = 0.5; t.add(post);
    t.position.set(i * 2.2, 0, 22);
    t.traverse((o) => { o.castShadow = true; });
    props.add(t);
  }
}
scene.add(props);

// ------------------------------------------------------------------ soldier
const S = buildSoldier();
scene.add(S.group);
const skeletonHelper = new THREE.SkeletonHelper(S.group);
skeletonHelper.visible = false;
scene.add(skeletonHelper);
const muzzleNode = S.rifle.getObjectByName('Muzzle');
const ejectNode = S.rifle.getObjectByName('Ejection');

$('#status').textContent = 'Solving & baking animations…';
await new Promise((r) => setTimeout(r, 30));
const t0 = performance.now();
const baked = bakeAll();
const CLIPS = Object.fromEntries(baked.map((b) => [b.clip.name, b.clip]));
const DEFS = Object.fromEntries(baked.map((b) => [b.def.name, b.def]));
$('#status').textContent = `${baked.length} clips baked in ${Math.round(performance.now() - t0)} ms`;

const mixer = new THREE.AnimationMixer(S.group);
const actions = {};
for (const [n, c] of Object.entries(CLIPS)) {
  const a = mixer.clipAction(c);
  if (!c.userData.loop) { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; }
  actions[n] = a;
}
// additive recoil layers (relative to the static stance pose)
const additive = {};
for (const [fire, ref] of [['ADS_Fire_Auto', 'ADS_Pose'], ['HipFire_Fire_Auto', 'HipFire_Pose'], ['Crouch_ADS_Fire_Auto', 'Crouch_ADS_Pose'], ['Prone_Fire_Auto', 'Prone_Pose']]) {
  const c = THREE.AnimationUtils.makeClipAdditive(CLIPS[fire].clone(), 0, CLIPS[ref], 60);
  c.name = fire + '_Additive';
  const a = mixer.clipAction(c);
  a.blendMode = THREE.AdditiveAnimationBlendMode;
  additive[fire] = a;
}

// ------------------------------------------------------------------ cameras
const camera = new THREE.PerspectiveCamera(40, 1, 0.02, 300);
camera.position.set(-2.4, 1.7, 3.0);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1.05, 0.2);
controls.enableDamping = true;
controls.minDistance = 0.4;
controls.maxDistance = 20;

const CAM_PRESETS = {
  orbit: null,
  side: [[-3.4, 1.25, 0.4], [0, 1.0, 0.4]],
  front: [[0.3, 1.4, 3.6], [0, 1.05, 0]],
  back: [[-0.9, 1.65, -2.6], [0, 1.25, 0.6]],
  shoulder: [[-0.75, 1.75, -0.9], [0, 1.4, 2.5]],
  close: [[-1.1, 1.6, 1.25], [-0.1, 1.35, 0.3]],
  hands: [[0.8, 1.35, 1.1], [-0.08, 1.3, 0.35]],
  feet: [[-1.6, 0.45, 0.9], [0, 0.2, 0]],
};
let camMode = 'orbit';
function setCamera(name) {
  camMode = name;
  document.querySelectorAll('[data-cam]').forEach((b) => b.classList.toggle('on', b.dataset.cam === name));
  if (CAM_PRESETS[name]) {
    const [p, t] = CAM_PRESETS[name];
    const base = S.group.position;
    camera.position.set(base.x + p[0], p[1], base.z + p[2]);
    controls.target.set(base.x + t[0], t[1], base.z + t[2]);
  }
}

// ------------------------------------------------------------------ effects
const fx = new THREE.Group(); scene.add(fx);
const flashMat = new THREE.MeshBasicMaterial({ color: '#ffd27a', transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false });
const flashGeo = (() => {
  const g = new THREE.ConeGeometry(0.035, 0.16, 6, 1, true); g.rotateX(Math.PI / 2); g.translate(0, 0, 0.08); return g;
})();
const starGeo = new THREE.PlaneGeometry(0.14, 0.14);
const flashLight = new THREE.PointLight('#ffb35c', 0, 4, 2);
scene.add(flashLight);
const shellGeo = new THREE.CylinderGeometry(0.0045, 0.0045, 0.045, 6); shellGeo.rotateX(Math.PI / 2);
const shellMat = new THREE.MeshStandardMaterial({ color: '#b08d3c', metalness: 0.7, roughness: 0.35, flatShading: true });
const tracerMat = new THREE.MeshBasicMaterial({ color: '#ffcf80', transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false });
const tracerGeo = new THREE.CylinderGeometry(0.004, 0.004, 1.6, 4); tracerGeo.rotateX(Math.PI / 2);
const live = [];

function fireEffects() {
  S.group.updateMatrixWorld(true);
  const mp = new THREE.Vector3(), mq = new THREE.Quaternion();
  muzzleNode.getWorldPosition(mp); muzzleNode.getWorldQuaternion(mq);
  const cone = new THREE.Mesh(flashGeo, flashMat.clone());
  cone.position.copy(mp); cone.quaternion.copy(mq);
  cone.scale.setScalar(0.8 + Math.random() * 0.5);
  const star = new THREE.Mesh(starGeo, flashMat.clone());
  star.position.copy(mp); star.quaternion.copy(mq);
  star.rotateZ(Math.random() * Math.PI);
  fx.add(cone, star);
  live.push({ o: cone, life: 0.045, t: 0 }, { o: star, life: 0.035, t: 0 });
  flashLight.position.copy(mp); flashLight.intensity = 6;
  // tracer (every 3rd round)
  if (Math.random() < 0.34) {
    const tr = new THREE.Mesh(tracerGeo, tracerMat.clone());
    tr.position.copy(mp); tr.quaternion.copy(mq);
    fx.add(tr);
    live.push({ o: tr, life: 0.35, t: 0, vel: new THREE.Vector3(0, 0, 1).applyQuaternion(mq).multiplyScalar(160) });
  }
  // shell casing: ejected right, up and slightly back
  const ep = new THREE.Vector3(), eq = new THREE.Quaternion();
  ejectNode.getWorldPosition(ep); ejectNode.getWorldQuaternion(eq);
  const sh = new THREE.Mesh(shellGeo, shellMat);
  sh.position.copy(ep); sh.castShadow = true;
  const v = new THREE.Vector3(-2.6 - Math.random(), 1.6 + Math.random() * 0.8, -0.6 + Math.random() * 0.5).applyQuaternion(eq);
  fx.add(sh);
  live.push({ o: sh, life: 3.0, t: 0, vel: v, spin: new THREE.Vector3(Math.random() * 30, Math.random() * 30, 0), shell: true });
}
function updateEffects(dt) {
  flashLight.intensity = Math.max(0, flashLight.intensity - dt * 120);
  for (let i = live.length - 1; i >= 0; i--) {
    const e = live[i];
    e.t += dt;
    if (e.vel) {
      if (e.shell) e.vel.y -= 9.81 * dt;
      e.o.position.addScaledVector(e.vel, dt);
      if (e.spin) { e.o.rotation.x += e.spin.x * dt; e.o.rotation.y += e.spin.y * dt; }
      if (e.shell && e.o.position.y < 0.005) { e.o.position.y = 0.005; e.vel.multiplyScalar(0.3); e.vel.y = Math.abs(e.vel.y) * 0.4; e.spin.multiplyScalar(0.5); }
    }
    if (!e.shell && e.o.material) e.o.material.opacity = Math.max(0, 1 - e.t / e.life);
    if (e.t > e.life) { fx.remove(e.o); live.splice(i, 1); }
  }
}

// ------------------------------------------------------------------ left-hand IK fix-up
// Keeps the support hand locked on the handguard while clips cross-fade.
const _inv = new THREE.Matrix4(), _m = new THREE.Matrix4();
const charQ = (obj) => { // orientation in character (group) space
  const q = new THREE.Quaternion(); obj.getWorldQuaternion(q);
  const g = new THREE.Quaternion(); S.group.getWorldQuaternion(g);
  return g.invert().multiply(q);
};
const toChar = (v) => v.applyMatrix4(_inv.copy(S.group.matrixWorld).invert());
function leftHandIK() {
  const B = S.bones;
  S.group.updateMatrixWorld(true);
  // current hand in weapon space -> nearest valid support-hand grip on the handguard
  _m.copy(S.rifle.matrixWorld).invert();
  const wrist = B.LeftHand.getWorldPosition(new THREE.Vector3()).applyMatrix4(_m);
  const z = THREE.MathUtils.clamp(wrist.z + 0.045, 0.22, 0.37);
  const g = leftGrip(z, 'cup');
  const tPos = g.pos.clone().applyMatrix4(S.rifle.matrixWorld);
  const rq = new THREE.Quaternion(); S.rifle.getWorldQuaternion(rq);
  const tQuatW = rq.multiply(g.quat);
  // to character space
  const root = toChar(B.LeftArm.getWorldPosition(new THREE.Vector3()));
  const elbow = toChar(B.LeftForeArm.getWorldPosition(new THREE.Vector3()));
  const target = toChar(tPos.clone());
  const gq = new THREE.Quaternion(); S.group.getWorldQuaternion(gq);
  const tQuat = gq.clone().invert().multiply(tQuatW);
  const l1 = BIND_LOCAL.LeftForeArm.length(), l2 = BIND_LOCAL.LeftHand.length();
  const ik = twoBoneIK(root, target, l1, l2, elbow.clone().sub(root));
  const bindPole = new THREE.Vector3(0, 0, -1);
  const upQ = frameRotation(BIND_LOCAL.LeftForeArm.clone().normalize(), bindPole, ik.mid.clone().sub(root), ik.pp);
  let loQ = frameRotation(BIND_LOCAL.LeftHand.clone().normalize(), bindPole, ik.end.clone().sub(ik.mid), ik.pp);
  const tw = twistAbout(loQ.clone().invert().multiply(tQuat), BIND_LOCAL.LeftHand.clone().normalize());
  loQ = loQ.multiply(qPow(tw, 0.6));
  const pArm = charQ(B.LeftShoulder);
  B.LeftArm.quaternion.copy(pArm.clone().invert().multiply(upQ));
  B.LeftForeArm.quaternion.copy(upQ.clone().invert().multiply(loQ));
  B.LeftHand.quaternion.copy(loQ.clone().invert().multiply(tQuat));
}

// ------------------------------------------------------------------ viewer state
let current = null;
let paused = false;
let ikFix = true;
let groundScroll = 0;
let lastClipTime = 0;
const GROUPS = [
  ['Locomotion', ['Idle', 'Walk', 'Run', 'ADS_Walk', 'HipFire_Walk']],
  ['Weapon', ['ADS_Idle', 'HipFire_Idle', 'ADS_Fire', 'ADS_Fire_Auto', 'HipFire_Fire', 'HipFire_Fire_Auto']],
  ['Transitions', ['Idle_To_ADS', 'ADS_To_Idle', 'Idle_To_HipFire', 'HipFire_To_Idle', 'HipFire_To_ADS', 'ADS_To_HipFire']],
  ['Crouch', ['Crouch_Idle', 'Crouch_Walk', 'Crouch_ADS_Idle', 'Crouch_ADS_Walk', 'Crouch_ADS_Fire', 'Crouch_ADS_Fire_Auto', 'Stand_To_Crouch', 'Crouch_To_Stand', 'Crouch_To_Crouch_ADS', 'Crouch_ADS_To_Crouch']],
  ['Prone', ['Prone_Idle', 'Prone_Fire', 'Prone_Fire_Auto', 'Prone_Crawl', 'Stand_To_Prone', 'Prone_To_Stand']],
  ['Jump', ['Jump', 'Jump_Start', 'Jump_Air', 'Jump_Land']],
  ['Poses', ['Idle_Pose', 'ADS_Pose', 'HipFire_Pose', 'Crouch_Pose', 'Crouch_ADS_Pose', 'Prone_Pose']],
];

function play(name, fade = Number($('#fade').value)) {
  const next = actions[name];
  if (!next) return;
  document.querySelectorAll('[data-clip]').forEach((b) => b.classList.toggle('on', b.dataset.clip === name));
  next.reset();
  next.setEffectiveWeight(1);
  next.setEffectiveTimeScale(Number($('#speed').value));
  next.play();
  if (current && current !== next) current.crossFadeTo(next, fade, false);
  current = next;
  lastClipTime = 0;
  const d = DEFS[name];
  $('#clipinfo').innerHTML = `<b>${name}</b> · ${d.duration.toFixed(2)} s · ${d.loop ? 'loop' : 'one-shot'}${d.speed ? ` · ${d.speed.toFixed(2)} m/s in-place` : ''}${d.shots && d.shots.length ? ` · ${d.shots.length} shot${d.shots.length > 1 ? 's' : ''}` : ''}`;
}

function buildUI() {
  const list = $('#clips');
  for (const [title, names] of GROUPS) {
    const h = document.createElement('div'); h.className = 'group'; h.textContent = title; list.appendChild(h);
    const wrap = document.createElement('div'); wrap.className = 'btns';
    for (const n of names) {
      if (!actions[n]) continue;
      const b = document.createElement('button');
      b.textContent = n.replace(/_/g, ' '); b.dataset.clip = n;
      b.onclick = () => play(n);
      wrap.appendChild(b);
    }
    list.appendChild(wrap);
  }
  document.querySelectorAll('[data-cam]').forEach((b) => (b.onclick = () => setCamera(b.dataset.cam)));
  $('#speed').oninput = (e) => { $('#speedv').textContent = Number(e.target.value).toFixed(2) + '×'; if (current) current.setEffectiveTimeScale(Number(e.target.value)); };
  $('#fade').oninput = (e) => { $('#fadev').textContent = Number(e.target.value).toFixed(2) + ' s'; };
  $('#pause').onclick = () => { paused = !paused; $('#pause').textContent = paused ? '▶ Play' : '❚❚ Pause'; };
  $('#step').onclick = () => { paused = true; $('#pause').textContent = '▶ Play'; mixer.update(1 / 60); };
  $('#skel').onchange = (e) => (skeletonHelper.visible = e.target.checked);
  $('#wire').onchange = (e) => { S.mesh.material.wireframe = e.target.checked; S.rifle.material.wireframe = e.target.checked; };
  $('#ikfix').onchange = (e) => (ikFix = e.target.checked);
  $('#scroll').onchange = () => {};
  $('#export').onclick = async () => {
    $('#export').disabled = true; $('#export').textContent = 'Exporting…';
    try {
      const buf = await exportGLB(baked);
      const url = URL.createObjectURL(new Blob([buf], { type: 'model/gltf-binary' }));
      const a = document.createElement('a'); a.href = url; a.download = 'soldier.glb'; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      $('#status').textContent = `Exported soldier.glb (${(buf.byteLength / 1024).toFixed(0)} KB, ${baked.length} clips)`;
    } finally { $('#export').disabled = false; $('#export').textContent = '⬇ Export GLB'; }
  };
  $('#modeplay').onclick = () => setMode('play');
  $('#modeview').onclick = () => setMode('view');
}

// ------------------------------------------------------------------ play mode (third-person sandbox)
const keys = {};
const sim = {
  yaw: 0, camYaw: 0, camPitch: 0.12, aim: 'none', fire: false, fireTimer: 0, jumping: false,
  speed: 0, base: null, lowerYaw: 0, eye: false,
};
let mode = 'view';
function setMode(m) {
  mode = m;
  document.body.classList.toggle('playing', m === 'play');
  $('#modeplay').classList.toggle('on', m === 'play');
  $('#modeview').classList.toggle('on', m === 'view');
  controls.enabled = m === 'view';
  if (m === 'play') {
    sim.yaw = sim.camYaw = 0; sim.jumping = false; sim.aim = 'none'; sim.lastAim = 'none'; sim.fire = false;
    sim.posture = 'stand'; sim.wantPosture = null; sim.postureClip = null;
    S.group.position.set(0, 0, 0); S.group.rotation.set(0, 0, 0);
    document.activeElement?.blur?.();
    groundScroll = 0; gtex.offset.set(0, 0);
    setBase('Idle', 0.2);
    renderer.domElement.requestPointerLock?.();
  } else {
    document.exitPointerLock?.();
    S.group.position.set(0, 0, 0); S.group.rotation.set(0, 0, 0);
    for (const a of Object.values(additive)) a.stop();
    play('Idle', 0.2);
    setCamera('orbit');
  }
}
function setBase(name, fade = 0.25, timeScale = 1) {
  const a = actions[name];
  if (sim.base === name) { a.setEffectiveTimeScale(timeScale); return; }
  const prev = sim.base ? actions[sim.base] : current;
  a.reset(); a.setEffectiveWeight(1); a.setEffectiveTimeScale(timeScale); a.play();
  if (prev && prev !== a) {
    // phase-match locomotion cycles so feet don't pop
    if (prev.getClip().userData.speed && a.getClip().userData.speed) a.time = (prev.time / prev.getClip().duration) * a.getClip().duration;
    prev.crossFadeTo(a, fade, false);
  }
  sim.base = name; current = a;
}
window.addEventListener('keydown', (e) => {
  keys[e.code] = true;
  if (mode !== 'play') return;
  if (['Space', 'Enter', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.code)) e.preventDefault(); // no UI buttons / page scroll
  if (e.repeat) return;
  if (e.code === 'Space' && !sim.jumping && (sim.posture || 'stand') === 'stand' && !sim.postureClip) startJump();
  if (e.code === 'KeyV') sim.eye = !sim.eye;
  if (e.code === 'KeyH') sim.aim = sim.aim === 'hip' ? 'none' : 'hip';
  if (e.code === 'KeyC') sim.wantPosture = (sim.posture || 'stand') === 'crouch' ? 'stand' : 'crouch';
  if (e.code === 'KeyZ') sim.wantPosture = (sim.posture || 'stand') === 'prone' ? 'stand' : 'prone';
  if (e.code === 'Escape') setMode('view');
});
window.addEventListener('keyup', (e) => { keys[e.code] = false; });
renderer.domElement.addEventListener('mousedown', (e) => {
  if (mode !== 'play') return;
  if (document.pointerLockElement !== renderer.domElement) renderer.domElement.requestPointerLock?.();
  if (e.button === 0) sim.fire = true;
  if (e.button === 2) sim.aim = 'ads';
});
window.addEventListener('mouseup', (e) => {
  if (e.button === 0) sim.fire = false;
  if (e.button === 2 && sim.aim === 'ads') sim.aim = 'none';
});
renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());
window.addEventListener('mousemove', (e) => {
  if (mode !== 'play') return;
  const locked = document.pointerLockElement === renderer.domElement;
  if (!locked && !(e.buttons & 4)) return;
  sim.camYaw -= e.movementX * 0.0025;
  sim.camPitch = THREE.MathUtils.clamp(sim.camPitch + e.movementY * 0.002, -0.3, 0.6);
});

function startJump() {
  sim.jumping = true;
  const a = actions.Jump;
  a.reset(); a.setEffectiveWeight(1); a.setEffectiveTimeScale(1); a.play();
  (sim.base ? actions[sim.base] : current).crossFadeTo(a, 0.12, false);
  sim.base = 'Jump'; current = a;
}
mixer.addEventListener('finished', (e) => {
  if (mode === 'play' && e.action === actions.Jump) { sim.jumping = false; sim.base = 'Jump'; }
});

const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
// one-shot posture changes (body locked until they finish)
const POSTURE_T = {
  'stand>crouch': 'Stand_To_Crouch', 'crouch>stand': 'Crouch_To_Stand',
  'stand>prone': 'Stand_To_Prone', 'prone>stand': 'Prone_To_Stand',
  'crouch>prone': 'Stand_To_Prone', 'prone>crouch': 'Prone_To_Stand',
};
function updatePlay(dt) {
  // arrow keys orbit the camera (same as moving the mouse): left/right turn, up/down tilt
  const orbitX = (keys.ArrowRight ? 1 : 0) - (keys.ArrowLeft ? 1 : 0);
  const orbitY = (keys.ArrowDown ? 1 : 0) - (keys.ArrowUp ? 1 : 0);
  if (orbitX) sim.camYaw -= orbitX * 2.2 * dt;
  if (orbitY) sim.camPitch = THREE.MathUtils.clamp(sim.camPitch + orbitY * 1.1 * dt, -0.3, 0.6);
  // desired movement in camera frame
  const f = (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0);
  const r = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0);
  const moving = f !== 0 || r !== 0;
  const posture = sim.posture || 'stand';
  const run = (keys.ShiftLeft || keys.ShiftRight) && sim.aim === 'none' && f > 0 && posture === 'stand';
  let aimMode = sim.fire && sim.aim === 'none' ? 'hip' : sim.aim;
  if (posture !== 'stand' && aimMode === 'hip') aimMode = 'ads'; // crouched/prone fire from the shoulder
  if (posture === 'prone') aimMode = 'ads';
  const moveYaw = sim.camYaw + Math.atan2(-r, f); // camera looks toward +Z at yaw 0

  // posture transition in progress?
  if (sim.postureClip) {
    if (actions[sim.postureClip].isRunning()) { sim.speed *= Math.exp(-dt * 8); return; }
    sim.postureClip = null;
  }
  if (sim.wantPosture && sim.wantPosture !== posture && !sim.jumping) {
    let from = posture, to = sim.wantPosture;
    if (from === 'crouch' && to === 'prone') from = 'stand';
    const t = POSTURE_T[`${from}>${to}`];
    sim.posture = to === 'crouch' && posture === 'prone' ? 'stand' : to;
    sim.wantPosture = sim.posture === to ? null : to; // prone -> crouch goes through standing
    sim.lastAim = 'none';
    setBase(t, 0.15);
    sim.postureClip = t;
    return;
  }

  let clip, speed = 0, timeScale = 1, lowerYaw = 0;
  const P = { stand: { idle: 'Idle', walk: 'Walk', ads: 'ADS_Idle', adsWalk: 'ADS_Walk', hip: 'HipFire_Idle', hipWalk: 'HipFire_Walk' },
    crouch: { idle: 'Crouch_Idle', walk: 'Crouch_Walk', ads: 'Crouch_ADS_Idle', adsWalk: 'Crouch_ADS_Walk', hip: 'Crouch_ADS_Idle', hipWalk: 'Crouch_ADS_Walk' },
    prone: { idle: 'Prone_Idle', walk: 'Prone_Crawl', ads: 'Prone_Idle', adsWalk: 'Prone_Crawl', hip: 'Prone_Idle', hipWalk: 'Prone_Crawl' } }[posture];
  if (!sim.jumping) {
    if (posture === 'prone') {
      if (moving) {
        sim.yaw = sim.yaw + wrapAngle(moveYaw - sim.yaw) * Math.min(1, dt * 2.5); // slow pivot on the elbows
        clip = P.walk; speed = DEFS[clip].speed;
      } else {
        sim.yaw = sim.yaw + wrapAngle(sim.camYaw - sim.yaw) * Math.min(1, dt * 2.5);
        clip = P.idle;
      }
    } else if (aimMode !== 'none') {
      sim.yaw = sim.yaw + wrapAngle(sim.camYaw - sim.yaw) * Math.min(1, dt * 14);
      if (moving) {
        clip = aimMode === 'ads' ? P.adsWalk : P.hipWalk;
        let d = wrapAngle(moveYaw - sim.yaw);
        if (Math.abs(d) > deg(100)) { timeScale = -1; d = wrapAngle(d - Math.PI); } // backpedal
        lowerYaw = THREE.MathUtils.clamp(d, -deg(80), deg(80));
        speed = DEFS[clip].speed;
      } else clip = aimMode === 'ads' ? P.ads : P.hip;
    } else if (moving) {
      sim.yaw = sim.yaw + wrapAngle(moveYaw - sim.yaw) * Math.min(1, dt * (run ? 6 : 8));
      clip = run ? 'Run' : P.walk;
      speed = DEFS[clip].speed;
    } else clip = P.idle;
    const prevAim = sim.lastAim || 'none';
    // standing / crouched mode changes use the authored transition clips
    const tname = posture === 'stand'
      ? { 'none>ads': 'Idle_To_ADS', 'ads>none': 'ADS_To_Idle', 'none>hip': 'Idle_To_HipFire', 'hip>none': 'HipFire_To_Idle', 'hip>ads': 'HipFire_To_ADS', 'ads>hip': 'ADS_To_HipFire' }[`${prevAim}>${aimMode}`]
      : posture === 'crouch' ? { 'none>ads': 'Crouch_To_Crouch_ADS', 'ads>none': 'Crouch_ADS_To_Crouch' }[`${prevAim}>${aimMode}`] : null;
    if (tname && !moving && [P.idle, P.ads, P.hip].includes(sim.base)) setBase(tname, 0.08);
    sim.lastAim = aimMode;
    const inTransition = sim.base && sim.base.includes('_To_') && actions[sim.base].isRunning() && !moving;
    if (!inTransition) setBase(clip, 0.22, timeScale);
  } else {
    speed = moving ? (sim.speed > 2 ? 3.0 : 1.2) : 0;
  }
  sim.lowerYaw += (lowerYaw - sim.lowerYaw) * Math.min(1, dt * 10);
  sim.speed += (speed - sim.speed) * Math.min(1, dt * 6);
  const dirYaw = sim.yaw + sim.lowerYaw + (timeScale < 0 ? Math.PI : 0);
  S.group.position.x += Math.sin(dirYaw) * sim.speed * dt;
  S.group.position.z += Math.cos(dirYaw) * sim.speed * dt;
  S.group.rotation.y = sim.yaw;

  // automatic fire: additive recoil layer + effects at the cyclic rate
  const crawling = posture === 'prone' && moving;
  const fireOn = sim.fire && !sim.jumping && !crawling;
  const layerName = posture === 'prone' ? 'Prone_Fire_Auto' : posture === 'crouch' ? 'Crouch_ADS_Fire_Auto' : aimMode === 'ads' ? 'ADS_Fire_Auto' : 'HipFire_Fire_Auto';
  const layer = additive[layerName];
  for (const a of Object.values(additive)) {
    const want = fireOn && a === layer;
    if (want && !a.isRunning()) { a.reset(); a.setEffectiveWeight(1); a.play(); sim.fireTimer = 0; }
    if (!want && a.isRunning()) a.stop();
  }
  if (fireOn) {
    sim.fireTimer -= dt;
    if (sim.fireTimer <= 0) { fireEffects(); sim.fireTimer += 60 / 700; }
  }
}
const deg = (d) => (d * Math.PI) / 180;

function applyLowerBodyYaw() {
  // rotate the pelvis toward the move direction while the chest keeps aiming
  const th = sim.lowerYaw;
  if (Math.abs(th) < 1e-4) return;
  const B = S.bones;
  const ry = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), th);
  const qh = B.Hips.quaternion.clone();
  B.Hips.quaternion.premultiply(ry);
  // Spine' = Qh^-1 * Ry(-th) * Qh * Spine  (keeps everything above the pelvis fixed)
  const fix = qh.clone().invert().multiply(ry.clone().invert()).multiply(qh);
  B.Spine.quaternion.premultiply(fix);
  B.Hips.position.applyAxisAngle(new THREE.Vector3(0, 1, 0), th);
}

function updatePlayCamera(dt) {
  const B = S.bones;
  S.group.updateMatrixWorld(true);
  if (sim.eye || sim.aim === 'ads') {
    if (sim.eye) {
      const eye = RIGHT_EYE_LOCAL.clone().applyMatrix4(B.Head.matrixWorld);
      const rq = new THREE.Quaternion(); S.rifle.getWorldQuaternion(rq);
      camera.position.copy(eye);
      camera.quaternion.copy(rq).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI));
      camera.fov = 32; camera.near = 0.01; camera.updateProjectionMatrix();
      return;
    }
  }
  camera.fov = sim.aim === 'ads' ? 30 : 42; camera.near = 0.02; camera.updateProjectionMatrix();
  const dist = sim.aim === 'ads' ? 1.7 : 2.6;
  const side = sim.aim === 'ads' ? -0.62 : -0.55;
  const ph = { stand: sim.aim === 'ads' ? 1.6 : 1.55, crouch: 1.15, prone: 0.75 }[sim.posture || 'stand'];
  const pivot = S.group.position.clone().add(new THREE.Vector3(0, ph, 0));
  const fwd = new THREE.Vector3(Math.sin(sim.camYaw), 0, Math.cos(sim.camYaw));
  const right = new THREE.Vector3(-fwd.z, 0, fwd.x).negate();
  const want = pivot.clone().addScaledVector(fwd, -dist * Math.cos(sim.camPitch)).addScaledVector(right, side).add(new THREE.Vector3(0, dist * Math.sin(sim.camPitch), 0));
  camera.position.lerp(want, 1 - Math.exp(-dt * 14));
  camera.lookAt(pivot.clone().addScaledVector(fwd, 6).addScaledVector(right, side * 0.5).add(new THREE.Vector3(0, -0.3 - 6 * Math.sin(sim.camPitch) * 0.5, 0)));
}

// ------------------------------------------------------------------ main loop
function resize() {
  const el = $('#view');
  renderer.setSize(el.clientWidth, el.clientHeight);
  camera.aspect = el.clientWidth / el.clientHeight;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();
buildUI();

const clock = new THREE.Clock();
function frame() {
  const dt = Math.min(0.05, clock.getDelta());
  if (mode === 'play') {
    updatePlay(dt);
    mixer.update(dt);
    applyLowerBodyYaw();
  } else if (!paused) {
    mixer.update(dt);
  }
  if (ikFix) leftHandIK();

  if (mode === 'view' && current) {
    const clip = current.getClip();
    // scroll the ground for in-place locomotion so planted feet stay locked to it
    if ($('#scroll').checked && clip.userData.speed && !paused) {
      const ts = current.getEffectiveTimeScale();
      groundScroll += clip.userData.speed * dt * ts * current.getEffectiveWeight();
    }
    gtex.offset.y = groundScroll / 2; // texture tile = 120/60 = 2 m
    props.position.z = -groundScroll;
    // effects for fire clips
    const t = current.time;
    for (const s of clip.userData.shots || []) if ((lastClipTime < s && t >= s) || (t < lastClipTime && s <= t)) fireEffects();
    lastClipTime = t;
    $('#time').value = clip.duration > 0.05 ? (t / clip.duration) : 0;
  }
  if (mode === 'play') updatePlayCamera(dt); else controls.update();
  updateEffects(dt);
  sun.position.copy(S.group.position).add(new THREE.Vector3(4, 8, 5));
  sun.target.position.copy(S.group.position);
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

$('#time').oninput = (e) => {
  if (!current) return;
  paused = true; $('#pause').textContent = '▶ Play';
  current.time = Number(e.target.value) * current.getClip().duration;
  mixer.update(0);
};

// URL options (used for screenshots / deep links): ?clip=Run&cam=side&t=0.3
const startClip = params.get('clip') || 'Idle';
play(startClip, 0);
setCamera(params.get('cam') || 'orbit');
if (params.has('t')) {
  mixer.update(0);
  current.time = Number(params.get('t')) * current.getClip().duration;
  paused = true;
  mixer.update(0);
  if (current.getClip().userData.speed) props.position.z = 0;
}
if (params.has('noui')) document.body.classList.add('noui');
window.__dbg = { sim, camera, S, actions };
requestAnimationFrame(frame);
setTimeout(() => { window.__done = true; }, 400);
