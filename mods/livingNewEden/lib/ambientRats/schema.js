"use strict";

const OPERATOR_KIND = "lneAmbient";
const SELECTION_PREFIX = "lne_ambient";
const WORK_CLASS = "OPERATIONAL";

const BANDS = Object.freeze(["highsec", "lowsec", "nullsec"]);
const KINDS = Object.freeze(["pirate", "empire", "hive"]);
const ANCHOR_KINDS = Object.freeze(["stargate", "station", "planet", "moon"]);
const SCOPES = Object.freeze(["controlled", "captured"]);

const REFUSAL = Object.freeze(["BAND_INELIGIBLE", "BAND_OFF", "NO_CONTROLLER", "KIND_OFF", "NOT_CAPTURED", "NO_SOURCE",
  "NO_GROUPS", "SCENE_NOT_LOADED", "SEAM_UNAVAILABLE", "READ_FAILED", "HIGHSEC_PIRATE", "CONCORD_AGGRO_NPC"]);
const DEFERRAL = Object.freeze(["GOVERNOR", "SPAWN_INTERVAL", "COOLDOWN", "SYSTEM_FULL", "GLOBAL_FULL", "NO_ANCHOR",
  "NO_PLAYER_IN_SPACE"]);
const FAILURES = Object.freeze(["spawn", "despawn", "order", "read", "paint", "aggro"]);

const COUNTER_NAMES = Object.freeze(["passes", "spawned", "ships", "wiped", "expired", "stale", "left", "orphans",
  "orders", "attacks", "repainted", "armed", "disarmed", "gatePicketsSpawned",
  ...FAILURES.map((name) => `failed.${name}`),
  ...REFUSAL.map((reason) => `refused.${reason}`),
  ...DEFERRAL.map((reason) => `deferred.${reason}`)]);

const NAVY_TEMPLATE_FACTION_KEY = "guristas";
const EXCLUDED_SOURCE_FACTION_IDS = Object.freeze([500021]);
const GROUPS_KEY_BY_BAND = Object.freeze({ highsec: "groupsHighsec", lowsec: "groupsLowsec", nullsec: "groupsNullsec" });
const HIGHSEC_EXCLUDED_FACTION_IDS = Object.freeze([500006]);
const HIGHSEC_FORBIDDEN_KINDS = Object.freeze(["pirate", "hive"]);

function parseClosedList(text, allowed) {
  if (typeof text !== "string" || !Array.isArray(allowed)) return null;
  const out = [];
  for (const raw of text.split(",")) {
    const token = raw.trim();
    if (token === "" || !allowed.includes(token) || out.includes(token)) return null;
    out.push(token);
  }
  return out;
}

const parseBands = (text) => parseClosedList(text, BANDS);
const parseFactionKinds = (text) => parseClosedList(text, KINDS);
const parseAnchorKinds = (text) => parseClosedList(text, ANCHOR_KINDS);
const isScope = (text) => SCOPES.includes(text);

module.exports = { OPERATOR_KIND, SELECTION_PREFIX, WORK_CLASS, BANDS, KINDS, ANCHOR_KINDS, SCOPES, REFUSAL, DEFERRAL,
  FAILURES, COUNTER_NAMES, NAVY_TEMPLATE_FACTION_KEY, EXCLUDED_SOURCE_FACTION_IDS, GROUPS_KEY_BY_BAND,
  HIGHSEC_EXCLUDED_FACTION_IDS, HIGHSEC_FORBIDDEN_KINDS, parseClosedList,
  parseBands, parseFactionKinds, parseAnchorKinds, isScope };
