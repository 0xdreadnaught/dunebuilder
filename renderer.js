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
    return { duneExport: true, gear: duneExport.gear || {}, characterPanel: duneExport.characterPanel || null, buildTotals: null, skillBonuses: null };
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

  const heading = document.createElement('div');
  heading.className = 'stats-section-label';
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

  // EHP section
  const ehpHeading = document.createElement('div');
  ehpHeading.className = 'stats-section-label';
  ehpHeading.textContent = 'EHP';
  container.appendChild(ehpHeading);

  const maxHealth = lastCharacterPanel?.Health
    ? (parseResource(lastCharacterPanel.Health)?.max ?? null) : null;

  // Armor mitigation: derive from equipped gear Armor Value via Armor / (Armor + 500)
  const totalArmor = equipped['Armor Value'] ?? 0;
  const armorMit = totalArmor > 0 ? (totalArmor / (totalArmor + 500)) * 100 : null;

  // Type mitigations: sum gear stats + pasted build totals
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
    // Mitigations stack multiplicatively: dmg_taken = (1 - armorMit) * (1 - typeMit)
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

  // Stamina / Dash section
  const staminaHeading = document.createElement('div');
  staminaHeading.className = 'stats-section-label';
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
let lastCharacterPanel = null;
let lastBuildTotals = null;
let lastSkillBonuses = null;
let currentPickerItems = [];
let currentPickerSlotType = null;

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
const ARMOR_SLOTS = new Set(['helm', 'chest', 'gloves', 'pants', 'boots']);

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
    const [garmentRes, utilityRes] = await Promise.all([
      fetch('./items_garment_t6.json'),
      fetch('./items_utility.json'),
    ]);
    const garments = await garmentRes.json();
    const utility = await utilityRes.json();

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

function aggregateEquippedStats() {
  const totals = {};
  const seen = new Set();
  Object.values(equippedItems).forEach(item => {
    if (seen.has(item.slug)) return;
    seen.add(item.slug);
    (item.stats || []).forEach(stat => {
      if (typeof stat.value !== 'number') return;
      const key = stat.name.replace(/:$/, '');
      totals[key] = (totals[key] || 0) + stat.value;
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
    ARMOR_SLOTS.forEach(s => { equippedItems[s] = item; });
    document.querySelector('.armor-layout').classList.add('radsuit-active');
    document.querySelectorAll('.armor-slot').forEach(slotEl => {
      if (getSlotType(slotEl) === 'helm') updateSlotDisplay(slotEl, item);
    });
  } else {
    // If a rad suit currently occupies this slot, displace it from all 5 slots first
    if (ARMOR_SLOTS.has(slotType) && equippedItems[slotType]?.slot === 'radsuit') {
      ARMOR_SLOTS.forEach(s => { delete equippedItems[s]; });
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
    document.querySelectorAll('.armor-slot').forEach(slotEl => {
      if (getSlotType(slotEl) === slotType) updateSlotDisplay(slotEl, item);
    });
  }

  closeItemPicker();
  refreshPanels();
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
}

function clearSlot(slotEl) {
  const slotType = getSlotType(slotEl);
  const item = slotType ? equippedItems[slotType] : null;

  if (item?.slot === 'radsuit') {
    ARMOR_SLOTS.forEach(s => { delete equippedItems[s]; });
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
    if (slotType) delete equippedItems[slotType];
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
})();

// =============================================
// EXPORT
// =============================================

function exportBuild() {
  const gear = {};
  for (const [slot, item] of Object.entries(equippedItems)) {
    gear[slot] = item.slug;
  }

  const exportData = { gear };
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
    setTimeout(() => { exportBtn.textContent = 'Export Build'; }, 1500);
  } catch (err) {
    showError('Export failed: ' + err.message);
    exportBtn.textContent = 'Export Build';
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
      // Import gear
      for (const [slot, slug] of Object.entries(result.gear)) {
        selectItem(slot, slug);
      }
      // Import character panel
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
    pasteBtn.textContent = 'Paste from Clipboard';
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
