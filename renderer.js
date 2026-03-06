'use strict';

// =============================================
// CONSTANTS
// =============================================
const EXCLUDED_KEYS = new Set(['Power Pool', 'Armor Value', 'Maximum Power']);
const RESOURCE_KEYS = new Set(['Health', 'Stamina', 'Energy']);
const LABEL_OVERRIDES = { 'Energy': 'Power' };

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
    return { duneExport: true, slots: duneExport.slots || {}, characterPanel: duneExport.characterPanel || null, buildTotals: null, skillBonuses: null };
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

function createStatRow(label, value) {
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
  return row;
}

function createResourceBar(label, { current, max }, cssKey) {
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

  return wrapper;
}

// =============================================
// RENDERING
// =============================================

function renderCharacterPanel(data, itemStats) {
  const container = document.getElementById('character-stats');
  container.innerHTML = '';

  const powerPool = getEquippedStat('pack', 'power pool');

  if (!data && !itemStats && powerPool === null) {
    container.innerHTML = '<p class="empty-state">Paste a build to see stats</p>';
    return;
  }

  let renderedPowerBar = false;

  if (data) {
    for (const [key, value] of Object.entries(data)) {
      if (RESOURCE_KEYS.has(key)) {
        // Replace Energy bar with Power Pool from equipped pack
        if (key === 'Energy' && powerPool !== null) {
          container.appendChild(createResourceBar('Power', { current: powerPool, max: powerPool }, 'Energy'));
          renderedPowerBar = true;
          continue;
        }
        const resource = parseResource(value);
        if (resource) {
          const displayLabel = LABEL_OVERRIDES[key] || key;
          container.appendChild(createResourceBar(displayLabel, resource, key));
          continue;
        }
      }
      container.appendChild(createStatRow(key, value));
    }
  }

  // Show Power Pool bar even without character panel data
  if (!renderedPowerBar && powerPool !== null) {
    container.appendChild(createResourceBar('Power', { current: powerPool, max: powerPool }, 'Energy'));
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
      `${Math.round(armorMit * 10) / 10}%`));
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
      `${Math.round(armorMit * 10) / 10}%`));
    container.appendChild(createStatRow('vs Physical',
      ehpFromMit(armorMit, 0).toLocaleString()));

    DAMAGE_TYPES.forEach(([label, key]) => {
      const gearMit  = equipped[key] ?? 0;
      const pasteMit = lastBuildTotals?.[key] != null
        ? (parseFloat(String(lastBuildTotals[key])) || 0) : 0;
      const totalMit = gearMit + pasteMit;
      if (totalMit === 0) return;
      container.appendChild(createStatRow(label,
        ehpFromMit(armorMit, totalMit).toLocaleString()));
    });
  }

  // --- Stamina / Dash section (green — matches Stamina) ---
  const staminaHeading = document.createElement('div');
  staminaHeading.className = 'stats-section-label stats-section-label--stamina';
  staminaHeading.textContent = 'Stamina';
  container.appendChild(staminaHeading);

  const BASE_DASH_COST = 32;
  const maxStamina = lastCharacterPanel?.Stamina
    ? (parseResource(lastCharacterPanel.Stamina)?.max ?? null)
    : null;
  const skillDashRaw = lastSkillBonuses?.['Dash Stamina Cost'];
  const skillDashMod = skillDashRaw != null ? (parseFloat(String(skillDashRaw)) || 0) : 0;
  const gearDashMod  = equipped['Dash Stamina Cost'] ?? 0;
  const effectiveCost = Math.max(1, BASE_DASH_COST * (1 + (skillDashMod + gearDashMod) / 100));

  container.appendChild(createStatRow('Dash Cost', `${Math.round(effectiveCost)}`));

  if (maxStamina !== null) {
    const rawDashes = maxStamina / effectiveCost;
    const rawRounded = Math.round(rawDashes * 10) / 10;
    const effectiveDashes = Math.ceil(rawRounded);
    container.appendChild(createStatRow('Max Dashes', `${effectiveDashes} (${rawRounded.toFixed(1)})`));
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
      container.appendChild(createStatRow('Max Damage Absorbed', endurance.toLocaleString()));
    }

    if (powerPool !== null && regenPerSec !== null) {
      const recharge = (powerPool / regenPerSec).toFixed(1);
      container.appendChild(createStatRow('Full Recharge', `${recharge}s`));
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
let AUGMENT_DATA = [];
let lastCharacterPanel = null;
let lastBuildTotals = null;
let lastSkillBonuses = null;
let currentPickerItems = [];
let currentPickerSlotType = null;
const appSettings = loadSettings();

function loadSettings() {
  try {
    const saved = localStorage.getItem('dunebuilder-settings');
    if (saved) return { showCommons: true, ...JSON.parse(saved) };
  } catch { /* ignore corrupt data */ }
  return { showCommons: true };
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

function getSlotClass(slotEl) {
  return [...slotEl.classList].find(c => c.startsWith('slot--'));
}

function getSlotType(slotEl) {
  const cls = getSlotClass(slotEl);
  return cls ? (SLOT_TYPE_MAP[cls] ?? null) : null;
}

function formatStatValue(name, value) {
  if (typeof value !== 'number') return String(value);
  const n = name.toLowerCase();
  if (
    n.includes('armor value') ||
    n.includes('heat protection') ||
    n.includes('max stack') ||
    n.includes('volume') ||
    n.includes('power pool') ||
    n.includes('regen per second') ||
    n.includes('power drain') ||
    n.includes('shield refresh time')
  ) {
    return String(value);
  }
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
    const [garmentRes, utilityRes, augmentRes] = await Promise.all([
      fetch('./items_garment_t6.json'),
      fetch('./items_utility.json'),
      fetch('./augments_garment.json'),
    ]);
    const garments = await garmentRes.json();
    const utility = await utilityRes.json();
    AUGMENT_DATA = await augmentRes.json();

    const withSlots = utility
      .map(item => {
        const slot = assignUtilitySlot(item.slug);
        return slot ? { ...item, slot } : null;
      })
      .filter(Boolean);

    GARMENT_ITEMS = [...garments, ...withSlots];
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
  nameEl.textContent = item.name;

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
  const seen = new Set();

  // Base + grade stats from items
  Object.entries(equippedItems).forEach(([slotType, item]) => {
    if (seen.has(item.slug)) return;
    seen.add(item.slug);
    const grade = equippedGrades[slotType] || 0;
    const stats = (grade > 0 && item.scaledStats?.[grade - 1] && Object.keys(item.scaledStats[grade - 1]).length > 0)
      ? mergeBaseWithScaled(item.stats, item.scaledStats[grade - 1])
      : item.stats;
    (stats || []).forEach(stat => {
      if (typeof stat.value !== 'number') return;
      const key = stat.name.replace(/:$/, '');
      totals[key] = (totals[key] || 0) + stat.value;
    });
  });

  // Layer augment effects on top
  const augmentDetails = []; // for rendering in Character Panel
  Object.entries(equippedAugments).forEach(([slotType, slots]) => {
    if (!slots) return;
    slots.forEach((aug, idx) => {
      if (!aug || !aug.slug) return;
      const augData = AUGMENT_DATA.find(a => a.slug === aug.slug);
      if (!augData) return;
      const grade = aug.grade || 1;

      // Apply effects
      (augData.effects || []).forEach(eff => {
        const gradeData = eff.grades[grade - 1];
        if (!gradeData) return;

        const key = eff.stat.replace(/:$/, '');
        const baseVal = totals[key] || 0;

        if (aug.customValues != null) {
          // Custom value overrides the effect
          if (eff.type === 'percent') {
            totals[key] = baseVal * (1 + aug.customValues / 100);
          } else {
            totals[key] = (totals[key] || 0) + aug.customValues;
          }
        } else {
          // Use max of range by default
          const effectVal = gradeData[1];
          if (eff.type === 'percent') {
            // Percent augments multiply the base stat
            totals[key] = baseVal * (1 + effectVal / 100);
          } else {
            totals[key] = (totals[key] || 0) + effectVal;
          }
        }
      });

      // Apply tradeoffs (always flat, always active when augment is equipped with grade > 0)
      (augData.tradeoffs || []).forEach(t => {
        const key = t.stat.replace(/:$/, '');
        totals[key] = (totals[key] || 0) + t.value;
      });
    });
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

function refreshPanels() {
  const equipped = aggregateEquippedStats();
  const itemStats = Object.keys(equipped).length > 0 ? formatAggregatedStats(equipped) : null;
  renderCharacterPanel(lastCharacterPanel, itemStats);
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
    if (a.rarity !== b.rarity) return a.rarity === 'Unique' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  if (!appSettings.showCommons) {
    currentPickerItems = currentPickerItems.filter(i => i.rarity !== 'Common');
  }
  currentPickerSlotType = slotType;

  renderPickerItems(currentPickerItems, slotType);

  const overlay = document.getElementById('item-picker-overlay');
  requestAnimationFrame(() => requestAnimationFrame(() => overlay.classList.add('visible')));
}

function closeItemPicker() {
  document.getElementById('item-picker-overlay').classList.remove('visible');
  document.getElementById('item-picker-search').value = '';
}

function selectItem(slotType, slug) {
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
      refreshPanels();
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

function createAppliedAugmentDot(slotType, dotIndex, augment) {
  const dot = document.createElement('div');
  dot.className = 'augment-dot augment-dot--applied';

  const augData = AUGMENT_DATA.find(a => a.slug === augment.slug);
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
    clearTooltip();
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
      refreshPanels();
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
  refreshPanels();
}

function removeAugment(slotType, dotIndex) {
  if (equippedAugments[slotType]) {
    equippedAugments[slotType][dotIndex] = null;
  }
  refreshAugmentDots(slotType);
  refreshPanels();
}

function refreshAugmentDots(slotType, expandDotIndex) {
  document.querySelectorAll('.armor-slot').forEach(slotEl => {
    if (getSlotType(slotEl) !== slotType) return;
    const existing = slotEl.querySelector('.augment-dots');
    if (existing) existing.remove();
    const item = equippedItems[slotType];
    if (item && GARMENT_SLOTS.has(slotType) && item.slot !== 'radsuit' && item.scaledStats?.length && item.rarity === 'Unique') {
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

function openAugmentPicker(slotType, dotIndex) {
  currentAugmentSlotType = slotType;
  currentAugmentDotIndex = dotIndex;

  const slotLabel = SLOT_LABEL_MAP[slotType] || slotType;
  document.getElementById('augment-picker-title').textContent = `Augment — ${slotLabel} Slot ${dotIndex + 1}`;
  document.getElementById('augment-picker-search').value = '';

  renderAugmentPickerItems(AUGMENT_DATA);

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
    span.textContent = `${statLabel}: +${bestGrade[0]}${suffix} – ${bestGrade[1]}${suffix}`;
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
  refreshPanels();
}

// =============================================
// AUGMENT CUSTOM VALUE POPUP
// =============================================

let activeAugmentPopup = { slotType: null, dotIndex: null };

function openAugmentValuePopup(slotType, dotIndex, event) {
  const aug = equippedAugments[slotType]?.[dotIndex];
  if (!aug) return;

  activeAugmentPopup = { slotType, dotIndex };

  const popup = document.getElementById('augment-value-popup');
  const input = document.getElementById('augment-value-input');

  // Pre-fill with current custom value or empty
  input.value = aug.customValues != null ? aug.customValues : '';

  popup.hidden = false;
  popup.style.left = `${event.clientX}px`;
  popup.style.top = `${event.clientY}px`;

  // Keep popup in viewport
  requestAnimationFrame(() => {
    const rect = popup.getBoundingClientRect();
    if (rect.right > window.innerWidth) popup.style.left = `${window.innerWidth - rect.width - 8}px`;
    if (rect.bottom > window.innerHeight) popup.style.top = `${window.innerHeight - rect.height - 8}px`;
  });

  input.focus();
  input.select();
}

function closeAugmentValuePopup() {
  document.getElementById('augment-value-popup').hidden = true;
  activeAugmentPopup = { slotType: null, dotIndex: null };
}

function saveAugmentCustomValue() {
  const { slotType, dotIndex } = activeAugmentPopup;
  const aug = equippedAugments[slotType]?.[dotIndex];
  if (!aug) { closeAugmentValuePopup(); return; }

  const input = document.getElementById('augment-value-input');
  const val = parseFloat(input.value);
  if (isNaN(val) || input.value.trim() === '') {
    delete aug.customValues;
  } else {
    aug.customValues = val;
  }

  closeAugmentValuePopup();
  refreshPanels();
}

// =============================================
// TOOLTIP PANEL
// =============================================

function showTooltip(slotType) {
  const item = equippedItems[slotType];
  if (!item) return;

  const panel = document.getElementById('tooltip-panel');
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

  stats.forEach(stat => {
    const row = document.createElement('div');
    row.className = 'stat-row';

    const label = document.createElement('span');
    label.className = 'stat-label';
    label.textContent = stat.name.replace(/:$/, '');

    const value = document.createElement('span');
    value.className = 'stat-value';
    value.textContent = formatStatValue(stat.name, stat.value);

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
}

function showAugmentTooltip(slotType, dotIndex) {
  const equipped = equippedAugments[slotType]?.[dotIndex];
  if (!equipped) return;

  const augData = AUGMENT_DATA.find(a => a.slug === equipped.slug);
  if (!augData) return;

  const panel = document.getElementById('tooltip-panel');
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
      if (customVal != null) {
        value.textContent = `+${customVal}${eff.type === 'percent' ? '%' : ''}`;
      } else {
        value.textContent = `+${g[0]}–${g[1]}${eff.type === 'percent' ? '%' : ''}`;
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

function clearTooltip() {
  const panel = document.getElementById('tooltip-panel');
  panel.innerHTML = '<div class="tooltip-panel__empty">Hover an item to inspect</div>';
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

(async () => {
  await loadGarmentItems();

  document.querySelectorAll('.armor-slot').forEach(slotEl => {
    if (slotEl.classList.contains('slot--null')) return;
    slotEl.addEventListener('click', () => openItemPicker(slotEl));
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
    const filtered = AUGMENT_DATA.filter(a => a.name.toLowerCase().includes(query));
    renderAugmentPickerItems(filtered);
  });

  // Augment custom value popup events
  document.getElementById('augment-value-save').addEventListener('click', saveAugmentCustomValue);
  document.getElementById('augment-value-cancel').addEventListener('click', closeAugmentValuePopup);

  document.getElementById('augment-value-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') saveAugmentCustomValue();
    if (e.key === 'Escape') closeAugmentValuePopup();
  });

  // Close popup on outside click
  document.addEventListener('mousedown', e => {
    const popup = document.getElementById('augment-value-popup');
    if (!popup.hidden && !popup.contains(e.target)) {
      closeAugmentValuePopup();
    }
  });
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

// =============================================
// EXPORT
// =============================================

const EXPORT_SLOT_ORDER = ['helm', 'chest', 'pants', 'gloves', 'boots', 'holtzman', 'belt', 'pack'];

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

  const exportData = { slots };

  if (lastCharacterPanel) {
    exportData.characterPanel = {};
    for (const key of RESOURCE_KEYS) {
      if (lastCharacterPanel[key] != null) {
        exportData.characterPanel[key] = lastCharacterPanel[key];
      }
    }
  }

  const json = JSON.stringify(exportData, null, 2);
  const output = [
    '======================================================================',
    'DUNEBUILDER EXPORT',
    '======================================================================',
    json,
  ].join('\n');

  return window.electronAPI.writeClipboard(output);
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
  const hasGear = Object.keys(equippedItems).length > 0;
  if (!hasGear && !lastCharacterPanel) {
    showError('Nothing to export — equip gear or paste a build first.');
    return;
  }
  exportBtn.disabled = true;
  exportBtn.textContent = 'Exporting…';
  try {
    await exportBuild();
    exportBtn.textContent = 'Copied!';
    setTimeout(() => { exportBtn.textContent = 'Export'; }, 1500);
  } catch (err) {
    showError('Export failed: ' + err.message);
    exportBtn.textContent = 'Export';
  } finally {
    exportBtn.disabled = false;
  }
});

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
      // First pass: set state (grades, augments) before building visuals
      for (const [slot, data] of Object.entries(result.slots)) {
        const item = GARMENT_ITEMS.find(i => i.slug === data.item);
        if (!item) continue;
        equippedItems[slot] = item;
        if (GARMENT_SLOTS.has(slot)) equippedGrades[slot] = data.grade || 0;
        if (data.augments) {
          equippedAugments[slot] = data.augments.map(a => a ? { slug: a.slug, grade: Math.max(a.grade || 0, 1), ...(a.customValues != null ? { customValues: a.customValues } : {}) } : null);
          const lastNonNull = data.augments.reduce((max, a, i) => a ? i : max, -1);
          augmentSlotUnlocks[slot] = Math.max(lastNonNull + 1, 1);
        }
      }
      // Second pass: build visuals with correct state already in place
      for (const [slot, data] of Object.entries(result.slots)) {
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
    banner.hidden = false;
  } catch { /* silent fail — update check is non-critical */ }
})();
