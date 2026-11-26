"use strict";

const { toBind } = require("../persistence/repository");
const {
  LIVE_MEMBERS_TABLE_NAME: T, LIVE_MEMBER_STATES, MAX_LIVE_MEMBERS_PER_BATTLE, MAX_PROFILE_ID_LENGTH, SIDES,
} = require("./schema");

const MAX_ID_LENGTH = 64;
const MAX_MEMBER_KEY_LENGTH = 200;
const MAX_HULL_GROUP_LENGTH = 32;
const INITIAL_VERSION = 1;
const SPEC_KEYS = Object.freeze(["memberKey", "fleetId", "side", "factionId", "hullGroup", "typeId", "ordinal",
  "profileId"]);
const COLUMNS = "battle_id, member_key, claim_seq, fleet_id, side, faction_id, hull_group, type_id, ordinal, "
  + "profile_id, state, entity_id, boot_at, updated_at, version";

const TX_REQUIRED = Object.freeze({ ok: false, reason: "TX_REQUIRED" });
const txMissing = (tx) => !tx || tx.inTransaction !== true;
const isText = (v, max) => typeof v === "string" && v.length >= 1 && v.length <= max;
const isPositiveInt = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const invalid = (detail) => ({ ok: false, reason: "MEMBERS_INVALID", detail });

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function specProblem(m, i) {
  const where = `members[${i}]`;
  if (!isPlainObject(m)) return `${where}: not an object`;
  for (const k of Object.keys(m)) if (!SPEC_KEYS.includes(k)) return `${where}: field ${k}`;
  if (!isText(m.memberKey, MAX_MEMBER_KEY_LENGTH)) return `${where}.memberKey`;
  if (!isText(m.fleetId, MAX_ID_LENGTH)) return `${where}.fleetId`;
  if (!SIDES.includes(m.side)) return `${where}.side`;
  if (!isPositiveInt(m.factionId)) return `${where}.factionId`;
  if (!isText(m.hullGroup, MAX_HULL_GROUP_LENGTH)) return `${where}.hullGroup`;
  if (m.typeId !== null && !(Number.isSafeInteger(m.typeId) && m.typeId >= 0)) return `${where}.typeId`;
  if (!isPositiveInt(m.ordinal)) return `${where}.ordinal`;
  if (!isText(m.profileId, MAX_PROFILE_ID_LENGTH)) return `${where}.profileId`;
  return null;
}

function membersProblem(members) {
  if (!Array.isArray(members) || members.length === 0) return "members: empty or not an array";
  const seen = new Set();
  for (let i = 0; i < members.length; i += 1) {
    const p = specProblem(members[i], i);
    if (p) return p;
    if (seen.has(members[i].memberKey)) return `members[${i}]: duplicate memberKey`;
    seen.add(members[i].memberKey);
  }
  return null;
}

function toMember(row) {
  return Object.freeze({ battleId: row.battle_id, memberKey: row.member_key, claimSeq: row.claim_seq,
    fleetId: row.fleet_id, side: row.side, factionId: row.faction_id, hullGroup: row.hull_group,
    typeId: row.type_id === 0 ? null : row.type_id, ordinal: row.ordinal, profileId: row.profile_id, state: row.state,
    entityId: row.entity_id, bootAt: row.boot_at, updatedAt: row.updated_at, version: row.version });
}

