'use strict';

/**
 * incoming/index.js
 * -----------------
 * Inbound message router for a single WhatsApp dispatch instance.
 *
 * Required by `scheduler/InstanceRunner.js` as:
 *
 *     const { IncomingHandler } = require(path.join(baseDir, 'incoming'));
 *
 * InstanceRunner binds the WhatsApp client's 'message' event to
 * `handler.handle(payload)`. The handler's job is to:
 *   1. Normalize whatever the transport hands us into a common envelope.
 *   2. Classify it: is it a delivery/read RECEIPT, a session STATUS signal,
 *      or an actual inbound human message?
 *   3. Route accordingly — persist human replies through `dataManager`, fold
 *      status signals into the session ledger, and surface anything weird to
 *      the logger. Optionally mirror a copy to Telegram for live monitoring.
 *
 * This file ships as a clean integration stub: it implements the full routing
 * shape with no external deps, so the pipeline runs end-to-end. The persistence
 * calls degrade gracefully when a real DataManager isn't injected (tests /
 * sandbox), recording into an in-memory buffer instead.
 */

/**
 * @typedef {'message'|'receipt'|'status'|'unknown'} IncomingKind
 */

/**
 * IncomingHandler
 *
 * Constructor contract intentionally matches what InstanceRunner passes in,
 * but ALSO accepts the slimmer `{ telegramToken, telegramChatId, dataManager }`
 * shape requested by the integration spec — both work.
 */
class IncomingHandler {
  /**
   * @param {{
   *   instanceId?: string|number,
   *   client?: object,
   *   dataManager?: object,
   *   logger?: object,
   *   telegramToken?: string,
   *   telegramChatId?: string,
   *   sessionStore?: Map
   * }} [options]
   */
  constructor(options = {}) {
    this.instanceId = options.instanceId !== undefined ? String(options.instanceId) : 'default';
    this.client = options.client || null;
    this.dataManager = options.dataManager || null;
    this.logger = options.logger || null;
    this.telegramToken = options.telegramToken || null;
    this.telegramChatId = options.telegramChatId || null;

    // Per-phone session ledger: phone → { status, lastSeenAt, messages: [] }.
    // Backed by the injected Map when provided, else in-memory.
    this.sessions = options.sessionStore instanceof Map ? options.sessionStore : new Map();

    // Counters for diagnostics / assertions.
    this.handled = 0;
    this.byKind = { message: 0, receipt: 0, status: 0, unknown: 0 };
  }

  /* --------------------------------------------------------------------- *
   * Public API
   * --------------------------------------------------------------------- */

  /**
   * Routes a single inbound payload. Never throws — inbound processing must
   * not crash the dispatch loop. Any error is logged and swallowed.
   *
   * @param {object} msg Raw payload from the WhatsApp transport.
   * @returns {Promise<{ ok: boolean, kind: IncomingKind, phone: string|null, action: string }>}
   */
  async handle(msg) {
    this.handled += 1;

    let envelope;
    try {
      envelope = this._normalize(msg);
    } catch (err) {
      this.byKind.unknown += 1;
      await this._safeError(`normalize failed: ${(err && err.message) || err}`);
      return { ok: false, kind: 'unknown', phone: null, action: 'rejected' };
    }

    this.byKind[envelope.kind] = (this.byKind[envelope.kind] || 0) + 1;

    try {
      switch (envelope.kind) {
        case 'receipt':
          await this._handleReceipt(envelope);
          return { ok: true, kind: 'receipt', phone: envelope.phone, action: 'receipt-recorded' };

        case 'status':
          await this._handleStatus(envelope);
          return { ok: true, kind: 'status', phone: envelope.phone, action: 'status-updated' };

        case 'message':
          await this._handleMessage(envelope);
          return { ok: true, kind: 'message', phone: envelope.phone, action: 'message-stored' };

        default:
          await this._handleUnknown(envelope);
          return { ok: true, kind: 'unknown', phone: envelope.phone, action: 'ignored' };
      }
    } catch (err) {
      await this._safeError(`handle(${envelope.kind}) failed for ${envelope.phone}: ${(err && err.message) || err}`);
      return { ok: false, kind: envelope.kind, phone: envelope.phone, action: 'error' };
    }
  }

