// Generic 5.56 carbine (original low-poly design), built in WEAPON SPACE:
// origin = centre of the pistol grip where the firing hand's palm wraps,
// +Z = toward the muzzle, +Y = up, +X = the shooter's left side.

import * as THREE from 'three';
import { MeshBuilder, flatMaterial } from './meshkit.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);

export const WEAPON = {
  BORE_Y: 0.080,
  SIGHT_Y: 0.140,                 // red-dot optical axis height above grip origin
  SIGHT_Z: 0.065,                 // optic centre
  BUTT: V(0, 0.066, -0.330),      // centre of the butt pad
  MUZZLE: V(0, 0.080, 0.630),
  EJECTION: V(-0.017, 0.088, 0.045),
  TRIGGER: V(0, 0.022, 0.030),
  HANDGUARD_BOTTOM_Y: 0.051,
  HANDGUARD_Z: [0.19, 0.45],
  MASS: 3.4,
};

const q = (x, y, z) => new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z, 'XYZ'));

/** Build an orientation from (axis, palm) for a hand bone; see skeleton bind frames. */
function handQuat(side, axis, palmApprox) {
  const a = axis.clone().normalize();
  const p = palmApprox.clone().addScaledVector(a, -palmApprox.dot(a)).normalize();
  const m = new THREE.Matrix4();
  if (side === 'Right') {
    const t = new THREE.Vector3().crossVectors(a, p);
    // bind: axis = -X, palm = -Y, thumb = +Z
    m.makeBasis(a.clone().negate(), p.clone().negate(), t);
  } else {
    const t = new THREE.Vector3().crossVectors(p, a);
    // bind: axis = +X, palm = -Y, thumb = +Z
    m.makeBasis(a, p.clone().negate(), t);
  }
  return { quat: new THREE.Quaternion().setFromRotationMatrix(m), a, p };
}

/**
 * Right (firing) hand on the pistol grip, in weapon space.
 * Returns the Hand bone (wrist) transform.
 */
export function rightGrip() {
  const { quat, a, p } = handQuat('Right', V(0.20, -0.30, 0.93), V(1, 0.1, 0));
  const palm = V(-0.019, 0.004, -0.014);
  const pos = palm.clone().addScaledVector(p, -0.017).addScaledVector(a, -0.052);
  return { pos, quat };
}

/**
 * Left (support) hand under/along the handguard at distance z along the weapon.
 * style 'cup' = palm under handguard; 'clamp' = thumb-over C-clamp on the left side.
 */
export function leftGrip(z = 0.30, style = 'cup') {
  let axis, palm, contact;
  if (style === 'clamp') {
    // thumb over the top, palm on the left/bottom, fingers wrapping under to the right side
    axis = V(-0.30, 0.42, 0.86);
    palm = V(-0.75, 0.62, 0);
    contact = V(0.020, 0.064, z);
  } else {
    axis = V(-0.42, 0.10, 0.90);
    palm = V(-0.30, 1, 0);
    contact = V(0.008, WEAPON.HANDGUARD_BOTTOM_Y - 0.002, z);
  }
  const { quat, a, p } = handQuat('Left', axis, palm);
  const pos = contact.clone().addScaledVector(p, -0.017).addScaledVector(a, -0.050);
  return { pos, quat };
}

