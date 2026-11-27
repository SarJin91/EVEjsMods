"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { wrapSiteSpawnForNavy, checkTemplate, PIRATE_FACTION_KEYS } = require("../../lib/adapter/siteNavy");
const { NAVY_PROFILES_BY_FACTION_ID } = require("../../lib/adapter/empireNavyCatalog");
const { NAVY_PASSIVE_BEHAVIOR } = require("../../lib/adapter/data/liveProfiles");
const { createBeltNavyRoll } = require("../../lib/world/beltNavy");
const { createAggroService } = require("../../lib/world/beltNavy/aggroService");
const { findServerSrcOnDisk } = require("../../lib/adapter/locator");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SERVER_SEARCH_MAX_DEPTH = 5;
const CALDARI = 500001;
const SYS_NULL = 30000201;
const SYS_HIGH = 30000202;
const PIRATE_TYPE = 600;
const PIRATE_BOUNTY = 10000;
const MULTIPLIER = 1.1;
const NOW = 1700000000000;

const ENTRY = (hullClass, extra = {}) => ({ entityKind: "npc", factionKey: "guristas", hullClass, ...extra });
const TEMPLATES = Object.freeze({
  "tpl-ok": { populationHints: { encounters: [{ key: "w1", spawnEntries: [ENTRY("cruiser"), ENTRY("frigate")] },
    { key: "w2", spawnEntries: [ENTRY("battleship")] }] } },
  "tpl-nohull": { populationHints: { encounters: [{ key: "w1", spawnEntries: [ENTRY("cruiser")] },
    { key: "w2", spawnEntries: [{ entityKind: "npc", factionKey: "guristas" }] }] } },
  "tpl-trigger": { populationHints: { encounters: [{ key: "w1", spawnEntries: [ENTRY("cruiser")] },
    { key: "w2", spawnEntries: [ENTRY("frigate")], triggerEntity: { typeID: 1234 } }] } },
});

function pirateDefinition(hull) {
  return { profile: { profileID: `guristas_${hull}`, name: `Guristas ${hull}`, bounty: PIRATE_BOUNTY,
    shipTypeID: PIRATE_TYPE }, lootTable: { lootTableID: "lt_guristas" } };
}

function buildNpcDefinition(profileId) {
  const m = /_(\d+)_[a-z]+_([a-z]+)$/.exec(profileId);
  if (!m) return null;
  return { profile: { profileID: profileId, name: `Navy ${m[2]}`, bounty: 0, shipTypeID: Number(m[1]) },
    lootTable: { lootTableID: "parity_faction_warfare_entities_pending_loot" } };
}

function navyTypeIds() {
  const ids = new Set();
  for (const byHull of Object.values(NAVY_PROFILES_BY_FACTION_ID)) {
    for (const id of Object.values(byHull)) ids.add(buildNpcDefinition(id).profile.shipTypeID);
  }
  return ids;
}

