# References

The animations are procedurally authored, not motion captured. Their timing, joint ranges and postures were set from published gait biomechanics, load-carriage studies and military marksmanship doctrine. The values used are listed next to each source.

## Walking gait
* Normative sagittal joint kinematics by gait phase: knee flexion about 20° in loading response and about 60° in swing; ankle ±10–20°.
  [PMC555760 table 3](https://pmc.ncbi.nlm.nih.gov/articles/PMC555760/table/T3) · [gait cycle data](https://www.scribd.com/document/338772029/gait-cycle-data-pdf) · [JNER gait parameters](https://jneuroengrehab.biomedcentral.com/articles/10.1186/1743-0003-8-55/tables/1) · [PMC2899459 fig. 3](https://pmc.ncbi.nlm.nih.gov/articles/PMC2899459/figure/Fig3) · [PMC6656910](https://pmc.ncbi.nlm.nih.gov/articles/PMC6656910) · [PMC2907535](https://pmc.ncbi.nlm.nih.gov/articles/PMC2907535) · [WFU ACL gait data](https://sites.google.com/a/wfu.edu/aclgait/data)
* Stance is about 60 % of the walking cycle; midstance shortens as speed increases.
  [Normal Gait (Univ. of Missouri PM&R)](https://medicine.missouri.edu/sites/default/files/pm-r/Normal_Gait.pdf)
* Used in `GAITS.walk`:
  * 62 % stance; heel strike with 16° dorsiflexion; heel-off at 40 %; toe-off with 38° heel rise.
  * Pelvic rotation ±5° and obliquity ±3.5°; COM bob about 3 cm peak to peak; lateral sway ±1.8 cm.

## Running gait
* Stance is about 40 % of the running cycle, with swing and flight making up the rest. At about 3.5 m/s: stance about 38 %, vertical COM oscillation about 7.2 cm.
  [Konstanz ISBS proceedings](https://ojs.ub.uni-konstanz.de/cpa/article/view/1308/1229) · [Running biomechanics chapter](https://www.scribd.com/document/875703918/Chapter-16)
* Cadence 150–180 spm; knee flexion 20–30° at initial contact; vertical oscillation is linked to running economy.
  [Running form research summary](https://runningform.vercel.app/research) · [PMC5473370](https://pmc.ncbi.nlm.nih.gov/articles/PMC5473370)
* Used in `GAITS.run`: 4.3 m/s with 1.5 m steps; 28 % stance (about 0.2 s contact) with two flight phases; 171 spm; about 6.8 cm vertical oscillation; high heel recovery; 18° trunk lean.

## Load carriage / walking with a rifle
* Load increases forward trunk inclination; walking with a rifle plus boots and helmet flexes the trunk further forward; weapon handling does not significantly change stride-time variability.
  [Effects of military load carriage on kinematics of gait (PubMed 20496244)](https://pubmed.ncbi.nlm.nih.gov/20496244/) · [Carrying a weapon (Sheffield Hallam)](https://shura.shu.ac.uk/37910/1/Wheat-CarryingWeaponDoes%28VoR%29.pdf) · [NSCA TSAC report 80: biomechanics of loaded marching](https://www.nsca.com/globalassets/education/articles/tsac/tsac-80/tsac-report-80_biomechanical-effects-of-loaded-marching.pdf) · [Attwells et al., Ergonomics](https://dspace.lboro.ac.uk/2134/17047) · [Coventry: heavy loads and soldiers' posture](https://pureportal.coventry.ac.uk/en/publications/influence-of-carrying-heavy-loads-on-soldiers-posture-movements-a/) · [DTIC ADA394891](https://apps.dtic.mil/sti/tr/pdf/ADA394891.pdf)
* Used in the clips:
  * Forward trunk lean: 8–9° walking, 15° running, 10–16° when aiming.
  * Chest stabilised against pelvic rotation so the rifle stays steady.

## Rifle marksmanship and weapon handling
* FM 3-22.9 *Rifle Marksmanship M16/M4* covers the steady-position elements: butt in the pocket of the firing shoulder, firm stock weld, firing-eye alignment, support hand, firing-hand grip, elbows.
  [FM 3-22.9 (2008, UNT archive)](https://webarchive.library.unt.edu/web/20130213212857/http:/armypubs.army.mil/doctrine/DR_pubs/dr_a/pdf/fm3_22x9.pdf) · [FM 3-22.9 (2003, Internet Archive)](https://ia600301.us.archive.org/9/items/milmanual-fm-3-22.9-rifle-marksmanship-m16a1-m16a2-3-m16a4-and-m4-carb/fm_3-22.9_rifle_marksmanship_m16a1_m16a2-3_m16a4_and_m4_carbine.pdf) · [GlobalSecurity FM 3-22.9 appendix](https://www.globalsecurity.org/military/library/policy/army/fm/3-22-9/appa.htm)
* USMC fundamentals: stock weld is firm cheek–stock contact with the aiming eye looking straight through the optic. Eye relief depends on neck length and how the stock sits in the shoulder. The butt stays consistently in the shoulder pocket.
  [USMC ART.06 Fundamentals of Rifle Marksmanship](https://www.trngcmd.marines.mil/Portals/207/Docs/wtbn/ART.06%20Fundamentals%20of%20Rifle%20Marksmanship%20RCO.doc) · [Seven common factors](https://www.militarytraining.net/Marksmanship/Marksmanship%20seven%20common%20factors%20for%20rifle%20shooting.htm) · [Competitive marksmanship](https://www.slideserve.com/elkan/competitive-marksmanship) · [Sniper's Hide: butt placement](https://www.snipershide.com/shooting/goto/post?id=8013571) · [Sniper's Hide: eye relief / cheek weld](https://snipershide.com/shooting/threads/eye-relief-cheek-weld.10409) · [Stock fit](https://unionsportsmen.org/stock-fit-is-important-for-rifles-too/)
* Used in `STANCES` and `calibrate()`:
  * ADS: butt seated in the shoulder pocket; right eye solved onto the sight line; raised firing shoulder and elbow; support hand under the handguard; bladed stance with the left foot forward.
  * Trigger discipline: the index finger stays straight outside the guard except when firing.
  * Hip fire: the stock is clamped under the firing arm.

## Prone, crouch and crawl
* Prone firing position follows FM 3-22.9 (linked above):
  * The body is angled to the left of the line of fire, with the firing-side knee drawn up.
  * The elbows support the rifle, and the butt sits in the shoulder pocket.
* The crawl follows the low-crawl family of individual movement techniques in FM 3-21.75 *The Warrior Ethos and Soldier Combat Skills*:
  * The body stays flat on the ground.
  * The soldier pulls with the arms and pushes with a drawn-up leg.
  * The muzzle is kept off the ground.
  * Here it is alternating: the right forearm with the left knee, then the other pair.
* Used in `buildProne()` (`src/motion.js`) and `crawlClip()` (`src/clips.js`).
