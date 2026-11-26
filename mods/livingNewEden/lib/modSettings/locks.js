"use strict";

const { isSecretRow } = require("../observer/effectiveConfig");
const { LOCK, LNE_LOCKS, SHIP_WING_LOCKS, staticLockOf } = require("./lockSpec");

const UNLOCKED = Object.freeze({ locked: false });

function lockOf(reason) {
  return Object.freeze({ locked: true, reason });
}

function createLocks(spec) {
  const isSecret = (row) => Boolean(row) && (isSecretRow(row) || staticLockOf(spec, row) === LOCK.SECRET);
  function locked(row) {
    if (!row || typeof row.key !== "string") return UNLOCKED;
    if (isSecret(row)) return lockOf(LOCK.SECRET);
    const reason = staticLockOf(spec, row);
    return reason ? lockOf(reason) : UNLOCKED;
  }
  return Object.freeze({ isSecret, locked });
}

module.exports = { LOCK, LNE_LOCKS, SHIP_WING_LOCKS, createLocks };
