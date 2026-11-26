"use strict";

const { BREAKER } = require("./schema");

const WINDOW_MS = 60000;
const DAY_MS = 86400000;
const COOLDOWN_GROWTH = 2;

function createRequestWindow(maxPerMinute) {
  const max = Number.isSafeInteger(maxPerMinute) && maxPerMinute > 0 ? maxPerMinute : 0;
  const times = [];
  const expire = (now) => {
    while (times.length > 0 && times[0] + WINDOW_MS <= now) times.shift();
  };
  return Object.freeze({
    tryTake(now) {
      expire(now);
      if (times.length >= max) return false;
      times.push(now);
      return true;
    },
    inWindow(now) {
      expire(now);
      return times.length;
    },
  });
}

function createDailyBudget(limit) {
  const max = Number.isSafeInteger(limit) && limit > 0 ? limit : 0;
  let day = null;
  let used = 0;
  const roll = (now) => {
    const d = Math.floor(now / DAY_MS);
    if (d !== day) {
      day = d;
      used = 0;
    }
  };
  return Object.freeze({
    canSpend(n, now) {
      roll(now);
      const need = Number.isFinite(n) && n > 0 ? n : 0;
      return max > 0 && used + need <= max;
    },
    spend(n, now) {
      roll(now);
      if (Number.isFinite(n) && n > 0) used += Math.ceil(n);
    },
    usedToday(now) {
      roll(now);
      return used;
    },
  });
}

function createBreaker(S) {
  const limit = Math.max(1, S.breakerFailures);
  const baseCd = S.breakerCooldownMs;
  const maxCd = Math.max(baseCd, S.breakerMaxCooldownMs);
  let state = BREAKER.CLOSED;
  let failures = 0;
  let cd = baseCd;
  let until = 0;
  let probing = false;
  let opened = 0;

  const open = (now, retryAfterMs) => {
    state = BREAKER.OPEN;
    probing = false;
    const wait = Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? Math.min(maxCd, Math.max(cd, retryAfterMs)) : cd;
    until = now + wait;
    opened += 1;
  };

  return {
    state(now) {
      if (state === BREAKER.OPEN && now >= until) return BREAKER.HALF_OPEN;
      return state;
    },
    allow(now) {
      if (state === BREAKER.CLOSED) return true;
      if (state === BREAKER.OPEN) {
        if (now < until) return false;
        state = BREAKER.HALF_OPEN;
        probing = false;
      }
      if (probing) return false;
      probing = true;
      return true;
    },
    release() {
      if (state === BREAKER.HALF_OPEN) probing = false;
    },
    success(_now) {
      state = BREAKER.CLOSED;
      failures = 0;
      cd = baseCd;
      probing = false;
    },
    failure(now, retryAfterMs) {
      if (state === BREAKER.HALF_OPEN) {
        cd = Math.min(COOLDOWN_GROWTH * cd, maxCd);
        open(now, retryAfterMs);
        return;
      }
      if (state === BREAKER.OPEN) return;
      failures += 1;
      if (failures >= limit) open(now, retryAfterMs);
    },
    get opened() {
      return opened;
    },
  };
}

module.exports = { createRequestWindow, createDailyBudget, createBreaker, WINDOW_MS, DAY_MS };
