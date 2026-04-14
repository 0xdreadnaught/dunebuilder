'use strict';

// =============================================
// CONSTANTS
// =============================================
const EXCLUDED_KEYS = new Set(['Power Pool', 'Armor Value', 'Maximum Power']);
const RESOURCE_KEYS = new Set(['Health', 'Stamina', 'Energy']);
const LABEL_OVERRIDES = { 'Energy': 'Power' };
const STAMINA_REGEN_PCT = 0.25; // ~25% of max stamina per second (estimated)
const STAMINA_REGEN_DELAY = 1.0; // 1.0s delay before regen starts (patch 1.2.10.0)
const BASE_STATS = { Health: 150, Stamina: 100, Energy: 0 }; // Power=0 until power pack equipped
const baseCharacterStats = { Health: 150, Stamina: 100, Energy: 0 };

// =============================================
// PARSING
// =============================================

/**
 * Extracts and parses the JSON block following a named === section header.
 * @param {string} text - Full pasted text
 * @param {string} section - Section title, e.g. "FINAL BUILD TOTALS"
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
  // Check for DuneBuilder export format first
  const duneExport = extractSection(text, 'DUNEBUILDER EXPORT');
  if (duneExport) {
    return { duneExport: true, slots: duneExport.slots || {}, hotbar: duneExport.hotbar || null, characterPanel: duneExport.characterPanel || null, buildTotals: null, skillBonuses: null };
  }

  const buildTotals    = extractSection(text, 'FINAL BUILD TOTALS');
  const characterPanel = extractSection(text, 'CHARACTER PANEL');
  const skillBonuses   = extractSection(text, 'SKILL TREE BONUSES');

  if (!buildTotals && !characterPanel && !skillBonuses) return null;

  if (buildTotals) {
    for (const key of EXCLUDED_KEYS) {
      delete buildTotals[key];
    }
  }

  return { buildTotals, characterPanel, skillBonuses };
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
    row.addEventListener('mouseenter', () => {
      if (appSettings.showFormulas) showFormulaTooltip(label, value, formula);
    });
    row.addEventListener('mouseleave', () => {
      if (appSettings.showFormulas) clearTooltip();
    });
  }

  return row;
}

function createResourceBar(label, { current, max }, cssKey, regenPerSec, regenDelay) {
  const wrapper = document.createElement('div');
  wrapper.className = 'resource-bar-wrapper';

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
  text.textContent = `${Math.round(current)} / ${Math.round(max)}`;

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
          text.textContent = `${Math.round(max)} / ${Math.round(max)}`;
        }, 600);
      }
    });
  });

  // Right-click to edit base value
  wrapper.addEventListener('contextmenu', e => {
    e.preventDefault();
    const dataKey = (cssKey === 'Energy' || label === 'Power') ? 'Energy' : (cssKey || label);
    openResourceValuePopup(label, dataKey, e);
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
    text.textContent = `${Math.round(cur)} / ${Math.round(max)}`;

    if (regenPerSec && cur < max) {
      const delayMs = (regenDelay || 0) * 1000;
      function startRegen() {
        let lastTime = performance.now();
        function tick(now) {
          const dt = (now - lastTime) / 1000;
          lastTime = now;
          cur = Math.min(max, cur + regenPerSec * dt);
          fill.style.width = `${(cur / max) * 100}%`;
          text.textContent = `${Math.round(cur)} / ${Math.round(max)}`;
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

  const powerPool = getEquippedStat('pack', 'power pool');
  const powerRegen = getEquippedStat('pack', 'regen per second');

  let renderedPowerBar = false;
  let renderedHealth = false;
  let renderedStamina = false;

  if (data) {
    for (const [key, value] of Object.entries(data)) {
      if (RESOURCE_KEYS.has(key)) {
        // Replace Energy bar with Power Pool from equipped pack
        if (key === 'Energy' && powerPool !== null) {
          container.appendChild(createResourceBar('Power', { current: powerPool, max: powerPool }, 'Energy', powerRegen));
          renderedPowerBar = true;
          continue;
        }
        const resource = parseResource(value);
        if (resource) {
          const displayLabel = LABEL_OVERRIDES[key] || key;
          const regen = key === 'Stamina' ? resource.max * STAMINA_REGEN_PCT : null;
          const delay = key === 'Stamina' ? STAMINA_REGEN_DELAY : 0;
          container.appendChild(createResourceBar(displayLabel, resource, key, regen, delay));
          if (key === 'Health') renderedHealth = true;
          if (key === 'Stamina') renderedStamina = true;
          continue;
        }
      }
      container.appendChild(createStatRow(key, value));
    }
  }

  // Show base resource bars if not provided by paste data
  if (!renderedHealth && baseCharacterStats.Health > 0) {
    const max = baseCharacterStats.Health;
    container.appendChild(createResourceBar('Health', { current: max, max }, 'Health'));
    renderedHealth = true;
  }
  if (!renderedStamina && baseCharacterStats.Stamina > 0) {
    const max = baseCharacterStats.Stamina;
    const regen = max * STAMINA_REGEN_PCT;
    container.appendChild(createResourceBar('Stamina', { current: max, max }, 'Stamina', regen, STAMINA_REGEN_DELAY));
    renderedStamina = true;
  }

  // Show Power Pool bar — 0/0 if no pack equipped
  if (!renderedPowerBar) {
    const pp = powerPool || baseCharacterStats.Energy || 0;
    container.appendChild(createResourceBar('Power', { current: pp, max: pp }, 'Energy', powerRegen));
  }

  // Remove Power Pool from equipment stats since it's shown as a bar
  if (itemStats && powerPool !== null) {
    delete itemStats['Power Pool'];
  }

  if (itemStats && Object.keys(itemStats).length > 0) {
    const label = document.createElement('div');
    label.className = 'stats-section-label';
    label.textContent = 'Equipment';
    container.appendChild(label);
    for (const [key, value] of Object.entries(itemStats)) {
      container.appendChild(createStatRow(key, value));
    }
  }
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

  const hasShield = !!equippedItems['holtzman'];
  const hasPack   = !!equippedItems['pack'];

  // --- EHP section (red — matches Health) ---
  const ehpHeading = document.createElement('div');
  ehpHeading.className = 'stats-section-label stats-section-label--health';
  ehpHeading.textContent = 'Effective Health Pool (EHP)';
  container.appendChild(ehpHeading);

  const maxHealth = lastCharacterPanel?.Health
    ? (parseResource(lastCharacterPanel.Health)?.max ?? null) : null;

  const totalArmor = equipped['Armor Value'] ?? 0;
  const armorMit = totalArmor > 0 ? (totalArmor / (totalArmor + 500)) * 100 : null;

  const DAMAGE_TYPES = [
    ['vs Light Dart',  'Light Dart Mitigation'],
    ['vs Heavy Dart',  'Heavy Dart Mitigation'],
    ['vs Energy',      'Energy Mitigation'],
    ['vs Blade',       'Blade Mitigation'],
    ['vs Concussive',  'Concussive Mitigation'],
  ];

  const hasArmor  = armorMit !== null;
  const hasHealth = maxHealth !== null;

  if (!hasArmor && !hasHealth) {
    const noData = document.createElement('p');
    noData.className = 'empty-state';
    noData.textContent = 'Equip gear or paste a build to see EHP';
    container.appendChild(noData);
  } else if (!hasHealth) {
    container.appendChild(createStatRow('Armor Mitigation',
      `${Math.round(armorMit * 10) / 10}%`,
      `Armor / (Armor + 500)\n${totalArmor} / (${totalArmor} + 500) = ${(armorMit / 100).toFixed(4)}`));
    const noHp = document.createElement('p');
    noHp.className = 'empty-state';
    noHp.textContent = 'Paste a build to see EHP (need Health)';
    container.appendChild(noHp);
  } else if (!hasArmor) {
    const noArmor = document.createElement('p');
    noArmor.className = 'empty-state';
    noArmor.textContent = 'Equip armor to see EHP';
    container.appendChild(noArmor);
  } else {
    const ehpFromMit = (armorPct, typePct) => {
      const armorMul = Math.max(0.001, 1 - armorPct / 100);
      const typeMul  = 1 - typePct / 100;
      return Math.round(maxHealth / (armorMul * typeMul));
    };

    container.appendChild(createStatRow('Armor Mitigation',
      `${Math.round(armorMit * 10) / 10}%`,
      `Armor / (Armor + 500)\n${totalArmor} / (${totalArmor} + 500) = ${(armorMit / 100).toFixed(4)}`));
    container.appendChild(createStatRow('vs Physical',
      ehpFromMit(armorMit, 0).toLocaleString(),
      `Health / (DMG - ArmorMit%)\n${maxHealth} / (1 - ${(armorMit / 100).toFixed(4)}) = ${ehpFromMit(armorMit, 0)}`));

    DAMAGE_TYPES.forEach(([label, key]) => {
      const gearMit  = equipped[key] ?? 0;
      const pasteMit = lastBuildTotals?.[key] != null
        ? (parseFloat(String(lastBuildTotals[key])) || 0) : 0;
      const totalMit = gearMit + pasteMit;
      if (totalMit === 0) return;
      const armorMul = Math.max(0.001, 1 - armorMit / 100);
      const typeMul  = 1 - totalMit / 100;
      container.appendChild(createStatRow(label,
        ehpFromMit(armorMit, totalMit).toLocaleString(),
        `Health / ((DMG - ArmorMit%) × (DMG - TypeMit%))\n${maxHealth} / (${armorMul.toFixed(4)} × ${typeMul.toFixed(4)}) = ${ehpFromMit(armorMit, totalMit)}`));
    });
  }

  // --- Stamina / Dash section (green — matches Stamina) ---
  const staminaHeading = document.createElement('div');
  staminaHeading.className = 'stats-section-label stats-section-label--stamina';
  staminaHeading.textContent = 'Stamina';
  container.appendChild(staminaHeading);

  const BASE_DASH_COST = 30;
  const maxStamina = lastCharacterPanel?.Stamina
    ? (parseResource(lastCharacterPanel.Stamina)?.max ?? null)
    : null;
  const skillDashRaw = lastSkillBonuses?.['Dash Stamina Cost'];
  const skillDashMod = skillDashRaw != null ? (parseFloat(String(skillDashRaw)) || 0) : 0;
  const gearDashMod  = equipped['Dash Stamina Cost'] ?? 0;
  const effectiveCost = Math.max(1, BASE_DASH_COST * (1 + (skillDashMod + gearDashMod) / 100));

  const totalDashMod = skillDashMod + gearDashMod;
  container.appendChild(createStatRow('Dash Cost', `${Math.round(effectiveCost)}`,
    `BaseCost × (1 + ModTotal%)\n${BASE_DASH_COST} × (1 + ${totalDashMod}%) = ${Math.round(effectiveCost)}`));

  if (maxStamina !== null) {
    const rawDashes = maxStamina / effectiveCost;
    const rawRounded = Math.round(rawDashes * 10) / 10;
    const effectiveDashes = Math.ceil(rawRounded);
    container.appendChild(createStatRow('Max Dashes', `${effectiveDashes} (${rawRounded.toFixed(1)})`,
      `MaxStamina / DashCost\n${maxStamina} / ${Math.round(effectiveCost)} = ${rawRounded.toFixed(1)}`));
  }

  // --- Shield section (blue — matches Power) ---
  const heading = document.createElement('div');
  heading.className = 'stats-section-label stats-section-label--energy';
  heading.textContent = 'Shield';
  container.appendChild(heading);

  if (!hasShield || !hasPack) {
    const p = document.createElement('p');
    p.className = 'empty-state';
    p.textContent = (!hasShield && !hasPack) ? 'Equip a shield and power pack'
                  : !hasShield               ? 'No shield equipped'
                  :                            'No power pack equipped';
    container.appendChild(p);
  } else {
    if (powerPool !== null && powerDrain !== null) {
      const endurance = Math.round(powerPool / (powerDrain / 100));
      container.appendChild(createStatRow('Max Damage Absorbed', endurance.toLocaleString(),
        `PowerPool / (PowerDrain%)\n${powerPool} / ${(powerDrain / 100).toFixed(4)} = ${endurance}`));
    }

    if (powerPool !== null && regenPerSec !== null) {
      const recharge = (powerPool / regenPerSec).toFixed(1);
      container.appendChild(createStatRow('Full Recharge', `${recharge}s`,
        `PowerPool / RegenPerSec\n${powerPool} / ${regenPerSec} = ${recharge}s`));
    }
  }
}

function renderCalculations() {
  const container = document.getElementById('build-stats');
  container.innerHTML = '';

  const equipped = aggregateEquippedStats();

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

// =============================================
// ITEM PICKER
// =============================================

let GARMENT_ITEMS = [];
let WEAPON_ITEMS = [];
let AUGMENT_DATA = [];
let WEAPON_AUGMENT_DATA = [];
let lastCharacterPanel = null;
let lastBuildTotals = null;
let lastSkillBonuses = null;
let currentPickerItems = [];
let currentPickerSlotType = null;
const appSettings = loadSettings();

function loadSettings() {
  try {
    const saved = localStorage.getItem('dunebuilder-settings');
    if (saved) return { showCommons: false, showFormulas: false, showT0: false, showT1: false, showT2: false, showT3: false, showT4: false, showT5: false, showWeaponCommons: false, showWeaponT1: false, showWeaponT2: false, showWeaponT3: false, showWeaponT4: false, showWeaponT5: false, persistWeaponTypeFilter: false, ...JSON.parse(saved) };
  } catch { /* ignore corrupt data */ }
  return { showCommons: false, showFormulas: false, showT0: false, showT1: false, showT2: false, showT3: false, showT4: false, showT5: false, showWeaponCommons: false, showWeaponT1: false, showWeaponT2: false, showWeaponT3: false, showWeaponT4: false, showWeaponT5: false, persistWeaponTypeFilter: false };
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

