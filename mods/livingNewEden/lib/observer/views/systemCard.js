"use strict";

const { performance } = require("node:perf_hooks");
const { OPEN_BATTLE_STATES } = require("../../battle/schema");
const { OPEN_OPERATION_STATES } = require("../../fleets/schema");
const { positionAt } = require("../../fleets/travel");
const S = require("../../world/occupation/schema");
const { progressToJson, thresholdMarks } = require("../../world/occupation/progress");
const invasionRepository = require("../../world/invasions/invasionRepository");
const { STATE_ACTIVE, STATE_WITHDRAWING } = require("../../world/invasions/schema");

const VIEW_ID = "system-card";
const WORK_CLASS = "MAINTENANCE";
const METRIC_BUILD_MS = "observer.systemCardMs";
const METRIC_DEFERRALS = "observer.systemCard.deferrals";
const MS_DECIMALS = 10;
const SCORE_DECIMALS = 10;
const DESTROYED = "DESTROYED";
const PRESENT_STATES = Object.freeze([...S.STANDING_FLEET_STATES, "ENGAGED"]);

const round1 = (v) => Math.round(v * SCORE_DECIMALS) / SCORE_DECIMALS;
const relative = (at, now) => (at === null || at === undefined ? null : Number(at) - now);

function call(obj, name) {
  try {
    return obj && typeof obj[name] === "function" ? obj[name]() : undefined;
  } catch (_err) {
    return undefined;
  }
}

function section(fn) {
  try {
    const v = fn();
    return v === undefined ? null : v;
  } catch (_err) {
    return null;
  }
}

function readFleets(repo, db, id, maxFleets, maxRows) {
  const r = repo.listFleetsInSystem(db, id, { limit: maxFleets + 1, states: [...PRESENT_STATES] });
  if (!r.ok) return null;
  const list = r.fleets.slice(0, maxFleets);
  const groups = new Map();
  let shipsTotal = 0;
  for (const f of list) {
    const k = `${f.factionId}:${f.fleetRole}:${f.state}`;
    const g = groups.get(k) || { factionId: f.factionId, role: f.fleetRole, state: f.state, fleets: 0, ships: 0 };
    g.fleets += 1;
    g.ships += f.shipCount;
    shipsTotal += f.shipCount;
    groups.set(k, g);
  }
  const sorted = [...groups.values()].sort((a, b) => b.ships - a.ships || a.factionId - b.factionId
    || (a.role < b.role ? -1 : (a.role > b.role ? 1 : 0)) || (a.state < b.state ? -1 : (a.state > b.state ? 1 : 0)));
  return { list, view: { groups: sorted.slice(0, maxRows), fleetsTotal: list.length, shipsTotal,
    truncated: r.fleets.length > maxFleets || sorted.length > maxRows } };
}

function hasMethods(obj, names) {
  return Boolean(obj) && names.every((n) => typeof obj[n] === "function");
}

const CREW_METHODS = Object.freeze(["listSeatsInTx", "summarizeInTx", "listPilotStatsInTx", "describe"]);

function pilotOf(crews, seat, stats) {
  let d = null;
  try {
    d = crews.describe(seat.characterId);
  } catch (_err) {
    d = null;
  }
  const known = d && d.ok === true;
  const s = stats.get(seat.characterId);
  return { characterId: seat.characterId, name: known ? d.name || null : null,
    corporationName: known ? d.corporationName || null : null, allianceName: known ? d.allianceName || null : null,
    hullGroup: seat.hullGroup, typeId: seat.typeId === undefined ? null : seat.typeId, losses: s ? s.losses : 0 };
}

