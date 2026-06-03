// Verifies the 3-tier hydration stamina model against the user's in-game readings:
//   floor 130 (100 + 30 keystones, no node):      low 130 / mid 162 / high 195
//   floor 145 (+ General Conditioning r1 = +15):  low 146 / mid 181 / high 218 (±1 rounding)
// Combat MaxStamina keystones 2/16/36 sum to +30; General Conditioning = Swordmaster Aggression3.
import { _electron as electron } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0;
const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const app = await electron.launch({ args: [ROOT], cwd: ROOT });
const page = await app.firstWindow();
await page.waitForFunction(() => typeof window.__golden !== 'undefined', { timeout: 15000 });
await page.waitForFunction(() => window.__golden.GARMENT_BY_SLUG?.size > 0, { timeout: 15000 });

const KEYSTONES = ['Combat_CombatKeystone_MaxStamina2','Combat_CombatKeystone_MaxStamina16','Combat_CombatKeystone_MaxStamina36'];

// Drives context.hydrationPct (0–100) at each percent and reads the Stamina max.
async function staminaAtPcts(build) {
  return await page.evaluate(({ build, pcts }) => {
    const g = window.__golden;
    g.applyBuildData(build);
    const out = {};
    for (const p of pcts) {
      g.SKILL_TREE_STATE.context.hydrationPct = p;
      g.refreshPanels();
      const txt = document.getElementById('character-stats')?.innerText || '';
      const m = txt.match(/STAMINA\s+(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/i);
      out[p] = m ? Math.round(parseFloat(m[2])) : null;
    }
    return out;
  }, { build, pcts: [100, 70, 50, 30, 29, 10] });
}

// floor 130: keystones only, no General Conditioning. Tier boundaries: ≥70 high, ≥30 mid, <30 low.
const r1 = await staminaAtPcts({
  slots: {}, hotbar: null,
  specializations: { combattrack: { level: 44, keystones: KEYSTONES } },
  skills: {},
});
console.log('Floor 130 (keystones only):', JSON.stringify(r1));
ok(near(r1[100], 195), `100% → 195 (got ${r1[100]})`);
ok(near(r1[70], 195),  `70% boundary → high 195 (got ${r1[70]})`);
ok(near(r1[50], 162, 2), `50% → mid 162/163 (got ${r1[50]})`);
ok(near(r1[30], 162, 2), `30% boundary → mid 162/163 (got ${r1[30]})`);
ok(near(r1[29], 130), `29% → low 130 (got ${r1[29]})`);
ok(near(r1[10], 130), `10% → low 130 (got ${r1[10]})`);

// floor 145: + General Conditioning r1 (+15)
const r2 = await staminaAtPcts({
  slots: {}, hotbar: null,
  specializations: { combattrack: { level: 44, keystones: KEYSTONES } },
  skills: { Swordmaster: { 'Skills.Attribute.Aggression3': 1 } },
});
console.log('Floor 145 (+General Conditioning r1):', JSON.stringify(r2));
ok(near(r2[100], 218, 1.5), `100% → 218 (got ${r2[100]})`);
ok(near(r2[50], 181, 2),    `50% → 181 (got ${r2[50]})`);
ok(near(r2[10], 145, 1.5),  `10% → 145 (got ${r2[10]})`);

await app.close();
console.log('\n' + (fails === 0 ? 'ALL HYDRATION CHECKS PASSED' : `${fails} FAILURE(S)`));
process.exit(fails === 0 ? 0 : 1);
