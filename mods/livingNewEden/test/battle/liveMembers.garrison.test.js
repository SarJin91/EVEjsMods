"use strict";

const assert = require("node:assert");

const { planLiveMembers, planGarrisonMembers, splitMembers, garrisonProblem, buildLiveResult, memberKeyOf,
  GARRISON_HULL_GROUPS } = require("../../lib/battle/liveMembers");
const { GARRISON_FLEET_ID, MAX_GARRISON_PROXIES } = require("../../lib/battle/schema");
const { validateResult } = require("../../lib/battle/contract");
const { HULL_CLASS_BY_GROUP } = require("../../lib/adapter/data/liveProfiles");
const config = require("../../config");

const BATTLE_ID = "battle_mvwonw0h_00xs_58wa";
const GURISTAS = 500010;
const SANSHA = 500019;

function input(garrison) {
  return {
    v: 1, battleId: BATTLE_ID, seed: 12345, systemId: 30001269, environment: "nullsec", objective: "capture",
    garrison, resolverVersion: "internal-v1", maxResolutionMs: 20,
    sideA: { factionId: SANSHA, fleets: [{ fleetId: "fleet_a", factionId: SANSHA, fleetRole: "invasion",
      doctrineId: null, supplyState: 100, composition: [{ hullGroup: "cruiser", typeId: null, count: 2 }] }] },
    sideB: { factionId: GURISTAS, fleets: [{ fleetId: "fleet_b", factionId: GURISTAS, fleetRole: "garrison",
      doctrineId: null, supplyState: 100, composition: [{ hullGroup: "frigate", typeId: null, count: 1 }] }] },
  };
}

const GARRISON = Object.freeze({ side: "B", factionId: GURISTAS, strength: 80 });
const OPTS = Object.freeze({ maxShips: 6, pointsPerShip: 25, hullGroup: "cruiser", room: 40 });

function rowsOf(inp, proxies, dead) {
  const fleet = planLiveMembers(inp, { maxShips: 256 }).members;
  return [...fleet, ...proxies].map((m) => ({ ...m, profileId: "prof_test",
    state: dead(m) ? "DESTROYED" : "SPAWNED" }));
}

const battleOf = (inp) => ({ input: inp, updatedAt: 1760000000000 });

