"use strict";

const COLS = "corp_id, name, ticker, focus, state, home_id, region_id, profile, ceo_pilot_id, members, seq, founded_at, "
  + "next_at, low_since, ended_at, version";
const VALUES = "?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?";

const cache = new WeakMap();

function stmts(tx) {
  let s = cache.get(tx);
  if (s) return s;
  s = {
    all: tx.prepare(`SELECT ${COLS} FROM world_npc_corps ORDER BY corp_id`),
    upsert: tx.prepare(`INSERT INTO world_npc_corps (${COLS}) VALUES (${VALUES}) ON CONFLICT(corp_id) DO UPDATE SET `
      + "name = excluded.name, ticker = excluded.ticker, focus = excluded.focus, state = excluded.state, "
      + "home_id = excluded.home_id, region_id = excluded.region_id, profile = excluded.profile, "
      + "ceo_pilot_id = excluded.ceo_pilot_id, members = excluded.members, seq = excluded.seq, "
      + "founded_at = excluded.founded_at, next_at = excluded.next_at, low_since = excluded.low_since, "
      + "ended_at = excluded.ended_at, version = excluded.version"),
    deleteDissolved: tx.prepare("DELETE FROM world_npc_corps WHERE corp_id = ? AND state = 2 AND ended_at < ?"),
  };
  cache.set(tx, s);
  return s;
}

const int = (v) => Math.floor(Number(v) || 0);

function rowOf(r) {
  return { corpId: int(r.corp_id), name: String(r.name), ticker: String(r.ticker), focus: int(r.focus),
    state: int(r.state), homeId: int(r.home_id), regionId: int(r.region_id), profile: int(r.profile),
    ceoPilotId: int(r.ceo_pilot_id), members: int(r.members), seq: int(r.seq), foundedAt: int(r.founded_at),
    nextAt: int(r.next_at), lowSince: int(r.low_since), endedAt: int(r.ended_at), version: int(r.version) };
}

const paramsOf = (c) => [int(c.corpId), String(c.name), String(c.ticker), int(c.focus), int(c.state), int(c.homeId),
  int(c.regionId), int(c.profile), int(c.ceoPilotId), int(c.members), int(c.seq), int(c.foundedAt), int(c.nextAt),
  int(c.lowSince), int(c.endedAt), int(c.version)];

function loadAllCorps(tx) {
  return stmts(tx).all.all().map(rowOf);
}

function upsertCorpsInTx(tx, rows) {
  const s = stmts(tx).upsert;
  let n = 0;
  for (const c of rows) n += s.run(...paramsOf(c)).changes;
  return n;
}

function deleteDissolvedBeforeInTx(tx, beforeAt, corpIds) {
  const s = stmts(tx).deleteDissolved;
  let n = 0;
  for (const id of corpIds) n += s.run(int(id), int(beforeAt)).changes;
  return n;
}

module.exports = { loadAllCorps, upsertCorpsInTx, deleteDissolvedBeforeInTx };
