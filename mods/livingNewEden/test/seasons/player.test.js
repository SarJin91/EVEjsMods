"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

const { resolveConfig, SCHEMA } = require("../../config");
const C = require("../../lib/seasons/command");
const V = require("../../lib/seasons/view");
const { hintOf } = require("../../lib/seasons/hint");
const { startSeasons } = require("../../lib/seasons");
const { createSeasonRepository } = require("../../lib/seasons/repository");
const { createViewRegistry } = require("../../lib/observer/views");
const { createStepRegistry, MAX_HINT_SOURCES } = require("../../lib/gameMaster/registry");
const P = require("../../lib/world/invasions/rollPlanner");
const { PROFILES } = require("../../lib/world/invasions/data/invaderProfiles");
const { createInvasionService } = require("../../lib/world/invasions/invasionService");
const { createRng } = require("../../lib/util/rng");
const { parseComposeEnv } = require("../../tools/liveSim/compose");
const { loadDriver, withStore } = require("../notices/storeHelper");
const F = require("./fixture");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const DAY = 86400000;
const { T0 } = F;
const TRIG = 500026;
const DEATHLESS = 500029;
const GURISTAS = 500010;
const REGION = 10000001;
const ALICE = 90000001;
const BOB = 90000002;
const NAMES = { factionName: (id) => ({ [TRIG]: "Triglavian Collective" })[id] || null,
  regionName: (id) => ({ [REGION]: "Alpha Reach" })[id] || null };

const BASE = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir() } });

const active = (over) => ({ seasonNo: 2, state: "ACTIVE", crisisKind: "INVASION_SURGE", factionId: TRIG,
  regionIds: [REGION], stage: 1, stageCount: 4, stageDueAt: T0 + DAY, startsAt: T0 - 10 * DAY,
  endsAt: T0 + 5 * DAY + 3600000, meterDefense: 40, meterCrisis: 25, ...(over || {}) });

function chatOf(season, score, settings) {
  const bumps = [];
  const chat = C.createSeasonChat({ seasons: { current: () => (season instanceof Error ? (() => { throw season; })()
    : { ok: true, season }), scoreOf: () => score }, clock: { now: () => T0 },
  settings: { maxReplyChars: 1000, lineBreak: "<br>", ...(settings || {}) }, names: NAMES, isRunning: () => true,
  bump: (n) => bumps.push(n) });
  return { chat, bumps };
}

function rollRig({ bias, getSeasons }) {
  const c = BASE.config;
  const config = { ...c, invasions: { ...c.invasions, chancePermille: 1000, maxActivePerFaction: 3 },
    seasons: { ...c.seasons, enabled: bias, invasionBiasEnabled: bias } };
  const systems = Array.from({ length: 6 }, (_, i) => 30000001 + i);
  const registry = { getFaction: (f) => ([TRIG, DEATHLESS].includes(f) ? { kind: "invader" } : null),
    isActive: (f) => [TRIG, DEATHLESS].includes(f), getDoctrine: () => null };
  const graph = { getSystemsBySecClass: (k) => (k === "nullsec" ? systems : []),
    getSystem: (id) => (systems.includes(id) ? { systemId: id, secClass: "nullsec", regionId: REGION } : null) };
  const fakeTx = { prepare: () => ({ get: () => ({ c: 0 }), all: () => [] }) };
  const svc = createInvasionService({ config, coreIndex: { enabled: false, systems: new Map() },
    store: { transaction: (_n, fn) => ({ ok: true, value: fn(fakeTx) }) },
    repository: { getSystem: () => ({ ok: true, system: { occupationState: "STABLE", controllerFactionId: null } }) },
    graph: { getGraph: () => ({ ok: true, graph }) },
    stations: { getMode: () => "ready", repository: { countLiveBySystem: () => ({ ok: true, rows: [] }) } },
    sovClaims: { claimOf: () => ({ ok: true, claimed: false }) }, strategy: { registry },
    telemetry: { count() {} }, logger: { log() {} }, nowMs: () => 0, worldSeed: 5, getSeasons });
  const roll = (round) => {
    const r = svc.rollHandlerFn({ payload: { round } }, { now: 0 });
    assert.ok(r.ok, JSON.stringify(r));
    r.onCommitted({ ok: true });
    return svc.getStatus().lastDecision;
  };
  return { svc, roll };
}

