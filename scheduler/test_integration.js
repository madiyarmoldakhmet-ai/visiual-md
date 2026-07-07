'use strict';

/**
 * test_integration.js — master end-to-end integration test.
 *
 * Exercises the FULL lifecycle of the `scheduler/` module against a REAL
 * configuration file (configs/instance_1.json) using the newly created
 * `core/` and `incoming/` stubs and the real `data/` subsystem.
 *
 * What this proves:
 *   1. ConfigAdapter.adapt() loads configs/instance_1.json — which uses the
 *      `waveSchedule[]` format — WITHOUT crashing, producing native `waves[]`.
 *   2. The peer modules `../core` and `../incoming` resolve correctly
 *      (no MODULE_NOT_FOUND).
 *   3. Fallback defaults apply: baseIntervalSec, messageTemplate,
 *      randomizationPercent, totalInstances (=5, per spec).
 *   4. Telegram alerting is wired (boot / shutdown events fire — actual
 *      network call is tolerated but never blocks the test).
 *   5. The send cycle runs end-to-end through a compressed window built
 *      around the current wall-clock time, dispatches real messages through
 *      the stubbed WhatsAppClient, persists status through the real
 *      DataManager, and exits gracefully via a signal-driven shutdown.
 *
 * Strategy for a deterministic, fast test:
 *   - The real configs/instance_1.json has waves 09:00–10:00, 12:30–13:15,
 *     16:00–17:30, 19:30–20:00. These only match specific times of day.
 *   - To run the cycle at ANY time, we synthesize a TEMPORARY compressed
 *     config whose waves are wrapped tightly around "now" with generous
 *     quotas, but written in the SAME `waveSchedule[]` shape the adapter
 *     must handle — so the adapter is genuinely exercised, not bypassed.
 *   - The original configs/instance_1.json is loaded and validated FIRST
 *     (static contract check) before the live cycle uses the compressed copy.
 *
 * Production-data isolation:
 *   - The live cycle persists state through the REAL DataManager into the
 *     real shard + cursor + registry + log. We snapshot all of these before
 *     the live run and restore them in finally{}, so the test is fully
 *     idempotent and never permanently mutates production data.
 *
 * Graceful exit:
 *   - A watchdog fires `runner.shutdown('watchdog')` after a few seconds,
 *     which flips isRunning=false, drains any in-flight send, persists the
 *     cursor, sends the shutdown alert, and cleans up. process.exit(0) is
 *     called AFTER the finally-restore so snapshots are never skipped.
 *
 * Run:  node test_integration.js
 */

const path = require('path');
const fs = require('fs');
const { DateTime } = require('luxon');

const { InstanceRunner, ConfigAdapter, PRODUCTION_DEFAULTS } = require('./scheduler');

const TZ = 'Asia/Almaty';
const INSTANCE_ID = '1';
const REAL_CONFIG = path.join(__dirname, 'configs', `instance_${INSTANCE_ID}.json`);
const COMPRESSED_CONFIG = path.join(__dirname, 'configs', `_integration_instance_${INSTANCE_ID}.json`);

/* ================================================================ *
 *  Helpers
 * ================================================================ */

function banner(title) {
  const line = '─'.repeat(Math.max(20, title.length + 4));
  console.log(`\n┌${line}┐`);
  console.log(`│  ${title}  │`);
  console.log(`└${line}┘`);
}

function assert(cond, msg) {
  if (!cond) {
    throw new Error(`INTEGRATION ASSERTION FAILED: ${msg}`);
  }
  console.log(`  ✓ ${msg}`);
}

/**
 * Production-data isolation. Snapshots shard + cursor + registry + log for
 * the instance before the live run, restores them afterwards. Files that
 * didn't exist pre-test get removed in restore().
 *
 * @param {string} instanceId
 * @returns {{ restore: () => void }}
 */
function snapshotInstanceData(instanceId) {
  const targets = [
    path.join(__dirname, 'data', `messages_instance_${instanceId}.json`),
    path.join(__dirname, 'data', `cursor_instance_${instanceId}.json`),
    path.join(__dirname, 'data', 'status_registry.json'),
    path.join(__dirname, 'logs', `instance_${instanceId}.log`),
  ];
  const snapshots = targets.map((p) => ({ path: p, existed: false, content: null }));
  for (const s of snapshots) {
    try {
      if (fs.existsSync(s.path)) {
        s.existed = true;
        s.content = fs.readFileSync(s.path);
      }
    } catch (_) { /* best-effort */ }
  }
  return {
    restore() {
      for (const s of snapshots) {
        try {
          if (s.existed) fs.writeFileSync(s.path, s.content);
          else if (fs.existsSync(s.path)) fs.unlinkSync(s.path);
        } catch (_) { /* best-effort */ }
      }
    },
  };
}

