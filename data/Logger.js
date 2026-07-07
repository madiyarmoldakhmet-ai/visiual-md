'use strict';

const fs = require('fs');
const path = require('path');
const { DateTime } = require('luxon');

const ALMATY_ZONE = 'Asia/Almaty';

/**
 * Logger — логирование действий инстанса рассылки WhatsApp-сообщений.
 * Пишет одновременно в файл (append-поток) и в console.log.
 * Все временные метки — в часовом поясе Asia/Almaty.
 */
class Logger {
    /**
     * @param {number} instanceId — номер инстанса (1..7)
     * @param {string} logDir — директория для логов, напр. './logs'
     */
    constructor(instanceId, logDir) {
        this.instanceId = instanceId;
        this.logDir = logDir;

        // Дата в зоне Asia/Almaty на момент создания (для имени файла).
        const now = DateTime.now().setZone(ALMATY_ZONE);
        const dateStamp = now.toFormat('yyyy-MM-dd');
        this.fileName = `instance_${instanceId}_${dateStamp}.log`;
        this.filePath = path.join(logDir, this.fileName);

        // Создаём папку логов, если её нет.
        fs.mkdirSync(logDir, { recursive: true });

        // Открываем поток в режиме append, UTF-8.
        this.stream = fs.createWriteStream(this.filePath, {
            flags: 'a',
            encoding: 'utf8',
        });

        this.stream.on('error', (err) => {
            // Сбои самого потока логируем только в stderr, чтобы не зациклиться.
            // eslint-disable-next-line no-console
            console.error(`[Logger] Ошибка записи в файл лога (${this.filePath}): ${err.message}`);
        });
    }

    /**
     * Текущее время в зоне Asia/Almaty в формате YYYY-MM-DD HH:mm:ss.
     * @returns {string}
     */
    _timestamp() {
        return DateTime.now().setZone(ALMATY_ZONE).toFormat('yyyy-MM-dd HH:mm:ss');
    }

    /**
     * Базовое логирование.
     * @param {string} message — текст сообщения
     * @param {'INFO'|'WARN'|'ERROR'} level — уровень
     */
    log(message, level = 'INFO') {
        const ts = this._timestamp();
        const line = `[${ts}] [${level}] Номер ${this.instanceId}: ${message}`;

        // Записываем в файл (с переносом строки).
        if (this.stream && this.stream.writable) {
            this.stream.write(line + '\n');
        }

        // Дублируем в консоль.
        // eslint-disable-next-line no-console
        console.log(line);
    }

    /**
     * Логирование отправки одного сообщения.
     * @param {number} index — порядковый номер сообщения
     * @param {number} total — всего сообщений
     * @param {string} phone — номер телефона (полный, будет маскирован в логе)
     * @param {{success: true, messageId?: string, timestamp?: string} |
     *         {success: false, errorCode?: string|number, errorMessage?: string}} result
     */
    logSend(index, total, phone, result) {
        const masked = this._maskPhone(phone);
        let body;

        if (result && result.success) {
            body = `Сообщение ${index}/${total} успешно отправлено (${masked})`;
        } else {
            const reason = (result && (result.errorMessage || result.errorCode)) || 'неизвестная ошибка';
            body = `Ошибка отправки ${index}/${total} (${masked}): ${reason}`;
        }

        // Логируем на INFO/WARN/ERROR в зависимости от результата.
        const level = result && result.success ? 'INFO' : 'ERROR';
        this.log(body, level);
    }

    /**
     * Логирование жизненного цикла волны рассылки.
     * @param {string} waveName — имя волны
     * @param {'start'|'end'|'pause'} action — действие
     */
    logWave(waveName, action) {
        const map = {
            start: 'старт',
            end: 'завершена',
            pause: 'пауза',
        };
        const suffix = map[action] !== undefined ? map[action] : String(action);
        this.log(`Волна ${waveName}: ${suffix}`, 'INFO');
    }

    /**
     * Логирование входящего сообщения.
     * @param {string} from — номер отправителя (будет маскирован)
     * @param {string} text — текст сообщения (обрезается до 50 символов)
     */
    logIncoming(from, text) {
        const masked = this._maskPhone(from);
        const trimmed = this._truncateText(text);
        this.log(`Входящее от ${masked}: ${trimmed}`, 'INFO');
    }

    /**
     * Закрывает файловый поток, освобождая ресурсы.
     */
    close() {
        if (this.stream) {
            this.stream.end();
        }
    }

    /**
     * Маскирование номера телефона: первые 4 и последние 4 цифры после '+' видны,
     * середина заменяется на '***'.
     * Пример: '+77012345678' → '+7701***5678'
     * @param {string} phone
     * @returns {string}
     */
    _maskPhone(phone) {
        const str = String(phone == null ? '' : phone);
        const plus = str.startsWith('+') ? '+' : '';
        const digits = plus ? str.slice(1) : str;

        // Слишком короткие номера не маскируем полноценно — возвращаем как есть,
        // чтобы не выдать больше данных, чем нужно.
        if (digits.length <= 8) {
            return plus + digits;
        }

        const head = digits.slice(0, 4);
        const tail = digits.slice(-4);
        return `${plus}${head}***${tail}`;
    }

    /**
     * Обрезка текста до 50 символов; при превышении добавляется '…'.
     * @param {string} text
     * @returns {string}
     */
    _truncateText(text) {
        const str = text == null ? '' : String(text);
        if (str.length <= 50) {
            return str;
        }
        return str.slice(0, 50) + '…';
    }
}

module.exports = Logger;
