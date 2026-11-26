"use strict";

const { validateLegShape, hasWormholeEdges } = require("../travel");

const NONE = Object.freeze({ via: "NONE", fromSystemId: null });

function entryOf(leg, systemId, systemIndex) {
  if (!leg || !validateLegShape(leg).ok) return NONE;
  const k = Number.isSafeInteger(systemIndex) ? systemIndex : leg.systems.indexOf(systemId);
  if (k <= 0 || k >= leg.systems.length || leg.systems[k] !== systemId) return NONE;
  const fromSystemId = leg.systems[k - 1];
  if (hasWormholeEdges(leg) && leg.wormholeEdges.some((e) => e && e.i === k - 1)) {
    return Object.freeze({ via: "WORMHOLE", fromSystemId });
  }
  return Object.freeze({ via: "GATE", fromSystemId });
}

module.exports = { entryOf };
