"use strict";

const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");

const config = require("../../config");
const { planFameBounty } = require("../../lib/fame/bounty");
const { startFame } = require("../../lib/fame");
const FS = require("../../lib/fame/schema");
const { createBountyService } = require("../../lib/bounty/service");
const { createUnavailableBounty } = require("../../lib/bounty");
const RV = require("../../lib/bounty/revenge");
const RR = require("../../lib/bounty/revengeRepository");
const { LEVELS } = require("../../lib/bounty/data/levels");
const { createJournal } = require("../../lib/persistence/journal");
const { newsSettingsOf } = require("../../lib/news/schema");
const { KIND_DATA, PLACEHOLDERS } = require("../../lib/news/data/kinds");
const J = require("../../lib/news/collect/journalFacts");
const SS = require("../../lib/world/standings/schema");
const { planPirateKillCharge } = require("../../lib/world/standings/standingsRules");
const { STANDINGS_DATA_V1 } = require("../../lib/world/standings/data/standingsData");
const { loadDriver, withStore } = require("../notices/storeHelper");
const { harness: H } = require("../battle/settlement.test");
const { harness: T } = require("../world/standings.test");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const T0 = 1760000000000;
const C1 = 90000001;
const GURISTAS = 500010;
const ANGELS = 500011;
const SYS = 4;
const HIGH = 5;
const MIN = 60000;

const cache = new Map();
function cfg(env = {}) {
  const key = JSON.stringify(env);
  if (!cache.has(key)) {
    const r = config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(), ...env }, settings: {},
      envFile: {} });
    assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
    cache.set(key, r.config);
  }
  return cache.get(key);
}

const FAME_ON = Object.freeze({ EVEJS_LNE_FAME_ENABLED: "1", EVEJS_LNE_FAME_BOUNTY_ENABLED: "1",
  EVEJS_LNE_FAME_NOTICES_ENABLED: "1" });

function line() {
  return {
    getSystem: (id) => (Number.isInteger(id) && id >= 1 && id <= 10 ? { id, secClass: id === HIGH ? "highsec"
      : "lowsec", regionId: 10000001, constellationId: 20000001 } : null),
    getNeighbors: (id) => [id - 1, id + 1].filter((n) => n >= 1 && n <= 10),
    getSystemIds: () => Array.from({ length: 10 }, (_v, i) => i + 1),
    findRoute: (a, b) => ({ ok: true, jumps: Math.abs(a - b) }),
  };
}

function fameRig(env, o = {}) {
  const clock = { t: T0, now() { return this.t; } };
  const calls = [];
  const mails = [];
  const rig = { answer: () => ({ outcome: "created", revengeId: "rev:x" }), clock, calls, mails };
  const store = { transaction: (_name, fn) => ({ ok: true, value: fn({}) }) };
  const notices = { getStatus: () => ({ state: "running" }), enqueueItemsInTx: (_tx, items) => {
    mails.push(...items);
    return { ok: true, inserted: items.length };
  } };
  const r = startFame({ config: cfg(env), clock, logger: { log() {} }, setTimer: () => ({ cancel() {}, hasRef: () => false }),
    persistence: { ok: true, store, journal: {} },
    readStanding: () => ({ ok: true, found: true, standing: -3 }),
    readFactionNames: () => ({ ok: true, names: new Map([[GURISTAS, "Guristas Pirates"]]) }),
    getPresence: () => ({ listPresence: () => [{ systemId: o.systemId || SYS,
      characters: [{ characterId: C1, name: "Bob", state: "space" }] }] }),
    getRegistry: () => ({ listActiveFactions: () => [{ factionId: GURISTAS }] }),
    getNotices: () => notices, getGraph: () => ({ getGraph: () => ({ ok: true, graph: line() }) }),
    getBounty: () => ({ postFameBounty: (spec) => {
      calls.push(spec);
      return rig.answer(spec);
    } }) });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  rig.fame = r.fame;
  rig.review = (t) => {
    clock.t = t;
    assert.strictEqual(r.fame.reviewNow(t).ok, true);
  };
  rig.counters = () => r.fame.getStatus().counters;
  return rig;
}

