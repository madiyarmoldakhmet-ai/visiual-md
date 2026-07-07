'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');

const IntervalGenerator = require('./IntervalGenerator');
const TimeWindow = require('./TimeWindow');
const WaveScheduler = require('./WaveScheduler');
const ConfigAdapter = require('./ConfigAdapter');

/**
 * Верхняя граница ожидания завершения отправки "в полёте" при shutdown().
 * Достаточно для одного round-trip sendMessage; цикл уже остановлен, новых
 * отправок не начнётся.
 */
const INSTANCE_RUNNER_DRAIN_TIMEOUT_MS = 15_000;

/**
 * Тайм-аут HTTP-запроса к Telegram API. Короткий намеренно: алерты —
 * fire-and-forget, остановка процесса не должна ждать сети.
 */
const TELEGRAM_HTTP_TIMEOUT_MS = 5000;

/**
 * InstanceRunner — оркестратор одного инстанса рассылки WhatsApp.
 *
 * Запускается как независимый процесс (PM2/Docker). Цикл:
 *   рабочее окно → текущая волна → квота → отправка → статус → рандомная пауза.
 *
 * Конфигурация приводится к canonical-формату через `ConfigAdapter.adapt()`
 * (поддерживает как native `waves[]`, так и реальный `waveSchedule[]`).
 *
 * Graceful Shutdown: SIGINT/SIGTERM сбрасывают isRunning, _smartSleep
 * прерывает сон, цикл останавливается на следующей итерации. При наличии
 * cfg.telegram.{botToken,chatId} пушит алерты (boot/shutdown/crash) в Telegram
 * через нативный `https` — нулевых npm-зависимостей.
 */
class InstanceRunner {
  /**
   * @param {{ instanceId: string|number, configPath: string, baseDir?: string }} options
   */
  constructor({ instanceId, configPath, baseDir } = {}) {
    if (instanceId === undefined || instanceId === null || instanceId === '') {
      throw new Error('InstanceRunner: instanceId is required');
    }
    if (!configPath || typeof configPath !== 'string') {
      throw new Error('InstanceRunner: configPath is required');
    }

    this.instanceId = String(instanceId);
    this.configPath = path.isAbsolute(configPath) ? configPath : path.resolve(process.cwd(), configPath);
    this.baseDir = baseDir || path.resolve(__dirname, '..');

    // Runtime state
    this.isRunning = false;
    this.isShuttingDown = false;
    this.config = null;
    this.client = null;
    this.dataManager = null;
    this.logger = null;
    this.incomingHandler = null;
    this.waveScheduler = null;
    this.intervalGenerator = null;

    // Per-wave session counters keyed by wave index (in-memory only).
    this._waveSentCounts = new Map();
    this._currentWaveIndex = null;

    // Cursor / "final index position" for crash-safe resumption.
    this._cursor = 0;
    this._pending = [];
    this._cursorPersistedAt = 0;

    // Сериализует shutdown против отправки "в полёте": SIGTERM, пришедший
    // во время sendMessage(), НЕ рвёт отправку и не ломает состояние.
    this._dispatchInFlight = false;
    this._shutdownPromise = null;
    this._shutdownSignal = null;
    this._cleanedUp = false;

    // Bound signal handlers.
    this._sigintHandler = this._onSignal.bind(this, 'SIGINT');
    this._sigtermHandler = this._onSignal.bind(this, 'SIGTERM');
    this._signalsAttached = false;

    // Счётчик отправленных алертов (диагностика/тесты).
    this._alertsSent = 0;
  }

  /* --------------------------------------------------------------------- *
   * Public API
   * --------------------------------------------------------------------- */

