"use strict";

const { performance } = require("node:perf_hooks");
const { CONTACTABLE_STATES } = require("../../battle/data/contactRules");
const { pairKeyOf } = require("../../battle/contacts");
const { jumpMsForComposition } = require("../../fleets/travel");
const { bfs } = require("../ai/bfs");
const { decideScan, decideExpire } = require("./pinRules");
const { claimHoldGuardOf, readClaimHoldInTx } = require("../claimHoldGuard");
const { TARGET_ROLES, STRIKE_ROLES, HOLD_STATES, RETRYABLE_REASONS, SCAN_OUTCOMES } = require("./data/huntRules");

const SCAN_EVENT = "HUNT_SCAN";
const EXPIRE_EVENT = "HUNT_PIN_EXPIRE";
const PIN_AGGREGATE = "hunt_pin";
const HUNTER_ROLE = "hunter";
const PASS_STATES = Object.freeze(["ENGAGED", "TRAVELLING", "RETREATING"]);
const IN_FLIGHT = Object.freeze(["TRAVELLING", "RETREATING"]);
const MAX_DETAIL = 120;
const MS_DECIMALS = 10;
const COUNTER_NAMES = Object.freeze(["scans", "pinsCreated", "noPin", "scanRefused", "enqueueRefused", "pinsStruck",
  "pinsEscaped", "pinsBroken", "pinsCancelled", "expireStale", "departurePinned", "guardReads"]);
const CLOSE_COUNTER = Object.freeze({ STRUCK: "pinsStruck", ESCAPED: "pinsEscaped", BROKEN: "pinsBroken",
  CANCELLED: "pinsCancelled" });
const SCAN_KEYS = Object.freeze(["at", "hunterFleetId", "systemId"]);

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const messageOf = (err) => String((err && err.message) || err).slice(0, MAX_DETAIL);

function parseScanPayload(p) {
  if (!isPlain(p) || Object.keys(p).sort().join() !== SCAN_KEYS.join()) return null;
  if (!isId(p.systemId) || !isTime(p.at)) return null;
  if (p.hunterFleetId !== null && (typeof p.hunterFleetId !== "string" || p.hunterFleetId === "")) return null;
  return { systemId: p.systemId, at: p.at, hunterFleetId: p.hunterFleetId };
}

function parseExpirePayload(p) {
  if (!isPlain(p) || Object.keys(p).join() !== "pinId" || typeof p.pinId !== "string" || p.pinId === "") return null;
  return { pinId: p.pinId };
}

