/**
 * Golden-test parity harness for DuneBuilder.
 *
 * Usage:
 *   node test/golden/capture.mjs --out test/golden/baseline.json
 *   node test/golden/capture.mjs --check test/golden/baseline.json
 *
 * --out   <file>  Capture current app output and write snapshot to <file>.
 * --check <file>  Re-capture and deep-diff against <file>. Exits non-zero on any diff.
 */

import { _electron as electron } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const FIXTURES_PATH = path.join(__dirname, 'fixtures.json');

// ---------------------------------------------------------------------------
// Named constants for magic numbers
// ---------------------------------------------------------------------------
const INIT_TIMEOUT_MS   = 15_000;  // max wait for app + data to be ready

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const outIdx   = args.indexOf('--out');
const checkIdx = args.indexOf('--check');

if (outIdx === -1 && checkIdx === -1) {
  console.error('Usage: capture.mjs --out <file>  OR  capture.mjs --check <file>');
  process.exit(1);
}

// m1: --out and --check are mutually exclusive
if (outIdx !== -1 && checkIdx !== -1) {
  console.error('--out and --check are mutually exclusive. Use one at a time.');
  process.exit(1);
}

const outFile   = outIdx   !== -1 ? args[outIdx + 1]   : null;
const checkFile = checkIdx !== -1 ? args[checkIdx + 1] : null;

if (outFile == null && checkFile == null) {
  console.error('Missing file argument after --out / --check');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// appSettings defaults (must stay in sync with renderer.js loadSettings)
// ---------------------------------------------------------------------------
const APP_SETTINGS_DEFAULTS = {
  showCommons:            false,
  showFormulas:           true,
  showT0:                 false,
  showT1:                 false,
  showT2:                 false,
  showT3:                 false,
  showT4:                 false,
  showT5:                 false,
  showWeaponCommons:      false,
  showWeaponT1:           false,
  showWeaponT2:           false,
  showWeaponT3:           false,
  showWeaponT4:           false,
  showWeaponT5:           false,
  persistWeaponTypeFilter: false,
  applyStaggered:         false,
  applyHeadshot:          false,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Collapse runs of whitespace (including \n) to a single space and trim. */
function normalizeText(s) {
  return (s || '').replace(/\s+/g, ' ').trim();
}

/**
 * Deep-diff two plain objects/arrays.
 * Returns an array of { path, expected, actual } for every divergence.
 */
function deepDiff(expected, actual, prefix = '') {
  const diffs = [];

  if (typeof expected !== typeof actual) {
    diffs.push({ path: prefix, expected, actual });
    return diffs;
  }

  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      diffs.push({ path: prefix, expected, actual });
      return diffs;
    }
    const len = Math.max(expected.length, actual.length);
    for (let i = 0; i < len; i++) {
      diffs.push(...deepDiff(expected[i], actual[i], `${prefix}[${i}]`));
    }
    return diffs;
  }

  if (expected !== null && typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object') {
      diffs.push({ path: prefix, expected, actual });
      return diffs;
    }
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const k of keys) {
      diffs.push(...deepDiff(expected[k], actual[k], prefix ? `${prefix}.${k}` : k));
    }
    return diffs;
  }

  // Primitives
  if (expected !== actual) {
    diffs.push({ path: prefix, expected, actual });
  }
  return diffs;
}

// ---------------------------------------------------------------------------
// Core capture logic
// ---------------------------------------------------------------------------

async function captureAll(page) {
  const fixtures = JSON.parse(readFileSync(FIXTURES_PATH, 'utf-8'));
  const snapshot = {};

  for (const fixture of fixtures) {
    console.log(`  Capturing: ${fixture.name}`);
    const result = await captureFixture(page, fixture);
    snapshot[fixture.name] = result;
  }

  return snapshot;
}

