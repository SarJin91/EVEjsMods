"use strict";

const CALDARI = 500001;
const GURISTAS = 500010;

function factions() {
  return { available: true, state: "ready", reason: null, seed: 1, registryVersion: 7, factions: [
    { factionId: CALDARI, name: "Caldari State", kind: "empire", corporation: { id: 1000035, name: "Caldari Navy" },
      status: "ACTIVE", base: "New Caldari", resources: 24281, reserves: 1000, frontLimit: 2,
      doctrine: "empire-border-defense-v2", campaigns: [], startStations: { npc: 5, upwell: 0 }, inRegistry: true,
      fronts: { count: 0, limit: 2 }, borderSystems: 347,
      upkeep: { paidUntil: 1793350800000, unpaidPeriods: 0, totals: { income: 11511, upkeep: 3749, unpaid: 0,
        tradeFunded: 2251 }, perPeriod: { income: 71, cost: 49, net: 22, reserveIncome: 10, tradeUnits: 0,
        offensiveAllowed: true, round: 1992613 } },
      treasury: { mode: "NORMAL", modeChangedAt: null, kind: "empire", balanceIsk: 4990112550000,
        initialIsk: 5000000000000, totals: { income: 0, fleetUpkeep: 0, productionFees: 0, losses: 0, tradeOut: 9887450000,
          tradeIn: 0 },
        today: { day: 20756, income: 0, fleetUpkeep: 0, productionFees: 0, losses: 0, lossValue: 0, shipsLost: 0,
          tradeOut: 9887450000, tradeIn: 0, unpaid: 0, balanceEnd: 4990112550000, updatedAt: 1793351685082 },
        yesterday: null, avg7dNetIsk: null,
        forecast: { trend: "FLAT", daysToZero: null, daysToAusterity: null, austerityEnterIsk: 500000000000,
          austerityExitIsk: 1000000000000 } },
      lastReview: { round: 1992613, outcome: "REVIEWED", target: 30000863, notes: ["INDUSTRY_JOB_LIMIT", "NO_HULLS:logistics"] } },
    { factionId: GURISTAS, name: "Guristas Pirates", kind: "pirate", corporation: { id: 1000127, name: "Guristas" },
      status: "ACTIVE", base: "6NJ8-V", resources: 29049, reserves: 1000, frontLimit: 2, doctrine: "pirate-territorial-v2",
      campaigns: [], startStations: { npc: 5, upwell: 0 }, inRegistry: true, fronts: null, borderSystems: null,
      upkeep: { paidUntil: 1793350800000, unpaidPeriods: 0, totals: {}, perPeriod: null }, treasury: null,
      lastReview: null },
  ], campaigns: [] };
}

function activity() {
  return { available: true, generatedAt: 1793352585082, intervalMs: 900000, staleAfterMs: 1800000, summary: {},
    factions: [
      { factionId: CALDARI, name: "Caldari State",
        verdict: { code: "BLOCKED", label: "BLOCKED", sentence: "Blocked: no full set of hulls." },
        notes: [
          { code: "INDUSTRY_JOB_LIMIT", arg: null, category: "oczekiwane", text: "faction industry job limit" },
          { code: "TRADE_STOCKPILE_OFFER", arg: "type:35@npc-60000946", category: "informacja",
            text: "buy offer for the station stockpile" },
          { code: "NO_HULLS", arg: "logistics", category: "blokada",
            text: "no full set of hulls at any station — mobilization impossible" },
          { code: "INSUFFICIENT_FORCE", arg: null, category: "oczekiwane", text: "forces too weak to attack the target" },
        ],
        now: { total: 17, sections: {} },
        plans: { target: { systemId: 30000863, name: "C2X-M5" }, outcome: "REVIEWED", round: 1992613,
          decision: [{ type: "TRADE_OFFER", label: "TRADE_OFFER", count: 4 },
            { type: "MINE_DISPATCH", label: "miner dispatch", count: 3 }],
          refused: 0, lastReviewAt: 1793352585082, sinceLastReview: "4 min", nextReviewAt: 1793353485082,
          untilNextReview: "11 min" } },
      { factionId: GURISTAS, name: "Guristas Pirates",
        verdict: { code: "WORKING", label: "WORKING", sentence: "Working." }, notes: [], now: { total: 3, sections: {} },
        plans: { target: null, outcome: "REVIEWED", round: 1992613, decision: [], lastReviewAt: 1793352585082,
          nextReviewAt: 1793353485082 } },
    ] };
}

function factionFleets() {
  return { available: true, generatedAt: 1793352069212, states: ["IDLE", "STAGED"], factions: [
    { factionId: CALDARI, fleets: 26, ships: 104, byState: { IDLE: 18, STAGED: 8 },
      hulls: [["cruiser", 40], ["frigate", 30]],
      list: [{ fleetId: "fleet_1", role: "patrol", state: "STAGED", systemId: 30000200, systemName: "Akkio",
        targetSystemId: null, targetName: null, ships: 6, hulls: [["cruiser", 4], ["logistics", 2]],
        operationId: null, supply: 100, refitPending: false }],
      truncated: true, operations: { list: [], truncated: false } },
    { factionId: GURISTAS, fleets: 2, ships: 8, byState: { IDLE: 2 }, hulls: [["frigate", 8]], list: [],
      truncated: true, operations: { list: [], truncated: false } },
  ], factionsTruncated: 0 };
}

