"use strict";

const { performance } = require("node:perf_hooks");
const S = require("../schema");
const { ACTION, decideConvoyStep } = require("./convoyMachine");
const { cargoVolume, carriersOf, capacityOf, carrierCapacitiesM3, scaleCargo, fitCargo, cargoUnits, toDeltas,
  itemsToCargo } = require("./cargo");
const { nextReconcileKey } = require("../reconcileSlots");

const STATION_MODE_READY = "ready";
const STATION_ONLINE = "ONLINE";
const CONSTRUCTION_PURPOSE = "CONSTRUCTION";
const SITE_INVALID = "SITE_INVALID";
const ROUTE_SKIP_REASONS = Object.freeze(["SAME_SYSTEM", "TOO_FAR", "UNREACHABLE", "UNKNOWN_SYSTEM",
  "NO_RETREAT_TARGET"]);
const STOCK_FULL_REASONS = Object.freeze(["STOCK_CAP", "STOCK_ITEMS_LIMIT"]);
const DELIVERY_STATES = Object.freeze(["STAGED", "REFITTING", "IDLE"]);
const MAX_DETAIL = 120;
const MS_DECIMALS = 100;
const LOST_READ_MAX = 1024;
const COUNTER_NAMES = Object.freeze(["dispatched", "localLoads", "loaded", "delivered", "deliveredUnits", "lostUnits",
  "aborted", "lost", "redirected", "reseek", "waits", "timeouts", "stale", "stockRefused", "reconciled", "pruned",
  "ignored", "orphansReleased", "dispatchRefused", "reconcileExhausted", "replenished", "replenishHulls",
  "tributeDispatched", "tributeDelivered", "tributeDeliveredUnits", "tributeLost",
  "tributeForfeited",
  "nudgeSkippedIntercepted"]);
const DUE_KEYS = Object.freeze(["convoyId", "phaseSeq", "round"]);
const NUDGE_KEYS = Object.freeze(["at", "fleetId", "legSeq", "state"]);
const SAVEPOINT_ABORT = Symbol("logistics-savepoint-abort");

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isText = (v) => typeof v === "string" && v.length >= 1 && v.length <= S.MAX_ID_LENGTH;
const messageOf = (err) => String((err && err.message) || err).slice(0, MAX_DETAIL);
const sameKeys = (p, keys) => Object.keys(p).sort().join() === [...keys].sort().join();

function call(fn, fallback) {
  try {
    return fn();
  } catch (_err) {
    return fallback;
  }
}

function parsePayload(p) {
  if (!p || typeof p !== "object" || Array.isArray(p)) return null;
  if (sameKeys(p, DUE_KEYS)) {
    if (!isText(p.convoyId) || !isTime(p.phaseSeq) || !isTime(p.round)) return null;
    return { kind: "due", convoyId: p.convoyId, phaseSeq: p.phaseSeq, round: p.round };
  }
  if (sameKeys(p, NUDGE_KEYS)) {
    if (!isText(p.fleetId) || !isTime(p.legSeq) || typeof p.state !== "string" || !isTime(p.at)) return null;
    return { kind: "nudge", fleetId: p.fleetId, legSeq: p.legSeq, state: p.state, at: p.at };
  }
  return null;
}

function loadOf(plan, stockItems) {
  const have = new Map((stockItems || []).map((it) => [`${it.itemKind}/${it.itemKey}`, it.quantity]));
  const out = {};
  for (const k of Object.keys(plan || {}).sort()) {
    const n = Math.min(plan[k], have.get(k) || 0);
    if (n > 0) out[k] = n;
  }
  return out;
}

