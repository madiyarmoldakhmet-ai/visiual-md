'use strict';

/**
 * ReportGenerator — формирует сводные отчёты после завершения рассылки:
 * отчёт по одному инстансу, сохранение в файл и глобальный отчёт по всем
 * инстансам.
 *
 * ReportGenerator ТОЛЬКО ЧИТАЕТ из statusTracker. Он не вызывает
 * setMessageStatus/save и не мутирует трекер.
 */

const fs = require('fs');
const path = require('path');
const { DateTime } = require('luxon');

const ALMATY_ZONE = 'Asia/Almaty';

class ReportGenerator {
  /**
   * Сформировать отчёт по одному инстансу.
   *
   * @param {string|number} instanceId
   * @param {object} statusTracker — готовый объект StatusTracker
   * @param {Date} startTime — момент старта рассылки
   * @returns {object} отчёт
   */
  generate(instanceId, statusTracker, startTime) {
    const endTime = new Date();

    const data = (statusTracker && statusTracker.data) || {};
    const messages = data.messages || {};
    const optOuts = Array.isArray(data.optOuts) ? data.optOuts : [];
    const warmLeads = Array.isArray(data.warmLeads) ? data.warmLeads : [];

    const messageIds = Object.keys(messages);
    const total = messageIds.length;

    let sent = 0;
    let failed = 0;
    const errors = [];

    for (const messageId of messageIds) {
      const entry = messages[messageId] || {};
      if (entry.status === 'sent') {
        sent += 1;
      } else if (entry.status === 'failed') {
        failed += 1;
        errors.push({
          messageId,
          // В StatusTracker не хранятся телефоны сообщений — только статусы по id.
          phone: 'N/A',
          error: entry.errorCode || entry.errorMessage || null,
          attempts: entry.attempts || 1,
        });
      }
    }

    const successRate = total > 0 ? Math.round((sent / total) * 100) + '%' : '0%';
    const duration = this._formatDuration(endTime - startTime);

    const warmLeadsReport = warmLeads.map((lead) => ({
      phone: this._maskPhone(lead.phone),
      response: lead.response,
      time: this._toAlmatyHHmm(lead.receivedAt),
    }));

    return {
      instanceId,
      phoneLabel: `Номер ${instanceId}`,
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
      duration,
      stats: {
        total,
        sent,
        failed,
        optOuts: optOuts.length,
        warmLeads: warmLeads.length,
        successRate,
      },
      errors,
      warmLeads: warmLeadsReport,
    };
  }

  /**
   * Сохранить отчёт в JSON-файл и вывести текстовый блок в консоль.
   *
   * @param {object} report — результат generate()
   * @param {string} outputDir — папка для сохранения
   * @returns {string} путь к сохранённому файлу
   */
  saveReport(report, outputDir) {
    fs.mkdirSync(outputDir, { recursive: true });

    const datePart = this._toAlmatyDate(report.endTime || new Date().toISOString());
    const fileName = `report_instance_${report.instanceId}_${datePart}.json`;
    const filePath = path.join(outputDir, fileName);

    fs.writeFileSync(filePath, JSON.stringify(report, null, 2), 'utf8');

    this._printInstanceReport(report);

    return filePath;
  }

  /**
   * Глобальный отчёт по всем инстансам. Выводит ASCII-блок в console.log.
   *
   * @param {object[]} allReports — массив результатов generate()
   * @returns {string} текстовый блок (дополнительно к console.log)
   */
  generateGlobalReport(allReports) {
    const reports = Array.isArray(allReports) ? allReports : [];

    let totalSum = 0;
    let sentSum = 0;
    let failedSum = 0;
    let optOutsSum = 0;
    let warmLeadsSum = 0;

    for (const report of reports) {
      const s = report.stats || {};
      totalSum += s.total || 0;
      sentSum += s.sent || 0;
      failedSum += s.failed || 0;
      optOutsSum += s.optOuts || 0;
      warmLeadsSum += s.warmLeads || 0;
    }

    const overallRate =
      totalSum > 0 ? (sentSum / totalSum * 100).toFixed(1) + '%' : '0%';

    const firstDate = reports.length
      ? this._toAlmatyDate(reports[0].endTime || reports[0].startTime)
      : this._toAlmatyDate(new Date().toISOString());

    const sep = '═══════════════════════════════════════';
    const lines = [];
    lines.push(sep);
    lines.push('  СВОДНЫЙ ОТЧЁТ РАССЫЛКИ');
    lines.push(`  Дата: ${firstDate}`);
    lines.push(sep);
    lines.push(`  Всего отправлено: ${sentSum} / ${totalSum}`);
    lines.push(`  Успешно: ${sentSum} (${overallRate})`);
    lines.push(`  Ошибки: ${failedSum}`);
    lines.push(`  Тёплые лиды: ${warmLeadsSum}`);
    lines.push(`  Отписки: ${optOutsSum}`);
    lines.push(sep);

    for (const report of reports) {
      const s = report.stats || { sent: 0, total: 0, failed: 0 };
      const mark = (s.failed || 0) === 0 ? '✓' : '⚠';
      lines.push(`  Номер ${report.instanceId}: ${s.sent}/${s.total} ${mark}`);
    }

    lines.push(sep);

    const text = lines.join('\n');
    console.log(text);
    return text;
  }

