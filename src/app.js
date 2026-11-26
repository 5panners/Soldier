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

// ------------------------------------------------------------------ test course (play mode)
// Stairs, ramps, a steep slope and a patch of uneven ground, west of the spawn point.
// groundH(x, z) is the walkable height everywhere; foot IK and the character root use it.
function inCourse(x, z) { return x > -42 && x < -13 && z > -8 && z < 28; }
const TAN15 = Math.tan((15 * Math.PI) / 180), TAN25 = Math.tan((25 * Math.PI) / 180);
function roughH(x, z) {
  if (x < -40 || x > -31 || z < -6 || z > 26) return 0;
  const edge = Math.min(1, (x + 40) / 1.5, (-31 - x) / 1.5, (z + 6) / 1.5, (26 - z) / 1.5);
  const n = Math.sin(x * 1.7) * Math.cos(z * 1.3) * 0.6 + Math.sin(x * 0.6 + z * 0.8 + 1) * 0.4;
  return 0.35 * (0.5 + 0.5 * n) * Math.max(0, edge);
}
function groundH(x, z) {
  let h = roughH(x, z);
  // A: 15 deg ramp up -> platform -> stairs down (x -22..-18)
  if (x >= -22 && x <= -18) {
    if (z >= 0 && z < 5.6) h = Math.max(h, z * TAN15);
    else if (z >= 5.6 && z <= 8.4) h = Math.max(h, 1.5);
    else if (z > 8.4 && z < 11.4) h = Math.max(h, 1.5 - (Math.floor((z - 8.4) / 0.3) + 1) * 0.15);
  }
  // B: stairs up -> platform -> steep 25 deg slope down (x -28..-24)
  if (x >= -28 && x <= -24) {
    if (z >= 0 && z < 3) h = Math.max(h, Math.min(1.5, (Math.floor(z / 0.3) + 1) * 0.15));
    else if (z >= 3 && z <= 5) h = Math.max(h, 1.5);
    else if (z > 5 && z < 5 + 1.5 / TAN25) h = Math.max(h, 1.5 - (z - 5) * TAN25);
  }
  return h;
}
const course = new THREE.Group();
{
  const concrete = new THREE.MeshStandardMaterial({ color: '#9a948a', flatShading: true, roughness: 0.95 });
  const edgeMat = new THREE.MeshStandardMaterial({ color: '#7f796f', flatShading: true, roughness: 0.95 });
  const dirt = new THREE.MeshStandardMaterial({ color: '#7d7556', flatShading: true, roughness: 1 });
  const box = (x0, x1, z0, z1, h, m = concrete) => {
    if (h <= 0.001) return;
    const b = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, h, z1 - z0), m);
    b.position.set((x0 + x1) / 2, h / 2, (z0 + z1) / 2); course.add(b);
  };
  const wedge = (x0, x1, z0, z1, hz0, hz1) => { // solid block with a slanted top: hz0 at z0 -> hz1 at z1
    const g = new THREE.BoxGeometry(x1 - x0, 1, z1 - z0);
    const pa = g.attributes.position;
    for (let i = 0; i < pa.count; i++) {
      const lz = pa.getZ(i) + (z1 - z0) / 2, t = lz / (z1 - z0);
      pa.setY(i, pa.getY(i) > 0 ? hz0 + (hz1 - hz0) * t : 0);
    }
    g.translate((x0 + x1) / 2, 0, (z0 + z1) / 2);
    g.computeVertexNormals();
    course.add(new THREE.Mesh(g, concrete));
  };
  // A
  wedge(-22, -18, 0, 5.6, 0, 1.5); box(-22, -18, 5.6, 8.4, 1.5);
  for (let i = 0; i < 10; i++) box(-22, -18, 8.4 + i * 0.3, 8.7 + i * 0.3, 1.5 - (i + 1) * 0.15, i % 2 ? concrete : edgeMat);
  // B
  for (let i = 0; i < 10; i++) box(-28, -24, i * 0.3, (i + 1) * 0.3, (i + 1) * 0.15, i % 2 ? concrete : edgeMat);
  box(-28, -24, 3, 5, 1.5); wedge(-28, -24, 5, 5 + 1.5 / TAN25, 1.5, 0);
  // uneven ground patch
  const pg = new THREE.PlaneGeometry(9, 32, 54, 192); pg.rotateX(-Math.PI / 2); pg.translate(-35.5, 0, 10);
  const pa = pg.attributes.position;
  for (let i = 0; i < pa.count; i++) pa.setY(i, roughH(pa.getX(i), pa.getZ(i)) + 0.003);
  pg.computeVertexNormals();
  course.add(new THREE.Mesh(pg, dirt));
  course.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
}
scene.add(course);

// scattered low-poly props (for the play mode / sense of motion)
const props = new THREE.Group();
{
  const mat = new THREE.MeshStandardMaterial({ color: '#8d8a7c', flatShading: true, roughness: 1 });
  const crate = new THREE.MeshStandardMaterial({ color: '#7a6847', flatShading: true, roughness: 0.9 });
  let seed = 3; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 70; i++) {
    const r = 6 + rnd() * 40, a = rnd() * Math.PI * 2;
    if (inCourse(Math.cos(a) * r, Math.sin(a) * r)) { rnd(); rnd(); continue; } // keep the test course clear
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

// low walls to vault in play mode (1.0 m high, 25 cm thick, as authored in the Vault clip)
const WALLS = [];
{
  const mat = new THREE.MeshStandardMaterial({ color: '#8a8478', flatShading: true, roughness: 0.95 });
  const cap = new THREE.MeshStandardMaterial({ color: '#a39d90', flatShading: true });
  for (const [x, z, yaw, w] of [[0, 7, 0, 2.6], [-5, 13, 0.35, 3.0], [6, 4, -0.7, 2.4], [2, 16, 0.1, 3.2], [-7, 3, 1.2, 2.4]]) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(w, 0.96, 0.25), mat); body.position.y = 0.48;
    const top = new THREE.Mesh(new THREE.BoxGeometry(w + 0.04, 0.04, 0.29), cap); top.position.y = 0.98;
    g.add(body, top); g.position.set(x, 0, z); g.rotation.y = yaw;
    g.traverse((o) => { o.castShadow = o.receiveShadow = true; });
    props.add(g);
    WALLS.push({ g, x, z, yaw, half: w / 2 });
  }
}
// ------------------------------------------------------------------ hit boxes (collision)
// Every prop gets a collider: boxes (crates, walls) as oriented boxes, rocks as circles,
// target posts as thin circles. B toggles a wireframe view of them.
const COLLIDERS = [];
{
  props.updateMatrixWorld(true);
  for (const o of props.children) {
    if (o.isMesh && o.geometry.type === 'BoxGeometry') {
      const q = o.geometry.parameters;
      COLLIDERS.push({ type: 'box', x: o.position.x, z: o.position.z, hx: q.width / 2, hz: q.depth / 2, yaw: o.rotation.y, top: o.position.y + q.height / 2 });
    } else if (o.isMesh && o.geometry.type === 'DodecahedronGeometry') {
      const r = o.geometry.parameters.radius;
      COLLIDERS.push({ type: 'circle', x: o.position.x, z: o.position.z, r: r * 0.92, top: o.position.y + r });
    } else if (o.isGroup) {
      const w = WALLS.find((wl) => wl.g === o);
      if (w) COLLIDERS.push({ type: 'box', x: w.x, z: w.z, hx: w.half + 0.02, hz: 0.145, yaw: w.yaw, top: 1.0 });
      else COLLIDERS.push({ type: 'circle', x: o.position.x, z: o.position.z, r: 0.06, top: 1.7 }); // target post
    }
  }
}
const colliderViz = new THREE.Group(); colliderViz.visible = false; scene.add(colliderViz);
{
  const lm = new THREE.LineBasicMaterial({ color: '#ff5a36' });
  for (const c of COLLIDERS) {
    let geo;
    if (c.type === 'box') geo = new THREE.EdgesGeometry(new THREE.BoxGeometry(c.hx * 2, c.top, c.hz * 2));
    else geo = new THREE.EdgesGeometry(new THREE.CylinderGeometry(c.r, c.r, c.top, 12));
    const l = new THREE.LineSegments(geo, lm);
    l.position.set(c.x, c.top / 2, c.z); l.rotation.y = c.type === 'box' ? c.yaw : 0;
    colliderViz.add(l);
  }
}
const BODY_R = 0.32, STEP_MAX = 0.45;
function collide(p) {
  for (let it = 0; it < 3; it++) {
    for (const c of COLLIDERS) {
      const dx = p.x - c.x, dz = p.z - c.z;
      if (dx * dx + dz * dz > 25) continue;
      if (c.top - p.y < STEP_MAX * 0.6) continue; // low enough to step over
      if (c.type === 'circle') {
        const d = Math.hypot(dx, dz), m = c.r + BODY_R;
        if (d < m && d > 1e-6) { p.x = c.x + (dx / d) * m; p.z = c.z + (dz / d) * m; }
      } else {
        const cs = Math.cos(c.yaw), sn = Math.sin(c.yaw);
        const lx = dx * cs - dz * sn, lz = dx * sn + dz * cs; // world -> box local (inverse Ry)
        const qx = Math.max(-c.hx, Math.min(c.hx, lx)), qz = Math.max(-c.hz, Math.min(c.hz, lz));
        let ex = lx - qx, ez = lz - qz, d = Math.hypot(ex, ez), nx, nz, push;
        if (d > 1e-6) { if (d >= BODY_R) continue; nx = ex / d; nz = ez / d; push = BODY_R - d; }
        else { // centre inside the box: leave by the nearest face
          const px = c.hx - Math.abs(lx), pz = c.hz - Math.abs(lz);
          if (px < pz) { nx = Math.sign(lx) || 1; nz = 0; push = px + BODY_R; } else { nx = 0; nz = Math.sign(lz) || 1; push = pz + BODY_R; }
        }
        const nlx = lx + nx * push, nlz = lz + nz * push;
        p.x = c.x + nlx * cs + nlz * sn; p.z = c.z - nlx * sn + nlz * cs; // box local -> world (Ry)
      }
    }
  }
}