  /**
   * Загружает конфиг, подключает внешние модули, запускает цикл отправки.
   * @returns {Promise<Object>} отчёт о выполненном цикле.
   */
  async run() {
    if (this.isRunning) {
      throw new Error(`InstanceRunner[${this.instanceId}]: already running`);
    }

    this.isRunning = true;
    this._attachSignalHandlers();

    try {
      // 1. Конфиг (с авто-адаптацией через ConfigAdapter + фолбэками).
      const rawConfig = this._loadConfig();
      this.config = ConfigAdapter.adapt(rawConfig);
      this._validateConfig(this.config);

      // 2. Подсистемы.
      this.waveScheduler = new WaveScheduler({
        timezone: this.config.timezone,
        waves: this.config.waves,
      });
      this.intervalGenerator = new IntervalGenerator(this.config.randomizationPercent);

      // 3. Внешние модули (resolved relative to baseDir).
      const { WhatsAppClient } = require(path.join(this.baseDir, 'core'));
      const { DataManager, Logger } = require(path.join(this.baseDir, 'data'));
      const { IncomingHandler } = require(path.join(this.baseDir, 'incoming'));

      this.logger = new Logger({ instanceId: this.instanceId, baseDir: this.baseDir });
      this.dataManager = new DataManager({ instanceId: this.instanceId, baseDir: this.baseDir });
      this.client = new WhatsAppClient({ instanceId: this.instanceId, config: this.config });
      this.incomingHandler = new IncomingHandler({
        instanceId: this.instanceId,
        client: this.client,
        dataManager: this.dataManager,
        logger: this.logger,
        telegramToken: this.config.telegram ? this.config.telegram.botToken : undefined,
        telegramChatId: this.config.telegram ? this.config.telegram.chatId : undefined,
      });

      await this.logger.info(`Instance ${this.instanceId}: booting`);

      // 3.5. Telegram-алерт о старте инстанса.
      this._alert('boot', `🟢 Instance ${this.instanceId} booted — ${this.config.waves.length} wave(s) loaded.`);

      // 4. Подключение клиента.
      await this.client.connect();

      // 5. Привязка входящих сообщений.
      if (typeof this.client.on === 'function') {
        this.client.on('message', (payload) => {
          Promise.resolve(this.incomingHandler.handle(payload)).catch((err) => {
            if (this.logger && this.logger.error) {
              this.logger.error(`Incoming handler error: ${err && err.message ? err.message : err}`).catch(() => {});
            }
          });
        });
      }

      // 6. Загрузка получателей + восстановление курсора.
      const allTargets = await this.dataManager.loadPendingTargets();
      const pending = this._filterPendingForInstance(allTargets);
      this._pending = pending;

      const savedCursor = this._loadCursor();
      if (savedCursor > 0 && savedCursor < pending.length) {
        this._cursor = savedCursor;
        await this.logger.info(
          `Instance ${this.instanceId}: resuming from cursor=${savedCursor}/${pending.length}`
        );
      } else {
        this._cursor = 0;
      }

      await this.logger.info(
        `Instance ${this.instanceId}: ${pending.length} pending recipient(s) queued`
      );

      // 7. Цикл отправки.
      const report = {
        instanceId: this.instanceId,
        startedAt: new Date().toISOString(),
        total: pending.length,
        sent: 0,
        failed: 0,
        skipped: 0,
        stopped: false,
        resumedFrom: this._cursor,
      };

      for (let i = this._cursor; i < pending.length; i++) {
        this._cursor = i;
        if (!this.isRunning) {
          report.stopped = true;
          break;
        }

        try {
          // Помечаем отправку "в полёте" — SIGTERM дождётся её завершения.
          this._dispatchInFlight = true;
          const dispatched = await this._processTarget(pending[i]);
          this._dispatchInFlight = false;
          this._cursor = i + 1;
          this._persistCursor();

          if (dispatched === 'sent') report.sent += 1;
          else if (dispatched === 'skipped') report.skipped += 1;
        } catch (err) {
          this._dispatchInFlight = false;
          report.failed += 1;
          await this.logger.error(
            `Send failed for ${this._targetId(pending[i])}: ${err && err.message ? err.message : err}`
          );
          this._cursor = i + 1;
          this._persistCursor();
        }
      }

      report.finishedAt = new Date().toISOString();

      // 8. Финализация.
      await this.logger.info(
        `Instance ${this.instanceId}: cycle complete — sent=${report.sent}, failed=${report.failed}, skipped=${report.skipped}`
      );

      if (!report.stopped) {
        this._alert(
          'cycle',
          `✅ Instance ${this.instanceId} cycle complete — sent=${report.sent}, failed=${report.failed}, skipped=${report.skipped}`
        );
      }

      return report;
    } catch (err) {
      if (this.logger && this.logger.error) {
        await this.logger.error(`Fatal: ${err && err.stack ? err.stack : err}`);
      } else {
        console.error(`[InstanceRunner ${this.instanceId}] Fatal:`, err);
      }
      this._alert(
        'crash',
        `🔴 Instance ${this.instanceId} CRASHED: ${err && err.message ? err.message : err}`
      );
      throw err;
    } finally {
      await this._cleanup();
    }
  }

