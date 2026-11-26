"use strict";

const MAX_FIELD_LENGTH = 80;

function field(value) {
  if (value === undefined || value === null || value === "") return "-";
  const text = String(value).replace(/\s+/gu, "_");
  return text.length > MAX_FIELD_LENGTH ? `${text.slice(0, MAX_FIELD_LENGTH)}...` : text;
}

function createRedeemLog({ config, now = Date.now, logFn }) {
  const keys = new Map();
  const window = { startedAt: Number.NEGATIVE_INFINITY, lines: 0 };
  const counters = { seen: 0, logged: 0, suppressed: 0 };

  function report(entry) {
    counters.seen += 1;
    const at = now();
    const parts = {
      char: field(entry.characterID),
      uuid: field(entry.uuid),
      daily: field(entry.dailyError),
      monthly: field(entry.monthlyError),
    };
    const key = `${parts.char}|${parts.uuid}|${parts.daily}|${parts.monthly}`;
    let slot = keys.get(key);
    if (slot && at - slot.lastAt < config.logIntervalMs) {
      slot.suppressed += 1;
      counters.suppressed += 1;
      return { logged: false, reason: "key-interval" };
    }
    if (at - window.startedAt >= config.logIntervalMs) {
      window.startedAt = at;
      window.lines = 0;
    }
    if (window.lines >= config.logMaxPerInterval) {
      if (slot) slot.suppressed += 1;
      counters.suppressed += 1;
      return { logged: false, reason: "global-cap" };
    }
    const suppressed = slot ? slot.suppressed : 0;
    if (slot) keys.delete(key);
    slot = { lastAt: at, suppressed: 0 };
    keys.set(key, slot);
    while (keys.size > config.logMaxKeys) keys.delete(keys.keys().next().value);
    window.lines += 1;
    counters.logged += 1;
    logFn(
      `redeem 404 char=${parts.char} uuid=${parts.uuid} daily=${parts.daily} monthly=${parts.monthly}` +
        (suppressed > 0 ? ` (+${suppressed} suppressed)` : ""),
    );
    return { logged: true };
  }

  return {
    report,
    stats: () => ({ ...counters, trackedKeys: keys.size }),
  };
}

module.exports = {
  createRedeemLog,
  field,
};
