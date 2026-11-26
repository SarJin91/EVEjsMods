"use strict";

const { performance } = require("node:perf_hooks");
const { GANK_METRICS, GANK_COUNTER_NAMES } = require("../schema");
const { ROLL, bucketOf, planGank, hullsOf } = require("./plan");
const { GANKER, VICTIM_HULL_GROUPS } = require("./data");

const WORK_CLASS = "OPERATIONAL";
const HOME_BAND = "highsec";
const RETRY_STAGE = "tx";
const MS_DECIMALS = 10;
const MAX_DETAIL = 160;

function messageOf(err) {
  return String((err && err.message) || err).slice(0, MAX_DETAIL);
}

function createGank(deps) {
  const G = deps && deps.settings;
  if (!G || typeof G !== "object" || !Array.isArray(G.systemIds)) {
    return { ok: false, reason: "MISSING_DEPS", detail: "settings" };
  }
  for (const k of ["describeSystem", "empireFactionOf", "getWrecks", "onRumour"]) {
    if (typeof deps[k] !== "function") return { ok: false, reason: "MISSING_DEPS", detail: k };
  }
  const worldSeed = Number.isSafeInteger(deps.worldSeed) ? deps.worldSeed : 0;
  const curve = Array.isArray(deps.hourCurvePermille) ? deps.hourCurvePermille : null;
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
  const telemetry = deps.telemetry || null;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : null;

  const counters = Object.fromEntries(GANK_COUNTER_NAMES.map((name) => [name, 0]));
  const handled = new Map();
  const logged = new Set();
  let loggedBucket = null;
  let stopped = false;
  let lastPass = null;

  function log(line) {
    if (!logger) return;
    try {
      logger.log(`highsecLife: gank ${line}`);
    } catch (_err) {
    }
  }

  function metric(kind, name, value) {
    if (!telemetry || typeof telemetry[kind] !== "function") return;
    try {
      telemetry[kind](name, value);
    } catch (_err) {
    }
  }

  function bump(name) {
    if (Object.prototype.hasOwnProperty.call(counters, name)) counters[name] += 1;
  }

  function soft(fn, arg) {
    try {
      return fn(arg) || null;
    } catch (_err) {
      return null;
    }
  }

  function governorAdmits() {
    try {
      const g = typeof deps.getGovernor === "function" ? deps.getGovernor() : null;
      return !g || typeof g.admits !== "function" || g.admits(WORK_CLASS) !== false;
    } catch (_err) {
      return true;
    }
  }

  function failOnce(systemId, bucket, detail) {
    bump("failed");
    if (loggedBucket !== bucket) {
      logged.clear();
      loggedBucket = bucket;
    }
    if (logged.has(systemId)) return;
    logged.add(systemId);
    log(`field in ${systemId} (bucket ${bucket}) failed - ${String(detail || "NO_RESULT").slice(0, MAX_DETAIL)}`);
  }

  function rumour(event) {
    try {
      if (deps.onRumour(event) === true) bump("rumoursAdded");
    } catch (_err) {
    }
  }

  function step(systemId, bucket, now, budget) {
    if (handled.get(systemId) === bucket) return "next";
    const desc = soft(deps.describeSystem, systemId);
    if (!desc || desc.secClass !== HOME_BAND) {
      bump("notHighsec");
      handled.set(systemId, bucket);
      return "next";
    }
    const plan = planGank(systemId, bucket, worldSeed, curve, G);
    if (plan.roll === ROLL.QUIET) {
      bump("quiet");
      handled.set(systemId, bucket);
      return "next";
    }
    if (now < plan.at) return "next";
    if (plan.at + G.fieldTtlMs <= now) {
      bump("tooLate");
      handled.set(systemId, bucket);
      return "next";
    }
    if (budget.created >= G.maxPerPass) return "stop";
    if (!governorAdmits()) {
      bump("deferred.GOVERNOR");
      return "stop";
    }
    const faction = soft(deps.empireFactionOf, systemId);
    if (!faction || faction.ok !== true || !Number.isSafeInteger(faction.factionId) || faction.factionId <= 0) {
      bump("noFaction");
      handled.set(systemId, bucket);
      return "next";
    }
    const wrecks = soft(deps.getWrecks);
    if (!wrecks || typeof wrecks.placeGankField !== "function") {
      bump("refused.WRECKS");
      handled.set(systemId, bucket);
      return "next";
    }
    const hulls = hullsOf(faction.factionId);
    const shipsLost = 1 + plan.gankers;
    let r;
    try {
      r = wrecks.placeGankField({ systemId, bucket, at: plan.at, factionId: faction.factionId,
        victim: { hullGroup: VICTIM_HULL_GROUPS[plan.victimKind], typeId: hulls[plan.victimKind] },
        gankers: { hullGroup: GANKER.hullGroup, typeId: GANKER.typeId, count: plan.gankers }, ttlMs: G.fieldTtlMs });
    } catch (err) {
      failOnce(systemId, bucket, `THREW: ${messageOf(err)}`);
      return "next";
    }
    if (!r || r.ok !== true) {
      failOnce(systemId, bucket, r && `${r.reason}${r.stage ? `@${r.stage}` : ""}`);
      if (!(r && r.stage === RETRY_STAGE)) handled.set(systemId, bucket);
      return "next";
    }
    handled.set(systemId, bucket);
    if (r.duplicate === true) {
      bump("duplicate");
    } else {
      bump("created");
      budget.created += 1;
      metric("count", GANK_METRICS.fields, 1);
    }
    rumour({ systemId, bucket, at: plan.at, shipsLost });
    return "next";
  }

  function runPass(now) {
    if (stopped) return { ok: false, reason: "STOPPED" };
    const t0 = nowMs();
    const budget = { created: 0 };
    bump("passes");
    try {
      const bucket = bucketOf(now, G.bucketMs);
      for (const systemId of G.systemIds) {
        if (step(systemId, bucket, now, budget) === "stop") break;
      }
      lastPass = { at: now, bucket, created: budget.created };
    } catch (err) {
      bump("failed");
      log(`pass failed - ${messageOf(err)}`);
    }
    metric("observe", GANK_METRICS.passMs, Math.round((nowMs() - t0) * MS_DECIMALS) / MS_DECIMALS);
    return { ok: true, created: budget.created };
  }

  return { ok: true, gank: Object.freeze({
    runPass,
    getStatus: () => Object.freeze({ systems: G.systemIds.length, handled: handled.size, lastPass,
      counters: Object.freeze({ ...counters }) }),
    stop: () => {
      stopped = true;
    },
  }) };
}

module.exports = { createGank };
