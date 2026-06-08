'use strict';

// Compact layout flag: set by main.js via ?compact=1 when display is short.
if (new URLSearchParams(location.search).get('compact') === '1') {
  document.documentElement.classList.add('compact-layout');
}

// =============================================
// CONSTANTS
// =============================================
const LABEL_OVERRIDES = {
  'Energy': 'Power',
  'Regen per Second': 'Power Regen/s',
  'Power Drain (%)': 'Power Drain %',
};
// Stamina regen is FLAT (per second), NOT a percentage of max. Confirmed structurally via Ghidra:
// UDuneCharacterAttributeSet.StaminaRegenPerTick default = 20, and BP_PassiveStaminaRegen_GE has
// Period = 0.05s. The custom UDuneStaminaRegenExecution scales the per-tick amount by the period
// (otherwise 20/tick × 20 ticks/sec = 400/sec, which is absurd), netting ~20 stamina/sec. The exact
// per-tick scaling inside the execution isn't fully decompiled, but 20/sec is the gameplay-plausible
// value and the only flat reading consistent with the attribute name + period. Revisit if in-game
// stamina-refill timing disagrees. (2026-05-28)
const STAMINA_REGEN_PER_SEC = 20.0;
const STAMINA_REGEN_PCT = 0.20; // back-compat constant: 20% of starting 100 max stamina. Use STAMINA_REGEN_PER_SEC for correct math.
const STAMINA_REGEN_DELAY = 3.0; // seconds before regen starts. Ghidra-confirmed via UDuneCharacterAttributeSet.StaminaRegenDelay (2026-05-28)
const BASE_STATS = { Health: 150, Stamina: 100, Energy: 0 }; // Power=0 until power pack equipped
const BASE_INVENTORY = { slots: 35, volume: 175.0 };

// Build-save format version. Bump ONLY when the saved schema changes shape (slug encoding,
// new required fields, renamed keys) — NOT for calc/constant tweaks, since derived stats are
// recomputed on load and never persisted. migrateBuildData() keys off this to bring old saves
// forward. Saves written before versioning existed have no formatVersion → treated as 0 (legacy).
const BUILD_FORMAT_VERSION = 1;
let APP_VERSION = null; // cached at startup for the informational stamp on exports (best-effort)

// Hydrated Stamina Bonus (Aggression2: +15/20/25%) multiplies max stamina, but only while the
// Innate hydration buff to MAX STAMINA. Confirmed from DT_HydrationStates
// (GE_DehydratedState / GE_HydratedBonus1 / GE_HydratedBonus2 at the 30% / 70%
// hydration-bar thresholds) + in-game measurement: max stamina is the floor
// (base 100 + Max Stamina keystones + General Conditioning) multiplied by a
// hydration factor that depends on the current hydration tier:
//   low  (<30%):  +0%   — the bare floor
//   mid  (30-70%): +25%
//   high (>70%):  +50%
// Optimized Hydration (Aggression2) adds ON TOP, additively, at the two hydrated
// tiers (not when dehydrated). e.g. floor 130 → 130×1.50=195 at high; with 1 pt
// Optimized Hydration (+15%) → 130×1.65=214.5≈215. Matches the live panel.
const HYDRATION_INNATE = { low: 0, mid: 0.25, high: 0.50 };
// Hydration tier derived from the 0–100 hydration percent (the bar position).
// Thresholds match DT_HydrationStates (70% / 30%); upper edge inclusive.
function hydrationTier() {
  const ctx = (typeof SKILL_TREE_STATE !== 'undefined' && SKILL_TREE_STATE.context) || {};
  const pct = typeof ctx.hydrationPct === 'number' ? ctx.hydrationPct : 100;
  return pct >= 70 ? 'high' : pct >= 30 ? 'mid' : 'low';
}
function hydrationStaminaMul() {
  const tier = hydrationTier();
  const innate = HYDRATION_INNATE[tier] ?? 0.50;
  const opt = tier === 'low' ? 0 : (getSkillBonuses().hydratedStaminaPct || 0) / 100;
  return 1 + innate + opt;
}

// =============================================
// PARSING
// =============================================

/**
 * Extracts and parses the JSON block following a named === section header.
 * @param {string} text - Full pasted text
 * @param {string} section - Section title, e.g. "DUNEBUILDER EXPORT"
 * @returns {object|null}
 */
function extractSection(text, section) {
  const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const headerPattern = new RegExp(`={3,}\\s*${escaped}\\s*={3,}\\s*`, 'i');
  const headerMatch = headerPattern.exec(text);
  if (!headerMatch) return null;

  // Find the first '{' after the header, then brace-match to find the full JSON block
  const afterHeader = text.slice(headerMatch.index + headerMatch[0].length);
  const braceStart = afterHeader.indexOf('{');
  if (braceStart === -1) return null;

  let depth = 0;
  let end = -1;
  for (let i = braceStart; i < afterHeader.length; i++) {
    if (afterHeader[i] === '{') depth++;
    else if (afterHeader[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) return null;

  try {
    return JSON.parse(afterHeader.slice(braceStart, end + 1));
  } catch (e) {
    console.error(`Failed to parse JSON for "${section}":`, e.message);
    return null;
  }
}

/**
 * Parses a "current/max" resource string like "143/205".
 * @param {string} value
 * @returns {{ current: number, max: number }|null}
 */
function parseResource(value) {
  const match = String(value).match(/^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/);
  if (!match) return null;
  return { current: parseFloat(match[1]), max: parseFloat(match[2]) };
}

/**
 * Parses clipboard text into build data.
 * @param {string} text
 * @returns {{ duneExport: true, slots: object, hotbar: object|null, specializations: object|null, skills: object|null }|null}
 */
function parseClipboardText(text) {
  const duneExport = extractSection(text, 'DUNEBUILDER EXPORT');
  if (!duneExport) return null;
  return {
    duneExport: true,
    slots: duneExport.slots || {},
    hotbar: duneExport.hotbar || null,
    specializations: duneExport.specializations || null,
    skills: duneExport.skills || null,
  };
}

// =============================================
// DOM FACTORIES
// =============================================

function createStatRow(label, value, formula, rows) {
  const row = document.createElement('div');
  row.className = 'stat-row';

  const labelEl = document.createElement('span');
  labelEl.className = 'stat-label';
  labelEl.textContent = label;

  const valueEl = document.createElement('span');
  valueEl.className = 'stat-value';
  valueEl.textContent = value;

  row.appendChild(labelEl);
  row.appendChild(valueEl);

  if (formula || (rows && rows.length)) {
    row.addEventListener('mouseenter', e => showFormulaTooltip(label, value, formula, e, rows));
    row.addEventListener('mousemove',  e => positionStatFormulaTooltip(e));
    row.addEventListener('mouseleave', hideStatFormulaTooltip);
  }

  return row;
}

function createResourceBar(label, { current, max }, cssKey, regenPerSec, regenDelay, breakdown) {
  const wrapper = document.createElement('div');
  wrapper.className = 'resource-bar-wrapper';
  wrapper.dataset.resource = cssKey || label;

  const labelEl = document.createElement('span');
  labelEl.className = 'resource-label';
  labelEl.textContent = label;

  const bar = document.createElement('div');
  bar.className = `resource-bar resource-bar--${(cssKey || label).toLowerCase()}`;

  const fill = document.createElement('div');
  fill.className = 'resource-bar__fill';
  fill.style.width = '0%';

  // Live state — mutated in place by setMax/setRegen so the click handler
  // below always reads the current values. Capturing `max` / `regenPerSec`
  // directly into the closure would leave click+drain replaying the OLD max
  // after refreshAfterSpecChange() runs (which is what skill-tree
  // allocations now trigger).
  const state = { max, regenPerSec: regenPerSec || 0, regenDelay: regenDelay || 0 };

  const startPct = state.max > 0 ? (current / state.max) * 100 : 0;

  const text = document.createElement('span');
  text.className = 'resource-bar__text';
  text.textContent = `${formatNumber(Math.round(current))} / ${formatNumber(Math.round(state.max))}`;

  bar.appendChild(fill);
  bar.appendChild(text);
  wrapper.appendChild(labelEl);
  wrapper.appendChild(bar);

  // Expose live setters so in-place updates from refreshAfterSpecChange()
  // can keep both the displayed text AND the click-drain math in sync.
  wrapper._setMax = (newMax) => {
    state.max = newMax;
    text.textContent = `${formatNumber(Math.round(newMax))} / ${formatNumber(Math.round(newMax))}`;
  };
  wrapper._setRegenPerSec = (newRegen) => { state.regenPerSec = newRegen || 0; };

  // Animate: snap to current%, then regen to 100% if not full
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      fill.style.width = `${startPct}%`;
      if (startPct < 100) {
        setTimeout(() => {
          fill.style.width = '100%';
          text.textContent = `${formatNumber(Math.round(state.max))} / ${formatNumber(Math.round(state.max))}`;
        }, 600);
      }
    });
  });

  // Hover tooltip: HP / Stamina / Power source breakdown.
  // Mirrors the right-panel stat-row hover pattern so the same formula tip
  // doubles up here. Caller passes a `breakdown` object describing the parts
  // that summed to `max`; we synthesize a generic+computed formula plus a
  // contributor row list that names each skill node contributing flat HP.
  if (breakdown && breakdown.staminaFloor != null) {
    // Stamina = (base + Max Stamina keystones + General Conditioning) × hydration
    // multiplier. Innate hydration buff (+0/+25/+50% by tier) + Optimized Hydration
    // fold into the multiplier. Formula spells out the flat sum (no "Floor" jargon).
    const innate = breakdown.innatePct || 0;
    const opt = breakdown.optPct || 0;
    const mul = 1 + (innate + opt) / 100;
    const tierLabel = { high: 'Fully hydrated (>70%)', mid: 'Hydrated (30–70%)', low: 'Dehydrated (<30%)' }[breakdown.hydrationTier] || 'Hydration';
    const sym = ['Base'];
    const num = [formatNumber(breakdown.base || 0)];
    const rows = [{ label: 'Base', value: formatNumber(breakdown.base || 0) }];
    if (breakdown.spec)      { rows.push({ label: 'Spec keystones',       value: `+${formatNumber(breakdown.spec)}` });      sym.push('Spec');      num.push(formatNumber(breakdown.spec)); }
    if (breakdown.skillFlat) { rows.push({ label: 'General Conditioning', value: `+${formatNumber(breakdown.skillFlat)}` }); sym.push('Gen Cond'); num.push(formatNumber(breakdown.skillFlat)); }
    rows.push({ label: tierLabel, value: `+${formatNumber(innate)}%` });
    if (opt) rows.push({ label: 'Optimized Hydration', value: `+${formatNumber(opt)}%` });
    const multi = num.length > 1;
    const symLeft = multi ? `(${sym.join(' + ')})` : sym[0];
    const numLeft = multi ? `(${num.join(' + ')})` : num[0];
    const formula = `${symLeft} × (1 + ${formatNumber(innate + opt)}%)\n${numLeft} × ${mul.toFixed(2)} = ${formatNumber(Math.round(state.max))}`;
    bar.addEventListener('mouseenter', e => showFormulaTooltip(
      `Max ${label}`, formatNumber(Math.round(state.max)), formula, e, rows));
    bar.addEventListener('mousemove',  e => positionStatFormulaTooltip(e));
    bar.addEventListener('mouseleave', hideStatFormulaTooltip);
  } else if (breakdown && breakdown.pasted != null) {
    // Pasted-panel path (HP): the value is the in-game final max (level + keystones + skills already
    // baked in), so there's nothing to add up — just label it as ground truth.
    bar.addEventListener('mouseenter', e => showFormulaTooltip(
      `Max ${label}`, formatNumber(Math.round(breakdown.pasted)),
      'From your pasted character panel\n(includes level scaling, keystones & skills)', e, []));
    bar.addEventListener('mousemove',  e => positionStatFormulaTooltip(e));
    bar.addEventListener('mouseleave', hideStatFormulaTooltip);
  } else if (breakdown && breakdown.garmentPower) {
    // Power: saved base power pool plus flat Maximum Power from gear (Power Harness).
    const base = Math.round(breakdown.powerBase || 0);
    const gear = Math.round(breakdown.garmentPower);
    const formula = `Base + Gear\n${formatNumber(base)} + ${formatNumber(gear)} = ${formatNumber(Math.round(state.max))}`;
    const rows = [
      { label: 'Base Power', value: formatNumber(base) },
      { label: 'Gear (Maximum Power)', value: `+${formatNumber(gear)}` },
    ];
    bar.addEventListener('mouseenter', e => showFormulaTooltip(
      `Max ${label}`, formatNumber(Math.round(state.max)), formula, e, rows));
    bar.addEventListener('mousemove',  e => positionStatFormulaTooltip(e));
    bar.addEventListener('mouseleave', hideStatFormulaTooltip);
  } else if (breakdown && (breakdown.base != null || breakdown.spec || breakdown.skillFlat || (breakdown.contributors && breakdown.contributors.length))) {
    const fmtSigned = v => (v > 0 ? '+' : '') + formatNumber(Math.round(v));
    const formulaParts = [];
    const computedParts = [];
    if (breakdown.base != null) {
      formulaParts.push('Base');
      computedParts.push(formatNumber(Math.round(breakdown.base)));
    }
    if (breakdown.spec) {
      formulaParts.push('+ Spec');
      computedParts.push(`+ ${formatNumber(Math.round(breakdown.spec))}`);
    }
    if (breakdown.skillFlat) {
      formulaParts.push('+ Skill');
      computedParts.push(`+ ${formatNumber(Math.round(breakdown.skillFlat))}`);
    }
    const formula = formulaParts.length > 1
      ? `${formulaParts.join(' ')}\n${computedParts.join(' ')} = ${formatNumber(Math.round(state.max))}`
      : null;
    const rows = [];
    if (breakdown.spec) {
      rows.push({ label: 'Spec Bonus', value: fmtSigned(breakdown.spec) });
    }
    if (Array.isArray(breakdown.contributors)) {
      for (const c of breakdown.contributors) {
        rows.push({ label: `${c.nodeName} r${c.rank}`, value: c.value });
      }
    }
    bar.addEventListener('mouseenter', e => showFormulaTooltip(`Max ${label}`, formatNumber(Math.round(state.max)), formula, e, rows));
    bar.addEventListener('mousemove',  e => positionStatFormulaTooltip(e));
    bar.addEventListener('mouseleave', hideStatFormulaTooltip);
  }

  // Click to drain + regen
  let regenAnim = null;
  let regenTimeout = null;
  bar.addEventListener('click', e => {
    if (regenAnim) { cancelAnimationFrame(regenAnim); regenAnim = null; }
    if (regenTimeout) { clearTimeout(regenTimeout); regenTimeout = null; }

    const rect = bar.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    let cur = pct * state.max;

    // Disable CSS transition for instant snap
    fill.style.transition = 'none';
    fill.style.width = `${(cur / state.max) * 100}%`;
    text.textContent = `${formatNumber(Math.round(cur))} / ${formatNumber(Math.round(state.max))}`;

    if (state.regenPerSec && cur < state.max) {
      const delayMs = state.regenDelay * 1000;
      function startRegen() {
        let lastTime = performance.now();
        function tick(now) {
          const dt = (now - lastTime) / 1000;
          lastTime = now;
          cur = Math.min(state.max, cur + state.regenPerSec * dt);
          fill.style.width = `${(cur / state.max) * 100}%`;
          text.textContent = `${formatNumber(Math.round(cur))} / ${formatNumber(Math.round(state.max))}`;
          if (cur < state.max) {
            regenAnim = requestAnimationFrame(tick);
          } else {
            regenAnim = null;
          }
        }
        regenAnim = requestAnimationFrame(tick);
      }
      if (delayMs > 0) {
        regenTimeout = setTimeout(startRegen, delayMs);
      } else {
        startRegen();
      }
    }
  });

  return wrapper;
}

// =============================================
// RENDERING
// =============================================

function renderCharacterPanel(itemStats) {
  const container = document.getElementById('character-stats');
  container.innerHTML = '';
  const barsHolder = document.createElement('div');
  barsHolder.className = 'char-bars';
  container.appendChild(barsHolder);
  renderResourceBars(barsHolder);

  const extrasHolder = document.createElement('div');
  extrasHolder.className = 'char-extras';
  container.appendChild(extrasHolder);
  renderCharExtras(extrasHolder, itemStats);
}

// Vertical hydration bar: click sets context.hydrationPct (0–100) to the clicked
// vertical position (no drag, no snap). Fill shows the exact %, dashed lines mark
// the 70%/30% stamina-tier boundaries. Replaces the old Settings dropdown.
function buildHydrationBar() {
  const ctx = (typeof SKILL_TREE_STATE !== 'undefined' && SKILL_TREE_STATE.context) || {};
  const pct = typeof ctx.hydrationPct === 'number' ? ctx.hydrationPct : 100;
  const wrap = document.createElement('div');
  wrap.className = 'hydration-bar';
  const track = document.createElement('div');
  track.className = 'hydration-bar__track';
  const fill = document.createElement('div');
  fill.className = 'hydration-bar__fill';
  fill.style.height = `${pct}%`;
  const m70 = document.createElement('div'); m70.className = 'hydration-bar__mark hydration-bar__mark--70';
  const m30 = document.createElement('div'); m30.className = 'hydration-bar__mark hydration-bar__mark--30';
  track.append(fill, m70, m30);
  const label = document.createElement('span');
  label.className = 'hydration-bar__label';
  label.textContent = `${Math.round(pct)}%`;
  wrap.append(track, label);
  track.addEventListener('click', e => {
    const r = track.getBoundingClientRect();
    const p = Math.max(0, Math.min(100, Math.round((r.bottom - e.clientY) / r.height * 100)));
    if (typeof SKILL_TREE_STATE !== 'undefined' && SKILL_TREE_STATE.context) SKILL_TREE_STATE.context.hydrationPct = p;
    // Update only this bar's fill/label, then recompute Stamina (and dashes/EHP)
    // in place. Hydration touches Stamina max alone, so don't re-render the
    // resource bars — that would re-animate HP/Power for no reason.
    fill.style.height = `${p}%`;
    label.textContent = `${p}%`;
    refreshAfterSpecChange();
  });
  // Tooltip reads live state so it stays accurate after the bar is clicked.
  track.addEventListener('mouseenter', e => {
    const cur = (typeof SKILL_TREE_STATE !== 'undefined' && SKILL_TREE_STATE.context
      && typeof SKILL_TREE_STATE.context.hydrationPct === 'number') ? SKILL_TREE_STATE.context.hydrationPct : 100;
    const t = hydrationTier();
    const innate = { high: 50, mid: 25, low: 0 }[t];
    const tierName = { high: 'Fully hydrated', mid: 'Hydrated', low: 'Dehydrated' }[t];
    showFormulaTooltip('Hydration', `${Math.round(cur)}%`, `${tierName} → +${innate}% max stamina`, e,
      [{ label: '> 70%', value: '+50%' }, { label: '30–70%', value: '+25%' }, { label: '< 30%', value: '+0%' }]);
  });
  track.addEventListener('mousemove', e => positionStatFormulaTooltip(e));
  track.addEventListener('mouseleave', hideStatFormulaTooltip);
  return wrap;
}

/** Resource bars (Health, Stamina, Power). All three are computed from
 *  base (150/100/0) + skill nodes + Combat keystones + gear — leveling grants
 *  no resources (confirmed 2026-06-02), so there is nothing to import; the
 *  build defines everything. The hover breakdown lets the user trace each
 *  source. Animations only run on first build. */
function renderResourceBars(container) {
  const powerPool  = getEquippedStat('pack', 'power pool');
  const basePowerRegen = getEquippedStat('pack', 'regen per second');
  const sb = getSpecBonuses();
  const skb = getSkillBonuses();
  // Skill-tree contribution to power regen — multiplicative on the pack's base
  // regen (e.g. +10% Scientist3 turns 5/s into 5.5/s).
  const powerRegen = basePowerRegen != null
    ? basePowerRegen * (1 + (skb.powerRegenPct || 0) / 100)
    : null;

  // Two-column layout: vertical hydration bar (left) + the resource bars (right).
  const resources = document.createElement('div');
  resources.className = 'char-bars__resources';
  container.appendChild(buildHydrationBar());
  container.appendChild(resources);

  if (BASE_STATS.Health > 0) {
    const max = getMaxHealth();
    const breakdown = {
      base: BASE_STATS.Health,
      spec: sb.health,
      skillFlat: skb.maxHealthFlat || 0,
      contributors: getSkillContributors(['Max Health']),
    };
    resources.appendChild(createResourceBar('Health', { current: max, max }, 'Health', null, 0, breakdown));
  }
  if (BASE_STATS.Stamina > 0) {
    // Floor = base + Max Stamina keystones + General Conditioning (the <30% value).
    // Displayed max = Floor × hydration multiplier (innate +0/+25/+50% by tier +
    // Optimized Hydration). hydrationStaminaMul() encodes the active tier.
    const tier = hydrationTier();
    const floor = getStaminaFloor();
    const max = getMaxStamina();
    const regen = STAMINA_REGEN_PER_SEC * (1 + (skb.staminaRecoveryPct || 0) / 100);
    const breakdown = {
      staminaFloor: floor,
      base: BASE_STATS.Stamina,
      spec: sb.stamina,
      skillFlat: skb.maxStaminaFlat || 0,
      hydrationTier: tier,
      innatePct: (HYDRATION_INNATE[tier] ?? 0.5) * 100,
      optPct: tier === 'low' ? 0 : (skb.hydratedStaminaPct || 0),
      contributors: getSkillContributors(['Max Stamina']),
    };
    resources.appendChild(createResourceBar('Stamina', { current: max, max }, 'Stamina', regen, STAMINA_REGEN_DELAY, breakdown));
  }
  {
    // Power = pack power pool + gear Maximum Power (Power Harness +50). No skill
    // or keystone grants max power. Shared with the right-panel power calcs via
    // getMaxPower() so the bar and every power calc agree.
    const garmentPower = getGarmentMaxPower();
    const basePwr = powerPool || 0;
    const pp = getMaxPower() ?? garmentPower; // pack+gear, or gear-only when no pack
    const pBreak = garmentPower ? { powerBase: basePwr, garmentPower } : null;
    resources.appendChild(createResourceBar('Power', { current: pp, max: pp }, 'Energy', powerRegen, 0, pBreak));
  }
}

/** Equipment + Inventory + Spec readouts. Safe to re-render on spec changes
 *  without touching (and re-animating) the resource bars above. */
function renderCharExtras(container, itemStats) {
  container.innerHTML = '';

  // Trim stats that aren't meaningful in the Equipment aggregate:
  //  - Power Pool is shown as the Power bar.
  //  - Volume is each equipped item's inventory footprint (irrelevant once worn);
  //    the Inventory section below shows the real backpack-capacity Volume.
  const hasPack = getEquippedStat('pack', 'power pool') !== null;
  if (itemStats) {
    if (hasPack) delete itemStats['Power Pool'];
    delete itemStats['Volume'];
    // Shield's "Power Drain (%)" is its run cost — surfaced on the shield's own
    // tooltip and folded into the right-side Power/Suspension calcs, not a
    // character stat for the Equipment aggregate.
    delete itemStats['Power Drain (%)'];
  }

  if (itemStats && Object.keys(itemStats).length > 0) {
    const label = document.createElement('div');
    label.className = 'stats-section-label';
    label.textContent = 'Equipment';
    container.appendChild(label);
    for (const [key, value] of Object.entries(itemStats)) {
      container.appendChild(createStatRow(LABEL_OVERRIDES[key] || key, value));
    }
  }

  // Inventory section — character carrying capacity, always shown.
  const invHeading = document.createElement('div');
  invHeading.className = 'stats-section-label';
  invHeading.textContent = 'Inventory';
  container.appendChild(invHeading);

  const invBonus = getSpecBonuses();
  const slots = BASE_INVENTORY.slots + invBonus.inventorySlots;
  const volume = Math.round((BASE_INVENTORY.volume * invBonus.backpackVolumeMul) * 10) / 10;
  container.appendChild(createStatRow('Slots', formatNumber(slots)));
  container.appendChild(createStatRow('Volume', `${formatNumber(volume, 1)}v`));

  // Skills section — allocated attribute nodes from the K-menu tree.
  // Display-only for now; calc wire-up is the next pass.
  const skillsHolder = document.createElement('div');
  skillsHolder.id = 'skills-summary';
  container.appendChild(skillsHolder);
  renderSkillsSummary();

  // Techniques section — currently equipped Skills.Perk.* nodes (slotted
  // into one of the 3 technique slots). Display-only for now.
  const techHolder = document.createElement('div');
  techHolder.id = 'techniques-summary';
  container.appendChild(techHolder);
  renderTechniquesSummary();

  // Spec sections holder — populated by renderSpecSummary().
  const specHolder = document.createElement('div');
  specHolder.id = 'spec-summary';
  container.appendChild(specHolder);
  renderSpecSummary();
}

/** Walks SKILL_TREE_STATE.allocations, surfacing the stat lines of allocated
 *  attribute nodes (Ranged Damage, Scattergun Damage, etc) in the left panel.
 *  Skipped silently if nothing is allocated yet or skill-tree data hasn't loaded. */
function renderSkillsSummary() {
  const container = document.getElementById('skills-summary');
  if (!container) return;
  container.innerHTML = '';
  if (!SKILL_TREE_STATE.loaded) return;

  // Collect every allocated attribute node, sum its current-rank stats.
  const rows = [];
  for (const spec of Object.keys(SKILL_TREE_STATE.allocations)) {
    const specAlloc = SKILL_TREE_STATE.allocations[spec] || {};
    for (const tag of Object.keys(specAlloc)) {
      const node = SKILL_TREE_STATE.nodesByTag[tag];
      const rank = specAlloc[tag] || 0;
      if (!node || rank <= 0) continue;
      if ((node.skillType || '').toLowerCase() !== 'attribute') continue;
      const stats = (node.statsPerRank || [])[rank - 1];
      if (!stats || typeof stats !== 'object') continue;
      for (const [label, value] of Object.entries(stats)) {
        rows.push({ label, value, tag });
      }
    }
  }
  if (rows.length === 0) return;

  const heading = document.createElement('div');
  heading.className = 'stats-section-label';
  heading.textContent = 'Skills';
  container.appendChild(heading);
  for (const r of rows) {
    container.appendChild(createStatRow(r.label, r.value));
  }
}

// TECHNIQUE_HIDE_TAGS, TECHNIQUE_CONTEXT, parsePct, and computeSkillBonuses
// live in lib/skill-bonuses.js (loaded as a <script src> before renderer.js).
// They're attached as globals on window for direct reference here.

/** Mirrors renderSkillsSummary but for techniques. Only techniques currently
 *  equipped in one of the 3 technique slots contribute — matches in-game
 *  behavior where allocating a technique unlocks it but the bonus only
 *  applies while slotted. Situational techniques are further gated by the
 *  context toggles (Suspended / Lunging / Exploited). */
function renderTechniquesSummary() {
  const container = document.getElementById('techniques-summary');
  if (!container) return;
  container.innerHTML = '';
  if (!SKILL_TREE_STATE.loaded) return;

  const equipped = (SKILL_TREE_STATE.equipped || {}).techniques || [];
  const context = SKILL_TREE_STATE.context || {};

  // First pass: figure out which context toggles to show (only for situational
  // techniques the player has actually equipped).
  const visibleContexts = [];
  for (const tag of equipped) {
    const ctx = tag && TECHNIQUE_CONTEXT[tag];
    if (ctx && !visibleContexts.some(c => c.key === ctx.key)) {
      visibleContexts.push(ctx);
    }
  }
  // Hydration is no longer a chip — it's a 3-tier selector in Settings (the innate
  // +0/+25/+50% max-stamina buff always applies, so it isn't a per-build toggle).

  // Second pass: collect rows from equipped techniques, skipping hidden tags
  // and context-gated ones whose toggle is off.
  const rows = [];
  for (const tag of equipped) {
    if (!tag) continue;
    if (TECHNIQUE_HIDE_TAGS.has(tag)) continue;
    const ctx = TECHNIQUE_CONTEXT[tag];
    if (ctx && !context[ctx.key]) continue;
    const node = SKILL_TREE_STATE.nodesByTag[tag];
    if (!node) continue;
    const specAlloc = SKILL_TREE_STATE.allocations[node.spec] || {};
    const rank = specAlloc[tag] || 0;
    if (rank <= 0) continue;
    const stats = (node.statsPerRank || [])[rank - 1];
    if (!stats || typeof stats !== 'object') continue;
    for (const [label, value] of Object.entries(stats)) {
      rows.push({ label, value });
    }
  }

  if (visibleContexts.length === 0 && rows.length === 0) return;

  const heading = document.createElement('div');
  heading.className = 'stats-section-label';
  heading.textContent = 'Techniques';
  container.appendChild(heading);

  if (visibleContexts.length > 0) {
    const chipRow = document.createElement('div');
    chipRow.className = 'tech-context-row';
    for (const c of visibleContexts) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'tech-context-chip' + (context[c.key] ? ' active' : '');
      chip.textContent = c.label;
      chip.dataset.contextKey = c.key;
      chip.addEventListener('click', () => {
        SKILL_TREE_STATE.context[c.key] = !SKILL_TREE_STATE.context[c.key];
        persistSkillTreeState();
        renderTechniquesSummary();
        // Lunging flips ToughLunge's mitigation bonus on/off — needs the same
        // EHP recompute that spec changes trigger. Other contexts piggyback.
        refreshAfterSpecChange();
      });
      chipRow.appendChild(chip);
    }
    container.appendChild(chipRow);
  }

  for (const r of rows) {
    container.appendChild(createStatRow(r.label, r.value));
  }
}

/** In-place text update for an existing bar — used on spec changes so we
 *  don't trigger the snap-then-regen animation. Routes through the bar's
 *  internal setter so the click-to-drain handler picks up the new max. */
function updateResourceBarMaxInPlace(resourceKey, newMax) {
  const wrapper = document.querySelector(`.resource-bar-wrapper[data-resource="${resourceKey}"]`);
  if (!wrapper || !wrapper._setMax) return;
  wrapper._setMax(newMax);
}

/** Same idea for the regen rate (Stamina rate is a flat 20/sec scaled by
 *  Disciplined Breathing; Power rate is the pack value multiplied by
 *  Scientist3's bonus). Skips the animation; just updates the value the
 *  click-drain regen reads. */
function updateResourceBarRegenInPlace(resourceKey, newRegenPerSec) {
  const wrapper = document.querySelector(`.resource-bar-wrapper[data-resource="${resourceKey}"]`);
  if (!wrapper || !wrapper._setRegenPerSec) return;
  wrapper._setRegenPerSec(newRegenPerSec);
}

let calcMode = 'def';

function getEquippedStat(slotType, nameFragment) {
  const item = equippedItems[slotType];
  if (!item) return null;
  const stat = Object.values(item.stats || {}).find(s =>
    s.name.toLowerCase().includes(nameFragment.toLowerCase())
  );
  return stat != null ? stat.value : null;
}

/** Flat "Maximum Power" granted by equipped garments/armor, summed across slots.
 *  The Power Harness chest (`combat_heavy_unique_powerincrease_top_06`) gives
 *  +50 and is currently the only item with this stat. The saved build's Energy
 *  value does NOT include it, so it has to be layered onto the power pool like
 *  any other gear contribution. The stat is flat (no perGrade), so the raw value
 *  is correct at every grade. */
function getGarmentMaxPower() {
  let total = 0;
  for (const slot of ARMOR_SLOTS) {
    const v = getEquippedStat(slot, 'maximum power');
    if (typeof v === 'number') total += v;
  }
  return total;
}

// ── Single source of truth for resource maxes ──────────────────────────────
// Both the resource bars and the right-panel calcs read these, so the bar and
// every dependent calc (EHP, dashes, power endurance/recharge/suspension/uptime)
// agree. Return null when the resource isn't present.
function getMaxHealth() {
  if (!(BASE_STATS.Health > 0)) return null;
  return BASE_STATS.Health + getSpecBonuses().health + (getSkillBonuses().maxHealthFlat || 0);
}
/** Pre-hydration stamina (the <30% "dehydrated" floor). */
function getStaminaFloor() {
  if (!(BASE_STATS.Stamina > 0)) return null;
  return BASE_STATS.Stamina + getSpecBonuses().stamina + (getSkillBonuses().maxStaminaFlat || 0);
}
/** Displayed max stamina = floor × hydration multiplier (tier-based). */
function getMaxStamina() {
  const floor = getStaminaFloor();
  return floor == null ? null : floor * hydrationStaminaMul();
}
/** Usable power pool = pack power pool + flat gear "Maximum Power" (Power Harness).
 *  Matches the Power bar. null when no power pack is equipped. */
function getMaxPower() {
  const pack = getEquippedStat('pack', 'power pool');
  return pack == null ? null : pack + getGarmentMaxPower();
}
/** Breakdown rows for the power pool: pack base + gear (when any), so calc
 *  tooltips show the same split as the Power bar. */
function powerPoolRows() {
  const pack = getEquippedStat('pack', 'power pool') || 0;
  const gear = getGarmentMaxPower();
  const rows = [{ label: 'Pack Power Pool', value: formatNumber(pack) }];
  if (gear > 0) rows.push({ label: 'Gear (Maximum Power)', value: `+${formatNumber(gear)}` });
  return rows;
}

/** Player power-efficiency multiplier on EVERY power cost (weapon per-shot,
 *  shield, suspensor). Binary-confirmed: cost = base × PowerEfficiency, default
 *  1.0, driven toward 0. Fed by the efficiency gauntlets' "Power Consumption"
 *  stat and the BatteryExpert skill. See reference-power-consumption-model. */
function getPowerUsageMul() {
  const gauntletPct = aggregateEquippedStats()['Power Consumption'] || 0;
  const skillPct = getSkillBonuses().powerUsagePct || 0;
  return Math.max(0, 1 + gauntletPct / 100 + skillPct / 100);
}

function renderDefCalcs(container, equipped) {
  const powerPool   = getMaxPower(); // pack pool + gear (Maximum Power) — matches the Power bar
  const powerDrain  = getEquippedStat('holtzman', 'power drain (%)');
  const baseRegenPerSec = getEquippedStat('pack', 'regen per second');
  const beltDrain   = getEquippedStat('belt',     'power drain');
  const skb = getSkillBonuses();
  const sb  = getSpecBonuses();
  // Perf: walk the skill tree ONCE for all contributor lookups in this render,
  // then filter by label per call site. Previously each getSkillContributors([...])
  // re-walked the whole allocation tree (~12 walks per def-calc render).
  const _allContribs = getSkillContributors(null);
  const skillContribFor = labels => {
    const set = new Set(labels);
    return _allContribs.filter(c => set.has(c.statLabel));
  };
  // Pack regen scaled by Scientist3 (Power Regeneration %) — applies wherever
  // we cite RegenPerSec for shield-recharge and pack-recharge calcs.
  const regenPerSec = baseRegenPerSec != null
    ? baseRegenPerSec * (1 + (skb.powerRegenPct || 0) / 100)
    : null;

  const hasShield = !!equippedItems['holtzman'];
  const hasPack   = !!equippedItems['pack'];
  const hasBelt   = !!equippedItems['belt'];

  // General power-usage reduction shared by every pack consumer: the efficiency
  // gauntlets' "Power Consumption" stat (negative = less drain) plus the
  // BatteryExpert (Conservation of Energy) skill. Applied to BOTH the shield's
  // drain (Max Damage Absorbed) and the suspensor belt's drain. Floored at 0.
  const powerConsumptionPct = equipped['Power Consumption'] || 0;
  const skillPowerUsagePct  = (skb.powerUsagePct || 0) / 100;
  const powerUsageMul = getPowerUsageMul();

  // Shared formatter for signed percent values in the contributor row lists.
  const fmtSignedPct = pct => (pct > 0 ? '+' : '') + pct.toFixed(pct % 1 ? 1 : 0) + '%';

  // --- EHP section (red — matches Health) ---
  const ehpHeading = document.createElement('div');
  ehpHeading.className = 'stats-section-label stats-section-label--health';
  ehpHeading.textContent = 'Effective Health Pool (EHP)';
  container.appendChild(ehpHeading);

  const maxHealth = getMaxHealth();

  const totalArmor = equipped['Armor Value'] ?? 0;
  const armorMit = (totalArmor / (totalArmor + 500)) * 100;
  // Skill mitigation (e.g. ToughLunge while lunging) stacks additively with the
  // Combat-spec mitigation passive — they share one "specMit" channel before
  // the multiplicative armor combine.
  const specMitBase = sb.mitigationPercent;
  const skillMitPct = skb.mitigationPct || 0;
  const specMit = specMitBase + skillMitPct;

  // Combined Damage Reduction stacks armor and the Combat spec passive
  // multiplicatively: 1 - (1 - armor%) × (1 - spec%).
  const drFraction = 1 - (1 - armorMit / 100) * (1 - specMit / 100);
  const drPercent = drFraction * 100;

  // Each row maps to the armor `equipped[<key>]` mitigation channel. The
  // optional third element names the skill-bonus key whose value adds on top
  // of the gear mitigation (e.g. MetabolizePoison contributes to vs Poison).
  // Fourth element is the short label used in the contributor row list.
  const DAMAGE_TYPES = [
    ['vs Light Dart',  'Light Dart Mitigation', null,                  'LDart Mit'],
    ['vs Heavy Dart',  'Heavy Dart Mitigation', null,                  'HDart Mit'],
    ['vs Energy',      'Energy Mitigation',     null,                  'Energy Mit'],
    ['vs Blade',       'Blade Mitigation',      null,                  'Blade Mit'],
    ['vs Concussive',  'Concussive Mitigation', null,                  'Concussive Mit'],
    ['vs Fire',        'Fire Mitigation',       null,                  'Fire Mit'],
    ['vs Poison',      'Poison Mitigation',     'poisonMitigationPct', 'Poison Mit'],
  ];

  if (maxHealth !== null) {
    const ehpFromMit = (drPct, typePct) => {
      const drMul   = Math.max(0.001, 1 - drPct / 100);
      const typeMul = 1 - typePct / 100;
      return Math.round(maxHealth / (drMul * typeMul));
    };

    // Match the weapon-damage tooltip pattern: each contributor is its own
    // NAMED variable in the symbolic formula and gets a corresponding numeric
    // value in the substitution. No vague "+ Skill 50%" trailing lines.
    let drFormula;
    if (specMit > 0) {
      // Build the mitigation expression piece-wise so SpecMit% and SkillMit%
      // appear as distinct terms (matches how weapon damage shows SkillRGD%,
      // SkillHS%, etc).
      const mitTerms = [];
      const mitVals  = [];
      if (specMitBase) { mitTerms.push('SpecMit%');  mitVals.push((specMitBase / 100).toFixed(4)); }
      if (skillMitPct) { mitTerms.push('SkillMit%'); mitVals.push((skillMitPct  / 100).toFixed(4)); }
      const mitSym = mitTerms.join(' + ');
      const mitNum = mitVals.join(' + ');
      drFormula = `1 - (1 - Armor/(Armor+500)) × (1 - ${mitSym})\n` +
        `1 - (1 - ${(armorMit / 100).toFixed(4)}) × (1 - ${mitNum}) = ${drFraction.toFixed(4)}`;
    } else {
      drFormula = `Armor / (Armor + 500)\n${totalArmor} / (${totalArmor} + 500) = ${drFraction.toFixed(4)}`;
    }

    // Contributor row list for Damage Reduction: armor (always), spec passive,
    // each skill node contributing Damage Mitigation by name. Other EHP rows
    // skip the HP breakdown since the Health-bar tooltip (future) will own it.
    const drRows = [{ label: 'Armor Value', value: `${formatNumber(totalArmor)} → ${(armorMit).toFixed(1)}%` }];
    if (specMitBase) drRows.push({ label: 'Spec Mitigation', value: fmtSignedPct(specMitBase) });
    for (const c of skillContribFor(['Damage Mitigation'])) {
      drRows.push({ label: `${c.nodeName} r${c.rank}`, value: c.value });
    }

    container.appendChild(createStatRow('Damage Reduction',
      `${formatNumber(Math.round(drPercent * 10) / 10, 1)}%`, drFormula, drRows));
    container.appendChild(createStatRow('vs Physical',
      formatNumber(ehpFromMit(drPercent, 0)),
      `Health / (DMG - DR%)\n${formatNumber(maxHealth)} / (1 - ${drFraction.toFixed(4)}) = ${formatNumber(ehpFromMit(drPercent, 0))}`));

    // Per-type rows show only the gear + skill mitigation specific to that
    // damage type. HP breakdown lives on the Health-bar hover tooltip.
    const TYPE_SKILL_STAT_LABELS = {
      poisonMitigationPct: ['Poison Mitigation'],
    };
    DAMAGE_TYPES.forEach(([label, key, skillBonusKey, shortLabel]) => {
      const gearMit = equipped[key] ?? 0;
      const skillMit = skillBonusKey ? (skb[skillBonusKey] || 0) : 0;
      const typeMit = Math.min(95, gearMit + skillMit);
      const drMul   = Math.max(0.001, 1 - drPercent / 100);
      const typeMul = 1 - typeMit / 100;
      let typeSym, typeNum;
      if (skillMit) {
        typeSym = 'GearMit% + SkillMit%';
        typeNum = `${(gearMit / 100).toFixed(4)} + ${(skillMit / 100).toFixed(4)}`;
      } else {
        typeSym = 'TypeMit%';
        typeNum = (typeMit / 100).toFixed(4);
      }
      const formula = `Health / ((DMG - DR%) × (DMG - ${typeSym}))\n` +
        `${formatNumber(maxHealth)} / (${drMul.toFixed(4)} × (1 - ${typeNum})) = ${formatNumber(ehpFromMit(drPercent, typeMit))}`;
      // Row list = mitigation contributors only. Skip rows when only gear is
      // contributing and nothing else, since the value already reads from the
      // headline number.
      const rows = [];
      if (gearMit) rows.push({ label: shortLabel, value: fmtSignedPct(gearMit) });
      if (skillBonusKey) {
        const skillLabels = TYPE_SKILL_STAT_LABELS[skillBonusKey] || [];
        for (const c of skillContribFor(skillLabels)) {
          rows.push({ label: `${c.nodeName} r${c.rank}`, value: c.value });
        }
      }
      container.appendChild(createStatRow(label, formatNumber(ehpFromMit(drPercent, typeMit)), formula, rows));
    });

    // Radiation: not HP damage — a 150,000-rad poisoning meter that fills at a flat rate per zone level,
    // linearly slowed by Radiation Mitigation. Headline shows the range: worst zone (L3) → lightest (L1).
    const RAD_CAPACITY = 150000;
    const RAD_RATES = [['L1', 1500], ['L2', 3000], ['L3', 15000]];
    const radMit = equipped['Radiation Mitigation'] ?? 0;
    const radMul = 1 - radMit / 100;
    const fmtRadTime = secs => {
      if (!isFinite(secs) || secs <= 0) return '∞';
      const total = Math.round(secs), m = Math.floor(total / 60), s = total % 60;
      return m > 0 ? (s > 0 ? `${m}m${s}s` : `${m}m`) : `${s}s`;
    };
    const radSurvival = base => radMul <= 0 ? Infinity : RAD_CAPACITY / (base * radMul);
    container.appendChild(createStatRow('vs Radiation',
      `${fmtRadTime(radSurvival(15000))} - ${fmtRadTime(radSurvival(1500))}`,
      `${formatNumber(RAD_CAPACITY)} rad capacity / (zone rate × (1 - RadMit%))\n` +
      `RadMit ${radMit}% → ${Math.round(radMul * 100)}% of base fill rate\n` +
      RAD_RATES.map(([lvl, base]) => `${lvl} (${formatNumber(base)}/s): ${fmtRadTime(radSurvival(base))}`).join('  ·  ') +
      `\nshown: L3 (worst zone) - L1 (lightest)`));
  }

  // --- Stamina / Dash section (green — matches Stamina) ---
  const staminaHeading = document.createElement('div');
  staminaHeading.className = 'stats-section-label stats-section-label--stamina';
  staminaHeading.textContent = 'Stamina';
  container.appendChild(staminaHeading);

  const BASE_DASH_COST = 35; // Ghidra-confirmed via UDuneCharacterAttributeSet.DashStaminaCost (2026-05-28). Was 30 historically; verify with in-game dash count if it feels off.
  // Hydrated toggle scales max stamina (Aggression2) → more dashes when hydrated.
  const maxStamina = getMaxStamina();
  const gearDashMod  = equipped['Dash Stamina Cost'] ?? 0;
  // ThriveOnDanger's "Stamina Costs -15%" reduces every stamina expenditure,
  // dash included. Stored as a signed percent (negative means reduction).
  const skillStaminaCostPct = skb.staminaCostPct || 0;
  const effectiveCost = Math.max(1, BASE_DASH_COST * (1 + gearDashMod / 100) * (1 + skillStaminaCostPct / 100));

  // Build the cost expression with NAMED variables per contributor.
  const dashTerms = ['BaseCost'];
  const dashNums  = [String(BASE_DASH_COST)];
  if (gearDashMod) {
    dashTerms.push('(1 + GearMod%)');
    dashNums.push(`(1 + ${(gearDashMod / 100).toFixed(2)})`);
  }
  if (skillStaminaCostPct) {
    dashTerms.push('(1 + SkillCost%)');
    dashNums.push(`(1 + ${(skillStaminaCostPct / 100).toFixed(2)})`);
  }
  const dashRows = [{ label: 'Base Dash Cost', value: String(BASE_DASH_COST) }];
  if (gearDashMod) dashRows.push({ label: 'Gear Dash Cost Mod', value: fmtSignedPct(gearDashMod) });
  for (const c of skillContribFor(['Stamina Costs'])) {
    dashRows.push({ label: `${c.nodeName} r${c.rank}`, value: c.value });
  }
  container.appendChild(createStatRow('Dash Cost', formatNumber(Math.round(effectiveCost)),
    `${dashTerms.join(' × ')}\n${dashNums.join(' × ')} = ${formatNumber(Math.round(effectiveCost))}`,
    dashRows));

  if (maxStamina !== null) {
    const rawDashes = maxStamina / effectiveCost;
    const rawRounded = Math.round(rawDashes * 10) / 10;
    const effectiveDashes = Math.ceil(rawRounded);
    container.appendChild(createStatRow('Max Dashes', `${formatNumber(effectiveDashes)} (${formatNumber(rawRounded, 1)})`,
      `Stamina / DashCost\n${formatNumber(maxStamina)} / ${formatNumber(Math.round(effectiveCost))} = ${formatNumber(rawRounded, 1)}`));
  }

  // Mountaineer (Explorer2) reduces climbing stamina drain. The base in-game
  // rate isn't exposed as a stat we can multiply against, so surface this as a
  // percent reduction on the climbing channel — same shape as the other skill
  // contributor rows.
  const climbingDrainPct = skb.climbingStaminaPct || 0;
  if (climbingDrainPct !== 0) {
    const climbRows = [];
    for (const c of skillContribFor(['Climbing Stamina Drain'])) {
      climbRows.push({ label: `${c.nodeName} r${c.rank}`, value: c.value });
    }
    container.appendChild(createStatRow('Climbing Drain', fmtSignedPct(climbingDrainPct),
      `Skill-driven reduction to stamina cost while climbing.\nNet: ${fmtSignedPct(climbingDrainPct)}`,
      climbRows));
  }

  // --- Healing section (red — matches Health) ---
  // All values come from the skill tree (no gear stats feed these yet).
  // Render only the rows whose contributor is actually active.
  const healingRegenRate = skb.healingRegenRatePct || 0;
  const healingRegenLimit = skb.healingRegenLimitPct || 0;
  const healingEffectiveness = skb.healingEffectivenessPct || 0;
  const healkitRestoration = skb.healkitRestorationPct || 0;
  const healthRegen = skb.healthRegenPct || 0;
  const hasHealing = healingRegenRate || healingRegenLimit || healingEffectiveness || healkitRestoration || healthRegen;
  if (hasHealing) {
    const healHeading = document.createElement('div');
    healHeading.className = 'stats-section-label stats-section-label--health';
    healHeading.textContent = 'Healing';
    container.appendChild(healHeading);

    const HEAL_ROWS = [
      ['Healing Regen Rate',    healingRegenRate,    'Healing Regen Rate',         'How fast HP regenerates after taking damage.'],
      ['Healing Regen Limit',   healingRegenLimit,   'Healing Regen Limit',        'Cap on how much HP regen can refill (% of max).'],
      ['Healing Effectiveness', healingEffectiveness,'Healing Effectiveness',      'Multiplier on heal item potency (potions, etc.).'],
      ['Healkit Restoration',   healkitRestoration,  'Healkit Instant Restoration','Instant HP a healkit restores when used.'],
      ['Health Regeneration',   healthRegen,         'Health Regeneration',        'Passive HP/sec regen (ThriveOnDanger).'],
    ];
    HEAL_ROWS.forEach(([label, pct, skillStat, description]) => {
      if (!pct) return;
      const rows = [];
      for (const c of skillContribFor([skillStat])) {
        rows.push({ label: `${c.nodeName} r${c.rank}`, value: c.value });
      }
      container.appendChild(createStatRow(label, fmtSignedPct(pct), description, rows));
    });
  }

  // --- Hydration section (cyan — distinct from Stamina/Health) ---
  const hydratedBonus = skb.hydratedStaminaPct || 0;
  const dehydratedLimit = skb.dehydratedStaminaPct || 0;
  if (hydratedBonus || dehydratedLimit) {
    const hydHeading = document.createElement('div');
    // Reuse the stamina (green) section style — hydration directly affects stamina.
    hydHeading.className = 'stats-section-label stats-section-label--stamina';
    hydHeading.textContent = 'Hydration';
    container.appendChild(hydHeading);

    if (hydratedBonus) {
      const rows = [];
      for (const c of skillContribFor(['Hydrated Stamina Bonus'])) {
        rows.push({ label: `${c.nodeName} r${c.rank}`, value: c.value });
      }
      container.appendChild(createStatRow('Hydrated Stamina Bonus', fmtSignedPct(hydratedBonus),
        'Bonus to max stamina while hydrated.', rows));
    }
    if (dehydratedLimit) {
      const rows = [];
      for (const c of skillContribFor(['Dehydrated Stamina Limit'])) {
        rows.push({ label: `${c.nodeName} r${c.rank}`, value: c.value });
      }
      container.appendChild(createStatRow('Dehydrated Stamina Limit', fmtSignedPct(dehydratedLimit),
        'Raised stamina ceiling when dehydrated (Desert Conditioning).', rows));
    }
  }

  // --- Power section (blue — matches Power Pool) ---
  // Houses everything that draws from the same power pool: shield endurance,
  // recharge time, and suspensor-belt active time.
  const heading = document.createElement('div');
  heading.className = 'stats-section-label stats-section-label--energy';
  heading.textContent = 'Power';
  container.appendChild(heading);

  if (!hasPack) {
    const p = document.createElement('p');
    p.className = 'empty-state';
    p.textContent = 'No power pack equipped';
    container.appendChild(p);
    return;
  }

  // Shield endurance + recharge — only when a shield is also equipped.
  if (hasShield) {
    if (powerPool !== null && powerDrain !== null) {
      const effDrain = powerDrain * powerUsageMul;
      const endurance = Math.round(powerPool / (effDrain / 100));
      const reduced = Math.abs(powerUsageMul - 1) > 1e-6;
      const rows = [
        ...powerPoolRows(),
        { label: 'Shield Power Drain', value: `${formatNumber(powerDrain)}%` },
      ];
      if (reduced) rows.push({ label: 'Power-usage reduction', value: fmtSignedPct((powerUsageMul - 1) * 100) });
      const formula = reduced
        ? `PowerPool / (PowerDrain% × PowerUseMul)\n${formatNumber(powerPool)} / (${(powerDrain / 100).toFixed(4)} × ${powerUsageMul.toFixed(2)}) = ${formatNumber(endurance)}`
        : `PowerPool / (PowerDrain%)\n${formatNumber(powerPool)} / ${(powerDrain / 100).toFixed(4)} = ${formatNumber(endurance)}`;
      container.appendChild(createStatRow('Max Damage Absorbed', formatNumber(endurance), formula, rows));
    }
  }

  if (powerPool !== null && regenPerSec !== null) {
    const recharge = powerPool / regenPerSec;
    const powerRegenSkillPct = skb.powerRegenPct || 0;
    // Regen expression — split into PackRegen × (1 + SkillRegen%) when Scientist3
    // contributes, otherwise just plain Regen.
    const regenSym = powerRegenSkillPct ? 'PackRegen × (1 + SkillRegen%)' : 'Regen';
    const regenNum = powerRegenSkillPct
      ? `${formatNumber(baseRegenPerSec)} × (1 + ${(powerRegenSkillPct / 100).toFixed(2)})`
      : formatNumber(regenPerSec);
    const rechargeRows = [
      ...powerPoolRows(),
      { label: 'Pack Regen/sec',  value: formatNumber(baseRegenPerSec) },
    ];
    for (const c of skillContribFor(['Power Regeneration'])) {
      rechargeRows.push({ label: `${c.nodeName} r${c.rank}`, value: c.value });
    }
    container.appendChild(createStatRow('Full Recharge', `${formatNumber(recharge, 1)}s`,
      `PowerPool / ${regenSym}\n${formatNumber(powerPool)} / ${regenNum} = ${formatNumber(recharge, 1)}s`,
      rechargeRows));
  }

  // Suspension — how long the suspensor belt can run before the pack is empty.
  // Exploration Suspensor Powerdrain Reduction keystones apply as the FINAL
  // layer (same pattern as the Combat damage / mitigation passives).
  if (hasBelt && beltDrain !== null && powerPool !== null) {
    // SuspensorTech1 attribute folds into the same drain multiplier as the
    // Exploration spec keystone reductions. Both store percent deltas; combine
    // additively then floor at 0 (matches the existing spec-side math).
    // BatteryExpert (Conservation of Energy) reduces general Power Usage; the
    // suspensor belt is one consumer of that pool, so it stacks here too.
    const specDrainMul = sb.suspensorDrainMul; // 1.0 = no reduction
    const skillDrainPct = (skb.suspensorDrainPct || 0) / 100;
    const gauntletPct = powerConsumptionPct / 100; // efficiency gauntlets (general power usage)
    const specDelta = specDrainMul - 1.0; // 0 means no spec contribution
    const drainMul = Math.max(0, specDrainMul + skillDrainPct + skillPowerUsagePct + gauntletPct);
    const effectiveDrain = beltDrain * drainMul;
    if (effectiveDrain > 0) {
      const duration = powerPool / effectiveDrain;
      const fmtDur = secs => {
        if (!isFinite(secs) || secs <= 0) return '0s';
        // Preserve the decimal — a fractional second is meaningful here
        // (you don't get the rounded-up time when the pack runs dry).
        if (secs < 60) return `${formatNumber(secs, 1)}s`;
        const m = Math.floor(secs / 60);
        const s = secs - m * 60;
        if (s < 0.05) return `${formatNumber(m)}m`;
        return `${formatNumber(m)}m${formatNumber(s, 1)}s`;
      };
      // Build the DrainMul expression with each contributor as its own named
      // variable. Each variable corresponds to one feeding source so the user
      // can verify wiring without inspecting state.
      const drainSyms = ['1.00'];
      const drainNums = ['1.00'];
      if (Math.abs(specDelta) > 1e-6) {
        drainSyms.push('SpecDrain%');
        drainNums.push((specDelta).toFixed(2));
      }
      if (Math.abs(skillDrainPct) > 1e-6) {
        drainSyms.push('SuspensorTech%');
        drainNums.push((skillDrainPct).toFixed(2));
      }
      if (Math.abs(skillPowerUsagePct) > 1e-6) {
        drainSyms.push('PowerUsage%');
        drainNums.push((skillPowerUsagePct).toFixed(2));
      }
      if (Math.abs(gauntletPct) > 1e-6) {
        drainSyms.push('PowerEff%');
        drainNums.push((gauntletPct).toFixed(2));
      }
      // Outer-paren the DrainMul expression when it has more than one term so
      // it's clearly the second factor of BeltDrain × DrainMul.
      const drainHasMods = drainSyms.length > 1;
      const drainSymWrap = drainHasMods ? `(${drainSyms.join(' + ')})` : '1.00';
      const drainNumWrap = drainHasMods ? `(${drainNums.join(' + ')})` : '1.00';
      const baseFormula = `PowerPool / (BeltDrain × ${drainSymWrap})\n` +
        `${formatNumber(powerPool)} / (${formatNumber(beltDrain)} × ${drainNumWrap}) = ${formatNumber(duration, 1)}s`;
      const simpleFormula = `PowerPool / BeltDrain\n${formatNumber(powerPool)} / ${formatNumber(beltDrain)} = ${formatNumber(duration, 1)}s`;
      const susRows = [
        ...powerPoolRows(),
        { label: 'Belt Power Drain/s', value: formatNumber(beltDrain) },
      ];
      if (Math.abs(specDelta) > 1e-6) {
        susRows.push({ label: 'Spec Suspensor Drain (keystone)', value: fmtSignedPct(specDelta * 100) });
      }
      if (Math.abs(gauntletPct) > 1e-6) {
        susRows.push({ label: 'Power Consumption (gauntlets)', value: fmtSignedPct(powerConsumptionPct) });
      }
      for (const c of skillContribFor(['Suspensor Power Drain', 'Power Usage'])) {
        susRows.push({ label: `${c.nodeName} r${c.rank}`, value: c.value });
      }
      container.appendChild(createStatRow('Suspension', fmtDur(duration),
        drainHasMods ? baseFormula : simpleFormula,
        susRows));
    }
  }
}

function renderCalculations(equipped) {
  const container = document.getElementById('build-stats');
  container.innerHTML = '';

  if (equipped === undefined) equipped = aggregateEquippedStats();

  if (calcMode === 'def') {
    renderDefCalcs(container, equipped);
  } else {
    const p = document.createElement('p');
    p.className = 'empty-state';
    p.textContent = 'Weapon data coming soon';
    container.appendChild(p);
  }
}

function triggerRevealAnimation() {
  const panels = document.querySelectorAll('.panel--left, .panel--right');
  panels.forEach(panel => {
    panel.style.transition = 'none';
    panel.style.opacity = '0';
    panel.style.transform = 'translateY(6px)';
    void panel.offsetWidth; // force reflow
    panel.style.transition = '';
    panel.style.opacity = '';
    panel.style.transform = '';
  });
}

// =============================================
// ERROR DISPLAY
// =============================================

let errorTimeout = null;

function showError(msg) {
  const el = document.getElementById('error-message');
  el.textContent = msg;
  el.classList.add('visible');
  if (errorTimeout) clearTimeout(errorTimeout);
  errorTimeout = setTimeout(() => el.classList.remove('visible'), 4000);
}

// Helpers exposed for engine-ini.js (loaded as a separate <script>).
window.dbHooks = { showError, closeSettings };

// =============================================
// ITEM PICKER
// =============================================

let GARMENT_ITEMS = [];
let WEAPON_ITEMS = [];
let AUGMENT_DATA = [];
let WEAPON_AUGMENT_DATA = [];
let SPECIALIZATIONS_DATA = [];
const specState = {}; // { trackId: { level: 0, keystones: Set<id> } }
const SPEC_TRACK_ORDER = ['craftingtrack', 'gatheringtrack', 'explorationtrack', 'combattrack', 'sabotagetrack'];
let GARMENT_BY_SLUG = new Map();
let WEAPON_BY_SLUG = new Map();
let AUGMENT_BY_SLUG = new Map();
let WEAPON_AUGMENT_BY_SLUG = new Map();
// camelCase stat/effect key → its stripped display name (e.g. armorValue →
// "Armor Value"). Populated at load from the data's own `.name` fields so the
// defense totals (which the EHP/mitigation calcs and Equipment list read by
// display name) can name a key even when no equipped item carries that stat.
const STAT_KEY_DISPLAY = {};
let currentPickerItems = [];
let currentPickerSlotType = null;
const appSettings = loadSettings();

function loadSettings() {
  const defaults = { showCommons: false, showFormulas: true, showT0: false, showT1: false, showT2: false, showT3: false, showT4: false, showT5: false, showWeaponCommons: false, showWeaponT1: false, showWeaponT2: false, showWeaponT3: false, showWeaponT4: false, showWeaponT5: false, persistWeaponTypeFilter: false, applyStaggered: false, applyHeadshot: false };
  try {
    const saved = localStorage.getItem('dunebuilder-settings');
    if (saved) return { ...defaults, ...JSON.parse(saved) };
  } catch { /* ignore corrupt data */ }
  return defaults;
}

function saveSettings() {
  localStorage.setItem('dunebuilder-settings', JSON.stringify(appSettings));
}

// Augment state: { boots: [{ slug, grade, customValues? }, null, null], ... }
const equippedAugments = {};
// How many augment slots are unlocked per armor slot (default 1, max 3)
const augmentSlotUnlocks = {};
// Current augment picker context
let currentAugmentSlotType = null;
let currentAugmentDotIndex = null;

const SLOT_TYPE_MAP = {
  'slot--helm':     'helm',
  'slot--chest':    'chest',
  'slot--gloves':   'gloves',
  'slot--pants':    'pants',
  'slot--boots':    'boots',
  'slot--holtzman': 'holtzman',
  'slot--belt':     'belt',
  'slot--pack':     'pack',
};

const SLOT_LABEL_MAP = {
  helm:     'Helm',
  chest:    'Chest',
  gloves:   'Gloves',
  pants:    'Pants',
  boots:    'Boots',
  holtzman: 'Holtzman Shield',
  belt:     'Suspensor Belt',
  pack:     'Power Pack',
  hotbar0: 'Hotbar 1', hotbar1: 'Hotbar 2', hotbar2: 'Hotbar 3', hotbar3: 'Hotbar 4',
  hotbar4: 'Hotbar 5', hotbar5: 'Hotbar 6', hotbar6: 'Hotbar 7', hotbar7: 'Hotbar 8',
};

const SLOT_ORIGINAL_LABELS = {
  'slot--helm':     'Helm',
  'slot--chest':    'Chest',
  'slot--gloves':   'Gloves',
  'slot--pants':    'Pants',
  'slot--boots':    'Boots',
  'slot--holtzman': 'Holtzman Shield',
  'slot--belt':     'Suspensor Belt',
  'slot--pack':     'Power Pack',
};

const equippedItems = {};
const equippedGrades = {};

// Skill-tree state. Declared here (with the other top-level state) rather than
// down in the SKILL TREE PANEL section because the early init path
// (refreshPanels → renderResourceBars → getSkillBonuses) and the hydrated
// toggle both read it during module evaluation. The full skill-tree code lives
// further down; this is only the state container.
const SKILL_TREE_STATE = {
  data: null,             // mock-v6-data.json
  descriptions: {},       // descriptions.json
  costs: {},              // costs.json
  subTreeLabels: {},      // sub-tree-labels.json
  gt: null,               // gt-skill-tree.json (for spec nav icons)
  loaded: false,
  // allocations: { [spec]: { [tag]: rank, ... }, ... }
  allocations: {},
  // Per-spec rank cache for quick lookup, populated after data load
  nodesByTag: {},         // tag -> { spec, name, prerequisites, ... }
  spSpent: 0,
  spTotal: 199,
  spBase: 199,    // L200 baseline from SkillXPPerLevel curve
  spBonus: 0,     // sum of Combat-spec SkillPoint keystone effects currently claimed
  spBonusBreakdown: '', // tooltip-friendly description (e.g. "+24 from Combat")
  currentSpec: null,
  tt: { node: null, skill: null, previewRank: 1, allocated: 0, max: 1 },
  // Combat-context flags gate situational technique stat lines (e.g.
  // Death from Above only contributes Damage While Suspended when `suspended`
  // is true). Persisted with the rest of the skill-tree state.
  // hydrated defaults ON: the pasted Stamina is the dehydrated floor, so the headline number should
  // be the computed hydrated max (your normal topped-up state). Toggle off to see the bare floor.
  context: { suspended: false, lunging: false, exploited: false, hydrationPct: 100 },
};

const ARMOR_SLOTS = new Set(['helm', 'chest', 'gloves', 'pants', 'boots']);
const GARMENT_SLOTS = new Set(['helm', 'chest', 'gloves', 'pants', 'boots']);

// Hotbar: keys are 'hotbar0' through 'hotbar7' in equippedItems/equippedGrades/etc.
const HOTBAR_SLOTS = new Set(['hotbar0','hotbar1','hotbar2','hotbar3','hotbar4','hotbar5','hotbar6','hotbar7']);
let activeHotbarIndex = null; // 0-7 or null
let weaponTypeFilter = { melee: true, ranged: true }; // for hotbar picker

function getSlotClass(slotEl) {
  return [...slotEl.classList].find(c => c.startsWith('slot--'));
}

function getSlotType(slotEl) {
  const cls = getSlotClass(slotEl);
  return cls ? (SLOT_TYPE_MAP[cls] ?? null) : null;
}

const FLAT_STATS = new Set([
  'armor value', 'heat protection', 'max stack', 'volume',
  'power pool', 'regen per second', 'power drain', 'shield refresh time',
  // Weapon stats
  'damage per shot', 'shield damage per shot', 'clip size', 'dps', 'sustained dps',
  'reload time', 'rate of fire', 'effective range', 'maximum range',
  'damage per hit', 'attack speed',
  'heavy attack damage (shielded)', 'heavy attack damage (unshielded)',
  'shield damage per hit', 'power consumption (per shot)',
  'recoil', 'projectile spread', 'volume', 'aoe radius',
]);

// Stats where a lower numeric value is better (used in tooltip coloring).
// LOWER_IS_BETTER is the superset; tradeoff call sites use the subset (weapon-centric stats only).
const LOWER_IS_BETTER = new Set([
  'Attack Stamina Cost', 'Block Stamina Cost', 'Dash Stamina Cost',
  'Climbing Stamina Cost', 'Recoil', 'Projectile spread', 'Volume',
  'Reload Time', 'Power Consumption', 'Power Consumption (per shot)',
  'Power Drain', 'Sun Stroke Rate',
]);
// Subset used for weapon tradeoff coloring (augment cards and augment tooltip).
const LOWER_BETTER_TRADEOFF_STATS = new Set([
  'Reload Time', 'Recoil', 'Volume', 'Power Consumption (per shot)',
  'Accuracy', 'Projectile spread',
]);

/** Locale-formatted number with optional fixed decimals. Adds thousands
 *  separators ("2,977" instead of "2977"). */
function formatNumber(value, decimals) {
  if (typeof value !== 'number' || !isFinite(value)) return String(value);
  const opts = decimals != null
    ? { minimumFractionDigits: decimals, maximumFractionDigits: decimals }
    : undefined;
  return value.toLocaleString(undefined, opts);
}

function formatStatValue(name, value) {
  if (typeof value !== 'number') return String(value);
  const n = name.toLowerCase().replace(/:$/, '');
  if (FLAT_STATS.has(n)) return formatNumber(value);
  // Accuracy is stored on Funcom's 0–1 scale; show it as a human-readable percent.
  if (n === 'accuracy') return `${formatNumber(Math.round(value * 1000) / 10)}%`;
  // Crit Damage is the per-weapon m_CritDamage multiplier fraction (0.5 = +50%
  // headshot bonus, applied as ×1.50 in the damage formula). Show it as the
  // bonus percent so the card row agrees with the formula's "× Crit × 1.50".
  if (n === 'crit damage') return `+${formatNumber(value * 100)}%`;
  // Maximum Power (Power Harness) is a flat additive bonus to the power pool.
  if (n === 'maximum power') return `${value >= 0 ? '+' : ''}${formatNumber(value)}`;
  return `${formatNumber(value)}%`;
}

async function loadGarmentItems() {
  try {
    // Fetch all data files concurrently. Specializations joins the same batch so
    // its network wait overlaps the others; the .catch keeps a bad spec response
    // from rejecting the whole batch (it stays isolated, same as before).
    const [weaponsRes, garmentsRes, augmentsRes, utilityRes, specRes] = await Promise.all([
      fetch('./data/weapons.json'),
      fetch('./data/garments.json'),
      fetch('./data/augments.json'),
      fetch('./data/utility.json'),
      fetch('./data/specializations.json').catch(e => { console.error('Failed to fetch specializations:', e); return null; }),
    ]);
    // Specializations — parsed in its own try so it doesn't block on a single bad response.
    try {
      if (specRes) {
        SPECIALIZATIONS_DATA = await specRes.json();
        SPECIALIZATIONS_DATA.forEach(track => {
          specState[track.id] = { level: 0, keystones: new Set() };
        });
      }
    } catch (e) {
      console.error('Failed to load specializations:', e);
    }

    const weapons  = await weaponsRes.json();
    const garments = await garmentsRes.json();
    const augments = await augmentsRes.json();
    // Utility items already carry their `slot` baked in by the dataset, so no
    // slot-assignment mapping is needed — they merge straight into the garment pool.
    const utility  = await utilityRes.json();

    WEAPON_ITEMS = weapons;
    GARMENT_ITEMS = [...garments, ...utility];

    // Augments split by `subtype` into the two pools the app keeps:
    //  - weapon pool (ranged/melee) — selectable on hotbar weapons
    //  - garment/generic pool — selectable on garments/utility
    WEAPON_AUGMENT_DATA = augments.filter(a => a.subtype === 'ranged' || a.subtype === 'melee');
    AUGMENT_DATA        = augments.filter(a => a.subtype === 'garment');

    const indexBySlug = (arr) => { const m = new Map(); for (const x of arr) if (!m.has(x.slug)) m.set(x.slug, x); return m; };
    GARMENT_BY_SLUG = indexBySlug(GARMENT_ITEMS);
    WEAPON_BY_SLUG = indexBySlug(WEAPON_ITEMS);
    AUGMENT_BY_SLUG = indexBySlug(AUGMENT_DATA);
    WEAPON_AUGMENT_BY_SLUG = indexBySlug(WEAPON_AUGMENT_DATA);

    // Build the key→display-name map from the data's own `.name` values: item
    // stats first, then augment effect names (skipping the fan-out keys, whose
    // expanded targets are already named by the item stats above).
    const stripColon = s => s.replace(/:$/, '');
    [...weapons, ...garments, ...utility].forEach(it => {
      for (const [k, v] of Object.entries(it.stats || {})) {
        if (v?.name && STAT_KEY_DISPLAY[k] == null) STAT_KEY_DISPLAY[k] = stripColon(v.name);
      }
    });
    augments.forEach(a => (a.effects || []).forEach(e => {
      if (e.key === 'damage' || e.key === 'shieldDamage' || e.key === 'dartMitigation') return;
      if (e.name && STAT_KEY_DISPLAY[e.key] == null) STAT_KEY_DISPLAY[e.key] = stripColon(e.name);
    }));
  } catch (e) {
    console.error('Failed to load items:', e);
  }
}

// =============================================
// KEYED STAT ACCESS + EFFECT REGISTRY
// =============================================

/** Numeric value of a keyed stat at a given grade. Grade scaling reads
 *  `perGrade[grade-1]` (grade 1..maxGrade); falls back to the grade-0 `value`
 *  at grade 0 or when the stat doesn't scale. Returns null when the key is
 *  absent or non-numeric. */
function statValueAt(stats, key, grade) {
  const s = stats?.[key];
  if (!s || typeof s.value !== 'number') return null;
  if (grade > 0 && Array.isArray(s.perGrade) && s.perGrade[grade - 1] != null) {
    return s.perGrade[grade - 1];
  }
  return s.value;
}

/** The keys an effect's `key` routes to. Mirrors the old expandStatKey:
 *  `damage`/`shieldDamage` fan out to the per-shot AND per-hit stat keys, and
 *  `dartMitigation` to the light + heavy mitigation keys. All other keys route
 *  to themselves. */
function expandEffectKey(key) {
  if (key === 'dartMitigation') return ['lightDartMitigation', 'heavyDartMitigation'];
  if (key === 'damage') return ['damagePerShot', 'damagePerHit'];
  if (key === 'shieldDamage') return ['shieldDamagePerShot', 'shieldDamagePerHit'];
  return [key];
}

/** Effect keys whose in-game sign is inverted (Funcom shows a "-40%" accuracy
 *  augment as a buff). The data matches the game's display, so the calc flips
 *  the sign here. */
const SIGN_FLIP_KEYS = new Set(['accuracy']);

/**
 * Resolve a slot's socketed augments into normalized per-stat-key contributions.
 *
 * Returns an array of contribution objects, one per (effect × expanded key):
 *   { key, type, min, max, hasCustom, isTradeoff, augName, augGrade }
 * where `type` is 'percent'|'flat', min/max are the rolled (sign-corrected)
 * bounds for the augment's grade (equal when custom-valued or a single-value
 * effect), and `isTradeoff` marks downside effects (good:false).
 *
 * Behavior preserved from the pre-migration code:
 *  - reads effect.grades[augGrade-1]; null (below min quality) is skipped;
 *  - good:true effects honor a per-effect custom override (keyed by effect.name)
 *    which collapses min==max==custom; good:false (tradeoffs) ignore customs;
 *  - accuracy sign flip applied to both bounds;
 *  - damage/shieldDamage/dartMitigation fan out via expandEffectKey.
 */
function resolveAugmentContribs(slotType, augSlots) {
  const contribs = [];
  // Radiation Suits gain nothing from radiation-mitigation augments (verified in-game).
  // The picker already hides these on a rad suit; this also guards the calc so a build
  // saved before that rule (or hand-edited) still computes correctly and can't show
  // unlimited radiation resistance.
  const isRadSuit = equippedItems[slotType]?.slot === 'radsuit';
  (augSlots || []).forEach(aug => {
    if (!aug || !aug.slug) return;
    const augData = findAugmentData(aug.slug, slotType);
    if (!augData) return;
    const augGrade = aug.grade || 1;
    const gradeIdx = augGrade > 0 ? augGrade - 1 : 0;

    (augData.effects || []).forEach(eff => {
      const g = eff.grades?.[gradeIdx];
      if (!g) return; // null below min quality → skip
      const isTradeoff = eff.good === false;
      const sign = SIGN_FLIP_KEYS.has(eff.key) ? -1 : 1;
      // Tradeoffs never honored custom values (matches old tradeoff path).
      const customVal = isTradeoff ? null : aug.customValues?.[eff.name];
      const hasCustom = customVal != null;
      const min = sign * (hasCustom ? customVal : g[0]);
      const max = sign * (hasCustom ? customVal : g[1]);
      expandEffectKey(eff.key).forEach(key => {
        if (isRadSuit && key === 'radiationMitigation') return;
        contribs.push({
          key, type: eff.op, min, max, hasCustom, isTradeoff,
          augName: augData.name, augGrade,
        });
      });
    });
  });
  return contribs;
}

function createItemCard(item, slotType) {
  const rarityClass = item.rarity === 'Unique' ? 'rarity--unique' : 'rarity--common';
  const card = document.createElement('div');
  card.className = `item-card ${rarityClass}`;

  const img = document.createElement('img');
  img.className = 'item-card__icon';
  img.src = item.icon;
  img.alt = item.name;
  img.loading = 'lazy';

  const info = document.createElement('div');
  info.className = 'item-card__info';

  const nameRow = document.createElement('div');
  nameRow.className = 'item-card__name-row';

  const nameEl = document.createElement('span');
  nameEl.className = 'item-card__name';
  nameEl.textContent = item.tier != null ? `${item.name} (T${item.tier})` : item.name;

  const badge = document.createElement('span');
  badge.className = `item-card__badge ${rarityClass}`;
  badge.textContent = item.rarity;

  nameRow.appendChild(nameEl);
  nameRow.appendChild(badge);

  const statsEl = document.createElement('div');
  statsEl.className = 'item-card__stats';
  Object.values(item.stats || {}).forEach(stat => {
    const s = document.createElement('span');
    s.className = 'item-card__stat';
    s.textContent = `${stat.name.replace(/:$/, '')}: ${formatStatValue(stat.name, stat.value)}`;
    statsEl.appendChild(s);
  });

  info.appendChild(nameRow);
  info.appendChild(statsEl);
  card.appendChild(img);
  card.appendChild(info);

  card.addEventListener('click', () => selectItem(slotType, item.slug));
  return card;
}


function aggregateEquippedStats() {
  const totals = {};
  const seenArmor = new Set(); // only dedupe armor slots (radsuit fills all 5)

  Object.entries(equippedItems).forEach(([slotType, item]) => {
    // Hotbar weapon stats don't feed into the character/defense panel
    if (HOTBAR_SLOTS.has(slotType)) return;
    if (ARMOR_SLOTS.has(slotType)) {
      if (seenArmor.has(item.slug)) return;
      seenArmor.add(item.slug);
    }
    // A rad suit occupies all 5 armor slots; its grade and augments live on the 'helm' key.
    const stateSlot = item.slot === 'radsuit' ? 'helm' : slotType;
    const grade = equippedGrades[stateSlot] || 0;

    // Build per-item stat map (keyed by display name) so augments can modify it
    // before summing. Grade scaling reads perGrade[grade-1] ?? value.
    const itemStats = {};
    for (const [statKey, stat] of Object.entries(item.stats || {})) {
      const v = statValueAt(item.stats, statKey, grade);
      if (v == null) continue;
      const name = stat.name.replace(/:$/, '');
      itemStats[name] = (itemStats[name] || 0) + v;
    }

    // Apply socketed augment effects to this item's stats only. Effects route by
    // camelCase key; translate to the display-name space `itemStats` uses. The
    // aggregate uses each effect's MAX rolled value (or custom override).
    resolveAugmentContribs(stateSlot, equippedAugments[stateSlot]).forEach(c => {
      const name = STAT_KEY_DISPLAY[c.key] || c.key;
      const baseVal = itemStats[name] || 0;
      if (c.type === 'percent') {
        if (baseVal === 0) return; // Percent of nothing is nothing
        itemStats[name] = baseVal * (1 + c.max / 100);
      } else {
        itemStats[name] = baseVal + c.max;
      }
    });

    // Sum this item's (augmented) stats into global totals
    for (const [key, value] of Object.entries(itemStats)) {
      totals[key] = (totals[key] || 0) + value;
    }
  });

  // Clean up IEEE-754 accumulation noise. Source values carry at most a few
  // decimals (e.g., gloves/boots end in .3), but summing binary-inexact
  // fractions like 0.3 leaves artifacts (2951.6 → 2951.6000000000004).
  // Round to 6 dp: removes the ~1e-13 noise while preserving any genuine
  // precision from augment-percent math.
  for (const key of Object.keys(totals)) {
    totals[key] = Math.round(totals[key] * 1e6) / 1e6;
  }

  return totals;
}

// =============================================
// SPECIALIZATIONS — calc integration
// =============================================

// Weapon damage stat keys that get multiplied by the Combat damage passive.
// `sustainedDps` is a synthetic key the ranged path injects (no source stat).
const SPEC_DAMAGE_KEYS = new Set([
  'damagePerShot', 'damagePerHit',
  'shieldDamagePerShot', 'shieldDamagePerHit',
  'heavyAttackDamageShielded', 'heavyAttackDamageUnshielded',
  'dps', 'sustainedDps',
]);

// Display-label remap for ranged (keyed): existing dps is the burst-rate value
// (Damage × RoF/60). The synthetic "sustainedDps" factors in reload time —
// that's the meaningful sustained metric so it gets the "DPS" headline label.
const RANGED_DISPLAY_LABELS = {
  dps: 'Burst DPS',
  sustainedDps: 'DPS',
};

// Display-only label remapping for melee weapon damage rows (keyed). The four
// damage stats break down by attack type (light/heavy) and target state
// (shielded/unshielded); surface them clearly instead of the raw stat names.
const MELEE_DISPLAY_LABELS = {
  damagePerHit: 'Light vs Unshielded',
  shieldDamagePerHit: 'Light vs Shielded',
  heavyAttackDamageUnshielded: 'Heavy vs Unshielded',
  heavyAttackDamageShielded: 'Heavy vs Shielded',
};

// Preferred row order for melee weapon tooltips (keyed) — keeps the four damage
// rows grouped at the top in light→heavy / unshielded→shielded reading order.
const MELEE_STAT_ORDER = [
  'damageType',
  'damagePerHit',
  'shieldDamagePerHit',
  'heavyAttackDamageUnshielded',
  'heavyAttackDamageShielded',
  'dps',
  'attackSpeed',
  'attackStaminaCost',
  'blockStaminaCost',
  'volume',
];

/** Returns how a single damage row is composed from the weapon's one stated
 *  damage value. Every melee/ranged damage row resolves to:
 *    final = (stated + augFlat) × factorMul × hitSplit × (1 + pool%)
 *  where `stated` is the SAME number across all rows that share a primary stat
 *  (e.g., all light/heavy melee rows reference Damage Per Hit, with heavy rows
 *  carrying a ×3 / ×6 multiplier). Returns null if the row isn't a recognised
 *  damage row. `statMap` is { statKey → raw stat object }. */
function getDamageRowSpec(item, statKey, statMap, augEffects) {
  const valOf = key => statMap[key]?.value ?? 0;
  const augmentedValue = (key) => {
    const base = valOf(key);
    const ae = augEffects?.[key];
    if (!ae) return base;
    if (ae.type === 'percent') return base * (1 + ae.max / 100);
    return base + ae.max;
  };
  const fmtN = v => String(Math.round(v * 100) / 100);

  // factorSymExpr / factorNumExpr are inlined into the formula's factor slot
  // so the user sees the full derivation rather than an opaque "Mag/Cycle"
  // bucket. factorLabel is the compact row-below display (e.g. "Mag/Cycle ×2.73").
  const noFactor = { factorMul: 1, factorLabel: '', factorSymExpr: '', factorNumExpr: '' };

  if (item.subtype === 'melee') {
    const dph = valOf('damagePerHit');
    if (statKey === 'damagePerHit') {
      return { ...noFactor, statedKey: 'damagePerHit', statedValue: dph, isPrimary: true };
    }
    if (statKey === 'shieldDamagePerHit') {
      return { ...noFactor, statedKey: 'shieldDamagePerHit', statedValue: valOf('shieldDamagePerHit'), isPrimary: true };
    }
    // DualBlades Flurry uses 2.5× instead of 6× for the shielded heavy (it's a
    // multi-hit flurry where each hit lands, not a single big swing). Source:
    // BP_DualBlades_FlurryShielded_AttackParams.m_DamageDealtOverrideMultiplier (GHID30b).
    // The unshielded heavy still uses the default 3× — Funcom ships no DualBlades-specific
    // unshielded params.
    const isDualBlades = /dualblades/i.test(item.slug || '');
    if (statKey === 'heavyAttackDamageUnshielded') {
      return {
        statedKey: 'damagePerHit', statedValue: dph, isPrimary: false,
        factorMul: 3, factorLabel: 'Heavy ×3', factorSymExpr: 'Heavy', factorNumExpr: '3',
        factorRows: [{ label: 'Heavy', value: '×3' }],
      };
    }
    if (statKey === 'heavyAttackDamageShielded') {
      const mul = isDualBlades ? 2.5 : 6;
      const label = isDualBlades ? 'Heavy ×2.5 (DualBlades)' : 'Heavy ×6';
      return {
        statedKey: 'damagePerHit', statedValue: dph, isPrimary: false,
        factorMul: mul, factorLabel: label, factorSymExpr: 'Heavy', factorNumExpr: String(mul),
        factorRows: [{ label: 'Heavy', value: `×${mul}` }],
      };
    }
    if (statKey === 'dps') {
      const spd = augmentedValue('attackSpeed') || 60;
      const mul = spd / 60;
      return {
        statedKey: 'damagePerHit', statedValue: dph, isPrimary: false,
        factorMul: mul, factorLabel: `Speed/60 ×${mul.toFixed(2)}`,
        factorSymExpr: 'Speed/60', factorNumExpr: `${fmtN(spd)}/60`,
        factorRows: [{ label: 'Attack Speed', value: fmtN(spd) }],
      };
    }
  } else if (item.subtype === 'ranged') {
    const dps = valOf('damagePerShot');
    if (statKey === 'damagePerShot') {
      return { ...noFactor, statedKey: 'damagePerShot', statedValue: dps, isPrimary: true };
    }
    if (statKey === 'shieldDamagePerShot') {
      return { ...noFactor, statedKey: 'shieldDamagePerShot', statedValue: valOf('shieldDamagePerShot'), isPrimary: true };
    }
    if (statKey === 'dps') {
      const rof = augmentedValue('rateOfFire') || 60;
      const mul = rof / 60;
      return {
        statedKey: 'damagePerShot', statedValue: dps, isPrimary: false,
        factorMul: mul, factorLabel: `RoF/60 ×${mul.toFixed(2)}`,
        factorSymExpr: 'RoF/60', factorNumExpr: `${fmtN(rof)}/60`,
        factorRows: [{ label: 'RoF', value: fmtN(rof) }],
      };
    }
    if (statKey === 'sustainedDps') {
      // Average shots-per-second over a full magazine cycle including reload.
      const clip = augmentedValue('clipSize');
      const rof = augmentedValue('rateOfFire') || 60;
      const reload = augmentedValue('reloadTime');
      const cycle = (clip * 60 / rof) + reload;
      const mul = cycle > 0 ? clip / cycle : 0;
      return {
        statedKey: 'damagePerShot', statedValue: dps, isPrimary: false,
        factorMul: mul, factorLabel: `Mag/Cycle ×${mul.toFixed(2)}`,
        factorSymExpr: 'Clip / (Clip × 60/RoF + Reload)',
        factorNumExpr: `${fmtN(clip)} / (${fmtN(clip)} × 60/${fmtN(rof)} + ${fmtN(reload)})`,
        factorRows: [
          { label: 'Clip', value: fmtN(clip) },
          { label: 'RoF', value: fmtN(rof) },
          { label: 'Reload', value: `${fmtN(reload)}s` },
        ],
      };
    }
  }
  return null;
}

/** Aggregated allocated-spec contributions that feed into existing calcs.
 *  Damage bonuses are returned as percentage points (e.g. 100 = +100%) so they
 *  can be summed with augment damage % into a single additive bonus pool —
 *  matching the in-game damage model. */
function getSpecBonuses() {
  const b = {
    health: 0,
    stamina: 0,
    combatDamagePct: 0,      // Combat passive — % to add to damage bonus pool (0–100)
    staggerPct: 0,           // Sabotage stagger passive — 0 unless setting + spec (0–50)
    headHunterPct: 0,        // Sabotage Head Hunter keystones — % to head pool only (0–30)
    mitigationPercent: 0,    // percentage points to add across all mitigation types
    suspensorDrainMul: 1,    // 1.0 = no reduction; 0.7 = 30% less drain
    inventorySlots: 0,       // flat slot additions from Pack Mule keystones
    backpackVolumeMul: 1,    // 1.0 = base; 2.0 = +100% from passive at L100
  };
  if (!SPECIALIZATIONS_DATA?.length) return b;

  for (const track of SPECIALIZATIONS_DATA) {
    const state = specState[track.id];
    if (!state) continue;

    if (track.id === 'combattrack') {
      for (const p of (track.passiveAttributes || [])) {
        const v = p.values?.[state.level] ?? 0;
        if (p.key === 'DamageBonus_SpecTrack') b.combatDamagePct = v * 100;
        if (p.key === 'TotalDamageMitigation_SpecTrack') b.mitigationPercent = v * 100;
      }
      for (const k of (track.keystones || [])) {
        if (!state.keystones.has(k.id)) continue;
        for (const e of (k.effects || [])) {
          if (e.value == null) continue;
          if (e.name === 'Max Health') b.health += e.value;
          if (e.name === 'Max Stamina') b.stamina += e.value;
        }
      }
    }

    if (track.id === 'explorationtrack') {
      // Backpack Volume Capacity passive — stored as a multiplier (1.01→2.0).
      for (const p of (track.passiveAttributes || [])) {
        if (p.key === 'BackpackVolumeCapacityMultiplier') {
          b.backpackVolumeMul = p.values?.[state.level] ?? 1;
        }
      }
      // Pack Mule keystones — flat +5 slots each — and Suspensor drain
      // reductions summed into a final multiplier.
      let drainPct = 0;
      for (const k of (track.keystones || [])) {
        if (!state.keystones.has(k.id)) continue;
        for (const e of (k.effects || [])) {
          if (e.value == null) continue;
          if (e.name === 'Inventory Slot Capacity') b.inventorySlots += e.value;
          if (e.name === 'Suspensor Power Drain') drainPct += e.value;
        }
      }
      b.suspensorDrainMul = Math.max(0, 1 + drainPct);
    }

    if (track.id === 'sabotagetrack') {
      // Damage-to-Staggered passive — applied only when the user toggles the
      // setting (matches our "you've staggered them or you haven't" model).
      if (appSettings.applyStaggered) {
        for (const p of (track.passiveAttributes || [])) {
          if (p.key === 'BackstabDamageBonus_SpecTrack') {
            const v = p.values?.[state.level] ?? 0;
            b.staggerPct = v * 100;
          }
        }
      }
      // Head Hunter keystones — sum the headshot-damage bonuses. Joins the
      // additive pool but only on headshots (and only on weapons that can HS).
      for (const k of (track.keystones || [])) {
        if (!state.keystones.has(k.id)) continue;
        for (const e of (k.effects || [])) {
          if (e.name === 'Headshot Damage' && e.value != null) b.headHunterPct += e.value * 100;
        }
      }
    }
  }
  return b;
}

/** Thin wrapper over the shared computeSkillBonuses() in lib/skill-bonuses.js.
 *  Reads from the live SKILL_TREE_STATE and forwards the four inputs the
 *  shared aggregator needs. Returning the zero-filled default before load
 *  keeps every calc site safe to call unconditionally. */
function getSkillBonuses() {
  if (typeof SKILL_TREE_STATE === 'undefined' || !SKILL_TREE_STATE.loaded) {
    return {
      rangedDamagePct: 0, headshotDamagePct: 0, bodyDamagePct: 0,
      pistolDamagePct: 0, rifleDamagePct: 0, carbineDamagePct: 0, scattergunDamagePct: 0,
      heavyDamagePct: 0, bladeDamagePct: 0, shortBladeDamagePct: 0, longBladeDamagePct: 0, shieldDamagePct: 0,
      maxHealthFlat: 0, maxStaminaFlat: 0,
      powerRegenPct: 0, suspensorDrainPct: 0, mitigationPct: 0,
      suspendedDamagePct: 0,
      staminaCostPct: 0, staminaRecoveryPct: 0,
      powerUsagePct: 0, poisonMitigationPct: 0,
      healingRegenRatePct: 0, healingRegenLimitPct: 0,
      healingEffectivenessPct: 0, healkitRestorationPct: 0,
      healthRegenPct: 0,
      hydratedStaminaPct: 0, dehydratedStaminaPct: 0, climbingStaminaPct: 0,
    };
  }
  return computeSkillBonuses({
    allocations: SKILL_TREE_STATE.allocations,
    equipped:    SKILL_TREE_STATE.equipped,
    context:     SKILL_TREE_STATE.context,
    nodesByTag:  SKILL_TREE_STATE.nodesByTag,
  });
}

/** Walks allocated nodes + equipped techniques and returns every
 *  contributor whose per-rank stats include one of `statLabels`. Mirrors the
 *  gating logic in computeSkillBonuses (attributes always on; techniques only
 *  when slotted + context flag met). Used by right-panel tooltips to list each
 *  specific skill source by name + rank for verification. Returns:
 *    [{ nodeName, rank, statLabel, value }]
 */
function getSkillContributors(statLabels) {
  if (typeof SKILL_TREE_STATE === 'undefined' || !SKILL_TREE_STATE.loaded) return [];
  // null/undefined statLabels => return every contributor (no label filter).
  // Lets a caller walk the tree ONCE and filter the result per stat in JS,
  // instead of re-walking for each label set (see renderDefCalcs).
  const labelSet = statLabels ? new Set(statLabels) : null;
  const _alloc = SKILL_TREE_STATE.allocations || {};
  const _equip = (SKILL_TREE_STATE.equipped || {}).techniques || [];
  const _ctx   = SKILL_TREE_STATE.context || {};
  const _nodes = SKILL_TREE_STATE.nodesByTag || {};
  const out = [];
  for (const spec of Object.keys(_alloc)) {
    const specAlloc = _alloc[spec] || {};
    for (const tag of Object.keys(specAlloc)) {
      const node = _nodes[tag];
      if (!node) continue;
      const rank = specAlloc[tag] || 0;
      if (rank <= 0) continue;
      const skillType = (node.skillType || '').toLowerCase();
      // Techniques: must be slotted, not hidden, and context-gate must pass.
      if (skillType === 'technique') {
        if (!_equip.includes(tag)) continue;
        if (typeof TECHNIQUE_HIDE_TAGS !== 'undefined' && TECHNIQUE_HIDE_TAGS.has(tag)) continue;
        const ctx = typeof TECHNIQUE_CONTEXT !== 'undefined' ? TECHNIQUE_CONTEXT[tag] : null;
        if (ctx && !_ctx[ctx.key]) continue;
      } else if (skillType !== 'attribute') {
        continue;
      }
      const stats = (node.statsPerRank || [])[rank - 1] || {};
      for (const label of Object.keys(stats)) {
        if (labelSet && !labelSet.has(label)) continue;
        out.push({ nodeName: node.name || tag, rank, statLabel: label, value: stats[label] });
      }
    }
  }
  return out;
}

/** Whether a weapon item can land headshots in-game. Driven off the per-weapon
 *  `m_CritDamage` UPROPERTY surfaced as `stats.critDamage` — any weapon with
 *  critDamage > 0 supports crits / headshots. critDamage == 0 weapons are
 *  scatterguns, flamethrowers, and mining tools — confirmed via pak extraction
 *  (see `reference_extracted_combat_data.md`).
 *  Melee weapons always return false (they don't have a head/body split). */
function canHeadshot(item) {
  if (!item) return false;
  if (item.subtype === 'melee') return false;
  const cd = item.stats?.critDamage?.value;
  return typeof cd === 'number' && cd > 0;
}

/** Actual in-game hit-location splits — your weapon's printed Damage Per Shot
 *  is the *stated* value; you only ever deal a fraction of it depending on
 *  where you hit. The 0.60 / 0.40 = 1.5 ratio is the location split itself.
 *  The per-weapon `m_CritDamage` multiplier is a SEPARATE factor applied on
 *  head rows when the target's UCritable interface fires (see
 *  reference_damage_model.md for the full breakdown). All damage % bonuses
 *  sum into a single additive pool that multiplies the split value. */
const HIT_SPLIT_BODY = 0.40;
const HIT_SPLIT_HEAD = 0.60;

/** Whether a weapon participates in the body/head hit-location split. Melee
 *  swings don't hit a location zone — they deal the stated value directly —
 *  while all ranged weapons use the body split (only headshot eligibility
 *  varies, handled by `canHeadshot`). */
function canBodySplit(item) {
  if (!item) return false;
  return item.subtype !== 'melee';
}

function formatAggregatedStats(totals) {
  const result = {};
  for (const [displayName, value] of Object.entries(totals)) {
    const precision = displayName === 'Accuracy' ? 1000 : 10;
    const rounded = Math.round(value * precision) / precision;
    result[displayName] = formatStatValue(displayName, rounded);
  }
  return result;
}

function refreshPanels(skipResourceBars) {
  const equipped = aggregateEquippedStats();
  const itemStats = Object.keys(equipped).length > 0 ? formatAggregatedStats(equipped) : null;
  if (!skipResourceBars) renderCharacterPanel(itemStats);
  renderCalculations(equipped);
  refreshActiveTooltip();
}

// Persistent "no results" message for a picker list. Lives as a child of the
// list container; shown only when no card in the list is visible.
function getPickerEmptyState(list, text) {
  let el = list.querySelector(':scope > .empty-state');
  if (!el) {
    el = document.createElement('p');
    el.className = 'empty-state';
    list.appendChild(el);
  }
  el.textContent = text;
  return el;
}

// Show/hide picker cards by substring match against card.dataset.search.
// Skips the persistent .empty-state element; shows it only when nothing matches.
// Cards use display:flex, so toggle inline display rather than the [hidden] attr.
function filterPickerList(list, query, emptyText) {
  const q = (query || '').toLowerCase();
  let anyVisible = false;
  for (const card of list.children) {
    if (card.classList.contains('empty-state')) continue;
    const match = (card.dataset.search || '').includes(q);
    card.style.display = match ? '' : 'none';
    if (match) anyVisible = true;
  }
  getPickerEmptyState(list, emptyText).hidden = anyVisible;
}

function renderPickerItems(items, slotType) {
  const list = document.getElementById('item-picker-list');
  list.innerHTML = '';
  items.forEach(item => {
    const card = createItemCard(item, slotType);
    card.dataset.search = item.name.toLowerCase();
    if (equippedItems[slotType]?.slug === item.slug) card.classList.add('item-card--equipped');
    list.appendChild(card);
  });
  // Empty search on open: message shown only when there are no cards.
  getPickerEmptyState(list, 'No items found.').hidden = items.length > 0;
}

function openItemPicker(slotEl) {
  const slotType = getSlotType(slotEl);
  const slotClass = getSlotClass(slotEl);
  const label = slotType ? SLOT_LABEL_MAP[slotType] : (SLOT_ORIGINAL_LABELS[slotClass] || 'Slot');

  document.getElementById('item-picker-title').textContent = `Select ${label}`;
  document.getElementById('item-picker-search').value = '';

  const items = slotType
    ? GARMENT_ITEMS.filter(i => i.slot === slotType || (slotType === 'chest' && i.slot === 'radsuit'))
    : [];
  currentPickerItems = [...items].sort((a, b) => {
    const tierA = a.tier ?? 0;
    const tierB = b.tier ?? 0;
    if (tierA !== tierB) return tierB - tierA;
    if (a.rarity !== b.rarity) return a.rarity === 'Unique' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  if (!appSettings.showCommons) {
    currentPickerItems = currentPickerItems.filter(i => i.rarity !== 'Common');
  }
  currentPickerItems = currentPickerItems.filter(i => {
    const tier = i.tier;
    if (tier === 0 && !appSettings.showT0) return false;
    if (tier === 1 && !appSettings.showT1) return false;
    if (tier === 2 && !appSettings.showT2) return false;
    if (tier === 3 && !appSettings.showT3) return false;
    if (tier === 4 && !appSettings.showT4) return false;
    if (tier === 5 && !appSettings.showT5) return false;
    return true;
  });
  currentPickerSlotType = slotType;

  renderPickerItems(currentPickerItems, slotType);

  const overlay = document.getElementById('item-picker-overlay');
  requestAnimationFrame(() => requestAnimationFrame(() => overlay.classList.add('visible')));
}

function closeItemPicker() {
  document.getElementById('item-picker-overlay').classList.remove('visible');
  document.getElementById('item-picker-search').value = '';
  removeWeaponTypeFilters();
}

function selectItem(slotType, slug) {
  // Route hotbar selections to weapon handler
  if (HOTBAR_SLOTS.has(slotType)) { selectHotbarItem(slotType, slug); return; }

  const item = GARMENT_BY_SLUG.get(slug);
  if (!item || !slotType) return;

  if (item.slot === 'radsuit') {
    ARMOR_SLOTS.forEach(s => { equippedItems[s] = item; delete equippedGrades[s]; delete equippedAugments[s]; delete augmentSlotUnlocks[s]; });
    document.querySelector('.armor-layout').classList.add('radsuit-active');
    document.querySelectorAll('.armor-slot').forEach(slotEl => {
      if (getSlotType(slotEl) === 'helm') updateSlotDisplay(slotEl, item);
    });
  } else {
    // If a rad suit currently occupies this slot, displace it from all 5 slots first
    if (ARMOR_SLOTS.has(slotType) && equippedItems[slotType]?.slot === 'radsuit') {
      ARMOR_SLOTS.forEach(s => { delete equippedItems[s]; delete equippedGrades[s]; delete equippedAugments[s]; delete augmentSlotUnlocks[s]; });
      document.querySelector('.armor-layout').classList.remove('radsuit-active');
      document.querySelectorAll('.armor-slot').forEach(el => {
        const st = getSlotType(el);
        if (ARMOR_SLOTS.has(st) && st !== slotType) {
          el.classList.remove('has-item');
          el.title = '';
          el.innerHTML = `<span class="slot-label">${SLOT_ORIGINAL_LABELS[getSlotClass(el)] || ''}</span>`;
        }
      });
    }
    equippedItems[slotType] = item;
    if (GARMENT_SLOTS.has(slotType)) equippedGrades[slotType] = 0;
    document.querySelectorAll('.armor-slot').forEach(slotEl => {
      if (getSlotType(slotEl) === slotType) updateSlotDisplay(slotEl, item);
    });
  }

  closeItemPicker();
  refreshPanels();
}

function attachGradeHover(svgEl) {
  let hoverTimer = null;
  svgEl.addEventListener('mouseenter', () => {
    hoverTimer = setTimeout(() => svgEl.classList.add('grade-ring--expanded'), 200);
  });
  svgEl.addEventListener('mouseleave', () => {
    clearTimeout(hoverTimer);
    svgEl.classList.remove('grade-ring--expanded');
  });
}

// Builds a circular "grade ring" SVG. Used for both the corner ring on a graded
// armor/weapon slot and the mini ring inside an applied augment dot — the only
// differences are captured by the options object.
function createGradeRing(opts) {
  const {
    viewBox, svgClass, cx, cy, r,
    segCount = 5, gapDeg,
    currentGrade,           // grade rendered as filled (number)
    onPick,                 // (grade /* 1..segCount */, event, svg) => void
    hasText = false,        // append the center grade-number <text>
    textFontSize,           // font-size for the center text (when hasText)
  } = opts;

  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', viewBox);
  svg.classList.add(svgClass);

  // Block clicks anywhere on the ring SVG from opening the item picker
  svg.addEventListener('click', e => e.stopPropagation());

  // Background circle — visible when expanded for readability
  const bg = document.createElementNS(NS, 'circle');
  bg.setAttribute('cx', String(cx));
  bg.setAttribute('cy', String(cy));
  bg.setAttribute('r', String(cx));
  bg.classList.add('grade-bg');
  svg.appendChild(bg);

  const sliceDeg = 360 / segCount;            // pie slice (hit zone) per segment
  const segDeg = sliceDeg - gapDeg;            // visible arc is narrower

  for (let i = 0; i < segCount; i++) {
    const sliceStart = -90 + i * sliceDeg;
    const arcStart = sliceStart + gapDeg / 2;  // center the gap
    const arcEnd = arcStart + segDeg;

    // Pie-slice hit zone (invisible, full wedge to SVG edge)
    const hr = cx;  // extend hit zone to full SVG radius
    const s1 = (sliceStart * Math.PI) / 180;
    const s2 = ((sliceStart + sliceDeg) * Math.PI) / 180;
    const hx1 = cx + hr * Math.cos(s1), hy1 = cy + hr * Math.sin(s1);
    const hx2 = cx + hr * Math.cos(s2), hy2 = cy + hr * Math.sin(s2);
    const hitD = `M ${cx} ${cy} L ${hx1} ${hy1} A ${hr} ${hr} 0 0 1 ${hx2} ${hy2} Z`;

    const hitzone = document.createElementNS(NS, 'path');
    hitzone.setAttribute('d', hitD);
    hitzone.classList.add('grade-hitzone');
    hitzone.addEventListener('click', e => {
      e.stopPropagation();
      onPick(i + 1, e, svg);
    });

    // Visible arc segment (stroked arc along the ring)
    const a1 = (arcStart * Math.PI) / 180;
    const a2 = (arcEnd * Math.PI) / 180;
    const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
    const x2 = cx + r * Math.cos(a2), y2 = cy + r * Math.sin(a2);
    const d = `M ${x1} ${y1} A ${r} ${r} 0 0 1 ${x2} ${y2}`;

    const arc = document.createElementNS(NS, 'path');
    arc.setAttribute('d', d);
    arc.classList.add('grade-segment');
    arc.dataset.grade = String(i + 1);

    if (i + 1 <= currentGrade) arc.classList.add('active');

    // Hit zone first, then arc — so CSS `+` sibling selector works
    svg.appendChild(hitzone);
    svg.appendChild(arc);
  }

  if (hasText) {
    // Grade number in center
    const text = document.createElementNS(NS, 'text');
    text.classList.add('grade-number');
    text.setAttribute('x', String(cx));
    text.setAttribute('y', String(cy));
    text.setAttribute('font-size', String(textFontSize));
    text.textContent = '';
    svg.appendChild(text);

    if (currentGrade > 0) text.textContent = String(currentGrade);
  }

  svg.classList.toggle('grade--max', currentGrade === 5);

  attachGradeHover(svg);
  return svg;
}

// Corner grade ring for a graded armor/weapon slot.
function createSlotGradeRing(slotType) {
  return createGradeRing({
    viewBox: '0 0 42 42',
    svgClass: 'armor-slot__grade',
    cx: 21, cy: 21, r: 16,
    gapDeg: 8,
    currentGrade: equippedGrades[slotType] || 0,
    hasText: true,
    textFontSize: 20,
    onPick: (clicked, e, svg) => {
      equippedGrades[slotType] = (equippedGrades[slotType] === clicked) ? 0 : clicked;
      updateGradeSegments(svg, slotType);
      refreshPanels(HOTBAR_SLOTS.has(slotType));
    },
  });
}

function updateGradeSegments(svg, slotType) {
  const grade = equippedGrades[slotType] || 0;
  svg.querySelectorAll('.grade-segment').forEach(seg => {
    const g = parseInt(seg.dataset.grade, 10);
    seg.classList.toggle('active', g <= grade);
  });
  const text = svg.querySelector('.grade-number');
  if (text) text.textContent = grade > 0 ? String(grade) : '';
  svg.classList.toggle('grade--max', grade === 5);
}

// =============================================
// AUGMENT DOTS
// =============================================

function createAugmentDots(slotType) {
  const container = document.createElement('div');
  container.className = 'augment-dots';
  container.dataset.slotType = slotType;

  // Block clicks on dots container from bubbling to the armor slot
  container.addEventListener('click', e => e.stopPropagation());

  const unlocked = augmentSlotUnlocks[slotType] || 1;

  for (let i = 0; i < 3; i++) {
    const augment = equippedAugments[slotType]?.[i] || null;
    const isUnlocked = i < unlocked;

    if (augment) {
      container.appendChild(createAppliedAugmentDot(slotType, i, augment));
    } else if (isUnlocked) {
      container.appendChild(createUnlockedDot(slotType, i));
    } else {
      container.appendChild(createLockedDot(slotType, i));
    }
  }

  return container;
}

function createLockedDot(slotType, dotIndex) {
  const dot = document.createElement('button');
  dot.className = 'augment-dot augment-dot--locked';
  dot.title = 'Locked — click to unlock';
  dot.addEventListener('click', e => {
    e.stopPropagation();
    unlockAugmentSlot(slotType, dotIndex);
  });
  return dot;
}

function createUnlockedDot(slotType, dotIndex) {
  const dot = document.createElement('button');
  dot.className = 'augment-dot augment-dot--unlocked';
  dot.title = 'Empty — click to add augment, right-click to lock';
  dot.addEventListener('click', e => {
    e.stopPropagation();
    openAugmentPicker(slotType, dotIndex);
  });
  dot.addEventListener('contextmenu', e => {
    e.preventDefault();
    e.stopPropagation();
    relockAugmentSlot(slotType, dotIndex);
  });
  return dot;
}

/** Title-case label for an augment subtype ('ranged' → 'Ranged'), matching the
 *  capitalized badge text the pre-migration `type[0]` field carried. */
function augTypeLabel(subtype) {
  if (!subtype) return '';
  return subtype.charAt(0).toUpperCase() + subtype.slice(1);
}

function findAugmentData(slug, slotType) {
  if (HOTBAR_SLOTS.has(slotType)) {
    return WEAPON_AUGMENT_BY_SLUG.get(slug) || AUGMENT_BY_SLUG.get(slug) || null;
  }
  return AUGMENT_BY_SLUG.get(slug) || null;
}

function createAppliedAugmentDot(slotType, dotIndex, augment) {
  const dot = document.createElement('div');
  dot.className = 'augment-dot augment-dot--applied';

  const augData = findAugmentData(augment.slug, slotType);
  dot.title = augData ? augData.name : augment.slug;

  const icon = document.createElement('img');
  icon.className = 'augment-dot__icon';
  if (augData?.subtype) icon.classList.add(`augment-type--${augData.subtype}`);
  icon.src = augData?.icon || '';
  icon.alt = augData?.name || '';
  dot.appendChild(icon);

  // Mini grade ring
  dot.appendChild(createGradeRing({
    viewBox: '0 0 22 22',
    svgClass: 'augment-dot__grade',
    cx: 11, cy: 11, r: 8,
    gapDeg: 10,
    currentGrade: augment.grade || 0,
    onPick: (clicked, e) => {
      if (e.ctrlKey) { openAugmentPicker(slotType, dotIndex); return; }
      const aug = equippedAugments[slotType]?.[dotIndex];
      if (!aug) return;
      aug.grade = (aug.grade === clicked) ? 1 : clicked;
      refreshAugmentDots(slotType, dotIndex);
      refreshPanels(HOTBAR_SLOTS.has(slotType));
    },
  }));

  // Clear button
  const clearBtn = document.createElement('button');
  clearBtn.className = 'augment-dot__clear';
  clearBtn.textContent = '×';
  clearBtn.title = 'Remove augment';
  clearBtn.addEventListener('click', e => {
    e.stopPropagation();
    removeAugment(slotType, dotIndex);
  });
  dot.appendChild(clearBtn);

  // Right-click for custom value
  dot.addEventListener('contextmenu', e => {
    e.preventDefault();
    e.stopPropagation();
    openAugmentValuePopup(slotType, dotIndex, e);
  });

  // Click (any modifier) to swap augment
  dot.addEventListener('click', e => {
    e.stopPropagation();
    openAugmentPicker(slotType, dotIndex);
  });

  // Tooltip — show augment info instead of item info
  dot.addEventListener('mouseenter', e => {
    e.stopPropagation();
    showAugmentTooltip(slotType, dotIndex);
  });
  dot.addEventListener('mouseleave', e => {
    e.stopPropagation();
    showTooltip(slotType);
  });

  return dot;
}

function unlockAugmentSlot(slotType, dotIndex) {
  const current = augmentSlotUnlocks[slotType] || 1;
  if (dotIndex < current) return; // already unlocked
  augmentSlotUnlocks[slotType] = dotIndex + 1;
  refreshAugmentDots(slotType);
}

function relockAugmentSlot(slotType, dotIndex) {
  const current = augmentSlotUnlocks[slotType] || 1;
  if (dotIndex + 1 > current) return; // already locked
  // Relock this slot and any after it; clear augments in relocked positions
  augmentSlotUnlocks[slotType] = dotIndex;
  if (equippedAugments[slotType]) {
    for (let i = dotIndex; i < 3; i++) equippedAugments[slotType][i] = null;
  }
  refreshAugmentDots(slotType);
  refreshPanels(HOTBAR_SLOTS.has(slotType));
}

function removeAugment(slotType, dotIndex) {
  if (equippedAugments[slotType]) {
    equippedAugments[slotType][dotIndex] = null;
  }
  refreshAugmentDots(slotType);
  refreshPanels(HOTBAR_SLOTS.has(slotType));
}

function refreshAugmentDots(slotType, expandDotIndex) {
  // Find the right DOM element(s) for this slotType
  const elements = HOTBAR_SLOTS.has(slotType)
    ? [document.querySelector(`.hotbar-slot[data-hotbar="${slotType.replace('hotbar', '')}"]`)]
    : [...document.querySelectorAll('.armor-slot')].filter(el => getSlotType(el) === slotType);

  elements.forEach(slotEl => {
    if (!slotEl) return;
    const existing = slotEl.querySelector('.augment-dots');
    if (existing) existing.remove();
    const item = equippedItems[slotType];
    const isGradeable = GARMENT_SLOTS.has(slotType) || HOTBAR_SLOTS.has(slotType);
    if (item && isGradeable && item.maxGrade > 0 && item.rarity === 'Unique' && (item.slot !== 'radsuit' || slotType === 'helm')) {
      const dots = createAugmentDots(slotType);
      slotEl.appendChild(dots);
      if (expandDotIndex != null) {
        const dot = dots.children[expandDotIndex];
        const gradeRing = dot?.querySelector('.augment-dot__grade');
        if (gradeRing) gradeRing.classList.add('grade-ring--expanded');
      }
    }
  });
}

// =============================================
// AUGMENT PICKER
// =============================================

function getAvailableAugments(slotType, dotIndex) {
  let source;
  if (HOTBAR_SLOTS.has(slotType)) {
    const item = equippedItems[slotType];
    const wType = item?.subtype;
    const wFamily = item?.family;
    source = wType
      ? WEAPON_AUGMENT_DATA.filter(a => {
          // Generic ranged/melee augments (no family restriction).
          if (a.family == null && a.subtype === wType) return true;
          // Weapon-family-specific augments.
          if (wFamily && a.family === wFamily) return true;
          return false;
        })
      : WEAPON_AUGMENT_DATA;
  } else {
    source = AUGMENT_DATA;
    // Radiation Suits reject any augment that grants radiation mitigation (verified
    // in-game). This is what stops you stacking rad-mit augments on a rad suit for
    // unlimited radiation resistance, and matches the augments' own "cannot be applied
    // to Radiation Suits" rule. A rad suit fills every armor slot, so equippedItems
    // for this slot is the suit itself.
    if (equippedItems[slotType]?.slot === 'radsuit') {
      source = source.filter(a => !(a.effects || []).some(e => e.key === 'radiationMitigation'));
    }
  }
  // Hide augments already equipped on this item (other dots)
  const equipped = equippedAugments[slotType] || [];
  const equippedSlugs = new Set(equipped.filter((a, i) => a && i !== dotIndex).map(a => a.slug));
  return source.filter(a => !equippedSlugs.has(a.slug));
}

function openAugmentPicker(slotType, dotIndex) {
  currentAugmentSlotType = slotType;
  currentAugmentDotIndex = dotIndex;

  const slotLabel = SLOT_LABEL_MAP[slotType] || slotType;
  document.getElementById('augment-picker-title').textContent = `Augment — ${slotLabel} Slot ${dotIndex + 1}`;
  document.getElementById('augment-picker-search').value = '';

  renderAugmentPickerItems(getAvailableAugments(slotType, dotIndex));

  const overlay = document.getElementById('augment-picker-overlay');
  requestAnimationFrame(() => requestAnimationFrame(() => overlay.classList.add('visible')));
}

function closeAugmentPicker() {
  document.getElementById('augment-picker-overlay').classList.remove('visible');
  document.getElementById('augment-picker-search').value = '';
  currentAugmentSlotType = null;
  currentAugmentDotIndex = null;
}

function renderAugmentPickerItems(augments) {
  const list = document.getElementById('augment-picker-list');
  list.innerHTML = '';
  augments.forEach(aug => {
    const card = createAugmentCard(aug);
    card.dataset.search = aug.name.toLowerCase();
    list.appendChild(card);
  });
  getPickerEmptyState(list, 'No augments found.').hidden = augments.length > 0;
}

function createAugmentCard(aug) {
  const card = document.createElement('div');
  card.className = 'augment-card';

  const img = document.createElement('img');
  img.className = 'augment-card__icon';
  if (aug.subtype) img.classList.add(`augment-type--${aug.subtype}`);
  img.src = aug.icon;
  img.alt = aug.name;
  img.loading = 'lazy';

  const info = document.createElement('div');
  info.className = 'augment-card__info';

  const nameEl = document.createElement('div');
  nameEl.className = 'augment-card__name';
  nameEl.textContent = aug.name;

  const effectsEl = document.createElement('div');
  effectsEl.className = 'augment-card__effects';

  (aug.effects || []).forEach(eff => {
    // Show the range for the best available grade.
    const bestGrade = [...eff.grades].reverse().find(g => g !== null);
    if (!bestGrade) return;
    const span = document.createElement('span');
    const statLabel = eff.name.replace(/:$/, '');
    const fmtVal = v => (v >= 0 ? `+${v}` : `${v}`);
    // Card text always carries a '%' suffix (matches pre-migration behavior,
    // including the flat-effect quirk). Downsides (good:false) are single-valued.
    if (eff.good === false) {
      const isBuff = LOWER_BETTER_TRADEOFF_STATS.has(statLabel) ? bestGrade[1] < 0 : bestGrade[1] > 0;
      span.className = isBuff ? 'augment-card__effect' : 'augment-card__tradeoff';
      span.textContent = `${statLabel}: ${fmtVal(bestGrade[1])}%`;
    } else {
      span.className = 'augment-card__effect';
      if (bestGrade[0] === bestGrade[1]) {
        span.textContent = `${statLabel}: ${fmtVal(bestGrade[0])}%`;
      } else {
        span.textContent = `${statLabel}: ${fmtVal(bestGrade[0])}% to ${fmtVal(bestGrade[1])}%`;
      }
    }
    effectsEl.appendChild(span);
  });

  const descEl = document.createElement('div');
  descEl.className = 'augment-card__desc';
  descEl.textContent = aug.description || '';

  info.appendChild(nameEl);
  info.appendChild(effectsEl);
  if (aug.description) info.appendChild(descEl);
  card.appendChild(img);
  card.appendChild(info);

  card.addEventListener('click', () => selectAugment(aug.slug));
  return card;
}

function selectAugment(slug) {
  const slotType = currentAugmentSlotType;
  const dotIndex = currentAugmentDotIndex;
  if (slotType == null || dotIndex == null) return;

  if (!equippedAugments[slotType]) {
    equippedAugments[slotType] = [null, null, null];
  }

  equippedAugments[slotType][dotIndex] = { slug, grade: 1 };

  closeAugmentPicker();
  refreshAugmentDots(slotType);
  refreshPanels(HOTBAR_SLOTS.has(slotType));
}

// =============================================
// AUGMENT CUSTOM VALUE POPUP
// =============================================

let activeAugmentPopup = { slotType: null, dotIndex: null };

function openAugmentValuePopup(slotType, dotIndex, event) {
  const aug = equippedAugments[slotType]?.[dotIndex];
  if (!aug) return;

  const augData = findAugmentData(aug.slug, slotType);
  if (!augData) return;

  activeAugmentPopup = { slotType, dotIndex };

  const popup = document.getElementById('augment-value-popup');
  const fieldsContainer = document.getElementById('augment-value-fields');
  fieldsContainer.innerHTML = '';

  const grade = aug.grade || 1;
  const gradeIdx = grade > 0 ? grade - 1 : 0;
  const customValues = aug.customValues || {};

  (augData.effects || []).forEach(eff => {
    if (eff.good === false) return; // downsides (folded tradeoffs) aren't user-tunable
    const g = eff.grades?.[gradeIdx];
    if (!g) return; // stat not available at this grade

    const row = document.createElement('div');
    row.className = 'augment-value-popup__field';

    const label = document.createElement('label');
    label.className = 'augment-value-popup__stat';
    const min = g[0], max = g[1];
    const suffix = eff.op === 'percent' ? '%' : '';
    label.textContent = `${eff.name.replace(/:$/, '')} (${min}${suffix} – ${max}${suffix})`;

    const input = document.createElement('input');
    input.className = 'augment-value-popup__input';
    input.type = 'number';
    input.step = '0.1';
    input.placeholder = `${min} – ${max}`;
    input.dataset.stat = eff.name;
    input.dataset.min = String(Math.min(min, max));
    input.dataset.max = String(Math.max(min, max));

    if (customValues[eff.name] != null) {
      input.value = customValues[eff.name];
    }

    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') saveAugmentCustomValue();
      if (e.key === 'Escape') closeAugmentValuePopup();
    });

    row.appendChild(label);
    row.appendChild(input);
    fieldsContainer.appendChild(row);
  });

  popup.hidden = false;
  popup.style.left = `${event.clientX}px`;
  popup.style.top = `${event.clientY}px`;

  requestAnimationFrame(() => {
    const rect = popup.getBoundingClientRect();
    if (rect.right > window.innerWidth) popup.style.left = `${window.innerWidth - rect.width - 8}px`;
    if (rect.bottom > window.innerHeight) popup.style.top = `${window.innerHeight - rect.height - 8}px`;
  });

  const firstInput = fieldsContainer.querySelector('input');
  if (firstInput) { firstInput.focus(); firstInput.select(); }
}

function closeAugmentValuePopup() {
  document.getElementById('augment-value-popup').hidden = true;
  activeAugmentPopup = { slotType: null, dotIndex: null };
}

function saveAugmentCustomValue() {
  const { slotType, dotIndex } = activeAugmentPopup;
  const aug = equippedAugments[slotType]?.[dotIndex];
  if (!aug) { closeAugmentValuePopup(); return; }

  const inputs = document.querySelectorAll('#augment-value-fields input');
  const customValues = {};
  let hasAny = false;

  inputs.forEach(input => {
    const stat = input.dataset.stat;
    const val = parseFloat(input.value);
    if (!isNaN(val) && input.value.trim() !== '') {
      const min = parseFloat(input.dataset.min);
      const max = parseFloat(input.dataset.max);
      customValues[stat] = Math.min(Math.max(val, min), max);
      hasAny = true;
    }
  });

  aug.customValues = hasAny ? customValues : undefined;
  if (!hasAny) delete aug.customValues;

  const isHotbar = HOTBAR_SLOTS.has(activeAugmentPopup.slotType);
  closeAugmentValuePopup();
  refreshPanels(isHotbar);
}

// =============================================
// SPECIALIZATIONS PANEL
// =============================================

function openSpecializations() {
  if (SPECIALIZATIONS_DATA.length === 0) return;
  renderSpecOverlay();
  document.getElementById('specializations-overlay').classList.add('visible');
}

function closeSpecializations() {
  document.getElementById('specializations-overlay').classList.remove('visible');
  hideSpecTooltip();
}

function specIconUrl(iconPath) {
  if (!iconPath) return '';
  const m = iconPath.match(/([^/\\]+?)\.(webp|png)$/i);
  return m ? `./imgs/specializations/${m[1]}.webp` : '';
}

function renderSpecOverlay() {
  const body = document.getElementById('spec-body');
  body.innerHTML = '';
  const byId = new Map(SPECIALIZATIONS_DATA.map(t => [t.id, t]));
  SPEC_TRACK_ORDER.forEach(id => {
    const track = byId.get(id);
    if (track) body.appendChild(renderSpecTrack(track));
  });
}

function renderSpecTrack(track) {
  const state = specState[track.id];
  const keystonesByLevel = new Map();
  track.keystones.forEach(k => keystonesByLevel.set(k.level, k));

  const row = document.createElement('div');
  row.className = 'spec-track';
  row.dataset.track = track.id;

  // Banner / name / level setter
  const banner = document.createElement('div');
  banner.className = 'spec-track__banner';
  const bannerUrl = specIconUrl(track.bannerPath);
  if (bannerUrl) banner.style.backgroundImage = `url("${bannerUrl}")`;

  const headerRow = document.createElement('div');
  headerRow.className = 'spec-track__header-row';
  const nameEl = document.createElement('div');
  nameEl.className = 'spec-track__name';
  nameEl.textContent = track.name;
  headerRow.appendChild(nameEl);
  banner.appendChild(headerRow);

  const setLevel = (n) => {
    const clamped = Math.max(0, Math.min(track.maxLevel, n));
    if (clamped === state.level) return;
    state.level = clamped;
    track.keystones.forEach(k => { if (k.level > clamped) state.keystones.delete(k.id); });
    updateSpecTrack(track);
    focusSpecHighest(track);
  };

  const levelDisplay = document.createElement('div');
  levelDisplay.className = 'spec-track__level-display';
  const arrowLeft = document.createElement('button');
  arrowLeft.className = 'spec-track__level-arrow spec-track__level-arrow--down';
  arrowLeft.setAttribute('aria-label', 'Decrease level');
  arrowLeft.textContent = '◀';
  arrowLeft.addEventListener('click', () => setLevel(state.level - 1));
  const levelText = document.createElement('span');
  levelText.className = 'spec-track__level-text';
  if (state.level >= track.maxLevel) levelText.classList.add('spec-track__level-text--max');
  levelText.textContent = `${state.level}/${track.maxLevel}`;
  const arrowRight = document.createElement('button');
  arrowRight.className = 'spec-track__level-arrow spec-track__level-arrow--up';
  arrowRight.setAttribute('aria-label', 'Increase level');
  arrowRight.textContent = '▶';
  arrowRight.addEventListener('click', () => setLevel(state.level + 1));
  levelDisplay.appendChild(arrowLeft);
  levelDisplay.appendChild(levelText);
  levelDisplay.appendChild(arrowRight);
  banner.appendChild(levelDisplay);

  // Wheel anywhere on the banner adjusts the level.
  banner.addEventListener('wheel', e => {
    if (e.deltaY === 0) return;
    e.preventDefault();
    setLevel(state.level + (e.deltaY < 0 ? 1 : -1));
  }, { passive: false });

  // Info button — sits beside the spec name in the header row, on the same plane.
  // Hover for a passive-bonuses summary at the current level.
  const info = document.createElement('button');
  info.className = 'spec-track__info';
  info.type = 'button';
  info.setAttribute('aria-label', 'Show passive bonuses at current level');
  info.textContent = '?';
  info.addEventListener('mouseenter', e => showSpecPassivesTooltip(track, e));
  info.addEventListener('mousemove', e => positionSpecTooltip(e));
  info.addEventListener('mouseleave', hideSpecTooltip);
  headerRow.appendChild(info);

  row.appendChild(banner);

  // Horizontal strip of level nodes 1..maxLevel
  const strip = document.createElement('div');
  strip.className = 'spec-track__strip';

  // Connecting bar (sits behind the nodes, gold portion shows current progress).
  const bar = document.createElement('div');
  bar.className = 'spec-track__bar';
  const barFill = document.createElement('div');
  barFill.className = 'spec-track__bar-fill';
  bar.appendChild(barFill);
  strip.appendChild(bar);

  for (let lvl = 1; lvl <= track.maxLevel; lvl++) {
    const node = buildSpecNode(track, state, lvl, keystonesByLevel.get(lvl));
    node.dataset.level = String(lvl);
    strip.appendChild(node);
  }
  // Vertical wheel → horizontal scroll so users can mousewheel through the strip.
  strip.addEventListener('wheel', e => {
    if (e.deltaY === 0) return;
    e.preventDefault();
    strip.scrollLeft += e.deltaY;
  }, { passive: false });
  row.appendChild(strip);

  // After layout, size + position the bar (top aligned to icon midline)
  // and apply the initial fill.
  requestAnimationFrame(() => layoutSpecBar(track));

  return row;
}

/**
 * Measure the strip layout and (re)position the connecting bar:
 *  - top: vertically centered on the icon (not the node), so passive and keystone icons share the midline
 *  - width: spans from the first node's left edge to the last node's right edge
 *  - fill width: from start to the center of the current-level node
 *
 * Does NOT rebuild any DOM — purely numeric updates, so CSS transitions
 * animate the fill smoothly without flicker.
 */
function layoutSpecBar(track) {
  const state = specState[track.id];
  const row = document.querySelector(`.spec-track[data-track="${track.id}"]`);
  if (!row) return;
  const strip = row.querySelector('.spec-track__strip');
  const bar = row.querySelector('.spec-track__bar');
  const barFill = row.querySelector('.spec-track__bar-fill');
  if (!strip || !bar || !barFill) return;

  const first = strip.querySelector('.spec-node[data-level="1"]');
  const last = strip.querySelector(`.spec-node[data-level="${track.maxLevel}"]`);
  if (!first || !last) return;

  // Vertical centering of the bar is handled in CSS (top: 50%; translateY(-50%)).
  // The level number is now position:absolute so icons sit on the node midline,
  // which equals the strip/row midline regardless of resolution.

  // Span: left edge of first node → right edge of last node.
  const leftEdge = first.offsetLeft;
  const rightEdge = last.offsetLeft + last.offsetWidth;
  bar.style.left = `${leftEdge}px`;
  bar.style.width = `${rightEdge - leftEdge}px`;

  // Fill: bar-relative offset to center of current-level node.
  if (state.level > 0) {
    const target = strip.querySelector(`.spec-node[data-level="${state.level}"]`);
    if (target) {
      const centerX = target.offsetLeft + target.offsetWidth / 2;
      barFill.style.width = `${Math.max(0, centerX - leftEdge)}px`;
    }
  } else {
    barFill.style.width = '0px';
  }
}

/**
 * Smoothly scroll a track's strip so the highest unlocked node is centered.
 * Called only on level changes (not on keystone toggles), so toggling a
 * keystone from a manually-scrolled position doesn't yank focus away.
 */
function focusSpecHighest(track) {
  const state = specState[track.id];
  if (state.level <= 0) return;
  const row = document.querySelector(`.spec-track[data-track="${track.id}"]`);
  if (!row) return;
  const target = row.querySelector(`.spec-node[data-level="${state.level}"]`);
  if (target) target.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
}

/**
 * In-place update of a single track row: refresh node states (locked/unlocked/claimed)
 * and recompute the bar fill. No DOM rebuild — CSS transitions stay smooth and
 * scroll position is preserved.
 */
function updateSpecTrack(track) {
  const state = specState[track.id];
  const row = document.querySelector(`.spec-track[data-track="${track.id}"]`);
  if (!row) return;

  const levelText = row.querySelector('.spec-track__level-text');
  if (levelText) {
    levelText.textContent = `${state.level}/${track.maxLevel}`;
    levelText.classList.toggle('spec-track__level-text--max', state.level >= track.maxLevel);
  }

  row.querySelectorAll('.spec-node').forEach(node => {
    const lvl = parseInt(node.dataset.level, 10);
    const locked = lvl > state.level;
    node.classList.toggle('locked', locked);
    node.classList.toggle('unlocked', !locked);
    const ksId = node.dataset.keystone;
    if (ksId) node.classList.toggle('claimed', state.keystones.has(ksId));
  });

  layoutSpecBar(track);
  // Spec changes affect HP/Stamina, weapon damage, mitigation, and the readout
  // sections. Refresh just those — re-rendering the resource bars would replay
  // their snap-then-regen animation on every level tick.
  refreshAfterSpecChange();
}

/** Targeted refresh used by spec mutations. Updates bar text in-place (no
 *  animation), re-renders Equipment/Inventory/Spec sections, and refreshes
 *  the right-panel calcs. */
function refreshAfterSpecChange() {
  // 1. Bar text (HP/Stamina max may have moved from Combat keystones or
  //    skill-tree Vitality / General Conditioning attribute nodes; Stamina
  //    regen is a flat 20/sec scaled by Disciplined Breathing; Power regen
  //    scales with Scientist3).
  const sb = getSpecBonuses();
  const skb = getSkillBonuses();
  const hpMax = getMaxHealth();
  if (hpMax != null) updateResourceBarMaxInPlace('Health', hpMax);
  const stamMax = getMaxStamina();
  if (stamMax != null) {
    updateResourceBarMaxInPlace('Stamina', stamMax);
    updateResourceBarRegenInPlace('Stamina', STAMINA_REGEN_PER_SEC * (1 + (skb.staminaRecoveryPct || 0) / 100));
  }
  const basePackRegen = getEquippedStat('pack', 'regen per second');
  if (basePackRegen != null) {
    updateResourceBarRegenInPlace('Energy', basePackRegen * (1 + (skb.powerRegenPct || 0) / 100));
  }

  // 2. Extras section (Equipment / Inventory / Spec readouts).
  const extras = document.querySelector('.char-extras');
  if (extras) {
    const equipped = aggregateEquippedStats();
    const itemStats = Object.keys(equipped).length > 0 ? formatAggregatedStats(equipped) : null;
    renderCharExtras(extras, itemStats);
  }

  // 3. Right-panel calcs (EHP / Stamina / Power).
  renderCalculations();

  // 4. If a weapon/armor tooltip is currently visible, re-render it in place
  //    so its damage/mitigation values reflect the spec change immediately.
  refreshActiveTooltip();
}

/**
 * Build the per-spec readout sections at the bottom of the left character panel.
 * Each section lists the spec's currently-active passives (at level) plus the
 * aggregated effect totals from claimed keystones. Tracks with nothing active
 * are skipped to keep the panel clean.
 */
function renderSpecSummary() {
  const container = document.getElementById('spec-summary');
  if (!container) return;
  container.innerHTML = '';

  const byId = new Map(SPECIALIZATIONS_DATA.map(t => [t.id, t]));
  SPEC_TRACK_ORDER.forEach(id => {
    const track = byId.get(id);
    if (!track) return;
    const state = specState[track.id];
    if (!state) return;
    const claimedKs = track.keystones.filter(k => state.keystones.has(k.id));
    if (state.level === 0 && claimedKs.length === 0) return;

    const heading = document.createElement('div');
    heading.className = 'stats-section-label';
    heading.textContent = `${track.name} — L${state.level}`;
    container.appendChild(heading);

    // Passives at current level (skip if level 0 — no passive value yet)
    if (state.level > 0) {
      (track.passiveAttributes || []).forEach(p => {
        container.appendChild(createStatRow(p.name, formatSpecPassive(p, state.level)));
      });
    }

    // Aggregated effects across all claimed keystones in this track.
    const totals = new Map(); // name → { value, format }
    claimedKs.forEach(k => {
      (k.effects || []).forEach(e => {
        if (e.value == null) return;
        const prev = totals.get(e.name);
        if (prev) prev.value += e.value;
        else totals.set(e.name, { value: e.value, format: e.format });
      });
    });
    totals.forEach((entry, name) => {
      container.appendChild(createStatRow(name, formatKeystoneValue(entry.value, entry.format)));
    });
  });
}

function buildSpecNode(track, state, lvl, keystone) {
  const node = document.createElement('div');
  const locked = lvl > state.level;
  node.className = 'spec-node' + (keystone ? ' keystone' : '') + (locked ? ' locked' : ' unlocked');
  if (keystone) {
    node.dataset.keystone = keystone.id;
    // Cosmetic helm keystones use full-color art and get a grayscale-→-color
    // reveal on claim instead of the flat gold tint the others get.
    if (keystone.keystoneType === 'ItemCustomization') node.classList.add('cosmetic');
    if (state.keystones.has(keystone.id)) node.classList.add('claimed');
  }

  const lvlEl = document.createElement('div');
  lvlEl.className = 'spec-node__level';
  lvlEl.textContent = String(lvl);
  node.appendChild(lvlEl);

  const iconWrap = document.createElement('div');
  iconWrap.className = 'spec-node__icon';
  const img = document.createElement('img');
  if (keystone) {
    img.src = specIconUrl(keystone.iconPath);
    img.alt = keystone.name;
  } else {
    // Use the track's path icon as a generic passive marker.
    img.src = specIconUrl(track.iconPath);
    img.alt = track.name;
    // Default/locked/unlocked dimming + gold tint handled in CSS.
  }
  iconWrap.appendChild(img);
  node.appendChild(iconWrap);

  // Tooltip on hover
  node.addEventListener('mouseenter', e => showSpecTooltip(track, lvl, keystone, e));
  node.addEventListener('mousemove', e => positionSpecTooltip(e));
  node.addEventListener('mouseleave', hideSpecTooltip);

  if (keystone) {
    node.addEventListener('click', (e) => {
      const curState = specState[track.id];
      if (lvl > curState.level) return;
      if (e.ctrlKey || e.metaKey) {
        // Bulk: claim every keystone up to and including this one (within level cap).
        track.keystones.forEach(k => {
          if (k.level <= lvl) curState.keystones.add(k.id);
        });
      } else if (curState.keystones.has(keystone.id)) {
        curState.keystones.delete(keystone.id);
      } else {
        curState.keystones.add(keystone.id);
      }
      updateSpecTrack(track);
    });
  }

  return node;
}

function showSpecTooltip(track, lvl, keystone, event) {
  const tip = document.getElementById('spec-tooltip');
  tip.innerHTML = '';

  const title = document.createElement('div');
  title.className = 'spec-tooltip__title';
  title.textContent = keystone ? keystone.name : `Level ${lvl} passive`;
  tip.appendChild(title);

  const meta = document.createElement('div');
  meta.className = 'spec-tooltip__meta';
  meta.textContent = `L${lvl}` + (keystone ? '  ·  keystone' : '  ·  passive only');
  tip.appendChild(meta);

  if (keystone) {
    // Effect list (if any), then description text.
    if (keystone.effects?.length) {
      const effects = document.createElement('div');
      effects.className = 'spec-tooltip__effects';
      keystone.effects.forEach(e => {
        const row = document.createElement('div');
        row.textContent = `${e.name}: ${formatKeystoneValue(e.value, e.format)}`;
        effects.appendChild(row);
      });
      tip.appendChild(effects);
    }
    if (keystone.description) {
      const desc = document.createElement('div');
      desc.className = 'spec-tooltip__desc';
      desc.textContent = keystone.description;
      tip.appendChild(desc);
    }
  } else {
    // Passive nodes — show each passive's per-level delta.
    const desc = document.createElement('div');
    desc.className = 'spec-tooltip__desc';
    desc.style.whiteSpace = 'pre-line';
    const parts = track.passiveAttributes.map(p => {
      const prev = p.values[lvl - 1] ?? 0;
      const cur = p.values[lvl] ?? 0;
      return `${p.name}: ${formatSpecPassiveDelta(cur - prev)}`;
    });
    desc.textContent = parts.join('\n');
    tip.appendChild(desc);
  }

  tip.hidden = false;
  positionSpecTooltip(event);
}

function positionSpecTooltip(event) {
  const tip = document.getElementById('spec-tooltip');
  if (tip.hidden) return;
  const pad = 12;
  const edge = 8; // viewport margin
  const rect = tip.getBoundingClientRect();

  // Horizontal: prefer right-of-cursor; flip left if that would overflow.
  let x = event.clientX + pad;
  if (x + rect.width > window.innerWidth - edge) {
    x = event.clientX - rect.width - pad;
  }

  // Vertical: pick the direction based on CURSOR POSITION, not content height.
  // Otherwise short tooltips show below the cursor while tall ones flip above,
  // and hovers on the same row read inconsistently. With this rule, every
  // tooltip on a given row goes the same way.
  const placeAbove = event.clientY > window.innerHeight / 2;
  let y = placeAbove
    ? event.clientY - rect.height - pad
    : event.clientY + pad;

  // Final clamp: keep the tooltip on-screen even if the chosen direction overflows.
  x = Math.max(edge, Math.min(x, window.innerWidth - rect.width - edge));
  y = Math.max(edge, Math.min(y, window.innerHeight - rect.height - edge));

  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
}

function hideSpecTooltip() {
  const tip = document.getElementById('spec-tooltip');
  if (tip) tip.hidden = true;
}

function formatSpecPassiveDelta(delta) {
  if (!delta) return '+0';
  if (delta < 0.5) return `+${Math.round(delta * 1000) / 10}%`;
  return `+${Math.round(delta * 100) / 100}`;
}

/**
 * Format a keystone effect value per its format template. Known templates from
 * the source data: "+{v:0}" (int), "+{v:0}%" (int percent), "+{v:0.#}%" (1-dec percent).
 * Percent values are stored as fractions (0.3 = 30%), so we scale by 100 for those.
 */
function formatKeystoneValue(value, format) {
  if (value == null) return '';
  if (format === '+{v:0}%') {
    const n = Math.round(value * 100);
    return `${n >= 0 ? '+' : ''}${n}%`;
  }
  if (format === '+{v:0.#}%') {
    const n = Math.round(value * 1000) / 10;
    return `${n >= 0 ? '+' : ''}${n}%`;
  }
  const n = Math.round(value);
  return `${n >= 0 ? '+' : ''}${n}`;
}

/**
 * Format a cumulative passive value as a percent gain. The source data uses two
 * conventions for the same idea: Combat Damage stores 0→1.0 (read directly as
 * 0%→100%), while Crafted Item Durability stores 1.01→2.0 (a multiplier, so
 * convert via (v-1) to get the percent gain). Either way we display as +N%.
 */
function formatSpecPassive(passive, level) {
  const v = passive?.values?.[level];
  if (typeof v !== 'number') return '—';
  const isMultiplier = (passive.values[1] ?? 0) >= 1;
  const pct = isMultiplier ? (v - 1) * 100 : v * 100;
  const rounded = Math.round(pct * 10) / 10;
  return `${rounded >= 0 ? '+' : ''}${rounded}%`;
}

/** Hover summary for the `?` button — passives + aggregated claimed-keystone effects. */
function showSpecPassivesTooltip(track, event) {
  const state = specState[track.id];
  const tip = document.getElementById('spec-tooltip');
  tip.innerHTML = '';

  const title = document.createElement('div');
  title.className = 'spec-tooltip__title';
  title.textContent = `${track.name} — Level ${state.level}`;
  tip.appendChild(title);

  const section = (label) => {
    const h = document.createElement('div');
    h.className = 'spec-tooltip__meta';
    h.textContent = label;
    tip.appendChild(h);
  };

  // Passives at current level
  if (track.passiveAttributes?.length) {
    section('Passives');
    const body = document.createElement('div');
    body.className = 'spec-tooltip__desc';
    track.passiveAttributes.forEach(p => {
      const row = document.createElement('div');
      row.textContent = `${p.name}: ${formatSpecPassive(p, state.level)}`;
      body.appendChild(row);
    });
    tip.appendChild(body);
  }

  // Aggregated effects across all claimed keystones in this track.
  const totals = new Map(); // name → { value, format }
  track.keystones.forEach(k => {
    if (!state.keystones.has(k.id)) return;
    (k.effects || []).forEach(e => {
      if (e.value == null) return;
      const prev = totals.get(e.name);
      if (prev) prev.value += e.value;
      else totals.set(e.name, { value: e.value, format: e.format });
    });
  });

  if (totals.size > 0) {
    section('From claimed keystones');
    const body = document.createElement('div');
    body.className = 'spec-tooltip__desc';
    totals.forEach((entry, name) => {
      const row = document.createElement('div');
      row.textContent = `${name}: ${formatKeystoneValue(entry.value, entry.format)}`;
      body.appendChild(row);
    });
    tip.appendChild(body);
  }

  if (!track.passiveAttributes?.length && totals.size === 0) {
    const empty = document.createElement('div');
    empty.className = 'spec-tooltip__desc';
    empty.textContent = 'No bonuses yet — raise the level or claim a keystone.';
    tip.appendChild(empty);
  }

  tip.hidden = false;
  positionSpecTooltip(event);
}

// =============================================
// AOE BLAST-FIELD POPUP
// =============================================

/** Blast-intensity colour ramp (t in 0..1 -> [r,g,b]). Inverted heat scale:
 *  high damage (core) = red, mid = orange, low damage (edge) = yellow. */
function aoeThermal(t) {
  const s = [[0,[252,230,130]],[0.3,[248,178,60]],[0.55,[236,120,35]],[0.78,[214,70,30]],[1,[186,32,26]]];
  if (t <= 0) return s[0][1];
  for (let i = 1; i < s.length; i++) {
    if (t <= s[i][0]) {
      const f = (t - s[i-1][0]) / (s[i][0] - s[i-1][0]);
      return s[i-1][1].map((c, k) => Math.round(c + (s[i][1][k] - c) * f));
    }
  }
  return s[s.length-1][1];
}

/** Draw a single weapon's radial blast field (top-down) onto `canvas`.
 *  `rb` is the weapon's radialBlast config; `scale` multiplies both radii
 *  (the equipped AOE augment scales the whole blast). */
function drawAoeBlast(canvas, rb, scale) {
  const inner = rb.innerM * scale;
  const outer = rb.outerM * scale;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height, cx = W / 2, cy = H / 2;
  const pad = 34;
  const pxPerM = (Math.min(W, H) / 2 - pad) / outer;
  const base = rb.blastBase || 1;
  const dmgAt = d => {
    if (d <= inner) return rb.blastBase;
    if (d <= outer) {
      const a = (outer - d) / (outer - inner);
      return rb.blastMin + (rb.blastBase - rb.blastMin) * Math.pow(Math.max(a, 0), rb.falloff);
    }
    return 0;
  };
  ctx.fillStyle = '#120d08'; ctx.fillRect(0, 0, W, H);
  const img = ctx.getImageData(0, 0, W, H), data = img.data;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const dx = (x - cx) / pxPerM, dy = (y - cy) / pxPerM, d = Math.sqrt(dx*dx + dy*dy);
    if (d > outer) continue;
    const c = aoeThermal(dmgAt(d) / base);
    const i = (y*W + x) * 4;
    data[i]=c[0]; data[i+1]=c[1]; data[i+2]=c[2]; data[i+3]=255;
  }
  ctx.putImageData(img, 0, 0);
  // metre grid rings
  ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(255,255,255,0.16)';
  for (let m = 1; m <= Math.ceil(outer); m++) { ctx.beginPath(); ctx.arc(cx, cy, m*pxPerM, 0, 7); ctx.stroke(); }
  // inner ring (full-damage core)
  ctx.setLineDash([5,4]); ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(255,255,255,0.88)';
  ctx.beginPath(); ctx.arc(cx, cy, inner*pxPerM, 0, 7); ctx.stroke(); ctx.setLineDash([]);
  // outer ring
  ctx.lineWidth = 2; ctx.strokeStyle = '#f1c27a';
  ctx.beginPath(); ctx.arc(cx, cy, outer*pxPerM, 0, 7); ctx.stroke();
  // ring labels: white in-field, outer stays gold on the dark background.
  const fmtM = v => (v % 1 ? v.toFixed(1) : v.toString()) + ' m';
  ctx.font = '13.2px Segoe UI'; ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(255,255,255,0.92)'; ctx.fillText(fmtM(inner) + ' core', cx, cy - inner*pxPerM - 4);
  ctx.fillStyle = '#f1c27a'; ctx.fillText(fmtM(outer), cx, cy - outer*pxPerM - 5);
  // direct-impact marker (crosshair at the point of impact) + caption
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(cx, cy, 6, 0, 7); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(cx-9,cy); ctx.lineTo(cx+9,cy); ctx.moveTo(cx,cy-9); ctx.lineTo(cx,cy+9); ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.92)'; ctx.font = '12px Segoe UI'; ctx.textAlign = 'center';
  ctx.fillText('direct hit', cx, cy + 22);
}

let aoeBlastKeyHandler = null;
/** Open the blast-field popup for `item`. Radii scale by the equipped AOE augment
 *  (scaleMin..scaleMax; both 1 when none). `coreMin/coreMax` are the weapon's
 *  computed Damage Per Shot (= blast core damage); edge derives via the falloff. */
function openAoeBlast(item, scaleMin, scaleMax, coreMin, coreMax, shieldMin, shieldMax) {
  const rb = item.radialBlast;
  if (!rb) return;
  const overlay = document.getElementById('aoe-blast-overlay');
  const canvas = document.getElementById('aoe-blast-canvas');
  const info = document.getElementById('aoe-blast-info');
  document.getElementById('aoe-blast-title').textContent = item.name + ' · Blast field';
  // Draw at the boosted (max) radii; the augment roll spans min..max.
  drawAoeBlast(canvas, rb, scaleMax);

  const augmented = Math.abs(scaleMax - 1) > 1e-6 || Math.abs(scaleMin - 1) > 1e-6;
  const f = v => (v % 1 ? v.toFixed(2) : v.toString());
  const fmtR = (baseR) => {
    const lo = baseR * scaleMin, hi = baseR * scaleMax;
    if (!augmented) return f(baseR) + ' m';
    return (scaleMin === scaleMax ? f(hi) : f(lo) + '–' + f(hi)) + ' m';
  };
  const noFall = rb.falloff === 0;
  const edgePct = Math.round(rb.blastMin / (rb.blastBase || 1) * 100);
  const fall = noFall ? '<b>none</b> (full damage to the edge)'
                      : 'linear → <b>' + edgePct + '%</b> at the edge';

  // Real blast damage: core = the weapon's computed Damage Per Shot; edge scales
  // by the falloff ratio (= core when there is no falloff).
  const cMin = coreMin != null ? coreMin : rb.blastBase;
  const cMax = coreMax != null ? coreMax : rb.blastBase;
  const edgeRatio = noFall ? 1 : (rb.blastMin / (rb.blastBase || 1));
  const dmgStr = (lo, hi) => lo === hi
    ? formatNumber(Math.round(lo))
    : formatNumber(Math.round(lo)) + '–' + formatNumber(Math.round(hi));
  const coreStr = dmgStr(cMin, cMax);
  const edgeStr = noFall ? coreStr : dmgStr(cMin * edgeRatio, cMax * edgeRatio);

  // Shield blast damage (against the Holtzman shield), same shape as body.
  const sCMin = shieldMin != null ? shieldMin : rb.blastShieldBase;
  const sCMax = shieldMax != null ? shieldMax : rb.blastShieldBase;
  const shEdgeRatio = noFall ? 1 : (rb.blastShieldMin / (rb.blastShieldBase || 1));
  const shCoreStr = dmgStr(sCMin, sCMax);
  const shEdgeStr = noFall ? shCoreStr : dmgStr(sCMin * shEdgeRatio, sCMax * shEdgeRatio);
  info.innerHTML =
    '<span class="k">Blast damage, core:</span> <b>' + coreStr + '</b><br>' +
    '<span class="k">Blast damage, edge:</span> <b>' + edgeStr + '</b><br>' +
    '<span class="k">Shield dmg, core:</span> <b>' + shCoreStr + '</b><br>' +
    '<span class="k">Shield dmg, edge:</span> <b>' + shEdgeStr + '</b><br>' +
    '<span class="k">Falloff:</span> ' + fall + '<br>' +
    '<span class="k">Core radius:</span> <b>' + fmtR(rb.innerM) + '</b><br>' +
    '<span class="k">Blast radius:</span> <b>' + fmtR(rb.outerM) + '</b>' +
    (augmented ? ' <span class="k">(augmented)</span>' : '') +
    (rb.fire ? '<br><span class="fire">▲ Sets targets on fire (heat on hit)</span>' : '');

  overlay.classList.add('visible');
  aoeBlastKeyHandler = (e) => { if (e.key === 'Escape') closeAoeBlast(); };
  document.addEventListener('keydown', aoeBlastKeyHandler);
}
function closeAoeBlast() {
  const overlay = document.getElementById('aoe-blast-overlay');
  if (overlay) overlay.classList.remove('visible');
  if (aoeBlastKeyHandler) { document.removeEventListener('keydown', aoeBlastKeyHandler); aoeBlastKeyHandler = null; }
}

// =============================================
// TOOLTIP PANEL
// =============================================

function showTooltip(slotType, force) {
  // While Ctrl is pinning the current tooltip, ignore mouseenter-driven switches
  // to other slots. Internal refreshes pass `force: true` so they still update.
  if (tooltipPinned && !force) return;
  const item = equippedItems[slotType];
  if (!item) return;
  if (tooltipClearTimer) { clearTimeout(tooltipClearTimer); tooltipClearTimer = null; }
  activeTooltip = { fn: 'item', args: [slotType] };

  document.getElementById('build-stats').hidden = true;
  const panel = document.getElementById('tooltip-panel');
  panel.style.flex = '1 1 0';
  panel.innerHTML = '';

  // Name + rarity badge
  const nameRow = document.createElement('div');
  nameRow.className = 'tooltip-panel__name-row';

  const nameEl = document.createElement('span');
  nameEl.className = 'tooltip-panel__name';
  nameEl.textContent = item.name;

  const badge = document.createElement('span');
  const rarityClass = item.rarity === 'Unique' ? 'rarity--unique' : 'rarity--common';
  badge.className = `tooltip-panel__badge ${rarityClass}`;
  badge.textContent = item.rarity;

  nameRow.appendChild(nameEl);
  nameRow.appendChild(badge);
  panel.appendChild(nameRow);

  // Stats — read the keyed map, applying grade scaling per stat. Each display
  // row carries its camelCase `key` (for spec/label/statMap lookups) and its
  // `name` (the display string formatStatValue keys off). Object insertion
  // order is preserved, so the visible row order matches the data layout.
  const grade = equippedGrades[slotType] || 0;
  // Player PowerEfficiency (gauntlets + BatteryExpert) multiplies every power
  // cost (binary-confirmed). Applied to the weapon's per-shot cost row at render
  // time and shown as a × PwrEff factor in its hover formula (like the exoskeleton
  // gear bonus on damage), not folded silently here.
  const pwrMul = item.subtype !== 'melee' ? getPowerUsageMul() : 1;
  const stats = Object.entries(item.stats || {}).map(([key, s]) => ({
    key,
    name: s.name,
    type: s.type,
    value: statValueAt(item.stats, key, grade) ?? s.value,
  }));

  // Compute augment contributions per stat key for this item.
  //   augEffects[key]  → aggregated min/max/type, used for the final math.
  //   augContribs[key] → per-augment list { augName, augGrade, type, min, max,
  //     isCustom, isTradeoff } so the breakdown can show each augment as its
  //     own term in the formula rather than collapsing everything to "Aug%".
  const augEffects = {};
  const augContribs = {};
  const pushContrib = (key, entry) => {
    if (!augContribs[key]) augContribs[key] = [];
    augContribs[key].push(entry);
  };
  resolveAugmentContribs(slotType, equippedAugments[slotType]).forEach(c => {
    if (!augEffects[c.key]) augEffects[c.key] = { min: 0, max: 0, hasCustom: true, type: c.type };
    augEffects[c.key].min += c.min;
    augEffects[c.key].max += c.max;
    if (!c.hasCustom) augEffects[c.key].hasCustom = false;
    pushContrib(c.key, {
      key: c.key, augName: c.augName, augGrade: c.augGrade, type: c.type,
      min: c.min, max: c.max, isCustom: c.hasCustom, isTradeoff: c.isTradeoff,
    });
  });

  // Build the displayed stat list with any derived/synthetic stats injected.
  // - Melee with damage-per-hit/attack-speed → add "DPS" and group attack rows.
  const displayStats = stats.slice();
  const findStat = (key) => stats.find(s => s.key === key);
  const valueWithAugMax = (key, base) => {
    const ae = augEffects[key];
    if (!ae) return base;
    if (ae.type === 'percent') return base * (1 + ae.max / 100);
    return base + ae.max;
  };
  if (item.subtype === 'melee') {
    const dphS = findStat('damagePerHit');
    const spdS = findStat('attackSpeed');
    if (dphS && spdS) {
      const spd = Math.max(1, valueWithAugMax('attackSpeed', spdS.value));
      const dps = dphS.value * spd / 60;
      displayStats.push({ key: 'dps', name: 'DPS', value: dps, type: 'number' });
    }
    // Group the four light/heavy × shielded/unshielded rows together at the top
    // so they read as a damage table rather than scattered through the stats.
    const orderIdx = key => {
      const i = MELEE_STAT_ORDER.indexOf(key);
      return i === -1 ? Infinity : i;
    };
    displayStats.sort((a, b) => {
      const ai = orderIdx(a.key);
      const bi = orderIdx(b.key);
      return ai === bi ? 0 : ai - bi;
    });
  } else if (item.subtype === 'ranged') {
    // Inject a synthetic "Sustained DPS" row that factors in reload time.
    // Display label flips: data's DPS (burst rate) → "Burst DPS"; synthetic
    // sustained → "DPS" (the meaningful sustained metric). Renders just above
    // the burst row so the user sees the honest DPS first.
    const dpsIdx = displayStats.findIndex(s => s.key === 'dps');
    if (dpsIdx >= 0 && findStat('clipSize') && findStat('rateOfFire') && findStat('reloadTime')) {
      displayStats.splice(dpsIdx, 0, { key: 'sustainedDps', name: 'Sustained DPS', value: 0, type: 'number' });
    }

    // Power weapons: surface the active power-efficiency reduction (gauntlets +
    // BatteryExpert — the same PowerEfficiency that scales shield/suspensor) and a
    // sustained-fire "Power Uptime" vs the equipped pack's regen. Injected right
    // after the Power Consumption row. (pcS.value already carries the × pwrMul.)
    const pcS = findStat('powerConsumptionPerShot');
    const rofS = findStat('rateOfFire');
    const packRegen = getEquippedStat('pack', 'regen per second');
    const packPool  = getMaxPower(); // pack pool + gear (Maximum Power) — matches the bar
    if (pcS && pcS.value > 0 && rofS && packRegen != null) {
      // cost/shot already carries the weapon power augment (valueWithAugMax) and
      // the player PowerEfficiency (× pwrMul). Uptime = pool / (cost/s − regen/s).
      const costPerShot = valueWithAugMax('powerConsumptionPerShot', pcS.value) * pwrMul;
      const rof = valueWithAugMax('rateOfFire', rofS.value);
      const costPerSec = costPerShot * rof / 60;
      const regenPerSec = packRegen * (1 + (getSkillBonuses().powerRegenPct || 0) / 100);
      const sustainable = costPerSec <= regenPerSec;
      let uptime, t = null;
      if (sustainable) {
        uptime = 'Indefinite';
      } else if (packPool != null) {
        t = packPool / (costPerSec - regenPerSec);
        uptime = t < 60 ? `${formatNumber(t, 1)}s`
                        : `${Math.floor(t / 60)}m${formatNumber(Math.round(t % 60))}s`;
      } else {
        uptime = '—';
      }
      // Colour like the other rows: green when the power setup is buffed (cost
      // reduced below the weapon's base, or regen boosted), red if worsened.
      const cheaper = costPerShot < pcS.value - 1e-6;
      const regenUp = regenPerSec > packRegen + 1e-6;
      const pricier = costPerShot > pcS.value + 1e-6;
      const upColor = (cheaper || regenUp) ? 'var(--color-stamina)'
                    : pricier ? 'var(--color-health)' : '';
      const pcIdx = displayStats.findIndex(s => s.key === 'powerConsumptionPerShot');
      if (pcIdx >= 0) displayStats.splice(pcIdx + 1, 0, {
        key: 'powerUptime', name: 'Power Uptime', value: uptime, type: 'text', color: upColor,
        _uptime: { costPerShot, rof, costPerSec, regenPerSec, pool: packPool, pwrMul, sustainable },
      });
    }
  }

  // Stats indexed by camelCase key so getDamageRowSpec can resolve cross-row
  // refs (e.g., Heavy Attack rows need to find Damage Per Hit's raw value).
  const statMap = {};
  displayStats.forEach(s => { statMap[s.key] = s; });

  // Cross-domain offensive bonus from equipped gear (e.g. exoskeleton +melee%).
  // Character-wide and additive: a melee weapon gets the aggregated 'Melee Damage'
  // total, a ranged weapon gets 'Ranged Damage'. Computed once per tooltip render.
  const equippedTotals = aggregateEquippedStats();
  const gearDmgPct = item.subtype === 'melee'
    ? (equippedTotals['Melee Damage'] || 0)
    : (equippedTotals['Ranged Damage'] || 0);

  // Captured for the AOE blast popup: the in-game Damage Per Shot and Shield
  // Damage Per Shot (Stated × (1+aug%)), which for radial weapons equal the blast
  // core body / shield damage (RadialDamageConfig.BaseDamage / BaseShieldDamage).
  let aoeCoreMin = null, aoeCoreMax = null, aoeShieldMin = null, aoeShieldMax = null;

  displayStats.forEach(stat => {
    const row = document.createElement('div');
    row.className = 'stat-row';

    const key = stat.key;
    const displayName = stat.name.replace(/:$/, '');
    const displayLabel =
      (item.subtype === 'melee'  && MELEE_DISPLAY_LABELS[key])  ||
      (item.subtype === 'ranged' && RANGED_DISPLAY_LABELS[key]) ||
      displayName;

    const label = document.createElement('span');
    label.className = 'stat-label';
    label.textContent = displayLabel;

    const value = document.createElement('span');
    value.className = 'stat-value';

    const sb = getSpecBonuses();
    const isDamageKey = SPEC_DAMAGE_KEYS.has(key);
    const spec = isDamageKey ? getDamageRowSpec(item, key, statMap, augEffects) : null;
    // For damage rows, augments are sourced from the STATED stat (so heavy/DPS
    // rows inherit the same augment as Damage Per Hit / Damage Per Shot).
    const augEff = spec ? augEffects[spec.statedKey] : augEffects[key];
    const baseText = formatStatValue(stat.name, stat.value);

    if (spec) {
      // Damage = (Stated + augFlat) × factorMul × hitSplit × (1 + pool%)
      // where factorMul covers deterministic multipliers between Stated and
      // this row (Heavy ×3/×6, RoF/60, Speed/60), and hitSplit is the body/head
      // hit-location multiplier (1 when not applicable).
      const augPctMin = augEff?.type === 'percent' ? augEff.min : 0;
      const augPctMax = augEff?.type === 'percent' ? augEff.max : 0;
      const augFlatMin = augEff && augEff.type !== 'percent' ? augEff.min : 0;
      const augFlatMax = augEff && augEff.type !== 'percent' ? augEff.max : 0;

      // Shield damage hits the bubble — no body/head zone. The shield Stated
      // already represents the shield-specific damage value.
      const isShieldStated = (spec.statedKey === 'shieldDamagePerShot' || spec.statedKey === 'shieldDamagePerHit');
      const useSplit = canBodySplit(item) && !isShieldStated;
      const showHead = useSplit && appSettings.applyHeadshot && canHeadshot(item);
      const hitMode = !useSplit ? 'none' : showHead ? 'head' : 'body';
      const hitSplit = hitMode === 'none' ? 1
                     : hitMode === 'head' ? HIT_SPLIT_HEAD
                     : HIT_SPLIT_BODY;

      const combatPct = sb.combatDamagePct;
      const staggerPct = sb.staggerPct;
      const headHunterPct = hitMode === 'head' ? sb.headHunterPct : 0;

      // Headshot-damage augments (the Tactical line) join the additive pool on
      // head rows only — same bucket as the Sabotage Head Hunter keystone.
      // Stored op:percent (whole numbers) after normalization, so read directly.
      const hsAe = augEffects['headshotDamage'];
      const hsDmgAugPctMin = (hitMode === 'head' && hsAe?.type === 'percent') ? hsAe.min : 0;
      const hsDmgAugPctMax = (hitMode === 'head' && hsAe?.type === 'percent') ? hsAe.max : 0;

      // Skill-tree contributions. Ranged Damage % from allocated attribute
      // nodes (Weaponry1, MentalCalculus2) joins the additive pool on ranged
      // weapons only — same shape as the cross-domain gearDmgPct above.
      // Headshot Damage % from equipped techniques (Marksman, Center of Mass
      // penalty) and any attribute headshot nodes joins the pool on head rows
      // only — same bucket as the Sabotage Head Hunter keystone.
      const skb = getSkillBonuses();
      const skillRangedPct = item.subtype !== 'melee' ? skb.rangedDamagePct : 0;
      const skillHeadshotPct = hitMode === 'head' ? skb.headshotDamagePct : 0;
      // Body Damage applies to anything that isn't a headshot or a shield row.
      // hitMode 'body' is the obvious case; 'none' covers non-splitting weapons
      // (flamethrowers, lasguns, etc) which in-game still register as body
      // damage. Shield-stated rows opt out — Center of Mass treats "Shield
      // Damage" as a separate stat from "Body Damage".
      const skillBodyPct = (!isShieldStated && hitMode !== 'head') ? skb.bodyDamagePct : 0;
      // Per-family weapon damage bonuses — applied only when the equipped
      // weapon matches the relevant family. Mapping derived from
      // SupportedFrameTypes in dune-weapons-full.json (pak source):
      //   Pistol      → Maula Pistol, Rafiq Snubnose
      //   Rifle       → Karpov 38, JABAL Spitdart
      //   Carbine/SMG → Disruptor M11
      //   Scattergun  → GRDA 44, Drillshot FK7
      //   Lmg/Lasgun/FlameThrower (Heavy) → Lasgun, VULCAN GAU-92,
      //                                     Flamethrower, Missile Launcher, Pyrocket
      // Shield-stated rows opt out (these are body-damage stats).
      const skillFamilyPct = (() => {
        if (isShieldStated || item.subtype === 'melee') return 0;
        const fam = item.family || '';
        if (fam === 'Maula Pistol' || fam === 'Rafiq Snubnose') return skb.pistolDamagePct;
        if (fam === 'Karpov 38' || fam === 'JABAL Spitdart') return skb.rifleDamagePct;
        if (fam === 'Disruptor M11') return skb.carbineDamagePct;
        if (fam === 'GRDA 44' || fam === 'Drillshot FK7') return skb.scattergunDamagePct;
        if (fam === 'Lasgun' || fam === 'VULCAN GAU-92' || fam === 'Flamethrower' ||
            fam === 'Missile Launcher' || fam === 'Pyrocket') return skb.heavyDamagePct;
        return 0;
      })();
      // Blade Damage applies on every melee blade weapon (Blade1/WeirdingWay1 +
      // Center of Mass technique). Short/Long Blade nodes (WeirdingWay2 / Blade2)
      // stack on top only when the equipped weapon's bladeClass matches —
      // classification sourced from the pak SupportedFrameType (data/weapons.json).
      const skillBladePct = item.subtype === 'melee'
        ? skb.bladeDamagePct
          + (item.bladeClass === 'Short' ? skb.shortBladeDamagePct : 0)
          + (item.bladeClass === 'Long'  ? skb.longBladeDamagePct  : 0)
        : 0;
      // Shield Damage applies only on the dedicated shield-damage rows
      // (the in-game weapon tooltip shows them separately from body damage).
      const skillShieldPct = isShieldStated ? skb.shieldDamagePct : 0;
      // DeathFromAbove — generic damage % active only while suspended (context
      // chip in the techniques summary). Joins the pool on every weapon row
      // since the in-game effect is "damage while suspended," not weapon-type
      // specific. Shield-stated rows opt out (consistent with other generic
      // damage bonuses; the in-game tooltip lists shield damage separately).
      const skillSuspendedPct = !isShieldStated ? skb.suspendedDamagePct : 0;

      const poolMin = augPctMin + combatPct + staggerPct + headHunterPct + hsDmgAugPctMin + gearDmgPct + skillRangedPct + skillHeadshotPct + skillBodyPct + skillFamilyPct + skillBladePct + skillShieldPct + skillSuspendedPct;
      const poolMax = augPctMax + combatPct + staggerPct + headHunterPct + hsDmgAugPctMax + gearDmgPct + skillRangedPct + skillHeadshotPct + skillBodyPct + skillFamilyPct + skillBladePct + skillShieldPct + skillSuspendedPct;

      // Per-weapon crit multiplier applied on head rows only — fires on
      // headshots against generic NPCs (the target's UCritable interface
      // effectively equals the headshot bit for typical humanoids). Bosses
      // and weak-spot enemies may differ but we don't model per-NPC behavior.
      // Verified vs Misr ground-truth: head/body ratio matches within ~3%.
      const weaponCritDamage = item.stats?.critDamage?.value ?? 0;
      const critMul = hitMode === 'head' ? (1 + weaponCritDamage) : 1;

      const round1 = v => Math.round(v * 10) / 10;
      const finalDmg = (poolPct, flatBonus) =>
        round1((spec.statedValue + flatBonus) * spec.factorMul * hitSplit * (1 + poolPct / 100) * critMul);
      const finalMin = finalDmg(poolMin, augFlatMin);
      const finalMax = finalDmg(poolMax, augFlatMax);

      // In-game weapon tooltip = Stated × (1 + aug%). Lets the user verify
      // augment math against the actual game tooltip. Only meaningful for the
      // primary rows the game actually shows (Damage Per Shot, Damage Per Hit,
      // Shield Damage Per *) — heavy/DPS are derived rows the game doesn't
      // expose as their own tooltip values.
      const tipDmg = (pct, flat) => round1((spec.statedValue + flat) * (1 + pct / 100));
      const tooltipMin = tipDmg(augPctMin, augFlatMin);
      const tooltipMax = tipDmg(augPctMax, augFlatMax);

      // The Damage Per Shot / Shield Damage Per Shot rows carry the blast core
      // for radial weapons. Use the STATED value (= RadialDamageConfig BaseDamage /
      // BaseShieldDamage × (1+aug%)): binary RE (FUN_143b65350) confirms the radial
      // blast builds an FRadialDamageEvent with no bone, so it skips BOTH the
      // headshot/crit gate (+0x14a) AND the per-bone hit-location multiplier
      // (+0x3e0&2) — it deals full BaseDamage, no 0.40 body-split, no crit.
      if (key === 'damagePerShot') { aoeCoreMin = tooltipMin; aoeCoreMax = tooltipMax; }
      if (key === 'shieldDamagePerShot') { aoeShieldMin = tooltipMin; aoeShieldMax = tooltipMax; }

      // A headshot augment can introduce a range even when the stated-damage
      // augment is absent/single-valued — so the head row shows X–Y correctly.
      const hsIsRange = hitMode === 'head' && hsAe && !hsAe.hasCustom && hsAe.min !== hsAe.max;
      const isRange = (augEff && !augEff.hasCustom && augEff.min !== augEff.max) || hsIsRange;
      const netPositive = poolMax > 0 || augFlatMax > 0;
      const netNegative = poolMax < 0 && poolMin < 0;
      value.style.color = netNegative ? 'var(--color-health)'
                       : netPositive ? 'var(--color-stamina)'
                       : '';
      value.textContent = isRange
        ? `${formatStatValue(stat.name, finalMin)}–${formatStatValue(stat.name, finalMax)}`
        : formatStatValue(stat.name, finalMin);

      const breakdown = {
        kind: 'damage',
        name: displayLabel,
        statName: stat.name,
        statedKey: spec.statedKey,
        statedValue: spec.statedValue,
        factorMul: spec.factorMul,
        factorLabel: spec.factorLabel,
        factorSymExpr: spec.factorSymExpr,
        factorNumExpr: spec.factorNumExpr,
        factorRows: spec.factorRows || [],
        isPrimary: spec.isPrimary,
        augPctMin, augPctMax, augFlatMin, augFlatMax,
        augContribs: augContribs[spec.statedKey] || [],
        combatPct, staggerPct, headHunterPct,
        gearDmgPct, skillRangedPct, skillHeadshotPct, skillBodyPct,
        skillFamilyPct, skillBladePct, skillShieldPct, skillSuspendedPct,
        weaponFamily: item.family || '',
        hsDmgAugPctMin, hsDmgAugPctMax,
        hsContribs: hitMode === 'head' ? (augContribs['headshotDamage'] || []) : [],
        poolMin, poolMax,
        finalMin, finalMax,
        tooltipMin, tooltipMax,
        isRange,
        hitMode,
        hitSplit,
        weaponCritDamage, critMul,
      };
      row.addEventListener('mouseenter', e => showStatFormulaTooltip(breakdown, e));
      row.addEventListener('mousemove', e => positionStatFormulaTooltip(e));
      row.addEventListener('mouseleave', hideStatFormulaTooltip);

      // "Tooltip (in-game)" row above the headline value — only for primary
      // damage rows that get a hit-location split (so the in-game tooltip
      // value meaningfully differs from the headline). Shield rows skip the
      // split, so their tooltip row would just duplicate the headline value
      // sans Combat/Stagger — info already visible in the breakdown.
      const isShieldRow = spec.statedKey === 'shieldDamagePerShot' || spec.statedKey === 'shieldDamagePerHit';
      if (spec.isPrimary && !isShieldRow && augEff && (augPctMin || augPctMax || augFlatMin || augFlatMax)) {
        const tipRow = document.createElement('div');
        tipRow.className = 'stat-row';
        const tipLabel = document.createElement('span');
        tipLabel.className = 'stat-label';
        tipLabel.textContent = `Stated ${displayName}`;
        const tipValue = document.createElement('span');
        tipValue.className = 'stat-value';
        tipValue.textContent = isRange
          ? `${formatStatValue(stat.name, tooltipMin)}–${formatStatValue(stat.name, tooltipMax)}`
          : formatStatValue(stat.name, tooltipMin);
        tipRow.appendChild(tipLabel);
        tipRow.appendChild(tipValue);
        // Stated row's own breakdown: Base × (1 + Aug%) = Stated. No split, no
        // spec pool — that's the headline row's story.
        const statedBreakdown = {
          kind: 'stated',
          name: `Stated ${displayName}`,
          statName: stat.name,
          statedValue: spec.statedValue,
          augPctMin, augPctMax, augFlatMin, augFlatMax,
          augContribs: augContribs[spec.statedKey] || [],
          tooltipMin, tooltipMax,
          isRange,
        };
        tipRow.addEventListener('mouseenter', e => showStatFormulaTooltip(statedBreakdown, e));
        tipRow.addEventListener('mousemove', e => positionStatFormulaTooltip(e));
        tipRow.addEventListener('mouseleave', hideStatFormulaTooltip);
        panel.appendChild(tipRow);
      }
    } else if (key === 'powerConsumptionPerShot' && Math.abs(pwrMul - 1) > 1e-6) {
      // Player PowerEfficiency (gauntlets + BatteryExpert) multiplies the per-shot
      // cost on top of any weapon power augment. Shown as a × PwrEff factor in the
      // hover formula (cf. the exoskeleton gear bonus on damage).
      const ae = augEff; // power augment (percent) or null
      const aMul = m => (ae && ae.type === 'percent') ? (1 + m / 100) : 1;
      const round1 = v => Math.round(v * 10) / 10;
      const finalMin = round1(stat.value * aMul(ae ? ae.min : 0) * pwrMul);
      const finalMax = round1(stat.value * aMul(ae ? ae.max : 0) * pwrMul);
      const isRange = ae && !ae.hasCustom && ae.min !== ae.max;
      // Lower power = good: green when reduced below base, red if raised.
      value.style.color = finalMax < stat.value ? 'var(--color-stamina)'
                        : finalMax > stat.value ? 'var(--color-health)' : '';
      value.textContent = isRange
        ? `${formatStatValue(stat.name, finalMin)}–${formatStatValue(stat.name, finalMax)}`
        : formatStatValue(stat.name, finalMin);
      const breakdown = {
        kind: 'plain', name: displayLabel, statName: stat.name,
        baseValue: stat.value, augEff: ae, augContribs: augContribs[key] || [],
        finalMin, finalMax, isRange, powerEffMul: pwrMul,
      };
      row.addEventListener('mouseenter', e => showStatFormulaTooltip(breakdown, e));
      row.addEventListener('mousemove', e => positionStatFormulaTooltip(e));
      row.addEventListener('mouseleave', hideStatFormulaTooltip);
    } else if (key === 'powerUptime') {
      value.textContent = baseText; // "Indefinite" / "4.3s"
      if (stat.color) value.style.color = stat.color;
      if (stat._uptime) {
        const breakdown = { kind: 'uptime', name: displayLabel, valueText: stat.value, ...stat._uptime };
        row.addEventListener('mouseenter', e => showStatFormulaTooltip(breakdown, e));
        row.addEventListener('mousemove', e => positionStatFormulaTooltip(e));
        row.addEventListener('mouseleave', hideStatFormulaTooltip);
      }
    } else if (augEff) {
      // === Non-damage stat path (unchanged) ===
      const precision = key === 'accuracy' ? 1000 : 10;
      const roundP = v => Math.round(v * precision) / precision;
      const applyAug = (base) => {
        if (augEff.type === 'percent') {
          return {
            min: base * (1 + augEff.min / 100),
            max: base * (1 + augEff.max / 100),
          };
        }
        return { min: base + augEff.min, max: base + augEff.max };
      };
      const { min: augMin, max: augMax } = applyAug(stat.value);
      const finalMin = roundP(augMin);
      const finalMax = roundP(augMax);

      const lowerBetter = LOWER_IS_BETTER.has(displayName);
      const isWorse = lowerBetter ? finalMin > stat.value : finalMax < stat.value;
      const color = isWorse ? 'var(--color-health)' : 'var(--color-stamina)';

      const isRange = !augEff.hasCustom && augEff.min !== augEff.max;
      value.style.color = color;
      value.textContent = isRange
        ? `${formatStatValue(stat.name, finalMin)}–${formatStatValue(stat.name, finalMax)}`
        : formatStatValue(stat.name, finalMin);

      const breakdown = {
        kind: 'plain',
        name: displayName,
        statName: stat.name,
        baseValue: stat.value,
        augEff,
        augContribs: augContribs[key] || [],
        finalMin,
        finalMax,
        isRange,
      };
      row.addEventListener('mouseenter', e => showStatFormulaTooltip(breakdown, e));
      row.addEventListener('mousemove', e => positionStatFormulaTooltip(e));
      row.addEventListener('mouseleave', hideStatFormulaTooltip);
    } else {
      value.textContent = baseText;
    }

    // AOE Radius row → click to open the blast-field popup. The equipped AOE
    // augment (if any) scales both radii, so derive the scale band from augEff.
    if (key === 'aoeRadiusM' && item.radialBlast) {
      const sMin = augEff?.type === 'percent' ? (1 + augEff.min / 100) : 1;
      const sMax = augEff?.type === 'percent' ? (1 + augEff.max / 100) : 1;
      // snapshot the computed Damage Per Shot / Shield Damage Per Shot
      const coreMin = aoeCoreMin, coreMax = aoeCoreMax;
      const shieldMin = aoeShieldMin, shieldMax = aoeShieldMax;
      row.classList.add('stat-row--clickable');
      row.title = 'Click to view blast field';
      row.addEventListener('click', () => openAoeBlast(item, sMin, sMax, coreMin, coreMax, shieldMin, shieldMax));
    }

    row.appendChild(label);
    row.appendChild(value);
    panel.appendChild(row);
  });

  // Meta line — grade + augments
  const meta = document.createElement('div');
  meta.className = 'tooltip-panel__meta';
  const parts = [];

  if (item.maxGrade > 0 && grade > 0) {
    parts.push(`Grade ${grade}`);
  }

  if (equippedAugments[slotType]) {
    const applied = equippedAugments[slotType].filter(a => a !== null).length;
    const unlocked = augmentSlotUnlocks[slotType] || 0;
    parts.push(`Augments: ${applied}/${unlocked}`);
  }

  if (parts.length) {
    meta.textContent = parts.join('  ·  ');
    panel.appendChild(meta);
  }

  // Augment stat breakdown
  const augSlots = equippedAugments[slotType];
  if (augSlots) {
    const appliedAugs = augSlots.filter(a => a !== null);
    if (appliedAugs.length > 0) {
      const augSection = document.createElement('div');
      augSection.className = 'tooltip-panel__aug-section';

      appliedAugs.forEach(aug => {
        const augData = findAugmentData(aug.slug, slotType);
        if (!augData) return;

        const augHeader = document.createElement('div');
        augHeader.className = 'tooltip-panel__aug-name';
        augHeader.textContent = augData.name;
        augSection.appendChild(augHeader);

        const augGrade = aug.grade || 1;
        const gradeIdx = augGrade > 0 ? augGrade - 1 : 0;

        (augData.effects || []).forEach(eff => {
          const g = eff.grades?.[gradeIdx];
          if (!g) return;
          const row = document.createElement('div');
          row.className = 'stat-row';

          const label = document.createElement('span');
          label.className = 'stat-label';
          const statName = eff.name.replace(/:$/, '');
          label.textContent = statName;

          const value = document.createElement('span');
          value.className = 'stat-value';
          const fmtAugVal = v => (v >= 0 ? `+${v}` : `${v}`);

          if (eff.good === false) {
            // Downside (folded tradeoff): always rendered with a '%' suffix and
            // colored by direction. Tradeoffs repeat one value across grades.
            const isBuff = LOWER_BETTER_TRADEOFF_STATS.has(statName) ? g[1] < 0 : g[1] > 0;
            value.style.color = isBuff ? 'var(--color-stamina)' : 'var(--color-health)';
            value.textContent = `${fmtAugVal(g[1])}%`;
          } else {
            value.style.color = 'var(--color-stamina)';
            const customVal = aug.customValues?.[eff.name];
            const suffix = eff.op === 'percent' ? '%' : '';
            if (customVal != null) {
              value.textContent = `${fmtAugVal(customVal)}${suffix}`;
            } else if (g[0] === g[1]) {
              value.textContent = `${fmtAugVal(g[0])}${suffix}`;
            } else {
              value.textContent = `${fmtAugVal(g[0])}${suffix} to ${fmtAugVal(g[1])}${suffix}`;
            }
          }

          row.appendChild(label);
          row.appendChild(value);
          augSection.appendChild(row);
        });
      });

      panel.appendChild(augSection);
    }
  }
}

function showAugmentTooltip(slotType, dotIndex, force) {
  const equipped = equippedAugments[slotType]?.[dotIndex];
  if (!equipped) return;

  if (tooltipPinned && !force) return;
  const augData = findAugmentData(equipped.slug, slotType);
  if (!augData) return;
  if (tooltipClearTimer) { clearTimeout(tooltipClearTimer); tooltipClearTimer = null; }
  activeTooltip = { fn: 'augment', args: [slotType, dotIndex] };

  document.getElementById('build-stats').hidden = true;
  const panel = document.getElementById('tooltip-panel');
  panel.style.flex = '1 1 0';
  panel.innerHTML = '';

  // Name row
  const nameRow = document.createElement('div');
  nameRow.className = 'tooltip-panel__name-row';
  const nameEl = document.createElement('span');
  nameEl.className = 'tooltip-panel__name';
  nameEl.textContent = augData.name;
  nameRow.appendChild(nameEl);

  if (augData.subtype) {
    const badge = document.createElement('span');
    badge.className = 'tooltip-panel__badge rarity--unique';
    badge.textContent = augTypeLabel(augData.subtype);
    nameRow.appendChild(badge);
  }
  panel.appendChild(nameRow);

  // Effects at current grade. good:true → upside (colored stamina, op suffix,
  // honors custom override); good:false → downside (colored health, always '%').
  const grade = equipped.grade || 0;
  (augData.effects || []).forEach(eff => {
    const row = document.createElement('div');
    row.className = 'stat-row';

    const label = document.createElement('span');
    label.className = 'stat-label';
    label.textContent = eff.name.replace(/:$/, '');

    const value = document.createElement('span');
    value.className = 'stat-value';

    const gradeIdx = grade > 0 ? grade - 1 : 0;
    const g = eff.grades?.[gradeIdx];
    if (g && eff.good === false) {
      value.style.color = 'var(--color-health)';
      value.textContent = `${g[1]}%`;
    } else if (g) {
      value.style.color = 'var(--color-stamina)';
      const customVal = equipped.customValues?.[eff.name];
      const suffix = eff.op === 'percent' ? '%' : '';
      const fmtAugVal = v => (v >= 0 ? `+${v}` : `${v}`);
      if (customVal != null) {
        value.textContent = `${fmtAugVal(customVal)}${suffix}`;
      } else if (g[0] === g[1]) {
        value.textContent = `${fmtAugVal(g[0])}${suffix}`;
      } else {
        value.textContent = `${fmtAugVal(g[0])}${suffix} to ${fmtAugVal(g[1])}${suffix}`;
      }
    } else {
      value.style.color = 'var(--color-text-dim)';
      value.textContent = '—';
    }

    row.appendChild(label);
    row.appendChild(value);
    panel.appendChild(row);
  });

  // Meta — grade + description
  const meta = document.createElement('div');
  meta.className = 'tooltip-panel__meta';
  const parts = [];
  if (grade > 0) parts.push(`Grade ${grade}`);
  if (augData.description) parts.push(augData.description);
  if (parts.length) {
    meta.textContent = parts.join('  ·  ');
    panel.appendChild(meta);
  }
}

/**
 * Floating breakdown of how a weapon-tooltip stat value was computed:
 *   base × augments × spec multiplier = final.
 * Renders into #stat-formula-tooltip near the cursor — separate from the main
 * tooltip panel so it doesn't conflict with a pinned weapon tooltip.
 */
// Short, uniform stat abbreviations for formula-tooltip tokens (Aug1DMG%,
// Aug2HS%, CombatDMG%, …). Keyed by the EXPANDED stat key as it appears in a
// contribution (damage→damagePerShot/Hit, dartMitigation→light/heavyDartMitigation).
// Unmapped keys fall back to a CamelCase of the key so future stats degrade gracefully.
const STAT_ABBREV = {
  damagePerShot: 'DMG', damagePerHit: 'DMG',
  shieldDamagePerShot: 'SHD', shieldDamagePerHit: 'SHD',
  headshotDamage: 'HS',
  rateOfFire: 'ROF', clipSize: 'CLIP', reloadTime: 'RLD', recoil: 'RCL',
  accuracy: 'ACC', projectileSpread: 'SPR', effectiveRange: 'RNG', maximumRange: 'MaxRNG',
  aoeRadiusM: 'AOE', powerConsumptionPerShot: 'PWR', attackStaminaCost: 'ATKStam',
  volume: 'VOL', blockStaminaCost: 'BlkStam',
  fireDamageOverTime: 'FireDOT', poisonDamageOverTime: 'PoisonDOT',
  armorValue: 'ARM',
  lightDartMitigation: 'LDartMit', heavyDartMitigation: 'HDartMit',
  energyMitigation: 'EnrgMit', bladeMitigation: 'BladeMit', concussiveMitigation: 'ConcMit',
  fireMitigation: 'FireMit', poisonMitigation: 'PsnMit', radiationMitigation: 'RadMit',
  heatProtection: 'HeatProt', durabilityLossOnDefeat: 'DurLoss',
};
const statAbbrev = (key) => STAT_ABBREV[key] || (key ? key.charAt(0).toUpperCase() + key.slice(1) : '');

function showStatFormulaTooltip(b, event) {
  if (!appSettings.showFormulas) return;
  const tip = document.getElementById('stat-formula-tooltip');
  if (!tip) return;
  tip.innerHTML = '';

  const title = document.createElement('div');
  title.className = 'stat-formula-tooltip__title';
  title.textContent = b.name;
  tip.appendChild(title);

  const addRow = (label, value, cls) => {
    const row = document.createElement('div');
    row.className = 'stat-formula-tooltip__row' + (cls ? ' ' + cls : '');
    const l = document.createElement('span'); l.className = 'label'; l.textContent = label;
    const v = document.createElement('span'); v.className = 'value'; v.textContent = value;
    row.appendChild(l); row.appendChild(v);
    tip.appendChild(row);
  };
  const addFormula = (text) => {
    const f = document.createElement('div');
    f.className = 'stat-formula-tooltip__formula';
    f.textContent = text;
    tip.appendChild(f);
  };
  const addTotal = (label, value) => {
    const row = document.createElement('div');
    row.className = 'stat-formula-tooltip__total';
    const l = document.createElement('span'); l.textContent = label;
    const v = document.createElement('span'); v.textContent = value;
    row.appendChild(l); row.appendChild(v);
    tip.appendChild(row);
  };

  // Shared helpers for damage / stated kinds: render each augment as its own
  // term in both the symbolic and the numeric (computed) form of the formula.
  const fmtPct  = v => `${v >= 0 ? '+' : ''}${Math.round(v * 10) / 10}%`;
  const fmtFlat = v => `${v >= 0 ? '+' : ''}${Math.round(v * 10) / 10}`;
  const fmtDec  = v => {
    const r = Math.round(v * 10000) / 10000;
    return String(r);
  };
  const fmtNum  = v => {
    const r = Math.round(v * 100) / 100;
    return String(r);
  };

  const addComputed = (text) => {
    const f = document.createElement('div');
    f.className = 'stat-formula-tooltip__computed';
    f.textContent = text;
    tip.appendChild(f);
  };
  const addDivider = () => {
    const d = document.createElement('div');
    d.className = 'stat-formula-tooltip__divider';
    tip.appendChild(d);
  };

  // Split augContribs into the flat additions (modify Base) and the percent
  // contributions (join the bonus pool).
  const flatContribs = (b.augContribs || []).filter(c => c.type !== 'percent');
  const pctContribs  = (b.augContribs || []).filter(c => c.type === 'percent');
  // Headshot-damage augment contributions (head rows only; [] otherwise).
  const hsContribs = b.hsContribs || [];

  // Build symbolic + numeric forms for the bonus pool. Each augment gets its
  // own Aug# placeholder so the formula expands per-augment rather than
  // hiding everything under a single "Aug%" bucket.
  const buildPoolExpr = ({ includeSpecs }) => {
    const sym = [], num = [];
    pctContribs.forEach((c, i) => {
      sym.push(`Aug${i + 1}${statAbbrev(c.key)}%`);
      num.push(fmtDec(c.max / 100));
    });
    hsContribs.forEach((c, i) => {
      sym.push(`Aug${i + 1}${statAbbrev(c.key)}%`);
      num.push(fmtDec(c.max / 100));
    });
    if (includeSpecs && b.combatPct)     { sym.push('CombatDMG%');  num.push(fmtDec(b.combatPct / 100)); }
    if (includeSpecs && b.staggerPct)    { sym.push('SabotageSTGR%'); num.push(fmtDec(b.staggerPct / 100)); }
    if (includeSpecs && b.headHunterPct) { sym.push('SabotageHS%'); num.push(fmtDec(b.headHunterPct / 100)); }
    if (includeSpecs && b.gearDmgPct)    { sym.push('GearDMG%');   num.push(fmtDec(b.gearDmgPct / 100)); }
    if (includeSpecs && b.skillRangedPct){ sym.push('SkillRGD%');  num.push(fmtDec(b.skillRangedPct / 100)); }
    if (includeSpecs && b.skillHeadshotPct){ sym.push('SkillHS%'); num.push(fmtDec(b.skillHeadshotPct / 100)); }
    if (includeSpecs && b.skillBodyPct)  { sym.push('SkillBDY%'); num.push(fmtDec(b.skillBodyPct / 100)); }
    if (includeSpecs && b.skillFamilyPct){ sym.push('SkillFAM%'); num.push(fmtDec(b.skillFamilyPct / 100)); }
    if (includeSpecs && b.skillBladePct) { sym.push('SkillBLD%'); num.push(fmtDec(b.skillBladePct / 100)); }
    if (includeSpecs && b.skillShieldPct){ sym.push('SkillSHD%'); num.push(fmtDec(b.skillShieldPct / 100)); }
    if (includeSpecs && b.skillSuspendedPct){ sym.push('SkillSUS%'); num.push(fmtDec(b.skillSuspendedPct / 100)); }
    return {
      sym: sym.length ? ` × (1 + ${sym.join(' + ')})` : '',
      num: sym.length ? ` × (1 + ${num.join(' + ')})` : '',
    };
  };

  // Base may have flat augment additions folded in: (Base + Aug1flat + …).
  const buildBaseExpr = () => {
    if (!flatContribs.length) {
      return { sym: 'Base', num: fmtNum(b.statedValue) };
    }
    const symParts = ['Base', ...flatContribs.map((c, i) => `Aug${i + 1}${statAbbrev(c.key)}`)];
    const numParts = [fmtNum(b.statedValue), ...flatContribs.map(c => fmtFlat(c.max))];
    return { sym: `(${symParts.join(' + ')})`, num: `(${numParts.join(' + ')})` };
  };

  // Render the per-augment rows below the formulas — same in both kinds.
  // Rows are listed in the same order as the Aug# terms in the formula above,
  // so the user can match positionally without needing the "Aug1:" prefix.
  const renderAugRows = () => {
    pctContribs.forEach(c => {
      const tag = `${c.augName} G${c.augGrade}${c.isTradeoff ? ' (tradeoff)' : ''} (${statAbbrev(c.key)})`;
      const valText = c.min === c.max ? fmtPct(c.max) : `${fmtPct(c.min)} to ${fmtPct(c.max)}`;
      addRow(tag, valText);
    });
    hsContribs.forEach(c => {
      const tag = `${c.augName} G${c.augGrade}${c.isTradeoff ? ' (tradeoff)' : ''} (${statAbbrev(c.key)})`;
      const valText = c.min === c.max ? fmtPct(c.max) : `${fmtPct(c.min)} to ${fmtPct(c.max)}`;
      addRow(tag, valText);
    });
    flatContribs.forEach(c => {
      const tag = `${c.augName} G${c.augGrade}${c.isTradeoff ? ' (tradeoff)' : ''} (${statAbbrev(c.key)})`;
      const valText = c.min === c.max ? fmtFlat(c.max) : `${fmtFlat(c.min)} to ${fmtFlat(c.max)}`;
      addRow(tag, valText);
    });
  };

  if (b.kind === 'damage') {
    const hasFactor = !!b.factorLabel;
    const hasSplit = b.hitMode !== 'none';
    const hasCrit = b.critMul && b.critMul !== 1;
    // Wrap multi-token factor expressions in parens to make the precedence
    // unambiguous (e.g., `Clip / (Clip × 60/RoF + Reload)` needs outer parens
    // so it's clear the whole quotient is the factor).
    const wrap = expr => expr.includes(' ') ? `(${expr})` : expr;
    const factorSym = hasFactor && b.factorSymExpr ? ` × ${wrap(b.factorSymExpr)}` : '';
    const factorNum = hasFactor && b.factorNumExpr ? ` × ${wrap(b.factorNumExpr)}` : '';
    const splitSym = hasSplit ? ' × Split' : '';
    const splitNum = hasSplit ? ` × ${b.hitSplit.toFixed(2)}` : '';
    // Per-weapon crit multiplier — head rows only, hidden when critDamage = 0
    // (scatterguns, flamethrowers, mining tools) so the formula stays clean.
    const critSym = hasCrit ? ' × Crit' : '';
    const critNum = hasCrit ? ` × ${b.critMul.toFixed(2)}` : '';
    const resultLabel = hasSplit ? 'Hit Damage' : 'Damage';

    const baseExpr = buildBaseExpr();
    const poolExpr = buildPoolExpr({ includeSpecs: true });
    const finalText = b.isRange
      ? `${formatStatValue(b.statName, b.finalMin)}–${formatStatValue(b.statName, b.finalMax)}`
      : formatStatValue(b.statName, b.finalMin);

    addFormula(`${baseExpr.sym}${factorSym}${splitSym}${poolExpr.sym}${critSym} = ${resultLabel}`);
    addDivider();
    addComputed(`${baseExpr.num}${factorNum}${splitNum}${poolExpr.num}${critNum} = ${formatStatValue(b.statName, b.finalMax)}`);
    addDivider();

    addRow('Base', formatStatValue(b.statName, b.statedValue));
    // One row per variable that appears in the formula's factor (e.g., Clip,
    // RoF, Reload for sustained DPS; Heavy ×3 for heavy attacks). No derived
    // intermediates — every row maps to a term the formula references.
    (b.factorRows || []).forEach(r => addRow(r.label, r.value));
    if (hasSplit) {
      const splitLabel = b.hitMode === 'head' ? `Head ×${HIT_SPLIT_HEAD.toFixed(2)}`
                                              : `Body ×${HIT_SPLIT_BODY.toFixed(2)}`;
      addRow('Split', splitLabel);
    }
    renderAugRows();
    if (b.combatPct)     addRow('CombatDMG',  fmtPct(b.combatPct));
    if (b.staggerPct)    addRow('SabotageSTGR', fmtPct(b.staggerPct));
    if (b.headHunterPct) addRow('SabotageHS', fmtPct(b.headHunterPct));
    if (b.gearDmgPct)    addRow('GearDMG', fmtPct(b.gearDmgPct));
    if (b.skillRangedPct) addRow('Skill RGD', fmtPct(b.skillRangedPct));
    if (b.skillHeadshotPct) addRow('Skill HS', fmtPct(b.skillHeadshotPct));
    if (b.skillBodyPct) addRow('Skill BDY', fmtPct(b.skillBodyPct));
    // Per-family / blade / shield rows label themselves with the family name
    // so it's clear WHY they fire (e.g. "Pistol Damage" on a Maula Pistol).
    if (b.skillFamilyPct) addRow(`Skill ${b.weaponFamily || 'Family'}`, fmtPct(b.skillFamilyPct));
    if (b.skillBladePct) addRow('Skill Blade', fmtPct(b.skillBladePct));
    if (b.skillShieldPct) addRow('Skill Shield', fmtPct(b.skillShieldPct));
    if (b.skillSuspendedPct) addRow('Skill Suspended', fmtPct(b.skillSuspendedPct));
    if (hasCrit) addRow('Crit', `+${Math.round(b.weaponCritDamage * 100)}% (×${b.critMul.toFixed(2)})`);

    addTotal(b.name, finalText);
  } else if (b.kind === 'stated') {
    // In-game tooltip value: (Base + flat aug) × (1 + Aug%…) = Stated.
    const baseExpr = buildBaseExpr();
    const poolExpr = buildPoolExpr({ includeSpecs: false });
    const totalText = b.isRange
      ? `${formatStatValue(b.statName, b.tooltipMin)}–${formatStatValue(b.statName, b.tooltipMax)}`
      : formatStatValue(b.statName, b.tooltipMin);

    addFormula(`${baseExpr.sym}${poolExpr.sym} = Stated`);
    addDivider();
    addComputed(`${baseExpr.num}${poolExpr.num} = ${formatStatValue(b.statName, b.tooltipMax)}`);
    addDivider();

    addRow('Base', formatStatValue(b.statName, b.statedValue));
    renderAugRows();

    addTotal('Stated', totalText);
  } else if (b.kind === 'uptime') {
    // Power uptime: PackPool / (cost/s − regen/s). cost/shot already carries the
    // weapon power augment AND the player PowerEfficiency (gear/skill).
    const fmtN = v => formatNumber(v, 1);
    addFormula('PackPool / (Cost/s − Regen/s)');
    addDivider();
    if (b.sustainable) {
      addComputed(`Cost/s ${fmtN(b.costPerSec)} ≤ Regen/s ${fmtN(b.regenPerSec)} → Indefinite`);
    } else {
      addComputed(`${fmtNum(b.pool)} / (${fmtN(b.costPerSec)} − ${fmtN(b.regenPerSec)}) = ${b.valueText}`);
    }
    addDivider();
    addRow('Cost / shot', fmtN(b.costPerShot));
    addRow('Rate of Fire', fmtNum(b.rof));
    addRow('Cost / sec', fmtN(b.costPerSec));
    addRow('Regen / sec', fmtN(b.regenPerSec));
    if (b.pool != null) addRow('Pack Pool', fmtNum(b.pool));
    if (Math.abs(b.pwrMul - 1) > 1e-6) addRow('Power Efficiency', fmtPct((b.pwrMul - 1) * 100));
    addTotal('Power Uptime', b.valueText);
  } else {
    // Plain (non-damage) stat. Expanded per-augment, matching the damage rows:
    //   percent: Base × (1 + Aug1% + Aug2% + …) = Final
    //   flat:    Base + Aug1 + Aug2 + …          = Final
    const isPct = b.augEff && b.augEff.type === 'percent';
    const finalText = b.isRange
      ? `${formatStatValue(b.statName, b.finalMin)}–${formatStatValue(b.statName, b.finalMax)}`
      : formatStatValue(b.statName, b.finalMin);
    // Player power-efficiency multiplier (gauntlets + BatteryExpert) shown as a
    // × PwrEff factor, the way the exoskeleton gear bonus appears on damage.
    const pe = b.powerEffMul != null && Math.abs(b.powerEffMul - 1) > 1e-6;
    const peSym = pe ? ' × PwrEff' : '';
    const peNum = pe ? ` × ${fmtDec(b.powerEffMul)}` : '';

    if (isPct) {
      const poolExpr = buildPoolExpr({ includeSpecs: false });
      addFormula(`Base${poolExpr.sym}${peSym} = Final`);
      addDivider();
      addComputed(`${fmtNum(b.baseValue)}${poolExpr.num}${peNum} = ${formatStatValue(b.statName, b.finalMax)}`);
    } else {
      // Flat: render proper +/- signs in the numeric form (Base - 2, not + -2).
      let symExpr = 'Base', numExpr = fmtNum(b.baseValue);
      flatContribs.forEach((c, i) => {
        symExpr += ` + Aug${i + 1}`;
        const rv = Math.round(c.max * 10) / 10;
        numExpr += rv >= 0 ? ` + ${rv}` : ` - ${Math.abs(rv)}`;
      });
      addFormula(`${symExpr}${peSym} = Final`);
      addDivider();
      addComputed(`${numExpr}${peNum} = ${formatStatValue(b.statName, b.finalMax)}`);
    }
    addDivider();

    addRow('Base', formatStatValue(b.statName, b.baseValue));
    renderAugRows();
    if (pe) addRow('Power Efficiency', fmtPct((b.powerEffMul - 1) * 100));
    addTotal('Final', finalText);
  }

  tip.hidden = false;
  positionStatFormulaTooltip(event);
}

function positionStatFormulaTooltip(event) {
  const tip = document.getElementById('stat-formula-tooltip');
  if (!tip || tip.hidden) return;
  const pad = 12;
  const edge = 8;
  const rect = tip.getBoundingClientRect();
  let x = event.clientX + pad;
  if (x + rect.width > window.innerWidth - edge) x = event.clientX - rect.width - pad;
  // Direction based on cursor position so neighboring rows place consistently.
  const placeAbove = event.clientY > window.innerHeight / 2;
  let y = placeAbove
    ? event.clientY - rect.height - pad
    : event.clientY + pad;
  x = Math.max(edge, Math.min(x, window.innerWidth - rect.width - edge));
  y = Math.max(edge, Math.min(y, window.innerHeight - rect.height - edge));
  tip.style.left = `${x}px`;
  tip.style.top  = `${y}px`;
}

function hideStatFormulaTooltip() {
  const tip = document.getElementById('stat-formula-tooltip');
  if (tip) tip.hidden = true;
}

/**
 * Right-panel calc-row formula tooltip — renders into the floating element
 * (#stat-formula-tooltip) near the cursor so it never has to clobber the
 * main right-panel tooltip area (which is also used for weapon hover).
 *
 * Formula string is the existing two-line "generic\ncomputed" format used by
 * createStatRow call sites.
 */
function showFormulaTooltip(label, value, formula, event, rows) {
  if (!appSettings.showFormulas) return;
  const tip = document.getElementById('stat-formula-tooltip');
  if (!tip) return;
  tip.innerHTML = '';

  const title = document.createElement('div');
  title.className = 'stat-formula-tooltip__title';
  title.textContent = label;
  tip.appendChild(title);

  const [generic, computed] = (formula || '').split('\n');

  if (generic) {
    const g = document.createElement('div');
    g.className = 'stat-formula-tooltip__formula';
    g.textContent = generic;
    tip.appendChild(g);
  }

  if (generic && computed) {
    const d = document.createElement('div');
    d.className = 'stat-formula-tooltip__divider';
    tip.appendChild(d);
  }

  if (computed) {
    const c = document.createElement('div');
    c.className = 'stat-formula-tooltip__computed';
    c.textContent = computed;
    tip.appendChild(c);
  }

  // Contributor row list — same shape as the weapon-damage tooltip's
  // per-augment rows. Each row pairs a source name with its value
  // (e.g. "Vitality r3 (Max Health)" / "+55").
  if (Array.isArray(rows) && rows.length) {
    if (generic || computed) {
      const d = document.createElement('div');
      d.className = 'stat-formula-tooltip__divider';
      tip.appendChild(d);
    }
    for (const r of rows) {
      const row = document.createElement('div');
      row.className = 'stat-formula-tooltip__row';
      const l = document.createElement('span'); l.className = 'label'; l.textContent = r.label;
      const v = document.createElement('span'); v.className = 'value'; v.textContent = String(r.value);
      row.appendChild(l); row.appendChild(v);
      tip.appendChild(row);
    }
  }

  // Total row pinned at the bottom mirrors the value shown in the panel.
  const total = document.createElement('div');
  total.className = 'stat-formula-tooltip__total';
  const tLabel = document.createElement('span'); tLabel.textContent = label;
  const tValue = document.createElement('span'); tValue.textContent = String(value);
  total.appendChild(tLabel); total.appendChild(tValue);
  tip.appendChild(total);

  tip.hidden = false;
  if (event) positionStatFormulaTooltip(event);
}

let tooltipClearTimer = null;
// What's currently in the right-panel tooltip, so we can re-render it in place
// when build state changes (augment applied, spec level moved, etc.) without
// the user having to mouseout/mouseback to see fresh values.
let activeTooltip = null; // { fn: 'item'|'augment', args: [...] }

// Ctrl-hold "pins" the tooltip — keeps it visible across mouseleave events so
// the user can move onto the tooltip itself (scroll it, hover inner rows).
let tooltipPinned = false;

function clearTooltip() {
  // Skip the deferred clear while the user is holding Ctrl to pin the tooltip.
  if (tooltipPinned) return;
  tooltipClearTimer = setTimeout(() => {
    activeTooltip = null;
    document.getElementById('build-stats').hidden = false;
    const panel = document.getElementById('tooltip-panel');
    panel.style.flex = '';
    panel.innerHTML = '<div class="tooltip-panel__empty">Hover an item to inspect</div>';
  }, 100);
}

function refreshActiveTooltip() {
  if (!activeTooltip) return;
  const t = activeTooltip;
  // `true` bypasses the pin so this internal refresh can update values while
  // the user is holding Ctrl on the currently-shown tooltip.
  if (t.fn === 'item') showTooltip(t.args[0], true);
  else if (t.fn === 'augment') showAugmentTooltip(t.args[0], t.args[1], true);
}

function updateSlotDisplay(slotEl, item) {
  slotEl.classList.add('has-item');
  slotEl.title = item.name;
  slotEl.innerHTML = '';

  const img = document.createElement('img');
  img.className = 'armor-slot__icon';
  img.src = item.icon;
  img.alt = item.name;
  img.draggable = false; // stop native image drag (was draggable to desktop)

  const clearBtn = document.createElement('button');
  clearBtn.className = 'armor-slot__clear';
  clearBtn.textContent = '×';
  clearBtn.title = 'Remove';
  clearBtn.addEventListener('click', e => { e.stopPropagation(); clearSlot(slotEl); });

  slotEl.appendChild(img);
  slotEl.appendChild(clearBtn);

  const slotType = getSlotType(slotEl);
  // A rad suit is rendered on the 'helm' position; its grade ring / augment dots live there.
  if (slotType && GARMENT_SLOTS.has(slotType) && item.maxGrade > 0) {
    slotEl.appendChild(createSlotGradeRing(slotType));
    // Augment dots only for Unique garments
    if (item.rarity === 'Unique') {
      if (!augmentSlotUnlocks[slotType]) augmentSlotUnlocks[slotType] = 1;
      if (!equippedAugments[slotType]) equippedAugments[slotType] = [null, null, null];
      slotEl.appendChild(createAugmentDots(slotType));
    }
  }

}

function clearSlot(slotEl) {
  const slotType = getSlotType(slotEl);
  const item = slotType ? equippedItems[slotType] : null;

  if (item?.slot === 'radsuit') {
    ARMOR_SLOTS.forEach(s => { delete equippedItems[s]; delete equippedGrades[s]; delete equippedAugments[s]; delete augmentSlotUnlocks[s]; });
    document.querySelector('.armor-layout').classList.remove('radsuit-active');
    document.querySelectorAll('.armor-slot').forEach(el => {
      const st = getSlotType(el);
      if (ARMOR_SLOTS.has(st)) {
        el.classList.remove('has-item');
        el.title = '';
        el.innerHTML = `<span class="slot-label">${SLOT_ORIGINAL_LABELS[getSlotClass(el)] || ''}</span>`;
      }
    });
  } else {
    if (slotType) { delete equippedItems[slotType]; delete equippedGrades[slotType]; delete equippedAugments[slotType]; delete augmentSlotUnlocks[slotType]; }
    const slotClass = getSlotClass(slotEl);
    slotEl.classList.remove('has-item');
    slotEl.title = '';
    slotEl.innerHTML = `<span class="slot-label">${SLOT_ORIGINAL_LABELS[slotClass] || ''}</span>`;
  }

  refreshPanels();
}

// =============================================
// HOTBAR — WEAPON SLOTS
// =============================================

function getHotbarSlotType(el) {
  const idx = el.dataset.hotbar;
  return idx != null ? `hotbar${idx}` : null;
}

function selectHotbarSlot(index) {
  // Only select if slot has an item
  if (!equippedItems[`hotbar${index}`]) return;
  activeHotbarIndex = index;
  updateHotbarSelection();
}

function updateHotbarSelection() {
  document.querySelectorAll('.hotbar-slot').forEach(el => {
    const idx = parseInt(el.dataset.hotbar, 10);
    el.classList.toggle('hotbar-slot--active', idx === activeHotbarIndex);
  });
}

function autoSelectFirstHotbarWeapon() {
  for (let i = 0; i < 8; i++) {
    if (equippedItems[`hotbar${i}`]) {
      activeHotbarIndex = i;
      updateHotbarSelection();
      return;
    }
  }
  activeHotbarIndex = null;
  updateHotbarSelection();
}

function cycleHotbar(direction) {
  // Collect occupied indices
  const occupied = [];
  for (let i = 0; i < 8; i++) {
    if (equippedItems[`hotbar${i}`]) occupied.push(i);
  }
  if (occupied.length === 0) return;

  if (activeHotbarIndex == null) {
    activeHotbarIndex = direction > 0 ? occupied[0] : occupied[occupied.length - 1];
  } else {
    const currentPos = occupied.indexOf(activeHotbarIndex);
    if (currentPos === -1) {
      activeHotbarIndex = direction > 0 ? occupied[0] : occupied[occupied.length - 1];
    } else {
      const nextPos = currentPos + direction;
      if (nextPos < 0 || nextPos >= occupied.length) return; // no wrap
      activeHotbarIndex = occupied[nextPos];
    }
  }
  updateHotbarSelection();
}

function getActiveHotbarSlotType() {
  return activeHotbarIndex != null ? `hotbar${activeHotbarIndex}` : null;
}

function getFilteredWeaponItems() {
  let items = [...WEAPON_ITEMS].sort((a, b) => {
    const tierA = a.tier ?? 0;
    const tierB = b.tier ?? 0;
    if (tierA !== tierB) return tierB - tierA;
    if (a.rarity !== b.rarity) return a.rarity === 'Unique' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  if (!appSettings.showWeaponCommons) {
    items = items.filter(i => i.rarity !== 'Common');
  }
  items = items.filter(i => {
    const tier = i.tier;
    if (tier === 1 && !appSettings.showWeaponT1) return false;
    if (tier === 2 && !appSettings.showWeaponT2) return false;
    if (tier === 3 && !appSettings.showWeaponT3) return false;
    if (tier === 4 && !appSettings.showWeaponT4) return false;
    if (tier === 5 && !appSettings.showWeaponT5) return false;
    return true;
  });
  // Apply weapon type filter
  if (!weaponTypeFilter.melee || !weaponTypeFilter.ranged) {
    items = items.filter(i => {
      if (i.subtype === 'melee' && !weaponTypeFilter.melee) return false;
      if (i.subtype === 'ranged' && !weaponTypeFilter.ranged) return false;
      return true;
    });
  }
  return items;
}

function refilterHotbarPicker() {
  // A type-filter toggle changes which items are candidates, so rebuild the
  // card list for the new candidate set, then re-apply the current search text.
  currentPickerItems = getFilteredWeaponItems();
  renderPickerItems(currentPickerItems, currentPickerSlotType);
  const list = document.getElementById('item-picker-list');
  filterPickerList(list, document.getElementById('item-picker-search').value, 'No items found.');
}

function createWeaponTypeFilters() {
  // Remove any existing filter bar
  const existing = document.getElementById('weapon-type-filters');
  if (existing) existing.remove();

  const bar = document.createElement('div');
  bar.id = 'weapon-type-filters';
  bar.className = 'weapon-type-filters';

  const createBtn = (type, label) => {
    const btn = document.createElement('button');
    btn.className = 'weapon-type-btn';
    btn.textContent = label;
    btn.classList.toggle('active', weaponTypeFilter[type]);
    btn.addEventListener('click', () => {
      weaponTypeFilter[type] = !weaponTypeFilter[type];
      btn.classList.toggle('active', weaponTypeFilter[type]);
      refilterHotbarPicker();
    });
    return btn;
  };

  bar.appendChild(createBtn('melee', 'Melee'));
  bar.appendChild(createBtn('ranged', 'Ranged'));

  // Insert into the item picker header specifically
  const overlay = document.getElementById('item-picker-overlay');
  const header = overlay.querySelector('.item-picker-header');
  const closeBtn = overlay.querySelector('.item-picker-close');
  header.insertBefore(bar, closeBtn);
}

function removeWeaponTypeFilters() {
  const existing = document.getElementById('weapon-type-filters');
  if (existing) existing.remove();
}

function openHotbarPicker(slotEl) {
  const slotType = getHotbarSlotType(slotEl);
  if (!slotType) return;

  // Reset filters unless persistence is on
  if (!appSettings.persistWeaponTypeFilter) {
    weaponTypeFilter.melee = true;
    weaponTypeFilter.ranged = true;
  }

  const idx = parseInt(slotEl.dataset.hotbar, 10);
  document.getElementById('item-picker-title').textContent = `Hotbar Slot ${idx + 1}`;
  document.getElementById('item-picker-search').value = '';

  currentPickerItems = getFilteredWeaponItems();
  currentPickerSlotType = slotType;

  createWeaponTypeFilters();
  renderPickerItems(currentPickerItems, slotType);

  const overlay = document.getElementById('item-picker-overlay');
  requestAnimationFrame(() => requestAnimationFrame(() => overlay.classList.add('visible')));
}

function selectHotbarItem(slotType, slug) {
  const item = WEAPON_BY_SLUG.get(slug);
  if (!item || !slotType) return;

  equippedItems[slotType] = item;
  equippedGrades[slotType] = 0;

  const idx = parseInt(slotType.replace('hotbar', ''), 10);
  const slotEl = document.querySelector(`.hotbar-slot[data-hotbar="${idx}"]`);
  if (slotEl) updateHotbarSlotDisplay(slotEl, item, slotType);

  // Auto-select this slot if nothing is active
  if (activeHotbarIndex == null) {
    activeHotbarIndex = idx;
    updateHotbarSelection();
  }

  closeItemPicker();
}

function updateHotbarSlotDisplay(slotEl, item, slotType) {
  slotEl.classList.add('has-item');
  slotEl.title = item.name;
  // Preserve the slot number
  const idx = parseInt(slotEl.dataset.hotbar, 10);
  slotEl.innerHTML = '';

  const numEl = document.createElement('span');
  numEl.className = 'slot-number';
  numEl.textContent = String(idx + 1);
  slotEl.appendChild(numEl);

  const img = document.createElement('img');
  img.className = 'hotbar-slot__icon';
  img.src = item.icon;
  img.alt = item.name;
  img.draggable = false; // let the slot's drag-to-swap handle dragging, not the image
  slotEl.appendChild(img);

  const clearBtn = document.createElement('button');
  clearBtn.className = 'hotbar-slot__clear';
  clearBtn.textContent = '×';
  clearBtn.title = 'Remove';
  clearBtn.addEventListener('click', e => { e.stopPropagation(); clearHotbarSlot(slotEl); });
  slotEl.appendChild(clearBtn);

  // Grade ring for Unique weapons that support grades.
  if (item.maxGrade > 0) {
    slotEl.appendChild(createSlotGradeRing(slotType));
    if (item.rarity === 'Unique') {
      if (!augmentSlotUnlocks[slotType]) augmentSlotUnlocks[slotType] = 1;
      if (!equippedAugments[slotType]) equippedAugments[slotType] = [null, null, null];
      slotEl.appendChild(createAugmentDots(slotType));
    }
  }

}

function clearHotbarSlot(slotEl) {
  const slotType = getHotbarSlotType(slotEl);
  if (slotType) {
    delete equippedItems[slotType];
    delete equippedGrades[slotType];
    delete equippedAugments[slotType];
    delete augmentSlotUnlocks[slotType];
  }
  const idx = parseInt(slotEl.dataset.hotbar, 10);
  slotEl.classList.remove('has-item');
  slotEl.title = '';
  slotEl.innerHTML = '';
  const numEl = document.createElement('span');
  numEl.className = 'slot-number';
  numEl.textContent = String(idx + 1);
  slotEl.appendChild(numEl);

  // If we cleared the active slot, auto-select the next available
  if (activeHotbarIndex === idx) {
    autoSelectFirstHotbarWeapon();
  }
}

// Re-render a hotbar slot's DOM from current state without mutating that state
// (unlike clearHotbarSlot). Used after a drag-swap.
function renderHotbarSlotDom(slotType) {
  const idx = parseInt(slotType.replace('hotbar', ''), 10);
  const slotEl = document.querySelector(`.hotbar-slot[data-hotbar="${idx}"]`);
  if (!slotEl) return;
  const item = equippedItems[slotType];
  if (item) {
    updateHotbarSlotDisplay(slotEl, item, slotType);
  } else {
    slotEl.classList.remove('has-item');
    slotEl.title = '';
    slotEl.innerHTML = '';
    const numEl = document.createElement('span');
    numEl.className = 'slot-number';
    numEl.textContent = String(idx + 1);
    slotEl.appendChild(numEl);
  }
}

// Swap the full per-slot state between two hotbar slots so the user can arrange
// the hotbar to match in-game without re-picking. The weapon's grade and
// augments travel with it. If the target is empty, the source moves there.
function swapHotbarSlots(srcType, tgtType) {
  if (!srcType || !tgtType || srcType === tgtType) return;
  for (const map of [equippedItems, equippedGrades, equippedAugments, augmentSlotUnlocks]) {
    const tmp = map[srcType];
    if (map[tgtType] === undefined) delete map[srcType]; else map[srcType] = map[tgtType];
    if (tmp === undefined) delete map[tgtType]; else map[tgtType] = tmp;
  }
  renderHotbarSlotDom(srcType);
  renderHotbarSlotDom(tgtType);
  // Active slot is positional; if it ended up empty, fall back to the first weapon.
  if (activeHotbarIndex != null && !equippedItems[`hotbar${activeHotbarIndex}`]) {
    autoSelectFirstHotbarWeapon();
  } else {
    updateHotbarSelection();
  }
  refreshPanels(true);
}

(async () => {
  await loadGarmentItems();

  document.querySelectorAll('.armor-slot').forEach(slotEl => {
    if (slotEl.classList.contains('slot--null')) return;
    slotEl.addEventListener('click', () => openItemPicker(slotEl));
    const armorSlotType = getSlotType(slotEl);
    slotEl.addEventListener('mouseenter', () => showTooltip(armorSlotType));
    slotEl.addEventListener('mouseleave', clearTooltip);

    // Armor slots drag as the whole slot object (matching the hotbar's look)
    // instead of the bare icon, but they're fixed positions — no drop/swap.
    slotEl.draggable = true;
    slotEl.addEventListener('dragstart', e => {
      e.dataTransfer.effectAllowed = 'none'; // can't be dropped anywhere
      slotEl.classList.add('slot-dragging');
    });
    slotEl.addEventListener('dragend', () => slotEl.classList.remove('slot-dragging'));
  });

  // Hotbar slot click → weapon picker
  document.querySelectorAll('.hotbar-slot').forEach(slotEl => {
    slotEl.addEventListener('click', e => {
      // Don't open picker if clicking clear button, grade ring, or augment dots
      if (e.target.closest('.hotbar-slot__clear, .armor-slot__grade, .augment-dots')) return;
      openHotbarPicker(slotEl);
    });
    const hotbarSlotType = getHotbarSlotType(slotEl);
    slotEl.addEventListener('mouseenter', () => showTooltip(hotbarSlotType));
    slotEl.addEventListener('mouseleave', clearTooltip);

    // Drag-to-swap: arrange weapons across slots to match in-game positions.
    slotEl.draggable = true;
    slotEl.addEventListener('dragstart', e => {
      const st = getHotbarSlotType(slotEl);
      if (!st || !equippedItems[st]) { e.preventDefault(); return; } // nothing to drag
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', st);
      slotEl.classList.add('slot-dragging');
    });
    slotEl.addEventListener('dragend', () => slotEl.classList.remove('slot-dragging'));
    slotEl.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      slotEl.classList.add('hotbar-slot--dragover');
    });
    slotEl.addEventListener('dragleave', () => slotEl.classList.remove('hotbar-slot--dragover'));
    slotEl.addEventListener('drop', e => {
      e.preventDefault();
      slotEl.classList.remove('hotbar-slot--dragover');
      const srcType = e.dataTransfer.getData('text/plain');
      const tgtType = getHotbarSlotType(slotEl);
      swapHotbarSlots(srcType, tgtType);
    });
  });

  document.getElementById('item-picker-close').addEventListener('click', closeItemPicker);

  document.getElementById('item-picker-overlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeItemPicker();
  });

  document.getElementById('item-picker-search').addEventListener('input', e => {
    filterPickerList(document.getElementById('item-picker-list'), e.target.value, 'No items found.');
  });

  // Augment picker events
  document.getElementById('augment-picker-close').addEventListener('click', closeAugmentPicker);

  document.getElementById('augment-picker-overlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeAugmentPicker();
  });

  document.getElementById('augment-picker-search').addEventListener('input', e => {
    filterPickerList(document.getElementById('augment-picker-list'), e.target.value, 'No augments found.');
  });

  // Augment custom value popup events
  document.getElementById('augment-value-save').addEventListener('click', saveAugmentCustomValue);
  document.getElementById('augment-value-cancel').addEventListener('click', closeAugmentValuePopup);

  // Close augment popup on outside click
  document.addEventListener('mousedown', e => {
    const augPopup = document.getElementById('augment-value-popup');
    if (!augPopup.hidden && !augPopup.contains(e.target)) {
      closeAugmentValuePopup();
    }
  });

  // Hotbar selection: keys 1-8
  document.addEventListener('keydown', e => {
    // Skip if an input/textarea is focused
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    const num = parseInt(e.key, 10);
    if (num >= 1 && num <= 8) {
      selectHotbarSlot(num - 1);
    }
  });

  // Ctrl-hold pins the right-panel tooltip so it can be moused-over and scrolled.
  // Pressed: skip pending clears, keep tooltip alive across mouseleave events.
  // Released: if the cursor isn't on the tooltip or a tooltip source, dismiss.
  document.addEventListener('keydown', e => {
    if (e.key === 'Control' && !tooltipPinned) {
      tooltipPinned = true;
      if (tooltipClearTimer) { clearTimeout(tooltipClearTimer); tooltipClearTimer = null; }
    }
  });
  document.addEventListener('keyup', e => {
    if (e.key === 'Control') {
      tooltipPinned = false;
      // If the mouse isn't currently sitting on something that would keep the
      // tooltip alive on its own, schedule the normal deferred clear.
      const overSource = document.querySelector(
        '.armor-slot:hover, .hotbar-slot:hover, .augment-dot:hover, #tooltip-panel:hover'
      );
      if (!overSource) clearTooltip();
    }
  });

  // Ctrl+wheel is browser zoom by default — intercept it on the tooltip panel
  // so a pinned tooltip can be scrolled with the wheel instead.
  const tooltipPanelEl = document.getElementById('tooltip-panel');
  if (tooltipPanelEl) {
    tooltipPanelEl.addEventListener('wheel', e => {
      if (!tooltipPinned) return;
      e.preventDefault();
      tooltipPanelEl.scrollTop += e.deltaY;
    }, { passive: false });
  }

  // Initial render of character panel with base stats
  refreshPanels();
})();

// =============================================
// ABOUT
// =============================================

function openAbout() {
  const overlay = document.getElementById('about-overlay');
  requestAnimationFrame(() => requestAnimationFrame(() => overlay.classList.add('visible')));
  // Refresh the version display each time so it always matches the running app.
  window.electronAPI.getVersion()
    .then(v => { document.getElementById('about-version').textContent = `v${v}`; })
    .catch(e => console.warn('[about] version fetch failed:', e));
}

function closeAbout() {
  document.getElementById('about-overlay').classList.remove('visible');
}

document.getElementById('app-logo').addEventListener('click', openAbout);
document.getElementById('about-close').addEventListener('click', closeAbout);
document.getElementById('about-overlay').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeAbout();
});


// =============================================
// SETTINGS
// =============================================

function openSettings() {
  const overlay = document.getElementById('settings-overlay');
  requestAnimationFrame(() => requestAnimationFrame(() => overlay.classList.add('visible')));
}

function closeSettings() {
  document.getElementById('settings-overlay').classList.remove('visible');
}

document.getElementById('settings-btn').addEventListener('click', openSettings);
document.getElementById('settings-close').addEventListener('click', closeSettings);
document.getElementById('settings-overlay').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeSettings();
});

document.getElementById('open-specializations-btn').addEventListener('click', openSpecializations);
document.getElementById('spec-close').addEventListener('click', closeSpecializations);
document.getElementById('specializations-overlay').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeSpecializations();
});

// Help / Tips modal — open via the ? button next to the logo.
const openHelp  = () => {
  document.getElementById('help-overlay').classList.add('visible');
  // Reset scroll to the top so opening always starts at the first section.
  const body = document.querySelector('.help-body');
  if (body) body.scrollTop = 0;
};
const closeHelp = () => document.getElementById('help-overlay').classList.remove('visible');
document.getElementById('open-help-btn').addEventListener('click', openHelp);
document.getElementById('help-close').addEventListener('click', closeHelp);
document.getElementById('help-overlay').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeHelp();
});

document.getElementById('setting-show-commons').checked = appSettings.showCommons;
document.getElementById('setting-show-commons').addEventListener('change', e => {
  appSettings.showCommons = e.target.checked;
  saveSettings();
});

for (const tier of [0, 1, 2, 3, 4, 5]) {
  const key = `showT${tier}`;
  const el = document.getElementById(`setting-show-t${tier}`);
  el.checked = appSettings[key];
  el.addEventListener('change', e => {
    appSettings[key] = e.target.checked;
    saveSettings();
  });
}

// Weapon settings
document.getElementById('setting-show-weapon-commons').checked = appSettings.showWeaponCommons;
document.getElementById('setting-show-weapon-commons').addEventListener('change', e => {
  appSettings.showWeaponCommons = e.target.checked;
  saveSettings();
});

for (const tier of [1, 2, 3, 4, 5]) {
  const key = `showWeaponT${tier}`;
  const el = document.getElementById(`setting-show-weapon-t${tier}`);
  el.checked = appSettings[key];
  el.addEventListener('change', e => {
    appSettings[key] = e.target.checked;
    saveSettings();
  });
}

document.getElementById('setting-show-formulas').checked = appSettings.showFormulas;
document.getElementById('setting-show-formulas').addEventListener('change', e => {
  appSettings.showFormulas = e.target.checked;
  saveSettings();
  // If a formula tooltip is currently visible, hide it immediately on opt-out.
  if (!appSettings.showFormulas) hideStatFormulaTooltip();
});

document.getElementById('setting-persist-weapon-filter').checked = appSettings.persistWeaponTypeFilter;
document.getElementById('setting-persist-weapon-filter').addEventListener('change', e => {
  appSettings.persistWeaponTypeFilter = e.target.checked;
  saveSettings();
});

document.getElementById('setting-apply-staggered').checked = appSettings.applyStaggered;
document.getElementById('setting-apply-staggered').addEventListener('change', e => {
  appSettings.applyStaggered = e.target.checked;
  saveSettings();
  // Folds the Sabotage Damage-to-Staggered passive into weapon damage totals.
  refreshPanels();
});

document.getElementById('setting-apply-headshot').checked = appSettings.applyHeadshot;
document.getElementById('setting-apply-headshot').addEventListener('change', e => {
  appSettings.applyHeadshot = e.target.checked;
  saveSettings();
  // Adds the ×1.5 base headshot multiplier (plus Sabotage Head Hunter bonus)
  // to weapons that can headshot.
  refreshPanels();
});

// Hydration is set via the interactive hydration bar in the character panel
// (see buildHydrationBar) — no Settings control.

// =============================================
// EXPORT
// =============================================

const EXPORT_SLOT_ORDER = ['helm', 'chest', 'pants', 'gloves', 'boots', 'holtzman', 'belt', 'pack'];
const EXPORT_HOTBAR_ORDER = ['hotbar0','hotbar1','hotbar2','hotbar3','hotbar4','hotbar5','hotbar6','hotbar7'];

function exportBuild() {
  const slots = {};
  for (const slot of EXPORT_SLOT_ORDER) {
    const item = equippedItems[slot];
    if (!item) continue;
    const entry = { item: item.slug };
    // Grade (only non-zero)
    if (equippedGrades[slot] > 0) entry.grade = equippedGrades[slot];
    // Augments (always 3-element array for armor, omit for non-augmentable)
    if (ARMOR_SLOTS.has(slot)) {
      const augs = equippedAugments[slot] || [null, null, null];
      entry.augments = augs.map(a => {
        if (!a) return null;
        const aug = { slug: a.slug, grade: a.grade };
        if (a.customValues != null) aug.customValues = a.customValues;
        return aug;
      });
    }
    slots[slot] = entry;
  }

  // Hotbar (weapons)
  const hotbar = {};
  for (const slot of EXPORT_HOTBAR_ORDER) {
    const item = equippedItems[slot];
    if (!item) continue;
    const entry = { item: item.slug };
    if (equippedGrades[slot] > 0) entry.grade = equippedGrades[slot];
    const augs = equippedAugments[slot] || [null, null, null];
    entry.augments = augs.map(a => {
      if (!a) return null;
      const aug = { slug: a.slug, grade: a.grade };
      if (a.customValues != null) aug.customValues = a.customValues;
      return aug;
    });
    hotbar[slot] = entry;
  }

  // Stamp the format version (load-bearing, drives load-side migration).
  const exportData = { formatVersion: BUILD_FORMAT_VERSION };
  exportData.slots = slots;
  if (Object.keys(hotbar).length > 0) exportData.hotbar = hotbar;

  // Specializations — per-track level + claimed keystones. Skip tracks with
  // no progress to keep exports compact.
  const specs = {};
  for (const [id, state] of Object.entries(specState)) {
    const keystones = [...state.keystones];
    if (state.level > 0 || keystones.length > 0) {
      specs[id] = { level: state.level, keystones };
    }
  }
  if (Object.keys(specs).length > 0) exportData.specializations = specs;

  // Skill tree — per-spec map of tag → rank, plus the _equipped block holding
  // the 3 ability + 3 technique loadout slots. Only included if there's any
  // allocation OR any equip set, so a clean build doesn't emit a noisy block.
  if (typeof SKILL_TREE_STATE !== 'undefined' && SKILL_TREE_STATE.allocations) {
    const skills = {};
    for (const [spec, alloc] of Object.entries(SKILL_TREE_STATE.allocations)) {
      const filtered = {};
      for (const [tag, rank] of Object.entries(alloc)) {
        if (rank > 0) filtered[tag] = rank;
      }
      if (Object.keys(filtered).length > 0) skills[spec] = filtered;
    }
    const eq = SKILL_TREE_STATE.equipped || {};
    const hasEquip = (eq.abilities || []).some(Boolean) || (eq.techniques || []).some(Boolean);
    if (hasEquip) {
      skills._equipped = {
        abilities: (eq.abilities || [null,null,null]).slice(0, 3),
        techniques: (eq.techniques || [null,null,null]).slice(0, 3),
      };
    }
    // Combat-context toggles (suspended/lunging/exploited/hydrated) are NOT
    // persisted — they're transient view state, not part of the build. A loaded
    // build opens in the default scenario view.
    if (Object.keys(skills).length > 0) exportData.skills = skills;
  }

  // Health/Stamina/Power are NOT persisted: they're fully computed from
  // base (150/100/0) + skills + gear + spec (leveling grants no resources —
  // confirmed 2026-06-02). Saving them would be redundant derived data.

  return exportData;
}

function exportToClipboard() {
  const data = exportBuild();
  const json = JSON.stringify(data, null, 2);
  const output = [
    '======================================================================',
    'DUNEBUILDER EXPORT',
    '======================================================================',
    json,
  ].join('\n');
  return window.electronAPI.writeClipboard(output);
}

// =============================================
// APPLY BUILD DATA
// =============================================

// Bring an older build payload up to the current format before applying it. Keyed off
// `formatVersion` (absent = 0 = pre-versioning legacy save). Each migration is a pure
// `data => data` step registered in ascending order; we run every step whose target version
// is newer than the save's. No-op today (current format == 1, and v0 → v1 needs no field
// changes since the schema is identical — versioning just started getting stamped). When the
// schema next changes, bump BUILD_FORMAT_VERSION and add a step here.
const BUILD_MIGRATIONS = [
  // { to: 2, migrate: (d) => { /* e.g. rename a slug, reshape a field */ return d; } },
];

function migrateBuildData(data) {
  if (!data || typeof data !== 'object') return data;
  let from = Number.isInteger(data.formatVersion) ? data.formatVersion : 0;
  if (from >= BUILD_FORMAT_VERSION) return data; // current or newer (newer = forward-compat, apply as-is)
  for (const step of BUILD_MIGRATIONS) {
    if (step.to > from) {
      try {
        data = step.migrate(data) || data;
        from = step.to;
      } catch (e) {
        console.warn(`[migrate] step →v${step.to} failed:`, e);
        break; // stop the chain; apply what we have rather than corrupt further
      }
    }
  }
  data.formatVersion = BUILD_FORMAT_VERSION;
  return data;
}

function applyBuildData(rawData) {
  const data = migrateBuildData(rawData);
  // Clear all existing state
  for (const key of Object.keys(equippedItems)) delete equippedItems[key];
  for (const key of Object.keys(equippedGrades)) delete equippedGrades[key];
  for (const key of Object.keys(equippedAugments)) delete equippedAugments[key];
  for (const key of Object.keys(augmentSlotUnlocks)) delete augmentSlotUnlocks[key];
  activeHotbarIndex = null;

  // Reset all armor slot visuals
  document.querySelector('.armor-layout').classList.remove('radsuit-active');
  document.querySelectorAll('.armor-slot').forEach(el => {
    const st = getSlotType(el);
    if (st) {
      el.classList.remove('has-item');
      el.title = '';
      el.innerHTML = `<span class="slot-label">${SLOT_ORIGINAL_LABELS[getSlotClass(el)] || ''}</span>`;
    }
  });

  // Reset all hotbar slot visuals
  document.querySelectorAll('.hotbar-slot').forEach(el => {
    const idx = parseInt(el.dataset.hotbar, 10);
    el.classList.remove('has-item', 'hotbar-slot--active');
    el.title = '';
    el.innerHTML = '';
    const numEl = document.createElement('span');
    numEl.className = 'slot-number';
    numEl.textContent = String(idx + 1);
    el.appendChild(numEl);
  });

  // Armor slots — first pass: set state
  const slots = data.slots || {};
  for (const [slot, slotData] of Object.entries(slots)) {
    const item = GARMENT_BY_SLUG.get(slotData.item);
    if (!item) continue;
    equippedItems[slot] = item;
    if (GARMENT_SLOTS.has(slot)) equippedGrades[slot] = slotData.grade || 0;
    if (slotData.augments) {
      equippedAugments[slot] = slotData.augments.map(a => a ? { slug: a.slug, grade: Math.max(a.grade || 0, 1), ...(a.customValues != null ? { customValues: a.customValues } : {}) } : null);
      const lastNonNull = slotData.augments.reduce((max, a, i) => a ? i : max, -1);
      augmentSlotUnlocks[slot] = Math.max(lastNonNull + 1, 1);
    }
  }

  // Armor slots — second pass: build visuals
  for (const [slot, slotData] of Object.entries(slots)) {
    const item = equippedItems[slot];
    if (!item) continue;
    if (item.slot === 'radsuit') {
      ARMOR_SLOTS.forEach(s => { equippedItems[s] = item; });
      document.querySelector('.armor-layout').classList.add('radsuit-active');
      document.querySelectorAll('.armor-slot').forEach(el => {
        if (getSlotType(el) === 'helm') updateSlotDisplay(el, item);
      });
    } else {
      document.querySelectorAll('.armor-slot').forEach(el => {
        if (getSlotType(el) === slot) updateSlotDisplay(el, item);
      });
    }
  }

  // Hotbar (weapons)
  if (data.hotbar) {
    for (const [slot, slotData] of Object.entries(data.hotbar)) {
      const item = WEAPON_BY_SLUG.get(slotData.item);
      if (!item) continue;
      equippedItems[slot] = item;
      equippedGrades[slot] = slotData.grade || 0;
      if (slotData.augments) {
        equippedAugments[slot] = slotData.augments.map(a => a ? { slug: a.slug, grade: Math.max(a.grade || 0, 1), ...(a.customValues != null ? { customValues: a.customValues } : {}) } : null);
        const lastNonNull = slotData.augments.reduce((max, a, i) => a ? i : max, -1);
        augmentSlotUnlocks[slot] = Math.max(lastNonNull + 1, 1);
      }
      const idx = slot.replace('hotbar', '');
      const slotEl = document.querySelector(`.hotbar-slot[data-hotbar="${idx}"]`);
      if (slotEl) updateHotbarSlotDisplay(slotEl, item, slot);
    }
    autoSelectFirstHotbarWeapon();
  }

  // NOTE: legacy `characterPanel` (saved Health/Stamina/Power) is intentionally
  // ignored — those pools are computed from base + skills + gear + spec, so an
  // old build that still carries the block just has it dropped. No error.

  // Reset all specializations to baseline, then layer in any saved state.
  for (const id of Object.keys(specState)) {
    specState[id] = { level: 0, keystones: new Set() };
  }
  if (data.specializations) {
    for (const [id, s] of Object.entries(data.specializations)) {
      if (!specState[id]) continue; // unknown track id — ignore
      const track = SPECIALIZATIONS_DATA.find(t => t.id === id);
      const maxLevel = track?.maxLevel ?? 100;
      const level = Math.max(0, Math.min(maxLevel, parseInt(s.level, 10) || 0));
      const validKsIds = new Set((track?.keystones || []).map(k => k.id));
      const keystones = new Set(
        (Array.isArray(s.keystones) ? s.keystones : [])
          .filter(id => validKsIds.has(id))
      );
      specState[id] = { level, keystones };
    }
  }
  // If the spec modal is currently open, rebuild it so it reflects the load.
  const specOverlay = document.getElementById('specializations-overlay');
  if (specOverlay?.classList.contains('visible')) renderSpecOverlay();

  // Skill tree allocations + equipped loadout. The `_equipped` key is a special
  // sub-block alongside the spec-name keys — it holds the 3 ability + 3
  // technique loadout slots. Spec-name keys never start with underscore so we
  // discriminate by that.
  if (typeof SKILL_TREE_STATE !== 'undefined') {
    SKILL_TREE_STATE.allocations = {};
    SKILL_TREE_STATE.equipped = { abilities: [null,null,null], techniques: [null,null,null] };
    SKILL_TREE_STATE.context = { suspended: false, lunging: false, exploited: false, hydrationPct: 100 };
    if (data.skills && typeof data.skills === 'object') {
      for (const [key, val] of Object.entries(data.skills)) {
        if (key === '_equipped') {
          if (val && typeof val === 'object') {
            const padOrTrunc = (a) => (Array.isArray(a) ? a.slice(0,3) : []).concat([null,null,null]).slice(0,3);
            SKILL_TREE_STATE.equipped.abilities  = padOrTrunc(val.abilities);
            SKILL_TREE_STATE.equipped.techniques = padOrTrunc(val.techniques);
          }
          continue;
        }
        // Legacy `_context` (combat-scenario toggles) is intentionally not read —
        // context resets to defaults (hydrated ON) above. The `_`-prefix skip
        // below silently ignores it (and any other underscore meta key).
        if (key.startsWith('_') || !val || typeof val !== 'object') continue;
        SKILL_TREE_STATE.allocations[key] = {};
        for (const [tag, rank] of Object.entries(val)) {
          const r = parseInt(rank, 10);
          if (r > 0) SKILL_TREE_STATE.allocations[key][tag] = r;
        }
      }
    }
    if (SKILL_TREE_STATE.loaded) {
      recomputeSpentSP();
      pruneEquipped(); // drop any loaded equips that don't match the loaded allocations
      // Always refresh the bottom-strip mini-slot icons (they live in the
      // tree view and don't get rebuilt by showSpec — without this, stale
      // equipped icons from the previous build persist across a load.)
      renderMiniSlotIcons();
      const stOverlay = document.getElementById('skill-tree-overlay');
      if (stOverlay?.classList.contains('visible') && SKILL_TREE_STATE.currentSpec) {
        showSpec(SKILL_TREE_STATE.currentSpec);
        // If the user was on the equip subpage, rebuild it from the new state
        // so the slots/grids don't show stale icons.
        if (getCurrentSkillView() === 'equip') renderEquipPage();
      }
    }
    persistSkillTreeState();
  }

  refreshPanels();
  triggerRevealAnimation();
}

// =============================================
// SAVE / LOAD
// =============================================

let currentBuildPath = null;

function getBuildJson() {
  return JSON.stringify(exportBuild(), null, 2);
}

function showSavingOverlay() {
  document.getElementById('saving-overlay').classList.add('visible');
}

function hideSavingOverlay() {
  document.getElementById('saving-overlay').classList.remove('visible');
}

async function saveBuild() {
  const data = getBuildJson();
  if (!currentBuildPath) {
    return saveBuildAs();
  }
  showSavingOverlay();
  const minDelay = new Promise(r => setTimeout(r, 500));
  const ok = await window.electronAPI.saveBuildFile(currentBuildPath, data);
  await minDelay;
  hideSavingOverlay();
  if (ok) {
    showSaveConfirmation('Saved');
  } else {
    showError('Save failed.');
  }
}

async function saveBuildAs() {
  const defaultName = currentBuildPath
    ? currentBuildPath.split(/[/\\]/).pop()
    : 'build.dbf';
  const filepath = await window.electronAPI.saveDialog(defaultName);
  if (!filepath) return;
  showSavingOverlay();
  const minDelay = new Promise(r => setTimeout(r, 500));
  const data = getBuildJson();
  const ok = await window.electronAPI.saveBuildFile(filepath, data);
  await minDelay;
  hideSavingOverlay();
  if (ok) {
    currentBuildPath = filepath;
    showSaveConfirmation('Saved');
  } else {
    showError('Save failed.');
  }
}

function showSaveConfirmation(text) {
  const btn = document.getElementById('save-btn');
  btn.textContent = text;
  setTimeout(() => { btn.textContent = 'Save'; }, 1500);
}

async function openLoadModal() {
  const builds = await window.electronAPI.listBuilds();
  const list = document.getElementById('load-list');
  list.innerHTML = '';

  // New build option at the top
  const newItem = document.createElement('div');
  newItem.className = 'load-item load-item--new';
  const newName = document.createElement('span');
  newName.className = 'load-item__name';
  newName.textContent = '+ New Build';
  newItem.appendChild(newName);
  newItem.addEventListener('click', () => {
    applyBuildData({ slots: {}, hotbar: null });
    currentBuildPath = null;
    refreshPanels();
    closeLoadModal();
  });
  list.appendChild(newItem);

  if (builds.length === 0) {
    // Just the new build option, nothing else needed
  } else {
    builds.forEach(b => {
      const item = document.createElement('div');
      item.className = 'load-item';

      const name = document.createElement('span');
      name.className = 'load-item__name';
      name.textContent = b.name;

      const date = document.createElement('span');
      date.className = 'load-item__date';
      date.textContent = new Date(b.modified).toLocaleDateString();

      const del = document.createElement('button');
      del.className = 'load-item__delete';
      del.textContent = '✕';
      del.title = 'Delete build';
      del.addEventListener('click', async e => {
        e.stopPropagation();
        if (!confirm(`Delete "${b.name}"?`)) return;
        const ok = await window.electronAPI.deleteBuildFile(b.path);
        if (ok) {
          if (currentBuildPath === b.path) currentBuildPath = null;
          openLoadModal(); // refresh list
        }
      });

      item.appendChild(name);
      item.appendChild(date);
      item.appendChild(del);
      item.addEventListener('click', () => loadBuildFromFile(b.path));
      list.appendChild(item);
    });
  }

  const overlay = document.getElementById('load-overlay');
  requestAnimationFrame(() => requestAnimationFrame(() => overlay.classList.add('visible')));
}

function closeLoadModal() {
  document.getElementById('load-overlay').classList.remove('visible');
}

async function loadBuildFromFile(filepath) {
  const text = await window.electronAPI.loadBuildFile(filepath);
  if (!text) {
    showError('Failed to read build file.');
    closeLoadModal();
    return;
  }

  try {
    const data = JSON.parse(text);
    applyBuildData(data);
    currentBuildPath = filepath;
    closeLoadModal();
  } catch {
    showError('Invalid build file.');
    closeLoadModal();
  }
}

async function loadBuildBrowse() {
  const filepath = await window.electronAPI.loadDialog();
  if (!filepath) return;
  closeLoadModal();
  await loadBuildFromFile(filepath);
}

// =============================================
// PASTE HANDLER
// =============================================

document.getElementById('calc-def-btn').addEventListener('click', () => {
  calcMode = 'def';
  document.getElementById('calc-def-btn').classList.add('active');
  document.getElementById('calc-off-btn').classList.remove('active');
  renderCalculations();
});

document.getElementById('calc-off-btn').addEventListener('click', () => {
  calcMode = 'off';
  document.getElementById('calc-off-btn').classList.add('active');
  document.getElementById('calc-def-btn').classList.remove('active');
  renderCalculations();
});

const exportBtn = document.getElementById('export-btn');

exportBtn.addEventListener('click', async () => {
  const hasGear = Object.keys(equippedItems).some(k => equippedItems[k] != null);
  if (!hasGear) {
    showError('Nothing to export — equip gear first.');
    return;
  }
  exportBtn.disabled = true;
  exportBtn.textContent = 'Exporting…';
  try {
    await exportToClipboard();
    exportBtn.textContent = 'Copied!';
    setTimeout(() => { exportBtn.textContent = 'Export'; }, 1500);
  } catch (err) {
    showError('Export failed: ' + err.message);
    exportBtn.textContent = 'Export';
  } finally {
    exportBtn.disabled = false;
  }
});

// Save / Load buttons
document.getElementById('save-btn').addEventListener('click', saveBuild);
document.getElementById('save-dropdown').addEventListener('click', saveBuildAs);
document.getElementById('load-btn').addEventListener('click', openLoadModal);
document.getElementById('load-close').addEventListener('click', closeLoadModal);
document.getElementById('load-overlay').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeLoadModal();
});
document.getElementById('load-browse').addEventListener('click', loadBuildBrowse);

const pasteBtn = document.getElementById('paste-btn');

pasteBtn.addEventListener('click', async () => {
  pasteBtn.disabled = true;
  pasteBtn.textContent = 'Reading…';

  try {
    const text = await window.electronAPI.readClipboard();
    const result = parseClipboardText(text);

    if (!result) {
      showError('No valid build data found in clipboard.');
    } else {
      applyBuildData(result);
      refreshPanels();
      triggerRevealAnimation();
    }
  } catch (err) {
    showError('Clipboard read failed: ' + err.message);
  } finally {
    pasteBtn.disabled = false;
    pasteBtn.textContent = 'Paste Build';
  }
});

// =============================================
// UPDATE NOTIFICATIONS  (driven by electron-updater events from main)
// =============================================

(() => {
  const banner       = document.getElementById('update-banner');
  if (!banner) return;
  const textEl       = document.getElementById('update-text');
  const notesBtn     = document.getElementById('update-notes-toggle');
  const notesPanel   = document.getElementById('update-notes');
  const downloadBtn  = document.getElementById('update-download');
  const dismissBtn   = document.getElementById('update-dismiss');
  const progressEl   = document.getElementById('update-progress');
  const progressFill = document.getElementById('update-progress-fill');

  let dismissed = false;
  const show = () => { if (!dismissed) banner.hidden = false; };

  // Render a safe markdown subset (headings, bold, code, bullets, paragraphs).
  // Input is HTML-escaped first, then only our own tags are added — no raw
  // HTML from the release body passes through.
  function renderNotesHtml(raw) {
    const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const inline = s => esc(s)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`(.+?)`/g, '<code>$1</code>');
    let html = '', listOpen = false;
    const closeList = () => { if (listOpen) { html += '</ul>'; listOpen = false; } };
    for (const line of String(raw).split(/\r?\n/)) {
      const t = line.trim();
      if (!t) { closeList(); continue; }
      let m;
      if ((m = t.match(/^#{1,6}\s+(.+)$/))) {
        closeList();
        html += `<h4 class="update-notes__heading">${inline(m[1])}</h4>`;
      } else if ((m = t.match(/^[-*]\s+(.+)$/))) {
        if (!listOpen) { html += '<ul class="update-notes__list">'; listOpen = true; }
        html += `<li>${inline(m[1])}</li>`;
      } else {
        closeList();
        html += `<p class="update-notes__para">${inline(t)}</p>`;
      }
    }
    closeList();
    return html;
  }

  function setNotes(notes) {
    if (notes) {
      notesPanel.innerHTML = renderNotesHtml(notes);
      notesBtn.hidden = false;
      notesBtn.onclick = () => {
        const showing = !notesPanel.hidden;
        notesPanel.hidden = showing;
        notesBtn.textContent = showing ? "What's New" : 'Hide Notes';
      };
    } else {
      notesBtn.hidden = true;
    }
  }

  dismissBtn.addEventListener('click', () => { dismissed = true; banner.hidden = true; });

  window.electronAPI.onUpdateAvailable(({ version, notes }) => {
    textEl.textContent = `v${version} available`;
    setNotes(notes);
    progressFill.style.width = '0%';
    progressEl.hidden = true;
    downloadBtn.hidden = false;
    downloadBtn.disabled = false;
    downloadBtn.textContent = 'Download';
    downloadBtn.onclick = () => {
      textEl.textContent = `v${version} available`;   // reset if we're retrying after an error
      downloadBtn.disabled = true;
      downloadBtn.textContent = 'Downloading…';
      progressFill.style.width = '0%';
      progressEl.hidden = false;
      window.electronAPI.downloadUpdate();
    };
    show();
  });

  window.electronAPI.onDownloadProgress(pct => {
    const p = Math.max(0, Math.min(100, Number(pct) || 0));
    progressEl.hidden = false;
    progressFill.style.width = `${p}%`;
    downloadBtn.textContent = `Downloading… ${Math.round(p)}%`;
  });

  window.electronAPI.onUpdateDownloaded(({ version }) => {
    textEl.textContent = `v${version} ready`;
    progressEl.hidden = true;
    downloadBtn.hidden = false;
    downloadBtn.disabled = false;
    downloadBtn.textContent = 'Restart to update';
    downloadBtn.onclick = () => window.electronAPI.installUpdate();
    show();
  });

  window.electronAPI.onUpdateError(msg => {
    // A failed background *check* (no internet, GitHub down) stays silent. But if a banner is up
    // and a download was attempted, surface it so the user isn't left at a silent dead end.
    console.warn('[update]', msg);
    if (!banner.hidden && !downloadBtn.hidden && downloadBtn.textContent !== 'Restart to update') {
      textEl.textContent = "Update download failed — retry, or grab it from the Releases page";
      progressEl.hidden = true;
      progressFill.style.width = '0%';
      downloadBtn.disabled = false;
      downloadBtn.textContent = 'Retry';   // onclick is still the download handler
    }
  });
})();

// Dev hook — exposes key state and functions for the golden-test harness.
// Safe to leave in production builds: harmless read-only surface.
window.__golden = {
  applyBuildData,
  exportBuild,
  refreshPanels,
  showTooltip,
  SKILL_TREE_STATE,
  appSettings,
  equippedItems,
  equippedGrades,
  equippedAugments,
  augmentSlotUnlocks,
  specState,
  // All four data maps are reassigned after async load, so expose getters
  // so the harness always sees the current Map reference.
  get WEAPON_BY_SLUG()         { return WEAPON_BY_SLUG; },
  get GARMENT_BY_SLUG()        { return GARMENT_BY_SLUG; },
  get AUGMENT_BY_SLUG()        { return AUGMENT_BY_SLUG; },
  get WEAPON_AUGMENT_BY_SLUG() { return WEAPON_AUGMENT_BY_SLUG; },
};

// =============================================
// SKILL TREE PANEL
// Port of scratch/skill-tree-mock/index.html (v6.17) into DuneBuilder.
// Key differences from the mock:
//   - Allocation requires all prerequisites at rank >= 1 (was unenforced).
//   - Lines highlight "available path" (prereqs met) in purple regardless of
//     allocation; allocated-both endpoints get the brighter glow variant.
//   - Allocations are kept in SKILL_TREE_STATE and exported with the build.
//   - Persists to localStorage as a fallback for raw page reloads.
// =============================================

// SKILL_TREE_STATE is declared near the top-level state cluster (just after
// equippedItems/equippedGrades) so it is initialised before the early init
// path — refreshPanels() → renderResourceBars() → getSkillBonuses() — and the
// hydrated-toggle setup both touch it during module evaluation. Declaring it
// here (after those run) put it in its temporal dead zone and threw on boot.

const ST_STORAGE_KEY = 'dunebuilder-skill-tree-v1';
const ST_SPEC_ORDER = ['Trooper', 'Mentat', 'Planetologist', 'Bene Gesserit', 'Swordmaster'];
const ST_TYPE_DISPLAY = {
  attribute: 'ATTRIBUTE',
  perk: 'TECHNIQUE',
  ability: 'ABILITY',
  spice: 'SPICE ABILITY',
};

async function loadSkillTreeData() {
  if (SKILL_TREE_STATE.loaded) return;
  try {
    const [nodesRes, descRes, costsRes, labelsRes, gtRes, statsRes] = await Promise.all([
      fetch('./data/skill-tree/nodes.json'),
      fetch('./data/skill-tree/descriptions.json'),
      fetch('./data/skill-tree/costs.json'),
      fetch('./data/skill-tree/sub-tree-labels.json'),
      fetch('./data/skill-tree/gt-skill-tree.json'),
      fetch('./data/skill-tree/stats-per-rank.json'),
    ]);
    const data = await nodesRes.json();
    const descriptions = await descRes.json();
    const costs = await costsRes.json();
    const subTreeLabels = await labelsRes.json();
    const gt = await gtRes.json();
    const statsPerRank = await statsRes.json();

    // Filter specs to canonical order
    data.specs = ST_SPEC_ORDER.filter(s => s in data.skills_by_spec);

    // Merge descriptions + costs + multi-stat per-rank into nodes; build tag→node index.
    // statsPerRank.json supersedes the partial single-stat data baked into nodes.json
    // (which came from skill_data.py). Tags listed in stats._unresolved keep whatever
    // nodes.json had as a fallback so the tooltip still shows something.
    //
    // Prereqs: gt-skill-tree.json carries the FULL bidirectional adjacency graph
    // (each node lists every connected neighbor as a prereq). nodes.json only had
    // the "upstream" links, which made the OR-availability check too restrictive —
    // a node was unreachable from siblings on either side. Take the UNION so any
    // adjacent allocated neighbor unlocks the node, matching in-game behaviour.
    const gtPrereqByTag = {};
    for (const s of (gt.skills || [])) {
      if (s.tag) gtPrereqByTag[s.tag] = s.prerequisites || [];
    }

    SKILL_TREE_STATE.nodesByTag = {};
    for (const spec of Object.keys(data.skills_by_spec)) {
      for (const n of data.skills_by_spec[spec]) {
        const d = descriptions[n.tag];
        if (d && typeof d === 'object') {
          n.description = d.description || '';
          n.subDescription = d.subDescription || '';
        }
        const c = costs[n.tag];
        n.skillPointCostPerRank = Array.isArray(c) ? c : [];
        const sr = statsPerRank[n.tag];
        if (Array.isArray(sr) && sr.length > 0) {
          n.statsPerRank = sr;
        }
        // Union prereqs from gt — gives the full adjacency graph for OR-pathing.
        const gtPrereqs = gtPrereqByTag[n.tag] || [];
        if (gtPrereqs.length) {
          const combined = new Set([...(n.prerequisites || []), ...gtPrereqs]);
          n.prerequisites = [...combined];
        }
        n.spec = spec;
        SKILL_TREE_STATE.nodesByTag[n.tag] = n;
      }
    }

    // Spec nav icons (from gt skillTrees)
    const specNavIcons = {};
    for (const t of (gt.skillTrees || [])) {
      const name = t.name;
      const local = t.iconPath_local;
      if (name && local) specNavIcons[name] = local;
      if (name === 'BeneGesserit' && local) specNavIcons['Bene Gesserit'] = local;
    }
    data.specNavIcons = specNavIcons;
    data.subTreeLabels = subTreeLabels;
    data.maxSPLevel200 = costs._maxSPLevel200 || 199;

    SKILL_TREE_STATE.data = data;
    SKILL_TREE_STATE.descriptions = descriptions;
    SKILL_TREE_STATE.costs = costs;
    SKILL_TREE_STATE.subTreeLabels = subTreeLabels;
    SKILL_TREE_STATE.gt = gt;
    SKILL_TREE_STATE.spBase = data.maxSPLevel200;
    SKILL_TREE_STATE.spTotal = data.maxSPLevel200; // may grow once spec bonus is computed
    SKILL_TREE_STATE.loaded = true;

    // Blank slate on boot: skill-tree state is NOT persisted across launches. It
    // lives in the build file (saved/loaded via the .dbf) exactly like slots,
    // hotbar, and specializations — a fresh launch starts empty; the user loads or
    // imports a build to populate. Purge any legacy persisted state so old sessions
    // don't leak in (this also fixed the stale-tree-on-boot bug + per-change
    // localStorage writes that were adding overhead).
    try { localStorage.removeItem(ST_STORAGE_KEY); } catch (e) { /* ignore */ }

    // Recompute spent SP across all specs + drop any equips that no longer
    // point at allocated nodes (could happen if data shape changes).
    recomputeSpentSP();
    pruneEquipped();
  } catch (e) {
    console.error('Failed to load skill tree data:', e);
  }
}

function persistSkillTreeState() {
  // No-op by design: skill-tree state is intentionally NOT persisted to localStorage.
  // Blank slate on boot — the build file is the only source of truth (see
  // loadSkillTreeData). Kept as a stub so the existing call sites stay valid;
  // removing them outright is fine to do opportunistically in a later refactor.
}

function recomputeSpentSP() {
  let total = 0;
  for (const spec of Object.keys(SKILL_TREE_STATE.allocations)) {
    const specAlloc = SKILL_TREE_STATE.allocations[spec] || {};
    for (const tag of Object.keys(specAlloc)) {
      const node = SKILL_TREE_STATE.nodesByTag[tag];
      const rank = specAlloc[tag] || 0;
      if (!node) continue;
      const costs = node.skillPointCostPerRank || [];
      for (let r = 1; r <= rank; r++) total += (costs[r - 1] || 1);
    }
  }
  SKILL_TREE_STATE.spSpent = total;
  refreshSPDisplay();
}

// Sum up bonus SP from currently-claimed Combat specialization keystones
// (effect name === "Skill Points"). Other specs don't grant SP today; if they
// ever do, the loop covers them automatically.
function recomputeBonusSP() {
  let bonus = 0;
  const breakdown = {};
  if (typeof specState === 'object' && Array.isArray(SPECIALIZATIONS_DATA)) {
    for (const track of SPECIALIZATIONS_DATA) {
      const state = specState[track.id];
      if (!state || !state.keystones || state.keystones.size === 0) continue;
      let trackBonus = 0;
      for (const ks of (track.keystones || [])) {
        if (!state.keystones.has(ks.id)) continue;
        for (const eff of (ks.effects || [])) {
          if ((eff.name || '').toLowerCase() === 'skill points') {
            const v = parseInt(eff.value, 10);
            if (Number.isFinite(v)) trackBonus += v;
          }
        }
      }
      if (trackBonus > 0) breakdown[track.name || track.id] = trackBonus;
      bonus += trackBonus;
    }
  }
  SKILL_TREE_STATE.spBonus = bonus;
  SKILL_TREE_STATE.spTotal = SKILL_TREE_STATE.spBase + bonus;
  SKILL_TREE_STATE.spBonusBreakdown = Object.entries(breakdown)
    .map(([n, v]) => `+${v} from ${n}`).join(', ');
  return bonus;
}

function refreshSPDisplay() {
  recomputeBonusSP();
  const { spSpent, spTotal, spBase, spBonus, spBonusBreakdown } = SKILL_TREE_STATE;
  const sv = document.getElementById('st-sp-val');
  const sm = document.getElementById('st-sp-max');
  if (sv) sv.textContent = spSpent;
  if (sm) sm.textContent = spTotal;
  // Tooltip on the diamond shows the breakdown when there's a bonus.
  const dia = document.getElementById('st-sp-diamond');
  if (dia) {
    dia.title = spBonus > 0
      ? `${spSpent} / ${spTotal} skill points (${spBase} base${spBonusBreakdown ? ', ' + spBonusBreakdown : ''})`
      : `${spSpent} / ${spTotal} skill points`;
  }
}

function flashSPInsufficient() {
  const d = document.getElementById('st-sp-diamond');
  if (!d) return;
  d.classList.add('st-sp-flash');
  setTimeout(() => d.classList.remove('st-sp-flash'), 350);
}

// =============================================
// Prerequisites & dependency logic
// =============================================
function specRankFor(tag) {
  const node = SKILL_TREE_STATE.nodesByTag[tag];
  if (!node) return 0;
  const specAlloc = SKILL_TREE_STATE.allocations[node.spec] || {};
  return specAlloc[tag] || 0;
}

// A node is "available" (prereqs met) if ANY ONE prerequisite tag has rank >= 1.
// Dune's tree uses OR-semantics for path connections — you only need one
// connecting allocated neighbor to branch into the next node.
// Nodes with no prerequisites are always available.
function isNodeAvailable(node) {
  if (!node || !Array.isArray(node.prerequisites) || node.prerequisites.length === 0) return true;
  return node.prerequisites.some(preTag => specRankFor(preTag) >= 1);
}

// A node can be deallocated unless it's the LAST satisfying prereq for some
// allocated dependent. Specifically: going from 1→0 is blocked only if some
// allocated downstream node has this in its prereq list AND no other prereq
// of that dependent is currently allocated.
function canDeallocate(node, newRank) {
  if (newRank >= 1) return true;
  if (!node) return false;
  const tag = node.tag;
  for (const spec of Object.keys(SKILL_TREE_STATE.allocations)) {
    const specAlloc = SKILL_TREE_STATE.allocations[spec] || {};
    for (const depTag of Object.keys(specAlloc)) {
      if (specAlloc[depTag] < 1) continue;
      const depNode = SKILL_TREE_STATE.nodesByTag[depTag];
      if (!depNode || !Array.isArray(depNode.prerequisites)) continue;
      if (!depNode.prerequisites.includes(tag)) continue;
      // Dependent has us as a prereq. Would dependent still be available without us?
      const otherSatisfied = depNode.prerequisites.some(p => p !== tag && specRankFor(p) >= 1);
      if (!otherSatisfied) return false;
    }
  }
  return true;
}

// =============================================
// Modal open/close
// =============================================
// Resize the Electron window AND wait for the renderer's resize event to fire
// (which is when document layout has actually caught up to the new viewport
// size). `await ipc()` alone only synchronises on main's setBounds() returning —
// the renderer-side resize event + layout pass happens on a later tick, so a
// render fired right after the IPC await sees the OLD viewport dimensions.
async function setWindowWidthScaleAndAwaitLayout(scale) {
  if (!window.electronAPI?.setWindowWidthScale) return;
  const beforeW = window.innerWidth;
  const resizePromise = new Promise((resolve) => {
    let resolved = false;
    const onResize = () => {
      if (resolved) return;
      if (window.innerWidth === beforeW) return; // ignore phantom resize events
      resolved = true;
      window.removeEventListener('resize', onResize);
      resolve();
    };
    window.addEventListener('resize', onResize);
    // Safety: if the scale was a no-op (e.g. already at target), no resize
    // event fires. Resolve after 200ms so we never hang openSkillTree.
    setTimeout(() => {
      if (resolved) return;
      resolved = true;
      window.removeEventListener('resize', onResize);
      resolve();
    }, 200);
  });
  await window.electronAPI.setWindowWidthScale(scale);
  await resizePromise;
}

async function openSkillTree() {
  await loadSkillTreeData();
  const overlay = document.getElementById('skill-tree-overlay');
  if (!overlay) return;
  // Compact mode already starts at 1180px wide (vs non-compact 1020px), so it
  // doesn't need the 1.35× expansion — the modal fits fine at the native width.
  const isCompact = document.documentElement.classList.contains('compact-layout');
  if (!isCompact) await setWindowWidthScaleAndAwaitLayout(1.35);
  overlay.classList.add('visible');
  buildSpecNav();
  const startSpec = SKILL_TREE_STATE.currentSpec || SKILL_TREE_STATE.data.specs[0];
  document.querySelectorAll('#st-spec-nav .st-spec-icon').forEach(x => {
    x.classList.toggle('active', x.dataset.spec === startSpec);
  });
  ensureTreeAreaResizeObserver();
  showSpec(startSpec);
  refreshSPDisplay();
  renderMiniSlotIcons();
}

// One-time install of a ResizeObserver on the tree-area. Re-renders the
// current spec whenever the area's content rect changes (window resize, modal
// open animation finishing, etc) so node positions always match the actual
// container size rather than the size at first render.
let st_resizeObserver = null;
function ensureTreeAreaResizeObserver() {
  if (st_resizeObserver) return;
  const area = document.getElementById('st-tree-area');
  if (!area || typeof ResizeObserver === 'undefined') return;
  let lastW = 0, lastH = 0;
  st_resizeObserver = new ResizeObserver((entries) => {
    for (const e of entries) {
      const w = Math.round(e.contentRect.width);
      const h = Math.round(e.contentRect.height);
      // Only re-render on a real size change to avoid feedback loops.
      if (w === lastW && h === lastH) continue;
      lastW = w; lastH = h;
      const spec = SKILL_TREE_STATE.currentSpec;
      const skills = spec && SKILL_TREE_STATE.data?.skills_by_spec?.[spec];
      const overlay = document.getElementById('skill-tree-overlay');
      if (!skills || !overlay?.classList.contains('visible')) continue;
      renderTree(skills, spec);
      restoreAllocationsForSpec(spec);
      refreshAllNodes();
    }
  });
  st_resizeObserver.observe(area);
}

function closeSkillTree() {
  const overlay = document.getElementById('skill-tree-overlay');
  if (overlay) overlay.classList.remove('visible');
  // Only restore width if we resized on open (we didn't in compact mode).
  const isCompact = document.documentElement.classList.contains('compact-layout');
  if (!isCompact && window.electronAPI?.setWindowWidthScale) {
    window.electronAPI.setWindowWidthScale(1.0);
  }
  hideSkillTooltip();
}

// =============================================
// Spec navigation
// =============================================
function buildSpecNav() {
  const nav = document.getElementById('st-spec-nav');
  if (!nav) return;
  // Remove any previously-injected spec icons
  [...nav.querySelectorAll('.st-spec-icon')].forEach(e => e.remove());
  const trail = document.getElementById('st-trailing-key');
  const DATA = SKILL_TREE_STATE.data;
  DATA.specs.forEach((spec, i) => {
    const el = document.createElement('div');
    el.className = 'st-spec-icon' + (i === 0 ? ' active' : '');
    el.title = spec; el.dataset.spec = spec;
    const inner = document.createElement('div'); inner.className = 'inner';
    const img = document.createElement('img');
    const iconPath = DATA.specNavIcons[spec];
    if (iconPath) img.src = './' + iconPath.replace(/^\.\//, '');
    img.alt = spec;
    inner.appendChild(img); el.appendChild(inner);
    el.addEventListener('click', () => {
      nav.querySelectorAll('.st-spec-icon').forEach(x => x.classList.remove('active'));
      el.classList.add('active');
      showSpec(spec);
    });
    nav.insertBefore(el, trail);
  });
}

function showSpec(spec) {
  SKILL_TREE_STATE.currentSpec = spec;
  const label = document.getElementById('st-spec-label');
  if (label) label.textContent = spec.toUpperCase();
  const skills = SKILL_TREE_STATE.data.skills_by_spec[spec];
  if (!skills) return;
  renderTree(skills, spec);
  restoreAllocationsForSpec(spec);
  refreshAllNodes();
}

function restoreAllocationsForSpec(spec) {
  const specAlloc = SKILL_TREE_STATE.allocations[spec] || {};
  document.querySelectorAll('.st-node').forEach(n => {
    const r = specAlloc[n.dataset.tag] || 0;
    n.dataset.rank = String(r);
    [...n.querySelectorAll('.st-pip')].forEach((p, i) => p.classList.toggle('filled', i < r));
    n.classList.toggle('allocated', r >= 1);
  });
}

// =============================================
// Tree rendering
// =============================================
const ST_TREE_W = 1300, ST_TREE_H = 580, ST_PAD = 70, ST_NODE = 60, ST_APEX = 70;

// Per-node visual overrides (replicates the mock's initial-tweak-state.json).
// These were hand-tuned for icon legibility — keep them in sync if the mock changes.
const ST_DEFAULTS_BY_TYPE = {
  attribute: { shape: 'circle',  size: 58, iconScale: 105 },
  perk:      { shape: 'octagon', size: 74, iconScale: 105 },
  ability:   { shape: 'diamond', size: 74, iconScale: 105 },
  spice:     { shape: 'diamond', size: 70, iconScale: 105 },
};
const ST_DEFAULTS_APEX = { shape: 'diamond', size: 70, iconScale: 60 };
const ST_NODE_OVERRIDES = {
  'Skills.Attribute.Weaponry1':{shape:'circle',size:58,iconScale:183},
  'Skills.Attribute.Weaponry2':{shape:'circle',size:58,iconScale:183},
  'Skills.Perk.BodyShots':{shape:'octagon',size:93,iconScale:105},
  'Skills.Perk.HeavyWeaponNaib':{shape:'octagon',size:93,iconScale:105},
  'Skills.Attribute.Weaponry3':{shape:'circle',size:58,iconScale:183},
  'Skills.Attribute.Weaponry4':{shape:'circle',size:58,iconScale:183},
  'Skills.Attribute.Weaponry5':{shape:'circle',size:58,iconScale:183},
  'Skills.Attribute.Weaponry6':{shape:'circle',size:58,iconScale:183},
  'Skills.Ability.EnergyCapsule':{shape:'diamond',size:70,iconScale:135},
  'Skills.Ability.SuspensorGrenade_Reduction':{shape:'diamond',size:74,iconScale:127},
  'Skills.Perk.SuspensorDash':{shape:'octagon',size:93,iconScale:105},
  'Skills.Attribute.SuspensorTech1':{shape:'circle',size:58,iconScale:183},
  'Skills.Perk.DeathFromAbove':{shape:'octagon',size:93,iconScale:105},
  'Skills.Ability.SuspensorBlast':{shape:'diamond',size:70,iconScale:105},
  'Skills.Ability.CablePull':{pipOffsetY:14},
  'Skills.Ability.FragGrenade':{pipOffsetY:12},
  'Skills.Perk.TrooperCooldowns':{shape:'octagon',size:93,iconScale:105},
  'Skills.Ability.AssaultSeeker':{shape:'diamond',size:74,iconScale:140,pipOffsetY:14},
  'Skills.Spice.GadgetReload':{shape:'circle',size:60,iconScale:149},
  'Skills.Ability.TurretSeeker':{shape:'diamond',size:74,iconScale:140,pipOffsetY:13},
  'Skills.Attribute.MentalCalculus1':{shape:'circle',size:58,iconScale:183},
  'Skills.Attribute.MentalCalculus2':{shape:'circle',size:58,iconScale:183},
  'Skills.Attribute.MentalCalculus3':{shape:'circle',size:58,iconScale:183},
  'Skills.Perk.HeadShots':{shape:'octagon',size:95,iconScale:105},
  'Skills.Attribute.MentalCalculus4':{shape:'circle',size:58,iconScale:183},
  'Skills.Perk.ExploitWeakness':{shape:'octagon',size:95,iconScale:105},
  'Skills.Attribute.MentalCalculus5':{shape:'circle',size:58,iconScale:183},
  'Skills.Perk.ShieldWeakpoint':{shape:'circle',size:58,iconScale:183},
  'Skills.Ability.PoisonCapsuleLauncher':{shape:'diamond',size:74,iconScale:140,pipOffsetY:14},
  'Skills.Ability.PoisonMine':{shape:'diamond',size:74,iconScale:120},
  'Skills.Attribute.Assassination1':{shape:'circle',size:58,iconScale:183},
  'Skills.Attribute.Assassination2':{shape:'circle',size:58,iconScale:183},
  'Skills.Perk.PoisonTooth':{shape:'octagon',size:95,iconScale:105},
  'Skills.Ability.StunDart':{shape:'diamond',size:74,iconScale:126},
  'Skills.Ability.HunterSeeker':{shape:'diamond',size:70,iconScale:105},
  'Skills.Ability.SuspensorWall':{shape:'diamond',size:74,iconScale:140,pipOffsetY:14},
  'Skills.Ability.SuspensorMine_Amplification':{shape:'diamond',size:74,iconScale:127},
  'Skills.Ability.SolidoDecoy':{shape:'diamond',size:74,iconScale:127},
  'Skills.Ability.SuspensorMine_Reduction':{shape:'diamond',size:74,iconScale:126},
  'Skills.Perk.IronWill':{shape:'octagon',size:95,iconScale:105},
  'Skills.Ability.PortableGenerator':{shape:'diamond',size:70,iconScale:105},
  'Skills.Attribute.Scientist1':{shape:'circle',size:58,iconScale:196},
  'Skills.Attribute.Scientist2':{shape:'circle',size:58,iconScale:196},
  'Skills.Attribute.Scientist3':{shape:'circle',size:58,iconScale:196},
  'Skills.Attribute.Scientist4':{shape:'circle',size:58,iconScale:196},
  'Skills.Attribute.Scientist5':{shape:'circle',size:58,iconScale:196},
  'Skills.Science.m_PowerMax':{shape:'circle',size:58,iconScale:196},
  'Skills.Perk.BatteryExpert':{shape:'octagon',size:70,iconScale:94},
  'Skills.Ability.SuspensorPad':{shape:'diamond',size:74,iconScale:130},
  'Skills.Attribute.Explorer1':{shape:'circle',size:58,iconScale:196},
  'Skills.Attribute.Explorer2':{shape:'circle',size:58,iconScale:153},
  'Skills.Attribute.Explorer3':{shape:'circle',size:58,iconScale:196},
  'Skills.Attribute.Explorer4':{shape:'circle',size:58,iconScale:196},
  'Skills.Attribute.Explorer5':{shape:'circle',size:58,iconScale:196},
  'Skills.Attribute.Driver1':{shape:'circle',size:58,iconScale:196},
  'Skills.Attribute.Driver2':{shape:'circle',size:58,iconScale:196},
  'Skills.Attribute.Driver3':{shape:'circle',size:58,iconScale:196},
  'Skills.Attribute.Driver4':{shape:'circle',size:58,iconScale:196},
  'Skills.Attribute.Driver5':{shape:'circle',size:58,iconScale:196},
  'Skills.Attribute.Driver6':{shape:'circle',size:58,iconScale:196},
  'Skills.Spice.VehicleHeat':{shape:'circle',size:58,iconScale:182},
  'Skills.Ability.Hypersprint':{pipOffsetY:15},
  'Skills.Perk.Backstabber':{shape:'octagon',size:86,iconScale:105},
  'Skills.Attribute.WeirdingWay1':{shape:'circle',size:58,iconScale:179},
  'Skills.Attribute.WeirdingWay2':{shape:'circle',size:58,iconScale:179},
  'Skills.Spice.BinduDodge':{shape:'circle',size:58,iconScale:179},
  'Skills.Attribute.Manipulation1':{shape:'circle',size:58,iconScale:179},
  'Skills.Perk.VoiceAnalysis':{shape:'octagon',size:81,iconScale:105},
  'Skills.Spice.VoiceSplash':{shape:'circle',size:58,iconScale:166},
  'Skills.Attribute.SelfControl1':{shape:'circle',size:58,iconScale:179},
  'Skills.Perk.RegenCap':{shape:'octagon',size:85,iconScale:105},
  'Skills.Attribute.SelfControl2':{shape:'circle',size:58,iconScale:157},
  'Skills.Attribute.SelfControl3':{shape:'circle',size:58,iconScale:179},
  'Skills.Attribute.SelfControl4':{shape:'circle',size:58,iconScale:179},
  'Skills.Attribute.SelfControl5':{shape:'circle',size:58,iconScale:179},
  'Skills.Perk.BinduStability':{shape:'octagon',size:81,iconScale:105},
  'Skills.Perk.MetabolizePoison':{shape:'octagon',size:81,iconScale:105},
  'Skills.Ability.LitanyAgainstFear':{shape:'diamond',size:70,iconScale:126,pipOffsetY:10},
  'Skills.Attribute.Blade1':{shape:'circle',size:54,iconScale:187},
  'Skills.Perk.MeleeChain':{shape:'octagon',size:74,iconScale:105},
  'Skills.Attribute.Blade2':{shape:'circle',size:54,iconScale:187},
  'Skills.Ability.Whirlwind':{shape:'diamond',size:74,iconScale:125,pipOffsetY:14},
  'Skills.Spice.ParryBoost':{shape:'circle',size:54,iconScale:187},
  'Skills.Attribute.Resolve1':{shape:'circle',size:54,iconScale:187},
  'Skills.Perk.ToughLunge':{shape:'octagon',size:74,iconScale:105},
  'Skills.Attribute.Resolve2':{shape:'circle',size:54,iconScale:187},
  'Skills.Attribute.UnstoppableAttacks':{shape:'circle',size:54,iconScale:187},
  'Skills.Perk.ThriveOnDanger':{shape:'octagon',size:70,iconScale:105},
  'Skills.Ability.KneeCharge':{shape:'diamond',size:74,iconScale:125,pipOffsetY:15},
  'Skills.Attribute.Aggression1':{shape:'circle',size:54,iconScale:187},
  'Skills.Attribute.Aggression2':{shape:'circle',size:54,iconScale:187},
  'Skills.Perk.SprintStamina':{shape:'octagon',size:74,iconScale:105},
  'Skills.Ability.BattleCry':{pipOffsetY:14},
  'Skills.Attribute.Aggression3':{shape:'circle',size:54,iconScale:187},
  'Skills.Attribute.Aggression4':{shape:'circle',size:54,iconScale:187},
  'Skills.Spice.ShadowStrike':{shape:'circle',size:54,iconScale:165},
};

function stDefaultForNode(node) {
  if (node.classList.contains('apex')) return ST_DEFAULTS_APEX;
  const skill = JSON.parse(node.dataset.skillJson || '{}');
  const t = (skill.skillType || 'attribute').toLowerCase();
  return ST_DEFAULTS_BY_TYPE[t] || ST_DEFAULTS_BY_TYPE.attribute;
}

function applyStNodeStyles(node) {
  const tag = node.dataset.tag;
  const def = stDefaultForNode(node);
  const ov = ST_NODE_OVERRIDES[tag] || {};
  const shape = ov.shape || def.shape;
  const baseSize = ov.size != null ? ov.size : def.size;
  const ico = ov.iconScale != null ? ov.iconScale : def.iconScale;
  const pipY = ov.pipOffsetY != null ? ov.pipOffsetY : 0;
  // Scale node size by the tree-area's current layout scale (1.0 = the
  // 1300×580 reference canvas the overrides were tuned for; smaller in
  // compact mode). Read once from the area's CSS var that renderTree sets.
  const area = node.parentElement;
  const layoutScale = parseFloat(area?.style.getPropertyValue('--st-layout-scale')) || 1;
  const size = Math.max(8, Math.round(baseSize * layoutScale));
  node.style.width = size + 'px';
  node.style.height = size + 'px';
  if (node.dataset.cx) {
    node.style.left = (+node.dataset.cx - size/2) + 'px';
    node.style.top  = (+node.dataset.cy - size/2) + 'px';
  }
  const img = node.querySelector('img');
  if (img) { img.style.width = ico + '%'; img.style.height = ico + '%'; }
  const shapeDiv = node.querySelector('.st-shape');
  if (shapeDiv) {
    [...shapeDiv.classList].forEach(c => {
      if (c.startsWith('passive-')) shapeDiv.classList.remove(c);
    });
    shapeDiv.classList.add('passive-' + shape);
  }
  const pipBox = node.querySelector('.st-pips');
  if (pipBox) {
    const baseBottom = node.classList.contains('apex') ? -18 : -14;
    pipBox.style.bottom = (baseBottom - pipY) + 'px';
  }
}

function renderTree(skills, specName) {
  const area = document.getElementById('st-tree-area');
  if (!area) return;
  [...area.querySelectorAll('.st-node, svg.st-lines')].forEach(e => e.remove());
  // Read the LAYOUT size (offsetWidth/Height), NOT getBoundingClientRect —
  // the modal has a `transform: scale(0.97) → scale(1.0)` open animation,
  // and getBoundingClientRect would return the transformed rect (97% of
  // layout) for the duration of the animation. That under-scaled the
  // projection on first open and left rightmost columns compressed.
  // offsetWidth/Height return the pre-transform border-box dimensions.
  const areaW = area.offsetWidth  || ST_TREE_W;
  const areaH = area.offsetHeight || ST_TREE_H;
  // Scale the apex-frame texture + node sizes proportionally to the area
  // (reference: 1300×580 = the "full" canvas the overrides were tuned for).
  const layoutScale = Math.min(areaW / ST_TREE_W, areaH / ST_TREE_H);
  area.style.setProperty('--st-layout-scale', String(layoutScale));
  const xs = skills.map(s => s.x), ys = skills.map(s => s.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const w = maxX - minX, h = maxY - minY;
  const scale = Math.min((areaW - ST_PAD*2) / w, (areaH - ST_PAD*2) / h);
  // Center the projected tree inside the area on whichever axis isn't the
  // limiting one. Without this, when height limits scale (compact mode), the
  // tree's projected width is less than the area's width but rendered nodes
  // start at ST_PAD on the left → empty space on the right edge instead of
  // balanced margins.
  const projectedW = w * scale;
  const projectedH = h * scale;
  const xOffset = Math.max(ST_PAD, (areaW - projectedW) / 2);
  const yOffset = Math.max(ST_PAD, (areaH - projectedH) / 2);
  const proj = (x, y) => ({ x: xOffset + (x - minX) * scale, y: yOffset + (y - minY) * scale });

  renderSubTreeLabels(skills, specName, proj);

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('st-lines');
  svg.setAttribute('viewBox', `0 0 ${areaW} ${areaH}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  area.appendChild(svg);

  const placed = {};
  skills.forEach(s => {
    const p = proj(s.x, s.y);
    const isApex = s.y < minY + (h * 0.1);
    const t = (s.skillType || '').toLowerCase();
    // build-v6.py stores 'technique' (from gt). Older mock data used 'perk' —
    // accept both. Anything that isn't attribute/technique falls under ability
    // (covers 'ability' and 'spice').
    const frameType = t === 'attribute' ? 'attribute'
      : (t === 'perk' || t === 'technique') ? 'technique'
      : 'ability';
    const node = document.createElement('div');
    node.className = 'st-node ' + (isApex ? 'apex' : 'passive') + ' frame-' + frameType;
    node.dataset.cx = p.x; node.dataset.cy = p.y;
    node.dataset.tag = s.tag;
    node.dataset.rank = '0';
    node.dataset.skillJson = JSON.stringify(s);
    const shape = document.createElement('div'); shape.className = 'st-shape';
    const iconLocal = s.iconPath_local;
    if (iconLocal) {
      const img = document.createElement('img');
      img.src = './' + iconLocal.replace(/^\.?\/?/, '');
      img.alt = s.name; img.loading = 'lazy';
      shape.appendChild(img);
    }
    node.appendChild(shape);
    const maxRank = Math.max(1, (s.statsPerRank || []).length || s.pipCount || 1);
    node.dataset.maxRank = String(maxRank);
    if (maxRank > 1) {
      const pipBox = document.createElement('div');
      pipBox.className = 'st-pips';
      for (let i = 0; i < maxRank; i++) {
        const p2 = document.createElement('div'); p2.className = 'st-pip'; pipBox.appendChild(p2);
      }
      node.appendChild(pipBox);
    }
    node.addEventListener('click', (ev) => { ev.preventDefault(); tryAllocateNode(node); });
    node.addEventListener('contextmenu', (ev) => { ev.preventDefault(); tryDeallocateNode(node); });
    node.addEventListener('mouseenter', e => showSkillTooltip(e, s, node));
    node.addEventListener('mousemove',  e => moveSkillTooltip(e));
    node.addEventListener('mouseleave', () => hideSkillTooltip());
    area.appendChild(node);
    placed[s.tag] = { el: node, x: p.x, y: p.y };
    applyStNodeStyles(node);
  });

  skills.forEach(s => {
    const tgt = placed[s.tag]; if (!tgt) return;
    (s.prerequisites || []).forEach(preTag => {
      const src = placed[preTag]; if (!src) return;
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', src.x); line.setAttribute('y1', src.y);
      line.setAttribute('x2', tgt.x); line.setAttribute('y2', tgt.y);
      line.classList.add('st-line');
      line.dataset.srcTag = preTag; line.dataset.tgtTag = s.tag;
      svg.appendChild(line);
    });
  });
}

function renderSubTreeLabels(skills, specName, proj) {
  const host = document.getElementById('st-sub-tree-labels');
  if (!host) return;
  host.innerHTML = '';
  const labels = (SKILL_TREE_STATE.subTreeLabels || {})[specName];
  if (!labels) return;
  const buckets = [[], [], []];
  skills.forEach(s => {
    if (s.subTreeIdx == null) return;
    buckets[s.subTreeIdx].push(proj(s.x, s.y).x);
  });
  buckets.forEach((xs, i) => {
    if (!xs.length || !labels[i]) return;
    const cx = xs.reduce((a,b) => a+b, 0) / xs.length;
    const el = document.createElement('div');
    el.className = 'st-sub-tree-label';
    el.style.left = cx + 'px';
    el.textContent = labels[i];
    host.appendChild(el);
  });
}

// Refresh "locked" class + line states based on current allocations.
function refreshAllNodes() {
  document.querySelectorAll('.st-node').forEach(node => {
    const skill = SKILL_TREE_STATE.nodesByTag[node.dataset.tag];
    if (!skill) return;
    const rank = +node.dataset.rank;
    const available = isNodeAvailable(skill);
    node.classList.toggle('locked', !available && rank === 0);
  });
  document.querySelectorAll('svg.st-lines line').forEach(line => {
    const srcNode = document.querySelector(`.st-node[data-tag="${line.dataset.srcTag}"]`);
    const tgtNode = document.querySelector(`.st-node[data-tag="${line.dataset.tgtTag}"]`);
    if (!srcNode || !tgtNode) return;
    const srcRank = +srcNode.dataset.rank;
    const tgtRank = +tgtNode.dataset.rank;
    const tgtSkill = SKILL_TREE_STATE.nodesByTag[line.dataset.tgtTag];
    // "available" = the prereq edge: src is rank>=1 (this edge is satisfied)
    const edgeSatisfied = srcRank >= 1;
    // Show as available (purple) once the prereq node is rank ≥1 — that's the "you can reach this" cue.
    // Show as allocated (brighter) when BOTH nodes are allocated.
    line.classList.toggle('available', edgeSatisfied && tgtRank === 0);
    line.classList.toggle('allocated', edgeSatisfied && tgtRank >= 1);
  });
}

// =============================================
// Allocation
// =============================================
function spCostForRank(node, rank) {
  const arr = node.skillPointCostPerRank;
  if (Array.isArray(arr) && arr[rank - 1] != null) return arr[rank - 1];
  return 1;
}

function tryAllocateNode(nodeEl) {
  const tag = nodeEl.dataset.tag;
  const node = SKILL_TREE_STATE.nodesByTag[tag];
  if (!node) return;
  const cur = +nodeEl.dataset.rank;
  const max = +nodeEl.dataset.maxRank;
  if (cur >= max) return;
  if (!isNodeAvailable(node)) { flashSPInsufficient(); return; }
  const cost = spCostForRank(node, cur + 1);
  if (SKILL_TREE_STATE.spSpent + cost > SKILL_TREE_STATE.spTotal) { flashSPInsufficient(); return; }
  // Commit
  const spec = node.spec;
  if (!SKILL_TREE_STATE.allocations[spec]) SKILL_TREE_STATE.allocations[spec] = {};
  SKILL_TREE_STATE.allocations[spec][tag] = cur + 1;
  setNodeRankUI(nodeEl, cur + 1);
  SKILL_TREE_STATE.spSpent += cost;
  refreshSPDisplay();
  refreshAllNodes();
  persistSkillTreeState();
  renderSkillsSummary();
  renderTechniquesSummary();
  // Top resource bars + right-panel EHP/Stamina/Power calcs need to react to
  // skill nodes that contribute Max Health / Max Stamina / mitigation / power
  // regen / suspensor drain. Same handler the spec tracks use.
  refreshAfterSpecChange();
  syncTooltipIfShowing(nodeEl, cur + 1);
}

function tryDeallocateNode(nodeEl) {
  const tag = nodeEl.dataset.tag;
  const node = SKILL_TREE_STATE.nodesByTag[tag];
  if (!node) return;
  const cur = +nodeEl.dataset.rank;
  if (cur <= 0) return;
  const newRank = cur - 1;
  if (!canDeallocate(node, newRank)) { flashSPInsufficient(); return; }
  const refund = spCostForRank(node, cur);
  const spec = node.spec;
  if (newRank <= 0) {
    if (SKILL_TREE_STATE.allocations[spec]) delete SKILL_TREE_STATE.allocations[spec][tag];
  } else {
    SKILL_TREE_STATE.allocations[spec][tag] = newRank;
  }
  setNodeRankUI(nodeEl, newRank);
  SKILL_TREE_STATE.spSpent = Math.max(0, SKILL_TREE_STATE.spSpent - refund);
  refreshSPDisplay();
  refreshAllNodes();
  pruneEquipped();           // drop the equip if this node is no longer allocated
  renderMiniSlotIcons();
  persistSkillTreeState();
  renderSkillsSummary();
  renderTechniquesSummary();
  // Mirror the allocate path — see comment in tryAllocateNode.
  refreshAfterSpecChange();
  syncTooltipIfShowing(nodeEl, newRank);
}

function setNodeRankUI(nodeEl, newRank) {
  nodeEl.dataset.rank = String(newRank);
  [...nodeEl.querySelectorAll('.st-pip')].forEach((p, i) => p.classList.toggle('filled', i < newRank));
  nodeEl.classList.toggle('allocated', newRank >= 1);
}

function syncTooltipIfShowing(nodeEl, newRank) {
  const st = SKILL_TREE_STATE.tt;
  if (!st || st.node !== nodeEl) return;
  const s = st.skill;
  const max = Math.max(1, (s.statsPerRank || []).length || s.pipCount || 1);
  const prevAllocated = st.allocated;
  st.allocated = newRank;
  st.max = max;
  // Clamp up on allocate: preview at least matches what's now allocated.
  if (st.previewRank < newRank) st.previewRank = newRank;
  // Clamp down on deallocate: if preview was tracking the allocated rank
  // (the default state — preview defaults to allocated on first hover), drop
  // it with allocated so the displayed stat reflects the new rank instead
  // of going stale at the old rank. If preview was set independently (user
  // scrolled to a different rank), leave it alone so they can keep previewing.
  if (st.previewRank === prevAllocated && newRank < prevAllocated) {
    st.previewRank = Math.max(1, newRank);
  }
  if (st.previewRank > max) st.previewRank = max;
  renderSkillTooltip();
}

function resetCurrentTree() {
  const spec = SKILL_TREE_STATE.currentSpec;
  if (!spec) return;
  delete SKILL_TREE_STATE.allocations[spec];
  document.querySelectorAll('.st-node').forEach(n => setNodeRankUI(n, 0));
  recomputeSpentSP();
  refreshAllNodes();
  pruneEquipped();
  renderMiniSlotIcons();
  persistSkillTreeState();
  renderSkillsSummary();
  renderTechniquesSummary();
}

// =============================================
// Tooltip
// =============================================
function showSkillTooltip(e, s, nodeEl) {
  const tt = document.getElementById('st-tooltip');
  if (!tt) return;
  const allocated = nodeEl ? +nodeEl.dataset.rank : 0;
  const max = Math.max(1, (s.statsPerRank || []).length || s.pipCount || 1);
  let preview = allocated >= 1 ? allocated : 1;
  preview = Math.max(1, Math.min(max, preview));
  SKILL_TREE_STATE.tt = { node: nodeEl, skill: s, previewRank: preview, allocated, max };
  renderSkillTooltip();
  // Position FIRST while still visibility:hidden — the layout is already live
  // (the tooltip never went display:none) so offsetHeight reflects the just-
  // set innerHTML correctly. Then make it visible so the user doesn't see a
  // flash at the old position.
  moveSkillTooltip(e);
  tt.classList.add('st-visible');
}

function renderSkillTooltip() {
  const tt = document.getElementById('st-tooltip');
  if (!tt) return;
  const { skill: s, previewRank, allocated, max } = SKILL_TREE_STATE.tt;
  if (!s) return;
  const typeLabel = ST_TYPE_DISPLAY[(s.skillType || '').toLowerCase()] || (s.skillType || '').toUpperCase();
  let bars = '';
  for (let i = 1; i <= max; i++) {
    let cls = 'empty';
    if (i <= allocated) cls = 'filled';
    if (i === previewRank) cls = 'preview';
    bars += `<div class="st-tt-bar ${cls}"></div>`;
  }
  const rankStats = (s.statsPerRank && s.statsPerRank[previewRank - 1]) || {};
  let statsHtml = '';
  for (const [name, val] of Object.entries(rankStats)) {
    statsHtml += `<div class="st-tt-stat"><span>${name}</span><span class="v">${val}</span></div>`;
  }
  if (!statsHtml) {
    statsHtml = `<div class="st-tt-stat"><span style="color:var(--color-text-secondary);font-style:italic;">(no per-rank stat mined for this rank)</span><span></span></div>`;
  }
  let costHtml = '';
  if (previewRank > allocated) {
    const node = SKILL_TREE_STATE.nodesByTag[s.tag];
    const c = node ? spCostForRank(node, previewRank) : null;
    if (c != null) costHtml = `<div class="st-tt-cost"><span>Cost</span><span>${c} Skill Point${c === 1 ? '' : 's'}</span></div>`;
  }
  let footerStatus = '';
  if (allocated >= max) {
    footerStatus = `<div class="st-tt-footer-status" style="color:var(--color-gold-bright);">Maxed</div>`;
  } else if (previewRank > allocated) {
    const node = SKILL_TREE_STATE.nodesByTag[s.tag];
    const c = node ? spCostForRank(node, previewRank) : 0;
    if (node && !isNodeAvailable(node)) {
      footerStatus = `<div class="st-tt-footer-status">Prerequisites Not Met</div>`;
    } else if (SKILL_TREE_STATE.spSpent + c > SKILL_TREE_STATE.spTotal) {
      footerStatus = `<div class="st-tt-footer-status">Insufficient Skill Points</div>`;
    }
  }
  let descHtml = '';
  if (s.description) {
    descHtml = `<div class="st-tt-desc"><p>${s.description}</p>${s.subDescription ? `<p>${s.subDescription}</p>` : ''}</div>`;
  } else {
    descHtml = `<div class="st-tt-desc"><p style="color:var(--color-text-secondary);font-style:italic;">(no description)</p></div>`;
  }
  let hotkeysHtml = '';
  if (max > 1) {
    hotkeysHtml = `
      <div class="st-tt-hotkeys">
        <div class="st-tt-hk"><span class="kc">Z</span><span>Prev Level</span></div>
        <div class="st-tt-hk"><span class="kc">X</span><span>${previewRank >= max ? 'Wrap to 1' : 'Next Level'}</span></div>
      </div>`;
  }
  let prereqMeta = '';
  if (Array.isArray(s.prerequisites) && s.prerequisites.length) {
    const names = s.prerequisites.map(pt => {
      const pn = SKILL_TREE_STATE.nodesByTag[pt];
      return pn ? pn.name : pt;
    });
    prereqMeta = `<div class="st-tt-meta">Requires: ${names.join(', ')}</div>`;
  }
  tt.innerHTML = `
    <div class="st-tt-header">
      <div class="st-tt-type">${typeLabel}</div>
      <div class="st-tt-name">${s.name}</div>
      <div class="st-tt-rank-diamond"><span>${allocated || 1}</span></div>
    </div>
    <div class="st-tt-level-row">
      <div class="st-tt-level-label">Level ${previewRank}/${max}</div>
      <div class="st-tt-bars">${bars}</div>
    </div>
    ${descHtml}
    <div class="st-tt-stats">${statsHtml}</div>
    ${costHtml}
    ${footerStatus}
    ${hotkeysHtml}
    ${prereqMeta}
  `;
}

function moveSkillTooltip(e) {
  const tt = document.getElementById('st-tooltip');
  if (!tt) return;
  // Force a layout flush so the dimensions we read reflect the CURRENT
  // content (showSkillTooltip just set innerHTML + display:block on the same
  // tick — getBoundingClientRect can return 0×0 if layout hasn't settled).
  // Reading offsetHeight forces a synchronous reflow.
  void tt.offsetHeight;
  // offsetWidth/Height are layout dims (immune to CSS transforms) and reliable
  // post-flush. CSS pins `.st-tooltip { width: 380px }` so the constant
  // fallback only ever kicks in if measurement is genuinely broken.
  const tw = tt.offsetWidth  || 380;
  const th = tt.offsetHeight || 200;
  // Clamp to the modal's content rect (not the viewport) so the tooltip
  // never spills past the panel border. Inset 8px off the modal border.
  const modal = document.querySelector('.skill-tree-modal');
  const mr = modal ? modal.getBoundingClientRect() : { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
  const INSET = 8;
  const GAP   = 16;
  const minX = mr.left + INSET;
  const minY = mr.top  + INSET;
  // If the tooltip is wider/taller than the modal can ever hold (degenerate
  // tiny modal), Math.max with minX guarantees we never produce an inverted
  // clamp range that would force the tooltip past the right/bottom edge.
  const maxX = Math.max(minX, mr.right  - INSET - tw);
  const maxY = Math.max(minY, mr.bottom - INSET - th);
  // Prefer bottom-right of cursor; flip horizontally / vertically if that
  // side would overflow the modal.
  let x = e.clientX + GAP;
  let y = e.clientY + GAP;
  if (x + tw + INSET > mr.right)  x = e.clientX - tw - GAP;
  if (y + th + INSET > mr.bottom) y = e.clientY - th - GAP;
  // Final clamp — covers the case where neither side fits (cursor + tooltip
  // larger than the modal edge in both directions).
  x = Math.max(minX, Math.min(maxX, x));
  y = Math.max(minY, Math.min(maxY, y));
  tt.style.left = x + 'px';
  tt.style.top  = y + 'px';
}

function hideSkillTooltip() {
  const tt = document.getElementById('st-tooltip');
  if (tt) tt.classList.remove('st-visible');
  SKILL_TREE_STATE.tt = { node: null, skill: null, previewRank: 1, allocated: 0, max: 1 };
}

// X / Z to cycle the previewed rank inside the tooltip
document.addEventListener('keydown', (e) => {
  const st = SKILL_TREE_STATE.tt;
  if (!st || !st.skill) return;
  if (!document.getElementById('skill-tree-overlay').classList.contains('visible')) return;
  if (e.key.toLowerCase() === 'x') {
    st.previewRank = st.previewRank >= st.max ? 1 : st.previewRank + 1;
    renderSkillTooltip(); e.preventDefault();
  } else if (e.key.toLowerCase() === 'z') {
    st.previewRank = st.previewRank <= 1 ? st.max : st.previewRank - 1;
    renderSkillTooltip(); e.preventDefault();
  }
});

// Bind buttons
document.addEventListener('DOMContentLoaded', () => {
  // Cache the app version once so exportBuild() (sync) can stamp it without an await.
  window.electronAPI.getVersion()
    .then(v => { APP_VERSION = v; })
    .catch(() => { /* informational only — leave null */ });
  const openBtn = document.getElementById('open-skill-tree-btn');
  if (openBtn) openBtn.addEventListener('click', openSkillTree);
  const closeBtn = document.getElementById('skill-tree-close');
  if (closeBtn) closeBtn.addEventListener('click', closeSkillTree);
  const overlay = document.getElementById('skill-tree-overlay');
  if (overlay) overlay.addEventListener('click', e => { if (e.target === e.currentTarget) closeSkillTree(); });
  const resetBtn = document.getElementById('st-reset-tree');
  if (resetBtn) resetBtn.addEventListener('click', resetCurrentTree);

  // AOE blast-field popup close wiring (button + backdrop click).
  const aoeClose = document.getElementById('aoe-blast-close');
  if (aoeClose) aoeClose.addEventListener('click', closeAoeBlast);
  const aoeOverlay = document.getElementById('aoe-blast-overlay');
  if (aoeOverlay) aoeOverlay.addEventListener('click', e => { if (e.target === e.currentTarget) closeAoeBlast(); });
});

// Cycle the active spec by delta (-1 = previous / Z, +1 = next / C). Wraps.
function cycleSkillTreeSpec(delta) {
  const specs = SKILL_TREE_STATE.data?.specs;
  if (!specs || !specs.length) return;
  const current = SKILL_TREE_STATE.currentSpec || specs[0];
  const idx = specs.indexOf(current);
  const next = specs[(idx + delta + specs.length) % specs.length];
  document.querySelectorAll('#st-spec-nav .st-spec-icon').forEach(x => {
    x.classList.toggle('active', x.dataset.spec === next);
  });
  showSpec(next);
}

// Hook the 'K' shortcut while overlay closed → open. While open, Z/C cycle specs.
document.addEventListener('keydown', (e) => {
  if (e.target && /input|textarea|select/i.test(e.target.tagName || '')) return;
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  const overlay = document.getElementById('skill-tree-overlay');
  if (!overlay) return;
  const isOpen = overlay.classList.contains('visible');
  if (e.key === 'Escape' && isOpen) {
    closeSkillTree();
    e.preventDefault();
    return;
  }
  // When a tooltip is showing, Z/X are consumed by the tooltip rank-preview
  // cycler (see earlier listener); don't also cycle specs/tabs.
  const tooltipActive = !!SKILL_TREE_STATE.tt?.skill;
  const inEquipView = isOpen && getCurrentSkillView() === 'equip';
  if (isOpen && !tooltipActive && (e.key === 'z' || e.key === 'Z')) {
    if (inEquipView) switchEquipTab('ability');
    else cycleSkillTreeSpec(-1);
    e.preventDefault();
    return;
  }
  if (isOpen && (e.key === 'c' || e.key === 'C')) {
    if (inEquipView) switchEquipTab('technique');
    else cycleSkillTreeSpec(+1);
    e.preventDefault();
    return;
  }
  if (e.key.toLowerCase() !== 'k') return;
  if (isOpen) closeSkillTree();
  else openSkillTree();
});

// =============================================
// SKILL TREE — EQUIP SUBPAGE (S key)
// View toggle (tree ↔ equip), drag-and-drop equip flow, persistence under
// SKILL_TREE_STATE.equipped + the skills._equipped block.
// =============================================

// Equipped slots state. Each array is exactly 3 entries. Each entry is either
// a node tag (e.g. "Skills.Ability.AssaultSeeker") or null = empty slot.
SKILL_TREE_STATE.equipped = { abilities: [null, null, null], techniques: [null, null, null] };

function isAbilitySlotEligible(node) {
  if (!node) return false;
  const t = (node.skillType || '').toLowerCase();
  return t === 'ability' || t === 'spice';
}
function isTechniqueSlotEligible(node) {
  if (!node) return false;
  // build-v6.py stores skillType as 'technique' (lowercased from gt's "Technique");
  // accept 'perk' too in case the source ever changes back.
  const t = (node.skillType || '').toLowerCase();
  return t === 'technique' || t === 'perk';
}

function isAllocated(tag) {
  const n = SKILL_TREE_STATE.nodesByTag[tag];
  if (!n) return false;
  const specAlloc = SKILL_TREE_STATE.allocations[n.spec] || {};
  return (specAlloc[tag] || 0) >= 1;
}

// Set or clear a slot. Slot type = "ability" | "technique", idx = 0..2.
function setEquipSlot(slotType, idx, tag) {
  const key = slotType === 'ability' ? 'abilities' : 'techniques';
  if (!SKILL_TREE_STATE.equipped[key]) SKILL_TREE_STATE.equipped[key] = [null, null, null];
  // If this tag is already equipped in another slot of the same type, clear that other slot first.
  if (tag) {
    SKILL_TREE_STATE.equipped[key] = SKILL_TREE_STATE.equipped[key].map(t => t === tag ? null : t);
  }
  SKILL_TREE_STATE.equipped[key][idx] = tag || null;
  persistSkillTreeState();
  renderEquipPage();
  renderMiniSlotIcons();
  if (key === 'techniques') {
    renderTechniquesSummary();
    // Techniques can contribute Damage Mitigation (ToughLunge), and equipping/
    // unequipping changes the bonus pool — re-run the spec-change refresh so
    // bars + calcs see the updated value.
    refreshAfterSpecChange();
  }
}

function clearEquipSlot(slotType, idx) {
  setEquipSlot(slotType, idx, null);
}

// Strip out any equipped entries that are no longer allocated (e.g. user
// resets the tree). Called from recomputeSpentSP / reset paths so the equip
// state can't reference dead tags.
function pruneEquipped() {
  let changed = false;
  for (const key of ['abilities', 'techniques']) {
    const arr = SKILL_TREE_STATE.equipped[key] || [];
    for (let i = 0; i < arr.length; i++) {
      if (arr[i] && !isAllocated(arr[i])) {
        arr[i] = null;
        changed = true;
      }
    }
  }
  if (changed) persistSkillTreeState();
}

// ============== View toggle ==============
function getCurrentSkillView() {
  const equipView = document.getElementById('st-view-equip');
  if (!equipView) return 'tree';
  return equipView.hasAttribute('hidden') ? 'tree' : 'equip';
}

function swapToEquipView() {
  const treeView = document.getElementById('st-view-tree');
  const equipView = document.getElementById('st-view-equip');
  if (!treeView || !equipView) return;
  treeView.setAttribute('hidden', '');
  equipView.removeAttribute('hidden');
  hideSkillTooltip();
  renderEquipPage();
}

function swapToTreeView() {
  const treeView = document.getElementById('st-view-tree');
  const equipView = document.getElementById('st-view-equip');
  if (!treeView || !equipView) return;
  equipView.setAttribute('hidden', '');
  treeView.removeAttribute('hidden');
  renderMiniSlotIcons();
}

function toggleSkillView() {
  if (getCurrentSkillView() === 'tree') swapToEquipView();
  else swapToTreeView();
}

// ============== Render: equip page (slots + allocated grids) ==============
function renderEquipPage() {
  pruneEquipped(); // make sure no stale equips before rendering
  renderEquipSlots('ability');
  renderEquipSlots('technique');
  renderEquipGrid('ability');
  renderEquipGrid('technique');
  syncEquipTabButtons();
}

function renderEquipSlots(slotType) {
  const containerId = slotType === 'ability' ? 'st-equip-ability-slots' : 'st-equip-technique-slots';
  const labelsId    = slotType === 'ability' ? 'st-equip-ability-labels' : 'st-equip-technique-labels';
  const container = document.getElementById(containerId);
  const labelsBox = document.getElementById(labelsId);
  if (!container) return;
  const key = slotType === 'ability' ? 'abilities' : 'techniques';
  const arr = SKILL_TREE_STATE.equipped[key] || [];
  [...container.querySelectorAll('.st-equip-slot')].forEach((slot, idx) => {
    const tag = arr[idx];
    const content = slot.querySelector('.st-equip-slot-content');
    if (content) {
      content.innerHTML = '';
      if (tag) {
        const node = SKILL_TREE_STATE.nodesByTag[tag];
        if (node?.iconPath_local) {
          const img = document.createElement('img');
          img.src = './' + node.iconPath_local.replace(/^\.?\/?/, '');
          img.alt = node.name || tag;
          img.title = node.name || tag;
          content.appendChild(img);
        }
      }
    }
    slot.classList.toggle('st-equip-empty', !tag);
    slot.classList.toggle('st-equip-filled', !!tag);
  });
  // Sync names below the slot row
  if (labelsBox) {
    const spans = labelsBox.querySelectorAll('span');
    spans.forEach((span, idx) => {
      const tag = arr[idx];
      const node = tag ? SKILL_TREE_STATE.nodesByTag[tag] : null;
      span.textContent = node?.name || '';
    });
  }
}

// Render the FULL grid of all items in a category (both unlocked + locked).
// Order is fixed (tree position): walk every spec → every node in spec order,
// keep items matching the requested type. This way the grid layout doesn't
// shuffle as the user allocates new things.
function renderEquipGrid(slotType) {
  const gridId = slotType === 'ability' ? 'st-equip-ability-grid' : 'st-equip-technique-grid';
  const grid = document.getElementById(gridId);
  if (!grid) return;
  grid.innerHTML = '';
  const eligible = slotType === 'ability' ? isAbilitySlotEligible : isTechniqueSlotEligible;
  const equippedKey = slotType === 'ability' ? 'abilities' : 'techniques';
  const equippedSet = new Set(SKILL_TREE_STATE.equipped[equippedKey] || []);
  const data = SKILL_TREE_STATE.data;
  if (!data) return;

  // Walk in canonical spec order so the grid is stable.
  const items = [];
  for (const spec of (data.specs || [])) {
    const nodes = data.skills_by_spec?.[spec] || [];
    for (const n of nodes) {
      if (!eligible(n)) continue;
      items.push(n);
    }
  }

  for (const node of items) {
    const item = document.createElement('div');
    item.className = `st-equip-item st-equip-item--${slotType}`;
    item.dataset.tag = node.tag;
    item.dataset.slotType = slotType;

    const unlocked = isAllocated(node.tag);
    item.classList.add(unlocked ? 'st-equip-unlocked' : 'st-equip-locked');

    if (unlocked) {
      item.draggable = true;
      item.title = node.name || node.tag;
      if (equippedSet.has(node.tag)) item.classList.add('st-equip-equipped');
      if (node.iconPath_local) {
        const img = document.createElement('img');
        img.src = './' + node.iconPath_local.replace(/^\.?\/?/, '');
        img.alt = node.name || node.tag;
        item.appendChild(img);
      }
    } else {
      item.draggable = false;
      // Locked items show a "+" placeholder. Span lives above the ::after
      // shape fill via z-index in CSS.
      const plus = document.createElement('span');
      plus.className = 'st-equip-item-plus';
      plus.textContent = '+';
      item.appendChild(plus);
    }

    const mark = document.createElement('div');
    mark.className = 'st-equip-item-mark';
    item.appendChild(mark);
    grid.appendChild(item);
  }
}

// ============== Tab switching (Abilities ↔ Techniques) ==============
function switchEquipTab(tab /* 'ability' | 'technique' */) {
  const abilPane = document.getElementById('st-equip-pane-ability');
  const techPane = document.getElementById('st-equip-pane-technique');
  if (!abilPane || !techPane) return;
  if (tab === 'technique') {
    abilPane.setAttribute('hidden', '');
    techPane.removeAttribute('hidden');
  } else {
    techPane.setAttribute('hidden', '');
    abilPane.removeAttribute('hidden');
  }
  syncEquipTabButtons();
}

function syncEquipTabButtons() {
  const abilPane = document.getElementById('st-equip-pane-ability');
  const isAbility = abilPane && !abilPane.hasAttribute('hidden');
  const abilBtn = document.getElementById('st-equip-tab-ability');
  const techBtn = document.getElementById('st-equip-tab-technique');
  if (abilBtn) abilBtn.classList.toggle('st-equip-tab--active', isAbility);
  if (techBtn) techBtn.classList.toggle('st-equip-tab--active', !isAbility);
}

function getActiveEquipTab() {
  const abilPane = document.getElementById('st-equip-pane-ability');
  return (abilPane && !abilPane.hasAttribute('hidden')) ? 'ability' : 'technique';
}

// Bottom-strip mini-slots in tree view — render equipped icons so the strip
// reflects the current loadout even while looking at the tree.
function renderMiniSlotIcons() {
  for (const slotType of ['ability', 'technique']) {
    const stripId = slotType === 'ability' ? 'st-strip-abilities' : 'st-strip-techniques';
    const strip = document.getElementById(stripId);
    if (!strip) continue;
    const key = slotType === 'ability' ? 'abilities' : 'techniques';
    const arr = SKILL_TREE_STATE.equipped[key] || [];
    [...strip.querySelectorAll('.st-mini-slot')].forEach((slot, idx) => {
      // Strip any existing icon overlay
      const existing = slot.querySelector('.st-mini-slot-icon');
      if (existing) existing.remove();
      const tag = arr[idx];
      if (!tag) return;
      const node = SKILL_TREE_STATE.nodesByTag[tag];
      if (!node?.iconPath_local) return;
      const overlay = document.createElement('div');
      overlay.className = 'st-mini-slot-icon';
      const img = document.createElement('img');
      img.src = './' + node.iconPath_local.replace(/^\.?\/?/, '');
      img.alt = node.name || tag;
      img.title = node.name || tag;
      overlay.appendChild(img);
      slot.appendChild(overlay);
    });
  }
}

// ============== Drag-and-drop ==============
// Delegate on the equip view so we don't re-wire on every render.
function setupEquipDragDrop() {
  const equipView = document.getElementById('st-view-equip');
  if (!equipView || equipView.dataset.dragWired === '1') return;
  equipView.dataset.dragWired = '1';

  // Source items: dragstart marks the item, sets payload
  equipView.addEventListener('dragstart', (e) => {
    const item = e.target.closest('.st-equip-item');
    if (!item) return;
    if (item.classList.contains('st-equip-item--equipped')) {
      // Allow re-drag of equipped items so user can move them to a different slot
    }
    e.dataTransfer.setData('text/plain', JSON.stringify({
      tag: item.dataset.tag,
      slotType: item.dataset.slotType,
    }));
    e.dataTransfer.effectAllowed = 'move';
    item.classList.add('st-equip-dragging');
  });
  equipView.addEventListener('dragend', (e) => {
    const item = e.target.closest('.st-equip-item');
    if (item) item.classList.remove('st-equip-dragging');
  });

  // Drop targets: the 6 slots
  equipView.addEventListener('dragover', (e) => {
    const slot = e.target.closest('.st-equip-slot');
    if (!slot) return;
    e.preventDefault(); // allow drop
    e.dataTransfer.dropEffect = 'move';
    slot.classList.add('st-equip-drag-over');
  });
  equipView.addEventListener('dragleave', (e) => {
    const slot = e.target.closest('.st-equip-slot');
    if (slot) slot.classList.remove('st-equip-drag-over');
  });
  equipView.addEventListener('drop', (e) => {
    const slot = e.target.closest('.st-equip-slot');
    if (!slot) return;
    e.preventDefault();
    slot.classList.remove('st-equip-drag-over');
    let payload;
    try { payload = JSON.parse(e.dataTransfer.getData('text/plain') || '{}'); }
    catch { return; }
    const [slotType, idxStr] = (slot.dataset.equipSlot || '').split(':');
    const idx = parseInt(idxStr, 10);
    if (!slotType || !Number.isFinite(idx)) return;
    if (payload.slotType !== slotType) return; // ability can't drop into technique slot
    setEquipSlot(slotType, idx, payload.tag);
  });

  // Click an equipped slot → clear it
  equipView.addEventListener('click', (e) => {
    const slot = e.target.closest('.st-equip-slot');
    if (!slot) return;
    const [slotType, idxStr] = (slot.dataset.equipSlot || '').split(':');
    const idx = parseInt(idxStr, 10);
    if (!slotType || !Number.isFinite(idx)) return;
    const key = slotType === 'ability' ? 'abilities' : 'techniques';
    if ((SKILL_TREE_STATE.equipped[key] || [])[idx]) {
      clearEquipSlot(slotType, idx);
    }
  });
}

// Wire view-toggle clickables. The tree bottom-strip click swaps to equip;
// the equip back button swaps back. Both also bound to the S key. Tabs are
// click-to-switch + Z/C navigable while in equip view.
document.addEventListener('DOMContentLoaded', () => {
  const stripEnter = document.getElementById('st-enter-subpage');
  if (stripEnter) stripEnter.addEventListener('click', swapToEquipView);
  const backBtn = document.getElementById('st-equip-back');
  if (backBtn) backBtn.addEventListener('click', swapToTreeView);
  const abilTab = document.getElementById('st-equip-tab-ability');
  const techTab = document.getElementById('st-equip-tab-technique');
  if (abilTab) abilTab.addEventListener('click', () => switchEquipTab('ability'));
  if (techTab) techTab.addEventListener('click', () => switchEquipTab('technique'));
  setupEquipDragDrop();
  // Eager-load so the left-panel Skills / Techniques sections can surface
  // allocations + equips restored from localStorage before the user ever
  // opens the K menu.
  loadSkillTreeData().then(() => {
    renderSkillsSummary();
    renderTechniquesSummary();
  });
});

// S key handler — toggles tree ↔ equip view while skill-tree modal is open
// and no input field is focused. Sits BEFORE the main K/Z/C listener so we
// don't interfere with those.
document.addEventListener('keydown', (e) => {
  if (e.target && /input|textarea|select/i.test(e.target.tagName || '')) return;
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  const overlay = document.getElementById('skill-tree-overlay');
  if (!overlay || !overlay.classList.contains('visible')) return;
  // Don't fire S while a tooltip is showing (preserves potential future tooltip-S use).
  if (e.key === 's' || e.key === 'S') {
    toggleSkillView();
    e.preventDefault();
  }
});
