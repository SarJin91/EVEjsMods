"use strict";

const assert = require("node:assert");

const { createContactService, declineOf } = require("../../lib/battle/contactService");
const { createHostility } = require("../../lib/battle/data/hostility");
const { GROUPS } = require("../../lib/battle/data/strengthCatalog");
const { expandStrengthGroups } = require("../../lib/battle/strength");
const { capitalPowerOverlayOf } = require("../../lib/battle/data/capitalStrengthRows");
const { buildPowerTable } = require("../../lib/strategy/ai/strength");

const SANSHA = 500019;
const AMARR = 500003;
const SYSTEM = 30000142;
const FRIEND = 30000143;
const ENEMY = 30000144;
const HOME = 30000150;
const AT = 1000000;
const LIMITS = Object.freeze({ maxFleetsPerSide: 8, maxSettlementRows: 450 });
const TABLE = Object.freeze({ frigate: 10, cruiser: 30, battleship: 80 });
const RETREAT_LIMITS = Object.freeze({ retreatSearchMaxJumps: 2, retreatSearchMaxSystems: 10, retreatMaxCandidates: 3 });

const comp = (hullGroup, count) => [{ hullGroup, typeId: null, count }];
const fleetA = (fleetId, composition, extra = {}) => ({ fleetId, factionId: SANSHA, fleetRole: "patrol",
  operationId: "op1", state: "STAGED", currentSystemId: SYSTEM, homeSystemId: null, version: 4, shipCount: 2,
  composition, ...extra });
const fleetB = (fleetId, composition) => ({ fleetId, factionId: AMARR, fleetRole: "patrol", operationId: null,
  state: "IDLE", currentSystemId: SYSTEM, homeSystemId: SYSTEM, version: 2, shipCount: 6, composition });
const op = (operationType) => ({ operationId: "op1", operationType, state: "ACTIVE", targetSystemId: SYSTEM,
  objective: "raid" });

function rig({ fleets, operation = op("raid"), settings = {}, getStrategy, planInTx } = {}) {
  const created = [];
  const plans = [];
  const counters = {};
  const svc = createContactService({
    store: { transaction: (name, fn) => ({ ok: true, value: fn({ inTransaction: true }) }) },
    scheduler: { enqueue: () => ({ ok: true, duplicate: false }) },
    battleRepository: { createBattle: (tx, spec) => {
      created.push(spec);
      return { ok: true, battleId: "b1", duplicate: false };
    } },
    cooldownRepository: { listForSystem: () => ({ ok: true, cooldowns: new Map() }) },
    fleetRepository: {
      getOperation: () => ({ ok: true, operation }),
      listFleetsInSystem: () => ({ ok: true, fleets, nextAfterFleetId: null }),
    },
    getGraph: () => ({ getSystem: (id) => ({ systemId: id, secClass: "lowsec" }),
      getNeighbors: (id) => (id === SYSTEM ? [FRIEND, ENEMY] : []) }),
    worldRepository: { limits: { maxBatchReadIds: 50 },
      getSystems: (tx, ids) => ({ ok: true, systems: ids.map((systemId) => ({ systemId,
        controllerFactionId: systemId === FRIEND ? SANSHA : AMARR })) }) },
    resolverVersion: "internal-v1",
    settings: { engageDelayMs: 1000, recontactCooldownMs: 1, contactScanMaxFleets: 64, maxResolutionMs: 20,
      influenceGarrison: "off", ...settings },
    travel: { planInTx: (tx, input, key, opts) => {
      plans.push({ input, key, opts });
      return planInTx ? planInTx(input) : { ok: true, duplicate: false };
    } },
    getStrategy, powerPerPoint: 0,
    limits: LIMITS, isHostile: createHostility(),
    bump: (name, n = 1) => {
      counters[name] = (counters[name] || 0) + n;
    },
    logger: { log() {} }, isActive: () => true });
  const check = () => svc.onContactCheck({ payload: { systemId: SYSTEM, at: AT, triggerFleetId: "a1" } });
  return { svc, created, plans, counters, check };
}

const ON = Object.freeze({ declineEnabled: true, declineRatioPermille: 500, retreatLimits: RETREAT_LIMITS });
const strategyOf = (powerTable) => () => ({ powerTable });
const base = (operation, fleetsA, fleetsB, gB = 0, powerPerPoint = 0) => ({ fleetsA, fleetsB, gB, operation,
  systemId: SYSTEM, table: TABLE, powerPerPoint, ratioPermille: 500 });

