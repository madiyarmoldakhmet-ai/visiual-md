'use strict';

const fs = require('fs');
const path = require('path');

const StatusTracker = require('./StatusTracker');

// Мягкая валидация номера: Казахстан +77XXXXXXXXX или Кыргызстан +996XXXXXXXXX.
// Несоответствие — лишь warning, не ошибка (главное — чтобы phone был непустым).
const PHONE_RE = /^(\+77\d{9}|\+996\d{9})$/;

/**
 * DataManager
 *
 * Загрузка и управление базой сообщений для модуля WhatsApp-рассылки.
 *
 * ГЛАВНЫЙ ПРИНЦИП: исходный файл базы (this.dbPath, обычно messages.json)
 * ТОЛЬКО ЧИТАЕТСЯ и никогда не мутируется. Все изменения статусов живут
 * в StatusTracker (отдельный файл на диске). После перезапуска процесса
 * уже отправленные сообщения не возвращаются в очередь — их статус 'sent'
 * восстанавливается из файла статусов при загрузке.
 */
class DataManager {
  /**
   * @param {Object} opts
   * @param {string} opts.dbPath    - путь к JSON-файлу базы сообщений
   * @param {string} opts.statusDir - директория для файлов статусов
   */
  constructor({ dbPath, statusDir }) {
    this.dbPath = dbPath;
    this.statusDir = statusDir;

    // StatusTracker создаётся в loadMessages(instanceId), т.к. instanceId
    // известен только в момент загрузки.
    this.statusTracker = null;

    // Кэш загруженных (отфильтрованных + со статусами) сообщений и инстанса.
    this.messages = null;
    this.instanceId = null;
  }

  /**
   * Загружает базу, фильтрует по инстансу, валидирует записи,
   * накладывает актуальные статусы из StatusTracker.
   *
   * @param {number|string} instanceId
   * @returns {Array<Object>} массив сообщений с актуальными статусами
   * @throws {Error} если файл не найден, повреждён или запись невалидна
   */
  loadMessages(instanceId) {
    let raw;
    try {
      raw = fs.readFileSync(this.dbPath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new Error(`Файл базы не найден: ${this.dbPath}`);
      }
      throw err;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`База повреждена: ${err.message}`);
    }

    if (!Array.isArray(parsed)) {
      throw new Error('База повреждена: ожидается массив сообщений');
    }

    // Фильтруем записи, принадлежащие этому инстансу.
    const filtered = parsed.filter(
      (rec) => rec && rec.assigned_to === instanceId
    );

    // Валидация каждой записи.
    filtered.forEach((rec, idx) => {
      if (rec.id === undefined || rec.id === null) {
        throw new Error(
          `Невалидная запись (индекс ${idx}): отсутствует поле id`
        );
      }
      if (!rec.phone || (typeof rec.phone === 'string' && !rec.phone.trim())) {
        throw new Error(
          `Невалидная запись id=${rec.id}: поле phone обязательно и непустое`
        );
      }
      if (
        !rec.message ||
        (typeof rec.message === 'string' && !rec.message.trim())
      ) {
        throw new Error(
          `Невалидная запись id=${rec.id}: поле message обязательно и непустое`
        );
      }

      // Мягкая проверка формата телефона — warning, но не ошибка.
      if (typeof rec.phone === 'string' && !PHONE_RE.test(rec.phone)) {
        console.warn(
          `[DataManager] Телефон "${rec.phone}" (id=${rec.id}) не соответствует ожидаемому формату +77XXXXXXXXX / +996XXXXXXXXX`
        );
      }
    });

    // Создаём StatusTracker для этого инстанса (читает/создаёт файл статусов).
    this.statusTracker = new StatusTracker(this.statusDir, instanceId);

    // Накладываем актуальные статусы из файла статусов на загруженные сообщения.
    // Это гарантирует, что после перезапуска отправленные (status='sent')
    // не вернутся в очередь как 'new'.
    const merged = this.statusTracker.mergeWithMessages(filtered);

    // Кэшируем для getStats / markOptOut.
    this.messages = merged;
    this.instanceId = instanceId;

