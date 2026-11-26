"use strict";

function markWrapped(wrapper, original) {
  Object.defineProperty(wrapper, "__hotPathPerfCareer", { value: original });
  return wrapper;
}

function createCareerReadDispatch(profiles) {
  const list = profiles.filter(Boolean);

  function pick(table, pth) {
    for (const p of list) {
      try {
        if (p.wantsGate(table, pth)) return p;
      } catch (error) {
        p.disable("error", String(error && error.message || error));
      }
    }
    return null;
  }

  function wrapGate(original) {
    const wrapped = function hotPathPerfCareerGate(table, pth) {
      const armed = pick(table, pth);
      if (!armed) return original.apply(this, arguments);
      armed.arm();
      try {
        return original.apply(this, arguments);
      } finally {
        armed.disarm();
      }
    };
    return markWrapped(wrapped, original);
  }

  function wrapServe(original) {
    const wrapped = function hotPathPerfCareerServe(table) {
      for (const p of list) {
        if (p.armedFor(table)) return p.serve(original, this, arguments);
      }
      return original.apply(this, arguments);
    };
    return markWrapped(wrapped, original);
  }

  return { wrapGate, wrapServe, profiles: list };
}

module.exports = { createCareerReadDispatch, markWrapped };