/** Rifle mesh in weapon space. */
export function buildRifleGeometry() {
  const B = new MeshBuilder();
  const W = [[0, 1]];
  const BY = WEAPON.BORE_Y;
  const gm = 'gunmetal', bl = 'black', gl = 'gunLight', tan = 'gunTan';

  // Upper receiver
  B.box(V(0, 0.083, 0.07), [0.030, 0.042, 0.27], gm, W);
  // Lower receiver + magwell
  B.box(V(0, 0.045, 0.055), [0.028, 0.038, 0.20], gl, W);
  B.box(V(0, 0.020, 0.095), [0.030, 0.035, 0.055], gl, W);
  // Ejection port cover (right side)
  B.box(V(-0.0155, 0.088, 0.045), [0.003, 0.016, 0.05], bl, W);
  // Charging handle
  B.box(V(0, 0.100, -0.075), [0.040, 0.010, 0.022], bl, W);
  // Forward assist
  B.cylinder(V(-0.016, 0.092, -0.01), V(-0.024, 0.092, 0.01), 0.007, 0.007, gm, W, { n: 6 });
  // Top rail along receiver + handguard
  B.box(V(0, 0.109, 0.18), [0.022, 0.010, 0.54], bl, W);
  for (let z = -0.04; z < 0.44; z += 0.03) B.box(V(0, 0.115, z), [0.022, 0.004, 0.012], bl, W);

  // Pistol grip (angled back ~20 deg)
  B.box(V(0, -0.010, -0.018), [0.027, 0.105, 0.034], bl, W, { quat: q(0.36, 0, 0), taperBottom: [0.95, 0.9] });
  // Trigger guard
  B.box(V(0, 0.000, 0.040), [0.020, 0.006, 0.070], bl, W);
  B.box(V(0, 0.012, 0.073), [0.020, 0.024, 0.006], bl, W);
  // Trigger
  B.box(V(0, 0.020, 0.030), [0.006, 0.026, 0.006], gl, W, { quat: q(0.25, 0, 0) });

  // Magazine (slight forward curve), tan polymer
  B.box(V(0, -0.025, 0.098), [0.024, 0.07, 0.062], tan, W, { quat: q(0.06, 0, 0) });
  B.box(V(0, -0.095, 0.112), [0.024, 0.075, 0.060], tan, W, { quat: q(0.24, 0, 0) });
  B.box(V(0, -0.137, 0.126), [0.030, 0.014, 0.068], bl, W, { quat: q(0.28, 0, 0) });

  // Buffer tube
  B.cylinder(V(0, 0.077, -0.09), V(0, 0.077, -0.28), 0.016, 0.016, gm, W, { n: 8 });
  // Stock body
  B.box(V(0, 0.072, -0.245), [0.036, 0.055, 0.15], bl, W, { taperTop: [0.9, 1] });
  B.box(V(0, 0.040, -0.285), [0.034, 0.050, 0.075], bl, W, { quat: q(-0.25, 0, 0) });
  // Cheek rest top
  B.box(V(0, 0.102, -0.24), [0.034, 0.010, 0.12], gl, W);
  // Butt pad
  B.box(V(0, WEAPON.BUTT.y, WEAPON.BUTT.z + 0.008), [0.040, 0.135, 0.018], 'pad', W);

  // Handguard (octagonal free-float)
  B.cylinder(V(0, BY, WEAPON.HANDGUARD_Z[0]), V(0, BY, WEAPON.HANDGUARD_Z[1]), 0.029, 0.028, gm, W, { n: 8, roll: Math.PI / 8 });
  // Handguard slots (dark accents on sides)
  for (const s of [-1, 1]) for (let z = 0.23; z < 0.43; z += 0.05)
    B.box(V(0.028 * s, BY, z), [0.004, 0.010, 0.025], bl, W);
  // Barrel + gas block + muzzle device
  B.cylinder(V(0, BY, 0.45), V(0, BY, 0.585), 0.0095, 0.0095, bl, W, { n: 8 });
  B.cylinder(V(0, BY, 0.585), V(0, BY, 0.632), 0.014, 0.013, gm, W, { n: 8, roll: Math.PI / 8 });
  // Folding front sight (down)
  B.box(V(0, 0.118, 0.41), [0.018, 0.010, 0.04], bl, W);

  // Red dot optic: mount + tube + lenses
  const SY = WEAPON.SIGHT_Y, SZ = WEAPON.SIGHT_Z;
  B.box(V(0, 0.122, SZ), [0.026, 0.016, 0.05], bl, W);
  // open optic tube (caps omitted) + lens rings, so the reticle is visible through it
  B.cylinder(V(0, SY, SZ - 0.045), V(0, SY, SZ + 0.045), 0.021, 0.022, bl, W, { n: 8, roll: Math.PI / 8, caps: false });
  const annulus = (z, ro, ri, col, dir) => {
    const n = 8;
    for (let i = 0; i < n; i++) {
      const a0 = Math.PI / 8 + (2 * Math.PI * i) / n, a1 = Math.PI / 8 + (2 * Math.PI * (i + 1)) / n;
      const P = (r, a) => V(Math.cos(a) * r, SY + Math.sin(a) * r, z);
      const q = [P(ro, a0), P(ro, a1), P(ri, a1), P(ri, a0)];
      if (dir > 0) B.quad(q[0], q[1], q[2], q[3], col, W); else B.quad(q[3], q[2], q[1], q[0], col, W);
    }
  };
  for (const [z, ro, ri] of [[SZ - 0.045, 0.0215, 0.0165], [SZ + 0.045, 0.0225, 0.0175]]) { annulus(z, ro, ri, bl, -1); annulus(z, ro, ri, bl, 1); }
  B.box(V(0, SY + 0.024, SZ), [0.012, 0.010, 0.020], bl, W);        // turret top
  B.box(V(-0.023, SY, SZ), [0.010, 0.012, 0.018], bl, W);           // turret side
  // red-dot reticle floating on the optical axis (visible through the rear lens)
  B.box(V(0, SY, SZ + 0.02), [0.0035, 0.0035, 0.002], 'lensRed', W);
  // Sling swivel points
  B.box(V(0.017, 0.075, -0.30), [0.006, 0.02, 0.02], gm, W);
  B.box(V(0.03, BY, 0.43), [0.006, 0.016, 0.016], gm, W);

  return B.buildStatic();
}

export function buildRifle() {
  const mat = flatMaterial('Rifle');
  mat.side = THREE.DoubleSide; // open optic tube is seen from the inside when aiming
  const mesh = new THREE.Mesh(buildRifleGeometry(), mat);
  mesh.name = 'Rifle';
  mesh.castShadow = true;
  // Named attachment points as empty child nodes (exported to glTF).
  const add = (name, pos, quat) => {
    const o = new THREE.Object3D();
    o.name = name;
    o.position.copy(pos);
    if (quat) o.quaternion.copy(quat);
    mesh.add(o);
  };
  add('Muzzle', WEAPON.MUZZLE);
  add('Ejection', WEAPON.EJECTION);
  add('SightLine', new THREE.Vector3(0, WEAPON.SIGHT_Y, WEAPON.SIGHT_Z));
  const lg = leftGrip(0.30, 'cup');
  add('LeftHand_IK', lg.pos, lg.quat);
  return mesh;
}
