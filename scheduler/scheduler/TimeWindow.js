'use strict';

const { DateTime } = require('luxon');

/**
 * TimeWindow — проверка рабочего окна с поддержкой перехода через полночь.
 *
 * Например, окно 17:00→03:00 в Asia/Almaty. Методы:
 *   isWithinWindow()    — внутри ли окна прямо сейчас;
 *   getTimeUntilStart() — ms до начала (0 если внутри);
 *   getTimeUntilEnd()   — ms до конца (0 если снаружи).
 */
class TimeWindow {
  /**
   * @param {string} timezone IANA timezone, например 'Asia/Almaty'.
   * @param {{hour:number, minute:number}} workStart
   * @param {{hour:number, minute:number}} workEnd
   */
  constructor(timezone, workStart, workEnd) {
    if (!timezone || typeof timezone !== 'string') {
      throw new Error(`TimeWindow: timezone must be a non-empty string, received: ${timezone}`);
    }
    this._validateTime(workStart, 'workStart');
    this._validateTime(workEnd, 'workEnd');

    this.timezone = timezone;
    this.workStart = { hour: workStart.hour, minute: workStart.minute };
    this.workEnd = { hour: workEnd.hour, minute: workEnd.minute };
  }

  /** @private */
  _validateTime(t, name) {
    const ok = t && typeof t === 'object'
      && Number.isInteger(t.hour) && Number.isInteger(t.minute)
      && t.hour >= 0 && t.hour <= 23
      && t.minute >= 0 && t.minute <= 59;
    if (!ok) {
      throw new Error(`TimeWindow: ${name} must be { hour: 0-23, minute: 0-59 }, received: ${JSON.stringify(t)}`);
    }
  }

  /** @private — true если окно пересекает полночь (end <= start). */
  _crossesMidnight() {
    const s = this.workStart.hour * 60 + this.workStart.minute;
    const e = this.workEnd.hour * 60 + this.workEnd.minute;
    return e <= s;
  }

  /** @private */
  _now() {
    return DateTime.now().setZone(this.timezone);
  }

  /** @private — DateTime начала окна на указанный день. */
  _startForDay(ref) {
    return ref.set({
      hour: this.workStart.hour,
      minute: this.workStart.minute,
      second: 0,
      millisecond: 0,
    });
  }

  /** @private — DateTime конца окна (для переходящего окна — ref + 1 день). */
  _endForDay(ref) {
    const endDay = this._crossesMidnight() ? ref.plus({ days: 1 }) : ref;
    return endDay.set({
      hour: this.workEnd.hour,
      minute: this.workEnd.minute,
      second: 0,
      millisecond: 0,
    });
  }

  /** @private — текущее окно [start, end), содержащее "now", или null. */
  _currentWindow() {
    const now = this._now();
    const startToday = this._startForDay(now);
    const endToday = this._endForDay(startToday);

    if (now >= startToday && now < endToday) {
      return { start: startToday, end: endToday };
    }

    // Для переходящего окна: "now" перед сегодняшним стартом может быть
    // внутри вчерашнего окна, которое продлевается в сегодня.
    if (this._crossesMidnight()) {
      const yesterday = now.minus({ days: 1 });
      const startY = this._startForDay(yesterday);
      const endY = this._endForDay(yesterday);
      if (now >= startY && now < endY) {
        return { start: startY, end: endY };
      }
    }

    return null;
  }

  /** Внутри ли рабочего окна прямо сейчас. */
  isWithinWindow() {
    return this._currentWindow() !== null;
  }

  /** ms до начала окна (0 если внутри). */
  getTimeUntilStart() {
    if (this._currentWindow()) return 0;

    const now = this._now();
    const startToday = this._startForDay(now);

    if (startToday > now) {
      return startToday.toMillis() - now.toMillis();
    }
    // Окно откроется завтра.
    return this._startForDay(now.plus({ days: 1 })).toMillis() - now.toMillis();
  }

  /** ms до конца окна (0 если снаружи). */
  getTimeUntilEnd() {
    const current = this._currentWindow();
    if (!current) return 0;
    return Math.max(0, current.end.toMillis() - this._now().toMillis());
  }
}

module.exports = TimeWindow;
module.exports.TimeWindow = TimeWindow;