function harness(over = {}) {
  const env = { calls: [], counts: {}, rolls: 0, registered: [], nextEntity: 9000, enabled: true,
    summaries: new Map(), refs: new Map(), roll: () => ({ ok: true, navy: true }), sink: null };
  env.sink = { canAccept: () => true, registerGroup: (g) => { env.registered.push(g); return { ok: true }; } };
  const original = function vendorSpawn() {
    env.calls.push({ self: this, args: [...arguments], length: arguments.length });
    const n = (arguments[1] && arguments[1].data && arguments[1].data.definitions.length) || 0;
    const spawned = [];
    for (let i = 0; i < n; i += 1) spawned.push({ entity: { itemID: (env.nextEntity += 1) } });
    env.lastResult = { success: true, data: { spawned } };
    env.calls[env.calls.length - 1].returned = env.lastResult;
    return env.lastResult;
  };
  const wrap = wrapSiteSpawnForNavy(original, {
    enabled: () => env.enabled,
    readSummary: (id) => env.summaries.get(id) || null,
    readInstanceRef: (id) => env.refs.get(id) || null,
    readTemplate: (id) => TEMPLATES[id] || null,
    navyProfiles: NAVY_PROFILES_BY_FACTION_ID,
    navyTypeIds: navyTypeIds(),
    readController: () => ({ ok: true, controllerFactionId: CALDARI }),
    resolveSecurityProfile: (id) => ({ band: id === SYS_HIGH ? "highsec" : "nullsec" }),
    buildNpcDefinition,
    resolveNpcBounty: (def) => def.profile.bounty,
    bountyMultiplier: MULTIPLIER,
    rewardsEnabled: true,
    decideSite: (input) => {
      env.rolls += 1;
      return env.roll(input);
    },
    getAggroSink: () => env.sink,
    standingAggroEnabled: true,
    maxTrackedSites: 64,
    nowMs: () => NOW,
    onOutcome: (outcome, reason) => {
      const key = `${outcome}:${reason}`;
      env.counts[key] = (env.counts[key] || 0) + 1;
    },
    ...over,
  });
  assert.ok(wrap.ok, JSON.stringify(wrap));
  const site = (id, extra = {}) => {
    env.summaries.set(id, { instanceID: id, templateID: "tpl-ok", siteFamily: "combat", siteKind: "anomaly",
      siteOrigin: "client_dungeon", runtimeFlags: { universeSeeded: true }, ...extra });
    if (!env.refs.has(id)) env.refs.set(id, { spawnState: { encounterStatesByKey: {} } });
  };
  const spawn = (id, { wave = "w1", hull = "cruiser", systemId = SYS_NULL, key, meta } = {}) => {
    const context = { systemID: systemId, scene: { systemID: systemId }, preferredTargetID: 0, anchorKind: "site" };
    const selection = { success: true, data: { definitions: [pirateDefinition(hull)], selectionID: `guristas_${hull}`,
      selectionName: `Guristas ${hull}` } };
    const scope = meta === undefined ? { dungeonMaterializedSiteContent: true, dungeonSiteInstanceID: id,
      dungeonSiteID: 40000000 + id, dungeonEncounterKey: key || `instance:${id}:${wave}` } : meta;
    const options = { amount: 1, transient: true, runtimeKind: "nativeCombat", ...(scope ? { entityScopeMetadata: scope } : {}) };
    const self = { vendor: true };
    const result = wrap.wrapped.call(self, context, selection, options);
    return { context, selection, options, scope, self, result, call: env.calls[env.calls.length - 1] };
  };
  const isNavy = (s) => s.call.args[1].data.definitions[0].profile.shipTypeID !== PIRATE_TYPE;
  return { env, wrap, site, spawn, isNavy };
}

function assertBitInBit(s, label) {
  assert.strictEqual(s.result, s.call.returned, `${label}: result`);
  assert.strictEqual(s.call.self, s.self, `${label}: this`);
  assert.strictEqual(s.call.length, 3, `${label}: arguments.length`);
  assert.strictEqual(s.call.args[0], s.context, `${label}: context`);
  assert.strictEqual(s.call.args[1], s.selection, `${label}: selection`);
  assert.strictEqual(s.call.args[2], s.options, `${label}: options`);
}

function findSrcDir() {
  const found = findServerSrcOnDisk(MOD_DIR, SERVER_SEARCH_MAX_DEPTH, fs.existsSync);
  return found.ok ? found.srcDir : null;
}

function listJs(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJs(full));
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

function functionBody(source, name) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) return "";
  const end = source.indexOf("\n}\n", start);
  return source.slice(start, end < 0 ? source.length : end);
}

