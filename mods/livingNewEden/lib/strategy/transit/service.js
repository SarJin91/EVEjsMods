"use strict";

const { performance } = require("node:perf_hooks");
const { fingerprint } = require("../../util/fingerprint");
const { pairKeyOf } = require("../../battle/contacts");
const { EVASIVE_ROLES } = require("../../battle/data/contactRules");
const { hostileCrossingsOfLeg, routeContactPermille, chancePermilleOf, classPermilleOf, exemptOf, shipCountOf,
  haltLimitOf, decideCheckpoint, chainsAfter, picketDefensesOf, nextHostileOf, STALE_REASONS } = require("./rules");

const CHECKPOINT_EVENT = "TRANSIT_CHECKPOINT";
const RESOLVED_EVENT = "TRANSIT_CHECKPOINT_RESOLVED";
const BUDGET_EVENT = "TRANSIT_HALT_BUDGET";
const AGGREGATE_TYPE = "transit";
const PAYLOAD_KEYS = Object.freeze(["at", "check", "fleetId", "legSeq", "systemId", "systemIndex"]);
const MAX_CHECK = 31;
const STALE_INTERCEPT = Object.freeze(["STALE_LEG", "NOT_CROSSING", "LEG_HAS_WORMHOLES", "FLEET_NOT_FOUND"]);
const PERMANENT_INTERCEPT = Object.freeze(["FLEET_INVALID_INPUT"]);
const STALE_OTHER = "OTHER";
const STALE_OFF = "OFF";
const STALE_KEYS = Object.freeze([...new Set([...STALE_REASONS, STALE_OFF, ...STALE_INTERCEPT, STALE_OTHER])]);
const DEFENDER_STATES = Object.freeze(["IDLE", "STAGED"]);
const HOUR_MS = 3600000;
const LEGS_PASSED_LONG = 5;
const COUNTER_NAMES = Object.freeze(["legsSeen", "legsHostile", "hostileCrossings", "listenerIndexCold", "legsExempt",
  "legsTruncated", "listenerErrors", "indexBuilds", "indexPageRefused", "indexWaitSeed", "hostileLegs1", "hostileLegs2", "hostileLegs3",
  "hostileLegs4", "hostileLegs5plus", "contactBucket0", "contactBucket1", "contactBucket2", "contactBucket3",
  "contactBucket4", "contactBucket5", "contactBucket6", "contactBucket7", "contactBucket8", "contactBucket9",
  "checksQueued", "listenerBudgetPass", "enqueueRefused", "checks", "passed", "halts", "haltsPicket", "haltsContact",
  "observedPass", "cooldownPass", "budgetPass", "stale", "chainQueued", "chainCut", "battlesCreated", "haltRefused",
  "drained", "legsPassed", "legsPassed5plus", "indexSeedDegraded",
  "advised", "advisedSystems", "advisorIndexCold",
  "advisorCalls", "advisorHostileRoutes",
  "hostileLegsEvasive", "hostileLegsSmall", "hostileLegsRegular", "hostileLegsLarge"]);
const HOSTILE_LEGS_TOP = 5;
const BUCKETS = 9;
const BUCKET_WIDTH = 100;
const MIN_LEG_SYSTEMS = 3;
const PERMILLE = 1000;
const HASH_HEX = 40;
const MAX_ID = 64;
const DEFAULT_ROUTE_OPERATION = "invasion";
const MAX_DETAIL = 120;

const messageOf = (err) => String((err && err.message) || err).slice(0, MAX_DETAIL);
const hostileLegsName = (n) => (n >= HOSTILE_LEGS_TOP ? "hostileLegs5plus" : `hostileLegs${n}`);
const legClassName = (fleetRole, shipCount, S) => {
  if (EVASIVE_ROLES.includes(fleetRole)) return "hostileLegsEvasive";
  if (Number.isSafeInteger(shipCount) && shipCount <= S.smallGangMaxShips) return "hostileLegsSmall";
  if (Number.isSafeInteger(shipCount) && shipCount >= S.largeFleetMinShips) return "hostileLegsLarge";
  return "hostileLegsRegular";
};
const isText = (v) => typeof v === "string" && v.length > 0 && v.length <= MAX_ID;
const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

