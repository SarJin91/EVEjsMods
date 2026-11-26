"use strict";

const { fingerprint } = require("../../util/fingerprint");
const { crossingOfFortress, decideCheckpoint, defensesOf, STALE_REASONS } = require("./rules");

const CHECKPOINT_EVENT = "FORTRESS_CHECKPOINT";
const RESOLVED_EVENT = "FORTRESS_CHECKPOINT_RESOLVED";
const AGGREGATE_TYPE = "fortress";
const PAYLOAD_KEYS = Object.freeze(["at", "fleetId", "legSeq", "systemId", "systemIndex"]);
const STALE_INTERCEPT = Object.freeze(["STALE_LEG", "NOT_CROSSING", "LEG_HAS_WORMHOLES", "FLEET_NOT_FOUND"]);
const PERMANENT_INTERCEPT = Object.freeze(["FLEET_INVALID_INPUT"]);
const STALE_OTHER = "OTHER";
const STALE_OFF = "OFF";
const SERVICE_STALE = Object.freeze(["BATTLE_UNAVAILABLE", STALE_OFF, "UNKNOWN_FORTRESS"]);
const STALE_KEYS = Object.freeze([...new Set([...STALE_REASONS, ...SERVICE_STALE, ...STALE_INTERCEPT, STALE_OTHER])]);
const COUNTER_NAMES = Object.freeze(["crossingsQueued", "listenerExempt", "enqueueRefused", "halts", "passed",
  "observedPass", "stale", "battlesCreated", "haltRefused", "drained",
  "budgetPass", "memoryWrites", "avoidAdvised"]);
const MODES = Object.freeze(["off", "drain", "on"]);
const HASH_HEX = 40;
const MAX_DETAIL = 120;
const MAX_ID = 64;

const isText = (v) => typeof v === "string" && v.length > 0 && v.length <= MAX_ID;
const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const messageOf = (err) => String((err && err.message) || err).slice(0, MAX_DETAIL);

const checkpointKey = (systemId, fleetId, legSeq) => `fortress:${systemId}:x:${fleetId}:${legSeq}`;
const haltKeyOf = (hitKey) => `zfh:${fingerprint(`${hitKey}:halt`).slice(0, HASH_HEX)}`;
const battleKeyOf = (hitKey) => `zfb:${fingerprint(`${hitKey}:battle`).slice(0, HASH_HEX)}`;

function staleKeyOf(reason) {
  const why = String(reason);
  return STALE_KEYS.includes(why) ? why : STALE_OTHER;
}

function parsePayload(p) {
  if (!isPlain(p) || Object.keys(p).sort().join() !== PAYLOAD_KEYS.join()) return null;
  if (!isId(p.systemId) || !isText(p.fleetId) || !Number.isSafeInteger(p.legSeq) || p.legSeq < 0
    || !Number.isSafeInteger(p.systemIndex) || p.systemIndex < 1 || !isTime(p.at)) return null;
  return { systemId: p.systemId, fleetId: p.fleetId, legSeq: p.legSeq, systemIndex: p.systemIndex, at: p.at };
}

const memoryKeyOf = (systemId, factionId) => `${systemId}:${factionId}`;