module.exports = ({ test }) => {
  test("SNV1 qualified wave rolled navy: rewarded navy definitions, passive, selectionID, same scope, site group", () => {
    const h = harness();
    h.site(11);
    const s = h.spawn(11);
    assert.strictEqual(h.env.calls.length, 1);
    const [context, selection, options] = s.call.args;
    const def = selection.data.definitions[0];
    assert.deepStrictEqual([def.profile.profileID, def.profile.factionID, def.profile.bounty, def.lootTable.lootTableID,
      def.profile.lootTableID], [NAVY_PROFILES_BY_FACTION_ID[CALDARI].cruiser, CALDARI,
      Math.round(PIRATE_BOUNTY * MULTIPLIER), "lt_guristas", "lt_guristas"]);
    const selectionID = `belt_navy:${CALDARI}:site:11`;
    assert.deepStrictEqual([options.selectionID, selection.data.selectionID, options.preferredTargetID,
      context.preferredTargetID, options.behaviorOverrides], [selectionID, selectionID, 0, 0, { ...NAVY_PASSIVE_BEHAVIOR }]);
    assert.strictEqual(options.entityScopeMetadata, s.scope, "entityScopeMetadata is the same reference");
    assert.deepStrictEqual(options.entityScopeMetadata, { dungeonMaterializedSiteContent: true, dungeonSiteInstanceID: 11,
      dungeonSiteID: 40000011, dungeonEncounterKey: "instance:11:w1" });
    assert.strictEqual(s.result, h.env.lastResult, "the vendor's result goes back unchanged");
    assert.deepStrictEqual(h.env.registered, [{ spawnSiteId: "site:11", kind: "site", systemId: SYS_NULL,
      factionId: CALDARI, entityIds: [9001], atMs: NOW }]);
    assert.deepStrictEqual(h.env.counts, { "navy:CONTROLLER_NAVY": 1 });
    assert.strictEqual(h.env.rolls, 1);
  });

  test("SNV2 bit in bit: flag off, no metadata, fw-open key, lne_event, manualSpawn, not nullsec", () => {
    const h = harness();
    const cases = [];
    h.site(21);
    h.env.enabled = false;
    cases.push(["flag off", h.spawn(21)]);
    h.env.enabled = true;
    cases.push(["no metadata", h.spawn(21, { meta: null })]);
    cases.push(["fw-open", h.spawn(21, { key: "fw-open:21:wave1" })]);
    h.site(22, { siteOrigin: "lne_event" });
    cases.push(["lne_event", h.spawn(22)]);
    h.site(23, { runtimeFlags: { universeSeeded: true, manualSpawn: true } });
    cases.push(["manualSpawn", h.spawn(23)]);
    h.site(24);
    cases.push(["highsec", h.spawn(24, { systemId: SYS_HIGH })]);
    for (const [label, s] of cases) assertBitInBit(s, label);
    assert.strictEqual(h.env.calls.length, cases.length);
    assert.deepStrictEqual([h.env.rolls, h.env.registered.length], [0, 0], "no roll, no group");
    assert.deepStrictEqual(h.env.counts, { "pirates:LNE_EVENT": 1, "pirates:MANUAL": 1, "pirates:NOT_NULLSEC": 1 });
  });

  test("SNV3 whole anomaly: the first result holds when the share changes; unclassified or trigger template = pirates", () => {
    const occ = { score: 100 };
    const roll = createBeltNavyRoll({
      getWorld: () => ({ getControlState: () => ({ ok: true, system: { controllerFactionId: CALDARI,
        occupationState: "STABLE" } }) }),
      getOccupation: () => ({ effectiveScoreOf: () => occ.score }),
      worldSeed: 424242, settings: { shareMin: 0, shareMax: 1, consolidatingWeight: 0.5, rollBucketMs: 3600000 } });
    const h = harness({ decideSite: (input) => roll.decideSite(input) });
    h.site(31);
    const first = h.spawn(31, { wave: "w1", hull: "cruiser" });
    occ.score = 0;
    assert.strictEqual(roll.decideSite({ systemId: SYS_NULL, factionId: CALDARI, instanceId: 31, atMs: NOW }).navy, false);
    const second = h.spawn(31, { wave: "w2", hull: "battleship" });
    assert.deepStrictEqual([h.isNavy(first), h.isNavy(second)], [true, true], "both waves navy");
    assert.strictEqual(second.call.args[1].data.definitions[0].profile.profileID,
      NAVY_PROFILES_BY_FACTION_ID[CALDARI].battleship);
    assert.deepStrictEqual(h.env.registered.map((g) => g.spawnSiteId), ["site:31", "site:31"]);

    for (const tpl of ["tpl-nohull", "tpl-trigger"]) {
      const p = harness();
      p.site(32, { templateID: tpl });
      const waves = [p.spawn(32, { wave: "w1" }), p.spawn(32, { wave: "w2", hull: "frigate" })];
      for (const s of waves) assertBitInBit(s, tpl);
      assert.deepStrictEqual([p.env.rolls, p.env.registered.length], [0, 0], tpl);
    }
    assert.deepStrictEqual([checkTemplate(TEMPLATES["tpl-nohull"], PIRATE_FACTION_KEYS).reason,
      checkTemplate(TEMPLATES["tpl-trigger"], PIRATE_FACTION_KEYS).reason, checkTemplate(TEMPLATES["tpl-ok"],
        PIRATE_FACTION_KEYS).ok], ["ENTRY_UNCLASSIFIED", "IDENTITY_TRIGGER", true]);
  });

  test("SNV4 restart: an empty wrap reads navy or pirates from spawnState without a roll, no wave = roll", () => {
    const identity = (typeID) => ({ spawnState: { encounterStatesByKey: { w1: { spawnedAtMs: NOW,
      spawnedIdentitiesByEntityID: { 777: { typeID, nameID: null, label: "x" } } } } } });
    const h = harness({ decideSite: () => { throw new Error("no roll after a restart with a wave"); } });
    h.env.refs.set(41, identity(75358));
    h.site(41);
    h.env.refs.set(42, identity(PIRATE_TYPE));
    h.site(42);
    const navy = h.spawn(41, { wave: "w2" });
    const pirates = h.spawn(42, { wave: "w2" });
    assert.strictEqual(h.isNavy(navy), true);
    assertBitInBit(pirates, "pirate type");
    assert.deepStrictEqual(h.env.counts, { "recovered:NAVY": 1, "recovered:PIRATES": 1, "navy:CONTROLLER_NAVY": 1 });

    const fresh = harness();
    fresh.site(43);
    assert.strictEqual(fresh.isNavy(fresh.spawn(43)), true);
    assert.strictEqual(fresh.env.rolls, 1, "no wave yet: one roll");
  });

  test("SNV5 vendor facts on the source text; aggroService: wave 2 appends, a site expire never despawns", () => {
    const src = findSrcDir();
    assert.ok(src, "EveJS server/src not found above the mod");
    const read = (rel) => fs.readFileSync(path.join(src, rel), "utf8").replace(/\r\n/g, "\n");
    const npcService = read("space/npc/npcService.js");
    assert.ok(functionBody(npcService, "spawnNpcBatchInSystem").includes("nativeNpcService.spawnNativeDefinitionsInContext("),
      "spawnNpcBatchInSystem calls the export through the module object");
    const site = read("services/dungeon/dungeonUniverseSiteService.js");
    assert.ok(site.includes("`instance:${instanceID}:${planKey}`") && site.includes("dungeonEncounterKey: encounterKey"),
      "wave key and scope metadata of the site service");
    assert.ok(read("space/npc/nativeNpcService.js").includes("...scopeResolution.data.metadata"),
      "the scope metadata goes into the entity record");
    const destructured = /\{[^}]*\bspawnNativeDefinitionsInContext\b[^}]*\}\s*=/;
    const offenders = [...listJs(path.join(src, "space")), ...listJs(path.join(src, "services", "dungeon")),
      ...listJs(path.join(src, "services", "chat"))].filter((f) => destructured.test(fs.readFileSync(f, "utf8")));
    assert.deepStrictEqual(offenders, [], "nobody destructures the wrapped export");

    const world = { now: NOW, despawned: [], ships: new Map(), timers: [], reads: [] };
    const service = createAggroService({
      hunt: { readPlayerShips: () => ({ ok: true, ships: [] }) },
      scene: { readGroup: (_s, ids) => {
        world.reads.push([...ids]);
        return { ok: true, ships: ids.map((id) => world.ships.get(id)).filter(Boolean) };
      },
        orderGroup: () => ({ ok: true, failed: [] }) },
      spawn: { despawn: (_s, ids) => { world.despawned.push(ids); return { ok: true }; } },
      readStanding: () => ({ ok: true, standing: 0 }), getStandings: () => null, clock: { now: () => world.now },
      settings: { hostileBelowStanding: 0, aggroRangeMeters: 150000, pollMs: 5000, maxGroups: 1, maxGroupsPerPass: 4,
        groupTtlMs: 60000 },
      setTimer: (fn) => { const t = { fn, cancel() {} }; world.timers.push(t); return t; }, nowMs: () => 0 });
    const group = (ids, kind, atMs = world.now) => service.registerGroup({ spawnSiteId: "site:51", systemId: SYS_NULL,
      factionId: CALDARI, entityIds: ids, atMs, kind });
    assert.deepStrictEqual(group([1, 2], "site"), { ok: true });
    assert.deepStrictEqual(group([3, 2], "site"), { ok: true }, "wave 2 appends");
    assert.deepStrictEqual(world.reads[world.reads.length - 1], [1, 2, 3], "one group with the ships of both waves");
    assert.deepStrictEqual(group([5], "dock"), { ok: false, reason: "INVALID_INPUT" });
    assert.deepStrictEqual(service.getStatus().groups, 1);
    world.now += 60001;
    service.runPass();
    assert.deepStrictEqual([service.getStatus().groups, world.despawned], [0, []], "expired without a despawn");
  });
};
