"use strict";

const { createRng, deriveSeed } = require("../util/rng");
const { BENCH_FACTIONS, BENCH_COMPOSITIONS, ROAM_TARGET_TRIES, DWELL_SPREAD_MIN, DWELL_SPREAD_SPAN,
  BENCH_START_SEC_CLASS, BENCH_OPERATION } = require("./data/benchProfile");

const BENCH_EVENT_TYPE = "BENCH_FLEET_ROAM";
const BENCH_FLEET_PREFIX = "lnebench-";
const INDEX_DIGITS = 5;
const KEY_VERSION = "bench:v1";
const COUNTER_NAMES = Object.freeze(["seeded", "planned", "waiting", "stale", "noTarget", "refused"]);
const OUTCOME = Object.freeze({ SEEDED: "SEEDED", PLANNED: "PLANNED", WAITING: "WAITING", STALE: "STALE" });

const fleetIdOf = (index) => `${BENCH_FLEET_PREFIX}${String(index).padStart(INDEX_DIGITS, "0")}`;
const fleetKey = (index) => `${KEY_VERSION}:fleet:${index}`;
const roamKey = (index, round) => `${KEY_VERSION}:roam:${index}:${round}`;
const opKey = (fleetId, round) => `${KEY_VERSION}:op:${fleetId}:${round}`;
const planKey = (fleetId, round) => `${KEY_VERSION}:plan:${fleetId}:${round}`;

function messageOf(err) {
  return String((err && err.message) || err);
}