  // ─────────────────────── helpers ───────────────────────

  /**
   * Длительность из миллисекунд: 'X часов Y минут' или 'Y минут' если < часа.
   */
  _formatDuration(ms) {
    const diff = Number(ms) || 0;
    const HOUR = 3600000;
    const MIN = 60000;
    const hours = Math.floor(diff / HOUR);
    const minutes = Math.floor((diff % HOUR) / MIN);
    if (hours >= 1) {
      return `${hours} часов ${minutes} минут`;
    }
    return `${minutes} минут`;
  }

  /**
   * Маскировка телефона: первые 4 и последние 4 цифры после '+', середина '***'.
   * Короткие (≤8 цифр) — без маски.
   * Пример: '+77012345678' → '+7701***5678'
   */
  _maskPhone(phone) {
    if (!phone || typeof phone !== 'string') return phone;

    const hasPlus = phone.startsWith('+');
    const digits = hasPlus ? phone.slice(1) : phone;

    if (digits.length <= 8) {
      return phone;
    }

    const head = digits.slice(0, 4);
    const tail = digits.slice(-4);
    return `${hasPlus ? '+' : ''}${head}***${tail}`;
  }

  /**
   * ISO (UTC) → HH:mm в зоне Asia/Almaty.
   */
  _toAlmatyHHmm(iso) {
    if (!iso) return null;
    try {
      return DateTime.fromISO(iso, { zone: 'utc' })
        .setZone(ALMATY_ZONE)
        .toFormat('HH:mm');
    } catch (_e) {
      return null;
    }
  }

  /**
   * ISO (UTC) → YYYY-MM-DD в зоне Asia/Almaty.
   */
  _toAlmatyDate(iso) {
    if (!iso) {
      iso = new Date().toISOString();
    } else if (iso instanceof Date) {
      iso = iso.toISOString();
    }
    try {
      return DateTime.fromISO(iso, { zone: 'utc' })
        .setZone(ALMATY_ZONE)
        .toFormat('yyyy-MM-dd');
    } catch (_e) {
      return DateTime.now().setZone(ALMATY_ZONE).toFormat('yyyy-MM-dd');
    }
  }

  /**
   * ISO (UTC) → 'YYYY-MM-DD HH:mm' в зоне Asia/Almaty.
   */
  _toAlmatyDateTime(iso) {
    if (!iso) return '';
    try {
      return DateTime.fromISO(iso, { zone: 'utc' })
        .setZone(ALMATY_ZONE)
        .toFormat('yyyy-MM-dd HH:mm');
    } catch (_e) {
      return '';
    }
  }

  /**
   * Красивый текстовый отчёт по инстансу в console.log.
   */
  _printInstanceReport(report) {
    const s = report.stats || {};
    const start = this._toAlmatyDateTime(report.startTime);
    const end = this._toAlmatyDateTime(report.endTime);
    const sep = '══════════════════════════════════════';

    console.log(sep);
    console.log(`  ОТЧЁТ: ${report.phoneLabel || 'Номер ' + report.instanceId}`);
    console.log(`  Период: ${start} → ${end}`);
    console.log(`  Длительность: ${report.duration}`);
    console.log(sep);
    console.log(`  Всего: ${s.total || 0} | Отправлено: ${s.sent || 0} | Ошибок: ${s.failed || 0}`);
    console.log(`  Успешность: ${s.successRate || '0%'}`);
    console.log(`  Тёплые лиды: ${s.warmLeads || 0} | Отписки: ${s.optOuts || 0}`);
    console.log(sep);
  }
}

module.exports = ReportGenerator;
