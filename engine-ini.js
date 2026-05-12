'use strict';
// Engine.ini reference modal — extracted from renderer.js. Loaded as a separate <script defer>.
(() => {
  let ENGINE_CVAR_CATALOG = null;
  let CVAR_BY_NAME = new Map();
  let CVARS_BY_CATEGORY = new Map();

  fetch('./data/engine_cvars.json').then(r => r.json()).then(cat => {
    ENGINE_CVAR_CATALOG = cat;
    CVAR_BY_NAME = new Map();
    CVARS_BY_CATEGORY = new Map();
    for (const c of cat.cvars) {
      const key = c.name.toLowerCase();
      if (!CVAR_BY_NAME.has(key)) CVAR_BY_NAME.set(key, c);
      if (!CVARS_BY_CATEGORY.has(c.category)) CVARS_BY_CATEGORY.set(c.category, []);
      CVARS_BY_CATEGORY.get(c.category).push(c);
    }
  }).catch(() => { /* catalog load failed — modal will show what it can */ });

  const engineIniState = {
    filePath: null,
    fileExists: false,
    parsedSections: null,    // [{ name: string|null, lines: string[] }]
    included: [],            // [{ name, value, source: 'catalog'|'unknown' }]
    dirty: false,
    filterCategory: 'all',   // category id or 'all'
  };

  function parseEngineIni(text) {
    const raw = text || '';
    // Detect whether the file uses CRLF; we'll preserve that on write.
    const usesCRLF = /\r\n/.test(raw);
    const lines = raw.split(/\r?\n/);
    const sections = [{ name: null, lines: [] }];
    for (const line of lines) {
      const m = line.match(/^\s*\[([^\]]+)\]\s*$/);
      if (m) sections.push({ name: m[1], lines: [] });
      else sections[sections.length - 1].lines.push(line);
    }
    // Stash line-ending preference on the first section so the serializer can read it back.
    sections._eol = usesCRLF ? '\r\n' : '\n';
    return sections;
  }

  function serializeEngineIni(sections) {
    const eol = sections._eol || '\r\n'; // default to CRLF on Windows
    const out = [];
    sections.forEach((sec) => {
      if (sec.name !== null) {
        if (out.length && out[out.length - 1].trim() !== '') out.push('');
        out.push(`[${sec.name}]`);
      }
      for (const line of sec.lines) out.push(line);
    });
    return out.join(eol).replace(/(\r?\n)*$/, eol);
  }

  function parseSystemSettingsEntries(sectionLines) {
    const entries = [];
    for (const line of sectionLines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const name = line.slice(0, eq).trim();
      let value = line.slice(eq + 1);
      // Strip inline comment after `;`
      const sc = value.indexOf(';');
      if (sc !== -1) value = value.slice(0, sc);
      entries.push({ name, value: value.trim() });
    }
    return entries;
  }

  function getCvarCatalogEntry(name) {
    return CVAR_BY_NAME.get((name || '').toLowerCase()) || null;
  }

  function loadEngineIniFromText(text) {
    engineIniState.parsedSections = parseEngineIni(text);
    const managed = engineIniState.parsedSections.find(
      s => s.name && s.name.toLowerCase() === ENGINE_CVAR_CATALOG.managedSection.toLowerCase()
    );
    const entries = managed ? parseSystemSettingsEntries(managed.lines) : [];
    engineIniState.included = entries.map(e => {
      const cat = getCvarCatalogEntry(e.name);
      return {
        name: cat ? cat.name : e.name,
        value: e.value,
        source: cat ? 'catalog' : 'unknown',
      };
    });
    engineIniState.dirty = false;
  }

  async function refreshEngineIniFromDisk() {
    const result = await window.electronAPI.engineIni.read();
    engineIniState.filePath = result.path;
    engineIniState.fileExists = result.exists;
    if (result.exists) {
      loadEngineIniFromText(result.text);
    } else {
      engineIniState.parsedSections = parseEngineIni('');
      engineIniState.included = [];
      engineIniState.dirty = false;
    }
  }

  function buildEngineIniText() {
    const sections = engineIniState.parsedSections.map(s => ({ name: s.name, lines: [...s.lines] }));
    // Preserve the original eol preference detected at parse time
    sections._eol = engineIniState.parsedSections._eol;

    const managedName = ENGINE_CVAR_CATALOG.managedSection;
    const managedIdx = sections.findIndex(
      s => s.name && s.name.toLowerCase() === managedName.toLowerCase()
    );
    const lines = engineIniState.included.map(c => `${c.name}=${c.value}`);

    if (lines.length === 0) {
      // No managed cvars: don't emit an empty section. Drop it if it existed.
      if (managedIdx !== -1) sections.splice(managedIdx, 1);
    } else {
      lines.push('');
      if (managedIdx === -1) {
        sections.push({ name: managedName, lines });
      } else {
        sections[managedIdx].lines = lines;
      }
    }
    return serializeEngineIni(sections);
  }

  function escapeAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function renderEngineIniAvailable(searchTerm = '') {
    const list = document.getElementById('engine-ini-available-list');
    list.innerHTML = '';
    if (!ENGINE_CVAR_CATALOG) return;

    const includedNames = new Set(engineIniState.included.map(c => c.name.toLowerCase()));
    const term = searchTerm.toLowerCase().trim();
    const activeCat = engineIniState.filterCategory;

    let totalAvailable = 0;
    for (const cat of ENGINE_CVAR_CATALOG.categories) {
      if (activeCat !== 'all' && activeCat !== cat.id) continue;

      const catCvars = CVARS_BY_CATEGORY.get(cat.id) || [];
      const visible = catCvars.filter(c => {
        if (includedNames.has(c.name.toLowerCase())) return false;
        if (!term) return true;
        return c.name.toLowerCase().includes(term)
            || (c.description || '').toLowerCase().includes(term);
      });
      if (!visible.length) continue;

      const details = document.createElement('details');
      details.className = 'engine-ini-section';
      details.open = true;

      const summary = document.createElement('summary');
      summary.className = 'engine-ini-section-label';
      summary.textContent = cat.label;
      details.appendChild(summary);

      for (const cvar of visible) {
        details.appendChild(createAvailableItem(cvar));
        totalAvailable++;
      }
      list.appendChild(details);
    }

    document.getElementById('engine-ini-available-count').textContent = `${totalAvailable} cvar${totalAvailable === 1 ? '' : 's'}`;
  }

  function createAvailableItem(cvar) {
    const item = document.createElement('div');
    item.className = 'engine-ini-item';
    item.draggable = true;
    item.dataset.cvar = cvar.name;

    const head = document.createElement('div');
    head.className = 'engine-ini-item__head';

    const name = document.createElement('span');
    name.className = 'engine-ini-item__name';
    name.textContent = cvar.name;
    head.appendChild(name);

    if (cvar.notes) {
      const warn = document.createElement('span');
      warn.className = 'engine-ini-item__warn';
      warn.textContent = '⚠';
      warn.title = 'Has caveat — hover for details';
      head.appendChild(warn);
    }

    const def = document.createElement('span');
    if (cvar.default === null || cvar.default === undefined) {
      def.className = 'engine-ini-item__default engine-ini-item__default--unknown';
      def.textContent = 'unknown';
    } else {
      def.className = 'engine-ini-item__default';
      def.textContent = String(cvar.default);
    }
    head.appendChild(def);
    item.appendChild(head);

    attachCvarTooltip(item, cvar);

    item.addEventListener('dragstart', e => {
      e.dataTransfer.setData('text/x-cvar-name', cvar.name);
      e.dataTransfer.setData('text/x-source', 'available');
      e.dataTransfer.effectAllowed = 'move';
      item.classList.add('dragging');
      hideCvarTooltip();
    });
    item.addEventListener('dragend', () => item.classList.remove('dragging'));

    return item;
  }

  // --- Floating cvar tooltip ---
  let cvarTooltipEl = null;
  function getCvarTooltipEl() {
    if (!cvarTooltipEl) cvarTooltipEl = document.getElementById('engine-ini-tooltip');
    return cvarTooltipEl;
  }

  function showCvarTooltip(cvar, anchorEl) {
    const tip = getCvarTooltipEl();
    tip.innerHTML = '';

    if (cvar.description) {
      const d = document.createElement('div');
      d.className = 'engine-ini-tooltip__desc';
      d.textContent = cvar.description;
      tip.appendChild(d);
    }

    const metaParts = [];
    if (cvar.type) metaParts.push(cvar.type);
    if (cvar.range) metaParts.push(cvar.range);
    if (cvar.default !== null && cvar.default !== undefined) metaParts.push(`default ${cvar.default}`);
    if (metaParts.length) {
      const m = document.createElement('div');
      m.className = 'engine-ini-tooltip__meta';
      m.textContent = metaParts.join(' · ');
      tip.appendChild(m);
    }

    if (cvar.notes) {
      const n = document.createElement('div');
      n.className = 'engine-ini-tooltip__notes';
      n.textContent = cvar.notes;
      tip.appendChild(n);
    }

    // Render off-screen first so we can measure
    tip.style.left = '-9999px';
    tip.style.top = '-9999px';
    tip.hidden = false;

    // Anchor: pin tooltip below the item, aligned to its left edge.
    // If it would clip the bottom of the modal, flip above.
    const rect = anchorEl.getBoundingClientRect();
    const modal = document.querySelector('.engine-ini-modal');
    const modalRect = modal ? modal.getBoundingClientRect()
      : { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
    const tipRect = tip.getBoundingClientRect();

    const gap = 6;
    let top = rect.bottom + gap;
    if (top + tipRect.height > modalRect.bottom - 8) {
      top = rect.top - tipRect.height - gap;
    }
    // Clamp to modal vertical bounds
    if (top < modalRect.top + 8) top = modalRect.top + 8;

    let left = rect.left;
    // Clamp to modal horizontal bounds so the tooltip stays inside the panel
    if (left + tipRect.width > modalRect.right - 8) {
      left = modalRect.right - tipRect.width - 8;
    }
    if (left < modalRect.left + 8) left = modalRect.left + 8;

    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  }

  function hideCvarTooltip() {
    const tip = getCvarTooltipEl();
    if (tip) tip.hidden = true;
  }

  function attachCvarTooltip(itemEl, cvar) {
    let timer = null;
    itemEl.addEventListener('mouseenter', () => {
      timer = setTimeout(() => showCvarTooltip(cvar, itemEl), 220);
    });
    itemEl.addEventListener('mouseleave', () => {
      if (timer) clearTimeout(timer);
      hideCvarTooltip();
    });
  }

  function renderEngineIniFilters() {
    const container = document.getElementById('engine-ini-filters');
    container.innerHTML = '';
    if (!ENGINE_CVAR_CATALOG) return;

    const allBtn = document.createElement('button');
    allBtn.className = 'engine-ini-filter-btn' + (engineIniState.filterCategory === 'all' ? ' active' : '');
    allBtn.textContent = 'All';
    allBtn.addEventListener('click', () => setActiveFilter('all'));
    container.appendChild(allBtn);

    for (const cat of ENGINE_CVAR_CATALOG.categories) {
      const btn = document.createElement('button');
      btn.className = 'engine-ini-filter-btn' + (engineIniState.filterCategory === cat.id ? ' active' : '');
      btn.textContent = shortCatLabel(cat);
      btn.title = cat.label;
      btn.addEventListener('click', () => setActiveFilter(cat.id));
      container.appendChild(btn);
    }
  }

  function setActiveFilter(categoryId) {
    engineIniState.filterCategory = categoryId;
    renderEngineIniFilters();
    rerenderEngineIniLists();
  }

  function shortCatLabel(cat) {
    // Compact pill labels for the filter row
    const map = {
      d3d12: 'D3D12',
      shader: 'Shaders',
      lumen: 'Lumen',
      nanite: 'Nanite',
      shadow: 'Shadows',
      dlss: 'DLSS / NIS',
      parallel: 'Parallel',
      streaming: 'Streaming',
      physics: 'Physics',
      misc: 'Misc',
    };
    return map[cat.id] || cat.label;
  }

  function renderEngineIniIncluded(searchTerm = '') {
    const list = document.getElementById('engine-ini-included-list');
    list.innerHTML = '';
    const term = searchTerm.toLowerCase().trim();
    const activeCat = engineIniState.filterCategory;

    const visible = engineIniState.included.filter(c => {
      if (term && !c.name.toLowerCase().includes(term)) return false;
      if (activeCat !== 'all') {
        const cat = getCvarCatalogEntry(c.name);
        // Unknown cvars: show only when filter is "all"
        if (!cat) return false;
        if (cat.category !== activeCat) return false;
      }
      return true;
    });

    if (!engineIniState.included.length) {
      const empty = document.createElement('div');
      empty.className = 'engine-ini-empty-list';
      empty.textContent = 'Nothing in [SystemSettings] yet. Drag cvars here from the left.';
      list.appendChild(empty);
    } else if (!visible.length) {
      const empty = document.createElement('div');
      empty.className = 'engine-ini-empty-list';
      empty.textContent = 'No included cvars match the current filter.';
      list.appendChild(empty);
    } else {
      for (const entry of visible) {
        list.appendChild(createIncludedItem(entry));
      }
    }

    const total = engineIniState.included.length;
    const dirtyTag = engineIniState.dirty ? ' · unsaved' : '';
    document.getElementById('engine-ini-included-count').textContent = `${total} cvar${total === 1 ? '' : 's'}${dirtyTag}`;
  }

  function createIncludedItem(entry) {
    const cat = getCvarCatalogEntry(entry.name);

    const item = document.createElement('div');
    item.className = 'engine-ini-item engine-ini-item--included';
    item.draggable = true;
    item.dataset.cvar = entry.name;

    const head = document.createElement('div');
    head.className = 'engine-ini-item__head';

    const name = document.createElement('span');
    name.className = 'engine-ini-item__name';
    name.textContent = entry.name;
    head.appendChild(name);

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'engine-ini-item__value-input';
    input.value = entry.value;
    if (cat && cat.default !== null && cat.default !== undefined && String(cat.default) !== entry.value) {
      input.classList.add('modified');
    }
    input.addEventListener('input', () => {
      entry.value = input.value;
      engineIniState.dirty = true;
      if (cat && cat.default !== null && cat.default !== undefined) {
        input.classList.toggle('modified', String(cat.default) !== input.value);
      }
      updateEngineIniStatus();
      updateIncludedCount();
    });
    head.appendChild(input);

    const remove = document.createElement('button');
    remove.className = 'engine-ini-item__remove';
    remove.title = 'Remove from Engine.ini';
    remove.textContent = '×';
    remove.addEventListener('click', () => removeFromIncluded(entry.name));
    head.appendChild(remove);

    item.appendChild(head);

    const meta = document.createElement('div');
    meta.className = 'engine-ini-item__meta';
    if (cat) {
      const parts = [];
      if (cat.type) parts.push(cat.type);
      if (cat.range) parts.push(cat.range);
      if (cat.default !== null && cat.default !== undefined) parts.push(`default ${cat.default}`);
      meta.textContent = parts.join(' · ');
    } else {
      meta.textContent = 'unknown cvar (preserved from existing file)';
    }
    item.appendChild(meta);

    if (cat) attachCvarTooltip(item, cat);

    item.addEventListener('dragstart', e => {
      e.dataTransfer.setData('text/x-cvar-name', entry.name);
      e.dataTransfer.setData('text/x-source', 'included');
      e.dataTransfer.effectAllowed = 'move';
      item.classList.add('dragging');
      hideCvarTooltip();
    });
    item.addEventListener('dragend', () => item.classList.remove('dragging'));

    return item;
  }

  function addToIncluded(cvarName) {
    if (engineIniState.included.some(c => c.name.toLowerCase() === cvarName.toLowerCase())) return;
    const cat = getCvarCatalogEntry(cvarName);
    const value = (cat && cat.default !== null && cat.default !== undefined) ? String(cat.default) : '';
    engineIniState.included.push({
      name: cat ? cat.name : cvarName,
      value,
      source: cat ? 'catalog' : 'unknown',
    });
    engineIniState.dirty = true;
    rerenderEngineIniLists();
  }

  function removeFromIncluded(cvarName) {
    const before = engineIniState.included.length;
    engineIniState.included = engineIniState.included.filter(
      c => c.name.toLowerCase() !== cvarName.toLowerCase()
    );
    if (engineIniState.included.length !== before) {
      engineIniState.dirty = true;
      rerenderEngineIniLists();
    }
  }

  function rerenderEngineIniLists() {
    const availSearch = document.getElementById('engine-ini-search-available')?.value || '';
    const incSearch = document.getElementById('engine-ini-search-included')?.value || '';
    renderEngineIniAvailable(availSearch);
    renderEngineIniIncluded(incSearch);
    updateEngineIniStatus();
  }

  function updateIncludedCount() {
    const total = engineIniState.included.length;
    const dirtyTag = engineIniState.dirty ? ' · unsaved' : '';
    document.getElementById('engine-ini-included-count').textContent = `${total} cvar${total === 1 ? '' : 's'}${dirtyTag}`;
  }

  function updateEngineIniStatus() {
    const status = document.getElementById('engine-ini-status');
    status.classList.remove('engine-ini-status--success', 'engine-ini-status--error');
    if (engineIniState.dirty) {
      status.classList.add('engine-ini-status--dirty');
      status.textContent = 'Unsaved changes — click Apply to write Engine.ini';
    } else {
      status.classList.remove('engine-ini-status--dirty');
      status.textContent = 'drag between columns · Apply writes Engine.ini';
    }
    document.getElementById('engine-ini-apply').disabled = !engineIniState.dirty;
  }

  async function openEngineIniModal() {
    if (!ENGINE_CVAR_CATALOG) {
      window.dbHooks.showError('Engine cvar catalog not loaded.');
      return;
    }
    window.dbHooks.closeSettings();

    await refreshEngineIniFromDisk();

    const overlay = document.getElementById('engine-ini-overlay');
    const subtitle = document.getElementById('engine-ini-subtitle');
    const empty = document.getElementById('engine-ini-empty');
    const body = document.getElementById('engine-ini-body');
    const footer = overlay.querySelector('.engine-ini-footer');

    subtitle.textContent = engineIniState.filePath
      ? engineIniState.filePath + (engineIniState.fileExists ? ' · loaded' : ' · not found')
      : '';

    if (!engineIniState.fileExists) {
      empty.hidden = false;
      body.hidden = true;
      footer.hidden = true;
    } else {
      empty.hidden = true;
      body.hidden = false;
      footer.hidden = false;
      renderEngineIniFilters();
      rerenderEngineIniLists();
    }

    requestAnimationFrame(() => requestAnimationFrame(() => overlay.classList.add('visible')));
  }

  function closeEngineIniModal() {
    hideCvarTooltip();
    document.getElementById('engine-ini-overlay').classList.remove('visible');
  }

  async function applyEngineIni() {
    const text = buildEngineIniText();
    const result = await window.electronAPI.engineIni.write(text);
    const status = document.getElementById('engine-ini-status');
    if (result.success) {
      engineIniState.dirty = false;
      // Re-parse from what we just wrote so state matches disk
      loadEngineIniFromText(text);
      rerenderEngineIniLists();
      status.classList.remove('engine-ini-status--dirty', 'engine-ini-status--error');
      status.classList.add('engine-ini-status--success');
      status.textContent = 'Saved to Engine.ini';
      setTimeout(() => updateEngineIniStatus(), 1800);
    } else {
      status.classList.remove('engine-ini-status--success');
      status.classList.add('engine-ini-status--error');
      status.textContent = 'Save failed: ' + (result.error || 'unknown error');
    }
  }

  async function revertEngineIni() {
    await refreshEngineIniFromDisk();
    rerenderEngineIniLists();
  }

  // --- Wire up modal events ---
  document.getElementById('open-engine-ini-btn').addEventListener('click', openEngineIniModal);
  document.getElementById('engine-ini-close').addEventListener('click', closeEngineIniModal);
  document.getElementById('engine-ini-overlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeEngineIniModal();
  });
  document.getElementById('engine-ini-apply').addEventListener('click', applyEngineIni);
  document.getElementById('engine-ini-revert').addEventListener('click', revertEngineIni);
  document.getElementById('engine-ini-reveal').addEventListener('click', () => {
    window.electronAPI.engineIni.reveal();
  });

  document.getElementById('engine-ini-search-available').addEventListener('input', e => {
    renderEngineIniAvailable(e.target.value);
  });
  document.getElementById('engine-ini-search-included').addEventListener('input', e => {
    renderEngineIniIncluded(e.target.value);
  });

  // Drag-drop targets
  const includedListEl = document.getElementById('engine-ini-included-list');
  const availableListEl = document.getElementById('engine-ini-available-list');

  includedListEl.addEventListener('scroll', hideCvarTooltip);
  availableListEl.addEventListener('scroll', hideCvarTooltip);

  includedListEl.addEventListener('dragover', e => {
    if (e.dataTransfer.types.includes('text/x-cvar-name')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      includedListEl.classList.add('drag-over');
    }
  });
  includedListEl.addEventListener('dragleave', () => includedListEl.classList.remove('drag-over'));
  includedListEl.addEventListener('drop', e => {
    includedListEl.classList.remove('drag-over');
    const name = e.dataTransfer.getData('text/x-cvar-name');
    const source = e.dataTransfer.getData('text/x-source');
    if (source === 'available' && name) {
      e.preventDefault();
      addToIncluded(name);
    }
  });

  availableListEl.addEventListener('dragover', e => {
    if (e.dataTransfer.types.includes('text/x-cvar-name')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      availableListEl.classList.add('drag-over');
    }
  });
  availableListEl.addEventListener('dragleave', () => availableListEl.classList.remove('drag-over'));
  availableListEl.addEventListener('drop', e => {
    availableListEl.classList.remove('drag-over');
    const name = e.dataTransfer.getData('text/x-cvar-name');
    const source = e.dataTransfer.getData('text/x-source');
    if (source === 'included' && name) {
      e.preventDefault();
      removeFromIncluded(name);
    }
  });
})();