  /**
   * Graceful shutdown: сбрасывает isRunning, отключает клиент, флешит данные.
   *
   * Идемпотентна: повторный вызов присоединяется к уже идущему shutdown.
   * Если отправка "в полёте" — дожидается её завершения перед финальным flush.
   *
   * @param {string} [reason]
   * @returns {Promise<void>}
   */
  async shutdown(reason = 'manual') {
    if (this._shutdownPromise) {
      return this._shutdownPromise;
    }
    this._shutdownSignal = reason;
    this.isShuttingDown = true;
    this.isRunning = false;

    this._shutdownPromise = (async () => {
      if (this.logger && this.logger.info) {
        try {
          await this.logger.info(`Instance ${this.instanceId}: shutdown initiated (${reason})`);
        } catch (_) { /* ignore */ }
      }

      // Если отправка в полёте — даём дорваться. Ограниченный полл.
      const drainStart = Date.now();
      while (this._dispatchInFlight && Date.now() - drainStart < INSTANCE_RUNNER_DRAIN_TIMEOUT_MS) {
        await this._rawSleep(25);
      }

      try { this._persistCursor(true); } catch (_) { /* best-effort */ }

      this._alert('shutdown', `🛑 Instance ${this.instanceId} shutting down (${reason})`);

      await this._cleanup();
    })().catch(() => {
      /* swallow; cleanup must not throw to the signal handler */
    });

    return this._shutdownPromise;
  }

  /* --------------------------------------------------------------------- *
   * Send pipeline
   * --------------------------------------------------------------------- */

  /**
   * Обработка одного получателя: окно → волна → квота → отправка → статус → пауза.
   * @private
   * @returns {Promise<'sent'|'skipped'>}
   */
  async _processTarget(target) {
    // (a) Рабочее окно.
    if (!this.waveScheduler.isWorkingHours()) {
      const until = this.waveScheduler._timeWindow.getTimeUntilStart();
      await this.logger.info(
        `Instance ${this.instanceId}: outside working hours; waiting ${Math.round(until / 1000)}s`
      );
      await this.waitForWorkingHours();
      if (!this.isRunning) return 'skipped';
    }

    // (b) Текущая волна.
    let wave = this.waveScheduler.getCurrentWave();
    if (!wave || !wave.isActive) {
      await this.logger.info(
        `Instance ${this.instanceId}: currently in pause; waiting for next active wave`
      );
      await this.waitForNextWave();
      if (!this.isRunning) return 'skipped';
      wave = this.waveScheduler.getCurrentWave();
      if (!wave || !wave.isActive) return 'skipped';
    }

    // (c) Квота (счётчик в памяти по индексу волны).
    if (this._currentWaveIndex !== wave.index) {
      this._currentWaveIndex = wave.index;
      if (!this._waveSentCounts.has(wave.index)) {
        this._waveSentCounts.set(wave.index, 0);
      }
    }
    const sentThisWave = this._waveSentCounts.get(wave.index) || 0;
    const remaining = this.waveScheduler.getMessageQuota(wave.index, sentThisWave);

    if (remaining <= 0) {
      await this.logger.info(
        `Instance ${this.instanceId}: wave "${wave.name}" quota reached (${sentThisWave}/${wave.messageCount}); waiting for next wave`
      );
      await this.waitForNextWave({ skipCurrentActive: true });
      if (!this.isRunning) return 'skipped';

      const refreshed = this.waveScheduler.getCurrentWave();
      if (!refreshed || !refreshed.isActive) return 'skipped';

      this._currentWaveIndex = refreshed.index;
      if (!this._waveSentCounts.has(refreshed.index)) {
        this._waveSentCounts.set(refreshed.index, 0);
      }
      const refreshedRemaining = this.waveScheduler.getMessageQuota(
        refreshed.index,
        this._waveSentCounts.get(refreshed.index) || 0
      );
      if (refreshedRemaining <= 0) return 'skipped';
      wave = refreshed;
    }

    // (d) Отправка.
    const messageBody = this._buildMessage(target);
    await this.client.sendMessage(this._targetPhone(target), messageBody);

    // (e) Статус + лог.
    await this.dataManager.updateStatus(this._targetId(target), 'sent');
    await this.logger.logSend({
      instanceId: this.instanceId,
      targetId: this._targetId(target),
      phone: this._targetPhone(target),
      wave: wave.name,
      waveIndex: wave.index,
    });

    this._waveSentCounts.set(wave.index, (this._waveSentCounts.get(wave.index) || 0) + 1);

    // (f) Рандомная пауза.
    const delayMs = this.intervalGenerator.generate(this.config.baseIntervalSec);
    await this.logger.info(
      `Instance ${this.instanceId}: sent to ${this._targetPhone(target)} | next delay=${delayMs}ms`
    );
    await this._smartSleep(delayMs);

    return 'sent';
  }

