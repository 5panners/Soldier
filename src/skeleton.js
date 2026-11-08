// Humanoid skeleton definition (Mixamo-compatible bone names, no prefix).
// Units: metres. Y up. Character faces +Z. Character's LEFT is +X.
// Bind pose is a T-pose and every bone has an identity bind rotation, so a
// bone's local rotation is expressed directly in world-aligned axes of its parent.

import * as THREE from 'three';

const v = (x, y, z) => new THREE.Vector3(x, y, z);

// [name, parent, world position in T-pose]
function sideBones(side) {
  const s = side === 'Left' ? 1 : -1; // +X for left
  const P = side;
  const hy = 1.445;          // shoulder/arm height
  const hz = -0.01;
  const wrist = 0.745;
  return [
    [`${P}Shoulder`, 'Spine2', v(0.03 * s, 1.455, 0.0)],
    [`${P}Arm`, `${P}Shoulder`, v(0.175 * s, hy, hz)],
    [`${P}ForeArm`, `${P}Arm`, v(0.475 * s, hy, hz)],
    [`${P}Hand`, `${P}ForeArm`, v(wrist * s, hy, hz)],
    // Thumb: from the base of the palm, angled forward (+Z) and slightly down.
    [`${P}HandThumb1`, `${P}Hand`, v((wrist + 0.022) * s, hy - 0.012, hz + 0.025)],
    [`${P}HandThumb2`, `${P}HandThumb1`, v((wrist + 0.050) * s, hy - 0.016, hz + 0.050)],
    [`${P}HandThumb3`, `${P}HandThumb2`, v((wrist + 0.075) * s, hy - 0.018, hz + 0.066)],
    // Index finger (separate so it can rest on / pull the trigger)
    [`${P}HandIndex1`, `${P}Hand`, v((wrist + 0.088) * s, hy, hz + 0.024)],
    [`${P}HandIndex2`, `${P}HandIndex1`, v((wrist + 0.128) * s, hy, hz + 0.026)],
    [`${P}HandIndex3`, `${P}HandIndex2`, v((wrist + 0.160) * s, hy, hz + 0.027)],
    // Middle/ring/little fingers share one chain (stylised low-poly mitten block)
    [`${P}HandMiddle1`, `${P}Hand`, v((wrist + 0.090) * s, hy, hz - 0.012)],
    [`${P}HandMiddle2`, `${P}HandMiddle1`, v((wrist + 0.133) * s, hy, hz - 0.012)],
    [`${P}HandMiddle3`, `${P}HandMiddle2`, v((wrist + 0.165) * s, hy, hz - 0.012)],
    // Legs
    [`${P}UpLeg`, 'Hips', v(0.095 * s, 0.93, 0.0)],
    [`${P}Leg`, `${P}UpLeg`, v(0.098 * s, 0.51, 0.0)],
    [`${P}Foot`, `${P}Leg`, v(0.100 * s, 0.085, 0.0)],
    [`${P}ToeBase`, `${P}Foot`, v(0.100 * s, 0.025, 0.135)],
    [`${P}Toe_End`, `${P}ToeBase`, v(0.100 * s, 0.022, 0.215)],
  ];
}

export const BONE_DEFS = [
  ['Hips', null, v(0, 0.97, 0)],
  ['Spine', 'Hips', v(0, 1.07, 0)],
  ['Spine1', 'Spine', v(0, 1.19, 0)],
  ['Spine2', 'Spine1', v(0, 1.32, 0)],
  ['Neck', 'Spine2', v(0, 1.462, -0.015)],
  ['Head', 'Neck', v(0, 1.548, 0.0)],
  ['HeadTop_End', 'Head', v(0, 1.745, 0.0)],
  ...sideBones('Left'),
  ...sideBones('Right'),
];

export const BONE_INDEX = Object.fromEntries(BONE_DEFS.map((b, i) => [b[0], i]));
export const BIND_WORLD = Object.fromEntries(BONE_DEFS.map((b) => [b[0], b[2].clone()]));
export const PARENT = Object.fromEntries(BONE_DEFS.map((b) => [b[0], b[1]]));

// Bind-space offset of each bone from its parent (identity bind rotations).
export const BIND_LOCAL = Object.fromEntries(
  BONE_DEFS.map(([n, p, w]) => [n, p ? w.clone().sub(BIND_WORLD[p]) : w.clone()])
);

// Right eye, relative to the Head bone (bind axes). Used to align the sight line.
// (face scaled 1.10 about its centre, then the whole head group 1.03 and lowered onto the short neck)
export const RIGHT_EYE_LOCAL = v(-0.0363, 0.0834, 0.1053);
export const LEFT_EYE_LOCAL = v(0.0363, 0.0834, 0.1053);

// Shoulder pocket (where the rifle butt seats), in RightShoulder (clavicle) space.
// Bind world ≈ (-0.14, 1.435, 0.085): between the plate carrier edge and the deltoid.
export const SHOULDER_POCKET_LOCAL = v(-0.152, 1.452, 0.104).sub(BIND_WORLD.RightShoulder);
// Point on the right flank under the armpit (hip-fire tuck), in Spine2 space.
export const UNDERARM_TUCK_LOCAL = v(-0.232, 1.235, -0.04).sub(BIND_WORLD.Spine2);

export const LEG_UPPER = BIND_WORLD.LeftUpLeg.distanceTo(BIND_WORLD.LeftLeg);
export const LEG_LOWER = BIND_WORLD.LeftLeg.distanceTo(BIND_WORLD.LeftFoot);
export const ARM_UPPER = BIND_WORLD.LeftArm.distanceTo(BIND_WORLD.LeftForeArm);
export const ARM_LOWER = BIND_WORLD.LeftForeArm.distanceTo(BIND_WORLD.LeftHand);
export const ANKLE_HEIGHT = BIND_WORLD.LeftFoot.y;

/** Build a THREE.Bone hierarchy in bind pose. Returns { root, bones: {name: Bone}, list: Bone[] } */
export function buildSkeletonBones() {
  const bones = {};
  const list = [];
  for (const [name, parent] of BONE_DEFS) {
    const b = new THREE.Bone();
    b.name = name;
    b.position.copy(BIND_LOCAL[name]);
    bones[name] = b;
    list.push(b);
    if (parent) bones[parent].add(b);
  }
  return { root: bones.Hips, bones, list };
}