const checkpointKey = (systemId, fleetId, legSeq) => `transit:${systemId}:x:${fleetId}:${legSeq}`;
const haltKeyOf = (hitKey) => `tsh:${fingerprint(`${hitKey}:halt`).slice(0, HASH_HEX)}`;
const battleKeyOf = (hitKey) => `tsb:${fingerprint(`${hitKey}:battle`).slice(0, HASH_HEX)}`;
const hourBucketOf = (at) => Math.floor(at / HOUR_MS);
const budgetKeyOf = (controllerId, hourBucket, fleetId, legSeq) =>
  `trn:hb:${controllerId}:${hourBucket}:${fleetId}:${legSeq}`;
const budgetRangeOf = (controllerId, hourBucket) => [`trn:hb:${controllerId}:${hourBucket}:`,
  `trn:hb:${controllerId}:${hourBucket};`];

function staleKeyOf(reason) {
  const why = String(reason);
  return STALE_KEYS.includes(why) ? why : STALE_OTHER;
}

function parsePayload(p) {
  if (!isPlain(p) || Object.keys(p).sort().join() !== PAYLOAD_KEYS.join()) return null;
  if (!isId(p.systemId) || !isText(p.fleetId) || !Number.isSafeInteger(p.legSeq) || p.legSeq < 0
    || !Number.isSafeInteger(p.systemIndex) || p.systemIndex < 1 || !isTime(p.at)
    || !Number.isSafeInteger(p.check) || p.check < 0 || p.check > MAX_CHECK) return null;
  return { at: p.at, check: p.check, fleetId: p.fleetId, legSeq: p.legSeq, systemId: p.systemId,
    systemIndex: p.systemIndex };
}

