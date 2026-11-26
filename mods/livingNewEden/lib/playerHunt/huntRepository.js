"use strict";

const { defineTable, updateWithVersion, toBind } = require("../persistence/repository");
const { deriveSeed } = require("../util/rng");
const { memberKeyOf } = require("../battle/liveMembers");
const S = require("./schema");
const { REPEL_ROWS } = require("./repel");
const { orderForQuarry, HULL_RANK } = require("./policy");

const T = S.TABLE_NAME;
const HUNT_TABLE = defineTable({ name: T, idColumn: "hunt_id",
  columns: ["state", "members_json", "live_at", "ended_at", "end_reason", "losses_json", "updated_at"] });
const COLUMNS = "hunt_id, fleet_id, faction_id, system_id, character_id, mode, state, standing, members_json, seed, "
  + "started_at, live_at, ended_at, end_reason, losses_json, updated_at, version";
const MAX_ID_LENGTH = 64;
const MAX_MEMBER_KEY_LENGTH = 128;
const MAX_LIST_LIMIT = 1000;
const FLEET_IDLE = "IDLE";
const FLEET_STAGED = "STAGED";
const FLEET_MATERIALIZED = "MATERIALIZED";
const FLEET_DESTROYED = "DESTROYED";
const INITIAL_VERSION = 1;
const EVENT = Object.freeze({ CLAIM: "PLAYER_HUNT_CLAIMED", LIVE: "PLAYER_HUNT_LIVE", LOSS: "PLAYER_HUNT_LOSS",
  END: "PLAYER_HUNT_ENDED" });
const END_ROWS = 6 + REPEL_ROWS + S.RELEASE_CONTACT_ROWS;

const TX_REQUIRED = Object.freeze({ ok: false, reason: "TX_REQUIRED" });
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const isText = (v, max) => typeof v === "string" && v.length > 0 && v.length <= max;
const isPositiveId = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const typeOrder = (typeId) => (typeId === null || typeId === undefined ? 0 : typeId);

function invalid(detail) {
  return { ok: false, reason: "PLAYER_HUNT_INVALID_INPUT", detail };
}

function unknownKey(obj, allowed) {
  return Object.keys(obj).find((k) => !allowed.includes(k));
}

function parseJson(text) {
  return text === null || text === undefined ? null : JSON.parse(text);
}

function toHunt(row) {
  return {
    huntId: row.hunt_id, fleetId: row.fleet_id, factionId: row.faction_id, systemId: row.system_id,
    characterId: row.character_id, mode: row.mode, state: row.state, standing: row.standing,
    members: JSON.parse(row.members_json), seed: row.seed, startedAt: row.started_at, liveAt: row.live_at,
    endedAt: row.ended_at, endReason: row.end_reason, losses: parseJson(row.losses_json), updatedAt: row.updated_at,
    version: row.version,
  };
}

function membersOf(fleetId, composition) {
  const groups = [...composition].sort((a, b) => (a.hullGroup < b.hullGroup ? -1 : a.hullGroup > b.hullGroup ? 1 : 0)
    || typeOrder(a.typeId) - typeOrder(b.typeId));
  const out = [];
  for (const g of groups) {
    const typeId = g.typeId === undefined ? null : g.typeId;
    for (let ordinal = 1; ordinal <= g.count; ordinal += 1) {
      out.push({ memberKey: memberKeyOf(fleetId, g.hullGroup, typeId, ordinal), hullGroup: g.hullGroup, typeId,
        state: "PLANNED" });
    }
  }
  return out;
}

function pickDetachment(members, n) {
  const list = Array.isArray(members) ? members : [];
  if (!Number.isSafeInteger(n) || n < 1 || n >= list.length) return [...list];
  const groups = [];
  const byGroup = new Map();
  for (const m of list) {
    const k = `${m.hullGroup}\u0000${typeOrder(m.typeId)}`;
    let g = byGroup.get(k);
    if (!g) {
      g = [];
      byGroup.set(k, g);
      groups.push(g);
    }
    g.push(m);
  }
  const out = [];
  for (let round = 0; out.length < n; round += 1) {
    for (const g of groups) {
      if (round < g.length && out.length < n) out.push(g[round]);
    }
  }
  return out;
}

