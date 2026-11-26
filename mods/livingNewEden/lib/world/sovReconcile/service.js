"use strict";

const { createPoller, defaultSetTimer } = require("../../presence/poller");
const { classifyForeign, listDefended, planSettlement, factKey, defendedKey } = require("./rules");
const {
  FACT_AGGREGATE,
  FACT_EVENT_TYPES,
  LOG_ACTION_NATIVE_LOSS,
  LOG_ACTION_REPROJECT,
} = require("./schema");
const { upsertLog, getLog } = require("../sovProjection/repository");
const { readPage, markForeignInTx, deleteEpisodeInTx } = require("./repository");
const { pickNudges } = require("./catchup");
const { WORK_CLASS_ORDER } = require("../../telemetry/loadGovernor");
const { getCoreIndex, coreOwnerOf } = require("../core");

const STATE_READY = "ready";
const STATE_IDLE = "idle";
const STATE_STOPPED = "stopped";

const EVENT_LOSS = FACT_EVENT_TYPES[0];
const EVENT_REPROJECT = FACT_EVENT_TYPES[1];
const EVENT_DEFENDED = FACT_EVENT_TYPES[2];

const COUNTER_NAMES = Object.freeze([
  "passes",
  "foreignRows",
  "deferredRows",
  "markedForeign",
  "deletedRestored",
  "factsPlanned",
  "factsApplied",
  "factsDuplicate",
  "factsStale",
  "factsFailed",
  "defendedProcessed",
  "dropApplied",
  "abandonApplied",
  "logUpserted",
  "episodeDeleted",
  "journalApplied",
  "stale",
  "invalid",
  "failed",
  "duplicateKeyCollision",
  "truncated",
  "syncPending",
  "governorRefused",
  "seamUnavailable",
  "projectionDisabled",
  "inFlightSkipped",
  "noForeignRows",
  "vcorpsPending",
  "overBudget",
  "nudged",
  "nudgeFailed",
  "playerHeld",
  "coreProtected",
  "rowsGivenUp",
]);

const GAUGE_NAMES = Object.freeze(["foreignRows", "deferredRows"]);

const PARAM_KEYS = Object.freeze([
  "enabled",
  "passMs",
  "fullPassMs",
  "maxRowsPerPass",
  "maxFactsPerPass",
  "maxOutcomesPerSystem",
  "maxDeferMs",
  "hubLossInfluencePoints",
  "logOnceMs",
  "logOnceMaxKeys",
  "governorWorkClass",
  "maxProjectNudgesPerPass",
  "maxRowRetries",
]);

const INTEGER_KEYS = Object.freeze(["passMs", "fullPassMs", "maxRowsPerPass", "maxFactsPerPass",
  "maxOutcomesPerSystem", "maxDeferMs", "hubLossInfluencePoints", "logOnceMs", "logOnceMaxKeys",
  "maxProjectNudgesPerPass", "maxRowRetries"]);

const MAX_DETAIL = 120;

const MIN_ROWS_FOR_SEAM_OUTAGE = 2;

function messageOf(err) {
  return String((err && err.message) || err);
}

class Abort extends Error {
  constructor(kind, detail) {
    super(String(detail).slice(0, MAX_DETAIL));
    this.name = "SovReconcileAbort";
    this.kind = kind;
  }
}

function validateConfig(cfg) {
  const keys = new Set(PARAM_KEYS);
  for (const k of Object.keys(cfg)) if (!keys.has(k)) return { ok: false, reason: "CONFIG_UNKNOWN_KEY", key: k };
  for (const k of PARAM_KEYS) if (cfg[k] === undefined) return { ok: false, reason: "CONFIG_MISSING_KEY", key: k };
  if (typeof cfg.enabled !== "boolean") return { ok: false, reason: "CONFIG_TYPE", key: "enabled" };
  for (const k of INTEGER_KEYS) {
    if (!Number.isSafeInteger(cfg[k]) || cfg[k] < 0) return { ok: false, reason: "CONFIG_TYPE", key: k };
  }
  for (const k of ["passMs", "maxRowsPerPass", "maxFactsPerPass", "maxOutcomesPerSystem", "maxDeferMs",
    "logOnceMaxKeys"]) {
    if (cfg[k] === 0) return { ok: false, reason: "CONFIG_ZERO", key: k };
  }
  if (!WORK_CLASS_ORDER.includes(cfg.governorWorkClass)) {
    return { ok: false, reason: "CONFIG_TYPE", key: "governorWorkClass" };
  }
  return { ok: true };
}

