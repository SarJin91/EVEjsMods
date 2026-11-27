"use strict";

const assert = require("node:assert");
const path = require("node:path");

const config = require("../../config");
const { createJournal } = require("../../lib/persistence/journal");
const { createSentryService } = require("../../lib/sentries/service");
const { planSentryBattle } = require("../../lib/sentries/battlePlan");
const S = require("../../lib/sentries/schema");
const { GROUPS: STRENGTH_GROUPS } = require("../../lib/battle/data/strengthCatalog");
const { expandStrengthGroups } = require("../../lib/battle/strength");
const { capitalPowerOverlayOf } = require("../../lib/battle/data/capitalStrengthRows");
const { harness: H } = require("../battle/settlement.test");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const DEFAULTS = config.resolveConfig({ modDir: MOD_DIR, env: {} }).config;
const GROUPS = expandStrengthGroups(STRENGTH_GROUPS, null, capitalPowerOverlayOf(undefined));
const SYS = 30002000;
const OWNER = 500020;
const ENEMY = 500010;
const ENEMY2 = 500011;
const NEUTRAL = 500012;
const SETTINGS = Object.freeze({ maxFleetsPerSide: 1, maxSentriesPerBattle: 1, damageTakenPermille: 300,
  attackerRetreatLossPermille: 300 });

const fleet = (fleetId, factionId, count, over = {}) => ({ fleetId, factionId, version: 3, fleetRole: "patrol",
  state: "IDLE", shipCount: count, currentSystemId: SYS, composition: [{ hullGroup: "frigate", count }], ...over });
