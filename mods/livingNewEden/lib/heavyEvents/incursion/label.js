"use strict";

const W = require("../world/schema");

const WORD = "Incursion:";

function incursionLabelOf(factionName, kind) {
  const words = Object.prototype.hasOwnProperty.call(W.LABEL_WORDS, kind) ? W.LABEL_WORDS[kind] : "";
  const tail = [WORD, words].filter((s) => s !== "").join(" ");
  const faction = typeof factionName === "string" ? factionName.trim() : "";
  const full = [faction, tail].filter((s) => s !== "").join(" ");
  if (full.length <= W.LABEL_MAX) return full;
  const room = W.LABEL_MAX - tail.length - 1;
  return room > 0 ? `${faction.slice(0, room).trim()} ${tail}`.trim() : tail.slice(0, W.LABEL_MAX);
}

module.exports = { incursionLabelOf };