// the wall shown in the viewer while the Vault clip plays
const viewerWall = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.0, 0.25), new THREE.MeshStandardMaterial({ color: '#8a8478', flatShading: true }));
viewerWall.castShadow = viewerWall.receiveShadow = true;
viewerWall.visible = false;
scene.add(viewerWall);

// ------------------------------------------------------------------ soldier
const S = buildSoldier();
scene.add(S.group);
const skeletonHelper = new THREE.SkeletonHelper(S.group);
skeletonHelper.visible = false;
scene.add(skeletonHelper);

// ------------------------------------------------------------------ bounding boxes (option)
// One switch (the "Bounding boxes" checkbox, or B) shows every collider: the props' hit boxes
// (orange), the soldier's own per-limb hit boxes (cyan, attached to the bones), his overall
// bounding box (green) and the cylinder that collides with props (yellow).
const hitViz = new THREE.Group(); hitViz.visible = false; scene.add(hitViz);
const HITBOXES = [];
{
  const lm = new THREE.LineBasicMaterial({ color: '#38d6ff', depthTest: false, transparent: true, opacity: 0.9 });
  const add = (bone, size, center, dir = null) => { // axis-aligned box in the bone's bind frame (dir: rotate Y onto dir)
    const g = new THREE.BoxGeometry(size[0], size[1], size[2]);
    if (dir) g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize()));
    const l = new THREE.LineSegments(new THREE.EdgesGeometry(g), lm);
    l.matrixAutoUpdate = false; l.renderOrder = 10; l.frustumCulled = false;
    hitViz.add(l);
    HITBOXES.push({ bone, local: new THREE.Matrix4().makeTranslation(center[0], center[1], center[2]), l });
  };
  const seg = (a, b, r) => { // limb segment from bone a to bone b
    const d = BIND_LOCAL[b], len = d.length();
    add(a, [2 * r, len, 2 * r], [d.x / 2, d.y / 2, d.z / 2], d);
  };
  add('Head', [0.20, 0.25, 0.25], [0, 0.082, 0.01]);
  add('Spine2', [0.40, 0.32, 0.28], [0, 0.07, 0]);
  add('Spine', [0.36, 0.25, 0.26], [0, 0.06, 0]);
  add('Hips', [0.38, 0.20, 0.26], [0, -0.02, 0]);
  for (const sd of ['Left', 'Right']) {
    const s = sd === 'Left' ? 1 : -1;
    seg(`${sd}Arm`, `${sd}ForeArm`, 0.065);
    seg(`${sd}ForeArm`, `${sd}Hand`, 0.055);
    add(`${sd}Hand`, [0.12, 0.05, 0.10], [0.06 * s, 0, 0.0]);
    seg(`${sd}UpLeg`, `${sd}Leg`, 0.09);
    seg(`${sd}Leg`, `${sd}Foot`, 0.07);
    add(`${sd}Foot`, [0.11, 0.09, 0.28], [0, -0.04, 0.05]);
  }
  // overall bounding box (rebuilt every frame from the bone positions) and the prop-collision cylinder
  const bm = new THREE.LineBasicMaterial({ color: '#6dff6d', depthTest: false, transparent: true, opacity: 0.9 });
  hitViz.userData.box = new THREE.Box3();
  hitViz.userData.helper = new THREE.Box3Helper(hitViz.userData.box, '#6dff6d'); hitViz.userData.helper.material = bm; hitViz.userData.helper.frustumCulled = false; hitViz.userData.helper.renderOrder = 10;
  hitViz.add(hitViz.userData.helper);
  const cyl = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.CylinderGeometry(0.32, 0.32, 1.8, 20)), new THREE.LineBasicMaterial({ color: '#ffd23f', depthTest: false, transparent: true, opacity: 0.8 }));
  cyl.renderOrder = 10; cyl.frustumCulled = false; hitViz.userData.cyl = cyl; hitViz.add(cyl);
}
const _bp = new THREE.Vector3();
function updateHitViz() {
  colliderViz.position.copy(props.position); // the viewer scrolls the props past the soldier
  if (!hitViz.visible) return;
  S.group.updateMatrixWorld(true);
  for (const h of HITBOXES) { h.l.matrix.multiplyMatrices(S.bones[h.bone].matrixWorld, h.local); h.l.matrixWorldNeedsUpdate = true; }
  const box = hitViz.userData.box.makeEmpty();
  for (const n in S.bones) box.expandByPoint(S.bones[n].getWorldPosition(_bp));
  box.min.addScalar(-0.09); box.max.addScalar(0.09); box.min.y = Math.min(box.min.y, S.group.position.y);
  const cy = hitViz.userData.cyl; cy.position.set(S.group.position.x, S.group.position.y + 0.9, S.group.position.z);
}
function setBoundingBoxes(on) {
  colliderViz.visible = on; hitViz.visible = on;
  const cb = document.querySelector('#bbox'); if (cb) cb.checked = on;
}
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