  /**
   * Returns the current session ledger entry for a phone (or null).
   * @param {string} phone
   */
  getSession(phone) {
    return phone ? (this.sessions.get(String(phone)) || null) : null;
  }

  /* --------------------------------------------------------------------- *
   * Normalization & classification
   * --------------------------------------------------------------------- */

  /**
   * @private
   * Coerces a transport-specific payload into a common envelope and classifies
   * it. Recognition rules (in priority order):
   *   - { type: 'receipt' } | { status: 'delivered'|'read'|'sent' } | { kind: 'receipt' }
   *       → receipt (delivery / read confirmation).
   *   - { type: 'status' } | { event: 'status' } | { sessionStatus: ... }
   *       → status (session lifecycle signal — connected / disconnected / banned).
   *   - everything else with a body/text/message field → human inbound message.
   *
   * @param {object} msg
   * @returns {{ kind: IncomingKind, phone: string|null, text: string, raw: object, ts: string }}
   */
  _normalize(msg) {
    if (msg === null || msg === undefined) {
      throw new Error('incoming payload is null');
    }
    if (typeof msg !== 'object') {
      throw new Error(`incoming payload must be an object, got ${typeof msg}`);
    }

    const phone = this._extractPhone(msg);
    const text = this._extractText(msg);
    const ts = msg.ts || msg.timestamp || msg.receivedAt || new Date().toISOString();

    let kind = 'message';

    if (
      msg.type === 'receipt' ||
      msg.kind === 'receipt' ||
      msg.event === 'receipt' ||
      ['delivered', 'read', 'sent', 'failed'].includes(msg.status)
    ) {
      kind = 'receipt';
    } else if (
      msg.type === 'status' ||
      msg.event === 'status' ||
      msg.kind === 'status' ||
      Object.prototype.hasOwnProperty.call(msg, 'sessionStatus')
    ) {
      kind = 'status';
    } else if (
      msg.type === 'message' ||
      msg.kind === 'message' ||
      msg.event === 'message' ||
      text !== '' ||
      Object.prototype.hasOwnProperty.call(msg, 'body') ||
      Object.prototype.hasOwnProperty.call(msg, 'text') ||
      Object.prototype.hasOwnProperty.call(msg, 'message')
    ) {
      kind = 'message';
    } else {
      kind = 'unknown';
    }

    return { kind, phone, text, raw: msg, ts };
  }

  /**
   * @private
   */
  _extractPhone(msg) {
    if (!msg) return null;
    const candidates = [msg.from, msg.phone, msg.sender, msg.peer, msg.chatId];
    for (const c of candidates) {
      if (c !== undefined && c !== null && c !== '') return String(c);
    }
    return null;
  }

  /**
   * @private
   */
  _extractText(msg) {
    if (!msg) return '';
    const candidates = [msg.text, msg.body, msg.message, msg.content];
    for (const c of candidates) {
      if (typeof c === 'string' && c.length > 0) return c;
    }
    return '';
  }

  /* --------------------------------------------------------------------- *
   * Per-kind handlers
   * --------------------------------------------------------------------- */

  /**
   * @private
   * A real human reply. We:
   *   - append it to the per-phone session ledger,
   *   - persist a 'replied' status through the DataManager (if available) so
   *     the dispatch reports can attribute it back to the original send,
   *   - (optionally) forward a copy to Telegram for live monitoring.
   */
  async _handleMessage(env) {
    const session = this._touchSession(env.phone, { status: 'replied' });
    session.messages.push({ dir: 'in', text: env.text, ts: env.ts });

    if (this.dataManager && typeof this.dataManager.updateStatus === 'function' && env.phone) {
      try {
        await this.dataManager.updateStatus(env.phone, 'replied', {
          repliedAt: env.ts,
          replyText: env.text,
        });
      } catch (_) {
        /* persistence best-effort */
      }
    }

    await this._safeInfo(`inbound message from ${env.phone || '?'}: "${env.text.slice(0, 80)}"`);

    if (this.telegramToken && this.telegramChatId) {
      // Fire-and-forget mirror — best-effort, never blocks the dispatch loop.
      this._mirrorToTelegram(`💬 [${this.instanceId}] ${env.phone || '?'}: ${env.text}`).catch(() => {});
    }
  }