function trade() {
  const offer = { offerId: "tp_1", side: "buy", stationId: "npc-60000826", itemKey: "type:35", typeId: 35,
    quantity: 1226420, unitPriceIsk: 15, iskTotal: 19530738, state: "OPEN" };
  return { available: true, state: "ready", counters: {}, factions: [
    { faction: "Caldari State", availableIsk: 9673139075, reservedIsk: 326860925, capIsk: 50000000000,
      headroomIsk: 40000000000, fundedUnitsTotal: 2251, fundedTotal: 10000000000, spentTotal: 0,
      releasedTotal: 39997184, lastFundedAt: 1793351685082, offers: [offer, { ...offer, offerId: "tp_2" }] },
    { faction: GURISTAS, availableIsk: 1000, reservedIsk: 0, capIsk: 50000000000, headroomIsk: 49999999000,
      fundedUnitsTotal: 0, fundedTotal: 1000, spentTotal: 0, releasedTotal: 0, lastFundedAt: null, offers: [] },
    { faction: "Twin Cartel", availableIsk: 5, reservedIsk: 0, capIsk: 1, headroomIsk: 0, fundedUnitsTotal: 0,
      fundedTotal: 0, spentTotal: 0, releasedTotal: 0, lastFundedAt: null, offers: [] },
  ], contracts: { open: 9, byFaction: [{ faction: "Caldari State", open: 9, tiers: [1, 7, 1], cap: 25 }] } };
}

function production() {
  const station = (id, system, lines, jobs) => ({ station: id, kind: "npc", system, lines, jobs });
  return { available: true, state: "ready", recipesVersion: 3, counters: {}, factions: [
    { faction: "Caldari State", stations: [
      station("npc-60000826", 30001447, "2/4", [
        { hullGroup: "mining_barge", runs: 1, dueAt: 1793358285082, waitRound: 0 },
        { hullGroup: "mining_barge", runs: 1, dueAt: 1793353785082, waitRound: 0 }]),
      station("npc-60000946", 30001429, "0/4", []),
      station("npc-60000964", 30000205, "1/4", [{ hullGroup: "cruiser", runs: 2, dueAt: 1793355000000, waitRound: 0 }]),
      station("npc-60003172", 30000144, "0/4", []),
      station("npc-60015106", 30000145, "bad", []),
      station("npc-60015107", 30000146, "0/4", []),
    ], hullPool: { total: 321, groups: { cruiser: 96, frigate: 65 }, perStation: {} },
    inProduction: { mining_barge: 2 }, deficit: {}, deficitStation: "npc-60003172",
    totals: { jobsStarted: 294, hullsDelivered: 431, hullsLost: 0 }, last24h: { hullsDelivered: 11, hullsLost: 0 } },
    { faction: "Guristas Pirates", stations: [station("npc-60001", 30002000, "0/4", [])],
      hullPool: { total: 10, groups: { frigate: 10 }, perStation: {} }, inProduction: {}, deficit: { frigate: 2 },
      totals: {}, last24h: { hullsDelivered: 0, hullsLost: 0 } },
  ] };
}

function mining() {
  return { available: true, state: "ready", counters: {}, factions: [
    { faction: "Caldari State", miners: { live: 10, idle: 0, onTrip: 10 }, trips: { OUTBOUND: 0, MINING: 10, RETURNING: 0 },
      totals: { started: 705, delivered: 695 }, last24h: { delivered: 902221820, lost: 0, trips: { DELIVERED: 116 } },
      mineralStock: { total: 2164226231, minerals: [{ mineral: "Tritanium", quantity: 1662750155 },
        { mineral: "Pyerite", quantity: 221539370 }] }, topBelts: [{ system: "M-OEE8", units: 421438908 }] },
    { faction: "Guristas Pirates", miners: { live: 2, idle: 2, onTrip: 0 }, trips: {}, totals: {},
      last24h: { delivered: 0, lost: 0, trips: {} }, mineralStock: { total: 0, minerals: [] }, topBelts: [] },
  ] };
}

function stations() {
  const row = (station, faction, system, state) => ({ station, faction, system, kind: "npc", state, version: 1,
    items: 1, quantity: 1, stock: [] });
  return { available: true, state: "ready", reason: null, seed: 1, truncated: false, stations: [
    row("Akkio V - Moon 6 - Caldari Funds Unlimited Vault", "Caldari State", "Akkio", "ONLINE"),
    row("Obe VI - Caldari Provisions Plantation", "Caldari State", "Obe", "ONLINE"),
    row("Taisy III - Caldari Navy Assembly Plant", "Caldari State", "Taisy", "ONLINE"),
    row("Venal X - Guristas Base", "Guristas Pirates", "6NJ8-V", "REINFORCED"),
  ] };
}

function logistics() {
  return { available: true, state: "ready", counters: {}, factions: [
    { faction: "Caldari State", open: [{ convoyId: "c1" }], totals: { started: 107, delivered: 98, aborted: 9, lost: 0,
      unitsLoaded: 1, unitsDelivered: 1, unitsLost: 0 }, last24h: { delivered: 0, lost: 0, convoys: {} } },
  ] };
}

function control() {
  return { available: true, seed: 1, graphReady: true, totals: {}, factions: [[500025, "Rogue Drones", 688],
    [CALDARI, "Caldari State", 7], [GURISTAS, "Guristas Pirates", 12]], factionNames: {}, regions: [], systems: [] };
}

function invasions() {
  return { available: true, state: "ready", truncated: false, open: [], ended: [], totals: {}, lastDecision: null,
    rollIntervalMs: 21600000 };
}

const SOURCES = Object.freeze({ factions, activity, "faction-fleets": factionFleets, trade, production, mining,
  stations, logistics, control, invasions });

function factionNames() {
  return new Map([[CALDARI, "Caldari State"], [GURISTAS, "Guristas Pirates"], [500098, "Twin Cartel"],
    [500099, "Twin Cartel"]]);
}

module.exports = { CALDARI, GURISTAS, SOURCES, factionNames };