/** Scatter half-angle (degrees) of a shot right now: tight when aimed and still, wide when moving fast. */
function spreadDeg() {
  const mf = Math.min(1, (sim.speed || 0) / 5.2);          // 0 standing .. 1 at full run speed
  const posture = sim.posture || 'stand';
  if (posture !== 'stand') return 0.05 + 0.4 * mf;
  if (sim.aim === 'ads') return 0.05 + 4.0 * mf;           // aimed fire suffers badly at a sprint
  return 1.2 + 2.5 * mf;                                   // hip fire is loose to begin with
}
function fireEffects() {
  S.group.updateMatrixWorld(true);
  const mp = new THREE.Vector3();
  let mq = new THREE.Quaternion();
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
  // the round leaves along the bore axis (the Muzzle node's +Z is the barrel's axis)
  let bore = new THREE.Vector3(0, 0, 1).applyQuaternion(mq);
  // accuracy: the further he moves while firing, the wider the scatter (aimed fire is the tightest)
  const sp = spreadDeg();
  if (sp > 0) {
    const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * deg(sp);
    const side = new THREE.Vector3(1, 0, 0).applyQuaternion(mq), up = new THREE.Vector3(0, 1, 0).applyQuaternion(mq);
    bore.addScaledVector(side, Math.cos(a) * Math.tan(r)).addScaledVector(up, Math.sin(a) * Math.tan(r)).normalize();
    mq = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), bore);
  }
  const hit = castRay(mp, bore);
  lastShot = { from: mp.clone(), dir: bore.clone(), hit: hit.point.clone(), t: performance.now() };
  if (Math.random() < 0.34) {
    const tr = new THREE.Mesh(tracerGeo, tracerMat.clone());
    tr.position.copy(mp); tr.quaternion.copy(mq);
    fx.add(tr);
    live.push({ o: tr, life: Math.min(0.35, hit.distance / 160), t: 0, vel: bore.clone().multiplyScalar(160) });
  }
  if (hit.object) impact(hit);
  // shell casing: ejected right, up and slightly back
  const ep = new THREE.Vector3(), eq = new THREE.Quaternion();
  ejectNode.getWorldPosition(ep); ejectNode.getWorldQuaternion(eq);
  const sh = new THREE.Mesh(shellGeo, shellMat);
  sh.position.copy(ep); sh.castShadow = true;
  const v = new THREE.Vector3(-2.6 - Math.random(), 1.6 + Math.random() * 0.8, -0.6 + Math.random() * 0.5).applyQuaternion(eq);
  fx.add(sh);
  live.push({ o: sh, life: 3.0, t: 0, vel: v, spin: new THREE.Vector3(Math.random() * 30, Math.random() * 30, 0), shell: true });
}
// bore-sight laser (L in play mode): drawn exactly along the barrel axis to where a round would land
const laserGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, 1)]);
const laser = new THREE.Line(laserGeo, new THREE.LineBasicMaterial({ color: '#ff3b24' }));
laser.frustumCulled = false; laser.visible = false;
scene.add(laser);

// ------------------------------------------------------------------ ballistics (hitscan along the bore)
const raycaster = new THREE.Raycaster();
let lastShot = null;
function castRay(origin, dir, far = 400) {
  raycaster.set(origin, dir); raycaster.far = far;
  const h = raycaster.intersectObjects([ground, props, course], true)[0];
  return h ? { point: h.point, distance: h.distance, object: h.object, normal: h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld) : new THREE.Vector3(0, 1, 0) }
    : { point: origin.clone().addScaledVector(dir, far), distance: far, object: null };
}
const holeGeo = new THREE.CircleGeometry(0.012, 6);
const holeMat = new THREE.MeshBasicMaterial({ color: '#141414', polygonOffset: true, polygonOffsetFactor: -2 });
const dustMat = new THREE.MeshStandardMaterial({ color: '#b5a98a', flatShading: true, transparent: true, opacity: 0.9 });
const dustGeo = new THREE.TetrahedronGeometry(0.03, 0);
function impact(hit) {
  const hole = new THREE.Mesh(holeGeo, holeMat);
  hole.position.copy(hit.point).addScaledVector(hit.normal, 0.002);
  hole.lookAt(hit.point.clone().add(hit.normal));
  fx.add(hole);
  live.push({ o: hole, life: 20, t: 0, keep: true });
  for (let i = 0; i < 6; i++) {
    const d = new THREE.Mesh(dustGeo, dustMat.clone());
    d.position.copy(hit.point);
    const v = hit.normal.clone().multiplyScalar(1.2 + Math.random()).add(new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.6, Math.random() - 0.5));
    fx.add(d);
    live.push({ o: d, life: 0.5, t: 0, vel: v, dust: true });
  }
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
    if (e.dust) e.vel.y -= 4 * dt;
    if (!e.shell && !e.keep && e.o.material) e.o.material.opacity = Math.max(0, 1 - e.t / e.life);
    if (e.t > e.life) { fx.remove(e.o); live.splice(i, 1); }
  }
}

