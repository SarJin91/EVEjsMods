"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { planMinerRaids } = require("../../../lib/strategy/ai/minerRaids");
const { isForeignBastion } = require("../../../lib/strategy/ai/bastions");
const { describeNote } = require("../../../lib/strategy/activity/notes");
const { decideReview } = require("../../../lib/strategy/ai");
const { evaluateSupplyAndFronts } = require("../../../lib/strategy/ai/supply");
const { usableKinds } = require("../../../lib/strategy/ai/targeting");
const { buildPowerTable, strengthOf } = require("../../../lib/strategy/ai/strength");
const { createOperationKinds } = require("../../../lib/strategy/kinds");
const { OPERATION_KINDS_VERSION, OPERATION_KINDS_V1 } = require("../../../lib/strategy/data/operationKinds");
const { TARGET_SCORING_V1 } = require("../../../lib/strategy/data/targetScoring");
const { FLEET_ROLES, OPERATION_TYPES, OBJECTIVES } = require("../../../lib/fleets/schema");
const { GROUPS } = require("../../../lib/battle/data/strengthCatalog");
const { OBJECTIVE_MAP } = require("../../../lib/battle/data/contactRules");
const { createTripRepository } = require("../../../lib/economy/mining/tripRepository");
const { createMiningService, COUNTER_NAMES } = require("../../../lib/economy/mining/miningService");
const { createUnavailableMining } = require("../../../lib/economy/mining");
const { resolveConfig } = require("../../../config");
const { harness: H } = require("../../battle/settlement.test");

const MOD_DIR = path.resolve(__dirname, "..", "..", "..");
const AT = 1760000000000;
const HOUR = 3600000;
const F = 7;
const HOSTILE = 9;
const NEUTRAL = 11;

const kinds = (() => {
  const k = createOperationKinds({ version: OPERATION_KINDS_VERSION, kinds: OPERATION_KINDS_V1 },
    { operationTypes: OPERATION_TYPES, objectives: OBJECTIVES, fleetRoles: FLEET_ROLES });
  assert.ok(k.ok, JSON.stringify(k));
  return k.kinds;
})();
const POWER = buildPowerTable(GROUPS);
const SIX = [{ hullGroup: "cruiser", typeId: null, count: 6 }];
const RAID = Object.freeze({ maxPerReview: 1, windowMs: HOUR, maxJumps: 5, minShips: 3, minShipRatioPermille: 1000,
  minShiftLeftMs: HOUR / 2, highsec: false, maxFleetsScanned: 12 });

const PARAMS = Object.freeze({ maxReachJumps: 10, supplyChainJumps: 10, captureRangeFromStationJumps: 5,
  maxAssemblyJumps: 8, maxBfsSystems: 2000, mobilizeFallbackJumps: 0, mobilizeFallbackMaxSystems: 2000,
  maxTargetCandidates: 40, targetPickTopK: 1, maxOperationsPerReview: 2, maxFleetsPerOperation: 4,
  maxFleetsPerFaction: 12, maxMobilizationsPerReview: 3, mobilizeResourcePerShip: 10, mobilizeReservePerShip: 1,
  attackStrengthRatio: 1.2, intelTtlMs: 6 * HOUR, maxObservationsPerReview: 8, reconWindowMs: HOUR / 2,
  attackWindowMs: 2 * HOUR, operationGraceMs: HOUR, maxHousekeepingPerReview: 4, maxRefitRequestsPerReview: 2,
  returnAfterIdleMs: HOUR / 2, returnWindowMs: 2 * HOUR, maxReturnsPerReview: 3,
  returnFleetRoles: [...kinds.get("return").fleetRoles],
  kinds: kinds.list, scoring: TARGET_SCORING_V1, powerTable: POWER, frontLimitCap: 2, routeMaxJumps: 40,
  minerRaid: RAID });

const miner = (systemId, extra = {}) => ({ tripId: `t${systemId}`, factionId: HOSTILE, fleetId: `m${systemId}`,
  systemId, secClass: "lowsec", miningEndsAt: AT + 2 * HOUR, ships: 3, ...extra });

