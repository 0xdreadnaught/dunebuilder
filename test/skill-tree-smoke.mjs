#!/usr/bin/env node
// Skill-tree integration smoke test.
// Loads the data files DuneBuilder ships and validates:
//   - JSON parses
//   - Every node has a cost array (for nodes referenced in skill-tree-data)
//   - Every prerequisite resolves to another node tag
//   - Allocation of a sample build correctly enforces prereqs
//   - SP budget math sums correctly
// Run: node test/skill-tree-smoke.mjs

import fs from 'node:fs';
import path from 'node:path';

const BASE = path.join('data', 'skill-tree');

function loadJson(name) {
  return JSON.parse(fs.readFileSync(path.join(BASE, name), 'utf8'));
}

let failures = 0;
function check(cond, msg) {
  if (cond) { console.log('  ✓', msg); }
  else { console.log('  ✗', msg); failures++; }
}

console.log('== JSON parse ==');
const nodes = loadJson('nodes.json');
const descs = loadJson('descriptions.json');
const costs = loadJson('costs.json');
const labels = loadJson('sub-tree-labels.json');
const gt = loadJson('gt-skill-tree.json');
check(true, 'all 5 data files parsed');

console.log('\n== Specs ==');
const expectedSpecs = ['Trooper', 'Mentat', 'Planetologist', 'Bene Gesserit', 'Swordmaster'];
for (const s of expectedSpecs) {
  check(s in nodes.skills_by_spec, `${s} present in nodes.json`);
  check(s in labels && labels[s].length === 3, `${s} has 3 sub-tree labels`);
}

console.log('\n== Tag uniqueness + coverage ==');
const nodesByTag = {};
for (const [spec, ns] of Object.entries(nodes.skills_by_spec)) {
  for (const n of ns) {
    check(!nodesByTag[n.tag], `unique tag ${n.tag}`);
    nodesByTag[n.tag] = { ...n, spec };
  }
}
const totalNodes = Object.keys(nodesByTag).length;
console.log(`  total node count: ${totalNodes}`);
check(totalNodes >= 100, 'at least 100 total nodes');

console.log('\n== Descriptions ==');
let missing = 0;
for (const tag of Object.keys(nodesByTag)) {
  if (!descs[tag]) missing++;
}
check(missing === 0, `all ${totalNodes} tags have descriptions (${missing} missing)`);

console.log('\n== Costs ==');
let missingCosts = 0;
for (const tag of Object.keys(nodesByTag)) {
  if (!Array.isArray(costs[tag])) missingCosts++;
}
check(missingCosts === 0, `all ${totalNodes} tags have cost arrays (${missingCosts} missing)`);
check(costs._maxSPLevel200 === 199, 'max SP at level 200 = 199');

console.log('\n== Prerequisite consistency ==');
let unresolved = 0;
for (const node of Object.values(nodesByTag)) {
  for (const pre of (node.prerequisites || [])) {
    if (!nodesByTag[pre]) {
      console.log(`    unresolved: ${node.tag} → ${pre}`);
      unresolved++;
    }
  }
}
check(unresolved === 0, `all prerequisites resolve to known nodes`);

console.log('\n== Subtree assignment ==');
let unassigned = 0;
for (const node of Object.values(nodesByTag)) {
  if (node.subTreeIdx == null || node.subTreeIdx < 0 || node.subTreeIdx > 2) unassigned++;
}
check(unassigned === 0, `all nodes have subTreeIdx in [0..2] (${unassigned} unassigned)`);

