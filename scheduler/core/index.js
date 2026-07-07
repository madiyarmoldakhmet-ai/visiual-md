'use strict';

/**
 * core/index.js
 * -------------
 * WhatsApp Client integration interface.
 *
 * This module is the seam between the `scheduler/` orchestration layer and the
 * concrete WhatsApp transport (baileys / whatsapp-web.js / a HTTP gateway). In
 * production it is replaced by a real client; in this workspace it ships as a
 * fully-functional simulation stub so the entire pipeline — InstanceRunner →
 * WaveScheduler → IntervalGenerator → DataManager → IncomingHandler — can be
 * exercised end-to-end without hitting the WhatsApp network.
 *
 * Required by `scheduler/InstanceRunner.js` as:
 *
 *     const { WhatsAppClient } = require(path.join(baseDir, 'core'));
 *
 * The stub honours the SAME async contract a real client must satisfy:
 *   - connect()                → Promise<void>
 *   - sendMessage(phone, text) → Promise<{ ok, phone, messageId, ts }>
 *   - onIncomingMessage(cb)    → registers a listener for inbound traffic
 *   - on(event, cb)            → EventEmitter-style alias used by InstanceRunner
 *                                for binding the 'message' event.
 *   - disconnect()             → Promise<void> (idempotent, never throws)
 *
 * The stub records every dispatched message in an in-memory ledger and exposes
 * `lastMessage()` / `sentLog` for assertions in integration tests.
 */

const crypto = require('crypto');

class WhatsAppClient {
  /**
   * @param {{
   *   instanceId?: string|number,
   *   config?: object,
   *   transport?: object,
   *   latencyMs?: number
   * }} [options]
   */
  constructor({ instanceId, config, transport, latencyMs } = {}) {
    this.instanceId = instanceId !== undefined ? String(instanceId) : 'default';
    this.config = config || {};
    this.transport = transport || null; // future: real client handle

    // Simulated network latency for sendMessage round-trips. Tiny by default
    // so tests stay fast but still exercise the await path.
    this.latencyMs = typeof latencyMs === 'number' ? latencyMs : 25;

    this.connected = false;
    this.connecting = null; // in-flight connect() promise (dedup)

    // Public ledger of dispatched messages — handy for integration assertions.
    this.sentLog = [];

    // Event listeners. Supports BOTH the onIncomingMessage(cb) API and the
    // EventEmitter-style on('message', cb) API that InstanceRunner uses.
    this._listeners = {
      message: [],
      incoming: [],
      status: [],
      disconnected: [],
    };

    // Optional injected transport. When provided, sendMessage/connect/
    // disconnect delegate to it (production wiring point).
    this._useTransport = !!(this.transport && typeof this.transport.sendMessage === 'function');
  }

  /* --------------------------------------------------------------------- *
   * Lifecycle
   * --------------------------------------------------------------------- */

