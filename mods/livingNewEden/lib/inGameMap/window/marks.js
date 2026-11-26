"use strict";

const MARK_KINDS = Object.freeze([
  Object.freeze({ kind: 1, name: "FLEET", layer: "layer-fleets", paths: true, count: "items", label: "fleets",
    rgb: Object.freeze([0xff, 0xb0, 0x00]) }),
  Object.freeze({ kind: 2, name: "BATTLE", layer: "layer-battles-open", paths: false, count: "lines", label: "battle",
    rgb: Object.freeze([0xff, 0x40, 0x40]) }),
  Object.freeze({ kind: 3, name: "EVENT", layer: "layer-events", paths: false, count: "lines", label: "event",
    rgb: Object.freeze([0x40, 0xc0, 0xff]) }),
  Object.freeze({ kind: 4, name: "INVASION", layer: "layer-invasions", paths: false, count: "one", label: "invasion",
    rgb: Object.freeze([0xc0, 0x40, 0xff]) }),
  Object.freeze({ kind: 5, name: "SITUATION", layer: "layer-situations", paths: false, count: "lines",
    label: "distress", rgb: Object.freeze([0xff, 0xd7, 0x5e]) }),
]);
const RESERVED_KINDS = Object.freeze([6]);
const CORP_MARK = Object.freeze({ kind: 6, name: "SIGHTING", label: "sighting",
  rgb: Object.freeze([0x60, 0xff, 0x90]) });
const LAYER_IDS = Object.freeze(MARK_KINDS.map((k) => k.layer));

function pathSystem(item) {
  const systems = Array.isArray(item && item[0]) ? item[0] : [];
  if (systems.length === 0) return null;
  const progress = Number(item[2]);
  const p = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0;
  return systems[Math.min(systems.length - 1, Math.floor(p * (systems.length - 1)))];
}

function weightOf(def, item) {
  if (def.count !== "lines") return 1;
  return Math.max(1, Array.isArray(item[3]) ? item[3].length : 0);
}

function marksOf(layers, idIndexOf) {
  const out = new Map();
  for (const def of MARK_KINDS) {
    const data = layers ? layers[def.layer] : null;
    const items = data && Array.isArray(data.items) ? data.items : [];
    for (const item of items) {
      if (!Array.isArray(item)) continue;
      const systemId = def.paths ? pathSystem(item) : item[0];
      const idx = Number.isSafeInteger(systemId) ? idIndexOf(systemId) : -1;
      if (!Number.isSafeInteger(idx) || idx < 0) continue;
      const key = `${def.kind}:${idx}`;
      out.set(key, (out.get(key) || 0) + weightOf(def, item));
    }
  }
  return out;
}

module.exports = { MARK_KINDS, RESERVED_KINDS, CORP_MARK, LAYER_IDS, pathSystem, marksOf };
