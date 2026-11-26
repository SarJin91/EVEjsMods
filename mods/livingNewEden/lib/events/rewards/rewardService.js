"use strict";

const { performance } = require("node:perf_hooks");
const { createRng, deriveSeed } = require("../../util/rng");
const { REWARD_EVENT_CATALOG, REWARD_PROFILES, REWARD_FACTIONS, rewardLootIdOf } = require("../data/eventCatalog");
const { STATE: EVENT_STATE } = require("../eventMachine");
const { STATE: SITE_STATE } = require("../sites/schema");
const data = require("../salvage/data");

const COUNTER_NAMES = Object.freeze(["passes", "deferred", "readRefused", "placed", "adopted", "duplicate", "items",
  "factionItems", "skipped.CAP_DAY", "skipped.CAP_SYSTEM", "skipped.SITE_NOT_ACTIVE", "skipped.NO_REWARD_FACTION",
  "skipped.EXPIRED", "refused.SPEC_INVALID", "refused.WRECK_TYPE_NOT_FOUND", "refused.WRITE_FAILED",
  "refused.SEAM_UNAVAILABLE", "refused.SITE_NOT_ACTIVE", "refused.OTHER"]);
const METRIC_PASS_MS = "eventRewards.passMs";
const COUNTED_REFUSALS = Object.freeze(["SPEC_INVALID", "WRECK_TYPE_NOT_FOUND", "WRITE_FAILED", "SEAM_UNAVAILABLE",
  "SITE_NOT_ACTIVE"]);
const COUNTED_SKIPS = Object.freeze(["SITE_NOT_ACTIVE", "NO_REWARD_FACTION", "EXPIRED"]);

const KEY_PREFIX = "evrwd";
const ANOMALY_PREFIX = "evrwd_";
const SEED_STREAM = "evrwd";
const RANGE_END = ";";
const DAY_MS = 86400000;
const SITE_SLOT = 0;
const LAST_DEGREE = 359;
const RAD_PER_DEGREE = Math.PI / 180;
const AGGREGATE_TYPE = "event_reward";
const EVENT_PLACED = "EVENT_REWARD_PLACED";
const MAX_DETAIL = 120;
const MS_DECIMALS = 1000;

class Rollback {
  constructor(reason) {
    this.reason = String(reason || "REFUSED");
  }
}

function noop() {}

function messageOf(err) {
  return String((err && err.message) || err).slice(0, MAX_DETAIL);
}

function safeCall(fn) {
  try {
    return typeof fn === "function" ? fn() : null;
  } catch (_err) {
    return null;
  }
}

function isPositiveInt(v) {
  return Number.isSafeInteger(v) && v > 0;
}

function rewardTypesOf(catalog) {
  const out = new Map();
  for (const type of catalog) if (typeof type.reward === "string") out.set(type.eventType, type.reward);
  return out;
}

function contentFactionOf(row) {
  const c = row && row.reason && typeof row.reason === "object" ? row.reason.contentFactionId : undefined;
  return isPositiveInt(c) ? c : row.factionId;
}

function dayOf(createdAt) {
  return Math.floor(createdAt / DAY_MS);
}

function cacheKeyOf(day, systemId, eventId) {
  return `${KEY_PREFIX}:${day}:${systemId}:${eventId}`;
}

