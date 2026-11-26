"use strict";

const { performance } = require("node:perf_hooks");
const { KIND_APPLY } = require("../../persistence/journal");
const { BUSY_STATES } = require("../../world/occupation/schema");
const { nextReconcileKey } = require("../../economy/reconcileSlots");
const { stationCorporationOf } = require("../stationSeed");
const S = require("./schema");
const { ACTION, decideBuildStep } = require("./buildMachine");

const STATION_MODE_READY = "ready";
const STATION_ANCHORING = "ANCHORING";
const STATION_ONLINE = "ONLINE";
const MAX_DETAIL = 120;
const MS_DECIMALS = 100;
const COUNTER_NAMES = Object.freeze(["planned", "received", "receivedUnits", "anchored", "completed", "cancelled",
  "failed", "convoysLost", "waits", "stale", "reconciled", "reconcileExhausted"]);
const DUE_KEYS = Object.freeze(["phaseSeq", "round", "stationId"]);
const SITE_REFUSALS = Object.freeze(["SYSTEM_STATION_LIMIT", "SYSTEM_FACTION_STATION_LIMIT", "FACTION_STATION_LIMIT",
  "STATION_LIMIT", "UNKNOWN_FACTION", "STATION_EXISTS"]);
const SAVEPOINT_ABORT = Symbol("construction-savepoint-abort");

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isText = (v, max = S.MAX_ID_LENGTH) => typeof v === "string" && v.length >= 1 && v.length <= max;
const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const messageOf = (err) => String((err && err.message) || err).slice(0, MAX_DETAIL);
const unitsOf = (cargo) => Object.keys(cargo || {}).reduce((n, k) => n + Math.max(0, Number(cargo[k]) || 0), 0);

function call(fn, fallback) {
  try {
    return fn();
  } catch (_err) {
    return fallback;
  }
}

function parsePayload(p) {
  if (!isPlain(p) || Object.keys(p).sort().join() !== DUE_KEYS.join()) return null;
  if (!isText(p.stationId) || !isTime(p.phaseSeq) || !isTime(p.round)) return null;
  return { stationId: p.stationId, phaseSeq: p.phaseSeq, round: p.round };
}

function toDeltas(cargo) {
  return Object.keys(cargo).sort().filter((k) => cargo[k] > 0).map((k) => {
    const slash = k.indexOf("/");
    return { itemKind: k.slice(0, slash), itemKey: k.slice(slash + 1), delta: cargo[k] };
  });
}

function receiveOf(required, deliveredBefore, cargo) {
  const delivered = { ...(deliveredBefore || {}) };
  let acceptedUnits = 0;
  let surplusUnits = 0;
  for (const k of Object.keys(cargo).sort()) {
    const have = delivered[k] || 0;
    const accepted = Math.min(cargo[k], Math.max(0, (required[k] || 0) - have));
    acceptedUnits += accepted;
    surplusUnits += cargo[k] - accepted;
    delivered[k] = have + cargo[k];
  }
  const complete = Object.keys(required).every((k) => (delivered[k] || 0) >= required[k]);
  const surplus = {};
  for (const k of Object.keys(delivered).sort()) {
    const extra = delivered[k] - (required[k] || 0);
    if (extra > 0) surplus[k] = extra;
  }
  return { delivered, acceptedUnits, surplusUnits, complete, surplus };
}