console.log('\n== Allocation simulation ==');
// Simulate allocating the Trooper "Center of Mass" chain
const alloc = { Trooper: {} };
function isAvailable(tag) {
  const n = nodesByTag[tag];
  if (!n) return false;
  if (!Array.isArray(n.prerequisites) || n.prerequisites.length === 0) return true;
  // OR-semantics: any one allocated prereq lets you branch
  return n.prerequisites.some(pre => (alloc[nodesByTag[pre].spec] || {})[pre] >= 1);
}
function tryAllocate(tag) {
  if (!isAvailable(tag)) return false;
  const n = nodesByTag[tag];
  alloc[n.spec][tag] = (alloc[n.spec][tag] || 0) + 1;
  return true;
}
// Center of Mass has prereqs Weaponry3, Weaponry4, Weaponry1
check(!tryAllocate('Skills.Perk.BodyShots'), 'cannot allocate Center of Mass before any prereq');
check(tryAllocate('Skills.Attribute.Weaponry1'), 'allocate Weaponry1 (no prereqs)');
// With OR-semantics, allocating Weaponry1 should now unlock CoM
check(tryAllocate('Skills.Perk.BodyShots'), 'CoM allocatable after Weaponry1 (OR-semantics)');

console.log('\n== Cost summing ==');
let spSpent = 0;
for (const [spec, specAlloc] of Object.entries(alloc)) {
  for (const [tag, rank] of Object.entries(specAlloc)) {
    const c = costs[tag];
    for (let r = 1; r <= rank; r++) spSpent += (c?.[r - 1] || 1);
  }
}
const max = costs._maxSPLevel200;
console.log(`  spent: ${spSpent} / ${max} (${Object.keys(alloc.Trooper).length} nodes allocated)`);
check(spSpent > 0 && spSpent <= max, 'allocation total fits within budget');

// =============================================================================
// Skill-calc golden tests
// -----------------------------------------------------------------------------
// Imports the SAME computeSkillBonuses() the renderer uses (lib/skill-bonuses.js)
// — so these checks run the exact production aggregator, not a parallel copy.
// Adding a new bonus key in the shared file is automatically picked up here;
// you only need to add a new checkBonuses() case to lock in expected output.
// =============================================================================
console.log('\n== Skill-calc golden tests ==');

// Dynamic import of the dual-export CommonJS file — Node's ESM loader returns
// module.exports as the default export.
const sharedMod = await import('../lib/skill-bonuses.js');
const { computeSkillBonuses } = sharedMod.default || sharedMod;

// The renderer merges stats-per-rank.json into each node at load time
// (n.statsPerRank = statsPerRank[n.tag]). Replicate that here so the
// nodesByTag we pass to the aggregator has the same shape it sees in prod.
const statsPerRank = loadJson('stats-per-rank.json');
for (const n of Object.values(nodesByTag)) {
  const sr = statsPerRank[n.tag];
  if (Array.isArray(sr) && sr.length > 0) n.statsPerRank = sr;
}

function checkBonuses(name, state, expected) {
  const got = computeSkillBonuses({ ...state, nodesByTag });
  const keys = Object.keys(expected);
  const mismatches = keys.filter(k => Math.abs((got[k] || 0) - expected[k]) > 0.001);
  if (mismatches.length === 0) {
    console.log(`  ✓ ${name}`);
  } else {
    console.log(`  ✗ ${name}`);
    for (const k of mismatches) console.log(`      ${k}: expected ${expected[k]}, got ${got[k]}`);
    failures++;
  }
}

// --- Step 1: Ranged Damage % from attribute nodes ---
checkBonuses(
  'baseline: nothing allocated → 0 bonuses',
  { allocations: {}, equipped: { techniques: [] }, context: {} },
  { rangedDamagePct: 0, headshotDamagePct: 0 }
);
checkBonuses(
  'Weaponry1 r1 → +3% ranged',
  { allocations: { Trooper: { 'Skills.Attribute.Weaponry1': 1 } } },
  { rangedDamagePct: 3 }
);
checkBonuses(
  'Weaponry1 r3 → +9% ranged',
  { allocations: { Trooper: { 'Skills.Attribute.Weaponry1': 3 } } },
  { rangedDamagePct: 9 }
);
checkBonuses(
  'Weaponry1 r3 + MentalCalculus2 r2 → +9 + +6 = +15% ranged (additive)',
  { allocations: {
      Trooper: { 'Skills.Attribute.Weaponry1': 3 },
      Mentat:  { 'Skills.Attribute.MentalCalculus2': 2 },
  } },
  { rangedDamagePct: 15 }
);

