"use strict";

const { fingerprint } = require("../util/fingerprint");
const { planLiveMembers, planGarrisonMembers, splitMembers, garrisonProblem, buildLiveResult, EXIT_REASONS } =
  require("./liveMembers");
const { membersProblem } = require("./liveMemberRepository");
const { MAX_LIVE_MEMBERS_PER_BATTLE } = require("./schema");
const { SETTLEMENT_VERSION } = require("./settlementPlan");
const { structureOf, withStructureOutcome } = require("./structureOutcome");

const BATTLE_AGGREGATE = "battle";
const LIVE_MODE = "LIVE_EVEJS";
const VIRTUAL = "VIRTUAL";
const LIVE_UNSUPPORTED = "LIVE_UNSUPPORTED";
const RESOLUTION_EVENT = "BATTLE_RESOLUTION";
const TERMINAL = Object.freeze(["COMPLETED", "FAILED", "QUARANTINED"]);
const MATERIALIZABLE_STATES = Object.freeze(["PENDING", "CLAIMED"]);
const MAX_ID_LENGTH = 64;
const MAX_REASON_LENGTH = 64;
const EXIT_REQ_KEYS = Object.freeze(["battleId", "at", "reason", "structure"]);

const TX_REQUIRED = Object.freeze({ ok: false, reason: "TX_REQUIRED" });
const txMissing = (tx) => !tx || tx.inTransaction !== true;
const isText = (v, max) => typeof v === "string" && v.length >= 1 && v.length <= max;
const isVersion = (v) => Number.isSafeInteger(v) && v >= 1;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isPositiveInt = (v) => Number.isSafeInteger(v) && v > 0;
const invalid = (detail) => ({ ok: false, reason: "LIVE_INVALID_INPUT", detail });
const unwrap = (r) => (r && r.reason === "APPLY_REFUSED" && r.refusal ? r.refusal : r);
const typeOf = (t) => (t === null || t === undefined ? 0 : t);

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function refusalOf(r) {
  const out = { ...unwrap(r) };
  delete out.error;
  out.ok = false;
  if (!out.reason) out.reason = "LIVE_FAILED";
  return out;
}

