"use strict";

function createWeaponRegistry(input) {
  const handlers = Object.freeze([...(Array.isArray(input && input.handlers) ? input.handlers : [])]);
  const isEnabled = typeof (input && input.isEnabled) === "function" ? input.isEnabled : () => false;
  const classify = typeof (input && input.classify) === "function" ? input.classify : () => null;

  function safe(fn) {
    try {
      return fn() === true;
    } catch (_err) {
      return false;
    }
  }

  function enabled(handler) {
    return safe(() => isEnabled(handler));
  }

  function matches(handler, module, charge, family) {
    return safe(() => handler.match(module, charge, family));
  }

  function handlerFor(module, charge, family) {
    for (const handler of handlers) {
      if (enabled(handler) && matches(handler, module, charge, family)) return handler;
    }
    return null;
  }

  function unsupportedId(module, charge, family) {
    if (handlerFor(module, charge, family)) return null;
    for (const handler of handlers) {
      if (matches(handler, module, charge, family)) return handler.id;
    }
    try {
      const id = classify(module, charge, family);
      return typeof id === "string" && id ? id : null;
    } catch (_err) {
      return null;
    }
  }

  function kinds() {
    return handlers.filter(enabled).map((handler) => handler.id);
  }

  return Object.freeze({ handlerFor, unsupportedId, kinds });
}

module.exports = { createWeaponRegistry };