  /**
   * Ждёт открытия рабочего окна, опрашивая _smartSleep по 60с.
   * @returns {Promise<void>}
   */
  async waitForWorkingHours() {
    while (this.isRunning) {
      const until = this.waveScheduler._timeWindow.getTimeUntilStart();
      if (until <= 0) return;
      await this._smartSleep(Math.min(until, 60_000));
    }
  }

  /**
   * Ждёт следующей активной волны.
   *
   * При skipCurrentActive=true (квота исчерпана) запоминает индекс текущей
   * волны и ждёт, пока не начнётся ДРУГАЯ активная волна.
   *
   * @param {{ skipCurrentActive?: boolean }} [options]
   * @returns {Promise<void>}
   */
  async waitForNextWave(options = {}) {
    const skipWaveIndex = options.skipCurrentActive
      ? (this.waveScheduler.getCurrentWave()?.index ?? null)
      : null;

    while (this.isRunning) {
      const current = this.waveScheduler.getCurrentWave();
      if (current && current.isActive) {
        if (skipWaveIndex === null || current.index !== skipWaveIndex) return;
      }

      const next = this.waveScheduler.getNextActiveWave({
        skipCurrentActive: skipWaveIndex !== null,
      });
      if (!next || next.startsInMs <= 0) {
        await this._smartSleep(5_000);
        continue;
      }
      await this._smartSleep(Math.min(next.startsInMs, 60_000));
    }
  }

  /* --------------------------------------------------------------------- *
   * Smart sleep — отзывчив к остановке
   * --------------------------------------------------------------------- */

  /**
   * Спит `ms`, разбивая на отрезки 2–5с. Проверяет isRunning перед каждым
   * отрезком — при shutdown сон мгновенно прерывается.
   * @private
   * @param {number} ms
   * @returns {Promise<void>}
   */
  async _smartSleep(ms) {
    let remaining = Math.max(0, Math.floor(ms));
    while (remaining > 0 && this.isRunning) {
      const slice = Math.min(remaining, this._randomInt(2000, 5000));
      await this._rawSleep(slice);
      remaining -= slice;
    }
  }

  /** @private */
  _randomInt(min, max) {
    return min + Math.floor(Math.random() * (max - min + 1));
  }

  /** @private */
  _rawSleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /* --------------------------------------------------------------------- *
   * Config / data helpers
   * --------------------------------------------------------------------- */

  /** @private */
  _loadConfig() {
    const raw = fs.readFileSync(this.configPath, 'utf8');
    const parsed = JSON.parse(raw);
    // Нормализуем instanceId из конфига, если конструктору не передали явный.
    if (
      (this.instanceId === undefined || this.instanceId === null || this.instanceId === '') &&
      parsed && parsed.instanceId !== undefined && parsed.instanceId !== null
    ) {
      this.instanceId = String(parsed.instanceId);
    }
    return parsed;
  }

  /** @private */
  _validateConfig(cfg) {
    if (!cfg || typeof cfg !== 'object') {
      throw new Error('InstanceRunner: config must be a JSON object');
    }
    if (!Array.isArray(cfg.waves) || cfg.waves.length === 0) {
      throw new Error('InstanceRunner: config.waves must be a non-empty array');
    }
  }

  /* --------------------------------------------------------------------- *
   * Cursor persistence (crash-safe resumption)
   * --------------------------------------------------------------------- */

  /** @private — путь к JSON-файлу курсора для этого инстанса. */
  _cursorPath() {
    return path.join(this.baseDir, 'data', `cursor_instance_${this.instanceId}.json`);
  }

