"use strict";

const { validateLegShape, hasWormholeEdges } = require("./travel");

function crossingOf(fleet, systemId) {
  if (!fleet || fleet.state !== "TRAVELLING" || !validateLegShape(fleet.route).ok) return null;
  const leg = fleet.route;
  if (hasWormholeEdges(leg)) return null;
  const i = leg.systems.indexOf(systemId);
  if (i <= 0 || i >= leg.systems.length - 1) return null;
  return { i, from: leg.departAt + i * leg.jumpMs, jumpMs: leg.jumpMs, leg };
}

function gateLegOf(fleet) {
  if (!fleet || fleet.state !== "TRAVELLING" || !validateLegShape(fleet.route).ok
    || hasWormholeEdges(fleet.route)) return null;
  return fleet.route;
}

module.exports = { crossingOf, gateLegOf };
