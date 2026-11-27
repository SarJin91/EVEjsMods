"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const S = require("../../lib/shipAi/schema");
const { planCallout, buildCallout } = require("../../lib/shipAi/callout");
const { createShipAiClient } = require("../../lib/shipAi/client");
const { createShipAiPrefsRepository } = require("../../lib/shipAi/prefsRepository");
const { createShipAiEventsRepository } = require("../../lib/shipAi/events");
const { createProactive, planProactive } = require("../../lib/shipAi/proactive");
const { readGridNpcsFrom } = require("../../lib/adapter/shipTelemetry");
const { createAdapter } = require("../../lib/adapter");
const SH = require("../notices/storeHelper");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SERVER_SRC = path.resolve(MOD_DIR, "..", "..", "server", "src");
const PLAYER = 9001;
const AI = 91000001;
const JITA = 30000142;
const TAMA = 30002813;
const T0 = 1700000000000;
const SERPENTIS = 500020;
const GURISTAS = 500010;
const SHIP = 1000000001;
const NPC_TYPE = 23000;

const base = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_SHIP_AI_ENABLED: "1" } }).config;

function settings(over) {
  const r = S.shipAiModelSettingsOf({ shipAi: { ...base.shipAi, minIntervalMs: 0, language: "pl", ...(over || {}) } });
  assert.ok(r.ok, JSON.stringify(r));
  return r.settings;
}

const LIMITS = (M) => ({ maxChars: M.calloutMaxChars, maxNameChars: M.calloutMaxNameChars });
const spec = (level, ships, extra) => ({ level, ships, pilots: 0, closing: false,
  groups: [{ key: `f:${SERPENTIS}`, faction: "Serpentis", ships, cls: "frigate" }], ...(extra || {}) });
const systemPass = (systemId, ships) => ({ systemId, readings: [{ level: "system",
  groups: ships > 0 ? [{ key: `f:${GURISTAS}`, faction: "Guristas", ships, cls: null }] : [] }] });

function rig(store, over, extraDeps) {
  const M = settings(over);
  const where = { state: "space" };
  let now = T0;
  const clock = { now: () => now, advance: (ms) => { now += ms; } };
  const transport = { calls: [], post(s) {
    this.calls.push(s);
    return Promise.resolve({ ok: false, reason: "NET_ERROR" });
  } };
  const client = createShipAiClient({ S: M, apiKey: "", transport, nowMs: clock.now });
  const npcs = [];
  const delivered = [];
  const calls = { grid: 0 };
  const toolDeps = {
    telemetry: () => ({ ok: true, docked: false, shipTypeId: 587, armorPermille: 1000, structurePermille: 1000,
      warping: false, entityId: SHIP, position: { x: 0, y: 0, z: 0 } }),
    typeName: (t) => ({ 587: "Rifter", [NPC_TYPE]: "Serpentis Scout" }[t] || null),
    itemByName: (name) => ({ ok: true, found: true, item: { groupName: name === "Rifter" ? "Frigate"
      : "Asteroid Serpentis Frigate" } }),
    graph: () => null,
    gridNpcs: () => {
      calls.grid += 1;
      return { ok: true, truncated: false, npcs: npcs.map((n) => ({ ...n })) };
    },
    pirates: () => new Set([SERPENTIS, GURISTAS]),
    standing: () => null,
    factionName: (id) => ({ [SERPENTIS]: "Serpentis", [GURISTAS]: "Guristas" }[id] || "an unknown faction"),
    invaderFactions: () => new Set(),
    ...(extraDeps || {}),
  };
  const adapter = { readPresence: () => ({ ok: true, characters: [{ characterId: PLAYER, name: "P", systemId: JITA,
    state: where.state }] }) };
  const p = createProactive({ S: M, maxIdentities: 16, store, prefsRepo: createShipAiPrefsRepository(),
    eventsRepo: createShipAiEventsRepository(M), adapter, seam: null, toolDeps, client,
    deliver: (id, lines) => {
      for (const l of lines) delivered.push(l);
      return { room: lines.length, system: 0, failed: 0 };
    },
    nameOf: () => "Jin", isWatched: (id) => id === PLAYER, isAllowed: () => true,
    staticIndex: () => new Map([[JITA, { name: "Jita", security: "highsec", region: "The Forge", regionId: 1 }]]),
    snapshot: () => ({ json: "{}", presence: null }),
    initialPrefs: new Map([[PLAYER, { quiet: false, lastProactiveAt: null }]]), nowMs: clock.now,
    setTimer: () => ({ cancel() {}, hasRef: () => false }) });
  assert.deepStrictEqual(p.start(), { ok: true, running: true });
  const npc = (entityId, km, targetId = 0) => ({ entityId, typeId: NPC_TYPE, factionId: SERPENTIS,
    position: { x: km * 1000, y: 0, z: 0 }, targetId, inWarp: false });
  return { M, p, clock, npcs, npc, delivered, transport, calls, where };
}