function createLiveMemberRepository(deps) {
  if (!deps || !deps.clock || typeof deps.clock.now !== "function") {
    throw new TypeError("createLiveMemberRepository: clock.now required");
  }
  const clock = deps.clock;
  const perDb = new WeakMap();
  function stmts(db) {
    let s = perDb.get(db);
    if (s) return s;
    s = {
      one: db.prepare(`SELECT ${COLUMNS} FROM ${T} WHERE battle_id = ? AND member_key = ?`),
      insert: db.prepare(`INSERT INTO ${T} (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      byBattle: db.prepare(`SELECT ${COLUMNS} FROM ${T} WHERE battle_id = ?
        ORDER BY side, fleet_id, hull_group, type_id, ordinal`),
      byEntity: db.prepare(`SELECT ${COLUMNS} FROM ${T} WHERE boot_at = ? AND entity_id = ?`),
      spawn: db.prepare(`UPDATE ${T} SET state = 'SPAWNED', entity_id = ?, boot_at = ?, updated_at = ?,
        version = version + 1 WHERE battle_id = ? AND member_key = ? AND state = 'PLANNED'`),
      reserve: db.prepare(`UPDATE ${T} SET state = 'RESERVE', updated_at = ?, version = version + 1
        WHERE battle_id = ? AND member_key = ? AND state = 'PLANNED'`),
      spawnReserve: db.prepare(`UPDATE ${T} SET state = 'SPAWNED', entity_id = ?, boot_at = ?, updated_at = ?,
        version = version + 1 WHERE battle_id = ? AND member_key = ? AND state = 'RESERVE' AND claim_seq = ?`),
      destroy: db.prepare(`UPDATE ${T} SET state = 'DESTROYED', updated_at = ?, version = version + 1
        WHERE battle_id = ? AND member_key = ? AND state = 'SPAWNED'`),
      deleteBattle: db.prepare(`DELETE FROM ${T} WHERE battle_id = ?`),
    };
    perDb.set(db, s);
    return s;
  }

  function readNow() {
    const now = clock.now();
    return isTime(now) ? now : undefined;
  }

  function insertPlanned(tx, battleId, claimSeq, members) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isText(battleId, MAX_ID_LENGTH)) return invalid("battleId");
    if (!isPositiveInt(claimSeq)) return invalid("claimSeq");
    if (Array.isArray(members) && members.length > MAX_LIVE_MEMBERS_PER_BATTLE) {
      return { ok: false, reason: "MEMBERS_TOO_MANY", members: members.length, limit: MAX_LIVE_MEMBERS_PER_BATTLE };
    }
    const problem = membersProblem(members);
    if (problem) return invalid(problem);
    const now = readNow();
    if (now === undefined) return invalid("clock.now");
    const s = stmts(tx);
    for (const m of members) {
      if (s.one.get(battleId, m.memberKey)) return { ok: false, reason: "MEMBER_EXISTS", battleId, memberKey: m.memberKey };
    }
    for (const m of members) {
      s.insert.run(battleId, m.memberKey, toBind(claimSeq), m.fleetId, m.side, toBind(m.factionId), m.hullGroup,
        toBind(m.typeId === null ? 0 : m.typeId), toBind(m.ordinal), m.profileId, "PLANNED", null, null, toBind(now),
        toBind(INITIAL_VERSION));
    }
    return { ok: true, inserted: members.length };
  }

  function markSpawned(tx, battleId, bootAt, spawned, reserveKeys) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isText(battleId, MAX_ID_LENGTH)) return invalid("battleId");
    if (!isTime(bootAt)) return invalid("bootAt");
    if (!Array.isArray(spawned) || spawned.length === 0) return invalid("spawned: empty");
    const reserve = reserveKeys === undefined ? [] : reserveKeys;
    if (!Array.isArray(reserve) || reserve.some((k) => !isText(k, MAX_MEMBER_KEY_LENGTH))) return invalid("reserveKeys");
    const now = readNow();
    if (now === undefined) return invalid("clock.now");
    const s = stmts(tx);
    for (const x of spawned) {
      if (!x || !isText(x.memberKey, MAX_MEMBER_KEY_LENGTH) || !isPositiveInt(x.entityId)) return invalid("spawned");
      const taken = s.byEntity.get(toBind(bootAt), toBind(x.entityId));
      if (taken) return { ok: false, reason: "ENTITY_TAKEN", entityId: x.entityId, battleId: taken.battle_id };
    }
    for (const x of spawned) {
      const r = s.spawn.run(toBind(x.entityId), toBind(bootAt), toBind(now), battleId, x.memberKey);
      if (Number(r.changes) !== 1) return { ok: false, reason: "MEMBER_NOT_PLANNED", battleId, memberKey: x.memberKey };
    }
    for (const memberKey of reserve) {
      const r = s.reserve.run(toBind(now), battleId, memberKey);
      if (Number(r.changes) !== 1) return { ok: false, reason: "MEMBER_NOT_PLANNED", battleId, memberKey };
    }
    return { ok: true, spawned: spawned.length, reserved: reserve.length };
  }

  function markReserveSpawned(tx, battleId, claimSeq, bootAt, spawned) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isText(battleId, MAX_ID_LENGTH)) return invalid("battleId");
    if (!isPositiveInt(claimSeq)) return invalid("claimSeq");
    if (!isTime(bootAt)) return invalid("bootAt");
    if (!Array.isArray(spawned) || spawned.length === 0) return invalid("spawned: empty");
    const now = readNow();
    if (now === undefined) return invalid("clock.now");
    const s = stmts(tx);
    for (const x of spawned) {
      if (!x || !isText(x.memberKey, MAX_MEMBER_KEY_LENGTH) || !isPositiveInt(x.entityId)) return invalid("spawned");
      const row = s.one.get(battleId, x.memberKey);
      if (!row || row.state !== "RESERVE") {
        return { ok: false, reason: "MEMBER_NOT_RESERVE", battleId, memberKey: x.memberKey,
          state: row ? row.state : null };
      }
      if (Number(row.claim_seq) !== claimSeq) {
        return { ok: false, reason: "CLAIM_MISMATCH", battleId, memberKey: x.memberKey, claimSeq: Number(row.claim_seq) };
      }
      const taken = s.byEntity.get(toBind(bootAt), toBind(x.entityId));
      if (taken) return { ok: false, reason: "ENTITY_TAKEN", entityId: x.entityId, battleId: taken.battle_id };
    }
    for (const x of spawned) {
      const r = s.spawnReserve.run(toBind(x.entityId), toBind(bootAt), toBind(now), battleId, x.memberKey,
        toBind(claimSeq));
      if (Number(r.changes) !== 1) throw new Error(`markReserveSpawned: ${battleId}/${x.memberKey} not written`);
    }
    return { ok: true, spawned: spawned.length };
  }

  function markDestroyed(tx, battleId, memberKey) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isText(battleId, MAX_ID_LENGTH)) return invalid("battleId");
    if (!isText(memberKey, MAX_MEMBER_KEY_LENGTH)) return invalid("memberKey");
    const now = readNow();
    if (now === undefined) return invalid("clock.now");
    const r = stmts(tx).destroy.run(toBind(now), battleId, memberKey);
    if (Number(r.changes) !== 1) return { ok: false, reason: "MEMBER_NOT_SPAWNED", battleId, memberKey };
    return { ok: true };
  }

  function listByBattle(tx, battleId) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isText(battleId, MAX_ID_LENGTH)) return invalid("battleId");
    return { ok: true, members: Object.freeze(stmts(tx).byBattle.all(battleId).map(toMember)) };
  }

  function deleteByBattle(tx, battleId) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isText(battleId, MAX_ID_LENGTH)) return invalid("battleId");
    return { ok: true, deleted: Number(stmts(tx).deleteBattle.run(battleId).changes) };
  }

  function findByEntity(tx, bootAt, entityId) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isTime(bootAt)) return invalid("bootAt");
    if (!isPositiveInt(entityId)) return invalid("entityId");
    const row = stmts(tx).byEntity.get(toBind(bootAt), toBind(entityId));
    return { ok: true, member: row ? toMember(row) : null };
  }

  return Object.freeze({ insertPlanned, markSpawned, markReserveSpawned, markDestroyed, listByBattle, deleteByBattle,
    findByEntity });
}

module.exports = { createLiveMemberRepository, membersProblem, LIVE_MEMBER_STATES };