  /**
   * Opens the simulated connection. Idempotent: a second call while the first
   * is in flight (or already connected) returns the same promise.
   *
   * @returns {Promise<void>}
   */
  async connect() {
    if (this.connected) return;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      await this._delay(this.latencyMs);
      if (this._useTransport && typeof this.transport.connect === 'function') {
        await this.transport.connect();
      }
      this.connected = true;
      this.connecting = null;
    })();

    return this.connecting;
  }

  /**
   * Closes the simulated connection. Idempotent and never rejects — closing
   * must always be safe from a `finally` block.
   *
   * @returns {Promise<void>}
   */
  async disconnect() {
    if (!this.connected && !this.connecting) return;
    try {
      await this._delay(this.latencyMs);
      if (this._useTransport && typeof this.transport.disconnect === 'function') {
        await this.transport.disconnect();
      }
    } catch (_) {
      /* swallow: disconnect must never throw to a finally block */
    } finally {
      this.connected = false;
      this.connecting = null;
      this._emit('disconnected', { instanceId: this.instanceId });
    }
  }

  /* --------------------------------------------------------------------- *
   * Sending
   * --------------------------------------------------------------------- */

  /**
   * Sends a single message to `phone` with body `text`.
   *
   * Returns a simulated success payload shaped the way a real client would —
   * `{ ok, phone, messageId, ts, instanceId }`. Rejects only when not
   * connected (matching real-client behaviour so callers see the contract
   * violation loudly during development).
   *
   * @param {string} phone
   * @param {string} text
   * @returns {Promise<{ok:boolean, phone:string, messageId:string, ts:string, instanceId:string}>}
   */
  async sendMessage(phone, text) {
    if (!this.connected) {
      throw new Error(`WhatsAppClient[${this.instanceId}]: sendMessage before connect()`);
    }
    await this._delay(this.latencyMs);

    const messageId = `msg_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const ts = new Date().toISOString();

    if (this._useTransport) {
      const real = await this.transport.sendMessage(phone, text);
      const entry = {
        ok: true,
        phone,
        text,
        messageId,
        ts,
        instanceId: this.instanceId,
        transport: real,
      };
      this.sentLog.push(entry);
      return entry;
    }

    const entry = { ok: true, phone, text, messageId, ts, instanceId: this.instanceId };
    this.sentLog.push(entry);
    return entry;
  }

  /* --------------------------------------------------------------------- *
   * Inbound events
   * --------------------------------------------------------------------- */

  /**
   * Registers a listener for inbound messages. Alias kept on the prototype so
   * callers that prefer the named API (vs. on('message', cb)) work too.
   *
   * @param {(payload: object) => void|Promise<void>} callback
   * @returns {() => void} unsubscribe function
   */
  onIncomingMessage(callback) {
    if (typeof callback !== 'function') {
      throw new TypeError('WhatsAppClient.onIncomingMessage: callback must be a function');
    }
    this._listeners.message.push(callback);
    this._listeners.incoming.push(callback);
    return () => {
      this._listeners.message = this._listeners.message.filter((fn) => fn !== callback);
      this._listeners.incoming = this._listeners.incoming.filter((fn) => fn !== callback);
    };
  }

  /**
   * EventEmitter-style registration. InstanceRunner uses `on('message', cb)`.
   * Supported events: 'message', 'incoming', 'status', 'disconnected'.
   *
   * @param {string} event
   * @param {Function} callback
   * @returns {() => void} unsubscribe function
   */
  on(event, callback) {
    if (typeof event !== 'string') {
      throw new TypeError('WhatsAppClient.on: event must be a string');
    }
    if (typeof callback !== 'function') {
      throw new TypeError('WhatsAppClient.on: callback must be a function');
    }
    const bucket = this._listeners[event] || (this._listeners[event] = []);
    bucket.push(callback);
    return () => {
      this._listeners[event] = bucket.filter((fn) => fn !== callback);
    };
  }

  /**
   * Test/driver hook: synthetically deliver an inbound payload to all
   * registered listeners. Real clients would invoke this on socket data.
   *
   * @param {object} payload
   * @returns {void}
   */
  simulateIncoming(payload) {
    this._emit('message', payload);
    this._emit('incoming', payload);
  }

  /**
   * @private
   * Dispatches `payload` to every listener registered for `event`. Listeners
   * may be async; failures are isolated so one bad listener does not break
   * the others.
   */
  _emit(event, payload) {
    const bucket = this._listeners[event];
    if (!bucket || bucket.length === 0) return;
    for (const fn of bucket.slice()) {
      try {
        const ret = fn(payload);
        if (ret && typeof ret.catch === 'function') {
          ret.catch(() => { /* listener failure is non-fatal */ });
        }
      } catch (_) {
        /* isolate listener errors */
      }
    }
  }

  /* --------------------------------------------------------------------- *
   * Convenience accessors
   * --------------------------------------------------------------------- */

  /** @returns {object|null} the most recent dispatched message, or null. */
  lastMessage() {
    return this.sentLog.length ? this.sentLog[this.sentLog.length - 1] : null;
  }

  /** @returns {number} total messages dispatched in this client's lifetime. */
  sentCount() {
    return this.sentLog.length;
  }

  /* --------------------------------------------------------------------- *
   * Internals
   * --------------------------------------------------------------------- */

  /**
   * @private
   * Promise-based sleep. Non-positive values resolve on the next microtask.
   */
  _delay(ms) {
    if (typeof ms !== 'number' || ms <= 0) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, Math.floor(ms)));
  }
}

module.exports = WhatsAppClient;
module.exports.WhatsAppClient = WhatsAppClient;