// ------------------------------------------------------------------ foot IK on uneven ground
// The clips assume flat ground at the character root. Each frame in play mode: find the ground
// under each foot (heel and toe), drop the pelvis so the lower foot can reach, then two-bone IK
// each leg onto its ground and tilt planted feet to the slope.
const _up = new THREE.Vector3(0, 1, 0);
function groundNormal(x, z) {
  const e = 0.06;
  const n = new THREE.Vector3(groundH(x - e, z) - groundH(x + e, z), 2 * e, groundH(x, z - e) - groundH(x, z + e)).normalize();
  return n.angleTo(_up) > deg(28) ? _up.clone() : n; // step edges: keep the foot level
}
function footIK(dt) {
  const B = S.bones;
  S.group.updateMatrixWorld(true);
  const gy = S.group.position.y;
  const gq = new THREE.Quaternion(); S.group.getWorldQuaternion(gq);
  const info = {};
  for (const sd of ['Left', 'Right']) {
    const A = B[`${sd}Foot`].getWorldPosition(new THREE.Vector3());
    const toe = B[`${sd}ToeBase`].getWorldPosition(new THREE.Vector3());
    const heel = A.clone().add(A.clone().sub(toe).setY(0).normalize().multiplyScalar(0.06));
    // ground under heel, ankle and toe; anything more than a step above/below the root is a
    // ledge the foot can't use (it stays at the root's ground level instead)
    const gc = (h) => (Math.abs(h - gy) <= STEP_MAX ? h : gy);
    const g = Math.max(gc(groundH(heel.x, heel.z)), gc(groundH(A.x, A.z)), gc(groundH(toe.x, toe.z)));
    const lift = Math.min(A.y - 0.085, toe.y - 0.025) - gy; // sole height above the root ground in the clip
    info[sd] = { A, off: g - gy, plant: 1 - THREE.MathUtils.clamp(lift / 0.12, 0, 1), n: groundNormal(A.x, A.z), footQ: charQ(B[`${sd}Foot`]) };
  }
  const want = Math.min(0, info.Left.off, info.Right.off);
  sim.pelvisDrop = (sim.pelvisDrop || 0) + (want - (sim.pelvisDrop || 0)) * Math.min(1, dt * 14);
  B.Hips.position.y += sim.pelvisDrop;
  S.group.updateMatrixWorld(true);
  const l1 = BIND_LOCAL.LeftLeg.length(), l2 = BIND_LOCAL.LeftFoot.length();
  for (const sd of ['Left', 'Right']) {
    const I = info[sd];
    if (Math.abs(I.off - sim.pelvisDrop) < 0.002 && I.n.y > 0.999) continue;
    const root = toChar(B[`${sd}UpLeg`].getWorldPosition(new THREE.Vector3()));
    const knee = toChar(B[`${sd}Leg`].getWorldPosition(new THREE.Vector3()));
    const target = toChar(I.A.clone().add(new THREE.Vector3(0, I.off, 0)));
    // knee direction: the clip's own bend (correct in the sagittal plane, e.g. pointing down when the
    // heel is kicked up behind) with any sideways part removed, plus straight ahead so a nearly
    // straight leg has a stable pole. A pure "forward" pole fails when the hip-ankle line itself
    // runs forward/back (heel kick going downhill) and the knee splays out.
    const side = sd === 'Left' ? 1 : -1;
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(charQ(B.Hips)).setY(0).normalize();
    const lat = new THREE.Vector3(fwd.z, 0, -fwd.x);
    const ankC = toChar(B[`${sd}Foot`].getWorldPosition(new THREE.Vector3()));
    const axis = ankC.clone().sub(root).normalize();
    const bend = knee.clone().sub(root);
    bend.addScaledVector(axis, -bend.dot(axis));
    bend.addScaledVector(lat, -bend.dot(lat));
    const pole = bend.multiplyScalar(8).add(fwd).addScaledVector(lat, 0.04 * side).normalize();
    const ik = twoBoneIK(root, target, l1, l2, pole);
    const bindPole = new THREE.Vector3(0, 0, 1);
    const upQ = frameRotation(BIND_LOCAL[`${sd}Leg`].clone().normalize(), bindPole, ik.mid.clone().sub(root), ik.pp);
    const loQ = frameRotation(BIND_LOCAL[`${sd}Foot`].clone().normalize(), bindPole, ik.end.clone().sub(ik.mid), ik.pp);
    B[`${sd}UpLeg`].quaternion.copy(charQ(B.Hips).invert().multiply(upQ));
    B[`${sd}Leg`].quaternion.copy(upQ.clone().invert().multiply(loQ));
    // planted feet lie on the slope (ground normal into character space)
    const nChar = I.n.clone().applyQuaternion(gq.clone().invert());
    const tilt = new THREE.Quaternion().setFromUnitVectors(_up, nChar);
    const fq = qPow(tilt, I.plant).multiply(I.footQ);
    B[`${sd}Foot`].quaternion.copy(loQ.clone().invert().multiply(fq));
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
  const z = THREE.MathUtils.clamp(wrist.z + 0.045, 0.19, 0.37);
  // keep however far below the handguard the clip holds the hand (the aimed stances hold it low)
  const drop = THREE.MathUtils.clamp(leftGrip(z, 'cup').pos.y - wrist.y, 0, 0.08);
  const g = leftGrip(z, 'cup', drop);
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
let groundScroll = 0, groundScrollX = 0;
let lastClipTime = 0;
const GROUPS = [
  ['Locomotion', ['Idle', 'Walk', 'Run', 'Strafe_Left', 'Strafe_Right', 'ADS_Walk', 'ADS_Strafe_Left', 'ADS_Strafe_Right', 'HipFire_Walk', 'HipFire_Run', 'ADS_Run']],
  ['Weapon', ['ADS_Idle', 'HipFire_Idle', 'ADS_Fire', 'ADS_Fire_Auto', 'HipFire_Fire', 'HipFire_Fire_Auto']],
  ['Transitions', ['Idle_To_ADS', 'ADS_To_Idle', 'Idle_To_HipFire', 'HipFire_To_Idle', 'HipFire_To_ADS', 'ADS_To_HipFire']],
  ['Crouch', ['Crouch_Idle', 'Crouch_Walk', 'Crouch_ADS_Idle', 'Crouch_ADS_Walk', 'Crouch_ADS_Fire', 'Crouch_ADS_Fire_Auto', 'Stand_To_Crouch', 'Crouch_To_Stand', 'Crouch_To_Crouch_ADS', 'Crouch_ADS_To_Crouch']],
  ['Prone', ['Prone_Idle', 'Prone_Fire', 'Prone_Fire_Auto', 'Prone_Crawl', 'Stand_To_Prone', 'Prone_To_Stand']],
  ['Jump & vault', ['Jump', 'Walk_Jump', 'Walk_Jump_Left', 'Run_Jump', 'Run_Jump_Left', 'Jump_Start', 'Jump_Air', 'Jump_Land', 'Vault']],
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
  $('#bbox').onchange = (e) => setBoundingBoxes(e.target.checked);
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
    sim.yaw = sim.camYaw = 0; sim.jumping = false; sim.vault = null; sim.pendingLeap = null; sim.aim = 'none'; sim.lastAim = 'none'; sim.fire = false;
    sim.god = false; sim.posture = 'stand'; sim.wantPosture = null; sim.postureClip = null; sim.feetYaw = null; sim.turnStep = null; sim.pelvisDrop = 0; sim.falling = false; sim.vy = 0;
    viewerWall.visible = false;
    S.group.position.set(0, 0, 0); S.group.rotation.set(0, 0, 0);
    document.activeElement?.blur?.();
    groundScroll = 0; groundScrollX = 0; gtex.offset.set(0, 0); props.position.set(0, 0, 0);
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
  if (e.code === 'Space' && !sim.jumping && !sim.vault && (sim.posture || 'stand') === 'stand' && !sim.postureClip) {
    const v = vaultableWall();
    if (v) startVault(v);
    else if ((sim.base === 'Run' || sim.base === 'Walk') && actions[sim.base].getEffectiveTimeScale() > 0 && (keys.KeyW)) {
      if (!startLeapNow(sim.base)) sim.pendingLeap = sim.base; // else leap on the next footfall
    }
    else startJump(); // two-footed standing jump only from a standstill
  }
  if (e.code === 'KeyV') { sim.eye = !sim.eye; if (sim.eye) sim.god = false; }
  if (e.code === 'KeyG') {
    sim.god = !sim.god;
    if (sim.god) { // start from the current chase view, then orbit freely
      sim.eye = false;
      sim.godYaw = sim.yaw; sim.godPitch = 0.25; sim.godDist = 3.2 * (sim.zoom || 1);
      sim.godTarget = 1.0;
    }
  }
  if (e.code === 'KeyL') sim.laser = !sim.laser;
  if (e.code === 'KeyB') setBoundingBoxes(!colliderViz.visible);
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
  if (e.button === 2) sim.aim = sim.aim === 'ads' ? 'none' : 'ads'; // right click toggles aim down sights
});
window.addEventListener('mouseup', (e) => {
  if (e.button === 0) sim.fire = false;
});
renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());
// mouse wheel: orbit radius in play mode (0.5x .. 4x of the default distance)
renderer.domElement.addEventListener('wheel', (e) => {
  if (mode !== 'play') return;
  e.preventDefault();
  if (sim.god) { sim.godDist = THREE.MathUtils.clamp(sim.godDist * Math.exp(e.deltaY * 0.0012), 0.6, 25); return; }
  sim.zoom = THREE.MathUtils.clamp((sim.zoom || 1) * Math.exp(e.deltaY * 0.0012), 0.5, 4);
}, { passive: false });
window.addEventListener('mousemove', (e) => {
  if (mode !== 'play') return;
  const locked = document.pointerLockElement === renderer.domElement;
  if (!locked && !(e.buttons & 4)) return;
  if (sim.god) { // god cam: the mouse only orbits the camera, the soldier is not turned
    sim.godYaw -= e.movementX * 0.005;
    sim.godPitch = THREE.MathUtils.clamp(sim.godPitch + e.movementY * 0.005, -1.45, 1.45);
    return;
  }
  // shooter-style mouse look: X turns the soldier (camera locked behind him), Y tilts the view
  if (!sim.vault && !sim.postureClip) sim.yaw -= e.movementX * 0.0022 * (sim.aim === 'ads' || sim.eye ? 0.55 : 1) * ((sim.posture || 'stand') === 'prone' ? 0.5 : 1);
  sim.camPitch = THREE.MathUtils.clamp(sim.camPitch + e.movementY * 0.002, -0.3, 0.6);
});

