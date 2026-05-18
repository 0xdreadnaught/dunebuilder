'use strict';

// Compact layout flag: set by main.js via ?compact=1 when display is short.
if (new URLSearchParams(location.search).get('compact') === '1') {
  document.documentElement.classList.add('compact-layout');
}

// =============================================
// CONSTANTS
// =============================================
const RESOURCE_KEYS = new Set(['Health', 'Stamina', 'Energy']);
const LABEL_OVERRIDES = {
  'Energy': 'Power',
  'Regen per Second': 'Power Regen/s',
  'Power Drain (%)': 'Power Drain %',
};
const STAMINA_REGEN_PCT = 0.25; // ~25% of max stamina per second (estimated)
const STAMINA_REGEN_DELAY = 1.0; // 1.0s delay before regen starts (patch 1.2.10.0)
const BASE_STATS = { Health: 150, Stamina: 100, Energy: 0 }; // Power=0 until power pack equipped
const BASE_INVENTORY = { slots: 35, volume: 175.0 };

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
 * @returns {{ buildTotals: object|null, characterPanel: object|null }|null}
 */
function parseClipboardText(text) {
  const duneExport = extractSection(text, 'DUNEBUILDER EXPORT');
  if (!duneExport) return null;
  return {
    duneExport: true,
    slots: duneExport.slots || {},
    hotbar: duneExport.hotbar || null,
    characterPanel: duneExport.characterPanel || null,
    specializations: duneExport.specializations || null,
  };
}

// =============================================
// DOM FACTORIES
// =============================================

function createStatRow(label, value, formula) {
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

  if (formula) {
    row.addEventListener('mouseenter', e => showFormulaTooltip(label, value, formula, e));
    row.addEventListener('mousemove',  e => positionStatFormulaTooltip(e));
    row.addEventListener('mouseleave', hideStatFormulaTooltip);
  }

  return row;
}