function createConstructionService(deps) {
  const { store, journal, builds, scheduler, worldRepository, registry, kits, clock, ids, config } = deps;
  const C = config.construction;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
  const telemetry = deps.telemetry || null;
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
  const machineParams = Object.freeze({ recheckMs: C.recheckMs });
  const counters = Object.fromEntries(COUNTER_NAMES.map((n) => [n, 0]));
  let state = "ready";
  let lastRefusal = null;
  let seq = 0;
  const ownKit = kits && own(kits, C.kitId) ? kits[C.kitId] : null;
  const kitUnits = ownKit && ownKit.items ? Object.values(ownKit.items).reduce((a, b) => a + b, 0) : null;
  const kitFactorPermille = ownKit && Number.isSafeInteger(ownKit.factorPermille) ? ownKit.factorPermille : null;

  function metric(kind, name, value) {
    if (!telemetry || typeof telemetry[kind] !== "function") return;
    try {
      telemetry[kind](name, value);
    } catch (_err) {
    }
  }

  function bump(name, n = 1) {
    if (!(n > 0) || !own(counters, name)) return;
    counters[name] += n;
    seq += 1;
    metric("count", `strategy.construction.${name}`, n);
  }

  function log(line) {
    try {
      logger.log(line);
    } catch (_err) {
    }
  }

  const stopped = () => state === "stopped";

  function stationsNow() {
    const st = typeof deps.getStations === "function" ? call(deps.getStations, null) : null;
    const mode = st && typeof st.getMode === "function" ? call(() => st.getMode(), "off") : "off";
    return { mode, repository: mode === STATION_MODE_READY && st ? st.repository : null };
  }

  function getMode() {
    if (stopped()) return "off";
    const mode = stationsNow().mode;
    return mode === STATION_MODE_READY || mode === "pending" ? mode : "off";
  }

  function getKit(kitId) {
    if (typeof kitId !== "string" || !own(kits, kitId)) return null;
    const k = kits[kitId];
    return { kitId, kind: k.kind, structureFamily: k.structureFamily, typeId: k.typeId, items: { ...k.items } };
  }

  const isActive = (factionId) => call(() => registry.isActive(factionId) === true, false);
  const corporationOf = (factionId) => call(() => {
    const faction = registry.getFaction(factionId);
    return faction ? stationCorporationOf(registry, faction) : null;
  }, null);

  const savepoints = new WeakMap();
  function inSavepoint(tx, fn) {
    let run = savepoints.get(tx);
    if (!run) {
      run = tx.transaction((body, holder) => {
        const r = body();
        if (!r || r.ok !== true) {
          holder.refusal = r || { ok: false, reason: "CONSTRUCTION_FAILED" };
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

  function enqueueDue(tx, stationId, phaseSeq, round, dueAt) {
    const r = scheduler.enqueue(S.BUILD_EVENT_TYPE, stationId, dueAt, { stationId, phaseSeq, round },
      S.buildDueKey(stationId, phaseSeq, round), { tx, chained: true });
    if (!r || r.ok !== true) return { ok: false, reason: (r && r.reason) || "ENQUEUE_FAILED", stage: "deadline" };
    return { ok: true };
  }

  function checkSite(tx, repository, factionId, systemId, self) {
    if (!isActive(factionId)) return { ok: true, good: false, reason: "FACTION_PASSIVE" };
    const w = worldRepository.getSystems(tx, [systemId], { includeInfluence: false });
    if (!w || w.ok !== true) return w || { ok: false, reason: "WORLD_READ_FAILED" };
    const sys = w.systems.find((x) => x.systemId === systemId) || null;
    if (!sys || sys.controllerFactionId !== factionId) return { ok: true, good: false, reason: "SITE_NOT_OWN" };
    if (BUSY_STATES.includes(sys.occupationState)) return { ok: true, good: false, reason: "SITE_BUSY" };
    const live = repository.liveCounts(tx, systemId, factionId);
    if (!live || live.ok !== true) return live || { ok: false, reason: "STATIONS_READ_FAILED" };
    const minus = self ? 1 : 0;
    const supplying = {};
    for (const [name, opts] of [["inSystem", { systemId }], ["inSystemOfFaction", { factionId, systemId }],
      ["ofFaction", { factionId }], ["all", {}]]) {
      const c = builds.countOpen(tx, { ...opts, states: [S.SUPPLYING] });
      if (!c.ok) return c;
      supplying[name] = Math.max(0, c.count - minus);
    }
    const L = repository.limits;
    const n = (name) => live[name] + supplying[name];
    if (n("inSystem") >= L.maxPerSystem) return { ok: true, good: false, reason: "SYSTEM_STATION_LIMIT" };
    if (n("inSystemOfFaction") >= L.maxPerSystemPerFaction) {
      return { ok: true, good: false, reason: "SYSTEM_FACTION_STATION_LIMIT" };
    }
    if (n("ofFaction") >= L.maxPerFaction) return { ok: true, good: false, reason: "FACTION_STATION_LIMIT" };
    if (n("all") >= L.maxStations) return { ok: true, good: false, reason: "STATION_LIMIT" };
    return { ok: true, good: true, reason: null };
  }

  function planInTx(tx, spec, key) {
    if (stopped()) return { ok: false, reason: "CONSTRUCTION_UNAVAILABLE", detail: "stopped" };
    if (!tx || tx.inTransaction !== true) return { ok: false, reason: "TX_REQUIRED" };
    if (!isPlain(spec) || !isId(spec.factionId) || !isId(spec.systemId) || !isText(spec.kitId, S.MAX_KIT_ID_LENGTH)
      || !isTime(spec.at) || !isText(key, S.MAX_KEY_LENGTH - S.KEY_SUFFIX_RESERVE)) {
      return { ok: false, reason: "INVALID_INPUT" };
    }
    const bkey = S.buildKey(key);
    const earlier = builds.buildIdOfKey(tx, bkey);
    if (!earlier.ok) return earlier;
    if (earlier.duplicate) {
      const b = builds.getBuild(tx, earlier.stationId);
      if (!b.ok) return b;
      return { ok: true, kind: "plan", duplicate: true, stationId: earlier.stationId,
        state: b.build ? b.build.state : null };
    }
    const kit = getKit(spec.kitId);
    if (!kit) return { ok: false, reason: "UNKNOWN_KIT" };
    if (!isActive(spec.factionId) || corporationOf(spec.factionId) === null) {
      return { ok: false, reason: "UNKNOWN_FACTION" };
    }
    const st = stationsNow();
    if (!st.repository) return { ok: false, reason: "STATIONS_NOT_READY" };
    const here = builds.countOpen(tx, { factionId: spec.factionId, systemId: spec.systemId });
    if (!here.ok) return here;
    if (here.count > 0) return { ok: false, reason: "BUILD_OPEN_IN_SYSTEM" };
    const site = checkSite(tx, st.repository, spec.factionId, spec.systemId, false);
    if (!site.ok) return site;
    if (!site.good) return { ok: false, reason: site.reason };
    const mine = builds.countOpen(tx, { factionId: spec.factionId });
    if (!mine.ok) return mine;
    if (mine.count >= C.maxOpenBuildsPerFaction) return { ok: false, reason: "BUILD_LIMIT" };
    const total = builds.countOpen(tx, {});
    if (!total.ok) return total;
    if (total.count >= C.maxOpenBuildsTotal) return { ok: false, reason: "BUILD_LIMIT_TOTAL" };
    const liveAll = st.repository.countLiveAll(tx);
    if (!liveAll || liveAll.ok !== true) return liveAll || { ok: false, reason: "STATIONS_READ_FAILED" };
    const supplyingAll = builds.countOpen(tx, { states: [S.SUPPLYING] });
    if (!supplyingAll.ok) return supplyingAll;
    if (liveAll.count + supplyingAll.count >= C.maxLiveStationsTotal) {
      return { ok: false, reason: "GLOBAL_STATION_LIMIT" };
    }
    const stationId = ids.next("st");
    const at = spec.at;
    const supplyDeadlineAt = at + C.supplyTimeoutMs;
    return inSavepoint(tx, () => {
      const created = builds.createBuild(tx, { stationId, idempotencyKey: bkey, factionId: spec.factionId,
        systemId: spec.systemId, kitId: kit.kitId, required: kit.items, supplyDeadlineAt, at }, bkey);
      if (!created.ok) return created;
      if (created.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", detail: bkey };
      const ev = enqueueDue(tx, stationId, 0, 0, Math.min(supplyDeadlineAt, at + C.recheckMs));
      if (!ev.ok) return ev;
      return { ok: true, kind: "plan", duplicate: false, stationId, state: S.SUPPLYING };
    });
  }

  function siteOfInTx(tx, stationId, factionId) {
    if (stopped()) return { ok: false, reason: "CONSTRUCTION_UNAVAILABLE", detail: "stopped" };
    if (!tx || tx.inTransaction !== true) return { ok: false, reason: "TX_REQUIRED" };
    if (!isText(stationId) || !isId(factionId)) return { ok: false, reason: "INVALID_INPUT" };
    const b = builds.getBuild(tx, stationId);
    if (!b.ok) return b;
    const build = b.build;
    if (!build) return { ok: true, isSite: false };
    const site = (good, reason) => ({ ok: true, isSite: true, systemId: build.systemId, good, reason, build });
    if (build.factionId !== factionId) return site(false, "FOREIGN_BUILD");
    if (build.state !== S.SUPPLYING) return site(false, `BUILD_${build.state}`);
    const st = stationsNow();
    if (!st.repository) return site(false, "STATIONS_NOT_READY");
    const c = checkSite(tx, st.repository, factionId, build.systemId, true);
    if (!c.ok) return c;
    return site(c.good, c.reason);
  }

  const siteInvalid = (detail) => ({ ok: false, reason: "SITE_INVALID", detail: String(detail) });

  function receiveInTx(tx, spec) {
    if (stopped()) return siteInvalid("CONSTRUCTION_STOPPED");
    if (!tx || tx.inTransaction !== true) return { ok: false, reason: "TX_REQUIRED" };
    if (!isPlain(spec) || !isText(spec.stationId) || !isId(spec.factionId) || !isText(spec.convoyId)
      || !isPlain(spec.cargo) || !isTime(spec.at)
      || !Object.keys(spec.cargo).every((k) => Number.isSafeInteger(spec.cargo[k]) && spec.cargo[k] > 0)) {
      return { ok: false, reason: "INVALID_INPUT" };
    }
    const rkey = S.buildReceiveKey(spec.stationId, spec.convoyId);
    const seen = journal.findByKey(tx, rkey);
    if (!seen.ok) return seen;
    if (seen.found) {
      if (seen.entry.kind !== KIND_APPLY) return { ok: false, reason: "IDEMPOTENCY_CONFLICT", detail: rkey };
      return { ok: true, kind: "receive", duplicate: true, anchored: false, acceptedUnits: 0, surplusUnits: 0 };
    }
    const site = siteOfInTx(tx, spec.stationId, spec.factionId);
    if (!site.ok) return site;
    if (!site.isSite) return siteInvalid("NO_BUILD");
    if (!site.good) return siteInvalid(site.reason);
    const build = site.build;
    const required = build.required;
    const foreign = Object.keys(spec.cargo).find((k) => !own(required, k));
    if (foreign !== undefined) return siteInvalid("KIT_ITEM");
    const r = receiveOf(required, build.delivered, spec.cargo);
    const base = { ok: true, kind: "receive", duplicate: false, stationId: build.stationId,
      factionId: build.factionId, acceptedUnits: r.acceptedUnits, surplusUnits: r.surplusUnits };
    const at = spec.at;
    if (!r.complete) {
      const t = builds.transitionBuild(tx, { stationId: build.stationId, expectedVersion: build.version,
        from: S.SUPPLYING, to: S.SUPPLYING, at, patch: { delivered: r.delivered,
          convoysDelivered: build.convoysDelivered + 1 } }, rkey);
      if (!t.ok) return t;
      if (t.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", detail: rkey };
      return { ...base, anchored: false };
    }
    const kit = getKit(build.kitId);
    if (!kit) return siteInvalid("UNKNOWN_KIT");
    const corporationId = corporationOf(build.factionId);
    if (corporationId === null) return siteInvalid("NO_CORPORATION");
    const repository = stationsNow().repository;
    const anchorUntilAt = at + C.anchoringMs;
    const surplusDeltas = toDeltas(r.surplus);
    const surplusTotal = unitsOf(r.surplus);
    return inSavepoint(tx, () => {
      const cs = repository.createStation(tx, { stationId: build.stationId, kind: kit.kind, typeId: kit.typeId,
        structureFamily: kit.structureFamily, systemId: build.systemId, ownerFactionId: build.factionId,
        ownerCorporationId: corporationId, origin: S.STATION_ORIGIN_BUILT, at, initialState: STATION_ANCHORING,
        stateUntilAt: anchorUntilAt }, S.buildAnchorKey(build.stationId));
      if (!cs.ok) return SITE_REFUSALS.includes(cs.reason) ? siteInvalid(`STATION_${cs.reason}`) : cs;
      if (cs.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", detail: S.buildAnchorKey(build.stationId) };
      if (surplusDeltas.length > 0) {
        const sc = repository.applyStockChange(tx, { stationId: build.stationId,
          key: S.buildSurplusKey(build.stationId), reason: S.SURPLUS_REASON, at, deltas: surplusDeltas });
        if (!sc.ok) return siteInvalid(`SURPLUS_${sc.reason}`);
        if (sc.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", detail: S.buildSurplusKey(build.stationId) };
      }
      const next = build.phaseSeq + 1;
      const t = builds.transitionBuild(tx, { stationId: build.stationId, expectedVersion: build.version,
        from: S.SUPPLYING, to: S.ANCHORING, at, patch: { delivered: r.delivered,
          convoysDelivered: build.convoysDelivered + 1, surplusUnits: surplusTotal, phaseSeq: next, watchRound: 0,
          anchorStartedAt: at, anchorUntilAt } }, rkey);
      if (!t.ok) return t;
      if (t.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", detail: rkey };
      const ev = enqueueDue(tx, build.stationId, next, 0, anchorUntilAt);
      if (!ev.ok) return ev;
      return { ...base, anchored: true, anchorUntilAt };
    });
  }

  function onConvoyLostInTx(tx, spec) {
    if (!tx || tx.inTransaction !== true) return { ok: false, reason: "TX_REQUIRED" };
    if (!isPlain(spec) || !isText(spec.stationId) || !isText(spec.convoyId) || !isTime(spec.at)) {
      return { ok: false, reason: "INVALID_INPUT" };
    }
    const lkey = S.buildLostKey(spec.stationId, spec.convoyId);
    const none = { ok: true, kind: "lost", duplicate: false, counted: false, cancelled: false };
    const seen = journal.findByKey(tx, lkey);
    if (!seen.ok) return seen;
    if (seen.found) return { ...none, duplicate: true };
    const b = builds.getBuild(tx, spec.stationId);
    if (!b.ok) return b;
    const build = b.build;
    if (!build || build.state !== S.SUPPLYING) return none;
    const lost = build.convoysLost + 1;
    const cancel = lost >= C.maxLostConvoys;
    const patch = cancel ? { convoysLost: lost, phaseSeq: build.phaseSeq + 1, endedAt: spec.at,
      endReason: "CONVOYS_LOST", lostUnits: unitsOf(build.delivered) } : { convoysLost: lost };
    const t = builds.transitionBuild(tx, { stationId: build.stationId, expectedVersion: build.version,
      from: S.SUPPLYING, to: cancel ? S.CANCELLED : S.SUPPLYING, at: spec.at, patch }, lkey);
    if (!t.ok) return t;
    return { ...none, duplicate: t.duplicate === true, counted: true, cancelled: cancel,
      stationId: build.stationId, factionId: build.factionId };
  }

  function failBuildInTx(tx, spec, key) {
    if (!tx || tx.inTransaction !== true) return { ok: false, reason: "TX_REQUIRED" };
    if (!isPlain(spec) || !isText(spec.stationId) || !isTime(spec.at) || !isText(key, S.MAX_KEY_LENGTH)
      || (spec.reason !== undefined && !isText(spec.reason, S.MAX_END_REASON_LENGTH))) {
      return { ok: false, reason: "INVALID_INPUT" };
    }
    const seen = journal.findByKey(tx, key);
    if (!seen.ok) return seen;
    if (seen.found) return { ok: true, kind: "fail", duplicate: true };
    const b = builds.getBuild(tx, spec.stationId);
    if (!b.ok) return b;
    const build = b.build;
    if (!build) return { ok: false, reason: "ROW_NOT_FOUND" };
    if (build.state !== S.ANCHORING) return { ok: false, reason: "STATE_MISMATCH", actual: build.state };
    const t = builds.transitionBuild(tx, { stationId: build.stationId, expectedVersion: build.version,
      from: S.ANCHORING, to: S.FAILED, at: spec.at, patch: { phaseSeq: build.phaseSeq + 1, endedAt: spec.at,
        endReason: spec.reason || "DESTROYED" } }, key);
    if (!t.ok) return t;
    return { ok: true, kind: "fail", duplicate: t.duplicate === true, stationId: build.stationId,
      factionId: build.factionId };
  }

  function noteCommitted(r) {
    if (!r || r.ok !== true || r.duplicate === true) return;
    if (r.kind === "plan") bump("planned");
    else if (r.kind === "receive") {
      bump("received");
      bump("receivedUnits", r.acceptedUnits || 0);
      if (r.anchored) {
        bump("anchored");
        log(`construction: ${r.stationId} of ${r.factionId} ANCHORING until ${r.anchorUntilAt}`);
      }
    } else if (r.kind === "lost" && r.counted) {
      bump("convoysLost");
      if (r.cancelled) {
        bump("cancelled");
        log(`construction: ${r.stationId} of ${r.factionId} CANCELLED CONVOYS_LOST`);
      }
    } else if (r.kind === "fail") bump("failed");
  }

  function step(tx, ev, p) {
    const out = { action: ACTION.STALE, reason: null, stationId: p.stationId };
    const key = ev.idempotencyKey;
    const at = ev.dueAt;
    const b = builds.getBuild(tx, p.stationId);
    if (!b.ok) return b;
    const build = b.build;
    if (!build || build.phaseSeq !== p.phaseSeq || build.watchRound !== p.round) return { ok: true, ...out };
    const st = stationsNow();
    let station = null;
    let site = null;
    if (st.repository && build.state === S.ANCHORING) {
      const g = st.repository.getStation(tx, build.stationId);
      if (!g.ok) return g;
      station = g.record;
    }
    if (st.repository && build.state === S.SUPPLYING) {
      site = checkSite(tx, st.repository, build.factionId, build.systemId, true);
      if (!site.ok) return site;
    }
    const d = decideBuildStep(build, station, { at, stationsMode: st.mode, site }, machineParams);
    Object.assign(out, { action: d.action, reason: d.reason || null, factionId: build.factionId,
      systemId: build.systemId });
    const end = (to, patch) => {
      const t = builds.transitionBuild(tx, { stationId: build.stationId, expectedVersion: build.version,
        from: build.state, to, at, patch: { phaseSeq: build.phaseSeq + 1, endedAt: at, endReason: d.reason,
          ...patch } }, S.buildEndKey(build.stationId, build.phaseSeq));
      if (!t.ok) return t;
      if (t.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", detail: S.buildEndKey(build.stationId,
        build.phaseSeq) };
      return { ok: true, ...out };
    };
    switch (d.action) {
      case ACTION.STALE:
        return { ok: true, ...out };
      case ACTION.RETRY_LATER:
        return { ok: false, reason: d.reason };
      case ACTION.WAIT:
      case ACTION.REARM: {
        const round = build.watchRound + 1;
        const w = builds.watchBuild(tx, { stationId: build.stationId, expectedVersion: build.version,
          state: build.state, watchRound: round, at }, `${key}:wait`);
        if (!w.ok) return w;
        const e = enqueueDue(tx, build.stationId, build.phaseSeq, round, d.dueAt);
        return e.ok ? { ok: true, ...out } : e;
      }
      case ACTION.CANCEL:
        return end(S.CANCELLED, { lostUnits: unitsOf(build.delivered) });
      case ACTION.COMPLETE: {
        if (d.stationEdge) {
          const ts = st.repository.transitionStation(tx, { stationId: build.stationId,
            expectedVersion: station.version, from: STATION_ANCHORING, to: STATION_ONLINE,
            key: S.buildOnlineKey(build.stationId), reason: S.ONLINE_REASON, at, patch: { stateUntilAt: null } });
          if (!ts.ok) return ts;
          if (ts.duplicate) {
            return { ok: false, reason: "NESTED_KEY_REUSED", detail: S.buildOnlineKey(build.stationId) };
          }
        }
        return end(S.COMPLETED, {});
      }
      case ACTION.FAIL:
        return end(S.FAILED, {});
      default:
        return { ok: false, reason: "UNKNOWN_ACTION", permanent: true };
    }
  }

  function onCommitted(v) {
    if (!v || v.ok !== true) return;
    switch (v.action) {
      case ACTION.STALE: bump("stale"); break;
      case ACTION.WAIT:
      case ACTION.REARM: bump("waits"); break;
      case ACTION.CANCEL: bump("cancelled"); break;
      case ACTION.COMPLETE: bump("completed"); break;
      case ACTION.FAIL: bump("failed"); break;
      default: break;
    }
    if ([ACTION.CANCEL, ACTION.COMPLETE, ACTION.FAIL].includes(v.action)) {
      log(`construction: ${v.stationId} of ${v.factionId} in ${v.systemId} ${v.action} ${v.reason || ""}`);
    }
  }

  function handler(ev) {
    try {
      const p = parsePayload(ev && ev.payload);
      if (!p) return { ok: false, reason: "CONSTRUCTION_PAYLOAD_INVALID", permanent: true };
      if (stopped()) return { ok: false, reason: "CONSTRUCTION_STOPPED" };
      const t0 = nowMs();
      return { ok: true, outcome: "STEP", effect: (tx) => {
        const r = step(tx, ev, p);
        metric("observe", "strategy.construction.stepMs", Math.round((nowMs() - t0) * MS_DECIMALS) / MS_DECIMALS);
        if (!r || r.ok !== true) lastRefusal = String((r && r.reason) || "STEP_FAILED");
        return r;
      }, onCommitted };
    } catch (err) {
      return { ok: false, reason: `CONSTRUCTION_STEP_FAILED: ${messageOf(err)}` };
    }
  }

  function reconcile() {
    try {
      const listed = store.transaction("construction.reconcileRead", (db) => builds.listOpen(db,
        { limit: C.reconcileMaxBuilds }));
      const r = listed.ok ? listed.value : listed;
      if (!r || !r.ok) return { ok: false, reason: (r && r.reason) || "TX_FAILED" };
      let enqueued = 0;
      let exhausted = 0;
      const now = clock.now();
      for (const b of r.builds) {
        const slot = nextReconcileKey(scheduler, { dueKey: S.buildDueKey(b.stationId, b.phaseSeq, b.watchRound),
          baseKey: S.buildReconcileKey(b.stationId, b.phaseSeq, b.watchRound), maxAttempts: C.reconcileMaxAttempts });
        if (!slot.ok) return slot;
        if (slot.open) continue;
        if (slot.exhausted) {
          exhausted += 1;
          log(`construction: reconcile ${b.stationId} exhausted ${C.reconcileMaxAttempts} attempts`);
          continue;
        }
        const dueAt = b.state === S.ANCHORING && isTime(b.anchorUntilAt) ? Math.max(now, b.anchorUntilAt) : now;
        const e = scheduler.enqueue(S.BUILD_EVENT_TYPE, b.stationId, dueAt,
          { stationId: b.stationId, phaseSeq: b.phaseSeq, round: b.watchRound }, slot.key);
        if (e && e.ok && !e.duplicate) enqueued += 1;
        else if (!e || !e.ok) log(`construction: reconcile ${b.stationId} refused ${(e && e.reason) || "?"}`);
      }
      bump("reconciled", enqueued);
      bump("reconcileExhausted", exhausted);
      return { ok: true, open: r.builds.length, enqueued, exhausted };
    } catch (err) {
      return { ok: false, reason: `RECONCILE_FAILED: ${messageOf(err)}` };
    }
  }

  function readOpen(tx, factionId, opts) {
    if (stopped()) return { ok: false, reason: "CONSTRUCTION_UNAVAILABLE", detail: "stopped" };
    if (!tx || tx.inTransaction !== true) return { ok: false, reason: "TX_REQUIRED" };
    if (!isId(factionId)) return { ok: false, reason: "INVALID_INPUT" };
    const limit = opts && Number.isSafeInteger(opts.limit) && opts.limit >= 0 ? opts.limit
      : Math.max(1, C.maxOpenBuildsPerFaction);
    const r = builds.listOpenOfFaction(tx, factionId, limit + 1);
    if (!r.ok) return r;
    const total = builds.countOpen(tx, {});
    if (!total.ok) return total;
    const repository = stationsNow().repository;
    const live = repository ? repository.countLiveAll(tx) : { ok: true, count: 0 };
    if (!live || live.ok !== true) return live || { ok: false, reason: "STATIONS_READ_FAILED" };
    const supplying = repository ? builds.countOpen(tx, { states: [S.SUPPLYING] }) : { ok: true, count: 0 };
    if (!supplying.ok) return supplying;
    const last = builds.lastCreatedAtOfFaction(tx, factionId);
    if (!last.ok) return last;
    return { ok: true, openTotal: total.count, liveTotal: live.count + supplying.count, lastBuildAt: last.at,
      truncated: r.builds.length > limit, builds: r.builds.slice(0, limit).map((b) => {
      const remaining = {};
      for (const k of Object.keys(b.required).sort()) {
        const left = b.required[k] - (b.delivered[k] || 0);
        if (left > 0) remaining[k] = left;
      }
      return { stationId: b.stationId, systemId: b.systemId, kitId: b.kitId, state: b.state,
        required: { ...b.required }, delivered: { ...b.delivered }, remaining, convoysLost: b.convoysLost,
        supplyDeadlineAt: b.supplyDeadlineAt, anchorUntilAt: b.anchorUntilAt };
    }) };
  }

  function getStatus() {
    return Object.freeze({ state, seq, mode: getMode(), kitId: C.kitId, kitUnits, kitFactorPermille,
      counters: Object.freeze({ ...counters }), lastRefusal });
  }

  return Object.freeze({
    getMode,
    getKit,
    planInTx,
    siteOfInTx,
    receiveInTx,
    onConvoyLostInTx,
    failBuildInTx,
    readOpen,
    noteCommitted,
    handler,
    reconcile,
    noteRefusal: (reason) => { lastRefusal = String(reason); },
    getStatus,
    stop() {
      state = "stopped";
      seq += 1;
    },
    isStopped: stopped,
  });
}

module.exports = { createConstructionService, parsePayload, receiveOf, COUNTER_NAMES };
