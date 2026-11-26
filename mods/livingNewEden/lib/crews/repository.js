"use strict";

const { toBind } = require("../persistence/repository");
const { TABLES } = require("./schema");

const H = TABLES.crews;
const S = TABLES.seats;
const P = TABLES.pilots;

function toHeader(row) {
  return row ? { fleetId: row.fleet_id, factionId: row.faction_id, corporationId: row.corporation_id,
    compositionSig: row.composition_sig, wanted: row.wanted, seated: row.seated, lastSeenAt: row.last_seen_at,
    createdAt: row.created_at, updatedAt: row.updated_at, version: row.version } : null;
}

function toSeat(row) {
  return Object.freeze({ fleetId: row.fleet_id, seat: row.seat, characterId: row.character_id,
    hullGroup: row.hull_group, typeId: row.type_id, joinedAt: row.joined_at });
}

const bindOrNull = (v) => (v === null || v === undefined ? null : toBind(v));

function createCrewRepository() {
  const perDb = new WeakMap();

  function stmts(db) {
    let s = perDb.get(db);
    if (s) return s;
    const HEAD = "fleet_id, faction_id, corporation_id, composition_sig, wanted, seated, last_seen_at, created_at, "
      + "updated_at, version";
    const SEAT = "fleet_id, seat, character_id, hull_group, type_id, joined_at";
    s = {
      header: db.prepare(`SELECT ${HEAD} FROM ${H} WHERE fleet_id = ?`),
      headersIn: db.prepare(`SELECT ${HEAD} FROM ${H} WHERE fleet_id IN (SELECT value FROM json_each(?))
        ORDER BY fleet_id`),
      headersAfter: db.prepare(`SELECT ${HEAD} FROM ${H} WHERE fleet_id > ? ORDER BY fleet_id LIMIT ?`),
      insertHeader: db.prepare(`INSERT INTO ${H} (${HEAD}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`),
      updateHeader: db.prepare(`UPDATE ${H} SET faction_id = ?, corporation_id = ?, composition_sig = ?, wanted = ?,
        seated = ?, last_seen_at = ?, updated_at = ?, version = version + 1 WHERE fleet_id = ? AND version = ?`),
      deleteHeader: db.prepare(`DELETE FROM ${H} WHERE fleet_id = ?`),
      seatsOf: db.prepare(`SELECT ${SEAT} FROM ${S} WHERE fleet_id = ? ORDER BY seat`),
      seatsIn: db.prepare(`SELECT ${SEAT} FROM ${S} WHERE fleet_id IN (SELECT value FROM json_each(?))
        ORDER BY fleet_id, seat`),
      insertSeat: db.prepare(`INSERT INTO ${S} (${SEAT}) VALUES (?, ?, ?, ?, ?, ?)`),
      deleteSeat: db.prepare(`DELETE FROM ${S} WHERE fleet_id = ? AND seat = ?`),
      takenIds: db.prepare(`SELECT character_id FROM ${S}`).pluck(),
      cooling: db.prepare(`SELECT character_id, cooldown_until FROM ${P} WHERE cooldown_until > ?`),
      pilot: db.prepare(`SELECT character_id, losses, cooldown_until FROM ${P} WHERE character_id = ?`),
      pilotsIn: db.prepare(`SELECT character_id, losses FROM ${P}
        WHERE character_id IN (SELECT value FROM json_each(?))`),
      insertPilot: db.prepare(`INSERT INTO ${P} (character_id, losses, cooldown_until, last_fleet_id, updated_at)
        VALUES (?, 1, ?, ?, ?)`),
      updatePilot: db.prepare(`UPDATE ${P} SET losses = losses + 1, cooldown_until = ?, last_fleet_id = ?,
        updated_at = ? WHERE character_id = ?`),
      reclaimFaction: db.prepare(`SELECT ${HEAD} FROM ${H} INDEXED BY world_fleet_crews_reclaim
        WHERE faction_id = ? AND (last_seen_at IS NULL OR last_seen_at < ?) AND seated > 0
        ORDER BY last_seen_at, fleet_id DESC LIMIT ?`),
      reclaimCorp: db.prepare(`SELECT ${HEAD} FROM ${H} INDEXED BY world_fleet_crews_reclaim
        WHERE faction_id = ? AND (last_seen_at IS NULL OR last_seen_at < ?) AND seated > 0 AND corporation_id = ?
        ORDER BY last_seen_at, fleet_id DESC LIMIT ?`),
      totals: db.prepare(`SELECT count(*) AS fleets, coalesce(sum(seated), 0) AS seated FROM ${H}`),
    };
    perDb.set(db, s);
    return s;
  }

  return Object.freeze({
    getHeader: (db, fleetId) => toHeader(stmts(db).header.get(fleetId)),
    headersIn(db, fleetIds) {
      const out = new Map();
      if (fleetIds.length === 0) return out;
      for (const row of stmts(db).headersIn.all(JSON.stringify([...fleetIds]))) out.set(row.fleet_id, toHeader(row));
      return out;
    },
    headersAfter: (db, after, limit) => stmts(db).headersAfter.all(after, toBind(limit)).map(toHeader),
    insertHeader(db, h, at) {
      stmts(db).insertHeader.run(h.fleetId, toBind(h.factionId), bindOrNull(h.corporationId), h.compositionSig,
        toBind(h.wanted), toBind(h.seated), bindOrNull(h.lastSeenAt), toBind(at), toBind(at));
    },
    updateHeader(db, h, expectedVersion, at) {
      return stmts(db).updateHeader.run(toBind(h.factionId), bindOrNull(h.corporationId), h.compositionSig,
        toBind(h.wanted), toBind(h.seated), bindOrNull(h.lastSeenAt), toBind(at), h.fleetId,
        toBind(expectedVersion)).changes === 1;
    },
    deleteHeader: (db, fleetId) => stmts(db).deleteHeader.run(fleetId).changes,
    seatsOf: (db, fleetId) => stmts(db).seatsOf.all(fleetId).map(toSeat),
    seatsIn(db, fleetIds) {
      const out = new Map(fleetIds.map((id) => [id, []]));
      if (fleetIds.length === 0) return out;
      for (const row of stmts(db).seatsIn.all(JSON.stringify([...fleetIds]))) {
        if (!out.has(row.fleet_id)) out.set(row.fleet_id, []);
        out.get(row.fleet_id).push(toSeat(row));
      }
      for (const [id, list] of out) out.set(id, Object.freeze(list));
      return out;
    },
    insertSeat(db, fleetId, seat, at) {
      stmts(db).insertSeat.run(fleetId, toBind(seat.seat), toBind(seat.characterId), seat.hullGroup,
        bindOrNull(seat.typeId), toBind(at));
    },
    deleteSeat: (db, fleetId, seat) => stmts(db).deleteSeat.run(fleetId, toBind(seat)).changes,
    takenIds: (db) => new Set(stmts(db).takenIds.all()),
    cooling(db, at) {
      return new Map(stmts(db).cooling.all(toBind(at)).map((r) => [r.character_id, r.cooldown_until]));
    },
    getPilot(db, characterId) {
      const row = stmts(db).pilot.get(toBind(characterId));
      return row ? { characterId: row.character_id, losses: row.losses, cooldownUntil: row.cooldown_until } : null;
    },
    pilotsIn(db, characterIds) {
      const out = new Map();
      if (characterIds.length === 0) return out;
      for (const row of stmts(db).pilotsIn.all(JSON.stringify([...characterIds]))) {
        out.set(Number(row.character_id), Object.freeze({ losses: Number(row.losses) }));
      }
      return out;
    },
    recordLoss(db, characterId, until, fleetId, at) {
      const s = stmts(db);
      if (s.pilot.get(toBind(characterId))) s.updatePilot.run(toBind(until), fleetId, toBind(at), toBind(characterId));
      else s.insertPilot.run(toBind(characterId), toBind(until), fleetId, toBind(at));
    },
    reclaimCandidates(db, { factionId, corporationId, seenBefore, limit }) {
      const s = stmts(db);
      const rows = corporationId
        ? s.reclaimCorp.all(toBind(factionId), toBind(seenBefore), toBind(corporationId), toBind(limit))
        : s.reclaimFaction.all(toBind(factionId), toBind(seenBefore), toBind(limit));
      return rows.map(toHeader);
    },
    totals(db) {
      const r = stmts(db).totals.get();
      return { fleets: Number(r.fleets), seated: Number(r.seated) };
    },
  });
}

module.exports = { createCrewRepository };