module.exports = ({ test }) => {
  test("DC1 declineOf: 2 frigates vs 6 cruisers -> decline, 6 vs 6 cruisers -> battle", () => {
    const weak = declineOf(base(op("raid"), [fleetA("a1", comp("frigate", 2))], [fleetB("b1", comp("cruiser", 6))]));
    const even = declineOf(base(op("raid"), [fleetA("a1", comp("cruiser", 6))], [fleetB("b1", comp("cruiser", 6))]));
    assert.deepStrictEqual([weak, even], [{ decline: true, powerA: 20, powerB: 180 }, { decline: false }]);
  });

  test("DC2 a garrison of B raises powerB: no decline -> decline", () => {
    const A = [fleetA("a1", comp("cruiser", 3))];
    const B = [fleetB("b1", comp("cruiser", 1))];
    assert.deepStrictEqual([declineOf(base(op("raid"), A, B)).decline,
      declineOf(base(op("raid"), A, B, 10, 20))], [false, { decline: true, powerA: 90, powerB: 230 }]);
  });

  test("DC3 operation defense, or a side A fleet IDLE -> the battle as before", () => {
    const B = [fleetB("b1", comp("cruiser", 6))];
    const defense = rig({ fleets: [fleetA("a1", comp("frigate", 2)), ...B], operation: op("defense"),
      settings: ON, getStrategy: strategyOf(TABLE) });
    const idle = declineOf(base(op("raid"), [fleetA("a1", comp("frigate", 2), { state: "IDLE" })], B));
    assert.deepStrictEqual([defense.check().outcome, idle], ["BATTLE", { decline: false }]);
  });

  test("DC4 effect: retreat to the friendly system, home after TOO_FAR: a partial stuck fights",
    () => {
      const r = rig({ fleets: [fleetA("a1", comp("frigate", 1), { homeSystemId: HOME }), fleetA("a2", comp("frigate", 1)),
        fleetB("b1", comp("cruiser", 6))], settings: ON, getStrategy: strategyOf(TABLE),
      planInTx: (input) => (input.targetSystemId === FRIEND ? { ok: false, reason: "TOO_FAR" } : { ok: true }) });
      const out = r.check();
      assert.strictEqual(out.outcome, "DECLINED");
      const res = out.effect({ inTransaction: true }, { idempotencyKey: "K" });
      const plan = (fleetId, targetSystemId) => ({ input: { fleetId, targetSystemId, at: AT, expectedVersion: 4 },
        key: `K:decline:${fleetId}`, opts: { mode: "retreat", chained: true } });
      assert.deepStrictEqual([res, r.plans, r.created.map((s) => [s.sideA.fleets, s.sideB.fleets]),
        r.counters["contacts.declined"], r.counters["contacts.declineFleetsRetreated"],
        r.counters["contacts.declineStuck"], r.counters["contacts.found"]],
      [{ ok: true, declined: 1, battleId: "b1" }, [plan("a1", FRIEND), plan("a1", HOME), plan("a2", FRIEND)],
        [[[{ fleetId: "a2", expectedVersion: 4 }], [{ fleetId: "b1", expectedVersion: 2 }]]], 1, 1, 1, 1]);
    });

  test("DC6 all side A stuck -> the battle of the plan, declineStuck = n, no declined", () => {
    const fleets = [fleetA("a1", comp("frigate", 1)), fleetA("a2", comp("frigate", 1)),
      fleetB("b1", comp("cruiser", 6))];
    const pre = rig({ fleets });
    pre.check().effect({ inTransaction: true }, { idempotencyKey: "K" });
    const r = rig({ fleets, settings: ON, getStrategy: strategyOf(TABLE),
      planInTx: () => ({ ok: false, reason: "TOO_FAR" }) });
    const out = r.check();
    const res = out.effect({ inTransaction: true }, { idempotencyKey: "K" });
    assert.deepStrictEqual([out.outcome, res, r.created, r.counters["contacts.declineStuck"],
      r.counters["contacts.declined"], r.counters["contacts.declineFleetsRetreated"], r.counters["contacts.found"]],
    ["DECLINED", { ok: true, declined: 0, battleId: "b1" }, pre.created, 2, undefined, undefined, 1]);
  });

  test("DC5 flag off = the previous spec, no getStrategy; the BS overlay table flips the decision", () => {
    const fleets = [fleetA("a1", comp("battleship", 2)), fleetB("b1", comp("cruiser", 6))];
    const pre = rig({ fleets });
    const calls = { off: 0, on: 0 };
    const counting = (key) => () => {
      calls[key] += 1;
      return { powerTable: TABLE };
    };
    const off = rig({ fleets, settings: { declineEnabled: false, declineRatioPermille: 500 },
      getStrategy: counting("off") });
    const on = rig({ fleets, settings: ON, getStrategy: counting("on") });
    pre.check().effect({ inTransaction: true }, { idempotencyKey: "K" });
    off.check().effect({ inTransaction: true }, { idempotencyKey: "K" });
    on.check();
    assert.deepStrictEqual([off.created, off.counters, calls.off, calls.on > 0],
      [pre.created, pre.counters, 0, true]);
    const tableOf = (s) => buildPowerTable(expandStrengthGroups(GROUPS, null, capitalPowerOverlayOf(s)));
    const plain = rig({ fleets, settings: ON, getStrategy: strategyOf(tableOf({})) });
    const bs = rig({ fleets, settings: ON, getStrategy: strategyOf(tableOf({ battleshipPowerCalibrated: true,
      battleshipPowerPermille: 520 })) });
    const none = rig({ fleets, settings: ON, getStrategy: () => null });
    assert.deepStrictEqual([plain.check().outcome, bs.check().outcome, none.check().outcome,
      none.counters["contacts.declineNoPower"]], ["BATTLE", "DECLINED", "BATTLE", 1]);
  });
};
