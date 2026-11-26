"use strict";

const { performance } = require("node:perf_hooks");
const { createPoller } = require("../presence/poller");
const { PRESENT_STATES } = require("../localPilots/schema");
const { FLEET_STATES, DESTROYED_STATE } = require("../fleets/schema");
const { stableJson } = require("../util/fingerprint");
const { seatKey, crewTargets } = require("./plan");
const { buildCrewPool, emptyCrewPool } = require("./pool");
const { createCrewRepository } = require("./repository");
const { createReconciler } = require("./reconcile");
const { createCrewsConsequence } = require("./consequence");
const { CAUSES, PRIORITY, COUNTER_NAMES, WORK_CLASS, STATE, AGGREGATE, EVENT_LIVE_LOSS, EVENT_RECONCILE, KEY_PREFIX,
  FACADE_METHODS } = require("./schema");

const MS_DECIMALS = 10;
const MAX_DETAIL = 160;
const LIVE_STATES = Object.freeze(FLEET_STATES.filter((s) => s !== DESTROYED_STATE));
const GUARDED_CAUSES = Object.freeze([CAUSES.LIVE, CAUSES.BATTLE]);

function messageOf(err) {
  return String((err && err.message) || err).slice(0, MAX_DETAIL);
}

function isPositiveInt(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isTx(tx) {
  return Boolean(tx && typeof tx.prepare === "function");
}

function createUnavailableCrews(reason) {
  const why = String(reason || "CREWS_UNAVAILABLE");
  const refuse = () => ({ ok: false, reason: why });
  const facade = { consequence: null };
  for (const name of FACADE_METHODS) facade[name] = refuse;
  facade.getStatus = () => Object.freeze({ state: "unavailable", reason: why });
  facade.stop = () => {};
  return Object.freeze(facade);
}

function persistenceOf(ctx) {
  const p = ctx && ctx.persistence;
  return p && p.ok !== false && p.store && typeof p.store.transaction === "function" && p.journal
    && typeof p.journal.applyOnce === "function" ? p : null;
}

function startCrews(deps) {
  const config = deps && deps.config;
  const S = config && config.crews;
  if (!S || S.enabled !== true) return { ok: false, reason: "disabled_by_config" };
  const ctx = deps.ctx || {};
  const clock = deps.clock && typeof deps.clock.now === "function" ? deps.clock : { now: () => Date.now() };
  const telemetry = deps.telemetry || null;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : null;
  const persistence = persistenceOf(ctx);
  if (!persistence) return { ok: false, reason: "NO_PERSISTENCE_STORE" };
  const fleetRepository = () => {
    const r = ctx.fleets && ctx.fleets.repository;
    return r && typeof r.getFleet === "function" ? r : null;
  };
  if (!fleetRepository()) return { ok: false, reason: "NO_FLEETS" };
  const maxPool = config.localPilots && Number.isSafeInteger(config.localPilots.maxPoolCharacters)
    ? config.localPilots.maxPoolCharacters : 0;

  function log(line) {
    if (!logger) return;
    try {
      logger.log(`crews: ${line}`);
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

  const counters = Object.fromEntries(COUNTER_NAMES.map((name) => [name, 0]));
  function bump(name, n = 1) {
    if (!(n > 0)) return;
    counters[name] += n;
    metric("count", `crews.${name}`, n);
  }

  let state = STATE.STARTING;
  let pool = emptyCrewPool();
  let headerCursor = "";
  const factionCursor = new Map();
  let factionTurn = 0;
  const requested = new Set();
  let lastPass = null;
  const subscriptions = [];

  function presenceOf() {
    const p = ctx.presence;
    return p && typeof p.observedSystems === "function" ? p : null;
  }

  function isObserved(systemId) {
    try {
      const p = presenceOf();
      return Boolean(p && typeof p.isObserved === "function" && p.isObserved(systemId));
    } catch (_err) {
      return false;
    }
  }

  function refreshPool() {
    let cand = null;
    try {
      const vc = ctx.virtualCorps;
      cand = vc && typeof vc.listPilotCandidates === "function" ? vc.listPilotCandidates() : null;
    } catch (_err) {
      cand = null;
    }
    if (!cand || cand.ok !== true || !isPositiveInt(cand.version)) {
      if (pool.version !== 0) pool = emptyCrewPool();
      return;
    }
    if (cand.version === pool.version) return;
    pool = buildCrewPool(cand.candidates, maxPool, cand.version);
  }

  const repo = createCrewRepository();
  const reconciler = createReconciler({ repo, getFleetRepository: fleetRepository, getPool: () => pool, settings: S,
    isObserved });

  function governorAdmits() {
    try {
      const governor = ctx.governor;
      return !governor || typeof governor.admits !== "function" || governor.admits(WORK_CLASS) !== false;
    } catch (_err) {
      return true;
    }
  }

  function tallyOf(r, tally) {
    if (!r || r.ok !== true) {
      tally.errors += 1;
      return;
    }
    tally.enlisted += r.enlisted;
    tally.released += r.removed;
    tally.lost += r.lost;
    tally.reclaimed += r.reclaimed;
    tally.stale += r.stale;
    tally.shortfall += r.shortfall;
  }

  function runPhases(db, now) {
    const tally = { enlisted: 0, released: 0, lost: 0, reclaimed: 0, stale: 0, shortfall: 0, truncated: 0, errors: 0,
      fleets: 0 };
    const fr = fleetRepository();
    if (!fr) throw new Error("NO_FLEETS");
    const sh = reconciler.newShared({ seats: S.maxSeatWritesPerPass, reclaim: S.maxReclaimPerPass });
    const done = new Set();
    const asked = new Set(requested);
    tally.askedSeated = 0;
    let left = S.maxFleetsPerPass;
    const room = () => left > 0 && sh.budget.seats > 0;
    const run = (fleetId, opts) => {
      done.add(fleetId);
      left -= 1;
      tally.fleets += 1;
      const r = reconciler.reconcileInTx(db, fleetId, { at: now, ...opts }, sh);
      tallyOf(r, tally);
      if (asked.has(fleetId) && r && r.ok === true && r.enlisted + r.reclaimed > 0) tally.askedSeated += 1;
    };
    const presence = presenceOf();
    const observed = presence ? presence.observedSystems() : [];
    const systems = [...new Set(Array.isArray(observed) ? observed : [])].filter(isPositiveInt)
      .sort((a, b) => a - b);
    const read = systems.length > 0 ? fr.listFleetsInSystems(db, systems.slice(0, S.maxFleetsPerPass),
      { states: [...PRESENT_STATES], limitPerSystem: S.maxFleetsPerPass }) : { ok: true, bySystem: new Map() };
    if (!read || read.ok !== true) throw new Error(`listFleetsInSystems: ${(read && read.reason) || "no_result"}`);
    if (systems.length > S.maxFleetsPerPass) tally.truncated += 1;
    const present = [];
    for (const list of read.bySystem.values()) for (const f of list) present.push(f.fleetId);
    present.sort();
    for (const id of present) sh.protectedIds.add(id);
    for (const id of present) {
      if (!room()) {
        tally.truncated += 1;
        break;
      }
      run(id, { cause: CAUSES.SHRINK, enlist: true, priority: PRIORITY.OBSERVED, touchSeen: true });
    }
    for (const id of [...requested].sort()) {
      if (!room()) break;
      requested.delete(id);
      if (done.has(id)) continue;
      sh.protectedIds.add(id);
      run(id, { cause: CAUSES.SHRINK, enlist: true, priority: PRIORITY.OBSERVED, touchSeen: true });
    }
    if (room()) {
      const page = repo.headersAfter(db, headerCursor, left);
      headerCursor = page.length < left ? "" : page[page.length - 1].fleetId;
      const ids = page.map((h) => h.fleetId).filter((id) => !done.has(id));
      const got = ids.length > 0 ? fr.getFleets(db, ids) : { ok: true, fleets: [] };
      if (!got || got.ok !== true) throw new Error(`getFleets: ${(got && got.reason) || "no_result"}`);
      const byId = new Map(got.fleets.map((f) => [f.fleetId, f]));
      for (const h of page) {
        if (done.has(h.fleetId)) continue;
        if (!room()) break;
        const f = byId.get(h.fleetId);
        if (!f || f.state === DESTROYED_STATE) {
          run(h.fleetId, { cause: CAUSES.GONE, enlist: false });
          continue;
        }
        const sig = stableJson(crewTargets(f.composition, S));
        if (sig === h.compositionSig && h.seated >= h.wanted) continue;
        run(h.fleetId, { cause: CAUSES.SHRINK, enlist: true, priority: PRIORITY.BACKGROUND });
      }
    }
    if (S.backgroundEnlist === true && pool.ready && room()) {
      const taken = sh.taken || (sh.taken = repo.takenIds(db));
      const cooling = sh.cooling || (sh.cooling = repo.cooling(db, now));
      const factions = [...pool.byFaction.keys()].sort((a, b) => a - b)
        .filter((f) => pool.byFaction.get(f).some((id) => !taken.has(id) && !((cooling.get(id) || 0) > now)));
      for (let i = 0; i < factions.length && room(); i += 1) {
        const factionId = factions[(factionTurn + i) % factions.length];
        const listed = fr.listFleetsByFaction(db, factionId, { states: [...LIVE_STATES],
          afterFleetId: factionCursor.get(factionId) || "", limit: left });
        if (!listed || listed.ok !== true) throw new Error(`listFleetsByFaction: ${(listed && listed.reason) || "no_result"}`);
        factionCursor.set(factionId, listed.nextAfterFleetId || "");
        const crewed = repo.headersIn(db, listed.fleets.map((f) => f.fleetId));
        for (const f of listed.fleets) {
          if (!room()) break;
          if (crewed.has(f.fleetId) || done.has(f.fleetId)) continue;
          run(f.fleetId, { cause: CAUSES.SHRINK, enlist: true, priority: PRIORITY.BACKGROUND });
        }
      }
      if (factions.length > 0) factionTurn = (factionTurn + 1) % factions.length;
    }
    tally.totals = repo.totals(db);
    tally.more = requested.size > 0;
    return tally;
  }

  function pass() {
    if (state !== STATE.RUNNING) return { ok: false, reason: "not_running" };
    if (!governorAdmits()) {
      bump("deferrals");
      return { ok: false, reason: "DEFERRED" };
    }
    const t0 = performance.now();
    try {
      refreshPool();
      const now = clock.now();
      const res = persistence.store.transaction("crews.pass", (db) => runPhases(db, now));
      if (!res || res.ok !== true) {
        bump("errors");
        log(`pass refused - ${(res && res.reason) || "no_result"}${res && res.error ? ` ${messageOf(res.error)}` : ""}`);
        return { ok: false, reason: (res && res.reason) || "PASS_FAILED" };
      }
      const t = res.value;
      for (const name of ["enlisted", "released", "lost", "reclaimed", "stale", "shortfall", "truncated", "errors"]) {
        bump(name, t[name]);
      }
      bump("passes");
      metric("gauge", "crews.crewedFleets", t.totals.fleets);
      metric("gauge", "crews.seatedPilots", t.totals.seated);
      const ms = Math.round((performance.now() - t0) * MS_DECIMALS) / MS_DECIMALS;
      metric("observe", "crews.passMs", ms);
      lastPass = { at: now, fleets: t.fleets, enlisted: t.enlisted, shortfall: t.shortfall,
        crewedFleets: t.totals.fleets, seatedPilots: t.totals.seated, ms };
      if (t.more) poller.arm(S.nudgeDelayMs);
      if (t.askedSeated > 0) refreshLocalSoon();
      return { ok: true };
    } catch (err) {
      bump("errors");
      log(`pass failed - ${messageOf(err)}`);
      return { ok: false, reason: "PASS_FAILED", detail: messageOf(err) };
    }
  }

  function refreshLocalSoon() {
    const later = typeof deps.setImmediate === "function" ? deps.setImmediate : setImmediate;
    try {
      later(() => {
        try {
          const lp = state === STATE.RUNNING ? ctx.localPilots : null;
          if (lp && typeof lp.runPassNow === "function") lp.runPassNow();
        } catch (err) {
          log(`local refresh failed - ${messageOf(err)}`);
        }
      });
    } catch (_err) {
    }
  }

  const poller = createPoller({ runPass: () => { pass(); }, intervalMs: S.refreshMs, now: () => clock.now(),
    setTimer: deps.setTimer, onError: (err) => { bump("errors"); log(`timer failed - ${messageOf(err)}`); } });

  function scheduleSoon() {
    if (state !== STATE.RUNNING) return;
    poller.arm(S.nudgeDelayMs);
  }

  function requestEnlist(fleetIds) {
    if (state !== STATE.RUNNING) return { ok: false, reason: "not_running" };
    let queued = 0;
    for (const id of Array.isArray(fleetIds) ? fleetIds : []) {
      if (typeof id !== "string" || id === "" || requested.has(id)) continue;
      if (requested.size >= S.maxFleetsPerPass) break;
      requested.add(id);
      queued += 1;
    }
    if (queued > 0) scheduleSoon();
    return { ok: true, queued };
  }

  function listSeatsInTx(tx, fleetIds) {
    if (!isTx(tx)) return { ok: false, reason: "TX_REQUIRED" };
    if (!Array.isArray(fleetIds) || !fleetIds.every((id) => typeof id === "string" && id !== "")) {
      return { ok: false, reason: "INVALID_ARGUMENT", detail: "fleetIds" };
    }
    const ids = [...new Set(fleetIds)].sort();
    if (ids.length > S.maxFleetsPerPass) return { ok: false, reason: "BATCH_TOO_LARGE", limit: S.maxFleetsPerPass };
    const map = repo.seatsIn(tx, ids);
    const byFleet = new Map();
    for (const [id, list] of map) {
      byFleet.set(id, Object.freeze(list.map((s) => Object.freeze({ seat: s.seat, characterId: s.characterId,
        hullGroup: s.hullGroup, typeId: s.typeId, joinedAt: s.joinedAt }))));
    }
    return { ok: true, byFleet };
  }

  function describe(characterId) {
    refreshPool();
    const i = pool.info.get(characterId);
    if (!i) return { ok: false, reason: "UNKNOWN" };
    const nameOf = (id) => {
      try {
        const vc = ctx.virtualCorps;
        return id !== null && vc && typeof vc.nameOf === "function" ? vc.nameOf(id) || null : null;
      } catch (_err) {
        return null;
      }
    };
    return { ok: true, name: i.name, corporationId: i.corporationId, allianceId: i.allianceId,
      corporationName: nameOf(i.corporationId), allianceName: nameOf(i.allianceId) };
  }

  function summarizeInTx(tx, fleetIds, opts) {
    const seats = listSeatsInTx(tx, fleetIds);
    if (!seats.ok) return seats;
    const maxNames = opts && Number.isSafeInteger(opts.maxNames) && opts.maxNames >= 0 ? opts.maxNames : 0;
    const headers = repo.headersIn(tx, [...seats.byFleet.keys()]);
    const byFleet = new Map();
    for (const [id, list] of seats.byFleet) {
      const h = headers.get(id);
      const names = [];
      for (const s of list) {
        if (names.length >= maxNames) break;
        const i = pool.info.get(s.characterId);
        if (i && i.name) names.push(i.name);
      }
      byFleet.set(id, { seated: list.length, wanted: h ? h.wanted : 0, names });
    }
    return { ok: true, byFleet };
  }

  function listPilotStatsInTx(tx, characterIds) {
    if (!isTx(tx)) return { ok: false, reason: "TX_REQUIRED" };
    if (!Array.isArray(characterIds) || !characterIds.every(isPositiveInt)) {
      return { ok: false, reason: "INVALID_ARGUMENT", detail: "characterIds" };
    }
    const ids = [...new Set(characterIds)].sort((a, b) => a - b);
    const limit = S.maxFleetsPerPass * S.maxCrewPerFleet;
    if (ids.length > limit) return { ok: false, reason: "BATCH_TOO_LARGE", limit };
    return { ok: true, byId: repo.pilotsIn(tx, ids) };
  }

  function validMembers(members) {
    return Array.isArray(members) && members.length <= S.maxCrewPerFleet
      && members.every((m) => m && typeof m.memberKey === "string" && m.memberKey !== ""
        && typeof m.hullGroup === "string" && (m.typeId === null || m.typeId === undefined || isPositiveInt(m.typeId)));
  }

  function seatsForMaterializationInTx(tx, req) {
    if (state !== STATE.RUNNING) return { ok: false, reason: "CREWS_OFF" };
    if (!isTx(tx)) return { ok: false, reason: "TX_REQUIRED" };
    if (!req || typeof req.fleetId !== "string" || !Number.isSafeInteger(req.at) || req.at < 0
      || !validMembers(req.members)) {
      return { ok: false, reason: "INVALID_ARGUMENT" };
    }
    refreshPool();
    if (!pool.ready) return { ok: false, reason: "POOL_NOT_READY" };
    const fr = fleetRepository();
    const got = fr ? fr.getFleet(tx, req.fleetId) : null;
    if (!got || got.ok !== true) return { ok: false, reason: "FLEET_READ_FAILED" };
    if (!got.fleet || got.fleet.state === DESTROYED_STATE) return { ok: false, reason: "FLEET_NOT_FOUND" };
    const sh = reconciler.newShared({ seats: S.maxCrewPerFleet * 2, reclaim: S.maxReclaimPerPass });
    sh.protectedIds.add(req.fleetId);
    const r = reconciler.reconcileInTx(tx, req.fleetId, { cause: CAUSES.SHRINK, at: req.at, enlist: true,
      priority: PRIORITY.MATERIALIZE, touchSeen: true }, sh);
    if (!r.ok) return r;
    bump("enlisted", r.enlisted);
    bump("reclaimed", r.reclaimed);
    const free = new Map();
    for (const s of repo.seatsOf(tx, req.fleetId)) {
      const key = seatKey(s.hullGroup, s.typeId);
      if (!free.has(key)) free.set(key, []);
      free.get(key).push(s);
    }
    const members = [...req.members].sort((a, b) => (a.memberKey < b.memberKey ? -1 : (a.memberKey > b.memberKey ? 1 : 0)));
    const seats = [];
    let unmatched = 0;
    for (const m of members) {
      const list = free.get(seatKey(m.hullGroup, m.typeId === undefined ? null : m.typeId));
      const s = list && list.length > 0 ? list.shift() : null;
      if (!s) {
        unmatched += 1;
        continue;
      }
      const i = pool.info.get(s.characterId);
      seats.push(Object.freeze({ memberKey: m.memberKey, characterId: s.characterId,
        ownerId: (i && i.corporationId) || got.fleet.corporationId || null, allianceId: i ? i.allianceId : null,
        name: i ? i.name : null }));
    }
    return { ok: true, seats: Object.freeze(seats), unmatched };
  }

  function recordLiveLossInTx(tx, req, idempotencyKey) {
    if (state !== STATE.RUNNING) return { ok: false, reason: "CREWS_OFF" };
    if (!isTx(tx)) return { ok: false, reason: "TX_REQUIRED" };
    if (!req || typeof req.fleetId !== "string" || req.fleetId === "" || !Number.isSafeInteger(req.at) || req.at < 0
      || !Array.isArray(req.characterIds) || !req.characterIds.every(isPositiveInt)
      || typeof idempotencyKey !== "string" || idempotencyKey === "") {
      return { ok: false, reason: "INVALID_ARGUMENT" };
    }
    const characterIds = [...new Set(req.characterIds)].sort((a, b) => a - b);
    const r = persistence.journal.applyOnce(tx, { key: `${KEY_PREFIX}${idempotencyKey}`,
      aggregate: { type: AGGREGATE, id: req.fleetId }, eventType: EVENT_LIVE_LOSS,
      payload: { fleetId: req.fleetId, characterIds } }, (db) => {
      const wanted = new Set(characterIds);
      const seats = repo.seatsOf(db, req.fleetId).filter((s) => wanted.has(s.characterId));
      for (const s of seats) {
        repo.deleteSeat(db, req.fleetId, s.seat);
        repo.recordLoss(db, s.characterId, req.at + S.lostCooldownMs, req.fleetId, req.at);
      }
      const h = repo.getHeader(db, req.fleetId);
      if (h && seats.length > 0) {
        const next = { ...h, seated: Math.max(0, h.seated - seats.length) };
        if (!repo.updateHeader(db, next, h.version, req.at)) return { ok: false, reason: "VERSION_CONFLICT" };
      }
      return { ok: true, lost: seats.length };
    });
    if (!r.ok) return { ok: false, reason: r.reason, ...(r.refusal ? { detail: r.refusal.reason } : {}) };
    if (r.duplicate) return { ok: true, duplicate: true, lost: 0 };
    bump("lost", r.value.lost);
    return { ok: true, duplicate: false, lost: r.value.lost };
  }

  function reconcileGuardedInTx(tx, fleetId, req, idempotencyKey) {
    if (state !== STATE.RUNNING) return { ok: false, reason: "CREWS_OFF" };
    if (!isTx(tx)) return { ok: false, reason: "TX_REQUIRED" };
    if (typeof fleetId !== "string" || fleetId === "" || !req || !GUARDED_CAUSES.includes(req.cause)
      || !Number.isSafeInteger(req.at) || req.at < 0 || typeof idempotencyKey !== "string" || idempotencyKey === ""
      || (req.maxRows !== undefined && !(Number.isSafeInteger(req.maxRows) && req.maxRows > 0))) {
      return { ok: false, reason: "INVALID_ARGUMENT" };
    }
    const ceiling = req.maxRows === undefined ? {} : { maxRows: req.maxRows };
    const r = persistence.journal.applyOnce(tx, { key: `${KEY_PREFIX}${idempotencyKey}`,
      aggregate: { type: AGGREGATE, id: fleetId }, eventType: EVENT_RECONCILE, payload: { fleetId, cause: req.cause } },
    (db) => reconciler.reconcileInTx(db, fleetId, { cause: req.cause, at: req.at, enlist: false, ...ceiling }));
    if (!r.ok) return { ok: false, reason: r.reason, ...(r.refusal ? { detail: r.refusal.reason } : {}) };
    if (r.duplicate) return { ok: true, duplicate: true, lost: 0 };
    bump("lost", r.value.lost);
    return { ok: true, duplicate: false, lost: r.value.lost };
  }

  const consequence = createCrewsConsequence({ settings: S,
    reconcileInTx: (tx, fleetId, opts) => reconciler.reconcileInTx(tx, fleetId, opts),
    onLost: (n) => bump("lost", n), onTruncated: (n) => bump("truncated", n) });

  state = STATE.RUNNING;
  poller.start();
  poller.arm(S.nudgeDelayMs);

  const presence = presenceOf();
  if (presence && typeof presence.onSystemObserved === "function") {
    try {
      const sub = presence.onSystemObserved(() => scheduleSoon());
      if (sub && sub.ok && typeof sub.unsubscribe === "function") subscriptions.push(() => sub.unsubscribe());
    } catch (err) {
      log(`presence onSystemObserved refused - ${messageOf(err)}`);
    }
  }
  const vc = ctx.virtualCorps;
  if (vc && typeof vc.whenReady === "function") {
    try {
      Promise.resolve(vc.whenReady()).then(() => scheduleSoon(), () => {});
    } catch (_err) {
    }
  }

  function stop(_reason) {
    if (state === STATE.STOPPED) return;
    state = STATE.STOPPED;
    poller.stop();
    for (const off of subscriptions.splice(0)) {
      try {
        off();
      } catch (_err) {
      }
    }
    requested.clear();
  }

  function getStatus() {
    return { state, lastPass, poolVersion: pool.version, poolReady: pool.ready, poolCharacters: pool.info.size,
      requested: requested.size, ...counters };
  }

  const facade = { runPassNow: () => pass(), requestEnlist, listSeatsInTx, describe, summarizeInTx,
    listPilotStatsInTx, seatsForMaterializationInTx, recordLiveLossInTx, reconcileGuardedInTx, consequence, getStatus, stop };
  return { ok: true, crews: Object.freeze(facade) };
}

module.exports = { startCrews, createUnavailableCrews };
