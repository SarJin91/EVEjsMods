"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const S = require("../../lib/shipAi/schema");
const { OPEN_BATTLE_STATES } = require("../../lib/battle/schema");
const { toolsFor, TOOL_BY_NAME } = require("../../lib/shipAi/tools/catalog");
const { createToolDeps } = require("../../lib/shipAi/tools/deps");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const PLAYER = 9001;
const SYS = [30000001, 30000002, 30000003, 30000004, 30000005];
const ISOLATED = 30000099;
const REGION_A = 10000001;
const REGION_B = 10000002;
const AMARR = 500003;
const SANSHA = 500019;

const base = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_SHIP_AI_ENABLED: "1" } }).config;
function settings(over) {
  const r = S.shipAiModelSettingsOf({ shipAi: { ...base.shipAi, minIntervalMs: 0, ...(over || {}) } });
  assert.ok(r.ok, JSON.stringify(r));
  return r.settings;
}

function lineGraph(routes) {
  const names = new Map([...SYS.map((id, i) => [id, `Sys${i}`]), [ISOLATED, "Lonely"]]);
  return {
    hasSystem: (id) => names.has(id),
    getSystem: (id) => (names.has(id) ? { name: names.get(id), regionId: id === SYS[4] || id === ISOLATED
      ? REGION_B : REGION_A, security: 0.5, secClass: "highsec" } : undefined),
    getNeighbors: (id) => {
      const i = SYS.indexOf(id);
      return i < 0 ? [] : [SYS[i - 1], SYS[i + 1]].filter(Boolean);
    },
    getRegionName: () => "Region",
    getSystemIds: () => [...names.keys()],
    findRoute: (from, to) => {
      routes.push([from, to]);
      const a = SYS.indexOf(from);
      const b = SYS.indexOf(to);
      return a < 0 || b < 0 ? { ok: false, reason: "NO_ROUTE" } : { ok: true, jumps: Math.abs(a - b) };
    },
  };
}

function depsOf(o) {
  const adapter = {
    readPresence: () => ({ ok: true, characters: [{ characterId: PLAYER, systemId: SYS[0], state: "space" }] }),
    readFactionNames: () => ({ ok: true, names: new Map([[AMARR, "Amarr Empire"], [SANSHA, "Sansha's Nation"]]) }),
    listNpcStationsInSystem: () => ({ ok: true, stations: [] }),
  };
  const graph = o.graph;
  return createToolDeps({ adapter, sensors: null, S: o.S, getGraph: () => ({ getGraph: () => ({ ok: true, graph }) }),
    getFleets: () => null, getWorld: () => null, getStore: () => o.store, getBattles: o.getBattles, db: null });
}
const fakeStore = (txOf, names) => ({ transaction: (name, fn) => {
  names.push(name);
  return { ok: true, value: fn(txOf()) };
} });
const toolOf = (S2, name) => toolsFor(S2).find((t) => t.name === name);
const battle = (state, mode, fleetIds) => ({ battleId: `b-${state}`, state, mode, fleetIds,
  input: { sideA: { factionId: AMARR, fleets: [{ fleetId: fleetIds[0] }] },
    sideB: { factionId: SANSHA, fleets: [{ fleetId: fleetIds[1] }] } } });

