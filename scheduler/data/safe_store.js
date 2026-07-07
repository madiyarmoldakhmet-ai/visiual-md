'use strict';

/**
 * data/safe_store.js
 * ------------------
 * Hardened I/O core for the scheduler.
 *
 * Guarantees provided to callers (DataManager, Logger, …):
 *
 *   1. ATOMIC PUBLISH
 *      `atomicWriteJSON` serializes to a unique hidden temp file in the SAME
 *      directory, fsyncs it, then calls `fs.promises.rename`. On POSIX,
 *      rename over a file in the same directory is atomic: a concurrent
 *      reader sees either the old bytes or the new bytes — never a torn /
 *      half-written file. We never write the destination directly.
 *
 *   2. MUTUAL EXCLUSION AROUND READ-MODIFY-WRITE
 *      Atomic rename alone does NOT prevent lost updates when two agents do
 *      `read → mutate → write`: A and B can both read "pending", both
 *      mutate, and the second rename silently clobbers the first. To make a
 *      read-modify-write safe we must serialize the WHOLE critical section.
 *
 *      `withLock(path, fn)` runs `fn` under an exclusive lock:
 *        - in-process: a per-path Promise chain (Node is single-threaded,
 *          so this alone serializes awaits within one process);
 *        - cross-process: an exclusive file lock acquired with O_EXCL +
 *          O_CREAT (the exact algorithm `proper-lockfile` uses on POSIX).
 *          If Agent 1 holds the lock, Agents 2–5 retry with exponential
 *          backoff + jitter until Agent 1 releases it.
 *      Stale locks left by a crashed holder are reclaimed after a heartbeat
 *      timeout, mirroring proper-lockfile's `stale` option.
 *
 * No third-party dependency: we depend only on `fs` + `crypto`. This keeps
 * the on-disk lock format compatible with a hand-rolled re-implementation
 * while behaving like `proper-lockfile.lock(...)`.
 */

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const os = require('os');

/* -------------------------------------------------------------------------- *
 * Atomic JSON publish: write temp → fsync → rename
 * -------------------------------------------------------------------------- */

/**
 * Atomically write `data` (JSON-serialized) to `targetPath`.
 *
 * Steps:
 *   1. Ensure the parent directory exists.
 *   2. Write to `.${basename}.${pid}.${rand}.tmp` (hidden, unique).
 *   3. fsync the fd so the bytes survive a crash between write and rename.
 *   4. `fs.promises.rename` over the destination — atomic on POSIX.
 *   5. `fsync` the parent directory so the rename itself is durable.
 *      (Best-effort on platforms that forbid fsync on directories.)
 *
 * @param {string} targetPath Absolute path to the destination file.
 * @param {*} data            Any JSON-serializable value.
 * @returns {Promise<void>}
 */
