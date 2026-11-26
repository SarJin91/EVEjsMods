"use strict";

const { WORK_CLASS } = require("../schema");
const { MAX_COVERING_BATTLES } = require("../repository");

const KILLS_VIEW_ID = "kb-kills";
const KILL_VIEW_ID = "kb-kill";
const CHARACTER_VIEW_ID = "kb-character";
const KILLS_OPT_PARAMS = Object.freeze(["system", "before"]);
const CHARACTER_OPT_PARAMS = Object.freeze(["before"]);

const isId = (v) => Number.isSafeInteger(v) && v > 0;

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

function idsOf(kills, withAttackers) {
  const char = new Set();
  const corp = new Set();
  const alliance = new Set();
  const types = new Set();
  const add = (set, v) => {
    if (isId(v)) set.add(v);
  };
  for (const k of kills) {
    add(char, k.victimCharacterId);
    add(char, k.finalCharacterId);
    add(corp, k.victimCorporationId);
    add(corp, k.finalCorporationId);
    add(alliance, k.victimAllianceId);
    add(types, k.shipTypeId);
    if (!withAttackers) continue;
    for (const a of k.attackers) {
      if (!Array.isArray(a)) continue;
      add(char, a[0]);
      add(corp, a[1]);
      add(alliance, a[2]);
      add(types, a[4]);
    }
  }
  const sorted = (s) => [...s].sort((x, y) => x - y);
  return { names: { char: sorted(char), corp: sorted(corp), alliance: sorted(alliance) }, types: sorted(types) };
}

function lookupOf(repo, db, kills, withAttackers) {
  const ids = idsOf(kills, withAttackers);
  const names = repo.readNames(db, ids.names);
  if (!names.ok) return names;
  const prices = repo.readPrices(db, ids.types);
  if (!prices.ok) return prices;
  const nameOf = (kind, id) => (isId(id) ? names.names[kind].get(id) || null : null);
  const typeName = (id) => {
    const p = isId(id) ? prices.prices.get(id) : null;
    return p ? p.name : null;
  };
  return { ok: true, lookup: { nameOf, typeName } };
}

function summaryOf(k, L, systemOf) {
  const sys = k.systemId === null ? null : systemOf(k.systemId);
  return { killId: k.killId, killAt: k.killAt, systemId: k.systemId, systemName: sys ? sys.name : null,
    security: sys ? sys.security : null,
    victim: { characterId: k.victimCharacterId, characterName: L.nameOf("char", k.victimCharacterId),
      corporationId: k.victimCorporationId, corporationName: L.nameOf("corp", k.victimCorporationId),
      allianceId: k.victimAllianceId, allianceName: L.nameOf("alliance", k.victimAllianceId),
      factionId: k.victimFactionId, shipTypeId: k.shipTypeId, shipTypeName: L.typeName(k.shipTypeId) },
    iskLost: k.iskLost,
    final: { characterId: k.finalCharacterId, characterName: L.nameOf("char", k.finalCharacterId),
      corporationId: k.finalCorporationId, corporationName: L.nameOf("corp", k.finalCorporationId) },
    attackerCount: k.attackerCount, cls: k.cls };
}

function relatedKillsOf(q) {
  if (q.max === 0) return { ok: true, kills: [] };
  const list = q.repo.listKillsInWindow(q.db, { systemId: q.systemId, fromMs: Math.max(0, q.createdAt - q.slackMs),
    toMs: q.settledAt + q.slackMs, limit: q.max });
  if (!list.ok) return list;
  if (list.rows.length === 0) return { ok: true, kills: [] };
  const l = lookupOf(q.repo, q.db, list.rows, false);
  if (!l.ok) return l;
  return { ok: true, kills: list.rows.map((k) => {
    const s = summaryOf(k, l.lookup, q.systemOf);
    return { killId: s.killId, killAt: s.killAt, victim: { characterId: s.victim.characterId,
      name: s.victim.characterName, shipTypeId: s.victim.shipTypeId, shipName: s.victim.shipTypeName },
    iskLost: s.iskLost, attackerCount: s.attackerCount };
  }) };
}

function buildKbKillsView(deps) {
  const { store, repo, pageRows } = deps;
  const admitted = gateOf(deps);
  function getData(req) {
    if (!admitted()) return { available: false, reason: "GOVERNOR_HOLD" };
    const params = (req && req.params) || {};
    const filters = { system: isId(params.system) ? params.system : null,
      before: isId(params.before) ? params.before : null };
    const t = txValue(store.transaction("killboard.view.kills", (db) => {
      const list = repo.listKills(db, { systemId: filters.system, before: filters.before, limit: pageRows + 1 });
      if (!list.ok) return list;
      const page = list.rows.slice(0, pageRows);
      const l = lookupOf(repo, db, page, false);
      if (!l.ok) return l;
      return { ok: true, page, more: list.rows.length > pageRows, lookup: l.lookup };
    }));
    if (t.refused) return t.refused;
    const v = t.value;
    return { available: true, filters, rows: v.page.map((k) => summaryOf(k, v.lookup, deps.systemOf)),
      nextBefore: v.more ? v.page[v.page.length - 1].killId : null };
  }
  return Object.freeze({ title: "Killboard: kills", listed: false, optParams: KILLS_OPT_PARAMS,
    cacheKey: () => (admitted() ? deps.cacheVersion() : null), getData });
}

