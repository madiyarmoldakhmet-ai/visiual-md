'use strict';

/**
 * data/DataManager.js
 * -------------------
 * Thread-safe (process-safe) persistence layer for a single dispatch
 * instance. Loaded by `scheduler/InstanceRunner.js` via:
 *
 *     const { DataManager } = require(path.join(baseDir, 'data'));
 *
 * Responsibilities
 *   - loadPendingTargets() : read this instance's shard (messages_instance_N).
 *   - updateStatus(id, status, [meta]) : MUTATE state. This is the dangerous
 *     call — it is a read-modify-write. Without a lock, parallel agents that
 *     each load the shard, flip one record, and write it back will LOST-UPDATE
 *     each other. We therefore:
 *       1. take an exclusive lock on the shard (in-process mutex +
 *          cross-process O_EXCL lockfile with backoff — Agents 2–5 queue);
 *       2. read the current contents;
 *       3. mutate exactly the targeted record;
 *       4. publish via atomic temp-write → fsync → rename.
 *   - commitStatus(...)    : same, but writes to the SHARED registry file
 *     `status_registry.json`. Every instance writes here concurrently, so it
 *     is the canonical stress point. Same lock + atomic publish.
 *   - flush()              : no-op here (every write is already durable),
 *     kept for InstanceRunner's lifecycle contract.
 *
 * Why two writes? The per-instance shard is each agent's private work list;
 * the shared registry is a global "what is the state of every message right
 * now" ledger that all 5 instances append to. Both are protected the same way.
 */

const path = require('path');
const {
  atomicReadJSON,
  atomicWriteJSON,
  withLock,
  sweepTempFiles,
} = require('./safe_store');

/**
 * Statuses the registry knows how to record. Keeping this closed lets us
 * reject garbage writes early instead of letting them corrupt the ledger.
 */
const ALLOWED_STATUSES = new Set([
  'pending',
  'sent',
  'failed',
  'skipped',
  'delivered',
  'read',
  'replied',
  'error',
]);

class DataManager {
  /**
   * @param {{
   *   instanceId: string|number,
   *   baseDir?: string,
   *   dataDir?: string,
   *   lockOptions?: object
   * }} options
   */
  constructor({ instanceId, baseDir, dataDir, lockOptions } = {}) {
    if (instanceId === undefined || instanceId === null || instanceId === '') {
      throw new Error('DataManager: instanceId is required');
    }

    this.instanceId = String(instanceId);
    this.baseDir = baseDir || path.resolve(__dirname, '..');
    this.dataDir = dataDir || path.join(this.baseDir, 'data');
    this.lockOptions = lockOptions || undefined; // fall back to safe_store defaults

    // Lazily-computed paths.
    this._shardPath = null;
    this._registryPath = path.join(this.dataDir, 'status_registry.json');

    // Per-instance in-memory cache of the last-seen registry, purely so we
    // can attribute commits to this process for diagnostics. Never used as a
    // source of truth (we always re-read under the lock).
    this._lastCommitAt = null;
  }

  /* --------------------------------------------------------------------- *
   * Path helpers
   * --------------------------------------------------------------------- */

  /** @private */
  _shardFilePath() {
    if (this._shardPath) return this._shardPath;
    this._shardPath = path.join(this.dataDir, `messages_instance_${this.instanceId}.json`);
    return this._shardPath;
  }

  /** @private */
  _registryFilePath() {
    return this._registryPath;
  }

  /* --------------------------------------------------------------------- *
   * Reads
   * --------------------------------------------------------------------- */

  /**
   * Loads this instance's shard and returns ONLY records whose status is
   * still actionable (i.e. 'pending'). Records already marked sent/failed/
   * skipped are filtered out so a resumed run doesn't re-send them.
   *
   * Safe to call concurrently: it is a plain atomic read (no mutation), and
   * atomic rename guarantees we read a complete, consistent file.
   *
   * @returns {Promise<Array<Object>>}
   */
  async loadPendingTargets() {
    const all = await atomicReadJSON(this._shardFilePath(), []);
    if (!Array.isArray(all)) {
      throw new Error(
        `DataManager[${this.instanceId}]: shard ${this._shardFilePath()} is not a JSON array`
      );
    }
    return all.filter((rec) => !rec || rec.status === 'pending' || rec.status === undefined);
  }

  /**
   * Loads the full shard (all statuses). Read-only.
   *
   * @returns {Promise<Array<Object>>}
   */
  async loadAllTargets() {
    const all = await atomicReadJSON(this._shardFilePath(), []);
    return Array.isArray(all) ? all : [];
  }

  /* --------------------------------------------------------------------- *
   * Mutations — all locked + atomically published
   * --------------------------------------------------------------------- */

  /**
   * Update the status of a single record identified by `targetId` within
   * THIS instance's shard. Runs as a locked read-modify-write so that
   * concurrent agents (or a resumed run) cannot lose each other's updates.
   *
   * `targetId` is matched against the record's `contactId`, `id`, or `phone`,
   * in that order — matching the identity resolution used by InstanceRunner.
   *
   * @param {string} targetId
   * @param {string} status  One of ALLOWED_STATUSES.
   * @param {object} [meta]  Optional fields merged into the record
   *                         (e.g. { sentAt, wave, attempt }).
   * @returns {Promise<{targetId:string, status:string, found:boolean, instanceId:string}>}
   */
  async updateStatus(targetId, status, meta) {
    if (!targetId) throw new Error('DataManager.updateStatus: targetId is required');
    this._assertStatus(status);

    const shardPath = this._shardFilePath();
    const stamp = new Date().toISOString();

    return withLock(shardPath, async () => {
      const records = await atomicReadJSON(shardPath, []);
      if (!Array.isArray(records)) {
        throw new Error(`DataManager: shard ${shardPath} is not a JSON array`);
      }

      let found = false;
      for (const rec of records) {
        if (this._matchesTarget(rec, targetId)) {
          found = true;
          rec.status = status;
          rec.statusUpdatedAt = stamp;
          rec.lastInstanceId = this.instanceId;
          if (meta && typeof meta === 'object') {
            Object.assign(rec, meta);
          }
          // Do NOT break: a target might legitimately appear once, but if it
          // somehow appears twice we want both rows consistent.
        }
      }

      await atomicWriteJSON(shardPath, records);
      return { targetId, status, found, instanceId: this.instanceId };
    }, this.lockOptions);
  }

