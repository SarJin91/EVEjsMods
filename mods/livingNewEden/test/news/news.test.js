"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { createJournal } = require("../../lib/persistence/journal");
const { createManualClock } = require("../../lib/util/clock");
const { createViewRegistry } = require("../../lib/observer/views");
const { resolveConfig, SCHEMA } = require("../../config");
const S = require("../../lib/news/schema");
const { KIND_DATA, PLACEHOLDERS, weightOf } = require("../../lib/news/data/kinds");
const { factsOfWarViews } = require("../../lib/news/collect/warFacts");
const J = require("../../lib/news/collect/journalFacts");
const { selectFacts } = require("../../lib/news/select");
const { boundaryAtOrBefore } = require("../../lib/news/cycle");
const { renderFallback } = require("../../lib/news/fallback");
const { createNewsRepository } = require("../../lib/news/repository");
const { createNewsTail } = require("../../lib/news/tail");
const { startNews, createUnavailableNews } = require("../../lib/news");
const { SETTLED_EVENT } = require("../../lib/battle/settlement");
const { parseComposeEnv } = require("../../tools/liveSim/compose");
const { loadDriver, withStore } = require("../notices/storeHelper");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const B = Date.UTC(2026, 10, 15, 17, 0, 0);
const H = 3600000;
const SYS = 30000142;
const FA = 500001;
const FB = 500002;
const NAMES = new Map([[FA, "Caldari State"], [FB, "Gallente Federation"]]);
const graph = Object.freeze({
  getSystem: (id) => (id === SYS ? { systemId: id, name: "Jita", regionId: 10000002 } : null),
  getRegionName: () => "The Forge",
});

function newsConfig(env = {}) {
  const r = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_NEWS_ENABLED: "1", ...env } });
  assert.ok(r.ok, JSON.stringify(r.errors));
  return r.config;
}

function settings(env) {
  const r = S.newsSettingsOf(newsConfig(env));
  assert.ok(r.ok, JSON.stringify(r));
  return r.settings;
}

function battle(at, systemId, a, b, da, db) {
  return { journalId: 1, createdAt: at, aggregateType: "battle", aggregateId: `b${at}`, eventType: "BATTLE_SETTLED",
    payload: { systemId, outcome: "A_WIN", sideA: { factionId: a, destroyed: da }, sideB: { factionId: b, destroyed: db } } };
}

function fact(key, kind, weight, at, systemId, data = {}) {
  return { factKey: key, kind, weight, at, systemId, data: { v: 1, systemName: "Jita", ...data } };
}

const ctxOf = (s, refs = new Map()) => ({ kinds: s.kinds, capitalClasses: s.capitalClasses, refs,
  cycleHours: s.cycleHours, publishHourUtc: s.publishHourUtc,
  place: (id) => (id === SYS ? { systemName: "Jita", regionName: "The Forge" } : null),
  factionName: (id) => NAMES.get(id) || null });

