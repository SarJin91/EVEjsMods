"use strict";

const { toBind } = require("../persistence/repository");
const S = require("./schema");

const TX_REQUIRED = Object.freeze({ ok: false, reason: "TX_REQUIRED" });
const MAX_IDS = 10000;
const MAX_LIST_LIMIT = 1000;
const MAX_BATTLE_NO = Number.MAX_SAFE_INTEGER;
const MAX_COVERING_BATTLES = 5;
const MAX_SCAN_ROWS = 2000;
const BOOTSTRAP_MAX_READS = 40;

const txMissing = (tx) => !tx || tx.inTransaction !== true;
const bad = (detail) => ({ ok: false, reason: "INVALID_ARGUMENT", detail });
const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isCount = (v) => Number.isSafeInteger(v) && v >= 0;
const isSource = (v) => S.CURSOR_SOURCES.includes(v);
const num = (v) => (v === null || v === undefined ? null : Number(v));

const BATTLE_COLUMNS = "battle_no, battle_id, settled_at, created_at, system_id, mode, environment, objective, outcome, "
  + "a_faction_id, b_faction_id, a_fleets, b_fleets, a_ships_lost, b_ships_lost, a_isk_lost, b_isk_lost, "
  + "unpriced_ships, structure_type_id, structure_destroyed, duration_sec, price_basis, ingested_at";
const B_COLUMNS = BATTLE_COLUMNS.split(", ").map((c) => `b.${c}`).join(", ");

function toRow(r) {
  return Object.freeze({
    battleNo: Number(r.battle_no), battleId: r.battle_id, settledAt: Number(r.settled_at),
    createdAt: Number(r.created_at), systemId: Number(r.system_id), mode: r.mode, environment: r.environment,
    objective: r.objective, outcome: r.outcome === null ? null : r.outcome,
    aFactionId: num(r.a_faction_id), bFactionId: num(r.b_faction_id), aFleets: Number(r.a_fleets),
    bFleets: Number(r.b_fleets), aShipsLost: Number(r.a_ships_lost), bShipsLost: Number(r.b_ships_lost),
    aIskLost: Number(r.a_isk_lost), bIskLost: Number(r.b_isk_lost), unpricedShips: Number(r.unpriced_ships),
    structureTypeId: num(r.structure_type_id), structureDestroyed: num(r.structure_destroyed),
    durationSec: num(r.duration_sec), priceBasis: r.price_basis, ingestedAt: Number(r.ingested_at),
  });
}

function toSide(r) {
  return Object.freeze({ factionId: Number(r.faction_id), side: r.side, fleets: Number(r.fleets),
    shipsLost: Number(r.ships_lost), iskLost: Number(r.isk_lost), result: r.result });
}

const TOTALS_COLUMNS = "faction_id, battles, wins, losses, draws, undecided, ships_lost, ships_killed, isk_lost, "
  + "isk_killed, first_battle_no, last_battle_no, updated_at";
const MAX_FACTION_TOTALS = 100;

const KILL_COLUMNS = "kill_id, kill_at, system_id, victim_character_id, victim_corporation_id, victim_alliance_id, "
  + "victim_faction_id, ship_type_id, isk_lost, final_character_id, final_corporation_id, attacker_count, "
  + "attackers_json, class, ingested_at";
const K_COLUMNS = KILL_COLUMNS.split(", ").map((c) => `k.${c}`).join(", ");
const MAX_KILL_ID = Number.MAX_SAFE_INTEGER;

function toKill(r) {
  let attackers = [];
  try {
    const parsed = JSON.parse(r.attackers_json);
    attackers = Array.isArray(parsed) ? parsed : [];
  } catch (_err) {
    attackers = [];
  }
  return Object.freeze({ killId: Number(r.kill_id), killAt: Number(r.kill_at), systemId: num(r.system_id),
    victimCharacterId: num(r.victim_character_id), victimCorporationId: num(r.victim_corporation_id),
    victimAllianceId: num(r.victim_alliance_id), victimFactionId: num(r.victim_faction_id),
    shipTypeId: num(r.ship_type_id), iskLost: Number(r.isk_lost), finalCharacterId: num(r.final_character_id),
    finalCorporationId: num(r.final_corporation_id), attackerCount: Number(r.attacker_count), attackers,
    cls: r.class, ingestedAt: Number(r.ingested_at), ...(r.role === undefined ? {} : { role: r.role }) });
}

function toCharTotals(r) {
  return Object.freeze({ characterId: Number(r.character_id), kills: Number(r.kills), losses: Number(r.losses),
    iskKilled: Number(r.isk_killed), iskLost: Number(r.isk_lost), firstKillId: Number(r.first_kill_id),
    lastKillId: Number(r.last_kill_id), updatedAt: Number(r.updated_at) });
}

