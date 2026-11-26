"use strict";

const WAL_HEADER_BYTES = 32;
const FRAME_HEADER_BYTES = 24;

function createWalMeter(deps) {
  if (!deps || typeof deps.statBytes !== "function") throw new TypeError("statBytes");
  if (!Number.isSafeInteger(deps.pageSize) || deps.pageSize < 1) throw new RangeError("pageSize");
  const statBytes = deps.statBytes;
  const frameBytes = deps.pageSize + FRAME_HEADER_BYTES;
  const framesOf = (size) => (size <= WAL_HEADER_BYTES ? 0 : Math.floor((size - WAL_HEADER_BYTES) / frameBytes));
  let calibrated = false;
  let resetPending = false;
  let last = null;
  let statFailed = 0;
  let unexpectedResets = 0;

  function afterTx() {
    let size;
    try {
      size = statBytes();
    } catch (_err) {
      size = null;
    }
    if (typeof size !== "number" || !Number.isFinite(size) || size < 0) {
      statFailed += 1;
      return null;
    }
    const now = framesOf(size);
    if (!calibrated) {
      last = now;
      return null;
    }
    let delta;
    if (resetPending) {
      if (now !== last) {
        delta = now;
        resetPending = false;
      } else {
        delta = 0;
      }
    } else {
      delta = now - last;
      if (delta < 0) {
        delta = now;
        unexpectedResets += 1;
      }
    }
    last = now;
    return delta;
  }

  function onCheckpoint(complete) {
    if (complete !== true) return;
    resetPending = true;
    calibrated = true;
  }

  function status() {
    return { calibrated, frameBytes, statFailed, unexpectedResets };
  }

  return { afterTx, onCheckpoint, status };
}

module.exports = { createWalMeter, WAL_HEADER_BYTES, FRAME_HEADER_BYTES };
