"use strict";

const { DENY_PREFIXES, rangeEndOf } = require("./schema");
const { getEventType } = require("../scheduler/eventTypes");

const TABLES = Object.freeze(["events", "journal"]);

const reviewGuard = (key) => key.split(":").slice(0, 4).join(":");
const arrivalGuard = (key) => key.split(":").slice(0, 3).join(":");
const intelGuard = (key) => {
  const p = key.split(":");
  return `strategy:review:${p[2]}:${p[4]}`;
};

const attritionGuard = (key) => {
  const p = key.split(":");
  return `sattr:${p[2]}:${p[3]}`;
};

const situationGuard = (key) => key;

const CLASSES = Object.freeze([
  Object.freeze({ id: "retention-chain", table: "events", eventType: "RETENTION_PASS", prefix: "retention:pass:",
    pattern: /^retention:pass:\d+:\d+$/, family: "T" }),
  Object.freeze({ id: "strategy-review", table: "events", eventType: "FACTION_STRATEGY_REVIEW",
    prefix: "strategy:review:", pattern: /^strategy:review:\d+:\d+$/, family: "T" }),
  Object.freeze({ id: "events-pulse", table: "events", eventType: "SITE_REFRESH", prefix: "events:",
    pattern: /^events:(?:pulse|boot):\d+:\d+$|^events:nudge:\d+:\d+:\d+$/, family: "T" }),
  Object.freeze({ id: "salvage-pulse", table: "events", eventType: "SALVAGE_PULSE", prefix: "salvage:pulse:",
    pattern: /^salvage:pulse:\d+:\d+$/, family: "T" }),
  Object.freeze({ id: "lowsec-plan", table: "events", eventType: "LOWSEC_CAMP_PLAN", prefix: "lowsec:plan:",
    pattern: /^lowsec:plan:\d+$/, family: "T" }),
  Object.freeze({ id: "whexp-plan", table: "events", eventType: "WH_EXPEDITION_PLAN", prefix: "whexp:plan:",
    pattern: /^whexp:plan:\d+$/, family: "T" }),
  Object.freeze({ id: "capsuleer-review", table: "events", eventType: "CAPSULEER_CORP_REVIEW",
    prefix: "capsuleers:review:", pattern: /^capsuleers:review:\d+$/, family: "T" }),
  Object.freeze({ id: "psiege-scan", table: "events", eventType: "PLAYER_SIEGE_SCAN", prefix: "psiege:scan:",
    pattern: /^psiege:scan:\d+$/, family: "T" }),
  Object.freeze({ id: "season-score", table: "events", eventType: "SEASON_SCORE", prefix: "season:score:",
    pattern: /^season:score:\d+$/, family: "T" }),
  Object.freeze({ id: "extraction-pulse", table: "events", eventType: "EXTRACTION_PULSE", prefix: "extraction:pulse:",
    pattern: /^extraction:pulse:\d+:\d+$/, family: "T" }),
  Object.freeze({ id: "sentry-reconcile", table: "events", eventType: "SENTRY_RECONCILE", prefix: "sentry:reconcile:",
    pattern: /^sentry:reconcile:\d+$/, family: "T" }),
  Object.freeze({ id: "sentry-attrition", table: "events", eventType: "SENTRY_ATTRITION", prefix: "sattr:",
    pattern: /^sattr:\d+:\d+$/, family: "T" }),
  Object.freeze({ id: "sov-reconcile", table: "events", eventType: "SOV_STRUCTURE_RECONCILE", prefix: "sovr:",
    pattern: /^sovr:\d+:(?:CONTROL|HEAL|ADOPT|PRUNE):[^\s]*$/, family: "T" }),
  Object.freeze({ id: "fleet-arrival", table: "events", eventType: "FLEET_ARRIVAL", prefix: "arrival:",
    pattern: /^arrival:[^:]+:\d+$/, family: "F" }),
  Object.freeze({ id: "fleet-refit", table: "events", eventType: "FLEET_REFIT_COMPLETE", prefix: "refit:",
    pattern: /^refit:[^:]+:\d+$/, family: "F" }),
  Object.freeze({ id: "fleet-refitseek", table: "events", eventType: "FLEET_REFIT_SEEK", prefix: "refitseek:",
    pattern: /^refitseek:[^:]+:\d+:\d+$/, family: "F" }),
  Object.freeze({ id: "hraid-check", table: "events", eventType: "HRAID_CHECK", prefix: "hraid:chk:",
    pattern: /^hraid:chk:\d+:arr:[^:]+:\d+$/, family: "F" }),
  Object.freeze({ id: "contact-arrival", table: "events", eventType: "BATTLE_CONTACT_CHECK", prefix: "contact:",
    pattern: /^contact:\d+:(?:arr:[^:]+:\d+|grid:[^:]+:\d+:\d+)$/, family: "F" }),
  Object.freeze({ id: "fleet-grid-arrival", table: "events", eventType: "FLEET_GRID_ARRIVAL", prefix: "grid:",
    pattern: /^grid:[^:]+:\d+:\d+$/, family: "F" }),
  Object.freeze({ id: "fleet-grid-crossing", table: "events", eventType: "FLEET_GRID_CROSSING", prefix: "gridx:",
    pattern: /^gridx:[^:]+:\d+:\d+:(?:in|out)$/, family: "F" }),
  Object.freeze({ id: "fortress-checkpoint", table: "events", eventType: "FORTRESS_CHECKPOINT", prefix: "fortress:",
    pattern: /^fortress:\d+:x:[^:]+:\d+$/, family: "F" }),
  Object.freeze({ id: "transit-checkpoint", table: "events", eventType: "TRANSIT_CHECKPOINT", prefix: "transit:",
    pattern: /^transit:\d+:x:[^:]+:\d+$/, family: "F" }),
  Object.freeze({ id: "lpost-sighting", table: "events", eventType: "LISTENING_POST_SIGHTING", prefix: "lpost:",
    pattern: /^lpost:\d+:x:[^:]+:\d+$/, family: "F" }),
  Object.freeze({ id: "grid-defense-alert", table: "events", eventType: "GRID_DEFENSE_ALERT", prefix: "gdef:",
    pattern: /^gdef:\d+:[^:]+:\d+:\d+(?::loc)?$/, family: "F" }),
  Object.freeze({ id: "grid-defense-step", table: "events", eventType: "GRID_DEFENSE_STEP", prefix: "gdstep:",
    pattern: /^gdstep:[^:]+:\d+:\d+:(?:post|arr|loc\d+|ret\d+|sp\d+|strike)$/, family: "F" }),
  Object.freeze({ id: "mining-due", table: "events", eventType: "MINING_TRIP_STEP", prefix: "mining:due:",
    pattern: /^mining:due:[^:]+:\d+:\d+$/, family: "S" }),
  Object.freeze({ id: "mining-nudge", table: "events", eventType: "MINING_TRIP_STEP", prefix: "mining:arr:",
    pattern: /^mining:arr:[^:]+:\d+:[A-Z_]+$/, family: "F" }),
  Object.freeze({ id: "convoy-due", table: "events", eventType: "CONVOY_DELIVERY", prefix: "convoy:due:",
    pattern: /^convoy:due:[^:]+:\d+:\d+$/, family: "S" }),
  Object.freeze({ id: "convoy-nudge", table: "events", eventType: "CONVOY_DELIVERY", prefix: "convoy:arr:",
    pattern: /^convoy:arr:[^:]+:\d+:[A-Z_]+$/, family: "F" }),
  Object.freeze({ id: "prod-due", table: "events", eventType: "PRODUCTION_JOB_COMPLETE", prefix: "prod:due:",
    pattern: /^prod:due:[^:]+:\d+$/, family: "S" }),
  Object.freeze({ id: "capsuleer-trip", table: "events", eventType: "CAPSULEER_TRIP_STEP", prefix: "capsuleers:trip:",
    pattern: /^capsuleers:trip:[^:]+:\d+:\d+$|^capsuleers:trip:nudge:[^:]+:\d+:[A-Z_]+$/, family: "S" }),
  Object.freeze({ id: "siege-step", table: "events", eventType: "STATION_SIEGE_STEP", prefix: "siege:",
    pattern: /^siege:[^:]+:\d+:\d+$/, family: "S" }),
  Object.freeze({ id: "psiege-step", table: "events", eventType: "PLAYER_SIEGE_STEP", prefix: "psiege:step:",
    pattern: /^psiege:step:[^:]+:\d+:\d+$/, family: "S" }),
  Object.freeze({ id: "hraid-step", table: "events", eventType: "HRAID_STEP", prefix: "hraid:step:",
    pattern: /^hraid:step:hr:[a-z]+:\d+:\d+:\d+:\d+$/, family: "S" }),
  Object.freeze({ id: "hraid-settle", table: "events", eventType: "HRAID_SETTLE", prefix: "hraid:settle:",
    pattern: /^hraid:settle:hr:[a-z]+:\d+:\d+$/, family: "S" }),
  Object.freeze({ id: "sentry-deploy", table: "events", eventType: "SENTRY_DEPLOY", prefix: "sentry:deploy:",
    pattern: /^sentry:deploy:sf-[0-9a-f]{40}$/, family: "S" }),
  Object.freeze({ id: "build-due", table: "events", eventType: "STATION_BUILD_STEP", prefix: "build:due:",
    pattern: /^build:due:[^:]+:\d+:\d+$/, family: "S" }),
  Object.freeze({ id: "lowsec-step", table: "events", eventType: "LOWSEC_CAMP_STEP", prefix: "lowsec:step:",
    pattern: /^lowsec:step:[^:]+:\d+(?::w\d+)?$/, family: "S" }),
  Object.freeze({ id: "whexp-step", table: "events", eventType: "WH_EXPEDITION_STEP", prefix: "whexp:step:",
    pattern: /^whexp:step:[^:]+:\d+(?::w\d+)?$/, family: "S" }),
  Object.freeze({ id: "salvage-phase", table: "events", eventType: "SALVAGE_JOB_ADVANCE", prefix: "salvage:sj:",
    pattern: /^salvage:sj:wf:(?:st:[^:]+:\d+|[^:]+):due:\d+$/, family: "S" }),
  Object.freeze({ id: "battle-announce-check", table: "events", eventType: "BATTLE_ANNOUNCE_CHECK", prefix: "bann:chk:",
    pattern: /^bann:chk:[^:]+:\d+$/, family: "S" }),
  Object.freeze({ id: "journal-review-intent", table: "journal", prefix: "strategy:review:",
    pattern: /^strategy:review:\d+:\d+:(?:touch|\d+:[A-Z_]+)$/, family: "T", guard: reviewGuard }),
  Object.freeze({ id: "journal-review-intel", table: "journal", prefix: "strategy:intel:",
    pattern: /^strategy:intel:\d+:\d+:\d+$/, family: "T", guard: intelGuard }),
  Object.freeze({ id: "journal-arrival", table: "journal", prefix: "arrival:",
    pattern: /^arrival:[^:]+:\d+(?::reseek|:replan)?$/, family: "F", guard: arrivalGuard }),
  Object.freeze({ id: "journal-sentry-attrition", table: "journal", prefix: "sentry:attrition:",
    pattern: /^sentry:attrition:\d+:\d+$/, family: "T", guard: attritionGuard }),
  Object.freeze({ id: "journal-situations", table: "journal", prefix: "sit:",
    pattern: /^sit:(?:start:\d+:\d+|s[0-9a-z]+-\d+:settle)$/, family: "T", guard: situationGuard }),
  Object.freeze({ id: "journal-extraction", table: "journal", prefix: "extract:",
    pattern: /^extract:\d+:\d+(?::[^:]+(?::\d+)?)?$/, family: "T", guard: situationGuard,
    minAgeOf: (config) => {
      const x = config && config.extraction;
      return x ? Math.max(x.markerRetentionMs, x.periodMs) : 0;
    } }),
  Object.freeze({ id: "journal-extraction-fuel", table: "journal", prefix: "fuel:",
    pattern: /^fuel:[^:]+:\d+$/, family: "T", guard: situationGuard,
    minAgeOf: (config) => {
      const x = config && config.extraction;
      return x ? Math.max(x.markerRetentionMs, 2 * x.periodMs) : 0;
    } }),
  Object.freeze({ id: "journal-extraction-pic", table: "journal", prefix: "pic:",
    pattern: /^pic:[^:]+:\d+:\d+$/, family: "T", guard: situationGuard,
    minAgeOf: (config) => {
      const x = config && config.extraction;
      return x ? Math.max(x.markerRetentionMs, x.periodMs) : 0;
    } }),
  Object.freeze({ id: "journal-extraction-xfer", table: "journal", prefix: "xfer:",
    pattern: /^xfer:[^:]+:[^:]+:\d+:(?:out|in)$/, family: "T", guard: situationGuard,
    minAgeOf: (config) => {
      const x = config && config.extraction;
      return x ? Math.max(x.markerRetentionMs, x.periodMs) : 0;
    } }),
]);

