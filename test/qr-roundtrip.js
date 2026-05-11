// test/qr-roundtrip.js — run with: node test/qr-roundtrip.js
// Encodes several strings, decodes each back with an independent minimal decoder,
// and asserts equality + structural sanity. Exits non-zero on any failure.
'use strict';
const { encodeQR, QRTooLongError } = require('../qr-encode.js');

const SIZE = 25;

function functionMap() {
  const f = [];
  for (let r = 0; r < SIZE; r++) f.push(new Array(SIZE).fill(false));
  const block = (top, left) => {
    for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
      const rr = top + r, cc = left + c;
      if (rr >= 0 && rr < SIZE && cc >= 0 && cc < SIZE) f[rr][cc] = true;
    }
  };
  block(0, 0); block(0, SIZE - 7); block(SIZE - 7, 0);
  for (let i = 8; i < SIZE - 8; i++) { f[6][i] = true; f[i][6] = true; }
  for (let r = -2; r <= 2; r++) for (let c = -2; c <= 2; c++) f[18 + r][18 + c] = true;
  for (let i = 0; i <= 8; i++) { f[i][8] = true; f[8][i] = true; }
  for (let i = SIZE - 8; i < SIZE; i++) { f[i][8] = true; f[8][i] = true; }
  return f;
}

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

const FORMAT_POS = [
  [0, 8], [1, 8], [2, 8], [3, 8], [4, 8], [5, 8],   // bits 0..5
  [7, 8],                                            // bit 6
  [8, 8],                                            // bit 7
  [8, 7],                                            // bit 8
  [8, 5], [8, 4], [8, 3], [8, 2], [8, 1], [8, 0],    // bits 9..14
];
function readMask(m) {
  let v = 0;
  for (let i = 0; i < 15; i++) if (m[FORMAT_POS[i][0]][FORMAT_POS[i][1]]) v |= (1 << i);
  v ^= 0x5412;
  return (v >> 10) & 0b111;
}

function readDataCodewords(m, f, maskFn) {
  const un = m.map(row => row.slice());
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++)
    if (!f[r][c] && maskFn(r, c)) un[r][c] = !un[r][c];
  const bits = [];
  for (let right = SIZE - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < SIZE; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? (SIZE - 1 - vert) : vert;
        if (!f[y][x] && bits.length < 352) bits.push(un[y][x] ? 1 : 0);
      }
    }
  }
  const cw = [];
  for (let i = 0; i < 34 * 8; i += 8) { let v = 0; for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j]; cw.push(v); }
  return cw;
}

function decode(qr) {
  const m = qr.modules, f = functionMap();
  const cw = readDataCodewords(m, f, MASKS[readMask(m)]);
  const bits = [];
  for (const b of cw) for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);
  let p = 0;
  const take = n => { let v = 0; for (let i = 0; i < n; i++) v = (v << 1) | bits[p++]; return v; };
  const mode = take(4);
  if (mode !== 0b0100) throw new Error('unexpected mode: 0b' + mode.toString(2));
  const len = take(8);
  const out = [];
  for (let i = 0; i < len; i++) out.push(take(8));
  return Buffer.from(out).toString('latin1');
}

let failures = 0;
const ok = (cond, msg) => { if (cond) console.log('OK   ' + msg); else { console.error('FAIL ' + msg); failures++; } };

const roundTrip = [
  'https://discord.gg/3sfZ7vpeXa',
  'A',
  'https://x.co/q',
  'https://discord.gg/abcdefghijklm',
];
for (const input of roundTrip) {
  try {
    const decoded = decode(encodeQR(input));
    ok(decoded === input, JSON.stringify(input) + (decoded === input ? '' : ' -> got ' + JSON.stringify(decoded)));
  } catch (e) { console.error('FAIL ' + JSON.stringify(input) + ' -> ' + e.message); failures++; }
}

try {
  encodeQR('https://discord.gg/abcdefghijklmn');
  console.error('FAIL expected QRTooLongError for a 33-char URL'); failures++;
} catch (e) {
  ok(e instanceof QRTooLongError, 'rejects a 33-char URL as too long (' + e.message + ')');
}

const qr = encodeQR('https://discord.gg/3sfZ7vpeXa');
ok(qr.size === 25 && qr.modules.length === 25 && qr.modules.every(r => r.length === 25), 'matrix is 25x25');
ok(qr.modules[0][0] && qr.modules[0][24] && qr.modules[24][0], 'all three finder corners are dark');
let timingOk = true;
for (let c = 8; c <= 16; c++) if (qr.modules[6][c] !== (c % 2 === 0)) timingOk = false;
ok(timingOk, 'row-6 timing pattern alternates correctly');
ok(qr.modules[17][8] === true, 'always-dark module (17,8) is dark');

if (failures) { console.error('\n' + failures + ' failure(s).'); process.exit(1); }
console.log('\nAll round-trip checks passed.');