// --- Step 2: Headshot Damage % (techniques + situational stacking) ---
checkBonuses(
  'Marksman r3 equipped → +20% headshot',
  { allocations: { Mentat: { 'Skills.Perk.HeadShots': 3 } },
    equipped: { techniques: ['Skills.Perk.HeadShots', null, null] } },
  { headshotDamagePct: 20 }
);
checkBonuses(
  'Marksman r3 allocated but NOT equipped → 0 (techniques must be slotted)',
  { allocations: { Mentat: { 'Skills.Perk.HeadShots': 3 } },
    equipped: { techniques: [null, null, null] } },
  { headshotDamagePct: 0 }
);
checkBonuses(
  'Center of Mass r3 equipped → -25% headshot penalty + 0% ranged (Body% is step 3)',
  { allocations: { Trooper: { 'Skills.Perk.BodyShots': 3 } },
    equipped: { techniques: ['Skills.Perk.BodyShots', null, null] } },
  { headshotDamagePct: -25, rangedDamagePct: 0 }
);
checkBonuses(
  'Marksman r3 + CoM r3 both equipped → +20 + -25 = -5% net headshot',
  { allocations: {
      Mentat:  { 'Skills.Perk.HeadShots': 3 },
      Trooper: { 'Skills.Perk.BodyShots': 3 },
    },
    equipped: { techniques: ['Skills.Perk.HeadShots', 'Skills.Perk.BodyShots', null] } },
  { headshotDamagePct: -5 }
);

// --- Step 3: Body Damage % from Center of Mass ---
checkBonuses(
  'CoM r1 equipped → +10% body',
  { allocations: { Trooper: { 'Skills.Perk.BodyShots': 1 } },
    equipped: { techniques: ['Skills.Perk.BodyShots', null, null] } },
  { bodyDamagePct: 10 }
);
checkBonuses(
  'CoM r3 equipped → +20% body (with the -25% head penalty also exposed)',
  { allocations: { Trooper: { 'Skills.Perk.BodyShots': 3 } },
    equipped: { techniques: ['Skills.Perk.BodyShots', null, null] } },
  { bodyDamagePct: 20, headshotDamagePct: -25 }
);
checkBonuses(
  'CoM allocated but not equipped → 0 body (techniques must be slotted)',
  { allocations: { Trooper: { 'Skills.Perk.BodyShots': 3 } },
    equipped: { techniques: [null, null, null] } },
  { bodyDamagePct: 0 }
);

