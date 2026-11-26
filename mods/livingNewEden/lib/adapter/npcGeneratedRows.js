"use strict";

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function wrapGeneratedRows(original, build, onOutcome, { symbol, label }) {
  let result = null;
  let tried = false;
  const merged = new Map();
  const note = (outcome, detail) => {
    if (typeof onOutcome !== "function") return;
    try {
      onOutcome(outcome, detail);
    } catch (_err) {
    }
  };
  function ensure() {
    if (tried) return result;
    tried = true;
    try {
      const built = build();
      if (built && built.ok === true && isObject(built.rows)) {
        result = built;
        let rowsInjected = 0;
        for (const table of Object.keys(built.rows)) rowsInjected += built.rows[table].length;
        note("built", { rowsInjected, skipped: Array.isArray(built.skipped) ? built.skipped.length : 0 });
      } else {
        note("failed", { reason: (built && built.reason) || "BUILD_REFUSED" });
      }
    } catch (err) {
      result = null;
      note("failed", { reason: "BUILD_THREW", error: err });
    }
    return result;
  }
  const wrapped = function livingNewEdenGeneratedRows(tableName) {
    const vendor = original.apply(this, arguments);
    try {
      const built = ensure();
      const extra = built && hasOwn(built.rows, tableName) ? built.rows[tableName] : null;
      if (!Array.isArray(extra) || extra.length === 0) return vendor;
      const base = Array.isArray(vendor) ? vendor : [];
      const memo = merged.get(tableName);
      if (memo && memo.vendor === vendor) return memo.out;
      const out = Object.freeze([...base, ...extra]);
      merged.set(tableName, { vendor, out });
      return out;
    } catch (_err) {
      return vendor;
    }
  };
  Object.defineProperty(wrapped, "name", { value: label });
  for (const s of Object.getOwnPropertySymbols(original)) {
    if (s !== symbol) wrapped[s] = original[s];
  }
  wrapped[symbol] = Object.freeze({ ensure });
  return wrapped;
}

module.exports = { wrapGeneratedRows };
