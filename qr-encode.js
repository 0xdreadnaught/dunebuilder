// qr-encode.js
// Standalone QR Code encoder — hard-wired to version 2, error-correction level L, byte mode.
// Always produces a 25x25 module matrix. No dependencies.
// UMD: exposes `window.QREncode` in a browser, `module.exports` under Node.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QREncode = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SIZE = 25;             // version 2 → 25x25 modules
  const DATA_CODEWORDS = 34;   // version 2, level L
  const EC_CODEWORDS = 10;     // version 2, level L (single error-correction block)
  const TOTAL_CODEWORDS = DATA_CODEWORDS + EC_CODEWORDS;  // 44
  const MAX_TEXT_BYTES = 32;   // byte-mode capacity at v2-L: floor((34*8 - 4 - 8) / 8)

  function QRTooLongError(message) {
    this.name = 'QRTooLongError';
    this.message = message;
    if (Error.captureStackTrace) Error.captureStackTrace(this, QRTooLongError);
  }
  QRTooLongError.prototype = Object.create(Error.prototype);
  QRTooLongError.prototype.constructor = QRTooLongError;

  // ---- GF(256) tables, primitive polynomial 0x11D ----
  const EXP = new Array(255);
  const LOG = new Array(256);
  (function initGF() {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11D;
    }
  })();
  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return EXP[(LOG[a] + LOG[b]) % 255];
  }

  // ---- Reed-Solomon error-correction codewords ----
  function rsGeneratorPoly(degree) {
    let poly = [1];
    for (let i = 0; i < degree; i++) {
      const next = new Array(poly.length + 1).fill(0);
      for (let j = 0; j < poly.length; j++) {
        next[j] ^= poly[j];                       // multiply by x
        next[j + 1] ^= gfMul(poly[j], EXP[i]);    // multiply by alpha^i
      }
      poly = next;
    }
    return poly.slice(1);  // drop the leading 1 → length `degree`
  }
  const GEN = rsGeneratorPoly(EC_CODEWORDS);  // length 10

  function rsEncode(data) {
    // data: array of DATA_CODEWORDS bytes → returns EC_CODEWORDS bytes
    const res = new Array(EC_CODEWORDS).fill(0);
    for (const b of data) {
      const factor = b ^ res.shift();
      res.push(0);
      for (let i = 0; i < EC_CODEWORDS; i++) res[i] ^= gfMul(GEN[i], factor);
    }
    return res;
  }

  // ---- text → 34 data codewords ----
  function textToBytes(text) {
    const bytes = [];
    for (let i = 0; i < text.length; i++) {
      const cp = text.codePointAt(i);
      if (cp < 0x80) bytes.push(cp);
      else if (cp < 0x800) bytes.push(0xC0 | (cp >> 6), 0x80 | (cp & 0x3F));
      else if (cp < 0x10000) bytes.push(0xE0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
      else { bytes.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F)); i++; }
    }
    return bytes;
  }

  function encodeData(text) {
    const bytes = textToBytes(text);
    if (bytes.length > MAX_TEXT_BYTES) {
      throw new QRTooLongError(
        'URL is ' + bytes.length + ' characters — too long to fit a 25×25 code (max ' +
        MAX_TEXT_BYTES + '). Try a discord.gg invite link.');
    }
    const bits = [];
    const put = (value, len) => { for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
    put(0b0100, 4);             // byte-mode indicator
    put(bytes.length, 8);       // character count (8 bits for versions 1-9, byte mode)
    for (const b of bytes) put(b, 8);
    const capacityBits = DATA_CODEWORDS * 8;
    put(0, Math.min(4, capacityBits - bits.length));   // terminator
    while (bits.length % 8 !== 0) bits.push(0);        // pad to a byte boundary
    const codewords = [];
    for (let i = 0; i < bits.length; i += 8) {
      let v = 0;
      for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
      codewords.push(v);
    }
    const PADS = [0xEC, 0x11];
    let p = 0;
    while (codewords.length < DATA_CODEWORDS) codewords.push(PADS[p++ % 2]);
    return codewords;  // length 34
  }

  // ---- module matrix + reservation map ----
  function newMatrix() {
    const m = [], reserved = [];
    for (let r = 0; r < SIZE; r++) { m.push(new Array(SIZE).fill(false)); reserved.push(new Array(SIZE).fill(false)); }
    return { m, reserved };
  }
  function setFn(m, reserved, r, c, dark) { m[r][c] = dark; reserved[r][c] = true; }

  function placeFinder(m, reserved, top, left) {
    // 7x7 finder + 1-module light separator on the inner edges
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = top + r, cc = left + c;
        if (rr < 0 || rr >= SIZE || cc < 0 || cc >= SIZE) continue;
        let dark;
        if (r === -1 || r === 7 || c === -1 || c === 7) dark = false;            // separator ring
        else {
          const ring = (r === 0 || r === 6 || c === 0 || c === 6);
          const center = (r >= 2 && r <= 4 && c >= 2 && c <= 4);
          dark = ring || center;
        }
        setFn(m, reserved, rr, cc, dark);
      }
    }
  }

  function placeTiming(m, reserved) {
    for (let i = 8; i < SIZE - 8; i++) {
      const dark = (i % 2 === 0);
      if (!reserved[6][i]) setFn(m, reserved, 6, i, dark);
      if (!reserved[i][6]) setFn(m, reserved, i, 6, dark);
    }
  }

  function placeAlignment(m, reserved) {
    // version 2: a single 5x5 alignment pattern centered at module (18, 18)
    for (let r = -2; r <= 2; r++) {
      for (let c = -2; c <= 2; c++) {
        const dark = (Math.abs(r) === 2 || Math.abs(c) === 2 || (r === 0 && c === 0));
        setFn(m, reserved, 18 + r, 18 + c, dark);
      }
    }
  }

  function reserveFormatAreas(m, reserved) {
    for (let i = 0; i <= 8; i++) { reserved[i][8] = true; reserved[8][i] = true; }
    for (let i = SIZE - 8; i < SIZE; i++) { reserved[i][8] = true; reserved[8][i] = true; }
    setFn(m, reserved, SIZE - 8, 8, true);   // always-dark module at (17, 8)
  }

  // ---- data placement (zigzag, two columns at a time, from bottom-right) ----
  function placeData(m, reserved, allBits) {
    let i = 0;
    for (let right = SIZE - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;   // skip the vertical timing line (column 6)
      for (let vert = 0; vert < SIZE; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? (SIZE - 1 - vert) : vert;
          if (!reserved[y][x] && i < allBits.length) { m[y][x] = allBits[i] === 1; i++; }
        }
      }
    }
  }

  // ---- mask patterns (r = row, c = col) ----
  const MASKS = [
    (r, c) => (r + c) % 2 === 0,
    (r, c) => r % 2 === 0,
    (r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => (r * c) % 2 + (r * c) % 3 === 0,
    (r, c) => ((r * c) % 2 + (r * c) % 3) % 2 === 0,
    (r, c) => ((r + c) % 2 + (r * c) % 3) % 2 === 0,
  ];
  function applyMask(m, reserved, maskFn) {
    for (let r = 0; r < SIZE; r++)
      for (let c = 0; c < SIZE; c++)
        if (!reserved[r][c] && maskFn(r, c)) m[r][c] = !m[r][c];
  }

  // ---- format information: 5 bits → BCH(15,5) → XOR mask, written into two copies ----
  function placeFormat(m, mask) {
    const data = (0b01 << 3) | mask;   // level L = 0b01
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >> 9) * 0x537);
    const bitsVal = ((data << 10) | rem) ^ 0x5412;
    const bit = i => (bitsVal >> i) & 1;
    // Copy A (around the top-left finder)
    for (let i = 0; i <= 5; i++) m[i][8] = bit(i) === 1;          // rows 0..5, col 8   <- bits 0..5
    m[7][8] = bit(6) === 1;                                        // row 7,     col 8   <- bit 6
    m[8][8] = bit(7) === 1;                                        // row 8,     col 8   <- bit 7
    m[8][7] = bit(8) === 1;                                        // row 8,     col 7   <- bit 8
    for (let i = 9; i < 15; i++) m[8][14 - i] = bit(i) === 1;      // row 8, cols 5..0   <- bits 9..14
    // Copy B
    for (let i = 0; i < 8; i++) m[8][SIZE - 1 - i] = bit(i) === 1;        // row 8, cols 24..17 <- bits 0..7
    for (let i = 8; i < 15; i++) m[SIZE - 15 + i][8] = bit(i) === 1;      // rows 18..24, col 8 <- bits 8..14
    m[SIZE - 8][8] = true;   // always-dark module (17, 8)
  }

  // ---- penalty scoring (used only to pick the prettiest of the 8 masks) ----
  function penalty(m) {
    let score = 0;
    const lineRun = getCell => {
      let runColor = getCell(0), runLen = 1;
      for (let k = 1; k < SIZE; k++) {
        if (getCell(k) === runColor) runLen++;
        else { if (runLen >= 5) score += runLen - 2; runColor = getCell(k); runLen = 1; }
      }
      if (runLen >= 5) score += runLen - 2;
    };
    for (let r = 0; r < SIZE; r++) lineRun(k => m[r][k]);
    for (let c = 0; c < SIZE; c++) lineRun(k => m[k][c]);
    for (let r = 0; r < SIZE - 1; r++)
      for (let c = 0; c < SIZE - 1; c++)
        if (m[r][c] === m[r][c + 1] && m[r][c] === m[r + 1][c] && m[r][c] === m[r + 1][c + 1]) score += 3;
    const PAT_A = [true, false, true, true, true, false, true, false, false, false, false];
    const PAT_B = [false, false, false, false, true, false, true, true, true, false, true];
    const matchAt = (getCell, start, pat) => { for (let k = 0; k < 11; k++) if (getCell(start + k) !== pat[k]) return false; return true; };
    for (let r = 0; r < SIZE; r++)
      for (let c = 0; c <= SIZE - 11; c++)
        if (matchAt(k => m[r][k], c, PAT_A) || matchAt(k => m[r][k], c, PAT_B)) score += 40;
    for (let c = 0; c < SIZE; c++)
      for (let r = 0; r <= SIZE - 11; r++)
        if (matchAt(k => m[k][c], r, PAT_A) || matchAt(k => m[k][c], r, PAT_B)) score += 40;
    let dark = 0;
    for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) if (m[r][c]) dark++;
    const percent = dark * 100 / (SIZE * SIZE);
    score += Math.floor(Math.abs(percent - 50) / 5) * 10;
    return score;
  }

  function selectAndApplyMask(m, reserved) {
    let best = null;
    for (let mask = 0; mask < 8; mask++) {
      const trial = m.map(row => row.slice());
      applyMask(trial, reserved, MASKS[mask]);
      placeFormat(trial, mask);
      const s = penalty(trial);
      if (!best || s < best.score) best = { score: s, matrix: trial };
    }
    return best.matrix;
  }

  function encodeQR(text) {
    if (typeof text !== 'string' || text.length === 0) throw new Error('encodeQR: empty text');
    const dataCw = encodeData(text);                 // 34 bytes (throws QRTooLongError if too long)
    const ecCw = rsEncode(dataCw);                   // 10 bytes
    const allBits = [];
    for (const b of dataCw.concat(ecCw)) for (let i = 7; i >= 0; i--) allBits.push((b >> i) & 1);  // 352 bits
    const { m, reserved } = newMatrix();
    placeFinder(m, reserved, 0, 0);
    placeFinder(m, reserved, 0, SIZE - 7);
    placeFinder(m, reserved, SIZE - 7, 0);
    placeTiming(m, reserved);
    placeAlignment(m, reserved);
    reserveFormatAreas(m, reserved);
    placeData(m, reserved, allBits);
    const matrix = selectAndApplyMask(m, reserved);
    return { size: SIZE, modules: matrix };          // modules[row][col]; true = dark; row 0 = top
  }

  return { encodeQR: encodeQR, QRTooLongError: QRTooLongError, SIZE: SIZE };
}));
