"use strict";

const { performance } = require("node:perf_hooks");
const S = require("../schema");
const { HULL_GROUPS, parseHullGroupList } = require("../../fleets/schema");
const { decideCompletion, waitOrTimeout, ACTION } = require("./jobMachine");
const { nextReconcileKey } = require("../reconcileSlots");
const { scaleAdvanced } = require("../extraction/demand");
const { capitalPermilleOf, recipeParamsOf } = require("./recipes");

const STATION_MODE_READY = "ready";
const ONLINE = "ONLINE";
const DESTROYED = "DESTROYED";
const STOCK_FULL_REASONS = Object.freeze(["STOCK_CAP", "STOCK_ITEMS_LIMIT"]);
const MAX_DETAIL = 120;
const MS_DECIMALS = 100;
const COUNTER_NAMES = Object.freeze(["started", "hullsStarted", "delivered", "hullsDelivered", "mineralsConsumed",
  "lost", "waits", "stale", "stockRefused", "reconciled", "reconcileExhausted", "pruned", "startRefused",
  "ladderProduce", "ladderReserveSet",
  "ladderOverRoom", "ladderFeeUnreachable",
  "advancedConsumed", "advancedShort", "advancedRefused"]);
const PERMILLE = 1000;
const UPWELL = "upwell";
const ADVANCED_KINDS = Object.freeze(["moon", "pi"]);
const DUE_KEYS = Object.freeze(["jobId", "round"]);
const SAVEPOINT_ABORT = Symbol("production-savepoint-abort");

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isText = (v) => typeof v === "string" && v.length >= 1 && v.length <= S.MAX_ID_LENGTH;
const messageOf = (err) => String((err && err.message) || err).slice(0, MAX_DETAIL);

function call(fn, fallback) {
  try {
    return fn();
  } catch (_err) {
    return fallback;
  }
}

function parsePayload(p) {
  if (!p || typeof p !== "object" || Array.isArray(p)) return null;
  if (Object.keys(p).sort().join() !== DUE_KEYS.join()) return null;
  if (!isText(p.jobId) || !isTime(p.round)) return null;
  return { jobId: p.jobId, round: p.round };
}

