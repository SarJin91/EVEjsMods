"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
const { resolveSqliteDriver } = require("../../lib/adapter/sqliteDriver");
const { openStore } = require("../../lib/persistence/store");
const { seedDbFile } = require("../_support/dbTemplate");
const { createJournal } = require("../../lib/persistence/journal");
const { createManualClock } = require("../../lib/util/clock");
const { buildUniverseGraph } = require("../../lib/graph/universeGraph");
const { createRouteFinder } = require("../../lib/graph/routes");
const { HULL_GROUPS, FLEET_ROLES, OPERATION_TYPES } = require("../../lib/fleets/schema");
const { createHostility } = require("../../lib/battle/data/hostility");
const { REGISTRY_DATA_V1, createFactionRegistry } = require("../../lib/strategy/registry");
const { validateCampaign } = require("../../lib/strategy/campaignCheck");
const { createFactionRepository } = require("../../lib/strategy/factionRepository");
const { startStrategy } = require("../../lib/strategy");
const { createViewRegistry } = require("../../lib/observer/views");
const { resolveConfig } = require("../../config");
const { k3StaticMap, system } = require("./fixtures/k3Cluster.fixture");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const START_MS = 1760000000000;
const CTX = Object.freeze({ hullGroups: HULL_GROUPS, fleetRoles: FLEET_ROLES, operationTypes: OPERATION_TYPES,
  hostility: createHostility(), maxFactions: 64, maxCampaignSystems: 40, maxShipsPerFleet: 500,
  maxCompositionEntries: 32, maxResourceUnits: 1000000000 });

function loadDriver() {
  const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
  if (!found.ok) return { ok: false, detail: found.reason };
  return resolveSqliteDriver(found.srcDir);
}

function withStore(driver, fn, { fresh = false } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-strat-"));
  const file = path.join(tmp, "world.sqlite");
  const open = [];
  const reopen = () => {
    if (!fresh) seedDbFile(driver, file, { seed: 1 });
    const opened = openStore({ filePath: file, openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
      busyTimeoutMs: 0, maxRowsPerTransaction: 500, maxWriteMsPerPass: 5, randomSeed: () => 1 });
    assert.ok(opened.ok, JSON.stringify(opened));
    open.push(opened.store);
    return opened.store;
  };
  const cleanup = () => {
    for (const s of open) s.close("test_cleanup");
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch (_err) {
    }
  };
  let result;
  try {
    result = fn(reopen);
  } catch (err) {
    cleanup();
    throw err;
  }
  if (result && typeof result.then === "function") return result.finally(cleanup);
  cleanup();
  return result;
}

function graphOf(opts) {
  const built = buildUniverseGraph(k3StaticMap(opts));
  assert.ok(built.ok);
  const finder = createRouteFinder(built.graph, { cacheSize: 16, maxJumps: 40 });
  return Object.freeze({ ...built.graph, ...finder.publicApi });
}

const tx = (store, fn) => {
  const r = store.transaction("test", fn);
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
};
const journalRows = (store) => tx(store, (db) => db.prepare("SELECT count(*) AS n FROM world_event_journal").get().n);
const factionRows = (store) => tx(store, (db) => db.prepare("SELECT * FROM world_factions ORDER BY faction_id").all());