function vcOf(state = "LINKED") {
  return { getOwnerIdentity: (_kind, gangId) => ({ ok: true, state, characterIds: [7000 + gangId * 10,
    7001 + gangId * 10, 7002 + gangId * 10, 7003 + gangId * 10], memberIndexes: [0, 1, 2, 3],
  memberNames: [null, "Ana Hunter", "Bo Hunter", null], name: "Guristas Gang" }) };
}

function bountyRig(opened, over = {}, vc = vcOf()) {
  const P = { ...cfg().bountyHunters, enabled: true, liveEnabled: true, revengeEnabled: true, ...over };
  const counts = [];
  const journal = createJournal({ clock: { now: () => T0 }, maxPayloadBytes: 4096, maxRows: 500,
    onCount: (name) => counts.push(name) });
  const svc = createBountyService({ store: opened.store, worldSeed: 7, journal, logger: { log() {} },
    settings: P, factionIds: [GURISTAS], levels: LEVELS, getGraph: () => line(), getVirtualCorps: () => vc,
    homeStationOf: () => ({ stationId: 60000001, corporationId: 1000127, systemId: 1 }), bloodlinesOf: () => [1],
    ownerCharacterBudget: 2048, systemFactionsOf: (ids) => ({ ok: true, entries: ids.map((systemId) => ({ systemId,
      factionId: GURISTAS })) }) });
  assert.strictEqual(svc.boot(T0).ok, true);
  return { svc, P, journal, counts };
}

const sql = (opened, text, ...args) => {
  const r = opened.store.transaction("fb.sql", (db) => db.prepare(text).all(...args).map((x) => ({ ...x })));
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
};

