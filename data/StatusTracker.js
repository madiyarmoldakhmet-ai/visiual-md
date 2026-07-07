'use strict';

const fs = require('fs');
const path = require('path');

/**
 * StatusTracker
 *
 * Хранит статусы отправки сообщений ОТДЕЛЬНО от основной базы (messages.json),
 * чтобы не мутировать исходный файл. Каждый инстанс имеет свой файл статусов:
 *   <statusDir>/instance_<instanceId>_status.json
 */
class StatusTracker {
  /**
   * @param {string} statusDir - директория для хранения файлов статусов
   * @param {number|string} instanceId - идентификатор инстанса
   */
  constructor(statusDir, instanceId) {
    this.statusDir = statusDir;
    this.instanceId = instanceId;

    const fileName = `instance_${this.instanceId}_status.json`;
    this.statusFile = path.join(this.statusDir, fileName);
    this.tmpFile = `${this.statusFile}.tmp`;

    this.data = this.load();
  }

  /**
   * Возвращает пустую структуру данных статусов.
   * @returns {Object}
   * @private
   */
  _emptyStructure() {
    return {
      instanceId: this.instanceId,
      lastUpdated: null,
      messages: {},
      optOuts: [],
      warmLeads: [],
    };
  }

  /**
   * Загружает существующий файл статусов или создаёт пустую структуру.
   * Не падает при отсутствии или повреждении файла.
   * @returns {Object}
   */
  load() {
    let raw;
    try {
      raw = fs.readFileSync(this.statusFile, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') {
        return this._emptyStructure();
      }
      // Иные ошибки чтения — стартуем с пустой структуры, не крашим.
      console.warn(
        `[StatusTracker] Не удалось прочитать файл статусов "${this.statusFile}": ${err.message}`
      );
      return this._emptyStructure();
    }

    try {
      const parsed = JSON.parse(raw);

      // Гарантируем наличие всех ожидаемых полей, даже если файл неполный.
      return {
        instanceId: this.instanceId,
        lastUpdated:
          parsed.lastUpdated !== undefined ? parsed.lastUpdated : null,
        messages:
          parsed.messages && typeof parsed.messages === 'object'
            ? parsed.messages
            : {},
        optOuts: Array.isArray(parsed.optOuts) ? parsed.optOuts : [],
        warmLeads: Array.isArray(parsed.warmLeads) ? parsed.warmLeads : [],
      };
    } catch (err) {
      console.warn(
        `[StatusTracker] Файл статусов "${this.statusFile}" повреждён (${err.message}). Стартую с пустой структуры.`
      );
      return this._emptyStructure();
    }
  }

  /**
   * Атомарно сохраняет структуру статусов на диск:
   *   (а) пишем JSON во временный файл <путь>.tmp
   *   (б) fs.renameSync(tmp, real) — атомарное переименование.
   */
  save() {
    // Гарантируем существование директории статусов.
    try {
      fs.mkdirSync(this.statusDir, { recursive: true });
    } catch (err) {
      // Игнорируем ошибку, если директория уже существует.
      if (err.code !== 'EEXIST') {
        throw err;
      }
    }

    this.data.lastUpdated = new Date().toISOString();
    const json = JSON.stringify(this.data, null, 2);

    // (а) пишем во временный файл
    fs.writeFileSync(this.tmpFile, json, 'utf8');

    // (б) атомарное переименование
    fs.renameSync(this.tmpFile, this.statusFile);
  }

  /**
   * Возвращает объект статуса сообщения или undefined, если записи нет.
   * @param {string} messageId
   * @returns {Object|undefined}
   */
  getMessageStatus(messageId) {
    return this.data.messages[messageId];
  }

  /**
   * Записывает/обновляет статус сообщения и сохраняет изменения.
   * @param {string} messageId
   * @param {Object} statusData
   */
  setMessageStatus(messageId, statusData) {
    this.data.messages[messageId] = statusData;
    this.save();
  }

  /**
   * Накладывает актуальные статусы из файла статусов на массив сообщений.
   *
   * @param {Array} messages - массив вида
   *   [{ id, phone, message, assigned_to, status }, ...]
   * @returns {Array} НОВЫЙ массив; исходный не мутируется.
   */
  mergeWithMessages(messages) {
    if (!Array.isArray(messages)) {
      return [];
    }

    return messages.map((msg) => {
      if (!msg || typeof msg !== 'object') {
        return msg;
      }

      const tracked = this.data.messages[msg.id];
      if (tracked && tracked.status !== undefined) {
        return { ...msg, status: tracked.status };
      }

      // Записи нет — статус остаётся как был.
      return { ...msg };
    });
  }
}

module.exports = StatusTracker;