function planCache(row, site, ctx) {
  const profileKey = row ? ctx.rewardTypes.get(row.eventType) : undefined;
  if (!profileKey || !Object.prototype.hasOwnProperty.call(ctx.profiles, profileKey)) {
    return { ok: false, reason: "NOT_REWARD_TYPE" };
  }
  if (row.state !== EVENT_STATE.ACTIVE || !(row.sitesCreated > 0)) return { ok: false, reason: "NOT_ACTIVE" };
  if (!(row.expiresAt > ctx.now)) return { ok: false, reason: "EXPIRED" };
  if (!site || site.state !== SITE_STATE.ACTIVE || typeof site.siteKey !== "string") {
    return { ok: false, reason: "SITE_NOT_ACTIVE" };
  }
  const factionId = contentFactionOf(row);
  const faction = Object.prototype.hasOwnProperty.call(ctx.factions, factionId) ? ctx.factions[factionId] : null;
  if (!faction) return { ok: false, reason: "NO_REWARD_FACTION" };
  const profile = ctx.profiles[profileKey];
  const P = ctx.P;
  const day = dayOf(row.createdAt);
  const rng = createRng(deriveSeed(row.seed, SEED_STREAM));
  const angle = rng.nextInt(0, LAST_DEGREE) * RAD_PER_DEGREE;
  const spec = {
    anomalyId: `${ANOMALY_PREFIX}${row.eventId}`.trim(),
    slot: SITE_SLOT,
    siteKey: site.siteKey,
    systemId: row.systemId,
    offset: { x: Math.round(P.cacheOffsetM * Math.cos(angle)), y: 0, z: Math.round(P.cacheOffsetM * Math.sin(angle)) },
    shipTypeId: 0,
    hullGroup: profile.hullGroup,
    factionName: data.wreckFactionNameOf(factionId),
    ownerId: data.ownerCorporationOf(factionId),
    rewardLoot: {
      id: rewardLootIdOf(profileKey, factionId),
      sizeBand: profile.sizeBand,
      itemPrefixes: [...faction.itemPrefixes],
      deadspacePrefixes: [...faction.deadspacePrefixes],
      factionAmmoWeight: P.factionAmmoWeight,
      factionModuleWeight: P.factionModuleWeight,
      deadspaceModuleWeight: P.deadspaceModuleWeight,
      minEntries: P.minEntries,
      maxEntries: Math.max(P.minEntries, P.maxEntries),
    },
    lootRolls: P[profile.rollsKey],
    nowMs: ctx.now,
    expiresAtMs: row.expiresAt,
    fallbackWreckNames: data.fallbackWreckNamesOf(profile.hullGroup, factionId),
  };
  return { ok: true, key: cacheKeyOf(day, row.systemId, row.eventId), day, factionId, profile: profileKey, spec };
}

