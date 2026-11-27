"use strict";

const assert = require("node:assert");

const S = require("../../../lib/world/standings/schema");
const { planNavyPenalty, validateData } = require("../../../lib/world/standings/standingsRules");
const { planCharacterPrune } = require("../../../lib/world/standings/pruneRules");
const { STANDINGS_DATA_V1 } = require("../../../lib/world/standings/data/standingsData");
const { createUnavailableStandings } = require("../../../lib/world/standings");
const { observeKill } = require("../../../lib/adapter/killObservation");
const { harness: H } = require("../../battle/settlement.test");
const { harness: T } = require("../standings.test");

const { CALDARI, GURISTAS } = T;
const PARAMS = Object.freeze({ navyAttackRaw: 0.002, navyKillRaw: 0.005, navyAttackWindowMs: 600000 });
const SYSTEM = 30001984;
const CHARACTER = 7;
const AT = 1793000000000;
const DAY = Math.floor(AT / S.DAY_MS);

const attack = (over = {}) => ({ kind: "ATTACK", characterId: CHARACTER, factionId: CALDARI, systemId: SYSTEM, atMs: AT, ...over });

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  test("BNP1 plan: negative raw, attack window key, kill key, prune parses and keeps a<window>, data checks", () => {
    const window = Math.floor(AT / PARAMS.navyAttackWindowMs);
    const plan = planNavyPenalty(attack(), PARAMS);
    assert.deepStrictEqual(plan, { ok: true, day: DAY, window, rawChange: -0.002,
      key: `lne:std:${CHARACTER}:${DAY}:${CALDARI}:${SYSTEM}:a${window}` });
    assert.strictEqual(planNavyPenalty(attack({ atMs: AT + 1 }), PARAMS).key, plan.key, "the same window");
    const kill = planNavyPenalty(attack({ kind: "KILL", victimId: 99 }), PARAMS);
    assert.deepStrictEqual(kill, { ok: true, day: DAY, window: null, rawChange: -0.005,
      key: `lne:std:${CHARACTER}:${DAY}:${CALDARI}:${SYSTEM}:k${AT}.99` });
    for (const bad of [null, attack({ kind: "OTHER" }), attack({ characterId: 0 }), attack({ atMs: 1.5 })]) {
      assert.deepStrictEqual(planNavyPenalty(bad, PARAMS), { ok: false, reason: "PENALTY_INVALID_INPUT" });
    }

    const parsed = S.parseGrantKey(plan.key);
    assert.deepStrictEqual(parsed, { characterId: CHARACTER, day: DAY, factionId: CALDARI, systemId: SYSTEM,
      slot: `a${window}` });
    const now = S.dayEndMs(DAY) + 2 * S.DAY_MS;
    const row = { journalId: 1, key: plan.key, kind: "OUTBOX", eventType: S.EVENT_TYPE, state: "APPLIED", createdAt: AT,
      appliedAt: AT };
    const pruned = planCharacterPrune({ now, retentionMs: S.DAY_MS, receiptGraceMs: 0, rows: [row], scanComplete: true,
      lastScannedKey: plan.key, receiptKeys: [plan.key] });
    assert.deepStrictEqual([pruned.receiptsToDelete, pruned.rowsIfReceiptGone], [[plan.key], [{ journalId: 1, key: plan.key }]]);

    const pirates = new Set([GURISTAS]);
    assert.deepStrictEqual(validateData(STANDINGS_DATA_V1, pirates), { ok: true });
    assert.strictEqual(STANDINGS_DATA_V1.navyEventTypeId, 76);
    assert.strictEqual(validateData({ ...STANDINGS_DATA_V1, navyEventTypeId: 0 }, pirates).detail, "navyEventTypeId");
    assert.strictEqual(validateData({ ...STANDINGS_DATA_V1, msgByReason: { PIRATE_SUPPRESSION: "x" } }, pirates).detail,
      "msgByReason NAVY_AGGRESSION");
  });

  needsDriver("BNP2 attack: one charge per window, a negative write with event 76, next window and other system charge", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const rt = T.fakeRuntime();
      const calls = [];
      const apply = rt.applyStandingChanges;
      rt.applyStandingChanges = (id, changes, options) => {
        calls.push(changes[0]);
        return apply(id, changes, options);
      };
      const env = T.bootStd(reopen(), shared, {}, rt);
      const base = shared.clock.now();
      const hit = (over) => env.standings.onNavyPenalty(attack({ atMs: base, ...over }));
      assert.deepStrictEqual(hit(), { ok: true, outcome: "CHARGED" });
      assert.deepStrictEqual(hit(), { ok: true, outcome: "DEBOUNCED" });
      assert.deepStrictEqual([T.outboxRows(env).length, T.grantEvents(env).length], [1, 1], "one row and one event");
      assert.strictEqual(hit({ systemId: SYSTEM + 1 }).outcome, "CHARGED", "another system");
      assert.strictEqual(hit({ factionId: 500003 }).outcome, "CHARGED", "another faction");
      await T.passesAt(env, shared, base);
      assert.strictEqual(hit({ atMs: base + PARAMS.navyAttackWindowMs }).outcome, "CHARGED", "the next window");
      await T.passesAt(env, shared, base);
      assert.deepStrictEqual(T.outboxRows(env).map((r) => r.state), ["APPLIED", "APPLIED", "APPLIED", "APPLIED"]);
      assert.strictEqual(rt.applied, 4);
      assert.deepStrictEqual(calls[0], { ownerID: CALDARI, rawChange: -0.002, eventTypeID: 76, applySocial: false,
        msg: "Aggression against the belt navy (Living New Eden)" });
      assert.ok(env.lines.some((l) => l.startsWith(`standings: -0.002 char=${CHARACTER}`)), env.lines.join("\n"));
      const counters = env.standings.getStatus().counters;
      assert.deepStrictEqual([counters.navyCharged, counters.navyDebounced, counters.applied], [4, 1, 4]);
      env.standings.stop("test");
    }));

  needsDriver("BNP3 kill: navy field from killObservation, one charge per kill, replay and restart charge nothing", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const rt = T.fakeRuntime();
      const env = T.bootStd(reopen(), shared, {}, rt);
      const base = shared.clock.now();
      const victim = { itemID: 4242, systemID: SYSTEM, selectionID: "belt_navy:500001:belt_rat:x:nullsec" };
      const observe = (standings, entity = victim) => observeKill(null, entity, CHARACTER, { nowMs: base },
        { resolveVictimFactionID: () => CALDARI, getStandings: () => standings, isNavyVictim: () => true });
      assert.deepStrictEqual(observe(env.standings).results.standings, { ok: true, outcome: "CHARGED" });
      assert.deepStrictEqual(observe(env.standings).results.standings, { ok: true, outcome: "DEBOUNCED" }, "a replay");
      assert.strictEqual(observe(env.standings, { ...victim, itemID: 4243 }).results.standings.outcome, "CHARGED",
        "a second ship killed in the same millisecond");
      await T.passesAt(env, shared, base);
      assert.strictEqual(rt.applied, 2);
      env.standings.stop("restart");
      env.store.close();
      const again = T.bootStd(reopen(), shared, {}, rt);
      assert.deepStrictEqual(observe(again.standings).results.standings, { ok: true, outcome: "DEBOUNCED" }, "after a restart");
      await T.passesAt(again, shared, base);
      assert.deepStrictEqual([rt.applied, again.standings.getStatus().counters.navyCharged], [2, 0]);
      const stale = again.standings.onNpcKill({ characterId: CHARACTER, victimFactionId: CALDARI, systemId: SYSTEM,
        atMs: base - S.STALE_KILL_MS - 1, navy: true });
      assert.deepStrictEqual(stale, { ok: true, outcome: "STALE_KILL" });
      again.standings.stop("test");
    }));

  needsDriver("BNP4 flag off: no cost and no row; the kill stays no pirate plus; the unavailable stub refuses", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const rt = T.fakeRuntime();
      const env = T.bootStd(reopen(), shared, { EVEJS_LNE_STANDINGS_NAVY_PENALTY_ENABLED: "0" }, rt);
      const base = shared.clock.now();
      assert.deepStrictEqual(env.standings.onNavyPenalty(attack({ atMs: base })), { ok: true, outcome: "OFF" });
      assert.deepStrictEqual(env.standings.onNpcKill({ characterId: CHARACTER, victimFactionId: CALDARI, systemId: SYSTEM,
        atMs: base, victimId: 1, navy: true }), { ok: true, outcome: "OFF" });
      assert.deepStrictEqual(T.outboxRows(env), []);
      assert.deepStrictEqual(env.standings.onNavyPenalty({ kind: "ATTACK" }), { ok: true, outcome: "OFF" });
      env.standings.stop("test");
      env.store.close();
      const on = T.bootStd(reopen(), shared, {}, rt);
      assert.deepStrictEqual(on.standings.onNavyPenalty({ kind: "ATTACK" }), { ok: true, outcome: "INVALID" });
      on.standings.stop("test");
      assert.deepStrictEqual(on.standings.onNavyPenalty(attack({ atMs: base })), { ok: false, reason: "STANDINGS_STOPPED" });
      assert.strictEqual(createUnavailableStandings("STANDINGS_DISABLED").onNavyPenalty(attack()).reason, "STANDINGS_DISABLED");
    }));
};
