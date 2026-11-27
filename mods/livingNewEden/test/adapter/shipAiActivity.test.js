"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const A = require("../../lib/adapter/shipAiActivity");
const K = require("../../lib/adapter/killObservation");
const { createAdapter } = require("../../lib/adapter");
const { GAME_MODULES } = require("../../lib/adapter/gameModules");
const { openStore } = require("../../lib/persistence/store");
const { MIGRATIONS } = require("../../lib/persistence/migrations");
const { createShipAiEventsRepository } = require("../../lib/shipAi/events");
const SH = require("../notices/storeHelper");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SERVER_SRC = path.resolve(MOD_DIR, "..", "..", "server", "src");
const PLAYER = 9001;
const OTHER = 9002;
const JITA = 30000142;
const SHIP = 990001;
const INSTANCE = 4401;

const read = (rel) => fs.readFileSync(path.join(SERVER_SRC, rel), "utf8").replace(/\r\n/g, "\n");
const playerShip = (cid = PLAYER) => ({ kind: "ship", itemID: SHIP, characterID: cid, session: { characterID: cid } });

module.exports = ({ test, skip }) => {
  test("TRB1 vendor facts: exports, stop literals, crystal burn-out, the completed instance field, the ship of a "
    + "session; GAME_MODULES wrap entries of the consumers shipAiMining / shipAiSite / shipAiKills", () => {
    const mining = read(path.join("services", "mining", "miningRuntime.js"));
    assert.ok(/\n {2}executeMiningCycle,\n/.test(mining), "executeMiningCycle exported");
    assert.ok(mining.includes("stopReason: \"cargo\""), "stopReason cargo");
    assert.ok(mining.includes("stopReason: \"ammo\""), "stopReason ammo");
    assert.ok(mining.includes("burnedOut ? \"ammo\" : null"), "the crystal burns out in a good cycle");
    assert.ok(mining.includes("partialCycle: options.partialCycle === true"), "the partial cycle flag");
    const tracking = read(path.join("services", "dungeon", "dungeonTrackingRuntime.js"));
    assert.ok(/\n {2}notifyDungeonCompletedForScene,\n/.test(tracking), "notifyDungeonCompletedForScene exported");
    assert.ok(tracking.includes("dungeonCompletedNotifiedInstanceID = instanceID"), "the completed instance field");
    const dyn = read(path.join("space", "runtime", "scene", "dynamicEntities.js"));
    assert.ok(dyn.includes("getShipEntityForSession(session)"), "scene.getShipEntityForSession");
    const ship = read(path.join("space", "runtime", "shipEntity.js"));
    assert.ok(ship.includes("characterID: session.characterID || 0,"), "the player ship carries the session character");
    const symOf = (p, name) => GAME_MODULES.find((e) => e.path === p).symbols.find((s) => s.name === name);
    const m = symOf("services/mining/miningRuntime", "executeMiningCycle");
    const s = symOf("services/dungeon/dungeonTrackingRuntime", "notifyDungeonCompletedForScene");
    const k = symOf("services/character/factionKillStandingRuntime", "recordNpcFactionStandingLoss");
    assert.deepStrictEqual([m.consumers, m.wrap, m.firstLoad, s.consumers, s.wrap, k.consumers.includes("shipAiKills")],
      [["shipAiMining"], true, undefined, ["shipAiSite"], true, true]);
  });

  test("TRB2 mining stop hook: fast path same object, cargo / ammo facts, NPC / copy / not watched / partial none, "
    + "consumer fault inside, chain symbols, uninstall under a foreign wrapper", () => {
    const FOREIGN = Symbol.for("test.foreign.mining");
    let result = { success: true, data: { stopReason: null } };
    const vendor = function vendorCycle() {
      return result;
    };
    vendor[FOREIGN] = true;
    const mod = { executeMiningCycle: vendor };
    const facts = [];
    let throwing = false;
    const hook = A.createMiningStopHook({ miningExports: mod, isWatched: (id) => id === PLAYER, now: () => 77,
      onStop: (f) => {
        if (throwing) throw new Error("consumer boom");
        facts.push(f);
      } });
    assert.deepStrictEqual(hook.install(), { ok: true });
    assert.deepStrictEqual(hook.install(), { ok: false, reason: "HOOK_ALREADY_INSTALLED" });
    assert.strictEqual(mod.executeMiningCycle[FOREIGN], true, "the symbol of the predecessor stays");
    assert.strictEqual(mod.executeMiningCycle[A.MINING_MARK], true);
    const scene = { systemID: JITA };
    assert.strictEqual(mod.executeMiningCycle(scene, playerShip(), {}, 0, {}), result, "the same object");
    assert.strictEqual(facts.length, 0);
    result = { success: false, stopReason: "cargo" };
    mod.executeMiningCycle(scene, playerShip(), {}, 0, {});
    result = { success: true, data: { stopReason: "ammo" } };
    mod.executeMiningCycle(scene, playerShip(), {}, 0, {});
    assert.deepStrictEqual(facts, [
      { type: "mining", characterId: PLAYER, shipId: SHIP, reason: "cargo", systemId: JITA, atMs: 77 },
      { type: "mining", characterId: PLAYER, shipId: SHIP, reason: "ammo", systemId: JITA, atMs: 77 }]);
    result = { success: false, stopReason: "cargo" };
    mod.executeMiningCycle(scene, { kind: "ship", itemID: 5, characterID: 0, session: null }, {}, 0, {});
    mod.executeMiningCycle(scene, { kind: "ship", itemID: 6, characterID: 0, pilotCharacterID: PLAYER,
      session: { characterID: PLAYER } }, {}, 0, {});
    mod.executeMiningCycle(scene, playerShip(OTHER), {}, 0, {});
    mod.executeMiningCycle(scene, playerShip(), {}, 0, { partialCycle: true });
    result = { success: false, stopReason: "target" };
    mod.executeMiningCycle(scene, playerShip(), {}, 0, {});
    assert.strictEqual(facts.length, 2, "NPC, ShipWing copy, not watched, partial cycle, target: no fact");
    throwing = true;
    result = { success: false, stopReason: "cargo" };
    assert.strictEqual(mod.executeMiningCycle(scene, playerShip(), {}, 0, {}), result, "a consumer fault stays inside");
    assert.deepStrictEqual(hook.stats(), { events: 3, consumerErrors: 1 });
    assert.deepStrictEqual([A.miningStopOf({ success: false, stopReason: "ammo" }), A.miningStopOf({ success: true }),
      A.miningStopOf(null)], ["ammo", null, null]);
    const ours = mod.executeMiningCycle;
    const foreign = function foreignWrap() {
      return ours.apply(this, arguments);
    };
    mod.executeMiningCycle = foreign;
    hook.uninstall();
    assert.strictEqual(mod.executeMiningCycle, foreign, "not unlinked under a foreign wrapper");
    throwing = false;
    mod.executeMiningCycle(scene, playerShip(), {}, 0, {});
    assert.strictEqual(facts.length, 2, "passive after the uninstall");
    const clean = { executeMiningCycle: vendor };
    const h2 = A.createMiningStopHook({ miningExports: clean, isWatched: () => true, now: () => 1, onStop: () => {} });
    assert.ok(h2.install().ok);
    h2.uninstall();
    assert.strictEqual(clean.executeMiningCycle, vendor);
  });

  test("TRB3 site cleared hook: result unchanged, consumer fault inside, 0 = no scan; one fact of two sessions; two "
    + "calls of one instance = one ship_ai_events row", () => {
    let count = 1;
    const vendor = () => count;
    const mod = { notifyDungeonCompletedForScene: vendor };
    const facts = [];
    let throwing = false;
    const hook = A.createSiteClearedHook({ trackingExports: mod, isWatched: (id) => id === PLAYER || id === OTHER,
      now: () => 55, scanMax: 8, onCleared: (f) => {
        if (throwing) throw new Error("consumer boom");
        facts.push(f);
      } });
    assert.deepStrictEqual(hook.install(), { ok: true });
    const ships = new Map([[PLAYER, { dungeonCompletedNotifiedInstanceID: INSTANCE }],
      [OTHER, { dungeonCompletedNotifiedInstanceID: 0 }]]);
    const scene = { systemID: JITA, sessions: new Map([[1, { characterID: PLAYER }], [2, { characterID: OTHER }]]),
      getShipEntityForSession: (s) => ships.get(s.characterID) };
    const instance = { instanceID: INSTANCE, siteKind: "Anomaly", siteFamily: "combat", factionID: 500010 };
    assert.strictEqual(mod.notifyDungeonCompletedForScene(scene, instance, {}), 1);
    assert.deepStrictEqual(facts, [{ type: "site", characterId: PLAYER, instanceId: INSTANCE, systemId: JITA,
      siteKind: "anomaly", siteFamily: "combat", factionId: 500010, atMs: 55 }]);
    count = 0;
    assert.strictEqual(mod.notifyDungeonCompletedForScene(scene, instance, {}), 0);
    assert.strictEqual(facts.length, 1, "0 notified = no scan");
    count = 2;
    mod.notifyDungeonCompletedForScene({ systemID: JITA, sessions: [{ characterID: PLAYER, shipID: SHIP }],
      getEntityByID: (id) => (id === SHIP ? { dungeonCompletedNotifiedInstanceID: INSTANCE } : null) }, INSTANCE, {});
    assert.deepStrictEqual([facts.length, facts[1].instanceId, facts[1].siteKind], [2, INSTANCE, null],
      "an ID only; the ship by session.shipID");
    throwing = true;
    assert.strictEqual(mod.notifyDungeonCompletedForScene(scene, instance, {}), 2, "a consumer fault stays inside");
    assert.deepStrictEqual(hook.stats(), { events: 3, consumerErrors: 1, truncated: 0 });
    hook.uninstall();
    assert.strictEqual(mod.notifyDungeonCompletedForScene, vendor);
    assert.deepStrictEqual(A.sessionsOf({ sessions: { a: 1 } }), [1]);

    const driver = SH.loadDriver();
    if (!driver || !driver.ok) return skip("TRB3 site row", "no sqlite driver");
    const opened = openStore({ filePath: ":memory:", openDatabase: () => new driver.Database(":memory:"),
      exclusiveLock: true, busyTimeoutMs: 0, maxRowsPerTransaction: 500, maxWriteMsPerPass: 5, randomSeed: () => 1,
      migrations: MIGRATIONS });
    assert.ok(opened.ok, JSON.stringify(opened));
    const store = opened.store;
    try {
      const repo = createShipAiEventsRepository({ eventsKeep: 50 });
      const run = (fn) => {
        const r = store.transaction("t.site", fn);
        assert.ok(r.ok, JSON.stringify(r));
        return r.value;
      };
      run((db) => db.prepare(`INSERT INTO ship_ai_prefs (player_character_id, ai_character_id, ai_name, language,
        quiet, portrait_sha, created_at, updated_at, last_proactive_at, version)
        VALUES (?, 91000001, 'Jin', NULL, 0, NULL, 1000, 1000, NULL, 1)`).run(PLAYER));
      const note = () => run((db) => repo.noteEventInTx(db, { playerId: PLAYER, kind: "SITE_CLEARED",
        key: `site:${INSTANCE}`, payload: { system: "Jita" }, nowMs: 2000 }));
      assert.deepStrictEqual([note().inserted, note().inserted], [true, false]);
      assert.strictEqual(run((db) => db.prepare("SELECT COUNT(*) AS n FROM ship_ai_events").get().n), 1);
    } finally {
      store.close("test_cleanup");
    }
    return undefined;
  });

  test("TRB4 kill fan-out: a throwing ship AI listener leaves the world listeners their results and vice versa; "
    + "ambient / heavy event reach the ship AI; suppressed none; navy in the fact; loader gate + wrap mount", () => {
    const got = { liberation: [], standings: [], playerActivity: [], shipAi: [] };
    const throws = new Set();
    const listener = (name) => () => ({ onNpcKill: (k) => {
      if (throws.has(name)) throw new Error(`${name} boom`);
      got[name].push(k);
      return { ok: true };
    } });
    const original = () => ({ applied: true });
    const flags = { ambient: false, heavy: false, navy: false, suppressed: false };
    const wrap = K.wrapNpcKillStandingLoss(() => (flags.suppressed ? { suppressed: true } : original()), {
      resolveVictimFactionID: () => 500010, getLiberation: listener("liberation"), getStandings: listener("standings"),
      getPlayerActivity: listener("playerActivity"), getFrontJobs: () => null, getShipAiKills: listener("shipAi"),
      isAmbientVictim: () => flags.ambient, isHeavyEventVictim: () => flags.heavy, isTrafficVictim: () => false,
      isNavyVictim: () => flags.navy, navyKillsLiberate: () => false });
    assert.ok(wrap.ok);
    const kill = (itemID) => wrap.wrapped({ itemID, typeID: 17736, systemID: JITA }, PLAYER, { nowMs: 5000,
      systemID: JITA });
    throws.add("shipAi");
    assert.deepStrictEqual(kill(1), { applied: true }, "the vendor result unchanged");
    assert.deepStrictEqual([got.liberation.length, got.standings.length, got.playerActivity.length,
      got.shipAi.length], [1, 1, 1, 0]);
    throws.clear();
    throws.add("standings");
    kill(2);
    assert.deepStrictEqual(got.shipAi, [{ characterId: PLAYER, victimId: 2, victimTypeId: 17736,
      victimFactionId: 500010, systemId: JITA, atMs: 5000, navy: false }]);
    throws.clear();
    flags.ambient = true;
    kill(3);
    flags.ambient = false;
    flags.heavy = true;
    kill(4);
    flags.heavy = false;
    assert.deepStrictEqual([got.shipAi.map((k) => k.victimId), got.playerActivity.length], [[2, 3, 4], 2],
      "ambient / heavy event: the ship AI only");
    flags.suppressed = true;
    kill(5);
    flags.suppressed = false;
    flags.navy = true;
    kill(6);
    assert.deepStrictEqual(got.shipAi.map((k) => [k.victimId, k.navy]), [[2, false], [3, false], [4, false],
      [6, true]], "suppressed none, navy in the fact");
    const direct = K.observeShipAiKill(null, { itemID: 7, typeID: 0, systemID: JITA }, PLAYER, { nowMs: 1 },
      { getShipAiKills: listener("shipAi") });
    assert.deepStrictEqual(direct, { skipped: "NO_TYPE" });

    const { buildHooks } = require("../../loader");
    const silent = { log() {}, debug() {}, logError() {} };
    const wrapped = (config) => {
      const ctx = { logger: silent, state: { configResult: { ok: true, config } } };
      const base = () => null;
      const exportsObj = { recordNpcFactionStandingLoss: base, resolveVictimFactionID: () => 0 };
      buildHooks(ctx).find((h) => h.name === "npcKillLiberation").run(exportsObj, "factionKillStandingRuntime", null);
      return exportsObj.recordNpcFactionStandingLoss !== base;
    };
    const ai = (killLinesEnabled) => ({ enabled: true, modules: { world: { enabled: false },
      strategy: { enabled: false } }, shipAi: { enabled: true, proactiveEnabled: true, triggersEnabled: true,
      killLinesEnabled } });
    try {
      K.setKillWrapMounted(false);
      assert.deepStrictEqual([wrapped(ai(false)), K.killWrapMounted()], [false, false], "all off: no wrap");
      assert.deepStrictEqual([wrapped(ai(true)), K.killWrapMounted()], [true, true], "kill lines: wrap + mounted");
    } finally {
      K.setKillWrapMounted(false);
    }
  });

  test("TRB6 facade: a DRIFT of shipAiMining refuses only installMiningHook; installSiteHook / setKillListener work, "
    + "uninstallAll gives the export back", () => {
    const SRC = path.join(path.sep, "x", "server", "src");
    const key = (rel) => path.join(SRC, `${rel}.js`);
    const vendorSite = () => 0;
    const tracking = { notifyDungeonCompletedForScene: vendorSite };
    const cache = { [key("_secondary/chat/chatRuntime")]: { exports: {} },
      [key("services/chat/xmppStubServer")]: { exports: {} },
      [key("services/mining/miningRuntime")]: { exports: {} },
      [key("services/dungeon/dungeonTrackingRuntime")]: { exports: tracking } };
    const table = GAME_MODULES.map((e) => (e.path === "services/mining/miningRuntime" ? e : { ...e, symbols: [] }));
    const adapter = createAdapter({ moduleApi: { _cache: cache }, logger: { log() {} }, gameModules: table });
    adapter.setServerSrc(SRC);
    const report = adapter.runProbe();
    assert.ok(Object.keys(report.disabledModules).includes("shipAiMining"), JSON.stringify(report.disabledModules));
    const act = adapter.shipAiSeams().seam.activity;
    assert.deepStrictEqual(act.installMiningHook(() => {}, () => true),
      { ok: false, reason: "SEAM_UNAVAILABLE", detail: "shipAiMining" });
    try {
      assert.deepStrictEqual(act.installSiteHook(() => {}, () => true, 8), { ok: true });
      assert.notStrictEqual(tracking.notifyDungeonCompletedForScene, vendorSite);
      assert.deepStrictEqual(act.installSiteHook(() => {}, () => true, 8),
        { ok: false, reason: "HOOK_ALREADY_INSTALLED" });
      const listener = { onNpcKill: () => {} };
      assert.deepStrictEqual(act.setKillListener(listener), { ok: true, wrapMounted: false });
      assert.strictEqual(K.getShipAiKills(), listener);
      assert.deepStrictEqual(act.stats(), { mining: null, site: { events: 0, consumerErrors: 0, truncated: 0 } });
    } finally {
      assert.deepStrictEqual(act.uninstallAll(), { ok: true });
    }
    assert.deepStrictEqual([tracking.notifyDungeonCompletedForScene === vendorSite, K.getShipAiKills()], [true, null]);
  });
};