/** Find a wall in front of the soldier that can be vaulted; returns the aligned start pose. */
function vaultableWall() {
  const P = S.group.position, f = new THREE.Vector3(Math.sin(sim.yaw), 0, Math.cos(sim.yaw));
  const V = DEFS.Vault.obstacle;
  for (const w of WALLS) {
    let n = new THREE.Vector3(Math.sin(w.yaw), 0, Math.cos(w.yaw)); // wall normal
    const rel = P.clone().sub(new THREE.Vector3(w.x, 0, w.z));
    if (rel.dot(n) > 0) n.negate(); // approach from either side: n points from the soldier into the wall
    const t = new THREE.Vector3(n.z, 0, -n.x);
    const lateral = rel.dot(t), dist = -rel.dot(n) - V.wallThickness / 2; // to the near face
    if (Math.abs(lateral) > w.half - 0.35 || dist < 0.2 || dist > 2.0 || f.dot(n) < Math.cos(deg(40))) continue;
    const face = new THREE.Vector3(w.x, 0, w.z).addScaledVector(n, -V.wallThickness / 2).addScaledVector(t, lateral);
    return { start: face.addScaledVector(n, -V.wallFront), yaw: Math.atan2(n.x, n.z), n };
  }
  return null;
}
function startVault(v) {
  sim.vault = { from: S.group.position.clone(), to: v.start, yaw0: sim.yaw, yaw1: v.yaw, n: v.n, t: 0 };
  const a = actions.Vault;
  a.reset(); a.setEffectiveWeight(1); a.setEffectiveTimeScale(1); a.play();
  (sim.base ? actions[sim.base] : current).crossFadeTo(a, 0.1, false);
  sim.base = 'Vault'; current = a;
}
function updateVault(dt) {
  const v = sim.vault;
  v.t += dt;
  const k = Math.min(1, v.t / 0.22); // ease into the authored take-off spot over the first steps
  const e = k * k * (3 - 2 * k);
  S.group.position.lerpVectors(v.from, v.to, e);
  sim.yaw = v.yaw0 + wrapAngle(v.yaw1 - v.yaw0) * e;
  S.group.rotation.y = sim.yaw;
  sim.speed = 0;
}

/**
 * Cut straight into a leap mid-stride. The leap clips begin with exactly the same steps as
 * the Walk/Run cycle, so if the take-off foot is still on the ground we can enter the leap
 * at the matching time with no visible change. Returns false if that foot has already left
 * the ground (then the leap starts at the next heel strike, a fraction of a second later).
 */
function startLeapNow(baseName) {
  const loco = actions[baseName], dur = loco.getClip().duration, f = loco.time / dur;
  const right = f < 0.5; // phase 0 = right heel strike, 0.5 = left heel strike
  const name = right ? `${baseName}_Jump` : `${baseName}_Jump_Left`;
  const offset = ((f - DEFS[name].startPhase + 1) % 1) * dur; // time since that heel strike
  if (offset > DEFS[name].events.takeoff - 0.03) return false;
  const a = actions[name];
  a.reset(); a.setEffectiveWeight(1); a.setEffectiveTimeScale(1); a.play();
  a.time = offset;
  loco.crossFadeTo(a, 0.05, false);
  sim.base = name; current = a; sim.jumping = 'leap'; sim.leapBase = baseName; sim.pendingLeap = null;
  return true;
}

/** Keep the character root on the ground: eases up steps/slopes, falls off tall ledges. */
function followGround(dt) {
  const p = S.group.position, f = new THREE.Vector3(Math.sin(sim.yaw), 0, Math.cos(sim.yaw));
  // average a little ahead and behind so stairs give a smooth climb of the pelvis
  // (samples beyond a ledge - more than a step away from the centre height - are ignored)
  const c = groundH(p.x, p.z);
  const near = (h) => (Math.abs(h - c) <= STEP_MAX ? h : c);
  const g = (c * 2 + near(groundH(p.x + f.x * 0.2, p.z + f.z * 0.2)) + near(groundH(p.x - f.x * 0.2, p.z - f.z * 0.2))) / 4;
  const gMax = Math.max(c, g);
  if (p.y - gMax > 0.5 || sim.falling) {
    sim.falling = true; sim.vy = (sim.vy || 0) - 9.81 * dt; p.y += sim.vy * dt;
    if (p.y <= g) { p.y = g; sim.vy = 0; sim.falling = false; }
  } else { p.y += (g - p.y) * Math.min(1, dt * 14); sim.vy = 0; }
}

function startJump() {
  sim.jumping = true;
  const a = actions.Jump;
  a.reset(); a.setEffectiveWeight(1); a.setEffectiveTimeScale(1); a.play();
  (sim.base ? actions[sim.base] : current).crossFadeTo(a, 0.06, false);
  sim.base = 'Jump'; current = a;
}
mixer.addEventListener('finished', (e) => {
  if (mode === 'play' && e.action === actions.Jump) { sim.jumping = false; sim.base = 'Jump'; }
  if (mode === 'play' && sim.jumping === 'leap' && /_Jump(_Left)?$/.test(e.action.getClip().name)) {
    // hand straight back to the walk/run cycle at the phase the leap ended on
    const end = DEFS[e.action.getClip().name].endPhase, loco = actions[sim.leapBase];
    sim.jumping = false;
    loco.reset(); loco.setEffectiveWeight(1); loco.setEffectiveTimeScale(1); loco.play();
    loco.time = end * loco.getClip().duration;
    e.action.crossFadeTo(loco, 0.06, false);
    sim.base = sim.leapBase; current = loco;
  }
  if (mode === 'play' && e.action === actions.Vault && sim.vault) {
    // the clip carries the body 2.5 m forward (root motion in Hips): move the character there
    const adv = DEFS.Vault.rootMotion.z;
    S.group.position.copy(sim.vault.to).addScaledVector(sim.vault.n, adv);
    sim.vault = null;
    setBase('Idle', 0);
    mixer.update(0);
  }
});

