"use strict";

const { performance } = require("node:perf_hooks");
const { deriveSeed } = require("../../util/rng");
const { effectivePool } = require("../../world/wreckPool");
const { WRECK_ACTIVE } = require("../../world/wreckSchema");
const { STATE: SITE_STATE } = require("../sites/schema");
const defaultRepository = require("./anomalyRepository");
const { planAnomaly, validateField, wrecksOfRows, placeSpecOf, dominantFactionOfWrecks } = require("./plan");
const data = require("./data");
const { AGGREGATE, EVENT_CLAIMED, STATE, END_REASON, PLAN_ROWS_CAP, claimKeyOf, takeKeyOf,
  fieldCapOf } = require("./schema");

const { clip, ROW_LEN } = require("../boardRows");

const BOARD = Object.freeze({ source: "salvage", refPrefix: "sv:", kind: "wreck_field", reward: "Salvage + loot" });

function boardRowOf(r) {
  return {
    ref: clip(`${BOARD.refPrefix}${r.anomalyId}`, ROW_LEN.ref),
    source: BOARD.source,
    kind: BOARD.kind,
    title: clip(`Wreck field (${Math.max(0, r.wrecksRemaining)} wrecks)`, ROW_LEN.title),
    systemId: r.systemId,
    factionId: null,
    level: null,
    scan: false,
    rewardText: BOARD.reward,
    endsAt: Number.isSafeInteger(r.expiresAt) ? r.expiresAt : null,
    state: clip(r.state, ROW_LEN.state),
  };
}

const COUNTER_NAMES = Object.freeze(["claimed", "skippedEmpty", "presenceUnsafe", "refused.SITES_FULL",
  "refused.SYSTEM_WINDOW_FULL", "refused.OTHER", "wrecksPlaced", "wrecksAdopted", "wrecksSkipped",
  "wrecksCollected", "wrecksRemoved", "ended.FIELD_GONE", "ended.SITE_GONE", "ended.CLEARED", "seamUnavailable",
  "versionConflict", "stepFailed", "adoptionScans", "wrecksEmpty", "wrecksNoLootTable", "ended.LOOTED",
  "mergedFields", "gridReads", "mergeCapped", "officerSpawned", "officerRefused"]);
const { QUIET_REASONS: OFFICER_QUIET_REFUSALS } = require("../../officers/schema");

const SITE_SLOT = 0;
const SEED_STREAM = "salvageAnomaly";
const CLEANUP_REASON = "EVENT_END";
const QUIET_REFUSALS = Object.freeze(["FULL", "SYSTEM_FULL", "FIELD_GONE"]);
const COUNTED_REFUSALS = Object.freeze(["SITES_FULL", "SYSTEM_WINDOW_FULL"]);
const PERMANENT_REFUSALS = Object.freeze(["PLAN_INVALID", "ANOMALY_EXISTS", "IDEMPOTENCY_CONFLICT",
  "TAKE_DUPLICATE", "SITE_REQUEST_INVALID", "JOURNAL_INVALID_INPUT", "JOURNAL_PAYLOAD_TOO_LARGE",
  "WRECK_INVALID_INPUT"]);
const MAX_DETAIL = 120;
const MS_DECIMALS = 1000;
const METERED_SEAM_METHODS = Object.freeze(["listOwn", "getOwn", "place", "remove", "flush", "readGrid"]);

const SKIP = "skip";
const STOP = "stop";
const DONE = "done";

class Rollback {
  constructor(reason) {
    this.reason = String(reason || "REFUSED");
  }
}

function noop() {}

function messageOf(err) {
  return String((err && err.message) || err).slice(0, MAX_DETAIL);
}

function isPositiveInt(v) {
  return Number.isSafeInteger(v) && v > 0;
}

function safeCall(fn) {
  try {
    return typeof fn === "function" ? fn() : null;
  } catch (_err) {
    return null;
  }
}

function sitesUsable(sites) {
  if (!sites || typeof sites.createSiteInTx !== "function" || typeof sites.listSitesByEvent !== "function"
    || typeof sites.cleanupSitesInTx !== "function") return false;
  if (typeof sites.getStatus !== "function") return true;
  const st = safeCall(() => sites.getStatus());
  return Boolean(st && st.state === "running");
}

function wreckRepoOf(wrecks) {
  const repo = wrecks && wrecks.repository;
  if (!repo || typeof repo.get !== "function" || typeof repo.claimForAnomalyInTx !== "function"
    || typeof repo.listUnmaterializedInSystem !== "function") return null;
  return repo;
}

