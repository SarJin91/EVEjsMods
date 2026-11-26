"use strict";

const { WAR_KINDS, MAX_FACT_KEY, MAX_NAME_CHARS, DATA_VERSION } = require("../schema");
const { weightOf } = require("../data/kinds");

const PERSONAL_KIND = "PLAYER_IMPACT";
const WAR_KEY_PREFIX = "w:";

function nameOf(v) {
  return typeof v === "string" && v.trim() !== "" ? v.replace(/\s+/g, " ").trim().slice(0, MAX_NAME_CHARS) : null;
}

function add(skipped, reason) {
  skipped[reason] = (skipped[reason] || 0) + 1;
}

function factsOfWarViews(views, opts) {
  const kinds = new Set(opts && Array.isArray(opts.kinds) ? opts.kinds : []);
  const facts = [];
  const skipped = {};
  for (const v of Array.isArray(views) ? views : []) {
    try {
      if (!v || typeof v !== "object") {
        add(skipped, "BAD_VIEW");
        continue;
      }
      if (v.kind === PERSONAL_KIND) {
        add(skipped, "PERSONAL");
        continue;
      }
      if (!WAR_KINDS.includes(v.kind)) {
        add(skipped, "UNKNOWN_KIND");
        continue;
      }
      if (!kinds.has(v.kind)) {
        add(skipped, "KIND_OFF");
        continue;
      }
      const factKey = `${WAR_KEY_PREFIX}${String(v.eventKey || "")}`;
      if (typeof v.eventKey !== "string" || v.eventKey === "" || factKey.length > MAX_FACT_KEY
        || !Number.isSafeInteger(v.at) || v.at < 0) {
        add(skipped, "BAD_VIEW");
        continue;
      }
      const data = { v: DATA_VERSION, systemName: nameOf(v.systemName), regionName: nameOf(v.regionName),
        factionA: nameOf(v.attackerName), factionB: nameOf(v.defenderName),
        outcome: typeof v.outcome === "string" ? v.outcome.slice(0, 32) : null };
      facts.push({ factKey, kind: v.kind, at: v.at, systemId: Number.isSafeInteger(v.systemId) ? v.systemId : null,
        weight: weightOf(v.kind, data), data });
    } catch (_err) {
      add(skipped, "BAD_VIEW");
    }
  }
  return { facts, skipped };
}

module.exports = { factsOfWarViews, WAR_KEY_PREFIX, PERSONAL_KIND };
