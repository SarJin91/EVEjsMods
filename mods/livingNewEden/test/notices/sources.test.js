"use strict";

const assert = require("node:assert");

const { classifyEntries, endedSiegeIds, KINDS, AGGREGATE_TYPES } = require("../../lib/notices/sources");
const OCC = require("../../lib/world/occupation/schema");
const { killKey } = require("../../lib/world/liberation/schema");
const { createJournal } = require("../../lib/persistence/journal");
const { createSiegeRepository } = require("../../lib/stations/siege/siegeRepository");
const { createIdGenerator } = require("../../lib/util/ids");
const { createRng } = require("../../lib/util/rng");
const { createManualClock } = require("../../lib/util/clock");
const F = require("./sourceFixture");
const { loadDriver, withStore } = require("./storeHelper");

const T0 = 1760000000000;
const SYS = 30001001;
const CHAR = 90000077;
const ALL = new Set(KINDS);

let nextId = 100;
function worldEntry(change, extra = {}) {
  nextId += 1;
  return { journalId: nextId, key: `w:${nextId}`, aggregateType: "world_system", aggregateId: change.systemId,
    eventType: change.reason, createdAt: T0, payload: F.worldPayload(change), ...extra };
}

const mark = (state, controller, occupier = null) => ({ state, controller, occupier });
const ctx = (extra = {}) => ({ now: T0 + 1000, maxEventAgeMs: 3600000, kinds: ALL, sieges: new Map(), ...extra });