function toTotals(r) {
  return Object.freeze({ factionId: Number(r.faction_id), battles: Number(r.battles), wins: Number(r.wins),
    losses: Number(r.losses), draws: Number(r.draws), undecided: Number(r.undecided),
    shipsLost: Number(r.ships_lost), shipsKilled: Number(r.ships_killed), iskLost: Number(r.isk_lost),
    iskKilled: Number(r.isk_killed), firstBattleNo: Number(r.first_battle_no), lastBattleNo: Number(r.last_battle_no),
    updatedAt: Number(r.updated_at) });
}

function createKillboardRepository() {
  const perDb = new WeakMap();
  function stmts(db) {
    let s = perDb.get(db);
    if (s) return s;
    s = {
      cursorOf: db.prepare(`SELECT at_ms, key_text, key_int, rows, state, version FROM ${S.CURSOR_TABLE}
        WHERE source = ?`),
      upsertCursor: db.prepare(`INSERT INTO ${S.CURSOR_TABLE} (source, at_ms, key_text, key_int, rows, state,
        updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, 1)
        ON CONFLICT (source) DO UPDATE SET at_ms = excluded.at_ms, key_text = excluded.key_text,
        key_int = excluded.key_int, rows = excluded.rows, state = excluded.state, updated_at = excluded.updated_at,
        version = ${S.CURSOR_TABLE}.version + 1`),
      known: db.prepare(`SELECT battle_id FROM ${S.BATTLES_TABLE} WHERE battle_id IN (SELECT value FROM json_each(?))`),
      prices: db.prepare(`SELECT type_id, isk, name FROM ${S.PRICES_TABLE}
        WHERE type_id IN (SELECT value FROM json_each(?))`),
      insertPrice: db.prepare(`INSERT OR IGNORE INTO ${S.PRICES_TABLE} (type_id, isk, name, basis, priced_at)
        VALUES (?, ?, ?, ?, ?)`),
      insertBattle: db.prepare(`INSERT OR IGNORE INTO ${S.BATTLES_TABLE} (battle_id, settled_at, created_at, system_id,
        mode, environment, objective, outcome, a_faction_id, b_faction_id, a_fleets, b_fleets, a_ships_lost,
        b_ships_lost, a_isk_lost, b_isk_lost, unpriced_ships, structure_type_id, structure_destroyed, duration_sec,
        price_basis, ingested_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      insertSide: db.prepare(`INSERT INTO ${S.SIDES_TABLE} (battle_no, faction_id, side, fleets, ships_lost, isk_lost,
        result) VALUES (?, ?, ?, ?, ?, ?, ?)`),
      upsertTotals: db.prepare(`INSERT INTO ${S.TOTALS_TABLE} (faction_id, battles, wins, losses, draws, undecided,
        ships_lost, ships_killed, isk_lost, isk_killed, first_battle_no, last_battle_no, updated_at, version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, min(?, ${S.MAX_ISK_TOTAL}), min(?, ${S.MAX_ISK_TOTAL}), ?, ?, ?, 1)
        ON CONFLICT (faction_id) DO UPDATE SET battles = battles + excluded.battles, wins = wins + excluded.wins,
        losses = losses + excluded.losses, draws = draws + excluded.draws,
        undecided = undecided + excluded.undecided, ships_lost = ships_lost + excluded.ships_lost,
        ships_killed = ships_killed + excluded.ships_killed,
        isk_lost = min(isk_lost + excluded.isk_lost, ${S.MAX_ISK_TOTAL}),
        isk_killed = min(isk_killed + excluded.isk_killed, ${S.MAX_ISK_TOTAL}),
        first_battle_no = min(first_battle_no, excluded.first_battle_no),
        last_battle_no = max(last_battle_no, excluded.last_battle_no), updated_at = excluded.updated_at,
        version = version + 1`),
      oldest: db.prepare(`SELECT battle_no FROM ${S.BATTLES_TABLE} ORDER BY battle_no LIMIT ?`),
      sideCounts: db.prepare(`SELECT battle_no, count(*) AS n FROM ${S.SIDES_TABLE}
        WHERE battle_no IN (SELECT value FROM json_each(?)) GROUP BY battle_no`),
      deleteSides: db.prepare(`DELETE FROM ${S.SIDES_TABLE} WHERE battle_no IN (SELECT value FROM json_each(?))`),
      deleteBattles: db.prepare(`DELETE FROM ${S.BATTLES_TABLE} WHERE battle_no IN (SELECT value FROM json_each(?))`),
      listAll: db.prepare(`SELECT ${BATTLE_COLUMNS} FROM ${S.BATTLES_TABLE} WHERE battle_no < ?
        ORDER BY battle_no DESC LIMIT ?`),
      listSystem: db.prepare(`SELECT ${BATTLE_COLUMNS} FROM ${S.BATTLES_TABLE} WHERE system_id = ? AND battle_no < ?
        ORDER BY battle_no DESC LIMIT ?`),
      listFaction: db.prepare(`SELECT DISTINCT ${B_COLUMNS} FROM ${S.SIDES_TABLE} s
        JOIN ${S.BATTLES_TABLE} b ON b.battle_no = s.battle_no
        WHERE s.faction_id = ? AND s.battle_no < ? ORDER BY b.battle_no DESC LIMIT ?`),
      listFactionSystem: db.prepare(`SELECT DISTINCT ${B_COLUMNS} FROM ${S.SIDES_TABLE} s
        JOIN ${S.BATTLES_TABLE} b ON b.battle_no = s.battle_no
        WHERE s.faction_id = ? AND s.battle_no < ? AND b.system_id = ? ORDER BY b.battle_no DESC LIMIT ?`),
      sidesOf: db.prepare(`SELECT battle_no, faction_id, side, fleets, ships_lost, isk_lost, result FROM ${S.SIDES_TABLE}
        WHERE battle_no IN (SELECT value FROM json_each(?)) ORDER BY battle_no, side, faction_id`),
      battleByNo: db.prepare(`SELECT ${BATTLE_COLUMNS} FROM ${S.BATTLES_TABLE} WHERE battle_no = ?`),
      sidesOfOne: db.prepare(`SELECT battle_no, faction_id, side, fleets, ships_lost, isk_lost, result
        FROM ${S.SIDES_TABLE} WHERE battle_no = ? ORDER BY side, faction_id`),
      totalsOf: db.prepare(`SELECT ${TOTALS_COLUMNS} FROM ${S.TOTALS_TABLE} WHERE faction_id = ?`),
      listTotals: db.prepare(`SELECT ${TOTALS_COLUMNS} FROM ${S.TOTALS_TABLE}
        ORDER BY isk_killed DESC, faction_id LIMIT ?`),
      knownNames: db.prepare(`SELECT id FROM ${S.NAMES_TABLE} WHERE kind = ? AND id IN (SELECT value FROM json_each(?))`),
      namesOf: db.prepare(`SELECT id, name FROM ${S.NAMES_TABLE}
        WHERE kind = ? AND id IN (SELECT value FROM json_each(?))`),
      insertName: db.prepare(`INSERT OR IGNORE INTO ${S.NAMES_TABLE} (kind, id, name, updated_at) VALUES (?, ?, ?, ?)`),
      insertKill: db.prepare(`INSERT OR IGNORE INTO ${S.KILLS_TABLE} (kill_id, kill_at, system_id, victim_character_id,
        victim_corporation_id, victim_alliance_id, victim_faction_id, ship_type_id, isk_lost, final_character_id,
        final_corporation_id, attacker_count, attackers_json, class, ingested_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      insertKillChar: db.prepare(`INSERT OR IGNORE INTO ${S.KILL_CHARS_TABLE} (character_id, kill_id, role)
        VALUES (?, ?, ?)`),
      upsertCharTotals: db.prepare(`INSERT INTO ${S.CHAR_TOTALS_TABLE} (character_id, kills, losses, isk_killed,
        isk_lost, first_kill_id, last_kill_id, updated_at, version)
        VALUES (?, ?, ?, min(?, ${S.MAX_ISK_TOTAL}), min(?, ${S.MAX_ISK_TOTAL}), ?, ?, ?, 1)
        ON CONFLICT (character_id) DO UPDATE SET kills = kills + excluded.kills, losses = losses + excluded.losses,
        isk_killed = min(isk_killed + excluded.isk_killed, ${S.MAX_ISK_TOTAL}),
        isk_lost = min(isk_lost + excluded.isk_lost, ${S.MAX_ISK_TOTAL}),
        first_kill_id = min(first_kill_id, excluded.first_kill_id),
        last_kill_id = max(last_kill_id, excluded.last_kill_id), updated_at = excluded.updated_at,
        version = version + 1`),
      oldestKills: db.prepare(`SELECT kill_id FROM ${S.KILLS_TABLE} ORDER BY kill_id LIMIT ?`),
      killCharCounts: db.prepare(`SELECT kill_id, count(*) AS n FROM ${S.KILL_CHARS_TABLE}
        WHERE kill_id IN (SELECT value FROM json_each(?)) GROUP BY kill_id`),
      deleteKillChars: db.prepare(`DELETE FROM ${S.KILL_CHARS_TABLE} WHERE kill_id IN (SELECT value FROM json_each(?))`),
      deleteKills: db.prepare(`DELETE FROM ${S.KILLS_TABLE} WHERE kill_id IN (SELECT value FROM json_each(?))`),
      wipeKillChars: db.prepare(`DELETE FROM ${S.KILL_CHARS_TABLE} WHERE (character_id, kill_id) IN
        (SELECT character_id, kill_id FROM ${S.KILL_CHARS_TABLE} LIMIT ?)`),
      wipeKills: db.prepare(`DELETE FROM ${S.KILLS_TABLE} WHERE kill_id IN
        (SELECT kill_id FROM ${S.KILLS_TABLE} LIMIT ?)`),
      wipeCharTotals: db.prepare(`DELETE FROM ${S.CHAR_TOTALS_TABLE} WHERE character_id IN
        (SELECT character_id FROM ${S.CHAR_TOTALS_TABLE} LIMIT ?)`),
      deleteCursor: db.prepare(`DELETE FROM ${S.CURSOR_TABLE} WHERE source = ?`),
      listKillsAll: db.prepare(`SELECT ${KILL_COLUMNS} FROM ${S.KILLS_TABLE} WHERE kill_id < ?
        ORDER BY kill_id DESC LIMIT ?`),
      listKillsSystem: db.prepare(`SELECT ${KILL_COLUMNS} FROM ${S.KILLS_TABLE}
        WHERE system_id = ? AND (kill_at, kill_id) < (?, ?) ORDER BY kill_at DESC, kill_id DESC LIMIT ?`),
      killAtOf: db.prepare(`SELECT kill_at FROM ${S.KILLS_TABLE} WHERE kill_id = ?`),
      killById: db.prepare(`SELECT ${KILL_COLUMNS} FROM ${S.KILLS_TABLE} WHERE kill_id = ?`),
      charsOfKill: db.prepare(`SELECT character_id, role FROM ${S.KILL_CHARS_TABLE} WHERE kill_id = ?
        ORDER BY role DESC, character_id`),
      charTotalsOf: db.prepare(`SELECT character_id, kills, losses, isk_killed, isk_lost, first_kill_id, last_kill_id,
        updated_at FROM ${S.CHAR_TOTALS_TABLE} WHERE character_id = ?`),
      listCharKills: db.prepare(`SELECT c.role AS role, ${K_COLUMNS} FROM ${S.KILL_CHARS_TABLE} c
        JOIN ${S.KILLS_TABLE} k ON k.kill_id = c.kill_id
        WHERE c.character_id = ? AND c.kill_id < ? ORDER BY c.kill_id DESC LIMIT ?`),
      killsInWindow: db.prepare(`SELECT ${KILL_COLUMNS} FROM ${S.KILLS_TABLE}
        WHERE system_id = ? AND kill_at BETWEEN ? AND ? ORDER BY kill_at, kill_id LIMIT ?`),
      battlesOfSystem: db.prepare(`SELECT battle_no, created_at, settled_at, outcome FROM ${S.BATTLES_TABLE}
        WHERE system_id = ? ORDER BY battle_no DESC LIMIT ?`),
      battlesAfter: db.prepare(`SELECT battle_no, settled_at, system_id FROM ${S.BATTLES_TABLE} WHERE battle_no > ?
        ORDER BY battle_no LIMIT ?`),
      killsAfter: db.prepare(`SELECT kill_id, kill_at, system_id, class FROM ${S.KILLS_TABLE} WHERE kill_id > ?
        ORDER BY kill_id LIMIT ?`),
      battleAtOrAbove: db.prepare(`SELECT battle_no, settled_at FROM ${S.BATTLES_TABLE} WHERE battle_no >= ?
        ORDER BY battle_no LIMIT 1`),
      killAtOrAbove: db.prepare(`SELECT kill_id, kill_at FROM ${S.KILLS_TABLE} WHERE kill_id >= ?
        ORDER BY kill_id LIMIT 1`),
      maxBattleNo: db.prepare(`SELECT max(battle_no) AS n FROM ${S.BATTLES_TABLE}`),
      maxKillId: db.prepare(`SELECT max(kill_id) AS n FROM ${S.KILLS_TABLE}`),
    };
    perDb.set(db, s);
    return s;
  }

  function readCursor(tx, source) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isSource(source)) return bad("source");
    const r = stmts(tx).cursorOf.get(source);
    return { ok: true, cursor: r ? Object.freeze({ atMs: Number(r.at_ms), keyText: r.key_text,
      keyInt: Number(r.key_int), rows: Number(r.rows), state: r.state, version: Number(r.version) }) : null };
  }

  function writeCursor(tx, source, cursor, nowMs) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isSource(source)) return bad("source");
    if (!cursor || !isTime(cursor.atMs) || typeof cursor.keyText !== "string"
      || cursor.keyText.length > S.MAX_TEXT_KEY_LENGTH || !isCount(cursor.keyInt) || !isCount(cursor.rows)) {
      return bad("cursor");
    }
    const state = cursor.state === undefined ? S.CURSOR_STATE_RUNNING : cursor.state;
    if (!S.CURSOR_STATES.includes(state)) return bad("cursor.state");
    if (!isTime(nowMs)) return bad("nowMs");
    stmts(tx).upsertCursor.run(source, toBind(cursor.atMs), cursor.keyText, toBind(cursor.keyInt),
      toBind(cursor.rows), state, toBind(nowMs));
    return { ok: true };
  }

  function knownBattleIds(tx, battleIds) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!Array.isArray(battleIds) || battleIds.length > MAX_IDS
      || !battleIds.every((id) => typeof id === "string" && id.length >= 1 && id.length <= S.MAX_TEXT_KEY_LENGTH)) {
      return bad("battleIds");
    }
    if (battleIds.length === 0) return { ok: true, known: new Set() };
    const rows = stmts(tx).known.all(JSON.stringify(battleIds));
    return { ok: true, known: new Set(rows.map((r) => r.battle_id)) };
  }

  function readPrices(tx, typeIds) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!Array.isArray(typeIds) || typeIds.length > MAX_IDS || !typeIds.every(isId)) return bad("typeIds");
    const prices = new Map();
    if (typeIds.length === 0) return { ok: true, prices };
    for (const r of stmts(tx).prices.all(JSON.stringify(typeIds))) {
      prices.set(Number(r.type_id), Object.freeze({ isk: num(r.isk), name: r.name === null ? null : r.name }));
    }
    return { ok: true, prices };
  }

  function insertPrices(tx, rows, nowMs) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!Array.isArray(rows) || rows.length > MAX_IDS) return bad("rows");
    if (!isTime(nowMs)) return bad("nowMs");
    for (const r of rows) {
      if (!r || !isId(r.typeId) || !(r.isk === null || isCount(r.isk))
        || !(r.name === null || (typeof r.name === "string" && r.name.length >= 1
          && r.name.length <= S.MAX_NAME_LENGTH))) {
        return bad("rows[]");
      }
    }
    const s = stmts(tx);
    let inserted = 0;
    for (const r of rows) {
      inserted += s.insertPrice.run(toBind(r.typeId), r.isk === null ? null : toBind(r.isk), r.name, S.PRICE_BASIS,
        toBind(nowMs)).changes;
    }
    return { ok: true, inserted };
  }

  function insertBattle(tx, plan, nowMs) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!plan || plan.ok !== true || !plan.row || !Array.isArray(plan.sides) || !Array.isArray(plan.deltas)) {
      return bad("plan");
    }
    if (!isTime(nowMs)) return bad("nowMs");
    const s = stmts(tx);
    const b = plan.row;
    const opt = (v) => (v === null || v === undefined ? null : toBind(v));
    const info = s.insertBattle.run(b.battleId, toBind(b.settledAt), toBind(b.createdAt), toBind(b.systemId), b.mode,
      b.environment, b.objective, b.outcome, opt(b.aFactionId), opt(b.bFactionId), toBind(b.aFleets),
      toBind(b.bFleets), toBind(b.aShipsLost), toBind(b.bShipsLost), toBind(b.aIskLost), toBind(b.bIskLost),
      toBind(b.unpricedShips), opt(b.structureTypeId), opt(b.structureDestroyed), opt(b.durationSec), b.priceBasis,
      toBind(nowMs));
    if (info.changes !== 1) return { ok: true, inserted: false, battleNo: null };
    const battleNo = Number(info.lastInsertRowid);
    for (const side of plan.sides) {
      s.insertSide.run(toBind(battleNo), toBind(side.factionId), side.side, toBind(side.fleets),
        toBind(side.shipsLost), toBind(side.iskLost), side.result);
    }
    for (const d of plan.deltas) {
      s.upsertTotals.run(toBind(d.factionId), toBind(d.battles), toBind(d.wins), toBind(d.losses), toBind(d.draws),
        toBind(d.undecided), toBind(d.shipsLost), toBind(d.shipsKilled), toBind(d.iskLost), toBind(d.iskKilled),
        toBind(battleNo), toBind(battleNo), toBind(nowMs));
    }
    return { ok: true, inserted: true, battleNo };
  }

  function pruneBattles(tx, keepRows, batch, maxRows) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isCount(keepRows)) return bad("keepRows");
    if (!isId(batch)) return bad("batch");
    if (!Number.isSafeInteger(maxRows) || maxRows < 3) return bad("maxRows");
    const s = stmts(tx);
    const cur = s.cursorOf.get("battles");
    const rows = cur ? Number(cur.rows) : 0;
    const excess = Math.min(rows - keepRows, batch, MAX_LIST_LIMIT);
    if (excess <= 0) return { ok: true, deleted: 0 };
    const nos = s.oldest.all(toBind(excess)).map((r) => Number(r.battle_no));
    if (nos.length === 0) return { ok: true, deleted: 0 };
    const sideCount = new Map(s.sideCounts.all(JSON.stringify(nos)).map((r) => [Number(r.battle_no), Number(r.n)]));
    const take = [];
    let used = 0;
    for (const no of nos) {
      const n = 1 + (sideCount.get(no) || 0);
      if (used + n > maxRows - 1) break;
      used += n;
      take.push(no);
    }
    if (take.length === 0) return { ok: true, deleted: 0 };
    const json = JSON.stringify(take);
    s.deleteSides.run(json);
    const deleted = s.deleteBattles.run(json).changes;
    return { ok: true, deleted };
  }

  function listBattles(tx, opts) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!opts || typeof opts !== "object") return bad("opts");
    const { factionId = null, systemId = null, before = null, limit } = opts;
    if (factionId !== null && !isId(factionId)) return bad("opts.factionId");
    if (systemId !== null && !isId(systemId)) return bad("opts.systemId");
    if (before !== null && !isId(before)) return bad("opts.before");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) return bad("opts.limit");
    const s = stmts(tx);
    const upper = toBind(before === null ? MAX_BATTLE_NO : before);
    const lim = toBind(limit);
    let raw;
    if (factionId !== null && systemId !== null) raw = s.listFactionSystem.all(toBind(factionId), upper, toBind(systemId), lim);
    else if (factionId !== null) raw = s.listFaction.all(toBind(factionId), upper, lim);
    else if (systemId !== null) raw = s.listSystem.all(toBind(systemId), upper, lim);
    else raw = s.listAll.all(upper, lim);
    const rows = raw.map(toRow);
    const sides = new Map(rows.map((r) => [r.battleNo, []]));
    if (rows.length > 0) {
      for (const r of s.sidesOf.all(JSON.stringify(rows.map((x) => x.battleNo)))) {
        const list = sides.get(Number(r.battle_no));
        if (list) list.push(toSide(r));
      }
    }
    return { ok: true, rows, sides };
  }

  function getBattleRow(tx, battleNo) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(battleNo)) return bad("battleNo");
    const s = stmts(tx);
    const r = s.battleByNo.get(toBind(battleNo));
    if (!r) return { ok: true, row: null, sides: [] };
    return { ok: true, row: toRow(r), sides: s.sidesOfOne.all(toBind(battleNo)).map(toSide) };
  }

  function readFactionTotals(tx, factionId) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(factionId)) return bad("factionId");
    const r = stmts(tx).totalsOf.get(toBind(factionId));
    return { ok: true, totals: r ? toTotals(r) : null };
  }

  function listFactionTotals(tx, limit) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_FACTION_TOTALS) return bad("limit");
    return { ok: true, rows: stmts(tx).listTotals.all(toBind(limit)).map(toTotals) };
  }

  const isKind = (k) => S.NAME_KINDS.includes(k);
  const isIdList = (ids) => Array.isArray(ids) && ids.length <= MAX_IDS && ids.every(isId);

  function knownNames(tx, kind, ids) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isKind(kind)) return bad("kind");
    if (!isIdList(ids)) return bad("ids");
    if (ids.length === 0) return { ok: true, known: new Set() };
    return { ok: true, known: new Set(stmts(tx).knownNames.all(kind, JSON.stringify(ids)).map((r) => Number(r.id))) };
  }

  function readNames(tx, byKind) {
    if (txMissing(tx)) return TX_REQUIRED;
    const spec = byKind && typeof byKind === "object" ? byKind : {};
    const names = {};
    for (const kind of S.NAME_KINDS) {
      const ids = spec[kind] === undefined ? [] : spec[kind];
      if (!isIdList(ids)) return bad(kind);
      names[kind] = new Map(ids.length === 0 ? [] : stmts(tx).namesOf.all(kind, JSON.stringify(ids))
        .map((r) => [Number(r.id), r.name]));
    }
    return { ok: true, names };
  }

  function insertNames(tx, rows, nowMs) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!Array.isArray(rows) || rows.length > MAX_IDS) return bad("rows");
    if (!isTime(nowMs)) return bad("nowMs");
    for (const r of rows) {
      if (!r || !isKind(r.kind) || !isId(r.id) || typeof r.name !== "string" || r.name.length < 1
        || r.name.length > S.MAX_NAME_LENGTH) {
        return bad("rows[]");
      }
    }
    const s = stmts(tx);
    let inserted = 0;
    for (const r of rows) inserted += s.insertName.run(r.kind, toBind(r.id), r.name, toBind(nowMs)).changes;
    return { ok: true, inserted };
  }

  function insertKill(tx, plan, nowMs) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!plan || plan.ok !== true || !plan.row || !Array.isArray(plan.chars) || !Array.isArray(plan.deltas)) {
      return bad("plan");
    }
    if (!isTime(nowMs)) return bad("nowMs");
    const s = stmts(tx);
    const k = plan.row;
    const opt = (v) => (v === null || v === undefined ? null : toBind(v));
    const info = s.insertKill.run(toBind(k.killId), toBind(k.killAt), opt(k.systemId), opt(k.victimCharacterId),
      opt(k.victimCorporationId), opt(k.victimAllianceId), opt(k.victimFactionId), opt(k.shipTypeId),
      toBind(k.iskLost), opt(k.finalCharacterId), opt(k.finalCorporationId), toBind(k.attackerCount),
      k.attackersJson, k.cls, toBind(nowMs));
    if (info.changes !== 1) return { ok: true, inserted: false };
    for (const c of plan.chars) s.insertKillChar.run(toBind(c.characterId), toBind(k.killId), c.role);
    for (const d of plan.deltas) {
      s.upsertCharTotals.run(toBind(d.characterId), toBind(d.kills), toBind(d.losses), toBind(d.iskKilled),
        toBind(d.iskLost), toBind(k.killId), toBind(k.killId), toBind(nowMs));
    }
    return { ok: true, inserted: true };
  }

  function pruneKills(tx, keepRows, batch, maxRows) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isCount(keepRows)) return bad("keepRows");
    if (!isId(batch)) return bad("batch");
    if (!Number.isSafeInteger(maxRows) || maxRows < 3) return bad("maxRows");
    const s = stmts(tx);
    const cur = s.cursorOf.get("kills");
    const rows = cur ? Number(cur.rows) : 0;
    const excess = Math.min(rows - keepRows, batch, MAX_LIST_LIMIT);
    if (excess <= 0) return { ok: true, deleted: 0 };
    const ids = s.oldestKills.all(toBind(excess)).map((r) => Number(r.kill_id));
    if (ids.length === 0) return { ok: true, deleted: 0 };
    const charCount = new Map(s.killCharCounts.all(JSON.stringify(ids)).map((r) => [Number(r.kill_id), Number(r.n)]));
    const take = [];
    let used = 0;
    for (const id of ids) {
      const n = 1 + (charCount.get(id) || 0);
      if (used + n > maxRows - 1) break;
      used += n;
      take.push(id);
    }
    if (take.length === 0) return { ok: true, deleted: 0 };
    const json = JSON.stringify(take);
    s.deleteKillChars.run(json);
    return { ok: true, deleted: s.deleteKills.run(json).changes };
  }

  function wipeKillsStep(tx, maxRows) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(maxRows)) return bad("maxRows");
    const s = stmts(tx);
    let room = maxRows;
    let deleted = 0;
    for (const st of [s.wipeKillChars, s.wipeKills, s.wipeCharTotals]) {
      if (room <= 0) return { ok: true, deleted, done: false };
      const n = st.run(toBind(room)).changes;
      deleted += n;
      room -= n;
      if (room <= 0) return { ok: true, deleted, done: false };
    }
    return { ok: true, deleted, done: true };
  }

  function deleteCursor(tx, source) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isSource(source)) return bad("source");
    stmts(tx).deleteCursor.run(source);
    return { ok: true };
  }

  function listKills(tx, opts) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!opts || typeof opts !== "object") return bad("opts");
    const { systemId = null, before = null, limit } = opts;
    if (systemId !== null && !isId(systemId)) return bad("opts.systemId");
    if (before !== null && !isId(before)) return bad("opts.before");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) return bad("opts.limit");
    const s = stmts(tx);
    const upper = toBind(before === null ? MAX_KILL_ID : before);
    if (systemId === null) return { ok: true, rows: s.listKillsAll.all(upper, toBind(limit)).map(toKill) };
    const at = before === null ? null : s.killAtOf.get(upper);
    if (before !== null && !at) return { ok: true, rows: [] };
    const atBound = at ? at.kill_at : toBind(MAX_KILL_ID);
    return { ok: true, rows: s.listKillsSystem.all(toBind(systemId), atBound, upper, toBind(limit)).map(toKill) };
  }

  function getKill(tx, killId) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(killId)) return bad("killId");
    const s = stmts(tx);
    const r = s.killById.get(toBind(killId));
    if (!r) return { ok: true, kill: null, chars: [] };
    return { ok: true, kill: toKill(r), chars: s.charsOfKill.all(toBind(killId)).map((c) => Object.freeze({
      characterId: Number(c.character_id), role: c.role })) };
  }

  function readCharTotals(tx, characterId) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(characterId)) return bad("characterId");
    const r = stmts(tx).charTotalsOf.get(toBind(characterId));
    return { ok: true, totals: r ? toCharTotals(r) : null };
  }

  function listCharacterKills(tx, opts) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!opts || typeof opts !== "object") return bad("opts");
    const { characterId, before = null, limit } = opts;
    if (!isId(characterId)) return bad("opts.characterId");
    if (before !== null && !isId(before)) return bad("opts.before");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) return bad("opts.limit");
    const rows = stmts(tx).listCharKills.all(toBind(characterId), toBind(before === null ? MAX_KILL_ID : before),
      toBind(limit));
    return { ok: true, rows: rows.map(toKill) };
  }

  function listKillsInWindow(tx, q) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!q || typeof q !== "object") return bad("q");
    if (!isId(q.systemId)) return bad("q.systemId");
    if (!isTime(q.fromMs) || !isTime(q.toMs)) return bad("q.window");
    if (!Number.isSafeInteger(q.limit) || q.limit < 0 || q.limit > MAX_LIST_LIMIT) return bad("q.limit");
    if (q.limit === 0 || q.toMs < q.fromMs) return { ok: true, rows: [] };
    return { ok: true, rows: stmts(tx).killsInWindow.all(toBind(q.systemId), toBind(q.fromMs), toBind(q.toMs),
      toBind(q.limit)).map(toKill) };
  }

  function listBattlesCovering(tx, q) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!q || typeof q !== "object") return bad("q");
    if (!isId(q.systemId)) return bad("q.systemId");
    if (!isTime(q.atMs)) return bad("q.atMs");
    if (!isCount(q.slackMs)) return bad("q.slackMs");
    if (!isId(q.scanRows) || q.scanRows > MAX_SCAN_ROWS) return bad("q.scanRows");
    if (!Number.isSafeInteger(q.max) || q.max < 0 || q.max > MAX_COVERING_BATTLES) return bad("q.max");
    const battles = [];
    if (q.max === 0) return { ok: true, battles };
    for (const r of stmts(tx).battlesOfSystem.all(toBind(q.systemId), toBind(q.scanRows))) {
      if (Number(r.created_at) - q.slackMs > q.atMs || q.atMs > Number(r.settled_at) + q.slackMs) continue;
      battles.push(Object.freeze({ no: Number(r.battle_no), settledAt: Number(r.settled_at),
        outcome: r.outcome === null ? null : r.outcome }));
      if (battles.length >= q.max) break;
    }
    return { ok: true, battles };
  }

  function listBattlesAfter(tx, battleNo, limit) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isCount(battleNo)) return bad("battleNo");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) return bad("limit");
    const s = stmts(tx);
    const rows = s.battlesAfter.all(toBind(battleNo), toBind(limit));
    if (rows.length === 0) return { ok: true, battles: [] };
    const sides = new Map(rows.map((r) => [Number(r.battle_no), []]));
    for (const r of s.sidesOf.all(JSON.stringify([...sides.keys()]))) {
      const list = sides.get(Number(r.battle_no));
      if (list) list.push(Object.freeze({ factionId: Number(r.faction_id), side: r.side, result: r.result }));
    }
    return { ok: true, battles: rows.map((r) => Object.freeze({ battleNo: Number(r.battle_no),
      settledAt: Number(r.settled_at), systemId: Number(r.system_id),
      sides: Object.freeze(sides.get(Number(r.battle_no))) })) };
  }

  function listPveKillsAfter(tx, killId, limit) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isCount(killId)) return bad("killId");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) return bad("limit");
    const rows = stmts(tx).killsAfter.all(toBind(killId), toBind(limit));
    const kills = rows.filter((r) => r.class === "PVE").map((r) => Object.freeze({ killId: Number(r.kill_id),
      killAt: Number(r.kill_at), systemId: num(r.system_id) }));
    return { ok: true, kills, scannedTo: rows.length > 0 ? Number(rows[rows.length - 1].kill_id) : null };
  }

  function firstKeyAtOrAfter(stmt, keyCol, atCol, maxStmt, atMs) {
    const max = Number(maxStmt.get().n || 0);
    let reads = 0;
    const rowAt = (key) => {
      reads += 1;
      const r = stmt.get(toBind(key));
      return r ? { key: Number(r[keyCol]), at: Number(r[atCol]) } : null;
    };
    if (max === 0) return { ok: true, key: null, reads };
    const last = rowAt(max);
    if (!last || last.at < atMs) return { ok: true, key: null, reads };
    let lo = 1;
    let hi = last.key;
    let best = last.key;
    while (lo < hi && reads < BOOTSTRAP_MAX_READS) {
      const mid = Math.floor((lo + hi) / 2);
      const r = rowAt(mid);
      if (!r || r.key >= hi) {
        hi = mid;
      } else if (r.at >= atMs) {
        best = r.key;
        hi = mid;
      } else {
        lo = r.key + 1;
      }
    }
    return { ok: true, key: best, reads };
  }

  function firstBattleNoAtOrAfter(tx, atMs) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isTime(atMs)) return bad("atMs");
    const s = stmts(tx);
    return firstKeyAtOrAfter(s.battleAtOrAbove, "battle_no", "settled_at", s.maxBattleNo, atMs);
  }

  function firstKillIdAtOrAfter(tx, atMs) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isTime(atMs)) return bad("atMs");
    const s = stmts(tx);
    return firstKeyAtOrAfter(s.killAtOrAbove, "kill_id", "kill_at", s.maxKillId, atMs);
  }

  function maxBattleNo(tx) {
    if (txMissing(tx)) return TX_REQUIRED;
    return { ok: true, max: Number(stmts(tx).maxBattleNo.get().n || 0) };
  }

  function maxKillId(tx) {
    if (txMissing(tx)) return TX_REQUIRED;
    return { ok: true, max: Number(stmts(tx).maxKillId.get().n || 0) };
  }

  return Object.freeze({ readCursor, writeCursor, knownBattleIds, readPrices, insertPrices, insertBattle, pruneBattles,
    listBattles, getBattleRow, readFactionTotals, listFactionTotals, knownNames, readNames, insertNames, insertKill,
    pruneKills, wipeKillsStep, deleteCursor, listKills, getKill, readCharTotals, listCharacterKills, listKillsInWindow,
    listBattlesCovering, listBattlesAfter, listPveKillsAfter, firstBattleNoAtOrAfter, firstKillIdAtOrAfter, maxBattleNo,
    maxKillId });
}

module.exports = { createKillboardRepository, MAX_LIST_LIMIT, MAX_FACTION_TOTALS, MAX_COVERING_BATTLES };
