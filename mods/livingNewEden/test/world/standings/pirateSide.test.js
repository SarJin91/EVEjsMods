"use strict";

const assert = require("node:assert");

const { planPirateGrant } = require("../../../lib/world/standings/standingsRules");
const { STANDINGS_DATA_V1 } = require("../../../lib/world/standings/data/standingsData");
const S = require("../../../lib/world/standings/schema");
const { harness: H } = require("../../battle/settlement.test");
const { harness: T } = require("../standings.test");

const { CALDARI, GURISTAS } = T;
const PIRATES = Object.freeze(new Set([500010, 500011, 500012, 500019, 500020, 500025]));
const CHARACTER = 7;
const ON = Object.freeze({ EVEJS_LNE_STANDINGS_PIRATE_SIDE_ENABLED: "1" });

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };
  const SYSTEM = H.S.N5;

  test("PS1 planPirateGrant: FIGHTER, SDE_SYSTEM, VICTIM_PIRATE, NO_PIRATE_BENEFICIARY, NO_ROW", () => {
    const ctx = { pirateIds: PIRATES, data: STANDINGS_DATA_V1,
      params: { debounceWindowMs: 0, pirateSideRawChangePerGrant: 2e-4 } };
    const atMs = 5 * S.DAY_MS + 9;
    const kill = { characterId: CHARACTER, victimFactionId: CALDARI, systemId: 30000001, atMs, victimId: 11 };
    const sys = (state, controller, occupier = null) => ({ occupationState: state, controllerFactionId: controller,
      occupierFactionId: occupier });
    assert.deepStrictEqual(planPirateGrant(kill, sys("STABLE", GURISTAS), null, ctx), { ok: true, factionId: GURISTAS,
      basis: "PIRATE_SIDE", source: "FIGHTER", day: 5, window: null, legacyKey: null, rawChange: 2e-4,
      key: `lne:std:${CHARACTER}:5:${GURISTAS}:30000001:k${atMs}.11` });
    const venal = planPirateGrant(kill, sys("STABLE", CALDARI), { factionId: GURISTAS }, ctx);
    assert.deepStrictEqual([venal.factionId, venal.source], [GURISTAS, "SDE_SYSTEM"]);
    assert.deepStrictEqual(planPirateGrant({ ...kill, victimFactionId: GURISTAS }, sys("STABLE", GURISTAS), null, ctx),
      { ok: false, reason: "VICTIM_PIRATE" });
    assert.deepStrictEqual(planPirateGrant(kill, sys("STABLE", CALDARI), { factionId: CALDARI }, ctx),
      { ok: false, reason: "NO_PIRATE_BENEFICIARY" });
    assert.deepStrictEqual(planPirateGrant(kill, null, null, ctx), { ok: false, reason: "NO_ROW" });
  });

  needsDriver("PS2 flag off: NOT_PIRATE with zero rows, a navy kill is the navy charge only", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const env = T.bootStd(reopen(), shared, {}, T.fakeRuntime());
      T.seedSystem(env, SYSTEM, GURISTAS);
      const atMs = shared.clock.now();
      const kill = { characterId: CHARACTER, victimFactionId: CALDARI, systemId: SYSTEM, atMs, victimId: 21 };
      assert.deepStrictEqual(env.standings.onNpcKill(kill), { ok: true, outcome: "NOT_PIRATE" });
      assert.deepStrictEqual([T.outboxRows(env).length, T.grantEvents(env).length], [0, 0]);
      assert.deepStrictEqual(env.standings.onNpcKill({ ...kill, navy: true }), { ok: true, outcome: "CHARGED" });
      assert.deepStrictEqual([T.outboxRows(env).length, T.grantEvents(env).length], [1, 1]);
      env.standings.stop("test");
    }));

  needsDriver("PS3 flag on: navy charge + pirate grant under another key, a replay writes nothing", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const env = T.bootStd(reopen(), shared, ON, T.fakeRuntime());
      T.seedSystem(env, SYSTEM, GURISTAS);
      const atMs = shared.clock.now();
      const kill = { characterId: CHARACTER, victimFactionId: CALDARI, systemId: SYSTEM, atMs, victimId: 31,
        navy: true };
      assert.deepStrictEqual(env.standings.onNpcKill(kill), { ok: true, outcome: "CHARGED" });
      const events = T.grantEvents(env).map(T.evOf);
      assert.strictEqual(events.length, 2);
      assert.notStrictEqual(events[0].idempotencyKey, events[1].idempotencyKey);
      const byFaction = Object.fromEntries(events.map((e) => [e.payload.factionId, e.payload.rawChange]));
      assert.ok(byFaction[CALDARI] < 0 && byFaction[GURISTAS] > 0, JSON.stringify(byFaction));
      assert.deepStrictEqual(env.standings.onNpcKill(kill), { ok: true, outcome: "DEBOUNCED" });
      assert.deepStrictEqual([T.outboxRows(env).length, T.grantEvents(env).length], [2, 2]);
      const c = env.standings.getStatus().counters;
      assert.deepStrictEqual([c.navyCharged, c.navyDebounced, c.pirateSideGranted, c.pirateSideDebounced], [1, 1, 1, 1]);
      env.standings.stop("test");
    }));

  needsDriver("PS4 handler: pirate grant PIRATE_ALLEGIANCE with event 486, grant stays PIRATE_SUPPRESSION", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const env = T.bootStd(reopen(), shared, ON, T.fakeRuntime());
      const grants = [];
      const apply = env.adapter.applyStandingGrant;
      env.adapter.applyStandingGrant = (grant, data) => {
        grants.push({ factionId: grant.factionId, rawChange: grant.rawChange, reason: grant.reason,
          eventTypeId: data.eventTypeId });
        return apply(grant, data);
      };
      T.seedSystem(env, SYSTEM, GURISTAS);
      const atMs = shared.clock.now();
      assert.strictEqual(env.standings.onNpcKill({ characterId: CHARACTER, victimFactionId: CALDARI, systemId: SYSTEM,
        atMs, victimId: 41 }).outcome, "GRANTED");
      assert.strictEqual(env.standings.onNpcKill({ characterId: CHARACTER, victimFactionId: GURISTAS, systemId: SYSTEM,
        atMs, victimId: 42 }).outcome, "GRANTED");
      await T.passesAt(env, shared, atMs);
      const pirate = grants.find((g) => g.factionId === GURISTAS);
      const plus = grants.find((g) => g.factionId !== GURISTAS);
      assert.deepStrictEqual(pirate, { factionId: GURISTAS, rawChange: 0.0002, reason: "PIRATE_ALLEGIANCE",
        eventTypeId: 486 });
      assert.deepStrictEqual([plus.reason, plus.eventTypeId], ["PIRATE_SUPPRESSION", 486]);
      const c = env.standings.getStatus().counters;
      assert.deepStrictEqual([c.pirateApplied, c.applied], [1, 1]);
      env.standings.stop("test");
    }));
};
