"use strict";

const { FACTION_KINDS } = require("../playerHunt/schema");

const MODES = Object.freeze(["PATROL", "GATE_CAMP"]);
const PATROL_OBJECT_KINDS = Object.freeze(["sun", "stargate", "station", "asteroidBelt", "planet"]);
const CAMP_GATE_POLICIES = Object.freeze(["border", "arrival", "random"]);
const END_UNOBSERVED = "UNOBSERVED";
const CAMP_PERMILLE_MIN = 0;
const CAMP_PERMILLE_MAX = 1000;
const DEFENSE_WORK_CLASSES = Object.freeze(["LIVE", "OPERATIONAL"]);
const DEFENSE_TRIGGERS = Object.freeze(["hostile", "any"]);
const TRIGGER_ARRIVAL = "arrival";
const TRIGGER_EXIT = "exit";
const TRIGGER_LNE = "lne";
const TRIGGER_REINFORCE = "reinforce";
const LNE_TARGET_SOURCES = Object.freeze(["hunt", "patrol", "exposure"]);
const LNE_SOURCES_NONE = "none";

function splitList(text) {
  if (typeof text !== "string") return null;
  const parts = text.split(",").map((p) => p.trim());
  return parts.some((p) => p === "") ? null : parts;
}

function parsePatrolObjectKinds(text) {
  const parts = splitList(text);
  if (parts === null) return null;
  if (!parts.every((p) => PATROL_OBJECT_KINDS.includes(p)) || new Set(parts).size !== parts.length) return null;
  return Object.freeze(parts);
}

function parseCampPermille(text) {
  const parts = splitList(text);
  if (parts === null) return null;
  const out = {};
  for (const part of parts) {
    const [kind, value, extra] = part.split(":").map((p) => p.trim());
    if (extra !== undefined || !FACTION_KINDS.includes(kind) || !/^[0-9]+$/.test(value || "")) return null;
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < CAMP_PERMILLE_MIN || n > CAMP_PERMILLE_MAX) return null;
    if (Object.prototype.hasOwnProperty.call(out, kind)) return null;
    out[kind] = n;
  }
  return Object.freeze(out);
}

function parseKindList(text) {
  const parts = splitList(text);
  if (parts === null) return null;
  if (!parts.every((p) => FACTION_KINDS.includes(p)) || new Set(parts).size !== parts.length) return null;
  return Object.freeze(parts);
}

function parseLneTargetSources(text) {
  if (typeof text === "string" && text.trim() === LNE_SOURCES_NONE) return Object.freeze([]);
  const parts = splitList(text);
  if (parts === null) return null;
  if (!parts.every((p) => LNE_TARGET_SOURCES.includes(p)) || new Set(parts).size !== parts.length) return null;
  return Object.freeze(parts);
}

function isDefenseWorkClass(text) {
  return typeof text === "string" && DEFENSE_WORK_CLASSES.includes(text);
}

function isDefenseTrigger(text) {
  return typeof text === "string" && DEFENSE_TRIGGERS.includes(text);
}

function isCampGatePolicy(text) {
  return typeof text === "string" && CAMP_GATE_POLICIES.includes(text);
}

module.exports = {
  MODES,
  PATROL_OBJECT_KINDS,
  CAMP_GATE_POLICIES,
  END_UNOBSERVED,
  CAMP_PERMILLE_MIN,
  CAMP_PERMILLE_MAX,
  DEFENSE_WORK_CLASSES,
  DEFENSE_TRIGGERS,
  TRIGGER_ARRIVAL,
  TRIGGER_EXIT,
  TRIGGER_LNE,
  TRIGGER_REINFORCE,
  LNE_TARGET_SOURCES,
  parsePatrolObjectKinds,
  parseLneTargetSources,
  parseCampPermille,
  parseKindList,
  isDefenseWorkClass,
  isDefenseTrigger,
  isCampGatePolicy,
};