module.exports = ({ test, skip }) => {
  test("FB1 planFameBounty table + the review bounty step: delay, created + mail, duplicate, waitOpen, noGang once, "
    + "highsec, flag off", () => {
    const p = { bountyEnabled: true, bountyDelayAfterTierMs: 10 * MIN, bountyCooldownMs: 86400000, enemyMax: -2,
      bountyLevelBase: 2, bountyLevelStep: 1.5, bountyMaxLevel: 5 };
    const pair = { tier: "PUBLIC_ENEMY", standing: -2, enemySince: T0 };
    const now = T0 + 10 * MIN;
    const facts = { now, located: { systemId: SYS, state: "space" }, secClass: "nullsec" };
    const rows = [
      [pair, facts, { ...p, bountyEnabled: false }, { post: false, wait: "OFF" }],
      [{ ...pair, tier: "LEGEND" }, facts, p, { post: false, wait: "NOT_ENEMY" }],
      [pair, { ...facts, now: now - 1 }, p, { post: false, wait: "DELAY" }],
      [{ ...pair, enemySince: null }, facts, p, { post: false, wait: "DELAY" }],
      [pair, { ...facts, located: null }, p, { post: false, wait: "NOT_LOCATED" }],
      [pair, { ...facts, located: { systemId: SYS, state: "docked" } }, p, { post: false, wait: "NOT_IN_SPACE" }],
      [pair, { ...facts, secClass: "highsec" }, p, { post: false, wait: "SEC_CLASS" }],
      [pair, { ...facts, secClass: null }, p, { post: false, wait: "SEC_CLASS" }],
      [pair, facts, p, { post: true, period: Math.floor(now / 86400000), level: 2, systemId: SYS }],
      [{ ...pair, standing: -5 }, { ...facts, secClass: "lowsec" }, p,
        { post: true, period: Math.floor(now / 86400000), level: 4, systemId: SYS }],
    ];
    for (const [a, f, q, want] of rows) assert.deepStrictEqual(planFameBounty(a, f, q), want, JSON.stringify([a, f]));

    const r = fameRig(FAME_ON);
    const delay = cfg(FAME_ON).fame.bountyDelayAfterTierMs;
    r.review(T0);
    assert.deepStrictEqual([r.calls.length, r.counters().bountyWaitDelay], [0, 1], "the delay counts from now");
    r.review(T0 + delay);
    assert.strictEqual(r.calls.length, 1);
    const period = Math.floor((T0 + delay) / cfg(FAME_ON).fame.bountyCooldownMs);
    assert.deepStrictEqual(r.calls[0], { characterId: C1, factionId: GURISTAS, period, level: 2, systemId: SYS,
      at: T0 + delay, delayMs: cfg(FAME_ON).fame.bountyDelayMs, windowMs: cfg(FAME_ON).fame.bountyWindowMs });
    assert.deepStrictEqual(r.mails.map((m) => [m.eventKey, m.kind, m.characterId, m.line]), [[
      `fame:bnty:${C1}:${GURISTAS}:${period}`, "FAME", C1,
      "Guristas Pirates has put a price on your head. Hunters are on their way."]]);
    r.review(T0 + delay + 1);
    assert.strictEqual(r.calls.length, 1, "created: no call in the same period");
    const cd = cfg(FAME_ON).fame.bountyCooldownMs;
    r.answer = () => ({ outcome: "skippedOpen" });
    r.review(T0 + delay + cd);
    assert.strictEqual(r.calls.length, 2, "the next period asks again");
    r.answer = () => ({ outcome: "duplicate" });
    r.review(T0 + delay + cd + 1);
    assert.strictEqual(r.calls.length, 3, "skippedOpen is not remembered");
    r.review(T0 + delay + cd + 2);
    assert.strictEqual(r.calls.length, 3, "duplicate is remembered");
    r.answer = () => ({ outcome: "noGang" });
    r.review(T0 + delay + 2 * cd);
    r.review(T0 + delay + 2 * cd + 1);
    const c = r.counters();
    assert.deepStrictEqual([c.bountyPosted, c.bountyDuplicate, c.bountyWaitOpen, c.bountyNoGang, c.bountyNoticesQueued,
      r.calls.length, r.mails.length], [1, 1, 1, 1, 1, 4, 1], "noGang: the faction is not asked again");
    assert.deepStrictEqual(r.fame.getStatus().noGangFactions, [GURISTAS]);
    r.fame.stop();

    const hs = fameRig(FAME_ON, { systemId: HIGH });
    hs.review(T0);
    hs.review(T0 + delay);
    assert.deepStrictEqual([hs.calls.length, hs.counters().bountyWaitSecClass], [0, 1]);
    hs.fame.stop();
    const off = fameRig({ EVEJS_LNE_FAME_ENABLED: "1" });
    off.review(T0);
    off.review(T0 + delay);
    assert.deepStrictEqual([off.calls.length, off.counters().bountyWaitDelay, off.fame.getStatus().enemies],
      [0, 0, undefined]);
    off.fame.stop();
  });

  const driver = loadDriver();
  if (!driver.ok) {
    skip("FB2/FB3/FB5 fame bounty on a store", `better-sqlite3 unavailable (${driver.detail})`);
  } else {
    test("FB2 postFameBounty: created (fame: row, nemesis_id NULL, journal), duplicate, skippedOpen, noGang, "
      + "gangNotReady, disabled", () => {
      withStore(driver, (opened) => {
        const { svc, P, counts } = bountyRig(opened);
        const spec = { characterId: C1, factionId: GURISTAS, period: 20000, level: 3, systemId: SYS, at: T0,
          delayMs: 120000, windowMs: 7200000 };
        assert.deepStrictEqual(svc.postFameBounty(spec), { outcome: "gangNotReady" }, "no territory yet");
        assert.strictEqual(svc.runPass(T0).ok, true);
        const made = svc.postFameBounty(spec);
        assert.deepStrictEqual(made, { outcome: "created", revengeId: `rev:fame:${C1}:${GURISTAS}:20000` });
        const [row] = sql(opened, "SELECT * FROM world_bounty_revenge WHERE wanted_id LIKE 'fame:%'");
        assert.deepStrictEqual([row.wanted_id, row.character_id, row.faction_id, row.target_level, row.hunter_level,
          row.kill_system_id, row.state, row.due_at, row.expires_at, row.nemesis_id],
        [`fame:${C1}:${GURISTAS}:20000`, C1, GURISTAS, 3, 2, SYS, "WAITING", T0 + 120000, T0 + 7200000, null]);
        assert.ok(row.gang_id >= 1 && row.gang_id <= P.maxGangs && row.boss_character_id === 7000 + row.gang_id * 10,
          "boss = member 0 of a gang of the faction");
        const keys = sql(opened, "SELECT idempotency_key AS k, aggregate_type AS t, event_type AS e FROM "
          + "world_event_journal WHERE idempotency_key LIKE 'bnty:rev:fame:%'");
        assert.deepStrictEqual(keys, [{ k: `bnty:rev:fame:${C1}:${GURISTAS}:20000`, t: "bounty_revenge",
          e: "BOUNTY_REVENGE_SWORN" }]);
        assert.deepStrictEqual(svc.postFameBounty(spec), { outcome: "duplicate" });
        assert.deepStrictEqual(svc.postFameBounty({ ...spec, at: T0 + 5, level: 4 }), { outcome: "duplicate" },
          "another payload in the same period");
        assert.deepStrictEqual(counts.filter((n) => n.startsWith("journal.")), [], JSON.stringify(counts));
        assert.deepStrictEqual(svc.postFameBounty({ ...spec, period: 20001 }), { outcome: "skippedOpen" });
        assert.deepStrictEqual(svc.postFameBounty({ ...spec, factionId: ANGELS }), { outcome: "noGang" });
        const c = svc.getStatus().counters;
        assert.deepStrictEqual([c.fameCreated, c.fameSkippedOpen, c.fameNoGang, c.fameGangNotReady, c.fameFailed],
          [1, 1, 1, 1, 0]);
        assert.strictEqual(svc.getStatus().revenge.open, 1, "the row in RAM after the commit");
        sql(opened, `DELETE FROM world_bounty_revenge WHERE wanted_id = 'fame:${C1}:${GURISTAS}:20000' RETURNING 1`);
        assert.deepStrictEqual(svc.postFameBounty({ ...spec, at: T0 + 9 }), { outcome: "duplicate" },
          "a pruned row: the journal key still says duplicate");
        assert.deepStrictEqual([counts.filter((n) => n.startsWith("journal.")), svc.getStatus().counters.fameFailed],
          [[], 0]);
        svc.stop();
      });
      withStore(driver, (opened) => {
        const { svc } = bountyRig(opened, {}, vcOf("PENDING"));
        assert.strictEqual(svc.runPass(T0).ok, true);
        assert.deepStrictEqual(svc.postFameBounty({ characterId: C1, factionId: GURISTAS, period: 1, level: 2,
          systemId: SYS, at: T0, delayMs: 0, windowMs: 600000 }), { outcome: "gangNotReady" });
        svc.stop();
        const off = bountyRig(opened, { revengeEnabled: false });
        assert.deepStrictEqual(off.svc.postFameBounty({}), { outcome: "disabled" });
        off.svc.stop();
      });
      assert.deepStrictEqual(createUnavailableBounty("disabled_by_config").postFameBounty({}), { outcome: "disabled" });
    });

    test("FB3 standings: pk charge -0.002 next to the k plus, DEBOUNCED again, 0 = no pk row, parseGrantKey pk, "
      + "the handler writes PIRATE_KILL", () => H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const rt = T.fakeRuntime();
      const off = T.bootStd(reopen(), shared, {}, rt);
      T.seedSystem(off, H.S.N5, GURISTAS);
      const base = shared.clock.now();
      const kill = { characterId: 7, victimFactionId: GURISTAS, systemId: H.S.N5, atMs: base, victimId: 7001 };
      assert.strictEqual(off.config.standings.pirateKillChargeRaw, 0, "default off");
      assert.strictEqual(off.standings.onNpcKill(kill).outcome, "GRANTED");
      assert.deepStrictEqual(T.outboxRows(off).filter((r) => r.k.includes(":pk")), [], "0 = no pk row");
      off.standings.stop("test");
      off.store.close();

      const env = T.bootStd(reopen(), shared, { EVEJS_LNE_STANDINGS_PIRATE_KILL_CHARGE_RAW: "0.002" }, rt);
      const writes = [];
      const apply = env.adapter.applyStandingGrant;
      env.adapter.applyStandingGrant = (grant, data) => {
        writes.push({ key: grant.key, reason: grant.reason, rawChange: grant.rawChange, factionId: grant.factionId,
          eventTypeId: data.eventTypeId });
        return apply(grant, data);
      };
      const kill2 = { ...kill, victimId: 7002 };
      assert.strictEqual(env.standings.onNpcKill(kill2).outcome, "GRANTED", "the plus result as today");
      assert.strictEqual(env.standings.onNpcKill(kill2).outcome, "DEBOUNCED", "the same kill again (plus and pk)");
      const day = SS.dayOf(base);
      const pk = `lne:std:7:${day}:${GURISTAS}:${H.S.N5}:pk${base}.7002`;
      const keys = T.outboxRows(env).map((r) => r.k);
      assert.ok(keys.includes(pk), JSON.stringify(keys));
      assert.strictEqual(keys.filter((k) => k.endsWith(`k${base}.7002`) && !k.includes(":pk")).length, 1, "the k plus");
      const counters = env.standings.getStatus().counters;
      assert.deepStrictEqual([counters.pirateKillCharged, counters.pirateKillDebounced], [1, 1]);
      await T.passesAt(env, shared, base);
      const byKey = Object.fromEntries(writes.map((w) => [w.key, w]));
      assert.deepStrictEqual(byKey[pk], { key: pk, reason: "PIRATE_KILL", rawChange: -0.002, factionId: GURISTAS,
        eventTypeId: STANDINGS_DATA_V1.navyEventTypeId });
      assert.ok(writes.some((w) => w.reason === "PIRATE_SUPPRESSION" && w.rawChange > 0), "the plus applied");
      env.standings.stop("test");

      assert.deepStrictEqual(SS.parseGrantKey(pk), { characterId: 7, day, factionId: GURISTAS, systemId: H.S.N5,
        slot: `pk${base}.7002` });
      assert.deepStrictEqual([SS.isPirateKillSlot(`pk${base}`), SS.isPirateKillSlot(`k${base}`),
        SS.isConvoySlot(`pk${base}`)], [true, false, false]);
      assert.deepStrictEqual(planPirateKillCharge(kill, { pirateKillChargeRaw: 0 }),
        { ok: false, reason: "PENALTY_INVALID_INPUT" });
      assert.strictEqual(STANDINGS_DATA_V1.msgByReason.PIRATE_KILL, "Killing pirates of this faction (Living New Eden)");
    }));
  }

  test("FB4 news: fame facts without the player, a gang revenge -> none, flags off -> none, gated kinds", () => {
    const kinds = (env) => {
      const s = newsSettingsOf(cfg({ EVEJS_LNE_NEWS_ENABLED: "1", ...env }));
      assert.ok(s.ok, JSON.stringify(s));
      return s.settings.kinds;
    };
    const FAME_KINDS = ["FAME_LEGEND", "FAME_PUBLIC_ENEMY", "FAME_BOUNTY"];
    const on = kinds({ EVEJS_LNE_FAME_ENABLED: "1", EVEJS_LNE_FAME_NEWS_ENABLED: "1",
      EVEJS_LNE_FAME_BOUNTY_ENABLED: "1" });
    assert.deepStrictEqual(FAME_KINDS.filter((k) => on.includes(k)), FAME_KINDS);
    assert.deepStrictEqual(FAME_KINDS.filter((k) => kinds({ EVEJS_LNE_FAME_ENABLED: "1",
      EVEJS_LNE_FAME_NEWS_ENABLED: "1" }).includes(k)), ["FAME_LEGEND", "FAME_PUBLIC_ENEMY"]);
    assert.deepStrictEqual(FAME_KINDS.filter((k) => kinds({}).includes(k)), []);
    assert.ok(J.TAIL_AGGREGATE_TYPES.includes("player_fame") && J.TAIL_AGGREGATE_TYPES.includes("bounty_revenge"));
    const e = (journalId, aggregateType, eventType, payload) => ({ journalId, createdAt: T0, aggregateType,
      aggregateId: "x", eventType, payload });
    const entries = [
      e(11, "player_fame", "FAME_TIER_CHANGED", { v: 1, characterId: C1, factionId: GURISTAS, tier: "PUBLIC_ENEMY",
        period: 3 }),
      e(12, "bounty_revenge", "BOUNTY_REVENGE_SWORN", { wantedId: `fame:${C1}:${GURISTAS}:9`, characterId: C1,
        factionId: GURISTAS, level: 3, at: T0 }),
      e(13, "bounty_revenge", "BOUNTY_REVENGE_SWORN", { wantedId: "bnt:1:1", characterId: C1, factionId: GURISTAS,
        level: 4, at: T0 }),
    ];
    const ctx = { refs: new Map(), factionName: () => "Guristas Pirates", place: () => ({ systemName: "X" }) };
    const got = J.factsOfEntries(entries, { ...ctx, kinds: on });
    assert.deepStrictEqual(got.facts.map((f) => [f.factKey, f.kind, f.systemId, f.data.factionA]), [
      ["fm:11", "FAME_PUBLIC_ENEMY", null, "Guristas Pirates"], ["fm:12", "FAME_BOUNTY", null, "Guristas Pirates"]]);
    assert.deepStrictEqual(got.skipped, {}, "a gang revenge: no fact, no skip");
    const text = JSON.stringify(got.facts);
    assert.ok(!text.includes(String(C1)) && !text.includes("Bob") && !text.includes("characterId"), text);
    const offFacts = J.factsOfEntries(entries, { ...ctx, kinds: kinds({}) });
    assert.deepStrictEqual(offFacts.facts, []);
    for (const k of FAME_KINDS) {
      for (const t of Object.values(KIND_DATA[k].template)) {
        for (const m of t.matchAll(/\{([a-z]+)\}/g)) assert.ok(PLACEHOLDERS.includes(m[1]) && m[1] === "a", `${k} ${m[1]}`);
      }
    }
    assert.strictEqual(KIND_DATA.FAME_BOUNTY.template.en, "{a} puts a price on a capsuleer's head.");
    assert.ok(!PLACEHOLDERS.includes("pilot"));
    const warn = (env) => config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(), ...env },
      settings: {}, envFile: {} }).warnings;
    const w = warn({ EVEJS_LNE_FAME_ENABLED: "1", EVEJS_LNE_FAME_BOUNTY_ENABLED: "1", EVEJS_LNE_FAME_NEWS_ENABLED: "1" });
    assert.ok(w.some((x) => x.startsWith("fame.bountyEnabled without bountyHunters.enabled")), "W81");
    assert.ok(w.some((x) => x.startsWith("fame.newsEnabled without news.enabled")), "W83");
    assert.ok(w.some((x) => x.startsWith("fame.bountyEnabled with standings.pirateKillChargeRaw=0")), "W85");
    assert.ok(warn({ EVEJS_LNE_FAME_BOUNTY_ENABLED: "1", EVEJS_LNE_FAME_NEWS_ENABLED: "1" })
      .includes("fame.bountyEnabled, fame.newsEnabled without fame.enabled - no effect"), "W67");
    assert.ok(!warn({}).some((x) => x.startsWith("fame.")));
    assert.strictEqual(FS.fameWantedIdOf(C1, GURISTAS, 9), `fame:${C1}:${GURISTAS}:9`);
  });

  if (driver.ok) {
    test("FB5 the end of a fame: revenge row (DONE through settle) = the hook shape of a gang revenge", () => {
      withStore(driver, (opened) => {
        const P = { ...cfg().bountyHunters, enabled: true, liveEnabled: true, revengeEnabled: true, revengeMaxLive: 4 };
        const journal = createJournal({ clock: { now: () => T0 }, maxPayloadBytes: 4096, maxRows: 500 });
        const own = new Map();
        const players = [];
        const hunt = {
          readPlayerShips: () => ({ ok: true, ships: players.map((s) => ({ ...s })) }),
          readShips: (_s, ids) => ({ ok: true, ships: ids.filter((id) => own.has(id)).map((id) => ({ entityId: id,
            position: { x: 1e9, y: 0, z: 0 }, inWarp: false })) }),
          readAggressors: () => ({ ok: true, aggressors: [] }), setSearch: () => ({ ok: true, failed: [] }),
          warpShips: (_s, ids) => ({ ok: true, warped: ids.length, failed: [] }),
          attackTargets: () => ({ ok: true, failed: [] }),
        };
        let next = 6000000000;
        const marks = [];
        const scene = {
          spawnGroup: (spec) => {
            const bossId = (next += 1);
            const escortIds = spec.escorts.map(() => (next += 1));
            for (const id of [bossId, ...escortIds]) own.set(id, true);
            return { ok: true, bossId, escortIds, anchorPoint: { x: 1e9, y: 0, z: 0 } };
          },
          despawn: (_s, ids) => {
            for (const id of ids) own.delete(id);
            return { ok: true };
          },
          markShips: (ids, o) => {
            marks.push({ ids: ids.slice(), ...o });
            return { ok: true };
          },
          forgetShips: () => ({ ok: true }),
        };
        const presence = { observedSystems: () => [SYS], getSystemPresence: () => ({ systemId: SYS,
          characters: [{ characterId: C1, state: "space" }, { characterId: C1 + 1, state: "space" }] }) };
        const hooks = [];
        const step = RV.createRevengeStep({ settings: P, store: opened.store, worldSeed: 7, journal,
          getPresence: () => presence, getGraph: () => line(), bump() {}, log() {}, onStale() {}, levels: LEVELS,
          getScene: () => scene, getHuntScene: () => hunt, getHuntParams: () => cfg().playerHunt,
          getVirtualCorps: () => vcOf(), sendCharacterSystemLine: () => ({ ok: true }),
          onRevengeEndInTx: (_tx, ended, outcome) => {
            hooks.push({ wantedId: ended.wantedId, outcome });
            return null;
          } });
        const killedAt = T0 - P.revengeDelayMs - 1000;
        const made = opened.store.transaction("fb5.create", (tx) => [
          step.createFameInTx(tx, { wantedId: `fame:${C1}:${GURISTAS}:1`, characterId: C1, factionId: GURISTAS,
            level: 4, systemId: SYS, at: killedAt, delayMs: P.revengeDelayMs, windowMs: P.revengeWindowMs },
          { gangId: 1, bossCharacterId: 7010 }),
          RR.createRevengeInTx(tx, { wantedId: "bnt:1:1", characterId: C1 + 1, factionId: GURISTAS, gangId: 1,
            bossCharacterId: 7010, targetLevel: 4, killSystemId: SYS, killedAt, seed: 4, delayMs: P.revengeDelayMs,
            windowMs: P.revengeWindowMs }, killedAt)]);
        assert.ok(made.ok && made.value[0].outcome === "created" && made.value[1].created, JSON.stringify(made));
        const read = opened.store.transaction("fb5.read", (tx) => step.readInTx(tx, T0, false));
        step.load(read.value.rows);
        for (const cid of [C1, C1 + 1]) {
          players.push({ characterId: cid, entityId: 900000 + cid, typeId: 587, groupId: 25,
            position: { x: 0, y: 0, z: 0 }, inWarp: false, cloaked: false, capsule: false, signatureRadius: 100 });
        }
        step.step(T0);
        step.step(T0 + 1);
        assert.strictEqual(marks.length, 2, "two squads in space");
        step.step(T0 + 2);
        for (const m of marks) step.onHunterKill({ wantedId: m.wantedId, version: m.version, victimId: m.ids[0] });
        players.length = 0;
        step.step(T0 + 3 + P.idleDespawnMs);
        assert.strictEqual(hooks.length, 2, JSON.stringify(hooks));
        const byWanted = Object.fromEntries(hooks.map((h) => [h.wantedId, h.outcome]));
        const fame = byWanted[`fame:${C1}:${GURISTAS}:1`];
        const gang = byWanted["bnt:1:1"];
        const shape = (o) => Object.keys(o).sort().map((k) => [k, o[k] === null ? "null" : typeof o[k]]);
        assert.deepStrictEqual(shape(fame), shape(gang));
        assert.deepStrictEqual([fame.state, fame.nemesisId, fame.bossKilled, fame.reason, fame.characterId],
          ["DONE", null, true, "IDLE", C1]);
        assert.deepStrictEqual([gang.state, gang.bossKilled], ["DONE", true]);
        step.stop();
      });
    });
  }
};
