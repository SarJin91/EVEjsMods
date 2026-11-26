"use strict";

const COLS = "pilot_id, system_id, prev_id, dest_id, home_id, ship_type_id, archetype, intent, state, seq, since_at, "
  + "due_at, flags, corp_id, group_id, gen, career, xp, wealth";
const VALUES = "?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?";

const cache = new WeakMap();

function stmts(tx) {
  let s = cache.get(tx);
  if (s) return s;
  s = {
    all: tx.prepare(`SELECT ${COLS} FROM world_npc_pilots ORDER BY pilot_id`),
    insertIgnore: tx.prepare(`INSERT OR IGNORE INTO world_npc_pilots (${COLS}) VALUES (${VALUES})`),
    upsert: tx.prepare(`INSERT INTO world_npc_pilots (${COLS}) VALUES (${VALUES}) ON CONFLICT(pilot_id) DO UPDATE SET `
      + "system_id = excluded.system_id, prev_id = excluded.prev_id, dest_id = excluded.dest_id, "
      + "home_id = excluded.home_id, ship_type_id = excluded.ship_type_id, archetype = excluded.archetype, "
      + "intent = excluded.intent, state = excluded.state, seq = excluded.seq, since_at = excluded.since_at, "
      + "due_at = excluded.due_at, flags = excluded.flags, corp_id = excluded.corp_id, group_id = excluded.group_id, "
      + "gen = excluded.gen, career = excluded.career, xp = excluded.xp, wealth = excluded.wealth"),
    deleteAbove: tx.prepare("DELETE FROM world_npc_pilots WHERE pilot_id IN "
      + "(SELECT pilot_id FROM world_npc_pilots WHERE pilot_id > ? ORDER BY pilot_id DESC LIMIT ?)"),
    maxId: tx.prepare("SELECT MAX(pilot_id) AS m FROM world_npc_pilots"),
    meta: tx.prepare("SELECT rules_version, size, seeded_at, flushed_at FROM world_npc_population WHERE id = 1"),
    writeMeta: tx.prepare("INSERT INTO world_npc_population (id, rules_version, size, seeded_at, flushed_at) "
      + "VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET rules_version = excluded.rules_version, "
      + "size = excluded.size, seeded_at = excluded.seeded_at, flushed_at = excluded.flushed_at"),
  };
  cache.set(tx, s);
  return s;
}

const int = (v) => Math.floor(Number(v) || 0);

function rowOf(r) {
  return { pilotId: int(r.pilot_id), systemId: int(r.system_id), prevId: int(r.prev_id), destId: int(r.dest_id),
    homeId: int(r.home_id), shipTypeId: int(r.ship_type_id), archetype: int(r.archetype), intent: int(r.intent),
    state: int(r.state), seq: int(r.seq), sinceAt: int(r.since_at), dueAt: int(r.due_at), flags: int(r.flags),
    corpId: int(r.corp_id), groupId: int(r.group_id), gen: int(r.gen), career: int(r.career), xp: int(r.xp),
    wealth: int(r.wealth) };
}

const paramsOf = (p) => [int(p.pilotId), int(p.systemId), int(p.prevId), int(p.destId), int(p.homeId),
  int(p.shipTypeId), int(p.archetype), int(p.intent), int(p.state), int(p.seq), int(p.sinceAt), int(p.dueAt),
  int(p.flags), int(p.corpId), int(p.groupId), int(p.gen), int(p.career), int(p.xp), int(p.wealth)];

function loadAll(tx) {
  return stmts(tx).all.all().map(rowOf);
}

function insertSliceInTx(tx, rows) {
  const s = stmts(tx).insertIgnore;
  let n = 0;
  for (const p of rows) n += s.run(...paramsOf(p)).changes;
  return n;
}

function upsertSliceInTx(tx, rows) {
  const s = stmts(tx).upsert;
  let n = 0;
  for (const p of rows) n += s.run(...paramsOf(p)).changes;
  return n;
}

function deleteAboveInTx(tx, size, limit) {
  return stmts(tx).deleteAbove.run(int(size), int(limit)).changes;
}

function maxPilotId(tx) {
  const r = stmts(tx).maxId.get();
  return r && r.m !== null && r.m !== undefined ? int(r.m) : 0;
}

function readMeta(tx) {
  const r = stmts(tx).meta.get();
  return r ? { rulesVersion: int(r.rules_version), size: int(r.size), seededAt: int(r.seeded_at),
    flushedAt: int(r.flushed_at) } : null;
}

function writeMetaInTx(tx, meta) {
  return stmts(tx).writeMeta.run(int(meta.rulesVersion), int(meta.size), int(meta.seededAt), int(meta.flushedAt))
    .changes;
}

module.exports = { loadAll, insertSliceInTx, upsertSliceInTx, deleteAboveInTx, maxPilotId, readMeta, writeMetaInTx };
