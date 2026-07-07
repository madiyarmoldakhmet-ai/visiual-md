'use strict';

/**
 * test_run.js — демонстрация работы InstanceRunner #1 с моками.
 *
 * Подменяет внешние модули (../core, ../data, ../incoming) in-memory моками
 * через monkey-patch Module._load и запускает полный цикл отправки.
 *
 * Генерирует сжатый конфиг вокруг текущего времени, чтобы за ~3 минуты
 * показать: Wave → Pause → Wave с переходом через квоту.
 *
 * Запуск: node test_run.js
 */

const path = require('path');
const fs = require('fs');
const Module = require('module');
const { DateTime } = require('luxon');

const { InstanceRunner } = require('./scheduler');
const TZ = 'Asia/Almaty';

/* ================================================================ *
 *  Моки внешних модулей
 * ================================================================ */

class MockWhatsAppClient {
  constructor({ instanceId }) {
    this.instanceId = instanceId;
    console.log(`[core][${instanceId}] WhatsAppClient init`);
  }
  async connect()    { console.log(`[core][${this.instanceId}] connect() OK`); }
  async disconnect() { console.log(`[core][${this.instanceId}] disconnect() OK`); }
  async sendMessage(phone, body) {
    const ts = DateTime.now().setZone(TZ).toFormat('HH:mm:ss');
    console.log(`[${ts}] [SEND][${this.instanceId}] -> ${phone}: "${body}"`);
  }
  on(event, fn) { /* no-op for mock */ }
}

class MockDataManager {
  constructor({ instanceId }) {
    this.instanceId = instanceId;
    this._store = [];
  }
  async loadPendingTargets() {
    return ['t1','t2','t3','t4','t5'].map((id, i) => ({
      id, phone: `+7701000000${i + 1}`, name: `Получатель ${i + 1}`, instanceId: '1',
    }));
  }
  async updateStatus(targetId, status) {
    this._store.push({ targetId, status });
    console.log(`  [DB][${this.instanceId}] ${targetId} -> ${status}`);
  }
  async flush() { console.log(`  [DB][${this.instanceId}] flush() — ${this._store.length} records`); }
}

class MockLogger {
  constructor({ instanceId }) { this.instanceId = instanceId; }
  async info(msg)      { console.log(`  [LOG][${this.instanceId}] INFO  ${msg}`); }
  async error(msg)     { console.error(`  [LOG][${this.instanceId}] ERROR ${msg}`); }
  async logSend(data)  { console.log(`  [LOG][${this.instanceId}] SEND wave="${data.wave}" -> ${data.phone}`); }
  async close()        { console.log(`  [LOG][${this.instanceId}] close()`); }
}

class MockIncomingHandler {
  constructor({ instanceId }) { this.instanceId = instanceId; }
  async handle(payload) { console.log(`  [INCOMING][${this.instanceId}] ${JSON.stringify(payload)}`); }
}

const mocks = {
  core:    { WhatsAppClient: MockWhatsAppClient },
  data:    { DataManager: MockDataManager, Logger: MockLogger },
  incoming: { IncomingHandler: MockIncomingHandler },
};

/* ================================================================ *
 *  Monkey-patch require
 * ================================================================ */
const originalLoad = Module._load;
Module._load = function (request) {
  if (typeof request === 'string') {
    if (request.endsWith('/core'))     return mocks.core;
    if (request.endsWith('/data'))     return mocks.data;
    if (request.endsWith('/incoming')) return mocks.incoming;
  }
  return originalLoad.apply(this, arguments);
};

/* ================================================================ *
 *  Сжатый конфиг (минутная гранулярность вокруг now)
 *
 *  Wave-1 : [now-1m .. now+1m]  quota=2
 *  Pause-1: [now+1m .. now+2m]
 *  Wave-2 : [now+2m .. now+5m]  quota=5
 * ================================================================ */
function generateConfig() {
  const now = DateTime.now().setZone(TZ);
  const fmt = (dt) => ({ hour: dt.hour, minute: dt.minute });

  return {
    instanceId: '1',
    totalInstances: 1,
    timezone: TZ,
    randomizationPercent: 20,
    baseIntervalSec: 1,
    messageTemplate: 'Привет, {name}! Демо-рассылка.',
    telegram: {
      botToken: process.env.TELEGRAM_BOT_TOKEN || '',
      chatId: process.env.TELEGRAM_CHAT_ID || '',
    },
    waves: [
      { name: 'Wave-1',  start: fmt(now.minus({ minutes: 1 })), end: fmt(now.plus({ minutes: 1 })), messageCount: 2 },
      { name: 'Pause-1', start: fmt(now.plus({ minutes: 1 })),  end: fmt(now.plus({ minutes: 2 })), messageCount: 0 },
      { name: 'Wave-2',  start: fmt(now.plus({ minutes: 2 })),  end: fmt(now.plus({ minutes: 5 })), messageCount: 5 },
    ],
  };
}

/* ================================================================ *
 *  Запуск
 * ================================================================ */
(async () => {
  const configPath = path.join(__dirname, 'configs', '_demo_instance_1.json');
  fs.writeFileSync(configPath, JSON.stringify(generateConfig(), null, 2));

  console.log('═══════════════════════════════════════════════════════');
  console.log(` DEMO InstanceRunner #1 — ${DateTime.now().setZone(TZ).toFormat('HH:mm:ss')} (${TZ})`);
  console.log(' Wave-1(quota=2) → Pause-1 → Wave-2(quota=5)');
  console.log('═══════════════════════════════════════════════════════\n');

  const runner = new InstanceRunner({
    instanceId: '1',
    configPath,
    baseDir: __dirname,
  });

  // Монитор состояния каждые 10с.
  const monitor = setInterval(() => {
    if (!runner.waveScheduler) return;
    const wave = runner.waveScheduler.getCurrentWave();
    const status = wave ? `${wave.name} (active=${wave.isActive})` : 'outside';
    const counts = [...runner._waveSentCounts.entries()].map(([i, c]) => `[${i}]=${c}`).join(' ') || '(none)';
    console.log(`[MONITOR] ${status} | sent: ${counts}`);
  }, 10_000);

  // Watchdog на 240с.
  const watchdog = setTimeout(() => runner.shutdown('watchdog'), 240_000);

  try {
    const report = await runner.run();
    console.log('\n═══════════════════════════════════════════════════════');
    console.log(' FINAL REPORT');
    console.log(JSON.stringify(report, null, 2));
    console.log('═══════════════════════════════════════════════════════');
  } catch (err) {
    console.error('\nFATAL:', err && err.stack ? err.stack : err);
    process.exit(1);
  } finally {
    clearTimeout(watchdog);
    clearInterval(monitor);
    try { fs.unlinkSync(configPath); } catch (_) { /* ignore */ }
  }
})();