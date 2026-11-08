// Bakes every clip and reports IK / contact quality metrics.
import { bakeAll } from '../src/bake.js';
import { eyeInWeapon, STANCES } from '../src/motion.js';
import { WEAPON } from '../src/weapon.js';

const t0 = Date.now();
const baked = bakeAll();
console.log(`Baked ${baked.length} clips in ${Date.now() - t0} ms\n`);
console.log('clip'.padEnd(20), 'dur'.padStart(6), 'frames'.padStart(7), 'footErr(mm)'.padStart(12), 'handErr(mm)'.padStart(12), 'eyeOffSight(mm)'.padStart(16));
let bad = 0;
for (const b of baked) {
  let eye = '';
  if (b.def.name.startsWith('ADS') && !b.def.name.includes('_To_')) {
    let m = 0;
    for (const r of b.poses) { const e = eyeInWeapon(r); m = Math.max(m, Math.hypot(e.x, e.y - WEAPON.SIGHT_Y)); }
    eye = (m * 1000).toFixed(1);
  }
  const f = b.metrics.footErr * 1000, h = b.metrics.handErr * 1000;
  if (f > 5 || h > 5) bad++;
  console.log(b.def.name.padEnd(20), b.def.duration.toFixed(2).padStart(6), String(b.metrics.frames).padStart(7), f.toFixed(1).padStart(12), h.toFixed(1).padStart(12), eye.padStart(16));
}
const c = STANCES.ads.calib;
console.log('\nADS calibration:', Object.entries(c).map(([k, v]) => `${k}=${['elev', 'prot', 'buttUp', 'cost'].includes(k) ? v.toFixed(3) : (v * 180 / Math.PI).toFixed(1) + '°'}`).join('  '));
if (bad) { console.log(`\n${bad} clip(s) exceed 5 mm IK error`); process.exitCode = 1; }
