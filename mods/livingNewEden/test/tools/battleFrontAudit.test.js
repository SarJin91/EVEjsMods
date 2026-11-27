"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const { createStrengthCatalog, expandStrengthGroups } = require("../../lib/battle/strength");
const { GROUPS: STRENGTH_GROUPS } = require("../../lib/battle/data/strengthCatalog");
const { buildResolverParams } = require("../../lib/battle/resolverParams");
const { buildPowerTable } = require("../../lib/strategy/ai/strength");
const resolver = require("../../lib/battle/resolverInternalV1");
const scenarios = require("../battle/scenarios");
const { auditBattles, stationPointsOf, gateOf, VERDICT } = require("../../tools/battleAudit/frontImpact");
const { createContactService } = require("../../lib/battle/contactService");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const FACTION_A = scenarios.FACTION_A;
const FACTION_B = 500002;

function setup() {
  const config = resolveConfig({ modDir: MOD_DIR, env: {} }).config;
  const made = createStrengthCatalog(undefined, { groupConfidence: config.battle.strengthGroupConfidence,
    unknownTypeConfidence: config.battle.strengthUnknownTypeConfidence });
  const built = buildResolverParams(config);
  assert.ok(made.ok && built.ok, "catalog and params");
  return { catalog: made.catalog, params: built.params,
    powerTable: buildPowerTable(expandStrengthGroups(STRENGTH_GROUPS)) };
}

function rowOf(input, result) {
  return { battleId: input.battleId, systemId: input.systemId, objective: input.objective,
    inputJson: JSON.stringify(input), resultJson: JSON.stringify(result), settledAt: 1, lossesA: 2, lossesB: 3 };
}

const bat = (garrisonSide, v1, extra = {}) => ({ garrisonSide, v1, parity: true, paramsMatch: true,
  influencePart: 1, ...extra });

