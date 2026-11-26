"use strict";

const { WORK_CLASS } = require("../schema");
const { MAX_FACTION_TOTALS } = require("../repository");
const { relatedKillsOf } = require("./kills");

const VIEW_ID = "kb-battles";
const OPT_PARAMS = Object.freeze(["faction", "system", "before"]);

function buildKbBattlesView(deps) {
  const { store, repo, pageRows } = deps;

  function admitted() {
    try {
      const governor = deps.getGovernor();
      return !governor || typeof governor.admits !== "function" || governor.admits(WORK_CLASS) !== false;
    } catch (_err) {
      return true;
    }
  }

  function sideOf(row, sides, name) {
    const list = sides.filter((s) => s.side === name);
    return {
      factionId: name === "A" ? row.aFactionId : row.bFactionId,
      factions: list.map((s) => [s.factionId, deps.factionName(s.factionId), s.result]),
      fleets: name === "A" ? row.aFleets : row.bFleets,
      shipsLost: name === "A" ? row.aShipsLost : row.bShipsLost,
      iskLost: name === "A" ? row.aIskLost : row.bIskLost,
    };
  }

  function getData(req) {
    if (!admitted()) return { available: false, reason: "GOVERNOR_HOLD" };
    const params = (req && req.params) || {};
    const filters = { faction: Number.isSafeInteger(params.faction) ? params.faction : null,
      system: Number.isSafeInteger(params.system) ? params.system : null,
      before: Number.isSafeInteger(params.before) ? params.before : null };
    const r = store.transaction("killboard.view.battles", (db) => repo.listBattles(db, { factionId: filters.faction,
      systemId: filters.system, before: filters.before, limit: pageRows + 1 }));
    if (!r.ok) return { available: false, reason: String(r.reason) };
    if (!r.value || r.value.ok !== true) return { available: false, reason: String(r.value && r.value.reason) };
    const page = r.value.rows.slice(0, pageRows);
    const rows = page.map((row) => {
      const sides = r.value.sides.get(row.battleNo) || [];
      const sys = deps.systemOf(row.systemId);
      const a = sideOf(row, sides, "A");
      const b = sideOf(row, sides, "B");
      return { no: row.battleNo, settledAt: row.settledAt, systemId: row.systemId,
        systemName: sys ? sys.name : null, security: sys ? sys.security : null, mode: row.mode,
        environment: row.environment, objective: row.objective, outcome: row.outcome, a, b,
        iskTotal: row.aIskLost + row.bIskLost, unpriced: row.unpricedShips, structureTypeId: row.structureTypeId,
        structureDestroyed: row.structureDestroyed };
    });
    const st = deps.projectorStatus() || {};
    return { available: true, filters, rows,
      nextBefore: r.value.rows.length > pageRows ? page[page.length - 1].battleNo : null,
      status: { rows: st.rows === undefined ? null : st.rows, watermarkAt: st.watermarkAt === undefined ? null
        : st.watermarkAt, lastPassAt: st.lastPassAt === undefined ? null : st.lastPassAt,
      backlogHint: st.backlogHint === true } };
  }

  return Object.freeze({
    title: "Killboard: battles",
    listed: false,
    optParams: OPT_PARAMS,
    cacheKey: () => (admitted() ? deps.cacheVersion() : null),
    getData,
  });
}

const BATTLE_VIEW_ID = "kb-battle";
const FACTION_VIEW_ID = "kb-faction";
const FACTIONS_VIEW_ID = "kb-factions";
const FACTION_OPT_PARAMS = Object.freeze(["before"]);
const SHIP_LISTS = Object.freeze({ escapedShips: "escaped", survivingShips: "surviving" });

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const asId = (v) => (isId(v) ? v : null);

function gateOf(deps) {
  return function admitted() {
    try {
      const governor = deps.getGovernor();
      return !governor || typeof governor.admits !== "function" || governor.admits(WORK_CLASS) !== false;
    } catch (_err) {
      return true;
    }
  };
}

