"use strict";

const assert = require("node:assert");
const path = require("node:path");

const config = require("../../../config");
const { settingsOf } = require("../../../lib/strategy/transit");
const { chancePermilleOf, classPermilleOf, hostileCrossingsOfLeg, routeContactPermille,
  EXEMPT_REASONS, decideCheckpoint, chainsAfter, picketDefensesOf, nextHostileOf, shipCountOf, STALE_REASONS,
  FINAL_STALE, KINDS } = require("../../../lib/strategy/transit/rules");

const MOD_DIR = path.resolve(__dirname, "..", "..", "..");

function settings(over = {}) {
  const c = JSON.parse(JSON.stringify(config.resolveConfig({ modDir: MOD_DIR, env: {} }).config));
  c.transit = { ...c.transit, ...over };
  const s = settingsOf(c);
  assert.ok(s.ok, JSON.stringify(s));
  return s.settings;
}

const SUB1 = Object.freeze({ basePermille: 80, controlPermille: 80, maxChancePermille: 400 });

module.exports = ({ test }) => {
  const S = settings(SUB1);

  test("TR1 rules: chancePermilleOf formula and caps; classPermilleOf order; routeContactPermille", () => {
    const e = (influence, garrison = 0, gateSentries = 0) => ({ influence, garrison, gateSentries });
    assert.strictEqual(chancePermilleOf(null, S), 0);
    assert.deepStrictEqual([chancePermilleOf(e(33.3), S), chancePermilleOf(e(37.5), S), chancePermilleOf(e(0), S)],
      [106, 110, 80]);
    assert.deepStrictEqual([chancePermilleOf(e(0, 2500), S), chancePermilleOf(e(0, 10000), S)], [130, 180]);
    assert.deepStrictEqual([chancePermilleOf(e(0, 0, 2), S), chancePermilleOf(e(0, 0, 10), S)], [130, 180]);
    assert.strictEqual(chancePermilleOf(e(100, 10000, 10), S), 360);
    assert.strictEqual(chancePermilleOf(e(100, 10000, 10), { ...S, basePermille: 300 }), 400);
    assert.strictEqual(chancePermilleOf(e(100, 10000, 10), { ...S, maxChancePermille: 0 }), 0);

    const cls = (fleetRole, shipCount) => classPermilleOf({ fleetRole, shipCount }, S);
    assert.deepStrictEqual([cls("hunter", 6), cls("capsuleer", 40), cls("invasion", 5), cls("invasion", 6),
      cls("invasion", 29), cls("invasion", 30), cls("invasion", null), cls("invasion", 2.5)],
    [250, 250, 500, 1000, 1000, 300, 1000, 1000]);

    assert.deepStrictEqual([routeContactPermille([]), routeContactPermille([1000]), routeContactPermille([0, 0]),
      routeContactPermille(Array(10).fill(160))], [0, 1000, 0, 825]);
  });

  test("TR2 hostileCrossingsOfLeg: filter, start/target never, exempt order, truncation, at and chance", () => {
    const OWN = 10;
    const FRIEND = 20;
    const FOE = 30;
    const entry = (systemId, controllerFactionId, chanceBase) => ({ systemId, controllerFactionId,
      secClass: "nullsec", influence: 0, garrison: 0, gateSentries: 0, chanceBase });
    const index = new Map([[1, entry(1, FOE, 300)], [2, entry(2, OWN, 300)], [3, entry(3, FRIEND, 300)],
      [4, entry(4, FOE, 200)], [7, entry(7, FOE, 300)], [41, entry(41, FOE, 100)], [42, entry(42, FOE, 150)],
      [43, entry(43, FOE, 100)]]);
    const get = (id) => index.get(id) || null;
    const isHostile = (a, b) => a !== b && b !== FRIEND;
    const mover = (over = {}) => ({ factionId: OWN, fleetRole: "invasion", shipCount: 30, operationType: "invasion",
      wormholes: false, ...over });
    const leg = { systems: [1, 2, 3, 4, 6, 7], departAt: 1000, jumpMs: 50 };
    const r = hostileCrossingsOfLeg(leg, get, isHostile, mover(), S);
    assert.deepStrictEqual(r, { crossings: [{ systemIndex: 3, systemId: 4, at: 1000 + 3 * 50,
      chancePermille: Math.floor(200 * 300 / 1000) }], truncated: false, exempt: null });
    assert.strictEqual(hostileCrossingsOfLeg(leg, get, isHostile, mover({ shipCount: 12 }), S).crossings[0]
      .chancePermille, 200);

    const ex = (m, s = S) => hostileCrossingsOfLeg(leg, get, isHostile, m, s);
    const sx = { ...S, exemptFactionIds: [OWN], exemptRoles: ["invasion"] };
    assert.deepStrictEqual([ex(mover({ wormholes: true, operationType: null }), sx).exempt,
      ex(mover({ operationType: null }), sx).exempt, ex(mover({ operationType: null }),
        { ...S, exemptRoles: ["invasion"] }).exempt, ex(mover({ operationType: null })).exempt,
      ex(mover({ operationType: "return" })).exempt], ["WORMHOLE", "FACTION", "ROLE", "NO_OPERATION", "OPERATION"]);
    assert.deepStrictEqual([...EXEMPT_REASONS], ["WORMHOLE", "FACTION", "ROLE", "NO_OPERATION", "OPERATION"]);
    assert.deepStrictEqual(ex(mover({ wormholes: true })), { crossings: [], truncated: false, exempt: "WORMHOLE" });

    const long = { systems: [1, 41, 42, 43, 7], departAt: 0, jumpMs: 10 };
    const t = hostileCrossingsOfLeg(long, get, isHostile, mover({ shipCount: 12 }), { ...S, listenerMaxSystems: 2 });
    assert.deepStrictEqual(t, { crossings: [{ systemIndex: 1, systemId: 41, at: 10, chancePermille: 100 },
      { systemIndex: 2, systemId: 42, at: 20, chancePermille: 150 }], truncated: true, exempt: null });
    assert.strictEqual(hostileCrossingsOfLeg(long, get, isHostile, mover(), S).truncated, false);
    assert.deepStrictEqual(hostileCrossingsOfLeg({ systems: [1, 7], departAt: 0, jumpMs: 1 }, get, isHostile, mover(),
      S), { crossings: [], truncated: false, exempt: null });
  });

  test("TR7 rules: decideCheckpoint closed set in step order, chainsAfter, deterministic roll; picketDefensesOf "
    + "chancePermilleOf extra; nextHostileOf; shipCountOf", () => {
    const S2 = settings({ haltsPerControllerHour: 2 });
    const leg = { v: 1, mode: "travel", systems: [1, 4, 5, 6, 7], departAt: 1000, jumpMs: 100, arriveAt: 1400,
      graphVersion: 1, observed: false };
    const target = { state: "TRAVELLING", legSeq: 3, route: leg, factionId: 10, fleetRole: "invasion" };
    const p = { at: 1200, check: 0, fleetId: "f1", legSeq: 3, systemId: 5, systemIndex: 2 };
    const base = { p, target, exemptReason: null, controllerFactionId: 30, secClassOk: true, hostile: true,
      observed: false, cooldown: false, battleReady: true, chancePermille: 1000, defenders: 0, moverEvasive: false,
      haltsThisHour: 0, worldSeed: 11 };
    const dec = (over) => decideCheckpoint({ ...base, ...over }, S2);
    const roll = dec({}).roll;
    const k = Math.floor(roll * 1000);
    const rows = [
      [{ target: null }, "STALE", "TARGET_GONE"],
      [{ target: { ...target, state: "DESTROYED" } }, "STALE", "TARGET_GONE"],
      [{ target: { ...target, state: "STAGED" }, exemptReason: "ROLE" }, "STALE", "LEG_MOVED"],
      [{ target: { ...target, legSeq: 4 } }, "STALE", "LEG_MOVED"],
      [{ target: { ...target, route: { ...leg, v: 2, constraints: {}, wormholeEdges: [{ i: 0, key: "w" }] } } },
        "STALE", "LEG_HAS_WORMHOLES"],
      [{ p: { ...p, systemIndex: 3 }, exemptReason: "ROLE" }, "STALE", "NOT_CROSSING"],
      [{ p: { ...p, at: 1300 } }, "STALE", "NOT_CROSSING"],
      [{ exemptReason: "OPERATION", controllerFactionId: null }, "STALE", "EXEMPT"],
      [{ controllerFactionId: null, hostile: false }, "STALE", "NOT_CONTROLLED"],
      [{ secClassOk: false }, "STALE", "NOT_CONTROLLED"],
      [{ hostile: false, observed: true }, "STALE", "NOT_HOSTILE"],
      [{ observed: true, cooldown: true }, "OBSERVED", undefined],
      [{ cooldown: true, chancePermille: 0 }, "COOLDOWN", undefined],
      [{ chancePermille: k, haltsThisHour: 9 }, "PASS", undefined],
      [{ chancePermille: k + 1, haltsThisHour: 2, battleReady: false }, "BUDGET", undefined],
      [{ battleReady: false }, "STALE", "BATTLE_UNAVAILABLE"],
      [{}, "HALT", undefined],
    ];
    const got = rows.map(([over]) => {
      const d = dec(over);
      return [d.action, d.reason];
    });
    assert.deepStrictEqual(got, rows.map(([, a, r]) => [a, r]));
    assert.deepStrictEqual(decideCheckpoint({ ...base, haltsThisHour: 0 }, { ...S2, haltsPerControllerHour: 0 })
      .action, "BUDGET");
    assert.strictEqual(decideCheckpoint({ ...base, haltsThisHour: 1 }, { ...S2, maxRowsPerTransaction: 1 }).action,
      "BUDGET");
    assert.deepStrictEqual([...STALE_REASONS], ["TARGET_GONE", "LEG_MOVED", "LEG_HAS_WORMHOLES", "NOT_CROSSING", "EXEMPT",
      "NOT_CONTROLLED", "NOT_HOSTILE", "BATTLE_UNAVAILABLE"]);
    assert.deepStrictEqual([...FINAL_STALE], STALE_REASONS.slice(0, 5));
    assert.deepStrictEqual([...KINDS], ["PICKET", "CONTACT"]);
    assert.deepStrictEqual([dec({}).kind, dec({ defenders: 1 }).kind, dec({ defenders: 1, moverEvasive: true }).kind],
      ["PICKET", "CONTACT", "PICKET"]);
    assert.deepStrictEqual(dec({}), { action: "HALT", roll, chancePermille: 1000, kind: "PICKET" });
    assert.strictEqual(dec({}).roll, roll);
    assert.notStrictEqual(dec({ worldSeed: 12 }).roll, roll);
    assert.notStrictEqual(dec({ p: { ...p, fleetId: "f2" } }).roll, roll);
    const chains = rows.map(([over]) => chainsAfter(dec(over)));
    assert.deepStrictEqual(chains, [false, false, false, false, false, false, false, false, true, true, true, true,
      true, true, true, true, false]);

    const pd = picketDefensesOf(30001, 500029, 120, S2);
    assert.deepStrictEqual([pd.attackerRetreatLossPermille, pd.entries.length], [150, 3]);
    assert.deepStrictEqual(pd.entries[2], { sentryId: "tp:30001:2", itemId: 30001 * 1000 + 503, typeId: 16690,
      ownerKind: "faction", ownerId: 500029, hp: 20000, ehp: 20000, dps: 60, signature: 400, designSig: 125 });
    assert.deepStrictEqual([picketDefensesOf(1, 2, 0, S2).entries.length, picketDefensesOf(1, 2, 1000, S2).entries
      .length, picketDefensesOf(1, 2, 1000, { ...S2, picketMaxBatteries: 3 }).entries.length], [1, 8, 3]);

    const e = { influence: 100, garrison: 0, gateSentries: 0 };
    assert.deepStrictEqual([chancePermilleOf(e, S), chancePermilleOf(e, S, 150), chancePermilleOf(e, S, 500),
      chancePermilleOf(e, S, -5)], [160, 310, 400, 160]);

    const long = { systems: [1, 2, 3, 4, 5, 6, 9], departAt: 0, jumpMs: 10 };
    const states = new Map([[2, { controllerFactionId: 10, securityClass: "nullsec" }],
      [3, { controllerFactionId: 30, securityClass: "lowsec" }], [4, { controllerFactionId: null,
        securityClass: "nullsec" }], [5, { controllerFactionId: 30, securityClass: "nullsec" }],
      [6, { controllerFactionId: 30, securityClass: "nullsec" }]]);
    const hostileOf = (a, b) => a !== b;
    assert.deepStrictEqual(nextHostileOf(long, 0, states, hostileOf, 10, S2), { systemIndex: 4, systemId: 5, at: 40 });
    assert.deepStrictEqual(nextHostileOf(long, 4, states, hostileOf, 10, S2), { systemIndex: 5, systemId: 6, at: 50 });
    assert.strictEqual(nextHostileOf(long, 5, states, hostileOf, 10, S2), null);
    assert.strictEqual(nextHostileOf(long, 0, states, hostileOf, 10, { ...S2, listenerMaxSystems: 3 }), null);

    assert.deepStrictEqual([shipCountOf([{ count: 4 }, { count: 6 }]), shipCountOf([]), shipCountOf(null),
      shipCountOf([{ count: 2 }, { count: 1.5 }])], [10, 0, null, null]);
  });
};
