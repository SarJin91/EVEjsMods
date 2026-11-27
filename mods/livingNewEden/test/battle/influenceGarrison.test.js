"use strict";

const assert = require("node:assert");

const { createContactService } = require("../../lib/battle/contactService");
const { harness: H } = require("./settlement.test");
const { harness: C } = require("./contacts.test");

const { S, FACTION_A: SANSHA, FACTION_B: OWNER } = H;
const SMALL = Object.freeze([{ hullGroup: "frigate", count: 2 }]);
const ENGAGE_MS = 60000;

const station = (owner, state = "ONLINE") => ({ stationId: `st-${owner}-${state}`, kind: "npc", state,
  structureFamily: null, ownerFactionId: owner });

function contactOf(opts = {}) {
  const created = [];
  const counters = {};
  let worldReads = 0;
  const fleets = [{ fleetId: "fa", factionId: SANSHA, state: "STAGED", shipCount: 5, operationId: null, version: 1,
    composition: SMALL }, { fleetId: "fb", factionId: OWNER, state: "IDLE", shipCount: 5, operationId: null, version: 1,
    composition: SMALL }];
  const settings = { engageDelayMs: 1000, recontactCooldownMs: 1, contactScanMaxFleets: 64, maxResolutionMs: 20,
    stationGarrisonEnabled: true, structureLiveCombatEnabled: false };
  if (opts.mode !== undefined) settings.influenceGarrison = opts.mode;
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
    worldRepository: { getSystem: () => {
      worldReads += 1;
      return { ok: true, system: { influence: [{ factionId: OWNER, garrisonStrength: 30 }] } };
    } },
    resolverVersion: "internal-v1", settings,
    getStations: () => ({ getMode: () => "ready",
      repository: { listStationsInSystem: () => ({ ok: true, records: opts.stations || [] }) } }),
    limits: { maxFleetsPerSide: 8, maxSettlementRows: 450 }, isHostile: () => true,
    bump: (name, n = 1) => {
      counters[name] = (counters[name] || 0) + n;
    },
    logger: { log() {} }, isActive: () => true });
  const r = svc.onContactCheck({ payload: { systemId: S.N5, at: 0, triggerFleetId: "fa" } });
  assert.strictEqual(r.outcome, "BATTLE", JSON.stringify(r));
  assert.ok(r.effect({ inTransaction: true }, { idempotencyKey: "contact:k" }).ok);
  return { garrison: created[0].garrison, worldReads, counters };
}

module.exports = ({ test, skip }) => {
  test("BIG1 legacy: influence 30 + ONLINE npc station of B -> garrison B 110 (absent and \"legacy\"), no "
    + "influenceGarrisonOff counter", () => {
    const want = { side: "B", factionId: OWNER, strength: 110 };
    const absent = contactOf({ stations: [station(OWNER)] });
    const legacy = contactOf({ mode: "legacy", stations: [station(OWNER)] });
    assert.deepStrictEqual([absent.garrison, legacy.garrison, absent.worldReads, legacy.worldReads],
      [want, want, 1, 1]);
    assert.strictEqual(legacy.counters["contacts.influenceGarrisonOff"], undefined);
  });

  test("BIG2 off: B station only (80), A station only -> side A 80, no station -> null; no influence "
    + "read; counter contacts.influenceGarrisonOff per created battle", () => {
    const b = contactOf({ mode: "off", stations: [station(OWNER)] });
    const a = contactOf({ mode: "off", stations: [station(SANSHA)] });
    const none = contactOf({ mode: "off" });
    assert.deepStrictEqual({ b: b.garrison, a: a.garrison, none: none.garrison,
      reads: [b.worldReads, a.worldReads, none.worldReads],
      off: [b.counters["contacts.influenceGarrisonOff"], none.counters["contacts.influenceGarrisonOff"]] }, {
      b: { side: "B", factionId: OWNER, strength: 80 }, a: { side: "A", factionId: SANSHA, strength: 80 }, none: null,
      reads: [0, 0, 0], off: [1, 1] });
  });

  const driver = H.loadDriver();
  const name5 = "BIG5 an open battle created with legacy (garrison 110) resolves after a restart with off "
    + "from its stored input (input.garrison.strength 110)";
  if (!driver.ok) {
    skip(name5, `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }
  test(name5, async () => {
    const seen = [];
    const resolver = C.seamResolver((input) => {
      seen.push(input.garrison);
      return "DRAW";
    });
    const world = { repository: {
      getSystem: () => ({ ok: true, system: { influence: [{ factionId: C.SANSHA, garrisonStrength: 30 },
        { factionId: C.GURISTAS, garrisonStrength: 30 }] } }),
      getSystems: (tx, ids) => ({ ok: true, systems: [], missing: ids }) } };
    const getStations = () => ({ getMode: () => "ready", repository: { listStationsInSystem: () => ({ ok: true,
      records: [station(C.SANSHA), station(C.GURISTAS)] }) } });
    const env = C.createEnv(driver, { resolver, world, getStations,
      config: { "battle.influenceGarrison": "legacy", "siege.stationGarrisonEnabled": true } });
    try {
      env.newFleet("a", C.SANSHA, S.N5);
      env.newFleet("b", C.GURISTAS, S.N5);
      const t0 = env.clock.now();
      env.check(S.N5, "big5");
      await env.drive(t0);
      const battles = env.battles();
      assert.strictEqual(battles.length, 1, JSON.stringify(battles));
      assert.strictEqual(battles[0].state, "PENDING");
      assert.strictEqual(JSON.parse(battles[0].input_json).garrison.strength, 110);
      assert.strictEqual(seen.length, 0, "not resolved before the flip");
      env.cfg.battle.influenceGarrison = "off";
      env.restart();
      await env.drive(t0 + ENGAGE_MS + 1);
      assert.strictEqual(seen.length, 1, JSON.stringify(seen));
      assert.strictEqual(seen[0].strength, 110, JSON.stringify(seen[0]));
      assert.notStrictEqual(env.q("SELECT state FROM battle_records WHERE battle_id = ?", battles[0].battle_id)[0]
        .state, "PENDING");
    } finally {
      env.close();
    }
  });
};