async function atomicWriteJSON(targetPath, data) {
  const dir = path.dirname(targetPath);
  await fsp.mkdir(dir, { recursive: true });

  const payload = JSON.stringify(data, null, 2);
  const tmpName = `.${path.basename(targetPath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const tmpPath = path.join(dir, tmpName);

  // Open with 'w' (O_CREAT|O_WRONLY|O_TRUNC). The random suffix guarantees
  // no two concurrent temp files collide even from the same pid.
  const fd = await fsp.open(tmpPath, 'w');
  try {
    await fd.writeFile(payload);
    await fd.sync(); // fsync the file contents to disk.
  } finally {
    await fd.close();
  }

  // Atomic publish. rename() is atomic when src/dst share a filesystem.
  await fsp.rename(tmpPath, targetPath);

  // Best-effort: make the directory entry change durable too.
  await fsyncDirectory(dir);
}

/**
 * Atomically read & parse a JSON file. Returns `fallback` if it does not
 * exist. Throws on malformed JSON (so corruption is surfaced, not hidden).
 *
 * @param {string} filePath
 * @param {*} [fallback] Value returned when the file is missing.
 * @returns {Promise<*>}
 */
async function atomicReadJSON(filePath, fallback) {
  let raw;
  try {
    raw = await fsp.readFile(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
  return JSON.parse(raw);
}

/**
 * Best-effort `fsync` of a directory. Required for rename durability on
 * Linux/ext4; a no-op-ish failure on platforms that reject it.
 *
 * @param {string} dir
 * @returns {Promise<void>}
 */
async function fsyncDirectory(dir) {
  let dh;
  try {
    dh = await fsp.open(dir, 'r');
    try {
      await dh.sync();
    } catch (_) {
      // Some platforms (e.g. Windows network shares) reject dir fsync.
    }
  } catch (_) {
    // Opening a directory for read can fail on some FSes; not fatal.
  } finally {
    if (dh) {
      try { await dh.close(); } catch (_) { /* ignore */ }
    }
  }
}

/* -------------------------------------------------------------------------- *
 * Cleanup helper for orphaned temp files (e.g. after a crash mid-write)
 * -------------------------------------------------------------------------- */

/**
 * Remove hidden temp files for a given target that look abandoned. Only
 * files matching `.${basename}.*.tmp` and older than `maxAgeMs` are swept.
 * Called opportunistically; never throws.
 *
 * @param {string} targetPath
 * @param {number} [maxAgeMs=60000]
 * @returns {Promise<void>}
 */
async function sweepTempFiles(targetPath, maxAgeMs = 60_000) {
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  let entries;
  try {
    entries = await fsp.readdir(dir);
  } catch (_) {
    return;
  }
  const now = Date.now();
  await Promise.all(entries.map(async (name) => {
    if (!name.startsWith(`.${base}.`) || !name.endsWith('.tmp')) return;
    try {
      const full = path.join(dir, name);
      const st = await fsp.stat(full);
      if (now - st.mtimeMs > maxAgeMs) await fsp.unlink(full).catch(() => {});
    } catch (_) { /* ignore */ }
  }));
}

/* -------------------------------------------------------------------------- *
 * Locking: in-process mutex + cross-process O_EXCL lockfile
 * -------------------------------------------------------------------------- */

/**
 * Default lock options. Tuned so a contended Agent waits up to ~1 minute
 * total before giving up — far longer than any legitimate commit.
 */
const DEFAULT_LOCK_OPTIONS = {
  lockDir: null,        // default: sibling `.locks` dir of the target
  staleMs: 10_000,      // reclaim lock if holder's heartbeat is older than this
  initialDelayMs: 20,   // first backoff sleep between retries
  maxDelayMs: 1_000,    // cap backoff
  timeoutMs: 60_000,    // give up after this many ms
  maxRetries: 2_000,    // hard cap on retry count
};

// Per-process, per-key mutex. Chains promises so concurrent awaits within
// a single process serialize even before touching the filesystem.
const _inProcessLocks = new Map();

/**
 * Serialize access to `key` WITHIN this process. Returns whatever `fn`
 * resolves to. Concurrent calls with the same `key` run strictly in order.
 *
 * @param {string} key
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 * @template T
 */
function withInProcessLock(key, fn) {
  const prev = _inProcessLocks.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  // Swallow rejection on the stored chain so one failure can't poison every
  // future acquisition; the actual value/error is delivered to `next`.
  _inProcessLocks.set(key, next.then(() => {}, () => {}));
  return next;
}

/**
 * Sleep helper.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build a human-readable lockfile path for a target.
 *
 * @param {string} targetPath
 * @param {string|null} lockDir
 * @returns {string}
 */
function lockfilePathFor(targetPath, lockDir) {
  const dir = lockDir || path.join(path.dirname(targetPath), '.locks');
  const base = path.basename(targetPath).replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(dir, `${base}.lock`);
}

/**
 * Attempt ONE acquisition of the cross-process lockfile using O_EXCL|O_CREAT.
 *
 * Lockfile content (JSON):
 *   { pid, hostname, bornAt, heartbeatAt }
 *
 * On success, schedules a periodic heartbeat refresh so other processes can
 * detect staleness. Returns the disposer handle (with `release()`).
 *
 * @param {string} lockPath
 * @param {object} opts
 * @returns {Promise<{release: () => Promise<void>}>}
 */
async function tryAcquireLockfile(lockPath, opts) {
  await fsp.mkdir(path.dirname(lockPath), { recursive: true });

  const ident = {
    pid: process.pid,
    hostname: os.hostname(),
    bornAt: Date.now(),
    heartbeatAt: Date.now(),
  };

  // O_EXCL guarantees only one creator wins. 'wx' === O_CREAT|O_EXCL|O_WRONLY.
  let handle;
  try {
    handle = await fsp.open(lockPath, 'wx');
  } catch (err) {
    if (err.code === 'EEXIST') {
      // Lock exists. Is it stale? If so, reclaim it.
      await reclaimIfStale(lockPath, opts.staleMs);
      // Re-attempt acquisition (throws EEXIST again if still held).
      handle = await fsp.open(lockPath, 'wx');
    } else {
      throw err;
    }
  }

  // We own it. Persist identity, then begin heartbeat.
  await handle.writeFile(JSON.stringify(ident));
  await handle.sync();
  await handle.close();

  const heartbeat = setInterval(async () => {
    try {
      const fresh = {
        ...ident,
        heartbeatAt: Date.now(),
      };
      // Atomic update of the lockfile mtime + content.
      const tmp = `${lockPath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.hb`;
      const h = await fsp.open(tmp, 'w');
      await h.writeFile(JSON.stringify(fresh));
      await h.sync();
      await h.close();
      await fsp.rename(tmp, lockPath);
    } catch (_) {
      /* heartbeat best-effort */
    }
  }, Math.max(500, Math.floor(opts.staleMs / 4)));

  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      clearInterval(heartbeat);
      try {
        await fsp.unlink(lockPath);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
        // Already gone — someone else may have reclaimed and released it.
      }
    },
  };
}

/**
 * If the existing lockfile's heartbeat is older than `staleMs`, attempt to
 * reclaim it by unlinking (relying on O_EXCL on the next attempt).
 *
 * @param {string} lockPath
 * @param {number} staleMs
 * @returns {Promise<void>}
 */
async function reclaimIfStale(lockPath, staleMs) {
  let raw;
  try {
    raw = await fsp.readFile(lockPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return; // already released, fine
    throw err;
  }
  let info;
  try {
    info = JSON.parse(raw);
  } catch (_) {
    // Corrupt lockfile → treat as stale and clear it.
    await fsp.unlink(lockPath).catch(() => {});
    return;
  }
  const hb = Number(info.heartbeatAt || info.bornAt || 0);
  if (Number.isFinite(hb) && Date.now() - hb > staleMs) {
    await fsp.unlink(lockPath).catch(() => {});
  }
}

/**
 * Acquire an exclusive lock on `targetPath`, retrying with exponential
 * backoff + jitter until success or timeout. Mirrors the user-visible
 * contract of `proper-lockfile.lock(...)`.
 *
 * @param {string} targetPath  The data file being protected.
 * @param {object} [options]
 * @returns {Promise<{release: () => Promise<void>}>}
 */
async function acquireLock(targetPath, options = {}) {
  const opts = { ...DEFAULT_LOCK_OPTIONS, ...options };
  const lockPath = lockfilePathFor(targetPath, opts.lockDir);

  const deadline = Date.now() + opts.timeoutMs;
  let delay = opts.initialDelayMs;
  let attempt = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt += 1;
    try {
      return await tryAcquireLockfile(lockPath, opts);
    } catch (err) {
      const held = err && (err.code === 'EEXIST' || err.code === 'EPERM');
      if (!held) throw err; // unexpected I/O error — propagate.

      if (Date.now() >= deadline || attempt > opts.maxRetries) {
        const e = new Error(
          `Lock acquisition timed out after ${opts.timeoutMs}ms for ${targetPath} ` +
          `(attempt ${attempt}; lockfile=${lockPath})`
        );
        e.code = 'LOCK_TIMEOUT';
        e.lockPath = lockPath;
        throw e;
      }
      // Exponential backoff with full jitter.
      const jitter = Math.random() * delay;
      await sleep(jitter);
      delay = Math.min(delay * 2, opts.maxDelayMs);
    }
  }
}

/**
 * Run `fn` while holding the exclusive lock for `targetPath`. Releases the
 * lock exactly once, even if `fn` throws. This is the safe primitive for any
 * read-modify-write critical section.
 *
 * @param {string} targetPath
 * @param {() => Promise<T>} fn
 * @param {object} [options]
 * @returns {Promise<T>}
 * @template T
 */
async function withLock(targetPath, fn, options = {}) {
  // In-process serialization first (cheap, avoids needless lock churn).
  return withInProcessLock(targetPath, async () => {
    const handle = await acquireLock(targetPath, options);
    try {
      return await fn();
    } finally {
      await handle.release();
    }
  });
}

module.exports = {
  atomicWriteJSON,
  atomicReadJSON,
  fsyncDirectory,
  sweepTempFiles,
  withLock,
  acquireLock,
  withInProcessLock,
  DEFAULT_LOCK_OPTIONS,
};
