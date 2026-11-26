"use strict";

function nonZero(target, counters, prefix = "") {
  if (!counters || typeof counters !== "object") return;
  for (const [name, value] of Object.entries(counters)) {
    if (typeof value === "number" && Number.isFinite(value) && value !== 0) target.set(`${prefix}${name}`, value);
  }
}

function show(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function formatTelemetry(parts) {
  const p = parts || {};
  const wing = p.wing || {};
  const head = [`records=${Number(wing.records) || 0}`, `live=${Number(wing.live) || 0}`];
  if (wing.storeReadOnly === true) head.push("storeReadOnly=1");
  const all = new Map();
  nonZero(all, wing.counters);
  nonZero(all, p.guards);
  nonZero(all, p.store && p.store.counters);
  if (p.driver) nonZero(all, { errors: p.driver.errors }, "driver.");
  nonZero(all, p.client && p.client.counters, "client.");
  nonZero(all, p.delivery && p.delivery.counters, "client.delivery.");
  nonZero(all, p.mining && p.mining.counters);
  nonZero(all, p.salvage && p.salvage.counters);
  nonZero(all, p.combat && p.combat.counters);
  nonZero(all, p.mirror && p.mirror.counters);
  nonZero(all, p.safeLogoff && p.safeLogoff.counters);
  nonZero(all, p.npcAggro && p.npcAggro.counters);
  nonZero(all, p.board && p.board.counters);
  nonZero(all, p.start);
  const tail = [...all.keys()].sort().map((name) => `${name}=${show(all.get(name))}`);
  return `telemetry ${[...head, ...tail].join(" ")}`;
}

module.exports = { formatTelemetry };