function createHuntService(deps) {
  const { store, journal, pins, scheduler, fleetRepository, travel, battle, clock, ids, config } = deps;
  const C = config.hunt;
  const engageDelayMs = config.battle.engageDelayMs;
  const timeFactor = config.fleets.travelTimeFactor;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
  const telemetry = deps.telemetry || null;
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
  const params = Object.freeze({ targetRoles: TARGET_ROLES, strikeRoles: STRIKE_ROLES, holdStates: HOLD_STATES,
    pinBaseMs: C.pinBaseMs, pinMinMs: C.pinMinMs, pinMaxMs: C.pinMaxMs, speedPenaltyPermille: C.speedPenaltyPermille,
    maxActivePins: C.maxActivePins, maxActivePinsPerFaction: C.maxActivePinsPerFaction,
    strikeMaxJumps: C.strikeMaxJumps, pinGraceMs: C.pinGraceMs, attackStrengthRatio: C.attackStrengthRatio,
    maxHuntersPerScan: C.maxHuntersPerScan });
  const counters = Object.fromEntries(COUNTER_NAMES.map((n) => [n, 0]));
  const noPinByReason = Object.fromEntries(SCAN_OUTCOMES.filter((o) => o !== "PIN").map((o) => [o, 0]));
  let state = "running";
  let lastRefusal = null;
  let openCount = 0;
  const claimGuard = claimHoldGuardOf(config);
  const worldNow = () => {
    try {
      const w = typeof deps.getWorld === "function" ? deps.getWorld() : null;
      return w && w.repository ? w.repository : null;
    } catch (_err) {
      return null;
    }
  };

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
    metric("count", `hunt.${name}`, n);
  }

  function setOpen(n) {
    openCount = Math.max(0, n);
    metric("gauge", "hunt.open", openCount);
  }

  function noPin(reason) {
    bump("noPin");
    if (own(noPinByReason, reason)) noPinByReason[reason] += 1;
  }

  function log(line) {
    try {
      logger.log(line);
    } catch (_err) {
    }
  }

  const stopped = () => state !== "running";

  function graphNow() {
    try {
      const r = typeof deps.getGraph === "function" ? deps.getGraph() : null;
      return r && r.ok === true && r.graph ? r.graph : null;
    } catch (_err) {
      return null;
    }
  }

  function enqueueScan(tx, systemId, at, hunterFleetId, key) {
    const r = scheduler.enqueue(SCAN_EVENT, String(systemId), at, { systemId, at, hunterFleetId }, key,
      { tx, chained: true });
    if (!r || r.ok !== true) bump("enqueueRefused");
  }

  function onArrival(tx, arrival) {
    if (stopped() || !arrival || !isId(arrival.systemId) || !isTime(arrival.at)) return;
    if (arrival.fleetRole === HUNTER_ROLE) {
      if (arrival.state !== "STAGED") return;
      enqueueScan(tx, arrival.systemId, arrival.at, arrival.fleetId,
        `hunt:scan:${arrival.systemId}:arr:${arrival.fleetId}:${arrival.legSeq}`);
      return;
    }
    if (C.scanOnHostileArrival !== true || !TARGET_ROLES.includes(arrival.fleetRole)) return;
    const l = fleetRepository.listFleetsInSystem(tx, arrival.systemId, { states: [...HOLD_STATES],
      limit: C.scanMaxFleets + 1 });
    if (!l || l.ok !== true) return;
    if (!l.fleets.some((f) => f.fleetRole === HUNTER_ROLE && deps.isHostile(f.factionId, arrival.factionId) === true)) {
      return;
    }
    enqueueScan(tx, arrival.systemId, arrival.at, null,
      `hunt:scan:${arrival.systemId}:hostile:${arrival.fleetId}:${arrival.legSeq}`);
  }

  function etaOf(fleet, jumps) {
    const base = jumpMsForComposition(fleet.composition, { timeFactor });
    if (!base.ok) return null;
    try {
      return jumps * Math.max(1, clock.travelDurationMs(base.baseJumpMs, { observed: false }));
    } catch (_err) {
      return null;
    }
  }

  const liveFromAt = (at) => at - engageDelayMs;

  function closeOverdueInTx(db, pin, at) {
    const f = fleetRepository.getFleets(db, [pin.hunterFleetId, pin.targetFleetId, pin.strikeFleetId]
      .filter((id) => typeof id === "string"));
    if (!f.ok) return f;
    const by = new Map(f.fleets.map((x) => [x.fleetId, x]));
    const of = (id) => (typeof id === "string" ? by.get(id) || null : null);
    const d = decideExpire({ pin, hunter: of(pin.hunterFleetId), target: of(pin.targetFleetId),
      strike: of(pin.strikeFleetId) });
    if (!d.close) return { ok: false, reason: "STALE", detail: pin.pinId };
    const r = journal.applyOnce(db, { key: `hunt:pin:${pin.pinId}:close`,
      aggregate: { type: PIN_AGGREGATE, id: pin.pinId }, eventType: "HUNT_PIN_CLOSED",
      payload: { pinId: pin.pinId, outcome: d.outcome } }, (tx) => pins.closePin(tx, { pinId: pin.pinId,
      expectedVersion: pin.version, outcome: d.outcome, at }));
    if (!r.ok || r.duplicate) return r.ok ? { ok: false, reason: "STALE", detail: pin.pinId } : (r.refusal || r);
    return { ok: true, pinId: pin.pinId, outcome: d.outcome };
  }

  function reconcileOverdue(db, hunterFleetId, targetFleetId, at) {
    const closed = [];
    const liveFrom = liveFromAt(at);
    for (const [read, reason] of [[() => pins.getActivePinForHunter(db, hunterFleetId), "HUNTER_PINNED"],
      [() => pins.getActivePinForTarget(db, targetFleetId), "TARGET_PINNED"]]) {
      const g = read();
      if (!g.ok) return g;
      if (!g.pin) continue;
      if (g.pin.untilAt >= liveFrom) return { ok: false, reason };
      const c = closeOverdueInTx(db, g.pin, at);
      if (!c.ok) return c;
      closed.push({ pinId: c.pinId, outcome: c.outcome });
    }
    return { ok: true, closed };
  }

  function readScan(db, p, graph) {
    const hunters = [];
    if (p.hunterFleetId !== null) {
      const g = fleetRepository.getFleet(db, p.hunterFleetId);
      if (!g.ok) return g;
      if (g.fleet && g.fleet.fleetRole === HUNTER_ROLE) hunters.push(g.fleet);
    } else {
      const l = fleetRepository.listFleetsInSystem(db, p.systemId, { states: [...HOLD_STATES],
        limit: C.scanMaxFleets + 1 });
      if (!l.ok) return l;
      hunters.push(...l.fleets.filter((f) => f.fleetRole === HUNTER_ROLE).slice(0, C.maxHuntersPerScan));
    }
    const fl = fleetRepository.listFleetsInSystem(db, p.systemId, { states: [...CONTACTABLE_STATES],
      limit: C.scanMaxFleets + 1 });
    if (!fl.ok) return fl;
    const truncated = fl.fleets.length > C.scanMaxFleets || fl.nextAfterFleetId !== null;
    const fleets = fl.fleets.slice(0, C.scanMaxFleets);
    const pinnedHunters = new Set();
    const live = { liveFrom: liveFromAt(p.at) };
    for (const h of hunters) {
      const a = pins.getActivePinForHunter(db, h.fleetId, live);
      if (!a.ok) return a;
      if (a.pin) pinnedHunters.add(h.fleetId);
    }
    const targets = pins.activeTargetsAmong(db, fleets.map((f) => f.fleetId), live);
    if (!targets.ok) return targets;
    const total = pins.countActive(db, live);
    if (!total.ok) return total;
    const activeByFaction = new Map();
    const candidates = new Map();
    const factions = [...new Set(hunters.map((h) => h.factionId))].sort((a, b) => a - b);
    const reach = factions.length > 0 ? bfs([p.systemId], (id) => graph.getNeighbors(id),
      { maxJumps: C.strikeMaxJumps, maxSystems: C.maxBfsSystems }) : new Map();
    const world = claimGuard && factions.length > 0 ? worldNow() : null;
    for (const f of factions) {
      const c = pins.countActive(db, { factionId: f, ...live });
      if (!c.ok) return c;
      activeByFaction.set(f, c.count);
      const hold = readClaimHoldInTx(db, world, f, p.at, claimGuard);
      if (!hold.ok) return hold;
      const page = [];
      for (const role of STRIKE_ROLES) {
        const l = fleetRepository.listFleetsByFaction(db, f, { states: ["IDLE"], role, limit: C.strikeScanMaxFleets });
        if (!l.ok) return l;
        page.push(...l.fleets);
      }
      page.sort((a, b) => (a.fleetId < b.fleetId ? -1 : a.fleetId > b.fleetId ? 1 : 0));
      const list = [];
      for (const fleet of page.slice(0, C.strikeScanMaxFleets)) {
        const jumps = reach.get(fleet.currentSystemId);
        if (jumps === undefined || hold.holds(fleet)) continue;
        list.push({ fleet, jumps, etaEstimateMs: etaOf(fleet, jumps) });
      }
      candidates.set(f, list);
    }
    const cool = battle.readCooldownsInTx(db, p.systemId);
    if (!cool || cool.ok !== true) return cool || { ok: false, reason: "COOLDOWNS_READ_FAILED" };
    return { ok: true, input: { at: p.at, systemId: p.systemId, hunters, fleets, truncated, pinnedHunters,
      pinnedTargets: targets.fleetIds, activeTotal: total.count, activeByFaction, cooldowns: cool.cooldowns,
      candidates } };
  }

  const unchanged = (now, seen) => Boolean(now && now.version === seen.version && now.state === seen.state);

  function pinEffect(etx, ev, p, plan) {
    const scanKey = ev.idempotencyKey;
    const key = `${scanKey}:pin`;
    const seen = journal.findByKey(etx, key);
    if (!seen.ok) return seen;
    const pinId = seen.found ? seen.entry.aggregateId : ids.next("hp");
    const { hunter, target, strike } = plan;
    const r = journal.applyOnce(etx, { key, aggregate: { type: PIN_AGGREGATE, id: pinId },
      eventType: "HUNT_PIN_CREATED", payload: { scanKey, systemId: p.systemId, hunterFleetId: hunter.fleetId,
        targetFleetId: target.fleetId, strikeFleetId: strike.fleetId, pinMs: plan.pinMs } }, (db) => {
      const g = fleetRepository.getFleets(db, [hunter.fleetId, target.fleetId, strike.fleetId]);
      if (!g.ok) return g;
      const now = new Map(g.fleets.map((f) => [f.fleetId, f]));
      if (!unchanged(now.get(hunter.fleetId), hunter) || !unchanged(now.get(target.fleetId), target)
        || !unchanged(now.get(strike.fleetId), { version: strike.version, state: "IDLE" })) {
        return { ok: false, reason: "STALE" };
      }
      const overdue = reconcileOverdue(db, hunter.fleetId, target.fleetId, p.at);
      if (!overdue.ok) return overdue;
      const op = fleetRepository.createOperation(db, { operationType: "intercept", factionId: hunter.factionId,
        originSystemId: strike.systemId, targetSystemId: p.systemId, objective: "destroy",
        dueAt: p.at + plan.pinMs + engageDelayMs, fleets: [{ fleetId: strike.fleetId,
          expectedVersion: strike.version }] }, `${scanKey}:op`);
      if (!op.ok) return op;
      if (op.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", detail: `${scanKey}:op` };
      const planned = travel.planInTx(db, { fleetId: strike.fleetId, targetSystemId: p.systemId, at: p.at },
        `${scanKey}:plan`, { chained: true });
      if (!planned || planned.ok !== true) return planned || { ok: false, reason: "PLAN_FAILED" };
      if (planned.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", detail: `${scanKey}:plan` };
      if (planned.arriveAt + C.pinGraceMs > p.at + plan.pinMs) return { ok: false, reason: "STRIKE_TOO_SLOW" };
      const untilAt = Math.min(p.at + plan.pinMs, planned.arriveAt + C.pinGraceMs);
      const created = pins.createPin(db, { pinId, idempotencyKey: key, factionId: hunter.factionId,
        hunterFleetId: hunter.fleetId, systemId: p.systemId, targetFleetId: target.fleetId,
        targetFactionId: target.factionId, strikeOperationId: op.operationId, strikeFleetId: strike.fleetId,
        pinnedAt: p.at, untilAt, detail: { tackle: plan.calc.tackle, coverPermille: plan.calc.coverPermille,
          speedPermille: plan.calc.speedPermille, requiredStrength: plan.requiredStrength,
          etaEstimateMs: strike.etaEstimateMs, strikeLegSeq: planned.legSeq, arriveAt: planned.arriveAt } });
      if (!created.ok) return created;
      const e = scheduler.enqueue(EXPIRE_EVENT, pinId, untilAt + engageDelayMs, { pinId }, `hunt:pin:${pinId}:expire`,
        { tx: etx, chained: true });
      if (!e || e.ok !== true) return { ok: false, reason: (e && e.reason) || "ENQUEUE_FAILED", stage: "expire" };
      return { ok: true, pinId, untilAt, operationId: op.operationId, strikeFleetId: strike.fleetId,
        targetFleetId: target.fleetId, hunterFleetId: hunter.fleetId, systemId: p.systemId,
        reconciled: overdue.closed };
    });
    if (r.ok) {
      if (r.duplicate) return { ok: true, created: false, duplicate: true, reason: "DUPLICATE", pinId };
      return { ok: true, created: true, ...r.value };
    }
    if (r.reason === "APPLY_REFUSED") {
      const why = r.refusal || {};
      const reason = String(why.reason || "REFUSED");
      if (RETRYABLE_REASONS.includes(reason)) return { ok: false, reason, detail: why.detail };
      return { ok: true, created: false, reason };
    }
    return { ok: false, reason: r.reason || "APPLY_FAILED", detail: r.code };
  }

  function onScan(ev) {
    try {
      const p = parseScanPayload(ev && ev.payload);
      if (!p) return { ok: false, reason: "HUNT_PAYLOAD_INVALID", permanent: true };
      if (stopped()) return { ok: false, reason: "HUNT_STOPPED" };
      const graph = graphNow();
      if (!graph) return { ok: false, reason: "GRAPH_NOT_READY" };
      const t0 = nowMs();
      const tx = store.transaction("hunt.scanRead", (db) => readScan(db, p, graph));
      const read = tx.ok ? tx.value : tx;
      if (!read || read.ok !== true) {
        const reason = String((read && read.reason) || "HUNT_READ_FAILED");
        lastRefusal = reason;
        bump("scanRefused");
        return { ok: false, reason };
      }
      const plan = decideScan({ ...read.input, isHostile: deps.isHostile, groups: deps.groups,
        strengthOf: deps.strengthOf, pairKeyOf, params });
      const ms = Math.round((nowMs() - t0) * MS_DECIMALS) / MS_DECIMALS;
      if (!plan.pin) {
        return { ok: true, outcome: plan.reason, onCommitted: () => {
          bump("scans");
          noPin(plan.reason);
          metric("observe", "hunt.scanMs", ms);
        } };
      }
      return { ok: true, outcome: "PIN", effect: (etx, event) => pinEffect(etx, event, p, plan.pin),
        onCommitted: (v) => {
          bump("scans");
          metric("observe", "hunt.scanMs", ms);
          if (!v || v.created !== true) {
            noPin("STALE");
            if (v && v.reason) lastRefusal = String(v.reason);
            return;
          }
          for (const c of v.reconciled || []) {
            bump(CLOSE_COUNTER[c.outcome]);
            log(`hunt: pin ${c.pinId} ${c.outcome} (overdue, closed by scan)`);
          }
          bump("pinsCreated");
          setOpen(openCount + 1 - (v.reconciled || []).length);
          log(`hunt: pin ${v.pinId} system=${v.systemId} hunter=${v.hunterFleetId} target=${v.targetFleetId} `
            + `strike=${v.strikeFleetId} until=${v.untilAt}`);
        } };
    } catch (err) {
      return { ok: false, reason: `HUNT_SCAN_FAILED: ${messageOf(err)}` };
    }
  }

  function readExpire(db, pinId) {
    const g = pins.getPinById(db, pinId);
    if (!g.ok) return g;
    const pin = g.pin;
    if (!pin) return { ok: true, pin: null, fleets: new Map() };
    const f = fleetRepository.getFleets(db, [pin.hunterFleetId, pin.targetFleetId, pin.strikeFleetId]
      .filter((id) => typeof id === "string"));
    if (!f.ok) return f;
    return { ok: true, pin, fleets: new Map(f.fleets.map((x) => [x.fleetId, x])) };
  }

  function closeEffect(etx, ev, pin, outcome) {
    const r = journal.applyOnce(etx, { key: `hunt:pin:${pin.pinId}:close`,
      aggregate: { type: PIN_AGGREGATE, id: pin.pinId }, eventType: "HUNT_PIN_CLOSED",
      payload: { pinId: pin.pinId, outcome } }, (db) => pins.closePin(db, { pinId: pin.pinId,
      expectedVersion: pin.version, outcome, at: ev.dueAt }));
    if (r.ok) return { ok: true, closed: r.duplicate !== true, outcome, pinId: pin.pinId };
    if (r.reason === "APPLY_REFUSED" && r.refusal && r.refusal.reason === "STALE") {
      return { ok: true, closed: false, outcome: "STALE", pinId: pin.pinId };
    }
    return r.reason === "APPLY_REFUSED" ? (r.refusal || { ok: false, reason: "CLOSE_REFUSED" })
      : { ok: false, reason: r.reason || "APPLY_FAILED" };
  }

  function onExpire(ev) {
    try {
      const p = parseExpirePayload(ev && ev.payload);
      if (!p) return { ok: false, reason: "HUNT_PAYLOAD_INVALID", permanent: true };
      if (stopped()) return { ok: false, reason: "HUNT_STOPPED" };
      const tx = store.transaction("hunt.expireRead", (db) => readExpire(db, p.pinId));
      const read = tx.ok ? tx.value : tx;
      if (!read || read.ok !== true) return { ok: false, reason: String((read && read.reason) || "HUNT_READ_FAILED") };
      const pin = read.pin;
      const of = (id) => (typeof id === "string" ? read.fleets.get(id) || null : null);
      const d = decideExpire({ pin, hunter: pin ? of(pin.hunterFleetId) : null,
        target: pin ? of(pin.targetFleetId) : null, strike: pin ? of(pin.strikeFleetId) : null });
      if (!d.close) return { ok: true, outcome: d.outcome };
      return { ok: true, outcome: d.outcome, effect: (etx, event) => closeEffect(etx, event, pin, d.outcome),
        onCommitted: (v) => {
          if (!v || v.closed !== true) {
            bump("expireStale");
            return;
          }
          bump(CLOSE_COUNTER[v.outcome]);
          setOpen(openCount - 1);
          log(`hunt: pin ${v.pinId} ${v.outcome}`);
        } };
    } catch (err) {
      return { ok: false, reason: `HUNT_EXPIRE_FAILED: ${messageOf(err)}` };
    }
  }

  function departureGuard(tx, fleet, input) {
    if (stopped() || !fleet || PASS_STATES.includes(fleet.state)) return { ok: true };
    const at = input && isTime(input.at) ? input.at : clock.now();
    bump("guardReads");
    const b = pins.getBlockingPinForFleet(tx, fleet.fleetId, at);
    if (!b || b.ok !== true || !b.pin) return { ok: true };
    const pin = b.pin;
    let hunter = fleet;
    if (pin.hunterFleetId !== fleet.fleetId) {
      const h = fleetRepository.getFleet(tx, pin.hunterFleetId);
      hunter = h && h.ok ? h.fleet : null;
    }
    if (!hunter || hunter.state === "DESTROYED" || IN_FLIGHT.includes(hunter.state)
      || hunter.currentSystemId !== pin.systemId) {
      return { ok: true };
    }
    bump("departurePinned");
    return { ok: false, reason: "FLEET_PINNED", detail: pin.pinId };
  }

  function getStatus() {
    return Object.freeze({ state, open: openCount, counters: Object.freeze({ ...counters,
      noPinByReason: Object.freeze({ ...noPinByReason }) }), lastRefusal });
  }

  return Object.freeze({
    onArrival,
    onScan,
    onExpire,
    departureGuard,
    getState: () => (stopped() ? "off" : "running"),
    getStatus,
    setOpen,
    stop() {
      state = "stopped";
    },
    isStopped: stopped,
  });
}

module.exports = { createHuntService, parseScanPayload, parseExpirePayload, COUNTER_NAMES, SCAN_EVENT, EXPIRE_EVENT };