function readCrews(crews, db, fleets, settings) {
  const maxPilots = settings.crewsMaxPilots;
  const batch = settings.crewsMaxFleets;
  if (!Array.isArray(fleets) || !hasMethods(crews, CREW_METHODS) || !Number.isSafeInteger(maxPilots) || maxPilots < 1
    || !Number.isSafeInteger(batch) || batch < 1) return null;
  const rows = [];
  let total = 0;
  let truncated = false;
  for (let i = 0; i < fleets.length && !truncated; i += batch) {
    const part = fleets.slice(i, i + batch);
    const ids = part.map((f) => f.fleetId);
    const seats = crews.listSeatsInTx(db, ids);
    const heads = crews.summarizeInTx(db, ids, { maxNames: 0 });
    if (!seats || seats.ok !== true || !heads || heads.ok !== true) return null;
    for (const f of part) {
      const list = seats.byFleet.get(f.fleetId) || [];
      const h = heads.byFleet.get(f.fleetId);
      const wanted = h ? h.wanted : 0;
      if (list.length === 0 && wanted === 0) continue;
      if (list.length > 0 && total >= maxPilots) {
        truncated = true;
        break;
      }
      const take = list.slice(0, maxPilots - total);
      if (take.length < list.length) truncated = true;
      total += take.length;
      rows.push({ fleet: f, seated: list.length, wanted, take });
    }
  }
  const characterIds = rows.flatMap((r) => r.take.map((s) => s.characterId));
  const stats = crews.listPilotStatsInTx(db, characterIds);
  if (!stats || stats.ok !== true) return null;
  return { fleets: rows.map((r) => ({ fleetId: r.fleet.fleetId, factionId: r.fleet.factionId,
    shipCount: r.fleet.shipCount, seated: r.seated, wanted: r.wanted,
    pilots: r.take.map((s) => pilotOf(crews, s, stats.byId)) })), truncated };
}

function operationRow(repo, db, op, id, now) {
  const members = repo.listFleetsOfOperation(db, op.operationId);
  if (!members.ok) return null;
  let fleets = 0;
  let ships = 0;
  let inFlight = 0;
  let etaMs = null;
  for (const f of members.fleets) {
    if (f.state === DESTROYED) continue;
    fleets += 1;
    ships += f.shipCount;
    const pos = positionAt(f, now);
    if (!pos.inFlight || f.targetSystemId !== id) continue;
    inFlight += 1;
    etaMs = Math.max(etaMs === null ? 0 : etaMs, pos.arriveAt - now);
  }
  return { operationId: op.operationId, type: op.operationType, objective: op.objective, state: op.state,
    factionId: op.factionId, originSystemId: op.originSystemId, fleets, ships, inFlight, etaMs,
    dueMs: relative(op.dueAt, now) };
}

function readOperations(repo, db, id, now, maxRows) {
  const r = repo.listOperationsByTarget(db, id, { states: [...OPEN_OPERATION_STATES], limit: maxRows + 1 });
  if (!r.ok) return null;
  const rows = [];
  for (const op of r.operations.slice(0, maxRows)) {
    const row = operationRow(repo, db, op, id, now);
    if (row === null) return null;
    rows.push(row);
  }
  return { rows, truncated: r.operations.length > maxRows };
}

function influenceRows(sys, progress, params) {
  const stored = new Map((sys.influence || []).map((i) => [i.factionId, i]));
  const ids = new Set(stored.keys());
  if (progress) for (const f of progress.scores.keys()) ids.add(f);
  const roleOf = (f) => {
    if (!progress) return null;
    if (f === progress.attacker) return "attacker";
    if (f === progress.defender) return "defender";
    return progress.hostile.includes(f) ? "hostile" : null;
  };
  const rows = [...ids].map((factionId) => {
    const row = stored.get(factionId);
    const raw = progress && progress.scores.has(factionId) ? progress.scores.get(factionId)
      : (row ? row.influenceScore : 0);
    const role = roleOf(factionId);
    return { factionId, score: round1(raw), garrison: row ? row.garrisonStrength : 0, role,
      marks: params && progress ? thresholdMarks(progress.state, role, params) : [] };
  });
  return rows.sort((a, b) => b.score - a.score || a.factionId - b.factionId);
}

function attackerInvasionOf(rows, attacker, withdrawAtOf, now) {
  if (!Number.isSafeInteger(attacker)) return null;
  const own = rows.filter((x) => Number(x.faction_id) === attacker);
  const active = own.filter((x) => x.state === STATE_ACTIVE);
  if (active.length > 0) {
    const known = active.map((x) => relative(withdrawAtOf(x), now)).filter((ms) => ms !== null);
    return { state: STATE_ACTIVE, withdrawMs: known.length > 0 ? Math.min(...known) : null };
  }
  const leaving = own.find((x) => x.state === STATE_WITHDRAWING);
  return leaving ? { state: STATE_WITHDRAWING, withdrawMs: relative(withdrawAtOf(leaving), now) } : null;
}

