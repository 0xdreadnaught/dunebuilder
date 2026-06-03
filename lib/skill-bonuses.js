// Pure aggregator for skill-tree bonuses. Single source of truth shared by:
//   - renderer.js (loaded via <script src> in index.html BEFORE renderer.js
//     so the constants and computeSkillBonuses are available as globals)
//   - test/skill-tree-smoke.mjs (loaded via dynamic import — Node returns
//     module.exports as the default export)
//
// Add a new bonus key here when a new skill-tree stat needs to drive a number
// in the calc pipeline. Bump the parseStats() switch to extract the new label.
// The golden tests in test/skill-tree-smoke.mjs run this exact function, so
// any new key automatically benefits from the test harness once a golden case
// is added for it.

(function () {
  // Techniques whose stat lines are ability tuning (cooldown/cost/duration of
  // the triggered ability itself) and aren't useful as a passive contribution.
  // Equipping these is still allowed; they just don't contribute to bonuses.
  const TECHNIQUE_HIDE_TAGS = new Set([
    'Skills.Perk.IronWill',
    'Skills.Perk.PoisonTooth',
    'Skills.Perk.SuspensorDash',
  ]);

  // Situational techniques whose bonus only applies in a specific gameplay
  // context. Mapped to the corresponding flag on state.context — when the
  // flag is true, the technique contributes; otherwise it's skipped.
  const TECHNIQUE_CONTEXT = {
    'Skills.Perk.DeathFromAbove':  { key: 'suspended', label: 'Suspended' },
    'Skills.Perk.ToughLunge':      { key: 'lunging',   label: 'Lunging' },
    'Skills.Perk.ExploitWeakness': { key: 'exploited', label: 'Exploited' },
  };

  // Parse a percent string like "+6%" or "-15%" into a signed number (6, -15).
  // Non-percent strings (raw integers, durations) contribute 0 to the pool.
  function parsePct(s) {
    if (typeof s !== 'string') return 0;
    const m = s.match(/^([+-]?)([0-9.]+)%$/);
    return m ? parseFloat(m[2]) * (m[1] === '-' ? -1 : 1) : 0;
  }

  // Parse a flat-number string like "55" or "+25" or "-10" into a signed number.
  // Used for skill stats stored without a % suffix (Max Health, Max Stamina).
  function parseFlat(s) {
    if (typeof s !== 'string') return 0;
    const m = s.match(/^([+-]?)([0-9.]+)$/);
    return m ? parseFloat(m[2]) * (m[1] === '-' ? -1 : 1) : 0;
  }

  // Extract every supported stat from a single rank's stat dict and add into
  // the running bonus accumulator. Centralised here so renderer + test can't
  // disagree about which labels feed which buckets.
  function applyRankStats(b, stats) {
    if (!stats || typeof stats !== 'object') return;
    if (stats['Ranged Damage']   != null) b.rangedDamagePct   += parsePct(stats['Ranged Damage']);
    if (stats['Headshot Damage'] != null) b.headshotDamagePct += parsePct(stats['Headshot Damage']);
    if (stats['Body Damage']     != null) b.bodyDamagePct     += parsePct(stats['Body Damage']);
    if (stats['Pistol Damage']       != null) b.pistolDamagePct     += parsePct(stats['Pistol Damage']);
    if (stats['Rifle Damage']        != null) b.rifleDamagePct      += parsePct(stats['Rifle Damage']);
    if (stats['Disruptor Damage']    != null) b.carbineDamagePct    += parsePct(stats['Disruptor Damage']);
    if (stats['Scattergun Damage']   != null) b.scattergunDamagePct += parsePct(stats['Scattergun Damage']);
    if (stats['Heavy Weapon Damage'] != null) b.heavyDamagePct      += parsePct(stats['Heavy Weapon Damage']);
    if (stats['Blade Damage']        != null) b.bladeDamagePct      += parsePct(stats['Blade Damage']);
    if (stats['Shield Damage']       != null) b.shieldDamagePct     += parsePct(stats['Shield Damage']);
    // Short/Long Blade Damage feed dedicated buckets; the renderer gates each
    // onto weapons whose bladeClass matches (data/weapons.json). Generic Blade
    // Damage above still applies to every melee weapon.
    if (stats['Short Blade Damage'] != null) b.shortBladeDamagePct += parsePct(stats['Short Blade Damage']);
    if (stats['Long Blade Damage']  != null) b.longBladeDamagePct  += parsePct(stats['Long Blade Damage']);

    // Step 8-10: character resource pools + mitigation (separate from damage pool).
    if (stats['Max Health']            != null) b.maxHealthFlat      += parseFlat(stats['Max Health']);
    if (stats['Max Stamina']           != null) b.maxStaminaFlat     += parseFlat(stats['Max Stamina']);
    if (stats['Power Regeneration']    != null) b.powerRegenPct      += parsePct(stats['Power Regeneration']);
    if (stats['Suspensor Power Drain'] != null) b.suspensorDrainPct  += parsePct(stats['Suspensor Power Drain']);
    if (stats['Damage Mitigation']     != null) b.mitigationPct      += parsePct(stats['Damage Mitigation']);

    // DeathFromAbove. Context-gated by `suspended`. Closes the last damage-side
    // skill-tree gap; ExploitWeakness/ShieldWeakpoint also have damage stats
    // but their per-rank curves aren't in the extracted data yet — they read
    // as Duration only today.
    if (stats['Damage While Suspended'] != null) b.suspendedDamagePct += parsePct(stats['Damage While Suspended']);

    // Step 12: Stamina + Power + Mitigation extensions wired into existing UI.
    if (stats['Stamina Costs']         != null) b.staminaCostPct      += parsePct(stats['Stamina Costs']);
    if (stats['Stamina Recovery Rate'] != null) b.staminaRecoveryPct  += parsePct(stats['Stamina Recovery Rate']);
    if (stats['Power Usage']           != null) b.powerUsagePct       += parsePct(stats['Power Usage']);
    if (stats['Poison Mitigation']     != null) b.poisonMitigationPct += parsePct(stats['Poison Mitigation']);

    // Aggregator-only (no right-panel UI surface yet — visible in left-panel
    // Skills/Techniques summary via the per-rank lookup). Adding keys here so
    // they're queryable when a UI surface lands; today they're inert in calcs.
    if (stats['Healing Regen Rate']            != null) b.healingRegenRatePct      += parsePct(stats['Healing Regen Rate']);
    if (stats['Healing Regen Limit']           != null) b.healingRegenLimitPct     += parsePct(stats['Healing Regen Limit']);
    if (stats['Healing Effectiveness']         != null) b.healingEffectivenessPct  += parsePct(stats['Healing Effectiveness']);
    if (stats['Healkit Instant Restoration']   != null) b.healkitRestorationPct    += parsePct(stats['Healkit Instant Restoration']);
    if (stats['Health Regeneration']           != null) b.healthRegenPct           += parsePct(stats['Health Regeneration']);
    if (stats['Hydrated Stamina Bonus']        != null) b.hydratedStaminaPct       += parsePct(stats['Hydrated Stamina Bonus']);
    if (stats['Dehydrated Stamina Limit']      != null) b.dehydratedStaminaPct     += parsePct(stats['Dehydrated Stamina Limit']);
    if (stats['Climbing Stamina Drain']        != null) b.climbingStaminaPct       += parsePct(stats['Climbing Stamina Drain']);
  }

  // Sums up every skill-tree-sourced bonus active in the given build state:
  //   - allocated attribute nodes (always active once allocated)
  //   - equipped techniques (only active while slotted in a technique slot)
  //   - equipped situational techniques (skipped unless their context flag is on)
  //
  // Arguments:
  //   allocations: { [spec]: { [tag]: rank } }
  //   equipped:    { techniques: [tag|null, tag|null, tag|null] }
  //   context:     { suspended?: bool, lunging?: bool, exploited?: bool }
  //   nodesByTag:  { [tag]: { spec, skillType, statsPerRank: [{...}, ...] } }
  //
  // Returns: a flat object of bonus keys. Every key in the returned shape
  // defaults to 0 so consumers can do `b.rangedDamagePct` without guarding.
  function computeSkillBonuses({ allocations, equipped, context, nodesByTag } = {}) {
    const b = {
      rangedDamagePct: 0,
      headshotDamagePct: 0,
      bodyDamagePct: 0,
      pistolDamagePct: 0,      // MentalCalculus4 (Pistol Damage)
      rifleDamagePct: 0,       // MentalCalculus5 (Rifle Damage)
      carbineDamagePct: 0,     // Weaponry2 (Disruptor Damage) → Disruptor M11
      scattergunDamagePct: 0,  // Weaponry3 (Scattergun Damage) → GRDA 44, Drillshot FK7
      heavyDamagePct: 0,       // Weaponry5 (Heavy Weapon Damage) → Lasgun, LMG, Flamethrower, Missile Launcher, Pyrocket
      bladeDamagePct: 0,       // Blade1/WeirdingWay1 (generic Blade Damage) — all melee
      shortBladeDamagePct: 0,  // WeirdingWay2 (Short Blade Damage) — Short-class only
      longBladeDamagePct: 0,   // Blade2 (Long Blade Damage) — Long-class only
      shieldDamagePct: 0,      // Center of Mass technique
      // Character resource pools + mitigation (separate from damage pool).
      maxHealthFlat: 0,        // SelfControl3 (Vitality) — +55 HP per rank
      maxStaminaFlat: 0,       // Aggression3 (General Conditioning) — +25 stamina per rank
      powerRegenPct: 0,        // Scientist3 (Rerouting) — +10% per rank
      suspensorDrainPct: 0,    // SuspensorTech1 (Suspensor Efficiency) — -20% per rank (negative)
      mitigationPct: 0,        // ToughLunge (Reckless Lunge) — +50% per rank, context-gated by lunging
      suspendedDamagePct: 0,   // DeathFromAbove — +20% damage while suspended (context-gated)
      // Step 12 — wired to existing UI surfaces:
      staminaCostPct: 0,       // ThriveOnDanger — -15% stamina costs (folds into Dash Cost)
      staminaRecoveryPct: 0,   // SprintStamina (Disciplined Breathing) — +20% stamina regen
      powerUsagePct: 0,        // BatteryExpert (Conservation of Energy) — -9% power usage (folds into suspensor drain)
      poisonMitigationPct: 0,  // MetabolizePoison — +20% poison mitigation (folds into vs Poison EHP row)
      // Step 12 — aggregator-only (no right-panel UI yet; left-panel summary already shows them):
      healingRegenRatePct: 0,       // RegenCap (Trauma Recovery)
      healingRegenLimitPct: 0,      // SelfControl1 (Recovery) + RegenCap
      healingEffectivenessPct: 0,   // SelfControl4 (Self-Healing) — heal-item potency
      healkitRestorationPct: 0,     // Aggression1 (Field Medicine) — healkit instant restore
      healthRegenPct: 0,            // ThriveOnDanger
      hydratedStaminaPct: 0,        // Aggression2 (Optimized Hydration)
      dehydratedStaminaPct: 0,      // Aggression4 (Desert Conditioning)
      climbingStaminaPct: 0,        // Explorer2 (Mountaineer)
    };
    const _alloc = allocations || {};
    const _equip = (equipped || {}).techniques || [];
    const _ctx   = context || {};
    const _nodes = nodesByTag || {};

    // Attribute nodes — every allocated rank contributes regardless of slotting.
    for (const spec of Object.keys(_alloc)) {
      const specAlloc = _alloc[spec] || {};
      for (const tag of Object.keys(specAlloc)) {
        const node = _nodes[tag];
        if (!node) continue;
        if ((node.skillType || '').toLowerCase() !== 'attribute') continue;
        const rank = specAlloc[tag] || 0;
        if (rank <= 0) continue;
        const stats = (node.statsPerRank || [])[rank - 1];
        applyRankStats(b, stats);
      }
    }

    // Equipped techniques — must be slotted; hidden tags skipped entirely;
    // context-gated tags whose flag is false also skipped.
    for (const tag of _equip) {
      if (!tag) continue;
      if (TECHNIQUE_HIDE_TAGS.has(tag)) continue;
      const ctx = TECHNIQUE_CONTEXT[tag];
      if (ctx && !_ctx[ctx.key]) continue;
      const node = _nodes[tag];
      if (!node) continue;
      const rank = (_alloc[node.spec] || {})[tag] || 0;
      if (rank <= 0) continue;
      const stats = (node.statsPerRank || [])[rank - 1];
      applyRankStats(b, stats);
    }

    return b;
  }

  const api = {
    TECHNIQUE_HIDE_TAGS,
    TECHNIQUE_CONTEXT,
    parsePct,
    computeSkillBonuses,
  };

  // Dual export. In Electron's renderer process (browser context) we attach
  // each name to globalThis/window so renderer.js can use them without an
  // import statement. Under Node's ESM loader the same file is dynamic-
  // imported by the test, where module.exports becomes the default export.
  if (typeof window !== 'undefined') {
    Object.assign(window, api);
  } else if (typeof globalThis !== 'undefined' && typeof module === 'undefined') {
    Object.assign(globalThis, api);
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})();
