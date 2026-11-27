"use strict";

const assert = require("node:assert");

const ko = require("../../lib/adapter/killObservation");
const ships = require("../../lib/adapter/situationShips");

const SYS = 30000144;

module.exports = ({ test }) => {
  test("SI4 situation ship -> skipped SITUATION, world listeners not called, onKill gets role and situationId", () => {
    ships.resetSituationShipsForTests();
    try {
      assert.deepStrictEqual(ships.markSituationShips([9001, 9002], { situationId: "sabc-1", role: "pirate", cap: 4 }),
        { ok: true, marked: 2, evicted: 0 });
      ships.markSituationShips([9003], { situationId: "sabc-1", role: "victim", cap: 4 });
      const world = [];
      const seen = [];
      const spy = (name) => ({ onNpcKill: (k) => { world.push(name); return { ok: true, k }; } });
      const before = ko.killObservationCounters().situationVictimSeen;
      const deps = { situationShipOf: ships.situationShipOf, isSituationShip: ko.isSituationShip,
        getSituations: () => ({ onNpcKill: (e) => { seen.push(e); return { ok: true, counted: true }; } }),
        getLiberation: () => spy("liberation"), getStandings: () => spy("standings"),
        getPlayerActivity: () => spy("playerActivity"), getFrontJobs: () => spy("frontJobs"),
        resolveVictimFactionID: () => 500010 };
      const r = ko.observeKill({ applied: true }, { itemID: 9001, systemID: SYS, operatorKind: "lneSituation" },
        140000001, { systemID: SYS, nowMs: 1763500000000 }, deps);
      assert.deepStrictEqual(r, { skipped: "SITUATION", situation: { ok: true, counted: true } });
      assert.deepStrictEqual(seen, [{ characterId: 140000001, entityId: 9001, role: "pirate", situationId: "sabc-1",
        systemId: SYS, atMs: 1763500000000 }]);
      assert.deepStrictEqual(world, [], "no world listener");
      assert.strictEqual(ko.killObservationCounters().situationVictimSeen, before + 1);
      ko.observeKill(null, { itemID: 9003, systemID: SYS }, 140000002, { nowMs: 5 }, deps);
      assert.strictEqual(seen[1].role, "victim");
      assert.deepStrictEqual(ko.observeKill(null, { itemID: 9002, systemID: SYS }, 0, { nowMs: 5 }, deps),
        { skipped: "SITUATION", situation: { skipped: "NO_KILLER" } });
      assert.deepStrictEqual(ko.observeKill(null, { itemID: 9999, systemID: SYS, operatorKind: "lneSituation" },
        140000001, { nowMs: 5 }, deps), { skipped: "SITUATION" });
      assert.strictEqual(seen.length, 2);
      assert.deepStrictEqual(world, []);
      const calls = [];
      const original = function original(entity) { calls.push(entity.itemID); return { applied: true, tag: 7 }; };
      const w = ko.wrapNpcKillStandingLoss(original, { ...deps });
      assert.ok(w.ok);
      assert.deepStrictEqual(w.wrapped({ itemID: 9002, systemID: SYS }, 140000003, { nowMs: 9 }),
        { applied: true, tag: 7 });
      assert.deepStrictEqual([calls, seen.length, seen[2].situationId], [[9002], 3, "sabc-1"]);
      assert.deepStrictEqual(world, []);
      ships.markSituationShips([9004, 9005], { situationId: "sabc-2", role: "victim", cap: 4 });
      assert.strictEqual(ships.situationShipOf(9001), null, "evicted first");
      assert.deepStrictEqual(ships.forgetSituationShips([9005, 1]), { ok: true, forgotten: 1 });
      assert.strictEqual(ships.situationShipOf(9005), null);
    } finally {
      ships.resetSituationShipsForTests();
    }
  });
};
