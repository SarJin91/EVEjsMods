"use strict";

const assert = require("node:assert");

const { corpNameOf, planBase, planReview } = require("../../../lib/strategy/capsuleers/capsuleerRules");
const { createRng } = require("../../../lib/util/rng");
const { EXPANSION_EXCLUDED_REGION_IDS } = require("../../../lib/strategy/data/expansion");
const D = require("../../../lib/strategy/data/capsuleers");

const SYS = Object.freeze({ P: 1, A: 2, B: 3, C: 4, D: 5, E: 6, F: 7, G: 8 });
const EDGES = [[SYS.P, SYS.A], [SYS.P, SYS.B], [SYS.P, SYS.C], [SYS.P, SYS.D], [SYS.P, SYS.F], [SYS.D, SYS.E],
  [SYS.E, SYS.G]];
const VERTEX = new Map([
  [SYS.P, { secClass: "lowsec", regionId: 10000001 }], [SYS.A, { secClass: "lowsec", regionId: 10000070 }],
  [SYS.B, { secClass: "lowsec", regionId: 10000001 }], [SYS.C, { secClass: "lowsec", regionId: 10000001 }],
  [SYS.D, { secClass: "lowsec", regionId: 10000001 }], [SYS.E, { secClass: "nullsec", regionId: 10000001 }],
  [SYS.F, { secClass: "highsec", regionId: 10000001 }], [SYS.G, { secClass: "lowsec", regionId: 10000002 }],
]);
const STATIONS = new Map([
  [SYS.P, [{ stationId: 60000001, corporationId: 1000001 }]], [SYS.A, [{ stationId: 60000002, corporationId: null }]],
  [SYS.B, [{ stationId: 60000003, corporationId: null }]], [SYS.C, []],
  [SYS.D, [{ stationId: 60000012, corporationId: 1000123 }, { stationId: 60000011, corporationId: null }]],
  [SYS.E, [{ stationId: 60000006, corporationId: null }]], [SYS.F, [{ stationId: 60000007, corporationId: null }]],
  [SYS.G, [{ stationId: 60000008, corporationId: 1000008 }]],
]);
const ADJ = new Map();
for (const [a, b] of EDGES) {
  if (!ADJ.has(a)) ADJ.set(a, []);
  if (!ADJ.has(b)) ADJ.set(b, []);
  ADJ.get(a).push(b);
  ADJ.get(b).push(a);
}
const PARAMS = Object.freeze({ baseMaxJumpsToPirate: 2, baseScanMaxSystems: 2000, baseSecClasses: ["lowsec"],
  baseCandidatesTop: 16 });

function input(over = {}) {
  const calls = [];
  return { calls, value: { pirateSystemIds: [SYS.P], neighbors: (id) => ADJ.get(id) || null,
    vertexOf: (id) => VERTEX.get(id) || null, stationsOf: (id) => {
      calls.push(id);
      return STATIONS.get(id) || [];
    }, takenBaseIds: new Set([SYS.B]), excludedRegionIds: new Set(EXPANSION_EXCLUDED_REGION_IDS),
    rng: createRng(11), ...over } };
}