async function captureFixture(page, fixture) {
  const { settings, build } = fixture;

  // I3: Reset ALL appSettings to baseline defaults, then overlay fixture settings.
  // This prevents settings from leaking between fixtures.
  await page.evaluate(({ defaults, overrides }) => {
    const g = window.__golden;
    Object.assign(g.appSettings, defaults, overrides);
  }, { defaults: APP_SETTINGS_DEFAULTS, overrides: settings });

  // Apply build state. applyBuildData already calls refreshPanels() internally,
  // so no explicit refreshPanels() call is needed here (I2).
  // Read #build-stats innerText inside the same evaluate so we capture the
  // synchronously-updated DOM without any setTimeout (I1 + m3).
  const calcPanelText = await page.evaluate((b) => {
    const g = window.__golden;
    g.applyBuildData(b);
    // Rendering is synchronous — DOM is fully updated by the time applyBuildData returns.
    // Ensure tooltip-panel hasn't obscured build-stats.
    const bs = document.getElementById('build-stats');
    const tp = document.getElementById('tooltip-panel');
    if (bs) bs.hidden = false;
    if (tp) tp.innerHTML = '<div class="tooltip-panel__empty">Hover an item to inspect</div>';
    return bs ? bs.innerText : '';
  }, build);

  // Capture per-slot tooltips
  const slots = {};

  // Determine which slots are populated
  const populatedSlots = await page.evaluate(() => {
    const g = window.__golden;
    const allSlots = [
      'helm', 'chest', 'gloves', 'pants', 'boots',
      'holtzman', 'belt', 'pack',
      'hotbar0', 'hotbar1', 'hotbar2', 'hotbar3',
      'hotbar4', 'hotbar5', 'hotbar6', 'hotbar7',
    ];
    return allSlots.filter(s => g.equippedItems[s] != null);
  });

  for (const slot of populatedSlots) {
    const tooltipText = await page.evaluate((slotType) => {
      const g = window.__golden;
      // Call showTooltip directly via the hook
      g.showTooltip(slotType, true);
      const panel = document.getElementById('tooltip-panel');
      return panel ? panel.innerText : '';
    }, slot);

    slots[slot] = normalizeText(tooltipText);

    // Restore build-stats after each tooltip
    await page.evaluate(() => {
      const bs = document.getElementById('build-stats');
      const tp = document.getElementById('tooltip-panel');
      if (bs) bs.hidden = false;
      if (tp) tp.innerHTML = '<div class="tooltip-panel__empty">Hover an item to inspect</div>';
    });
  }

  return {
    calcPanel: normalizeText(calcPanelText),
    slots,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('Launching Electron app...');

  let electronApp;
  try {
    electronApp = await electron.launch({
      args: [ROOT],
      cwd: ROOT,
    });
  } catch (err) {
    console.error('BLOCKED: Failed to launch Electron app.');
    console.error(err.message);
    process.exit(2);
  }

  // Get the first BrowserWindow page
  const page = await electronApp.firstWindow();
  console.log('Window ready. Waiting for app to initialise...');

  // Wait for __golden hook to be available (set after renderer.js initialises)
  try {
    await page.waitForFunction(() => typeof window.__golden !== 'undefined', { timeout: INIT_TIMEOUT_MS });
  } catch (err) {
    console.error('BLOCKED: window.__golden not found within 15s. Is the dev hook in renderer.js?');
    await electronApp.close();
    process.exit(2);
  }

  // I4: Wait for item data maps to be fully populated, including augment maps.
  try {
    await page.waitForFunction(
      () => {
        const g = window.__golden;
        return g.WEAPON_BY_SLUG      && g.WEAPON_BY_SLUG.size > 0 &&
               g.GARMENT_BY_SLUG     && g.GARMENT_BY_SLUG.size > 0 &&
               g.AUGMENT_BY_SLUG     && g.AUGMENT_BY_SLUG.size > 0 &&
               g.WEAPON_AUGMENT_BY_SLUG && g.WEAPON_AUGMENT_BY_SLUG.size > 0;
      },
      { timeout: INIT_TIMEOUT_MS }
    );
  } catch (err) {
    console.error('BLOCKED: Item data maps not fully populated within 15s.');
    await electronApp.close();
    process.exit(2);
  }

  console.log('App initialised. Running fixtures...');

  let snapshot;
  try {
    snapshot = await captureAll(page);
  } catch (err) {
    console.error('ERROR during capture:', err.message);
    await electronApp.close();
    process.exit(2);
  }

  await electronApp.close();

  // --out mode: write snapshot
  if (outFile) {
    writeFileSync(outFile, JSON.stringify(snapshot, null, 2), 'utf-8');
    console.log(`\nSnapshot written to: ${outFile}`);
    const names = Object.keys(snapshot);
    console.log(`Fixtures captured: ${names.length}`);
    for (const name of names) {
      const s = snapshot[name];
      const slotCount = Object.keys(s.slots).length;
      const calcLen = s.calcPanel.length;
      console.log(`  ${name}: calcPanel=${calcLen} chars, slots=${slotCount}`);
    }
    process.exit(0);
  }

  // --check mode: re-capture and diff
  if (checkFile) {
    let baseline;
    try {
      baseline = JSON.parse(readFileSync(checkFile, 'utf-8'));
    } catch (err) {
      console.error(`Could not read baseline file: ${checkFile}`);
      console.error(err.message);
      process.exit(1);
    }

    const diffs = deepDiff(baseline, snapshot);

    if (diffs.length === 0) {
      console.log('\nNo diffs found. Outputs match baseline exactly.');
      process.exit(0);
    } else {
      console.error(`\n${diffs.length} diff(s) found:`);
      for (const d of diffs) {
        console.error(`  PATH: ${d.path}`);
        const exp = JSON.stringify(d.expected);
        const act = JSON.stringify(d.actual);
        const expShort = exp && exp.length > 120 ? exp.slice(0, 120) + '...' : exp;
        const actShort = act && act.length > 120 ? act.slice(0, 120) + '...' : act;
        console.error(`    EXPECTED: ${expShort}`);
        console.error(`    ACTUAL:   ${actShort}`);
      }
      process.exit(1);
    }
  }
}

main().catch(err => {
  console.error('Unhandled error:', err);
  process.exit(2);
});