function txValue(r) {
  if (!r.ok) return { refused: { available: false, reason: String(r.reason) } };
  if (!r.value || r.value.ok !== true) return { refused: { available: false, reason: String(r.value && r.value.reason) } };
  return { value: r.value };
}

function fleetsOfSide(input, name) {
  const side = isObject(input) ? input[name === "A" ? "sideA" : "sideB"] : null;
  const out = new Map();
  for (const f of isObject(side) && Array.isArray(side.fleets) ? side.fleets : []) {
    if (!isObject(f) || typeof f.fleetId !== "string" || out.has(f.fleetId)) continue;
    const hulls = new Map();
    for (const c of Array.isArray(f.composition) ? f.composition : []) {
      if (!isObject(c) || typeof c.hullGroup !== "string") continue;
      const h = hullOf(hulls, c.hullGroup, asId(c.typeId));
      if (Number.isSafeInteger(c.count) && c.count > 0) h.start += c.count;
    }
    out.set(f.fleetId, { fleetId: f.fleetId, factionId: asId(f.factionId),
      fleetRole: typeof f.fleetRole === "string" ? f.fleetRole : null, hulls });
  }
  return out;
}

function hullOf(hulls, hullGroup, typeId) {
  const key = `${hullGroup}|${typeId === null ? "" : typeId}`;
  let h = hulls.get(key);
  if (!h) {
    h = { hullGroup, typeId, start: 0, destroyed: 0, escaped: 0, surviving: 0 };
    hulls.set(key, h);
  }
  return h;
}

function factionSet(input, name, fleets) {
  const side = isObject(input) ? input[name === "A" ? "sideA" : "sideB"] : null;
  const out = new Set();
  if (isObject(side) && isId(side.factionId)) out.add(side.factionId);
  for (const f of fleets.values()) if (f.factionId !== null) out.add(f.factionId);
  const g = isObject(input) && isObject(input.garrison) ? input.garrison : null;
  if (g && g.side === name && isId(g.factionId)) out.add(g.factionId);
  return out;
}

