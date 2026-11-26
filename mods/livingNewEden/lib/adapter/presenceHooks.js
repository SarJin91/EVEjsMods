"use strict";

const NAMES = Object.freeze(["attachSession", "detachSession"]);
const WRAPPED = Symbol.for("livingNewEden.presenceNudge");

function wrapPresenceNudge(runtimeExports, onNudge) {
  if (runtimeExports === null || typeof runtimeExports !== "object" || typeof onNudge !== "function") {
    return { ok: false, reason: "presence_symbol_missing" };
  }
  const proto = Object.getPrototypeOf(runtimeExports);
  if (proto === null || typeof proto !== "object") return { ok: false, reason: "presence_symbol_missing" };

  const previous = {};
  for (const name of NAMES) {
    const d = Object.getOwnPropertyDescriptor(proto, name);
    if (!d) return { ok: false, reason: "presence_symbol_missing" };
    if (d.get || d.set) return { ok: false, reason: "presence_symbol_not_writable" };
    if (typeof d.value !== "function") return { ok: false, reason: "presence_symbol_missing" };
    if (d.writable !== true || d.configurable !== true) return { ok: false, reason: "presence_symbol_not_writable" };
    const marks = proto[WRAPPED];
    if (d.value[WRAPPED] === true || (marks && marks[name] === true)) return { ok: false, reason: "already_wrapped" };
    previous[name] = d;
  }

  let active = true;
  let errors = 0;
  const wrappers = {};
  for (const name of NAMES) {
    const found = previous[name].value;
    const wrapper = {
      [name]: function livingNewEdenPresenceNudge() {
        try {
          return found.apply(this, arguments);
        } finally {
          if (active) {
            try {
              onNudge(name);
            } catch (_err) {
              errors += 1;
            }
          }
        }
      },
    }[name];
    Object.defineProperty(wrapper, WRAPPED, { value: true });
    wrappers[name] = wrapper;
  }
  const marks = Object.prototype.hasOwnProperty.call(proto, WRAPPED) && proto[WRAPPED] ? proto[WRAPPED] : {};
  for (const name of NAMES) marks[name] = true;
  Object.defineProperty(proto, WRAPPED, { value: marks, configurable: true, enumerable: false, writable: true });
  for (const name of NAMES) {
    Object.defineProperty(proto, name, { ...previous[name], value: wrappers[name] });
  }

  function unwrap() {
    if (!active) return;
    active = false;
    for (const name of NAMES) {
      if (proto[name] === wrappers[name]) {
        Object.defineProperty(proto, name, previous[name]);
        delete marks[name];
      }
    }
  }

  return { ok: true, unwrap, errors: () => errors };
}

module.exports = { NAMES, WRAPPED, wrapPresenceNudge };