const sentry = (n, over = {}) => ({ sentryId: `sf-${n}`, itemId: 7000 + n, typeId: 340501, ownerKind: "faction",
  factionId: OWNER, characterId: null, systemId: SYS, hp: 1000, dps: 67.7, signature: 6000, designSig: 125, ...over });

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  test("FD-P1 planSentryBattle: attacker = the largest hostile holder, fleets largest first and sentries in sentryId "
    + "order within the limits, ehp from damageTakenPermille, dps 0 kept, more; NO_HOSTILE, NO_SENTRY", () => {
    const fleets = [fleet("f-small", ENEMY, 5), fleet("f-big", ENEMY, 10), fleet("f-scout", ENEMY2, 40,
      { fleetRole: "scout" }), fleet("f-two", ENEMY2, 3), fleet("f-neutral", NEUTRAL, 50),
    fleet("f-live", ENEMY2, 60, { state: "MATERIALIZED" })];
    const sentries = [sentry(2, { dps: 0 }), sentry(1, { hp: 999 }), sentry(3, { ownerKind: "player", factionId: null,
      characterId: null })];
    const isHostileTo = (s, g) => g === ENEMY || g === ENEMY2;
    const plan = planSentryBattle({ fleets, sentries, isHostileTo, groups: GROUPS, settings: SETTINGS });
    assert.deepStrictEqual(plan, { battle: { factionId: ENEMY, fleets: [{ fleetId: "f-big", expectedVersion: 3 }],
      fixedDefenses: { attackerRetreatLossPermille: 300, entries: [{ sentryId: "sf-1", itemId: 7001, typeId: 340501,
        ownerKind: "faction", ownerId: OWNER, hp: 999, ehp: 3330, dps: 67.7, signature: 6000, designSig: 125 }] } },
    more: true });
    const wide = planSentryBattle({ fleets, sentries, isHostileTo, groups: GROUPS,
      settings: { ...SETTINGS, maxFleetsPerSide: 4, maxSentriesPerBattle: 8 } });
    assert.deepStrictEqual([wide.battle.fleets.map((f) => f.fleetId), wide.battle.fixedDefenses.entries
      .map((e) => [e.sentryId, e.dps])], [["f-big", "f-small"], [["sf-1", 67.7], ["sf-2", 0]]]);
    assert.deepStrictEqual([planSentryBattle({ fleets, sentries, isHostileTo: () => false,
      groups: GROUPS, settings: SETTINGS }), planSentryBattle({ fleets, sentries: [sentry(3, { ownerKind: "player",
      factionId: null })], isHostileTo, groups: GROUPS, settings: SETTINGS })],
    [{ battle: null, reason: "NO_HOSTILE" }, { battle: null, reason: "NO_SENTRY" }]);
  });

  needsDriver("FD-P2 sentry battle round: observed -> no battle; unobserved -> one battle (dps 0 without ammo / "
    + "incapacitated, default designSig), replay STALE; VERSION_CONFLICT -> {ok:false} without a journal entry; no "
    + "battle service -> BATTLE_OFF", () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    const { clock } = H.sharedOf();
    const journal = createJournal({ clock, maxPayloadBytes: 16384, maxRows: 500 });
    const rows = [1, 2, 3].map((n) => ({ ...sentry(n), state: S.ACTIVE, armedAt: 0 }));
    const items = new Map([[7001, { hp: 500000, destroyed: false, incapacitated: false }],
      [7002, { hp: 400000, destroyed: false, incapacitated: true }], [7003, { hp: 300000, destroyed: false,
        incapacitated: false }]]);
    const seam = { readSentryItem: (id) => ({ ok: true, item: items.get(id) }),
      readSentryCombat: (typeId) => (typeId === 340503 ? { ok: true, dps: 15.625, signature: 12000, designSig: null }
        : { ok: true, dps: 67.7, signature: 6000, designSig: 125 }),
      readAmmo: (id) => ({ ok: true, units: id === 7003 ? 0 : 50, capacityUnits: 100 }) };
    rows[0].typeId = 340503;
    const calls = [];
    const facade = { mode: "ok", getStatus: () => ({ state: facade.state || "ready" }),
      createFixedDefenseBattleInTx(tx, spec, key) {
        calls.push({ spec, key, inTx: tx.inTransaction === true });
        return facade.mode === "ok" ? { ok: true, duplicate: false, battleId: `b-${calls.length}` }
          : { ok: false, reason: "VERSION_CONFLICT" };
      } };
    let distance = 0;
    const cfg = { ...DEFAULTS, sentries: { ...DEFAULTS.sentries, enabled: true,
      battle: { ...DEFAULTS.sentries.battle, enabled: true, defaultDesignSig: 111 } } };
    const service = createSentryService({ store: opened.store, config: cfg, clock, seam, journal,
      repository: { listActive: () => ({ ok: true, sentries: rows, truncated: false }) },
      scheduler: { enqueue: () => ({ ok: true }) },
      fleetRepository: { listFleetsInSystem: (db, systemId, opts) => ({ ok: true, nextAfterFleetId: null,
        fleets: [fleet("f-big", ENEMY, 10), fleet("f-live", ENEMY, 10, { state: "MATERIALIZED" })]
          .filter((f) => opts.states.includes(f.state)) }) },
      getPresence: () => ({ distanceToObserved: () => ({ ok: true, distance }) }), groups: GROUPS,
      hostility: { isFactionEnemy: (f, g) => g === ENEMY }, getBattle: () => facade });
    assert.ok(service.rebuildArmed().ok);
    const R = cfg.sentries.battle.roundMs;
    const round = Math.floor(clock.now() / R) + 1;
    const ev = (r) => ({ payload: { systemId: SYS, round: r }, dueAt: r * R });
    const run = (fn) => {
      const r = opened.store.transaction("test", fn);
      assert.ok(r.ok, JSON.stringify(r));
      return r.value;
    };
    const jrows = (r) => run((db) => db.prepare("SELECT count(*) AS n FROM world_event_journal WHERE idempotency_key = ?")
      .get(S.attritionJournalKey(SYS, r)).n);

    const seen = service.onAttrition(ev(round), { anchorAt: round * R });
    assert.deepStrictEqual([seen.outcome, typeof seen.effect, seen.reschedule.idempotencyKey, calls.length],
      ["OBSERVED", "undefined", S.attritionKey(SYS, round + 1), 0]);
    distance = null;
    const r = service.onAttrition(ev(round), { anchorAt: round * R });
    assert.strictEqual(r.outcome, "BATTLE", JSON.stringify(r));
    const v = run((db) => r.effect(db));
    r.onCommitted(v);
    const c = calls[0];
    assert.deepStrictEqual([v, c.key, c.inTx, c.spec.systemId, c.spec.at, c.spec.sideA,
      c.spec.fixedDefenses.entries.map((e) => [e.sentryId, e.dps, e.designSig, e.ehp])],
    [{ ok: true, stale: false, battleId: "b-1", duplicate: false }, S.battleKey(SYS, round), true, SYS, round * R,
      { factionId: ENEMY, fleets: [{ fleetId: "f-big", expectedVersion: 3 }] },
      [["sf-1", 15.625, cfg.sentries.battle.defaultDesignSig, 500000], ["sf-2", 0, 125, 400000], ["sf-3", 0, 125,
        300000]]]);
    const again = service.onAttrition(ev(round), { anchorAt: round * R });
    const counters = service.getStatus().counters;
    assert.deepStrictEqual([again.outcome, calls.length, jrows(round), counters.battleRounds, counters.battlesCreated,
      counters.battleObservedSkips, r.reschedule.idempotencyKey], ["STALE", 1, 1, 1, 1, 0,
      S.attritionKey(SYS, round + 1)]);

    facade.mode = "conflict";
    const next = service.onAttrition(ev(round + 1), { anchorAt: (round + 1) * R });
    const refused = run((db) => next.effect(db));
    assert.deepStrictEqual([next.outcome, refused.ok, refused.reason, refused.permanent, jrows(round + 1)],
      ["BATTLE", false, "VERSION_CONFLICT", false, 0]);
    facade.state = "unavailable";
    assert.strictEqual(service.onAttrition(ev(round + 2), { anchorAt: (round + 2) * R }).outcome, "BATTLE_OFF");
    service.stop();
  }));
};