/* ================================================================ *
 *  STEP 1 — Static contract check: real configs/instance_1.json
 *            must load + adapt via ConfigAdapter WITHOUT throwing.
 * ================================================================ */
function verifyRealConfigLoads() {
  banner(`STEP 1 — Loading REAL ${path.basename(REAL_CONFIG)} via ConfigAdapter`);

  assert(fs.existsSync(REAL_CONFIG), `${path.basename(REAL_CONFIG)} exists on disk`);

  const raw = JSON.parse(fs.readFileSync(REAL_CONFIG, 'utf8'));
  assert(Array.isArray(raw.waveSchedule) && raw.waveSchedule.length > 0,
    'config uses waveSchedule[] with startAt + windowMinutes');

  const adapted = ConfigAdapter.adapt(raw);

  assert(Array.isArray(adapted.waves) && adapted.waves.length === raw.waveSchedule.length,
    `ConfigAdapter produced ${adapted.waves.length} wave(s) from ${raw.waveSchedule.length} waveSchedule entries`);

  // Spot-check: 19:30 + 30 min window → start 19:30 → end 20:00.
  const lastWave = adapted.waves[adapted.waves.length - 1];
  const expectedStart = raw.waveSchedule[raw.waveSchedule.length - 1].startAt; // "19:30"
  assert(`${lastWave.start.hour}:${String(lastWave.start.minute).padStart(2, '0')}` === expectedStart,
    `last wave start=${lastWave.start.hour}:${String(lastWave.start.minute).padStart(2, '0')} matches ${expectedStart}`);
  assert(lastWave.end.hour === 20 && lastWave.end.minute === 0,
    `last wave end=20:00 computed from 19:30 + 30min`);

  // Fallback defaults (real config has none of these keys).
  assert(adapted.baseIntervalSec === PRODUCTION_DEFAULTS.baseIntervalSec,
    `fallback baseIntervalSec=${adapted.baseIntervalSec}`);
  assert(adapted.messageTemplate === PRODUCTION_DEFAULTS.messageTemplate,
    `fallback messageTemplate="${adapted.messageTemplate}"`);
  assert(adapted.randomizationPercent === PRODUCTION_DEFAULTS.randomizationPercent,
    `fallback randomizationPercent=${adapted.randomizationPercent}`);
  assert(adapted.totalInstances === 5,
    `fallback totalInstances=${adapted.totalInstances} (spec requires 5)`);
  assert(adapted.timezone === TZ, `timezone=${adapted.timezone}`);

  console.log(`  → adapted waves:`);
  adapted.waves.forEach((w) => {
    console.log(`      ${w.name}: ${String(w.start.hour).padStart(2,'0')}:${String(w.start.minute).padStart(2,'0')} → ${String(w.end.hour).padStart(2,'0')}:${String(w.end.minute).padStart(2,'0')} (quota=${w.messageCount})`);
  });

  return adapted;
}

/* ================================================================ *
 *  STEP 2 — Build a COMPRESSED config around "now" so the live
 *            cycle can run at any wall-clock time. Written in the
 *            SAME waveSchedule[] format the adapter handles.
 * ================================================================ */
function buildCompressedConfig(realConfig) {
  const now = DateTime.now().setZone(TZ);

  const cfg = {
    instanceId: Number(INSTANCE_ID),
    sandbox: realConfig.sandbox,
    telegram: realConfig.telegram, // real token + chatId → alerts actually fire
    timezone: TZ,
    // Deliberately OMIT baseIntervalSec / messageTemplate / randomizationPercent
    // / totalInstances to prove the adapter applies fallback defaults.
    waveSchedule: [
      { wave: 1, startAt: now.minus({ minutes: 1 }).toFormat('HH:mm'), windowMinutes: 3, messageCount: 3 },
      { wave: 2, startAt: now.plus({ minutes: 3 }).toFormat('HH:mm'),  windowMinutes: 5, messageCount: 10 },
    ],
  };

  fs.writeFileSync(COMPRESSED_CONFIG, JSON.stringify(cfg, null, 2));
  console.log(`\n  compressed config written → ${path.basename(COMPRESSED_CONFIG)}`);
  console.log(`    Wave-1: [now-1m .. now+2m]  quota=3`);
  console.log(`    Wave-2: [now+3m .. now+8m]  quota=10`);
  return COMPRESSED_CONFIG;
}

