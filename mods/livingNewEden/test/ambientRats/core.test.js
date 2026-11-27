"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { resolveConfig, SCHEMA } = require("../../config");
const { decideEligibility } = require("../../lib/ambientRats/eligibility");
const { pickAnchor } = require("../../lib/ambientRats/anchors");
const { planAmbientGroup } = require("../../lib/ambientRats/groupPlan");
const { resolveEmpireFaction } = require("../../lib/ambientRats/highsecFaction");
const { PIRATE_KEY_BY_FACTION_ID } = require("../../lib/adapter/data/liveProfiles");
const { EMPIRE_FACTION_IDS } = require("../../lib/adapter/empireNavyCatalog");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const DEFAULTS = resolveConfig({ modDir: MOD_DIR, env: {} }).config.ambientRats;
const TABLES = { pirateKeyByFactionId: PIRATE_KEY_BY_FACTION_ID, navyFactionIds: new Set(EMPIRE_FACTION_IDS) };

const P = (x, y = 0, z = 0) => ({ x, y, z });

module.exports = ({ test }) => {
  test("AMB1 decideEligibility: sources, refusal order, scope captured", () => {
    const sys = (over) => ({ band: "nullsec", eligible: true, controllerFactionId: 500010, homeFactionId: 500010,
      kind: "pirate", ...over });
    const d = (over, s = {}) => decideEligibility(sys(over), TABLES, { ...DEFAULTS, ...s });
    assert.deepStrictEqual(d({}), { ok: true, factionId: 500010, kind: "pirate", band: "nullsec",
      source: { type: "pirate", factionKey: "guristas" }, groupsTarget: 3 });
    const navy = d({ band: "lowsec", controllerFactionId: 500001, kind: "empire" });
    assert.deepStrictEqual([navy.ok, navy.source, navy.groupsTarget], [true, { type: "navy" }, 2]);
    assert.strictEqual(d({ controllerFactionId: 500007, kind: "empire" }).reason, "NO_SOURCE");
    assert.deepStrictEqual(d({ controllerFactionId: 500025, kind: "hive" }).source,
      { type: "pirate", factionKey: "rogue_drones" });
    assert.strictEqual(d({ controllerFactionId: 500021 }).reason, "NO_SOURCE");
    assert.strictEqual(d({}, { factionKinds: "empire,hive" }).reason, "KIND_OFF");
    assert.strictEqual(d({ kind: "invader" }).reason, "KIND_OFF");
    assert.strictEqual(d({ band: "highsec" }).reason, "BAND_OFF");
    assert.strictEqual(d({ eligible: false, band: "nullsec" }).reason, "BAND_INELIGIBLE");
    assert.strictEqual(d({ controllerFactionId: null }).reason, "NO_CONTROLLER");
    assert.strictEqual(d({}, { scope: "captured" }).reason, "NOT_CAPTURED");
    assert.strictEqual(d({ homeFactionId: 500011 }, { scope: "captured" }).ok, true);
    assert.strictEqual(d({}, { groupsNullsec: 0 }).reason, "NO_GROUPS");
    assert.strictEqual(d({ eligible: false, controllerFactionId: null }).reason, "BAND_INELIGIBLE");
  });

  test("AMB2 pickAnchor: used / player near / foreign NPC near rejected, deterministic pick, NO_ANCHOR", () => {
    const S = { minPlayerDistanceMeters: 500000, anchorClearMeters: 100000 };
    const anchors = [
      { itemId: 40, kind: "planet", position: P(4e6) },
      { itemId: 10, kind: "stargate", position: P(1e6) },
      { itemId: 30, kind: "station", position: P(3e6) },
      { itemId: 20, kind: "planet", position: P(2e6) },
      { itemId: 50, kind: "moon", position: P(5e6) },
    ];
    const scene = { anchors, usedAnchorIds: new Set([30]), blockers: [P(4e6 + 50000)], players: [P(1e6 + 400000)] };
    assert.deepStrictEqual(pickAnchor(scene, S, () => 0), { ok: true, anchor: { itemId: 20, kind: "planet" } });
    assert.deepStrictEqual(pickAnchor(scene, S, () => 0.99), { ok: true, anchor: { itemId: 50, kind: "moon" } });
    assert.deepStrictEqual(pickAnchor({ ...scene, anchors: [...anchors].reverse() }, S, () => 0.6).anchor.itemId, 50);
    assert.deepStrictEqual(pickAnchor({ ...scene, usedAnchorIds: new Set([20, 30, 50]) }, S, () => 0),
      { ok: false, reason: "NO_ANCHOR" });
    assert.deepStrictEqual(pickAnchor({ anchors: [] }, S, () => 0), { ok: false, reason: "NO_ANCHOR" });
  });

  test("AMB3 planAmbientGroup: friendly no order, hostile relation attacked, provoked friendly attacked, primary", () => {
    const S = { aggroRangeMeters: 150000, groupTtlMs: 1800000 };
    const group = (over = {}) => ({ provoked: new Set(), seenAggressedAt: new Map(), spawnedAt: 0, ...over });
    const ship = (entityId, over = {}) => ({ entityId, position: P(0), manualTargetId: 0, aggressorEntityId: 0,
      aggressedAtMs: 0, ...over });
    const pl = (characterId, entityId, x) => ({ characterId, entityId, position: P(x) });
    const rel = (map) => (c) => (c in map ? map[c] : null);

    const friendly = planAmbientGroup(group(), { ships: [ship(1)], players: [pl(7, 70, 1000)] }, rel({ 7: "friendly" }),
      S, 10);
    assert.deepStrictEqual([friendly.orders, friendly.attacks, friendly.relation], [[], [], "friendly"]);

    const hostile = planAmbientGroup(group(), { ships: [ship(1), ship(2)], players: [pl(7, 70, 1000)] },
      rel({ 7: "hostile" }), S, 10);
    assert.deepStrictEqual(hostile.orders, [{ entityId: 1, targetId: 70 }, { entityId: 2, targetId: 70 }]);
    assert.strictEqual(hostile.relation, "hostile");

    const shot = planAmbientGroup(group(), { ships: [ship(1, { aggressorEntityId: 70, aggressedAtMs: 5 })],
      players: [pl(7, 70, 1000)] }, rel({ 7: "friendly" }), S, 10);
    assert.deepStrictEqual([shot.attacks, shot.orders, shot.seen, shot.relation],
      [[7], [{ entityId: 1, targetId: 70 }], [[1, 5]], "hostile"]);
    const provoked = planAmbientGroup(group({ provoked: new Set([7]) }), { ships: [ship(1)],
      players: [pl(7, 70, 1000)] }, rel({ 7: "friendly" }), S, 10);
    assert.deepStrictEqual([provoked.orders, provoked.relation], [[{ entityId: 1, targetId: 70 }], "hostile"]);

    const mixed = planAmbientGroup(group(), { ships: [ship(1)], players: [pl(9, 90, 900000), pl(8, 80, 2000)] },
      rel({ 8: "friendly", 9: "neutral" }), S, 10);
    assert.strictEqual(mixed.relation, "friendly");
    const far = planAmbientGroup(group(), { ships: [ship(1)], players: [pl(9, 90, 900000), pl(8, 80, 800000)] },
      rel({ 8: "friendly", 9: "neutral" }), S, 10);
    assert.strictEqual(far.relation, "neutral");
  });

  test("AR-P planAmbientGroup.armed: all hostile, one friendly, provoked friend, unknown, empty, flag off", () => {
    const S = { aggroRangeMeters: 150000, groupTtlMs: 1800000, vendorAggroEnabled: true };
    const group = (over = {}) => ({ provoked: new Set(), seenAggressedAt: new Map(), spawnedAt: 0, ...over });
    const ships = [{ entityId: 1, position: P(0), manualTargetId: 0, aggressorEntityId: 0, aggressedAtMs: 0 }];
    const players = [{ characterId: 7, entityId: 70, position: P(1000) }];
    const rel = (map) => (c) => (c in map ? map[c] : null);
    const armed = (scene, map, g = group(), s = S) => planAmbientGroup(g, { ships, ...scene }, rel(map), s, 10).armed;
    assert.strictEqual(armed({ players, pilots: [9] }, { 7: "hostile", 9: "hostile" }), true, "all hostile");
    assert.strictEqual(armed({ players, pilots: [9] }, { 7: "hostile", 9: "friendly" }), false, "a friend docked");
    assert.strictEqual(armed({ players, pilots: [9] }, { 7: "hostile", 9: "neutral" }), false, "a neutral");
    assert.strictEqual(armed({ players, pilots: [9] }, { 7: "friendly", 9: "hostile" }, group({ provoked: new Set([7]) })),
      true, "a provoked friend is hostile");
    assert.strictEqual(armed({ players, pilots: [9] }, { 7: "hostile" }), false, "unknown relation (null)");
    assert.strictEqual(armed({ players: [], pilots: [] }, {}), null, "no pilot: no change");
    assert.strictEqual(armed({ players, pilots: [9] }, { 7: "hostile", 9: "hostile" }, group(),
      { ...S, vendorAggroEnabled: false }), null, "flag off");
    const scene = Object.freeze({ ships: Object.freeze([...ships]), players: Object.freeze([...players]),
      pilots: Object.freeze([9]) });
    const g = group();
    planAmbientGroup(g, scene, rel({ 7: "hostile", 9: "hostile" }), S, 10);
    assert.deepStrictEqual([g.provoked.size, g.seenAggressedAt.size, scene.pilots], [0, 0, [9]], "input not mutated");
  });

  test("AMB4 config: 31 keys, defaults, enabled false, bad CSV token / scope -> warning and default", () => {
    const keys = SCHEMA.filter((row) => row.key.startsWith("ambientRats.")).map((row) => row.key);
    assert.strictEqual(keys.length, 31);
    assert.strictEqual(DEFAULTS.enabled, false);
    assert.strictEqual(DEFAULTS.highsecNavy, false, "highsecNavy default");
    assert.strictEqual(DEFAULTS.vendorAggroEnabled, true, "vendorAggroEnabled default");
    assert.deepStrictEqual([DEFAULTS.bands, DEFAULTS.factionKinds, DEFAULTS.scope, DEFAULTS.anchorKinds],
      ["lowsec,nullsec", "pirate,empire,hive", "controlled", "stargate,station,planet"]);
    assert.deepStrictEqual([DEFAULTS.groupsHighsec, DEFAULTS.groupsLowsec, DEFAULTS.groupsNullsec,
      DEFAULTS.maxShipsPerGroup, DEFAULTS.maxGroupsGlobal, DEFAULTS.maxShipsGlobal, DEFAULTS.aggroRangeMeters,
      DEFAULTS.eligibilityCacheMs], [1, 2, 3, 5, 48, 200, 150000, 60000]);
    const clean = resolveConfig({ modDir: MOD_DIR, env: {} });
    assert.ok(!clean.warnings.some((w) => w.includes("AMBIENT_RATS") || w.includes("ambientRats.")),
      clean.warnings.join("\n"));
    const bad = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_AMBIENT_RATS_BANDS: "lowsec,wormhole",
      EVEJS_LNE_AMBIENT_RATS_ANCHOR_KINDS: "stargate,asteroidBelt", EVEJS_LNE_AMBIENT_RATS_FACTION_KINDS: "pirate,,hive",
      EVEJS_LNE_AMBIENT_RATS_SCOPE: "everywhere", EVEJS_LNE_AMBIENT_RATS_GROUPS_NULLSEC: "99" } });
    const a = bad.config.ambientRats;
    assert.deepStrictEqual([a.bands, a.anchorKinds, a.factionKinds, a.scope, a.groupsNullsec],
      ["lowsec,nullsec", "stargate,station,planet", "pirate,empire,hive", "controlled", 8]);
    for (const env of ["BANDS", "ANCHOR_KINDS", "FACTION_KINDS", "SCOPE"]) {
      assert.ok(bad.warnings.some((w) => w.includes(`EVEJS_LNE_AMBIENT_RATS_${env}`)), `${env}:\n${bad.warnings.join("\n")}`);
    }
    assert.deepStrictEqual(bad.errors, []);
  });

  test("AMB-HS1 decideEligibility highsec: off as before (also bands with highsec), on: empire ok, pirate / hive "
    + "HIGHSEC_PIRATE, Ammatar NO_SOURCE, police KIND_OFF, CONCORD flag true / unknown refused, lowsec unchanged", () => {
    const sys = (over) => ({ band: "highsec", eligible: true, controllerFactionId: 500001, homeFactionId: 500001,
      kind: "empire", ...over });
    const d = (over, s = {}, t = TABLES) => decideEligibility(sys(over), t, { ...DEFAULTS, ...s });
    assert.strictEqual(d({}).reason, "BAND_OFF");
    assert.strictEqual(d({ controllerFactionId: null }, { bands: "highsec,lowsec" }).reason, "NO_CONTROLLER");
    assert.strictEqual(d({ controllerFactionId: 500010, kind: "pirate" }, { bands: "highsec,lowsec" }).ok, true,
      "off + bands highsec: a pirate world controller still passes as before");
    const on = { highsecNavy: true };
    const T = { ...TABLES, concordGateAggroNpcs: false };
    assert.deepStrictEqual(d({ controllerSource: "sde" }, on, T), { ok: true, factionId: 500001, kind: "empire",
      band: "highsec", source: { type: "navy" }, groupsTarget: 1 });
    assert.strictEqual(d({ controllerFactionId: 500010, kind: "pirate" }, on, T).reason, "HIGHSEC_PIRATE");
    assert.strictEqual(d({ controllerFactionId: 500010, kind: "pirate" }, { ...on, factionKinds: "pirate,empire" }, T)
      .reason, "HIGHSEC_PIRATE");
    assert.strictEqual(d({ controllerFactionId: 500025, kind: "hive" }, on, T).reason, "HIGHSEC_PIRATE");
    assert.strictEqual(d({ controllerFactionId: 500007 }, on, T).reason, "NO_SOURCE");
    assert.strictEqual(d({ controllerFactionId: 500006, kind: "police" }, on, T).reason, "KIND_OFF");
    assert.strictEqual(d({}, on, { ...TABLES, concordGateAggroNpcs: true }).reason, "CONCORD_AGGRO_NPC");
    assert.strictEqual(d({}, on, { ...TABLES, concordGateAggroNpcs: null }).reason, "CONCORD_AGGRO_NPC");
    assert.strictEqual(d({}, on, TABLES).reason, "CONCORD_AGGRO_NPC", "absent = unknown");
    const low = { band: "lowsec", controllerFactionId: 500001, kind: "empire" };
    assert.deepStrictEqual(d(low, on, T), d(low));
  });

  test("AMB-HS2 resolveEmpireFaction: own, CONCORD -> constellation (Jita), constellation CONCORD -> region "
    + "(Sanctum), tie lowest, NO_FACTION, NO_SYSTEM, graph without methods", () => {
    const graphOf = (rows) => {
      const sys = new Map(Object.entries(rows).map(([id, [f, c, r]]) => [Number(id), { factionId: f, constellationId: c,
        regionId: r }]));
      const by = (i) => (key) => [...sys].filter(([, v]) => [v.factionId, v.constellationId, v.regionId][i] === key)
        .map(([id]) => id);
      return { getSystem: (id) => sys.get(id) || null, getSystemsInConstellation: by(1),
        getSystemsInRegion: by(2) };
    };
    const X = [500006];
    assert.deepStrictEqual(resolveEmpireFaction(graphOf({ 1: [500002, 10, 100] }), 1, X),
      { ok: true, factionId: 500002, source: "system" });
    const jita = graphOf({ 1: [500006, 10, 100], 2: [500001, 10, 100], 3: [500001, 10, 100], 4: [500001, 10, 100],
      5: [500006, 10, 100], 6: [500002, 11, 100] });
    assert.deepStrictEqual(resolveEmpireFaction(jita, 1, X), { ok: true, factionId: 500001, source: "constellation" });
    const sanctum = graphOf({ 1: [500006, 20, 200], 2: [500006, 20, 200], 3: [500003, 21, 200], 4: [500003, 21, 200],
      5: [500003, 22, 200], 6: [500003, 22, 200], 7: [500003, 22, 200], 8: [500004, 23, 200], 9: [500004, 23, 200] });
    assert.deepStrictEqual(resolveEmpireFaction(sanctum, 1, X), { ok: true, factionId: 500003, source: "region" });
    const tie = graphOf({ 1: [0, 10, 100], 2: [500004, 10, 100], 3: [500004, 10, 100], 4: [500001, 10, 100],
      5: [500001, 10, 100] });
    assert.deepStrictEqual(resolveEmpireFaction(tie, 1, X), { ok: true, factionId: 500001, source: "constellation" });
    const none = graphOf({ 1: [0, 10, 100], 2: [500006, 10, 100], 3: [0, 11, 100] });
    assert.deepStrictEqual(resolveEmpireFaction(none, 1, X), { ok: false, reason: "NO_FACTION" });
    assert.deepStrictEqual(resolveEmpireFaction(jita, 99, X), { ok: false, reason: "NO_SYSTEM" });
    assert.deepStrictEqual(resolveEmpireFaction({}, 1, X), { ok: false, reason: "NO_SYSTEM" });
    assert.deepStrictEqual(resolveEmpireFaction(null, 1, X), { ok: false, reason: "NO_SYSTEM" });
    const throwing = { getSystem: () => ({ factionId: 500006, constellationId: 10, regionId: 100 }),
      getSystemsInConstellation: () => { throw new Error("x"); } };
    assert.deepStrictEqual(resolveEmpireFaction(throwing, 1, X), { ok: false, reason: "NO_FACTION" });
  });

  test("AMB-HS3 planAmbientGroup passive: a hostile standing gives no target, no red, armed null; an attacker is "
    + "still ordered and hostile, armed null", () => {
    const S = { aggroRangeMeters: 150000, groupTtlMs: 1800000, vendorAggroEnabled: true, passive: true };
    const group = (over = {}) => ({ provoked: new Set(), seenAggressedAt: new Map(), spawnedAt: 0, ...over });
    const ships = [{ entityId: 1, position: P(0), manualTargetId: 0, aggressorEntityId: 0, aggressedAtMs: 0 }];
    const players = [{ characterId: 7, entityId: 70, position: P(1000) }];
    const hostile = () => "hostile";
    const calm = planAmbientGroup(group(), { ships, players, pilots: [7] }, hostile, S, 10);
    assert.deepStrictEqual([calm.orders, calm.attacks, calm.armed], [[], [], null]);
    assert.notStrictEqual(calm.relation, "hostile");
    const angry = planAmbientGroup(group({ provoked: new Set([7]) }), { ships, players, pilots: [7] }, hostile, S, 10);
    assert.deepStrictEqual([angry.orders, angry.relation, angry.armed], [[{ entityId: 1, targetId: 70 }], "hostile",
      null]);
    assert.strictEqual(planAmbientGroup(group(), { ships, players, pilots: [7] }, hostile,
      { ...S, passive: undefined }, 10).armed, true);
  });
};
