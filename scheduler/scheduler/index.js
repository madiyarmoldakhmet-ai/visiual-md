'use strict';

/**
 * scheduler — точка входа модуля планировщика рассылки WhatsApp.
 *
 * Экспортирует 5 классов + продакшен-дефолты:
 *   - ConfigAdapter     : нормализация JSON-конфига волн.
 *   - IntervalGenerator : рандомизация интервалов + sleep().
 *   - TimeWindow        : рабочее окно (переход через полночь).
 *   - WaveScheduler     : управление волнами/паузами, квоты.
 *   - InstanceRunner    : оркестратор цикла отправки.
 *   - PRODUCTION_DEFAULTS / DEFAULT_MESSAGE_COUNT_PER_WAVE : фолбэки.
 */

const ConfigAdapter = require('./ConfigAdapter');
const IntervalGenerator = require('./IntervalGenerator');
const TimeWindow = require('./TimeWindow');
const WaveScheduler = require('./WaveScheduler');
const InstanceRunner = require('./InstanceRunner');

const { PRODUCTION_DEFAULTS, DEFAULTS } = ConfigAdapter;

module.exports = {
  ConfigAdapter,
  IntervalGenerator,
  TimeWindow,
  WaveScheduler,
  InstanceRunner,
  PRODUCTION_DEFAULTS,
  DEFAULTS,
};