module.exports = ({ test, skip }) => {
  test("N1 news facts: war views -> w: keys without PLAYER_IMPACT; journal rows -> bt / pj / tr keys, REF_MISSING, "
    + "BAD_PAYLOAD", () => {
    const s = settings();
    const views = [
      { eventKey: "occ:1:2", kind: "SYSTEM_CAPTURED", systemId: SYS, at: B - H, attackerName: "Caldari State",
        defenderName: "Gallente Federation", systemName: "Jita", regionName: "The Forge", recipients: [90000001],
        outcome: null },
      { eventKey: "imp:1", kind: "PLAYER_IMPACT", systemId: SYS, at: B - H, recipients: [90000001] },
    ];
    const war = factsOfWarViews(views, { kinds: s.kinds });
    assert.deepStrictEqual(war.facts.map((f) => f.factKey), ["w:occ:1:2"]);
    assert.strictEqual(war.skipped.PERSONAL, 1);
    assert.deepStrictEqual(Object.keys(war.facts[0].data).sort(),
      ["factionA", "factionB", "outcome", "regionName", "systemName", "v"]);
    assert.strictEqual(war.facts[0].weight, 80);

    const day = B - 5 * H;
    const created = { journalId: 3, createdAt: day, aggregateType: "production_job", aggregateId: "J1",
      eventType: "PRODUCTION_JOB_CREATED", payload: { jobId: "J1", factionId: FA, stationId: 60003760,
        hullGroup: "titan", runs: 1 } };
    const carrier = { ...created, aggregateId: "J9", payload: { ...created.payload, jobId: "J9", hullGroup: "carrier" } };
    const done = (jobId) => ({ journalId: 4, createdAt: day + 1, aggregateType: "production_job", aggregateId: jobId,
      eventType: "PRODUCTION_JOB_TRANSITION", payload: { jobId, from: "ACTIVE", to: "DELIVERED", endReason: "DONE" } });
    const treasury = { journalId: 77, createdAt: day, aggregateType: "faction_treasury", aggregateId: String(FB),
      eventType: "TREASURY_SETTLED", payload: { factionId: FB, credits: {}, debits: {}, stats: {},
        patch: { mode: "AUSTERITY" } } };
    const quiet = { ...treasury, journalId: 78, payload: { ...treasury.payload, patch: {} } };
    const broken = battle(day, SYS, FA, FB, 1, 1);
    broken.payload.sideB = null;
    const entries = [battle(day, SYS, FB, FA, 3, 4), battle(day + H, SYS, FA, FB, 5, 6), created, carrier,
      done("J2"), treasury, quiet, broken];
    assert.deepStrictEqual(J.refKeysOf(entries), ["pj:J2:start"]);
    const got = J.factsOfEntries(entries, ctxOf(s));
    assert.deepStrictEqual(got.facts.map((f) => f.factKey), [`bt:${B}:${SYS}:${FA}:${FB}`,
      `bt:${B}:${SYS}:${FA}:${FB}`, "pj:J1:start", "tr:77"]);
    assert.strictEqual(got.facts[0].merge, "battle");
    assert.strictEqual(got.facts[0].data.destroyed, 7);
    assert.strictEqual(got.facts[0].weight, 27);
    assert.strictEqual(got.facts[0].data.factionA, "Caldari State", "the lower faction id first");
    assert.strictEqual(got.facts[2].kind, "CAPITAL_STARTED");
    assert.strictEqual(got.facts[2].weight, 90);
    assert.strictEqual(got.facts[3].kind, "TREASURY_CRISIS");
    assert.deepStrictEqual(got.skipped, { REF_MISSING: 1, BAD_PAYLOAD: 1 });
    const start = got.facts[2];
    const withRef = J.factsOfEntries([done("J1")], ctxOf(s, new Map([[start.factKey, start]])));
    assert.deepStrictEqual(withRef.facts.map((f) => [f.factKey, f.kind, f.weight]),
      [["pj:J1:done", "CAPITAL_DELIVERED", 95]]);
    assert.strictEqual(J.BATTLE_SETTLED, SETTLED_EVENT);
    const inv = fs.readFileSync(path.join(MOD_DIR, "lib", "world", "invasions", "invasionService.js"), "utf8");
    assert.ok(inv.includes(`eventType: "${J.INVASION_SPAWNED}"`), "INVASION_SPAWNED literal of invasionService.js");
    assert.ok(fs.readFileSync(path.join(MOD_DIR, "lib", "battle", "settlement.js"), "utf8")
      .includes(`const BATTLE_AGGREGATE = "${J.BATTLE_AGGREGATE}";`));
  });

  test("N2 news selection + fallback: limits, battle threshold, permutation; en / pl text without braces; "
    + "every kind in data/kinds.js", () => {
    const s = settings({ EVEJS_LNE_NEWS_MAX_FACTS_PER_EDITION: "4", EVEJS_LNE_NEWS_MAX_PER_KIND: "2",
      EVEJS_LNE_NEWS_MAX_PER_SYSTEM: "2" });
    const set = [
      fact("a", "SYSTEM_CAPTURED", 80, B - 1, 1), fact("b", "SYSTEM_CAPTURED", 80, B - 2, 2),
      fact("c", "SYSTEM_CAPTURED", 80, B - 3, 3),
      fact("d", "INVASION_STARTED", 85, B - 4, 1), fact("e", "SIEGE_ENDED", 65, B - 5, 1),
      fact("f", "BATTLE", weightOf("BATTLE", { destroyed: 9 }), B - 6, 9, { destroyed: 9 }),
      fact("g", "BATTLE", weightOf("BATTLE", { destroyed: 40 }), B - 7, 8, { destroyed: 40 }),
      fact("h", "TREASURY_CRISIS", 75, B - 8, null), fact("i", "TREASURY_RECOVERED", 35, B - 9, null),
    ];
    const r = selectFacts(set, s);
    assert.deepStrictEqual(r.selected.map((f) => f.factKey), ["d", "a", "b", "h"]);
    assert.strictEqual(r.selected.length + r.dropped.length, set.length);
    for (const perm of [set.slice().reverse(), [...set.slice(4), ...set.slice(0, 4)]]) {
      assert.deepStrictEqual(selectFacts(perm, s).selected.map((f) => f.factKey), ["d", "a", "b", "h"]);
    }
    const one = selectFacts(set, { ...s, maxFactsPerEdition: 30, maxPerKind: 30, maxPerSystem: 30 });
    assert.ok(!one.selected.some((f) => f.factKey === "f") && one.selected.some((f) => f.factKey === "g"));
    for (const kind of S.KINDS) {
      const e = KIND_DATA[kind];
      assert.ok(e && Number.isSafeInteger(e.weight) && e.label.en && e.label.pl, kind);
      for (const lang of S.LANGUAGES) {
        for (const m of e.template[lang].matchAll(/\{([^}]*)\}/g)) assert.ok(PLACEHOLDERS.includes(m[1]), `${kind} ${m[1]}`);
      }
    }
    assert.deepStrictEqual(Object.keys(KIND_DATA).sort(), [...S.KINDS].sort());
    const all = S.KINDS.map((kind, i) => ({ factKey: `k${i}`, kind, at: B - i, systemId: null, weight: 1,
      data: i % 2 ? { systemName: null, regionName: null, factionA: null, factionB: null }
        : { systemName: "Jita", regionName: "The Forge", factionA: "A".repeat(140), factionB: "Gallente Federation",
          hullClass: "titan", destroyed: 12 } }));
    for (const language of S.LANGUAGES) {
      const t = renderFallback(all, { language, boundaryAt: B, cycleHours: 24, seq: 3, maxTitleChars: 40 });
      const text = [t.title, ...t.paragraphs].join("\n");
      assert.ok(!/[{}]/.test(text), text);
      assert.ok(t.title.length <= 40, t.title);
      assert.strictEqual(t.paragraphs.length, all.length + 1);
      assert.ok(t.paragraphs[0].includes("#3") && t.paragraphs[0].includes("17:00–17:00 UTC"), t.paragraphs[0]);
      assert.ok(text.includes(language === "pl" ? "nieznany system" : "unknown system"), language);
    }
    const quiet = renderFallback([], { language: "pl", boundaryAt: B, cycleHours: 6, seq: 1, maxTitleChars: 100 });
    assert.ok(quiet.paragraphs[0].includes("11:00–17:00 UTC") && quiet.paragraphs.length === 2, quiet.paragraphs[0]);
  });

  const truceEntry = (payload, eventType = "WAR_PAIR_TRUCE") => ({ journalId: 90, createdAt: B - 2 * H,
    aggregateType: "world_war_pair", aggregateId: `${FA}:${FB}`, eventType, payload });
  const TRUCE_PAYLOAD = Object.freeze({ lo: FA, hi: FB, at: B - 2 * H, lossesLo: 0, lossesHi: 70, winner: FA,
    truceUntil: B + 46 * H, initiator: FB });
  const truceOn = () => settings({ EVEJS_LNE_STRATEGY_TRUCE_ENABLED: "1" });

  test("N-TR1 WAR_PAIR_TRUCE -> one fact tc:lo:hi:until, factionA = initiator, factionB = the other side; "
    + "WAR_PAIR_CHANGED -> nothing; initiator outside the pair -> BAD_PAYLOAD", () => {
    const s = truceOn();
    const adapterNames = { ok: true, names: { [FA]: "Caldari State", [FB]: "Gallente Federation" } };
    const ctx = { ...ctxOf(s), factionName: (id) => adapterNames.names[id] || null };
    const got = J.factsOfEntries([truceEntry(TRUCE_PAYLOAD)], ctx);
    assert.deepStrictEqual(got.skipped, {});
    assert.deepStrictEqual(got.facts.map((f) => [f.factKey, f.kind, f.systemId, f.weight, f.data.factionA,
      f.data.factionB]), [[`tc:${FA}:${FB}:${B + 46 * H}`, "TRUCE_AGREED", null, 60, "Gallente Federation",
      "Caldari State"]]);
    for (const language of S.LANGUAGES) {
      const t = renderFallback(got.facts, { language, boundaryAt: B, cycleHours: 24, seq: 1, maxTitleChars: 100 });
      const text = t.paragraphs.join("\n");
      assert.ok(text.includes("Caldari State") && text.includes("Gallente Federation"), text);
    }
    const { truceUntil: _u, initiator: _i, ...battleOnly } = TRUCE_PAYLOAD;
    assert.deepStrictEqual(J.factsOfEntries([truceEntry(battleOnly, "WAR_PAIR_CHANGED")], ctx),
      { facts: [], skipped: {} });
    const bad = J.factsOfEntries([truceEntry({ ...TRUCE_PAYLOAD, initiator: 500099 })], ctx);
    assert.deepStrictEqual([bad.facts.length, bad.skipped], [0, { BAD_PAYLOAD: 1 }]);
    assert.ok(J.TAIL_AGGREGATE_TYPES.includes("world_war_pair"));
  });

  test("N-TR2 strategy.truceEnabled false -> no TRUCE_AGREED in kinds (also an explicit CSV), the fact -> KIND_OFF; "
    + "true -> in kinds", () => {
    const off = settings();
    const offCsv = settings({ EVEJS_LNE_NEWS_KINDS: "BATTLE,TRUCE_AGREED" });
    assert.ok(!off.kinds.includes("TRUCE_AGREED"));
    assert.deepStrictEqual(offCsv.kinds, ["BATTLE"]);
    assert.deepStrictEqual(J.factsOfEntries([truceEntry(TRUCE_PAYLOAD)], ctxOf(off)), { facts: [],
      skipped: { KIND_OFF: 1 } });
    assert.ok(truceOn().kinds.includes("TRUCE_AGREED"));
    assert.deepStrictEqual(settings({ EVEJS_LNE_STRATEGY_TRUCE_ENABLED: "1",
      EVEJS_LNE_NEWS_KINDS: "BATTLE,TRUCE_AGREED" }).kinds, ["BATTLE", "TRUCE_AGREED"]);
  });

  test("N-JCS5 BASTION_STATION_RETURNED -> bsr:<stationId>:<at> (a = to, b = from, systemId); flag off -> no "
    + "STATION_RETURNED in kinds, the fact -> KIND_OFF; from = to -> BAD_PAYLOAD", () => {
    const on = settings({ EVEJS_LNE_WORLD_NPC_SOV_BASTION_STATION_RETURN_ENABLED: "1" });
    const at = B - 3 * H;
    const entry = (payload) => ({ journalId: 91, createdAt: at, aggregateType: "world_bastion_station",
      aggregateId: "npc-60012598", eventType: "BASTION_STATION_RETURNED", payload });
    const P = Object.freeze({ stationId: "npc-60012598", systemId: SYS, fromFactionId: FB, toFactionId: FA, at });
    const got = J.factsOfEntries([entry(P)], ctxOf(on));
    assert.deepStrictEqual(got.skipped, {});
    assert.deepStrictEqual(got.facts.map((f) => [f.factKey, f.kind, f.systemId, f.weight, f.data.factionA,
      f.data.factionB, f.data.systemName]), [[`bsr:npc-60012598:${at}`, "STATION_RETURNED", SYS, 55, "Caldari State",
      "Gallente Federation", "Jita"]]);
    for (const language of S.LANGUAGES) {
      const t = renderFallback(got.facts, { language, boundaryAt: B, cycleHours: 24, seq: 1, maxTitleChars: 100 });
      const text = t.paragraphs.join("\n");
      assert.ok(text.includes("Caldari State") && text.includes("Gallente Federation") && !/[{}]/.test(text), text);
    }
    const bad = J.factsOfEntries([entry({ ...P, fromFactionId: FA })], ctxOf(on));
    assert.deepStrictEqual([bad.facts.length, bad.skipped], [0, { BAD_PAYLOAD: 1 }]);
    const off = settings();
    assert.ok(!off.kinds.includes("STATION_RETURNED") && on.kinds.includes("STATION_RETURNED"));
    assert.deepStrictEqual(settings({ EVEJS_LNE_NEWS_KINDS: "BATTLE,STATION_RETURNED" }).kinds, ["BATTLE"]);
    assert.deepStrictEqual(J.factsOfEntries([entry(P)], ctxOf(off)), { facts: [], skipped: { KIND_OFF: 1 } });
    assert.ok(J.TAIL_AGGREGATE_TYPES.includes("world_bastion_station"));
  });

  test("N-BH1 BOUNTY_CLAIMED -> bc:<periodEnd> (merge battle, {n} = count, no system); flag off -> KIND_OFF", () => {
    const on = settings({ EVEJS_LNE_BOUNTY_ENABLED: "1", EVEJS_LNE_BOUNTY_LIVE_ENABLED: "1" });
    const at = B - 3 * H;
    const entry = (id) => ({ journalId: 92, createdAt: at, aggregateType: "bounty", aggregateId: id,
      eventType: "BOUNTY_CLAIMED", payload: { wantedId: id, level: 3, factionId: FA, at } });
    const got = J.factsOfEntries([entry("bnt:1:1"), entry("bnt:2:1")], ctxOf(on));
    assert.deepStrictEqual(got.facts.map((f) => [f.factKey, f.kind, f.systemId, f.merge, f.data.destroyed]),
      [[`bc:${B}`, "BOUNTY_CLAIMED", null, "battle", 1], [`bc:${B}`, "BOUNTY_CLAIMED", null, "battle", 1]]);
    for (const language of S.LANGUAGES) {
      const t = renderFallback([{ ...got.facts[0], data: { ...got.facts[0].data, destroyed: 2 } }],
        { language, boundaryAt: B, cycleHours: 24, seq: 1, maxTitleChars: 100 });
      assert.ok(t.paragraphs[1].includes("2") && !/[{}]/.test(t.paragraphs[1]), t.paragraphs[1]);
    }
    const off = settings();
    assert.ok(!off.kinds.includes("BOUNTY_CLAIMED") && on.kinds.includes("BOUNTY_CLAIMED"));
    assert.deepStrictEqual(J.factsOfEntries([entry("bnt:1:1")], ctxOf(off)).skipped, { KIND_OFF: 1 });
    assert.ok(J.TAIL_AGGREGATE_TYPES.includes("bounty"));
  });

  test("N-native NATIVE_INCURSION_SETTLE -> nis:<taleId>:g<gen> (defeated -> DEFEATED 70, expired -> HELD 50); "
    + "vanished / BIND -> nothing; bad payload -> BAD_PAYLOAD; without newsEnabled -> no NATIVE_INCURSION_* kinds", () => {
    const ON = { EVEJS_LNE_NATIVE_INCURSIONS_ENABLED: "1", EVEJS_LNE_NATIVE_INCURSIONS_SETTLE_ENABLED: "1" };
    const on = settings({ ...ON, EVEJS_LNE_NATIVE_INCURSIONS_NEWS_ENABLED: "1" });
    const at = B - 3 * H;
    const entry = (eventType, payload) => ({ journalId: 93, createdAt: at, aggregateType: "native_incursion",
      aggregateId: String(payload.taleId), eventType, payload });
    const settle = (taleId, outcome) => entry("NATIVE_INCURSION_SETTLE", { taleId, generation: 2, outcome,
      targetSystemId: SYS });
    const got = J.factsOfEntries([settle(11, "defeated"), settle(12, "expired"), settle(13, "vanished"),
      entry("NATIVE_INCURSION_BIND", { taleId: 14, generation: 2 })], ctxOf(on));
    assert.deepStrictEqual(got.skipped, {});
    assert.deepStrictEqual(got.facts.map((f) => [f.factKey, f.kind, f.systemId, f.weight, f.data.systemName]),
      [["nis:11:g2", "NATIVE_INCURSION_DEFEATED", SYS, 70, "Jita"], ["nis:12:g2", "NATIVE_INCURSION_HELD", SYS, 50,
        "Jita"]]);
    for (const language of S.LANGUAGES) {
      const t = renderFallback(got.facts, { language, boundaryAt: B, cycleHours: 24, seq: 1, maxTitleChars: 100 });
      const text = t.paragraphs.join("\n");
      assert.ok(text.includes("Jita") && !/[{}]/.test(text), text);
    }
    assert.deepStrictEqual(J.factsOfEntries([entry("NATIVE_INCURSION_SETTLE", { taleId: 11, generation: 2,
      outcome: "won", targetSystemId: SYS })], ctxOf(on)).skipped, { BAD_PAYLOAD: 1 });
    for (const off of [settings(), settings(ON), settings({ EVEJS_LNE_NATIVE_INCURSIONS_NEWS_ENABLED: "1" })]) {
      assert.ok(!off.kinds.some((k) => k.startsWith("NATIVE_INCURSION_")), JSON.stringify(off.kinds));
    }
    assert.ok(on.kinds.includes("NATIVE_INCURSION_DEFEATED") && on.kinds.includes("NATIVE_INCURSION_HELD"));
    assert.ok(J.TAIL_AGGREGATE_TYPES.includes("native_incursion"));
  });

  test("N-finc FACTION_INCURSION_SETTLE -> fis:<id>:g1 (defeated -> DEFEATED 70, expired -> HELD 50, {a} = faction); "
    + "cancelled / no factionId / CREATE -> nothing; bad outcome -> BAD_PAYLOAD; kinds need both consequence flags", () => {
    const ON = { EVEJS_LNE_FACTION_INCURSIONS_ENABLED: "1", EVEJS_LNE_FACTION_INCURSIONS_SETTLE_ENABLED: "1",
      EVEJS_LNE_FACTION_INCURSIONS_CONSEQUENCES_ENABLED: "1" };
    const on = settings({ ...ON, EVEJS_LNE_FACTION_INCURSIONS_CONSEQUENCES_NEWS_ENABLED: "1" });
    const at = B - 3 * H;
    const entry = (eventType, payload) => ({ journalId: 94, createdAt: at, aggregateType: "faction_incursion",
      aggregateId: String(payload.incursionId), eventType, payload });
    const settle = (incursionId, outcome, extra = { factionId: FA }) => entry("FACTION_INCURSION_SETTLE",
      { incursionId, outcome, targetSystemId: SYS, ...extra });
    const got = J.factsOfEntries([settle(21, "defeated"), settle(22, "expired"), settle(23, "cancelled"),
      settle(24, "defeated", {}), entry("FACTION_INCURSION_CREATE", { incursionId: 25, factionId: FA })], ctxOf(on));
    assert.deepStrictEqual(got.skipped, {});
    assert.deepStrictEqual(got.facts.map((f) => [f.factKey, f.kind, f.systemId, f.weight, f.data.factionA]),
      [["fis:21:g1", "FACTION_INCURSION_DEFEATED", SYS, 70, "Caldari State"],
        ["fis:22:g1", "FACTION_INCURSION_HELD", SYS, 50, "Caldari State"]]);
    for (const language of S.LANGUAGES) {
      const t = renderFallback(got.facts, { language, boundaryAt: B, cycleHours: 24, seq: 1, maxTitleChars: 100 });
      const text = t.paragraphs.join("\n");
      assert.ok(text.includes("Jita") && text.includes("Caldari State") && !/[{}]/.test(text), text);
    }
    assert.deepStrictEqual(J.factsOfEntries([settle(21, "won")], ctxOf(on)).skipped, { BAD_PAYLOAD: 1 });
    for (const off of [settings(), settings(ON), settings({ ...ON, EVEJS_LNE_FACTION_INCURSIONS_CONSEQUENCES_ENABLED:
      "0", EVEJS_LNE_FACTION_INCURSIONS_CONSEQUENCES_NEWS_ENABLED: "1" })]) {
      assert.ok(!off.kinds.some((k) => k.startsWith("FACTION_INCURSION_")), JSON.stringify(off.kinds));
    }
    assert.ok(on.kinds.includes("FACTION_INCURSION_DEFEATED") && on.kinds.includes("FACTION_INCURSION_HELD"));
    assert.ok(J.TAIL_AGGREGATE_TYPES.includes("faction_incursion"));
  });

  const driver = loadDriver();
  if (!driver.ok) {
    for (const n of ["SC3", "N3", "N4", "N5"]) skip(`${n} news (store)`, `no sqlite driver: ${driver.detail}`);
    return;
  }

  test("SC3 SITUATION_RESOLVED -> sr:<periodEnd> (merge battle, saved {n} + lost {m}, no system) merged into one row; "
    + "STARTED -> nothing; saved > victims -> BAD_PAYLOAD; flag off -> KIND_OFF", () => withStore(driver, (opened) => {
    const SIT = require("../../lib/situations/schema");
    assert.deepStrictEqual([SIT.EVENT_RESOLVED, SIT.AGGREGATE], ["SITUATION_RESOLVED", "situation"]);
    assert.ok(J.TAIL_AGGREGATE_TYPES.includes("situation"));
    const on = settings({ EVEJS_LNE_SITUATIONS_ENABLED: "1", EVEJS_LNE_SITUATIONS_NEWS_ENABLED: "1" });
    const at = B - 3 * H;
    const entry = (id, payload, eventType = "SITUATION_RESOLVED") => ({ journalId: 93, createdAt: at,
      aggregateType: "situation", aggregateId: id, eventType, payload });
    const rescued = entry("s1-1", { kind: "BELT_RAID", systemId: SYS, outcome: "RESCUED", victims: 3, saved: 2 });
    const lost = entry("s1-2", { kind: "BELT_RAID", systemId: SYS, outcome: "LOST", victims: 2, saved: 0 });
    const got = J.factsOfEntries([rescued, lost, entry("s1-3", { kind: "BELT_RAID", systemId: SYS, bucket: 1 },
      "SITUATION_STARTED")], ctxOf(on));
    assert.deepStrictEqual(got.skipped, {});
    assert.deepStrictEqual(got.facts.map((f) => [f.factKey, f.kind, f.systemId, f.merge, f.data.destroyed, f.data.lost]),
      [[`sr:${B}`, "SITUATION_RESOLVED", null, "battle", 2, 1], [`sr:${B}`, "SITUATION_RESOLVED", null, "battle", 0, 2]]);
    const repo = createNewsRepository({ weightOf });
    const r = opened.store.transaction("sc3", (db) => repo.upsertFactsInTx(db, got.facts, at));
    assert.ok(r.ok && r.value.ok, JSON.stringify(r));
    const rows = opened.store.transaction("sc3.read", (db) => db.prepare("SELECT fact_key AS k, merges, data_json AS d "
      + "FROM lne_news_facts").all()).value;
    assert.strictEqual(rows.length, 1);
    const d = JSON.parse(rows[0].d);
    assert.deepStrictEqual([rows[0].k, rows[0].merges, d.destroyed, d.lost], [`sr:${B}`, 2, 2, 3]);
    for (const language of S.LANGUAGES) {
      const t = renderFallback([{ ...got.facts[0], data: d }], { language, boundaryAt: B, cycleHours: 24, seq: 1,
        maxTitleChars: 100 });
      assert.ok(t.paragraphs[1].includes("2") && t.paragraphs[1].includes("3") && !/[{}]/.test(t.paragraphs[1]),
        t.paragraphs[1]);
    }
    const bad = J.factsOfEntries([entry("s1-4", { kind: "BELT_RAID", systemId: SYS, outcome: "RESCUED", victims: 2,
      saved: 3 })], ctxOf(on));
    assert.deepStrictEqual([bad.facts.length, bad.skipped], [0, { BAD_PAYLOAD: 1 }]);
    const off = settings();
    assert.ok(!off.kinds.includes("SITUATION_RESOLVED") && on.kinds.includes("SITUATION_RESOLVED"));
    assert.deepStrictEqual(J.factsOfEntries([rescued], ctxOf(off)).skipped, { KIND_OFF: 1 });
  }));

  function env(opened, t0) {
    const clock = createManualClock(t0);
    const journal = createJournal({ clock, maxPayloadBytes: 8192, maxRows: 500 });
    const store = opened.store;
    const tx = (fn) => {
      const r = store.transaction("test", fn);
      assert.ok(r.ok, JSON.stringify(r));
      return r.value;
    };
    let n = 0;
    const write = (aggregateType, aggregateId, eventType, payload) => tx((db) => {
      n += 1;
      const r = journal.applyOnce(db, { key: `t:${n}`, aggregate: { type: aggregateType, id: aggregateId }, eventType,
        payload }, () => ({ ok: true }));
      assert.ok(r.ok, JSON.stringify(r));
      return r;
    });
    const settle = (id, da, db) => write("battle", id, "BATTLE_SETTLED", { systemId: SYS, outcome: "A_WIN",
      sideA: { factionId: FA, destroyed: da }, sideB: { factionId: FB, destroyed: db } });
    const facts = () => tx((db) => db.prepare("SELECT fact_key AS k, merges, data_json AS d, edition_id AS e, "
      + "updated_at AS u FROM lne_news_facts ORDER BY fact_key").all());
    const cursor = () => tx((db) => {
      const r = db.prepare("SELECT journal_cursor AS c FROM lne_news_state WHERE id = 1").get();
      return r ? Number(r.c) : null;
    });
    const head = () => tx((db) => journal.headId(db).headId);
    return { clock, journal, store, tx, write, settle, facts, cursor, head };
  }

  test("N3 news tail + repository: bootstrap at the head, facts + cursor in one tx, a forced refusal rolls both "
    + "back (merge counted once), a merge into an assigned fact -> late", () => withStore(driver, (opened) => {
    const e = env(opened, B - 6 * H);
    const s = settings();
    e.settle("old", 50, 50);
    const base = createNewsRepository({ weightOf });
    let failNext = false;
    const repo = { ...base, upsertFactsInTx: (db, facts, now) => {
      const r = base.upsertFactsInTx(db, facts, now);
      if (!failNext) return r;
      failNext = false;
      return { ok: false, reason: "FORCED" };
    } };
    const counts = {};
    const tail = createNewsTail({ store: e.store, journal: e.journal, repo, settings: s,
      place: () => ({ systemName: "Jita", regionName: "The Forge" }), factionName: (id) => NAMES.get(id) || null,
      bump: (k, n = 1) => {
        counts[k] = (counts[k] || 0) + n;
      } });
    const b = tail.bootstrap(e.clock.now());
    assert.deepStrictEqual([b.ok, b.created, b.cursor], [true, true, e.head()]);
    assert.strictEqual(e.cursor(), e.head(), "no history: the old battle is not read");
    e.settle("b1", 3, 4);
    e.settle("b2", 5, 6);
    failNext = true;
    const before = e.cursor();
    const refused = tail.runPass(e.clock.now());
    assert.deepStrictEqual([refused.ok, refused.reason], [false, "FORCED"]);
    assert.strictEqual(e.cursor(), before, "cursor unchanged");
    assert.deepStrictEqual(e.facts(), [], "facts rolled back");
    const ok = tail.runPass(e.clock.now());
    assert.ok(ok.ok, JSON.stringify(ok));
    assert.strictEqual(e.cursor(), e.head());
    const rows = e.facts();
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].merges, 2, "two battles merged once");
    assert.strictEqual(JSON.parse(rows[0].d).destroyed, 18);
    assert.deepStrictEqual([counts.factsInserted, counts.factsMerged, counts.tailRows], [1, 1, 2]);
    assert.deepStrictEqual(tail.runPass(e.clock.now()).rows, 0, "nothing new");
    e.tx((db) => db.prepare("UPDATE lne_news_facts SET edition_id = 'ed:1', selected = 1").run());
    const frozen = e.facts();
    e.clock.advance(60000);
    e.settle("b3", 1, 1);
    assert.ok(tail.runPass(e.clock.now()).ok);
    assert.deepStrictEqual(e.facts(), frozen);
    assert.strictEqual(counts.factsLate, 1);
    e.clock.set(B + H);
    e.settle("b4", 2, 2);
    assert.ok(tail.runPass(e.clock.now()).ok);
    const after = e.facts();
    assert.deepStrictEqual(after.map((r) => [r.k, r.e]), [[`bt:${B}:${SYS}:${FA}:${FB}`, "ed:1"],
      [`bt:${B + 24 * H}:${SYS}:${FA}:${FB}`, null]]);
    assert.strictEqual(counts.factsLate, 1, "not late");
  }));

  function fakeCtx(opened, journal, views, notices) {
    return { persistence: { ok: true, store: opened.store, journal }, graph: { getGraph: () => ({ ok: true, graph }) },
      views, notices: notices || { onWarEvents: () => ({ ok: false, reason: "NOTICES_DISABLED" }) } };
  }
  const timers = () => {
    const armed = [];
    return { armed, setTimer: (fn, ms) => {
      armed.push(ms);
      return { cancel() {}, hasRef: () => false };
    } };
  };
  const adapter = { readFactionNames: () => ({ ok: true, names: NAMES }) };

  test("N4 news cycle + restart: boundaries, one PUBLISHED FALLBACK edition after B + settleDelayMs, no second one "
    + "after a restart, a long gap -> only the newest boundary (SKIPPED)", () => withStore(driver, (opened) => {
    const cfg = { cycleHours: 24, publishHourUtc: 17 };
    assert.strictEqual(boundaryAtOrBefore(B + 1, cfg), B);
    assert.strictEqual(boundaryAtOrBefore(B, cfg), B);
    assert.strictEqual(boundaryAtOrBefore(B - 1, cfg), B - 24 * H);
    assert.strictEqual(boundaryAtOrBefore(Date.UTC(2026, 10, 15, 12, 0, 0), { cycleHours: 6, publishHourUtc: 17 }),
      Date.UTC(2026, 10, 15, 11, 0, 0));
    assert.strictEqual(boundaryAtOrBefore(Date.UTC(2026, 10, 16, 4, 59, 0), { cycleHours: 6, publishHourUtc: 17 }),
      Date.UTC(2026, 10, 15, 23, 0, 0));

    const e = env(opened, B - 3 * H);
    const config = newsConfig();
    let listener = null;
    const notices = { onWarEvents: (fn) => {
      listener = fn;
      return { ok: true, unsubscribe: () => {
        listener = null;
      } };
    } };
    const t = timers();
    const start = () => startNews({ config, ctx: fakeCtx(opened, e.journal, null, notices), adapter, clock: e.clock,
      setTimer: t.setTimer });
    const first = start();
    assert.ok(first.ok, JSON.stringify(first));
    const news = first.news;
    e.settle("x1", 10, 12);
    listener([{ eventKey: "occ:7:1", kind: "SYSTEM_CAPTURED", systemId: SYS, at: B - H, attackerName: "Caldari State",
      defenderName: "Gallente Federation", systemName: "Jita", regionName: "The Forge", recipients: [], outcome: null }]);
    news.runPassNow(B - 2 * H);
    listener([{ eventKey: "occ:7:2", kind: "ATTACK_STARTED", systemId: SYS, at: B + 60000, attackerName: "x",
      defenderName: "y", systemName: "Jita", regionName: "The Forge", recipients: [], outcome: null }]);
    news.runPassNow(B + 60000);
    const prev = `ed:${B - 24 * H}`;
    assert.deepStrictEqual(news.listEditions({ limit: 5 }).editions.map((x) => [x.editionId, x.state, x.seq]),
      [[prev, "SKIPPED", 1]], "before B + settleDelayMs");
    const at = B + config.news.settleDelayMs;
    news.runPassNow(at);
    const eds = news.listEditions({ limit: 5 }).editions;
    assert.strictEqual(eds.length, 2);
    assert.deepStrictEqual([eds[0].editionId, eds[0].state, eds[0].source, eds[0].factCount, eds[0].seq],
      [`ed:${B}`, "PUBLISHED", "FALLBACK", 2, 1]);
    assert.deepStrictEqual(eds[0].paragraphs, eds[0].fallbackParagraphs);
    assert.strictEqual(eds[0].title, "System captured: Jita");
    const st = news.getStatus();
    assert.deepStrictEqual([st.warFeed, st.editionsOpened, st.editionsSkipped, st.editionsPublished, st.fallbacks,
      st.lastEdition.state], ["on", 1, 1, 1, 1, "PUBLISHED"]);
    assert.strictEqual(st.nextBoundaryAt, B + 24 * H);
    news.runPassNow(at + 60000);
    news.stop("test");
    assert.strictEqual(listener, null, "stop unsubscribes");
    const second = start();
    assert.ok(second.ok);
    second.news.runPassNow(at + 120000);
    assert.strictEqual(second.news.listEditions({ limit: 5 }).editions.length, 2, "no second edition of B");
    assert.strictEqual(second.news.getStatus().editionsOpened, 0);
    const late = B + 5 * 24 * H + config.news.settleDelayMs;
    second.news.runPassNow(late);
    const after = second.news.listEditions({ limit: 10 }).editions;
    assert.deepStrictEqual(after.map((x) => [x.editionId, x.state, x.factCount]),
      [[`ed:${B + 5 * 24 * H}`, "SKIPPED", 0], [`ed:${B}`, "PUBLISHED", 2], [prev, "SKIPPED", 0]]);
    assert.strictEqual(e.facts().filter((f) => f.e === null).length, 0, "the stale open fact is pruned");
    second.news.stop("test");
  }));

  test("N5 news off / facade / view: disabled_by_config without timer or tx; stub = facade = NEWS_METHODS; the view "
    + "news; config defaults, warnings, compose lines", () => withStore(driver, (opened) => {
    const off = resolveConfig({ modDir: MOD_DIR, env: {} });
    assert.ok(off.ok);
    let txs = 0;
    const spyStore = { ...opened.store, transaction: (...a) => {
      txs += 1;
      return opened.store.transaction(...a);
    } };
    const t = timers();
    const e = env(opened, B - H);
    const r = startNews({ config: off.config, ctx: { persistence: { ok: true, store: spyStore, journal: e.journal } },
      clock: e.clock, setTimer: t.setTimer });
    assert.deepStrictEqual(r, { ok: false, reason: "disabled_by_config" });
    assert.deepStrictEqual([t.armed.length, txs], [0, 0]);
    const stub = createUnavailableNews("NEWS_DISABLED");
    assert.deepStrictEqual(Object.keys(stub), [...S.NEWS_METHODS]);
    assert.deepStrictEqual(stub.listEditions(), { ok: false, reason: "NEWS_DISABLED" });

    const views = createViewRegistry();
    const started = startNews({ config: newsConfig(), ctx: fakeCtx(opened, e.journal, views), adapter, clock: e.clock,
      setTimer: t.setTimer });
    assert.ok(started.ok, JSON.stringify(started));
    assert.deepStrictEqual(Object.keys(started.news), [...S.NEWS_METHODS]);
    assert.strictEqual(started.news.getStatus().warFeed, "unavailable:NOTICES_DISABLED");
    assert.strictEqual(t.armed.length, 1, "one poller timer");
    e.settle("v1", 20, 20);
    started.news.runPassNow(B - 1000);
    started.news.runPassNow(B + 10 * 60000);
    const view = views.getView("news");
    assert.ok(view && view.listed === true && view.order === 27 && view.title === "Galactic news");
    const data = view.getData();
    assert.strictEqual(data.available, true);
    assert.deepStrictEqual(data.editions.map((x) => [x.boundaryAt, x.state]),
      [[B, "PUBLISHED"], [B - 24 * H, "SKIPPED"]]);
    assert.deepStrictEqual(Object.keys(data.editions[0]), ["editionId", "seq", "boundaryAt", "state", "source",
      "title", "paragraphs", "factCount", "publishedAt", "recipients"]);
    assert.ok(data.editions[0].paragraphs[1].includes("40"), data.editions[0].paragraphs[1]);
    assert.strictEqual(data.nextBoundaryAt, B + 24 * H);
    started.news.stop("test");
    assert.strictEqual(views.getView("news"), null, "stop unregisters the view");

    const n = off.config.news;
    assert.deepStrictEqual([n.enabled, n.passIntervalMs, n.cycleHours, n.publishHourUtc, n.settleDelayMs, n.language,
      n.kinds, n.capitalClasses, n.maxFactsPerEdition, n.minFactsPerEdition, n.maxPerKind, n.maxPerSystem,
      n.battleMinDestroyed, n.maxCandidatesPerEdition, n.maxFactAgeMs, n.maxWarFactsPerCall, n.tailScanWindow,
      n.tailMaxRowsPerPass, n.tailMaxLagRows, n.keepEditions, n.factRetentionMs, n.pruneBatch, n.observerEditions,
      n.maxTitleChars], [false, 60000, 24, 17, 300000, "", "", "titan,supercarrier", 10, 1, 4, 2, 10, 500,
      172800000, 64, 20000, 500, 500000, 30, 1209600000, 200, 7, 100]);
    assert.ok(!off.warnings.some((w) => w.startsWith("news.")), off.warnings.join("\n"));
    const on = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_NEWS_ENABLED: "1",
      EVEJS_LNE_PERSISTENCE_MAX_ROWS_PER_TRANSACTION: "400" } });
    assert.deepStrictEqual(on.warnings.filter((w) => w.startsWith("news.")).map((w) => w.split(" - ")[0]),
      ["news.enabled without notices.enabled", "news.maxCandidatesPerEdition + 1 = 501 rows > "
        + "persistence.maxRowsPerTransaction=400"]);
    const bad = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_NEWS_KINDS: "BATTLE,NOPE" } });
    assert.strictEqual(bad.config.news.kinds, "", "a bad kinds CSV keeps the default");
    const envs = SCHEMA.filter((row) => row.key.startsWith("news.")).map((row) => row.env);
    assert.strictEqual(envs.length, 40);
    const composeFile = path.resolve(MOD_DIR, "..", "..", "compose.yaml");
    if (fs.existsSync(composeFile)) {
      const c = parseComposeEnv(fs.readFileSync(composeFile, "utf8"));
      assert.ok(c.ok, c.detail);
      const got = new Map(c.entries.map((x) => [x.name, x.value]));
      assert.deepStrictEqual(envs.filter((x) => !got.has(x)), [], "news keys missing in compose.yaml");
      assert.deepStrictEqual(envs.map((x) => got.get(x)), envs.map((x) => (x === "EVEJS_LNE_NEWS_ENABLED" ? "0" : "")));
    }
  }));
};
