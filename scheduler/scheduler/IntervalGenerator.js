'use strict';

/**
 * IntervalGenerator
 *
 * Produces randomized intervals around a base value (in seconds) using a
 * uniform distribution bounded by ±randomizationPercent%. Also exposes a
 * standalone sleep() helper returning a Promise.
 *
 * Designed for jittering delays between consecutive WhatsApp sends to avoid
 * robotic, deterministic timing patterns.
 */
class IntervalGenerator {
  /**
   * @param {number} [randomizationPercent=20] Percentage (0-100) of jitter
   *   applied symmetrically around the base interval.
   */
  constructor(randomizationPercent = 20) {
    if (
      typeof randomizationPercent !== 'number' ||
      Number.isNaN(randomizationPercent) ||
      randomizationPercent < 0 ||
      randomizationPercent > 100
    ) {
      throw new Error(
        `IntervalGenerator: randomizationPercent must be a number in [0,100], received: ${randomizationPercent}`
      );
    }
    this.randomizationPercent = randomizationPercent;
  }

  /**
   * Generates a randomized interval around the given base value.
   *
   * @param {number} baseIntervalSec Base interval in seconds.
   * @returns {number} Randomized interval in milliseconds (integer).
   */
  generate(baseIntervalSec) {
    if (typeof baseIntervalSec !== 'number' || Number.isNaN(baseIntervalSec) || baseIntervalSec < 0) {
      throw new Error(
        `IntervalGenerator.generate: baseIntervalSec must be a non-negative number, received: ${baseIntervalSec}`
      );
    }

    const baseMs = Math.floor(baseIntervalSec * 1000);
    const fraction = this.randomizationPercent / 100;
    const delta = baseMs * fraction;

    // Uniform random in [baseMs - delta; baseMs + delta]
    const randomized = baseMs - delta + Math.random() * (2 * delta);

    // Clamp to non-negative and floor to integer ms.
    return Math.max(0, Math.floor(randomized));
  }

  /**
   * Promise-based sleep.
   *
   * @param {number} ms Milliseconds to sleep. Non-positive values resolve immediately.
   * @returns {Promise<void>}
   */
  sleep(ms) {
    if (typeof ms !== 'number' || Number.isNaN(ms) || ms <= 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => setTimeout(resolve, Math.floor(ms)));
  }
}

module.exports = IntervalGenerator;
module.exports.IntervalGenerator = IntervalGenerator;