"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { resolveConfig, SCHEMA } = require("../../config");
const { startSeasons, createUnavailableSeasons, SEASONS_METHODS } = require("../../lib/seasons");
const { seasonsSettingsOf } = require("../../lib/seasons/schema");
const { newsSettingsOf } = require("../../lib/news/schema");
const J = require("../../lib/news/collect/journalFacts");
const { parseComposeEnv } = require("../../tools/liveSim/compose");
const F = require("./fixture");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SEASON_KINDS = ["SEASON_STARTED", "SEASON_STAGE", "SEASON_FINALE", "SEASON_ENDED"];

function configOf(env) {
  const r = resolveConfig({ modDir: MOD_DIR, env: { ...env } });
  assert.ok(r.ok, JSON.stringify(r.errors));
  return r;
}

module.exports = ({ test }) => {
  test("S5 seasons.enabled false: no handler, no store access, stub SEASONS_DISABLED; news gate; W110 / W111", () => {
    const off = configOf({});
    assert.strictEqual(off.config.seasons.enabled, false);
    assert.deepStrictEqual(off.warnings.filter((w) => w.startsWith("seasons.")), []);
    let touched = 0;
    const persistence = new Proxy({}, { get() {
      touched += 1;
      return undefined;
    } });
    const scheduler = F.fakeScheduler();
    const r = startSeasons({ config: off.config, persistence, clock: { now: () => 0 }, scheduler });
    assert.deepStrictEqual(r, { ok: false, reason: "disabled_by_config" });
    assert.deepStrictEqual([touched, scheduler.registerCalls(), scheduler.events.size], [0, 0, 0]);
    const stub = createUnavailableSeasons("SEASONS_DISABLED");
    assert.deepStrictEqual(Object.keys(stub).sort(), [...SEASONS_METHODS].sort());
    assert.deepStrictEqual(stub.current(), { ok: false, reason: "SEASONS_DISABLED" });
    assert.strictEqual(stub.currentSeasonKey(), null);

    const newsOff = newsSettingsOf(configOf({ EVEJS_LNE_NEWS_ENABLED: "1" }).config);
    const newsOn = newsSettingsOf(configOf({ EVEJS_LNE_NEWS_ENABLED: "1", EVEJS_LNE_SEASONS_ENABLED: "1" }).config);
    assert.ok(newsOff.ok && newsOn.ok);
    assert.deepStrictEqual(SEASON_KINDS.filter((k) => newsOff.settings.kinds.includes(k)), []);
    assert.deepStrictEqual(SEASON_KINDS.filter((k) => newsOn.settings.kinds.includes(k)), SEASON_KINDS);
    assert.ok(J.TAIL_AGGREGATE_TYPES.includes("season"));
    const e = (eventType, payload) => ({ journalId: 7, createdAt: 1000, aggregateType: "season", aggregateId: "3",
      eventType, payload });
    const got = J.factsOfEntries([e("SEASON_STARTED", { seasonNo: 3, factionId: 500026, regionIds: [10000001],
      stage: 0 }), e("SEASON_STAGE", { seasonNo: 3, stage: 2, factionId: 500026 }), e("SEASON_STAGE", { seasonNo: 3 }),
    e("SEASON_ENDED", { seasonNo: 3, factionId: null, outcome: "WON" })], { kinds: newsOn.settings.kinds,
      refs: new Map(), factionName: () => "Triglavian Collective", regionName: () => "Alpha Reach" });
    assert.deepStrictEqual(got.facts.map((f) => [f.factKey, f.kind, f.systemId, f.data.destroyed, f.data.lost,
      f.data.factionA, f.data.regionName]), [["ss:3", "SEASON_STARTED", null, 3, 0, "Triglavian Collective",
      "Alpha Reach"], ["sg:3:2", "SEASON_STAGE", null, 3, 2, "Triglavian Collective", null],
    ["se:3", "SEASON_ENDED", null, 3, 0, null, null]]);
    assert.deepStrictEqual(got.skipped, { BAD_PAYLOAD: 1 });

    const on = configOf({ EVEJS_LNE_SEASONS_ENABLED: "1" });
    assert.strictEqual(on.config.seasons.maxIskPerSeason, 350000000);
    const onW = on.warnings.filter((w) => w.startsWith("seasons."));
    assert.strictEqual(onW.length, 2, JSON.stringify(onW));
    assert.ok(onW[0].includes("heavyEvents") && onW[1].includes("gameMaster"));
    assert.ok(!onW.some((w) => w.startsWith("seasons.maxIskPerSeason")));
    const capOf = (cap) => configOf({ EVEJS_LNE_SEASONS_ENABLED: "1", EVEJS_LNE_SEASONS_MAX_ISK_PER_SEASON: cap })
      .warnings.filter((w) => w.startsWith("seasons.maxIskPerSeason"));
    assert.ok(capOf("322499999").length === 1 && capOf("322499999")[0].includes("below 322500000"));
    assert.deepStrictEqual(capOf("322500000"), []);
    const quiet = configOf({ EVEJS_LNE_SEASONS_ENABLED: "1", EVEJS_LNE_SEASONS_HEAVY_DEFENSE_POINTS: "0",
      EVEJS_LNE_SEASONS_HINT_ENABLED: "0" });
    assert.deepStrictEqual(quiet.warnings.filter((w) => w.startsWith("seasons.")), []);
    const warned = configOf({ EVEJS_LNE_SEASONS_ENABLED: "1", EVEJS_LNE_SEASONS_DURATION_MS: "3600000",
      EVEJS_LNE_SEASONS_SCORE_INTERVAL_MS: "600000", EVEJS_LNE_SEASONS_RESET_MODE: "offline",
      EVEJS_LNE_SEASONS_TIER1_ITEM_TYPE_ID: "34", EVEJS_LNE_SEASONS_REWARD_FALLBACK_STATION_ID: "0",
      EVEJS_LNE_SEASONS_KILL_POINTS: "0", EVEJS_LNE_SEASONS_HEAVY_DEFENSE_POINTS: "0",
      EVEJS_LNE_SEASONS_HINT_ENABLED: "0" });
    const w = warned.warnings.filter((x) => x.startsWith("seasons."));
    assert.strictEqual(w.length, 4, JSON.stringify(w));
    assert.ok(w[0].includes("below 10 x scoreIntervalMs") && w[1].includes("resetMode=offline"));
    assert.ok(w[2].includes("rewardFallbackStationId=0") && w[3].includes("killPoints=0"));
    assert.strictEqual(warned.config.seasons.resetMode, "offline");
    const badTiers = configOf({ EVEJS_LNE_SEASONS_ENABLED: "1", EVEJS_LNE_SEASONS_TIER2_MAX_RANK: "200" });
    assert.ok(badTiers.warnings.some((x) => x.includes("do not rise")));
    assert.deepStrictEqual(seasonsSettingsOf(badTiers.config),
      { ok: false, reason: "INVALID_SETTINGS", detail: "seasons.tier1MaxRank..tier3MaxRank" });

    const compose = parseComposeEnv(fs.readFileSync(path.resolve(MOD_DIR, "..", "..", "compose.yaml"), "utf8"))
      .entries;
    const byName = new Map(compose.map((e) => [e.name, e]));
    for (const row of SCHEMA.filter((x) => x.key.startsWith("seasons."))) {
      assert.ok(byName.has(row.env), `compose ${row.env}`);
      if (row.type === "boolean" && row.default === false) assert.strictEqual(byName.get(row.env).value, "0", row.env);
    }
  });
};