function buildKbKillView(deps) {
  const { store, repo } = deps;
  const admitted = gateOf(deps);
  function getData(req) {
    if (!admitted()) return { available: false, reason: "GOVERNOR_HOLD" };
    const killId = req && req.param;
    if (!isId(killId)) return { available: false, reason: "NOT_FOUND" };
    const t = txValue(store.transaction("killboard.view.kill", (db) => {
      const g = repo.getKill(db, killId);
      if (!g.ok || g.kill === null) return g.ok ? { ok: true, kill: null } : g;
      const l = lookupOf(repo, db, [g.kill], true);
      if (!l.ok) return l;
      let battles = [];
      if (isId(g.kill.systemId)) {
        const b = repo.listBattlesCovering(db, { systemId: g.kill.systemId, atMs: g.kill.killAt,
          slackMs: deps.relatedKillSlackMs, scanRows: deps.relatedScanRows, max: MAX_COVERING_BATTLES });
        if (!b.ok) return b;
        battles = b.battles;
      }
      return { ok: true, kill: g.kill, chars: g.chars, lookup: l.lookup, battles };
    }));
    if (t.refused) return t.refused;
    const v = t.value;
    if (v.kill === null) return { available: false, reason: "NOT_FOUND" };
    const L = v.lookup;
    const k = v.kill;
    const attackers = k.attackers.filter(Array.isArray).map((a) => ({ characterId: a[0],
      characterName: L.nameOf("char", a[0]), corporationId: a[1], corporationName: L.nameOf("corp", a[1]),
      allianceId: a[2], allianceName: L.nameOf("alliance", a[2]), factionId: a[3], shipTypeId: a[4],
      shipTypeName: L.typeName(a[4]), damageDone: a[5], finalBlow: isId(a[0]) && a[0] === k.finalCharacterId }));
    return { available: true, ...summaryOf(k, L, deps.systemOf), attackers, storedAttackers: attackers.length,
      characters: v.chars, battles: v.battles.map((b) => ({ no: b.no, settledAt: b.settledAt, outcome: b.outcome })) };
  }
  return Object.freeze({ title: "Killboard: kill", listed: false, param: "kill",
    cacheKey: () => (admitted() ? deps.cacheVersion() : null), getData });
}

function buildKbCharacterView(deps) {
  const { store, repo, pageRows } = deps;
  const admitted = gateOf(deps);
  function getData(req) {
    if (!admitted()) return { available: false, reason: "GOVERNOR_HOLD" };
    const params = (req && req.params) || {};
    const characterId = params.character;
    if (!isId(characterId)) return { available: false, reason: "NOT_FOUND" };
    const before = isId(params.before) ? params.before : null;
    const t = txValue(store.transaction("killboard.view.character", (db) => {
      const totals = repo.readCharTotals(db, characterId);
      if (!totals.ok) return totals;
      const list = repo.listCharacterKills(db, { characterId, before, limit: pageRows + 1 });
      if (!list.ok) return list;
      const page = list.rows.slice(0, pageRows);
      const l = lookupOf(repo, db, page, false);
      if (!l.ok) return l;
      const own = repo.readNames(db, { char: [characterId] });
      if (!own.ok) return own;
      return { ok: true, totals: totals.totals, page, more: list.rows.length > pageRows, lookup: l.lookup,
        name: own.names.char.get(characterId) || null };
    }));
    if (t.refused) return t.refused;
    const v = t.value;
    return { available: true, characterId, name: v.name, totals: v.totals, before,
      kills: v.page.map((k) => ({ ...summaryOf(k, v.lookup, deps.systemOf), role: k.role })),
      nextBefore: v.more ? v.page[v.page.length - 1].killId : null };
  }
  return Object.freeze({ title: "Killboard: character", listed: false, param: "character",
    optParams: CHARACTER_OPT_PARAMS, cacheKey: () => (admitted() ? deps.cacheVersion() : null), getData });
}

module.exports = { buildKbKillsView, buildKbKillView, buildKbCharacterView, KILLS_VIEW_ID, KILL_VIEW_ID,
  CHARACTER_VIEW_ID, relatedKillsOf };
