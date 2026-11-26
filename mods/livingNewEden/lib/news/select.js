"use strict";

const { KIND } = require("./schema");

function compareFacts(x, y) {
  if (x.weight !== y.weight) return y.weight - x.weight;
  if (x.at !== y.at) return y.at - x.at;
  if (x.factKey < y.factKey) return -1;
  return x.factKey > y.factKey ? 1 : 0;
}

function selectFacts(candidates, opts) {
  const sorted = (Array.isArray(candidates) ? candidates : []).filter((f) => f && typeof f.factKey === "string")
    .slice().sort(compareFacts);
  const perKind = new Map();
  const perSystem = new Map();
  const selected = [];
  const dropped = [];
  for (const f of sorted) {
    const destroyed = f.data && Number.isSafeInteger(f.data.destroyed) ? f.data.destroyed : 0;
    const kindCount = perKind.get(f.kind) || 0;
    const sysCount = f.systemId === null || f.systemId === undefined ? 0 : (perSystem.get(f.systemId) || 0);
    if ((f.kind === KIND.BATTLE && destroyed < opts.battleMinDestroyed) || selected.length >= opts.maxFactsPerEdition
      || kindCount >= opts.maxPerKind || sysCount >= opts.maxPerSystem) {
      dropped.push(f);
      continue;
    }
    selected.push(f);
    perKind.set(f.kind, kindCount + 1);
    if (f.systemId !== null && f.systemId !== undefined) perSystem.set(f.systemId, sysCount + 1);
  }
  return { selected, dropped };
}

module.exports = { selectFacts, compareFacts };
