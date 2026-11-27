"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const config = require("../../config");
const { structureOf, withStructureOutcome } = require("../../lib/battle/structureOutcome");
const { validateInput, validateResult, hashInput, HASH_LIMITS } = require("../../lib/battle/contract");
const { STRUCTURE_TYPE_IDS } = require("../../lib/stations/data/structureTypes");
const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
const { harness: H } = require("./settlement.test");
const { harness: C } = require("./contacts.test");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const COMP2 = Object.freeze([{ hullGroup: "cruiser", count: 2 }]);

const fleetResult = (outcome) => Object.freeze({ battleId: "battle_x", resolver: "internal-v1", outcome,
  destroyedShips: [], escapedShips: [], survivingShips: [], objectiveAchieved: outcome === "A_WIN",
  estimatedDurationSec: 10, confidence: 1, diagnostics: { source: "live", exit: "STRUCTURE_DESTROYED" } });

module.exports = ({ test, skip }) => {
  test("SO1 withStructureOutcome (pure): no structureId -> same object; destroyed + side B -> objective "
    + "true, outcome B_WIN kept; side A -> false; structure undefined -> structureDestroyed false", () => {
    const plain = { battleId: "battle_x", garrison: null };
    const withB = { ...plain, structureId: 1030000000001, structureTypeId: 35832, structureSide: "B" };
    const withA = { ...withB, structureSide: "A" };
    const r = fleetResult("B_WIN");
    const out = [];
    out.push(withStructureOutcome(r, plain, { destroyed: true }) === r);
    out.push(structureOf(plain), structureOf({ ...withB, structureSide: "C" }));
    out.push(structureOf(withB));
    const b = withStructureOutcome(r, withB, { destroyed: true });
    out.push([b.outcome, b.objectiveAchieved, b.structureDestroyed, b.structureId, b.structureTypeId]);
    const a = withStructureOutcome(fleetResult("A_WIN"), withA, { destroyed: true });
    out.push([a.outcome, a.objectiveAchieved, a.structureDestroyed]);
    const none = withStructureOutcome(fleetResult("A_WIN"), withB, undefined);
    out.push([none.outcome, none.objectiveAchieved, none.structureDestroyed]);
    const alive = withStructureOutcome(r, withB, { destroyed: false });
    out.push([alive.outcome, alive.objectiveAchieved, alive.structureDestroyed]);
    out.push(r.structureDestroyed === undefined, Object.isFrozen(r));
    assert.deepStrictEqual(out, [true, null, null,
      { structureId: 1030000000001, structureTypeId: 35832, side: "B" },
      ["B_WIN", true, true, 1030000000001, 35832],
      ["A_WIN", false, true],
      ["A_WIN", true, false],
      ["B_WIN", false, false],
      true, true]);
  });

  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("SLC-07 contract: structure keys optional and strict (all three or none, garrison null) "
    + "a battle without them keeps its input hash; vendor fact: mod Upwell types not of the family sov", () => {
    const env = C.createEnv(driver, { resolver: C.seamResolver(() => "DRAW") });
    try {
      const T = (fn) => {
        const r = env.store.transaction("test.so", fn);
        assert.ok(r.ok, JSON.stringify(r));
        return r.value;
      };
      const a = env.newFleet("so-a", C.SANSHA, H.S.N5, COMP2);
      const b = env.newFleet("so-b", C.GURISTAS, H.S.N5, COMP2);
      const side = (factionId, id) => ({ factionId, fleets: [{ fleetId: id, expectedVersion: env.fleet(id).version }] });
      const spec = { systemId: H.S.N5, environment: "nullsec", objective: "destroy", resolverVersion: "internal-v1",
        maxResolutionMs: 20, garrison: null, sideA: side(C.SANSHA, a), sideB: side(C.GURISTAS, b),
        structureId: 999001, structureTypeId: 35832, structureSide: "B" };
      const created = T((db) => env.battle.repository.createBattle(db, spec, "so:1:battle"));
      assert.strictEqual(created.ok, true, JSON.stringify(created));
      const stored = JSON.parse(JSON.stringify(T((db) => env.battle.repository.getBattle(db, created.battleId))
        .battle.input));
      assert.deepStrictEqual([stored.structureId, stored.structureSide], [999001, "B"]);
      const { structureId: _sid, structureTypeId: _tid, structureSide: _side, ...plain } = stored;
      const L = HASH_LIMITS;
      const out = [];
      out.push(hashInput(plain) === hashInput({ ...plain, structureId: null, structureTypeId: null,
        structureSide: null }));
      out.push(Object.prototype.hasOwnProperty.call(validateInput(plain, L).input, "structureId"));
      out.push(hashInput(plain) !== hashInput(stored));
      out.push(validateInput({ ...plain, foo: 1 }, L).detail);
      out.push(validateInput({ ...plain, structureId: 0 }, L).detail);
      out.push(validateInput({ ...stored, structureSide: "C" }, L).detail);
      out.push(validateInput({ ...stored, structureSide: null }, L).detail);
      out.push(validateInput({ ...stored, garrison: { side: "B", factionId: C.GURISTAS, strength: 5 } }, L).detail);
      const input = validateInput(stored, L).input;
      const base = { battleId: created.battleId, resolver: input.resolverVersion, outcome: "DRAW", destroyedShips: [],
        escapedShips: [], survivingShips: [...input.sideA.fleets, ...input.sideB.fleets].flatMap((f) =>
          f.composition.map((e) => ({ fleetId: f.fleetId, hullGroup: e.hullGroup, typeId: e.typeId, count: e.count }))),
        objectiveAchieved: false, estimatedDurationSec: 0, confidence: 1, diagnostics: {} };
      const R = { maxResultBytes: 131072 };
      out.push(Object.keys(validateResult(input, base, R).result).includes("structureDestroyed"));
      out.push(validateResult(input, { ...base, structureDestroyed: true, structureId: 999001 }, R)
        .result.structureDestroyed);
      out.push(validateResult(input, { ...base, extra: 1 }, R).detail);
      out.push(validateResult(input, { ...base, structureDestroyed: "yes" }, R).detail);
      assert.deepStrictEqual(out, [true, false, true, "input: field foo", "structureId", "structureSide",
        "structure: structureId, structureTypeId, structureSide all or none", "structure: garrison must be null",
        false, true, "result: field extra", "structureDestroyed"]);
    } finally {
      env.close();
    }

    const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
    assert.ok(found.ok, JSON.stringify(found));
    const text = fs.readFileSync(path.join(found.srcDir, "services", "structure", "structureConstants.js"), "utf8");
    const sov = [...text.matchAll(/(\d+): \{\s*typeID: \d+,\s*family: STRUCTURE_FAMILY\.SOV,/g)].map((m) => Number(m[1]));
    assert.ok(sov.includes(32226) && sov.length >= 4, `sov presets: ${sov.join(",")}`);
    assert.deepStrictEqual(Object.values(STRUCTURE_TYPE_IDS).filter((id) => sov.includes(id)), []);
  });

  test("SO6 resolveConfig warnings of battle.structureLiveCombat: needs materialization + native "
    + "destruction; end monitor off -> CONTESTED_TIMEOUT warning (also with a short timeout); timeout >= siege wait "
    + "-> warning; flag off -> none", () => {
    const P = "EVEJS_LNE_";
    const warningsOf = (env) => config.resolveConfig({ modDir: MOD_DIR, env }).warnings
      .filter((w) => w.includes("CONTESTED_TIMEOUT") || w.startsWith("battle.structureLiveCombat.enabled with"));
    const on = { [`${P}BATTLE_STRUCTURE_LIVE_COMBAT_ENABLED`]: "1" };
    const full = { ...on, [`${P}MATERIALIZATION_ENABLED`]: "1", [`${P}SIEGE_NATIVE_DESTRUCTION_ENABLED`]: "1" };
    const deps = "battle.structureLiveCombat.enabled with modules.materialization=false "
      + "siege.nativeDestructionEnabled=false - a destroyed structure is recreated by the projection";
    const monitorOff = "battle.structureLiveCombat.enabled with battle.liveEndMonitor.enabled=false - a LIVE battle "
      + "has no end timeout, a siege may end REPELLED CONTESTED_TIMEOUT during it";
    const timeout = "battle.liveEndMonitor.timeoutMs=300000 not below siege.recheckMs x siege.maxWaitRounds=0 - a "
      + "siege may end REPELLED CONTESTED_TIMEOUT during a LIVE battle";
    assert.deepStrictEqual({
      off: warningsOf({ [`${P}BATTLE_LIVE_END_MONITOR_ENABLED`]: "0", [`${P}SIEGE_MAX_WAIT_ROUNDS`]: "0" }),
      deps: warningsOf(on),
      clean: warningsOf(full),
      monitorOff: warningsOf({ ...full, [`${P}BATTLE_LIVE_END_MONITOR_ENABLED`]: "0" }),
      monitorOffShortWait: warningsOf({ ...full, [`${P}BATTLE_LIVE_END_MONITOR_ENABLED`]: "0",
        [`${P}SIEGE_MAX_WAIT_ROUNDS`]: "0" }),
      timeout: warningsOf({ ...full, [`${P}SIEGE_MAX_WAIT_ROUNDS`]: "0" }),
    }, { off: [], deps: [deps], clean: [], monitorOff: [monitorOff], monitorOffShortWait: [monitorOff],
      timeout: [timeout] });
  });
};