const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
// one-shot posture changes (body locked until they finish)
const POSTURE_T = {
  'stand>crouch': 'Stand_To_Crouch', 'crouch>stand': 'Crouch_To_Stand',
  'stand>prone': 'Stand_To_Prone', 'prone>stand': 'Prone_To_Stand',
  'crouch>prone': 'Stand_To_Prone', 'prone>crouch': 'Prone_To_Stand',
};
function updatePlay(dt) {
  if (sim.vault) { updateVault(dt); return; }
  // queued walking/running leap: start it exactly at the next heel strike so the stride lines up
  if (sim.pendingLeap) {
    const baseName = sim.pendingLeap, loco = actions[baseName], f0 = loco.time / loco.getClip().duration, prev = sim.lastLocoPhase ?? f0;
    const crossed = (a, b, x) => (a <= b ? a < x && b >= x : a < x || b >= x);
    if (sim.base !== baseName) sim.pendingLeap = null;
    else if (crossed(prev, f0, 0.5) || crossed(prev, f0, 0.999999)) {
      const name = crossed(prev, f0, 0.5) ? `${baseName}_Jump_Left` : `${baseName}_Jump`;
      const a = actions[name];
      a.reset(); a.setEffectiveWeight(1); a.setEffectiveTimeScale(1); a.play();
      // begin the leap as far in as the cycle has already gone past the heel strike
      a.time = Math.max(0, ((f0 - DEFS[name].startPhase + 1) % 1) * loco.getClip().duration);
      loco.crossFadeTo(a, 0.05, false);
      sim.base = name; current = a; sim.jumping = 'leap'; sim.leapBase = baseName; sim.pendingLeap = null;
    }
    sim.lastLocoPhase = f0;
  } else sim.lastLocoPhase = undefined;
  // chase camera: up/down arrows (or the mouse) tilt the view; it never orbits around him
  const orbitY = (keys.ArrowDown ? 1 : 0) - (keys.ArrowUp ? 1 : 0);
  if (sim.god) { // god cam: arrows orbit all the way round, R / F raise and lower the look-at point
    sim.godYaw += ((keys.ArrowLeft ? 1 : 0) - (keys.ArrowRight ? 1 : 0)) * 1.6 * dt;
    sim.godPitch = THREE.MathUtils.clamp(sim.godPitch + orbitY * 1.1 * dt, -1.45, 1.45);
    sim.godTarget = THREE.MathUtils.clamp(sim.godTarget + ((keys.KeyR ? 1 : 0) - (keys.KeyF ? 1 : 0)) * 1.0 * dt, 0.1, 2.2);
  } else if (orbitY) sim.camPitch = THREE.MathUtils.clamp(sim.camPitch + orbitY * 1.1 * dt, -0.3, 0.6);
  // desired movement in camera frame
  const f = (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0);
  const r = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0);
  // W/S forward/back and A/D strafe, all relative to the soldier's own facing; Q/E turn him.
  // The camera never steers him. (Prone: A/D turn, since there is no prone strafe.)
  const moving = f !== 0 || (r !== 0 && (sim.posture || 'stand') !== 'prone');
  const posture = sim.posture || 'stand';
  const run = (keys.ShiftLeft || keys.ShiftRight) && (sim.aim === 'none' || sim.aim === 'hip') && f > 0 && posture === 'stand';
  // Shift while aiming down the sights: move at full speed (the rifle stays up, but accuracy suffers)
  const adsRun = (keys.ShiftLeft || keys.ShiftRight) && sim.aim === 'ads' && posture === 'stand';
  let aimMode = sim.fire && sim.aim === 'none' ? 'hip' : sim.aim;
  if (posture !== 'stand' && aimMode === 'hip') aimMode = 'ads'; // crouched/prone fire from the shoulder
  if (posture === 'prone') aimMode = 'ads';

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

  let clip, speed = 0, timeScale = 1, lowerYaw = 0, moveOff = 0;
  const P = { stand: { idle: 'Idle', walk: 'Walk', ads: 'ADS_Idle', adsWalk: 'ADS_Walk', hip: 'HipFire_Idle', hipWalk: 'HipFire_Walk' },
    crouch: { idle: 'Crouch_Idle', walk: 'Crouch_Walk', ads: 'Crouch_ADS_Idle', adsWalk: 'Crouch_ADS_Walk', hip: 'Crouch_ADS_Idle', hipWalk: 'Crouch_ADS_Walk' },
    prone: { idle: 'Prone_Idle', walk: 'Prone_Crawl', ads: 'Prone_Idle', adsWalk: 'Prone_Crawl', hip: 'Prone_Idle', hipWalk: 'Prone_Crawl' } }[posture];
  if (!sim.jumping) {
    const turnRate = posture === 'prone' ? 0.9 : run ? 1.6 : aimMode !== 'none' ? 1.6 : 2.2;
    const turn = ((keys.KeyE ? 1 : 0) - (keys.KeyQ ? 1 : 0)) + (posture === 'prone' ? r : 0);
    if (turn !== 0 && !sim.postureClip) sim.yaw -= turn * turnRate * dt;
    const back = f < 0;
    const strafeOnly = f === 0 && r !== 0 && posture !== 'prone';
    const diag = f !== 0 && r !== 0 && posture !== 'prone';
    // moveOff: travel direction relative to facing (+ = left); diagonal walks turn the pelvis
    if (strafeOnly) moveOff = r > 0 ? -Math.PI / 2 : Math.PI / 2;
    else if (diag) { moveOff = (f > 0 ? -r : r) * deg(45); lowerYaw = moveOff; }
    if (posture === 'prone') {
      if (f !== 0) { clip = P.walk; speed = DEFS[clip].speed; if (back) timeScale = -1; }
      else clip = P.idle;
    } else if (strafeOnly && posture === 'stand' && aimMode === 'ads' && adsRun) {
      // aiming at full speed: sprint sideways with the hips turned into the travel direction
      clip = 'ADS_Run';
      moveOff = (r > 0 ? -1 : 1) * deg(85); lowerYaw = moveOff;
      speed = DEFS[clip].speed;
    } else if (strafeOnly && posture === 'stand' && aimMode === 'ads') {
      // aiming: careful side-step shuffle
      clip = `ADS_Strafe_${r > 0 ? 'Right' : 'Left'}`;
      speed = DEFS[clip].speed;
    } else if (strafeOnly && posture === 'stand') {
      // walking / running strafe: the walk (or run with Shift) with the hips turned into the
      // direction of travel and the chest still facing forward, like a running strafe
      const runStrafe = (keys.ShiftLeft || keys.ShiftRight) && aimMode !== 'ads';
      clip = runStrafe ? (aimMode === 'hip' ? 'HipFire_Run' : 'Run') : aimMode === 'hip' ? P.hipWalk : P.walk;
      moveOff = (r > 0 ? -1 : 1) * deg(85); lowerYaw = moveOff;
      speed = DEFS[clip].speed;
    } else if (strafeOnly) {
      // crouched: crouch-walk with the pelvis turned sideways (no dedicated crouch strafe)
      clip = aimMode !== 'none' ? P.adsWalk : P.walk;
      lowerYaw = moveOff * 0.85; speed = DEFS[clip].speed;
    } else if (aimMode !== 'none') {
      if (moving) {
        // firing from the hip keeps the full walking / running speed
        clip = aimMode === 'ads' ? (adsRun && f >= 0 ? 'ADS_Run' : P.adsWalk) : run && posture === 'stand' ? 'HipFire_Run' : P.hipWalk;
        speed = DEFS[clip].speed; if (back) timeScale = -1;
      } else clip = aimMode === 'ads' ? P.ads : P.hip;
    } else if (moving) {
      clip = run ? 'Run' : P.walk;
      speed = DEFS[clip].speed; if (back) timeScale = -1;
    } else clip = P.idle;
    const prevAim = sim.lastAim || 'none';
    // standing / crouched mode changes use the authored transition clips
    const tname = posture === 'stand'
      ? { 'none>ads': 'Idle_To_ADS', 'ads>none': 'ADS_To_Idle', 'none>hip': 'Idle_To_HipFire', 'hip>none': 'HipFire_To_Idle', 'hip>ads': 'HipFire_To_ADS', 'ads>hip': 'ADS_To_HipFire' }[`${prevAim}>${aimMode}`]
      : posture === 'crouch' ? { 'none>ads': 'Crouch_To_Crouch_ADS', 'ads>none': 'Crouch_ADS_To_Crouch' }[`${prevAim}>${aimMode}`] : null;
    if (tname && !moving && [P.idle, P.ads, P.hip].includes(sim.base)) setBase(tname, 0.08);
    sim.lastAim = aimMode;
    const inTransition = sim.base && sim.base.includes('_To_') && actions[sim.base].isRunning() && !moving;
    // turning on the spot: the feet stay planted while the upper body turns; past ~55 deg
    // he takes a couple of quick steps to bring the feet round (no ice-skating pivot)
    if (!moving && posture !== 'prone' && !inTransition) {
      if (sim.feetYaw === undefined || sim.feetYaw === null) sim.feetYaw = sim.yaw;
      let d = wrapAngle(sim.feetYaw - sim.yaw);
      if (!sim.turnStep && Math.abs(d) > deg(55)) sim.turnStep = { t: 0, from: sim.feetYaw };
      if (sim.turnStep) {
        const ts = sim.turnStep; ts.t += dt;
        const k = Math.min(1, ts.t / 0.38), e = k * k * (3 - 2 * k);
        sim.feetYaw = ts.from + wrapAngle(sim.yaw - ts.from) * e;
        d = wrapAngle(sim.feetYaw - sim.yaw);
        // stepping feet: a short burst of the walk cycle (no travel)
        clip = aimMode === 'ads' ? P.adsWalk : aimMode === 'hip' ? P.hipWalk : P.walk;
        timeScale = 0.9;
        if (k >= 1) sim.turnStep = null;
      }
      sim.lowerYaw = THREE.MathUtils.clamp(d, -deg(70), deg(70));
      lowerYaw = sim.lowerYaw;
    } else { sim.feetYaw = sim.yaw + sim.lowerYaw; sim.turnStep = null; }
    // momentum: playback rate follows the actual ground speed while speeding up / slowing
    // down, so the feet stay locked to the ground through starts, stops and walk<->run
    if (!inTransition && DEFS[clip] && DEFS[clip].speed && speed > 0) {
      timeScale *= THREE.MathUtils.clamp(Math.max(sim.speed, 0.25 * speed) / DEFS[clip].speed, 0.3, 1.0);
    }
    if (!inTransition) setBase(clip, 0.22, timeScale);
  } else {
    // running leap keeps the run speed (its planted feet move at exactly that speed);
    // the standing jump is done on the spot, so the feet never slide
    speed = sim.jumping === 'leap' ? DEFS[sim.leapBase].speed : 0;
  }
  sim.lowerYaw += (lowerYaw - sim.lowerYaw) * Math.min(1, dt * 10);
  sim.moveOff = (sim.moveOff || 0) + wrapAngle(moveOff - (sim.moveOff || 0)) * Math.min(1, dt * 12);
  sim.speed += (speed - sim.speed) * Math.min(1, dt * 6);
  const dirYaw = sim.yaw + sim.moveOff + (timeScale < 0 ? Math.PI : 0);
  const prevPos = S.group.position.clone();
  S.group.position.x += Math.sin(dirYaw) * sim.speed * dt;
  S.group.position.z += Math.cos(dirYaw) * sim.speed * dt;
  collide(S.group.position);
  // ledges taller than a step block him (slide along them on the free axis)
  const gNow = groundH(prevPos.x, prevPos.z);
  if (groundH(S.group.position.x, S.group.position.z) - gNow > STEP_MAX && !sim.jumping) {
    const tryX = groundH(S.group.position.x, prevPos.z) - gNow <= STEP_MAX, tryZ = groundH(prevPos.x, S.group.position.z) - gNow <= STEP_MAX;
    if (tryX) S.group.position.z = prevPos.z; else if (tryZ) S.group.position.x = prevPos.x; else { S.group.position.x = prevPos.x; S.group.position.z = prevPos.z; }
  }
  followGround(dt);
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
    if (sim.fireTimer <= 0) { sim.pendingShots = (sim.pendingShots || 0) + 1; sim.fireTimer += 60 / 700; }
  }
}
const deg = (d) => (d * Math.PI) / 180;
const smoother01 = (x) => x * x * x * (x * (x * 6 - 15) + 10);

