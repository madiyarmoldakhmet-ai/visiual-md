'use strict';

/**
 * ConfigAdapter — приводит JSON-конфиг к canonical-формату WaveScheduler.
 *
 * Поддерживает два формата входа:
 *   1) "native"  cfg.waves[]        { start:{hour,minute}, end:{...}, messageCount }
 *   2) "schedule" cfg.waveSchedule[] { startAt:"19:30", windowMinutes:30 }
 *
 * Возвращает нормализованный объект с fields:
 *   { timezone, waves[], baseIntervalSec, messageTemplate, randomizationPercent, ... }
 */

const DEFAULTS = Object.freeze({
  baseIntervalSec: 540,
  messageTemplate: 'Hello {name}',
  randomizationPercent: 20,
  totalInstances: 5,
  timezone: 'Asia/Almaty',
  messageCountPerWave: 50,
});

/**
 * Публичный alias для продакшен-дефолтов — используется интеграционными
 * тестами и дашбордами для интроспекции точных значений фолбэков.
 */
const PRODUCTION_DEFAULTS = DEFAULTS;

class ConfigAdapter {
  /**
   * @param {object} raw — исходный JSON.
   * @returns {object} адаптированный конфиг (новый объект).
   */
  static adapt(raw) {
    if (!raw || typeof raw !== 'object') {
      throw new Error('ConfigAdapter: config must be a JSON object');
    }
    const cfg = JSON.parse(JSON.stringify(raw));

    // (1) Конвертация waveSchedule → waves.
    if ((!Array.isArray(cfg.waves) || cfg.waves.length === 0) && Array.isArray(cfg.waveSchedule)) {
      cfg.waves = ConfigAdapter._convertWaveSchedule(cfg.waveSchedule);
    }

    // (2) Нормализация native waves.
    if (Array.isArray(cfg.waves)) {
      cfg.waves = cfg.waves.map((w, i) => ConfigAdapter._normalizeWave(w, i));
    }

    // (3) Дефолты опциональных ключей.
    ConfigAdapter._applyDefaults(cfg);
    return cfg;
  }

  /** @private */
  static _convertWaveSchedule(entries) {
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new Error('ConfigAdapter: waveSchedule is empty or invalid');
    }
    return entries.map((e, i) => {
      const start = ConfigAdapter._parseClock(e.startAt || e.start, `waveSchedule[${i}].startAt`);
      const windowMinutes = typeof e.windowMinutes === 'number' && e.windowMinutes > 0
        ? Math.floor(e.windowMinutes)
        : 30;
      const end = ConfigAdapter._addMinutes(start, windowMinutes);
      const messageCount = typeof e.messageCount === 'number'
        ? e.messageCount
        : (typeof e.quota === 'number' ? e.quota : DEFAULTS.messageCountPerWave);
      return {
        name: e.name || `Wave ${e.wave !== undefined ? e.wave : i + 1}`,
        start,
        end,
        messageCount,
        pause: messageCount === 0 || e.pause === true,
      };
    });
  }

  /** @private */
  static _normalizeWave(raw, index) {
    if (!raw || typeof raw !== 'object') {
      throw new Error(`ConfigAdapter: waves[${index}] must be an object`);
    }
    const need = (v) => v && typeof v === 'object' && typeof v.hour === 'number' && typeof v.minute === 'number';
    if (!need(raw.start)) throw new Error(`ConfigAdapter: waves[${index}].start must be { hour, minute }`);
    if (!need(raw.end))   throw new Error(`ConfigAdapter: waves[${index}].end must be { hour, minute }`);
    const messageCount = typeof raw.messageCount === 'number' ? raw.messageCount : DEFAULTS.messageCountPerWave;
    return {
      name: raw.name || `Wave ${index + 1}`,
      start: { hour: raw.start.hour, minute: raw.start.minute },
      end: { hour: raw.end.hour, minute: raw.end.minute },
      messageCount,
      pause: messageCount === 0 || raw.pause === true,
    };
  }

  /** @private */
  static _applyDefaults(cfg) {
    if (typeof cfg.baseIntervalSec !== 'number' || cfg.baseIntervalSec < 0) {
      cfg.baseIntervalSec = DEFAULTS.baseIntervalSec;
    }
    if (typeof cfg.messageTemplate !== 'string' || !cfg.messageTemplate.trim()) {
      cfg.messageTemplate = DEFAULTS.messageTemplate;
    }
    if (typeof cfg.randomizationPercent !== 'number' || Number.isNaN(cfg.randomizationPercent)) {
      cfg.randomizationPercent = DEFAULTS.randomizationPercent;
    }
    cfg.randomizationPercent = Math.max(0, Math.min(100, cfg.randomizationPercent));
    if (typeof cfg.totalInstances !== 'number' || cfg.totalInstances <= 0) {
      cfg.totalInstances = DEFAULTS.totalInstances;
    }
    if (typeof cfg.timezone !== 'string' || !cfg.timezone.trim()) {
      cfg.timezone = DEFAULTS.timezone;
    }
  }

  /** @private — парсит "HH:MM" в { hour, minute }. */
  static _parseClock(value, label) {
    const m = /^(\d{1,2}):(\d{1,2})$/.exec(String(value).trim());
    if (!m) throw new Error(`ConfigAdapter: ${label} must match "HH:MM", got: ${JSON.stringify(value)}`);
    const hour = parseInt(m[1], 10);
    const minute = parseInt(m[2], 10);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
      throw new Error(`ConfigAdapter: ${label} out of range — hour=${hour}, minute=${minute}`);
    }
    return { hour, minute };
  }

  /** @private — прибавляет minutes к {hour, minute} с оборотом через полночь. */
  static _addMinutes(t, minutes) {
    let total = t.hour * 60 + t.minute + Math.max(0, Math.floor(minutes));
    total = ((total % 1440) + 1440) % 1440;
    return { hour: Math.floor(total / 60), minute: total % 60 };
  }
}

module.exports = ConfigAdapter;
module.exports.ConfigAdapter = ConfigAdapter;
module.exports.DEFAULTS = DEFAULTS;
module.exports.PRODUCTION_DEFAULTS = PRODUCTION_DEFAULTS;