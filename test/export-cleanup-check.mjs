// Verifies the save/export cleanup:
//  1. Loading a LEGACY build blob (with characterPanel / _context / appVersion)
//     does not throw, and combat context resets to defaults.
//  2. Re-exporting that build emits ONLY pure inputs — no characterPanel,
//     no appVersion, no skills._context — while keeping slots/hotbar/skills
//     allocations + _equipped + formatVersion.
import { _electron as electron } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const ok  = (c, m) => { if (c) console.log('  ✓', m); else { console.log('  ✗', m); failures++; } };

const LEGACY = {
  formatVersion: 1,
  appVersion: '0.8.3',
  slots: { chest: { item: 'exoskeleton_heavy06_unique_top', grade: 5, augments: [null, null, null] } },
  hotbar: { hotbar0: { item: 'choamsword_2', grade: 5, augments: [null, null, null] } },
  specializations: {},
  skills: {
    Swordmaster: { 'Skills.Attribute.Blade2': 3 },
    Trooper: { 'Skills.Perk.BodyShots': 3 },
    // BodyShots is allocated above, so pruneEquipped() keeps it equipped.
    _equipped: { abilities: [null, null, null], techniques: ['Skills.Perk.BodyShots', null, null] },
    _context: { suspended: true, lunging: true, exploited: true, hydrated: false },
  },
  characterPanel: { Health: '220 / 220', Stamina: '206 / 206', Energy: '740 / 740' },
};

const app = await electron.launch({ args: [ROOT], cwd: ROOT });
const page = await app.firstWindow();
await page.waitForFunction(() => typeof window.__golden !== 'undefined', { timeout: 15000 });
// Item slug → object maps load async after __golden is set; wait for them so
// applyBuildData can resolve the slot/hotbar items into equippedItems.
await page.waitForFunction(
  () => window.__golden.GARMENT_BY_SLUG?.size > 0 && window.__golden.WEAPON_BY_SLUG?.size > 0,
  { timeout: 15000 });

const res = await page.evaluate((legacy) => {
  const g = window.__golden;
  let threw = null;
  try { g.applyBuildData(legacy); } catch (e) { threw = String(e); }
  let out = null, exportThrew = null;
  try { out = g.exportBuild(); } catch (e) { exportThrew = String(e); }
  return { threw, exportThrew, out };
}, LEGACY);

console.log('== Export cleanup ==');
ok(res.threw === null, `legacy load does not throw${res.threw ? ' (got: ' + res.threw + ')' : ''}`);
ok(res.exportThrew === null, `exportBuild does not throw${res.exportThrew ? ' (got: ' + res.exportThrew + ')' : ''}`);
const out = res.out || {};
ok(!('characterPanel' in out), 'export omits characterPanel');
ok(!('appVersion' in out), 'export omits appVersion');
ok(!(out.skills && '_context' in out.skills), 'export omits skills._context');
ok(out.formatVersion != null, 'export keeps formatVersion');
ok(out.slots && out.slots.chest && out.slots.chest.item === 'exoskeleton_heavy06_unique_top', 'export keeps slots');
ok(out.hotbar && out.hotbar.hotbar0 && out.hotbar.hotbar0.item === 'choamsword_2', 'export keeps hotbar');
ok(out.skills && out.skills.Swordmaster && out.skills.Swordmaster['Skills.Attribute.Blade2'] === 3, 'export keeps skill allocations');
ok(out.skills && out.skills._equipped && out.skills._equipped.techniques[0] === 'Skills.Perk.BodyShots',
   'export keeps non-empty skills._equipped (loadout round-trips)');

await app.close();
console.log('\n== Summary ==');
console.log(failures === 0 ? '  ALL CHECKS PASSED' : `  ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