// --- Steps 5-7: per-family / blade / shield bonuses ---
checkBonuses(
  'MentalCalculus4 r3 → +15% pistol',
  { allocations: { Mentat: { 'Skills.Attribute.MentalCalculus4': 3 } } },
  { pistolDamagePct: 15 }
);
checkBonuses(
  'MentalCalculus5 r3 → +15% rifle',
  { allocations: { Mentat: { 'Skills.Attribute.MentalCalculus5': 3 } } },
  { rifleDamagePct: 15 }
);
checkBonuses(
  'CoM r3 equipped also surfaces blade + shield damage',
  { allocations: { Trooper: { 'Skills.Perk.BodyShots': 3 } },
    equipped: { techniques: ['Skills.Perk.BodyShots', null, null] } },
  { bladeDamagePct: 20, shieldDamagePct: 20 }
);
// Gap-closure tests for v2-curve resolutions
checkBonuses(
  'Weaponry2 r3 → +15% carbine (Disruptor M11)',
  { allocations: { Trooper: { 'Skills.Attribute.Weaponry2': 3 } } },
  { carbineDamagePct: 15 }
);
checkBonuses(
  'Weaponry3 r3 → +15% scattergun (GRDA 44, Drillshot FK7)',
  { allocations: { Trooper: { 'Skills.Attribute.Weaponry3': 3 } } },
  { scattergunDamagePct: 15 }
);
checkBonuses(
  'Weaponry5 r3 → +15% heavy (Lasgun, LMG, Flamethrower, Missile, Pyrocket)',
  { allocations: { Trooper: { 'Skills.Attribute.Weaponry5': 3 } } },
  { heavyDamagePct: 15 }
);
checkBonuses(
  'Blade1 r3 → +15% blade (Short+Long Blade attribute node)',
  { allocations: { Swordmaster: { 'Skills.Attribute.Blade1': 3 } } },
  { bladeDamagePct: 15 }
);
// Long Blade Damage (Blade2) → longBladeDamagePct bucket; does NOT leak into
// the generic bladeDamagePct. Renderer gates it onto Long-class weapons only.
checkBonuses(
  'Blade2 r3 (Long Blade) → +15% longBlade, 0 generic blade',
  { allocations: { Swordmaster: { 'Skills.Attribute.Blade2': 3 } } },
  { longBladeDamagePct: 15, bladeDamagePct: 0, shortBladeDamagePct: 0 }
);
// Short Blade Damage (WeirdingWay2) → shortBladeDamagePct bucket.
checkBonuses(
  'WeirdingWay2 r3 (Short Blade) → +15% shortBlade, 0 generic blade',
  { allocations: { 'Bene Gesserit': { 'Skills.Attribute.WeirdingWay2': 3 } } },
  { shortBladeDamagePct: 15, bladeDamagePct: 0, longBladeDamagePct: 0 }
);

// --- Steps 8-10: character pools + mitigation ---
// NOTE: curve values are stored cumulatively at each rank (rank N = level-N
// value from the curve, NOT the sum of ranks 1..N). r3 of Vitality is +55 HP
// total, not 25+40+55=120.
checkBonuses(
  'SelfControl3 r3 (Vitality) → +55 Max Health flat at level 3',
  { allocations: { 'Bene Gesserit': { 'Skills.Attribute.SelfControl3': 3 } } },
  { maxHealthFlat: 55 }
);
checkBonuses(
  'SelfControl3 r1 (Vitality) → +25 Max Health flat at level 1',
  { allocations: { 'Bene Gesserit': { 'Skills.Attribute.SelfControl3': 1 } } },
  { maxHealthFlat: 25 }
);
checkBonuses(
  'Aggression3 r3 (General Conditioning) → +25 Max Stamina at level 3',
  { allocations: { Swordmaster: { 'Skills.Attribute.Aggression3': 3 } } },
  { maxStaminaFlat: 25 }
);
checkBonuses(
  'Scientist3 r3 (Rerouting) → +10% Power Regen at level 3 (attribute, always-on)',
  { allocations: { Planetologist: { 'Skills.Attribute.Scientist3': 3 } } },
  { powerRegenPct: 10 }
);
checkBonuses(
  'SuspensorTech1 r3 → -20% Suspensor Power Drain at level 3 (attribute, always-on)',
  { allocations: { Trooper: { 'Skills.Attribute.SuspensorTech1': 3 } } },
  { suspensorDrainPct: -20 }
);
checkBonuses(
  'ToughLunge r3 equipped + lunging → +50% Damage Mitigation at level 3',
  { allocations: { Swordmaster: { 'Skills.Perk.ToughLunge': 3 } },
    equipped: { techniques: ['Skills.Perk.ToughLunge', null, null] },
    context: { lunging: true } },
  { mitigationPct: 50 }
);
checkBonuses(
  'ToughLunge r3 equipped but NOT lunging → 0 mitigation (context-gated)',
  { allocations: { Swordmaster: { 'Skills.Perk.ToughLunge': 3 } },
    equipped: { techniques: ['Skills.Perk.ToughLunge', null, null] },
    context: { lunging: false } },
  { mitigationPct: 0 }
);
checkBonuses(
  'ToughLunge r3 allocated but NOT equipped → 0 mitigation (slot required)',
  { allocations: { Swordmaster: { 'Skills.Perk.ToughLunge': 3 } },
    equipped: { techniques: [null, null, null] },
    context: { lunging: true } },
  { mitigationPct: 0 }
);

