'use strict';
// QR Code Builder modal — encodes a URL to a fixed 25x25 QR (v2-L), pads a light "quiet zone"
// border, and walks the user row-by-row with run-length build instructions. Row 0 = the bottom
// row of the image (the first row you place when building walls from the ground up).
(function () {
  const CELL = 14;                       // canvas px per tile
  const COLOR_DARK     = '#0d0b08';      // dark wall tile  (matches --color-bg-void)
  const COLOR_LIGHT    = '#d8c89a';      // light wall tile (pale sand — keep in sync with .qr-run--light in styles.css)
  const COLOR_LIGHT_HL = '#f0dca0';      // light tile on the spotlit row (a touch brighter — matches --color-text-value)
  const INACTIVE_ALPHA = 0.3;            // every row except the one you're on is drawn faded

  const state = {
    grid: null,          // boolean[gridSize][gridSize] in image orientation (row 0 = top), or null
    gridSize: 0,
    direction: 'bottom', // 'bottom' = Row 0 is the bottom image row; 'top' = Row 0 is the top image row
    currentRow: 0,       // 0-indexed in the chosen direction (0 = the row you place first)
    totals: { dark: 0, light: 0 },
  };

  let el = null;
  function refs() {
    if (el) return el;
    const $ = id => document.getElementById(id);
    el = {
      overlay: $('qr-builder-overlay'), close: $('qr-builder-close'),
      url: $('qr-url-input'), qz: $('qr-qz-input'), qzLabel: $('qr-qz-label'),
      direction: $('qr-direction'),
      generate: $('qr-generate-btn'), status: $('qr-status'),
      canvas: $('qr-canvas'),
      prev: $('qr-prev-btn'), next: $('qr-next-btn'), rowLabel: $('qr-row-label'),
      runs: $('qr-runs'), tally: $('qr-row-tally'), grand: $('qr-grand-totals'),
      progress: $('qr-progress'),
    };
    return el;
  }

  // Map a row index (in the user's chosen counting direction) to a row in the image (0 = top).
  const imageRow = idx => state.direction === 'top' ? idx : state.gridSize - 1 - idx;

  function setStatus(text, kind) {   // kind: 'ok' | 'warn' | undefined
    const r = refs();
    r.status.textContent = text;
    r.status.className = 'qr-status' + (kind ? ' qr-status--' + kind : '');
  }

  function generate() {
    const r = refs();
    const url = r.url.value.trim();
    if (!url) { state.grid = null; setStatus('Enter a URL to encode.'); clearPanel(); drawCanvas(); return; }
    let qr;
    try { qr = window.QREncode.encodeQR(url); }
    catch (e) { state.grid = null; setStatus('✗ ' + e.message, 'warn'); clearPanel(); drawCanvas(); return; }
    const qz = parseInt(r.qz.value, 10);
    const full = qr.size + qz * 2;
    const grid = [];
    for (let row = 0; row < full; row++) {
      const line = [];
      for (let col = 0; col < full; col++) {
        const inQR = row >= qz && row < qz + qr.size && col >= qz && col < qz + qr.size;
        line.push(inQR ? qr.modules[row - qz][col - qz] : false);
      }
      grid.push(line);
    }
    let dark = 0;
    for (const line of grid) for (const v of line) if (v) dark++;
    state.grid = grid;
    state.gridSize = full;
    state.direction = r.direction.value;
    state.currentRow = 0;
    state.totals = { dark, light: full * full - dark };
    setStatus('✓ ' + qr.size + '×' + qr.size + ' QR + ' + qz + '-tile border = ' + full + '×' + full + ' tiles', 'ok');
    renderAll();
  }

  function clearPanel() {
    const r = refs();
    r.rowLabel.textContent = '—';
    r.runs.innerHTML = ''; r.tally.textContent = ''; r.grand.textContent = ''; r.progress.innerHTML = '';
    r.prev.disabled = true; r.next.disabled = true;
  }

  function drawCanvas() {
    const r = refs(), canvas = r.canvas;
    if (!state.grid) { canvas.width = canvas.height = 0; return; }
    const n = state.gridSize;
    canvas.width = n * CELL; canvas.height = n * CELL;
    const ctx = canvas.getContext('2d');
    const hl = imageRow(state.currentRow);
    for (let row = 0; row < n; row++) {
      const active = (row === hl);
      ctx.globalAlpha = active ? 1 : INACTIVE_ALPHA;   // spotlight the row you're on; fade the rest
      for (let col = 0; col < n; col++) {
        const dark = state.grid[row][col];
        ctx.fillStyle = dark ? COLOR_DARK : (active ? COLOR_LIGHT_HL : COLOR_LIGHT);
        ctx.fillRect(col * CELL, row * CELL, CELL - 1, CELL - 1);
      }
    }
    ctx.globalAlpha = 1;
  }

  function runLengths(boolRow) {
    const out = [];
    let cur = boolRow[0], k = 1;
    for (let i = 1; i < boolRow.length; i++) {
      if (boolRow[i] === cur) k++;
      else { out.push({ dark: cur, n: k }); cur = boolRow[i]; k = 1; }
    }
    out.push({ dark: cur, n: k });
    return out;
  }

  function renderRow() {
    const r = refs(), n = state.gridSize, boolRow = state.grid[imageRow(state.currentRow)];
    r.rowLabel.textContent = 'Row ' + state.currentRow + ' of ' + (n - 1);
    r.prev.disabled = state.currentRow === 0;
    r.next.disabled = state.currentRow === n - 1;
    r.runs.innerHTML = runLengths(boolRow).map(seg =>
      '<span class="qr-run ' + (seg.dark ? 'qr-run--dark' : 'qr-run--light') + '">' + seg.n + '</span>'
    ).join('');
    const darkN = boolRow.filter(Boolean).length;
    r.tally.textContent = darkN + ' dark · ' + (n - darkN) + ' light  ·  ' + n + ' tiles wide';
    r.grand.textContent = 'Total: ' + state.totals.dark + ' dark tiles · ' + state.totals.light + ' light tiles';
  }

  function renderProgress() {
    const r = refs(), n = state.gridSize;
    r.progress.innerHTML = '';
    for (let rb = 0; rb < n; rb++) {
      const cell = document.createElement('div');
      const cls = rb < state.currentRow ? 'is-done' : rb === state.currentRow ? 'is-current' : 'is-todo';
      cell.className = 'qr-prog-cell ' + cls;
      cell.title = 'Row ' + rb + ' — click to jump here';
      cell.addEventListener('click', () => { state.currentRow = rb; renderAll(); });
      r.progress.appendChild(cell);
    }
  }

  function renderAll() { drawCanvas(); renderRow(); renderProgress(); }

  function go(delta) {
    if (!state.grid) return;
    state.currentRow = Math.max(0, Math.min(state.gridSize - 1, state.currentRow + delta));
    renderAll();
  }

  function openModal() { refs().overlay.classList.add('visible'); if (!state.grid) generate(); }
  function closeModal() { refs().overlay.classList.remove('visible'); }

  // `<script defer>` guarantees the DOM is parsed before this runs, so wire everything now.
  document.getElementById('open-qr-builder-btn').addEventListener('click', openModal);
  {
    const r = refs();
    r.close.addEventListener('click', closeModal);
    r.overlay.addEventListener('click', e => { if (e.target === r.overlay) closeModal(); });
    r.generate.addEventListener('click', generate);
    r.url.addEventListener('keydown', e => { if (e.key === 'Enter') generate(); });
    r.qz.addEventListener('input', () => { r.qzLabel.textContent = r.qz.value; });
    r.direction.addEventListener('change', () => {
      const prev = state.direction;
      state.direction = r.direction.value;
      if (state.grid && prev !== state.direction) {
        // Stay on the same physical row; just flip the numbering so the strip and label re-read.
        state.currentRow = state.gridSize - 1 - state.currentRow;
        renderAll();
      }
    });
    r.prev.addEventListener('click', () => go(-1));
    r.next.addEventListener('click', () => go(1));
    r.canvas.addEventListener('click', e => {
      if (!state.grid) return;
      const rect = r.canvas.getBoundingClientRect();
      const imgRow = Math.floor((e.clientY - rect.top) / (rect.height / state.gridSize));
      if (imgRow < 0 || imgRow >= state.gridSize) return;
      state.currentRow = state.direction === 'top' ? imgRow : state.gridSize - 1 - imgRow;
      renderAll();
    });
  }
})();