// ------------------------------------------------------------------ aim: barrel onto the crosshair
// The camera's centre ray picks the aim point; the upper body (Spine1 + Spine2, so arms, rifle
// and head move as one and the cheek weld is kept) is rotated until the bore axis passes
// exactly through that point. Rounds are then cast along the bore, so the barrel, the
// crosshair and the bullet path all coincide.
const _aim = { point: new THREE.Vector3(), err: 0 };
function aimTarget() {
  const dir = new THREE.Vector3();
  if (sim.eye && eyeThroughSight()) {
    // looking through the optic: aim along the camera yaw/pitch from the eye
    dir.set(Math.sin(sim.camYaw) * Math.cos(sim.camPitch), -Math.sin(sim.camPitch), Math.cos(sim.camYaw) * Math.cos(sim.camPitch));
    const eye = RIGHT_EYE_LOCAL.clone().applyMatrix4(S.bones.Head.matrixWorld);
    return castRay(eye, dir.normalize()).point;
  }
  camera.getWorldDirection(dir);
  return castRay(camera.position.clone(), dir).point;
}
function boreRay() {
  S.group.updateMatrixWorld(true);
  const p = muzzleNode.getWorldPosition(new THREE.Vector3());
  const q = muzzleNode.getWorldQuaternion(new THREE.Quaternion());
  return { p, d: new THREE.Vector3(0, 0, 1).applyQuaternion(q) };
}
function rotateBoneWorld(bone, C) {
  const parentQ = bone.parent.getWorldQuaternion(new THREE.Quaternion());
  const cur = bone.getWorldQuaternion(new THREE.Quaternion());
  bone.quaternion.copy(parentQ.invert().multiply(C.clone().multiply(cur)));
}
function aimWeapon(weight, maxAngle) {
  if (weight <= 0.001) return;
  S.group.updateMatrixWorld(true);
  const target = aimTarget();
  _aim.point.copy(target);
  for (let i = 0; i < 4; i++) {
    const { p, d } = boreRay();
    const want = target.clone().sub(p).normalize();
    let C = new THREE.Quaternion().setFromUnitVectors(d, want);
    const ang = 2 * Math.acos(Math.min(1, Math.abs(C.w)));
    if (ang > maxAngle) C = qPow(C, maxAngle / ang);
    if (weight < 1) C = qPow(C, weight);
    if (i === 0) { rotateBoneWorld(S.bones.Spine1, qPow(C, 0.45)); rotateBoneWorld(S.bones.Spine2, qPow(C, 0.55)); }
    else rotateBoneWorld(S.bones.Spine2, C);
  }
  const { p, d } = boreRay();
  _aim.err = d.angleTo(target.clone().sub(p).normalize());
}

function applyLowerBodyYaw() {
  // rotate the pelvis toward the move direction while the chest keeps aiming
  const th = sim.lowerYaw;
  if (Math.abs(th) < 1e-4) return;
  const B = S.bones;
  const ry = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), th);
  const qh = B.Hips.quaternion.clone();
  const qs = qh.clone().multiply(B.Spine.quaternion); // Spine orientation in character space
  B.Hips.quaternion.premultiply(ry);
  // counter-rotate the torso so everything above the pelvis stays put, shared between Spine
  // and Spine1 so the waist twists smoothly instead of kinking at one joint
  const half = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -th / 2);
  B.Spine.quaternion.premultiply(qh.clone().invert().multiply(half).multiply(qh));
  B.Spine1.quaternion.premultiply(qs.clone().invert().multiply(half).multiply(qs));
  B.Hips.position.applyAxisAngle(new THREE.Vector3(0, 1, 0), th);
}