function overlaps(a, b) {
  return a.startsWith(b) || b.startsWith(a);
}

function validateClasses(list) {
  if (!Array.isArray(list)) throw new TypeError("retention: classes must be an array");
  const ids = new Set();
  for (const cls of list) {
    const id = cls && cls.id;
    if (typeof id !== "string" || id === "") throw new TypeError("retention: class without id");
    if (ids.has(id)) throw new TypeError(`retention: duplicate class ${id}`);
    ids.add(id);
    if (!TABLES.includes(cls.table)) throw new TypeError(`retention: class ${id} table ${String(cls.table)}`);
    if (cls.table === "events") {
      if (!getEventType(cls.eventType)) throw new TypeError(`retention: class ${id} unknown event type ${cls.eventType}`);
      if (cls.guard !== undefined) throw new TypeError(`retention: class ${id} events class with a guard`);
    } else if (typeof cls.guard !== "function") {
      throw new TypeError(`retention: class ${id} journal class without a guard`);
    }
    if (typeof cls.prefix !== "string" || !cls.prefix.endsWith(":")) {
      throw new TypeError(`retention: class ${id} prefix must end with ":"`);
    }
    if (!(cls.prefix < rangeEndOf(cls.prefix))) throw new TypeError(`retention: class ${id} bad range end`);
    if (!(cls.pattern instanceof RegExp)) throw new TypeError(`retention: class ${id} pattern`);
    if (cls.minAgeOf !== undefined && typeof cls.minAgeOf !== "function") {
      throw new TypeError(`retention: class ${id} minAgeOf must be a function`);
    }
    for (const deny of DENY_PREFIXES) {
      if (overlaps(cls.prefix, deny)) throw new TypeError(`retention: class ${id} overlaps the deny prefix ${deny}`);
    }
  }
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      if (list[i].table === list[j].table && overlaps(list[i].prefix, list[j].prefix)) {
        throw new TypeError(`retention: classes ${list[i].id} and ${list[j].id} overlap`);
      }
    }
  }
  return list;
}

validateClasses(CLASSES);

const CLASS_IDS = Object.freeze(CLASSES.map((c) => c.id));

module.exports = { CLASSES, CLASS_IDS, validateClasses };