function factionIdsOf(out) {
  const ids = new Set();
  const add = (v) => {
    if (Number.isSafeInteger(v) && v > 0) ids.add(v);
  };
  const { system: sys } = out;
  if (sys) for (const f of [sys.controller, sys.occupier, sys.previousController, sys.home]) add(f);
  if (out.progress) for (const f of [out.progress.attacker, out.progress.defender]) add(f);
  for (const r of out.influence) add(r.factionId);
  if (out.fleets) for (const g of out.fleets.groups) add(g.factionId);
  if (out.operations) for (const r of out.operations.rows) add(r.factionId);
  if (out.crews) for (const f of out.crews.fleets) add(f.factionId);
  for (const r of out.stations || []) add(r.ownerFactionId);
  for (const r of out.sieges || []) {
    add(r.attackerFactionId);
    add(r.ownerFactionId);
  }
  for (const r of out.invasions || []) add(r.factionId);
  for (const b of out.battles || []) {
    if (b.sides && b.sides.A) add(b.sides.A.factionId);
    if (b.sides && b.sides.B) add(b.sides.B.factionId);
  }
  return [...ids].sort((a, b) => a - b);
}

const EMPTY_WORLD = Object.freeze({ system: null, progress: null, sinceMs: null, influence: Object.freeze([]),
  fleets: null, operations: null, stations: null, sieges: null, invasions: null, attackerInvasion: null, battles: null,
  crews: null });