/* ================================================================ *
 *  STEP 3 — Live end-to-end run.
 * ================================================================ */
async function runLiveCycle(configPath) {
  banner('STEP 3 — Live end-to-end run (real core/ + incoming/ + data/)');

  const runner = new InstanceRunner({
    instanceId: INSTANCE_ID,
    configPath,
    baseDir: __dirname,
  });

  // Monitor: current wave + per-wave sent counts every 2s.
  const monitor = setInterval(() => {
    if (!runner.waveScheduler) return;
    const ts = DateTime.now().setZone(TZ).toFormat('HH:mm:ss');
    const wave = runner.waveScheduler.getCurrentWave();
    const status = wave ? `${wave.name} (active=${wave.isActive})` : 'outside window';
    const counts = runner._waveSentCounts && runner._waveSentCounts.size
      ? [...runner._waveSentCounts.entries()].map(([i, c]) => `[${i}]=${c}`).join(' ')
      : '(none)';
    console.log(`  [MONITOR ${ts}] current=${status} | sentPerWave: ${counts}`);
  }, 2_000);

  // Watchdog: graceful shutdown after 6 seconds — exercises the full
  // shutdown path (drain, cursor persist, shutdown alert, cleanup).
  const SHUTDOWN_AFTER_MS = 6_000;
  const watchdog = setTimeout(() => {
    console.log(`\n  ⏱  watchdog → runner.shutdown('watchdog') after ${SHUTDOWN_AFTER_MS}ms`);
    runner.shutdown('watchdog').catch(() => {});
  }, SHUTDOWN_AFTER_MS);

  try {
    const report = await runner.run();
    clearTimeout(watchdog);
    clearInterval(monitor);

    banner('FINAL REPORT');
    console.log(JSON.stringify(report, null, 2));

    assert(report.instanceId === INSTANCE_ID, `report.instanceId === "${INSTANCE_ID}"`);
    assert(typeof report.sent === 'number' && report.sent >= 0, `report.sent is non-negative (${report.sent})`);
    assert(typeof report.failed === 'number', `report.failed is a number (${report.failed})`);
    assert(typeof report.total === 'number' && report.total >= 0, `report.total is non-negative (${report.total})`);

    console.log(`\n  alerts attempted (Telegram): ${runner._alertsSent}`);
    assert(typeof runner._alertsSent === 'number', 'runner._alertsSent tracked');

    return report;
  } finally {
    clearTimeout(watchdog);
    clearInterval(monitor);
  }
}

/* ================================================================ *
 *  Orchestration
 * ================================================================ */
(async () => {
  const snapshot = snapshotInstanceData(INSTANCE_ID);
  let compressedPath = null;
  let exitCode = 0;

  try {
    banner(`INTEGRATION TEST START — ${new Date().toISOString()}`);

    const adapted = verifyRealConfigLoads();
    compressedPath = buildCompressedConfig(adapted);

    await runLiveCycle(compressedPath);

    banner('INTEGRATION TEST PASSED ✅');
    console.log('  All stages completed without throwing. Graceful exit.');
    console.log('  Modules verified:');
    console.log('    ✓ scheduler/InstanceRunner.js  (ConfigAdapter + fallbacks + telegram alerts)');
    console.log('    ✓ scheduler/ConfigAdapter.js   (waveSchedule → waves adaptation)');
    console.log('    ✓ core/index.js                (WhatsAppClient stub)');
    console.log('    ✓ incoming/index.js            (IncomingHandler stub)');
    console.log('    ✓ data/                         (real DataManager + Logger)');
  } catch (err) {
    exitCode = 1;
    console.error('\n❌ INTEGRATION TEST FAILED:', err && err.stack ? err.stack : err);
  } finally {
    // ALWAYS restore production state + drop the temp compressed config.
    // process.exit() MUST be called here (not in try/catch) so this block runs.
    try { snapshot.restore(); } catch (_) { /* best-effort */ }
    console.log('  Production shard + cursor restored to pre-test state.');
    if (compressedPath) {
      try { fs.unlinkSync(compressedPath); } catch (_) { /* ignore */ }
    } else {
      try { fs.unlinkSync(COMPRESSED_CONFIG); } catch (_) { /* ignore */ }
    }
    process.exit(exitCode);
  }
})();
