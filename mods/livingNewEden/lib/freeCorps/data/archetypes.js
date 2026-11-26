"use strict";

const row = (id, label, bands, securityRating, available) => Object.freeze({ id, label,
  bands: Object.freeze(bands), securityRating, available });

const ARCHETYPE_DATA = Object.freeze({
  miner: row("miner", "mining", ["highsec", "lowsec", "nullsec"], 2, true),
  hauler: row("hauler", "hauling", ["highsec", "lowsec"], 3, true),
  ratter: row("ratter", "ratting", ["lowsec", "nullsec"], 1, true),
  explorer: row("explorer", "exploration", ["highsec", "lowsec", "nullsec"], 1, true),
  industrialist: row("industrialist", "industry", ["highsec", "lowsec"], 3, true),
  missioner: row("missioner", "mission running", ["highsec"], 4, true),
  hunter: row("hunter", "hunting", ["lowsec", "nullsec"], -2, false),
  structure: row("structure", "structure", ["lowsec", "nullsec"], 0, false),
});

module.exports = { ARCHETYPE_DATA };
