"use strict";

const { createSovNativeReader } = require("../../lib/adapter/sovNative");

function createFakeAdapter({ sovNative = null, requireGame = null } = {}) {
  const defaultRequireGame = (modulePath) => {
    if (modulePath === "services/sovereignty/sovState") {
      return { ok: true, exports: sovNative };
    }
    if (modulePath === "services/sovereignty/sovStore") {
      return { ok: true, exports: { readSovereigntyTableUpdatedAt: () => new Date().toISOString() } };
    }
    return { ok: false, reason: "MODULE_NOT_FOUND", module: modulePath };
  };

  return Object.freeze({
    getProcessRole: () => "world",
    getSovNative: () => createSovNativeReader({ requireGame: requireGame || defaultRequireGame }),
    getSovProjection: () => ({ projectSovCall: async () => ({ ok: true }), readSovState: () => ({}) }),
    requireGame: requireGame || defaultRequireGame,
  });
}

module.exports = { createFakeAdapter };