module.exports = ({ test }) => {
  test("DR41 battles_nearby: jumps, more, only OPEN_BATTLE_STATES, no system beyond threatMaxJumps, no fleet ID", () => {
    const S2 = settings({ toolMaxRows: 2, threatMaxJumps: 2 });
    const calls = [];
    const repository = { listOpenInSystem: (tx, systemId, opts) => {
      calls.push({ tx, systemId, opts });
      if (systemId === SYS[1]) return { ok: true, battles: [battle("LIVE", "LIVE_EVEJS", ["f-1", "f-2"])] };
      if (systemId === SYS[2]) {
        return { ok: true, battles: [battle("PENDING", "VIRTUAL", ["f-3", "f-4"]),
          battle("SETTLED", "VIRTUAL", ["f-5", "f-6"]), battle("CLAIMED", "VIRTUAL", ["f-7", "f-8"])] };
      }
      return { ok: true, battles: [] };
    } };
    const names = [];
    const deps = depsOf({ S: S2, graph: lineGraph([]), store: fakeStore(() => "TX", names),
      getBattles: () => ({ repository }) });
    const r = toolOf(S2, "battles_nearby").run({ playerId: PLAYER, deps, S: S2, nowMs: () => 1 });
    assert.deepStrictEqual(r, { ok: true, data: { maxJumps: 2, battles: [
      { system: "Sys1", jumps: 1, state: "LIVE", mode: "LIVE_EVEJS" },
      { system: "Sys2", jumps: 2, state: "PENDING", mode: "VIRTUAL" }], more: 1 } });
    assert.deepStrictEqual(names, ["shipAi.tools.battles"], "one read transaction");
    assert.deepStrictEqual(calls.map((c) => c.systemId).sort(), SYS.slice(0, 3), "SYS[3] is 3 jumps away");
    for (const c of calls) {
      assert.strictEqual(c.tx, "TX");
      assert.deepStrictEqual(c.opts, { states: [...OPEN_BATTLE_STATES], limit: 3 });
    }
    const direct = deps.battlesIn([SYS[2]], 3);
    assert.deepStrictEqual(direct.bySystem.get(SYS[2]).map((b) => [b.state, b.sides]), [["PENDING", 2], ["CLAIMED", 2]]);
    assert.ok(!/f-\d/.test(JSON.stringify(r)), "no fleet ID");
  });

  test("DR42 invasions: real listOpen on a fake tx, nearest first, no route = null last; > rows x 4 = region", () => {
    const rowsOf = (systems) => systems.map((sys, i) => ({ invasion_id: `inv-${i}`, faction_id: i % 2 ? AMARR : SANSHA,
      beachhead_system_id: sys, state: i === 0 ? "STAGING" : "ACTIVE", open: 1, plan_json: "{}" }));
    let rows = rowsOf([SYS[3], ISOLATED, SYS[1]]);
    const sql = [];
    const tx = { prepare: (text) => ({ all: (...params) => {
      sql.push([text, params]);
      return rows;
    } }) };
    const routes = [];
    const names = [];
    const S2 = settings({ toolMaxRows: 2 });
    const deps = depsOf({ S: S2, graph: lineGraph(routes), store: fakeStore(() => tx, names), getBattles: () => null });
    const r = toolOf(S2, "invasions").run({ playerId: PLAYER, deps, S: S2, nowMs: () => 1 });
    assert.deepStrictEqual(r, { ok: true, data: { invasions: [
      { faction: "Sansha's Nation", system: "Sys1", jumps: 1, state: "ACTIVE" },
      { faction: "Sansha's Nation", system: "Sys3", jumps: 3, state: "STAGING" }], more: 1 } });
    assert.deepStrictEqual(names, ["shipAi.tools.invasions"]);
    assert.ok(/FROM world_invasions WHERE open = 1/.test(sql[0][0]) && /LIMIT \?/.test(sql[0][0]), sql[0][0]);
    assert.deepStrictEqual(sql[0][1], [2 * 4 + 1], "toolMaxRows x 4 + 1 rows");
    assert.strictEqual(routes.length, 3);
    const S1 = settings({ toolMaxRows: 2 });
    const all = depsOf({ S: S1, graph: lineGraph([]), store: fakeStore(() => tx, []), getBattles: () => null });
    rows = rowsOf([ISOLATED, SYS[2], SYS[4], SYS[1]]);
    const full = toolOf(S1, "invasions").run({ playerId: PLAYER, deps: all, S: S1, nowMs: () => 1 });
    assert.deepStrictEqual(full.data.invasions.map((x) => x.jumps), [1, 2], "the isolated one sorts last");

    const S3 = settings({ toolMaxRows: 1 });
    const routes3 = [];
    const deps3 = depsOf({ S: S3, graph: lineGraph(routes3), store: fakeStore(() => tx, []), getBattles: () => null });
    rows = rowsOf([SYS[4], ISOLATED, SYS[3], SYS[1], SYS[2]]);
    const many = toolOf(S3, "invasions").run({ playerId: PLAYER, deps: deps3, S: S3, nowMs: () => 1 });
    assert.deepStrictEqual(many, { ok: true, data: { invasions: [
      { faction: "Sansha's Nation", system: "Sys3", jumps: null, state: "ACTIVE" }], more: 4 } });
    assert.strictEqual(routes3.length, 0, "no route above toolMaxRows x 4");
  });

  test("DR43 no battle getter / unavailable facade = BATTLES_UNAVAILABLE, the v1 tools still answer", () => {
    const S2 = settings();
    for (const getBattles of [undefined, () => null, () => ({ repository: null })]) {
      const deps = depsOf({ S: S2, graph: lineGraph([]), store: fakeStore(() => "TX", []), getBattles });
      assert.deepStrictEqual(toolOf(S2, "battles_nearby").run({ playerId: PLAYER, deps, S: S2, nowMs: () => 1 }),
        { ok: false, reason: "BATTLES_UNAVAILABLE" });
      const loc = TOOL_BY_NAME.get("location").run({ playerId: PLAYER, deps, S: S2, nowMs: () => 1 });
      assert.strictEqual(loc.ok, true, JSON.stringify(loc));
      assert.strictEqual(loc.data.name, "Sys0");
    }
    const noStore = depsOf({ S: S2, graph: lineGraph([]), store: null, getBattles: () => null });
    assert.deepStrictEqual(noStore.invasionsOpen(3), { ok: false, reason: "INVASIONS_UNAVAILABLE" });
  });
};
