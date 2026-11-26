"use strict";

const SLOW_LOG_WINDOW_MS = 60000;

function noop() {}

function createSlowOpLog(opts) {
  const slowOpMs = opts && typeof opts.slowOpMs === "number" && opts.slowOpMs > 0 ? opts.slowOpMs : null;
  const perMin = opts && Number.isSafeInteger(opts.perMin) && opts.perMin >= 0 ? opts.perMin : 0;
  const nowMs = opts && typeof opts.nowMs === "function" ? opts.nowMs : () => 0;
  const logger = opts && opts.logger && typeof opts.logger.log === "function" ? opts.logger : { log: noop };
  let windowStart = null;
  let inWindow = 0;
  let suppressed = 0;

  return Object.freeze({
    isSlow: (ms) => slowOpMs !== null && typeof ms === "number" && ms > slowOpMs,
    log(line) {
      try {
        const now = nowMs();
        if (windowStart === null || now - windowStart >= SLOW_LOG_WINDOW_MS) {
          windowStart = now;
          inWindow = 0;
        }
        if (inWindow >= perMin) {
          suppressed += 1;
          return false;
        }
        inWindow += 1;
        logger.log(line);
        return true;
      } catch (_err) {
        return false;
      }
    },
    suppressed: () => suppressed,
  });
}

module.exports = { createSlowOpLog, SLOW_LOG_WINDOW_MS };
