"use strict";

const { afterValue } = require("./maybeAsync");

// flushTableDurable falls back to flushTableSync inside the vendor when the persistence worker is off.
function flushTable(store, table) {
  return typeof store.flushTableDurable === "function" ? store.flushTableDurable(table) : store.flushTableSync(table);
}

function flushTableThen(store, table, onResult, onError) {
  let raw;
  try {
    raw = flushTable(store, table);
  } catch (err) {
    return onError(err);
  }
  return afterValue(raw, onResult, onError);
}

module.exports = { flushTable, flushTableThen };