function buildKbBattleView(deps) {
  const { store, repo } = deps;
  const admitted = gateOf(deps);

  function readBattle(db, battleNo) {
    const head = repo.getBattleRow(db, battleNo);
    if (!head.ok || head.row === null) return head.ok ? { ok: true, head: null } : head;
    let battleRepo = null;
    try {
      battleRepo = deps.getBattleRepository();
    } catch (_err) {
      battleRepo = null;
    }
    let battle = null;
    let losses = [];
    if (battleRepo && typeof battleRepo.getBattle === "function" && typeof battleRepo.getLosses === "function") {
      let b = null;
      try {
        b = battleRepo.getBattle(db, head.row.battleId);
      } catch (_err) {
        b = null;
      }
      if (!b || b.ok !== true) return { ok: false, reason: "BATTLE_READ_FAILED" };
      if (b.battle) {
        const l = battleRepo.getLosses(db, head.row.battleId);
        if (!l || l.ok !== true) return { ok: false, reason: "LOSSES_READ_FAILED" };
        battle = b.battle;
        losses = l.losses;
      }
    }
    const types = new Set();
    if (head.row.structureTypeId !== null) types.add(head.row.structureTypeId);
    for (const loss of losses) if (isId(loss.typeId)) types.add(loss.typeId);
    if (battle && isObject(battle.input)) {
      for (const name of ["sideA", "sideB"]) {
        const side = battle.input[name];
        for (const f of isObject(side) && Array.isArray(side.fleets) ? side.fleets : []) {
          for (const c of isObject(f) && Array.isArray(f.composition) ? f.composition : []) {
            if (isObject(c) && isId(c.typeId)) types.add(c.typeId);
          }
        }
      }
    }
    const prices = repo.readPrices(db, [...types].sort((a, b) => a - b));
    if (!prices.ok) return prices;
    const related = readRelatedKills(db, head.row);
    if (!related.ok) return related;
    return { ok: true, head, battle, losses, prices: prices.prices, capsuleerKills: related.kills };
  }

  function readRelatedKills(db, row) {
    return relatedKillsOf({ repo, db, systemId: row.systemId, createdAt: row.createdAt, settledAt: row.settledAt,
      slackMs: deps.relatedKillSlackMs, max: deps.relatedKillsMax, systemOf: deps.systemOf });
  }

  function sidesOf(head, battle, losses, prices) {
    const priceOf = (typeId) => (typeId !== null && prices.has(typeId) ? prices.get(typeId) : null);
    const input = battle && isObject(battle.input) ? battle.input : null;
    const fleets = { A: fleetsOfSide(input, "A"), B: fleetsOfSide(input, "B") };
    const factions = { A: factionSet(input, "A", fleets.A), B: factionSet(input, "B", fleets.B) };
    let unattributed = 0;
    if (battle) {
      const result = isObject(battle.result) ? battle.result : {};
      const sideOfFleet = (fleetId) => (fleets.A.has(fleetId) ? "A" : (fleets.B.has(fleetId) ? "B" : null));
      for (const loss of losses) {
        let name = sideOfFleet(loss.fleetId);
        if (name === null && isId(loss.factionId) && factions.A.has(loss.factionId) !== factions.B.has(loss.factionId)) {
          name = factions.A.has(loss.factionId) ? "A" : "B";
        }
        if (name === null || !Number.isSafeInteger(loss.count) || loss.count < 1) {
          unattributed += Number.isSafeInteger(loss.count) && loss.count > 0 ? loss.count : 0;
          continue;
        }
        let f = fleets[name].get(loss.fleetId);
        if (!f) {
          f = { fleetId: String(loss.fleetId), factionId: asId(loss.factionId), fleetRole: null, hulls: new Map() };
          fleets[name].set(f.fleetId, f);
        }
        hullOf(f.hulls, String(loss.hullGroup), asId(loss.typeId)).destroyed += loss.count;
      }
      for (const [list, field] of Object.entries(SHIP_LISTS)) {
        for (const g of Array.isArray(result[list]) ? result[list] : []) {
          if (!isObject(g) || typeof g.hullGroup !== "string" || !Number.isSafeInteger(g.count) || g.count < 1) continue;
          const name = sideOfFleet(g.fleetId);
          if (name === null) continue;
          hullOf(fleets[name].get(g.fleetId).hulls, g.hullGroup, asId(g.typeId))[field] += g.count;
        }
      }
    }
    const out = ["A", "B"].map((name) => {
      const own = head.sides.filter((s) => s.side === name);
      return {
        side: name,
        factions: own.map((s) => ({ id: s.factionId, name: deps.factionName(s.factionId), result: s.result,
          shipsLost: s.shipsLost, iskLost: s.iskLost })),
        fleets: [...fleets[name].values()].map((f) => ({ fleetId: f.fleetId, factionId: f.factionId,
          fleetRole: f.fleetRole, hulls: [...f.hulls.values()].map((h) => {
            const p = priceOf(h.typeId);
            const isk = p && p.isk !== null ? h.destroyed * p.isk : null;
            return { hullGroup: h.hullGroup, typeId: h.typeId, typeName: p ? p.name : null, start: h.start,
              destroyed: h.destroyed, escaped: h.escaped, surviving: h.surviving,
              iskDestroyed: isk !== null && Number.isSafeInteger(isk) ? isk : null };
          }) })),
        shipsLost: name === "A" ? head.row.aShipsLost : head.row.bShipsLost,
        iskLost: name === "A" ? head.row.aIskLost : head.row.bIskLost,
      };
    });
    return { sides: out, unattributed };
  }

  function getData(req) {
    if (!admitted()) return { available: false, reason: "GOVERNOR_HOLD" };
    const no = req && req.param;
    if (!isId(no)) return { available: false, reason: "NOT_FOUND" };
    const t = txValue(store.transaction("killboard.view.battle", (db) => readBattle(db, no)));
    if (t.refused) return t.refused;
    const v = t.value;
    if (v.head === null) return { available: false, reason: "NOT_FOUND" };
    const row = v.head.row;
    const sys = deps.systemOf(row.systemId);
    const { sides, unattributed } = sidesOf(v.head, v.battle, v.losses, v.prices);
    const st = row.structureTypeId === null ? null : v.prices.get(row.structureTypeId);
    return { available: true, no: row.battleNo, battleId: row.battleId, settledAt: row.settledAt,
      createdAt: row.createdAt, systemId: row.systemId, systemName: sys ? sys.name : null,
      security: sys ? sys.security : null, mode: row.mode, environment: row.environment, objective: row.objective,
      outcome: row.outcome, durationSec: row.durationSec,
      structure: row.structureTypeId === null ? null : { typeId: row.structureTypeId, typeName: st ? st.name : null,
        destroyed: row.structureDestroyed === null ? null : row.structureDestroyed === 1 },
      sides, unpriced: row.unpricedShips, unattributed, priceBasis: row.priceBasis, summaryOnly: v.battle === null,
      capsuleerKills: v.capsuleerKills };
  }

  return Object.freeze({
    title: "Killboard: battle",
    listed: false,
    param: "battle",
    cacheKey: () => (admitted() ? deps.cacheVersion() : null),
    getData,
  });
}