function createTransitService(deps) {
  const { fleetRepository, index } = deps;
  const S = deps.settings || null;
  const mode = deps.mode === undefined ? "observe" : (deps.mode === "on" || deps.mode === "observe" ? deps.mode : null);
  const handlerMode = deps.handlerMode === "on" || deps.handlerMode === "drain" ? deps.handlerMode : null;
  const { store, journal, scheduler, travel } = deps;
  const worldRepository = deps.worldRepository || null;
  const worldSeed = Number.isSafeInteger(deps.worldSeed) ? deps.worldSeed : 0;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
  const telemetry = deps.telemetry || null;
  const perfNow = typeof deps.perfNow === "function" ? deps.perfNow : () => performance.now();
  const counters = Object.fromEntries(COUNTER_NAMES.map((n) => [n, 0]));
  const staleByReason = Object.create(null);
  let stopped = false;
  let lastRefusal = null;
  let degradedLogged = false;
  const budget = { seq: null, used: 0 };
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
    metric("count", `transit.${name}`, n);
  }

  function noteStale(reason) {
    const k = staleKeyOf(reason);
    staleByReason[k] = (staleByReason[k] || 0) + 1;
    bump("stale");
  }

  function noteLegPassed(checksDone) {
    bump("legsPassed");
    if (checksDone >= LEGS_PASSED_LONG) bump("legsPassed5plus");
  }

  function operationTypeOf(tx, d) {
    if (d.operationId === null || d.operationId === undefined || d.wormholes === true) return null;
    const r = fleetRepository.getOperation(tx, d.operationId);
    return r && r.ok === true && r.operation ? r.operation.operationType : null;
  }

  function enqueueFirst(tx, d, c) {
    const seq = store.getTxSeq();
    if (seq !== budget.seq) {
      budget.seq = seq;
      budget.used = 0;
    }
    if (budget.used >= S.maxCheckpointsPerTransaction) {
      bump("listenerBudgetPass");
      lastRefusal = "BUDGET";
      return;
    }
    const payload = { at: c.at, check: 0, fleetId: d.fleetId, legSeq: d.legSeq, systemId: c.systemId,
      systemIndex: c.systemIndex };
    const r = scheduler.enqueue(CHECKPOINT_EVENT, String(c.systemId), c.at, payload,
      checkpointKey(c.systemId, d.fleetId, d.legSeq), { tx, chained: d.chained === true });
    if (!r || r.ok !== true) {
      bump("enqueueRefused");
      lastRefusal = String((r && r.reason) || "ENQUEUE_FAILED");
      return;
    }
    if (!r.duplicate) {
      budget.used += 1;
      bump("checksQueued");
    }
  }

  function onDeparture(tx, d) {
    if (stopped || mode === null || !d || !d.leg || !Array.isArray(d.leg.systems)) return;
    try {
      bump("legsSeen");
      const t0 = perfNow();
      if (!index.isWarm()) {
        bump("listenerIndexCold");
        return;
      }
      if (d.leg.systems.length < MIN_LEG_SYSTEMS) {
        metric("observe", "transit.listenerMs", perfNow() - t0);
        return;
      }
      const operationType = operationTypeOf(tx, d);
      const x = hostileCrossingsOfLeg(d.leg, index.get, hostile, { factionId: d.factionId, fleetRole: d.fleetRole,
        shipCount: Number.isSafeInteger(d.shipCount) ? d.shipCount : null, operationType,
        wormholes: d.wormholes === true }, S);
      if (x.exempt) bump("legsExempt");
      if (x.truncated) bump("legsTruncated");
      const n = x.crossings.length;
      if (n > 0) {
        bump("legsHostile");
        bump("hostileCrossings", n);
        metric("observe", "transit.hostilePerLeg", n);
        bump(hostileLegsName(n));
        bump(legClassName(d.fleetRole, Number.isSafeInteger(d.shipCount) ? d.shipCount : null, S));
        const c = routeContactPermille(x.crossings.map((e) => e.chancePermille));
        metric("observe", "transit.expectedContactPermille", c);
        bump(`contactBucket${Math.min(BUCKETS, Math.floor(c / BUCKET_WIDTH))}`);
        if (mode === "on") enqueueFirst(tx, d, x.crossings[0]);
      }
      metric("observe", "transit.listenerMs", perfNow() - t0);
    } catch (err) {
      if (tx && tx.inTransaction === false) throw err;
      bump("listenerErrors");
      lastRefusal = `LISTENER:${messageOf(err)}`;
    }
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

  function cooldownOf(db, battle, p, controller, moverFactionId) {
    if (!battle || typeof battle.readCooldownsInTx !== "function") return false;
    const cd = battle.readCooldownsInTx(db, p.systemId);
    if (!cd || cd.ok !== true || !(cd.cooldowns instanceof Map)) return false;
    const until = cd.cooldowns.get(pairKeyOf(controller, moverFactionId));
    return Number.isFinite(until) && until > p.at;
  }

  function nextOf(db, p, target) {
    const leg = target.route;
    const systems = leg && Array.isArray(leg.systems) ? leg.systems : [];
    const last = Math.min(Math.max(0, systems.length - 2), S.listenerMaxSystems);
    const rest = systems.slice(p.systemIndex + 1, last + 1);
    if (rest.length === 0) return { ok: true, next: null };
    const r = worldRepository.getSystems(db, rest, { includeInfluence: false });
    if (!r || r.ok !== true) return r || { ok: false, reason: "SYSTEMS_READ_FAILED" };
    const states = new Map(r.systems.map((s) => [s.systemId, s]));
    return { ok: true, next: nextHostileOf(leg, p.systemIndex, states, hostile, target.factionId, S) };
  }

  function readCheckpoint(db, p, battle, observed) {
    const f = fleetRepository.getFleet(db, p.fleetId);
    if (!f || f.ok !== true) return f || { ok: false, reason: "FLEET_READ_FAILED" };
    const target = f.fleet || null;
    const fresh = Boolean(target && target.state === "TRAVELLING" && target.legSeq === p.legSeq);
    let exemptReason = null;
    if (fresh) {
      let operationType = null;
      if (target.operationId !== null && target.operationId !== undefined) {
        const o = fleetRepository.getOperation(db, target.operationId);
        if (!o || o.ok !== true) return o || { ok: false, reason: "OPERATION_READ_FAILED" };
        operationType = o.operation ? o.operation.operationType : null;
      }
      exemptReason = exemptOf({ factionId: target.factionId, fleetRole: target.fleetRole, operationType,
        wormholes: false }, S);
    }
    const sys = worldRepository.getSystem(db, p.systemId, { includeInfluence: true });
    if (!sys || sys.ok !== true) return sys || { ok: false, reason: "SYSTEM_READ_FAILED" };
    const system = sys.system || null;
    const controller = system && Number.isSafeInteger(system.controllerFactionId) ? system.controllerFactionId : null;
    const secClassOk = Boolean(system && S.secClasses.includes(system.securityClass));
    const isHostile = Boolean(target && controller !== null && hostile(target.factionId, controller));
    let cooldown = false;
    let defenders = 0;
    let haltsThisHour = 0;
    let chance = 0;
    let systemChance = 0;
    if (fresh && exemptReason === null && controller !== null && secClassOk && isHostile && !observed) {
      cooldown = cooldownOf(db, battle, p, controller, target.factionId);
      if (S.contactRoles.length > 0) {
        const page = fleetRepository.listFleetsInSystem(db, p.systemId, { states: [...DEFENDER_STATES],
          limit: S.contactScanFleets });
        if (!page || page.ok !== true) return page || { ok: false, reason: "FLEETS_READ_FAILED" };
        defenders = page.fleets.filter((fl) => fl.factionId === controller && S.contactRoles.includes(fl.fleetRole)
          && !EVASIVE_ROLES.includes(fl.fleetRole) && fl.fleetId !== p.fleetId).length;
      }
      if (S.haltsPerControllerHour > 0) {
        const [from, to] = budgetRangeOf(controller, hourBucketOf(p.at));
        const n = journal.countKeyRange(db, from, to, haltLimitOf(S));
        if (!n || n.ok !== true) return n || { ok: false, reason: "BUDGET_READ_FAILED" };
        haltsThisHour = n.count;
      }
      const inf = Array.isArray(system.influence) ? system.influence.find((i) => i && i.factionId === controller)
        : null;
      const live = index ? index.get(p.systemId) : null;
      const entry = { influence: inf && Number.isFinite(inf.influenceScore) ? inf.influenceScore : 0,
        garrison: inf && Number.isFinite(inf.garrisonStrength) ? inf.garrisonStrength : 0,
        gateSentries: live && live.controllerFactionId === controller ? live.gateSentries : 0 };
      systemChance = chancePermilleOf(entry, S, defenders > 0 ? S.defenderBonusPermille : 0);
      const cls = classPermilleOf({ fleetRole: target.fleetRole, shipCount: shipCountOf(target.composition) }, S);
      chance = Math.floor(systemChance * cls / PERMILLE);
    }
    const d = decideCheckpoint({ p, target, exemptReason, controllerFactionId: controller, secClassOk,
      hostile: isHostile, observed, cooldown, battleReady: battle !== null, chancePermille: chance, defenders,
      moverEvasive: Boolean(target && EVASIVE_ROLES.includes(target.fleetRole)), haltsThisHour, worldSeed }, S);
    let next = null;
    let chainCut = false;
    if (chainsAfter(d)) {
      if (p.check + 1 < S.maxChecksPerLeg) {
        const n = nextOf(db, p, target);
        if (!n || n.ok !== true) return n;
        next = n.next;
      } else {
        chainCut = true;
      }
    }
    return { ok: true, d, next, chainCut, target, controllerFactionId: controller, systemChance,
      checksDone: p.check + 1 };
  }

  function chainNext(etx, p, next) {
    if (!next) return { ok: true, queued: false };
    const payload = { at: next.at, check: p.check + 1, fleetId: p.fleetId, legSeq: p.legSeq, systemId: next.systemId,
      systemIndex: next.systemIndex };
    const r = scheduler.enqueue(CHECKPOINT_EVENT, String(next.systemId), next.at, payload,
      checkpointKey(next.systemId, p.fleetId, p.legSeq), { tx: etx, chained: true });
    if (!r || r.ok !== true) return { ok: false, reason: String((r && r.reason) || "ENQUEUE_FAILED") };
    return { ok: true, queued: r.duplicate !== true };
  }

  function haltEffect(etx, p, read, battle) {
    const { d, target } = read;
    const controller = read.controllerFactionId;
    const k = `${checkpointKey(p.systemId, p.fleetId, p.legSeq)}:hit`;
    const seen = journal.findByKey(etx, k);
    if (!seen.ok) return seen;
    if (seen.found) return { ok: true, applied: false, action: "DUPLICATE" };
    const hb = hourBucketOf(p.at);
    const [from, to] = budgetRangeOf(controller, hb);
    const used = journal.countKeyRange(etx, from, to, haltLimitOf(S));
    if (!used || used.ok !== true) return used || { ok: false, reason: "BUDGET_READ_FAILED" };
    if (used.count >= haltLimitOf(S)) {
      bump("haltRefused");
      lastRefusal = "budget:BUDGET_RACE";
      return { ok: false, reason: "BUDGET_RACE" };
    }
    const picket = d.kind === "PICKET";
    const battleKey = picket ? battleKeyOf(k) : null;
    const r = journal.applyOnce(etx, { key: k, aggregate: { type: AGGREGATE_TYPE, id: String(p.systemId) },
      eventType: RESOLVED_EVENT, payload: { ...p, outcome: "HALT", kind: d.kind, roll: d.roll,
        chancePermille: d.chancePermille, controllerFactionId: controller, battleKey } }, (db) => {
      const h = travel.interceptInTx(db, { fleetId: p.fleetId, expectedVersion: target.version, legSeq: p.legSeq,
        systemIndex: p.systemIndex, at: p.at }, haltKeyOf(k), { chained: true });
      if (!h || h.ok !== true) return { ...(h || { ok: false, reason: "INTERCEPT_FAILED" }), stage: "halt" };
      let battleId = null;
      let battleDuplicate = false;
      if (picket) {
        const f = fleetRepository.getFleet(db, p.fleetId);
        if (!f || f.ok !== true) return { ...(f || { ok: false, reason: "FLEET_READ_FAILED" }), stage: "fleet" };
        if (!f.fleet) return { ok: false, reason: "FLEET_NOT_FOUND", stage: "fleet" };
        const b = battle.createFixedDefenseBattleInTx(db, { systemId: p.systemId, at: p.at,
          sideA: { factionId: f.fleet.factionId, fleets: [{ fleetId: p.fleetId, expectedVersion: f.fleet.version }] },
          fixedDefenses: picketDefensesOf(p.systemId, controller, read.systemChance, S) }, battleKey);
        if (!b || b.ok !== true) return { ...(b || { ok: false, reason: "BATTLE_CREATE_FAILED" }), stage: "battle" };
        battleId = b.battleId;
        battleDuplicate = b.duplicate === true;
      }
      const m = journal.applyOnce(db, { key: budgetKeyOf(controller, hb, p.fleetId, p.legSeq),
        aggregate: { type: AGGREGATE_TYPE, id: String(controller) }, eventType: BUDGET_EVENT, payload: {} },
      () => ({ ok: true }));
      if (!m || m.ok !== true) return { ...(m || { ok: false, reason: "BUDGET_WRITE_FAILED" }), stage: "budget" };
      return { ok: true, action: "HALT", kind: d.kind, fleetId: p.fleetId, systemId: p.systemId, battleId,
        battleDuplicate };
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
    const t0 = perfNow();
    try {
      const p = parsePayload(ev && ev.payload);
      if (!p) return { ok: false, reason: "TRANSIT_PAYLOAD_INVALID", permanent: true };
      if (stopped) return { ok: false, reason: "TRANSIT_STOPPED" };
      if (handlerMode !== "on" || !S) {
        return { ok: true, outcome: "STALE", onCommitted: () => {
          bump("checks");
          noteStale(STALE_OFF);
          bump("drained");
        } };
      }
      const battle = battleNow();
      const observed = observedNow(p.systemId);
      const tx = store.transaction("transit.checkpointRead", (db) => readCheckpoint(db, p, battle, observed));
      const read = tx.ok ? tx.value : tx;
      if (!read || read.ok !== true) {
        return { ok: false, reason: String((read && read.reason) || "TRANSIT_READ_FAILED") };
      }
      const { d } = read;
      metric("observe", "transit.checkpointMs", perfNow() - t0);
      if (d.action === "HALT") {
        return { ok: true, outcome: "HALT", effect: (etx) => haltEffect(etx, p, read, battle), onCommitted: (v) => {
          bump("checks");
          if (!v || v.applied !== true) {
            if (v && v.action === "STALE") noteStale(v.reason);
            return;
          }
          bump("halts");
          bump(v.kind === "CONTACT" ? "haltsContact" : "haltsPicket");
          if (v.kind === "PICKET" && v.battleDuplicate !== true) bump("battlesCreated");
          logger.log(`transit: ${v.systemId} stopped fleet ${v.fleetId} kind=${v.kind} battle=${v.battleId || "-"}`
            + ` roll=${d.roll} chance=${d.chancePermille}`);
        } };
      }
      const final = !chainsAfter(d);
      const counted = () => {
        bump("checks");
        if (d.action === "STALE") noteStale(d.reason);
        else if (d.action === "OBSERVED") bump("observedPass");
        else if (d.action === "COOLDOWN") bump("cooldownPass");
        else if (d.action === "BUDGET") bump("budgetPass");
        else bump("passed");
      };
      if (final) {
        return { ok: true, outcome: "STALE", onCommitted: () => {
          counted();
          noteLegPassed(read.checksDone);
        } };
      }
      return { ok: true, outcome: d.action, effect: (etx) => chainNext(etx, p, read.next), onCommitted: (v) => {
        counted();
        if (read.chainCut) bump("chainCut");
        if (v && v.queued === true) bump("chainQueued");
        if (!read.next) noteLegPassed(read.checksDone);
      } };
    } catch (err) {
      return { ok: false, reason: `TRANSIT_CHECKPOINT_FAILED: ${messageOf(err)}` };
    }
  }

  function riskOf(systemId) {
    return index && index.isWarm() ? index.get(systemId) : null;
  }

  function routeRiskOf(factionId, systems, opts) {
    if (!index || !index.isWarm() || !Array.isArray(systems)) return null;
    const o = opts && typeof opts === "object" ? opts : {};
    const x = hostileCrossingsOfLeg({ systems, departAt: 0, jumpMs: 1 }, index.get, hostile, { factionId,
      fleetRole: typeof o.fleetRole === "string" ? o.fleetRole : null,
      shipCount: Number.isSafeInteger(o.shipCount) ? o.shipCount : null,
      operationType: typeof o.operationType === "string" ? o.operationType : DEFAULT_ROUTE_OPERATION,
      wormholes: false }, S);
    return { contactPermille: routeContactPermille(x.crossings.map((e) => e.chancePermille)), crossings: x.crossings,
      truncated: x.truncated };
  }

  function routeAdvice(who, query) {
    try {
      if (stopped || mode !== "on" || !S || S.advisorEnabled !== true || !who || !query) return null;
      bump("advisorCalls");
      if (!Array.isArray(query.route) || query.wormholes === true) return null;
      if (!index || !index.isWarm()) {
        bump("advisorIndexCold");
        return null;
      }
      const x = hostileCrossingsOfLeg({ systems: query.route, departAt: 0, jumpMs: 1 }, index.get, hostile, {
        factionId: who.factionId, fleetRole: who.fleetRole,
        shipCount: Number.isSafeInteger(who.shipCount) ? who.shipCount : null,
        operationType: DEFAULT_ROUTE_OPERATION, wormholes: false }, S);
      if (x.crossings.length > 0) bump("advisorHostileRoutes");
      const avoid = x.crossings.filter((c) => c.chancePermille >= S.advisorAvoidPermille).map((c) => c.systemId);
      if (avoid.length === 0) return null;
      bump("advised");
      bump("advisedSystems", avoid.length);
      return { avoidSystemIds: avoid, detourMaxJumps: S.advisorDetourMaxJumps, soft: true, detail: "TRANSIT_RISK" };
    } catch (err) {
      lastRefusal = `ADVISOR:${messageOf(err)}`;
      return null;
    }
  }

  function noteIndexBuilt(info) {
    bump("indexBuilds");
    metric("observe", "transit.indexBuildMs", info && Number.isFinite(info.buildMs) ? info.buildMs : 0);
    metric("gauge", "transit.indexSystems", info && Number.isSafeInteger(info.systems) ? info.systems : 0);
  }

  function noteIndexPageRefused(reason) {
    bump("indexPageRefused");
    lastRefusal = `INDEX_PAGE:${String(reason).slice(0, MAX_DETAIL)}`;
  }

  function noteIndexWaitSeed() {
    bump("indexWaitSeed");
  }

  function noteIndexSeedDegraded(state) {
    bump("indexSeedDegraded");
    if (degradedLogged) return;
    degradedLogged = true;
    logger.log(`transit: index built while the world control seed is ${String(state).slice(0, MAX_DETAIL)} - `
      + "checkpoints use the partial world state (world.seed.failures)");
  }

  const modeNow = () => {
    if (stopped) return "off";
    if (mode !== null) return mode;
    return handlerMode === "drain" ? "drain" : "off";
  };

  function getStatus() {
    return Object.freeze({ state: stopped ? "stopped" : "running", mode: modeNow(), handler: handlerMode,
      index: index ? index.getStatus() : null, counters: Object.freeze({ ...counters }),
      staleByReason: Object.freeze({ ...staleByReason }), lastRefusal });
  }

  return Object.freeze({ onDeparture, onCheckpoint, riskOf, routeRiskOf, routeAdvice, getStatus, getMode: modeNow,
    isStopped: () => stopped, noteIndexBuilt, noteIndexPageRefused, noteIndexWaitSeed, noteIndexSeedDegraded,
    stop() {
      stopped = true;
    } });
}

module.exports = { createTransitService, COUNTER_NAMES, CHECKPOINT_EVENT, RESOLVED_EVENT, STALE_KEYS, checkpointKey,
  haltKeyOf, battleKeyOf, budgetKeyOf, staleKeyOf };