function createSalvageAnomalyService(deps) {
  const { store, journal, adapter, config } = deps;
  const P = config.salvageAnomaly;
  const worldSeed = deps.worldSeed;
  const repo = deps.repository || defaultRepository;
  const telemetry = deps.telemetry || null;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log: noop };
  const getGovernor = typeof deps.getGovernor === "function" ? deps.getGovernor : () => null;
  const getPresence = typeof deps.getPresence === "function" ? deps.getPresence : () => null;
  const getSites = typeof deps.getSites === "function" ? deps.getSites : () => null;
  const getWrecks = typeof deps.getWrecks === "function" ? deps.getWrecks : () => null;
  const getOfficerSpawns = typeof deps.getOfficerSpawns === "function" ? deps.getOfficerSpawns : () => null;
  const officer = { spawned: 0, refused: 0 };
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
  const lootMissing = new Set(Array.isArray(deps.lootTablesMissing) ? deps.lootTablesMissing : []);
  const fallbackLootUsable = deps.fallbackLootUsable !== false;
  const lootRandomAny = new Set(Array.isArray(deps.lootTablesRandomAny) ? deps.lootTablesRandomAny : []);
  let passes = 0;
  let lastPass = null;
  const refusedFields = new Set();
  const adoptionDone = new Set();
  const blockedSystems = new Map();
  let blockedUntil = 0;
  const noLootLogged = new Set();
  const claimRetryMs = config.sites && Number.isSafeInteger(config.sites.retryDelayMs)
    ? config.sites.retryDelayMs : P.pumpIntervalMs;
  let nextClaimAt = 0;
  const fieldCap = fieldCapOf(P.maxFieldsPerAnomaly, store.limits && store.limits.maxRowsPerTransaction);
  const wreckCap = Math.min(P.maxWrecksPerAnomaly, PLAN_ROWS_CAP);
  const readCap = Math.min(fieldCap, wreckCap);
  const lootWatch = new Map();

  function rememberRefused(fieldId) {
    refusedFields.add(fieldId);
    while (refusedFields.size > P.maxRefusedFieldsRemembered) {
      refusedFields.delete(refusedFields.values().next().value);
    }
  }

  function bump(name, n = 1) {
    if (!telemetry || typeof telemetry.count !== "function" || n <= 0) return;
    try {
      telemetry.count(`salvageAnomaly.${name}`, n);
    } catch (_err) {
    }
  }

  function observeMs(kind, ms) {
    if (!telemetry || typeof telemetry.observe !== "function") return;
    const value = Math.max(0, Math.round(ms * MS_DECIMALS) / MS_DECIMALS);
    try {
      if (kind === "scan") telemetry.observe("salvageAnomaly.vendorScanMs", value);
      else if (kind === "claim") telemetry.observe("salvageAnomaly.claimMs", value);
      else telemetry.observe("salvageAnomaly.passMs", value);
    } catch (_err) {
    }
  }

  function meteredSeam(seam) {
    if (!telemetry || typeof telemetry.noteOp !== "function") return seam;
    const out = { ok: seam.ok };
    for (const name of METERED_SEAM_METHODS) {
      if (typeof seam[name] !== "function") continue;
      const label = `salvage.${name}`;
      out[name] = (...args) => {
        const t0 = nowMs();
        try {
          return seam[name](...args);
        } finally {
          try {
            telemetry.noteOp("adapter", label, t0, nowMs() - t0);
          } catch (_err) {
          }
        }
      };
    }
    return out;
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

  function lootTableFor(factionId, hullGroup) {
    return data.resolveLootTable(factionId, hullGroup, { sizedDefault: P.sizedDefaultLoot === true,
      fallbackId: fallbackLootUsable ? P.fallbackLootTableId : null, unusable: lootMissing, randomAny: lootRandomAny });
  }

  function rememberInvalid(invalid) {
    for (const [fieldId, bad] of invalid) {
      if (refusedFields.has(fieldId)) continue;
      rememberRefused(fieldId);
      bump("refused.OTHER");
      logger.log(`salvageAnomaly: claim of ${fieldId} refused - PLAN_INVALID (${bad})`);
    }
  }

  function unusableOf(f, now) {
    if (refusedFields.has(f.fieldId)) return "REFUSED";
    if (effectivePool(f, now).total < P.minPoolUnits) return "EMPTY";
    return validateField(f);
  }

  function hullsOf(f) {
    return f.composition.reduce((n, e) => n + e[3], 0);
  }

  function candidatesOf(systems, now, wreckRepo) {
    const r = store.transaction("salvageAnomaly.candidates", (db) => {
      const out = { list: [], empty: 0, invalid: [] };
      if (repo.countLiveInTx(db) >= P.maxActiveAnomalies) return out;
      for (const systemId of systems) {
        if (out.list.length >= P.maxObservedSystemsPerPass) break;
        if (blockedSystems.has(systemId)) continue;
        if (repo.countLiveBySystemInTx(db, systemId) >= P.maxPerSystem) continue;
        const listed = wreckRepo.listUnmaterializedInSystem(db, { systemId, at: now, limit: P.maxRowsPerPass });
        if (!listed || !listed.ok || listed.fields.length === 0) continue;
        let usable = false;
        for (const f of listed.fields) {
          const bad = unusableOf(f, now);
          if (bad === null) {
            usable = true;
            break;
          }
          if (bad !== "REFUSED" && bad !== "EMPTY") out.invalid.push([f.fieldId, bad]);
        }
        if (usable) out.list.push({ systemId });
        else out.empty += 1;
      }
      return out;
    });
    if (r.ok) rememberInvalid(r.value.invalid);
    if (!r.ok) {
      logger.log(`salvageAnomaly: candidate read failed - ${r.reason}${r.error ? ` ${messageOf(r.error)}` : ""}`);
      return { list: [], empty: 0 };
    }
    return r.value;
  }

  function mergedFieldOf(live) {
    if (live.length === 1) return live[0].field;
    return {
      composition: live.flatMap((l) => l.field.composition),
      shipsLost: live.reduce((n, l) => n + l.field.shipsLost, 0),
      salvageUnits: live.reduce((n, l) => n + l.field.salvageUnits, 0),
      lootUnits: live.reduce((n, l) => n + l.field.lootUnits, 0),
    };
  }

  function claim(candidate, now, sites, wreckRepo) {
    let primaryId = null;
    let taking = 0;
    let invalid = [];
    const t0 = nowMs();
    const r = store.transaction("salvageAnomaly.claim", (tx) => {
      primaryId = null;
      taking = 0;
      invalid = [];
      if (repo.countLiveInTx(tx) >= P.maxActiveAnomalies) throw new Rollback("FULL");
      if (repo.countLiveBySystemInTx(tx, candidate.systemId) >= P.maxPerSystem) throw new Rollback("SYSTEM_FULL");
      const listed = wreckRepo.listUnmaterializedInSystem(tx, { systemId: candidate.systemId, at: now,
        limit: readCap + P.maxRowsPerPass });
      if (!listed || !listed.ok) throw new Rollback((listed && listed.reason) || "FIELD_READ_FAILED");
      const fields = listed.fields;
      const live = [];
      let empty = false;
      let hulls = 0;
      let stop = 0;
      for (; stop < fields.length && live.length < readCap && hulls < wreckCap; stop += 1) {
        const f = fields[stop];
        const bad = unusableOf(f, now);
        if (bad === "EMPTY") empty = true;
        if (bad !== null) {
          if (bad !== "REFUSED" && bad !== "EMPTY") invalid.push([f.fieldId, bad]);
          continue;
        }
        live.push({ field: f, pool: effectivePool(f, now) });
        hulls += hullsOf(f);
      }
      const capped = fields.slice(stop).some((f) => unusableOf(f, now) === null);
      if (live.length === 0) throw new Rollback(empty ? "EMPTY" : "FIELD_GONE");
      taking = live.length;
      live.sort((a, b) => b.field.expiresAt - a.field.expiresAt
        || (a.field.fieldId < b.field.fieldId ? -1 : a.field.fieldId > b.field.fieldId ? 1 : 0));
      const rest = live.slice(1).sort((a, b) => (a.field.fieldId < b.field.fieldId ? -1 : 1));
      const ordered = [live[0], ...rest];
      const field = ordered[0].field;
      primaryId = field.fieldId;
      const haul = { salvage: ordered.reduce((n, l) => n + l.pool.salvage, 0),
        loot: ordered.reduce((n, l) => n + l.pool.loot, 0) };
      const anomalyId = repo.anomalyIdOf(field.fieldId);
      const seed = deriveSeed(worldSeed, SEED_STREAM, field.fieldId);
      const plan = planAnomaly(mergedFieldOf(ordered), haul, P, seed);
      if (!plan.ok) throw new Rollback(plan.reason);
      const mergedFieldIds = rest.map((l) => l.field.fieldId);
      const payload = { anomalyId, fieldId: field.fieldId, systemId: field.systemId };
      if (mergedFieldIds.length > 0) payload.mergedFieldIds = mergedFieldIds;
      const inserted = journal.applyOnce(tx, { key: claimKeyOf(field.fieldId),
        aggregate: { type: AGGREGATE, id: anomalyId }, eventType: EVENT_CLAIMED, payload },
      (db) => repo.insertInTx(db, { anomalyId, fieldId: field.fieldId, systemId: field.systemId,
        haulSalvage: haul.salvage, haulLoot: haul.loot, seed, planRows: plan.rows, expiresAt: field.expiresAt,
        now }));
      if (!inserted.ok) {
        throw new Rollback(inserted.reason === "APPLY_REFUSED" && inserted.refusal ? inserted.refusal.reason
          : inserted.reason);
      }
      if (inserted.duplicate) return { duplicate: true, anomalyId, merged: 0, taken: 0, capped: false };
      for (const l of ordered) {
        const taken = wreckRepo.claimForAnomalyInTx(tx, { fieldId: l.field.fieldId, expectedVersion: l.field.version,
          at: now }, takeKeyOf(l.field.fieldId));
        if (!taken || !taken.ok) throw new Rollback((taken && taken.reason) || "TAKE_FAILED");
        if (taken.duplicate) throw new Rollback("TAKE_DUPLICATE");
      }
      const site = sites.createSiteInTx(tx, { eventId: anomalyId, slot: SITE_SLOT, systemId: field.systemId,
        templateId: P.templateId, label: plan.label, factionId: null, expiresAt: field.expiresAt });
      if (!site || site.ok !== true) throw new Rollback((site && site.reason) || "SITE_REFUSED");
      return { duplicate: false, anomalyId, wrecks: plan.rows.length, merged: mergedFieldIds.length,
        taken: ordered.length, capped };
    });
    observeMs("claim", nowMs() - t0);
    rememberInvalid(invalid);
    if (r.ok) {
      if (!r.value.duplicate) {
        bump("claimed");
        bump("mergedFields", r.value.merged);
        if (r.value.capped) bump("mergeCapped");
      }
      return { ok: true, ...r.value };
    }
    const reason = r.error instanceof Rollback ? r.error.reason : (r.reason || "TX_FAILED");
    if (reason === "EMPTY") bump("skippedEmpty");
    else if (COUNTED_REFUSALS.includes(reason)) bump(`refused.${reason}`);
    else if (!QUIET_REFUSALS.includes(reason)) {
      if (PERMANENT_REFUSALS.includes(reason)) {
        if (primaryId !== null) rememberRefused(primaryId);
        if (taking > 1) blockedSystems.set(candidate.systemId, now + claimRetryMs);
      }
      bump("refused.OTHER");
      logger.log(`salvageAnomaly: claim ${primaryId !== null ? `of ${primaryId}` : `in system ${candidate.systemId}`}`
        + ` refused - ${reason}`
        + `${r.error && !(r.error instanceof Rollback) ? ` ${messageOf(r.error)}` : ""}`);
    }
    return { ok: false, reason };
  }

  function claimPhase(now, sites, wreckRepo, out) {
    const presence = safeCall(getPresence);
    const st = presence && typeof presence.getStatus === "function" ? safeCall(() => presence.getStatus()) : null;
    if (!st || st.available !== true || st.stale === true) {
      bump("presenceUnsafe");
      out.presence = "unsafe";
      return;
    }
    if (now < nextClaimAt) return;
    nextClaimAt = now + P.pumpIntervalMs;
    if (now < blockedUntil) return;
    for (const [systemId, until] of blockedSystems) {
      if (until <= now) blockedSystems.delete(systemId);
    }
    const observed = safeCall(() => presence.observedSystems());
    const systems = (Array.isArray(observed) ? observed : []).filter((id) => isPositiveInt(id)
      && !blockedSystems.has(id)).sort((a, b) => a - b).slice(0, P.maxObservedSystemsPerPass);
    if (systems.length === 0) return;
    const candidates = candidatesOf(systems, now, wreckRepo);
    bump("skippedEmpty", candidates.empty);
    let takenInPass = 0;
    for (const candidate of candidates.list) {
      if (out.claimed >= P.maxNewPerPass || takenInPass >= P.maxClaimFieldsPerPass) break;
      const res = claim(candidate, now, sites, wreckRepo);
      if (res.ok) {
        if (!res.duplicate) {
          out.claimed += 1;
          takenInPass += res.taken;
        }
        continue;
      }
      if (res.reason === "SYSTEM_WINDOW_FULL" || res.reason === "SYSTEM_FULL") {
        blockedSystems.set(candidate.systemId, now + claimRetryMs);
      } else if (res.reason === "SITES_FULL" || res.reason === "FULL") {
        blockedUntil = now + claimRetryMs;
        break;
      }
    }
  }

  function commit(row, now, patch, counters = [], extra = null) {
    const r = store.transaction("salvageAnomaly.step", (tx) => {
      const written = repo.transitionInTx(tx, row, { ...patch, updated_at: now });
      if (!written.ok) return written;
      if (extra) extra(tx);
      return written;
    });
    if (!r.ok) {
      const reason = r.error instanceof Rollback ? r.error.reason : r.reason;
      logger.log(`salvageAnomaly: step ${row.anomalyId} not committed - ${reason}`
        + `${r.error && !(r.error instanceof Rollback) ? ` ${messageOf(r.error)}` : ""}`);
      return false;
    }
    if (!r.value || r.value.ok !== true) {
      if (r.value && r.value.reason === "VERSION_CONFLICT") bump("versionConflict");
      return false;
    }
    for (const [name, n] of counters) bump(name, n);
    return true;
  }

  function retryLater(row, now) {
    commit(row, now, { next_at: now + P.pumpIntervalMs });
    return DONE;
  }

  function trackIntervalOf(row, ctx) {
    return ctx && ctx.observed.has(row.systemId) ? P.trackObservedIntervalMs : P.trackIntervalMs;
  }

  function afterPlayerEnd(row, now, sites) {
    if (typeof sites.nudge === "function") safeCall(() => sites.nudge());
    if (P.respawnDelayMs > 0) {
      const until = now + P.respawnDelayMs;
      if (!(blockedSystems.get(row.systemId) >= until)) blockedSystems.set(row.systemId, until);
    }
  }

  function cleanupInTx(sites, tx, anomalyId) {
    const cleaned = sites.cleanupSitesInTx(tx, anomalyId, CLEANUP_REASON);
    if (!cleaned || cleaned.ok !== true) throw new Rollback((cleaned && cleaned.reason) || "CLEANUP_REFUSED");
  }

  function toEnding(row, now, reason) {
    adoptionDone.delete(row.anomalyId);
    lootWatch.delete(row.anomalyId);
    const remaining = row.state === STATE.PLACING ? row.wrecksPlaced : row.wrecksRemaining;
    commit(row, now, { state: STATE.ENDING, end_reason: reason, wrecks_remaining: remaining, next_at: now });
    return DONE;
  }

  function scanOwn(seam, anomalyId) {
    const t0 = nowMs();
    let res;
    try {
      res = seam.listOwn(anomalyId);
    } catch (err) {
      res = { ok: false, reason: "READ_FAILED", detail: messageOf(err) };
    }
    observeMs("scan", nowMs() - t0);
    return res && res.ok === true && Array.isArray(res.wrecks) ? res : { ok: false, reason: (res && res.reason)
      || "READ_FAILED" };
  }

  function idsOf(placed) {
    return (Array.isArray(placed) ? placed : []).filter((p) => Array.isArray(p) && p.length >= 2 && isPositiveInt(p[1]))
      .map((p) => p[1]);
  }

  function knownOwn(seam, anomalyId, ids) {
    let res;
    try {
      res = seam.getOwn(anomalyId, ids);
    } catch (err) {
      res = { ok: false, reason: "READ_FAILED", detail: messageOf(err) };
    }
    return res && res.ok === true && Array.isArray(res.wrecks) ? res : { ok: false, reason: (res && res.reason)
      || "READ_FAILED" };
  }

  function noteNoLootTable(wreck) {
    if (noLootLogged.has(wreck.factionId)) return;
    noLootLogged.add(wreck.factionId);
    logger.log(`salvageAnomaly: no loot table for faction ${wreck.factionId} (hull ${wreck.hullGroup})`
      + " - wreck without loot");
  }

  function flushQuietly(seam) {
    try {
      seam.flush();
    } catch (_err) {
    }
  }

  function stepPlacing(row, now, seam, site, budget, ctx) {
    const planned = wrecksOfRows(row.plan);
    const placed = new Map(row.placed.filter((p) => Array.isArray(p) && p.length >= 2).map((p) => [p[0], p[1]]));
    const missing = planned.filter((w) => !placed.has(w.slot));
    const counters = { wrecksPlaced: 0, wrecksAdopted: 0, wrecksSkipped: 0, wrecksEmpty: 0, wrecksNoLootTable: 0 };
    let pendingSlots = null;
    let scanned = false;
    if (missing.length > 0 && budget.canWrite() && !adoptionDone.has(row.anomalyId)) {
      const own = scanOwn(seam, row.anomalyId);
      bump("adoptionScans");
      if (!own.ok) return retryLater(row, now);
      scanned = true;
      pendingSlots = new Set(own.wrecks.map((w) => w.slot).filter((slot) => !placed.has(slot)));
    }
    let ended = null;
    let stop = false;
    let failed = null;
    let attempts = 0;
    let wrote = false;
    const noLoot = [];
    for (const wreck of missing) {
      if (!budget.canWrite()) break;
      attempts += 1;
      const spec = { ...placeSpecOf(row, wreck, { siteKey: site.siteKey, nowMs: now, lootTableFor }),
        adopt: pendingSlots === null ? false : pendingSlots.has(wreck.slot) };
      const res = budget.call(() => seam.place(spec));
      if (Number.isSafeInteger(res.vendorWrites) && res.vendorWrites > 0) wrote = true;
      if (res.ok) {
        placed.set(wreck.slot, res.wreckId);
        counters[res.adopted ? "wrecksAdopted" : "wrecksPlaced"] += 1;
        if (!res.adopted && wreck.lootRolls > 0 && !spec.lootTableId) {
          counters.wrecksNoLootTable += 1;
          noLoot.push(wreck);
        }
        if (!res.adopted && spec.lootRolls > 0 && res.items === 0) counters.wrecksEmpty += 1;
        continue;
      }
      if (res.reason === "WRECK_TYPE_NOT_FOUND") {
        placed.set(wreck.slot, 0);
        counters.wrecksSkipped += 1;
        continue;
      }
      if (res.reason === "SITE_NOT_ACTIVE") ended = END_REASON.SITE_GONE;
      else if (res.reason === "SEAM_UNAVAILABLE") stop = true;
      else failed = res;
      break;
    }
    if (attempts === 0 && missing.length > 0) return SKIP;
    if (wrote) flushQuietly(seam);
    const placedList = [...placed.entries()].sort((a, b) => a[0] - b[0]);
    const placedCount = placedList.filter((p) => p[1] > 0).length;
    const patch = { placed_json: placedList, wrecks_placed: placedCount };
    if (ended) {
      Object.assign(patch, { state: STATE.ENDING, end_reason: ended, wrecks_remaining: placedCount, next_at: now });
    }
    else if (planned.every((w) => placed.has(w.slot))) {
      Object.assign(patch, { state: STATE.PLACED, wrecks_remaining: placedCount,
        next_at: now + trackIntervalOf(row, ctx) });
    } else {
      patch.next_at = failed ? now + P.pumpIntervalMs : now;
    }
    const committed = commit(row, now, patch, Object.entries(counters));
    if (committed) for (const wreck of noLoot) noteNoLootTable(wreck);
    const orphanRisk = failed !== null && Number.isSafeInteger(failed.vendorWrites) && failed.vendorWrites > 0;
    if (committed && !orphanRisk && !patch.state && (scanned || adoptionDone.has(row.anomalyId))) {
      adoptionDone.add(row.anomalyId);
    } else adoptionDone.delete(row.anomalyId);
    if (failed) {
      bump("stepFailed");
      logger.log(`salvageAnomaly: place of ${row.anomalyId} failed - ${failed.reason}`
        + `${failed.detail ? ` (${failed.detail})` : ""}`);
    }
    return stop ? STOP : DONE;
  }

  function rollOfficer(row, characterId) {
    try {
      const o = getOfficerSpawns();
      if (!o || typeof o.trySalvage !== "function") return;
      const res = o.trySalvage({ anomalyId: row.anomalyId, systemId: row.systemId, characterId,
        factionId: dominantFactionOfWrecks(wrecksOfRows(row.plan)) });
      if (res && res.ok === true) {
        officer.spawned += 1;
        bump("officerSpawned");
        return;
      }
      const reason = res && typeof res.reason === "string" ? res.reason : "NO_RESULT";
      if (OFFICER_QUIET_REFUSALS.includes(reason)) return;
      officer.refused += 1;
      bump("officerRefused");
    } catch (_err) {
    }
  }

  function lootedAndLeft(row, now, seam, site, wrecks) {
    if (typeof seam.readGrid !== "function") return false;
    const center = site && site.position ? site.position : null;
    let grid;
    try {
      grid = seam.readGrid(row.systemId, wrecks.map((w) => w.wreckId), center, P.gridRangeM);
    } catch (_err) {
      grid = null;
    }
    bump("gridReads");
    if (!grid || grid.ok !== true || grid.sceneLoaded !== true || !Array.isArray(grid.wrecks)) return false;
    const watch = lootWatch.get(row.anomalyId) || { visited: false, since: null };
    if (grid.playerOnGrid === true && watch.visited !== true && grid.playerCharacterId) {
      rollOfficer(row, grid.playerCharacterId);
    }
    if (grid.playerOnGrid === true) watch.visited = true;
    const allEmpty = grid.wrecks.length > 0 && grid.wrecks.every((w) => w.inScene === true && w.isEmpty === true);
    if (!allEmpty || grid.playerOnGrid === true) watch.since = null;
    else if (watch.since === null) watch.since = now;
    lootWatch.set(row.anomalyId, watch);
    return watch.visited && watch.since !== null && now - watch.since >= P.lootedGraceMs;
  }

  function stepTracking(row, now, seam, sites, site, ctx) {
    const own = knownOwn(seam, row.anomalyId, idsOf(row.placed));
    if (!own.ok) return retryLater(row, now);
    const left = own.wrecks.length;
    const collected = [["wrecksCollected", Math.max(0, row.wrecksRemaining - left)]];
    if (left === 0) {
      lootWatch.delete(row.anomalyId);
      const ended = commit(row, now, { state: STATE.ENDED, end_reason: END_REASON.CLEARED, ended_at: now,
        wrecks_remaining: 0, next_at: now }, [...collected, [`ended.${END_REASON.CLEARED}`, 1]],
      (tx) => cleanupInTx(sites, tx, row.anomalyId));
      if (ended) afterPlayerEnd(row, now, sites);
      return DONE;
    }
    const observed = ctx.observed.has(row.systemId);
    if (observed && P.endWhenLooted === true && lootedAndLeft(row, now, seam, site, own.wrecks)) {
      const ending = commit(row, now, { state: STATE.ENDING, end_reason: END_REASON.LOOTED, wrecks_remaining: left,
        next_at: now + P.lootedWreckTtlMs }, collected, (tx) => cleanupInTx(sites, tx, row.anomalyId));
      if (ending) {
        lootWatch.delete(row.anomalyId);
        afterPlayerEnd(row, now, sites);
      }
      return DONE;
    }
    commit(row, now, { wrecks_remaining: left, next_at: now + trackIntervalOf(row, ctx) }, collected);
    return DONE;
  }

  function stepEnding(row, now, seam, sites, budget) {
    if (row.wrecksRemaining > 0 && !budget.canWrite()) return SKIP;
    const known = idsOf(row.placed);
    let own = known.length > 0 ? knownOwn(seam, row.anomalyId, known) : { ok: true, wrecks: [] };
    if (!own.ok) return retryLater(row, now);
    if (own.wrecks.length === 0) own = scanOwn(seam, row.anomalyId);
    if (!own.ok) return retryLater(row, now);
    if (own.wrecks.length === 0) {
      commit(row, now, { state: STATE.ENDED, ended_at: now, wrecks_remaining: 0, next_at: now },
        [[`ended.${row.endReason}`, 1]], (tx) => cleanupInTx(sites, tx, row.anomalyId));
      return DONE;
    }
    let removed = 0;
    let gone = 0;
    let failed = null;
    let attempts = 0;
    for (const wreck of own.wrecks) {
      if (!budget.canWrite()) break;
      attempts += 1;
      const res = budget.call(() => seam.remove(row.anomalyId, wreck.wreckId, row.systemId));
      if (res.ok) {
        if (res.gone) gone += 1;
        else removed += 1;
        continue;
      }
      failed = res;
      break;
    }
    if (attempts === 0) return SKIP;
    if (removed > 0) flushQuietly(seam);
    commit(row, now, { wrecks_remaining: own.wrecks.length - removed - gone,
      next_at: failed ? now + P.pumpIntervalMs : now }, [["wrecksRemoved", removed]]);
    if (failed) {
      bump("stepFailed");
      logger.log(`salvageAnomaly: remove of ${row.anomalyId} failed - ${failed.reason}`
        + `${failed.detail ? ` (${failed.detail})` : ""}`);
    }
    return DONE;
  }

  function stepRow(row, now, seam, sites, wreckRepo, budget, ctx) {
    const facts = store.transaction("salvageAnomaly.read", (tx) => {
      const listed = sites.listSitesByEvent(row.anomalyId, tx);
      const got = wreckRepo.get(tx, row.fieldId);
      return { sites: listed && listed.ok ? listed.sites : null, field: got && got.ok ? got.field : null };
    });
    if (row.state !== STATE.PLACING) adoptionDone.delete(row.anomalyId);
    if (row.state !== STATE.PLACED) lootWatch.delete(row.anomalyId);
    if (!facts.ok || facts.value.sites === null) return retryLater(row, now);
    if (row.state === STATE.ENDING) return stepEnding(row, now, seam, sites, budget);
    const field = facts.value.field;
    if (!field || field.state !== WRECK_ACTIVE || field.expiresAt <= now || row.expiresAt <= now) {
      return toEnding(row, now, END_REASON.FIELD_GONE);
    }
    const site = facts.value.sites.find((s) => s.slot === SITE_SLOT) || null;
    const siteState = site ? site.state : null;
    if (siteState !== SITE_STATE.ACTIVE && siteState !== SITE_STATE.CREATING) {
      return toEnding(row, now, END_REASON.SITE_GONE);
    }
    if (row.state === STATE.SITE_PENDING) {
      if (siteState === SITE_STATE.ACTIVE) commit(row, now, { state: STATE.PLACING, next_at: now });
      else commit(row, now, { next_at: now + P.pumpIntervalMs });
      return DONE;
    }
    if (row.state === STATE.PLACING) {
      if (siteState !== SITE_STATE.ACTIVE) return retryLater(row, now);
      return stepPlacing(row, now, seam, site, budget, ctx);
    }
    if (row.state === STATE.PLACED) return stepTracking(row, now, seam, sites, site, ctx);
    return retryLater(row, now);
  }

  function stepPhase(now, seam, sites, wreckRepo, budget, out, ctx) {
    const due = store.transaction("salvageAnomaly.due", (db) => ({ rows: repo.listDueInTx(db, now, P.maxRowsPerPass),
      observedLive: repo.countObservedLiveInTx(db, [...ctx.observed]) }));
    if (!due.ok) {
      logger.log(`salvageAnomaly: due read failed - ${due.reason}`);
      return;
    }
    out.observedLive = due.value.observedLive;
    for (const row of due.value.rows) {
      out.rows += 1;
      let step;
      try {
        step = stepRow(row, now, seam, sites, wreckRepo, budget, ctx);
      } catch (err) {
        adoptionDone.delete(row.anomalyId);
        bump("stepFailed");
        logger.log(`salvageAnomaly: step ${row.anomalyId} threw - ${messageOf(err)}`);
        try {
          retryLater(row, now);
        } catch (_err) {
        }
        continue;
      }
      if (step === STOP) {
        bump("seamUnavailable");
        out.skipped = "SEAM_UNAVAILABLE";
        break;
      }
    }
  }

  function observedSetOf() {
    const presence = safeCall(getPresence);
    const list = presence && typeof presence.observedSystems === "function"
      ? safeCall(() => presence.observedSystems()) : null;
    return new Set((Array.isArray(list) ? list : []).filter(isPositiveInt).sort((a, b) => a - b)
      .slice(0, P.maxObservedSystemsPerPass));
  }

  function runPass(now) {
    const startedAt = nowMs();
    const out = { ok: true, claimed: 0, rows: 0, wreckOps: 0, vendorWrites: 0, presence: "ok", observedLive: 0,
      skipped: null };
    try {
      if (!Number.isSafeInteger(now) || now <= 0) return { ok: false, reason: "SALVAGE_ANOMALY_NOW_INVALID" };
      if (!admits("OPERATIONAL")) {
        out.skipped = "GOVERNOR";
        return out;
      }
      const sites = safeCall(getSites);
      if (!sitesUsable(sites)) {
        out.skipped = "SITES_UNAVAILABLE";
        return out;
      }
      const wreckRepo = wreckRepoOf(safeCall(getWrecks));
      if (!wreckRepo) {
        out.skipped = "WRECKS_UNAVAILABLE";
        return out;
      }
      const rawSeam = safeCall(() => adapter.getNativeWrecks());
      if (!rawSeam || rawSeam.ok !== true) {
        bump("seamUnavailable");
        out.skipped = "SEAM_UNAVAILABLE";
        return out;
      }
      const seam = meteredSeam(rawSeam);
      const budget = {
        ops: 0,
        writes: 0,
        canWrite: () => budget.ops < P.maxWreckWritesPerPass,
        call(fn) {
          let res;
          budget.ops += 1;
          try {
            res = fn();
          } catch (err) {
            res = { ok: false, reason: "WRITE_FAILED", detail: messageOf(err) };
          }
          if (!res || typeof res !== "object") res = { ok: false, reason: "NO_RESULT" };
          budget.writes += Number.isSafeInteger(res.vendorWrites) ? res.vendorWrites : 0;
          return res;
        },
      };
      claimPhase(now, sites, wreckRepo, out);
      stepPhase(now, seam, sites, wreckRepo, budget, out, { observed: observedSetOf() });
      out.wreckOps = budget.ops;
      out.vendorWrites = budget.writes;
      return out;
    } catch (err) {
      logger.log(`salvageAnomaly: pass failed - ${messageOf(err)}`);
      return { ok: false, reason: "SALVAGE_ANOMALY_PASS_FAILED", detail: messageOf(err) };
    } finally {
      passes += 1;
      lastPass = Object.freeze({ claimed: out.claimed, rows: out.rows, wreckOps: out.wreckOps,
        vendorWrites: out.vendorWrites,
        presence: out.presence, skipped: out.skipped });
      observeMs("pass", nowMs() - startedAt);
    }
  }

  function countLive() {
    if (typeof store.isInTransaction === "function" && store.isInTransaction()) {
      return { ok: false, reason: "TX_ACTIVE" };
    }
    const r = store.transaction("salvageAnomaly.read", (db) => repo.countLiveInTx(db));
    return r.ok ? { ok: true, count: r.value } : { ok: false, reason: r.reason || "TX_FAILED" };
  }

  function listBoardRows(opts) {
    try {
      const limit = opts && opts.limit;
      const systemIds = opts ? opts.systemIds : undefined;
      if (!Number.isSafeInteger(limit) || limit <= 0) return { ok: false, reason: "LIMIT_INVALID" };
      if (systemIds !== null && !(systemIds instanceof Set)) return { ok: false, reason: "SYSTEM_IDS_INVALID" };
      if (typeof store.isInTransaction === "function" && store.isInTransaction()) {
        return { ok: false, reason: "TX_ACTIVE" };
      }
      const r = store.transaction("salvageAnomaly.board", (db) => repo.listBoardInTx(db,
        { systemIds: systemIds === null ? null : [...systemIds], limit }));
      if (!r.ok) return { ok: false, reason: r.reason || "TX_FAILED" };
      if (!r.value || r.value.ok !== true) return { ok: false, reason: String((r.value && r.value.reason) || "NO_RESULT") };
      return { ok: true, rows: r.value.rows.map(boardRowOf), truncated: r.value.truncated };
    } catch (err) {
      return { ok: false, reason: "SALVAGE_BOARD_FAILED", detail: messageOf(err) };
    }
  }

  return Object.freeze({
    runPass,
    countLive,
    listBoardRows,
    getPassStatus: () => Object.freeze({ passes, last: lastPass, officer: Object.freeze({ ...officer }) }),
  });
}

module.exports = { createSalvageAnomalyService, COUNTER_NAMES, SITE_SLOT, Rollback };