    return merged;
  }

  /**
   * Возвращает сообщения, готовые к отправке: status === 'new' или 'failed',
   * и чей телефон НЕ в optOuts. Исходный массив не мутируется.
   *
   * @param {Array<Object>} messages
   * @returns {Array<Object>}
   */
  getPending(messages) {
    if (!Array.isArray(messages)) {
      return [];
    }

    const optOuts = this.statusTracker
      ? new Set(this.statusTracker.data.optOuts)
      : new Set();

    return messages.filter((msg) => {
      if (!msg) return false;
      if (msg.status !== 'new' && msg.status !== 'failed') return false;
      if (optOuts.has(msg.phone)) return false;
      return true;
    });
  }

  /**
   * Обновляет статус отправки одного сообщения и сохраняет его на диск
   * через StatusTracker (который сам делает save()).
   *
   * @param {string} messageId
   * @param {Object} result
   *   Успех:  { success: true, messageId, timestamp }
   *   Провал: { success: false, errorCode, errorMessage }
   */
  updateStatus(messageId, result) {
    if (!this.statusTracker) {
      throw new Error('Сначала вызовите loadMessages(instanceId)');
    }

    let statusData;

    if (result && result.success === true) {
      statusData = {
        status: 'sent',
        whatsappMessageId: result.messageId,
        sentAt: new Date(result.timestamp).toISOString(),
      };
    } else {
      // Инкрементируем счётчик попыток, если уже была запись с failed.
      const existing = this.statusTracker.getMessageStatus(messageId);
      const attempts = ((existing && existing.attempts) || 0) + 1;

      statusData = {
        status: 'failed',
        errorCode: result ? result.errorCode : undefined,
        errorMessage: result ? result.errorMessage : undefined,
        lastAttempt: new Date().toISOString(),
        attempts,
      };
    }

    this.statusTracker.setMessageStatus(messageId, statusData);
  }

  /**
   * Считает статистику по инстансу.
   *
   * @param {number|string} instanceId
   * @returns {{ total:number, sent:number, failed:number, pending:number, percentComplete:number }}
   */
  getStats(instanceId) {
    // Перечитываем сообщения для инстанса, если кэш неактуален.
    if (this.instanceId !== instanceId || !Array.isArray(this.messages)) {
      this.loadMessages(instanceId);
    }

    const messages = this.messages;
    const optOuts = this.statusTracker
      ? new Set(this.statusTracker.data.optOuts)
      : new Set();

    let total = 0;
    let sent = 0;
    let failed = 0;
    let pending = 0;

    for (const msg of messages) {
      total += 1;

      if (msg.status === 'sent') {
        sent += 1;
        continue;
      }

      // Не отправляем и не считаем pending тех, кто отписался.
      if (msg.status === 'failed') {
        failed += 1;
      }

      if ((msg.status === 'new' || msg.status === 'failed') && !optOuts.has(msg.phone)) {
        pending += 1;
      }
    }

    const percentComplete =
      total === 0 ? 0 : Math.round((sent / total) * 100);

    return { total, sent, failed, pending, percentComplete };
  }

  /**
   * Помечает контакт как отписавшегося (opt-out).
   * Добавляет phone в optOuts (без дублей) и исключает все НЕОТПРАВЛЕННЫЕ
   * сообщения этого контакта из очереди (status -> 'opted_out').
   *
   * @param {string} phone
   */
  markOptOut(phone) {
    if (!this.statusTracker) {
      throw new Error('Сначала вызовите loadMessages(instanceId)');
    }

    const { optOuts, messages: tracked } = this.statusTracker.data;

    // Добавляем в optOuts без дублей.
    if (!optOuts.includes(phone)) {
      optOuts.push(phone);
    }

    // Помечаем 'opted_out' все неотправленные сообщения этого контакта,
    // чтобы они не считались pending и не попали в очередь.
    if (Array.isArray(this.messages)) {
      for (const msg of this.messages) {
        if (msg && msg.phone === phone && msg.status !== 'sent') {
          const prev = tracked[msg.id] || {};
          tracked[msg.id] = { ...prev, status: 'opted_out' };
        }
      }
    }

    this.statusTracker.save();
  }

  /**
   * Помечает контакт как тёплый лид. Обновляет существующую запись,
   * если для phone она уже есть (без дублей).
   *
   * @param {string} phone
   * @param {string} responseText
   */
  markWarmLead(phone, responseText) {
    if (!this.statusTracker) {
      throw new Error('Сначала вызовите loadMessages(instanceId)');
    }

    const warmLeads = this.statusTracker.data.warmLeads;
    const now = new Date().toISOString();

    const existing = warmLeads.find((lead) => lead && lead.phone === phone);
    if (existing) {
      existing.response = responseText;
      existing.receivedAt = now;
    } else {
      warmLeads.push({
        phone,
        response: responseText,
        receivedAt: now,
      });
    }

    this.statusTracker.save();
  }
}

module.exports = DataManager;
