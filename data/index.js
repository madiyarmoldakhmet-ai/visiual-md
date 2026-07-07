'use strict';

/**
 * data/ — Data Layer & Logging
 *
 * Точка входа модуля. Экспортирует все классы, которые используют остальные
 * модули системы (Мадияр в scheduler/InstanceRunner, Алдияр в incoming/, Рамазан в core/).
 *
 * Карта зависимостей:
 *   Logger           — независимый, используется ВСЕМИ модулями
 *   StatusTracker    — независимый, используется внутри DataManager
 *   DataManager      — зависит от StatusTracker, используется scheduler/ и incoming/
 *   ReportGenerator  — читает из StatusTracker, используется scheduler/
 *
 * Пример использования (как написано в ТЗ, раздел 4):
 *
 *   const { DataManager, Logger, ReportGenerator } = require('./data');
 *   const logger = new Logger(1, './logs');
 *   const dm = new DataManager({ dbPath: './data/messages.json', statusDir: './data/status' });
 *   const messages = dm.loadMessages(1);
 *   const pending = dm.getPending(messages);
 *   dm.updateStatus('msg_001', { success: true, messageId: 'xxx', timestamp: Date.now() });
 *   const report = new ReportGenerator().generate(1, dm.statusTracker, startTime);
 */

const Logger = require('./Logger');
const StatusTracker = require('./StatusTracker');
const DataManager = require('./DataManager');
const ReportGenerator = require('./ReportGenerator');

module.exports = {
    Logger,
    StatusTracker,
    DataManager,
    ReportGenerator,
};