function createProductionService(deps) {
  const { store, jobs, scheduler, recipes, clock, ids, config } = deps;
  const P = config.production;
  const X = config.extraction || {};
  const maxDeltas = config.stations && isId(config.stations.maxDeltasPerChange) ? config.stations.maxDeltasPerChange
    : Number.MAX_SAFE_INTEGER;
  const maxQuantity = config.stations && isId(config.stations.maxStockQuantity) ? config.stations.maxStockQuantity
    : Number.MAX_SAFE_INTEGER;
  const fuelAsked = X.fuelEnabled === true;
  const recipeParams = recipeParamsOf(P);
  const advanced = deps.commodities && P.advancedInputsEnabled === true && isId(P.advancedInputsPermille)
    ? Object.freeze({ mode: P.advancedInputsMode === "required" ? "required" : "optional",
      billOf: (group, runs) => scaleAdvanced(deps.commodities, group, runs, P.advancedInputsPermille,
        call(() => capitalPermilleOf(group, recipeParams), PERMILLE)) })
    : null;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
  const telemetry = deps.telemetry || null;
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
  const machineParams = Object.freeze({ maxWaitRounds: P.maxWaitRounds });
  const freeHullGroups = Object.freeze(parseHullGroupList(P.freeHullGroups) || []);
  const counters = Object.fromEntries(COUNTER_NAMES.map((n) => [n, 0]));
  let state = "ready";
  let lastRefusal = null;
  let seq = 0;

  function metric(kind, name, value) {
    if (!telemetry || typeof telemetry[kind] !== "function") return;
    try {
      telemetry[kind](name, value);
    } catch (_err) {
    }
  }

  function bump(name, n = 1) {
    if (!(n > 0) || !Object.prototype.hasOwnProperty.call(counters, name)) return;
    counters[name] += n;
    seq += 1;
    metric("count", `production.${name}`, n);
  }

  function log(line) {
    try {
      logger.log(line);
    } catch (_err) {
    }
  }

  function stationsNow() {
    const st = typeof deps.getStations === "function" ? call(deps.getStations, null) : null;
    const mode = st && typeof st.getMode === "function" ? call(() => st.getMode(), "off") : "off";
    return { mode, repository: mode === STATION_MODE_READY && st ? st.repository : null };
  }

  function linesOf(kind) {
    if (kind === "npc") return P.linesPerNpcStation;
    if (kind === "upwell") return P.linesPerUpwellStation;
    return 0;
  }

  function unfueledOf(tx, stationIds, at) {
    if (!fuelAsked || stationIds.length === 0) return null;
    const ext = typeof deps.getExtraction === "function" ? call(deps.getExtraction, null) : null;
    if (!ext || typeof ext.fuelledOf !== "function") return null;
    const r = call(() => ext.fuelledOf(tx, stationIds, at), null);
    if (!r || r.ok !== true || r.enforced !== true || !(r.fuelled instanceof Set)) return null;
    return new Set(stationIds.filter((id) => !r.fuelled.has(id)));
  }

  function linesWithFuel(stationId, kind, unfueled) {
    const lines = linesOf(kind);
    if (kind !== UPWELL || !unfueled || !unfueled.has(stationId)) return lines;
    return Math.floor((lines * X.unfueledLinesPermille) / PERMILLE);
  }

  const savepoints = new WeakMap();
  function inSavepoint(tx, fn) {
    let run = savepoints.get(tx);
    if (!run) {
      run = tx.transaction((body, holder) => {
        const r = body();
        if (!r || r.ok !== true) {
          holder.refusal = r || { ok: false, reason: "PRODUCTION_FAILED" };
          throw SAVEPOINT_ABORT;
        }
        return r;
      });
      savepoints.set(tx, run);
    }
    const holder = { refusal: null };
    try {
      return run(fn, holder);
    } catch (err) {
      if (err === SAVEPOINT_ABORT && tx.inTransaction === true) return holder.refusal;
      throw err;
    }
  }

  function enqueueDue(tx, jobId, round, dueAt) {
    const r = scheduler.enqueue(S.PRODUCTION_EVENT_TYPE, jobId, dueAt, { jobId, round }, S.jobDueKey(jobId, round),
      { tx, chained: true });
    if (!r || r.ok !== true) return { ok: false, reason: (r && r.reason) || "ENQUEUE_FAILED", stage: "deadline" };
    return { ok: true };
  }

  function slotJobsOfFaction(tx, factionId) {
    const limit = P.maxActiveJobsPerFaction + P.reconcileMaxJobs;
    const listed = jobs.listActiveOfFaction(tx, factionId, limit);
    if (!listed.ok) return listed;
    const repo = stationsNow().repository;
    let unlisted = 0;
    if (listed.jobs.length >= limit) {
      const all = jobs.countActiveOfFaction(tx, factionId);
      if (!all.ok) return all;
      unlisted = Math.max(0, all.count - listed.jobs.length);
    }
    if (!repo) return { ok: true, jobs: listed.jobs, count: listed.jobs.length + unlisted };
    const holds = new Map();
    const kept = [];
    for (const j of listed.jobs) {
      if (!holds.has(j.stationId)) {
        const g = repo.getStation(tx, j.stationId);
        if (!g.ok) return g;
        const s = g.record;
        holds.set(j.stationId, Boolean(s) && s.state !== DESTROYED && s.ownerFactionId === factionId);
      }
      if (holds.get(j.stationId)) kept.push(j);
    }
    return { ok: true, jobs: kept, count: kept.length + unlisted };
  }

  function readStationState(tx, factionId, stations, opts) {
    if (state === "stopped") return { ok: false, reason: "PRODUCTION_UNAVAILABLE" };
    if (!tx || tx.inTransaction !== true) return { ok: false, reason: "TX_REQUIRED" };
    if (!isId(factionId) || !Array.isArray(stations)) return { ok: false, reason: "INVALID_INPUT" };
    const listed = slotJobsOfFaction(tx, factionId);
    if (!listed.ok) return listed;
    const byStation = new Map();
    const inProduction = {};
    for (const j of listed.jobs) {
      if (!byStation.has(j.stationId)) byStation.set(j.stationId, []);
      byStation.get(j.stationId).push({ jobId: j.jobId, hullGroup: j.hullGroup, runs: j.runs, dueAt: j.dueAt,
        waitRound: j.waitRound });
      inProduction[j.hullGroup] = (inProduction[j.hullGroup] || 0) + j.runs;
    }
    const unfueled = fuelAsked ? unfueledOf(tx, stations.filter((s) => s && s.kind === UPWELL)
      .map((s) => s.stationId), opts && isTime(opts.at) ? opts.at : clock.now()) : null;
    return { ok: true, stations: stations.map((s) => ({ stationId: s.stationId,
      lines: linesWithFuel(s.stationId, s.kind, unfueled), activeJobs: byStation.get(s.stationId) || [] })),
    inProduction, activeJobsTotal: listed.count };
  }

  function activeGroupsByStation(tx, factionId) {
    if (state === "stopped") return { ok: false, reason: "PRODUCTION_UNAVAILABLE" };
    if (!tx || tx.inTransaction !== true) return { ok: false, reason: "TX_REQUIRED" };
    if (!isId(factionId)) return { ok: false, reason: "INVALID_INPUT" };
    const listed = jobs.listActiveOfFaction(tx, factionId, P.maxActiveJobsPerFaction);
    if (!listed || listed.ok !== true) return listed || { ok: false, reason: "JOBS_READ_FAILED" };
    const sets = new Map();
    for (const j of listed.jobs) {
      if (!sets.has(j.stationId)) sets.set(j.stationId, new Set());
      sets.get(j.stationId).add(j.hullGroup);
    }
    const byStation = new Map();
    for (const [id, set] of sets) byStation.set(id, [...set].sort());
    return { ok: true, byStation };
  }

  function advancedTake(tx, repository, stationId, need) {
    let have = null;
    const any = ADVANCED_KINDS.some((k) => need[k].size > 0);
    if (any && advanced.mode === "optional") {
      const s = repository.getStock(tx, stationId);
      if (!s || s.ok !== true) return s || { ok: false, reason: "STOCK_READ_FAILED" };
      have = new Map(s.items.map((it) => [`${it.itemKind}|${it.itemKey}`, it.quantity]));
    }
    const take = [];
    let units = 0;
    let short = 0;
    for (const kind of ADVANCED_KINDS) {
      for (const [typeId, n] of need[kind]) {
        const itemKey = `type:${typeId}`;
        let t = n;
        if (have) t = Math.min(n, have.get(`${kind}|${itemKey}`) || 0);
        else if (n > maxQuantity) return { ok: false, reason: "INSUFFICIENT_STOCK", itemKind: kind, itemKey, need: n };
        short += n - t;
        if (t <= 0) continue;
        units += t;
        take.push({ itemKind: kind, itemKey, delta: -t });
      }
    }
    take.sort((a, b) => (a.itemKind < b.itemKind ? -1 : a.itemKind > b.itemKind ? 1
      : a.itemKey < b.itemKey ? -1 : a.itemKey > b.itemKey ? 1 : 0));
    return { ok: true, take, units, short };
  }

  function startJobInTx(tx, spec, idempotencyKey) {
    if (state === "stopped") return { ok: false, reason: "PRODUCTION_UNAVAILABLE", detail: "stopped" };
    if (!tx || tx.inTransaction !== true) return { ok: false, reason: "TX_REQUIRED" };
    if (!spec || !isId(spec.factionId) || !isText(spec.stationId) || typeof spec.hullGroup !== "string"
      || !isTime(spec.at) || typeof idempotencyKey !== "string" || idempotencyKey.length < 1
      || idempotencyKey.length > S.MAX_KEY_LENGTH - 10) {
      return { ok: false, reason: "INVALID_INPUT" };
    }
    const jobKey = `${idempotencyKey}:job`;
    const earlier = jobs.jobIdOfKey(tx, jobKey);
    if (!earlier.ok) return earlier;
    if (earlier.duplicate) {
      const j = jobs.getJob(tx, earlier.jobId);
      if (!j.ok) return j;
      return { ok: true, duplicate: true, jobId: earlier.jobId, dueAt: j.job ? j.job.dueAt : null };
    }
    if (spec.recipesVersion !== undefined && spec.recipesVersion !== recipes.version) {
      return { ok: false, reason: "RECIPES_CHANGED", expected: spec.recipesVersion, actual: recipes.version };
    }
    if (!HULL_GROUPS.includes(spec.hullGroup)) return { ok: false, reason: "UNKNOWN_HULL_GROUP" };
    if (freeHullGroups.includes(spec.hullGroup)) return { ok: false, reason: "FREE_HULL_GROUP" };
    if (!Number.isSafeInteger(spec.runs) || spec.runs < 1 || spec.runs > P.maxRunsPerJob) {
      return { ok: false, reason: "RUNS_INVALID" };
    }
    const recipe = recipes.lookup(spec.hullGroup);
    if (!recipe) return { ok: false, reason: "NOT_BUILDABLE" };
    const st = stationsNow();
    if (!st.repository) return { ok: false, reason: "STATIONS_NOT_READY" };
    const g = st.repository.getStation(tx, spec.stationId);
    if (!g.ok) return g;
    const station = g.record;
    if (!station) return { ok: false, reason: "STATION_NOT_FOUND" };
    if (station.ownerFactionId !== spec.factionId) return { ok: false, reason: "STATION_NOT_OWNED" };
    if (station.state !== ONLINE) return { ok: false, reason: "STATION_NOT_ONLINE", state: station.state };
    const atStation = jobs.countActiveAtStation(tx, spec.stationId, station.ownerFactionId);
    if (!atStation.ok) return atStation;
    const unfueled = station.kind === UPWELL ? unfueledOf(tx, [spec.stationId], spec.at) : null;
    if (atStation.count >= linesWithFuel(spec.stationId, station.kind, unfueled)) {
      return { ok: false, reason: "NO_FREE_LINE" };
    }
    const ofFaction = slotJobsOfFaction(tx, spec.factionId);
    if (!ofFaction.ok) return ofFaction;
    if (ofFaction.count >= P.maxActiveJobsPerFaction) return { ok: false, reason: "FACTION_JOB_LIMIT" };
    const bill = recipes.billFor(spec.hullGroup, spec.runs);
    const jobId = ids.next("pj");
    const at = spec.at;
    const dueAt = at + spec.runs * recipe.runMs;
    const keys = Object.keys(bill).sort();
    const minerals = keys.reduce((n, k) => n + bill[k], 0);
    const mineralDeltas = keys.map((k) => ({ itemKind: S.MINERAL_ITEM_KIND, itemKey: k, delta: -bill[k] }));
    let adv = null;
    if (advanced) {
      adv = advancedTake(tx, st.repository, spec.stationId, advanced.billOf(spec.hullGroup, spec.runs));
      if (!adv.ok) return adv;
    }
    const all = adv ? [...mineralDeltas, ...adv.take] : mineralDeltas;
    const chunks = [];
    if (!adv) chunks.push(mineralDeltas);
    else for (let i = 0; i < all.length; i += maxDeltas) chunks.push(all.slice(i, i + maxDeltas));
    return inSavepoint(tx, () => {
      for (let i = 0; i < chunks.length; i += 1) {
        const key = i === 0 ? S.consumeKey(jobId) : S.consumeChunkKey(jobId, i);
        const stock = st.repository.applyStockChange(tx, { stationId: spec.stationId, key,
          reason: S.PRODUCTION_REASON, at, deltas: chunks[i] });
        if (!stock.ok) return { ...stock, stage: "consume" };
        if (stock.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", detail: key };
      }
      const created = jobs.createJob(tx, { jobId, idempotencyKey, factionId: spec.factionId,
        stationId: spec.stationId, systemId: station.systemId, hullGroup: spec.hullGroup,
        itemKey: `group:${spec.hullGroup}`, runs: spec.runs, recipesVersion: recipes.version, consumed: bill,
        runMs: recipe.runMs, startedAt: at, dueAt }, jobKey);
      if (!created.ok) return created;
      if (created.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", detail: jobKey };
      const pruned = jobs.prune(tx, spec.factionId, Math.max(0, at - P.jobRetentionMs), P.pruneBatch);
      if (!pruned.ok) return pruned;
      const ev = enqueueDue(tx, jobId, 0, dueAt);
      if (!ev.ok) return ev;
      const done = { ok: true, duplicate: false, jobId, dueAt, runs: spec.runs, minerals, pruned: pruned.pruned };
      if (adv) {
        done.advanced = adv.units;
        if (advanced.mode === "optional") done.advancedShort = adv.short;
      }
      return done;
    });
  }

  function waitInTx(tx, job, at, key, out) {
    const round = job.waitRound + 1;
    const w = jobs.waitJob(tx, { jobId: job.jobId, expectedVersion: job.version, waitRound: round }, `${key}:wait`);
    if (!w.ok) return w;
    out.waitRound = round;
    return enqueueDue(tx, job.jobId, round, at + P.waitRecheckMs);
  }

  function loseInTx(tx, job, at, reason, key) {
    return jobs.endJob(tx, { jobId: job.jobId, expectedVersion: job.version, to: S.JOB_LOST, endedAt: at,
      endReason: reason, totals: { jobsLost: 1, hullsLost: job.runs } }, `${key}:job`);
  }

  function step(tx, ev, p) {
    const out = { action: ACTION.STALE, reason: null, jobId: p.jobId };
    const key = ev.idempotencyKey;
    const at = ev.dueAt;
    const j = jobs.getJob(tx, p.jobId);
    if (!j.ok) return j;
    const job = j.job;
    if (!job || job.state !== S.JOB_ACTIVE || job.waitRound !== p.round) return { ok: true, ...out };
    const st = stationsNow();
    if (!st.repository) return { ok: false, reason: "STATIONS_NOT_READY" };
    const g = st.repository.getStation(tx, job.stationId);
    if (!g.ok) return g;
    let d = decideCompletion(job, g.record, { round: p.round }, machineParams);
    Object.assign(out, { factionId: job.factionId, hullGroup: job.hullGroup, runs: job.runs });
    if (d.action === ACTION.DELIVER) {
      const r = inSavepoint(tx, () => {
        const stock = st.repository.applyStockChange(tx, { stationId: job.stationId, key: S.deliverKey(job.jobId),
          reason: S.PRODUCTION_DELIVERY_REASON, at, deltas: [{ itemKind: S.HULL_ITEM_KIND, itemKey: job.itemKey,
            delta: job.runs }] });
        if (!stock.ok) return { ...stock, stage: "deliver" };
        const e = jobs.endJob(tx, { jobId: job.jobId, expectedVersion: job.version, to: S.JOB_DELIVERED,
          endedAt: at, endReason: "DELIVERED", totals: { jobsDelivered: 1, hullsDelivered: job.runs } },
        `${key}:job`);
        if (!e.ok) return e;
        return { ok: true };
      });
      if (r.ok) {
        out.action = ACTION.DELIVER;
        return { ok: true, ...out };
      }
      if (!STOCK_FULL_REASONS.includes(r.reason)) return r;
      out.stockRefused = true;
      d = waitOrTimeout(job, machineParams, r.reason);
    }
    out.action = d.action;
    out.reason = d.reason || null;
    if (d.action === ACTION.WAIT) {
      const w = waitInTx(tx, job, at, key, out);
      return w.ok ? { ok: true, ...out } : w;
    }
    if (d.action === ACTION.LOSE) {
      const e = loseInTx(tx, job, at, d.reason, key);
      return e.ok ? { ok: true, ...out } : e;
    }
    return { ok: true, ...out };
  }

  function onCommitted(v) {
    if (!v || v.ok !== true) return;
    switch (v.action) {
      case ACTION.STALE: bump("stale"); break;
      case ACTION.WAIT: bump("waits"); break;
      case ACTION.DELIVER:
        bump("delivered");
        bump("hullsDelivered", v.runs || 0);
        break;
      case ACTION.LOSE:
        bump("lost");
        log(`production: job ${v.jobId} of ${v.factionId} LOST ${v.reason} ${v.hullGroup} x${v.runs}`);
        break;
      default: break;
    }
    if (v.stockRefused) bump("stockRefused");
  }

  function handler(ev) {
    try {
      const p = parsePayload(ev && ev.payload);
      if (!p) return { ok: false, reason: "PRODUCTION_PAYLOAD_INVALID", permanent: true };
      if (state === "stopped") return { ok: false, reason: "PRODUCTION_STOPPED" };
      const t0 = nowMs();
      return { ok: true, outcome: "STEP", effect: (tx) => {
        const r = step(tx, ev, p);
        metric("observe", "production.stepMs", Math.round((nowMs() - t0) * MS_DECIMALS) / MS_DECIMALS);
        if (!r || r.ok !== true) lastRefusal = String((r && r.reason) || "STEP_FAILED");
        return r;
      }, onCommitted };
    } catch (err) {
      return { ok: false, reason: `PRODUCTION_STEP_FAILED: ${messageOf(err)}` };
    }
  }

  function reconcile() {
    try {
      const listed = store.transaction("production.reconcileRead", (db) => jobs.listActive(db,
        { limit: P.reconcileMaxJobs }));
      const r = listed.ok ? listed.value : listed;
      if (!r || !r.ok) return { ok: false, reason: (r && r.reason) || "TX_FAILED" };
      let enqueued = 0;
      let exhausted = 0;
      const now = clock.now();
      for (const j of r.jobs) {
        const slot = nextReconcileKey(scheduler, { dueKey: S.jobDueKey(j.jobId, j.waitRound),
          baseKey: S.jobReconcileKey(j.jobId, j.waitRound), maxAttempts: P.reconcileMaxAttempts });
        if (!slot.ok) return slot;
        if (slot.open) continue;
        if (slot.exhausted) {
          exhausted += 1;
          log(`production: reconcile ${j.jobId} exhausted ${P.reconcileMaxAttempts} attempts`);
          continue;
        }
        const e = scheduler.enqueue(S.PRODUCTION_EVENT_TYPE, j.jobId, Math.max(now, j.dueAt),
          { jobId: j.jobId, round: j.waitRound }, slot.key);
        if (e && e.ok && !e.duplicate) enqueued += 1;
        else if (!e || !e.ok) log(`production: reconcile ${j.jobId} refused ${(e && e.reason) || "?"}`);
      }
      bump("reconciled", enqueued);
      bump("reconcileExhausted", exhausted);
      return { ok: true, open: r.jobs.length, enqueued, exhausted };
    } catch (err) {
      return { ok: false, reason: `RECONCILE_FAILED: ${messageOf(err)}` };
    }
  }

  return Object.freeze({
    getMode: () => (state === "stopped" ? "off" : state),
    getRecipes: () => recipes,
    linesOf,
    readStationState,
    activeGroupsByStation,
    getAdvanced: () => advanced,
    startJobInTx,
    handler,
    reconcile,
    count: (name, n = 1) => bump(name, n),
    noteRefusal: (reason) => { lastRefusal = String(reason); },
    getStatus: () => Object.freeze({ state, seq, counters: Object.freeze({ ...counters }), lastRefusal,
      recipesVersion: recipes.version }),
    stop() {
      state = "stopped";
      seq += 1;
    },
    isStopped: () => state === "stopped",
  });
}

module.exports = { createProductionService, parsePayload, COUNTER_NAMES };
