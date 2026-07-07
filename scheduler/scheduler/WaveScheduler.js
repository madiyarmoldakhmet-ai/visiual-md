'use strict';

const { DateTime } = require('luxon');
const TimeWindow = require('./TimeWindow');

/**
 * WaveScheduler — управляет последовательностью волн и пауз отправки.
 *
 * Формат элемента waves:
 *   { name, start: { hour, minute }, end: { hour, minute }, messageCount }
 *   messageCount === 0 → пауза.
 *
 * Timezone-locked (Asia/Almaty), поддерживает переход через полночь
 * (например, Wave 3: 23:00 → 03:00).
 */
class WaveScheduler {
  /**
   * @param {{ timezone?: string, waves: Array }} scheduleConfig
   */
  constructor(scheduleConfig) {
    if (!scheduleConfig || typeof scheduleConfig !== 'object') {
      throw new Error('WaveScheduler: scheduleConfig must be an object');
    }
    if (!Array.isArray(scheduleConfig.waves) || scheduleConfig.waves.length === 0) {
      throw new Error('WaveScheduler: scheduleConfig.waves must be a non-empty array');
    }

    this.timezone = scheduleConfig.timezone || 'Asia/Almaty';
    this.waves = scheduleConfig.waves.map((w, i) => this._normalizeWave(w, i));

    // Глобальное окно: от начала первой волны до конца последней.
    const first = this.waves[0];
    const last = this.waves[this.waves.length - 1];
    this._timeWindow = new TimeWindow(this.timezone, first.start, last.end);
  }

  /** @private */
  _normalizeWave(raw, index) {
    if (!raw || typeof raw !== 'object') {
      throw new Error(`WaveScheduler: wave[${index}] must be an object`);
    }
    const need = (v) => v && typeof v === 'object' && typeof v.hour === 'number' && typeof v.minute === 'number';
    if (!need(raw.start)) throw new Error(`WaveScheduler: wave[${index}].start must be { hour, minute }`);
    if (!need(raw.end))   throw new Error(`WaveScheduler: wave[${index}].end must be { hour, minute }`);

    const messageCount = typeof raw.messageCount === 'number' ? raw.messageCount : 0;
    return {
      index,
      name: raw.name || `Wave ${index + 1}`,
      start: { hour: raw.start.hour, minute: raw.start.minute },
      end: { hour: raw.end.hour, minute: raw.end.minute },
      messageCount,
      pause: messageCount === 0,
    };
  }

  /** @private */
  _now() {
    return DateTime.now().setZone(this.timezone);
  }

  /** @private */
  _toDateTime(ref, t) {
    return ref.set({ hour: t.hour, minute: t.minute, second: 0, millisecond: 0 });
  }

  /** @private — true если интервал пересекает полночь (end <= start). */
  _crossesMidnight(start, end) {
    const s = start.hour * 60 + start.minute;
    const e = end.hour * 60 + end.minute;
    return e <= s;
  }

  /** @private — абсолютные границы волны на указанный день. */
  _resolveWaveBounds(wave, ref) {
    const start = this._toDateTime(ref, wave.start);
    const endDay = this._crossesMidnight(wave.start, wave.end) ? ref.plus({ days: 1 }) : ref;
    const end = this._toDateTime(endDay, wave.end);
    return { start, end };
  }

  /** @private */
  _buildWaveView(wave, start, end) {
    return {
      index: wave.index,
      name: wave.name,
      start: { ...wave.start },
      end: { ...wave.end },
      messageCount: wave.messageCount,
      pause: wave.pause,
      isActive: !wave.pause && wave.messageCount > 0,
      startMs: start.toMillis(),
      endMs: end.toMillis(),
    };
  }

  /** Глобальное рабочее окно (делегирует TimeWindow). */
  isWorkingHours() {
    return this._timeWindow.isWithinWindow();
  }

  /**
   * Текущая волна (активная или пауза) с флагом isActive и границами startMs/endMs.
   * Корректно обрабатывает волны, переходящие через полночь.
   * @returns {Object|null}
   */
  getCurrentWave() {
    if (!this.isWorkingHours()) return null;
    const now = this._now();

    // Волны на "сегодня".
    for (const wave of this.waves) {
      const { start, end } = this._resolveWaveBounds(wave, now);
      if (now >= start && now < end) return this._buildWaveView(wave, start, end);
    }

    // Волны, начавшиеся вчера и продолжающиеся сегодня (переход через полночь).
    const yesterday = now.minus({ days: 1 });
    for (const wave of this.waves) {
      if (!this._crossesMidnight(wave.start, wave.end)) continue;
      const { start, end } = this._resolveWaveBounds(wave, yesterday);
      if (now >= start && now < end) return this._buildWaveView(wave, start, end);
    }

    return null;
  }

  /**
   * Следующая активная волна и ms до её начала.
   *
   * @param {{ skipCurrentActive?: boolean }} [options]
   *   skipCurrentActive: игнорировать текущую активную волну (квота исчерпана).
   * @returns {{ wave: Object, startsInMs: number } | null}
   */
  getNextActiveWave(options = {}) {
    const { skipCurrentActive = false } = options;
    const now = this._now();

    if (!skipCurrentActive) {
      const current = this.getCurrentWave();
      if (current && current.isActive) return null;
    }

    // Поиск по сегодняшнему и завтрашнему дню.
    for (let dayOffset = 0; dayOffset <= 1; dayOffset++) {
      const ref = now.plus({ days: dayOffset });
      for (const wave of this.waves) {
        if (wave.pause || wave.messageCount <= 0) continue;
        const { start, end } = this._resolveWaveBounds(wave, ref);
        const startsInMs = start.toMillis() - now.toMillis();
        if (startsInMs > 0) {
          return { wave: this._buildWaveView(wave, start, end), startsInMs };
        }
      }
    }

    return null;
  }

  /**
   * Оставшаяся квота для волны (max(0, messageCount - totalSent)).
   * @param {number} waveIndex
   * @param {number} totalSent
   * @returns {number}
   */
  getMessageQuota(waveIndex, totalSent) {
    if (waveIndex < 0 || waveIndex >= this.waves.length) return 0;
    const sent = typeof totalSent === 'number' && totalSent > 0 ? totalSent : 0;
    return Math.max(0, this.waves[waveIndex].messageCount - sent);
  }
}

module.exports = WaveScheduler;
module.exports.WaveScheduler = WaveScheduler;
module.exports.TimeWindow = TimeWindow;