/** Eye view goes through the optic only while the rifle is actually shouldered and aimed. */
function eyeThroughSight() {
  const posture = sim.posture || 'stand';
  if (sim.postureClip || sim.vault || sim.jumping) return false;
  if (posture === 'prone') return (sim.speed || 0) < 0.05; // crawling: rifle is cradled
  return sim.aim === 'ads';
}
function updatePlayCamera(dt) {
  const B = S.bones;
  S.group.updateMatrixWorld(true);
  if (sim.god) {
    const pivot = S.group.position.clone().add(new THREE.Vector3(0, sim.godTarget, 0));
    const cp = Math.cos(sim.godPitch), d = sim.godDist;
    const want = pivot.clone().add(new THREE.Vector3(Math.sin(sim.godYaw) * cp * d, Math.sin(sim.godPitch) * d, Math.cos(sim.godYaw) * cp * d));
    want.y = Math.max(want.y, S.group.position.y + 0.05, groundH(want.x, want.z) + 0.1);
    camera.position.lerp(want, 1 - Math.exp(-dt * 20));
    camera.lookAt(pivot);
    camera.fov += (45 - camera.fov) * Math.min(1, dt * 8); camera.near = 0.05; camera.updateProjectionMatrix();
    return;
  }
  if (sim.eye) {
    const eye = RIGHT_EYE_LOCAL.clone().applyMatrix4(B.Head.matrixWorld);
    camera.position.copy(eye);
    if (eyeThroughSight()) {
      // aiming down sights: look through the optic along the rifle
      const rq = new THREE.Quaternion(); S.rifle.getWorldQuaternion(rq);
      camera.quaternion.copy(rq).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI));
      camera.fov = 32;
    } else {
      // not aiming: first-person view from the eyes, looking ahead where the camera points
      // (eye level between both eyes, slightly forward so the face doesn't fill the view)
      const mid = new THREE.Vector3(0, 0.083, 0.135).applyMatrix4(B.Head.matrixWorld);
      camera.position.copy(mid);
      const dir = new THREE.Vector3(Math.sin(sim.camYaw) * Math.cos(sim.camPitch), -Math.sin(sim.camPitch), Math.cos(sim.camYaw) * Math.cos(sim.camPitch));
      camera.lookAt(mid.clone().add(dir));
      camera.fov = 70;
    }
    camera.near = eyeThroughSight() ? 0.07 : 0.04; camera.updateProjectionMatrix(); // clip the helmet brim; the optic is ~0.28 m away
    return;
  }
  const fovWant = sim.aim === 'ads' ? 30 : sim.base === 'Run' || sim.base === 'HipFire_Run' || sim.base === 'ADS_Run' || sim.base === 'Run_Jump' || sim.base === 'Run_Jump_Left' ? 48 : 42;
  camera.fov += (fovWant - camera.fov) * Math.min(1, dt * 6); camera.near = 0.02; camera.updateProjectionMatrix();
  const dist = (sim.aim === 'ads' ? 2.1 : 2.6) * (sim.zoom || 1); // mouse wheel scales the orbit radius
  const side = sim.aim === 'ads' ? -0.75 : -0.55;
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
    if (!sim.vault && !sim.falling && (sim.posture || 'stand') !== 'prone') footIK(dt);
    else if (sim.falling) sim.pelvisDrop = 0;
    // chase camera: locked behind the soldier (eases only while a vault re-aligns him)
    sim.camYaw = sim.vault ? sim.camYaw + wrapAngle(sim.yaw - sim.camYaw) * Math.min(1, dt * 8) : sim.yaw;
    updatePlayCamera(dt);
    const posture = sim.posture || 'stand';
    const aiming = !sim.jumping && !sim.vault && !sim.postureClip && (sim.aim !== 'none' || sim.fire || posture === 'prone') && !(posture === 'prone' && sim.speed > 0.05);
    sim.aimBlend = THREE.MathUtils.clamp((sim.aimBlend || 0) + (aiming ? dt : -dt) / 0.18, 0, 1);
    aimWeapon(smoother01(sim.aimBlend), posture === 'prone' ? deg(25) : deg(65));
  } else if (!paused) {
    mixer.update(dt);
  }
  if (ikFix) leftHandIK();
  updateHitViz();
  if (mode === 'play') {
    if (sim.eye) updatePlayCamera(dt); // the optic view follows the final, aimed rifle
    while (sim.pendingShots > 0) { fireEffects(); sim.pendingShots--; }
    document.body.classList.toggle('eyeview', (!!sim.eye && eyeThroughSight()) || !!sim.god);
    // reticle opens up with the scatter so the accuracy loss is visible
    const sp = spreadDeg(), rv = $('#reticle');
    const px = Math.max(6, (2 * Math.tan(deg(sp)) / (2 * Math.tan(deg(camera.fov / 2)))) * renderer.domElement.clientHeight);
    if (sp > 0.5) { rv.style.width = rv.style.height = `${px.toFixed(0)}px`; rv.style.margin = `${(-px / 2).toFixed(1)}px`; rv.style.background = 'transparent'; rv.style.border = '1.5px solid rgba(255,255,255,.7)'; }
    else { rv.style.width = rv.style.height = '6px'; rv.style.margin = '-3px'; rv.style.background = 'rgba(255,255,255,.7)'; rv.style.border = '0'; }
    laser.visible = sim.laser;
    if (sim.laser) {
      const { p, d } = boreRay();
      const h = castRay(p, d);
      laserGeo.setFromPoints([p, h.point]);
    }
  } else laser.visible = false;

  if (mode === 'view' && current) {
    const clip = current.getClip();
    viewerWall.visible = clip.name === 'Vault';
    if (viewerWall.visible) { const o = clip.userData.obstacle; viewerWall.position.set(0, o.wallHeight / 2, o.wallFront + o.wallThickness / 2); }
    // scroll the ground for in-place locomotion so planted feet stay locked to it
    if ($('#scroll').checked && clip.userData.speed && !paused) {
      const ts = current.getEffectiveTimeScale(), d = clip.userData.speed * dt * ts * current.getEffectiveWeight();
      if (clip.userData.strafe) groundScrollX += (clip.userData.strafe === 'left' ? 1 : -1) * d;
      else groundScroll += d;
    }
    // plane local +Y maps to world -Z, so the texture offset has the opposite sign of the props
    gtex.offset.y = -groundScroll / 2; // texture tile = 120/60 = 2 m
    gtex.offset.x = groundScrollX / 2;
    props.position.z = -groundScroll;
    props.position.x = -groundScrollX;
    // effects for fire clips
    const t = current.time;
    for (const s of clip.userData.shots || []) if ((lastClipTime < s && t >= s) || (t < lastClipTime && s <= t)) fireEffects();
    lastClipTime = t;
    $('#time').value = clip.duration > 0.05 ? (t / clip.duration) : 0;
  }
  if (mode !== 'play') controls.update();
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
window.__dbg = { sim, camera, S, actions, aim: _aim, boreRay, lastShot: () => lastShot };
requestAnimationFrame(frame);
setTimeout(() => { window.__done = true; }, 400);