// --- DeathFromAbove: damage-side context-gated technique ---
checkBonuses(
  'DfA r3 equipped + suspended → +20% Damage While Suspended',
  { allocations: { Trooper: { 'Skills.Perk.DeathFromAbove': 3 } },
    equipped: { techniques: ['Skills.Perk.DeathFromAbove', null, null] },
    context: { suspended: true } },
  { suspendedDamagePct: 20 }
);
checkBonuses(
  'DfA r3 equipped but NOT suspended → 0 (context-gated)',
  { allocations: { Trooper: { 'Skills.Perk.DeathFromAbove': 3 } },
    equipped: { techniques: ['Skills.Perk.DeathFromAbove', null, null] },
    context: { suspended: false } },
  { suspendedDamagePct: 0 }
);
checkBonuses(
  'DfA r3 NOT equipped + suspended → 0 (slot required)',
  { allocations: { Trooper: { 'Skills.Perk.DeathFromAbove': 3 } },
    equipped: { techniques: [null, null, null] },
    context: { suspended: true } },
  { suspendedDamagePct: 0 }
);

// --- Step 12: parked stamina/power/poison wires ---
// ThriveOnDanger is 1-rank only — allocating rank 1 is the max.
checkBonuses(
  'ThriveOnDanger r1 equipped → -15% stamina costs + +10% health regen',
  { allocations: { Swordmaster: { 'Skills.Perk.ThriveOnDanger': 1 } },
    equipped: { techniques: ['Skills.Perk.ThriveOnDanger', null, null] } },
  { staminaCostPct: -15, healthRegenPct: 10 }
);
checkBonuses(
  'SprintStamina r3 equipped → +20% stamina recovery rate',
  { allocations: { Swordmaster: { 'Skills.Perk.SprintStamina': 3 } },
    equipped: { techniques: ['Skills.Perk.SprintStamina', null, null] } },
  { staminaRecoveryPct: 20 }
);
checkBonuses(
  'BatteryExpert r3 equipped → -9% power usage',
  { allocations: { Planetologist: { 'Skills.Perk.BatteryExpert': 3 } },
    equipped: { techniques: ['Skills.Perk.BatteryExpert', null, null] } },
  { powerUsagePct: -9 }
);
checkBonuses(
  'MetabolizePoison r1 equipped → +20% poison mitigation (1-rank technique)',
  { allocations: { 'Bene Gesserit': { 'Skills.Perk.MetabolizePoison': 1 } },
    equipped: { techniques: ['Skills.Perk.MetabolizePoison', null, null] } },
  { poisonMitigationPct: 20 }
);
// Technique stats only apply when SLOTTED (consistent with other techniques)
checkBonuses(
  'ThriveOnDanger r1 allocated but NOT equipped → 0',
  { allocations: { Swordmaster: { 'Skills.Perk.ThriveOnDanger': 1 } },
    equipped: { techniques: [null, null, null] } },
  { staminaCostPct: 0, healthRegenPct: 0 }
);
// --- Aggregator-only keys (no UI wire today but must populate from data) ---
checkBonuses(
  'SelfControl1 r3 (Recovery) → +20% Healing Regen Limit (aggregator-only)',
  { allocations: { 'Bene Gesserit': { 'Skills.Attribute.SelfControl1': 3 } } },
  { healingRegenLimitPct: 20 }
);
checkBonuses(
  'Aggression2 r3 (Optimized Hydration) → +25% hydrated stamina (aggregator-only)',
  { allocations: { Swordmaster: { 'Skills.Attribute.Aggression2': 3 } } },
  { hydratedStaminaPct: 25 }
);

console.log('\n== Summary ==');
if (failures === 0) {
  console.log(`  ALL CHECKS PASSED`);
  process.exit(0);
} else {
  console.log(`  ${failures} CHECK(S) FAILED`);
  process.exit(1);
}