  /**
   * Append a commit entry to the SHARED registry. This is the canonical
   * multi-writer file: all 5 instances call it in parallel. Each call takes
   * the registry lock, so Agents 2–5 back off until Agent 1 finishes, then
   * proceed one at a time. No update is lost; the array only ever grows
   * appends-first.
   *
   * @param {{
   *   targetId: string,
   *   status: string,
   *   wave?: string,
   *   waveIndex?: number,
   *   phone?: string,
   *   attempt?: number,
   *   error?: string
   * }} entry
   * @returns {Promise<{index:number, total:number}>} index of the new entry
   */
  async commitStatus(entry) {
    if (!entry || entry.targetId === undefined) {
      throw new Error('DataManager.commitStatus: entry.targetId is required');
    }
    this._assertStatus(entry.status);

    const registryPath = this._registryFilePath();
    const stamp = new Date().toISOString();

    return withLock(registryPath, async () => {
      const registry = await atomicReadJSON(registryPath, []);
      if (!Array.isArray(registry)) {
        // Defensive: a corrupted registry should NEVER be silently overwritten
        // (we'd lose every prior commit). Move it aside and start fresh.
        await this._quarantineCorrupt(registryPath);
      }
      const list = Array.isArray(registry) ? registry : [];

      const record = {
        targetId: String(entry.targetId),
        instanceId: this.instanceId,
        status: entry.status,
        wave: entry.wave ?? null,
        waveIndex: entry.waveIndex ?? null,
        phone: entry.phone ?? null,
        attempt: entry.attempt ?? null,
        error: entry.error ?? null,
        committedAt: stamp,
        pid: process.pid,
      };
      list.push(record);

      await atomicWriteJSON(registryPath, list);
      this._lastCommitAt = stamp;

      return { index: list.length - 1, total: list.length };
    }, this.lockOptions);
  }

  /**
   * Bulk mark every record in this instance's shard with `status`. Useful for
   * resets / dry-runs. Still a locked RMW.
   *
   * @param {string} status
   * @returns {Promise<{updated:number}>}
   */
  async markAll(status) {
    this._assertStatus(status);
    const shardPath = this._shardFilePath();
    const stamp = new Date().toISOString();

    return withLock(shardPath, async () => {
      const records = await atomicReadJSON(shardPath, []);
      let updated = 0;
      for (const rec of Array.isArray(records) ? records : []) {
        if (rec && rec.status !== status) {
          rec.status = status;
          rec.statusUpdatedAt = stamp;
          rec.lastInstanceId = this.instanceId;
          updated += 1;
        }
      }
      await atomicWriteJSON(shardPath, Array.isArray(records) ? records : []);
      return { updated };
    }, this.lockOptions);
  }

  /* --------------------------------------------------------------------- *
   * Lifecycle
   * --------------------------------------------------------------------- */

  /**
   * InstanceRunner calls this on shutdown. Every mutation here is already
   * durable (fsync + rename), so there is no buffered state to drain. We
   * opportunistically sweep orphaned temp files for cleanliness.
   *
   * @returns {Promise<void>}
   */
  async flush() {
    await sweepTempFiles(this._shardFilePath()).catch(() => {});
    await sweepTempFiles(this._registryFilePath()).catch(() => {});
  }

  /* --------------------------------------------------------------------- *
   * Internals
   * --------------------------------------------------------------------- */

  /**
   * @private
   * @param {string} status
   */
  _assertStatus(status) {
    if (!ALLOWED_STATUSES.has(status)) {
      throw new Error(
        `DataManager: invalid status "${status}". Allowed: ${[...ALLOWED_STATUSES].join(', ')}`
      );
    }
  }

  /**
   * Identity resolution mirroring InstanceRunner: contactId → id → phone.
   *
   * @private
   * @param {object} rec
   * @param {string} targetId
   * @returns {boolean}
   */
  _matchesTarget(rec, targetId) {
    if (!rec || targetId === undefined || targetId === null) return false;
    const candidates = [rec.contactId, rec.id, rec.phone];
    return candidates.some((c) => c !== undefined && String(c) === String(targetId));
  }

  /**
   * If the shared registry is somehow corrupt, do NOT silently truncate it —
   * rename it to a quarantined name so history is preserved, then the caller
   * starts a fresh empty registry.
   *
   * @private
   * @param {string} registryPath
   * @returns {Promise<void>}
   */
  async _quarantineCorrupt(registryPath) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const quarantine = `${registryPath}.corrupt.${stamp}`;
    try {
      // rename is atomic; this either succeeds or raises (no half-state).
      const fs = require('fs').promises;
      await fs.rename(registryPath, quarantine);
      // eslint-disable-next-line no-console
      console.error(
        `[DataManager][${this.instanceId}] Registry was corrupt; ` +
        `quarantined to ${quarantine} and starting fresh.`
      );
    } catch (_) {
      /* if rename fails, the atomicWriteJSON that follows will replace it */
    }
  }
}

module.exports = DataManager;
module.exports.DataManager = DataManager;
module.exports.ALLOWED_STATUSES = ALLOWED_STATUSES;