function registry() {
  const r = createFactionRegistry(REGISTRY_DATA_V1, CTX);
  assert.ok(r.ok, JSON.stringify(r));
  return r.registry;
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  test("T1 registry: V1 ok, templates of HULL_GROUPS, allies match hostility, three bad variants refused", () => {
    const reg = registry();
    assert.strictEqual(reg.listFactions().length, 27);
    assert.deepStrictEqual(reg.listActiveFactions().map((f) => f.factionId),
      [500001, 500002, 500003, 500004, 500006, 500010, 500011, 500012, 500016, 500019, 500020, 500021, 500026,
        500029]);
    assert.deepStrictEqual(reg.version, { factions: 19, doctrines: 25, campaigns: 1, catalog: 1, activeCount: 14 });
    for (const f of reg.listActiveFactions()) {
      const doctrine = reg.getDoctrine(f.doctrineId);
      assert.strictEqual(doctrine.kind, f.kind);
      for (const entries of Object.values(doctrine.templates)) {
        for (const e of entries) assert.ok(HULL_GROUPS.includes(e.hullGroup), e.hullGroup);
      }
      for (const ally of f.allies) assert.strictEqual(createHostility()(f.factionId, ally), false);
    }
    assert.ok(Object.isFrozen(reg.getFaction(500019).startStations[0]));
    assert.deepStrictEqual(reg.getCampaignsForFaction(500003).map((c) => c.campaignId), ["k3-stain"]);
    assert.strictEqual(reg.isTheatreSystem("k3-stain", 30001954), true);
    assert.strictEqual(reg.isTheatreSystem("k3-stain", 30001721), false);

    const clone = (v) => JSON.parse(JSON.stringify(v));
    const badHull = clone(REGISTRY_DATA_V1);
    badHull.doctrines[0].templates.patrol[0].hullGroup = "no_such_hull";
    const badDoctrine = clone(REGISTRY_DATA_V1);
    badDoctrine.factions[1].doctrineId = "missing-v1";
    const unknownField = clone(REGISTRY_DATA_V1);
    unknownField.factions[2].colour = "green";
    const wideTemplate = clone(REGISTRY_DATA_V1);
    wideTemplate.doctrines[0].templates.patrol = HULL_GROUPS.slice(0, 18).map((hullGroup) => ({ hullGroup, count: 1 }));
    for (const [data, detail] of [[badHull, "doctrines[0].templates.patrol[0].hullGroup"],
      [badDoctrine, "factions[1].doctrineId"], [unknownField, "factions[2].colour"],
      [wideTemplate, "doctrines[0].templates.patrol.groups"]]) {
      assert.deepStrictEqual(createFactionRegistry(data, CTX), { ok: false, reason: "REGISTRY_INVALID", detail });
    }
  });

  test("HC3 doctrines v14: hoardCapped in the 3 pirate doctrines, raidsBeyondTheatre in the 2 territorial "
    + "ones, both default false; non-boolean and true on an invader / police doctrine -> REGISTRY_INVALID "
    + "reachJumps 10 in the 2 territorial ones, Sansha 6", () => {
    const { DOCTRINES_VERSION } = require("../../lib/strategy/data/doctrines");
    const reg = registry();
    const all = REGISTRY_DATA_V1.doctrines.map((d) => reg.getDoctrine(d.doctrineId));
    const ids = (field) => all.filter((d) => d[field] === true).map((d) => d.doctrineId).sort();
    const clone = (v) => JSON.parse(JSON.stringify(v));
    const at = (id) => REGISTRY_DATA_V1.doctrines.findIndex((d) => d.doctrineId === id);
    const refused = [];
    for (const [id, field, value] of [["pirate-territorial-v2", "hoardCapped", "yes"],
      ["serpentis-territorial-v2", "raidsBeyondTheatre", 1], ["triglavian-invader-v1", "hoardCapped", true],
      ["concord-border-police-v1", "raidsBeyondTheatre", true]]) {
      const data = clone(REGISTRY_DATA_V1);
      data.doctrines[at(id)][field] = value;
      refused.push(createFactionRegistry(data, CTX));
    }
    const reach = Object.fromEntries(["pirate-territorial-v2", "serpentis-territorial-v2", "sansha-incursion-v1"]
      .map((id) => [id, reg.getDoctrine(id).reachJumps]));
    assert.deepStrictEqual({ version: DOCTRINES_VERSION, hoard: ids("hoardCapped"), raids: ids("raidsBeyondTheatre"),
      reach,
      kinds: [...new Set(all.filter((d) => d.hoardCapped === true).map((d) => d.kind))],
      defaults: all.filter((d) => d.hoardCapped !== true).map((d) => [d.hoardCapped, d.raidsBeyondTheatre])
        .every(([h, r]) => h === false && r === false), refused }, {
      version: 25, hoard: ["pirate-territorial-v2", "rogue-hive-v1", "sansha-incursion-v1",
        "serpentis-territorial-v2", "soe-territorial-v1"],
      reach: { "pirate-territorial-v2": 10, "serpentis-territorial-v2": 10, "sansha-incursion-v1": 6 },
      raids: ["pirate-territorial-v2", "rogue-hive-v1", "serpentis-territorial-v2", "soe-territorial-v1"],
      kinds: ["pirate", "hive", "neutral"],
      defaults: true,
      refused: [
        { ok: false, reason: "REGISTRY_INVALID", detail: `doctrines[${at("pirate-territorial-v2")}].hoardCapped` },
        { ok: false, reason: "REGISTRY_INVALID",
          detail: `doctrines[${at("serpentis-territorial-v2")}].raidsBeyondTheatre` },
        { ok: false, reason: "REGISTRY_INVALID", detail: `doctrines[${at("triglavian-invader-v1")}].hoardCapped` },
        { ok: false, reason: "REGISTRY_INVALID",
          detail: `doctrines[${at("concord-border-police-v1")}].raidsBeyondTheatre` }] });
  });

  test("TA1 concord-empire-tribute registry v13: tributeTo of the 4 empires = CONCORD, tributeRecipientOf / "
    + "isTributeRecipient on the real facade (ctx.activeFactionIds narrows it); own id, payer outside the allies of "
    + "the receiver, passive receiver -> REGISTRY_INVALID", () => {
    const reg = registry();
    assert.strictEqual(typeof reg.tributeRecipientOf, "function");
    assert.strictEqual(typeof reg.isTributeRecipient, "function");
    for (const payer of [500001, 500002, 500003, 500004]) assert.strictEqual(reg.tributeRecipientOf(payer), 500006);
    assert.deepStrictEqual(reg.listFactions().filter((f) => f.tributeTo !== undefined).map((f) => f.factionId),
      [500001, 500002, 500003, 500004]);
    assert.strictEqual(reg.tributeRecipientOf(500006), null);
    assert.strictEqual(reg.tributeRecipientOf(424242), null);
    assert.strictEqual(reg.isTributeRecipient(500006), true);
    assert.strictEqual(reg.isTributeRecipient(500003), false);
    const lone = createFactionRegistry(REGISTRY_DATA_V1, { ...CTX, activeFactionIds: [500006] });
    assert.ok(lone.ok, JSON.stringify(lone));
    assert.strictEqual(lone.registry.isTributeRecipient(500006), false);
    assert.strictEqual(lone.registry.tributeRecipientOf(500003), 500006);

    const clone = (v) => JSON.parse(JSON.stringify(v));
    const at = (data, id) => data.factions.findIndex((f) => f.factionId === id);
    const self = clone(REGISTRY_DATA_V1);
    self.factions[at(self, 500003)].tributeTo = 500003;
    const notAlly = clone(REGISTRY_DATA_V1);
    notAlly.factions[at(notAlly, 500019)].tributeTo = 500006;
    const passive = clone(REGISTRY_DATA_V1);
    const passiveId = passive.factions.find((f) => f.activity === "passive").factionId;
    passive.factions[at(passive, 500003)].tributeTo = passiveId;
    const noStations = clone(REGISTRY_DATA_V1);
    noStations.factions[at(noStations, 500006)].startStations = [];
    const firstPayer = noStations.factions.find((f) => f.tributeTo === 500006).factionId;
    for (const [data, id] of [[self, 500003], [notAlly, 500019], [passive, 500003], [noStations, firstPayer]]) {
      assert.deepStrictEqual(createFactionRegistry(data, CTX),
        { ok: false, reason: "REGISTRY_INVALID", detail: `factions[${at(data, id)}].tributeTo` });
    }
  });

  test("D1 doctrines v4: optional fields with v3 defaults in the built doctrine, Amarr v3 belt fields "
    + "(sovereignty friendly) "
    + "inconsistent combinations -> REGISTRY_INVALID with the field path", () => {
    const reg = registry();
    const sansha = reg.getDoctrine("sansha-incursion-v1");
    assert.deepStrictEqual([sansha.ownSpace, sansha.borderReachKey, sansha.borderTargets, sansha.borderCaptures,
      sansha.captureTargets, sansha.targetSecClasses], [null, null, false, false,
      ["free", "contested", "hostile", "home"], ["nullsec"]]);
    assert.ok(Object.isFrozen(sansha.captureTargets));
    const amarr = reg.getDoctrine(reg.getFaction(500003).doctrineId);
    assert.deepStrictEqual([amarr.doctrineId, amarr.ownSpace, amarr.borderReachKey, amarr.borderTargets,
      amarr.borderCaptures, amarr.captureTargets, amarr.operationTypes.includes("raid")], ["amarr-border-defense-v3",
      { secClasses: ["highsec", "lowsec"], sovereignty: "friendly" }, "empireMaxReachJumps", true, true,
      ["free", "contested", "hostile"], true]);
    assert.strictEqual(reg.getDoctrine("amarr-border-defense-v1"), null);
    assert.strictEqual(reg.getDoctrine("amarr-border-defense-v2"), null);
    assert.strictEqual(reg.getDoctrine("empire-border-defense-v1"), null);
    const clone = (v) => JSON.parse(JSON.stringify(v));
    const variant = (patch) => {
      const data = clone(REGISTRY_DATA_V1);
      Object.assign(data.doctrines[0], patch);
      return data;
    };
    for (const [patch, detail] of [
      [{ borderCaptures: true }, "doctrines[0].ownSpace"],
      [{ canOccupy: false, captureTargets: ["free"] }, "doctrines[0].captureTargets"],
      [{ borderReachKey: "foo" }, "doctrines[0].borderReachKey"],
      [{ targetSecClasses: ["highsec"] }, "doctrines[0].targetSecClasses[0]"],
    ]) {
      assert.deepStrictEqual(createFactionRegistry(variant(patch), CTX), { ok: false, reason: "REGISTRY_INVALID",
        detail }, JSON.stringify(patch));
    }
  });

  test("D1 pirates: 10 active, Guristas / Angel / Blood on pirate-territorial-v1 (= Serpentis "
    + "fields), base "
    + "= catalog R-N base, start stations = prefix of candidates.nullsec within startStationsPerFaction", () => {
    const { FACTION_CATALOG } = require("../../lib/strategy/data/factionCatalog");
    const reg = registry();
    const PIRATES = [500010, 500011, 500012];
    const INVADERS = [500021, 500026, 500029];
    assert.deepStrictEqual(reg.listActiveFactions().map((f) => f.factionId),
      [500001, 500002, 500003, 500004, 500006, ...PIRATES, 500016, 500019, 500020, ...INVADERS]);
    for (const f of reg.listActiveFactions()) assert.strictEqual(reg.getDoctrine(f.doctrineId).kind, f.kind);
    const doctrine = reg.getDoctrine("pirate-territorial-v2");
    const { doctrineId: _a, origin: _b, ...fields } = doctrine;
    const { doctrineId: _c, origin: _d, ...serpentis } = reg.getDoctrine("serpentis-territorial-v2");
    assert.deepStrictEqual(fields, serpentis);
    assert.ok(doctrine.operationTypes.includes("invasion"));
    assert.deepStrictEqual(doctrine.captureTargets, ["free", "contested", "hostile", "home"]);
    assert.strictEqual(reg.getDoctrine("pirate-territorial-v1"), null);
    assert.strictEqual(reg.getDoctrine("serpentis-territorial-v1"), null);
    const perFaction = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir() } })
      .config.stations.startStationsPerFaction;
    for (const id of PIRATES) {
      const f = reg.getFaction(id);
      const e = FACTION_CATALOG.find((x) => x.factionId === id);
      assert.deepStrictEqual([f.kind, f.doctrineId, f.maxActiveFronts, f.initialResourceUnits, f.initialReserveUnits],
        ["pirate", "pirate-territorial-v2", 6, 8000, 150], String(id));
      assert.strictEqual(f.hqSystemId, e.candidates.suggestedBaseSystemId, `${id} base`);
      if (e.ownRegionIds.length > 0) assert.deepStrictEqual(f.homeRegionIds, e.ownRegionIds, `${id} region`);
      assert.ok(f.startStations.length >= 1 && f.startStations.length <= perFaction, `${id} stations`);
      assert.deepStrictEqual(f.startStations.map((s) => [s.stationId, s.systemId, s.corporationId]),
        e.candidates.nullsec.slice(0, f.startStations.length).map((row) => row.slice(0, 3)), `${id} candidates`);
    }
    assert.deepStrictEqual(PIRATES.map((id) => reg.getFaction(id).allies), [[], [500020], []]);
  });

  test("D1 empires: 13 active, Caldari / Minmatar / Gallente on empire-border-defense-v2 (= built Amarr v3 "
    + "fields, sovereignty friendly) with ownSpace, hq = sdeHqSystemId, home = borderRegionIds, start "
    + "stations = prefix of candidates.border (>= 1); + 3 invaders", () => {
    const { FACTION_CATALOG } = require("../../lib/strategy/data/factionCatalog");
    const reg = registry();
    const EMPIRES = [500001, 500002, 500004];
    assert.deepStrictEqual(reg.listActiveFactions().length, 14);
    assert.strictEqual(reg.getFaction(500003).doctrineId, "amarr-border-defense-v3");
    assert.deepStrictEqual([reg.getDoctrine("amarr-border-defense-v2"), reg.getDoctrine("empire-border-defense-v1")],
      [null, null]);
    const { doctrineId: _a, origin: _b, ...fields } = reg.getDoctrine("empire-border-defense-v2");
    const { doctrineId: _c, origin: _d, ...amarr } = reg.getDoctrine("amarr-border-defense-v3");
    assert.deepStrictEqual(fields, amarr);
    const perFaction = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir() } })
      .config.stations.startStationsPerFaction;
    for (const id of EMPIRES) {
      const f = reg.getFaction(id);
      const e = FACTION_CATALOG.find((x) => x.factionId === id);
      const doctrine = reg.getDoctrine(f.doctrineId);
      assert.deepStrictEqual([f.kind, f.activity, doctrine.kind, f.doctrineId, f.maxActiveFronts,
        f.initialResourceUnits, f.initialReserveUnits, f.allies], ["empire", "active", "empire",
        "empire-border-defense-v2", 6, 20000, 300, [500006]], String(id));
      assert.deepStrictEqual(doctrine.ownSpace, { secClasses: ["highsec", "lowsec"], sovereignty: "friendly" });
      assert.deepStrictEqual([f.ownerCorporationId, f.hqSystemId, f.homeRegionIds],
        [e.corporationId, e.sdeHqSystemId, e.borderRegionIds], `${id} catalog`);
      assert.ok(f.startStations.length >= 1 && f.startStations.length <= perFaction, `${id} stations`);
      assert.deepStrictEqual(f.startStations.map((s) => [s.kind, s.stationId, s.systemId, s.corporationId]),
        e.candidates.border.slice(0, f.startStations.length).map((row) => ["npc", ...row.slice(0, 3)]),
        `${id} candidates`);
    }
    assert.deepStrictEqual(EMPIRES.map((id) => [reg.corporationFor(id, "mining"), reg.corporationFor(id, "logistics")]),
      [[1000005, 1000002], [1000055, 1000053], [1000098, 1000120]]);
  });

  test("T2 theatre: k3 connected (34 systems, ecc 15, defender 3 jumps), hole -> DISCONNECTED, extra -> DRIFT", () => {
    const reg = registry();
    const k3 = reg.getCampaign("k3-stain");
    const ok = validateCampaign(k3, reg, graphOf(), { maxJumps: 40 });
    assert.deepStrictEqual(ok, { ok: true, systems: 34, eccentricity: 15, defenderJumps: { 500003: 3 } });
    const hole = validateCampaign(k3, reg, graphOf({ dropEdge: [30001870, 30001893] }), { maxJumps: 40 });
    assert.deepStrictEqual([hole.ok, hole.reason], [false, "CAMPAIGN_DISCONNECTED"]);
    const extra = validateCampaign(k3, reg, graphOf({ extra: [system(30001999, 10000022, 20000276, "nullsec")] }),
      { maxJumps: 40 });
    assert.deepStrictEqual([extra.ok, extra.reason, extra.systemId], [false, "CAMPAIGN_CONSTELLATION_DRIFT", 30001999]);
  });

  test("R1 active vs passive: registry -> 13 active (invaders), list -> 2, passive / unknown id or too many -> "
    + "STRATEGY_ACTIVE_FACTIONS_INVALID, passive with a doctrine -> REGISTRY_INVALID, passive defaults, none -> "
    + "campaign CAMPAIGN_FACTION_INACTIVE", () => {
    const reg = registry();
    assert.deepStrictEqual([reg.isActive(500019), reg.isActive(500010), reg.isActive(500025), reg.isActive(1)],
      [true, true, false, false]);
    const two = createFactionRegistry(REGISTRY_DATA_V1, { ...CTX, activeFactionIds: [500003, 500019] });
    assert.ok(two.ok, JSON.stringify(two));
    assert.deepStrictEqual(two.registry.listActiveFactions().map((f) => f.factionId), [500003, 500019]);
    assert.deepStrictEqual([two.registry.version.activeCount, two.registry.isActive(500006)], [2, false]);

    const configOf = (env) => resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(), ...env } });
    const start = (env) => startStrategy({ config: configOf(env).config,
      persistence: { ok: true, store: {}, journal: {} }, clock: createManualClock(START_MS) });
    const refused = (detail) => ({ ok: false, reason: "STRATEGY_ACTIVE_FACTIONS_INVALID", detail });
    assert.deepStrictEqual(start({ EVEJS_LNE_STRATEGY_ACTIVE_FACTIONS: "500003,500025" }), refused("500025"));
    assert.deepStrictEqual(start({ EVEJS_LNE_STRATEGY_ACTIVE_FACTIONS: "500003,123" }), refused("123"));
    assert.deepStrictEqual(start({ EVEJS_LNE_STRATEGY_MAX_ACTIVE_FACTIONS: "3" }), refused("count=14 max=3"));
    const mixed = configOf({ EVEJS_LNE_STRATEGY_ACTIVE_FACTIONS: "registry,500003" });
    assert.deepStrictEqual([mixed.config.strategy.activeFactions, mixed.warnings.length], ["registry", 1]);

    const clone = (v) => JSON.parse(JSON.stringify(v));
    const mordu = REGISTRY_DATA_V1.factions.findIndex((f) => f.factionId === 500018);
    const playing = clone(REGISTRY_DATA_V1);
    playing.factions[mordu].doctrineId = "serpentis-territorial-v2";
    assert.deepStrictEqual(createFactionRegistry(playing, CTX), { ok: false, reason: "REGISTRY_INVALID",
      detail: `factions[${mordu}].doctrineId` });
    const passive = reg.getFaction(500018);
    assert.deepStrictEqual(passive, { factionId: 500018, kind: "neutral", activity: "passive",
      ownerCorporationId: 1000128, hqSystemId: passive.hqSystemId, homeRegionIds: [], doctrineId: null,
      maxActiveFronts: 0, initialResourceUnits: 0, initialReserveUnits: 0, allies: [], startStations: [],
      origin: passive.origin });
    const drifters = reg.getFaction(500024);
    assert.deepStrictEqual([drifters.kind, drifters.activity, drifters.requiresFlag, drifters.doctrineId,
      reg.isActive(500024)], ["invader", "active", "drifters", "drifter-invader-v1", false]);
    const drones = reg.getFaction(500025);
    assert.deepStrictEqual([drones.kind, drones.activity, drones.requiresFlag, drones.doctrineId,
      reg.isActive(500025)], ["hive", "active", "hive", "rogue-hive-v1", false]);

    const none = createFactionRegistry(REGISTRY_DATA_V1, { ...CTX, activeFactionIds: [] });
    assert.ok(none.ok, JSON.stringify(none));
    assert.deepStrictEqual(validateCampaign(none.registry.getCampaign("k3-stain"), none.registry, graphOf(),
      { maxJumps: 40 }), { ok: false, reason: "CAMPAIGN_FACTION_INACTIVE", detail: "faction 500019" });
  });

  test("GD5 galaxy-density: active factions x (strategy + mining + logistics fleet caps) + invasions "
    + "<= limits.maxVirtualFleets", () => {
    const { config: c } = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir() } });
    const active = registry().listActiveFactions().length;
    const perFaction = c.strategy.maxFleetsPerFaction + c.mining.maxFleetsPerFaction + c.logistics.maxFleetsPerFaction;
    const ceiling = active * perFaction + c.invasions.maxActive * c.fleets.maxFleetsPerOperation;
    assert.deepStrictEqual([active, perFaction, ceiling], [14, 46, 692]);
    assert.ok(ceiling <= c.limits.maxVirtualFleets, `${ceiling} > ${c.limits.maxVirtualFleets}`);
  });

  test("T3 no branch per id: lib/strategy/*.js (without data/) has no faction, system, corp or station id", () => {
    const dir = path.join(MOD_DIR, "lib", "strategy");
    const hits = [];
    for (const name of fs.readdirSync(dir).filter((n) => n.endsWith(".js"))) {
      const source = fs.readFileSync(path.join(dir, name), "utf8");
      const m = source.match(/\b(500\d{3}|300\d{5}|1000\d{3}|600\d{5})\b/g);
      if (m) hits.push(`${name}: ${m.join(",")}`);
    }
    assert.deepStrictEqual(hits, []);
  });

  needsDriver("T4 repository: create, change v2, duplicate, VERSION_CONFLICT, INSUFFICIENT_RESOURCES, restart", () =>
    withStore(driver, (reopen) => {
      const clock = createManualClock(START_MS);
      const journal = createJournal({ clock, maxPayloadBytes: 4096, maxRows: 500 });
      const repo = createFactionRepository({ journal,
        limits: { maxResourceUnits: 1000000000, maxFrontLimit: 2, maxListLimit: 64 } });
      const store = reopen();
      const created = tx(store, (db) => repo.createFaction(db, { factionId: 500019, status: "ACTIVE",
        homeSystemId: 30001868, doctrineId: "sansha-incursion-v1", resourceUnits: 10000, reserveUnits: 200,
        frontLimit: 2, registryVersion: 1, createdAt: START_MS, updatedAt: START_MS }, "strategy:test:create"));
      assert.strictEqual(created.ok, true, JSON.stringify(created));
      assert.strictEqual(created.record.version, 1);
      const change = { factionId: 500019, expectedVersion: 1, key: "strategy:test:spend:1", reason: "TEST_SPEND",
        at: START_MS + 10, deltas: { resourceUnits: -500 } };
      const first = tx(store, (db) => repo.applyFactionChange(db, change));
      assert.deepStrictEqual([first.ok, first.record.version, first.record.resourceUnits, first.record.updatedAt],
        [true, 2, 9500, START_MS + 10]);
      const again = tx(store, (db) => repo.applyFactionChange(db, { ...change, at: START_MS + 20 }));
      assert.deepStrictEqual(again, { ok: true, duplicate: true });
      const stale = tx(store, (db) => repo.applyFactionChange(db, { ...change, key: "strategy:test:spend:2",
        deltas: { resourceUnits: -1 } }));
      assert.deepStrictEqual([stale.ok, stale.reason], [false, "VERSION_CONFLICT"]);
      const before = journalRows(store);
      const broke = tx(store, (db) => repo.applyFactionChange(db, { ...change, expectedVersion: 2,
        key: "strategy:test:spend:3", deltas: { resourceUnits: -9501 } }));
      assert.deepStrictEqual([broke.ok, broke.reason], [false, "INSUFFICIENT_RESOURCES"]);
      assert.strictEqual(journalRows(store), before, "no key for a refusal");
      assert.strictEqual(tx(store, (db) => repo.isApplied(db, "strategy:test:spend:3")).applied, false);
      const record = tx(store, (db) => repo.getFaction(db, 500019)).record;
      assert.strictEqual(record.resourceUnits, 9500);
      store.close("restart");
      const reopened = reopen();
      assert.deepStrictEqual(tx(reopened, (db) => repo.getFaction(db, 500019)).record, record);
    }));

  needsDriver("T5 seed + service: 13 created (invaders), restart with budgetFactor 2 -> 13 existing, disabled, hole in "
    + "theatre",
    () => withStore(driver, async (reopen) => {
      const clock = createManualClock(START_MS);
      const configOf = (env) => {
        const r = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(), ...env } });
        assert.deepStrictEqual(r.warnings, []);
        return r.config;
      };
      const graphService = (opts) => {
        const graph = graphOf(opts);
        return { whenReady: () => Promise.resolve({ ok: true, graph }), getGraph: () => ({ ok: true, graph }) };
      };
      const boot = (store, config, opts) => {
        const journal = createJournal({ clock, maxPayloadBytes: 4096, maxRows: 500 });
        const views = createViewRegistry();
        const lines = [];
        const r = startStrategy({ config, persistence: { ok: true, store, journal }, clock, views,
          graph: graphService(opts), logger: { log: (l) => lines.push(l) } });
        return { r, views, lines };
      };

      const store = reopen();
      const off = boot(store, configOf({ EVEJS_LNE_STRATEGY_ENABLED: "0", EVEJS_LNE_FLEETS_REFIT_POLICY: "anywhere",
        EVEJS_LNE_TREASURY_ENABLED: "0" }));
      assert.deepStrictEqual(off.r, { ok: false, reason: "STRATEGY_DISABLED" });
      assert.deepStrictEqual(factionRows(store), []);
      const first = boot(store, configOf({}));
      assert.ok(first.r.ok, JSON.stringify(first.r));
      const st = await first.r.strategy.whenReady();
      assert.deepStrictEqual([st.state, st.seed.created, st.seed.existing, st.seed.orphans], ["running", 14, 0, 0]);
      assert.ok(first.lines.includes("strategy: running factions=27 active=14 created=14 existing=0 orphans=0 "
        + "campaigns=k3-stain(34 systems, ecc 15)"), first.lines.join("\n"));
      const rows = factionRows(store);
      assert.deepStrictEqual(rows.map((r) => [r.faction_id, r.resource_units, r.front_limit]),
        [[500001, 20000, 6], [500002, 20000, 6], [500003, 20000, 6], [500004, 20000, 6], [500006, 1000, 2],
          [500010, 8000, 6], [500011, 8000, 6], [500012, 8000, 6], [500016, 8000, 6], [500019, 10000, 6],
          [500020, 8000, 6],
          [500021, 3000, 0], [500026, 6000, 1], [500029, 4000, 1]]);
      const k3 = first.r.strategy.getCampaign("k3-stain");
      assert.deepStrictEqual([k3.ok, k3.check.eccentricity], [true, 15]);
      first.r.strategy.stop("test");
      const journalAfterSeed = journalRows(store);

      const second = boot(store, configOf({ EVEJS_LNE_STRATEGY_BUDGET_FACTOR: "2" }));
      const st2 = await second.r.strategy.whenReady();
      assert.deepStrictEqual([st2.seed.created, st2.seed.existing], [0, 14]);
      assert.deepStrictEqual(factionRows(store), rows);
      assert.strictEqual(journalRows(store), journalAfterSeed);
      second.r.strategy.stop("test");

      const holed = boot(store, configOf({}), { dropEdge: [30001870, 30001893] });
      await holed.r.strategy.whenReady();
      assert.deepStrictEqual(holed.r.strategy.getCampaign("k3-stain"),
        { ok: false, reason: "CAMPAIGN_DISCONNECTED", systemId: 30001893 });
      assert.strictEqual(holed.r.strategy.getStatus().state, "running");
      assert.ok(holed.lines.includes("strategy: campaign k3-stain invalid CAMPAIGN_DISCONNECTED 30001893"),
        holed.lines.join("\n"));
      holed.r.strategy.stop("test");
    }));
};