function pickMatchedDetachment(members, quarryClass, n) {
  const list = Array.isArray(members) ? members : [];
  if (!has(HULL_RANK, quarryClass) || !Number.isSafeInteger(n) || n < 1 || n >= list.length) {
    return pickDetachment(list, n);
  }
  const q = HULL_RANK[quarryClass];
  const tierOf = (m) => (m && has(HULL_RANK, m.hullGroup) ? Math.abs(HULL_RANK[m.hullGroup] - q) : Infinity);
  const ordered = orderForQuarry(list, quarryClass);
  const out = [];
  let i = 0;
  while (i < ordered.length && out.length < n) {
    const tier = tierOf(ordered[i]);
    let j = i;
    while (j < ordered.length && tierOf(ordered[j]) === tier) j += 1;
    out.push(...pickDetachment(ordered.slice(i, j), n - out.length));
    i = j;
  }
  return out;
}

function lossesOf(members) {
  const byGroup = new Map();
  for (const m of members) {
    if (m.state !== "DESTROYED") continue;
    const k = `${m.hullGroup}\u0000${typeOrder(m.typeId)}`;
    const g = byGroup.get(k) || { hullGroup: m.hullGroup, typeId: m.typeId === undefined ? null : m.typeId, count: 0 };
    g.count += 1;
    byGroup.set(k, g);
  }
  return [...byGroup.values()].sort((a, b) => (a.hullGroup < b.hullGroup ? -1 : a.hullGroup > b.hullGroup ? 1 : 0)
    || typeOrder(a.typeId) - typeOrder(b.typeId));
}

const unwrap = (r) => (r.reason === "APPLY_REFUSED" ? r.refusal : r);

function callRepel(repel, db, info) {
  try {
    const r = repel(db, info);
    if (!r || typeof r !== "object" || typeof r.applied !== "boolean") return { applied: false, reason: "REPEL_INVALID" };
    const out = { applied: r.applied };
    if (typeof r.outcome === "string") out.outcome = r.outcome;
    if (typeof r.reason === "string") out.reason = r.reason;
    return out;
  } catch (_err) {
    return { applied: false, reason: "REPEL_THREW" };
  }
}

function callReleaseContact(hook, db, info) {
  if (hook === null) return;
  try {
    hook(db, info);
  } catch (_err) {
  }
}

