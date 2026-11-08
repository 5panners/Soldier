// GLB export: one skinned soldier mesh + rifle on the Weapon_R socket + all baked clips.
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { buildSoldier } from './soldier.js';

export function clipMetadata(baked) {
  return Object.fromEntries(baked.map((b) => [b.clip.name, {
    duration: +b.def.duration.toFixed(4),
    loop: !!b.def.loop,
    inPlaceSpeed: +(b.def.speed || 0).toFixed(3),
    shots: (b.def.shots || []).map((t) => +t.toFixed(4)),
    events: b.def.events || {},
  }]));
}

export async function exportGLB(baked) {
  const S = buildSoldier(); // fresh copy in bind (T) pose
  const scene = new THREE.Scene();
  scene.add(S.group);
  S.group.userData = {
    generator: 'Soldier Simulator',
    units: 'metres', up: '+Y', forward: '+Z',
    weaponSocket: 'Weapon_R',
    attachPoints: ['Muzzle', 'Ejection', 'SightLine', 'LeftHand_IK'],
    clips: clipMetadata(baked),
  };
  scene.updateMatrixWorld(true);
  const clips = baked.map((b) => b.clip);
  const exporter = new GLTFExporter();
  return await exporter.parseAsync(scene, { binary: true, animations: clips, onlyVisible: true, includeCustomExtensions: false });
}