  /**
   * @private
   * Delivery / read receipt. Updates the session's last status; persists a
   * 'delivered' or 'read' status through the DataManager when present.
   */
  async _handleReceipt(env) {
    const status = this._receiptStatus(env.raw);
    const session = this._touchSession(env.phone, { status, lastSeenAt: env.ts });

    if (this.dataManager && typeof this.dataManager.updateStatus === 'function' && env.phone) {
      try {
        await this.dataManager.updateStatus(env.phone, status, {
          receiptAt: env.ts,
        });
      } catch (_) {
        /* ignore */
      }
    }

    await this._safeInfo(`receipt ${status} for ${env.phone || '?'} (total session msgs: ${session.messages.length})`);
  }

  /**
   * @private
   * Session-status signal (connected / disconnected / banned / qr-scanned, …).
   * Surface to logs + Telegram so operators can react in real time.
   */
  async _handleStatus(env) {
    const signal =
      env.raw.sessionStatus ||
      env.raw.detail ||
      env.raw.state ||
      env.raw.eventDetail ||
      'unknown-status';

    this._touchSession(env.phone, { status: `session:${signal}`, lastSeenAt: env.ts });

    await this._safeInfo(`session status signal: ${signal} (phone=${env.phone || 'global'})`);

    if (this.telegramToken && this.telegramChatId) {
      this._mirrorToTelegram(`🔔 [${this.instanceId}] session ${signal}`).catch(() => {});
    }
  }

  /**
   * @private
   */
  async _handleUnknown(env) {
    await this._safeInfo(`unrecognized inbound payload kind from ${env.phone || '?'} — ignored`);
  }

  /* --------------------------------------------------------------------- *
   * Helpers
   * --------------------------------------------------------------------- */

  /**
   * @private
   * Returns the existing session for `phone`, creating one if needed, and
   * merges `patch` into it.
   */
  _touchSession(phone, patch) {
    const key = phone ? String(phone) : '__global__';
    let session = this.sessions.get(key);
    if (!session) {
      session = { phone: key, status: 'new', lastSeenAt: new Date().toISOString(), messages: [] };
      this.sessions.set(key, session);
    }
    if (patch && typeof patch === 'object') {
      Object.assign(session, patch);
    }
    return session;
  }

  /**
   * @private
   * Maps a raw receipt payload to one of the DataManager's allowed statuses.
   */
  _receiptStatus(raw) {
    const s = String(raw && (raw.status || raw.receipt || raw.delivery) || '').toLowerCase();
    if (s === 'read') return 'read';
    if (s === 'failed' || s === 'error') return 'error';
    return 'delivered';
  }

  /**
   * @private
   * Best-effort logger wrappers — degrade to no-ops when no logger is injected.
   */
  async _safeInfo(m) {
    if (this.logger && typeof this.logger.info === 'function') {
      try { await this.logger.info(`[IncomingHandler][${this.instanceId}] ${m}`); } catch (_) {}
    }
  }
  async _safeError(m) {
    if (this.logger && typeof this.logger.error === 'function') {
      try { await this.logger.error(`[IncomingHandler][${this.instanceId}] ${m}`); } catch (_) {}
    } else {
      // eslint-disable-next-line no-console
      console.error(`[IncomingHandler][${this.instanceId}] ${m}`);
    }
  }

  /**
   * @private
   * Fire-and-forget Telegram mirror. Zero-dependency: uses native https.
   * Kept here (rather than reaching into InstanceRunner) so the handler is
   * self-contained — but it deliberately swallows all errors so a missing or
   * invalid token never crashes inbound processing.
   */
  _mirrorToTelegram(text) {
    return new Promise((resolve) => {
      try {
        if (!this.telegramToken || !this.telegramChatId) return resolve(null);
        const https = require('https');
        const data = JSON.stringify({ chat_id: this.telegramChatId, text });
        const req = https.request(
          {
            method: 'POST',
            hostname: 'api.telegram.org',
            path: `/bot${this.telegramToken}/sendMessage`,
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(data),
            },
            timeout: 4000,
          },
          () => resolve(null)
        );
        req.on('error', () => resolve(null));
        req.on('timeout', () => { try { req.destroy(); } catch (_) {} resolve(null); });
        req.write(data);
        req.end();
      } catch (_) {
        resolve(null);
      }
    });
  }
}

module.exports = IncomingHandler;
module.exports.IncomingHandler = IncomingHandler;