module.exports = ({ test }) => {
  test("BFA1 battleFrontAudit: V0 = recorded (parity), paramsMatch false on another paramsHash", () => {
    const s = setup();
    const input = scenarios.SCENARIOS.capture(7, true);
    const r = resolver.resolve(input, s.catalog, s.params);
    assert.strictEqual(r.ok, true);
    const deps = { ...s, resolve: resolver.resolve, stationPoints: () => 0 };
    const out = auditBattles([rowOf(input, r.result)], deps);
    assert.strictEqual(out.unreadable.length, 0);
    const b = out.battles[0];
    assert.strictEqual(b.v0, r.result.outcome);
    assert.strictEqual(b.recorded, r.result.outcome);
    assert.strictEqual(b.parity, true);
    assert.strictEqual(b.paramsMatch, true);
    assert.ok(b.powerA > 0 && b.powerB > 0, "power of the sides from the power table");
    assert.deepStrictEqual([b.lossesA, b.lossesB], [2, 3]);
    const drift = JSON.parse(JSON.stringify(r.result));
    drift.diagnostics.paramsHash = "other";
    const out2 = auditBattles([rowOf(input, drift)], deps);
    assert.strictEqual(out2.battles[0].parity, true);
    assert.strictEqual(out2.battles[0].paramsMatch, false);
  });

  test("BFA2 battleFrontAudit: V1 = station points capped (or null), V2 = null, no garrison -> V0 = V1 = V2", () => {
    const s = setup();
    const seen = [];
    const spy = (input, catalog, params) => {
      seen.push(input.garrison === null ? null : input.garrison.strength);
      return resolver.resolve(input, catalog, params);
    };
    const input = scenarios.makeInput({ seed: 3, objective: "capture", garrison: { side: "B", strength: 10120 },
      sideA: [{ ships: [{ hullGroup: "cruiser", typeId: null, count: 10 }] }],
      sideB: [{ ships: [{ hullGroup: "cruiser", typeId: null, count: 10 }] }] });
    const rec = resolver.resolve(input, s.catalog, s.params);
    assert.strictEqual(rec.ok, true);
    const row = rowOf(input, rec.result);

    const withStations = auditBattles([row], { ...s, resolve: spy,
      stationPoints: (sys, f) => (sys === input.systemId && f === FACTION_B ? 80 : 0) });
    assert.deepStrictEqual(seen, [10120, 80, null], "V0 stored, V1 = 80 station points, V2 null");
    const b = withStations.battles[0];
    assert.strictEqual(b.v1GarrisonStrength, 80);
    assert.strictEqual(b.stationPtsNow, 80);
    assert.strictEqual(b.influencePart, 10040);
    assert.strictEqual(b.garrisonSide, "B");
    assert.strictEqual(b.approx, true);
    assert.ok(!b.v1.startsWith("REFUSED:") && !b.v2.startsWith("REFUSED:"), `${b.v1} ${b.v2}`);

    seen.length = 0;
    const noStations = auditBattles([row], { ...s, resolve: spy, stationPoints: () => 0 });
    assert.deepStrictEqual(seen, [10120, null, null], "no station points -> V1 garrison null");
    assert.strictEqual(noStations.battles[0].v1GarrisonStrength, null);
    assert.strictEqual(noStations.battles[0].v1, noStations.battles[0].v2);

    seen.length = 0;
    const aOnly = auditBattles([row], { ...s, resolve: spy,
      stationPoints: (sys, f) => (sys === input.systemId && f === FACTION_A ? 80 : 0) });
    assert.deepStrictEqual(seen, [10120, 80, null], "V1 = side A station points");
    assert.deepStrictEqual([aOnly.battles[0].v1GarrisonSide, aOnly.battles[0].v1GarrisonStrength,
      aOnly.battles[0].stationPtsNow], ["A", 80, 0]);

    const inputA = scenarios.makeInput({ seed: 4, objective: "capture", garrison: { side: "A", strength: 40 },
      sideA: [{ ships: [{ hullGroup: "cruiser", typeId: null, count: 10 }] }],
      sideB: [{ ships: [{ hullGroup: "cruiser", typeId: null, count: 10 }] }] });
    const recA = resolver.resolve(inputA, s.catalog, s.params);
    assert.strictEqual(recA.ok, true);
    const gSeen = [];
    const gSpy = (inp, catalog, params) => {
      gSeen.push(inp.garrison);
      return resolver.resolve(inp, catalog, params);
    };
    const pts = (a, b) => (sys, f) => (sys !== inputA.systemId ? 0 : f === FACTION_A ? a : f === FACTION_B ? b : 0);
    const bWins = auditBattles([rowOf(inputA, recA.result)], { ...s, resolve: gSpy, stationPoints: pts(200, 80) });
    assert.deepStrictEqual(gSeen[1], { side: "B", factionId: FACTION_B, strength: 80 });
    assert.strictEqual(bWins.battles[0].v1GarrisonSide, "B");
    gSeen.length = 0;
    auditBattles([rowOf(inputA, recA.result)], { ...s, resolve: gSpy, stationPoints: pts(200, 0) });
    assert.deepStrictEqual(gSeen[1], { side: "A", factionId: FACTION_A, strength: 40 }, "A points capped at 40");

    seen.length = 0;
    const plain = scenarios.SCENARIOS.similar(5);
    const r = resolver.resolve(plain, s.catalog, s.params);
    const none = auditBattles([rowOf(plain, r.result)], { ...s, resolve: spy, stationPoints: () => 80 });
    assert.deepStrictEqual(seen, [null], "no garrison -> one resolve");
    const n = none.battles[0];
    assert.strictEqual(n.v0, n.v1);
    assert.strictEqual(n.v0, n.v2);
    assert.strictEqual(n.approx, false);
    assert.strictEqual(n.garrisonSide, null);
  });

  test("BFA3 battleFrontAudit: stationPointsOf counts ONLINE stations of the faction only, needs the siege flags", () => {
    const on = { siege: { enabled: true, stationGarrisonEnabled: true } };
    const SYS = 30000142;
    const stations = [
      { systemId: SYS, ownerFactionId: FACTION_B, kind: "npc", structureFamily: null, state: "ONLINE" },
      { systemId: SYS, ownerFactionId: FACTION_B, kind: "upwell", structureFamily: "astrahus", state: "ONLINE" },
      { systemId: SYS, ownerFactionId: FACTION_B, kind: "upwell", structureFamily: "fortizar", state: "REINFORCED" },
      { systemId: SYS, ownerFactionId: 500001, kind: "npc", structureFamily: null, state: "ONLINE" },
      { systemId: SYS + 1, ownerFactionId: FACTION_B, kind: "npc", structureFamily: null, state: "ONLINE" },
    ];
    assert.strictEqual(stationPointsOf(stations, SYS, FACTION_B, on), 120);
    assert.strictEqual(stationPointsOf(stations, SYS, 500003, on), 0);
    assert.strictEqual(stationPointsOf(stations, SYS, FACTION_B,
      { siege: { enabled: true, stationGarrisonEnabled: false } }), 0);
    assert.strictEqual(stationPointsOf(stations, SYS, FACTION_B,
      { siege: { enabled: false, stationGarrisonEnabled: true } }), 120);
  });

  test("BFA5 battleFrontAudit: V1 garrison = the garrison of contactService in mode off on the same stations", () => {
    const SANSHA = 500019;
    const OWNER = 500010;
    const SYS = 30000142;
    const st = (owner, kind, family, state = "ONLINE", sys = SYS) => ({ stationId: `st-${owner}-${family}-${sys}`,
      systemId: sys, ownerFactionId: owner, kind, structureFamily: family, state });
    const cases = {
      bOnly: [st(OWNER, "npc", null), st(SANSHA, "upwell", "astrahus", "REINFORCED")],
      aOnly: [st(SANSHA, "npc", null), st(OWNER, "npc", null, "ONLINE", SYS + 1)],
      both: [st(SANSHA, "npc", null), st(OWNER, "upwell", "astrahus")],
      none: [st(OWNER, "upwell", "fortizar", "REINFORCED")],
    };
    const config = { siege: { enabled: false, stationGarrisonEnabled: true } };
    const small = [{ hullGroup: "frigate", count: 2 }];
    const runtimeOf = (stations) => {
      const created = [];
      const fleets = [{ fleetId: "fa", factionId: SANSHA, state: "STAGED", shipCount: 5, operationId: null,
        version: 1, composition: small }, { fleetId: "fb", factionId: OWNER, state: "IDLE", shipCount: 5,
        operationId: null, version: 1, composition: small }];
      const svc = createContactService({
        store: { transaction: (name, fn) => ({ ok: true, value: fn({ inTransaction: true }) }) },
        scheduler: { enqueue: () => ({ ok: true }) },
        battleRepository: { createBattle: (tx, spec) => {
          created.push(spec);
          return { ok: true, battleId: "b1", duplicate: false };
        } },
        cooldownRepository: { listForSystem: () => ({ ok: true, cooldowns: new Map() }) },
        fleetRepository: { listFleetsInSystem: () => ({ ok: true, fleets, nextAfterFleetId: null }) },
        getGraph: () => ({ getSystem: (id) => ({ systemId: id, secClass: "nullsec" }) }),
        worldRepository: { getSystem: () => ({ ok: true, system: { influence: [] } }) },
        resolverVersion: "internal-v1",
        settings: { engageDelayMs: 1000, recontactCooldownMs: 1, contactScanMaxFleets: 64, maxResolutionMs: 20,
          stationGarrisonEnabled: config.siege.stationGarrisonEnabled, structureLiveCombatEnabled: false,
          influenceGarrison: "off" },
        getStations: () => ({ getMode: () => "ready", repository: { listStationsInSystem: () => ({ ok: true,
          records: stations.filter((x) => x.systemId === SYS) }) } }),
        limits: { maxFleetsPerSide: 8, maxSettlementRows: 450 }, isHostile: () => true,
        bump: () => {}, logger: { log() {} }, isActive: () => true });
      const r = svc.onContactCheck({ payload: { systemId: SYS, at: 0, triggerFleetId: "fa" } });
      assert.strictEqual(r.outcome, "BATTLE", JSON.stringify(r));
      assert.ok(r.effect({ inTransaction: true }, { idempotencyKey: "contact:k" }).ok);
      return created[0].garrison;
    };
    const auditOf = (stations) => {
      const seen = [];
      const input = { battleId: "x", systemId: SYS, objective: "capture", sideA: { factionId: SANSHA, fleets: [] },
        sideB: { factionId: OWNER, fleets: [] }, garrison: { side: "B", factionId: OWNER, strength: 10120 } };
      auditBattles([rowOf(input, { outcome: "DRAW", diagnostics: { paramsHash: "h" } })], {
        catalog: null, params: { paramsHash: "h" }, powerTable: {},
        resolve: (inp) => {
          seen.push(inp.garrison);
          return { ok: true, result: { outcome: "DRAW" } };
        },
        stationPoints: (sys, f) => stationPointsOf(stations, sys, f, config) });
      return seen[1];
    };
    const got = {};
    const want = {};
    for (const [k, stations] of Object.entries(cases)) {
      got[k] = auditOf(stations);
      want[k] = runtimeOf(stations);
    }
    assert.deepStrictEqual(got, want);
    assert.deepStrictEqual(want.bOnly, { side: "B", factionId: OWNER, strength: 80 });
    assert.deepStrictEqual(want.aOnly, { side: "A", factionId: SANSHA, strength: 80 });
    assert.deepStrictEqual(want.both, { side: "B", factionId: OWNER, strength: 40 });
    assert.strictEqual(want.none, null);
  });

  test("BFA4 battleFrontAudit: gateOf gives every verdict", () => {
    const flip = [bat("B", "B_WIN"), bat("B", "A_WIN"), bat("B", "DRAW"), bat("B", "BOTH_RETREAT")];
    assert.strictEqual(gateOf(flip).verdict, VERDICT.FLIP_OFF);
    const drift = flip.map((b, i) => (i < 2 ? { ...b, paramsMatch: false } : b));
    assert.strictEqual(gateOf(drift).verdict, VERDICT.KEEP_PARAMS_DRIFT);
    const notGarrison = [bat("B", "B_WIN"), bat("B", "B_WIN"), bat("B", "B_WIN"), bat("B", "B_WIN")];
    const g = gateOf(notGarrison);
    assert.strictEqual(g.verdict, VERDICT.KEEP_NOT_GARRISON);
    assert.strictEqual(g.bWinShareV1, 1);
    const tooWeak = [bat("B", "A_WIN"), bat("B", "A_WIN"), bat("B", "A_WIN"), bat("B", "DRAW")];
    assert.strictEqual(gateOf(tooWeak).verdict, VERDICT.KEEP_TOO_WEAK);
    assert.strictEqual(gateOf([bat("A", "B_WIN"), bat(null, "A_WIN")]).verdict, VERDICT.NO_DATA);
    assert.strictEqual(gateOf([]).verdict, VERDICT.NO_DATA);
    const refusedOnly = gateOf([bat("B", "REFUSED:INPUT_INVALID")]);
    assert.strictEqual(refusedOnly.verdict, VERDICT.NO_DATA);
    assert.strictEqual(refusedOnly.gRefusedV1, 1);
    const mixed = [...notGarrison.map((b) => ({ ...b, influencePart: 0 })), ...flip];
    assert.strictEqual(gateOf(mixed, undefined, (b) => b.influencePart > 0).verdict, VERDICT.FLIP_OFF);
  });
};