module.exports = ({ test }) => {
  test("GLV1 planGarrisonMembers: garrison null -> []; strength 80 / pointsPerShip 25 -> 4 proxies (fleetId garrison, "
    + "side/faction of the garrison, ordinal 1..4); maxShips 2 -> 2; maxShips 0 -> []; k > room -> LIVE_TOO_LARGE; "
    + "bad opts -> INPUT_INVALID", () => {
    const got = {
      none: planGarrisonMembers(input(null), OPTS),
      zero: planGarrisonMembers(input({ ...GARRISON, strength: 0 }), OPTS),
      four: planGarrisonMembers(input(GARRISON), OPTS),
      capped: planGarrisonMembers(input(GARRISON), { ...OPTS, maxShips: 2 }),
      off: planGarrisonMembers(input(GARRISON), { ...OPTS, maxShips: 0 }),
      tooLarge: planGarrisonMembers(input(GARRISON), { ...OPTS, room: 3 }),
      badHull: planGarrisonMembers(input(GARRISON), { ...OPTS, hullGroup: "industrial" }).reason,
      badMax: planGarrisonMembers(input(GARRISON), { ...OPTS, maxShips: MAX_GARRISON_PROXIES + 1 }).reason,
      badInput: planGarrisonMembers({ ...input(GARRISON), v: 99 }, OPTS).reason,
    };
    const proxy = (ordinal) => ({ memberKey: `garrison:cruiser:0:${ordinal}`, fleetId: GARRISON_FLEET_ID, side: "B",
      factionId: GURISTAS, hullGroup: "cruiser", typeId: null, ordinal });
    assert.deepStrictEqual(got, {
      none: { ok: true, members: [], ships: 0 },
      zero: { ok: true, members: [], ships: 0 },
      four: { ok: true, members: [1, 2, 3, 4].map(proxy), ships: 4 },
      capped: { ok: true, members: [1, 2].map(proxy), ships: 2 },
      off: { ok: true, members: [], ships: 0 },
      tooLarge: { ok: false, reason: "LIVE_TOO_LARGE", ships: 4, limit: 3 },
      badHull: "INPUT_INVALID", badMax: "INPUT_INVALID", badInput: "INPUT_INVALID",
    });
    assert.strictEqual(memberKeyOf(GARRISON_FLEET_ID, "cruiser", null, 1), "garrison:cruiser:0:1");
  });

  test("GLV2 buildLiveResult with proxies: every fleet ship DESTROYED + 1 proxy alive -> B_WIN (DRAW without it), "
    + "ship lists only the input groups, validateResult ok, garrisonShips/garrisonLost; side B and all proxies dead -> "
    + "A_WIN; bad proxies -> MEMBERS_INVALID; "
    + "no proxies -> diagnostics exactly as before", () => {
    const inp = input(GARRISON);
    const proxies = planGarrisonMembers(inp, OPTS).members;
    const allButLast = (m) => !(m.fleetId === GARRISON_FLEET_ID && m.ordinal === 4);
    const held = buildLiveResult(battleOf(inp), rowsOf(inp, proxies, allButLast), { at: 1760000090000, reason: "END" });
    assert.strictEqual(held.ok, true, JSON.stringify(held));
    assert.deepStrictEqual([held.result.outcome, held.result.destroyedShips, held.result.survivingShips,
      held.result.diagnostics], ["B_WIN", [{ fleetId: "fleet_a", hullGroup: "cruiser", typeId: null, count: 2 },
      { fleetId: "fleet_b", hullGroup: "frigate", typeId: null, count: 1 }], [],
      { source: "live", exit: "END", garrisonShips: 4, garrisonLost: 3 }]);
    const noProxyRows = rowsOf(inp, [], allButLast);
    assert.strictEqual(buildLiveResult(battleOf(input(null)), noProxyRows, { at: 1760000090000, reason: "END" })
      .result.outcome, "DRAW", "the same fleet losses without proxies");
    assert.strictEqual(validateResult(inp, held.result, { maxResultBytes: 65536 }).ok, true);
    const fallen = buildLiveResult(battleOf(inp), rowsOf(inp, proxies, (m) => m.side === "B"),
      { at: 1760000090000, reason: "EXIT" });
    assert.deepStrictEqual([fallen.result.outcome, fallen.result.diagnostics.garrisonLost], ["A_WIN", 4]);

    const bad = (mutate) => {
      const rows = rowsOf(inp, proxies, () => false);
      mutate(rows);
      const r = buildLiveResult(battleOf(inp), rows, { at: 1760000090000, reason: "END" });
      return r.ok ? "ok" : r.reason;
    };
    const proxyAt = (rows, ordinal) => rows.find((m) => m.fleetId === GARRISON_FLEET_ID && m.ordinal === ordinal);
    assert.deepStrictEqual({
      side: bad((rows) => Object.assign(proxyAt(rows, 1), { side: "A" })),
      faction: bad((rows) => Object.assign(proxyAt(rows, 1), { factionId: SANSHA })),
      gap: bad((rows) => Object.assign(proxyAt(rows, 4), { ordinal: 5, memberKey: "garrison:cruiser:0:5" })),
      hull: bad((rows) => Object.assign(proxyAt(rows, 2), { hullGroup: "frigate", memberKey: "garrison:frigate:0:2" })),
      type: bad((rows) => Object.assign(proxyAt(rows, 2), { typeId: 587 })),
      noGarrison: buildLiveResult(battleOf(input(null)), rowsOf(input(null), proxies, () => false),
        { at: 1760000090000, reason: "END" }).reason,
    }, { side: "MEMBERS_INVALID", faction: "MEMBERS_INVALID", gap: "MEMBERS_INVALID", hull: "MEMBERS_INVALID",
      type: "MEMBERS_INVALID", noGarrison: "MEMBERS_INVALID" });

    const plain = buildLiveResult(battleOf(inp), rowsOf(inp, [], (m) => m.side === "B"),
      { at: 1760000090000, reason: "END" });
    assert.deepStrictEqual([plain.result.outcome, plain.result.diagnostics], ["A_WIN", { source: "live", exit: "END" }]);
  });

  test("GLV3 splitMembers keeps the order; garrisonProblem: no proxies -> null, proxies without a garrison / above "
    + "MAX_GARRISON_PROXIES -> problem; the count and hull group come from the proxies (any k, any combat group)", () => {
    const inp = input(GARRISON);
    const proxies = planGarrisonMembers(inp, { ...OPTS, maxShips: 3, hullGroup: "battleship" }).members;
    const fleet = planLiveMembers(inp, { maxShips: 256 }).members;
    const split = splitMembers([proxies[0], ...fleet, proxies[1]]);
    assert.deepStrictEqual([split.fleet, split.garrison], [fleet, [proxies[0], proxies[1]]]);
    const many = Array.from({ length: MAX_GARRISON_PROXIES + 1 }, (_, i) => ({ ...proxies[0], ordinal: i + 1,
      memberKey: memberKeyOf(GARRISON_FLEET_ID, "battleship", null, i + 1) }));
    assert.deepStrictEqual([garrisonProblem(inp, []), garrisonProblem(inp, proxies),
      typeof garrisonProblem(input(null), proxies), typeof garrisonProblem(inp, many)], [null, null, "string", "string"]);
    assert.ok(!GARRISON_HULL_GROUPS.includes("industrial") && GARRISON_HULL_GROUPS.includes("capital"));
  });

  test("GLV4 config: battle.garrisonLive.* defaults (enabled false, 6, 25, cruiser), liveHullGroup list = keys of "
    + "HULL_CLASS_BY_GROUP = GARRISON_HULL_GROUPS, maxShips max = MAX_GARRISON_PROXIES; bad hull group -> warning, "
    + "enabled without materialization -> warning", () => {
    const resolved = config.resolveConfig({ modDir: require("node:path").resolve(__dirname, "..", ".."), env: {} });
    assert.deepStrictEqual(resolved.config.battle.garrisonLive, { enabled: false, maxShips: 6, pointsPerShip: 25,
      hullGroup: "cruiser" });
    const { CAPITAL_HULL_GROUPS } = require("../../lib/fleets/schema");
    const garrisonKeys = Object.keys(HULL_CLASS_BY_GROUP).filter((g) => !CAPITAL_HULL_GROUPS.includes(g)).sort();
    assert.deepStrictEqual([...GARRISON_HULL_GROUPS].sort(), garrisonKeys);
    assert.ok(CAPITAL_HULL_GROUPS.every((g) => !Object.prototype.hasOwnProperty.call(HULL_CLASS_BY_GROUP, g)));
    assert.deepStrictEqual([...config.LIVE_HULL_GROUPS].sort(), garrisonKeys.filter((g) => g !== "capital"));
    const legacy = config.resolveConfig({ modDir: require("node:path").resolve(__dirname, "..", ".."),
      env: { EVEJS_LNE_BATTLE_GARRISON_LIVE_HULL_GROUP: "capital" } });
    assert.strictEqual(legacy.config.battle.garrisonLive.hullGroup, "cruiser");
    const row = config.SCHEMA.find((r) => r.key === "battle.garrisonLive.maxShips");
    assert.strictEqual(row.max, MAX_GARRISON_PROXIES);
    const bad = config.resolveConfig({ modDir: require("node:path").resolve(__dirname, "..", ".."),
      env: { EVEJS_LNE_BATTLE_GARRISON_LIVE_HULL_GROUP: "industrial", EVEJS_LNE_BATTLE_GARRISON_LIVE_ENABLED: "1" } });
    assert.strictEqual(bad.config.battle.garrisonLive.hullGroup, "cruiser");
    assert.ok(bad.warnings.some((w) => w.includes("EVEJS_LNE_BATTLE_GARRISON_LIVE_HULL_GROUP")), bad.warnings.join("\n"));
    assert.ok(bad.warnings.some((w) => w.startsWith("battle.garrisonLive.enabled with modules.materialization=false")),
      bad.warnings.join("\n"));
  });
};
