"use strict";

const LAYER = Object.freeze({ HEAVY: "heavy", POWER: "power", WORLD: "world", INCURSION: "incursion" });
const LAYERS = Object.freeze(Object.values(LAYER));
const PREFIX_OF = Object.freeze({ [LAYER.HEAVY]: "hev", [LAYER.POWER]: "hpw", [LAYER.WORLD]: "hwa",
  [LAYER.INCURSION]: "hin" });
const LAYER_OF_PREFIX = Object.freeze(Object.fromEntries(LAYERS.map((l) => [PREFIX_OF[l], l])));

function layerOfEventId(eventId) {
  if (typeof eventId !== "string") return null;
  const at = eventId.indexOf(":");
  if (at <= 0) return null;
  const prefix = eventId.slice(0, at);
  return Object.prototype.hasOwnProperty.call(LAYER_OF_PREFIX, prefix) ? LAYER_OF_PREFIX[prefix] : null;
}

function layerOfRow(row) {
  return layerOfEventId(row && row.eventId);
}

function layerIdRange(layer) {
  if (!Object.prototype.hasOwnProperty.call(PREFIX_OF, layer)) return null;
  return { from: `${PREFIX_OF[layer]}:`, to: `${PREFIX_OF[layer]};` };
}

module.exports = { LAYER, LAYERS, PREFIX_OF, layerOfEventId, layerOfRow, layerIdRange };
