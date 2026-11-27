"use strict";

const assert = require("node:assert");

const S = require("../../../lib/world/standings/schema");
const { planConvoyPenalty, validateData } = require("../../../lib/world/standings/standingsRules");
const { STANDINGS_DATA_V1 } = require("../../../lib/world/standings/data/standingsData");
const { harness: H } = require("../../battle/settlement.test");
const { harness: T } = require("../standings.test");

const { GURISTAS } = T;
const AMARR = 500003;
const SYSTEM = 30002187;
const CHARACTER = 7;
const ON = Object.freeze({ EVEJS_LNE_STANDINGS_CONVOY_PENALTY_ENABLED: "1" });

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("CV2 convoy charge: off = OFF without a row; kill once per ck key; one attack per window; the handler "
    + "writes CONVOY_AGGRESSION with event 76", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const rt = T.fakeRuntime();
      const off = T.bootStd(reopen(), shared, {}, rt);
      const base = shared.clock.now();
      const kill = { characterId: CHARACTER, victimFactionId: AMARR, convoyOwnerFactionId: AMARR, systemId: SYSTEM,
        atMs: base, victimId: 7001 };
      assert.strictEqual(off.config.standings.convoyPenaltyEnabled, false, "default off");
      assert.deepStrictEqual(off.standings.onConvoyPenalty({ kind: "ATTACK", characterId: CHARACTER, factionId: AMARR,
        systemId: SYSTEM, atMs: base }), { ok: true, outcome: "OFF" });
      assert.deepStrictEqual(off.standings.onNpcKill(kill), { ok: true, outcome: "OFF" }, "a convoy kill: no plus either");
      assert.deepStrictEqual(T.outboxRows(off), [], "zero journal rows with the flag off");
      off.standings.stop("test");
      off.store.close();

      const env = T.bootStd(reopen(), shared, ON, rt);
      const writes = [];
      const apply = env.adapter.applyStandingGrant;
      env.adapter.applyStandingGrant = (grant, data) => {
        writes.push({ reason: grant.reason, rawChange: grant.rawChange, eventTypeId: data.eventTypeId,
          factionId: grant.factionId, key: grant.key });
        return apply(grant, data);
      };
      assert.deepStrictEqual(env.standings.onNpcKill(kill), { ok: true, outcome: "CHARGED" });
      assert.deepStrictEqual(env.standings.onNpcKill(kill), { ok: true, outcome: "DEBOUNCED" }, "the same kill again");
      const killKey = `lne:std:${CHARACTER}:${S.dayOf(base)}:${AMARR}:${SYSTEM}:ck${base}.7001`;
      assert.deepStrictEqual(T.outboxRows(env).map((r) => r.k), [killKey]);

      const attack = (atMs) => env.standings.onConvoyPenalty({ kind: "ATTACK", characterId: CHARACTER,
        factionId: AMARR, systemId: SYSTEM, atMs });
      const windowMs = env.config.standings.navyAttackWindowMs;
      const windowStart = Math.floor(base / windowMs) * windowMs;
      assert.strictEqual(attack(windowStart).outcome, "CHARGED");
      assert.strictEqual(attack(windowStart + windowMs - 1).outcome, "DEBOUNCED", "two attacks in one window = one charge");
      assert.strictEqual(T.outboxRows(env).length, 2);
      const counters = env.standings.getStatus().counters;
      assert.deepStrictEqual([counters.convoyCharged, counters.convoyDebounced, counters.granted, counters.navyCharged],
        [2, 2, 0, 0]);

      await T.passesAt(env, shared, base);
      const byKey = Object.fromEntries(writes.map((w) => [w.key, w]));
      assert.deepStrictEqual(byKey[killKey], { reason: "CONVOY_AGGRESSION", rawChange: -0.004, eventTypeId: 76,
        factionId: AMARR, key: killKey });
      const attackKey = `lne:std:${CHARACTER}:${S.dayOf(windowStart)}:${AMARR}:${SYSTEM}:ca${windowStart / windowMs}`;
      assert.deepStrictEqual(byKey[attackKey], { reason: "CONVOY_AGGRESSION", rawChange: -0.0015, eventTypeId: 76,
        factionId: AMARR, key: attackKey });
      assert.strictEqual(rt.applied, 2);
      env.standings.stop("test");
    }));

  test("CV3 data and keys: old reason texts unchanged, validateData, parseGrantKey ck/ca and old shapes, payload keys", () => {
    assert.deepStrictEqual({ PIRATE_SUPPRESSION: STANDINGS_DATA_V1.msgByReason.PIRATE_SUPPRESSION,
      NAVY_AGGRESSION: STANDINGS_DATA_V1.msgByReason.NAVY_AGGRESSION,
      PIRATE_ALLEGIANCE: STANDINGS_DATA_V1.msgByReason.PIRATE_ALLEGIANCE }, {
      PIRATE_SUPPRESSION: "Pirate suppression (Living New Eden)",
      NAVY_AGGRESSION: "Aggression against the belt navy (Living New Eden)",
      PIRATE_ALLEGIANCE: "Fighting for the pirates (Living New Eden)" }, "the vendor fingerprint of the old grants");
    assert.deepStrictEqual([STANDINGS_DATA_V1.eventTypeId, STANDINGS_DATA_V1.navyEventTypeId], [486, 76]);
    assert.strictEqual(STANDINGS_DATA_V1.msgByReason.CONVOY_AGGRESSION, "Attack on a faction convoy (Living New Eden)");
    const pirates = new Set([GURISTAS]);
    assert.deepStrictEqual(validateData(STANDINGS_DATA_V1, pirates), { ok: true });
    const { CONVOY_AGGRESSION: _c, ...withoutConvoy } = STANDINGS_DATA_V1.msgByReason;
    assert.strictEqual(validateData({ ...STANDINGS_DATA_V1, msgByReason: withoutConvoy }, pirates).detail,
      "msgByReason CONVOY_AGGRESSION");

    const params = { convoyAttackRaw: 0.0015, convoyKillRaw: 0.004, navyAttackWindowMs: 600000 };
    const at = 1793000000000;
    const day = S.dayOf(at);
    const p = { characterId: CHARACTER, factionId: AMARR, systemId: SYSTEM, atMs: at };
    const kill = planConvoyPenalty({ ...p, kind: "KILL", victimId: 99 }, params);
    const attack = planConvoyPenalty({ ...p, kind: "ATTACK" }, params);
    assert.deepStrictEqual([kill.key, kill.rawChange], [`lne:std:${CHARACTER}:${day}:${AMARR}:${SYSTEM}:ck${at}.99`,
      -0.004]);
    assert.deepStrictEqual([attack.key, attack.rawChange],
      [`lne:std:${CHARACTER}:${day}:${AMARR}:${SYSTEM}:ca${Math.floor(at / 600000)}`, -0.0015]);
    assert.deepStrictEqual(planConvoyPenalty({ ...p, kind: "OTHER" }, params), { ok: false,
      reason: "PENALTY_INVALID_INPUT" });
    const slots = (keys) => keys.map((k) => (S.parseGrantKey(k) || { slot: null }).slot);
    const prefix = `lne:std:${CHARACTER}:${day}:${AMARR}:${SYSTEM}:`;
    assert.deepStrictEqual(slots([kill.key, attack.key, `${prefix}ck${at}`, `${prefix}k${at}.99`, `${prefix}k${at}`,
      `${prefix}a5`, `${prefix}17`, `${prefix}cx5`, `${prefix}ck`]),
    [`ck${at}.99`, `ca${Math.floor(at / 600000)}`, `ck${at}`, `k${at}.99`, `k${at}`, "a5", "17", null, null]);
    assert.deepStrictEqual(slots([kill.key, attack.key, `${prefix}k${at}.99`, `${prefix}a5`]).map(S.isConvoySlot),
      [true, true, false, false]);
    assert.strictEqual(S.PAYLOAD_KEYS, "characterId,factionId,journalId,rawChange,systemId");
  });
};