function createResourceBar(label, { current, max }, cssKey, regenPerSec, regenDelay) {
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

  const startPct = max > 0 ? (current / max) * 100 : 0;

  const text = document.createElement('span');
  text.className = 'resource-bar__text';
  text.textContent = `${formatNumber(Math.round(current))} / ${formatNumber(Math.round(max))}`;

  bar.appendChild(fill);
  bar.appendChild(text);
  wrapper.appendChild(labelEl);
  wrapper.appendChild(bar);

  // Animate: snap to current%, then regen to 100% if not full
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      fill.style.width = `${startPct}%`;
      if (startPct < 100) {
        setTimeout(() => {
          fill.style.width = '100%';
          text.textContent = `${formatNumber(Math.round(max))} / ${formatNumber(Math.round(max))}`;
        }, 600);
      }
    });
  });

  // Click to drain + regen
  let regenAnim = null;
  let regenTimeout = null;
  bar.addEventListener('click', e => {
    if (regenAnim) { cancelAnimationFrame(regenAnim); regenAnim = null; }
    if (regenTimeout) { clearTimeout(regenTimeout); regenTimeout = null; }

    const rect = bar.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    let cur = pct * max;

    // Disable CSS transition for instant snap
    fill.style.transition = 'none';
    fill.style.width = `${(cur / max) * 100}%`;
    text.textContent = `${formatNumber(Math.round(cur))} / ${formatNumber(Math.round(max))}`;

    if (regenPerSec && cur < max) {
      const delayMs = (regenDelay || 0) * 1000;
      function startRegen() {
        let lastTime = performance.now();
        function tick(now) {
          const dt = (now - lastTime) / 1000;
          lastTime = now;
          cur = Math.min(max, cur + regenPerSec * dt);
          fill.style.width = `${(cur / max) * 100}%`;
          text.textContent = `${formatNumber(Math.round(cur))} / ${formatNumber(Math.round(max))}`;
          if (cur < max) {
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

function renderCharacterPanel(data, itemStats) {
  const container = document.getElementById('character-stats');
  container.innerHTML = '';
  const barsHolder = document.createElement('div');
  barsHolder.className = 'char-bars';
  container.appendChild(barsHolder);
  renderResourceBars(barsHolder, data);

  const extrasHolder = document.createElement('div');
  extrasHolder.className = 'char-extras';
  container.appendChild(extrasHolder);
  renderCharExtras(extrasHolder, itemStats);
}

/** Resource bars (Health, Stamina, Power). Animations only run on first build. */
function renderResourceBars(container, data) {
  const powerPool  = getEquippedStat('pack', 'power pool');
  const powerRegen = getEquippedStat('pack', 'regen per second');
  let renderedPowerBar = false;
  let renderedHealth = false;
  let renderedStamina = false;
  const sb = getSpecBonuses();

  if (data) {
    for (const [key, value] of Object.entries(data)) {
      if (!RESOURCE_KEYS.has(key)) continue;
      if (key === 'Energy' && powerPool !== null) {
        container.appendChild(createResourceBar('Power', { current: powerPool, max: powerPool }, 'Energy', powerRegen));
        renderedPowerBar = true;
        continue;
      }
      const resource = parseResource(value);
      if (!resource) continue;
      // Combat Max Health / Max Stamina keystones add on top of pasted values.
      const specBonus = key === 'Health' ? sb.health
                      : key === 'Stamina' ? sb.stamina
                      : 0;
      if (specBonus) { resource.max += specBonus; resource.current += specBonus; }
      const displayLabel = LABEL_OVERRIDES[key] || key;
      const regen = key === 'Stamina' ? resource.max * STAMINA_REGEN_PCT : null;
      const delay = key === 'Stamina' ? STAMINA_REGEN_DELAY : 0;
      container.appendChild(createResourceBar(displayLabel, resource, key, regen, delay));
      if (key === 'Health') renderedHealth = true;
      if (key === 'Stamina') renderedStamina = true;
    }
  }

  // Fallback bars when paste data didn't provide them.
  if (!renderedHealth && BASE_STATS.Health > 0) {
    const max = BASE_STATS.Health + sb.health;
    container.appendChild(createResourceBar('Health', { current: max, max }, 'Health'));
  }
  if (!renderedStamina && BASE_STATS.Stamina > 0) {
    const max = BASE_STATS.Stamina + sb.stamina;
    const regen = max * STAMINA_REGEN_PCT;
    container.appendChild(createResourceBar('Stamina', { current: max, max }, 'Stamina', regen, STAMINA_REGEN_DELAY));
  }
  if (!renderedPowerBar) {
    const pp = powerPool || BASE_STATS.Energy || 0;
    container.appendChild(createResourceBar('Power', { current: pp, max: pp }, 'Energy', powerRegen));
  }
}

/** Equipment + Inventory + Spec readouts. Safe to re-render on spec changes
 *  without touching (and re-animating) the resource bars above. */
function renderCharExtras(container, itemStats) {
  container.innerHTML = '';

  // Remove Power Pool from equipment stats since it's shown as a bar
  const hasPack = getEquippedStat('pack', 'power pool') !== null;
  if (itemStats && hasPack) {
    delete itemStats['Power Pool'];
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

  // Spec sections holder — populated by renderSpecSummary().
  const specHolder = document.createElement('div');
  specHolder.id = 'spec-summary';
  container.appendChild(specHolder);
  renderSpecSummary();
}

/** In-place text update for an existing bar — used on spec changes so we
 *  don't trigger the snap-then-regen animation. */
function updateResourceBarMaxInPlace(resourceKey, newMax) {
  const wrapper = document.querySelector(`.resource-bar-wrapper[data-resource="${resourceKey}"]`);
  if (!wrapper) return;
  const textEl = wrapper.querySelector('.resource-bar__text');
  if (textEl) textEl.textContent = `${formatNumber(Math.round(newMax))} / ${formatNumber(Math.round(newMax))}`;
}

let calcMode = 'def';

function getEquippedStat(slotType, nameFragment) {
  const item = equippedItems[slotType];
  if (!item) return null;
  const stat = (item.stats || []).find(s =>
    s.name.toLowerCase().includes(nameFragment.toLowerCase())
  );
  return stat != null ? stat.value : null;
}

function renderDefCalcs(container, equipped) {
  const powerPool   = getEquippedStat('pack',     'power pool');
  const powerDrain  = getEquippedStat('holtzman', 'power drain (%)');
  const regenPerSec = getEquippedStat('pack',     'regen per second');
  const beltDrain   = getEquippedStat('belt',     'power drain');

  const hasShield = !!equippedItems['holtzman'];
  const hasPack   = !!equippedItems['pack'];
  const hasBelt   = !!equippedItems['belt'];

  // --- EHP section (red — matches Health) ---
  const ehpHeading = document.createElement('div');
  ehpHeading.className = 'stats-section-label stats-section-label--health';
  ehpHeading.textContent = 'Effective Health Pool (EHP)';
  container.appendChild(ehpHeading);

  const baseHpFromSource = lastCharacterPanel?.Health
    ? (parseResource(lastCharacterPanel.Health)?.max ?? null)
    : (BASE_STATS.Health > 0 ? BASE_STATS.Health : null);
  const maxHealth = baseHpFromSource != null
    ? baseHpFromSource + getSpecBonuses().health
    : null;

  const totalArmor = equipped['Armor Value'] ?? 0;
  const armorMit = (totalArmor / (totalArmor + 500)) * 100;
  const specMit = getSpecBonuses().mitigationPercent;

  // Combined Damage Reduction stacks armor and the Combat spec passive
  // multiplicatively: 1 - (1 - armor%) × (1 - spec%).
  const drFraction = 1 - (1 - armorMit / 100) * (1 - specMit / 100);
  const drPercent = drFraction * 100;

  const DAMAGE_TYPES = [
    ['vs Light Dart',  'Light Dart Mitigation'],
    ['vs Heavy Dart',  'Heavy Dart Mitigation'],
    ['vs Energy',      'Energy Mitigation'],
    ['vs Blade',       'Blade Mitigation'],
    ['vs Concussive',  'Concussive Mitigation'],
    ['vs Fire',        'Fire Mitigation'],
  ];

  if (maxHealth !== null) {
    const ehpFromMit = (drPct, typePct) => {
      const drMul   = Math.max(0.001, 1 - drPct / 100);
      const typeMul = 1 - typePct / 100;
      return Math.round(maxHealth / (drMul * typeMul));
    };

    const drFormula = specMit > 0
      ? `1 - (1 - Armor/(Armor+500)) × (1 - SpecMit%)\n` +
        `1 - (1 - ${(armorMit / 100).toFixed(4)}) × (1 - ${(specMit / 100).toFixed(4)}) = ${drFraction.toFixed(4)}`
      : `Armor / (Armor + 500)\n${totalArmor} / (${totalArmor} + 500) = ${drFraction.toFixed(4)}`;

    container.appendChild(createStatRow('Damage Reduction',
      `${formatNumber(Math.round(drPercent * 10) / 10, 1)}%`, drFormula));
    container.appendChild(createStatRow('vs Physical',
      formatNumber(ehpFromMit(drPercent, 0)),
      `Health / (DMG - DR%)\n${formatNumber(maxHealth)} / (1 - ${drFraction.toFixed(4)}) = ${formatNumber(ehpFromMit(drPercent, 0))}`));

    DAMAGE_TYPES.forEach(([label, key]) => {
      const typeMit = equipped[key] ?? 0;
      const drMul   = Math.max(0.001, 1 - drPercent / 100);
      const typeMul = 1 - typeMit / 100;
      container.appendChild(createStatRow(label,
        formatNumber(ehpFromMit(drPercent, typeMit)),
        `Health / ((DMG - DR%) × (DMG - TypeMit%))\n${formatNumber(maxHealth)} / (${drMul.toFixed(4)} × ${typeMul.toFixed(4)}) = ${formatNumber(ehpFromMit(drPercent, typeMit))}`));
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

  const BASE_DASH_COST = 30;
  const baseStamFromSource = lastCharacterPanel?.Stamina
    ? (parseResource(lastCharacterPanel.Stamina)?.max ?? null)
    : (BASE_STATS.Stamina > 0 ? BASE_STATS.Stamina : null);
  const maxStamina = baseStamFromSource != null
    ? baseStamFromSource + getSpecBonuses().stamina
    : null;
  const gearDashMod  = equipped['Dash Stamina Cost'] ?? 0;
  const effectiveCost = Math.max(1, BASE_DASH_COST * (1 + gearDashMod / 100));

  container.appendChild(createStatRow('Dash Cost', formatNumber(Math.round(effectiveCost)),
    `BaseCost × (1 + ModTotal%)\n${BASE_DASH_COST} × (1 + ${gearDashMod}%) = ${formatNumber(Math.round(effectiveCost))}`));

  if (maxStamina !== null) {
    const rawDashes = maxStamina / effectiveCost;
    const rawRounded = Math.round(rawDashes * 10) / 10;
    const effectiveDashes = Math.ceil(rawRounded);
    container.appendChild(createStatRow('Max Dashes', `${formatNumber(effectiveDashes)} (${formatNumber(rawRounded, 1)})`,
      `MaxStamina / DashCost\n${formatNumber(maxStamina)} / ${formatNumber(Math.round(effectiveCost))} = ${formatNumber(rawRounded, 1)}`));
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
      const endurance = Math.round(powerPool / (powerDrain / 100));
      container.appendChild(createStatRow('Max Damage Absorbed', formatNumber(endurance),
        `PowerPool / (PowerDrain%)\n${formatNumber(powerPool)} / ${(powerDrain / 100).toFixed(4)} = ${formatNumber(endurance)}`));
    }
  }

  if (powerPool !== null && regenPerSec !== null) {
    const recharge = powerPool / regenPerSec;
    container.appendChild(createStatRow('Full Recharge', `${formatNumber(recharge, 1)}s`,
      `PowerPool / RegenPerSec\n${formatNumber(powerPool)} / ${formatNumber(regenPerSec)} = ${formatNumber(recharge, 1)}s`));
  }

  // Suspension — how long the suspensor belt can run before the pack is empty.
  // Exploration Suspensor Powerdrain Reduction keystones apply as the FINAL
  // layer (same pattern as the Combat damage / mitigation passives).
  if (hasBelt && beltDrain !== null && powerPool !== null) {
    const drainMul = getSpecBonuses().suspensorDrainMul;
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
      const baseFormula = `PowerPool / (BeltDrain × SpecMul)\n` +
        `${formatNumber(powerPool)} / (${formatNumber(beltDrain)} × ${drainMul.toFixed(2)}) = ${formatNumber(duration, 1)}s`;
      const simpleFormula = `PowerPool / BeltDrain\n${formatNumber(powerPool)} / ${formatNumber(beltDrain)} = ${formatNumber(duration, 1)}s`;
      container.appendChild(createStatRow('Suspension', fmtDur(duration),
        drainMul !== 1 ? baseFormula : simpleFormula));
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
let lastCharacterPanel = null;
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
  'damage per shot', 'shield damage per shot', 'clip size', 'dps',
  'reload time', 'rate of fire', 'effective range', 'maximum range',
  'damage per hit', 'attack speed',
  'heavy attack damage (shielded)', 'heavy attack damage (unshielded)',
  'shield damage per hit', 'power consumption', 'power consumption (per shot)',
  'recoil', 'projectile spread', 'volume',
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

// Stats whose tradeoff values are percentage-based (not flat).
const PERCENT_TRADEOFFS = new Set(['Volume', 'Rate of Fire', 'Reload Time', 'Recoil', 'Power Consumption (per shot)', 'Accuracy']);

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
  return `${formatNumber(value)}%`;
}

function assignUtilitySlot(slug) {
  if (slug.startsWith('powerpack')) return 'pack';
  if (slug.startsWith('holtzman')) return 'holtzman';
  if (slug.includes('suspensorbelt') || slug.includes('stabilizationbelt') || slug === 't2tsp') return 'belt';
  return null;
}

async function loadGarmentItems() {
  try {
    const [t6Res, t5Res, t4Res, t3Res, t2Res, t1Res, utilityRes, augmentRes,
           wt6Res, wt5Res, wt4Res, wt3Res, wt2Res, wt1Res,
           augMeleeRes, augRangedRes] = await Promise.all([
      fetch('./data/items_garment_t6.json'),
      fetch('./data/items_garment_t5.json'),
      fetch('./data/items_garment_t4.json'),
      fetch('./data/items_garment_t3.json'),
      fetch('./data/items_garment_t2.json'),
      fetch('./data/items_garment_t1.json'),
      fetch('./data/items_utility.json'),
      fetch('./data/augments_garment.json'),
      fetch('./data/items_weapon_t6.json'),
      fetch('./data/items_weapon_t5.json'),
      fetch('./data/items_weapon_t4.json'),
      fetch('./data/items_weapon_t3.json'),
      fetch('./data/items_weapon_t2.json'),
      fetch('./data/items_weapon_t1.json'),
      fetch('./data/augments_melee.json'),
      fetch('./data/augments_ranged.json'),
    ]);
    // Specializations — loaded separately so it doesn't block on a single bad response.
    try {
      const specRes = await fetch('./data/specializations.json');
      SPECIALIZATIONS_DATA = await specRes.json();
      SPECIALIZATIONS_DATA.forEach(track => {
        specState[track.id] = { level: 0, keystones: new Set() };
      });
    } catch (e) {
      console.error('Failed to load specializations:', e);
    }
    const t6 = await t6Res.json();
    const t5 = await t5Res.json();
    const t4 = await t4Res.json();
    const t3 = await t3Res.json();
    const t2 = await t2Res.json();
    const t1 = await t1Res.json();
    const utility = await utilityRes.json();
    AUGMENT_DATA = await augmentRes.json();
    const wt6 = await wt6Res.json();
    const wt5 = await wt5Res.json();
    const wt4 = await wt4Res.json();
    const wt3 = await wt3Res.json();
    const wt2 = await wt2Res.json();
    const wt1 = await wt1Res.json();
    WEAPON_ITEMS = [...wt6, ...wt5, ...wt4, ...wt3, ...wt2, ...wt1];
    const augMelee = await augMeleeRes.json();
    const augRanged = await augRangedRes.json();
    WEAPON_AUGMENT_DATA = [...augMelee, ...augRanged];

    const withSlots = utility
      .map(item => {
        const slot = assignUtilitySlot(item.slug);
        return slot ? { ...item, slot } : null;
      })
      .filter(Boolean);

    GARMENT_ITEMS = [...t6, ...t5, ...t4, ...t3, ...t2, ...t1, ...withSlots];
    const indexBySlug = (arr) => { const m = new Map(); for (const x of arr) if (!m.has(x.slug)) m.set(x.slug, x); return m; };
    GARMENT_BY_SLUG = indexBySlug(GARMENT_ITEMS);
    WEAPON_BY_SLUG = indexBySlug(WEAPON_ITEMS);
    AUGMENT_BY_SLUG = indexBySlug(AUGMENT_DATA);
    WEAPON_AUGMENT_BY_SLUG = indexBySlug(WEAPON_AUGMENT_DATA);
  } catch (e) {
    console.error('Failed to load items:', e);
  }
}

function createItemCard(item, slotType) {
  const rarityClass = item.rarity === 'Unique' ? 'rarity--unique' : 'rarity--common';
  const card = document.createElement('div');
  card.className = `item-card ${rarityClass}`;

  const img = document.createElement('img');
  img.className = 'item-card__icon';
  img.src = item.img;
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
  (item.stats || []).forEach(stat => {
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

function mergeBaseWithScaled(baseStats, scaledOverrides) {
  return baseStats.map(stat => {
    if (stat.name in scaledOverrides) {
      return { ...stat, value: scaledOverrides[stat.name] };
    }
    return stat;
  });
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
    const stats = (grade > 0 && item.scaledStats?.[grade - 1] && Object.keys(item.scaledStats[grade - 1]).length > 0)
      ? mergeBaseWithScaled(item.stats, item.scaledStats[grade - 1])
      : item.stats;

    // Build per-item stat map so augments can modify it before summing
    const itemStats = {};
    (stats || []).forEach(stat => {
      if (typeof stat.value !== 'number') return;
      const key = stat.name.replace(/:$/, '');
      itemStats[key] = (itemStats[key] || 0) + stat.value;
    });

    // Apply augment effects to this item's stats only
    const augSlots = equippedAugments[stateSlot];
    if (augSlots) {
      augSlots.forEach(aug => {
        if (!aug || !aug.slug) return;
        const augData = findAugmentData(aug.slug, slotType);
        if (!augData) return;
        const augGrade = aug.grade || 1;

        (augData.effects || []).forEach(eff => {
          const gradeData = eff.grades[augGrade - 1];
          if (!gradeData) return;
          const statKey = eff.stat.replace(/:$/, '');
          const keys = expandStatKey(statKey);
          const customVal = aug.customValues?.[eff.stat];
          const rawVal = customVal != null ? customVal : gradeData[1];
          // Funcom displays Accuracy with an inverted sign: an in-game "-40%" is actually a +40%
          // gain to the accuracy stat. The data files match the game's display, so flip here.
          const effectVal = statKey === 'Accuracy' ? -rawVal : rawVal;

          keys.forEach(key => {
            const baseVal = itemStats[key] || 0;
            if (eff.type === 'percent') {
              if (baseVal === 0) return; // Percent of nothing is nothing
              itemStats[key] = baseVal * (1 + effectVal / 100);
            } else {
              itemStats[key] = baseVal + effectVal;
            }
          });
        });

        // Tradeoffs apply to the item
        (augData.tradeoffs || []).forEach(t => {
          const statKey = t.stat.replace(/:$/, '');
          const keys = expandStatKey(statKey);
          const isPercent = PERCENT_TRADEOFFS.has(statKey);
          const tradeoffVal = statKey === 'Accuracy' ? -t.value : t.value;
          keys.forEach(key => {
            const baseVal = itemStats[key] || 0;
            if (isPercent) {
              if (baseVal === 0) return; // Percent of nothing is nothing
              itemStats[key] = baseVal * (1 + tradeoffVal / 100);
            } else {
              itemStats[key] = baseVal + tradeoffVal;
            }
          });
        });
      });
    }

    // Sum this item's (augmented) stats into global totals
    for (const [key, value] of Object.entries(itemStats)) {
      totals[key] = (totals[key] || 0) + value;
    }
  });

  // Combat Damage passive multiplies all weapon damage stats. (Hotbar items
  // are skipped above, so this loop is effectively a no-op for SPEC_DAMAGE_KEYS
  // today — kept as a safety net should weapon stats ever enter the aggregate.)
  const dmgMul = getSpecBonuses().combatDamageMul;
  if (dmgMul !== 1) {
    for (const key of Object.keys(totals)) {
      if (SPEC_DAMAGE_KEYS.has(key)) totals[key] *= dmgMul;
    }
  }

  return totals;
}

// =============================================
// SPECIALIZATIONS — calc integration
// =============================================

// Weapon damage stats that get multiplied by the Combat damage passive.
const SPEC_DAMAGE_KEYS = new Set([
  'Damage Per Shot', 'Damage Per Hit',
  'Shield Damage Per Shot', 'Shield Damage Per Hit',
  'Heavy Attack Damage (Shielded)', 'Heavy Attack Damage (Unshielded)',
  'DPS',
]);

/** Aggregated allocated-spec contributions that feed into existing calcs. */
function getSpecBonuses() {
  const b = {
    health: 0,
    stamina: 0,
    combatDamageMul: 1,      // Combat passive only — always-on damage multiplier
    staggerMul: 1,           // Sabotage stagger passive — 1 unless setting + spec
    headHunterBonus: 0,      // Sabotage Head Hunter keystone sum (0–0.30) — used by headshot calc
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
        if (p.key === 'DamageBonus_SpecTrack') b.combatDamageMul = 1 + v;
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
            b.staggerMul = 1 + v;
          }
        }
      }
      // Head Hunter keystones — sum the headshot-damage bonuses. The base
      // ×1.5 headshot multiplier is applied at the consumer (since it's
      // weapon-dependent: drillshots/lasguns/etc. can't headshot).
      for (const k of (track.keystones || [])) {
        if (!state.keystones.has(k.id)) continue;
        for (const e of (k.effects || [])) {
          if (e.name === 'Headshot Damage' && e.value != null) b.headHunterBonus += e.value;
        }
      }
    }
  }
  return b;
}

/** Whether a weapon item can land headshots in-game. Excludes melee, drillshots,
 *  flamethrowers, lasguns, pyrockets, and missile launchers. */
const HEADSHOT_BLOCKED_FAMILIES = new Set([
  'Drillshot FK7', 'Flamethrower', 'Lasgun', 'Pyrocket', 'Missile Launcher',
]);
const HEADSHOT_BLOCKED_NAME_KEYWORDS = [
  'drillshot', 'flamethrower', 'lasgun', 'pyrocket', 'pyrorocket', 'missile launcher',
];
function canHeadshot(item) {
  if (!item) return false;
  if (item.weaponType === 'melee') return false;
  if (item.weaponFamily && HEADSHOT_BLOCKED_FAMILIES.has(item.weaponFamily)) return false;
  const name = (item.name || '').toLowerCase();
  return !HEADSHOT_BLOCKED_NAME_KEYWORDS.some(kw => name.includes(kw));
}

/** Base in-game headshot multiplier — community estimate of +50% on head hits. */
const HEADSHOT_BASE_MULTIPLIER = 1.5;

function formatAggregatedStats(totals) {
  const result = {};
  for (const [key, value] of Object.entries(totals)) {
    const precision = key === 'Accuracy' ? 1000 : 10;
    const rounded = Math.round(value * precision) / precision;
    result[key] = formatStatValue(key, rounded);
  }
  return result;
}

function refreshPanels(skipResourceBars) {
  const equipped = aggregateEquippedStats();
  const itemStats = Object.keys(equipped).length > 0 ? formatAggregatedStats(equipped) : null;
  if (!skipResourceBars) renderCharacterPanel(lastCharacterPanel, itemStats);
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

// Expand augment stat names to match item stat names
function expandStatKey(key) {
  if (key === 'Dart Mitigation') return ['Light Dart Mitigation', 'Heavy Dart Mitigation'];
  if (key === 'Damage') return ['Damage Per Shot', 'Damage Per Hit'];
  if (key === 'Shield Damage') return ['Shield Damage Per Shot', 'Shield Damage Per Hit'];
  return [key];
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
  if (augData?.type?.length) icon.classList.add(`augment-type--${augData.type[0].toLowerCase()}`);
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
    if (item && isGradeable && item.scaledStats?.length && item.rarity === 'Unique' && (item.slot !== 'radsuit' || slotType === 'helm')) {
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
    const wType = item?.weaponType;
    const wFamily = item?.weaponFamily;
    source = wType
      ? WEAPON_AUGMENT_DATA.filter(a => {
          const types = (a.type || []).map(t => t.toLowerCase());
          // Generic ranged/melee augments
          if (types.length === 1 && types.includes(wType)) return true;
          // Weapon-family-specific augments
          if (wFamily && types.includes(wFamily.toLowerCase())) return true;
          return false;
        })
      : WEAPON_AUGMENT_DATA;
  } else {
    source = AUGMENT_DATA;
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
  if (aug.type?.length) img.classList.add(`augment-type--${aug.type[0].toLowerCase()}`);
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
    // Show the range for the best available grade
    const bestGrade = [...eff.grades].reverse().find(g => g !== null);
    if (!bestGrade) return;
    const span = document.createElement('span');
    span.className = 'augment-card__effect';
    const statLabel = eff.stat.replace(/:$/, '');
    const suffix = '%';  // NOTE: flat effects arguably shouldn't carry '%' — leaving as-is (changing it alters card text; out of scope here)
    const fmtVal = v => (v >= 0 ? `+${v}` : `${v}`);
    if (bestGrade[0] === bestGrade[1]) {
      span.textContent = `${statLabel}: ${fmtVal(bestGrade[0])}${suffix}`;
    } else {
      span.textContent = `${statLabel}: ${fmtVal(bestGrade[0])}${suffix} to ${fmtVal(bestGrade[1])}${suffix}`;
    }
    effectsEl.appendChild(span);
  });

  (aug.tradeoffs || []).forEach(t => {
    const span = document.createElement('span');
    const statKey = t.stat.replace(/:$/, '');
    const isBuff = LOWER_BETTER_TRADEOFF_STATS.has(statKey) ? t.value < 0 : t.value > 0;
    span.className = isBuff ? 'augment-card__effect' : 'augment-card__tradeoff';
    const fmtVal = v => (v >= 0 ? `+${v}` : `${v}`);
    span.textContent = `${statKey}: ${fmtVal(t.value)}%`;
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
    const g = eff.grades?.[gradeIdx];
    if (!g) return; // stat not available at this grade

    const row = document.createElement('div');
    row.className = 'augment-value-popup__field';

    const label = document.createElement('label');
    label.className = 'augment-value-popup__stat';
    const min = g[0], max = g[1];
    const suffix = eff.type === 'percent' ? '%' : '';
    label.textContent = `${eff.stat.replace(/:$/, '')} (${min}${suffix} – ${max}${suffix})`;

    const input = document.createElement('input');
    input.className = 'augment-value-popup__input';
    input.type = 'number';
    input.step = '0.1';
    input.placeholder = `${min} – ${max}`;
    input.dataset.stat = eff.stat;
    input.dataset.min = String(Math.min(min, max));
    input.dataset.max = String(Math.max(min, max));

    if (customValues[eff.stat] != null) {
      input.value = customValues[eff.stat];
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
  // 1. Bar text (HP/Stamina max may have moved from Combat keystones).
  const sb = getSpecBonuses();
  const baseHp = lastCharacterPanel?.Health
    ? (parseResource(lastCharacterPanel.Health)?.max ?? null)
    : (BASE_STATS.Health > 0 ? BASE_STATS.Health : null);
  if (baseHp != null) updateResourceBarMaxInPlace('Health', baseHp + sb.health);
  const baseStam = lastCharacterPanel?.Stamina
    ? (parseResource(lastCharacterPanel.Stamina)?.max ?? null)
    : (BASE_STATS.Stamina > 0 ? BASE_STATS.Stamina : null);
  if (baseStam != null) updateResourceBarMaxInPlace('Stamina', baseStam + sb.stamina);

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

  // Stats — apply grade scaling if applicable
  let stats = item.stats || [];
  const grade = equippedGrades[slotType] || 0;
  if (grade > 0 && item.scaledStats?.[grade - 1]) {
    stats = mergeBaseWithScaled(stats, item.scaledStats[grade - 1]);
  }

  // Compute augment contributions per stat for this item
  const augEffects = {}; // key -> { min, max, hasCustom }
  const augSlotsForCalc = equippedAugments[slotType] || [];
  augSlotsForCalc.forEach(aug => {
    if (!aug) return;
    const augData = findAugmentData(aug.slug, slotType);
    if (!augData) return;
    const augGrade = aug.grade || 1;
    const gradeIdx = augGrade > 0 ? augGrade - 1 : 0;

    (augData.effects || []).forEach(eff => {
      const g = eff.grades?.[gradeIdx];
      if (!g) return;
      const statKey = eff.stat.replace(/:$/, '');
      const keys = expandStatKey(statKey);
      const customVal = aug.customValues?.[eff.stat];
      // Accuracy is displayed with inverted sign in-game; flip here so the math works.
      const sign = statKey === 'Accuracy' ? -1 : 1;
      keys.forEach(key => {
        if (!augEffects[key]) augEffects[key] = { min: 0, max: 0, hasCustom: true, type: eff.type };
        if (customVal != null) {
          augEffects[key].min += sign * customVal;
          augEffects[key].max += sign * customVal;
        } else {
          augEffects[key].min += sign * g[0];
          augEffects[key].max += sign * g[1];
          augEffects[key].hasCustom = false;
        }
      });
    });

    // Tradeoffs — expand compound keys
    (augData.tradeoffs || []).forEach(t => {
      const statKey = t.stat.replace(/:$/, '');
      const keys = expandStatKey(statKey);
      const isPercent = PERCENT_TRADEOFFS.has(statKey);
      const tradeoffVal = statKey === 'Accuracy' ? -t.value : t.value;
      keys.forEach(key => {
        if (!augEffects[key]) augEffects[key] = { min: 0, max: 0, hasCustom: true, type: isPercent ? 'percent' : 'flat' };
        augEffects[key].min += tradeoffVal;
        augEffects[key].max += tradeoffVal;
      });
    });
  });

  stats.forEach(stat => {
    const row = document.createElement('div');
    row.className = 'stat-row';

    const label = document.createElement('span');
    label.className = 'stat-label';
    label.textContent = stat.name.replace(/:$/, '');

    const value = document.createElement('span');
    value.className = 'stat-value';

    const key = stat.name.replace(/:$/, '');
    const augEff = augEffects[key];
    const baseText = formatStatValue(stat.name, stat.value);

    // Damage multipliers applied as the FINAL stages of the calc chain.
    // Each layer is conditional, so the formula tooltip can list them individually.
    const sb = getSpecBonuses();
    const isDamageKey = SPEC_DAMAGE_KEYS.has(key);
    const combatMul = isDamageKey ? sb.combatDamageMul : 1;
    const staggerMul = isDamageKey ? sb.staggerMul : 1;
    const headshotApplies = isDamageKey && appSettings.applyHeadshot && canHeadshot(item);
    const headshotBaseMul = headshotApplies ? HEADSHOT_BASE_MULTIPLIER : 1;
    // Sabotage Head Hunter — additive on top of the base HS multiplier; only
    // contributes when headshot also applies (it's a HS-conditional bonus).
    const headHunterMul = headshotApplies ? (1 + sb.headHunterBonus) : 1;
    const specMul = combatMul * staggerMul * headshotBaseMul * headHunterMul;
    const hasSpec = specMul !== 1;

    if (augEff || hasSpec) {
      // Accuracy is on a 0–1 scale, so it needs more precision than the default 1-decimal rounding.
      const precision = key === 'Accuracy' ? 1000 : 10;
      const roundP = v => Math.round(v * precision) / precision;
      const applyAug = (base) => {
        if (!augEff) return { min: base, max: base };
        if (augEff.type === 'percent') {
          return {
            min: base * (1 + augEff.min / 100),
            max: base * (1 + augEff.max / 100),
          };
        }
        return { min: base + augEff.min, max: base + augEff.max };
      };
      const { min: augMin, max: augMax } = applyAug(stat.value);
      const finalMin = roundP(augMin * specMul);
      const finalMax = roundP(augMax * specMul);

      const lowerBetter = LOWER_IS_BETTER.has(key);
      const isWorse = lowerBetter ? finalMin > stat.value : finalMax < stat.value;
      const color = isWorse ? 'var(--color-health)' : 'var(--color-stamina)';

      // Overwrite the raw item value with the calculated final value, colored
      // to indicate whether the modifications net-improve or net-degrade the
      // stat. The breakdown is available on hover via the formula tooltip.
      const isRange = augEff && !augEff.hasCustom && augEff.min !== augEff.max;
      value.style.color = color;
      value.textContent = isRange
        ? `${formatStatValue(stat.name, finalMin)}–${formatStatValue(stat.name, finalMax)}`
        : formatStatValue(stat.name, finalMin);

      // Hover on the row → floating formula breakdown.
      const breakdown = {
        name: key,
        statName: stat.name,
        baseValue: stat.value,
        augEff,
        combatMul,
        staggerMul,
        headshotBaseMul,
        headHunterMul,
        specMul, // combined; kept for backwards compatibility / quick checks
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

    row.appendChild(label);
    row.appendChild(value);
    panel.appendChild(row);
  });

  // Meta line — grade + augments
  const meta = document.createElement('div');
  meta.className = 'tooltip-panel__meta';
  const parts = [];

  if (item.scaledStats?.length && grade > 0) {
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
          label.textContent = eff.stat.replace(/:$/, '');

          const value = document.createElement('span');
          value.className = 'stat-value';
          value.style.color = 'var(--color-stamina)';

          const customVal = aug.customValues?.[eff.stat];
          const suffix = eff.type === 'percent' ? '%' : '';
          const fmtAugVal = v => (v >= 0 ? `+${v}` : `${v}`);
          if (customVal != null) {
            value.textContent = `${fmtAugVal(customVal)}${suffix}`;
          } else if (g[0] === g[1]) {
            value.textContent = `${fmtAugVal(g[0])}${suffix}`;
          } else {
            value.textContent = `${fmtAugVal(g[0])}${suffix} to ${fmtAugVal(g[1])}${suffix}`;
          }

          row.appendChild(label);
          row.appendChild(value);
          augSection.appendChild(row);
        });

        (augData.tradeoffs || []).forEach(t => {
          const row = document.createElement('div');
          row.className = 'stat-row';
          const label = document.createElement('span');
          label.className = 'stat-label';
          label.textContent = t.stat.replace(/:$/, '');
          const value = document.createElement('span');
          value.className = 'stat-value';
          const statKey = t.stat.replace(/:$/, '');
          const isBuff = LOWER_BETTER_TRADEOFF_STATS.has(statKey) ? t.value < 0 : t.value > 0;
          value.style.color = isBuff ? 'var(--color-stamina)' : 'var(--color-health)';
          const fmtVal = v => (v >= 0 ? `+${v}` : `${v}`);
          value.textContent = `${fmtVal(t.value)}%`;
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

  if (augData.type?.length) {
    const badge = document.createElement('span');
    badge.className = 'tooltip-panel__badge rarity--unique';
    badge.textContent = augData.type[0];
    nameRow.appendChild(badge);
  }
  panel.appendChild(nameRow);

  // Effects at current grade
  const grade = equipped.grade || 0;
  (augData.effects || []).forEach(eff => {
    const row = document.createElement('div');
    row.className = 'stat-row';

    const label = document.createElement('span');
    label.className = 'stat-label';
    label.textContent = eff.stat.replace(/:$/, '');

    const value = document.createElement('span');
    value.className = 'stat-value';
    value.style.color = 'var(--color-stamina)';

    const gradeIdx = grade > 0 ? grade - 1 : 0;
    const g = eff.grades?.[gradeIdx];
    if (g) {
      const customVal = equipped.customValues?.[eff.stat];
      const suffix = eff.type === 'percent' ? '%' : '';
      const fmtAugVal = v => (v >= 0 ? `+${v}` : `${v}`);
      if (customVal != null) {
        value.textContent = `${fmtAugVal(customVal)}${suffix}`;
      } else if (g[0] === g[1]) {
        value.textContent = `${fmtAugVal(g[0])}${suffix}`;
      } else {
        value.textContent = `${fmtAugVal(g[0])}${suffix} to ${fmtAugVal(g[1])}${suffix}`;
      }
    } else {
      value.textContent = '—';
      value.style.color = 'var(--color-text-dim)';
    }

    row.appendChild(label);
    row.appendChild(value);
    panel.appendChild(row);
  });

  // Tradeoffs
  (augData.tradeoffs || []).forEach(t => {
    const row = document.createElement('div');
    row.className = 'stat-row';

    const label = document.createElement('span');
    label.className = 'stat-label';
    label.textContent = t.stat.replace(/:$/, '');

    const value = document.createElement('span');
    value.className = 'stat-value';
    value.style.color = 'var(--color-health)';
    value.textContent = `${t.value}%`;

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
function showStatFormulaTooltip(b, event) {
  if (!appSettings.showFormulas) return;
  const tip = document.getElementById('stat-formula-tooltip');
  if (!tip) return;
  tip.innerHTML = '';

  const title = document.createElement('div');
  title.className = 'stat-formula-tooltip__title';
  title.textContent = b.name;
  tip.appendChild(title);

  // Symbolic formula line — built from whichever modifiers actually apply, so
  // the user reads "Base × (1 + Aug%) × Combat × Stagger × Headshot" and the
  // values below show each step.
  const augOp = b.augEff
    ? (b.augEff.type === 'percent' ? '× (1 + Aug%)' : '+ Aug')
    : null;
  const formulaParts = ['Base'];
  if (augOp) formulaParts.push(augOp);
  if (b.combatMul !== 1) formulaParts.push('× CombatDMG');
  if (b.staggerMul !== 1) formulaParts.push('× Stagger');
  if (b.headshotBaseMul !== 1) formulaParts.push('× HS');
  if (b.headHunterMul !== 1) formulaParts.push('× SabotageHS');
  const formula = document.createElement('div');
  formula.className = 'stat-formula-tooltip__formula';
  formula.textContent = formulaParts.join(' ') + ' = Final';
  tip.appendChild(formula);

  const addRow = (label, value) => {
    const row = document.createElement('div');
    row.className = 'stat-formula-tooltip__row';
    const l = document.createElement('span'); l.className = 'label'; l.textContent = label;
    const v = document.createElement('span'); v.className = 'value'; v.textContent = value;
    row.appendChild(l); row.appendChild(v);
    tip.appendChild(row);
  };

  addRow('Base', formatStatValue(b.statName, b.baseValue));

  if (b.augEff) {
    const isPct = b.augEff.type === 'percent';
    const fmt = v => {
      const n = Math.round(v * 10) / 10;
      const sign = n >= 0 ? '+' : '';
      return `${sign}${n}${isPct ? '%' : ''}`;
    };
    const range = b.augEff.min === b.augEff.max
      ? fmt(b.augEff.min)
      : `${fmt(b.augEff.min)} to ${fmt(b.augEff.max)}`;
    addRow('Augments', range);
  }

  const fmtMul = m => `×${(Math.round(m * 100) / 100).toFixed(2)}`;
  if (b.combatMul !== 1) addRow('CombatDMG', fmtMul(b.combatMul));
  if (b.staggerMul !== 1) addRow('Stagger', fmtMul(b.staggerMul));
  if (b.headshotBaseMul !== 1) addRow('HS', fmtMul(b.headshotBaseMul));
  if (b.headHunterMul !== 1) addRow('SabotageHS', fmtMul(b.headHunterMul));

  const total = document.createElement('div');
  total.className = 'stat-formula-tooltip__total';
  const tLabel = document.createElement('span'); tLabel.textContent = 'Final';
  const tValue = document.createElement('span');
  tValue.textContent = b.isRange
    ? `${formatStatValue(b.statName, b.finalMin)}–${formatStatValue(b.statName, b.finalMax)}`
    : formatStatValue(b.statName, b.finalMin);
  total.appendChild(tLabel); total.appendChild(tValue);
  tip.appendChild(total);

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
function showFormulaTooltip(label, value, formula, event) {
  if (!appSettings.showFormulas) return;
  const tip = document.getElementById('stat-formula-tooltip');
  if (!tip) return;
  tip.innerHTML = '';

  const title = document.createElement('div');
  title.className = 'stat-formula-tooltip__title';
  title.textContent = label;
  tip.appendChild(title);

  const [generic, computed] = formula.split('\n');

  if (generic) {
    const g = document.createElement('div');
    g.className = 'stat-formula-tooltip__formula';
    g.textContent = generic;
    tip.appendChild(g);
  }

  if (computed) {
    const c = document.createElement('div');
    c.className = 'stat-formula-tooltip__computed';
    c.textContent = computed;
    tip.appendChild(c);
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
  img.src = item.img;
  img.alt = item.name;

  const clearBtn = document.createElement('button');
  clearBtn.className = 'armor-slot__clear';
  clearBtn.textContent = '×';
  clearBtn.title = 'Remove';
  clearBtn.addEventListener('click', e => { e.stopPropagation(); clearSlot(slotEl); });

  slotEl.appendChild(img);
  slotEl.appendChild(clearBtn);

  const slotType = getSlotType(slotEl);
  // A rad suit is rendered on the 'helm' position; its grade ring / augment dots live there.
  if (slotType && GARMENT_SLOTS.has(slotType) && item.scaledStats?.length) {
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
      if (i.weaponType === 'melee' && !weaponTypeFilter.melee) return false;
      if (i.weaponType === 'ranged' && !weaponTypeFilter.ranged) return false;
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
  img.src = item.img;
  img.alt = item.name;
  slotEl.appendChild(img);

  const clearBtn = document.createElement('button');
  clearBtn.className = 'hotbar-slot__clear';
  clearBtn.textContent = '×';
  clearBtn.title = 'Remove';
  clearBtn.addEventListener('click', e => { e.stopPropagation(); clearHotbarSlot(slotEl); });
  slotEl.appendChild(clearBtn);

  // Grade ring for Unique weapons with scaledStats
  if (item.scaledStats?.length) {
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

(async () => {
  await loadGarmentItems();

  document.querySelectorAll('.armor-slot').forEach(slotEl => {
    if (slotEl.classList.contains('slot--null')) return;
    slotEl.addEventListener('click', () => openItemPicker(slotEl));
    const armorSlotType = getSlotType(slotEl);
    slotEl.addEventListener('mouseenter', () => showTooltip(armorSlotType));
    slotEl.addEventListener('mouseleave', clearTooltip);
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
}

function closeAbout() {
  document.getElementById('about-overlay').classList.remove('visible');
}

document.getElementById('app-logo').addEventListener('click', openAbout);
document.getElementById('about-close').addEventListener('click', closeAbout);
document.getElementById('about-overlay').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeAbout();
});

(async () => {
  try {
    const version = await window.electronAPI.getVersion();
    document.getElementById('about-version').textContent = `v${version}`;
  } catch { /* fallback to hardcoded version in HTML */ }
})();

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

  const exportData = { slots };
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

  if (lastCharacterPanel) {
    exportData.characterPanel = {};
    for (const key of RESOURCE_KEYS) {
      if (lastCharacterPanel[key] != null) {
        exportData.characterPanel[key] = lastCharacterPanel[key];
      }
    }
  }

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

function applyBuildData(data) {
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

  if (data.characterPanel) {
    lastCharacterPanel = data.characterPanel;
  }

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
    lastCharacterPanel = null;
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
  if (!hasGear && !lastCharacterPanel) {
    showError('Nothing to export — equip gear or paste a build first.');
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
      if (result.characterPanel) {
        lastCharacterPanel = result.characterPanel;
      }
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

  function setNotes(notes) {
    if (notes) {
      notesPanel.textContent = notes;
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
