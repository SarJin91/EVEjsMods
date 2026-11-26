"use strict";

const isMap = (m) => m instanceof Map;

function anchoredOf(input) {
  if (!input || typeof input !== "object") return null;
  const S = input.systemId;
  const F = input.factionId;
  const neighbours = Array.isArray(input.neighbours) ? input.neighbours : [];
  const around = [S, ...neighbours];
  let unknown = false;
  if (isMap(input.controllers)) {
    for (const n of neighbours) if (input.controllers.get(n) === F) return true;
  } else unknown = true;
  if (isMap(input.stationFactions)) {
    for (const id of around) {
      const set = input.stationFactions.get(id);
      if (set && typeof set.has === "function" && set.has(F)) return true;
    }
  }
  const fh = input.footholds;
  if (fh && fh.ok === true) {
    if (fh.reach && typeof fh.reach.has === "function" && fh.reach.has(S)) return true;
  } else unknown = true;
  const belt = input.belt;
  if (belt && belt.ok === true) {
    if (belt.mode === "ready" && isMap(belt.reach)) {
      for (const id of around) if (belt.reach.get(id) === 1) return true;
    }
  } else unknown = true;
  return unknown ? null : false;
}

module.exports = { anchoredOf };