function createLiveBridge(deps) {
  if (!deps || typeof deps !== "object") throw new TypeError("createLiveBridge: deps missing");
  const { journal, battleRepository, memberRepository, settlement, scheduler, limits } = deps;
  if (!journal || typeof journal.applyOnce !== "function") throw new TypeError("createLiveBridge: journal required");
  for (const fn of ["getBattle", "claim", "transition", "listOpenInSystem"]) {
    if (!battleRepository || typeof battleRepository[fn] !== "function") {
      throw new TypeError(`createLiveBridge: battleRepository.${fn} required`);
    }
  }
  if (!memberRepository || typeof memberRepository.insertPlanned !== "function") {
    throw new TypeError("createLiveBridge: memberRepository required");
  }
  if (!settlement || typeof settlement.settleLive !== "function") {
    throw new TypeError("createLiveBridge: settlement.settleLive required");
  }
  if (!scheduler || typeof scheduler.enqueue !== "function") throw new TypeError("createLiveBridge: scheduler required");
  if (!limits || !isPositiveInt(limits.maxListLimit)) throw new TypeError("createLiveBridge: limits.maxListLimit");
  const bump = typeof deps.bump === "function" ? deps.bump : () => {};
  const garrisonLiveEnabled = deps.garrisonLiveEnabled === true;

  function readBattle(db, battleId) {
    const read = battleRepository.getBattle(db, battleId);
    if (!read.ok) return read;
    if (!read.battle) return { ok: false, reason: "BATTLE_NOT_FOUND", battleId };
    return { ok: true, battle: read.battle };
  }

  const isMaterializing = (b, claimSeq) => b.state === "CLAIMED" && b.mode === LIVE_MODE && b.claimSeq === claimSeq;
  const notMaterializing = (b) => ({ ok: false, reason: "NOT_MATERIALIZING", battleId: b.battleId, state: b.state,
    mode: b.mode, claimSeq: b.claimSeq });
  const versionConflict = (b, expectedVersion) => ({ ok: false, reason: "VERSION_CONFLICT", expectedVersion,
    actualVersion: b.version });

  function membersMatchPlan(input, all) {
    const { fleet: members, garrison } = splitMembers(all);
    const plan = planLiveMembers(input, { maxShips: Math.max(1, members.length) });
    if (!plan.ok) return { ok: false, reason: "MEMBERS_INVALID", detail: plan.reason };
    if (plan.members.length !== members.length) return { ok: false, reason: "MEMBERS_INVALID", detail: "count" };
    const proxyProblem = garrisonProblem(input, garrison);
    if (proxyProblem) return { ok: false, reason: "MEMBERS_INVALID", detail: proxyProblem };
    const byKey = new Map(members.map((m) => [m.memberKey, m]));
    for (const p of plan.members) {
      const m = byKey.get(p.memberKey);
      if (!m || m.fleetId !== p.fleetId || m.side !== p.side || m.factionId !== p.factionId
        || m.hullGroup !== p.hullGroup || typeOf(m.typeId) !== typeOf(p.typeId) || m.ordinal !== p.ordinal) {
        return { ok: false, reason: "MEMBERS_INVALID", detail: `member ${p.memberKey}` };
      }
    }
    return { ok: true };
  }

  function listMaterializableInTx(tx, systemId, opts = {}) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isPositiveInt(systemId)) return invalid("systemId");
    if (!isPlainObject(opts)) return invalid("opts");
    if (opts.limit !== undefined && !isPositiveInt(opts.limit)) return invalid("opts.limit");
    const limit = Math.min(opts.limit === undefined ? limits.maxListLimit : opts.limit, limits.maxListLimit);
    const read = battleRepository.listOpenInSystem(tx, systemId, { states: [...MATERIALIZABLE_STATES],
      limit: limits.maxListLimit });
    if (!read.ok) return read;
    const battles = [];
    for (const b of read.battles) {
      if (battles.length >= limit) break;
      if (b.state === "PENDING" && b.holdReason === LIVE_UNSUPPORTED) continue;
      if (b.state === "CLAIMED" && b.mode !== VIRTUAL) continue;
      let shipCount = 0;
      for (const side of [b.input.sideA, b.input.sideB]) {
        for (const f of side.fleets) for (const e of f.composition) shipCount += e.count;
      }
      battles.push(Object.freeze({ battleId: b.battleId, version: b.version, state: b.state, mode: b.mode,
        claimSeq: b.claimSeq, holdReason: b.holdReason, createdAt: b.createdAt, shipCount }));
    }
    return { ok: true, battles: Object.freeze(battles) };
  }

  function readLiveInTx(tx, battleId) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isText(battleId, MAX_ID_LENGTH)) return invalid("battleId");
    const read = readBattle(tx, battleId);
    if (!read.ok) return read;
    const b = read.battle;
    return { ok: true, battle: Object.freeze({ battleId: b.battleId, systemId: Number(b.systemId), state: b.state,
      mode: b.mode, claimSeq: b.claimSeq, version: b.version, updatedAt: Number(b.updatedAt), input: b.input,
      grid: b.grid ? Object.freeze({ kind: b.grid.kind, id: b.grid.id }) : null }) };
  }

  function listMembersInTx(tx, battleId) {
    if (txMissing(tx)) return TX_REQUIRED;
    return memberRepository.listByBattle(tx, battleId);
  }

  function claimLiveInTx(tx, req, members) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isPlainObject(req) || Object.keys(req).some((k) => k !== "battleId" && k !== "expectedVersion")) {
      return invalid("req");
    }
    if (!isText(req.battleId, MAX_ID_LENGTH)) return invalid("battleId");
    if (!isVersion(req.expectedVersion)) return invalid("expectedVersion");
    if (Array.isArray(members) && members.length > MAX_LIVE_MEMBERS_PER_BATTLE) {
      return { ok: false, reason: "MEMBERS_TOO_MANY", members: members.length, limit: MAX_LIVE_MEMBERS_PER_BATTLE };
    }
    const problem = membersProblem(members);
    if (problem) return { ok: false, reason: "MEMBERS_INVALID", detail: problem };
    const { battleId, expectedVersion } = req;
    const key = `battle:${battleId}:liveclaim:v${expectedVersion}`;
    const r = journal.applyOnce(tx, { key, aggregate: { type: BATTLE_AGGREGATE, id: battleId },
      eventType: "BATTLE_LIVE_CLAIMED", payload: { battleId, expectedVersion, members: members.length,
        membersHash: fingerprint(members) } }, (db) => {
      const read = readBattle(db, battleId);
      if (!read.ok) return read;
      const b = read.battle;
      if (b.state === "RESOLVING" || b.state === "SETTLING") {
        return { ok: false, reason: "BATTLE_ALREADY_RESOLVING", battleId, state: b.state };
      }
      if (b.state === "LIVE" || (b.state === "CLAIMED" && b.mode === LIVE_MODE)) {
        return { ok: false, reason: "BATTLE_ALREADY_LIVE", battleId, state: b.state };
      }
      if (TERMINAL.includes(b.state)) return { ok: false, reason: "BATTLE_TERMINAL", battleId, state: b.state };
      if (b.version !== expectedVersion) return versionConflict(b, expectedVersion);
      if (b.input.garrison !== null && !garrisonLiveEnabled) {
        return { ok: false, reason: "GARRISON_UNSUPPORTED", battleId };
      }
      const match = membersMatchPlan(b.input, members);
      if (!match.ok) return match;
      const c = battleRepository.claim(db, { battleId, expectedVersion, mode: LIVE_MODE },
        `battle:${battleId}:claim:${b.claimSeq + 1}:${LIVE_MODE}`);
      if (!c.ok) return c;
      if (c.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", stage: "claim" };
      const ins = memberRepository.insertPlanned(db, battleId, c.claimSeq, members);
      if (!ins.ok) return ins;
      return { ok: true, claimSeq: c.claimSeq, version: c.version };
    });
    if (!r.ok) return refusalOf(r);
    if (r.duplicate) return { ok: true, duplicate: true, battleId, journalId: r.journalId };
    bump("live.claimed");
    if (splitMembers(members).garrison.length > 0) bump("live.garrisonClaimed");
    return { ok: true, duplicate: false, battleId, claimSeq: r.value.claimSeq, version: r.value.version,
      journalId: r.journalId };
  }

  function markLiveInTx(tx, req) {
    if (txMissing(tx)) return TX_REQUIRED;
    const KEYS = ["battleId", "expectedVersion", "claimSeq", "bootAt", "spawned", "reserve"];
    if (!isPlainObject(req) || Object.keys(req).some((k) => !KEYS.includes(k))) return invalid("req");
    const { battleId, expectedVersion, claimSeq, bootAt, spawned } = req;
    const hasReserve = Object.prototype.hasOwnProperty.call(req, "reserve");
    const reserve = hasReserve ? req.reserve : [];
    if (!isText(battleId, MAX_ID_LENGTH)) return invalid("battleId");
    if (!isVersion(expectedVersion)) return invalid("expectedVersion");
    if (!isPositiveInt(claimSeq)) return invalid("claimSeq");
    if (!isTime(bootAt)) return invalid("bootAt");
    if (!Array.isArray(spawned) || spawned.length === 0 || spawned.length > MAX_LIVE_MEMBERS_PER_BATTLE) {
      return { ok: false, reason: "MEMBERS_INVALID", detail: "spawned" };
    }
    const keys = new Set();
    const entities = new Set();
    for (const x of spawned) {
      if (!isPlainObject(x) || Object.keys(x).some((k) => k !== "memberKey" && k !== "entityId")
        || typeof x.memberKey !== "string" || !isPositiveInt(x.entityId) || keys.has(x.memberKey)
        || entities.has(x.entityId)) {
        return { ok: false, reason: "MEMBERS_INVALID", detail: "spawned: entry" };
      }
      keys.add(x.memberKey);
      entities.add(x.entityId);
    }
    if (!Array.isArray(reserve) || spawned.length + reserve.length > MAX_LIVE_MEMBERS_PER_BATTLE) {
      return { ok: false, reason: "MEMBERS_INVALID", detail: "reserve" };
    }
    const reserveKeys = new Set();
    for (const k of reserve) {
      if (typeof k !== "string" || k === "" || keys.has(k) || reserveKeys.has(k)) {
        return { ok: false, reason: "MEMBERS_INVALID", detail: "reserve: entry" };
      }
      reserveKeys.add(k);
    }
    const sorted = [...spawned].sort((a, b) => (a.memberKey < b.memberKey ? -1 : a.memberKey > b.memberKey ? 1 : 0))
      .map((x) => ({ memberKey: x.memberKey, entityId: x.entityId }));
    const sortedReserve = [...reserveKeys].sort();
    const key = `battle:${battleId}:live:${claimSeq}`;
    const payload = { battleId, claimSeq, bootAt, spawned: sorted.length, spawnedHash: fingerprint(sorted),
      ...(hasReserve ? { reserve: sortedReserve.length, reserveHash: fingerprint(sortedReserve) } : {}) };
    const r = journal.applyOnce(tx, { key, aggregate: { type: BATTLE_AGGREGATE, id: battleId },
      eventType: "BATTLE_LIVE_STARTED", payload }, (db) => {
      const read = readBattle(db, battleId);
      if (!read.ok) return read;
      const b = read.battle;
      if (!isMaterializing(b, claimSeq)) return notMaterializing(b);
      if (b.version !== expectedVersion) return versionConflict(b, expectedVersion);
      const list = memberRepository.listByBattle(db, battleId);
      if (!list.ok) return list;
      const planned = list.members.filter((m) => m.state === "PLANNED" && m.claimSeq === claimSeq);
      if (planned.length !== list.members.length || planned.length !== sorted.length + sortedReserve.length
        || planned.some((m) => !keys.has(m.memberKey) && !reserveKeys.has(m.memberKey))) {
        const what = hasReserve ? "spawned+reserve" : "spawned";
        return { ok: false, reason: "MEMBERS_INVALID", detail: `${what} != PLANNED members of the claim` };
      }
      const sp = hasReserve ? memberRepository.markSpawned(db, battleId, bootAt, sorted, sortedReserve)
        : memberRepository.markSpawned(db, battleId, bootAt, sorted);
      if (!sp.ok) return sp;
      const t = battleRepository.transition(db, { battleId, expectedVersion, from: "CLAIMED", to: "LIVE" },
        `${key}:state`);
      if (!t.ok) return t;
      if (t.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", stage: "live" };
      return { ok: true, version: t.version };
    });
    if (!r.ok) return refusalOf(r);
    if (r.duplicate) return { ok: true, duplicate: true, battleId, journalId: r.journalId };
    bump("live.live");
    return { ok: true, duplicate: false, battleId, version: r.value.version, journalId: r.journalId };
  }

  function revertLiveClaimInTx(tx, req) {
    if (txMissing(tx)) return TX_REQUIRED;
    const KEYS = ["battleId", "expectedVersion", "claimSeq", "at", "reason"];
    if (!isPlainObject(req) || Object.keys(req).some((k) => !KEYS.includes(k))) return invalid("req");
    const { battleId, expectedVersion, claimSeq, at, reason } = req;
    if (!isText(battleId, MAX_ID_LENGTH)) return invalid("battleId");
    if (!isVersion(expectedVersion)) return invalid("expectedVersion");
    if (!isPositiveInt(claimSeq)) return invalid("claimSeq");
    if (!isTime(at)) return invalid("at");
    if (!isText(reason, MAX_REASON_LENGTH)) return invalid("reason");
    const key = `battle:${battleId}:revert:${claimSeq}`;
    const r = journal.applyOnce(tx, { key, aggregate: { type: BATTLE_AGGREGATE, id: battleId },
      eventType: "BATTLE_LIVE_REVERTED", payload: { battleId, claimSeq, reason } }, (db) => {
      const read = readBattle(db, battleId);
      if (!read.ok) return read;
      const b = read.battle;
      if (!isMaterializing(b, claimSeq)) return notMaterializing(b);
      if (b.version !== expectedVersion) return versionConflict(b, expectedVersion);
      const c = battleRepository.claim(db, { battleId, expectedVersion, mode: VIRTUAL },
        `battle:${battleId}:claim:${claimSeq + 1}:${VIRTUAL}`);
      if (!c.ok) return c;
      if (c.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", stage: "claim" };
      const del = memberRepository.deleteByBattle(db, battleId);
      if (!del.ok) return del;
      const e = scheduler.enqueue(RESOLUTION_EVENT, battleId, at, { battleId, at },
        `battle:${battleId}:resolve:r${claimSeq}`, { tx: db });
      if (!e || e.ok !== true) return { ok: false, reason: (e && e.reason) || "ENQUEUE_FAILED", stage: "resolve" };
      return { ok: true, claimSeq: c.claimSeq, version: c.version, deleted: del.deleted };
    });
    if (!r.ok) return refusalOf(r);
    if (r.duplicate) return { ok: true, duplicate: true, battleId, journalId: r.journalId };
    bump("live.reverted");
    return { ok: true, duplicate: false, battleId, claimSeq: r.value.claimSeq, version: r.value.version,
      deleted: r.value.deleted, journalId: r.journalId };
  }

  function markDestroyedInTx(tx, req) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isPlainObject(req) || Object.keys(req).some((k) => k !== "battleId" && k !== "memberKey")) {
      return invalid("req");
    }
    const { battleId, memberKey } = req;
    if (!isText(battleId, MAX_ID_LENGTH)) return invalid("battleId");
    if (typeof memberKey !== "string" || memberKey === "") return invalid("memberKey");
    const read = readBattle(tx, battleId);
    if (!read.ok) return read;
    const b = read.battle;
    if (b.state !== "LIVE" || b.mode !== LIVE_MODE) {
      return { ok: false, reason: "NOT_LIVE", battleId, state: b.state, mode: b.mode };
    }
    const r = memberRepository.markDestroyed(tx, battleId, memberKey);
    if (r.ok) return { ok: true, duplicate: false };
    if (r.reason === "MEMBER_NOT_SPAWNED") return { ok: true, duplicate: true };
    return refusalOf(r);
  }

  function spawnReserveInTx(tx, req) {
    if (txMissing(tx)) return TX_REQUIRED;
    const KEYS = ["battleId", "claimSeq", "bootAt", "spawned"];
    if (!isPlainObject(req) || Object.keys(req).some((k) => !KEYS.includes(k))) return invalid("req");
    const { battleId, claimSeq, bootAt, spawned } = req;
    if (!isText(battleId, MAX_ID_LENGTH)) return invalid("battleId");
    if (!isPositiveInt(claimSeq)) return invalid("claimSeq");
    if (!isTime(bootAt)) return invalid("bootAt");
    if (!Array.isArray(spawned) || spawned.length === 0 || spawned.length > MAX_LIVE_MEMBERS_PER_BATTLE) {
      return invalid("spawned");
    }
    const keys = new Set();
    const entities = new Set();
    for (const x of spawned) {
      if (!isPlainObject(x) || Object.keys(x).some((k) => k !== "memberKey" && k !== "entityId")
        || typeof x.memberKey !== "string" || x.memberKey === "" || !isPositiveInt(x.entityId)
        || keys.has(x.memberKey) || entities.has(x.entityId)) {
        return invalid("spawned: entry");
      }
      keys.add(x.memberKey);
      entities.add(x.entityId);
    }
    const read = readBattle(tx, battleId);
    if (!read.ok) return read;
    const b = read.battle;
    if (b.state !== "LIVE" || b.mode !== LIVE_MODE) {
      return { ok: false, reason: "NOT_LIVE", battleId, state: b.state, mode: b.mode };
    }
    if (b.claimSeq !== claimSeq) return { ok: false, reason: "CLAIM_MISMATCH", battleId, claimSeq: b.claimSeq };
    const r = memberRepository.markReserveSpawned(tx, battleId, claimSeq, bootAt,
      spawned.map((x) => ({ memberKey: x.memberKey, entityId: x.entityId })));
    if (!r.ok) return refusalOf(r);
    bump("live.reserveSpawned", r.spawned);
    return { ok: true, spawned: r.spawned };
  }

  function exitLiveInTx(tx, req) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isPlainObject(req) || Object.keys(req).some((k) => !EXIT_REQ_KEYS.includes(k))) {
      return invalid("req");
    }
    const { battleId, at, reason, structure } = req;
    if (!isText(battleId, MAX_ID_LENGTH)) return invalid("battleId");
    if (!isTime(at)) return invalid("at");
    if (!EXIT_REASONS.includes(reason)) return invalid("reason");
    if (structure !== undefined && (!isPlainObject(structure) || Object.keys(structure).some((k) => k !== "destroyed")
      || typeof structure.destroyed !== "boolean")) {
      return invalid("structure");
    }
    const read = readBattle(tx, battleId);
    if (!read.ok) return read;
    const b = read.battle;
    if (structure !== undefined && structureOf(b.input) === null) return invalid("structure: no structureId");
    let result;
    if (b.state === "LIVE" && b.mode === LIVE_MODE) {
      const list = memberRepository.listByBattle(tx, battleId);
      if (!list.ok) return list;
      const built = buildLiveResult(b, list.members, { at, reason });
      if (!built.ok) {
        if (built.reason !== "MEMBERS_INVALID" || typeof settlement.quarantineLive !== "function") return built;
        return settlement.quarantineLive(tx, { battleId, reason: "LIVE_MEMBERS_INVALID",
          ...(built.detail ? { detail: String(built.detail) } : {}) }, SETTLEMENT_VERSION);
      }
      result = withStructureOutcome(built.result, b.input, structure);
    } else {
      result = b.state === "SETTLING" && b.result ? b.result : {};
    }
    const s = settlement.settleLive(tx, { battleId, result, at }, SETTLEMENT_VERSION);
    if (!s.ok || s.duplicate || s.outcome !== "COMPLETED") return s;
    const del = memberRepository.deleteByBattle(tx, battleId);
    if (!del.ok) throw new Error(`exitLiveInTx: members not deleted - ${del.reason}`);
    bump("live.settled");
    return { ...s, membersDeleted: del.deleted };
  }

  function markUnsupportedInTx(tx, req) {
    if (txMissing(tx)) return TX_REQUIRED;
    const KEYS = ["battleId", "expectedVersion", "reason"];
    if (!isPlainObject(req) || Object.keys(req).some((k) => !KEYS.includes(k))) return invalid("req");
    const { battleId, expectedVersion, reason } = req;
    if (!isText(battleId, MAX_ID_LENGTH)) return invalid("battleId");
    if (!isVersion(expectedVersion)) return invalid("expectedVersion");
    if (!isText(reason, MAX_REASON_LENGTH)) return invalid("reason");
    const key = `battle:${battleId}:unsupported:${expectedVersion}`;
    const r = journal.applyOnce(tx, { key, aggregate: { type: BATTLE_AGGREGATE, id: battleId },
      eventType: "BATTLE_LIVE_UNSUPPORTED", payload: { battleId, expectedVersion, reason } }, (db) => {
      const read = readBattle(db, battleId);
      if (!read.ok) return read;
      const b = read.battle;
      if (b.state !== "PENDING") return { ok: false, reason: "NOT_PENDING", battleId, state: b.state };
      if (b.version !== expectedVersion) return versionConflict(b, expectedVersion);
      const t = battleRepository.transition(db, { battleId, expectedVersion, from: "PENDING", to: "PENDING",
        patch: { holdReason: LIVE_UNSUPPORTED } }, `${key}:hold`);
      if (!t.ok) return t;
      if (t.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", stage: "hold" };
      return { ok: true, version: t.version };
    });
    if (!r.ok) return refusalOf(r);
    if (r.duplicate) return { ok: true, duplicate: true, battleId, journalId: r.journalId };
    bump("live.unsupported");
    return { ok: true, duplicate: false, battleId, version: r.value.version, journalId: r.journalId };
  }

  return Object.freeze({ planMembers: planLiveMembers, planGarrison: planGarrisonMembers, listMaterializableInTx,
    claimLiveInTx, listMembersInTx, markLiveInTx, revertLiveClaimInTx, exitLiveInTx, markUnsupportedInTx, readLiveInTx,
    markDestroyedInTx, spawnReserveInTx });
}

const LIVE_METHODS = Object.freeze(["planMembers", "planGarrison", "listMaterializableInTx", "claimLiveInTx",
  "listMembersInTx", "markLiveInTx", "revertLiveClaimInTx", "exitLiveInTx", "markUnsupportedInTx", "readLiveInTx",
  "markDestroyedInTx", "spawnReserveInTx"]);

module.exports = { createLiveBridge, LIVE_METHODS, LIVE_UNSUPPORTED };
