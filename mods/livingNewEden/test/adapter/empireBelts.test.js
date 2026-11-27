"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const { classifyHull, selectNavyProfiles, decideNavy, buildNavyDefinitions, isBeltNavyVictim, isSpecialSelection,
  wrapBeltSpawnForNavy, WRAPPED_EMPIRE_BELTS, SELECTION_PREFIX } = require("../../lib/adapter/empireBelts");
const { NAVY_PROFILES_BY_FACTION_ID, HULL_CLASSES } = require("../../lib/adapter/empireNavyCatalog");
const { selectNavyTable } = require("../../lib/adapter/factionProfiles");
const { createAdapter } = require("../../lib/adapter");
const { findServerSrcOnDisk } = require("../../lib/adapter/locator");
const { buildHooks, installModuleHook } = require("../../loader");
const { isMetricName } = require("../../lib/telemetry/registry");
const { npcSetupTables } = require("../_support/setupTables");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SERVER_SEARCH_MAX_DEPTH = 5;
const AMARR = 500003;
const SANSHA = 500019;
const SERPENTIS = 500020;
const SOE = 500016;
const NAVY_PREFIX = "parity_faction_warfare_entities_";
const NAVY_PLACEHOLDER_LOOT = "parity_faction_warfare_entities_pending_loot";
const PIRATE_BOUNTY = 12345;

const SYS_AMARR_NULL = 30000201;
const SYS_SANSHA_NULL = 30000202;
const SYS_AMARR_HIGH = 30000203;
const SYSTEMS = Object.freeze({
  [SYS_AMARR_NULL]: { solarSystemID: SYS_AMARR_NULL, factionID: SERPENTIS, regionID: 0, securityStatus: -0.5 },
  [SYS_SANSHA_NULL]: { solarSystemID: SYS_SANSHA_NULL, factionID: SERPENTIS, regionID: 0, securityStatus: -0.5 },
  [SYS_AMARR_HIGH]: { solarSystemID: SYS_AMARR_HIGH, factionID: SERPENTIS, regionID: 0, securityStatus: 0.9 },
});
const BELT_ID = 40000001;

function findSrcDir() {
  const found = findServerSrcOnDisk(MOD_DIR, SERVER_SEARCH_MAX_DEPTH, fs.existsSync);
  return found.ok ? found.srcDir : null;
}

function spyLogger() {
  const lines = { log: [], error: [], debug: [] };
  return { lines, log: (m) => lines.log.push(m), logError: (m) => lines.error.push(m),
    debug: (m) => lines.debug.push(m) };
}

function okConfig(world = {}, worldModule = {}) {
  return { ok: true, sources: {}, warnings: [], errors: [], config: { enabled: true, debug: false,
    modules: { world: { enabled: true, ...worldModule } },
    world: { projectionEnabled: true, empireBeltsEnabled: true, empireNavyFactions: "500001,500002,500003,500004",
      ...world } } };
}

function fakeModule(file, exports) {
  const m = new Module(file);
  m.filename = file;
  m.loaded = true;
  m.exports = exports;
  return m;
}

function seededRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function fakeNpcData() {
  const slug = (q) => String(q).trim().toLowerCase().replace(/\s+/g, "_");
  const buildNpcDefinition = (id) => {
    const profile = { profileID: id, name: String(id).replace(/_/g, " ") };
    if (String(id).startsWith(NAVY_PREFIX)) {
      return { profile: { ...profile, factionID: 0, bounty: 0, lootTableID: NAVY_PLACEHOLDER_LOOT },
        lootTable: { lootTableID: NAVY_PLACEHOLDER_LOOT } };
    }
    return { profile: { ...profile, bounty: PIRATE_BOUNTY }, lootTable: { lootTableID: `loot_${id}` } };
  };
  return {
    buildNpcDefinition,
    getNpcProfile: (id) => ({ profileID: id }),
    resolveNpcSpawnPool: (query) => ({ success: true, data: { spawnPoolID: slug(query),
      entries: HULL_CLASSES.map((h) => ({ profileID: `${slug(query)}_${h}`, weight: 1 })) } }),
  };
}

function hullOfProfileId(id) {
  return [...HULL_CLASSES].sort((a, b) => b.length - a.length).find((h) => id.endsWith(`_${h}`)) || null;
}

function withRealChain(src, opts, fn) {
  const { config = okConfig(), controllers = new Map(), adapter, telemetry = null, worldThrows = false,
    lootless = false, beltConfig = {}, beltNavyRoll = null, beltNavy = null, clock = null } = opts;
  const fullNpcData = fakeNpcData();
  const npcData = lootless ? { ...fullNpcData, buildNpcDefinition: (id) => ({ ...fullNpcData.buildNpcDefinition(id),
    lootTable: null }) } : fullNpcData;
  const at = (...p) => require.resolve(path.join(src, ...p));
  const fakes = new Map([
    [at("config"), { asteroidBeltNpcRatsEnabled: true, asteroidBeltNpcRatNullSecChance: 1,
      asteroidBeltNpcRatHighSecChance: 1, asteroidBeltNpcRatCommanderChance: 1,
      asteroidBeltNpcRatRollCooldownMs: 0, asteroidBeltNpcRatRespawnCooldownMs: 0, ...beltConfig }],
    [at("utils", "logger"), { info() {}, warn() {}, error() {}, debug() {}, log() {} }],
    [at("space", "worldData"), { getSolarSystemByID: (id) => SYSTEMS[id] || null }],
    [at("space", "npc", "npcData"), npcData],
    [at("space", "npc", "npcHullDamageability"), { npcProfileHasDamageableHull: () => true }],
    [at("space", "entityConstants"), { ENTITY_TYPE: { NPC: "npc" } }],
  ]);
  const policyFile = at("space", "npc", "pirateFactionPolicy");
  const beltFile = at("space", "npc", "beltRatRuntime");
  const reals = [at("common", "numbers"), policyFile, beltFile];
  const touched = [...fakes.keys(), ...reals];
  const previous = new Map(touched.map((key) => [key, require.cache[key]]));
  const originalLoad = Module._load;
  const logger = spyLogger();
  const world = { getController: (id) => {
    if (worldThrows) throw new Error("db gone");
    return { ok: true, controllerFactionId: controllers.has(id) ? controllers.get(id) : null };
  } };
  const defaultAdapter = { getNpcSpawnTools: () => ({ ok: true, buildNpcDefinition: npcData.buildNpcDefinition,
    spawnNativeDefinitionsInContext: () => { throw new Error("default spawner not expected in tests"); } }) };
  const ctx = { logger, loadConfig: () => config, world, telemetry, beltNavyRoll, beltNavy, clock,
    adapter: adapter === undefined ? defaultAdapter : adapter,
    state: { configResult: null, projection: null, projectionFailureLogged: false, empireBelts: null,
      empireBeltsFailureLogged: false, empireBeltsFallbackLogged: false } };
  try {
    for (const [file, exports] of fakes) require.cache[file] = fakeModule(file, exports);
    for (const file of reals) delete require.cache[file];
    installModuleHook(Module, buildHooks(ctx)
      .filter((h) => h.name === "pirateFactionProjection" || h.name === "empireBeltNavy"), logger);
    const belt = require(beltFile);
    const arrive = (systemID, extraOptions = {}) => {
      belt._testing.configureForTests({ randomProvider: seededRandom(7) });
      const calls = [];
      const spy = (context, selectionResult, spawnOptions) => {
        calls.push({ context, selectionResult, spawnOptions });
        return { success: true, data: { spawned: [] } };
      };
      const beltEntity = { itemID: BELT_ID, kind: "asteroidBelt", position: { x: 0, y: 0, z: 0 }, radius: 0 };
      const scene = { systemID, staticEntities: [beltEntity], dynamicEntities: new Map(),
        getEntityByID: (id) => (id === BELT_ID ? beltEntity : null) };
      const session = { _space: { shipID: 9 } };
      const ship = { itemID: 9, position: { x: 0, y: 0, z: 0 } };
      const input = { nowMs: 1000, broadcast: false, targetEntityID: BELT_ID, spawnNativeDefinitionsInContext: spy,
        ...extraOptions };
      const result = belt.maybeSpawnForSessionArrival(scene, session, ship, input);
      return { result, calls, spy, input };
    };
    return fn({ belt, ctx, logger, arrive, controllers });
  } finally {
    Module._load = originalLoad;
    for (const key of touched) {
      delete require.cache[key];
      if (previous.get(key)) require.cache[key] = previous.get(key);
    }
  }
}