function createEventRewardService(deps) {
  const { config, store, journal } = deps;
  const P = config.eventRewards;
  const maxOpenEvents = config.events && isPositiveInt(config.events.maxOpenEvents) ? config.events.maxOpenEvents
    : undefined;
  const telemetry = deps.telemetry || null;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log: noop };
  const getEvents = typeof deps.getEvents === "function" ? deps.getEvents : () => null;
  const getSites = typeof deps.getSites === "function" ? deps.getSites : () => null;
  const getWrecks = typeof deps.getWrecks === "function" ? deps.getWrecks : () => null;
  const getGovernor = typeof deps.getGovernor === "function" ? deps.getGovernor : () => null;
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
  const rowLimit = store.limits && isPositiveInt(store.limits.maxRowsPerTransaction)
    ? store.limits.maxRowsPerTransaction : null;
  const planCtx = { profiles: REWARD_PROFILES, factions: REWARD_FACTIONS,
    rewardTypes: rewardTypesOf(REWARD_EVENT_CATALOG), P, now: 0 };
  let lastPassAt = null;
  let placedTotal = 0;
  let lastRefusal = null;
  let stopped = false;

  function bump(name, n = 1) {
    if (!telemetry || typeof telemetry.count !== "function" || !(n > 0)) return;
    try {
      telemetry.count(`eventRewards.${name}`, n);
    } catch (_err) {
    }
  }

  function observePass(ms) {
    if (!telemetry || typeof telemetry.observe !== "function") return;
    try {
      telemetry.observe(METRIC_PASS_MS, Math.max(0, Math.round(ms * MS_DECIMALS) / MS_DECIMALS));
    } catch (_err) {
    }
  }

  function admits(workClass) {
    const governor = safeCall(getGovernor);
    if (!governor || typeof governor.admits !== "function") return true;
    try {
      return governor.admits(workClass) !== false;
    } catch (_err) {
      return true;
    }
  }

  function capOf(tx, counts, picked, fromKey, cap) {
    if (cap <= 0) return { ok: true, full: true };
    const limit = rowLimit === null ? cap : Math.min(cap, rowLimit);
    if (!counts.has(fromKey)) {
      const r = journal.countKeyRange(tx, `${fromKey}:`, `${fromKey}${RANGE_END}`, limit);
      if (!r || r.ok !== true) throw new Rollback(`countKeyRange ${(r && r.reason) || "no result"}`);
      counts.set(fromKey, r.count);
    }
    const used = counts.get(fromKey) + (picked.get(fromKey) || 0);
    return { ok: true, full: used >= limit };
  }

  function readCandidates(now, skipped) {
    const events = safeCall(getEvents);
    const sites = safeCall(getSites);
    if (!events || typeof events.listOpenEvents !== "function") return { ok: false, reason: "EVENTS_UNAVAILABLE" };
    if (!sites || typeof sites.listSitesByEvent !== "function") return { ok: false, reason: "SITES_UNAVAILABLE" };
    planCtx.now = now;
    const r = store.transaction("eventRewards.read", (tx) => {
      const open = events.listOpenEvents({ limit: maxOpenEvents }, tx);
      if (!open || open.ok !== true || !Array.isArray(open.events)) {
        throw new Rollback(`listOpenEvents ${(open && open.reason) || "no result"}`);
      }
      const rows = open.events.filter((row) => row && planCtx.rewardTypes.has(row.eventType)
        && row.state === EVENT_STATE.ACTIVE && row.sitesCreated > 0)
        .sort((a, b) => (a.createdAt - b.createdAt) || (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0));
      const counts = new Map();
      const picked = new Map();
      const out = [];
      for (const row of rows) {
        if (out.length >= P.maxPlacesPerPass) break;
        const listed = sites.listSitesByEvent(row.eventId, tx);
        if (!listed || listed.ok !== true || !Array.isArray(listed.sites)) {
          throw new Rollback(`listSitesByEvent ${(listed && listed.reason) || "no result"}`);
        }
        const site = listed.sites.find((s) => s && s.slot === SITE_SLOT) || null;
        const plan = planCache(row, site, planCtx);
        if (!plan.ok) {
          if (COUNTED_SKIPS.includes(plan.reason)) skipped[plan.reason] = (skipped[plan.reason] || 0) + 1;
          continue;
        }
        const seen = journal.findByKey(tx, plan.key);
        if (!seen || seen.ok !== true) throw new Rollback(`findByKey ${(seen && seen.reason) || "no result"}`);
        if (seen.found) continue;
        const dayKey = `${KEY_PREFIX}:${plan.day}`;
        const sysKey = `${dayKey}:${row.systemId}`;
        if (capOf(tx, counts, picked, dayKey, P.maxCachesPerDay).full) {
          skipped.CAP_DAY = (skipped.CAP_DAY || 0) + 1;
          continue;
        }
        if (capOf(tx, counts, picked, sysKey, P.maxCachesPerSystemPerDay).full) {
          skipped.CAP_SYSTEM = (skipped.CAP_SYSTEM || 0) + 1;
          continue;
        }
        picked.set(dayKey, (picked.get(dayKey) || 0) + 1);
        picked.set(sysKey, (picked.get(sysKey) || 0) + 1);
        out.push({ row, plan });
      }
      return out;
    });
    if (!r.ok) {
      const detail = r.error instanceof Rollback ? r.error.reason
        : `${r.reason}${r.error ? ` ${messageOf(r.error)}` : ""}`;
      return { ok: false, reason: "READ_REFUSED", detail };
    }
    return { ok: true, candidates: r.value };
  }

  function mark(row, plan) {
    const r = store.transaction("eventRewards.mark", (tx) => {
      const applied = journal.applyOnce(tx, { key: plan.key, aggregate: { type: AGGREGATE_TYPE, id: row.eventId },
        eventType: EVENT_PLACED, payload: { eventId: row.eventId, systemId: row.systemId,
          contentFactionId: plan.factionId, profile: plan.profile } }, () => ({ ok: true }));
      if (!applied || applied.ok !== true) throw new Rollback((applied && applied.reason) || "no result");
      return applied;
    });
    if (r.ok) return { ok: true, duplicate: r.value.duplicate === true };
    return { ok: false, reason: r.error instanceof Rollback ? r.error.reason : (r.reason || "TX_FAILED") };
  }

  function placeOne(seam, row, plan, out) {
    let res;
    try {
      res = seam.place(plan.spec);
    } catch (err) {
      res = { ok: false, reason: "WRITE_FAILED", detail: messageOf(err) };
    }
    if (!res || typeof res !== "object") res = { ok: false, reason: "NO_RESULT" };
    if (isPositiveInt(res.vendorWrites) && typeof seam.flush === "function") {
      safeCall(() => seam.flush());
    }
    if (res.ok !== true) {
      const reason = COUNTED_REFUSALS.includes(res.reason) ? res.reason : "OTHER";
      bump(`refused.${reason}`);
      out.refused[reason] = (out.refused[reason] || 0) + 1;
      lastRefusal = String(res.reason || "OTHER");
      logger.log(`eventRewards: place of event=${row.eventId} refused - ${res.reason}`
        + `${res.detail ? ` (${res.detail})` : ""}`);
      return res.reason === "SEAM_UNAVAILABLE" ? "stop" : "next";
    }
    const adopted = res.adopted === true;
    if (!adopted) {
      bump("items", res.items);
      bump("factionItems", res.factionItems);
    }
    const marked = mark(row, plan);
    if (!marked.ok) {
      lastRefusal = `MARK_${marked.reason}`;
      logger.log(`eventRewards: cache of event=${row.eventId} placed, mark failed - ${marked.reason}`);
      return "next";
    }
    if (marked.duplicate) {
      bump("duplicate");
      return "next";
    }
    placedTotal += 1;
    if (adopted) {
      bump("adopted");
      out.adopted += 1;
    } else {
      bump("placed");
      out.placed += 1;
    }
    logger.log(`eventRewards: cache event=${row.eventId} sys=${row.systemId} faction=${plan.factionId} `
      + `profile=${plan.profile} wreck=${res.wreckId} items=${res.items} `
      + `factionItems=${adopted ? "n/a" : res.factionItems} adopted=${adopted}`);
    return "next";
  }

  function runPass(now) {
    const startedAt = nowMs();
    const out = { ok: true, placed: 0, adopted: 0, skipped: {}, refused: {}, deferred: false };
    try {
      if (stopped) return { ok: false, reason: "EVENT_REWARDS_STOPPED" };
      if (!isPositiveInt(now)) return { ok: false, reason: "EVENT_REWARDS_NOW_INVALID" };
      bump("passes");
      lastPassAt = now;
      if (!admits("OPERATIONAL")) {
        bump("deferred");
        out.deferred = true;
        return out;
      }
      const read = readCandidates(now, out.skipped);
      if (!read.ok) {
        bump("readRefused");
        lastRefusal = read.detail ? `${read.reason}: ${read.detail}` : read.reason;
        return { ok: false, reason: read.reason, ...(read.detail ? { detail: read.detail } : {}) };
      }
      for (const [reason, n] of Object.entries(out.skipped)) bump(`skipped.${reason}`, n);
      if (read.candidates.length === 0) return out;
      const seam = safeCall(getWrecks);
      if (!seam || seam.ok !== true || typeof seam.place !== "function") {
        bump("refused.SEAM_UNAVAILABLE");
        out.refused.SEAM_UNAVAILABLE = 1;
        lastRefusal = "SEAM_UNAVAILABLE";
        return out;
      }
      for (const { row, plan } of read.candidates) {
        if (placeOne(seam, row, plan, out) === "stop") break;
      }
      return out;
    } catch (err) {
      logger.log(`eventRewards: pass failed - ${messageOf(err)}`);
      lastRefusal = "EVENT_REWARDS_PASS_FAILED";
      return { ok: false, reason: "EVENT_REWARDS_PASS_FAILED", detail: messageOf(err) };
    } finally {
      observePass(nowMs() - startedAt);
    }
  }

  function getStatus() {
    return Object.freeze({ state: stopped ? "unavailable" : "running", lastPassAt, placedTotal, lastRefusal });
  }

  function stop() {
    stopped = true;
  }

  return Object.freeze({ runPass, getStatus, stop });
}

module.exports = { createEventRewardService, planCache, rewardTypesOf, cacheKeyOf, COUNTER_NAMES, METRIC_PASS_MS,
  ANOMALY_PREFIX, Rollback };
