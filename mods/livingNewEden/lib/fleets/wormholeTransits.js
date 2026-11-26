"use strict";

const { toBind } = require("../persistence/repository");
const { hasWormholeEdges, crossAt } = require("./travel");

const IN_FLIGHT_SQL = "('TRAVELLING', 'RETREATING')";

const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isText = (v) => typeof v === "string" && v.length >= 1 && v.length <= 64;
const isLimit = (v) => Number.isSafeInteger(v) && v >= 1;
const invalid = (detail) => ({ ok: false, reason: "TRANSITS_INVALID_INPUT", detail });
const txMissing = (tx) => !tx || tx.inTransaction !== true;
const num = (v) => (v === null || v === undefined ? null : Number(v));

function createWormholeTransits() {
  const perDb = new WeakMap();
  function stmts(db) {
    let s = perDb.get(db);
    if (s) return s;
    s = {
      insert: db.prepare(`INSERT INTO world_wormhole_transits (fleet_id, leg_seq, edge_index, pair_key, from_system_id,
        to_system_id, cross_at, expires_at, closed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`),
      ofLeg: db.prepare(`SELECT edge_index, pair_key, cross_at, expires_at, closed_at FROM world_wormhole_transits
        WHERE fleet_id = ? AND leg_seq = ? ORDER BY edge_index`),
      openPairs: db.prepare(`SELECT DISTINCT t.pair_key AS pair_key FROM world_wormhole_transits t
        JOIN virtual_fleets f ON f.fleet_id = t.fleet_id AND f.leg_seq = t.leg_seq
        WHERE t.closed_at IS NULL AND f.state IN ${IN_FLIGHT_SQL} ORDER BY t.pair_key LIMIT ?`),
      openLegs: db.prepare(`SELECT t.fleet_id AS fleet_id, t.leg_seq AS leg_seq, count(*) AS n,
        max(t.cross_at) AS last_cross FROM world_wormhole_transits t
        JOIN virtual_fleets f ON f.fleet_id = t.fleet_id AND f.leg_seq = t.leg_seq
        WHERE t.pair_key = ? AND t.closed_at IS NULL AND f.state IN ${IN_FLIGHT_SQL}
        GROUP BY t.fleet_id, t.leg_seq ORDER BY (max(t.cross_at) > ?) DESC, min(t.cross_at), t.fleet_id, t.leg_seq
        LIMIT ?`),
      firstClosed: db.prepare(`SELECT min(closed_at) AS c FROM world_wormhole_transits WHERE pair_key = ?
        AND closed_at IS NOT NULL`),
      closeLeg: db.prepare(`UPDATE world_wormhole_transits SET closed_at = ? WHERE fleet_id = ? AND leg_seq = ?
        AND pair_key = ? AND closed_at IS NULL`),
      purge: db.prepare(`DELETE FROM world_wormhole_transits WHERE rowid IN (SELECT rowid FROM world_wormhole_transits
        WHERE cross_at < ? ORDER BY cross_at LIMIT ?)`),
    };
    perDb.set(db, s);
    return s;
  }

  function insertForLegInTx(tx, { fleetId, legSeq, leg } = {}) {
    if (txMissing(tx)) return { ok: false, reason: "TX_REQUIRED" };
    if (!isText(fleetId)) return invalid("fleetId");
    if (!Number.isSafeInteger(legSeq) || legSeq < 0) return invalid("legSeq");
    if (!hasWormholeEdges(leg)) return { ok: true, rows: 0 };
    const s = stmts(tx);
    for (const e of leg.wormholeEdges) {
      s.insert.run(fleetId, toBind(legSeq), toBind(e.i), e.pairKey, toBind(leg.systems[e.i]),
        toBind(leg.systems[e.i + 1]), toBind(crossAt(leg, e.i)), toBind(e.expiresAt));
    }
    return { ok: true, rows: leg.wormholeEdges.length };
  }

  function listForLeg(tx, fleetId, legSeq) {
    if (txMissing(tx)) return { ok: false, reason: "TX_REQUIRED" };
    if (!isText(fleetId)) return invalid("fleetId");
    if (!Number.isSafeInteger(legSeq) || legSeq < 0) return invalid("legSeq");
    const transits = stmts(tx).ofLeg.all(fleetId, toBind(legSeq)).map((r) => ({ edgeIndex: num(r.edge_index),
      pairKey: r.pair_key, crossAt: num(r.cross_at), expiresAt: num(r.expires_at), closedAt: num(r.closed_at) }));
    return { ok: true, transits };
  }

  function listOpenPairs(tx, { limit } = {}) {
    if (txMissing(tx)) return { ok: false, reason: "TX_REQUIRED" };
    if (!isLimit(limit)) return invalid("limit");
    return { ok: true, pairKeys: stmts(tx).openPairs.all(toBind(limit)).map((r) => r.pair_key) };
  }

  function listOpenLegs(tx, pairKey, { closedAt, limit } = {}) {
    if (txMissing(tx)) return { ok: false, reason: "TX_REQUIRED" };
    if (typeof pairKey !== "string" || pairKey === "") return invalid("pairKey");
    if (!isTime(closedAt)) return invalid("closedAt");
    if (!isLimit(limit)) return invalid("limit");
    return { ok: true, legs: stmts(tx).openLegs.all(pairKey, toBind(closedAt), toBind(limit)).map((r) => ({
      fleetId: r.fleet_id, legSeq: num(r.leg_seq), rows: num(r.n), affected: num(r.last_cross) > closedAt })) };
  }

  function firstClosedAt(tx, pairKey) {
    if (txMissing(tx)) return { ok: false, reason: "TX_REQUIRED" };
    if (typeof pairKey !== "string" || pairKey === "") return invalid("pairKey");
    return { ok: true, closedAt: num(stmts(tx).firstClosed.get(pairKey).c) };
  }

  function closeLegInTx(tx, pairKey, { fleetId, legSeq, closedAt } = {}) {
    if (txMissing(tx)) return { ok: false, reason: "TX_REQUIRED" };
    if (typeof pairKey !== "string" || pairKey === "") return invalid("pairKey");
    if (!isText(fleetId)) return invalid("fleetId");
    if (!Number.isSafeInteger(legSeq) || legSeq < 0) return invalid("legSeq");
    if (!isTime(closedAt)) return invalid("closedAt");
    return { ok: true, rows: Number(stmts(tx).closeLeg.run(toBind(closedAt), fleetId, toBind(legSeq), pairKey)
      .changes) };
  }

  function purgeInTx(tx, { before, limit } = {}) {
    if (txMissing(tx)) return { ok: false, reason: "TX_REQUIRED" };
    if (!Number.isSafeInteger(before)) return invalid("before");
    if (!isLimit(limit)) return invalid("limit");
    return { ok: true, rows: Number(stmts(tx).purge.run(toBind(before), toBind(limit)).changes) };
  }

  return Object.freeze({ insertForLegInTx, listForLeg, listOpenPairs, listOpenLegs, firstClosedAt, closeLegInTx,
    purgeInTx });
}

module.exports = { createWormholeTransits };