function buildKbFactionView(deps) {
  const { store, repo, pageRows } = deps;
  const admitted = gateOf(deps);

  function getData(req) {
    if (!admitted()) return { available: false, reason: "GOVERNOR_HOLD" };
    const params = (req && req.params) || {};
    const factionId = params.faction;
    if (!isId(factionId)) return { available: false, reason: "NOT_FOUND" };
    const before = isId(params.before) ? params.before : null;
    const t = txValue(store.transaction("killboard.view.faction", (db) => {
      const totals = repo.readFactionTotals(db, factionId);
      if (!totals.ok) return totals;
      const list = repo.listBattles(db, { factionId, before, limit: pageRows + 1 });
      if (!list.ok) return list;
      return { ok: true, totals: totals.totals, list };
    }));
    if (t.refused) return t.refused;
    const { totals, list } = t.value;
    const page = list.rows.slice(0, pageRows);
    const battles = page.map((row) => {
      const own = (list.sides.get(row.battleNo) || []).filter((s) => s.factionId === factionId);
      const sys = deps.systemOf(row.systemId);
      return { no: row.battleNo, settledAt: row.settledAt, systemId: row.systemId, systemName: sys ? sys.name : null,
        security: sys ? sys.security : null, mode: row.mode, outcome: row.outcome,
        side: own.length > 0 ? own[0].side : null, result: own.length > 0 ? own[0].result : null,
        shipsLost: own.reduce((n, s) => n + s.shipsLost, 0), iskLost: own.reduce((n, s) => n + s.iskLost, 0),
        iskTotal: row.aIskLost + row.bIskLost };
    });
    return { available: true, factionId, name: deps.factionName(factionId), totals, battles, before,
      nextBefore: list.rows.length > pageRows ? page[page.length - 1].battleNo : null };
  }

  return Object.freeze({
    title: "Killboard: faction",
    listed: false,
    param: "faction",
    optParams: FACTION_OPT_PARAMS,
    cacheKey: () => (admitted() ? deps.cacheVersion() : null),
    getData,
  });
}

function buildKbFactionsView(deps) {
  const { store, repo } = deps;
  const admitted = gateOf(deps);

  function getData() {
    if (!admitted()) return { available: false, reason: "GOVERNOR_HOLD" };
    const t = txValue(store.transaction("killboard.view.factions",
      (db) => repo.listFactionTotals(db, MAX_FACTION_TOTALS)));
    if (t.refused) return t.refused;
    return { available: true,
      factions: t.value.rows.map((r) => ({ ...r, name: deps.factionName(r.factionId) })) };
  }

  return Object.freeze({
    title: "Killboard: factions",
    listed: false,
    cacheKey: () => (admitted() ? deps.cacheVersion() : null),
    getData,
  });
}

module.exports = { buildKbBattlesView, VIEW_ID, OPT_PARAMS, buildKbBattleView, buildKbFactionView, buildKbFactionsView,
  BATTLE_VIEW_ID, FACTION_VIEW_ID, FACTIONS_VIEW_ID };