function createUnavailableSovReconcile(reason) {
  const refusal = Object.freeze({ ok: false, reason: String(reason) });
  return Object.freeze({
    start: () => refusal,
    stop: () => {},
    getStatus: () => Object.freeze({ state: STATE_STOPPED, reason: refusal.reason }),
  });
}

function createSovReconcileService(deps) {
  const { store, repository, journal, clock, occupation, virtualCorps, sovProjection, adapter, config, logger,
    getGovernor, setTimer, coreIndex: depsCoreIndex } = deps;
  const params = Object.freeze(Object.fromEntries(PARAM_KEYS.map((k) => [k, config.world?.sovReconcile?.[k]])));
  const validation = validateConfig(params);
  if (!validation.ok) throw new TypeError(`createSovReconcileService: invalid config: ${validation.reason} (${validation.key || ""})`);

  const sovNative = typeof adapter?.getSovNative === "function" ? adapter.getSovNative() : null;
  const isModAlliance = (id) => virtualCorps.isVirtualAlliance(id) === true;

  const coreIndex = depsCoreIndex || getCoreIndex(config);

  const counters = Object.fromEntries(COUNTER_NAMES.map((n) => [n, 0]));
  let stopped = false;
  let seq = 0;
  let lastError = null;
  let cursor = 0;
  let poller = null;
  let inPass = false;
  let idleReason = null;
  let lastPassAt = null;
  let lastFullAt = null;
  let lastUpdatedAt = null;

  let vcState = "pending";
  try {
    if (virtualCorps && typeof virtualCorps.whenReady === "function") {
      Promise.resolve(virtualCorps.whenReady()).then(() => { vcState = "ready"; }, () => { vcState = "failed"; });
    } else {
      vcState = "failed";
    }
  } catch (_err) {
    vcState = "failed";
  }

  const catchupState = { rotationIndex: 0 };

  function bump(name, n = 1) {
    if (!(n > 0)) return;
    if (!Object.prototype.hasOwnProperty.call(counters, name)) return;
    counters[name] += n;
    seq += 1;
  }

  function setGauge(name, value) {
    if (!GAUGE_NAMES.includes(name)) return;
    counters[name] = value;
    seq += 1;
  }

  function noteRefusal(where, reason) {
    lastError = `${where}:${String(reason).slice(0, MAX_DETAIL)}`;
    seq += 1;
  }

  function log(message) {
    try { logger?.log?.(message); } catch (_err) {}
  }

  const logOnceCache = new Map();

  const retryMap = new Map();

  function logOnce(systemId, reason) {
    const now = clock.now();
    const key = `${systemId}:${reason}`;
    const prev = logOnceCache.get(key);
    if (prev !== undefined && now - prev < params.logOnceMs) return false;
    if (logOnceCache.size >= params.logOnceMaxKeys) logOnceCache.clear();
    logOnceCache.set(key, now);
    log(`[sovReconcile] system ${systemId}: ${reason}`);
    return true;
  }

  function admits(workClass) {
    let governor = null;
    try {
      governor = typeof getGovernor === "function" ? getGovernor() : null;
    } catch (_err) {
      governor = null;
    }
    if (!governor || typeof governor.admits !== "function") return true;
    try {
      return governor.admits(workClass) !== false;
    } catch (_err) {
      return true;
    }
  }

  function runGates() {
    if (!params.enabled) return { ok: false, reason: "disabled_by_config" };
    if (!admits(params.governorWorkClass)) {
      bump("governorRefused");
      return { ok: false, reason: "GOVERNOR_DEFERRED" };
    }
    const proj = sovProjection?.getStatus?.();
    if (!proj || proj.state === "unavailable" || proj.state === "stopped") {
      bump("projectionDisabled");
      return { ok: false, reason: "dependency_disabled:sovProjection" };
    }
    if (proj.syncState !== "done" && proj.syncState !== "failed") {
      bump("syncPending");
      return { ok: false, reason: "SOV_SYNC_PENDING" };
    }
    if (!occupation || typeof occupation.abandonInTx !== "function" || typeof occupation.dropInfluenceInTx !== "function") {
      return { ok: false, reason: "dependency_disabled:occupation" };
    }
    if (!virtualCorps || typeof virtualCorps.isVirtualAlliance !== "function") {
      return { ok: false, reason: "dependency_disabled:virtualCorps" };
    }
    if (vcState === "pending") {
      bump("vcorpsPending");
      return { ok: false, reason: "VCORPS_PENDING" };
    }
    if (vcState === "failed") return { ok: false, reason: "VCORPS_FAILED" };
    if (!repository || typeof repository.isApplied !== "function" || typeof repository.getSystem !== "function") {
      return { ok: false, reason: "dependency_disabled:world" };
    }
    if (!sovNative) return { ok: false, reason: "SOV_SEAM_UNAVAILABLE" };
    return { ok: true };
  }

  function readClaim(systemId) {
    try {
      const r = sovNative.getSystemSovClaim(systemId);
      if (!r || r.ok !== true) return { ok: false, reason: (r && r.reason) || "CLAIM_READ_FAILED" };
      return { ok: true, claimed: r.claimed === true, allianceId: r.allianceId ?? null, corporationId: r.corporationId ?? null };
    } catch (err) {
      return { ok: false, reason: `CLAIM_READ_THREW: ${messageOf(err)}` };
    }
  }

  function readOutcomes(systemId) {
    try {
      const r = sovNative.readCampaignOutcomes(systemId, { max: params.maxOutcomesPerSystem });
      if (!r || r.ok !== true) return { ok: false, reason: (r && r.reason) || "OUTCOMES_READ_FAILED" };
      return { ok: true, outcomes: r.outcomes, truncated: r.truncated === true };
    } catch (err) {
      return { ok: false, reason: `OUTCOMES_READ_THREW: ${messageOf(err)}` };
    }
  }

  function readMarker() {
    try {
      const r = typeof sovNative.readUpdatedAt === "function" ? sovNative.readUpdatedAt() : null;
      return r && r.ok === true ? { ok: true, value: r.updatedAt ?? null } : { ok: false };
    } catch (_err) {
      return { ok: false };
    }
  }

  function isProjecting(systemId) {
    try {
      return sovProjection.isProjecting(systemId) === true;
    } catch (_err) {
      return false;
    }
  }

  function planRowOf(ep, kind) {
    return { kind, factionId: ep.factionId, allianceId: ep.allianceId, boundSeq: ep.boundSeq, foreignAt: ep.foreignAt };
  }

  function logRowOf(lastSeq, lastAlliance) {
    return { boundSeq: lastSeq, allianceId: lastAlliance };
  }

  function markInTx(tx, entries, now, full) {
    let marked = 0;
    let restored = 0;
    for (const e of entries) {
      if (!e.claim) continue;
      const lg = e.row.log;
      if (!e.episode && e.candidate && e.claim.allianceId !== lg.lastAlliance) {
        const ep = { factionId: lg.lastController, allianceId: lg.lastAlliance, boundSeq: lg.lastSeq,
          boundAt: lg.updatedAt, foreignAt: now, foreignAllianceId: e.claim.allianceId };
        const m = markForeignInTx(tx, { systemId: e.systemId, ...ep });
        if (m.ok) {
          e.episode = { id: m.id, version: m.version, ...ep };
          e.marked = true;
          marked += 1;
        } else {
          e.markRefused = m.reason;
        }
      }
      if (e.episode) {
        const ep = e.episode;
        const c = classifyForeign({ allianceId: ep.allianceId, boundSeq: ep.boundSeq, boundAt: ep.boundAt,
          foreignAt: ep.foreignAt, claim: { allianceId: e.claim.allianceId } }, e.outcomes || [], isModAlliance);
        if (!c.ok) {
          e.invalid = c.reason;
        } else if (c.kind === "RESTORED") {
          const d = deleteEpisodeInTx(tx, e.systemId, ep.version);
          if (d.ok) {
            e.episode = null;
            e.restored = true;
            restored += 1;
          } else {
            e.invalid = d.reason;
          }
        } else {
          e.classification = c;
        }
      }
      if (full && e.candidate && e.outcomes) {
        e.defended = [];
        for (const def of listDefended({ allianceId: lg.lastAlliance, boundAt: lg.updatedAt, outcomes: e.outcomes })) {
          const dk = defendedKey(e.systemId, def.campaignEpoch);
          if (!dk.ok) {
            e.invalidReceipts = (e.invalidReceipts || 0) + 1;
            continue;
          }
          const applied = repository.isApplied(tx, dk.key);
          if (applied.ok && applied.applied) continue;
          e.defended.push({ key: dk.key, def });
        }
      }
    }
    return { ok: true, marked, restored };
  }

  function settleDefended(e, item) {
    const lg = e.row.log;
    const res = store.transaction("sovReconcile.campFact", (tx) => {
      const applied = repository.isApplied(tx, item.key);
      if (!applied.ok) throw new Abort("FAILED", applied.reason);
      if (applied.applied) return { ok: true, duplicate: true };
      const jr = journal.applyOnce(tx, {
        key: item.key,
        aggregate: { type: FACT_AGGREGATE, id: e.systemId },
        eventType: EVENT_DEFENDED,
        payload: { systemId: e.systemId, kind: "DEFENDED", factionId: lg.lastController, allianceId: lg.lastAlliance,
          campaignEpoch: item.def.campaignEpoch, completedAtMs: item.def.completedAtMs },
      }, () => ({ ok: true }));
      if (!jr.ok) throw new Abort("FAILED", jr.reason);
      return { ok: true, duplicate: jr.duplicate === true };
    });
    if (!res.ok) {
      bump("factsFailed");
      logOnce(e.systemId, `defended fact failed: ${res.error instanceof Abort ? res.error.message : res.reason}`);
      return false;
    }
    if (res.value.duplicate) bump("factsDuplicate");
    else bump("defendedProcessed");
    return true;
  }

  function settleFact(e) {
    const systemId = e.systemId;
    const ep = e.episode;
    const kind = e.classification.kind;
    const outcome = e.classification.attackerOutcome || null;
    const fk = factKey(systemId, ep.boundSeq, ep.foreignAt, kind);
    if (!fk.ok) return { ok: false, abortKind: "INVALID", reason: fk.reason };

    const res = store.transaction("sovReconcile.fact", (tx) => {
      const applied = repository.isApplied(tx, fk.key);
      if (!applied.ok) throw new Abort("FAILED", applied.reason);
      if (applied.applied) return { ok: true, outcome: "DUPLICATE", key: fk.key };

      const sys = repository.getSystem(tx, systemId, { includeInfluence: false });
      if (!sys.ok) throw new Abort("FAILED", sys.reason);
      const lg = getLog(tx, systemId);
      if (!lg.ok && lg.reason !== "ROW_NOT_FOUND") throw new Abort("FAILED", lg.reason);
      const logValue = lg.ok ? lg.value : null;
      const now = clock.now();
      const world = sys.system
        ? { controllerFactionId: sys.system.controllerFactionId, occupationState: sys.system.occupationState }
        : null;
      const coreProtected = world && coreOwnerOf(coreIndex, systemId) === world.controllerFactionId && world.controllerFactionId === ep.factionId;
      const plan = planSettlement({
        row: planRowOf(ep, kind),
        logRow: logValue ? logRowOf(logValue.last_seq, logValue.last_alliance) : null,
        world,
        now,
        maxDeferMs: params.maxDeferMs,
        hubLossInfluencePoints: params.hubLossInfluencePoints,
        coreProtected,
      });
      if (!plan.ok) throw new Abort("INVALID", plan.reason);
      if (plan.action === "DEFERRED") return { ok: true, outcome: "DEFERRED" };
      if (plan.action === "STALE") {
        const del = deleteEpisodeInTx(tx, systemId, ep.version);
        if (!del.ok && del.reason !== "ROW_NOT_FOUND") {
          throw new Abort(del.reason === "VERSION_CONFLICT" ? "STALE" : "FAILED", del.reason);
        }
        return { ok: true, outcome: "STALE" };
      }

      const at = Math.min(Math.max(outcome ? outcome.completedAtMs : plan.at, 1), now);
      const points = plan.points || 0;
      let dropped = false;
      let abandoned = false;
      if ((plan.action === "LOSS_APPLIED" || plan.action === "DROP_ONLY") && points > 0) {
        const drop = occupation.dropInfluenceInTx(tx, { systemId, factionId: ep.factionId, points, at,
          reason: "SOV_HUB_LOST" }, `${fk.key}:drop`);
        if (!drop.ok) throw new Abort("FAILED", drop.reason);
        dropped = true;
      }
      if (plan.action === "LOSS_APPLIED") {
        const abandon = occupation.abandonInTx(tx, { systemId, at, factionId: ep.factionId }, `${fk.key}:abandon`);
        if (!abandon.ok) throw new Abort("FAILED", abandon.reason);
        abandoned = true;
      }

      let phaseSeq = logValue.last_seq;
      if (sys.system) {
        const fresh = repository.getSystem(tx, systemId, { includeInfluence: false });
        if (!fresh.ok) throw new Abort("FAILED", fresh.reason);
        if (fresh.system) phaseSeq = fresh.system.phaseSeq;
      }
      const up = upsertLog(tx, {
        systemId, controller: null, alliance: null, corp: null,
        action: plan.action === "REPROJECT" ? LOG_ACTION_REPROJECT : LOG_ACTION_NATIVE_LOSS,
        seq: phaseSeq, expectedVersion: logValue.version, now,
      });
      if (!up.ok) {
        throw new Abort(up.reason === "VERSION_CONFLICT" || up.reason === "STALE_SEQ" ? "STALE" : "FAILED", up.reason);
      }

      const del = deleteEpisodeInTx(tx, systemId, ep.version);
      if (!del.ok) throw new Abort(del.reason === "VERSION_CONFLICT" ? "STALE" : "FAILED", del.reason);

      const jr = journal.applyOnce(tx, {
        key: fk.key,
        aggregate: { type: FACT_AGGREGATE, id: systemId },
        eventType: plan.action === "REPROJECT" ? EVENT_REPROJECT : EVENT_LOSS,
        payload: {
          systemId, kind, factionId: ep.factionId, allianceId: ep.allianceId, boundSeq: ep.boundSeq,
          foreignAt: ep.foreignAt, foreignAllianceId: ep.foreignAllianceId,
          campaignEpoch: outcome ? outcome.campaignEpoch : null, completedAtMs: outcome ? outcome.completedAtMs : null,
        },
      }, () => ({ ok: true }));
      if (!jr.ok) throw new Abort("FAILED", jr.reason === "APPLY_REFUSED" ? (jr.refusal?.reason || jr.reason) : jr.reason);
      return { ok: true, outcome: plan.action, dropped, abandoned, coreProtected: coreProtected && plan.action === "DROP_ONLY" };
    });

    if (!res.ok) {
      const abortKind = res.error instanceof Abort ? res.error.kind : null;
      return { ok: false, abortKind, reason: abortKind ? res.error.message : (res.reason || "TX_FAILED") };
    }
    return res.value;
  }

  function recordFact(e, r) {
    if (!r.ok) {
      if (r.abortKind === "STALE") bump("stale");
      else if (r.abortKind === "INVALID") bump("invalid");
      else bump("factsFailed");
      logOnce(e.systemId, `fact ${r.abortKind || "TX"}: ${r.reason}`);
      return r.abortKind === "STALE" || r.abortKind === "INVALID";
    }
    switch (r.outcome) {
      case "DUPLICATE":
        bump("factsDuplicate");
        bump("duplicateKeyCollision");
        logOnce(e.systemId, "FACT_KEY_COLLISION: key applied, episode remains");
        return true;
      case "DEFERRED":
        e.deferred = true;
        return true;
      case "STALE":
        bump("stale");
        bump("factsStale");
        bump("episodeDeleted");
        e.episode = null;
        return true;
      default:
        bump("factsApplied");
        if (r.dropped) bump("dropApplied");
        if (r.abandoned) bump("abandonApplied");
        if (r.coreProtected) bump("coreProtected");
        bump("logUpserted");
        bump("episodeDeleted");
        bump("journalApplied");
        e.settled = r.outcome;
        e.episode = null;
        return true;
    }
  }

  function runPass() {
    if (inPass || stopped) return { ok: false, reason: inPass ? "IN_PASS" : "STOPPED" };
    inPass = true;
    try {
      bump("passes");
      lastPassAt = clock.now();
      const gates = runGates();
      if (!gates.ok) {
        idleReason = gates.reason;
        seq += 1;
        return gates;
      }
      idleReason = null;

      const now = clock.now();
      const marker = readMarker();
      const full = lastFullAt === null || params.fullPassMs === 0 || now >= lastFullAt + params.fullPassMs
        || (marker.ok && marker.value !== lastUpdatedAt);

      const page = store.transaction("sovReconcile.readPage", (tx) => readPage(tx,
        { afterSystemId: cursor, limit: params.maxRowsPerPass }));
      if (!page.ok || !page.value || page.value.ok !== true) {
        noteRefusal("readPage", page.ok ? page.value?.reason : page.reason);
        return { ok: false, reason: "READ_FAILED" };
      }
      const { rows, nextAfterSystemId } = page.value;
      let clean = true;

      const entries = [];
      for (const row of rows) {
        const candidate = row.log.lastController !== null && row.log.lastAlliance !== null;
        const e = { systemId: row.systemId, row, candidate, episode: row.episode, claim: null, outcomes: null };
        entries.push(e);
        if (!candidate && !row.episode) continue;
        if (isProjecting(row.systemId)) {
          bump("inFlightSkipped");
          e.skipped = true;
          continue;
        }
        const claim = readClaim(row.systemId);
        if (!claim.ok) {
          bump("seamUnavailable");
          logOnce(row.systemId, `claim read: ${claim.reason}`);
          e.skipped = true;
          e.failed = "claim";
          clean = false;
          continue;
        }
        const needOutcomes = row.episode !== null || (candidate && claim.allianceId !== row.log.lastAlliance)
          || (full && candidate);
        if (needOutcomes) {
          const o = readOutcomes(row.systemId);
          if (!o.ok) {
            bump("seamUnavailable");
            logOnce(row.systemId, `receipts read: ${o.reason}`);
            e.skipped = true;
            e.failed = "receipts";
            clean = false;
            continue;
          }
          if (o.truncated) bump("truncated");
          e.outcomes = o.outcomes;
        }
        e.claim = claim;
      }

      const marks = entries.some((e) => e.claim)
        ? store.transaction("sovReconcile.mark", (tx) => markInTx(tx, entries, now, full))
        : { ok: true, value: { ok: true, marked: 0, restored: 0 } };
      if (!marks.ok) {
        noteRefusal("mark", marks.reason);
        logOnce(0, `mark tx failed: ${marks.reason}`);
        bump("failed");
        return { ok: false, reason: "MARK_FAILED" };
      }
      bump("markedForeign", marks.value.marked);
      bump("deletedRestored", marks.value.restored);
      for (const e of entries) {
        if (e.invalid) {
          bump("invalid");
          logOnce(e.systemId, `episode invalid: ${e.invalid}`);
        }
        if (e.invalidReceipts) bump("invalid", e.invalidReceipts);
        if (e.markRefused) {
          bump("invalid");
          logOnce(e.systemId, `mark refused: ${e.markRefused}`);
        }
      }

      for (const e of entries) {
        for (const item of e.defended || []) {
          if (!settleDefended(e, item)) { clean = false; e.failed = "defended"; }
        }
      }

      let applied = 0;
      let deferred = 0;
      for (const e of entries) {
        if (!e.episode || !e.classification) continue;
        const world = e.row.world;
        const coreProtected = world && coreOwnerOf(coreIndex, e.systemId) === world.controllerFactionId && world.controllerFactionId === e.episode.factionId;
        const pre = planSettlement({
          row: planRowOf(e.episode, e.classification.kind),
          logRow: logRowOf(e.row.log.lastSeq, e.row.log.lastAlliance),
          world,
          now,
          maxDeferMs: params.maxDeferMs,
          hubLossInfluencePoints: params.hubLossInfluencePoints,
          coreProtected,
        });
        if (pre.ok && pre.action === "DEFERRED") {
          deferred += 1;
          continue;
        }
        if (applied >= params.maxFactsPerPass) {
          bump("overBudget");
          continue;
        }
        bump("factsPlanned");
        const r = settleFact(e);
        if (!recordFact(e, r)) { clean = false; e.failed = "fact"; }
        if (e.deferred) deferred += 1;
        else if (r.ok) applied += 1;
      }

      setGauge("foreignRows", entries.filter((e) => e.episode).length);
      setGauge("deferredRows", deferred);
      if (rows.length === 0) bump("noForeignRows");

      runNudges(entries);

      const attempted = entries.filter((e) => e.claim || e.failed);
      for (const e of attempted) {
        if (!e.failed) {
          const entry = retryMap.get(e.systemId);
          if (!full && entry && entry.reason === "defended") continue;
          retryMap.delete(e.systemId);
        }
      }
      const failedRows = attempted.filter((e) => e.failed);
      const seamUnavailable = attempted.length >= MIN_ROWS_FOR_SEAM_OUTAGE && failedRows.length === attempted.length
        && failedRows.every((e) => e.failed === "claim" || e.failed === "receipts");
      let gaveUp = 0;
      if (!seamUnavailable && failedRows.length > 0) {
        for (const e of failedRows) {
          let entry = retryMap.get(e.systemId);
          if (!entry) { entry = { count: 0, reason: e.failed }; retryMap.set(e.systemId, entry); }
          entry.count += 1;
          entry.reason = e.failed;
        }
        const allAtLimit = failedRows.every((e) => {
          const entry = retryMap.get(e.systemId);
          return entry && entry.count >= params.maxRowRetries;
        });
        if (allAtLimit) {
          for (const e of failedRows) {
            bump("rowsGivenUp");
            gaveUp += 1;
            logOnce(e.systemId, `gave up after ${params.maxRowRetries} passes: ${e.failed}`);
          }
          cursor = nextAfterSystemId === null ? 0 : nextAfterSystemId;
        }
      }

      if (clean) {
        cursor = nextAfterSystemId === null ? 0 : nextAfterSystemId;
        if (marker.ok) lastUpdatedAt = marker.value;
        if (full) lastFullAt = now;
      }
      return { ok: true, clean, full, rows: rows.length, applied, gaveUp };
    } catch (err) {
      noteRefusal("runPass", messageOf(err));
      bump("failed");
      return { ok: false, reason: "PASS_THREW" };
    } finally {
      inPass = false;
    }
  }

  function runNudges(entries) {
    if (params.maxProjectNudgesPerPass <= 0 || typeof sovProjection.requestProject !== "function") return;
    const claims = new Map();
    const rows = [];
    for (const e of entries) {
      if (e.skipped || e.episode || e.restored) continue;
      const worldController = e.row.world ? e.row.world.controllerFactionId : null;
      let logController = e.row.log.lastController;
      if (e.settled === "REPROJECT") logController = null;
      else if (e.settled) continue;
      if (logController === worldController) continue;
      let claim = e.claim;
      if (!claim) {
        claim = readClaim(e.systemId);
        if (!claim.ok) {
          bump("seamUnavailable");
          logOnce(e.systemId, `claim read: ${claim.reason}`);
          continue;
        }
      }
      claims.set(e.systemId, claim);
      rows.push({ systemId: e.systemId });
    }
    if (rows.length === 0) return;
    const tokens = sovProjection.getStatus()?.budget?.tokens ?? 0;
    const pick = pickNudges({
      rows,
      isProjecting,
      claimOf: (sid) => claims.get(sid),
      isModAlliance,
      tokens,
      max: params.maxProjectNudgesPerPass,
      state: catchupState,
    });
    for (const systemId of pick.nudge) {
      try {
        Promise.resolve(sovProjection.requestProject(systemId))
          .then((r) => bump(r && r.ok ? "nudged" : "nudgeFailed"), () => bump("nudgeFailed"));
      } catch (_err) {
        bump("nudgeFailed");
      }
    }
    if (pick.playerHeld.length > 0) bump("playerHeld", pick.playerHeld.length);
  }

  function start() {
    if (stopped) return { ok: false, reason: "stopped" };
    poller = createPoller({
      runPass,
      intervalMs: params.passMs,
      now: () => clock.now(),
      setTimer: setTimer || defaultSetTimer,
      onError: (err) => { noteRefusal("poller", messageOf(err)); bump("failed"); },
    });
    const res = poller.start();
    if (!res.ok) return res;
    log("[sovReconcile] started");
    return { ok: true };
  }

  function stop(reason) {
    if (stopped) return;
    stopped = true;
    if (poller) poller.stop();
    log(`[sovReconcile] stopped: ${reason || "unknown"}`);
  }

  function getStatus() {
    return Object.freeze({
      state: stopped ? STATE_STOPPED : (idleReason ? STATE_IDLE : STATE_READY),
      reason: stopped ? "stopped" : idleReason,
      seq,
      passes: counters.passes,
      lastPassAt,
      lastUpdatedAt,
      cursor,
      foreignRows: counters.foreignRows,
      deferredRows: counters.deferredRows,
      lastError,
      counters: Object.freeze({ ...counters }),
    });
  }

  function count(name, n = 1) {
    bump(name, n);
  }

  return Object.freeze({
    start,
    stop,
    getStatus,
    count,
    runPass,
    params,
    isStopped: () => stopped,
  });
}

module.exports = { createSovReconcileService, createUnavailableSovReconcile, Abort, COUNTER_NAMES, PARAM_KEYS };
