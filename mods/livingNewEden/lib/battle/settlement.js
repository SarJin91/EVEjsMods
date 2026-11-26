"use strict";

const { KIND_APPLY } = require("../persistence/journal");
const { stableJson, fingerprint } = require("../util/fingerprint");
const { normalizeComposition, normalizeLosses, subtractLosses } = require("../fleets/composition");
const { HASH_LIMITS, validateResult } = require("./contract");
const { findRetreatTargets } = require("./retreatTargets");
const {
  DISPOSITION, settleKey, failKey, quarantineKey, isSupportedVersion, planSettlement,
} = require("./settlementPlan");

const BATTLE_AGGREGATE = "battle";
const SETTLED_EVENT = "BATTLE_SETTLED";
const CANCELLED_EVENT = "BATTLE_CANCELLED";
const CONSEQUENCE_EVENT = "BATTLE_CONSEQUENCE";
const LIVE_MODE = "LIVE_EVEJS";
const ENGAGED = "ENGAGED";
const MAX_ID_LENGTH = 64;
const MAX_REASON_LENGTH = 64;
const MAX_DETAIL_LENGTH = 1000;
const HASH_RE = /^[0-9a-f]{64}$/;
const CONSEQUENCE_NAME_RE = /^[a-z][a-zA-Z0-9_-]{0,31}$/;
const SETTLE_STATES = Object.freeze(["RESOLVING", "SETTLING"]);
const CANCEL_STATES = Object.freeze(["PENDING", "CLAIMED", "RESOLVING", "SETTLING"]);
const TERMINAL = Object.freeze(["FAILED", "QUARANTINED"]);
const DATA_REASONS = Object.freeze(["NEGATIVE_COMPOSITION", "FLEET_NOT_ENGAGED", "RESULT_INVALID", "RESULT_UNBALANCED",
  "BATTLE_INVARIANT"]);
const LIMIT_NAMES = Object.freeze(["maxResultBytes", "maxSettlementRows", "retreatSearchMaxJumps",
  "retreatSearchMaxSystems", "retreatMaxCandidates"]);
const REQ_KEYS = Object.freeze(["battleId", "expectedVersion", "inputHash", "result", "at"]);
const LIVE_REQ_KEYS = Object.freeze(["battleId", "expectedVersion", "result", "at"]);
const LIVE_SETTLE_STATES = Object.freeze(["LIVE", "SETTLING"]);
const CANCEL_KEYS = Object.freeze(["battleId", "expectedVersion", "at", "reason", "detail"]);
const QUARANTINE_KEYS = Object.freeze(["battleId", "expectedVersion", "reason", "detail"]);
const COUNTER_NAMES = Object.freeze(["completed", "duplicate", "quarantined", "refused", "cancelled", "retreatHome",
  "refitInPlace", "consequenceRefused", "liveCompleted"]);

const TX_REQUIRED = Object.freeze({ ok: false, reason: "TX_REQUIRED", permanent: false });
const isText = (v, max) => typeof v === "string" && v.length >= 1 && v.length <= max;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isVersion = (v) => Number.isSafeInteger(v) && v >= 1;
const isPositiveInt = (v) => Number.isSafeInteger(v) && v > 0;

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

function fixedDefensesOf(input, result) {
  const fd = input && input.fixedDefenses;
  const out = result && result.fixedDefenseOutcome;
  if (!fd || !Array.isArray(fd.entries) || !Array.isArray(out)) return {};
  return { fixedDefenses: fd.entries.map((e, i) => ({ sentryId: e.sentryId, itemId: e.itemId, hp: e.hp, ehp: e.ehp,
    damage: out[i].damage, destroyed: out[i].destroyed })) };
}

function plainRefusal(r) {
  const out = {};
  for (const [k, v] of Object.entries(r || {})) {
    if (k === "error") out.detail = String((v && v.message) || v);
    else if (k !== "ok" && k !== "refusal") out[k] = v;
  }
  if (!out.reason) out.reason = "SETTLE_FAILED";
  return out;
}

const unwrap = (r) => (r && r.reason === "APPLY_REFUSED" && r.refusal ? r.refusal : r);