function buildSystemCardView(deps) {
  const { ctx, store, clock, settings } = deps;
  const getGovernor = typeof deps.getGovernor === "function" ? deps.getGovernor : () => null;
  const telemetry = deps.telemetry || null;
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
  const factionNames = deps.factionNames instanceof Map ? deps.factionNames : new Map();
  const refreshMs = Math.max(1, Math.trunc(Number(settings.refreshMs) || 0));

  function admitted() {
    try {
      const governor = getGovernor();
      return !governor || typeof governor.admits !== "function" || governor.admits(WORK_CLASS) !== false;
    } catch (_err) {
      return true;
    }
  }

  function metric(kind, name, value) {
    if (!telemetry || typeof telemetry[kind] !== "function") return;
    try {
      telemetry[kind](name, value);
    } catch (_err) {
    }
  }

  const keyAt = (now) => `k${Math.floor(now / refreshMs)}`;

  function readWorld(db, id, now) {
    const occ = ctx.occupation;
    if (occ && typeof occ.readProgressInTx === "function") {
      const r = occ.readProgressInTx(db, id, now, new Map());
      if (r && r.ok) return { sys: r.system, progress: r.progress };
    }
    const world = ctx.world;
    if (!world || !world.repository) return { sys: null, progress: null };
    const r = world.repository.getSystem(db, id, { includeInfluence: true });
    return { sys: r && r.ok ? r.system : null, progress: null };
  }

  function readAll(db, id, now) {
    const { sys, progress } = section(() => readWorld(db, id, now)) || { sys: null, progress: null };
    if (!sys) return { ...EMPTY_WORLD, inWorld: false };
    const fleetsRepo = ctx.fleets && ctx.fleets.repository;
    const stationsRepo = ctx.stations && ctx.stations.repository;
    const siegeRepo = ctx.siege && ctx.siege.repository;
    const battleRepo = ctx.battle && ctx.battle.repository;
    const { maxRows, maxFleets, recentBattles } = settings;
    const params = ctx.occupation ? ctx.occupation.params : null;
    const facade = ctx.invasions;
    const withdrawAtOf = facade && typeof facade.effectiveWithdrawAtOf === "function"
      ? facade.effectiveWithdrawAtOf : (r) => r.withdraw_at ?? null;
    const openInvasions = section(() => {
      const r = invasionRepository.listOpen(db, {});
      return r.ok ? r.invasions : null;
    });
    const fleetRead = section(() => (fleetsRepo ? readFleets(fleetsRepo, db, id, maxFleets, maxRows) : null));
    const crews = ctx.crews;
    return {
      inWorld: true,
      system: { state: sys.occupationState, controller: sys.controllerFactionId, occupier: sys.occupierFactionId,
        previousController: sys.previousControllerFactionId, home: sys.homeFactionId, sinceAt: sys.lastStateChangeAt,
        capturedAt: sys.capturedAt, detachedSinceAt: sys.detachedSinceAt },
      progress: progressToJson(progress),
      sinceMs: now - sys.lastStateChangeAt,
      influence: influenceRows(sys, progress, params),
      fleets: fleetRead ? fleetRead.view : null,
      crews: fleetRead ? section(() => readCrews(crews, db, fleetRead.list, settings)) : null,
      operations: section(() => (fleetsRepo ? readOperations(fleetsRepo, db, id, now, maxRows) : null)),
      stations: section(() => {
        if (!stationsRepo) return null;
        const r = stationsRepo.listStationsInSystem(db, id);
        return r.ok ? r.records.map((st) => ({ stationId: st.stationId, name: st.name,
          ownerFactionId: st.ownerFactionId, state: st.state, stateUntilMs: relative(st.stateUntilAt, now) })) : null;
      }),
      sieges: section(() => {
        if (!siegeRepo) return null;
        const r = siegeRepo.listOpenInSystem(db, id);
        return r.ok ? r.sieges.map((x) => ({ siegeId: x.siegeId, stationId: x.stationId, state: x.state,
          attackerFactionId: x.attackerFactionId, ownerFactionId: x.ownerFactionId, attackerShips: x.attackerShips,
          phaseEndsMs: relative(x.phaseEndsAt, now) })) : null;
      }),
      invasions: openInvasions === null ? null : section(() => openInvasions
        .filter((x) => Number(x.beachhead_system_id) === id).map((x) => ({
          invasionId: x.invasion_id, factionId: Number(x.faction_id), state: x.state,
          withdrawMs: relative(withdrawAtOf(x), now) }))),
      attackerInvasion: openInvasions === null || !progress ? null
        : section(() => attackerInvasionOf(openInvasions, progress.attacker, withdrawAtOf, now)),
      battles: section(() => {
        if (!battleRepo) return null;
        const r = battleRepo.summarizeInSystem(db, id, { limit: recentBattles });
        return r.ok ? r.battles.map((b) => ({ battleId: b.battleId, open: OPEN_BATTLE_STATES.includes(b.state),
          state: b.state, mode: b.mode, outcome: b.outcome, ageMs: now - (b.settledAt ?? b.createdAt),
          sides: b.sides })) : null;
      }),
    };
  }

  function getData(req) {
    const id = req && req.param;
    if (!Number.isSafeInteger(id) || id < 1) return { available: false, reason: "NO_SYSTEM" };
    if (call(store, "isOpen") !== true) return { available: false, reason: "STORE_CLOSED" };
    if (!admitted()) {
      metric("count", METRIC_DEFERRALS, 1);
      return { available: false, reason: "GOVERNOR_HOLD" };
    }
    const t0 = nowMs();
    const now = clock.now();
    const tx = store.transaction("observer.systemCard", (db) => ({ ok: true, card: readAll(db, id, now) }));
    if (!tx.ok || !tx.value || !tx.value.ok) return { available: false, reason: String(tx.reason || "TX_FAILED") };
    const { card } = tx.value;
    metric("observe", METRIC_BUILD_MS, Math.round((nowMs() - t0) * MS_DECIMALS) / MS_DECIMALS);
    const body = { available: true, key: keyAt(now), systemId: id, inWorld: card.inWorld, system: card.system,
      progress: card.progress, sinceMs: card.sinceMs, scoreMax: S.SCORE_MAX, influence: card.influence,
      fleets: card.fleets, operations: card.operations, stations: card.stations, sieges: card.sieges,
      invasions: card.invasions, attackerInvasion: card.attackerInvasion, battles: card.battles, crews: card.crews };
    body.names = factionIdsOf(body).map((f) => [f, factionNames.get(f) ?? null]);
    return body;
  }

  function cacheKey() {
    if (call(store, "isOpen") !== true || !admitted()) return null;
    return keyAt(clock.now());
  }

  return { title: "System card", listed: false, param: "system", cacheKey, getData };
}

module.exports = { VIEW_ID, buildSystemCardView };