  /**
   * Читает сохранённый курсор. При отсутствии/повреждении возвращает 0.
   * @private
   * @returns {number}
   */
  _loadCursor() {
    try {
      const p = this._cursorPath();
      if (!fs.existsSync(p)) return 0;
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      const n = Number(data && data.cursor);
      return Number.isInteger(n) && n >= 0 ? n : 0;
    } catch (_) {
      return 0;
    }
  }

  /**
   * Атомарно фиксирует курсор (write-temp + fsync + rename). Throttle — не
   * чаще раза в секунду, КРОМЕ финального flush при shutdown (force=true).
   * @private
   */
  _persistCursor(force = false) {
    const now = Date.now();
    if (!force && now - this._cursorPersistedAt < 1000) return;
    this._cursorPersistedAt = now;

    const target = this._cursorPath();
    const payload = JSON.stringify({
      instanceId: this.instanceId,
      cursor: this._cursor,
      total: Array.isArray(this._pending) ? this._pending.length : null,
      committedAt: new Date().toISOString(),
    }, null, 2);

    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const tmpPath = path.join(
        path.dirname(target),
        `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
      );
      const fd = fs.openSync(tmpPath, 'w');
      try {
        fs.writeFileSync(fd, payload);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmpPath, target);
    } catch (_) {
      /* best-effort persistence */
    }
  }

  /* --------------------------------------------------------------------- *
   * Recipient partitioning helpers
   * --------------------------------------------------------------------- */

  /**
   * Фильтрует получателей по instanceId: явное поле instanceId в строке
   * имеет приоритет, иначе — детерминированное хеш-разделение.
   * @private
   */
  _filterPendingForInstance(targets) {
    if (!Array.isArray(targets)) return [];

    const totalInstances =
      typeof this.config.totalInstances === 'number' && this.config.totalInstances > 0
        ? this.config.totalInstances
        : null;

    return targets.filter((t) => {
      if (!t) return false;
      if (t.instanceId !== undefined) return String(t.instanceId) === this.instanceId;
      if (totalInstances) {
        return this._hash(this._targetId(t)) % totalInstances === Number(this.instanceId) % totalInstances;
      }
      return false;
    });
  }

  /** @private */
  _hash(str) {
    const s = String(str);
    let h = 0;
    for (let i = 0; i < s.length; i++) {
      h = (h << 5) - h + s.charCodeAt(i);
      h |= 0;
    }
    return Math.abs(h);
  }

  /** @private */
  _targetId(t) {
    if (!t) return null;
    return t.id !== undefined ? t.id : t.phone !== undefined ? t.phone : JSON.stringify(t);
  }

  /** @private */
  _targetPhone(t) {
    if (!t) return null;
    return t.phone !== undefined ? t.phone : t.id;
  }

  /** @private */
  _buildMessage(t) {
    const template = (this.config && this.config.messageTemplate) || 'Hello {name}';
    if (!t) return template;
    return template
      .replace(/\{name\}/g, t.name || (t.firstName ? `${t.firstName} ${t.lastName || ''}`.trim() : ''))
      .replace(/\{phone\}/g, t.phone || '')
      .replace(/\{id\}/g, t.id !== undefined ? String(t.id) : '');
  }

  /* --------------------------------------------------------------------- *
   * Telegram alerting — zero-dependency native https
   * --------------------------------------------------------------------- */

  /**
   * Отправляет алерт в Telegram-чат, настроенный в cfg.telegram.
   *
   * Контракт:
   *   - Нативный `https`, 0 npm-зависимостей.
   *   - Fire-and-forget: НИКОГДА не бросает и не блокирует вызывающий код.
   *   - При отсутствии telegram.botToken/chatId — тихо пропускает.
   *   - Тайм-аут 5с — процесс не виснет на сети.
   *
   * @private
   * @param {'boot'|'shutdown'|'crash'|'cycle'|string} event
   * @param {string} text
   * @returns {void}
   */
  _alert(event, text) {
    const token = this.config && this.config.telegram && this.config.telegram.botToken;
    const chatId = this.config && this.config.telegram && this.config.telegram.chatId;

    if (!token || !chatId) return;

    const stamp = new Date().toISOString();
    const message = `🤖 [${this.instanceId}] (${event}) ${stamp}\n${text}`;

    this._postTelegram(token, chatId, message).then(
      () => { this._alertsSent += 1; },
      () => { /* network/Telegram error — non-fatal */ }
    );
  }

  /**
   * Реализация единичного POST к Telegram Bot API sendMessage.
   * @private
   * @param {string} token
   * @param {string} chatId
   * @param {string} text
   * @returns {Promise<{ok:boolean}>}
   */
  _postTelegram(token, chatId, text) {
    return new Promise((resolve, reject) => {
      let body;
      try {
        body = JSON.stringify({ chat_id: String(chatId), text, disable_web_page_preview: true });
      } catch (e) {
        return reject(e);
      }

      const options = {
        method: 'POST',
        hostname: 'api.telegram.org',
        path: `/bot${token}/sendMessage`,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: TELEGRAM_HTTP_TIMEOUT_MS,
      };

      const req = https.request(options, (res) => {
        res.resume();
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ ok: true });
          } else {
            reject(new Error(`Telegram API responded ${res.statusCode}`));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        try { req.destroy(new Error('Telegram request timed out')); } catch (_) { /* ignore */ }
      });

      req.write(body);
      req.end();
    });
  }

  /* --------------------------------------------------------------------- *
   * Lifecycle / signals
   * --------------------------------------------------------------------- */

  /** @private */
  _attachSignalHandlers() {
    if (this._signalsAttached) return;
    try {
      process.on('SIGINT', this._sigintHandler);
      process.on('SIGTERM', this._sigtermHandler);
      this._signalsAttached = true;
    } catch (_) { /* environments without signals */ }
  }

  /** @private */
  _detachSignalHandlers() {
    if (!this._signalsAttached) return;
    try {
      process.removeListener('SIGINT', this._sigintHandler);
      process.removeListener('SIGTERM', this._sigtermHandler);
    } catch (_) { /* ignore */ }
    this._signalsAttached = false;
  }

  /** @private */
  _onSignal(signal) {
    Promise.resolve(this.shutdown(signal)).catch(() => { /* ignore */ });
  }

  /**
   * Идемпотентный teardown. Безопасно вызывать и из finally-block run(), и
   * из shutdown(); guard предотвращает двойной disconnect / double-flush.
   * @private
   */
  async _cleanup() {
    if (this._cleanedUp) return;
    this._cleanedUp = true;

    this._detachSignalHandlers();

    if (this.client && typeof this.client.disconnect === 'function') {
      try { await this.client.disconnect(); } catch (_) { /* ignore */ }
    }
    if (this.dataManager && typeof this.dataManager.flush === 'function') {
      try { await this.dataManager.flush(); } catch (_) { /* ignore */ }
    }

    const id = this.instanceId;
    try {
      console.log(`[Agent ${id}] Successfully disengaged gracefully without loss of state`);
    } catch (_) { /* ignore */ }

    if (this.logger && typeof this.logger.close === 'function') {
      try { await this.logger.close(); } catch (_) { /* ignore */ }
    }
  }
}

module.exports = InstanceRunner;
module.exports.InstanceRunner = InstanceRunner;
module.exports.IntervalGenerator = IntervalGenerator;
module.exports.TimeWindow = TimeWindow;
module.exports.WaveScheduler = WaveScheduler;
module.exports.ConfigAdapter = ConfigAdapter;

/* --------------------------------------------------------------------- *
 * Process entry point
 * --------------------------------------------------------------------- *
 * Когда PM2 (или `node scheduler/InstanceRunner.js`) запускает этот файл
 * напрямую — парсит argv (--config <path> --id <n>), строит runner и
 * выполняет цикл. При чистом завершении — exit 0; фатальная ошибка — exit 1.
 */
if (require.main === module) {
  const argv = process.argv.slice(2);
  const getOpt = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
  };

  const configPath = getOpt('--config');
  const id = getOpt('--id') || process.env.INSTANCE_ID;

  if (!configPath || id === null || id === undefined) {
    console.error('Usage: node scheduler/InstanceRunner.js --config <path> --id <n>');
    process.exit(2);
  }

  const runner = new InstanceRunner({ instanceId: id, configPath });

  runner
    .run()
    .then(() => { process.exit(0); })
    .catch(() => { process.exit(1); });
}