function detailOf(r) {
  const text = r.detail !== undefined ? String(r.detail) : stableJson(plainRefusal(r));
  return text.length > MAX_DETAIL_LENGTH ? text.slice(0, MAX_DETAIL_LENGTH) : text;
}

function compositionText(list) {
  const r = normalizeComposition(list, HASH_LIMITS);
  return r.ok ? stableJson(r.composition) : null;
}

function createSettlement(deps) {
  if (!deps || typeof deps !== "object") throw new TypeError("createSettlement: deps missing");
  const { journal, battleRepository, fleetRepository, travel, limits, onCount } = deps;
  if (!journal || typeof journal.applyOnce !== "function" || typeof journal.findByKey !== "function") {
    throw new TypeError("createSettlement: journal with applyOnce/findByKey required");
  }
  for (const fn of ["getBattle", "transition", "recordLosses"]) {
    if (!battleRepository || typeof battleRepository[fn] !== "function") {
      throw new TypeError(`createSettlement: battleRepository.${fn} required`);
    }
  }
  for (const fn of ["getFleets", "applyLosses"]) {
    if (!fleetRepository || typeof fleetRepository[fn] !== "function") {
      throw new TypeError(`createSettlement: fleetRepository.${fn} required`);
    }
  }
  if (!travel || typeof travel.releaseFromBattleInTx !== "function") {
    throw new TypeError("createSettlement: travel.releaseFromBattleInTx required");
  }
  if (deps.getGraph !== undefined && deps.getGraph !== null && typeof deps.getGraph !== "function") {
    throw new TypeError("createSettlement: getGraph must be a function");
  }
  if (!limits || typeof limits !== "object") throw new TypeError("createSettlement: limits missing");
  for (const name of LIMIT_NAMES) {
    if (!isPositiveInt(limits[name])) {
      throw new TypeError(`createSettlement: limits.${name} must be a positive integer, got ${limits[name]}`);
    }
  }
  const consequences = deps.consequences === undefined || deps.consequences === null ? [] : deps.consequences;
  if (!Array.isArray(consequences)) throw new TypeError("createSettlement: consequences must be an array");
  const names = new Set();
  for (const c of consequences) {
    if (!c || !CONSEQUENCE_NAME_RE.test(c.name) || typeof c.apply !== "function" || names.has(c.name)) {
      throw new TypeError(`createSettlement: invalid consequence ${c && c.name}`);
    }
    names.add(c.name);
  }
  if (onCount !== undefined && typeof onCount !== "function") {
    throw new TypeError("createSettlement: onCount must be a function");
  }
  const worldRepository = deps.worldRepository || null;
  const L = Object.freeze(Object.fromEntries(LIMIT_NAMES.map((n) => [n, limits[n]])));
  const counters = Object.fromEntries(COUNTER_NAMES.map((n) => [n, 0]));
  let lastRefusal = null;
  let lastQuarantine = null;

  function bump(name, n = 1) {
    if (n <= 0) return;
    counters[name] += n;
    if (!onCount) return;
    try {
      onCount(`battle.settle.${name}`, n);
    } catch (_err) {
    }
  }

  function refuse(battleId, r, permanent) {
    bump("refused");
    const out = { ok: false, ...plainRefusal(r), permanent };
    lastRefusal = Object.freeze({ battleId: battleId === undefined ? null : battleId, reason: out.reason });
    return out;
  }

  function currentGraph() {
    try {
      const g = deps.getGraph ? deps.getGraph() : null;
      if (g && g.ok === true && g.graph) return g.graph;
      return g && typeof g.getNeighbors === "function" ? g : null;
    } catch (_err) {
      return null;
    }
  }

  function seenAs(tx, key, battleId, eventType) {
    const found = journal.findByKey(tx, key);
    if (!found.ok) return { ok: false, refusal: found };
    if (!found.found) return { ok: true, found: false };
    const e = found.entry;
    const same = e.kind === KIND_APPLY && e.aggregateType === BATTLE_AGGREGATE && e.aggregateId === battleId
      && (eventType === null || e.eventType === eventType);
    if (!same) return { ok: false, refusal: { reason: "IDEMPOTENCY_CONFLICT", journalId: e.journalId }, permanent: true };
    return { ok: true, found: true, journalId: e.journalId };
  }

  function loadBattle(tx, battleId, expectedVersion, allowed, opts = {}) {
    const read = battleRepository.getBattle(tx, battleId);
    if (!read.ok) return { ok: false, refusal: read, permanent: false };
    const b = read.battle;
    if (!b) return { ok: false, refusal: { reason: "BATTLE_NOT_FOUND", battleId }, permanent: true };
    if (b.state === "COMPLETED") return { ok: false, refusal: { reason: "ALREADY_SETTLED", battleId }, permanent: true };
    if (TERMINAL.includes(b.state)) {
      return { ok: false, refusal: { reason: "BATTLE_TERMINAL", battleId, state: b.state }, permanent: true };
    }
    const live = opts.mode === LIVE_MODE;
    if (live ? b.mode !== LIVE_MODE : (b.mode === LIVE_MODE || b.state === "LIVE")) {
      return { ok: false, refusal: { reason: "MODE_MISMATCH", battleId, mode: b.mode, state: b.state }, permanent: true };
    }
    if (!allowed.includes(b.state)) {
      return { ok: false, refusal: { reason: live ? "SETTLE_NOT_LIVE" : "SETTLE_NOT_RESOLVING", battleId, state: b.state },
        permanent: true };
    }
    if (expectedVersion !== undefined && b.version !== expectedVersion) {
      return { ok: false, refusal: { reason: "VERSION_CONFLICT", expectedVersion, actualVersion: b.version },
        permanent: false };
    }
    return { ok: true, battle: b };
  }

  function quarantineBattle(tx, battle, cause, detail, version) {
    const error = { reason: String(cause).slice(0, MAX_REASON_LENGTH) };
    if (detail !== undefined && detail !== null && String(detail).length > 0) {
      error.detail = String(detail).slice(0, MAX_DETAIL_LENGTH);
    }
    const r = battleRepository.transition(tx, { battleId: battle.battleId, expectedVersion: battle.version,
      from: battle.state, to: "QUARANTINED", patch: { error } }, quarantineKey(battle.battleId, version));
    if (!r.ok) return refuse(battle.battleId, { ...plainRefusal(r), stage: "quarantine" }, false);
    bump("quarantined");
    lastQuarantine = Object.freeze({ battleId: battle.battleId, cause: error.reason });
    const out = { ok: true, duplicate: false, outcome: "QUARANTINED", battleId: battle.battleId, cause: error.reason };
    if (error.detail !== undefined) out.detail = error.detail;
    return out;
  }

  function validateKeys(req, keys) {
    if (!isPlainObject(req)) return "req";
    const extra = Object.keys(req).find((k) => !keys.includes(k));
    if (extra !== undefined) return `req.${extra}`;
    if (!isText(req.battleId, MAX_ID_LENGTH)) return "battleId";
    if (req.expectedVersion !== undefined && !isVersion(req.expectedVersion)) return "expectedVersion";
    return null;
  }

  const invalidInput = (battleId, detail) => refuse(battleId, { reason: "SETTLE_INVALID_INPUT", detail }, true);

  function checkData(tx, battle, req, inputHash) {
    const cause = (c, detail) => ({ ok: false, cause: c, detail });
    if (inputHash !== battle.inputHash) return cause("INPUT_HASH_MISMATCH", `expected ${battle.inputHash}`);
    const v = validateResult(battle.input, req.result, { maxResultBytes: L.maxResultBytes });
    if (!v.ok) return cause(v.reason, detailOf(v));
    if (battle.state === "SETTLING" && fingerprint(v.result) !== fingerprint(battle.result)) {
      return cause("RESULT_CONFLICT", "result differs from the stored one");
    }
    const read = fleetRepository.getFleets(tx, battle.fleetIds);
    if (!read.ok) return { ok: false, refusal: read };
    const byId = new Map(read.fleets.map((f) => [f.fleetId, f]));
    for (const side of [battle.input.sideA, battle.input.sideB]) {
      for (const snap of side.fleets) {
        const rec = byId.get(snap.fleetId);
        if (!rec || rec.state !== ENGAGED) {
          return cause("FLEET_NOT_ENGAGED", `${snap.fleetId}: ${rec ? rec.state : "missing"}`);
        }
        const now = compositionText(rec.composition);
        if (now === null || now !== compositionText(snap.composition)) {
          return cause("COMPOSITION_DRIFT", snap.fleetId);
        }
      }
    }
    const plan = planSettlement(battle.input, v.result);
    if (!plan.ok) return cause(plan.reason, plan.detail);
    for (const f of plan.fleets) {
      if (f.losses.length === 0) continue;
      const losses = normalizeLosses(f.losses, HASH_LIMITS);
      const left = losses.ok ? subtractLosses(byId.get(f.fleetId).composition, losses.losses) : losses;
      if (!left.ok) return cause(left.reason === "NEGATIVE_COMPOSITION" ? left.reason : "RESULT_INVALID", detailOf(left));
      if ((left.shipCount === 0) !== (f.disposition === DISPOSITION.DESTROYED)) {
        return cause("BATTLE_INVARIANT", `${f.fleetId}: disposition ${f.disposition}`);
      }
    }
    return { ok: true, normalized: v.result, plan, byId };
  }

  function retreatPlan(tx, battle, plan, byId) {
    const retreating = plan.fleets.filter((f) => f.disposition === DISPOSITION.RETREAT);
    const targetsOf = new Map();
    const friendlyOf = new Map();
    if (retreating.length === 0) return { ok: true, targetsOf, friendlyOf };
    const graph = currentGraph();
    if (!graph) return { ok: false, refusal: { reason: "GRAPH_NOT_READY" } };
    for (const f of retreating) {
      if (!friendlyOf.has(f.factionId)) {
        const found = findRetreatTargets(tx, { graph, worldRepository, systemId: battle.systemId,
          factionId: f.factionId, limits: L });
        if (!found.ok) return { ok: false, refusal: found };
        friendlyOf.set(f.factionId, found.targets);
      }
      const list = [...friendlyOf.get(f.factionId)];
      const home = byId.get(f.fleetId).homeSystemId;
      if (home !== null && home !== battle.systemId && !list.includes(home)) list.push(home);
      targetsOf.set(f.fleetId, list);
    }
    return { ok: true, targetsOf, friendlyOf };
  }

  const nestedReused = (stage, fleetId) => ({ ok: false, reason: "NESTED_KEY_REUSED", stage, fleetId });

  function runConsequences(db, settled, K) {
    const applied = [];
    const refused = [];
    for (const c of consequences) {
      const ck = `${K}:c:${c.name}`;
      const r = journal.applyOnce(db, { key: ck, aggregate: { type: BATTLE_AGGREGATE, id: settled.battleId },
        eventType: CONSEQUENCE_EVENT, payload: { battleId: settled.battleId, name: c.name } }, (db2) => {
        const out = c.apply(db2, settled, ck);
        return out && typeof out === "object" ? out : { ok: false, reason: "CONSEQUENCE_INVALID_RESULT" };
      });
      if (r.ok) applied.push(c.name);
      else {
        refused.push(c.name);
        const why = unwrap(r);
        lastRefusal = Object.freeze({ battleId: settled.battleId, reason: `consequence ${c.name}: `
          + `${(why && why.reason) || "FAILED"}` });
      }
    }
    return { applied, refused };
  }

  function settle(tx, req, settlementVersion) {
    const problem = validateKeys(req, REQ_KEYS);
    const battleId = req && req.battleId;
    if (problem) return invalidInput(battleId, problem);
    if (typeof req.inputHash !== "string" || !HASH_RE.test(req.inputHash)) return invalidInput(battleId, "inputHash");
    return settleCommon(tx, req, settlementVersion, { allowed: SETTLE_STATES, mode: undefined,
      inputHash: req.inputHash });
  }

  function settleLive(tx, req, settlementVersion) {
    const problem = validateKeys(req, LIVE_REQ_KEYS);
    const battleId = req && req.battleId;
    if (problem) return invalidInput(battleId, problem);
    return settleCommon(tx, req, settlementVersion, { allowed: LIVE_SETTLE_STATES, mode: LIVE_MODE, inputHash: null });
  }

  function settleCommon(tx, req, settlementVersion, spec) {
    const battleId = req.battleId;
    if (!isPlainObject(req.result)) return invalidInput(battleId, "result");
    if (!isTime(req.at)) return invalidInput(battleId, "at");
    if (!isSupportedVersion(settlementVersion)) {
      return refuse(battleId, { reason: "SETTLEMENT_VERSION_UNSUPPORTED", settlementVersion }, true);
    }
    if (!tx || tx.inTransaction !== true) return TX_REQUIRED;
    const K = settleKey(battleId, settlementVersion);
    const seen = seenAs(tx, K, battleId, SETTLED_EVENT);
    if (!seen.ok) return refuse(battleId, seen.refusal, seen.permanent === true);
    if (seen.found) {
      bump("duplicate");
      return { ok: true, duplicate: true, outcome: "COMPLETED", battleId, journalId: seen.journalId };
    }
    const loaded = loadBattle(tx, battleId, req.expectedVersion, spec.allowed, { mode: spec.mode });
    if (!loaded.ok) return refuse(battleId, loaded.refusal, loaded.permanent);
    const battle = loaded.battle;
    const data = checkData(tx, battle, req, spec.inputHash === null ? battle.inputHash : spec.inputHash);
    if (!data.ok) {
      if (data.refusal) return refuse(battleId, data.refusal, false);
      return quarantineBattle(tx, battle, data.cause, data.detail, settlementVersion);
    }
    const { plan, normalized, byId } = data;
    if (plan.rowBound > L.maxSettlementRows) {
      return refuse(battleId, { reason: "SETTLEMENT_TOO_LARGE", rows: plan.rowBound, limit: L.maxSettlementRows }, true);
    }
    const retreat = retreatPlan(tx, battle, plan, byId);
    if (!retreat.ok) return refuse(battleId, retreat.refusal, false);

    const payload = { battleId, settlementVersion, inputHash: battle.inputHash, resultHash: fingerprint(normalized),
      systemId: battle.systemId, outcome: normalized.outcome, objectiveAchieved: normalized.objectiveAchieved,
      winnerFactionId: plan.winnerFactionId, sideA: plan.sides.A, sideB: plan.sides.B, lossRows: plan.lossRows.length };
    let homes = 0;
    let refits = 0;
    const applied = journal.applyOnce(tx, { key: K, aggregate: { type: BATTLE_AGGREGATE, id: battleId },
      eventType: SETTLED_EVENT, payload }, (db) => {
      let battleVersion = battle.version;
      if (battle.state !== "SETTLING") {
        const r = battleRepository.transition(db, { battleId, expectedVersion: battleVersion, from: battle.state,
          to: "SETTLING", patch: { result: normalized } }, `${K}:settling`);
        if (!r.ok) return r;
        if (r.duplicate) return nestedReused("settling");
        battleVersion = r.version;
      }
      const versions = new Map([...byId.values()].map((f) => [f.fleetId, f.version]));
      for (const f of plan.fleets) {
        if (f.losses.length === 0) continue;
        const r = fleetRepository.applyLosses(db, { fleetId: f.fleetId, expectedVersion: versions.get(f.fleetId),
          losses: f.losses.map((l) => ({ hullGroup: l.hullGroup, typeId: l.typeId, count: l.count })) },
        `${K}:fleet:${f.fleetId}:losses`);
        if (!r.ok) return { ...r, fleetId: f.fleetId };
        if (r.duplicate) return nestedReused("losses", f.fleetId);
        if (r.destroyed !== (f.disposition === DISPOSITION.DESTROYED)) {
          return { ok: false, reason: "BATTLE_INVARIANT", fleetId: f.fleetId, detail: "destroyed != disposition" };
        }
        versions.set(f.fleetId, r.version);
      }
      if (plan.lossRows.length > 0) {
        const r = battleRepository.recordLosses(db, battleId, plan.lossRows, `${K}:losses`);
        if (!r.ok) return r;
        if (r.duplicate) return nestedReused("recordLosses");
      }
      const fleets = [];
      for (const f of plan.fleets) {
        if (f.disposition === DISPOSITION.DESTROYED) {
          fleets.push({ fleetId: f.fleetId, side: f.side, factionId: f.factionId, disposition: "DESTROYED",
            lost: f.destroyed, retreatTo: null });
          continue;
        }
        const r = travel.releaseFromBattleInTx(db, { fleetId: f.fleetId, expectedVersion: versions.get(f.fleetId),
          at: req.at, disposition: f.disposition, retreatTargets: retreat.targetsOf.get(f.fleetId) || [] },
        `${K}:fleet:${f.fleetId}:release`, { chained: true });
        if (!r.ok) return { ...r, fleetId: f.fleetId };
        if (r.duplicate) return nestedReused("release", f.fleetId);
        if (r.disposition === "REFITTING") refits += 1;
        if (r.retreatTo !== null && !(retreat.friendlyOf.get(f.factionId) || []).includes(r.retreatTo)) homes += 1;
        fleets.push({ fleetId: f.fleetId, side: f.side, factionId: f.factionId, disposition: r.disposition,
          lost: f.destroyed, retreatTo: r.retreatTo });
      }
      const settled = deepFreeze({ battleId, settlementKey: K, mode: battle.mode, systemId: battle.systemId,
        environment: battle.environment, at: req.at, outcome: normalized.outcome, winnerSide: plan.winnerSide,
        winnerFactionId: plan.winnerFactionId, sides: plan.sides,
        fleets: fleets.map((f) => ({ fleetId: f.fleetId, side: f.side, factionId: f.factionId,
          disposition: f.disposition, lost: f.lost })),
        losses: plan.lossRows.map((r) => ({ ...r })), ...fixedDefensesOf(battle.input, normalized) });
      const cons = runConsequences(db, settled, K);
      const done = battleRepository.transition(db, { battleId, expectedVersion: battleVersion, from: "SETTLING",
        to: "COMPLETED", patch: { settlementKey: K } }, `${K}:completed`);
      if (!done.ok) return done;
      if (done.duplicate) return nestedReused("completed");
      return { ok: true, fleets, consequences: cons };
    });
    if (!applied.ok) {
      const why = unwrap(applied);
      if (why && DATA_REASONS.includes(why.reason)) {
        return quarantineBattle(tx, battle, why.reason, detailOf(why), settlementVersion);
      }
      return refuse(battleId, why, false);
    }
    if (applied.duplicate) {
      bump("duplicate");
      return { ok: true, duplicate: true, outcome: "COMPLETED", battleId, journalId: applied.journalId };
    }
    const value = applied.value;
    bump(battle.mode === LIVE_MODE ? "liveCompleted" : "completed");
    bump("retreatHome", homes);
    bump("refitInPlace", refits);
    bump("consequenceRefused", value.consequences.refused.length);
    return { ok: true, duplicate: false, outcome: "COMPLETED", battleId, settlementKey: K, journalId: applied.journalId,
      fleets: value.fleets.map((f) => ({ fleetId: f.fleetId, disposition: f.disposition, lost: f.lost,
        retreatTo: f.retreatTo })), lossRows: plan.lossRows.length, consequences: value.consequences };
  }

  function checkError(req) {
    if (!isText(req.reason, MAX_REASON_LENGTH)) return "reason";
    if (req.detail !== undefined && !isText(req.detail, MAX_DETAIL_LENGTH)) return "detail";
    return null;
  }

  function cancel(tx, req, settlementVersion) {
    const battleId = req && req.battleId;
    const problem = validateKeys(req, CANCEL_KEYS) || (isTime(req.at) ? null : "at") || checkError(req);
    if (problem) return invalidInput(battleId, problem);
    if (!isSupportedVersion(settlementVersion)) {
      return refuse(battleId, { reason: "SETTLEMENT_VERSION_UNSUPPORTED", settlementVersion }, true);
    }
    if (!tx || tx.inTransaction !== true) return TX_REQUIRED;
    const K = failKey(battleId, settlementVersion);
    const seen = seenAs(tx, K, battleId, CANCELLED_EVENT);
    if (!seen.ok) return refuse(battleId, seen.refusal, seen.permanent === true);
    if (seen.found) return { ok: true, duplicate: true, outcome: "FAILED", battleId, journalId: seen.journalId };
    const loaded = loadBattle(tx, battleId, req.expectedVersion, CANCEL_STATES);
    if (!loaded.ok) return refuse(battleId, loaded.refusal, loaded.permanent);
    const battle = loaded.battle;
    const read = fleetRepository.getFleets(tx, battle.fleetIds);
    if (!read.ok) return refuse(battleId, read, false);
    const error = req.detail === undefined ? { reason: req.reason } : { reason: req.reason, detail: req.detail };
    const applied = journal.applyOnce(tx, { key: K, aggregate: { type: BATTLE_AGGREGATE, id: battleId },
      eventType: CANCELLED_EVENT, payload: { battleId, settlementVersion, reason: req.reason } }, (db) => {
      const r = battleRepository.transition(db, { battleId, expectedVersion: battle.version, from: battle.state,
        to: "FAILED", patch: { error } }, `${K}:failed`);
      if (!r.ok) return r;
      if (r.duplicate) return nestedReused("failed");
      const fleets = [];
      for (const f of read.fleets) {
        if (f.state !== ENGAGED) continue;
        const rel = travel.releaseFromBattleInTx(db, { fleetId: f.fleetId, expectedVersion: f.version, at: req.at,
          disposition: "STAY" }, `${K}:fleet:${f.fleetId}:release`, { chained: true });
        if (!rel.ok) return { ...rel, fleetId: f.fleetId };
        if (rel.duplicate) return nestedReused("release", f.fleetId);
        fleets.push({ fleetId: f.fleetId, disposition: rel.disposition });
      }
      return { ok: true, fleets };
    });
    if (!applied.ok) return refuse(battleId, unwrap(applied), false);
    if (applied.duplicate) return { ok: true, duplicate: true, outcome: "FAILED", battleId, journalId: applied.journalId };
    bump("cancelled");
    return { ok: true, duplicate: false, outcome: "FAILED", battleId, journalId: applied.journalId,
      fleets: applied.value.fleets };
  }

  function quarantine(tx, req, settlementVersion) {
    return quarantineCommon(tx, req, settlementVersion, CANCEL_STATES, {});
  }

  function quarantineLive(tx, req, settlementVersion) {
    return quarantineCommon(tx, req, settlementVersion, LIVE_SETTLE_STATES, { mode: LIVE_MODE });
  }

  function quarantineCommon(tx, req, settlementVersion, allowed, opts) {
    const battleId = req && req.battleId;
    const problem = validateKeys(req, QUARANTINE_KEYS) || checkError(req);
    if (problem) return invalidInput(battleId, problem);
    if (!isSupportedVersion(settlementVersion)) {
      return refuse(battleId, { reason: "SETTLEMENT_VERSION_UNSUPPORTED", settlementVersion }, true);
    }
    if (!tx || tx.inTransaction !== true) return TX_REQUIRED;
    const seen = seenAs(tx, quarantineKey(battleId, settlementVersion), battleId, null);
    if (!seen.ok) return refuse(battleId, seen.refusal, seen.permanent === true);
    if (seen.found) return { ok: true, duplicate: true, outcome: "QUARANTINED", battleId, journalId: seen.journalId };
    const loaded = loadBattle(tx, battleId, req.expectedVersion, allowed, opts);
    if (!loaded.ok) return refuse(battleId, loaded.refusal, loaded.permanent);
    return quarantineBattle(tx, loaded.battle, req.reason, req.detail, settlementVersion);
  }

  function getCounters() {
    return Object.freeze({ ...counters, lastRefusal, lastQuarantine });
  }

  return Object.freeze({ settle, settleLive, cancel, quarantine, quarantineLive, getCounters, limits: L });
}

module.exports = { createSettlement, SETTLED_EVENT, CANCELLED_EVENT, CONSEQUENCE_EVENT };
