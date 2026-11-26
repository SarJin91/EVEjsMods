"use strict";

const { WAR_PAIR_ROWS_BOUND } = require("../strategy/truce/schema");
const { WORLD_BOSS_BATTLE_ROWS_BOUND } = require("../worldBosses/schema");

const SETTLEMENT_VERSION = 1;
const SUPPORTED_SETTLEMENT_VERSIONS = Object.freeze([1]);

const ROWS_PER_BATTLE = 6;
const ROWS_PER_FLEET = 6;

const DISPOSITION = Object.freeze({ DESTROYED: "DESTROYED", RETREAT: "RETREAT", STAY: "STAY" });

const RESOLVER_REFUSAL_POLICY = Object.freeze({ RESOLVER_BUDGET: "FAIL" });
const DEFAULT_REFUSAL_POLICY = "QUARANTINE";

const settleKey = (battleId, version) => `battle:${battleId}:settle:v${version}`;
const failKey = (battleId, version) => `battle:${battleId}:fail:v${version}`;
const quarantineKey = (battleId, version) => `battle:${battleId}:quarantine:v${version}`;

const isSupportedVersion = (v) => SUPPORTED_SETTLEMENT_VERSIONS.includes(v);

function classifyResolverRefusal(reason) {
  return Object.prototype.hasOwnProperty.call(RESOLVER_REFUSAL_POLICY, reason)
    ? RESOLVER_REFUSAL_POLICY[reason] : DEFAULT_REFUSAL_POLICY;
}

function settlementRowBound(input) {
  let rows = ROWS_PER_BATTLE;
  for (const side of [input.sideA, input.sideB]) {
    for (const f of side.fleets) rows += ROWS_PER_FLEET + f.composition.length;
  }
  return rows;
}

function settlementRowsLimit(config) {
  const crewsRows = config.crews && config.crews.enabled === true ? config.crews.maxSettleRows : 0;
  const attackLossRows = config.strategy && config.strategy.attackLossMemoryEnabled === true
    ? config.strategy.attackLossSettleRows : 0;
  const warPairRows = config.strategy && config.strategy.truceEnabled === true ? WAR_PAIR_ROWS_BOUND : 0;
  const wb = config.worldBosses;
  const worldBossRows = wb && wb.enabled === true && wb.clash && wb.clash.enabled === true
    ? WORLD_BOSS_BATTLE_ROWS_BOUND : 0;
  return config.persistence.maxRowsPerTransaction - config.battle.settleRowsReserve - crewsRows - attackLossRows
    - warPairRows - worldBossRows;
}

const groupKey = (hullGroup, typeId) => `${hullGroup}|${typeId === null ? 0 : typeId}`;

function byFleet(list) {
  const out = new Map();
  for (const g of list) {
    let f = out.get(g.fleetId);
    if (!f) {
      f = { total: 0, groups: new Map() };
      out.set(g.fleetId, f);
    }
    f.total += g.count;
    const key = groupKey(g.hullGroup, g.typeId);
    const prev = f.groups.get(key);
    if (prev) prev.count += g.count;
    else f.groups.set(key, { hullGroup: g.hullGroup, typeId: g.typeId, count: g.count });
  }
  return out;
}

function dispositionOf(d, e, s) {
  if (s > 0) return DISPOSITION.STAY;
  if (e > 0) return DISPOSITION.RETREAT;
  if (d > 0) return DISPOSITION.DESTROYED;
  return null;
}

const compareGroups = (a, b) => {
  if (a.hullGroup !== b.hullGroup) return a.hullGroup < b.hullGroup ? -1 : 1;
  return (a.typeId || 0) - (b.typeId || 0);
};

function planSettlement(input, result) {
  const destroyed = byFleet(result.destroyedShips);
  const escaped = byFleet(result.escapedShips);
  const surviving = byFleet(result.survivingShips);
  const total = (m, id) => (m.has(id) ? m.get(id).total : 0);
  const fleets = [];
  const lossRows = [];
  const sides = {};
  for (const [name, side] of [["A", input.sideA], ["B", input.sideB]]) {
    const sum = { factionId: side.factionId, destroyed: 0, escaped: 0, surviving: 0 };
    for (const f of side.fleets) {
      const d = total(destroyed, f.fleetId);
      const e = total(escaped, f.fleetId);
      const s = total(surviving, f.fleetId);
      const disposition = dispositionOf(d, e, s);
      if (disposition === null) return { ok: false, reason: "BATTLE_INVARIANT", detail: `fleet ${f.fleetId}: empty` };
      const losses = d > 0 ? [...destroyed.get(f.fleetId).groups.values()].sort(compareGroups) : [];
      for (const l of losses) {
        lossRows.push({ fleetId: f.fleetId, factionId: side.factionId, hullGroup: l.hullGroup,
          typeId: l.typeId === null ? 0 : l.typeId, count: l.count });
      }
      fleets.push({ fleetId: f.fleetId, side: name, factionId: side.factionId, destroyed: d, escaped: e, surviving: s,
        disposition, losses });
      sum.destroyed += d;
      sum.escaped += e;
      sum.surviving += s;
    }
    sides[name] = sum;
  }
  let winnerSide = null;
  if (result.outcome === "A_WIN") winnerSide = "A";
  else if (result.outcome === "B_WIN") winnerSide = "B";
  return { ok: true, fleets, lossRows, sides, winnerSide,
    winnerFactionId: winnerSide === null ? null : sides[winnerSide].factionId, rowBound: settlementRowBound(input) };
}

module.exports = {
  SETTLEMENT_VERSION,
  SUPPORTED_SETTLEMENT_VERSIONS,
  DISPOSITION,
  ROWS_PER_BATTLE,
  ROWS_PER_FLEET,
  settleKey,
  failKey,
  quarantineKey,
  isSupportedVersion,
  classifyResolverRefusal,
  settlementRowBound,
  settlementRowsLimit,
  planSettlement,
};
