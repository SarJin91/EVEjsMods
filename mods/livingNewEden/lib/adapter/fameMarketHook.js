"use strict";

const WRAPPED = Symbol.for("evejs.lne.fameMarket.v1");
const METHOD = "getMarketContext";

let installed = false;
let slot = null;
let calls = 0;
let modified = 0;
let failOpen = 0;
let refused = null;

function makeWrapper(original) {
  const wrapper = function livingNewEdenFameMarket(...args) {
    const out = original.apply(this, args);
    const fn = slot;
    if (!fn) return out;
    calls += 1;
    try {
      const next = fn(out);
      if (!next || typeof next !== "object") return out;
      if (next !== out) modified += 1;
      return next;
    } catch (_err) {
      failOpen += 1;
      return out;
    }
  };
  Object.defineProperty(wrapper, "name", { value: `livingNewEden_${METHOD}` });
  for (const s of Object.getOwnPropertySymbols(original)) {
    if (s !== WRAPPED) wrapper[s] = original[s];
  }
  wrapper[WRAPPED] = true;
  return wrapper;
}

function install(marketRulesExports) {
  const e = marketRulesExports;
  if (!e || (typeof e !== "object" && typeof e !== "function")
    || !Object.prototype.hasOwnProperty.call(e, METHOD) || typeof e[METHOD] !== "function") {
    refused = "PRIMARY_MISSING";
    return { ok: false, reason: "PRIMARY_MISSING" };
  }
  if (e[METHOD][WRAPPED] === true) {
    installed = true;
    refused = null;
    return { ok: true, installed: true, alreadyInstalled: true };
  }
  const desc = Object.getOwnPropertyDescriptor(e, METHOD);
  if (Object.isFrozen(e) || !desc || (desc.writable !== true && typeof desc.set !== "function")) {
    refused = "SEAM_NOT_WRITABLE";
    return { ok: false, reason: "SEAM_NOT_WRITABLE" };
  }
  e[METHOD] = makeWrapper(e[METHOD]);
  installed = true;
  refused = null;
  return { ok: true, installed: true };
}

function setSlot(fn) {
  if (fn !== null && typeof fn !== "function") return { ok: false, reason: "SLOT_INVALID" };
  slot = fn;
  return { ok: true };
}

function getStatus() {
  const state = installed ? "installed" : refused ? `refused:${refused}` : "not_loaded";
  return { installed, slot: slot !== null, calls, modified, failOpen, state };
}

module.exports = { install, setSlot, getStatus, WRAPPED, METHOD };