function formatStatValue(name, value) {
  if (typeof value !== 'number') return String(value);
  const n = name.toLowerCase().replace(/:$/, '');
  if (FLAT_STATS.has(n)) return String(value);
  return `${value}%`;
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
      fetch('./items_garment_t6.json'),
      fetch('./items_garment_t5.json'),
      fetch('./items_garment_t4.json'),
      fetch('./items_garment_t3.json'),
      fetch('./items_garment_t2.json'),
      fetch('./items_garment_t1.json'),
      fetch('./items_utility.json'),
      fetch('./augments_garment.json'),
      fetch('./items_weapon_t6.json'),
      fetch('./items_weapon_t5.json'),
      fetch('./items_weapon_t4.json'),
      fetch('./items_weapon_t3.json'),
      fetch('./items_weapon_t2.json'),
      fetch('./items_weapon_t1.json'),
      fetch('./augments_melee.json'),
      fetch('./augments_ranged.json'),
    ]);
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
    const grade = equippedGrades[slotType] || 0;
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
    const augSlots = equippedAugments[slotType];
    if (augSlots) {
      augSlots.forEach(aug => {
        if (!aug || !aug.slug) return;
        const augData = findAugmentData(aug.slug, slotType);
        if (!augData) return;
        const augGrade = aug.grade || 1;

        (augData.effects || []).forEach(eff => {
          const gradeData = eff.grades[augGrade - 1];
          if (!gradeData) return;
          const keys = expandStatKey(eff.stat.replace(/:$/, ''));
          const customVal = aug.customValues?.[eff.stat];
          const effectVal = customVal != null ? customVal : gradeData[1];

          keys.forEach(key => {
            const baseVal = itemStats[key] || 0;
            if (baseVal === 0) return; // Don't apply to stats the item doesn't have
            if (eff.type === 'percent') {
              itemStats[key] = baseVal * (1 + effectVal / 100);
            } else {
              itemStats[key] = baseVal + effectVal;
            }
          });
        });

        // Tradeoffs apply to the item
        const PERCENT_TRADEOFFS = new Set(['Volume', 'Rate of Fire', 'Reload Time', 'Recoil', 'Power Consumption (per shot)']);
        (augData.tradeoffs || []).forEach(t => {
          const keys = expandStatKey(t.stat.replace(/:$/, ''));
          const isPercent = PERCENT_TRADEOFFS.has(t.stat.replace(/:$/, ''));
          keys.forEach(key => {
            const baseVal = itemStats[key] || 0;
            if (isPercent) {
              itemStats[key] = baseVal * (1 + t.value / 100);
            } else {
              itemStats[key] = baseVal + t.value;
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

  return totals;
}

function formatAggregatedStats(totals) {
  const result = {};
  for (const [key, value] of Object.entries(totals)) {
    const rounded = Math.round(value * 10) / 10;
    result[key] = formatStatValue(key, rounded);
  }
  return result;
}

function refreshPanels(skipResourceBars) {
  const equipped = aggregateEquippedStats();
  const itemStats = Object.keys(equipped).length > 0 ? formatAggregatedStats(equipped) : null;
  if (!skipResourceBars) renderCharacterPanel(lastCharacterPanel, itemStats);
  renderCalculations();
}

function renderPickerItems(items, slotType) {
  const list = document.getElementById('item-picker-list');
  list.innerHTML = '';
  if (items.length === 0) {
    list.innerHTML = '<p class="empty-state">No items found.</p>';
    return;
  }
  items.forEach(item => {
    const card = createItemCard(item, slotType);
    if (equippedItems[slotType]?.slug === item.slug) card.classList.add('item-card--equipped');
    list.appendChild(card);
  });
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

  const item = GARMENT_ITEMS.find(i => i.slug === slug);
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

function createGradeRing(slotType) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 42 42');
  svg.classList.add('armor-slot__grade');

  // Block clicks anywhere on the ring SVG from opening the item picker
  svg.addEventListener('click', e => e.stopPropagation());

  const cx = 21, cy = 21, r = 16;

  // Background circle — visible when expanded for readability
  const bg = document.createElementNS(NS, 'circle');
  bg.setAttribute('cx', String(cx));
  bg.setAttribute('cy', String(cy));
  bg.setAttribute('r', String(cx));
  bg.classList.add('grade-bg');
  svg.appendChild(bg);

  const segCount = 5;
  const gapDeg = 8;
  const sliceDeg = 360 / segCount;            // 72° per pie slice (hit zone)
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
      const clicked = i + 1;
      equippedGrades[slotType] = (equippedGrades[slotType] === clicked) ? 0 : clicked;
      updateGradeSegments(svg, slotType);
      refreshPanels(HOTBAR_SLOTS.has(slotType));
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

    const grade = equippedGrades[slotType] || 0;
    if (i + 1 <= grade) arc.classList.add('active');

    // Hit zone first, then arc — so CSS `+` sibling selector works
    svg.appendChild(hitzone);
    svg.appendChild(arc);
  }

  // Grade number in center
  const text = document.createElementNS(NS, 'text');
  text.classList.add('grade-number');
  text.setAttribute('x', String(cx));
  text.setAttribute('y', String(cy));
  text.setAttribute('font-size', '20');
  text.textContent = '';
  svg.appendChild(text);

  const grade = equippedGrades[slotType] || 0;
  if (grade > 0) text.textContent = String(grade);
  svg.classList.toggle('grade--max', grade === 5);

  attachGradeHover(svg);
  return svg;
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
    return WEAPON_AUGMENT_DATA.find(a => a.slug === slug) || AUGMENT_DATA.find(a => a.slug === slug);
  }
  return AUGMENT_DATA.find(a => a.slug === slug);
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
  dot.appendChild(createAugmentGradeRing(slotType, dotIndex, augment));

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

  // Ctrl+click to swap augment (works regardless of grade ring state)
  dot.addEventListener('click', e => {
    e.stopPropagation();
    if (e.ctrlKey) { openAugmentPicker(slotType, dotIndex); return; }
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

function createAugmentGradeRing(slotType, dotIndex, augment) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 22 22');
  svg.classList.add('augment-dot__grade');

  svg.addEventListener('click', e => e.stopPropagation());

  const cx = 11, cy = 11, r = 8;

  // Background circle — visible when expanded
  const bg = document.createElementNS(NS, 'circle');
  bg.setAttribute('cx', String(cx));
  bg.setAttribute('cy', String(cy));
  bg.setAttribute('r', String(cx));
  bg.classList.add('grade-bg');
  svg.appendChild(bg);

  const segCount = 5;
  const gapDeg = 10;
  const sliceDeg = 360 / segCount;
  const segDeg = sliceDeg - gapDeg;

  for (let i = 0; i < segCount; i++) {
    const sliceStart = -90 + i * sliceDeg;
    const arcStart = sliceStart + gapDeg / 2;
    const arcEnd = arcStart + segDeg;

    // Hit zone (full wedge to SVG edge)
    const hr = cx;
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
      if (e.ctrlKey) { openAugmentPicker(slotType, dotIndex); return; }
      const clicked = i + 1;
      const aug = equippedAugments[slotType]?.[dotIndex];
      if (!aug) return;
      aug.grade = (aug.grade === clicked) ? 1 : clicked;
      refreshAugmentDots(slotType, dotIndex);
      refreshPanels(HOTBAR_SLOTS.has(slotType));
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

    const grade = augment.grade || 0;
    if (i + 1 <= grade) arc.classList.add('active');

    svg.appendChild(hitzone);
    svg.appendChild(arc);
  }

  const grade = augment.grade || 1;
  svg.classList.toggle('grade--max', grade === 5);

  attachGradeHover(svg);
  return svg;
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
    if (item && isGradeable && item.slot !== 'radsuit' && item.scaledStats?.length && item.rarity === 'Unique') {
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
  if (augments.length === 0) {
    list.innerHTML = '<p class="empty-state">No augments found.</p>';
    return;
  }
  augments.forEach(aug => {
    list.appendChild(createAugmentCard(aug));
  });
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
    const suffix = eff.type === 'percent' ? '%' : '%';
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
    span.className = 'augment-card__tradeoff';
    const statLabel = t.stat.replace(/:$/, '');
    span.textContent = `${statLabel}: ${t.value}%`;
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

// =============================================
// RESOURCE VALUE POPUP
// =============================================

let activeResourceKey = null;

function openResourceValuePopup(label, dataKey, event) {
  activeResourceKey = dataKey;
  const popup = document.getElementById('resource-value-popup');
  const input = document.getElementById('resource-value-input');
  const labelEl = document.getElementById('resource-value-label');

  labelEl.textContent = `Base ${label}`;
  input.value = baseCharacterStats[dataKey] || '';

  popup.hidden = false;
  popup.style.left = `${event.clientX}px`;
  popup.style.top = `${event.clientY}px`;

  requestAnimationFrame(() => {
    const rect = popup.getBoundingClientRect();
    if (rect.right > window.innerWidth) popup.style.left = `${window.innerWidth - rect.width - 8}px`;
    if (rect.bottom > window.innerHeight) popup.style.top = `${window.innerHeight - rect.height - 8}px`;
  });

  input.focus();
  input.select();
}

function closeResourceValuePopup() {
  document.getElementById('resource-value-popup').hidden = true;
  activeResourceKey = null;
}

function saveResourceValue() {
  if (!activeResourceKey) { closeResourceValuePopup(); return; }
  const input = document.getElementById('resource-value-input');
  const val = parseFloat(input.value);
  if (!isNaN(val) && val >= 0) {
    baseCharacterStats[activeResourceKey] = val;
  }
  closeResourceValuePopup();
  refreshPanels();
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
// TOOLTIP PANEL
// =============================================

function showTooltip(slotType) {
  const item = equippedItems[slotType];
  if (!item) return;
  if (tooltipClearTimer) { clearTimeout(tooltipClearTimer); tooltipClearTimer = null; }

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
      const keys = expandStatKey(eff.stat.replace(/:$/, ''));
      const customVal = aug.customValues?.[eff.stat];
      keys.forEach(key => {
        if (!augEffects[key]) augEffects[key] = { min: 0, max: 0, hasCustom: true, type: eff.type };
        if (customVal != null) {
          augEffects[key].min += customVal;
          augEffects[key].max += customVal;
        } else {
          augEffects[key].min += g[0];
          augEffects[key].max += g[1];
          augEffects[key].hasCustom = false;
        }
      });
    });

    // Tradeoffs — expand compound keys
    const PERCENT_TRADEOFFS = new Set(['Volume', 'Rate of Fire', 'Reload Time', 'Recoil', 'Power Consumption (per shot)']);
    (augData.tradeoffs || []).forEach(t => {
      const keys = expandStatKey(t.stat.replace(/:$/, ''));
      const isPercent = PERCENT_TRADEOFFS.has(t.stat.replace(/:$/, ''));
      keys.forEach(key => {
        if (!augEffects[key]) augEffects[key] = { min: 0, max: 0, hasCustom: true, type: isPercent ? 'percent' : 'flat' };
        augEffects[key].min += t.value;
        augEffects[key].max += t.value;
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

    if (augEff) {
      const applyAug = (base, augVal) => {
        if (augEff.type === 'percent') return Math.round(base * (1 + augVal / 100) * 10) / 10;
        return Math.round((base + augVal) * 10) / 10;
      };
      const finalMin = applyAug(stat.value, augEff.min);
      const finalMax = applyAug(stat.value, augEff.max);
      const LOWER_IS_BETTER = new Set([
        'Attack Stamina Cost', 'Block Stamina Cost', 'Dash Stamina Cost',
        'Climbing Stamina Cost', 'Recoil', 'Projectile spread', 'Volume',
        'Reload Time', 'Power Consumption', 'Power Consumption (per shot)',
        'Accuracy', 'Power Drain', 'Sun Stroke Rate',
      ]);
      const lowerBetter = LOWER_IS_BETTER.has(key);
      const isWorse = lowerBetter ? finalMin > stat.value : finalMax < stat.value;
      const color = isWorse ? 'var(--color-health)' : 'var(--color-stamina)';

      const isRange = !augEff.hasCustom && augEff.min !== augEff.max;
      if (isRange) {
        value.innerHTML = `${baseText} <span style="color:${color}">(${formatStatValue(stat.name, finalMin)}–${formatStatValue(stat.name, finalMax)})</span>`;
      } else {
        value.innerHTML = `${baseText} <span style="color:${color}">(${formatStatValue(stat.name, finalMin)})</span>`;
      }
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
          value.style.color = 'var(--color-health)';
          value.textContent = `${t.value}%`;
          row.appendChild(label);
          row.appendChild(value);
          augSection.appendChild(row);
        });
      });

      panel.appendChild(augSection);
    }
  }
}

function showAugmentTooltip(slotType, dotIndex) {
  const equipped = equippedAugments[slotType]?.[dotIndex];
  if (!equipped) return;

  const augData = findAugmentData(equipped.slug, slotType);
  if (!augData) return;
  if (tooltipClearTimer) { clearTimeout(tooltipClearTimer); tooltipClearTimer = null; }

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

function showFormulaTooltip(label, value, formula) {
  if (tooltipClearTimer) { clearTimeout(tooltipClearTimer); tooltipClearTimer = null; }
  const panel = document.getElementById('tooltip-panel');
  panel.style.flex = '';
  panel.innerHTML = '';

  const nameEl = document.createElement('div');
  nameEl.className = 'tooltip-panel__name';
  nameEl.textContent = label;
  panel.appendChild(nameEl);

  // Split formula on \n — first line is generic formula, second is with values
  const lines = formula.split('\n');

  const genericEl = document.createElement('div');
  genericEl.className = 'tooltip-panel__formula tooltip-panel__formula--generic';
  genericEl.textContent = lines[0];
  panel.appendChild(genericEl);

  if (lines[1]) {
    const computedEl = document.createElement('div');
    computedEl.className = 'tooltip-panel__formula tooltip-panel__formula--computed';
    computedEl.textContent = lines[1];
    panel.appendChild(computedEl);
  }
}

let tooltipClearTimer = null;

function clearTooltip() {
  tooltipClearTimer = setTimeout(() => {
    document.getElementById('build-stats').hidden = false;
    const panel = document.getElementById('tooltip-panel');
    panel.style.flex = '';
    panel.innerHTML = '<div class="tooltip-panel__empty">Hover an item to inspect</div>';
  }, 100);
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
  if (slotType && GARMENT_SLOTS.has(slotType) && item.slot !== 'radsuit' && item.scaledStats?.length) {
    slotEl.appendChild(createGradeRing(slotType));
    // Augment dots only for Unique garments
    if (item.rarity === 'Unique') {
      if (!augmentSlotUnlocks[slotType]) augmentSlotUnlocks[slotType] = 1;
      if (!equippedAugments[slotType]) equippedAugments[slotType] = [null, null, null];
      slotEl.appendChild(createAugmentDots(slotType));
    }
  }

  slotEl.addEventListener('mouseenter', () => showTooltip(slotType));
  slotEl.addEventListener('mouseleave', clearTooltip);
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
  currentPickerItems = getFilteredWeaponItems();
  const query = document.getElementById('item-picker-search').value.toLowerCase();
  const filtered = query ? currentPickerItems.filter(i => i.name.toLowerCase().includes(query)) : currentPickerItems;
  renderPickerItems(filtered, currentPickerSlotType);
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
  const item = WEAPON_ITEMS.find(i => i.slug === slug);
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
    slotEl.appendChild(createGradeRing(slotType));
    if (item.rarity === 'Unique') {
      if (!augmentSlotUnlocks[slotType]) augmentSlotUnlocks[slotType] = 1;
      if (!equippedAugments[slotType]) equippedAugments[slotType] = [null, null, null];
      slotEl.appendChild(createAugmentDots(slotType));
    }
  }

  slotEl.addEventListener('mouseenter', () => showTooltip(slotType));
  slotEl.addEventListener('mouseleave', clearTooltip);
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
  });

  // Hotbar slot click → weapon picker
  document.querySelectorAll('.hotbar-slot').forEach(slotEl => {
    slotEl.addEventListener('click', e => {
      // Don't open picker if clicking clear button, grade ring, or augment dots
      if (e.target.closest('.hotbar-slot__clear, .armor-slot__grade, .augment-dots')) return;
      openHotbarPicker(slotEl);
    });
  });

  document.getElementById('item-picker-close').addEventListener('click', closeItemPicker);

  document.getElementById('item-picker-overlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeItemPicker();
  });

  document.getElementById('item-picker-search').addEventListener('input', e => {
    const query = e.target.value.toLowerCase();
    const filtered = currentPickerItems.filter(i => i.name.toLowerCase().includes(query));
    renderPickerItems(filtered, currentPickerSlotType);
  });

  // Augment picker events
  document.getElementById('augment-picker-close').addEventListener('click', closeAugmentPicker);

  document.getElementById('augment-picker-overlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeAugmentPicker();
  });

  document.getElementById('augment-picker-search').addEventListener('input', e => {
    const query = e.target.value.toLowerCase();
    const available = getAvailableAugments(currentAugmentSlotType, currentAugmentDotIndex);
    const filtered = available.filter(a => a.name.toLowerCase().includes(query));
    renderAugmentPickerItems(filtered);
  });

  // Augment custom value popup events
  document.getElementById('augment-value-save').addEventListener('click', saveAugmentCustomValue);
  document.getElementById('augment-value-cancel').addEventListener('click', closeAugmentValuePopup);

  // Resource value popup events
  document.getElementById('resource-value-save').addEventListener('click', saveResourceValue);
  document.getElementById('resource-value-cancel').addEventListener('click', closeResourceValuePopup);
  document.getElementById('resource-value-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') saveResourceValue();
    if (e.key === 'Escape') closeResourceValuePopup();
  });

  // Close popups on outside click
  document.addEventListener('mousedown', e => {
    const augPopup = document.getElementById('augment-value-popup');
    if (!augPopup.hidden && !augPopup.contains(e.target)) {
      closeAugmentValuePopup();
    }
    const resPopup = document.getElementById('resource-value-popup');
    if (!resPopup.hidden && !resPopup.contains(e.target)) {
      closeResourceValuePopup();
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

document.getElementById('setting-show-commons').checked = appSettings.showCommons;
document.getElementById('setting-show-commons').addEventListener('change', e => {
  appSettings.showCommons = e.target.checked;
  saveSettings();
});

document.getElementById('setting-show-formulas').checked = appSettings.showFormulas;
document.getElementById('setting-show-formulas').addEventListener('change', e => {
  appSettings.showFormulas = e.target.checked;
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

document.getElementById('setting-persist-weapon-filter').checked = appSettings.persistWeaponTypeFilter;
document.getElementById('setting-persist-weapon-filter').addEventListener('change', e => {
  appSettings.persistWeaponTypeFilter = e.target.checked;
  saveSettings();
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
  exportData.baseStats = { ...baseCharacterStats };

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
  // Restore base stats if saved, otherwise reset to defaults
  if (data.baseStats) {
    Object.assign(baseCharacterStats, data.baseStats);
  } else {
    baseCharacterStats.Health = BASE_STATS.Health;
    baseCharacterStats.Stamina = BASE_STATS.Stamina;
    baseCharacterStats.Energy = BASE_STATS.Energy;
  }

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
    const item = GARMENT_ITEMS.find(i => i.slug === slotData.item);
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
      const item = WEAPON_ITEMS.find(i => i.slug === slotData.item);
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
    lastBuildTotals = null;
    lastSkillBonuses = null;
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
    } else if (result.duneExport) {
      applyBuildData(result);
      if (result.characterPanel) {
        lastCharacterPanel = result.characterPanel;
      }
      refreshPanels();
      triggerRevealAnimation();
    } else {
      lastCharacterPanel = result.characterPanel;
      lastBuildTotals    = result.buildTotals;
      lastSkillBonuses   = result.skillBonuses;
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
// UPDATE CHECK
// =============================================

(async () => {
  try {
    const update = await window.electronAPI.checkForUpdate();
    if (!update) return;

    const banner = document.getElementById('update-banner');
    document.getElementById('update-text').textContent = `v${update.version} available`;
    document.getElementById('update-download').addEventListener('click', () => {
      window.electronAPI.openExternal(update.url);
    });
    document.getElementById('update-dismiss').addEventListener('click', () => {
      banner.hidden = true;
    });

    // What's New toggle
    const notesPanel = document.getElementById('update-notes');
    const notesToggle = document.getElementById('update-notes-toggle');
    if (update.notes) {
      notesPanel.textContent = update.notes;
      notesToggle.addEventListener('click', () => {
        const showing = !notesPanel.hidden;
        notesPanel.hidden = showing;
        notesToggle.textContent = showing ? "What's New" : 'Hide Notes';
      });
    } else {
      notesToggle.hidden = true;
    }

    banner.hidden = false;
  } catch { /* silent fail — update check is non-critical */ }
})();