function snap(o = {}) {
  const row = (systemId, controllerFactionId) => ({ systemId, controllerFactionId, occupationState: "STABLE",
    controllerGarrison: 0, hostileStations: 0, observed: false });
  const s = { v: 1, factionId: F, round: 3, at: AT, seed: 11,
    faction: { status: o.status || "ACTIVE", homeSystemId: 20, doctrineId: "mr", resourceUnits: 100000,
      reserveUnits: 10000, frontLimit: 1, version: 1 },
    entry: { kind: "pirate", maxActiveFronts: 1, allies: [], homeRegionIds: [], ownerCorporationId: 1 },
    doctrine: { doctrineId: "mr", canOccupy: false, reachJumps: 30, returnToBase: true,
      operationTypes: o.operationTypes || ["recon", "raid", "return"],
      templates: { scout: [{ hullGroup: "frigate", count: 1 }], patrol: [{ hullGroup: "cruiser", count: 2 }] } },
    theatre: [14], expansion: [],
    neighbors: (id) => [id - 1, id + 1].filter((x) => x >= 1 && x <= 40), regionOf: () => null,
    isHostile: (x) => x === HOSTILE,
    stationsMode: "ready", stations: [{ systemId: 20, stationId: "st20" }],
    systems: [row(14, HOSTILE), row(20, F), row(26, HOSTILE)],
    fleets: o.fleets || [raider("r20", 20)], fleetsTruncated: false, operations: o.operations || [],
    operationsTruncated: false, intel: [], sightings: [], occupations: [], territory: [], territoryTruncated: false };
  if (o.minerTargets !== null) s.minerTargets = o.minerTargets || { targets: [miner(18)], truncated: false };
  return s;
}

function raider(fleetId, systemId, extra = {}) {
  const composition = extra.composition || SIX;
  return { fleetId, version: 2, state: "IDLE", fleetRole: "patrol", systemId, refitPending: false,
    shipCount: composition.reduce((s, e) => s + e.count, 0), strength: strengthOf(composition, POWER),
    operationId: null, legSeq: 0, homeSystemId: 20, updatedAt: AT - 2 * HOUR, ...extra };
}

const SUPPLY = { stationSystems: [20], reach: new Map([[18, 2], [19, 1], [20, 0], [24, 4]]), frontTargets: [] };
const plan = (s, o = {}) => planMinerRaids(s, o.supply || SUPPLY, { ...PARAMS, ...(o.params || {}) },
  o.used || new Set(), o.room === undefined ? 2 : o.room, o.opts);
const ganks = (d) => d.intents.filter((i) => i.type === "LAUNCH" && i.kind === "gank");