function isIndex(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function createBench(deps) {
  const { store, repository, travel, scheduler, graph, worldSeed, clock, settings } = deps;
  const telemetry = deps.telemetry || null;
  const setImmediateFn = typeof deps.setImmediateFn === "function" ? deps.setImmediateFn : (fn) => setImmediate(fn);
  const counters = Object.fromEntries(COUNTER_NAMES.map((name) => [name, 0]));
  let lastRefusal = null;

  function bump(name) {
    counters[name] += 1;
    if (!telemetry || typeof telemetry.count !== "function") return;
    try {
      telemetry.count(`fleets.bench.${name}`, 1);
    } catch (_err) {
    }
  }

  function currentGraph() {
    try {
      const r = graph && typeof graph.getGraph === "function" ? graph.getGraph() : null;
      return r && r.ok === true && r.graph ? r.graph : null;
    } catch (_err) {
      return null;
    }
  }

  function dwellOf(fleetId, round) {
    const rng = createRng(deriveSeed(worldSeed, "bench", fleetId, round));
    return Math.round(settings.dwellMs * (DWELL_SPREAD_MIN + DWELL_SPREAD_SPAN * rng.nextFloat()));
  }

  let startPool = null;
  function startPoolOf(g) {
    if (startPool === null || startPool.graph !== g) {
      const ids = g.getSystemsBySecClass(BENCH_START_SEC_CLASS).filter((id) => (g.getNeighbors(id) || []).length > 0);
      startPool = { graph: g, ids };
    }
    return startPool.ids;
  }

  function pickTarget(g, from, fleetId, round) {
    const rng = createRng(deriveSeed(worldSeed, "bench", "target", fleetId, round));
    for (let attempt = 0; attempt < ROAM_TARGET_TRIES; attempt += 1) {
      const steps = rng.nextInt(1, settings.roamMaxJumps);
      let at = from;
      let away = null;
      for (let i = 0; i < steps; i += 1) {
        const next = rng.pick(g.getNeighbors(at) || []);
        if (next === undefined) break;
        at = next;
        if (at !== from) away = at;
      }
      if (away === null) continue;
      at = away;
      const found = g.findRoute(from, at);
      if (found && found.ok === true && found.jumps > 0) return at;
    }
    return null;
  }

  function planEffect(spec) {
    return (tx) => {
      const { index, round, fleetId, start, target, at, create, factionId } = spec;
      let version = spec.version;
      if (create) {
        const created = repository.createFleet(tx, { fleetId, factionId, currentSystemId: start, homeSystemId: start,
          fleetRole: BENCH_OPERATION.fleetRole, doctrineId: BENCH_OPERATION.doctrineId,
          composition: BENCH_COMPOSITIONS[index % BENCH_COMPOSITIONS.length].map((e) => ({ ...e })) },
        fleetKey(index));
        if (!created.ok) return created;
        version = created.duplicate ? version : created.version;
      }
      const op = repository.createOperation(tx, { operationType: BENCH_OPERATION.operationType, factionId,
        originSystemId: start, targetSystemId: target, objective: BENCH_OPERATION.objective, dueAt: at,
        fleets: [{ fleetId, expectedVersion: version }] }, opKey(fleetId, round));
      if (!op.ok) return op;
      const plan = travel.planInTx(tx, { fleetId, targetSystemId: target, at }, planKey(fleetId, round),
        { chained: true });
      if (!plan.ok) return plan;
      const base = plan.duplicate ? at : plan.arriveAt;
      const next = scheduler.enqueue(BENCH_EVENT_TYPE, fleetId, base + dwellOf(fleetId, round),
        { index, round: round + 1 }, roamKey(index, round + 1), { tx, chained: true });
      if (!next || next.ok !== true) return { ok: false, reason: (next && next.reason) || "ENQUEUE_FAILED" };
      return { ok: true };
    };
  }

  function counted(fn) {
    return (tx, ev) => {
      const r = fn(tx, ev);
      if (!r || r.ok !== true) {
        bump("refused");
        lastRefusal = String((r && r.reason) || "EFFECT_FAILED");
      }
      return r;
    };
  }

  function waiting(index, round, at, fleet) {
    bump("waiting");
    const after = fleet && Number.isSafeInteger(fleet.nextActionAt) ? Math.max(at, fleet.nextActionAt) : at;
    return { ok: true, outcome: OUTCOME.WAITING, reschedule: { dueAt: after + dwellOf(fleetIdOf(index), round),
      payload: { index, round: round + 1 }, idempotencyKey: roamKey(index, round + 1) } };
  }

  function onRoam(ev, hctx) {
    const p = ev.payload;
    if (!p || !isIndex(p.index) || !isIndex(p.round)) {
      return { ok: false, reason: "BENCH_PAYLOAD_INVALID", permanent: true };
    }
    const { index, round } = p;
    const fleetId = fleetIdOf(index);
    if (index >= settings.fleets || ev.aggregateId !== fleetId) {
      bump("stale");
      return { ok: true, outcome: OUTCOME.STALE };
    }
    const at = hctx && Number.isSafeInteger(hctx.anchorAt) ? hctx.anchorAt : ev.dueAt;
    const read = store.transaction("fleets.benchRead", (tx) => repository.getFleet(tx, fleetId));
    if (!read.ok) return { ok: false, reason: read.reason || "TX_FAILED" };
    if (!read.value.ok) return { ok: false, reason: read.value.reason };
    const fleet = read.value.fleet;
    if ((!fleet && round > 0) || (fleet && (fleet.state === "DESTROYED" || round === 0))) {
      bump("stale");
      return { ok: true, outcome: OUTCOME.STALE };
    }
    if (fleet && fleet.state !== "IDLE") return waiting(index, round, at, fleet);
    const g = currentGraph();
    if (!g) return { ok: false, reason: "GRAPH_NOT_READY" };
    let start;
    if (fleet) start = fleet.currentSystemId;
    else {
      const pick = createRng(deriveSeed(worldSeed, "bench", index)).pick(startPoolOf(g));
      if (pick === undefined) return { ok: false, reason: "BENCH_NO_START_SYSTEM" };
      start = pick;
    }
    const target = pickTarget(g, start, fleetId, round);
    if (target === null) {
      bump("noTarget");
      if (!fleet) return { ok: false, reason: "BENCH_NO_TARGET" };
      return waiting(index, round, at, fleet);
    }
    const factionId = fleet ? fleet.factionId : BENCH_FACTIONS[index % BENCH_FACTIONS.length];
    const outcome = fleet ? OUTCOME.PLANNED : OUTCOME.SEEDED;
    bump(fleet ? "planned" : "seeded");
    return { ok: true, outcome, effect: counted(planEffect({ index, round, fleetId, start, target, at,
      create: !fleet, factionId, version: fleet ? fleet.version : 1 })) };
  }

  const handlers = Object.freeze({
    [BENCH_EVENT_TYPE]: (ev, hctx) => {
      try {
        return onRoam(ev, hctx);
      } catch (err) {
        return { ok: false, reason: `HANDLER_FAILED: ${messageOf(err)}` };
      }
    },
  });

  async function seed(opts = {}) {
    try {
      return await seedSlices(opts);
    } catch (err) {
      return { ok: false, reason: `SEED_THREW: ${messageOf(err)}`, enqueued: 0, duplicates: 0 };
    }
  }

  async function seedSlices(opts) {
    const isActive = typeof opts.isActive === "function" ? opts.isActive : () => true;
    const now = clock.now();
    const maxRows = Math.max(1, store.limits.maxRowsPerTransaction || 1);
    const sliceRows = Number.isSafeInteger(settings.seedBatchRows) && settings.seedBatchRows > 0
      ? settings.seedBatchRows : maxRows;
    const batch = Math.min(sliceRows, maxRows);
    let enqueued = 0;
    let duplicates = 0;
    for (let from = 0; from < settings.fleets; from += batch) {
      if (from > 0) {
        await new Promise((resolve) => setImmediateFn(resolve));
        if (!isActive()) return { ok: false, reason: "BENCH_STOPPED", enqueued, duplicates };
      }
      const specs = [];
      for (let index = from; index < Math.min(settings.fleets, from + batch); index += 1) {
        specs.push({ eventType: BENCH_EVENT_TYPE, aggregateId: fleetIdOf(index),
          dueAt: now + Math.floor((settings.dwellMs * index) / settings.fleets), payload: { index, round: 0 },
          idempotencyKey: roamKey(index, 0) });
      }
      const r = scheduler.enqueueMany(specs);
      if (!r || r.ok !== true) return { ok: false, reason: (r && r.reason) || "SEED_FAILED", enqueued, duplicates };
      enqueued += r.enqueued;
      duplicates += r.duplicates;
      if (r.refusal) return { ok: false, reason: r.refusal.reason || "SEED_REFUSED", enqueued, duplicates };
    }
    return { ok: true, enqueued, duplicates };
  }

  function getStatus() {
    return Object.freeze({ target: settings.fleets, dwellMs: settings.dwellMs, roamMaxJumps: settings.roamMaxJumps,
      counters: Object.freeze({ ...counters }), lastRefusal });
  }

  return Object.freeze({ seed, handlers, getStatus });
}

function checkBenchInvariants(db, opts) {
  try {
    const now = Number(opts && opts.now);
    const lag = Number(opts && opts.catchUpLagMs);
    if (!Number.isSafeInteger(now) || !Number.isSafeInteger(lag) || lag < 0) {
      return { ok: false, reason: "CHECK_INVALID_INPUT" };
    }
    const like = `${BENCH_FLEET_PREFIX}%`;
    const perFleet = db.prepare(`SELECT f.fleet_id AS id, f.state AS state, f.next_action_at AS due,
        coalesce(j.plans, 0) AS plans, coalesce(j.arrivals, 0) AS arrivals
      FROM virtual_fleets f LEFT JOIN (
        SELECT aggregate_id,
          sum(json_extract(payload, '$.to') IN ('TRAVELLING', 'RETREATING')) AS plans,
          sum(json_extract(payload, '$.from') IN ('TRAVELLING', 'RETREATING')
            AND json_extract(payload, '$.to') IN ('STAGED', 'REFITTING')) AS arrivals
        FROM world_event_journal
        WHERE kind = 'APPLY' AND event_type = 'FLEET_TRANSITION' AND aggregate_id LIKE ?
        GROUP BY aggregate_id) j ON j.aggregate_id = f.fleet_id
      WHERE f.fleet_id LIKE ?`).all(like, like);
    const out = { ok: true, fleets: perFleet.length, plans: 0, arrivals: 0, inFlight: 0, doubleArrivals: 0,
      lostArrivals: 0, inFlightMismatch: 0, quarantined: 0, claimed: 0, operations: {} };
    for (const row of perFleet) {
      const flying = row.state === "TRAVELLING" || row.state === "RETREATING";
      out.plans += row.plans;
      out.arrivals += row.arrivals;
      if (flying) out.inFlight += 1;
      if (row.arrivals > row.plans) out.doubleArrivals += 1;
      if (flying && row.due !== null && row.due < now - lag) out.lostArrivals += 1;
      if (row.plans - row.arrivals !== (flying ? 1 : 0)) out.inFlightMismatch += 1;
    }
    for (const row of db.prepare("SELECT state, count(*) AS n FROM world_scheduled_events "
      + "WHERE state <> 'DONE' AND state IN ('QUARANTINED', 'CLAIMED') GROUP BY state").all()) {
      if (row.state === "QUARANTINED") out.quarantined = row.n;
      else out.claimed = row.n;
    }
    for (const row of db.prepare("SELECT state, count(*) AS n FROM world_operations GROUP BY state").all()) {
      out.operations[row.state] = row.n;
    }
    out.pass = out.doubleArrivals === 0 && out.lostArrivals === 0 && out.inFlightMismatch === 0
      && out.quarantined === 0 && out.claimed === 0;
    return out;
  } catch (err) {
    return { ok: false, reason: "CHECK_FAILED", detail: messageOf(err) };
  }
}

module.exports = { createBench, checkBenchInvariants, BENCH_EVENT_TYPE, BENCH_FLEET_PREFIX, OUTCOME, fleetIdOf,
  roamKey, fleetKey };
