# Animation reference

All clips are baked at **60 fps** with a key on every bone (constant tracks are collapsed to two keys) plus `Hips.position`.
Locomotion is **in place**: the character stays at the origin and the clip's `inPlaceSpeed` is the ground speed that keeps the planted feet locked.
Vertical motion (gait bob, jump arc) is baked into `Hips.position`.

![walk](images/walk.png)
![run](images/run.png)
![jump](images/jump.png)
![ads walk](images/ads_walk.png)

## Locomotion

| Clip | Length | Loop | Speed | Notes |
|---|---|---|---|---|
| `Idle` | 4.00 s | ✓ | — | Low ready: butt in the shoulder pocket, muzzle about 30° down, index finger straight along the receiver. 15 breaths/min (chest pitch and clavicle lift), slow weight shift, and a head scan to the left and back. |
| `Walk` | 1.10 s | ✓ | 1.25 m/s | Patrol walk at the low ready, 109 steps/min, 0.69 m step. Stance is 62 % of the cycle. Heel strike with 16° dorsiflexion, heel-off at 40 %, toe-off with 38° heel rise and toe bend. Pelvis yaw ±5°, obliquity ±3.5°, sway ±1.8 cm, bob ±1.6 cm. The chest is stabilised and the rifle lags with each footfall. |
| `Run` | 0.68 s | ✓ | 3.2 m/s | 176 steps/min. Stance is 34 %, with two flight phases. Midfoot contact, high heel kick and about 6.4 cm vertical oscillation. 15° trunk lean and thorax counter-rotation. The rifle is carried compact across the chest, muzzle down-left. |
| `ADS_Walk` | 1.20 s | ✓ | 0.9 m/s | Aiming "Groucho" walk: knees bent, smooth rolling heel-to-toe, chest world-locked. Cheek weld kept: the eye stays within 1 mm of the sight line. |
| `HipFire_Walk` | 1.20 s | ✓ | 0.9 m/s | The same rolling gait with the stock clamped under the right arm. |

## Weapon stances and firing

| Clip | Length | Loop | Notes |
|---|---|---|---|
| `ADS_Idle` | 4.00 s | ✓ | Bladed stance with the left foot forward. Butt seated in the right shoulder pocket. The right eye is on the red-dot sight line (solved, see below). Right elbow out, support hand under the handguard. Micro breathing sway. |
| `HipFire_Idle` | 4.00 s | ✓ | Aggressive forward lean. The stock is tucked under the right armpit and clamped by the upper arm. Barrel level and forward, finger on the trigger. |
| `ADS_Fire` | 0.50 s | — | One shot at t = 0.06 s. Trigger press then reset. The muzzle climbs about 2.2° and the stock drives about 2 cm back into the shoulder. The chest and shoulder absorb the kick with a slight delay, then the rifle settles back on target. |
| `ADS_Fire_Auto` | 0.60 s | ✓ | 7 rounds at 700 RPM (shots every 0.0857 s). Impulses are summed periodically for a seamless loop with sustained muzzle rise. |
| `HipFire_Fire` | 0.50 s | — | One shot from the hip. Recoil is larger (about 4.5° climb) because the shoulder isn't supporting the stock. |
| `HipFire_Fire_Auto` | 0.60 s | ✓ | 700 RPM loop from the hip. |
| `*_Pose` | static | ✓ | Single static frames of each stance, for aim offsets and as additive references. |

Shot times (s) are in `animations.json` → `shots`. Use them to spawn muzzle flash and brass at the `Muzzle` and `Ejection` nodes.

## Transitions

These start and end exactly on the corresponding stance frames, so they chain without cross-fades. During each transition the trigger finger comes off the trigger and goes back on only once the rifle has settled.

| Clip | Length | Notes |
|---|---|---|
| `Idle_To_ADS` | 0.32 s | Mounts the rifle: the muzzle rises, the head drops into the cheek weld and the shoulder rises. |
| `ADS_To_Idle` | 0.40 s | Back to the low ready. |
| `Idle_To_HipFire` / `HipFire_To_Idle` | 0.30 / 0.35 s | The stock swings out and around the right arm and into the tuck (arced path). |
| `HipFire_To_ADS` / `ADS_To_HipFire` | 0.28 s | Fast mount and dismount. |

## Jump

| Clip | Length | Loop | Notes |
|---|---|---|---|
| `Jump` | 1.85 s | — | Full standing jump with the rifle at the low ready: anticipation crouch to 0.73 m hip height, extension with heel rise, take-off at 0.62 s (2.45 m/s), ballistic flight to about 0.31 m, knee tuck, toe-first landing at 1.12 s, absorb and recover. The rifle lags on take-off and dips on landing. |
| `Jump_Start` | 0.62 s | — | Crouch → take-off. Ends with the pelvis at take-off height. |
| `Jump_Air` | 0.80 s | ✓ | Airborne loop with legs tucked and the pelvis held at take-off height. Let your physics drive the real arc. |
| `Jump_Land` | 0.73 s | — | Touchdown → absorb → idle. Starts with the pelvis at take-off height. |

## ADS cheek-weld solution

The ADS head and neck posture isn't hand-posed. It is solved so that the **right eye lies on the optic's axis** with the butt seated in the shoulder pocket, using comfortable joint limits:

| Parameter | Value |
|---|---|
| Neck flexion | about 31° |
| Neck tilt toward the stock | about 14° |
| Head extension relative to the neck (keeps the gaze level) | about −25° |
| Head turn relative to the bladed chest | about 20° |
| Head tilt | about 14° |
| Right clavicle elevation (shoulder raised into the stock) | about 26° |
| Butt height on the shoulder | 3.5 cm high |
| Resulting eye-to-sight-line error | < 0.2 mm |
| Eye relief | about 8 cm forward of the butt pad, over the stock comb |

Run `npm run validate` to see the current numbers.