module.exports = ({ test }) => {
  test("C1 planBase: lowsec NPC station near pirate space; pirate / excluded region / taken / stationless "
    + "skipped; NO_BASE_CANDIDATE, NO_PIRATE_SPACE; same seed same pick", () => {
    const one = input();
    const got = planBase(one.value, PARAMS);
    const results = { got, calls: one.calls.slice().sort((a, b) => a - b) };
    results.none = planBase(input({ takenBaseIds: new Set([SYS.B, SYS.D]) }).value, PARAMS);
    results.noPirate = planBase(input({ pirateSystemIds: [] }).value, PARAMS);
    const far = { ...PARAMS, baseMaxJumpsToPirate: 3 };
    const picks = [];
    for (let seed = 1; seed <= 12; seed += 1) {
      const a = planBase(input({ rng: createRng(seed) }).value, far);
      const b = planBase(input({ rng: createRng(seed) }).value, far);
      assert.deepStrictEqual(a, b, `seed ${seed}`);
      picks.push(a.systemId);
    }
    results.farSet = [...new Set(picks)].sort((a, b) => a - b);
    results.top1 = planBase(input({ rng: createRng(5) }).value, { ...far, baseCandidatesTop: 1 }).systemId;
    assert.deepStrictEqual(results, {
      got: { ok: true, systemId: SYS.D, stationId: 60000011, stationCorporationId: null, jumps: 1 },
      calls: [SYS.C, SYS.D],
      none: { ok: false, reason: "NO_BASE_CANDIDATE" },
      noPirate: { ok: false, reason: "NO_PIRATE_SPACE" },
      farSet: [SYS.D, SYS.G],
      top1: SYS.D,
    });
  });

  test("C2 corpNameOf: deterministic, name <= 50, ticker 2-5 [A-Z0-9], slots 1..16 distinct", () => {
    const names = new Set();
    const tickers = new Set();
    for (let slot = 1; slot <= 16; slot += 1) {
      const n = corpNameOf(slot);
      assert.deepStrictEqual(corpNameOf(slot), n, `slot ${slot} deterministic`);
      assert.ok(n.name.length >= 1 && n.name.length <= 50, n.name);
      assert.ok(/^[\x20-\x7e]+$/.test(n.name), `ASCII ${n.name}`);
      assert.ok(/^[A-Z0-9]{2,5}$/.test(n.ticker), n.ticker);
      names.add(n.name);
      tickers.add(n.ticker);
    }
    assert.deepStrictEqual([names.size, tickers.size], [16, 16]);
  });

  test("FC1-3 free corps corpNameOf 1..64: distinct names and tickers ^[A-Z0-9]{2,5}$, slots 1..16 "
    + "as before", () => {
    const rows = [];
    for (let slot = 1; slot <= D.MAX_SLOTS; slot += 1) {
      const n = corpNameOf(slot);
      assert.ok(n.name.length >= 1 && n.name.length <= 50 && /^[\x20-\x7e]+$/.test(n.name), n.name);
      assert.ok(/^[A-Z0-9]{2,5}$/.test(n.ticker), `slot ${slot} ${n.ticker}`);
      rows.push(n);
    }
    assert.deepStrictEqual([D.MAX_SLOTS, new Set(rows.map((r) => r.name)).size,
      new Set(rows.map((r) => r.ticker)).size], [64, 64, 64]);
    assert.deepStrictEqual(rows.slice(0, 16).map((r) => `${r.name}|${r.ticker}`), ["Iron Wardens|IROW",
      "Silent Consortium|SILC", "Void Armada|VOIA", "Black Brotherhood|BLAB", "Azure Ventures|AZUV",
      "Stellar Collective|STEC", "Hollow Industries|HOLI", "Rogue Outfitters|ROGO", "Obsidian Syndicate|OBSS",
      "Frozen Ventures|FROV", "Scarlet Brotherhood|SCAB", "Golden Industries|GOLI", "Shadow Collective|SHAC",
      "Vanguard Syndicate|VANS", "Nova Outfitters|NOVO", "Ember Wardens|EMBW"]);
  });

  test("FC1-2 free corps planReview fleet budget: off = the result as before, room 0 -> no buy and "
    + "budgetRefused, rotation by round", () => {
    const corp = (slot, extra = {}) => ({ corpSlot: slot, state: "ACTIVE", iskBalance: 1000000000,
      corporationId: 98000000 + slot, seed: slot * 11, memberIds: [slot * 10 + 1, slot * 10 + 2, slot * 10 + 3],
      ...extra });
    const snap = { corps: [corp(3), corp(1), corp(2), corp(4, { state: "FOUNDING" })],
      identities: new Map([[4, { ok: true, state: "LINKED", characterIds: [41, 42, 43] }]]),
      fleetsByCorp: new Map([[98000001, 1]]), mercByCorp: new Map(), fleetsTruncated: false, round: 7 };
    const params = { maxCorps: 6, maxFoundingsPerReview: 1, maxFleetsPerCorp: 3, maxFleetBuysPerReview: 2,
      stipendIskPerReview: 10000000, maxIskBalance: 50000000000, templates: D.FLEET_TEMPLATES, membersPerCorp: 3,
      mercBuy: false, maxMercenaryFleetsPerCorp: 1, mercTemplates: D.MERC_TEMPLATES };
    const before = { found: { slot: 5 }, activate: [{ slot: 4, identity: { ok: true, state: "LINKED",
      characterIds: [41, 42, 43] } }], refuse: [], ensure: [], stipends: [{ slot: 1, amount: 10000000 },
      { slot: 2, amount: 10000000 }, { slot: 3, amount: 10000000 }], buys: [{ slot: 1, templateId: "ratter-cruisers",
      costIsk: 120000000, fleetRole: "capsuleer" }, { slot: 2, templateId: "ratter-bc", costIsk: 90000000,
      fleetRole: "capsuleer" }], refresh: [] };
    const strip = ({ budgetRefused, ...rest }) => rest;
    const off = planReview(snap, params);
    const offFlag = planReview(snap, { ...params, fleetBudget: { enabled: false, maxFleetsTotal: 0,
      minFleetHeadroom: 0, globalLimit: 0 } });
    const budget = (over) => ({ enabled: true, maxFleetsTotal: 48, minFleetHeadroom: 100, globalLimit: 1000, ...over });
    const full = planReview({ ...snap, fleetsTotal: 48, globalActive: 10 }, { ...params, fleetBudget: budget() });
    const noHeadroom = planReview({ ...snap, fleetsTotal: 1, globalActive: 900 }, { ...params,
      fleetBudget: budget() });
    const missing = planReview(snap, { ...params, fleetBudget: budget() });
    const three = { corps: [corp(1), corp(2), corp(3)], identities: new Map(), fleetsByCorp: new Map(),
      mercByCorp: new Map(), fleetsTruncated: false, fleetsTotal: 0, globalActive: 0 };
    const one = { ...params, maxFleetBuysPerReview: 1 };
    const rotated = planReview({ ...three, round: 1 }, { ...one, fleetBudget: budget() });
    const room1 = planReview({ ...three, round: 0, globalActive: 899 }, { ...params, maxFleetBuysPerReview: 3,
      fleetBudget: budget() });
    assert.deepStrictEqual({ off: strip(off), offRefused: off.budgetRefused, offFlag: strip(offFlag),
      offFlagRefused: offFlag.budgetRefused, fullBuys: full.buys, fullRefused: full.budgetRefused,
      fullRest: strip({ ...full, buys: before.buys }), noHeadroom: [noHeadroom.buys, noHeadroom.budgetRefused],
      missing: [missing.buys, missing.budgetRefused], rotated: rotated.buys.map((b) => b.slot),
      offRotation: planReview({ ...three, round: 1 }, one).buys.map((b) => b.slot),
      room1: [room1.buys.map((b) => b.slot), room1.budgetRefused] }, {
      off: before, offRefused: 0, offFlag: before, offFlagRefused: 0, fullBuys: [], fullRefused: 2,
      fullRest: before, noHeadroom: [[], 2], missing: [[], 2], rotated: [2], offRotation: [1],
      room1: [[1], 2] });
  });

  test("C7 planReview refresh: a LINKED identity without a current member -> no refresh "
    + "the slot stays on ensure; a superset -> refresh", () => {
    const corp = { corpSlot: 1, state: "ACTIVE", iskBalance: 0, corporationId: 98000001, seed: 1,
      memberIds: [90000001, 90000009] };
    const plan = (characterIds) => planReview({ corps: [corp], identities: new Map([[1, { ok: true, state: "LINKED",
      characterIds }]]), fleetsByCorp: new Map(), fleetsTruncated: false, round: 1 }, { maxCorps: 1,
      maxFoundingsPerReview: 0, maxFleetsPerCorp: 0, maxFleetBuysPerReview: 0, stipendIskPerReview: 0,
      maxIskBalance: 1, templates: [], membersPerCorp: 3 });
    const drifted = plan([90000001, 90000002, 90000003]);
    const superset = plan([90000001, 90000009, 90000003]);
    assert.deepStrictEqual([drifted.refresh, drifted.ensure, superset.refresh, superset.ensure],
      [[], [1], [{ slot: 1, memberIds: [90000001, 90000009, 90000003] }], []]);
  });
};