function createLogisticsService(deps) {
  const { store, convoys, fleets, scheduler, clock, ids, config } = deps;
  const L = config.logistics;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
  const telemetry = deps.telemetry || null;
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
  const machineParams = Object.freeze({ maxWatchRounds: L.maxWatchRounds });
  const cargoParams = Object.freeze({ carrierCapacityM3: L.carrierCapacityM3,
    capacityM3: carrierCapacitiesM3(L, deps.industryCatalog || null) });
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
    metric("count", `logistics.${name}`, n);
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
    const ready = mode === STATION_MODE_READY && st;
    return { mode, locator: ready ? st.locator : null, repository: ready ? st.repository : null };
  }

  const savepoints = new WeakMap();
  function inSavepoint(tx, fn) {
    let run = savepoints.get(tx);
    if (!run) {
      run = tx.transaction((body, holder) => {
        const r = body();
        if (!r || r.ok !== true) {
          holder.refusal = r || { ok: false, reason: "LOGISTICS_FAILED" };
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

  function enqueueStep(tx, convoyId, phaseSeq, round, dueAt) {
    const r = scheduler.enqueue(S.CONVOY_EVENT_TYPE, convoyId, dueAt, { convoyId, phaseSeq, round },
      S.convoyDueKey(convoyId, phaseSeq, round), { tx, chained: true });
    if (!r || r.ok !== true) return { ok: false, reason: (r && r.reason) || "ENQUEUE_FAILED", stage: "step" };
    return { ok: true };
  }

  function stationOf(tx, repository, stationId, factionId) {
    const r = repository.getStation(tx, stationId);
    if (!r || !r.ok) return r || { ok: false, reason: "STATIONS_READ_FAILED" };
    const s = r.record;
    return { ok: true, station: s, good: Boolean(s && s.ownerFactionId === factionId && s.state === STATION_ONLINE) };
  }

  function destOwnerOf(purpose, factionId) {
    if (purpose !== S.TRIBUTE_PURPOSE) return factionId;
    const r = typeof deps.tributeRecipientOf === "function" ? call(() => deps.tributeRecipientOf(factionId), null)
      : null;
    return isId(r) ? r : null;
  }

  function constructionNow() {
    const c = typeof deps.getConstruction === "function" ? call(deps.getConstruction, null) : null;
    if (!c || typeof c.siteOfInTx !== "function" || typeof c.getMode !== "function") return null;
    return call(() => c.getMode(), "off") === STATION_MODE_READY ? c : null;
  }

  function siteOf(tx, repository, purpose, stationId, factionId) {
    if (purpose !== CONSTRUCTION_PURPOSE) return { ok: true, isSite: false };
    const r = repository.getStation(tx, stationId);
    if (!r || !r.ok) return r || { ok: false, reason: "STATIONS_READ_FAILED" };
    if (r.record) return { ok: true, isSite: false };
    const bad = (reason, construction) => ({ ok: true, isSite: true, systemId: null, good: false, reason,
      required: null, construction });
    const c = constructionNow();
    if (!c) return bad("CONSTRUCTION_OFF", null);
    const s = c.siteOfInTx(tx, stationId, factionId);
    if (!s || !s.ok) return s || { ok: false, reason: "CONSTRUCTION_READ_FAILED" };
    if (!s.isSite) return bad("NO_BUILD", c);
    return { ok: true, isSite: true, systemId: s.systemId, good: s.good === true, reason: s.reason || null,
      required: s.build ? s.build.required : null, construction: c };
  }

  function noteConstruction(result) {
    const c = typeof deps.getConstruction === "function" ? call(deps.getConstruction, null) : null;
    if (c && typeof c.noteCommitted === "function") call(() => c.noteCommitted(result), null);
  }

  function getOperation(tx, operationId) {
    if (!operationId) return { ok: true, operation: null };
    return fleets.repository.getOperation(tx, operationId);
  }

  function release(tx, fleet, operationIds, key, close) {
    let operationId = null;
    if (fleet && ["STAGED", "PLANNED"].includes(fleet.state) && operationIds.includes(fleet.operationId)) {
      operationId = fleet.operationId;
      const r = fleets.repository.transition(tx, { fleetId: fleet.fleetId, expectedVersion: fleet.version,
        from: fleet.state, to: "IDLE" }, `${key}:rel`);
      if (!r.ok) return { ...r, stage: "release" };
      if (r.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", detail: `${key}:rel` };
    }
    for (const id of operationIds.filter((x) => x)) {
      const o = getOperation(tx, id);
      if (!o.ok) return o;
      const op = o.operation;
      if (!op || !["PLANNED", "ACTIVE"].includes(op.state)) continue;
      const to = op.state === "PLANNED" ? "CANCELLED" : close.to;
      const c = fleets.repository.transitionOperation(tx, { operationId: id, expectedVersion: op.version,
        from: op.state, to, result: close.result }, `${key}:close:${id}`);
      if (!c.ok) {
        if (c.reason === "OPERATION_HAS_FLEETS") continue;
        return { ...c, stage: "close" };
      }
    }
    return { ok: true, releasedFrom: operationId };
  }

  function legInTx(tx, fleetId, factionId, from, target, at, key) {
    const f = fleets.repository.getFleet(tx, fleetId);
    if (!f.ok || !f.fleet) return f.ok ? { ok: false, reason: "FLEET_NOT_FOUND" } : f;
    return inSavepoint(tx, () => {
      const op = fleets.repository.createOperation(tx, { operationType: S.LOGISTICS_OPERATION_TYPE, factionId,
        originSystemId: from, targetSystemId: target, objective: S.OBJECTIVE_DELIVER, dueAt: null,
        fleets: [{ fleetId, expectedVersion: f.fleet.version }] }, `${key}:op`);
      if (!op.ok) return op;
      if (op.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", detail: `${key}:op` };
      const plan = fleets.travel.planInTx(tx, { fleetId, targetSystemId: target, at }, `${key}:plan`,
        { chained: true });
      if (!plan.ok) return plan;
      if (plan.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", detail: `${key}:plan` };
      return { ok: true, operationId: op.operationId, target, arriveAt: plan.arriveAt };
    });
  }

  function computeLoad(tx, repository, convoy, fleet) {
    const stock = repository.getStock(tx, convoy.sourceStationId);
    if (!stock || !stock.ok) return stock || { ok: false, reason: "STATIONS_READ_FAILED" };
    if (stock.truncated === true) return { ok: false, reason: "STOCK_READ_TRUNCATED" };
    const load = fitCargo(loadOf(convoy.plan, stock.items), capacityOf(fleet.composition, cargoParams));
    const vol = cargoVolume(load);
    return { ok: true, load, volume: vol.ok ? vol.volume : 0, units: cargoUnits(load) };
  }

  function takeStock(tx, repository, convoy, load, at) {
    const r = repository.applyStockChange(tx, { stationId: convoy.sourceStationId, key: S.convoyLoadKey(convoy.convoyId),
      reason: S.CONVOY_LOAD_REASON, at, deltas: toDeltas(load, -1) });
    if (!r.ok) return { ...r, stage: "load" };
    if (r.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", detail: S.convoyLoadKey(convoy.convoyId) };
    return { ok: true };
  }

  function dispatchInTx(tx, spec, idempotencyKey) {
    if (state === "stopped") return { ok: false, reason: "LOGISTICS_UNAVAILABLE", detail: "stopped" };
    if (!tx || tx.inTransaction !== true) return { ok: false, reason: "TX_REQUIRED" };
    if (!spec || !isId(spec.factionId) || !isText(spec.fleetId) || !isTime(spec.at)
      || !Number.isSafeInteger(spec.expectedVersion) || spec.expectedVersion < 1
      || !isText(spec.sourceStationId) || !isText(spec.destStationId)
      || typeof idempotencyKey !== "string" || idempotencyKey.length < 1
      || idempotencyKey.length > S.MAX_KEY_LENGTH - 20) {
      return { ok: false, reason: "LOGISTICS_INVALID_INPUT" };
    }
    if (!S.CONVOY_PURPOSES.includes(spec.purpose)) return { ok: false, reason: "LOGISTICS_INVALID_INPUT",
      detail: "purpose" };
    const convoyKey = `${idempotencyKey}:convoy`;
    const earlier = convoys.convoyIdOfKey(tx, convoyKey);
    if (!earlier.ok) return earlier;
    if (earlier.duplicate) {
      const c = convoys.getConvoy(tx, earlier.convoyId);
      if (!c.ok) return c;
      return { ok: true, duplicate: true, convoyId: earlier.convoyId, state: c.convoy ? c.convoy.state : null };
    }
    const { mode, repository } = stationsNow();
    if (mode !== STATION_MODE_READY || !repository) return { ok: false, reason: "STATIONS_NOT_READY" };
    const f = fleets.repository.getFleet(tx, spec.fleetId);
    if (!f.ok) return f;
    const fleet = f.fleet;
    if (!fleet || fleet.factionId !== spec.factionId || fleet.fleetRole !== S.LOGISTICS_ROLE) {
      return { ok: false, reason: "NOT_A_CONVOY_FLEET" };
    }
    if (fleet.version !== spec.expectedVersion) {
      return { ok: false, reason: "VERSION_CONFLICT", expectedVersion: spec.expectedVersion,
        actualVersion: fleet.version };
    }
    if (fleet.state !== "IDLE") return { ok: false, reason: "FLEET_NOT_IDLE", state: fleet.state };
    if (fleet.refitPending === true) return { ok: false, reason: "REFIT_PENDING" };
    const open = convoys.findOpenByFleet(tx, fleet.fleetId);
    if (!open.ok) return open;
    if (open.convoy) return { ok: false, reason: "CONVOY_OPEN", convoyId: open.convoy.convoyId };
    const carriers = carriersOf(fleet.composition);
    if (carriers < 1) return { ok: false, reason: "NO_CARRIERS" };
    const src = stationOf(tx, repository, spec.sourceStationId, spec.factionId);
    if (!src.ok) return src;
    if (!src.good) return { ok: false, reason: "SOURCE_INVALID" };
    const site = siteOf(tx, repository, spec.purpose, spec.destStationId, spec.factionId);
    if (!site.ok) return site;
    let destSystemId;
    if (site.isSite) {
      if (!site.good) return { ok: false, reason: "DEST_INVALID", detail: site.reason };
      destSystemId = site.systemId;
    } else {
      const owner = destOwnerOf(spec.purpose, spec.factionId);
      if (owner === null) return { ok: false, reason: "DEST_INVALID", detail: "NO_RECIPIENT" };
      const dst = stationOf(tx, repository, spec.destStationId, owner);
      if (!dst.ok) return dst;
      if (!dst.good) return { ok: false, reason: "DEST_INVALID" };
      destSystemId = dst.station.systemId;
    }
    if (spec.sourceStationId === spec.destStationId || src.station.systemId === destSystemId) {
      return { ok: false, reason: "SAME_STATION" };
    }
    if (!Array.isArray(spec.items) || spec.items.length > L.maxCargoItems) {
      return { ok: false, reason: "CARGO_INVALID", detail: "items" };
    }
    const plan = itemsToCargo(spec.items);
    if (!plan) return { ok: false, reason: "CARGO_INVALID", detail: "items" };
    if (site.isSite && !Object.keys(plan).every((k) => site.required
      && Object.prototype.hasOwnProperty.call(site.required, k))) {
      return { ok: false, reason: "CARGO_INVALID", detail: "KIT_ITEM" };
    }
    if (spec.purpose === S.TRIBUTE_PURPOSE && !spec.items.every((it) => it && it.itemKind === "mineral")) {
      return { ok: false, reason: "CARGO_INVALID", detail: "TRIBUTE_ITEM" };
    }
    const vol = cargoVolume(plan);
    if (!vol.ok) return vol;
    const capacity = capacityOf(fleet.composition, cargoParams);
    if (vol.volume > capacity) return { ok: false, reason: "CARGO_TOO_LARGE", volume: vol.volume, capacity };
    const ofFaction = convoys.countOpenOfFaction(tx, spec.factionId);
    if (!ofFaction.ok) return ofFaction;
    if (ofFaction.count >= L.maxOpenConvoysPerFaction) return { ok: false, reason: "CONVOY_FACTION_LIMIT" };
    const convoyId = ids.next("cv");
    const local = fleet.currentSystemId === src.station.systemId;
    const at = spec.at;
    const target = local ? destSystemId : src.station.systemId;
    return inSavepoint(tx, () => {
      const pruned = convoys.prune(tx, spec.factionId, Math.max(0, at - L.convoyRetentionMs), L.pruneBatch);
      if (!pruned.ok) return pruned;
      const op = fleets.repository.createOperation(tx, { operationType: S.LOGISTICS_OPERATION_TYPE,
        factionId: spec.factionId, originSystemId: fleet.currentSystemId, targetSystemId: target,
        objective: S.OBJECTIVE_DELIVER, dueAt: null, fleets: [{ fleetId: fleet.fleetId,
          expectedVersion: fleet.version }] }, `${idempotencyKey}:op`);
      if (!op.ok) return op;
      if (op.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", detail: `${idempotencyKey}:op` };
      const created = convoys.createConvoy(tx, { convoyId, idempotencyKey: convoyKey, factionId: spec.factionId,
        fleetId: fleet.fleetId, operationId: op.operationId, purpose: spec.purpose,
        sourceStationId: spec.sourceStationId, sourceSystemId: src.station.systemId,
        destStationId: spec.destStationId, destSystemId, plan, cargoVolume: vol.volume,
        dispatchedAt: at }, convoyKey);
      if (!created.ok) return created;
      let loaded = null;
      let units = 0;
      if (local) {
        const c = convoys.getConvoy(tx, convoyId);
        if (!c.ok || !c.convoy) return c.ok ? { ok: false, reason: "ROW_NOT_FOUND" } : c;
        const l = computeLoad(tx, repository, c.convoy, fleet);
        if (!l.ok) return l;
        if (l.units === 0) return { ok: false, reason: "NOTHING_TO_LOAD" };
        const took = takeStock(tx, repository, c.convoy, l.load, at);
        if (!took.ok) return took;
        const moved = convoys.transitionConvoy(tx, { convoyId, expectedVersion: c.convoy.version,
          from: S.CONVOY_TO_SOURCE, to: S.CONVOY_IN_TRANSIT, patch: { phaseSeq: 1, watchRound: 0, cargo: l.load,
            carriersAtLoad: carriers, loadedAt: at, cargoVolume: l.volume }, totals: { unitsLoaded: l.units } },
        `${idempotencyKey}:loaded`);
        if (!moved.ok) return moved;
        loaded = l.load;
        units = l.units;
      }
      const go = fleets.travel.planInTx(tx, { fleetId: fleet.fleetId, targetSystemId: target, at },
        `${idempotencyKey}:plan`, { chained: true });
      if (!go.ok) return go;
      const phase = local ? 1 : 0;
      const ev = enqueueStep(tx, convoyId, phase, 0, go.arriveAt + L.watchGraceMs);
      if (!ev.ok) return ev;
      return { ok: true, duplicate: false, convoyId, state: local ? S.CONVOY_IN_TRANSIT : S.CONVOY_TO_SOURCE,
        ...(loaded ? { loaded } : {}), arriveAt: go.arriveAt, pruned: pruned.pruned, local, units };
    });
  }

  function endInTx(tx, convoy, fleet, to, reason, at, key, out) {
    const rel = release(tx, fleet, [convoy.operationId], key, { to: "FAILED",
      result: { closedBy: "logistics", reason } });
    if (!rel.ok) return rel;
    const lost = to === S.CONVOY_LOST ? cargoUnits(convoy.cargo) : 0;
    const moved = convoys.transitionConvoy(tx, { convoyId: convoy.convoyId, expectedVersion: convoy.version,
      from: convoy.state, to, patch: { phaseSeq: convoy.phaseSeq + 1, endedAt: at, endReason: reason,
        lostUnits: convoy.lostUnits + lost },
      totals: to === S.CONVOY_LOST ? { convoysLost: 1, unitsLost: lost } : { convoysAborted: 1 } }, `${key}:end`);
    if (!moved.ok) return moved;
    out.lostUnits = lost;
    if (to === S.CONVOY_LOST && convoy.purpose === CONSTRUCTION_PURPOSE) {
      const { repository } = stationsNow();
      if (repository) {
        const site = siteOf(tx, repository, convoy.purpose, convoy.destStationId, convoy.factionId);
        if (!site.ok) return site;
        if (site.isSite && site.construction) {
          const l = site.construction.onConvoyLostInTx(tx, { stationId: convoy.destStationId,
            convoyId: convoy.convoyId, at });
          if (!l || !l.ok) return { ...(l || { ok: false, reason: "CONSTRUCTION_FAILED" }), stage: "site.lost" };
          out.siteLost = l;
        }
      }
    }
    return { ok: true };
  }

  function deliverInTx(tx, convoy, fleet, stationId, at, key, out) {
    const cargo = convoy.cargo || {};
    const scaled = scaleCargo(cargo, convoy.carriersAtLoad || 1, carriersOf(fleet.composition));
    const deltas = toDeltas(scaled.deliver, 1);
    if (deltas.length > 0) {
      const { repository } = stationsNow();
      if (!repository) return { ok: false, reason: "STATIONS_NOT_READY" };
      const site = siteOf(tx, repository, convoy.purpose, stationId, convoy.factionId);
      if (!site.ok) return site;
      if (site.isSite) {
        if (!site.good || !site.construction) return { ok: false, reason: SITE_INVALID, detail: site.reason };
        const rec = site.construction.receiveInTx(tx, { stationId, factionId: convoy.factionId,
          convoyId: convoy.convoyId, cargo: scaled.deliver, at });
        if (!rec || !rec.ok) return rec && rec.reason === SITE_INVALID ? rec
          : { ...(rec || { ok: false, reason: "CONSTRUCTION_FAILED" }), stage: "site" };
        if (rec.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", detail: `site:${convoy.convoyId}` };
        out.site = rec;
      } else {
        const stock = repository.applyStockChange(tx, { stationId, key: S.convoyDeliverKey(convoy.convoyId),
          reason: S.CONVOY_DELIVERY_REASON, at, deltas });
        if (!stock.ok) return { ...stock, stage: "stock" };
        if (stock.duplicate) {
          return { ok: false, reason: "NESTED_KEY_REUSED", detail: S.convoyDeliverKey(convoy.convoyId) };
        }
      }
    }
    const units = cargoUnits(scaled.deliver);
    const rel = release(tx, fleet, [convoy.operationId], key, { to: "COMPLETED",
      result: { closedBy: "logistics", delivered: units } });
    if (!rel.ok) return rel;
    const moved = convoys.transitionConvoy(tx, { convoyId: convoy.convoyId, expectedVersion: convoy.version,
      from: S.CONVOY_IN_TRANSIT, to: S.CONVOY_DELIVERED, patch: { phaseSeq: convoy.phaseSeq + 1,
        deliveredStationId: stationId, delivered: scaled.deliver, lostUnits: convoy.lostUnits + scaled.lostUnits,
        endedAt: at, endReason: "DELIVERED" },
      totals: { convoysDelivered: 1, unitsDelivered: units, unitsLost: scaled.lostUnits } }, `${key}:deliver`);
    if (!moved.ok) return moved;
    out.delivered = units;
    out.lostUnits = scaled.lostUnits;
    return { ok: true };
  }

  function loadInTx(tx, convoy, fleet, at, key, out) {
    const { repository } = stationsNow();
    if (!repository) return { ok: false, reason: "STATIONS_NOT_READY" };
    const l = computeLoad(tx, repository, convoy, fleet);
    if (!l.ok) return l;
    if (l.units === 0) {
      out.action = ACTION.ABORT;
      out.reason = "EMPTY";
      return endInTx(tx, convoy, fleet, S.CONVOY_ABORTED, "EMPTY", at, key, out);
    }
    const rel = release(tx, fleet, [convoy.operationId], key, { to: "COMPLETED",
      result: { closedBy: "logistics", loaded: l.units } });
    if (!rel.ok) return rel;
    const leg = legInTx(tx, fleet.fleetId, convoy.factionId, fleet.currentSystemId, convoy.destSystemId, at,
      `${key}:leg`);
    if (!leg.ok) {
      if (!ROUTE_SKIP_REASONS.includes(leg.reason)) return leg;
      out.action = ACTION.ABORT;
      out.reason = "NO_ROUTE";
      const f = fleets.repository.getFleet(tx, fleet.fleetId);
      if (!f.ok) return f;
      return endInTx(tx, convoy, f.fleet, S.CONVOY_ABORTED, "NO_ROUTE", at, key, out);
    }
    const took = takeStock(tx, repository, convoy, l.load, at);
    if (!took.ok) return took;
    const next = convoy.phaseSeq + 1;
    const moved = convoys.transitionConvoy(tx, { convoyId: convoy.convoyId, expectedVersion: convoy.version,
      from: S.CONVOY_TO_SOURCE, to: S.CONVOY_IN_TRANSIT, patch: { phaseSeq: next, watchRound: 0,
        operationId: leg.operationId, cargo: l.load, carriersAtLoad: carriersOf(fleet.composition), loadedAt: at,
        cargoVolume: l.volume }, totals: { unitsLoaded: l.units } }, `${key}:convoy`);
    if (!moved.ok) return moved;
    out.loadedUnits = l.units;
    return enqueueStep(tx, convoy.convoyId, next, 0, leg.arriveAt + L.watchGraceMs);
  }

  function replanInTx(tx, convoy, fleet, facts, redirect, at, key, out) {
    const rel = release(tx, fleet, [convoy.operationId], key, { to: "FAILED",
      result: { closedBy: "logistics", reason: redirect ? "REDIRECT" : "RESEEK" } });
    if (!rel.ok) return rel;
    const from = fleet.currentSystemId;
    const next = convoy.phaseSeq + 1;
    const move = (patch) => convoys.transitionConvoy(tx, { convoyId: convoy.convoyId, expectedVersion: convoy.version,
      from: S.CONVOY_IN_TRANSIT, to: S.CONVOY_IN_TRANSIT, patch: { phaseSeq: next, ...patch } }, `${key}:convoy`);
    if (redirect && facts.stationHereId !== null) {
      const moved = move({ watchRound: 0, operationId: null, destStationId: facts.stationHereId, destSystemId: from });
      if (!moved.ok) return moved;
      const f = fleets.repository.getFleet(tx, fleet.fleetId);
      if (!f.ok || !f.fleet) return f.ok ? { ok: false, reason: "FLEET_NOT_FOUND" } : f;
      out.redirectedHere = true;
      return deliverInTx(tx, moved.convoy, f.fleet, facts.stationHereId, at, key, out);
    }
    const targets = [];
    if (!redirect) targets.push({ stationId: convoy.destStationId, systemId: convoy.destSystemId });
    else {
      const { locator } = stationsNow();
      if (!locator) return { ok: false, reason: "STATIONS_NOT_READY" };
      const found = locator.findNearestStations(tx, { factionId: convoy.factionId, fromSystemId: from });
      if (!found || found.ok !== true) return found || { ok: false, reason: "STATIONS_READ_FAILED" };
      for (const sys of found.targets) {
        if (sys === from) continue;
        const has = locator.hasRepairStation(tx, convoy.factionId, sys);
        if (!has || has.ok !== true) return has || { ok: false, reason: "STATIONS_READ_FAILED" };
        if (has.stationId !== null) targets.push({ stationId: has.stationId, systemId: sys });
      }
    }
    for (let i = 0; i < targets.length; i += 1) {
      const leg = legInTx(tx, fleet.fleetId, convoy.factionId, from, targets[i].systemId, at, `${key}:leg:${i}`);
      if (!leg.ok) {
        if (ROUTE_SKIP_REASONS.includes(leg.reason)) continue;
        return leg;
      }
      const moved = move({ watchRound: 0, operationId: leg.operationId, destStationId: targets[i].stationId,
        destSystemId: targets[i].systemId });
      if (!moved.ok) return moved;
      return enqueueStep(tx, convoy.convoyId, next, 0, leg.arriveAt + L.watchGraceMs);
    }
    const round = convoy.watchRound + 1;
    const moved = move({ watchRound: round, operationId: null });
    if (!moved.ok) return moved;
    out.noTarget = true;
    return enqueueStep(tx, convoy.convoyId, next, round, at + L.watchRecheckMs);
  }

  function readFacts(tx, convoy, fleet, trigger, at) {
    const st = stationsNow();
    const facts = { at, trigger, sourceOk: false, destOk: false, stationHereId: null, stationsMode: st.mode,
      carriers: fleet ? carriersOf(fleet.composition) : 0 };
    if (!st.repository || !st.locator) return { ok: true, facts };
    const src = stationOf(tx, st.repository, convoy.sourceStationId, convoy.factionId);
    if (!src.ok) return src;
    facts.sourceOk = src.good;
    const site = siteOf(tx, st.repository, convoy.purpose, convoy.destStationId, convoy.factionId);
    if (!site.ok) return site;
    let toReceiver = false;
    if (site.isSite) facts.destOk = site.good;
    else {
      const owner = destOwnerOf(convoy.purpose, convoy.factionId);
      const dst = stationOf(tx, st.repository, convoy.destStationId, owner === null ? convoy.factionId : owner);
      if (!dst.ok) return dst;
      facts.destOk = dst.good;
      if (convoy.purpose === S.TRIBUTE_PURPOSE) {
        toReceiver = dst.good && owner !== null;
        if (!toReceiver) {
          facts.destOk = Boolean(dst.station && dst.station.ownerFactionId === convoy.factionId
            && dst.station.state === STATION_ONLINE);
        }
      }
    }
    if (fleet && fleet.state !== "DESTROYED") {
      const has = st.locator.hasRepairStation(tx, convoy.factionId, fleet.currentSystemId);
      if (!has || has.ok !== true) return has || { ok: false, reason: "STATIONS_READ_FAILED" };
      facts.stationHereId = has.stationId;
    }
    return { ok: true, facts, toReceiver };
  }

  function releaseOrphan(tx, fleet, key, out) {
    if (!fleet || fleet.fleetRole !== S.LOGISTICS_ROLE || fleet.state !== "STAGED" || !fleet.operationId) {
      return { ok: true };
    }
    const o = getOperation(tx, fleet.operationId);
    if (!o.ok) return o;
    if (!o.operation || o.operation.operationType !== S.LOGISTICS_OPERATION_TYPE) return { ok: true };
    const rel = release(tx, fleet, [fleet.operationId], key, { to: "FAILED",
      result: { closedBy: "logistics", reason: "ORPHAN" } });
    if (rel.ok) out.orphan = true;
    return rel;
  }

  function step(tx, ev, p, trigger) {
    const out = { action: ACTION.STALE, reason: null };
    const key = ev.idempotencyKey;
    let convoy;
    if (p.kind === "due") {
      const c = convoys.getConvoy(tx, p.convoyId);
      if (!c.ok) return c;
      convoy = c.convoy;
      if (!convoy || convoy.phaseSeq !== p.phaseSeq || convoy.watchRound !== p.round) return { ok: true, ...out };
    } else {
      const c = convoys.findOpenByFleet(tx, p.fleetId);
      if (!c.ok) return c;
      convoy = c.convoy;
      if (!convoy) {
        const f = fleets.repository.getFleet(tx, p.fleetId);
        if (!f.ok) return f;
        const r = releaseOrphan(tx, f.fleet, key, out);
        return r.ok ? { ok: true, ...out } : r;
      }
    }
    const fr = fleets.repository.getFleet(tx, convoy.fleetId);
    if (!fr.ok) return fr;
    const fleet = fr.fleet;
    const at = p.kind === "nudge" ? p.at : ev.dueAt;
    const facts = readFacts(tx, convoy, fleet, trigger, at);
    if (!facts.ok) return facts;
    const d = decideConvoyStep(convoy, fleet, facts.facts, machineParams);
    out.action = d.action;
    out.reason = d.reason || null;
    out.convoyId = convoy.convoyId;
    out.factionId = convoy.factionId;
    out.purpose = convoy.purpose;
    switch (d.action) {
      case ACTION.STALE:
      case ACTION.IGNORE:
        return { ok: true, ...out };
      case ACTION.RETRY_LATER:
        return { ok: false, reason: d.reason };
      case ACTION.WAIT: {
        const engaged = d.reason === "ENGAGED" || d.reason === "EXPOSED";
        const round = engaged ? convoy.watchRound : convoy.watchRound + 1;
        const phaseSeq = engaged ? convoy.phaseSeq + 1 : convoy.phaseSeq;
        const w = convoys.watchConvoy(tx, { convoyId: convoy.convoyId, expectedVersion: convoy.version,
          state: convoy.state, watchRound: round, ...(engaged ? { phaseSeq } : {}) }, `${key}:wait`);
        if (!w.ok) return w;
        const flightDue = fleet && isTime(fleet.nextActionAt) ? fleet.nextActionAt + L.watchGraceMs : 0;
        const e = enqueueStep(tx, convoy.convoyId, phaseSeq, round, Math.max(at + L.watchRecheckMs, flightDue));
        return e.ok ? { ok: true, ...out } : e;
      }
      case ACTION.LOAD: {
        const r = loadInTx(tx, convoy, fleet, at, key, out);
        return r.ok ? { ok: true, ...out } : r;
      }
      case ACTION.DELIVER: {
        const r = deliverInTx(tx, convoy, fleet, convoy.destStationId, at, key, out);
        if (r.ok && facts.toReceiver === true) out.tributeDelivered = true;
        if (r.ok) return { ok: true, ...out };
        if (STOCK_FULL_REASONS.includes(r.reason)) {
          out.action = ACTION.LOSE;
          out.reason = "STOCK_FULL";
          out.stockRefused = true;
          const e = endInTx(tx, convoy, fleet, S.CONVOY_LOST, "STOCK_FULL", at, key, out);
          return e.ok ? { ok: true, ...out } : e;
        }
        if (r.reason === "STATION_DESTROYED" || r.reason === SITE_INVALID) {
          out.action = ACTION.REDIRECT;
          out.reason = r.reason;
          const x = replanInTx(tx, convoy, fleet, { ...facts.facts, stationHereId: null }, true, at, key, out);
          return x.ok ? { ok: true, ...out } : x;
        }
        return r;
      }
      case ACTION.REDIRECT:
      case ACTION.RESEEK: {
        const r = replanInTx(tx, convoy, fleet, facts.facts, d.action === ACTION.REDIRECT, at, key, out);
        return r.ok ? { ok: true, ...out } : r;
      }
      case ACTION.ABORT:
      case ACTION.LOSE: {
        if (d.action === ACTION.LOSE && d.reason === "TIMEOUT" && facts.facts.stationHereId !== null
          && fleet && DELIVERY_STATES.includes(fleet.state) && facts.facts.carriers > 0) {
          out.action = ACTION.REDIRECT;
          const x = replanInTx(tx, convoy, fleet, facts.facts, true, at, key, out);
          return x.ok ? { ok: true, ...out } : x;
        }
        const e = endInTx(tx, convoy, fleet, d.action === ACTION.LOSE ? S.CONVOY_LOST : S.CONVOY_ABORTED,
          d.reason || "ABORTED", at, key, out);
        return e.ok ? { ok: true, ...out } : e;
      }
      default:
        return { ok: false, reason: "UNKNOWN_ACTION", permanent: true };
    }
  }

  function onCommitted(v) {
    if (!v || v.ok !== true) return;
    if (v.orphan) bump("orphansReleased");
    switch (v.action) {
      case ACTION.STALE: bump("stale"); break;
      case ACTION.IGNORE: bump("ignored"); break;
      case ACTION.WAIT: bump("waits"); break;
      case ACTION.LOAD: bump("loaded"); break;
      case ACTION.REDIRECT: bump("redirected"); break;
      case ACTION.RESEEK: bump("reseek"); break;
      case ACTION.ABORT: bump("aborted"); break;
      case ACTION.LOSE: bump("lost"); break;
      default: break;
    }
    if (v.delivered !== undefined) {
      bump("delivered");
      bump("deliveredUnits", v.delivered);
    }
    if (v.tributeDelivered === true) {
      bump("tributeDelivered");
      bump("tributeDeliveredUnits", v.delivered || 0);
    }
    if (v.purpose === S.TRIBUTE_PURPOSE && v.action === ACTION.LOSE) bump("tributeLost");
    if (v.site) noteConstruction(v.site);
    if (v.siteLost) noteConstruction(v.siteLost);
    if (v.reason === "TIMEOUT") bump("timeouts");
    if (v.stockRefused) bump("stockRefused");
    bump("lostUnits", v.lostUnits || 0);
    if (v.action === ACTION.LOSE || v.reason === "TIMEOUT") {
      log(`logistics: convoy ${v.convoyId} of ${v.factionId} ${v.action} ${v.reason || ""} lost=${v.lostUnits || 0}`);
    }
  }

  function handler(ev, hctx) {
    try {
      const p = parsePayload(ev && ev.payload);
      if (!p) return { ok: false, reason: "LOGISTICS_PAYLOAD_INVALID", permanent: true };
      if (state === "stopped") return { ok: false, reason: "LOGISTICS_STOPPED" };
      const trigger = p.kind === "nudge" ? "arrival"
        : (String(ev.idempotencyKey).startsWith("convoy:rec:") ? "reconcile" : "due");
      const t0 = nowMs();
      return { ok: true, outcome: "STEP", effect: (tx) => {
        const r = step(tx, ev, p, trigger);
        metric("observe", "logistics.stepMs", Math.round((nowMs() - t0) * MS_DECIMALS) / MS_DECIMALS);
        if (!r || r.ok !== true) lastRefusal = String((r && r.reason) || "STEP_FAILED");
        return r;
      }, onCommitted };
    } catch (err) {
      return { ok: false, reason: `LOGISTICS_STEP_FAILED: ${messageOf(err)}` };
    }
  }

  function onArrival(tx, a) {
    if (state === "stopped" || !a || a.fleetRole !== S.LOGISTICS_ROLE) return;
    if (a.intercepted === true) {
      bump("nudgeSkippedIntercepted");
      return;
    }
    scheduler.enqueue(S.CONVOY_EVENT_TYPE, a.fleetId, a.at, { fleetId: a.fleetId, legSeq: a.legSeq, state: a.state,
      at: a.at }, S.convoyNudgeKey(a.fleetId, a.legSeq, a.state), { tx, chained: true });
  }

  function reconcile() {
    try {
      const listed = store.transaction("logistics.reconcileRead", (db) => {
        const open = convoys.listOpen(db, { limit: L.reconcileMaxConvoys });
        if (!open.ok) return open;
        const staged = fleets.repository.listFleetsByState(db, "STAGED", { limit: L.reconcileMaxConvoys,
          role: S.LOGISTICS_ROLE });
        if (!staged.ok) return staged;
        const orphans = [];
        for (const f of staged.fleets) {
          if (f.fleetRole !== S.LOGISTICS_ROLE || !f.operationId) continue;
          const c = convoys.findOpenByFleet(db, f.fleetId);
          if (!c.ok) return c;
          if (!c.convoy) orphans.push({ fleetId: f.fleetId, legSeq: f.legSeq });
        }
        return { ok: true, convoys: open.convoys, orphans };
      });
      const r = listed.ok ? listed.value : listed;
      if (!r || !r.ok) return { ok: false, reason: (r && r.reason) || "TX_FAILED" };
      let enqueued = 0;
      let exhausted = 0;
      const now = clock.now();
      for (const o of r.orphans) {
        const e = scheduler.enqueue(S.CONVOY_EVENT_TYPE, o.fleetId, now, { fleetId: o.fleetId, legSeq: o.legSeq,
          state: "STAGED", at: now }, S.convoyOrphanKey(o.fleetId, o.legSeq));
        if (e && e.ok && !e.duplicate) enqueued += 1;
      }
      for (const c of r.convoys) {
        const slot = nextReconcileKey(scheduler, { dueKey: S.convoyDueKey(c.convoyId, c.phaseSeq, c.watchRound),
          baseKey: S.convoyReconcileKey(c.convoyId, c.phaseSeq, c.watchRound), maxAttempts: L.reconcileMaxAttempts });
        if (!slot.ok) return slot;
        if (slot.open) continue;
        if (slot.exhausted) {
          exhausted += 1;
          log(`logistics: reconcile ${c.convoyId} exhausted ${L.reconcileMaxAttempts} attempts`);
          continue;
        }
        const e = scheduler.enqueue(S.CONVOY_EVENT_TYPE, c.convoyId, now,
          { convoyId: c.convoyId, phaseSeq: c.phaseSeq, round: c.watchRound }, slot.key);
        if (e && e.ok && !e.duplicate) enqueued += 1;
        else if (!e || !e.ok) log(`logistics: reconcile ${c.convoyId} refused ${(e && e.reason) || "?"}`);
      }
      bump("reconciled", enqueued);
      bump("reconcileExhausted", exhausted);
      return { ok: true, open: r.convoys.length, enqueued, exhausted };
    } catch (err) {
      return { ok: false, reason: `RECONCILE_FAILED: ${messageOf(err)}` };
    }
  }

  function readOpen(tx, factionId, opts) {
    if (state === "stopped") return { ok: false, reason: "LOGISTICS_UNAVAILABLE", detail: "stopped" };
    const limit = opts && Number.isSafeInteger(opts.limit) && opts.limit >= 0 ? opts.limit : L.maxOpenConvoysPerFaction;
    const r = convoys.listOpenOfFaction(tx, factionId, limit + 1);
    if (!r.ok) return r;
    return { ok: true, truncated: r.convoys.length > limit, convoys: r.convoys.slice(0, limit).map((c) => ({
      convoyId: c.convoyId, fleetId: c.fleetId, state: c.state, purpose: c.purpose, sourceStationId: c.sourceStationId,
      destStationId: c.destStationId, destSystemId: c.destSystemId, items: { ...(c.cargo || c.plan || {}) } })) };
  }

  function listInTransitInTx(tx, opts) {
    if (state === "stopped") return { ok: false, reason: "LOGISTICS_UNAVAILABLE", detail: "stopped" };
    const o = opts || {};
    if (!Number.isSafeInteger(o.limit) || o.limit < 1) return { ok: false, reason: "LOGISTICS_INVALID_INPUT",
      detail: "limit" };
    if (o.after !== undefined && typeof o.after !== "string") return { ok: false, reason: "LOGISTICS_INVALID_INPUT",
      detail: "after" };
    const r = convoys.listInTransit(tx, { limit: o.limit + 1, after: o.after });
    if (!r.ok) return r;
    return { ok: true, truncated: r.convoys.length > o.limit, convoys: r.convoys.slice(0, o.limit)
      .map((c) => ({ convoyId: c.convoyId, factionId: c.factionId, fleetId: c.fleetId, destSystemId: c.destSystemId,
        purpose: c.purpose, cargo: { ...(c.cargo || {}) }, carriersAtLoad: c.carriersAtLoad })) };
  }

  function listLostInTx(tx, opts) {
    if (state === "stopped") return { ok: false, reason: "LOGISTICS_UNAVAILABLE", detail: "stopped" };
    const o = opts || {};
    if (!Number.isSafeInteger(o.limit) || o.limit < 1 || o.limit > LOST_READ_MAX) {
      return { ok: false, reason: "LOGISTICS_INVALID_INPUT", detail: "limit" };
    }
    if (!Number.isSafeInteger(o.sinceMs) || o.sinceMs < 0) {
      return { ok: false, reason: "LOGISTICS_INVALID_INPUT", detail: "sinceMs" };
    }
    const r = convoys.lostSince(tx, o.sinceMs, o.limit + 1);
    if (!r.ok) return r;
    const out = [];
    for (const c of r.rows.slice(0, o.limit)) {
      const f = typeof c.fleetId === "string" && c.fleetId !== "" ? fleets.repository.getFleet(tx, c.fleetId) : null;
      if (f && f.ok !== true) return f;
      const systemId = f && f.fleet && Number.isSafeInteger(f.fleet.currentSystemId) && f.fleet.currentSystemId > 0
        ? f.fleet.currentSystemId : null;
      out.push({ convoyId: c.convoyId, factionId: c.factionId, fleetId: c.fleetId, systemId, lostUnits: c.lostUnits,
        endedAt: c.endedAt });
    }
    return { ok: true, truncated: r.rows.length > o.limit, convoys: out };
  }

  return Object.freeze({
    getMode: () => (state === "stopped" ? "off" : state),
    dispatchInTx,
    readOpen,
    listInTransitInTx,
    listLostInTx,
    handler,
    onArrival,
    reconcile,
    count: (name, n = 1) => bump(name, n),
    noteRefusal: (reason) => { lastRefusal = String(reason); },
    getStatus: () => Object.freeze({ state, seq, counters: Object.freeze({ ...counters }), lastRefusal }),
    stop() {
      state = "stopped";
      seq += 1;
    },
    isStopped: () => state === "stopped",
  });
}

module.exports = { createLogisticsService, parsePayload, loadOf, COUNTER_NAMES };