function insertPrefs(store) {
  const r = store.transaction("t.prefs", (db) => createShipAiPrefsRepository().insert(db,
    { playerId: PLAYER, aiId: AI, name: "Jin", nowMs: 1000 }));
  assert.ok(r.ok && r.value.ok, JSON.stringify(r));
}

module.exports = ({ test, skip }) => {
  test("CO1 buildCallout pl: fregata / 3 fregaty / 6 fregat / 12 fregat / 22 fregaty in attack, grid, system, scan; "
    + "w sektorze / Na skanie; no siat in data/callout.js and data/persona.js; <= calloutMaxChars", () => {
    const M = settings();
    const want = { 1: "fregata", 3: "3 fregaty", 6: "6 fregat", 12: "12 fregat", 22: "22 fregaty" };
    for (const [n, words] of Object.entries(want)) {
      for (const level of ["attack", "grid", "system", "scan"]) {
        const text = buildCallout(spec(level, Number(n)), "pl", 0, LIMITS(M));
        assert.ok(text.includes(`${words} Serpentis`), `${level} ${n}: ${text}`);
        if (level === "grid" || (level === "attack" && n !== "1")) assert.ok(text.includes("w sektorze"), text);
        if (level === "scan") assert.ok(text.startsWith("Na skanie"), text);
      }
    }
    assert.strictEqual(buildCallout(spec("attack", 3), "pl", 0, LIMITS(M)),
      "Atakują nas! 3 fregaty Serpentis w sektorze.");
    assert.strictEqual(buildCallout(spec("attack", 1), "pl", 0, LIMITS(M)), "Atakuje nas fregata Serpentis!");
    assert.strictEqual(buildCallout(spec("grid", 2, { closing: true }), "pl", 0, LIMITS(M)),
      "Kapitanie, 2 fregaty Serpentis w sektorze, zbliżają się.");
    assert.strictEqual(buildCallout(spec("scan", 1), "pl", 0, LIMITS(M)), "Na skanie wroga fregata Serpentis.");
    assert.strictEqual(buildCallout(spec("grid", 4), "en", 0, LIMITS(M)),
      "Captain, 4 Serpentis frigates in our sector.");
    for (const file of ["callout.js", "persona.js"]) {
      const text = fs.readFileSync(path.join(MOD_DIR, "lib", "shipAi", "data", file), "utf8")
        .replace("Never say \\\"siatka\\\".", "").toLowerCase();
      assert.ok(!text.includes("siat"), `${file} has no siat`);
    }
    const long = { level: "grid", ships: 14, pilots: 0, closing: true, groups: [
      { key: "f:1", faction: "Guristas Pirates Of The Very Long Name", ships: 7, cls: "Cruiser" },
      { key: "f:2", faction: "Serpentis Corporation Extended Name", ships: 7, cls: "Frigate" }] };
    for (const maxChars of [M.calloutMaxChars, 40]) {
      const text = buildCallout(long, "pl", 1, { maxChars, maxNameChars: M.calloutMaxNameChars });
      assert.ok(text.length <= maxChars && text.includes("14 statków"), `${maxChars}: ${text}`);
    }
  });

  test("CO2 planCallout system: 0 -> 6 Guristas = a line; the same reading after 5 s = silence; gone and back before "
    + "calloutClearMs = silence, after it = a line", () => {
    const M = settings({ calloutSystemCooldownMs: 60000 });
    const first = planCallout(null, systemPass(JITA, 6), T0, M);
    assert.ok(first.line, "a new wave speaks");
    assert.ok(buildCallout(first.line, "pl", 0, LIMITS(M)).includes("6 statków Guristas"),
      buildCallout(first.line, "pl", 0, LIMITS(M)));
    const same = planCallout(first.state, systemPass(JITA, 6), T0 + 5000, M);
    assert.deepStrictEqual([same.line, same.suppressed], [null, 1]);
    const gone = planCallout(same.state, systemPass(JITA, 0), T0 + 10000, M);
    const back = planCallout(gone.state, systemPass(JITA, 6), T0 + 10000 + M.calloutSystemCooldownMs, M);
    assert.strictEqual(back.line, null, "back before calloutClearMs: the same wave");
    const gone2 = planCallout(back.state, systemPass(JITA, 0), T0 + 80000, M);
    const wave = planCallout(gone2.state, systemPass(JITA, 6), T0 + 80000 + M.calloutClearMs, M);
    assert.ok(wave.line && wave.line.level === "system" && wave.line.ships === 6, "a new wave after calloutClearMs");
  });

  test("CO3 proactive: Serpentis at 20 km -> in the sector; closing next pass = silence; target = the ship -> under "
    + "attack despite calloutMinGapMs; ship_ai_events HOSTILES payload.level attack; zero HTTP", () => {
    const driver = SH.loadDriver();
    if (!driver.ok) return skip("CO3 hostile-callout proactive", `better-sqlite3 unavailable (${driver.detail})`);
    return SH.withStoreAsync(driver, async ({ store }) => {
      insertPrefs(store);
      const r = rig(store);
      r.npcs.push(r.npc(71, 20), r.npc(72, 22));
      r.p.runPass();
      assert.deepStrictEqual(r.delivered, [], "first pass: state only");
      r.clock.advance(5000);
      r.p.runPass();
      assert.deepStrictEqual(r.delivered, ["Kapitanie, 2 fregaty Serpentis w sektorze."]);
      r.npcs.splice(0, 2, r.npc(71, 15), r.npc(72, 16));
      r.clock.advance(5000);
      r.p.runPass();
      assert.strictEqual(r.delivered.length, 1, "closing, same rank: silence");
      r.npcs.splice(0, 2, r.npc(71, 15, SHIP), r.npc(72, 16, SHIP));
      r.clock.advance(5000);
      r.p.runPass();
      assert.ok(r.M.calloutMinGapMs > 10000, "the attack comes inside calloutMinGapMs");
      assert.deepStrictEqual(r.delivered.slice(1), ["Atakują nas! 2 fregaty Serpentis w sektorze."]);
      const rows = store.transaction("t.read", (db) => createShipAiEventsRepository(r.M).listRecent(db, PLAYER, 10))
        .value.rows.filter((e) => e.kind === "HOSTILES");
      assert.deepStrictEqual(rows.map((e) => [e.payload.level, e.payload.ships, e.key.split(":")[0],
        e.mentionedAt !== null]), [["attack", 2, "attack", true], ["grid", 2, "grid", true]]);
      const st = r.p.getStatus();
      assert.deepStrictEqual([st.counters.callouts, st.counters.calloutGrid, st.counters.calloutAttack,
        st.byKind.HOSTILE_GRID, st.byKind.HOSTILE_ATTACK, r.transport.calls.length], [2, 1, 1, 1, 1, 0]);
      r.p.stop();
    });
  });

  test("AL3!ai alerts off: Serpentis in the sector + the attack give no line and no gridNpcs read "
    + "isDscanAllowed off by callout / dscan / quiet, on by on/on; offerCallout refused; alerts on = the callout back",
  () => {
    const driver = SH.loadDriver();
    if (!driver.ok) return skip("AL3 alerts off proactive", `better-sqlite3 unavailable (${driver.detail})`);
    return SH.withStoreAsync(driver, async ({ store }) => {
      insertPrefs(store);
      const r = rig(store);
      r.p.setAlertModes(PLAYER, { calloutMode: "off" });
      r.npcs.push(r.npc(71, 20, SHIP), r.npc(72, 22, SHIP));
      r.p.runPass();
      r.clock.advance(5000);
      r.p.runPass();
      assert.deepStrictEqual([r.delivered, r.calls.grid, r.p.getStatus().counters.alertsSkipped,
        r.p.getStatus().alertsOff], [[], 0, 1, 1]);
      assert.deepStrictEqual(r.p.offerCallout(PLAYER, { level: "scan", groups: [] }), { queued: false });
      assert.deepStrictEqual(r.p.alertModesOf(PLAYER), { calloutMode: "off", dscanMode: "on" });
      assert.strictEqual(r.p.isDscanAllowed(PLAYER), false, "callout off");
      r.p.setAlertModes(PLAYER, { calloutMode: "on", dscanMode: "off" });
      assert.strictEqual(r.p.isDscanAllowed(PLAYER), false, "dscan off");
      r.p.setAlertModes(PLAYER, { dscanMode: "on" });
      assert.strictEqual(r.p.isDscanAllowed(PLAYER), true, "on / on");
      r.p.setQuiet(PLAYER, true);
      assert.strictEqual(r.p.isDscanAllowed(PLAYER), false, "quiet");
      r.p.setQuiet(PLAYER, false);
      r.clock.advance(5000);
      r.p.runPass();
      assert.deepStrictEqual(r.delivered, [], "first sight after the switch");
      r.clock.advance(5000);
      r.p.runPass();
      assert.deepStrictEqual(r.delivered, ["Atakują nas! 2 fregaty Serpentis w sektorze."]);
      assert.ok(r.calls.grid > 0);
      r.p.stop();
    });
  });

  test("CO4 escalation: after the attack the grid is silent; growth >= calloutGrowthMin past the cooldown = a second "
    + "line; a new system clears the state; calloutEnabled=false = the old static HOSTILES, no grid line", () => {
    const M = settings();
    const group = (ships) => [{ key: `f:${SERPENTIS}`, faction: "Serpentis", ships, cls: "frigate" }];
    const pass = (systemId, level, ships) => ({ systemId, readings: [{ level, groups: group(ships) }] });
    const attack = planCallout(null, pass(JITA, "attack", 3), T0, M);
    assert.strictEqual(attack.line.level, "attack");
    const eaten = planCallout(attack.state, pass(JITA, "grid", 3), T0 + 5000, M);
    assert.strictEqual(eaten.line, null, "the attack ate the grid");
    const grown = planCallout(eaten.state, pass(JITA, "grid", 3 + M.calloutGrowthMin),
      T0 + 5000 + M.calloutGridCooldownMs, M);
    assert.deepStrictEqual(grown.line && [grown.line.level, grown.line.ships], ["grid", 3 + M.calloutGrowthMin]);
    const moved = planCallout(grown.state, pass(TAMA, "grid", 3), T0 + 6000 + M.calloutGridCooldownMs, M);
    assert.ok(moved.line && moved.state.systemId === TAMA, "a new system: a new state");

    const prev = { systemId: JITA, state: "space", stable: "space", hostilesHere: 0 };
    const next = { ...prev, hostilesHere: 1, systemName: "Jita" };
    const prefs = { quiet: false, lastProactiveAt: null, lastByKind: new Map() };
    const off = settings({ calloutEnabled: false });
    assert.deepStrictEqual(planProactive(prev, next, prefs, T0, off).map((x) => [x.kind, x.line]),
      [["HOSTILES", "static"]]);
    assert.deepStrictEqual(planProactive(prev, next, prefs, T0, M), [], "callouts on: no static HOSTILES");

    const driver = SH.loadDriver();
    if (!driver.ok) return skip("CO4 hostile-callout off rig", `better-sqlite3 unavailable (${driver.detail})`);
    return SH.withStoreAsync(driver, async ({ store }) => {
      insertPrefs(store);
      const r = rig(store, { calloutEnabled: false });
      r.npcs.push(r.npc(71, 20, SHIP));
      r.p.runPass();
      r.clock.advance(5000);
      r.p.runPass();
      assert.deepStrictEqual([r.delivered, r.p.getStatus().counters.callouts], [[], 0]);
      r.p.stop();
    });
  });

  test("IN2 inbound: a non-hostile fleet in transit = silence; 4 Guristas -> coming from the next system, "
    + "HOSTILES payload.level inbound; same reading = silence; in the system after calloutMinGapMs = jumping in "
    + "(escalation); docked gets inbound too; TRANSIT_OFF = no line, calloutSensorFailed unchanged", () => {
    const driver = SH.loadDriver();
    if (!driver.ok) return skip("IN2 inbound callout", `better-sqlite3 unavailable (${driver.detail})`);
    const CALDARI = 500001;
    const INBOUND_LINE = "Kapitanie, 4 statki Guristas lecą do nas z sąsiedniego systemu.";
    const deps = (feed) => ({ graph: () => ({ hasSystem: () => true, getNeighbors: () => [] }),
      fleetsIn: () => ({ ok: true, bySystem: new Map([[JITA, feed.inSystem.map((f) => ({ ...f }))]]) }),
      inboundFleets: () => feed.inbound });
    const guristas = { ok: true, fleets: [{ fleetId: "f1", factionId: GURISTAS, ships: 4, etaMs: 30000 }] };
    return SH.withStoreAsync(driver, async ({ store }) => {
      insertPrefs(store);
      const feed = { inSystem: [], inbound: { ok: true, fleets: [{ fleetId: "f0", factionId: CALDARI, ships: 9,
        etaMs: 1000 }] } };
      const r = rig(store, {}, deps(feed));
      r.p.runPass();
      r.clock.advance(5000);
      r.p.runPass();
      assert.deepStrictEqual(r.delivered, [], "not hostile: silence");
      feed.inbound = guristas;
      r.clock.advance(5000);
      r.p.runPass();
      assert.deepStrictEqual(r.delivered, [INBOUND_LINE]);
      const rows = store.transaction("t.read", (db) => createShipAiEventsRepository(r.M).listRecent(db, PLAYER, 10))
        .value.rows.filter((e) => e.kind === "HOSTILES");
      assert.deepStrictEqual(rows.map((e) => [e.payload.level, e.payload.ships, e.key.split(":")[0]]),
        [["inbound", 4, "inbound"]]);
      r.clock.advance(5000);
      r.p.runPass();
      assert.strictEqual(r.delivered.length, 1, "the same reading: silence");
      feed.inbound = { ok: true, fleets: [] };
      feed.inSystem = [{ fleetId: "f1", factionId: GURISTAS, fleetRole: "invasion", shipCount: 4 }];
      r.clock.advance(r.M.calloutMinGapMs);
      r.p.runPass();
      assert.strictEqual(r.delivered.length, 2, JSON.stringify(r.delivered));
      assert.ok(r.delivered[1].includes("4 statki Guristas wskakują do systemu"), r.delivered[1]);
      const st = r.p.getStatus();
      assert.deepStrictEqual([st.counters.calloutInbound, st.counters.calloutSystem, st.counters.calloutSensorFailed],
        [1, 1, 0]);
      r.p.stop();

      const docked = rig(store, {}, deps({ inSystem: [], inbound: guristas }));
      docked.where.state = "docked";
      docked.p.runPass();
      docked.clock.advance(5000);
      docked.p.runPass();
      assert.deepStrictEqual(docked.delivered, [INBOUND_LINE], "docked: inbound too");
      docked.p.stop();

      const off = rig(store, {}, deps({ inSystem: [], inbound: { ok: false, reason: "TRANSIT_OFF" } }));
      off.p.runPass();
      off.clock.advance(5000);
      off.p.runPass();
      assert.deepStrictEqual([off.delivered, off.p.getStatus().counters.calloutSensorFailed], [[], 0]);
      off.p.stop();
    });
  });

  test("CO5 vendor facts: npcRegistry exports listControllersBySystem, npcBehaviorLoop sets "
    + "controller.currentTargetID =; readGridNpcsFrom skips a dormant controller, truncated at maxScan; the real "
    + "sensors facade has gridNpcs", () => {
    const src = (rel) => fs.readFileSync(path.join(SERVER_SRC, rel), "utf8").replace(/\r\n/g, "\n");
    const registry = src("space/npc/npcRegistry.js");
    assert.ok(/function listControllersBySystem\(systemID\)/.test(registry), "definition");
    assert.ok(/module\.exports = \{[^}]*\blistControllersBySystem,/.test(registry), "export");
    assert.ok(src("space/npc/npcBehaviorLoop.js").includes("controller.currentTargetID ="), "the combat target");

    const entities = new Map([[11, { typeID: NPC_TYPE, warFactionID: SERPENTIS, position: { x: 1, y: 2, z: 3 } }],
      [13, { typeID: NPC_TYPE, warFactionID: 0, position: { x: 4, y: 5, z: 6 }, mode: "WARP" }]]);
    const scene = { getEntityByID: (id) => entities.get(id) || null };
    const mods = { runtime: { isSolarSystemSceneLoaded: (id) => id === JITA, scenes: new Map([[JITA, scene]]) },
      registry: { listControllersBySystem: () => [{ entityID: 11, currentTargetID: SHIP },
        { entityID: 12, currentTargetID: 0 }, { entityID: 13, manualOrder: { type: "attack", targetID: 77 } },
        { entityID: 14 }] },
      factionKill: { resolveVictimFactionID: (e) => e.warFactionID } };
    assert.deepStrictEqual(readGridNpcsFrom(mods, JITA, { maxScan: 3 }), { ok: true, truncated: false, npcs: [
      { entityId: 11, typeId: NPC_TYPE, factionId: SERPENTIS, position: { x: 1, y: 2, z: 3 }, targetId: SHIP,
        inWarp: false },
      { entityId: 13, typeId: NPC_TYPE, factionId: null, position: { x: 4, y: 5, z: 6 }, targetId: 77,
        inWarp: true }] });
    assert.deepStrictEqual(readGridNpcsFrom(mods, TAMA, { maxScan: 3 }), { ok: false, reason: "SCENE_NOT_LOADED" });
    assert.deepStrictEqual(readGridNpcsFrom(mods, JITA, {}), { ok: false, reason: "INVALID_INPUT" });
    assert.deepStrictEqual(readGridNpcsFrom({}, JITA, { maxScan: 3 }), { ok: false, reason: "SEAM_UNAVAILABLE" });

    const SRC = path.join(path.sep, "x", "server", "src");
    const key = (rel) => path.join(SRC, `${rel}.js`);
    const cache = { [key("_secondary/chat/chatRuntime")]: { exports: {} },
      [key("services/chat/xmppStubServer")]: { exports: {} } };
    const adapter = createAdapter({ moduleApi: { _cache: cache }, logger: { log() {} } });
    adapter.setServerSrc(SRC);
    const seams = adapter.shipAiSeams();
    assert.strictEqual(seams.ok, true, JSON.stringify(seams));
    assert.ok(Object.keys(seams.seam.sensors).includes("gridNpcs"));
    assert.strictEqual(seams.seam.sensors.gridNpcs(JITA, { maxScan: 3 }).ok, false, "no vendor modules: refused");
  });

  test("CO6: listControllersBySystem has its own consumer shipAiCallout, resolveVictimFactionID has "
    + "no shipAi consumer; a DRIFT of the grid read refuses only gridNpcs, the telemetry still reads", () => {
    const { GAME_MODULES } = require("../../lib/adapter/gameModules");
    const symOf = (rel, name) => GAME_MODULES.find((e) => e.path === rel).symbols.find((s) => s.name === name);
    assert.deepStrictEqual(symOf("space/npc/npcRegistry", "listControllersBySystem").consumers, ["shipAiCallout"]);
    assert.ok(!symOf("services/character/factionKillStandingRuntime", "resolveVictimFactionID").consumers
      .some((c) => /^shipAi/.test(c)));

    const table = GAME_MODULES.map((e) => (e.path === "space/npc/npcRegistry" ? e : { ...e, symbols: [] }));
    const SRC = path.join(path.sep, "x", "server", "src");
    const key = (rel) => path.join(SRC, `${rel}.js`);
    const cache = { [key("_secondary/chat/chatRuntime")]: { exports: {} },
      [key("services/chat/xmppStubServer")]: { exports: {} },
      [key("space/npc/npcRegistry")]: { exports: {} },
      [key("services/chat/sessionRegistry")]: { exports: {
        getSessions: () => [{ characterID: PLAYER, stationid: 60003760, shipID: SHIP }] } },
      [key("services/inventory/itemStore")]: { exports: {
        findItemById: (id) => (id === SHIP ? { typeID: 587, conditionState: {} } : null) } } };
    const adapter = createAdapter({ moduleApi: { _cache: cache }, logger: { log() {} }, gameModules: table });
    adapter.setServerSrc(SRC);
    const report = adapter.runProbe();
    assert.deepStrictEqual(Object.keys(report.disabledModules), ["shipAiCallout", "shipAiDscan", "sentryDefend"],
      JSON.stringify(report.disabledModules));
    const sensors = adapter.shipAiSeams().seam.sensors;
    assert.deepStrictEqual(sensors.gridNpcs(JITA, { maxScan: 3 }), { ok: false, reason: "SEAM_UNAVAILABLE" });
    const t = sensors.telemetry(PLAYER);
    assert.deepStrictEqual([t.ok, t.docked, t.shipTypeId], [true, true, 587], JSON.stringify(t));
  });

  test("CO7 waves: 4 Guristas -> line; same ids = silence; empty grid then 4 new Guristas inside "
    + "calloutGridCooldownMs and calloutClearMs = new wave; all new ids again inside calloutWaveCooldownMs = silence; "
    + "past it = a second wave line", () => {
    const M = settings();
    const ids = (from) => [from, from + 1, from + 2, from + 3];
    const gridPass = (list) => ({ systemId: JITA, position: { x: 0, y: 0, z: 0 }, readings: [
      { level: "attack", groups: [] },
      { level: "grid", nearest: 20000, groups: list ? [{ key: `f:${GURISTAS}`, faction: "Guristas",
        ships: list.length, cls: null, ids: list }] : [] }] });
    const first = planCallout(null, gridPass(ids(1)), T0, M);
    assert.ok(first.line && first.line.wave === false, "the first sight is a plain grid line");
    const same = planCallout(first.state, gridPass(ids(1)), T0 + 5000, M);
    assert.strictEqual(same.line, null, "same ids: silence");
    const empty = planCallout(same.state, gridPass(null), T0 + 10000, M);
    assert.strictEqual(empty.line, null);
    const at = T0 + 10000 + M.calloutMinGapMs;
    assert.ok(at - T0 < M.calloutGridCooldownMs && at - T0 < M.calloutClearMs, "inside the old blockers");
    const wave = planCallout(empty.state, gridPass(ids(5)), at, M);
    assert.ok(wave.line && wave.line.wave === true, "back after an absence: a new wave");
    assert.strictEqual(buildCallout(wave.line, "pl", 0, LIMITS(M)),
      "Kapitanie, nowa fala: 4 statki Guristas w sektorze.");
    assert.strictEqual(buildCallout(wave.line, "en", 0, LIMITS(M)),
      "Captain, new wave: 4 Guristas ships in our sector.");
    const quick = planCallout(wave.state, gridPass(ids(9)), at + M.calloutMinGapMs, M);
    assert.ok(M.calloutMinGapMs < M.calloutWaveCooldownMs, "the gap is shorter than the wave cooldown");
    assert.strictEqual(quick.line, null, "two waves inside calloutWaveCooldownMs: one line");
    const later = planCallout(quick.state, gridPass(ids(13)), at + M.calloutWaveCooldownMs, M);
    assert.ok(later.line && later.line.wave === true, "all new ids with no empty pass = a new wave");
    assert.strictEqual(M.calloutWaveCooldownMs, 25000, "Default");
  });

  test("CO8 proactive landing: 3 Serpentis at anomaly A -> line; warp; land 10 000 km away on 3 other "
    + "Serpentis = a grid line in the first pass after landing (inside calloutGridCooldownMs); a jump with no warp pass seen = "
    + "a line too; calloutDiagOf counts the sector read", () => {
    const driver = SH.loadDriver();
    if (!driver.ok) return skip("CO8 landing callout", `better-sqlite3 unavailable (${driver.detail})`);
    return SH.withStoreAsync(driver, async ({ store }) => {
      insertPrefs(store);
      const ship = { warping: false, position: { x: 0, y: 0, z: 0 } };
      const r = rig(store, {}, { telemetry: () => ({ ok: true, docked: false, shipTypeId: 587, armorPermille: 1000,
        structurePermille: 1000, warping: ship.warping, entityId: SHIP, position: { ...ship.position } }) });
      const at = (entityId, x) => ({ entityId, typeId: NPC_TYPE, factionId: SERPENTIS, position: { x, y: 0, z: 0 },
        targetId: 0, inWarp: false });
      r.npcs.push(at(71, 20000), at(72, 21000), at(73, 22000));
      r.p.runPass();
      r.clock.advance(5000);
      r.p.runPass();
      assert.deepStrictEqual(r.delivered, ["Kapitanie, 3 fregaty Serpentis w sektorze."]);
      ship.warping = true;
      r.clock.advance(5000);
      r.p.runPass();
      const B = 1e10;
      ship.warping = false;
      ship.position = { x: B, y: 0, z: 0 };
      r.npcs.push(at(81, B + 20000), at(82, B + 21000), at(83, B + 22000));
      r.clock.advance(10000);
      r.p.runPass();
      assert.ok(r.clock.now() - T0 < r.M.calloutGridCooldownMs);
      assert.deepStrictEqual(r.delivered.slice(1), ["Kapitanie, 3 fregaty Serpentis w sektorze."], "landing line");
      const C = 2e10;
      ship.position = { x: C, y: 0, z: 0 };
      r.npcs.push(at(91, C + 20000), at(92, C + 21000), at(93, C + 22000));
      r.clock.advance(r.M.calloutMinGapMs);
      r.p.runPass();
      assert.strictEqual(r.delivered.length, 3, `a jump with no warp pass: ${JSON.stringify(r.delivered)}`);
      const diag = r.p.calloutDiagOf(PLAYER);
      assert.deepStrictEqual([diag.on, diag.counters.callouts, diag.counters.calloutGrid, diag.counters.calloutWave,
        diag.sector && [diag.sector.npcs, diag.sector.inRange, diag.sector.hostile, diag.sector.noFaction]],
      [true, 3, 3, 0, [9, 3, 3, 0]]);
      r.p.stop();
    });
  });

  test("CO9 dungeon NPC faction: warFactionID 0 + a pirate owner corporation -> the pirate faction (hostile) "
    + "no owner + a site of Angels -> Angels; a CONCORD owner -> not hostile; vendor facts and the shipAiCallout "
    + "consumer of getOwnerFactionID / getInstanceRef", () => {
    const { isHostileFaction } = require("../../lib/shipAi/callout");
    const ANGELS = 500011;
    const CONCORD = 500006;
    const entities = new Map([
      [21, { typeID: NPC_TYPE, warFactionID: 0, ownerID: 1000127, position: { x: 1, y: 0, z: 0 } }],
      [22, { typeID: NPC_TYPE, warFactionID: 0, ownerID: 0, dungeonSiteInstanceID: 55,
        position: { x: 2, y: 0, z: 0 } }],
      [23, { typeID: NPC_TYPE, warFactionID: 0, ownerID: 1000125, position: { x: 3, y: 0, z: 0 } }],
      [24, { typeID: NPC_TYPE, warFactionID: 0, ownerID: 0, position: { x: 4, y: 0, z: 0 } }]]);
    const scene = { getEntityByID: (id) => entities.get(id) || null };
    const mods = { runtime: { isSolarSystemSceneLoaded: () => true, scenes: new Map([[JITA, scene]]) },
      registry: { listControllersBySystem: () => [21, 22, 23, 24].map((entityID) => ({ entityID })) },
      factionKill: { resolveVictimFactionID: (e) => e.warFactionID },
      standing: { getOwnerFactionID: (id) => ({ 1000127: GURISTAS, 1000125: CONCORD }[id] || null) },
      dungeon: { getInstanceRef: (id) => (id === 55 ? { factionID: ANGELS } : null) } };
    const read = readGridNpcsFrom(mods, JITA, { maxScan: 10 });
    assert.deepStrictEqual(read.npcs.map((n) => n.factionId), [GURISTAS, ANGELS, CONCORD, null]);
    const ctx = { pirates: new Set([GURISTAS, ANGELS, SERPENTIS]), invaders: null, standing: () => null };
    const M = settings();
    assert.deepStrictEqual(read.npcs.map((n) => isHostileFaction(n.factionId, ctx, M)), [true, true, false, false]);
    const thrown = readGridNpcsFrom({ ...mods, standing: { getOwnerFactionID: () => { throw new Error("x"); } },
      dungeon: null }, JITA, { maxScan: 10 });
    assert.deepStrictEqual(thrown.npcs.map((n) => n.factionId), [null, null, null, null], "optional steps");

    const src = (rel) => fs.readFileSync(path.join(SERVER_SRC, rel), "utf8").replace(/\r\n/g, "\n");
    const standing = src("services/character/standingRuntime.js");
    assert.ok(/function getOwnerFactionID\(ownerID\)/.test(standing) && /\n  getOwnerFactionID,\n/.test(standing));
    const dungeon = src("services/dungeon/dungeonRuntime.js");
    assert.ok(/function getInstanceRef\(instanceID\)/.test(dungeon) && /\n  getInstanceRef,\n/.test(dungeon));
    assert.ok(src("services/dungeon/dungeonRuntime.js").includes("factionID: template.factionID || null"));
    const npc = src("space/npc/nativeNpcService.js");
    assert.ok(npc.includes("entity.ownerID = entityRecord.ownerID;") && npc.includes("entity.warFactionID = "
      + "entityRecord.warFactionID;"), "the native NPC entity carries ownerID / warFactionID");
    const { GAME_MODULES } = require("../../lib/adapter/gameModules");
    const symOf = (rel, name) => GAME_MODULES.find((e) => e.path === rel).symbols.find((s) => s.name === name);
    assert.ok(symOf("services/character/standingRuntime", "getOwnerFactionID").consumers.includes("shipAiCallout"));
    assert.ok(symOf("services/dungeon/dungeonRuntime", "getInstanceRef").consumers.includes("shipAiCallout"));
  });

  test("CO10: Sleepers 500021 on the grid = a grid line, CONCORD 500006 not; an empty "
    + "calloutHostileFactionIds = the old rule (Sleepers not hostile)", () => {
    const { isHostileFaction } = require("../../lib/shipAi/callout");
    const SLEEPERS = 500021;
    const CONCORD = 500006;
    const ctx = { pirates: new Set([GURISTAS]), invaders: null, standing: () => null };
    const M = settings();
    assert.strictEqual(M.calloutHostileFactionIds, "500021,500024,500026", "default");
    assert.deepStrictEqual([500021, 500024, 500026, CONCORD].map((id) => isHostileFaction(id, ctx, M)),
      [true, true, true, false]);
    assert.strictEqual(isHostileFaction(SLEEPERS, ctx, settings({ calloutHostileFactionIds: "" })), false);
    const driver = SH.loadDriver();
    if (!driver.ok) return skip("CO10 always hostile rig", `better-sqlite3 unavailable (${driver.detail})`);
    return SH.withStoreAsync(driver, async ({ store }) => {
      insertPrefs(store);
      for (const [over, want] of [[{}, 1], [{ calloutHostileFactionIds: "" }, 0]]) {
        const r = rig(store, over, { factionName: (id) => (id === SLEEPERS ? "Sleepers" : "an unknown faction") });
        r.npcs.push({ ...r.npc(71, 20), factionId: SLEEPERS }, { ...r.npc(72, 21), factionId: CONCORD });
        r.p.runPass();
        r.clock.advance(5000);
        r.p.runPass();
        assert.strictEqual(r.delivered.length, want, JSON.stringify(r.delivered));
        if (want === 1) assert.strictEqual(r.delivered[0], "Kapitanie, fregata Sleepers w sektorze.");
        r.p.stop();
      }
    });
  });

  test("CO11: a scan line, 60 s later an inbound fleet of another faction = an inbound "
    + "line, then a system fleet of a third = a system line; a second scan group inside calloutScanCooldownMs = "
    + "silence, past it = a line; a grid line still mutes the scan level", () => {
    const M = settings();
    assert.strictEqual(M.calloutScanCooldownMs, 60000, "default");
    const ANGEL = 500011;
    const g = (faction, ships) => ({ key: `f:${faction}`, faction: String(faction), ships, cls: null });
    const pass = (level, faction, ships) => ({ systemId: JITA, readings: [{ level, groups: [g(faction, ships)] }] });
    const scan = planCallout(null, pass("scan", SERPENTIS, 3), T0, M);
    assert.strictEqual(scan.line && scan.line.level, "scan");
    assert.deepStrictEqual(Object.keys(scan.state.levelAt), ["scan"], "a scan line sets only its own clock");
    const inbound = planCallout(scan.state, pass("inbound", GURISTAS, 4), T0 + 60000, M);
    assert.strictEqual(inbound.line && inbound.line.level, "inbound", "the inbound warning after a scan line");
    assert.ok(buildCallout(inbound.line, "pl", 0, LIMITS(M)).includes("lecą do nas"),
      buildCallout(inbound.line, "pl", 0, LIMITS(M)));
    const system = planCallout(inbound.state, pass("system", ANGEL, 2), T0 + 80000, M);
    assert.strictEqual(system.line && system.line.level, "system", "a system line after a scan and an inbound line");

    const early = planCallout(scan.state, pass("scan", GURISTAS, 2), T0 + M.calloutScanCooldownMs - 1, M);
    assert.deepStrictEqual([early.line, early.suppressed], [null, 1], "inside calloutScanCooldownMs");
    const late = planCallout(early.state, pass("scan", GURISTAS, 2), T0 + M.calloutScanCooldownMs, M);
    assert.strictEqual(late.line && late.line.level, "scan", "a second scan group past calloutScanCooldownMs");

    const grid = planCallout(null, pass("grid", SERPENTIS, 3), T0, M);
    assert.deepStrictEqual(Object.keys(grid.state.levelAt).sort(), ["grid", "inbound", "scan", "system"]);
    const muted = planCallout(grid.state, pass("scan", GURISTAS, 2), T0 + 30000, M);
    assert.strictEqual(muted.line, null, "the grid line eats the scan level (higher eats lower)");
  });
};