module.exports = ({ test, skip }) => {
  test("MR1 planMinerRaids: idle patrol fleet (6) 2 jumps from a hostile lowsec belt (3 miners, 2 h of shift left) "
    + "-> one LAUNCH gank, 1 fleet, mobilize [], dueAt at + windowMs, note MINER_RAID:<id>; deterministic", () => {
    const s = snap();
    const used = new Set();
    const r = plan(s, { used });
    assert.deepStrictEqual(r.intents, [{ type: "LAUNCH", kind: "gank",
      target: { kind: "system", systemId: 18, ref: null }, originSystemId: 20,
      fleets: [{ fleetId: "r20", expectedVersion: 2 }], mobilize: [], dueAt: AT + HOUR }]);
    assert.deepStrictEqual([r.notes, r.seen], [["MINER_RAID:18"], 1]);
    assert.ok(used.has("r20"), "the raid fleet joins used");
    assert.deepStrictEqual(plan(snap()), plan(snap()));
    const two = { targets: [miner(24, { ships: 5 }), miner(18)], truncated: true };
    const r2 = plan(snap({ minerTargets: two }));
    assert.deepStrictEqual([r2.intents[0].target.systemId, r2.notes, r2.seen],
      [18, ["MINER_RAID_TARGETS_TRUNCATED", "MINER_RAID:18"], 2]);
    const reach = { ...SUPPLY, reach: new Map([[18, 2], [22, 2]]) };
    const tie = { targets: [miner(18), miner(22, { ships: 4 })], truncated: false };
    assert.strictEqual(plan(snap({ minerTargets: tie }), { supply: reach }).intents[0].target.systemId, 22);
  });

  test("MR2 filters -> no intent (not hostile, highsec off, shift too short, open own op, too weak, dist 0, no raid "
    + "in doctrine, AUSTERITY); flag off = decideReview unchanged and no minerRaidsSeen", () => {
    const none = (s, o, notes) => {
      const r = plan(s, o);
      assert.deepStrictEqual(r.intents, [], JSON.stringify(r));
      if (notes) assert.deepStrictEqual(r.notes, notes);
    };
    const one = (t) => snap({ minerTargets: { targets: [miner(18, t)], truncated: false } });
    none(one({ factionId: NEUTRAL }), {}, []);
    none(one({ factionId: F }), {}, []);
    none(one({ secClass: "highsec" }), {}, []);
    assert.strictEqual(plan(one({ secClass: "highsec" }), { params: { minerRaid: { ...RAID, highsec: true } } })
      .intents.length, 1, "highsec only with the flag");
    none(one({ miningEndsAt: AT + HOUR / 4 }), {}, []);
    none(snap({ operations: [{ operationId: "o1", state: "ACTIVE", operationType: "recon", originSystemId: 20,
      targetSystemId: 18, dueAt: AT + HOUR, members: 1, orderedMembers: 1 }] }), {}, []);
    none(snap(), { opts: { targets: new Set([18]) } }, []);
    none(one({ ships: 7 }), {}, ["MINER_RAID_TOO_WEAK"]);
    assert.strictEqual(plan(one({ ships: 12 }), { params: { minerRaid: { ...RAID, minShipRatioPermille: 500 } } })
      .intents.length, 1, "ratio 500: 6 ships hold 12 miners");
    none(snap({ fleets: [raider("r18", 18)] }), {}, ["MINER_RAID_NO_TARGET"]);
    none(snap({ operationTypes: ["recon", "return"] }), {}, []);
    none(snap(), { supply: { ...SUPPLY, homeOnly: true } }, ["MINER_RAID_AUSTERITY"]);
    none(snap({ fleets: [raider("r20", 20, { composition: [{ hullGroup: "cruiser", typeId: null, count: 2 }] })] }),
      {}, []);

    const { minerRaid: _m, ...noKey } = PARAMS;
    const off = decideReview(snap(), { ...PARAMS, minerRaid: null });
    assert.strictEqual(off.outcome, "REVIEWED", off.reason);
    assert.deepStrictEqual(off, decideReview(snap({ minerTargets: null }), noKey));
    assert.ok(!("minerRaidsSeen" in off) && ganks(off).length === 0 && !off.notes.some((n) => n.startsWith("MINER")));
    const aiPath = require.resolve("../../../lib/strategy/ai");
    const raidsPath = require.resolve("../../../lib/strategy/ai/minerRaids");
    const [aiEntry, raidsEntry] = [require.cache[aiPath], require.cache[raidsPath]];
    let noPlanner;
    try {
      delete require.cache[aiPath];
      require.cache[raidsPath] = { ...raidsEntry, exports: { ...raidsEntry.exports,
        planMinerRaids: () => ({ intents: [], notes: [], seen: 0 }) } };
      noPlanner = require("../../../lib/strategy/ai").decideReview;
    } finally {
      require.cache[aiPath] = aiEntry;
      require.cache[raidsPath] = raidsEntry;
    }
    assert.notStrictEqual(noPlanner, decideReview, "a fresh ai/index");
    assert.deepStrictEqual(off, noPlanner(snap(), { ...PARAMS, minerRaid: null }), "flag off = no planner");
    const on = decideReview(snap(), PARAMS);
    assert.deepStrictEqual([ganks(on).map((i) => i.target.systemId), on.minerRaidsSeen], [[18], 1], JSON.stringify(on.notes));
  });

  test("MR3 slots, kind and fronts: room 0 / used fleet -> no raid, decideReview maxOperationsPerReview 0 -> no "
    + "gank; gank v10 enabled false, opensFront false, never usable; an open gank op holds no front", () => {
    assert.deepStrictEqual(plan(snap(), { room: 0 }), { intents: [], notes: [], seen: 0 });
    assert.deepStrictEqual(plan(snap(), { used: new Set(["r20"]) }).intents, []);
    assert.deepStrictEqual(ganks(decideReview(snap(), { ...PARAMS, maxOperationsPerReview: 0 })), []);
    const d = decideReview(snap(), PARAMS);
    const offensive = d.intents.filter((i) => i.type === "LAUNCH"
      && !["gank", "return", "patrol", "picket", "defense"].includes(i.kind));
    assert.ok(offensive.length + ganks(d).length <= PARAMS.maxOperationsPerReview, JSON.stringify(d.intents));

    assert.ok(OPERATION_KINDS_VERSION >= 11, String(OPERATION_KINDS_VERSION));
    const g = kinds.get("gank");
    assert.deepStrictEqual({ ...g, fleetRoles: [...g.fleetRoles], targetKinds: [...g.targetKinds] }, { kind: "gank",
      operationType: "gank", objective: "raid", fleetRoles: ["invasion", "patrol"], mobilizeRole: "patrol",
      offensive: true, opensFront: false, captures: false, targetKinds: ["system"], windowKey: "minerRaidWindowMs",
      needsIntel: false, needsCanOccupy: false, enabled: false, occupationSignal: null, inPlace: false });
    assert.ok(OPERATION_TYPES.includes("gank")
      && OPERATION_TYPES.indexOf("gank") === OPERATION_TYPES.indexOf("ratting") + 1);
    assert.ok(!usableKinds(snap({ operationTypes: ["recon", "raid", "gank"] }), PARAMS).some((k) => k.kind === "gank"));
    assert.strictEqual(OBJECTIVE_MAP.raid, "destroy");
    const op = (operationType) => ({ operationId: "o1", version: 1, state: "ACTIVE", operationType, originSystemId: 20,
      targetSystemId: 26, dueAt: AT + HOUR, members: 1, orderedMembers: 1 });
    assert.ok(!evaluateSupplyAndFronts(snap({ operations: [op("gank")] }), PARAMS).frontTargets.includes(26));
    assert.ok(evaluateSupplyAndFronts(snap({ operations: [op("raid")] }), PARAMS).frontTargets.includes(26),
      "contrast: a raid op holds the front");
  });

  test("MR6 strength check: flag off = the result as before; fresh intel 3x the fleet -> no LAUNCH "
    + "MINER_RAID_TOO_STRONG; legacy garrison above the fleet -> the second candidate without a garrison", () => {
    const fleetStrength = raider("r20", 20).strength;
    const on = { minerRaid: { ...RAID, strengthCheck: true } };
    const withIntel = (k = 3) => {
      const s = snap();
      s.intel = [{ systemId: 18, observedAt: AT - HOUR, hostileFleets: 1, hostileShips: 9,
        hostileStrength: k * fleetStrength, hostileStations: 0, controllerFactionId: null }];
      return s;
    };
    const got = {};
    const offFalse = plan(withIntel(), { params: { minerRaid: { ...RAID, strengthCheck: false } } });
    got.off = [offFalse.intents.map((i) => i.target.systemId), offFalse.notes, Object.keys(offFalse).sort()];
    got.offSame = JSON.stringify(offFalse) === JSON.stringify(plan(withIntel()));
    got.default = resolveConfig({ modDir: MOD_DIR, env: {} }).config.strategy.minerRaidStrengthCheck;
    const strong = plan(withIntel(), { params: on });
    got.strong = [strong.intents, strong.notes, strong.tooStrong];
    got.noIntel = plan(snap(), { params: on }).intents.map((i) => i.target.systemId);
    got.equal = plan(withIntel(1), { params: on }).notes;
    got.decision = [decideReview(withIntel(), { ...PARAMS, ...on }).minerRaidTooStrong,
      "minerRaidTooStrong" in decideReview(withIntel(), PARAMS)];
    const garrisoned = () => {
      const s = snap({ minerTargets: { targets: [miner(18), miner(22)], truncated: false } });
      s.systems = [...s.systems, { systemId: 18, controllerFactionId: HOSTILE, occupationState: "STABLE",
        controllerGarrison: fleetStrength + 1, hostileStations: 0, observed: false }];
      return s;
    };
    const reach = { ...SUPPLY, reach: new Map([[18, 2], [20, 0], [22, 2]]) };
    const pick = (params) => {
      const r = plan(garrisoned(), { supply: reach, params });
      return [r.intents.map((i) => i.target.systemId), r.notes, r.tooStrong];
    };
    got.garrisonOff = pick({});
    got.garrisonLegacy = pick({ ...on, garrisonEstimate: { mode: "legacy" } });
    got.garrisonResolverOff = pick({ ...on, garrisonEstimate: { mode: "resolver", influencePoints: false,
      stationPoints: 0, powerPerPoint: 1000 } });
    assert.deepStrictEqual(got, {
      off: [[18], ["MINER_RAID:18"], ["intents", "notes", "seen"]], offSame: true, default: false,
      strong: [[], ["MINER_RAID_TOO_STRONG"], 1], noIntel: [18], equal: ["MINER_RAID_TOO_STRONG"], decision: [1, false],
      garrisonOff: [[18], ["MINER_RAID:18"], undefined],
      garrisonLegacy: [[22], ["MINER_RAID:22"], 1],
      garrisonResolverOff: [[18], ["MINER_RAID:18"], 0],
    });
  });

  test("MR7 (P1): preferUnescorted - class 0 (fresh, no escort) before 1 (no intel) "
    + "before 2 (fresh, more hostile ships than miners); flag off = old order, no field; reordered; with the strength "
    + "check the result unchanged for the targets that pass", () => {
    const star = (o = {}) => {
      const s = snap({ fleets: o.fleets, minerTargets: { targets: [miner(17), miner(18), miner(19)],
        truncated: false } });
      s.neighbors = (id) => (id === 20 ? [17, 18, 19] : ([17, 18, 19].includes(id) ? [20] : []));
      s.intel = [{ systemId: 17, observedAt: AT - HOUR, hostileFleets: 2, hostileShips: 9,
        hostileStrength: o.strong17 || 1, hostileStations: 0, controllerFactionId: null },
      { systemId: 19, observedAt: AT - HOUR, hostileFleets: 1, hostileShips: 3, hostileStrength: 1,
        hostileStations: 0, controllerFactionId: null }];
      return s;
    };
    const reach = { ...SUPPLY, reach: new Map([[17, 1], [18, 1], [19, 1], [20, 0]]) };
    const three = [raider("r1", 20), raider("r2", 20), raider("r3", 20)];
    const run = (raid, o = {}) => plan(star(o), { supply: reach, room: 3,
      params: { minerRaid: { ...RAID, maxPerReview: 3, ...raid } } });
    const pick = (r) => [r.intents.map((i) => i.target.systemId), r.reordered];
    const fleetStrength = raider("r1", 20).strength;
    const got = {
      off: [pick(run({}, { fleets: three })), "reordered" in run({}, { fleets: three })],
      on: pick(run({ preferUnescorted: true }, { fleets: three })),
      single: pick(run({ preferUnescorted: true }, { fleets: [raider("r1", 20)] })),
      checkOff: (() => {
        const r = run({ strengthCheck: true }, { fleets: three, strong17: 3 * fleetStrength });
        return [r.intents.map((i) => i.target.systemId), r.tooStrong];
      })(),
      checkOn: (() => {
        const r = run({ strengthCheck: true, preferUnescorted: true }, { fleets: three, strong17: 3 * fleetStrength });
        return [r.intents.map((i) => i.target.systemId), r.tooStrong, r.reordered];
      })(),
      decision: [decideReview(star({ fleets: [raider("r1", 20)] }), { ...PARAMS,
        minerRaid: { ...RAID, preferUnescorted: true } }).minerRaidReordered,
      "minerRaidReordered" in decideReview(star({ fleets: [raider("r1", 20)] }), PARAMS)],
    };
    assert.deepStrictEqual(got, {
      off: [[[17, 18, 19], undefined], false],
      on: [[19, 18, 17], 2],
      single: [[19], 1],
      checkOff: [[18, 19], 1],
      checkOn: [[19, 18], 1, 1],
      decision: [1, false],
    });
  });

  test("MR8 (): the gank reads snapshot.extraIntel through intelWithExtra in both places "
    + "the threshold and the target class give with the rows only in extraIntel the result of the rows in intel",
  () => {
    const fleetStrength = raider("r1", 20).strength;
    const row = (systemId, ships, strength) => ({ systemId, observedAt: AT - HOUR, hostileFleets: 1,
      hostileShips: ships, hostileStrength: strength, hostileStations: 0, controllerFactionId: null });
    const check = { minerRaid: { ...RAID, strengthCheck: true } };
    const thr = (where) => {
      const s = snap();
      s[where] = [row(18, 9, 3 * fleetStrength)];
      const r = plan(s, { params: check });
      return [r.intents.map((i) => i.target.systemId), r.notes, r.tooStrong];
    };
    const cls = (where) => {
      const s = snap({ fleets: [raider("r1", 20), raider("r2", 20), raider("r3", 20)], minerTargets: {
        targets: [miner(17), miner(18), miner(19)], truncated: false } });
      s.neighbors = (id) => (id === 20 ? [17, 18, 19] : ([17, 18, 19].includes(id) ? [20] : []));
      s[where] = [row(17, 9, 1), row(19, 3, 1)];
      const r = plan(s, { supply: { ...SUPPLY, reach: new Map([[17, 1], [18, 1], [19, 1], [20, 0]]) }, room: 3,
        params: { minerRaid: { ...RAID, maxPerReview: 3, preferUnescorted: true } } });
      return [r.intents.map((i) => i.target.systemId), r.reordered];
    };
    assert.deepStrictEqual({ thr: [thr("extraIntel"), thr("intel")], cls: [cls("extraIntel"), cls("intel")] }, {
      thr: [[[], ["MINER_RAID_TOO_STRONG"], 1], [[], ["MINER_RAID_TOO_STRONG"], 1]],
      cls: [[[19, 18, 17], 2], [[19, 18, 17], 2]] });
  });

  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };
  const M = resolveConfig({ modDir: MOD_DIR, env: {} }).config.mining;

  needsDriver("MR4 readMinerTargets: MINING trips of other factions with the fleet STAGED in its belt and the shift "
    + "not over; own / RETURNING / ENGAGED / ended out; order mining_ends_at DESC, trip_id; limit + truncated; stub",
  () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    const shared = H.sharedOf();
    const env = H.boot(opened, shared);
    const { S, FACTION_A, FACTION_B } = H;
    const at = shared.clock.now();
    const comp = [{ hullGroup: "frigate", count: 4 }];
    const rows = [
      ["b1", FACTION_B, "MINING", "STAGED", true, at + 2 * HOUR],
      ["b2", FACTION_B, "MINING", "STAGED", true, at + HOUR],
      ["b0", FACTION_B, "MINING", "STAGED", true, at + HOUR],
      ["a1", FACTION_A, "MINING", "STAGED", true, at + 3 * HOUR],
      ["b3", FACTION_B, "RETURNING", "STAGED", true, at + 3 * HOUR],
      ["b4", FACTION_B, "MINING", "ENGAGED", true, at + 3 * HOUR],
      ["b5", FACTION_B, "MINING", "STAGED", true, at],
      ["b6", FACTION_B, "MINING", "STAGED", false, at + 3 * HOUR],
    ];
    const ids = {};
    for (const [tag, faction, tripState, fleetState, inBelt, endsAt] of rows) {
      const fleetId = H.newFleet(env, `mr4:${tag}`, faction, comp);
      ids[tag] = fleetId;
      env.tx((db) => {
        db.prepare("UPDATE virtual_fleets SET state = ?, current_system_id = ? WHERE fleet_id = ?")
          .run(fleetState, inBelt ? S.N5 : S.N6, fleetId);
        db.prepare(`INSERT INTO world_mining_trips (trip_id, idempotency_key, faction_id, fleet_id, origin_system_id,
          belt_system_id, state, sec_class, richness_permille, mining_ends_at, dispatched_at, created_at, updated_at,
          version) VALUES (?, ?, ?, ?, ?, ?, ?, 'nullsec', 500, ?, ?, ?, ?, 1)`)
          .run(`trip-${tag}`, `mr4:${tag}`, faction, fleetId, S.N0, S.N5, tripState, endsAt, at, at, at);
      });
    }
    const repo = createTripRepository({ journal: env.journal, clock: shared.clock });
    const read = (limit) => env.tx((db) => repo.listMinerTargets(db, { excludeFactionId: FACTION_A, at, limit }));
    const all = read(10);
    assert.deepStrictEqual([all.ok, all.truncated, all.targets.map((t) => t.tripId)],
      [true, false, ["trip-b1", "trip-b0", "trip-b2"]]);
    assert.deepStrictEqual({ ...all.targets[0] }, { tripId: "trip-b1", factionId: FACTION_B, fleetId: ids.b1,
      systemId: S.N5, secClass: "nullsec", miningEndsAt: at + 2 * HOUR, ships: 4 });
    const page = read(2);
    assert.deepStrictEqual([page.truncated, page.targets.map((t) => t.tripId)], [true, ["trip-b1", "trip-b0"]]);
    assert.deepStrictEqual([read(3).truncated, read(0).targets, read(0).truncated], [false, [], true]);
    assert.strictEqual(repo.listMinerTargets({ inTransaction: false }, { excludeFactionId: 1, at, limit: 1 }).reason,
      "TX_REQUIRED");
    const svc = createMiningService({ store: opened.store, journal: env.journal, trips: repo, fleets: env.fleets,
      scheduler: env.scheduler, world: { repository: {} }, getStations: () => null, clock: shared.clock,
      ids: shared.ids, config: { mining: M }, industryCatalog: { oreBand: () => null }, nowMs: () => 0 });
    assert.strictEqual(typeof svc.readMinerTargets, "function");
    const viaSvc = env.tx((db) => svc.readMinerTargets(db, { excludeFactionId: FACTION_A, at, limit: 10 }));
    assert.deepStrictEqual(viaSvc, all);
    assert.strictEqual(env.tx((db) => svc.readMinerTargets(db, { excludeFactionId: 0, at, limit: 1 })).reason,
      "INVALID_SPEC");
    assert.strictEqual(createUnavailableMining("x").readMinerTargets().reason, "MINING_UNAVAILABLE");
  }));

  test("JCR1: skipForeignBastions on -> no gank in a foreign NPC bastion (note "
    + "MINER_RAID_FOREIGN_BASTION), the target outside unchanged; flag off -> the bastion as before", () => {
    const two = { targets: [miner(18), miner(24)], truncated: false };
    const owners = new Map([[18, 500016]]);
    const on = { minerRaid: { ...RAID, skipForeignBastions: true } };
    const r = plan({ ...snap({ minerTargets: two }), bastionOwners: owners }, { params: on });
    assert.deepStrictEqual([ganks(r).map((i) => i.target.systemId), r.notes, r.seen],
      [[24], ["MINER_RAID_FOREIGN_BASTION", "MINER_RAID:24"], 2]);
    const off = plan({ ...snap({ minerTargets: two }), bastionOwners: owners },
      { params: { minerRaid: { ...RAID, skipForeignBastions: false } } });
    assert.deepStrictEqual([ganks(off).map((i) => i.target.systemId), off.notes], [[18], ["MINER_RAID:18"]]);
    assert.deepStrictEqual(off, plan({ ...snap({ minerTargets: two }), bastionOwners: owners }));
    const all = plan({ ...snap(), bastionOwners: owners }, { params: on });
    assert.deepStrictEqual([all.intents, all.notes, all.seen], [[], ["MINER_RAID_FOREIGN_BASTION"], 1]);
    assert.strictEqual(describeNote("MINER_RAID_FOREIGN_BASTION").known, true);
  });

  test("JCR2: an own bastion is never excluded from the ganks", () => {
    const r = plan({ ...snap(), bastionOwners: new Map([[18, F]]) },
      { params: { minerRaid: { ...RAID, skipForeignBastions: true } } });
    assert.deepStrictEqual([ganks(r).map((i) => i.target.systemId), r.notes], [[18], ["MINER_RAID:18"]]);
  });

  test("JCR4: isForeignBastion without snapshot.bastionOwners -> false", () => {
    assert.strictEqual(isForeignBastion({ factionId: F }, 18), false);
    assert.strictEqual(isForeignBastion({ factionId: F, bastionOwners: {} }, 18), false);
    assert.strictEqual(isForeignBastion(null, 18), false);
    assert.strictEqual(isForeignBastion({ factionId: F, bastionOwners: new Map() }, 18), false);
    assert.strictEqual(isForeignBastion({ factionId: F, bastionOwners: new Map([[18, F]]) }, 18), false);
    assert.strictEqual(isForeignBastion({ factionId: F, bastionOwners: new Map([[18, 500016]]) }, 18), true);
    const r = plan(snap(), { params: { minerRaid: { ...RAID, skipForeignBastions: true } } });
    assert.deepStrictEqual(r, plan(snap()));
  });

  test("MR5 mining.battleEnded: MINING trip ABORT by FLEET_DESTROYED +1, by a RETREATING fleet (NOT_IN_BELT) +1, "
    + "OUTBOUND trip DIVERTED (fleet IDLE) +0", () => {
    assert.ok(COUNTER_NAMES.includes("battleEnded"));
    const counted = {};
    const telemetry = { count: (name, n) => { counted[name] = (counted[name] || 0) + n; }, observe() {} };
    const run = (tripState, fleet) => {
      const trip = { tripId: "t1", factionId: HOSTILE, fleetId: "m1", state: tripState, phaseSeq: 1, watchRound: 0,
        beltSystemId: 18, outboundOperationId: "op1", returnOperationId: null, miningEndsAt: AT + HOUR, cargo: null,
        lostUnits: 0, version: 3 };
      const svc = createMiningService({ store: {}, journal: {}, scheduler: {}, clock: { now: () => AT },
        ids: { next: () => "x" }, config: { mining: M }, telemetry, nowMs: () => 0,
        industryCatalog: { oreBand: () => null }, world: { repository: {} },
        getStations: () => ({ getMode: () => "ready", locator: { hasRepairStation: () => ({ ok: true,
          stationId: null }) } }),
        trips: { getTrip: () => ({ ok: true, trip }), transitionTrip: () => ({ ok: true, duplicate: false, trip }) },
        fleets: { repository: { getFleet: () => ({ ok: true, fleet }), getOperation: () => ({ ok: true,
          operation: null }) } } });
      const h = svc.handler({ payload: { tripId: "t1", phaseSeq: 1, round: 0 }, idempotencyKey: "mining:due:t1",
        dueAt: AT }, {});
      assert.strictEqual(h.ok, true, JSON.stringify(h));
      const r = h.effect({ inTransaction: true });
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      h.onCommitted(r);
      return [r.action, r.reason, svc.getStatus().counters.battleEnded];
    };
    const fleet = (state, extra = {}) => ({ fleetId: "m1", state, currentSystemId: 18, operationId: null,
      fleetRole: "mining", version: 4, shipCount: 3, ...extra });
    assert.deepStrictEqual(run("MINING", fleet("DESTROYED")), ["ABORT", "FLEET_DESTROYED", 1]);
    assert.deepStrictEqual(run("MINING", fleet("RETREATING")), ["ABORT", "NOT_IN_BELT", 1]);
    assert.deepStrictEqual(run("OUTBOUND", fleet("IDLE")), ["ABORT", "DIVERTED", 0]);
    assert.strictEqual(counted["mining.battleEnded"], 2, JSON.stringify(counted));
  });
};