module.exports = ({ test, skip }) => {
  test("NS1 world rows from the real machine and changeSet: kinds, marks, silent create, STALE, LIBERATION_KILL", () => {
    const p = F.occupationSteps(SYS);
    const change = (state, reason = "OCCUPATION_PHASE_CHANGE") => ({ systemId: SYS, expectedVersion: 3, reason, state });
    const marks = new Map([[SYS, mark(OCC.CONTESTED, F.DEFENDER, F.ATTACKER)]]);

    const invade = worldEntry(change(p.invade));
    let r = classifyEntries([invade], marks, ctx());
    assert.deepStrictEqual(r.events.map((e) => [e.kind, e.eventKey, e.attacker, e.defender, e.systemId, e.at]),
      [["ATTACK_STARTED", `j:${invade.journalId}:ATTACK_STARTED`, F.ATTACKER, F.DEFENDER, SYS, T0]]);
    assert.deepStrictEqual(r.marks.get(SYS), mark(OCC.INVASION, F.DEFENDER, F.ATTACKER));

    const capture = worldEntry(change(p.capture));
    r = classifyEntries([invade, capture], marks, ctx());
    assert.deepStrictEqual(r.events.map((e) => [e.kind, e.attacker, e.defender]),
      [["ATTACK_STARTED", F.ATTACKER, F.DEFENDER], ["SYSTEM_CAPTURED", F.ATTACKER, F.DEFENDER]]);
    assert.deepStrictEqual(r.marks.get(SYS), mark(OCC.OCCUPIED, F.ATTACKER, F.ATTACKER));

    const invasionMarks = new Map([[SYS, mark(OCC.INVASION, F.DEFENDER, F.ATTACKER)]]);
    r = classifyEntries([worldEntry(change(p.release, "OCCUPATION_RELEASE"))], invasionMarks, ctx());
    assert.deepStrictEqual(r.events.map((e) => [e.kind, e.defender]), [["SYSTEM_RELEASED", F.DEFENDER]]);
    assert.deepStrictEqual(r.marks.get(SYS), mark(OCC.INVASION, null, F.ATTACKER));

    r = classifyEntries([worldEntry(change(p.repelled))], marks, ctx());
    assert.deepStrictEqual(r.events.map((e) => [e.kind, e.defender, e.attacker]),
      [["ATTACK_REPELLED", F.DEFENDER, F.ATTACKER]]);
    r = classifyEntries([worldEntry(change(p.repelled))], invasionMarks, ctx());
    assert.deepStrictEqual(r.events.map((e) => e.kind), ["ATTACK_REPELLED"]);
    r = classifyEntries([worldEntry(change(p.reconExpired))],
      new Map([[SYS, mark(OCC.RECON, F.DEFENDER, F.ATTACKER)]]), ctx());
    assert.deepStrictEqual([r.events, r.marks.get(SYS)], [[], mark(OCC.STABLE, F.DEFENDER, null)]);

    r = classifyEntries([worldEntry(change(p.idle))], marks, ctx());
    assert.deepStrictEqual([r.events, r.marks.get(SYS)], [[], mark(OCC.CONTESTED, F.DEFENDER, F.ATTACKER)]);

    const created = worldEntry({ systemId: SYS + 1, expectedVersion: 0, reason: "SEED_CONTROL",
      state: { securityClass: "nullsec", controllerFactionId: F.DEFENDER } });
    r = classifyEntries([created], new Map(), ctx());
    assert.deepStrictEqual([r.events, r.marks.get(SYS + 1)], [[], mark(OCC.STABLE, F.DEFENDER, null)]);

    r = classifyEntries([worldEntry(change(p.capture), { createdAt: T0 - 7200000 })],
      new Map([[SYS, mark(OCC.INVASION, F.DEFENDER, F.ATTACKER)]]), ctx());
    assert.deepStrictEqual([r.events, r.skipped, r.marks.get(SYS).state], [[], { STALE: 1 }, OCC.OCCUPIED]);
    r = classifyEntries([worldEntry(change(p.capture))], new Map([[SYS, mark(OCC.INVASION, F.DEFENDER)]]),
      ctx({ kinds: new Set(["ATTACK_STARTED"]) }));
    assert.deepStrictEqual([r.events, r.skipped], [[], { KIND_OFF: 1 }]);

    const atMs = T0 - 5000;
    const kill = worldEntry({ systemId: SYS, expectedVersion: 4, reason: "LIBERATION_KILL",
      influence: [{ factionId: F.DEFENDER, influenceScore: 35 }] }, { key: killKey(SYS, CHAR, F.DEFENDER, atMs, 777) });
    r = classifyEntries([kill], new Map([[SYS, mark(OCC.STABLE, F.DEFENDER)]]), ctx());
    assert.deepStrictEqual(r.events.map((e) => [e.kind, e.eventKey, e.characterId, e.defender]),
      [["PLAYER_IMPACT", `imp:${SYS}:${CHAR}:${Math.floor(T0 / 3600000)}`, CHAR, F.DEFENDER]]);
  });

  const driver = loadDriver();
  if (!driver.ok) {
    skip("NS2 notices sources: siege rows", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }
  test("NS2 siege rows of the real siegeRepository: SIEGE_STARTED, SIEGE_ENDED from the map, SIEGE_MISSING", () => {
    withStore(driver, (opened) => {
      const clock = createManualClock(T0);
      const journal = createJournal({ clock, maxPayloadBytes: 8192, maxRows: 500 });
      const sieges = createSiegeRepository({ journal, ids: createIdGenerator({ clock, rng: createRng(7) }) });
      const tx = (fn) => {
        const r = opened.store.transaction("t", fn);
        assert.ok(r.ok, JSON.stringify(r));
        return r.value;
      };
      const head = tx((db) => journal.headId(db)).headId;
      tx((db) => F.insertStation(db, "st-ns2", SYS, F.DEFENDER, T0));
      const made = tx((db) => sieges.createSiege(db, F.siegeSpec("st-ns2", SYS, T0), "siege:ns2:start"));
      assert.ok(made.ok, JSON.stringify(made));
      const ended = tx((db) => sieges.transitionSiege(db, { siegeId: made.siegeId, expectedVersion: 1,
        from: "SHIELD_ASSAULT", to: "REPELLED", at: T0, patch: { endedAt: T0, endReason: "NO_ATTACKER" } },
      "siege:ns2:end"));
      assert.ok(ended.ok, JSON.stringify(ended));
      const listed = tx((db) => journal.listAfter(db, { afterId: head, uptoId: head + 100,
        aggregateTypes: [...AGGREGATE_TYPES], limit: 50 }));
      assert.ok(listed.ok, JSON.stringify(listed));
      assert.deepStrictEqual(endedSiegeIds(listed.entries), [made.siegeId]);
      const map = new Map([[made.siegeId, tx((db) => sieges.getSiege(db, made.siegeId)).siege]]);
      let r = classifyEntries(listed.entries, new Map(), ctx({ sieges: map }));
      assert.deepStrictEqual(r.events.map((e) => [e.kind, e.systemId, e.attacker, e.defender, e.outcome || null,
        e.endReason || null]), [["SIEGE_STARTED", SYS, F.ATTACKER, F.DEFENDER, null, null],
        ["SIEGE_ENDED", SYS, F.ATTACKER, F.DEFENDER, "REPELLED", "NO_ATTACKER"]]);
      r = classifyEntries(listed.entries, new Map(), ctx());
      assert.deepStrictEqual([r.events.map((e) => e.kind), r.skipped], [["SIEGE_STARTED"], { SIEGE_MISSING: 1 }]);
    });
  });
};