function createHuntRepository(deps) {
  const { journal, fleetRepository, worldSeed } = deps || {};
  const repel = deps && typeof deps.repel === "function" ? deps.repel : null;
  const releaseContact = deps && typeof deps.releaseContact === "function" ? deps.releaseContact : null;
  const getCrews = deps && typeof deps.getCrews === "function" ? deps.getCrews : () => null;
  const crewMaxRows = deps && Number.isSafeInteger(deps.crewMaxRows) && deps.crewMaxRows > 0
    ? deps.crewMaxRows : undefined;
  const withRepel = (res, value) => (repel === null ? res : { ...res, repel: value });
  if (!journal || typeof journal.applyOnce !== "function") {
    throw new TypeError("createHuntRepository: journal.applyOnce required");
  }
  for (const fn of ["getFleet", "transition", "applyLosses"]) {
    if (!fleetRepository || typeof fleetRepository[fn] !== "function") {
      throw new TypeError(`createHuntRepository: fleetRepository.${fn} required`);
    }
  }
  if (!Number.isSafeInteger(worldSeed) || worldSeed < 0) {
    throw new TypeError(`createHuntRepository: worldSeed must be a uint32, got ${worldSeed}`);
  }

  const perDb = new WeakMap();
  function stmts(db) {
    let s = perDb.get(db);
    if (s) return s;
    s = {
      byId: db.prepare(`SELECT ${COLUMNS} FROM ${T} WHERE hunt_id = ?`),
      openOfFleet: db.prepare(`SELECT hunt_id FROM ${T} WHERE fleet_id = ? AND state IN ('CLAIMED','LIVE')`),
      insert: db.prepare(`INSERT INTO ${T} (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      listOpen: db.prepare(`SELECT ${COLUMNS} FROM ${T} WHERE state IN ('CLAIMED','LIVE') AND hunt_id > ?
        ORDER BY hunt_id LIMIT ?`),
      countOpen: db.prepare(`SELECT count(*) AS n FROM ${T} WHERE state IN ('CLAIMED','LIVE')`),
      lastEnded: db.prepare(`SELECT ended_at FROM ${T} WHERE character_id = ? AND faction_id = ?
        AND mode IN ('SWEEP','SCAN') AND end_reason NOT IN ('RESTART') AND ended_at IS NOT NULL
        ORDER BY ended_at DESC LIMIT 1`),
      recentEnded: db.prepare(`SELECT end_reason, members_json FROM ${T} WHERE character_id = ? AND faction_id = ?
        AND mode IN ('SWEEP','SCAN') AND end_reason NOT IN ('RESTART') AND ended_at >= ?
        ORDER BY ended_at DESC LIMIT ?`),
    };
    perDb.set(db, s);
    return s;
  }

  const txMissing = (tx) => !tx || tx.inTransaction !== true;

  function crewLossInTx(db, fleetId, at, key) {
    try {
      const crews = getCrews();
      if (!crews || typeof crews.reconcileGuardedInTx !== "function") return;
      crews.reconcileGuardedInTx(db, fleetId, { cause: "LIVE", at, ...(crewMaxRows ? { maxRows: crewMaxRows } : {}) },
        key);
    } catch (err) {
      if (!db || db.inTransaction !== true) throw err;
    }
  }

  function claimInTx(tx, req) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isPlainObject(req)) return invalid("req");
    const extra = unknownKey(req, ["fleetId", "expectedVersion", "characterId", "systemId", "mode", "standing", "at",
      "unstage", "maxMembers", "quarryClass"]);
    if (extra !== undefined) return invalid(`req: field ${extra}`);
    if (has(req, "unstage") && typeof req.unstage !== "boolean") return invalid("unstage");
    const unstage = req.unstage === true;
    if (has(req, "maxMembers") && (!Number.isSafeInteger(req.maxMembers) || req.maxMembers < 1)) {
      return invalid("maxMembers");
    }
    if (has(req, "quarryClass") && !isText(req.quarryClass, MAX_ID_LENGTH)) return invalid("quarryClass");
    if (!isText(req.fleetId, MAX_ID_LENGTH)) return invalid("fleetId");
    if (!Number.isSafeInteger(req.expectedVersion) || req.expectedVersion < 1) return invalid("expectedVersion");
    if (!isPositiveId(req.characterId)) return invalid("characterId");
    if (!isPositiveId(req.systemId)) return invalid("systemId");
    if (!S.MODES.includes(req.mode)) return invalid("mode");
    if (typeof req.standing !== "number" || !Number.isFinite(req.standing)) return invalid("standing");
    if (!isTime(req.at)) return invalid("at");
    const huntId = S.huntIdOf(req.fleetId, req.expectedVersion);
    if (huntId.length > S.MAX_HUNT_ID_LENGTH) return invalid("huntId too long");
    const payload = { fleetId: req.fleetId, expectedVersion: req.expectedVersion, characterId: req.characterId,
      systemId: req.systemId, mode: req.mode, standing: req.standing, at: req.at, ...(unstage ? { unstage } : {}),
      ...(has(req, "maxMembers") ? { maxMembers: req.maxMembers } : {}),
      ...(has(req, "quarryClass") ? { quarryClass: req.quarryClass } : {}) };
    const result = journal.applyOnce(tx, { key: S.claimKey(huntId), aggregate: { type: S.AGGREGATE, id: huntId },
      eventType: EVENT.CLAIM, payload }, (db) => {
      const got = fleetRepository.getFleet(db, req.fleetId);
      if (!got.ok) return got;
      const fleet = got.fleet;
      if (!fleet) return { ok: false, reason: "FLEET_NOT_FOUND", fleetId: req.fleetId };
      if (fleet.version !== req.expectedVersion) {
        return { ok: false, reason: "VERSION_CONFLICT", expectedVersion: req.expectedVersion,
          actualVersion: fleet.version };
      }
      const staged = unstage && fleet.state === FLEET_STAGED;
      if (fleet.state !== FLEET_IDLE && !staged) return { ok: false, reason: "FLEET_NOT_IDLE", state: fleet.state };
      if (fleet.refitPending === true) return { ok: false, reason: "REFIT_PENDING" };
      if (!staged && fleet.operationId !== null) {
        return { ok: false, reason: "FLEET_BUSY", operationId: fleet.operationId };
      }
      if (fleet.currentSystemId !== req.systemId) {
        return { ok: false, reason: "FLEET_NOT_IN_SYSTEM", systemId: fleet.currentSystemId };
      }
      const s = stmts(db);
      const open = s.openOfFleet.get(req.fleetId);
      if (open) return { ok: false, reason: "FLEET_BUSY", huntId: open.hunt_id };
      const all = membersOf(req.fleetId, fleet.composition);
      const members = !has(req, "maxMembers") ? all : has(req, "quarryClass")
        ? pickMatchedDetachment(all, req.quarryClass, req.maxMembers) : pickDetachment(all, req.maxMembers);
      let lockVersion = req.expectedVersion;
      if (staged) {
        const off = fleetRepository.transition(db, { fleetId: req.fleetId, expectedVersion: lockVersion,
          from: FLEET_STAGED, to: FLEET_IDLE, patch: {} }, S.unstageKey(huntId));
        if (!off.ok) return off;
        if (off.duplicate) return { ok: false, reason: "UNSTAGE_ALREADY_APPLIED", huntId };
        lockVersion = off.version;
      }
      const lock = fleetRepository.transition(db, { fleetId: req.fleetId, expectedVersion: lockVersion,
        from: FLEET_IDLE, to: FLEET_MATERIALIZED, patch: {} }, S.lockKey(huntId));
      if (!lock.ok) return lock;
      if (lock.duplicate) return { ok: false, reason: "LOCK_ALREADY_APPLIED", huntId };
      const seed = deriveSeed(worldSeed, "phunt", huntId);
      s.insert.run(huntId, req.fleetId, toBind(fleet.factionId), toBind(req.systemId), toBind(req.characterId),
        req.mode, "CLAIMED", req.standing, JSON.stringify(members), toBind(seed), toBind(req.at), null, null, null,
        null, toBind(req.at), toBind(INITIAL_VERSION));
      return { ok: true, fleetVersion: lock.version, members, unstaged: staged };
    });
    if (!result.ok) return unwrap(result);
    if (result.duplicate) return { ok: true, duplicate: true, huntId };
    return { ok: true, duplicate: false, huntId, fleetVersion: result.value.fleetVersion, version: INITIAL_VERSION,
      members: result.value.members, ...(has(req, "unstage") ? { unstaged: result.value.unstaged === true } : {}) };
  }

  function markLiveInTx(tx, req) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isPlainObject(req)) return invalid("req");
    const extra = unknownKey(req, ["huntId", "expectedVersion", "at"]);
    if (extra !== undefined) return invalid(`req: field ${extra}`);
    if (!isText(req.huntId, S.MAX_HUNT_ID_LENGTH)) return invalid("huntId");
    if (!Number.isSafeInteger(req.expectedVersion) || req.expectedVersion < 1) return invalid("expectedVersion");
    if (!isTime(req.at)) return invalid("at");
    const result = journal.applyOnce(tx, { key: S.liveKey(req.huntId),
      aggregate: { type: S.AGGREGATE, id: req.huntId }, eventType: EVENT.LIVE,
      payload: { huntId: req.huntId, expectedVersion: req.expectedVersion, at: req.at } }, (db) => {
      const row = stmts(db).byId.get(req.huntId);
      if (!row) return { ok: false, reason: "HUNT_NOT_FOUND", huntId: req.huntId };
      if (row.version !== req.expectedVersion) {
        return { ok: false, reason: "VERSION_CONFLICT", expectedVersion: req.expectedVersion,
          actualVersion: row.version };
      }
      if (row.state !== "CLAIMED") return { ok: false, reason: "NOT_CLAIMED", state: row.state };
      const members = JSON.parse(row.members_json).map((m) => (m.state === "PLANNED" ? { ...m, state: "SPAWNED" } : m));
      return updateWithVersion(db, HUNT_TABLE, req.huntId, row.version, { state: "LIVE",
        members_json: JSON.stringify(members), live_at: toBind(req.at), updated_at: toBind(req.at) });
    });
    if (!result.ok) return unwrap(result);
    if (result.duplicate) return { ok: true, duplicate: true };
    return { ok: true, duplicate: false, version: result.value.version };
  }

  function markDestroyedInTx(tx, req) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isPlainObject(req)) return invalid("req");
    const extra = unknownKey(req, ["huntId", "memberKey"]);
    if (extra !== undefined) return invalid(`req: field ${extra}`);
    if (!isText(req.huntId, S.MAX_HUNT_ID_LENGTH)) return invalid("huntId");
    if (!isText(req.memberKey, MAX_MEMBER_KEY_LENGTH)) return invalid("memberKey");
    const read = stmts(tx).byId.get(req.huntId);
    if (!read) return { ok: false, reason: "HUNT_NOT_FOUND", huntId: req.huntId };
    const known = JSON.parse(read.members_json).find((m) => m.memberKey === req.memberKey);
    if (!known) return { ok: false, reason: "MEMBER_UNKNOWN", memberKey: req.memberKey };
    if (known.state === "DESTROYED") return { ok: true, duplicate: true };
    if (read.state !== "LIVE") return { ok: false, reason: "NOT_LIVE", state: read.state };
    const result = journal.applyOnce(tx, { key: S.lossKey(req.huntId, req.memberKey),
      aggregate: { type: S.AGGREGATE, id: req.huntId }, eventType: EVENT.LOSS,
      payload: { huntId: req.huntId, memberKey: req.memberKey } }, (db) => {
      const row = stmts(db).byId.get(req.huntId);
      if (!row || row.state !== "LIVE") return { ok: false, reason: "NOT_LIVE", state: row ? row.state : null };
      const members = JSON.parse(row.members_json)
        .map((m) => (m.memberKey === req.memberKey ? { ...m, state: "DESTROYED" } : m));
      return updateWithVersion(db, HUNT_TABLE, req.huntId, row.version, { members_json: JSON.stringify(members) });
    });
    if (!result.ok) return unwrap(result);
    return { ok: true, duplicate: result.duplicate === true };
  }

  function endInTx(tx, req) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isPlainObject(req)) return invalid("req");
    const extra = unknownKey(req, ["huntId", "at", "reason"]);
    if (extra !== undefined) return invalid(`req: field ${extra}`);
    if (!isText(req.huntId, S.MAX_HUNT_ID_LENGTH)) return invalid("huntId");
    if (!isTime(req.at)) return invalid("at");
    if (!S.END_REASONS.includes(req.reason)) return invalid("reason");
    const read = stmts(tx).byId.get(req.huntId);
    if (!read) return { ok: false, reason: "HUNT_NOT_FOUND", huntId: req.huntId };
    if (read.state === "ENDED") {
      const got = fleetRepository.getFleet(tx, read.fleet_id);
      const destroyed = got.ok && got.fleet !== null && got.fleet.state === FLEET_DESTROYED;
      return withRepel({ ok: true, duplicate: true, outcome: destroyed ? "DESTROYED" : "RELEASED",
        losses: parseJson(read.losses_json) || [] }, null);
    }
    const result = journal.applyOnce(tx, { key: S.settleKey(req.huntId),
      aggregate: { type: S.AGGREGATE, id: req.huntId }, eventType: EVENT.END,
      payload: { huntId: req.huntId, at: req.at, reason: req.reason } }, (db) => {
      const row = stmts(db).byId.get(req.huntId);
      if (!row || row.state === "ENDED") return { ok: false, reason: "HUNT_NOT_FOUND", huntId: req.huntId };
      const losses = lossesOf(JSON.parse(row.members_json));
      const got = fleetRepository.getFleet(db, row.fleet_id);
      if (!got.ok) return got;
      if (!got.fleet) return { ok: false, reason: "FLEET_NOT_FOUND", fleetId: row.fleet_id };
      if (got.fleet.state !== FLEET_MATERIALIZED) {
        return { ok: false, reason: "FLEET_NOT_MATERIALIZED", state: got.fleet.state };
      }
      let version = got.fleet.version;
      let destroyed = false;
      if (losses.length > 0) {
        const lost = fleetRepository.applyLosses(db, { fleetId: row.fleet_id, expectedVersion: version, losses },
          S.lossesKey(req.huntId));
        if (!lost.ok) return lost;
        if (lost.duplicate) return { ok: false, reason: "LOSSES_ALREADY_APPLIED", huntId: req.huntId };
        version = lost.version;
        destroyed = lost.destroyed === true;
        if (S.HUNT_MODES.includes(row.mode) || req.reason === "RESTART") {
          crewLossInTx(db, row.fleet_id, req.at, S.lossesKey(req.huntId));
        }
      }
      if (!destroyed) {
        const rel = fleetRepository.transition(db, { fleetId: row.fleet_id, expectedVersion: version,
          from: FLEET_MATERIALIZED, to: FLEET_IDLE, patch: {} }, S.releaseKey(req.huntId));
        if (!rel.ok) return rel;
        if (rel.duplicate) return { ok: false, reason: "RELEASE_ALREADY_APPLIED", huntId: req.huntId };
      }
      const w = updateWithVersion(db, HUNT_TABLE, req.huntId, row.version, { state: "ENDED",
        ended_at: toBind(req.at), end_reason: req.reason, losses_json: JSON.stringify(losses),
        updated_at: toBind(req.at) });
      if (!w.ok) return w;
      const outcome = destroyed ? "DESTROYED" : "RELEASED";
      const repelResult = repel === null ? null : callRepel(repel, db, { huntId: req.huntId, fleetId: row.fleet_id,
        factionId: row.faction_id, systemId: row.system_id, characterId: row.character_id,
        members: JSON.parse(row.members_json), reason: req.reason, outcome, at: req.at });
      if (!destroyed && !S.RELEASE_CONTACT_SKIP_REASONS.includes(req.reason)) {
        callReleaseContact(releaseContact, db, { releaseId: req.huntId, fleetId: row.fleet_id,
          systemId: got.fleet.currentSystemId, at: req.at });
      }
      return { ok: true, outcome, losses, repel: repelResult };
    });
    if (!result.ok) return unwrap(result);
    if (result.duplicate) {
      const row = stmts(tx).byId.get(req.huntId);
      return withRepel({ ok: true, duplicate: true, outcome: "RELEASED",
        losses: row ? parseJson(row.losses_json) || [] : [] }, null);
    }
    return withRepel({ ok: true, duplicate: false, outcome: result.value.outcome, losses: result.value.losses },
      result.value.repel);
  }

  function listOpenInTx(tx, opts) {
    if (txMissing(tx)) return TX_REQUIRED;
    const o = isPlainObject(opts) ? opts : {};
    if (!Number.isSafeInteger(o.limit) || o.limit < 1 || o.limit > MAX_LIST_LIMIT) return invalid("limit");
    const after = has(o, "afterHuntId") && o.afterHuntId !== null ? o.afterHuntId : "";
    if (typeof after !== "string") return invalid("afterHuntId");
    const rows = stmts(tx).listOpen.all(after, toBind(o.limit));
    return { ok: true, hunts: rows.map(toHunt),
      nextAfterHuntId: rows.length === o.limit ? rows[rows.length - 1].hunt_id : null };
  }

  function readInTx(tx, huntId) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isText(huntId, S.MAX_HUNT_ID_LENGTH)) return invalid("huntId");
    const row = stmts(tx).byId.get(huntId);
    return { ok: true, hunt: row ? toHunt(row) : null };
  }

  function lastEndedAtInTx(tx, characterId, factionId) {
    if (txMissing(tx) || !isPositiveId(characterId) || !isPositiveId(factionId)) return null;
    const row = stmts(tx).lastEnded.get(toBind(characterId), toBind(factionId));
    return row ? row.ended_at : null;
  }

  function recentEndedInTx(tx, characterId, factionId, since, limit) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isPositiveId(characterId)) return invalid("characterId");
    if (!isPositiveId(factionId)) return invalid("factionId");
    if (!isTime(since)) return invalid("since");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) return invalid("limit");
    const raw = stmts(tx).recentEnded.all(toBind(characterId), toBind(factionId), toBind(since), toBind(limit));
    const rows = [];
    let skipped = 0;
    for (const r of raw) {
      let members = null;
      try {
        members = JSON.parse(r.members_json);
      } catch (_err) {
        members = null;
      }
      if (!Array.isArray(members)) skipped += 1;
      else rows.push({ endReason: r.end_reason, members });
    }
    return { ok: true, rows, skipped };
  }

  function countOpenInTx(tx) {
    if (txMissing(tx)) return TX_REQUIRED;
    return { ok: true, count: stmts(tx).countOpen.get().n };
  }

  return Object.freeze({ claimInTx, markLiveInTx, markDestroyedInTx, endInTx, listOpenInTx, readInTx,
    lastEndedAtInTx, recentEndedInTx, countOpenInTx });
}

module.exports = { createHuntRepository, membersOf, pickDetachment, pickMatchedDetachment, lossesOf, END_ROWS,
  EVENT };
