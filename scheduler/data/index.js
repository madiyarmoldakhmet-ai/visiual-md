'use strict';

/**
 * data/index.js
 * -------------
 * Public entry point for the `data` subsystem. Required by
 * `scheduler/InstanceRunner.js` as:
 *
 *     const { DataManager, Logger } = require(path.join(baseDir, 'data'));
 *
 * Exports:
 *   - DataManager : thread-safe persistence for shards + shared registry.
 *   - Logger      : per-instance JSON-lines logger.
 *   - safeStore   : raw primitives (atomicWriteJSON, withLock, …) for any
 *                   other module that needs the same guarantees.
 */

const DataManager = require('./DataManager');
const Logger = require('./Logger');
const safeStore = require('./safe_store');

module.exports = {
  DataManager,
  Logger,
  safeStore,
};