const profileIds = (call) => call.selectionResult.data.definitions.map((d) => d.profile.profileID);

module.exports = ({ test, skip }) => {
  const src = findSrcDir();
  const setup = npcSetupTables();
  const haveData = setup.ok;

  const e1 = "E1 empire belts vendor facts: live entry read from exports, vendor options, frozen pool keys, navy profiles";
  if (!src) skip(e1, "EveJS server/src not found above the mod");
  else {
    test(e1, () => {
      const read = (...p) => fs.readFileSync(path.join(src, ...p), "utf8");
      const sessions = read("space", "runtime", "scene", "sessions.js");
      const tick = read("space", "runtime", "scene", "tick.js");
      const belt = read("space", "npc", "beltRatRuntime.js");
      assert.ok(sessions.includes("beltRatRuntime.maybeSpawnForSessionArrival("), "sessions.js calls via the module");
      assert.ok(!/\{[^}]*\bmaybeSpawnForSessionArrival\b[^}]*\}\s*=/.test(sessions), "not destructured");
      const arrivals = (sessions.match(/this\.maybeSpawnAsteroidBeltRatsForArrival\(/g) || []).length
        + (tick.match(/this\.maybeSpawnAsteroidBeltRatsForArrival\(/g) || []).length;
      assert.strictEqual(arrivals, 3, "attachSession, attachSessionToExistingEntity, warpCompleted");
      assert.ok(belt.includes("options.skipSpecialSpawns === true"), "skipSpecialSpawns option");
      assert.ok(belt.includes("typeof options.spawnNativeDefinitionsInContext === \"function\""), "spawner option");
      assert.ok(belt.includes("STANDARD_POOL_QUERY_BY_FACTION = Object.freeze("), "pool keys frozen");
      assert.strictEqual(require(path.join(src, "space", "entityConstants")).ENTITY_TYPE.NPC, "npc");
      if (!haveData) return;
      const profiles = new Map(setup.tables.npcProfiles.profiles.map((p) => [p.profileID, p]));
      const behaviors = new Set(setup.tables.npcBehaviorProfiles.behaviorProfiles.map((b) => b.behaviorProfileID));
      let checked = 0;
      for (const [factionId, byHull] of Object.entries(NAVY_PROFILES_BY_FACTION_ID)) {
        for (const hull of HULL_CLASSES) {
          const id = byHull[hull];
          const row = profiles.get(id);
          assert.ok(row, `${factionId} ${hull}: ${id} exists`);
          assert.strictEqual(row.shipTypeID, Number(id.slice(NAVY_PREFIX.length).split("_")[0]), id);
          assert.strictEqual(row.entityType, "npc", id);
          assert.strictEqual(classifyHull({ profile: row }), hull, id);
          assert.ok(behaviors.has(row.behaviorProfileID), `${id}: behavior ${row.behaviorProfileID}`);
          checked += 1;
        }
      }
      assert.strictEqual(checked, 20);
    });
  }
  if (src && !haveData) skip("E1 data part", setup.reason);

  test("E2 empire belts pure logic: decideNavy matrix, classifyHull, buildNavyDefinitions, selectNavyProfiles", () => {
    const reads = [];
    const controllers = new Map([[1, AMARR], [2, SANSHA], [3, null]]);
    const deps = (over = {}) => ({
      navyProfiles: NAVY_PROFILES_BY_FACTION_ID,
      resolveSecurityProfile: (id) => ({ band: id === 9 ? "highsec" : "nullsec" }),
      readController: (id) => { reads.push(id); return { ok: true, controllerFactionId: controllers.get(id) }; },
      ...over,
    });
    assert.strictEqual(decideNavy(1, { factionKey: "angels" }, deps()).reason, "EXPLICIT_OVERRIDE");
    assert.strictEqual(decideNavy(1, { forceSpecialSpawnKind: "officer" }, deps()).reason, "EXPLICIT_OVERRIDE");
    assert.strictEqual(decideNavy("abc", {}, deps()).reason, "BAD_SYSTEM_ID");
    assert.strictEqual(decideNavy(9, {}, deps()).reason, "NOT_NULLSEC");
    assert.deepStrictEqual(reads, [], "no controller read before the band filter");
    assert.strictEqual(decideNavy(2, {}, deps()).reason, "NOT_EMPIRE");
    assert.strictEqual(decideNavy(3, undefined, deps()).reason, "NO_CONTROLLER");
    assert.strictEqual(decideNavy(1, {}, deps({ readController: () => ({ ok: false, reason: "TX_ACTIVE" }) })).reason,
      "READ_TX_ACTIVE");
    const navy = decideNavy(1, {}, deps());
    assert.deepStrictEqual([navy.reason, navy.factionId, navy.navy], ["CONTROLLER_NAVY", AMARR,
      NAVY_PROFILES_BY_FACTION_ID[AMARR]]);

    assert.strictEqual(classifyHull({ profile: { name: "Serpentis Battlecruiser" } }), "battlecruiser");
    assert.strictEqual(classifyHull({ profile: { name: "Serpentis Cruiser" } }), "cruiser");
    assert.strictEqual(classifyHull({ profile: { profileID: "x", name: "Sansha's Beast", shipNameTemplate: "Sansha's Beast",
      sourceProfileName: "Sansha Pulse Cruiser" } }), "cruiser");
    assert.strictEqual(classifyHull({ profile: { name: "Something" } }), null);

    const build = (id) => ({ profile: { profileID: id } });
    const defs = [{ profile: { name: "a battleship" } }, { profile: { name: "a frigate" } }];
    const ok = buildNavyDefinitions(defs, NAVY_PROFILES_BY_FACTION_ID[AMARR], build);
    assert.deepStrictEqual(ok.profileIds, [NAVY_PROFILES_BY_FACTION_ID[AMARR].battleship,
      NAVY_PROFILES_BY_FACTION_ID[AMARR].frigate]);
    assert.strictEqual(buildNavyDefinitions([...defs, { profile: { name: "?" } }],
      NAVY_PROFILES_BY_FACTION_ID[AMARR], build).reason, "HULL_UNKNOWN");
    assert.strictEqual(buildNavyDefinitions(defs, NAVY_PROFILES_BY_FACTION_ID[AMARR], () => null).reason,
      "DEFINITION_MISSING");
    assert.strictEqual(buildNavyDefinitions([], NAVY_PROFILES_BY_FACTION_ID[AMARR], build).reason, "EMPTY");

    assert.deepStrictEqual(Object.keys(selectNavyProfiles("500003,999")), ["500003"]);
    assert.strictEqual(selectNavyProfiles(""), NAVY_PROFILES_BY_FACTION_ID);

    const seen = [];
    const original = function vendor() { seen.push({ self: this, n: arguments.length }); return "vendor"; };
    const wrap = wrapBeltSpawnForNavy(original, { ...deps(), getNpcSpawnTools: () => ({ ok: false }) });
    assert.strictEqual(wrap.ok, true);
    const self = { tag: "exports" };
    assert.strictEqual(wrap.wrapped.call(self, { systemID: 2 }, {}, {}), "vendor");
    assert.deepStrictEqual(seen, [{ self, n: 3 }]);
    assert.strictEqual(wrapBeltSpawnForNavy(wrap.wrapped, deps()).noop, true);
    assert.strictEqual(wrapBeltSpawnForNavy(original, { ...deps() }).reason, "SPAWN_TOOLS_NOT_A_FUNCTION");
    assert.strictEqual(wrapBeltSpawnForNavy(null, {}).reason, "NOT_A_FUNCTION");
  });

  test("EBR1 belt navy rewards: bounty x multiplier, pirate loot, empire faction, group of two hulls, victim filter", () => {
    const navy = NAVY_PROFILES_BY_FACTION_ID[AMARR];
    const build = fakeNpcData().buildNpcDefinition;
    const lootA = { lootTableID: "loot_a" };
    const lootB = { lootTableID: "loot_b" };
    const pirates = [{ profile: { name: "a battleship", bounty: 1000 }, lootTable: lootA },
      { profile: { name: "a frigate", bounty: 333 }, lootTable: lootB }];
    const resolved = [];
    const rewards = { factionId: AMARR, bountyMultiplier: 1.1,
      resolveBounty: (def) => { resolved.push(def); return def.profile.bounty; } };
    const built = buildNavyDefinitions(pirates, navy, build, rewards);
    assert.strictEqual(built.ok, true, JSON.stringify(built));
    assert.deepStrictEqual(resolved, pirates, "the reader gets the pirate definition");
    assert.deepStrictEqual(built.profileIds, [navy.battleship, navy.frigate]);
    assert.deepStrictEqual(built.definitions.map((d) => [d.profile.profileID, d.profile.bounty, d.profile.factionID,
      d.profile.lootTableID, d.lootTable.lootTableID]), [
      [navy.battleship, 1100, AMARR, "loot_a", "loot_a"],
      [navy.frigate, 366, AMARR, "loot_b", "loot_b"],
    ]);
    assert.strictEqual(build(navy.frigate).profile.bounty, 0, "the builder's own result is not touched");

    assert.strictEqual(SELECTION_PREFIX, "belt_navy");
    assert.strictEqual(isBeltNavyVictim({ selectionID: `belt_navy:${AMARR}:belt_rat:x` }), true);
    assert.strictEqual(isBeltNavyVictim({ selectionID: "belt_rat:angels:nullsec" }), false);
    assert.strictEqual(isBeltNavyVictim({ selectionID: "belt_navy_other:1" }), false);
    assert.strictEqual(isBeltNavyVictim({}), false);
    assert.strictEqual(isBeltNavyVictim(null), false);
  });

  test("EBR1a getNpcSpawnTools reads the bounty through buildNpcEntityIdentity; no reader without npcPresentation", () => {
    const srcDir = path.join(path.sep, "x", "server", "src");
    const gameModules = ["space/npc/npcData", "space/npc/nativeNpcService", "space/npc/npcPresentation"]
      .map((p) => ({ path: p, symbols: [] }));
    const entry = (rel, exports) => [path.join(srcDir, `${rel}.js`), { exports }];
    const base = [entry("space/npc/npcData", { buildNpcDefinition() {} }),
      entry("space/npc/nativeNpcService", { spawnNativeDefinitionsInContext() {} })];
    const seen = [];
    const identity = (definition, shipLike) => { seen.push([definition, shipLike]); return { bounty: 4321 }; };
    const toolsOf = (entries) => {
      const adapter = createAdapter({ moduleApi: { _cache: Object.fromEntries(entries) }, gameModules,
        existsSync: () => false });
      adapter.setServerSrc(srcDir);
      adapter.markBooted();
      return adapter.getNpcSpawnTools();
    };
    const definition = { profile: {} };
    const tools = toolsOf([...base, entry("space/npc/npcPresentation", { buildNpcEntityIdentity: identity })]);
    assert.strictEqual(tools.resolveNpcBounty(definition), 4321);
    assert.deepStrictEqual(seen, [[definition, {}]]);
    const noReader = toolsOf(base);
    assert.strictEqual(noReader.ok, true, "the spawn tools stay usable with rewards off");
    assert.strictEqual(noReader.resolveNpcBounty, undefined);
  });

  test("EBR2 belt navy rewards off: the definition stays bit in bit", () => {
    const navy = NAVY_PROFILES_BY_FACTION_ID[AMARR];
    const build = fakeNpcData().buildNpcDefinition;
    const pirates = [{ profile: { name: "a cruiser", bounty: 1000 }, lootTable: { lootTableID: "loot_a" } }];
    const untouched = build(navy.cruiser);
    for (const rewards of [null, undefined]) {
      const built = buildNavyDefinitions(pirates, navy, build, rewards);
      assert.deepStrictEqual(built, { ok: true, definitions: [untouched], profileIds: [navy.cruiser] });
    }
    const same = { profile: { profileID: navy.cruiser } };
    assert.strictEqual(buildNavyDefinitions(pirates, navy, () => same, null).definitions[0], same);
  });

  test("EBR3 belt navy rewards refusals: unresolved bounty or loot of any ship refuses the whole group", () => {
    const navy = NAVY_PROFILES_BY_FACTION_ID[AMARR];
    const build = fakeNpcData().buildNpcDefinition;
    const good = { profile: { name: "a battleship" }, lootTable: { lootTableID: "loot_a" } };
    const noLoot = { profile: { name: "a frigate" }, lootTable: null };
    const reasonFor = (defs, resolveBounty, bountyMultiplier = 1.1) => buildNavyDefinitions(defs, navy, build,
      { factionId: AMARR, bountyMultiplier, resolveBounty }).reason;
    for (const bad of [0, -5, NaN, undefined, null, Infinity]) {
      assert.strictEqual(reasonFor([good], () => bad), "BOUNTY_UNRESOLVED", String(bad));
    }
    assert.strictEqual(reasonFor([good], () => 1, 0.1), "BOUNTY_UNRESOLVED", "rounded to 0: vendor hull fallback");
    assert.strictEqual(reasonFor([good, noLoot], () => 100), "LOOT_UNRESOLVED");
    assert.strictEqual(reasonFor([good, { ...good, lootTable: {} }], () => 100), "LOOT_UNRESOLVED");
  });

  test("EBR6 belt navy share: pirates bit in bit, specials skip the roll, flag off, refusals -> pirates + fallback", () => {
    const npcData = fakeNpcData();
    const NORMAL = "belt_rat:serpentis:nullsec";
    assert.strictEqual(isSpecialSelection(NORMAL), false);
    assert.strictEqual(isSpecialSelection(`${NORMAL}:commander`), true);
    assert.strictEqual(isSpecialSelection("belt_navy:500003:belt_rat:x:y"), false);
    assert.strictEqual(isSpecialSelection(undefined), false);
    const run = (over, selectionID = NORMAL) => {
      const outcomes = [];
      const spawned = [];
      const rolls = [];
      const own = (context, selectionResult, spawnOptions) => {
        spawned.push({ context, selectionResult, spawnOptions });
        return { success: true };
      };
      const selection = { success: true, data: { selectionID, selectionName: "n",
        definitions: [{ profile: { name: "a cruiser" }, lootTable: { lootTableID: "loot_a" } }] } };
      const given = {};
      const original = (_scene, _session, _ship, options) => {
        given.options = options;
        options.spawnNativeDefinitionsInContext({ tag: "context" }, selection,
          { ...options, spawnSiteID: "7:8:1", selectionID });
        return "vendor result";
      };
      const wrap = wrapBeltSpawnForNavy(original, { navyProfiles: NAVY_PROFILES_BY_FACTION_ID,
        resolveSecurityProfile: () => ({ band: "nullsec" }),
        readController: () => ({ ok: true, controllerFactionId: AMARR }),
        getNpcSpawnTools: () => ({ ok: true, buildNpcDefinition: npcData.buildNpcDefinition,
          spawnNativeDefinitionsInContext: own }),
        shareEnabled: true, nowMs: () => 42, onOutcome: (outcome, reason) => outcomes.push([outcome, reason]),
        decideSpawn: (input) => { rolls.push(input); return { ok: true, navy: false, share: 0.5, unit: 0.9 }; }, ...over });
      assert.strictEqual(wrap.wrapped({ systemID: 7 }, {}, {}, {}), "vendor result");
      return { outcomes, spawned, rolls, selection, given };
    };
    const untouched = (r) => {
      assert.strictEqual(r.spawned.length, 1);
      assert.strictEqual(r.spawned[0].selectionResult, r.selection, "the original selection, bit in bit");
      assert.strictEqual(r.spawned[0].spawnOptions.spawnNativeDefinitionsInContext, undefined);
    };

    const pirates = run({});
    untouched(pirates);
    assert.deepStrictEqual(pirates.rolls, [{ systemId: 7, factionId: AMARR, spawnSiteId: "7:8:1", atMs: 42 }]);
    assert.deepStrictEqual(pirates.outcomes, [["pirates", "ROLL"]]);
    assert.strictEqual(pirates.given.options.skipSpecialSpawns, undefined, "specials stay possible");

    const navy = run({ decideSpawn: () => ({ ok: true, navy: true, share: 0.5, unit: 0.1 }) });
    assert.deepStrictEqual(navy.spawned[0].selectionResult.data.definitions.map((d) => d.profile.profileID),
      [NAVY_PROFILES_BY_FACTION_ID[AMARR].cruiser]);
    assert.deepStrictEqual(navy.outcomes, [["navy", "CONTROLLER_NAVY"]]);

    const special = run({}, `${NORMAL}:hauler`);
    untouched(special);
    assert.deepStrictEqual(special.rolls, [], "no roll for a special spawn");
    assert.deepStrictEqual(special.outcomes, [["pirates", "SPECIAL"]]);

    const off = run({ shareEnabled: false });
    assert.deepStrictEqual(off.rolls, [], "flag off: no roll");
    assert.strictEqual(off.given.options.skipSpecialSpawns, true);
    assert.deepStrictEqual(off.outcomes, [["navy", "CONTROLLER_NAVY"]]);

    const failures = [
      [{ decideSpawn: () => { throw new Error("boom"); } }, "FAILED"],
      [{ nowMs: () => { throw new Error("boom"); } }, "FAILED"],
      [{ decideSpawn: () => ({ ok: false, reason: "CONTROL_CHANGED" }) }, "ROLL_CONTROL_CHANGED"],
      [{ decideSpawn: () => null }, "ROLL_NO_RESULT"],
      [{ decideSpawn: undefined }, "ROLL_UNAVAILABLE"],
    ];
    for (const [over, reason] of failures) {
      const r = run(over);
      untouched(r);
      assert.deepStrictEqual(r.outcomes, [["fallback", reason]]);
    }

    const noScore = run({ decideSpawn: () => ({ ok: false, reason: "NO_SCORE" }) });
    untouched(noScore);
    assert.deepStrictEqual(noScore.outcomes, [["noScore", "ROLL_NO_SCORE"]]);
  });

  test("EBR8 belt navy aggression: passive options, target 0 in options and context, group registered, no sink -> pirates", () => {
    const npcData = fakeNpcData();
    const selection = { success: true, data: { selectionID: "belt_rat:serpentis:nullsec", selectionName: "n",
      definitions: [{ profile: { name: "a cruiser" }, lootTable: { lootTableID: "loot_a" } }] } };
    const spawnResult = { success: true, data: { spawned: [{ entity: { itemID: 501 } }, { entity: { itemID: 502 } }] } };
    const run = (over, result = spawnResult) => {
      const outcomes = [];
      const spawned = [];
      const own = (context, selectionResult, spawnOptions) => {
        spawned.push({ context, selectionResult, spawnOptions });
        return result;
      };
      const original = (_scene, _session, _ship, options) => options.spawnNativeDefinitionsInContext(
        { preferredTargetID: 9, tag: "context" }, selection, { ...options, spawnSiteID: "7:8:1", preferredTargetID: 9 });
      const wrap = wrapBeltSpawnForNavy(original, { navyProfiles: NAVY_PROFILES_BY_FACTION_ID,
        resolveSecurityProfile: () => ({ band: "nullsec" }),
        readController: () => ({ ok: true, controllerFactionId: AMARR }),
        getNpcSpawnTools: () => ({ ok: true, buildNpcDefinition: npcData.buildNpcDefinition,
          spawnNativeDefinitionsInContext: own }),
        nowMs: () => 42, onOutcome: (outcome, reason) => outcomes.push([outcome, reason]),
        standingAggroEnabled: true, ...over });
      wrap.wrapped({ systemID: 7 }, {}, {}, {});
      return { outcomes, spawned };
    };
    const groups = [];
    const sink = { canAccept: () => true, registerGroup: (group) => { groups.push(group); return { ok: true }; } };

    const passive = run({ getAggroSink: () => sink });
    assert.deepStrictEqual(passive.spawned[0].spawnOptions.behaviorOverrides,
      { autoAggro: false, proximityAggroRangeMeters: 0 });
    assert.strictEqual(passive.spawned[0].spawnOptions.preferredTargetID, 0);
    assert.strictEqual(passive.spawned[0].context.preferredTargetID, 0);
    assert.strictEqual(passive.spawned[0].context.tag, "context");
    assert.ok(passive.spawned[0].selectionResult.data.selectionID.startsWith("belt_navy:"));
    assert.deepStrictEqual(groups, [{ spawnSiteId: "7:8:1", factionId: AMARR, entityIds: [501, 502], systemId: 7, atMs: 42 }]);
    assert.deepStrictEqual(passive.outcomes, [["navy", "CONTROLLER_NAVY"]]);

    groups.length = 0;
    const off = run({ standingAggroEnabled: false, getAggroSink: () => sink });
    assert.strictEqual(off.spawned[0].spawnOptions.behaviorOverrides, undefined, "flag off: the vendor's aggression");
    assert.strictEqual(off.spawned[0].spawnOptions.preferredTargetID, 9);
    assert.strictEqual(off.spawned[0].context.preferredTargetID, 9);
    assert.deepStrictEqual(groups, []);

    const refused = [{ getAggroSink: () => null }, { getAggroSink: undefined },
      { getAggroSink: () => ({ canAccept: () => false }) }, { getAggroSink: () => { throw new Error("boom"); } }];
    for (const over of refused) {
      const r = run(over);
      assert.strictEqual(r.spawned[0].selectionResult, selection, "the original selection, bit in bit");
      assert.strictEqual(r.spawned[0].spawnOptions.preferredTargetID, 9);
      assert.strictEqual(r.spawned[0].context.preferredTargetID, 9);
      assert.deepStrictEqual(r.outcomes, [["fallback", "AGGRO_UNAVAILABLE"]]);
    }

    const failed = run({ getAggroSink: () => sink }, { success: false, errorMsg: "NOPE" });
    assert.deepStrictEqual(groups, [], "a failed spawn registers nothing");
    assert.deepStrictEqual(failed.outcomes, [["failed", "SPAWN_NOPE"]]);

    const lost = run({ getAggroSink: () => ({ canAccept: () => true, registerGroup: () => ({ ok: false, reason: "DUPLICATE" }) }) });
    assert.deepStrictEqual(lost.outcomes, [["navy", "CONTROLLER_NAVY"], ["failed", "AGGRO_DUPLICATE"]]);
    const thrown = run({ getAggroSink: () => ({ canAccept: () => true, registerGroup() { throw new Error("boom"); } }) });
    assert.deepStrictEqual(thrown.outcomes, [["navy", "CONTROLLER_NAVY"], ["failed", "AGGRO_FAILED"]]);
  });

  const ebr7 = "EBR7 belt navy share on the real chain: real selection ids and spawnSiteID, navy, pirates, no service";
  const ebr9 = "EBR9 belt navy aggression on the real chain: vendor target zeroed, group registered, no service -> pirates";
  const ebr10 = "EBR10 belt navy aggression facts: passive branch, resume, rematerialization, aggression notes, spawn options";
  const e3 = "E3 empire belts on the real require chain: Amarr nullsec -> navy same hulls, Sansha -> pirates, highsec -> vendor";
  const e4 = "E4 empire belts real chain: flag off -> no wrap; no tools / throwing read / missing definition -> pirates";
  const ebr4 = "EBR4 belt navy rewards on the real chain: spawned navy has pirate rewards, failures -> pirates + fallback";
  const ebr5 = "EBR5 belt navy reward facts: identity bounty and faction, loot table, entity selectionID in the vendor source";
  const sbp5 = "SBP5 belt patrol through the empireBeltNavy hook (real chain, patrol flag on): SoE nullsec -> SoE profiles "
    + "of the vendor hulls, outcome patrol; flag off -> the vendor's rats";
  if (!src) {
    skip(sbp5, "EveJS server/src not found above the mod");
    skip(e3, "EveJS server/src not found above the mod");
    skip(e4, "EveJS server/src not found above the mod");
    skip(ebr4, "EveJS server/src not found above the mod");
    skip(ebr5, "EveJS server/src not found above the mod");
    skip(ebr7, "EveJS server/src not found above the mod");
    skip(ebr9, "EveJS server/src not found above the mod");
    skip(ebr10, "EveJS server/src not found above the mod");
    return;
  }

  test(ebr7, () => {
    const NOW = 1793000000000;
    const controllers = new Map([[SYS_AMARR_NULL, AMARR]]);
    const shareConfig = okConfig({ beltNavy: { shareEnabled: true } });
    const run = (opts, check) => {
      const counts = [];
      const inputs = [];
      const telemetry = { hooks: { onCount: (name) => { assert.ok(isMetricName(name), name);
        if (name.startsWith("world.empireBelts.")) counts.push(name); } } };
      const roll = opts.navy === undefined ? null : { decide: (input) => { inputs.push(input);
        return { ok: true, navy: opts.navy, share: 0.5, unit: 0.5 }; } };
      withRealChain(src, { controllers, telemetry, config: shareConfig, beltNavyRoll: roll, clock: { now: () => NOW },
        ...opts.chain }, (h) => check({ ...h, counts, inputs }));
    };
    const normal = { chain: { beltConfig: { asteroidBeltNpcRatCommanderChance: 0 } } };
    const expectedInput = { systemId: SYS_AMARR_NULL, factionId: AMARR, spawnSiteId: `${SYS_AMARR_NULL}:${BELT_ID}:1`,
      atMs: NOW };

    run({ ...normal, navy: true }, ({ arrive, counts, inputs }) => {
      const r = arrive(SYS_AMARR_NULL);
      assert.deepStrictEqual(inputs, [expectedInput], "the vendor's spawnSiteID in the spawn options");
      assert.ok(profileIds(r.calls[0]).every((id) => id.startsWith(NAVY_PREFIX)), profileIds(r.calls[0]).join());
      assert.deepStrictEqual(counts, ["world.empireBelts.navy"]);
    });
    run({ ...normal, navy: false }, ({ arrive, counts }) => {
      const r = arrive(SYS_AMARR_NULL);
      assert.ok(profileIds(r.calls[0]).every((id) => !id.startsWith(NAVY_PREFIX)), profileIds(r.calls[0]).join());
      assert.strictEqual(isSpecialSelection(r.calls[0].selectionResult.data.selectionID), false, "3 segments");
      assert.deepStrictEqual(counts, ["world.empireBelts.pirates"]);
    });
    run({ navy: true }, ({ arrive, counts, inputs }) => {
      const r = arrive(SYS_AMARR_NULL);
      const selectionID = r.calls[0].selectionResult.data.selectionID;
      assert.strictEqual(selectionID, "belt_rat:serpentis:nullsec:commander");
      assert.strictEqual(isSpecialSelection(selectionID), true, "4 segments");
      assert.deepStrictEqual(inputs, []);
      assert.deepStrictEqual(counts, ["world.empireBelts.pirates"]);
    });
    run(normal, ({ arrive, counts, logger }) => {
      const r = arrive(SYS_AMARR_NULL);
      assert.ok(profileIds(r.calls[0]).every((id) => !id.startsWith(NAVY_PREFIX)));
      assert.deepStrictEqual(counts, ["world.empireBelts.fallback"]);
      assert.ok(logger.lines.log.some((l) => l.includes("ROLL_UNAVAILABLE")), logger.lines.log.join("\n"));
    });
  });

  test(ebr9, () => {
    const NOW = 1793000000000;
    const controllers = new Map([[SYS_AMARR_NULL, AMARR]]);
    const config = okConfig({ beltNavy: { standingAggroEnabled: true } });
    const run = (opts, check) => {
      const counts = [];
      const telemetry = { hooks: { onCount: (name) => { assert.ok(isMetricName(name), name);
        if (name.startsWith("world.empireBelts.")) counts.push(name); } } };
      withRealChain(src, { controllers, telemetry, config, clock: { now: () => NOW }, ...opts },
        (h) => check({ ...h, counts }));
    };
    const groups = [];
    const beltNavy = { canAccept: () => true, registerGroup: (group) => { groups.push(group); return { ok: true }; } };
    run({ beltNavy }, ({ arrive, counts }) => {
      const { calls } = arrive(SYS_AMARR_NULL);
      assert.ok(profileIds(calls[0]).every((id) => id.startsWith(NAVY_PREFIX)), profileIds(calls[0]).join());
      assert.strictEqual(calls[0].spawnOptions.preferredTargetID, 0, "the vendor passes the pilot's ship");
      assert.strictEqual(calls[0].context.preferredTargetID, 0);
      assert.deepStrictEqual(calls[0].spawnOptions.behaviorOverrides, { autoAggro: false, proximityAggroRangeMeters: 0 });
      assert.deepStrictEqual(counts, ["world.empireBelts.navy"]);
    });
    assert.deepStrictEqual(groups.map((g) => [g.spawnSiteId, g.systemId, g.factionId, g.atMs]),
      [[`${SYS_AMARR_NULL}:${BELT_ID}:1`, SYS_AMARR_NULL, AMARR, NOW]]);
    run({}, ({ arrive, counts, logger }) => {
      const { calls } = arrive(SYS_AMARR_NULL);
      assert.ok(profileIds(calls[0]).every((id) => !id.startsWith(NAVY_PREFIX)));
      assert.strictEqual(calls[0].spawnOptions.preferredTargetID, 9);
      assert.deepStrictEqual(counts, ["world.empireBelts.fallback"]);
      assert.ok(logger.lines.log.some((l) => l.includes("AGGRO_UNAVAILABLE")), logger.lines.log.join("\n"));
    });
    run({ beltNavy, config: okConfig({ beltNavy: { shareEnabled: true } }), beltConfig: { asteroidBeltNpcRatCommanderChance: 0 },
      beltNavyRoll: { decide: () => ({ ok: false, reason: "NO_SCORE" }) } }, ({ arrive, counts, logger }) => {
      arrive(SYS_AMARR_NULL);
      assert.deepStrictEqual(counts, ["world.empireBelts.noScore"]);
      assert.deepStrictEqual(logger.lines.log.filter((l) => l.includes("empireBeltNavy")).length, 1, logger.lines.log.join("\n"));
    });
  });

  test(ebr10, () => {
    const read = (...p) => fs.readFileSync(path.join(src, ...p), "utf8").replace(/\r\n/g, "\n");
    const loop = read("space", "npc", "npcBehaviorLoop.js");
    const native = read("space", "npc", "nativeNpcService.js");
    const belt = read("space", "npc", "beltRatRuntime.js");
    const passiveAt = loop.indexOf("if (behaviorProfile.autoAggro === false) {");
    assert.ok(passiveAt >= 0, "passive branch");
    const passive = loop.slice(passiveAt, loop.indexOf("const autoAggroTargetClasses = resolveAutoAggroTargetClasses(", passiveAt));
    assert.ok(passive.indexOf("isValidCombatTarget(entity, preferredTarget,") >= 0, "a preferred target is answered");
    assert.ok(/if \(proximityAggroRangeMeters <= 0\) \{\s*return null;/.test(passive), "range 0 looks for nobody");
    assert.ok(/normalizedType === "resume"[^]{0,60}\{\s*return null;/.test(loop), "resume clears the manual order");
    assert.ok(/"proximityAggroRangeMeters",/.test(loop.slice(loop.indexOf("function normalizeBehaviorOverrides("))),
      "the override reaches the profile");
    const manualAt = loop.indexOf('manualOrder.type === "attack" &&');
    assert.ok(manualAt >= 0 && manualAt < loop.indexOf("function resolveDesiredTarget(") + 500, "an order before the behaviour");

    const controller = native.slice(native.indexOf("function registerNativeRuntimeController("));
    assert.ok(controller.slice(0, controller.indexOf("\n}\n")).includes("manualOrder: null"), "orders do not survive dormancy");
    assert.ok(native.includes("preferredTargetID: toPositiveInt(options.preferredTargetID, toPositiveInt(context.preferredTargetID, 0))"),
      "the options, then the context");
    const spawn = belt.slice(belt.indexOf("function spawnBeltRatGroup("));
    assert.ok(spawn.includes("    spawnSiteID,\n  });"), "spawnSiteID in the spawn options");
    assert.ok(spawn.includes("toPositiveInt(entry && entry.entity && entry.entity.itemID, 0)"), "entity ids of the result");

    const sites = [["space", "runtime", "scene", "modules.js"], ["space", "runtime", "targetDamageApplication.js"],
      ["space", "runtime", "weaponCycle.js"]].map((p) => [p[p.length - 1],
      read(...p).split("npcService.noteNpcIncomingAggression(").length - 1]);
    assert.deepStrictEqual(sites, [["modules.js", 1], ["targetDamageApplication.js", 1], ["weaponCycle.js", 2]]);
    assert.ok(read("services", "drone", "droneRuntime.js").includes("droneInterop.applyWeaponDamageToTarget("), "drones hit through it");
  });

  test(ebr5, () => {
    const read = (...p) => fs.readFileSync(path.join(src, ...p), "utf8").replace(/\r\n/g, "\n");
    const presentation = read("space", "npc", "npcPresentation.js");
    const native = read("space", "npc", "nativeNpcService.js");
    const wreck = read("space", "npc", "nativeNpcWreckService.js");
    assert.ok(/module\.exports = \{[^}]*\n  buildNpcEntityIdentity,\n/.test(presentation), "identity export");
    const authored = presentation.indexOf("const authored = toFiniteNumber(profile && profile.bounty, 0);");
    assert.ok(authored >= 0 && presentation.indexOf("if (authored > 0) {", authored) > authored,
      "an authored bounty wins over the hull fallback");
    assert.ok(presentation.includes("resolveNpcEntityBounty(profile, resolvedTypeID)"), "identity reads the profile");
    assert.ok(presentation.includes("warFactionID: toPositiveInt(profile.factionID, 0)"), "faction from the profile");
    assert.ok(native.includes("lootTableID: definition.lootTable ? definition.lootTable.lootTableID : null"), "loot");
    assert.ok(native.includes("bounty: identity.bounty"), "record bounty from the identity");
    assert.ok(native.includes("warFactionID: identity.warFactionID"), "record faction from the identity");
    assert.ok(native.includes("entity.selectionID = entityRecord.selectionID || null;"), "entity selectionID");
    assert.ok(wreck.includes("nativeEntityRecord && nativeEntityRecord.lootTableID"), "wreck loot from the record");
    const killStanding = read("services", "character", "factionKillStandingRuntime.js");
    assert.ok(killStanding.includes("toPositiveInt(victimEntity && victimEntity.warFactionID, 0)"), "victim faction");
  });

  test(ebr4, () => {
    const npcData = fakeNpcData();
    const unexpected = () => { throw new Error("not expected"); };
    const tools = (over = {}) => ({ getNpcSpawnTools: () => ({ ok: true, buildNpcDefinition: npcData.buildNpcDefinition,
      resolveNpcBounty: (d) => d.profile.bounty, spawnNativeDefinitionsInContext: unexpected, ...over }) });
    const rewardConfig = (beltNavy) => okConfig({ beltNavy: { rewardsEnabled: true, bountyMultiplier: 1.1, ...beltNavy } });
    const run = (opts, check) => {
      const counts = [];
      const telemetry = { hooks: { onCount: (name) => { if (name.startsWith("world.empireBelts.")) counts.push(name); } } };
      withRealChain(src, { controllers: new Map([[SYS_AMARR_NULL, AMARR]]), telemetry, ...opts },
        (h) => check({ ...h, counts }));
    };
    const pirate = (r) => {
      assert.strictEqual(r.calls.length, 1, JSON.stringify(r.result));
      assert.ok(profileIds(r.calls[0]).every((id) => !id.startsWith(NAVY_PREFIX)), profileIds(r.calls[0]).join());
    };

    run({ config: rewardConfig({}), adapter: tools() }, ({ arrive, counts }) => {
      const r = arrive(SYS_AMARR_NULL);
      assert.strictEqual(r.calls.length, 1, JSON.stringify(r.result));
      const definitions = r.calls[0].selectionResult.data.definitions;
      assert.ok(definitions.length > 0);
      for (const d of definitions) {
        assert.ok(d.profile.profileID.startsWith(NAVY_PREFIX), d.profile.profileID);
        assert.strictEqual(d.profile.bounty, Math.round(PIRATE_BOUNTY * 1.1));
        assert.strictEqual(d.profile.factionID, AMARR);
        assert.ok(d.lootTable.lootTableID.startsWith("loot_"), d.lootTable.lootTableID);
        assert.strictEqual(d.profile.lootTableID, d.lootTable.lootTableID);
      }
      assert.deepStrictEqual(counts, ["world.empireBelts.navy"]);
    });

    run({ config: rewardConfig({ rewardsEnabled: false }), adapter: tools({ resolveNpcBounty: undefined }) },
      ({ arrive, counts }) => {
        const r = arrive(SYS_AMARR_NULL);
        for (const d of r.calls[0].selectionResult.data.definitions) {
          assert.deepStrictEqual(d, npcData.buildNpcDefinition(d.profile.profileID));
        }
        assert.deepStrictEqual(counts, ["world.empireBelts.navy"]);
      });

    const failures = [
      ["no reader", tools({ resolveNpcBounty: undefined })],
      ["zero bounty", tools({ resolveNpcBounty: () => 0 })],
      ["reader throws", tools({ resolveNpcBounty: () => { throw new Error("boom"); } })],
    ];
    for (const [label, adapter] of failures) {
      run({ config: rewardConfig({}), adapter }, ({ arrive, counts }) => {
        pirate(arrive(SYS_AMARR_NULL));
        assert.deepStrictEqual(counts, ["world.empireBelts.fallback"], label);
      });
    }
    run({ config: rewardConfig({}), adapter: tools(), lootless: true }, ({ arrive, counts }) => {
      pirate(arrive(SYS_AMARR_NULL));
      assert.deepStrictEqual(counts, ["world.empireBelts.fallback"], "pirate without a loot table");
    });
  });

  test(e3, () => {
    const controllers = new Map([[SYS_SANSHA_NULL, SANSHA], [SYS_AMARR_HIGH, AMARR]]);
    withRealChain(src, { controllers }, ({ belt, ctx, arrive }) => {
      assert.strictEqual(belt.maybeSpawnForSessionArrival[WRAPPED_EMPIRE_BELTS], true);
      assert.strictEqual(ctx.state.empireBelts, "wrapped");

      const base = arrive(SYS_AMARR_NULL, { skipSpecialSpawns: true });
      assert.strictEqual(base.calls.length, 1, JSON.stringify(base.result));
      const vendorHulls = profileIds(base.calls[0]).map(hullOfProfileId);
      assert.ok(profileIds(base.calls[0]).every((id) => id.startsWith("serpentis_")), "fixture: vendor serpentis");

      controllers.set(SYS_AMARR_NULL, AMARR);
      const navy = arrive(SYS_AMARR_NULL);
      assert.strictEqual(navy.result.spawned, true, JSON.stringify(navy.result));
      assert.strictEqual(navy.calls.length, 1);
      const call = navy.calls[0];
      const ids = profileIds(call);
      assert.deepStrictEqual(ids, vendorHulls.map((h) => NAVY_PROFILES_BY_FACTION_ID[AMARR][h]));
      assert.ok(call.selectionResult.data.selectionID.startsWith(`belt_navy:${AMARR}:`));
      assert.ok(call.spawnOptions.selectionID.startsWith(`belt_navy:${AMARR}:`), "entities get the navy selection");
      assert.ok(!Object.prototype.hasOwnProperty.call(call.spawnOptions, "spawnNativeDefinitionsInContext"));
      assert.strictEqual(call.spawnOptions.skipSpecialSpawns, true);

      const pirates = arrive(SYS_SANSHA_NULL);
      assert.strictEqual(pirates.calls.length, 1, JSON.stringify(pirates.result));
      assert.ok(profileIds(pirates.calls[0]).every((id) => id.includes("sansha")), profileIds(pirates.calls[0]).join());
      assert.strictEqual(pirates.calls[0].spawnOptions.spawnNativeDefinitionsInContext, pirates.spy, "bit in bit");
      assert.strictEqual(pirates.calls[0].spawnOptions.skipSpecialSpawns, undefined, "bit in bit");

      const high = arrive(SYS_AMARR_HIGH);
      assert.strictEqual(high.calls.length, 1, JSON.stringify(high.result));
      assert.ok(profileIds(high.calls[0]).every((id) => !id.startsWith(NAVY_PREFIX)), profileIds(high.calls[0]).join());
      assert.strictEqual(high.calls[0].spawnOptions.spawnNativeDefinitionsInContext, high.spy);
    });
  });

  test(e4, () => {
    for (const [label, config] of [["empireBeltsEnabled=false", okConfig({ empireBeltsEnabled: false })],
      ["modules.world.enabled=false", okConfig({}, { enabled: false })]]) {
      withRealChain(src, { config }, ({ belt, ctx }) => {
        assert.strictEqual(belt.maybeSpawnForSessionArrival[WRAPPED_EMPIRE_BELTS], undefined, `${label}: no wrap`);
        assert.strictEqual(ctx.state.empireBelts, "disabled", label);
      });
    }
    const controllers = new Map([[SYS_AMARR_NULL, AMARR]]);
    const run = (opts, check) => {
      const counts = [];
      const telemetry = { hooks: { onCount: (name, n) => { assert.ok(isMetricName(name), name); if (name.startsWith("world.empireBelts.")) counts.push(name); } } };
      withRealChain(src, { controllers, telemetry, ...opts }, (h) => check({ ...h, counts }));
    };
    const pirate = (r) => {
      assert.strictEqual(r.calls.length, 1, JSON.stringify(r.result));
      assert.ok(profileIds(r.calls[0]).every((id) => !id.startsWith(NAVY_PREFIX)), profileIds(r.calls[0]).join());
    };
    run({ adapter: null }, ({ arrive, counts }) => {
      pirate(arrive(SYS_AMARR_NULL));
      assert.deepStrictEqual(counts, ["world.empireBelts.fallback"]);
    });
    run({ worldThrows: true }, ({ arrive, counts, logger }) => {
      pirate(arrive(SYS_AMARR_NULL));
      pirate(arrive(SYS_AMARR_NULL));
      assert.deepStrictEqual(counts, ["world.empireBelts.failed", "world.empireBelts.failed"]);
      assert.strictEqual(logger.lines.log.filter((l) => l.startsWith("empireBeltNavy: failed")).length, 1,
        logger.lines.log.join("\n"));
    });
    const noDefinition = { getNpcSpawnTools: () => ({ ok: true, buildNpcDefinition: () => null,
      spawnNativeDefinitionsInContext: () => { throw new Error("not expected"); } }) };
    run({ adapter: noDefinition }, ({ arrive, counts }) => {
      pirate(arrive(SYS_AMARR_NULL));
      assert.deepStrictEqual(counts, ["world.empireBelts.fallback"]);
    });
  });

  test("SBP1 selectNavyTable: SoE 5 classes, csv filtered to the catalog without empires, empty -> {}", () => {
    const data = require("../../lib/adapter/data/factionLiveProfiles");
    const soe = selectNavyTable("500016", data);
    assert.deepStrictEqual(Object.keys(soe), [String(SOE)]);
    assert.strictEqual(Object.keys(soe[SOE]).length, 5);
    for (const cls of Object.keys(soe[SOE])) assert.strictEqual(soe[SOE][cls], `lne_faction_${SOE}_${cls}`);
    assert.deepStrictEqual(selectNavyTable("500016,500001,999", data), soe);
    assert.deepStrictEqual(selectNavyTable("", data), {});
    assert.deepStrictEqual(selectNavyTable(undefined, data), {});
  });

  test("SBP2/SBP3 patrol replaces the belt rats in full; empires, pirates and no controller as before", () => {
    const patrolTable = selectNavyTable(String(SOE), require("../../lib/adapter/data/factionLiveProfiles"));
    const HULLS = ["frigate", "cruiser", "battleship"];
    const run = (controller, over = {}) => {
      const outcomes = [];
      const spawned = [];
      const rolls = [];
      const built = [];
      const selection = { success: true, data: { selectionID: "belt_rat:guristas:nullsec", selectionName: "g",
        definitions: HULLS.map((h) => ({ profile: { name: `guristas ${h}` }, lootTable: { lootTableID: "loot_g" } })) } };
      const given = {};
      let applied = null;
      const original = function (scene, session, ship, options) {
        applied = { self: this, args: [...arguments] };
        given.options = options;
        if (options && typeof options.spawnNativeDefinitionsInContext === "function") {
          options.spawnNativeDefinitionsInContext({ tag: "context" }, selection,
            { ...options, spawnSiteID: "7:8:1", selectionID: selection.data.selectionID });
        }
        return "vendor result";
      };
      const buildNpcDefinition = (id) => { built.push(id); return { profile: { profileID: id, name: id } }; };
      const wrap = wrapBeltSpawnForNavy(original, {
        navyProfiles: Object.freeze({ ...NAVY_PROFILES_BY_FACTION_ID, ...patrolTable }),
        fullReplaceFactionIds: [SOE],
        resolveSecurityProfile: () => ({ band: "nullsec" }),
        readController: () => ({ ok: true, controllerFactionId: controller }),
        getNpcSpawnTools: () => ({ ok: true, buildNpcDefinition,
          spawnNativeDefinitionsInContext: (context, selectionResult, spawnOptions) => {
            spawned.push({ context, selectionResult, spawnOptions });
            return { success: true };
          } }),
        shareEnabled: true, nowMs: () => 42, onOutcome: (outcome, reason) => outcomes.push([outcome, reason]),
        decideSpawn: (input) => { rolls.push(input); return { ok: true, navy: true }; }, ...over });
      const self = { tag: "this" };
      const options = { flag: 1 };
      assert.strictEqual(wrap.wrapped.call(self, { systemID: 7 }, "session", "ship", options), "vendor result");
      return { outcomes, spawned, rolls, built, selection, given, applied, self, options };
    };

    const soe = run(SOE);
    assert.deepStrictEqual(soe.rolls, [], "no share roll for a patrol faction");
    assert.strictEqual(soe.given.options.skipSpecialSpawns, true);
    assert.deepStrictEqual(soe.built, HULLS.map((h) => `lne_faction_${SOE}_${h}`));
    assert.deepStrictEqual(profileIds(soe.spawned[0]), HULLS.map((h) => `lne_faction_${SOE}_${h}`));
    assert.strictEqual(soe.spawned[0].selectionResult.data.selectionID, `belt_navy:${SOE}:belt_rat:guristas:nullsec`);
    assert.ok(isBeltNavyVictim({ selectionID: soe.spawned[0].spawnOptions.selectionID }));
    assert.deepStrictEqual(soe.outcomes, [["patrol", "CONTROLLER_PATROL"]]);

    let vendorSpawn = null;
    const missing = run(SOE, { getNpcSpawnTools: () => ({ ok: true, buildNpcDefinition: () => null,
      spawnNativeDefinitionsInContext: (context, selectionResult) => {
        vendorSpawn = selectionResult;
        return { success: true };
      } }) });
    assert.strictEqual(vendorSpawn, missing.selection, "the vendor's selection, bit in bit");
    assert.deepStrictEqual(missing.outcomes, [["fallback", "DEFINITION_MISSING"]]);

    for (const controller of [500010, null]) {
      const r = run(controller);
      assert.strictEqual(r.applied.self, r.self);
      assert.deepStrictEqual(r.applied.args, [{ systemID: 7 }, "session", "ship", r.options]);
      assert.strictEqual(r.applied.args[3], r.options, "the caller's options object");
      assert.deepStrictEqual(r.outcomes, []);
    }

    const minmatar = run(500004);
    assert.strictEqual(minmatar.rolls.length, 1);
    assert.strictEqual(minmatar.given.options.skipSpecialSpawns, undefined);
    assert.deepStrictEqual(minmatar.outcomes, [["navy", "CONTROLLER_NAVY"]]);
  });

  test(sbp5, () => {
    const patrolConfig = (on) => okConfig({ beltNavy: { patrolFactionsEnabled: on, patrolFactions: String(SOE) } });
    const run = (on, check) => {
      const counts = [];
      const telemetry = { hooks: { onCount: (name) => { assert.ok(isMetricName(name), name);
        if (name.startsWith("world.empireBelts.")) counts.push(name); } } };
      const controllers = new Map();
      withRealChain(src, { controllers, telemetry, config: patrolConfig(on) }, (h) => check({ ...h, counts }));
    };
    run(true, ({ belt, ctx, arrive, controllers, counts }) => {
      assert.strictEqual(belt.maybeSpawnForSessionArrival[WRAPPED_EMPIRE_BELTS], true);
      assert.strictEqual(ctx.state.empireBelts, "wrapped");
      const base = arrive(SYS_AMARR_NULL, { skipSpecialSpawns: true });
      assert.strictEqual(base.calls.length, 1, JSON.stringify(base.result));
      const vendorHulls = profileIds(base.calls[0]).map(hullOfProfileId);
      assert.deepStrictEqual(counts, []);
      controllers.set(SYS_AMARR_NULL, SOE);
      const patrol = arrive(SYS_AMARR_NULL);
      assert.strictEqual(patrol.calls.length, 1, JSON.stringify(patrol.result));
      assert.deepStrictEqual(profileIds(patrol.calls[0]), vendorHulls.map((h) => `lne_faction_${SOE}_${h}`));
      assert.ok(patrol.calls[0].selectionResult.data.selectionID.startsWith(`belt_navy:${SOE}:`));
      assert.strictEqual(patrol.calls[0].spawnOptions.skipSpecialSpawns, true);
      assert.deepStrictEqual(counts, ["world.empireBelts.patrol"]);
    });
    run(false, ({ belt, arrive, controllers, counts }) => {
      assert.strictEqual(belt.maybeSpawnForSessionArrival[WRAPPED_EMPIRE_BELTS], true);
      controllers.set(SYS_AMARR_NULL, SOE);
      const r = arrive(SYS_AMARR_NULL);
      assert.strictEqual(r.calls.length, 1, JSON.stringify(r.result));
      assert.ok(profileIds(r.calls[0]).every((id) => id.includes("serpentis_")), profileIds(r.calls[0]).join());
      assert.strictEqual(r.calls[0].spawnOptions.spawnNativeDefinitionsInContext, r.spy, "bit in bit");
      assert.deepStrictEqual(counts, []);
    });
  });

  test("SBP4 config: patrol defaults off / 500016, warning without the faction profiles", () => {
    const config = require("../../config");
    const base = config.resolveConfig({ env: {}, modDir: MOD_DIR });
    assert.strictEqual(base.config.world.beltNavy.patrolFactionsEnabled, false);
    assert.strictEqual(base.config.world.beltNavy.patrolFactions, "500016");
    const warns = (env) => config.resolveConfig({ env, modDir: MOD_DIR }).warnings
      .filter((w) => w.startsWith("world.beltNavy.patrolFactionsEnabled"));
    assert.strictEqual(warns({}).length, 0);
    assert.strictEqual(warns({ EVEJS_LNE_WORLD_BELT_NAVY_PATROL_FACTIONS_ENABLED: "1" }).length, 1);
    assert.strictEqual(warns({ EVEJS_LNE_WORLD_BELT_NAVY_PATROL_FACTIONS_ENABLED: "1",
      EVEJS_LNE_MATERIALIZATION_FACTION_PROFILES_ENABLED: "1" }).length, 0);
  });
};