function createFortressService(deps) {
  const { store, journal, scheduler, fleetRepository, travel } = deps;
  const S = deps.settings || null;
  const mode = MODES.includes(deps.mode) ? deps.mode : "drain";
  const fortresses = Array.isArray(deps.fortresses) ? deps.fortresses : [];
  const worldSeed = Number.isSafeInteger(deps.worldSeed) ? deps.worldSeed : 0;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
  const telemetry = deps.telemetry || null;
  const counters = Object.fromEntries(COUNTER_NAMES.map((n) => [n, 0]));
  const staleByReason = Object.create(null);
  let stopped = false;
  let lastRefusal = deps.memoryRefusal ? String(deps.memoryRefusal) : null;
  const budget = { seq: null, used: 0 };
  const memoryRepo = mode === "on" && S && S.haltMemoryEnabled === true && deps.memoryRepo ? deps.memoryRepo : null;
  const memoryState = memoryRepo ? (deps.memoryState === "load_failed" ? "load_failed" : "ready") : "off";
  const memory = new Map();
  if (memoryRepo && Array.isArray(deps.memoryRows)) {
    for (const row of deps.memoryRows) memory.set(memoryKeyOf(row.systemId, row.factionId), { untilAt: row.untilAt });
  }
  const hostile = (a, b) => {
    try {
      return deps.isHostile(Number(a), Number(b)) === true;
    } catch (_err) {
      return false;
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
    if (!(n > 0) || !Object.prototype.hasOwnProperty.call(counters, name)) return;
    counters[name] += n;
    metric("count", `fortress.${name}`, n);
  }

  function noteStale(reason) {
    const k = staleKeyOf(reason);
    staleByReason[k] = (staleByReason[k] || 0) + 1;
    bump("stale");
  }

  function exemptOf(fortress, factionId, fleetRole) {
    return factionId === fortress.factionId || S.exemptFactionIds.includes(factionId)
      || S.exemptRoles.includes(fleetRole);
  }

  function battleNow() {
    try {
      const b = typeof deps.getBattle === "function" ? deps.getBattle() : null;
      if (!b || typeof b.createFixedDefenseBattleInTx !== "function" || typeof b.getStatus !== "function") return null;
      const st = b.getStatus();
      return st && st.state === "ready" ? b : null;
    } catch (_err) {
      return null;
    }
  }

  function observedNow(systemId) {
    try {
      const p = typeof deps.getPresence === "function" ? deps.getPresence() : null;
      if (!p || typeof p.distanceToObserved !== "function") return false;
      const d = p.distanceToObserved(systemId, 0);
      if (d && d.ok === true) return d.distance === 0;
      return !(d && d.reason === "PRESENCE_UNAVAILABLE");
    } catch (_err) {
      return false;
    }
  }

  function onDeparture(tx, d) {
    if (stopped || mode !== "on" || !d || !d.leg) return;
    for (const fortress of fortresses) {
      const x = crossingOfFortress(d.leg, fortress);
      if (!x) continue;
      if (d.wormholes === true || exemptOf(fortress, d.factionId, d.fleetRole)) {
        bump("listenerExempt");
        continue;
      }
      const seq = store.getTxSeq();
      if (seq !== budget.seq) {
        budget.seq = seq;
        budget.used = 0;
      }
      if (budget.used >= S.maxCheckpointsPerTransaction) {
        bump("budgetPass");
        lastRefusal = "BUDGET";
        continue;
      }
      const payload = { systemId: fortress.systemId, fleetId: d.fleetId, legSeq: d.legSeq, systemIndex: x.systemIndex,
        at: x.at };
      const r = scheduler.enqueue(CHECKPOINT_EVENT, String(fortress.systemId), x.at, payload,
        checkpointKey(fortress.systemId, d.fleetId, d.legSeq), { tx, chained: d.chained === true });
      if (!r || r.ok !== true) {
        bump("enqueueRefused");
        lastRefusal = String((r && r.reason) || "ENQUEUE_FAILED");
        continue;
      }
      if (!r.duplicate) {
        budget.used += 1;
        bump("crossingsQueued");
      }
    }
  }

  function routeAdvice(fleet, query) {
    if (stopped || !memoryRepo || !fleet || !query || !Array.isArray(query.route)) return null;
    if (query.wormholes === true) return null;
    const last = query.route.length - 1;
    const avoid = [];
    for (const fortress of fortresses) {
      const i = query.route.indexOf(fortress.systemId);
      if (i <= 0 || i >= last || exemptOf(fortress, fleet.factionId, fleet.fleetRole)) continue;
      const entry = memory.get(memoryKeyOf(fortress.systemId, fleet.factionId));
      if (entry && query.at < entry.untilAt) avoid.push(fortress.systemId);
    }
    if (avoid.length === 0) return null;
    bump("avoidAdvised");
    return { avoidSystemIds: avoid, detourMaxJumps: S.haltMemoryDetourMaxJumps };
  }

  function haltEffect(etx, p, fortress, target, battle, roll) {
    const k = `${checkpointKey(p.systemId, p.fleetId, p.legSeq)}:hit`;
    const seen = journal.findByKey(etx, k);
    if (!seen.ok) return seen;
    if (seen.found) return { ok: true, applied: false, action: "DUPLICATE" };
    const battleKey = battleKeyOf(k);
    const r = journal.applyOnce(etx, { key: k, aggregate: { type: AGGREGATE_TYPE, id: String(p.systemId) },
      eventType: RESOLVED_EVENT, payload: { ...p, outcome: "HALT", roll, battleKey } }, (db) => {
      const h = travel.interceptInTx(db, { fleetId: p.fleetId, expectedVersion: target.version, legSeq: p.legSeq,
        systemIndex: p.systemIndex, at: p.at }, haltKeyOf(k), { chained: true });
      if (!h || h.ok !== true) return { ...(h || { ok: false, reason: "INTERCEPT_FAILED" }), stage: "halt" };
      const f = fleetRepository.getFleet(db, p.fleetId);
      if (!f || f.ok !== true) return { ...(f || { ok: false, reason: "FLEET_READ_FAILED" }), stage: "fleet" };
      if (!f.fleet) return { ok: false, reason: "FLEET_NOT_FOUND", stage: "fleet" };
      const b = battle.createFixedDefenseBattleInTx(db, { systemId: p.systemId, at: p.at,
        sideA: { factionId: f.fleet.factionId, fleets: [{ fleetId: p.fleetId, expectedVersion: f.fleet.version }] },
        fixedDefenses: defensesOf(fortress, S) }, battleKey);
      if (!b || b.ok !== true) return { ...(b || { ok: false, reason: "BATTLE_CREATE_FAILED" }), stage: "battle" };
      let memoryOut = null;
      if (memoryRepo) {
        const m = memoryRepo.recordHaltInTx(db, { systemId: p.systemId, factionId: f.fleet.factionId, at: p.at,
          untilAt: p.at + S.haltMemoryMs });
        if (!m || m.ok !== true) return { ...(m || { ok: false, reason: "MEMORY_WRITE_FAILED" }), stage: "memory" };
        memoryOut = { factionId: f.fleet.factionId, untilAt: m.untilAt };
      }
      return { ok: true, action: "HALT", fleetId: p.fleetId, systemId: p.systemId, battleId: b.battleId,
        battleDuplicate: b.duplicate === true, ...(memoryOut ? { memory: memoryOut } : {}) };
    });
    if (r.ok) return r.duplicate ? { ok: true, applied: false, action: "DUPLICATE" } : { ok: true, applied: true,
      ...r.value };
    const refusal = r.reason === "APPLY_REFUSED" && r.refusal ? r.refusal : null;
    const why = String((refusal && refusal.reason) || r.reason || "APPLY_FAILED");
    if (refusal && refusal.stage === "halt" && STALE_INTERCEPT.includes(why)) {
      return { ok: true, applied: false, action: "STALE", reason: why };
    }
    bump("haltRefused");
    lastRefusal = `${(refusal && refusal.stage) || "apply"}:${why}`;
    const permanent = Boolean(refusal && (refusal.permanent === true
      || (refusal.stage === "halt" && PERMANENT_INTERCEPT.includes(why))));
    return { ok: false, reason: why, ...(permanent ? { permanent: true } : {}),
      ...(refusal && refusal.detail !== undefined ? { detail: String(refusal.detail) } : {}),
      ...(r.error ? { detail: messageOf(r.error) } : {}) };
  }

  function onCheckpoint(ev) {
    try {
      const p = parsePayload(ev && ev.payload);
      if (!p) return { ok: false, reason: "FORTRESS_PAYLOAD_INVALID", permanent: true };
      if (stopped) return { ok: false, reason: "FORTRESS_STOPPED" };
      const stale = (reason) => ({ ok: true, outcome: "STALE", onCommitted: () => noteStale(reason) });
      if (mode !== "on") {
        return { ok: true, outcome: "STALE", onCommitted: () => {
          noteStale(STALE_OFF);
          bump("drained");
        } };
      }
      const fortress = fortresses.find((f) => f.systemId === p.systemId) || null;
      if (!fortress) return stale("UNKNOWN_FORTRESS");
      const tx = store.transaction("fortress.checkpointRead", (db) => fleetRepository.getFleet(db, p.fleetId));
      const read = tx.ok ? tx.value : tx;
      if (!read || read.ok !== true) {
        return { ok: false, reason: String((read && read.reason) || "FORTRESS_READ_FAILED") };
      }
      const target = read.fleet || null;
      const d = decideCheckpoint({ p, target, hostile: Boolean(target && hostile(fortress.factionId, target.factionId)),
        exempt: Boolean(target && exemptOf(fortress, target.factionId, target.fleetRole)),
        observed: Boolean(target) && observedNow(p.systemId), worldSeed }, S);
      if (d.action === "STALE") return stale(d.reason);
      if (d.action === "OBSERVED") return { ok: true, outcome: "OBSERVED", onCommitted: () => bump("observedPass") };
      if (d.action === "PASS") return { ok: true, outcome: "PASS", onCommitted: () => bump("passed") };
      const battle = battleNow();
      if (!battle) return stale("BATTLE_UNAVAILABLE");
      return { ok: true, outcome: "HALT", effect: (etx) => haltEffect(etx, p, fortress, target, battle, d.roll),
        onCommitted: (v) => {
          if (!v || v.applied !== true) {
            if (v && v.action === "STALE") noteStale(v.reason);
            return;
          }
          bump("halts");
          if (v.battleDuplicate !== true) bump("battlesCreated");
          if (v.memory) {
            memory.set(memoryKeyOf(v.systemId, v.memory.factionId), { untilAt: v.memory.untilAt });
            bump("memoryWrites");
          }
          logger.log(`fortress: ${v.systemId} stopped fleet ${v.fleetId} battle=${v.battleId} roll=${d.roll}`);
        } };
    } catch (err) {
      return { ok: false, reason: `FORTRESS_CHECKPOINT_FAILED: ${messageOf(err)}` };
    }
  }

  function getStatus() {
    return Object.freeze({ state: stopped ? "stopped" : "running", mode: stopped ? "off" : mode,
      fortresses: Object.freeze(fortresses.map((f) => f.systemId)), counters: Object.freeze({ ...counters }),
      staleByReason: Object.freeze({ ...staleByReason }), lastRefusal, memory: memoryState,
      memoryEntries: memory.size });
  }

  return Object.freeze({ onDeparture, onCheckpoint, routeAdvice, getStatus, getMode: () => (stopped ? "off" : mode),
    isStopped: () => stopped, stop() {
      stopped = true;
    } });
}

module.exports = { createFortressService, checkpointKey, haltKeyOf, battleKeyOf, staleKeyOf, CHECKPOINT_EVENT,
  RESOLVED_EVENT, COUNTER_NAMES, STALE_KEYS };
