'use strict';

/**
 * data/Logger.js
 * --------------
 * Per-instance logger that appends JSON-lines to a namespaced log file.
 *
 * Append-only logs are far less racy than JSON-registry RMWs (you can
 * append with a single `O_APPEND` write on POSIX and the kernel serializes
 * them), BUT:
 *   - `logSend` here also mirrors into the shared status_registry via the
 *     caller (InstanceRunner) — that path is protected by DataManager.
 *   - We still wrap multi-record writes (none today, but reserved) under
 *     safe_store.withLock so the primitive is safe by default.
 *
 * The log file itself is opened with flag 'a' (O_APPEND), which on local
 * POSIX filesystems guarantees atomic appends for writes ≤ PIPE_BUF. We
 * additionally serialize within the process so the interleaved timestamps
 * stay monotonic per instance.
 */

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');

class Logger {
  /**
   * @param {{
   *   instanceId: string|number,
   *   baseDir?: string,
   *   logsDir?: string
   * }} options
   */
  constructor({ instanceId, baseDir, logsDir } = {}) {
    if (instanceId === undefined || instanceId === null || instanceId === '') {
      throw new Error('Logger: instanceId is required');
    }
    this.instanceId = String(instanceId);
    this.baseDir = baseDir || path.resolve(__dirname, '..');
    this.logsDir = logsDir || path.join(this.baseDir, 'logs');
    this._logPath = path.join(this.logsDir, `instance_${this.instanceId}.log`);

    // Serialize in-process so timestamps stay monotonic.
    this._chain = Promise.resolve();
    this._fh = null; // lazy-opened handle
  }

  /**
   * @private
   * Opens the log file handle with O_APPEND. Lazily created on first write
   * so constructing a Logger is side-effect-free (important for tests).
   */
  async _handle() {
    if (this._fh) return this._fh;
    await fsp.mkdir(this.logsDir, { recursive: true });
    // 'a' === O_WRONLY|O_CREAT|O_APPEND. Concurrent appends from multiple
    // processes to the same file are atomic on POSIX for small writes.
    this._fh = await fsp.open(this._logPath, 'a');
    return this._fh;
  }

  /**
   * @private
   * Serialize a write through the in-process chain.
   * @param {string} line  Already-formatted line WITHOUT trailing newline.
   */
  async _writeLine(line) {
    this._chain = this._chain.then(async () => {
      const h = await this._handle();
      await h.writeFile(line + '\n');
    });
    return this._chain;
  }

  /**
   * @param {string} msg
   * @returns {Promise<void>}
   */
  async info(msg) {
    await this._writeLine(this._format('INFO', msg));
  }

  /**
   * @param {string} msg
   * @returns {Promise<void>}
   */
  async error(msg) {
    await this._writeLine(this._format('ERROR', msg));
  }

  /**
   * @param {{instanceId:string,targetId:string,phone:string,wave:string,waveIndex:number}} data
   * @returns {Promise<void>}
   */
  async logSend(data) {
    await this._writeLine(this._format('SEND', JSON.stringify(data)));
  }

  /**
   * Close the file handle. Idempotent.
   * @returns {Promise<void>}
   */
  async close() {
    // Wait for any in-flight writes to finish before closing.
    await this._chain.catch(() => {});
    if (this._fh) {
      try { await this._fh.close(); } catch (_) { /* ignore */ }
      this._fh = null;
    }
  }

  /**
   * @private
   * @param {string} level
   * @param {string} msg
   * @returns {string} JSON-encoded log line
   */
  _format(level, msg) {
    return JSON.stringify({
      ts: new Date().toISOString(),
      level,
      instanceId: this.instanceId,
      msg,
    });
  }
}

module.exports = Logger;
module.exports.Logger = Logger;