module.exports = ({ test, skip }) => {
  test("V1 !season: none / PLANNED / ACTIVE with points and titles / 0 pts / read fault; install and uninstall", () => {
    assert.strictEqual(chatOf(null).chat.handle({ characterId: ALICE }, "!season"), "LNE Season: none.");
    assert.strictEqual(chatOf({ ...active(), state: "PLANNED", startsAt: T0 + 2 * DAY + 1 }).chat.handle(null),
      "LNE Season: no season running. Next season starts in 3 d.");
    const { chat, bumps } = chatOf(active(), { ok: true, seasonNo: 2, points: 120, rank: 3,
      titles: [{ seasonNo: 1, tier: "CHAMPION" }, { seasonNo: 1, tier: "VETERAN" }] });
    const text = chat.handle({ characterId: ALICE }, "!season");
    assert.strictEqual(text, "Season 2: Triglavian Collective invasion surge | stage 2/4 | 6 d left | defense 40 vs "
      + "crisis 25<br>You: 120 pts, rank 3 | titles: S1 Champion, S1 Veteran");
    assert.ok(/^[\x20-\x7e]*$/.test(text) && text.length <= 1000);
    assert.strictEqual(chatOf(active(), { ok: true, seasonNo: 2, points: 0, rank: null, titles: [] }).chat
      .handle({ characterId: BOB }).split("<br>")[1], "You: 0 pts");
    assert.strictEqual(chatOf(active(), { ok: false, reason: "READ_FAILED" }).chat.handle({ characterId: BOB }),
      "LNE Season unavailable.");
    assert.strictEqual(chatOf(new Error("boom")).chat.handle({ characterId: BOB }), "LNE Season unavailable.");
    assert.strictEqual(chatOf(active(), null, { maxReplyChars: 40 }).chat.handle(null).length, 40);
    assert.deepStrictEqual(bumps, ["commandReplies"]);
    assert.ok(C.matchSeasonCommand("!season") && C.matchSeasonCommand("! sezon x") && !C.matchSeasonCommand("!seasons"));

    const installs = [];
    const removed = [];
    const adapter = { installChatCommand: (c) => {
      installs.push(c);
      return { ok: true };
    }, uninstallChatCommand: (n) => removed.push(n) };
    const r = C.installSeasonCommand(adapter, chat);
    assert.ok(r.ok);
    assert.deepStrictEqual([installs[0].name, installs[0].match("!season"), installs[0].handle === chat.handle],
      ["season", true, true]);
    r.uninstall();
    assert.deepStrictEqual(removed, ["season"]);
    assert.deepStrictEqual(C.installSeasonCommand(null, chat), { ok: false, reason: "NO_CHAT_SEAM" });
  });

  test("V2 planRoll step 4: no seasonBias = before (bit for bit); F x2; roll handler counters fail-open", () => {
    const entry = (systemId) => ({ systemId, row: { occupationState: "STABLE", controllerFactionId: null },
      liveStations: 0, observed: false, claimed: false, inTheatre: false, openBeachhead: false, core: false,
      category: "free" });
    const params = { chancePermille: 1000, maxActive: 3, maxActivePerFaction: 1, weightFree: 3, weightActive: 5,
      weightControlled: 1, avoidObservedSystems: true, avoidStationSystems: true, avoidCampaignTheatres: true,
      requireSovCheck: false, beachheadCaptureRangeJumps: 3 };
    const profiles = [TRIG, DEATHLESS].map((f) => ({ ...PROFILES.find((p) => p.factionId === f), eligible: true }));
    const [wT, wD] = profiles.map((p) => p.weight);
    const snap = { round: 4, rollSeed: 9, sampleSeed: 10, openTotal: 0, openByFaction: new Map(), profiles,
      sampled: [entry(30000001), entry(30000002)], stationsReady: true };
    const biased = { ...params, seasonBias: { factionId: TRIG, permille: 2000 } };
    let trigToday = 0;
    let trigBiased = 0;
    for (let seed = 1; seed <= 60; seed += 1) {
      const today = P.planRoll(snap, params, createRng(seed));
      assert.deepStrictEqual(P.planRoll(snap, { ...params, seasonBias: undefined }, createRng(seed)), today);
      const rng = createRng(seed);
      rng.nextInt(1, 1000);
      assert.strictEqual(today.factionId, rng.nextInt(1, wT + wD) <= wT ? TRIG : DEATHLESS, `seed ${seed}`);
      const b = P.planRoll(snap, biased, createRng(seed));
      const rb = createRng(seed);
      rb.nextInt(1, 1000);
      assert.strictEqual(b.factionId, rb.nextInt(1, 2 * wT + wD) <= 2 * wT ? TRIG : DEATHLESS, `biased ${seed}`);
      if (today.factionId === TRIG) trigToday += 1;
      if (b.factionId === TRIG) trigBiased += 1;
    }
    assert.ok(trigBiased > trigToday, `${trigBiased} > ${trigToday}`);

    const off = rollRig({ bias: false, getSeasons: () => { throw new Error("must not be read"); } });
    const broken = rollRig({ bias: true, getSeasons: () => ({ current: () => { throw new Error("boom"); } }) });
    assert.deepStrictEqual(broken.roll(3), off.roll(3));
    assert.strictEqual(broken.svc.getStatus().counters.seasonBiasUnavailable, 1);
    assert.ok(!("seasonBoosted" in off.svc.getStatus().counters), "off: no season counters");
    const season = (factionId) => ({ current: () => ({ ok: true, season: active({ factionId }) }) });
    const crisis = rollRig({ bias: true, getSeasons: () => season(TRIG) });
    let picked = 0;
    for (let round = 1; round <= 10; round += 1) if (crisis.roll(round).factionId === TRIG) picked += 1;
    assert.ok(picked > 0);
    assert.strictEqual(crisis.svc.getStatus().counters.seasonBoosted, picked);
    const pirate = rollRig({ bias: true, getSeasons: () => season(GURISTAS) });
    assert.deepStrictEqual(pirate.roll(3), off.roll(3));
    assert.strictEqual(pirate.svc.getStatus().counters.seasonBiasNoProfile, 1);
  });

  const driver = loadDriver();
  if (!driver.ok) {
    skip("V3 season panel / layer / hint", `better-sqlite3 unavailable (${driver.detail})`);
  } else {
    test("V3 layer-season marks 24 + galaxy-wide note; panel 72 on a store; hintOf; startSeasons mounts and undoes",
      () => {
        const graph = { getSystemsInRegion: (r) => (r === REGION ? [30000005, 30000002, 30000009] : []) };
        const layer = V.buildSeasonLayer({ seasons: { current: () => ({ ok: true, season: active() }) },
          getGraph: () => graph, names: NAMES, clock: { now: () => T0 }, settings: { bucketMs: 60000 } });
        const views = createViewRegistry();
        assert.strictEqual(views.registerView(V.LAYER_ID, layer).ok, true);
        assert.deepStrictEqual([V.LAYER_ID, layer.listed, layer.mapLayer], ["layer-season", false,
          { kind: "marks", order: 24 }]);
        const data = layer.getData();
        assert.deepStrictEqual(data.items, [[30000002, "crisis", "S2", ["Season 2: Triglavian Collective",
          "Alpha Reach stage 2/4"], null]]);
        const sandbox = { window: {} };
        vm.runInNewContext(fs.readFileSync(path.join(MOD_DIR, "web", "galaxy.js"), "utf8"), sandbox,
          { filename: "galaxy.js" });
        assert.deepStrictEqual(data.legend.map((l) => [l[0], sandbox.window.LneGalaxy._pure.markShape(l[3])]),
          [["crisis", "hexagon"]]);
        const galaxy = V.buildSeasonLayer({ seasons: { current: () => ({ ok: true, season: active({ regionIds: [] }) }) },
          getGraph: () => graph, clock: { now: () => T0 }, settings: { bucketMs: 60000 } }).getData();
        assert.deepStrictEqual([galaxy.items, galaxy.note], [[], "season 2: galaxy-wide crisis"]);
        assert.deepStrictEqual(V.buildSeasonLayer({ seasons: { current: () => ({ ok: true, season: null }) },
          getGraph: () => graph, clock: { now: () => T0 }, settings: { bucketMs: 1 } }).getData().items, []);

        const hint = hintOf(active({ regionIds: [REGION, 10000002] }), NAMES, T0);
        assert.deepStrictEqual(hint.lines, ["Season 2 crisis: Triglavian Collective invasion surge (stage 2/4, 6 days "
          + "left)", "Crisis regions: Alpha Reach, region 10000002"]);
        assert.ok(hint.lines.length <= 3 && hint.lines.every((l) => /^[\x20-\x7e]{1,160}$/.test(l)));
        assert.strictEqual(hintOf(active({ state: "PLANNED" }), NAMES, T0), null);

        withStore(driver, ({ store }) => {
          const repo = createSeasonRepository();
          const crisis = { factionId: TRIG, regionIds: [REGION], params: {} };
          F.tx(store, (db) => {
            assert.ok(repo.insertPlannedInTx(db, { seasonNo: 1, crisisKind: "INVASION_SURGE", crisisOwner: "test",
              crisisVersion: 1, crisis, seed: 1, startsAt: T0 - 30 * DAY, endsAt: T0 - 20 * DAY, stageCount: 2,
              stageDueAt: T0 - 25 * DAY, now: T0 - 30 * DAY }).ok);
            assert.ok(repo.updateInTx(db, 1, 1, { state: "ARCHIVED", outcome: "WON", closeReason: "FINISHED",
              closedAt: T0 - 20 * DAY, now: T0 - 20 * DAY }).ok);
            assert.ok(repo.insertRewardsInTx(db, [
              { characterId: BOB, rank: 2, points: 30, tier: "HERO", iskAmount: 5, itemTypeId: 0, itemQty: 1 },
              { characterId: ALICE, rank: 1, points: 50, tier: "CHAMPION", iskAmount: 9, itemTypeId: 0, itemQty: 1 },
            ], { seasonNo: 1, outcome: "WON", mailEnabled: false, now: T0 - 20 * DAY }).ok);
            assert.ok(repo.updateRewardInTx(db, `season:1:${BOB}`, 1, { state: "FAILED", now: T0 }).ok);
            assert.ok(repo.insertPlannedInTx(db, { seasonNo: 2, crisisKind: "INVASION_SURGE", crisisOwner: "test",
              crisisVersion: 1, crisis, seed: 2, startsAt: T0 - 10 * DAY, endsAt: T0 + 5 * DAY, stageCount: 4,
              stageDueAt: T0 + DAY, now: T0 - 10 * DAY }).ok);
            const item = (characterId, points) => ({ characterId, points, kills: points, defenses: 1, lastAt: T0 });
            assert.ok(repo.upsertScoresInTx(db, 2, [item(BOB, 7), item(ALICE, 12)], 100).ok);
          });
          const names = [];
          const txNames = [];
          const spy = { ...store, transaction: (name, fn) => {
            txNames.push(name);
            return store.transaction(name, fn);
          } };
          const panel = V.buildSeasonPanel({ store: spy, repo, seasons: { current: () => ({ ok: true,
            season: active() }) }, names: NAMES, clock: { now: () => T0 }, settings: { bucketMs: 60000 },
          getStatus: () => ({ counters: { commandReplies: 1 } }),
          characterNames: (ids) => {
            names.push(ids);
            return new Map([[ALICE, "Alice"]]);
          } });
          assert.strictEqual(views.registerView(V.VIEW_ID, panel).ok, true);
          assert.deepStrictEqual([V.VIEW_ID, panel.order, panel.listed], ["seasons", 72, true]);
          const p = panel.getData();
          assert.deepStrictEqual(txNames, ["observer.seasons"]);
          assert.deepStrictEqual(p.top, [
            { rank: 1, character: "Alice", characterId: ALICE, points: 12, kills: 12, defenses: 1 },
            { rank: 2, character: String(BOB), characterId: BOB, points: 7, kills: 7, defenses: 1 }]);
          assert.deepStrictEqual(p.history, [{ seasonNo: 1, outcome: "WON", closedAt: T0 - 20 * DAY,
            champion: "Alice" }]);
          assert.deepStrictEqual([p.rewards, p.season.faction, p.season.regions, p.season.endsIn, p.counters],
            [{ pending: 1, failed: 1 }, "Triglavian Collective", [{ regionId: REGION, name: "Alpha Reach" }],
              5 * DAY + 3600000, { commandReplies: 1 }]);
          assert.deepStrictEqual(names, [[ALICE, BOB]]);

          const env = { EVEJS_DATA_ROOT: os.tmpdir(), EVEJS_LNE_SEASONS_ENABLED: "1" };
          const config = resolveConfig({ modDir: MOD_DIR, env }).config;
          const boot = (hintRegistry, viewRegistry, adapter) => startSeasons({ config,
            persistence: { ok: true, store, journal: F.journalOf({ now: T0 }), worldSeed: 1 },
            clock: { now: () => T0 }, scheduler: F.fakeScheduler(), adapter, views: viewRegistry, hintRegistry,
            getGraph: () => graph, logger: { log() {} } });
          const gm = createStepRegistry();
          const reg = createViewRegistry();
          const removed = [];
          const adapter = { installChatCommand: () => ({ ok: true }), uninstallChatCommand: (n) => removed.push(n) };
          const r = boot(gm, reg, adapter);
          assert.ok(r.ok, JSON.stringify(r));
          assert.deepStrictEqual(gm.listHintSources().map((s) => s.key), ["seasons"]);
          assert.ok(reg.getView(V.VIEW_ID) && reg.getView(V.LAYER_ID));
          r.seasons.stop();
          assert.deepStrictEqual([gm.listHintSources().length, Boolean(reg.getView(V.VIEW_ID)),
            Boolean(reg.getView(V.LAYER_ID)), removed], [0, false, false, ["season"]]);
          const full = createStepRegistry();
          for (let i = 1; i <= MAX_HINT_SOURCES; i += 1) full.registerHintSource({ key: `src${i}`, read: () => null });
          const r2 = boot(full, null, null);
          assert.ok(r2.ok, JSON.stringify(r2));
          assert.strictEqual(r2.seasons.getStatus().counters.hintRefused, 1);
          r2.seasons.stop();
        });
      });
  }

  test("V5 compose: every seasons.* row has a line (flag default false ':-0', the rest empty); W114 / W115", () => {
    const compose = parseComposeEnv(fs.readFileSync(path.resolve(MOD_DIR, "..", "..", "compose.yaml"), "utf8"))
      .entries;
    const byName = new Map(compose.map((e) => [e.name, e]));
    const rows = SCHEMA.filter((x) => x.key.startsWith("seasons."));
    assert.ok(rows.some((r) => r.key === "seasons.invasionBiasPermille"));
    for (const row of rows) {
      assert.ok(byName.has(row.env), `compose ${row.env}`);
      assert.strictEqual(byName.get(row.env).value, row.type === "boolean" && row.default === false ? "0" : "",
        row.env);
    }
    const W = (env) => resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(),
      EVEJS_LNE_SEASONS_ENABLED: "1", ...env } }).warnings.filter((w) => /^seasons\.(invasionBias|hint)/.test(w));
    const off = { EVEJS_LNE_SEASONS_HINT_ENABLED: "0" };
    assert.deepStrictEqual(W(off), []);
    assert.deepStrictEqual(W({ ...off, EVEJS_LNE_SEASONS_INVASION_BIAS_ENABLED: "1" }), [], "invasions on by default");
    assert.deepStrictEqual(W({ ...off, EVEJS_LNE_SEASONS_INVASION_BIAS_ENABLED: "1", EVEJS_LNE_INVASIONS_ENABLED: "0" })
      .map((w) => w.split(" ")[0]), ["seasons.invasionBiasEnabled"]);
    assert.deepStrictEqual(W({}).map((w) => w.split(" ")[0]), ["seasons.hintEnabled"]);
    assert.deepStrictEqual(W({ EVEJS_LNE_GAMEMASTER_ENABLED: "1" }), []);
  });
};
