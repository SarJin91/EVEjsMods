"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const { REGISTRY_DATA_V1, createFactionRegistry } = require("../../lib/strategy/registry");
const { enabledFlagsOf } = require("../../lib/strategy");
const { HULL_GROUPS, FLEET_ROLES, OPERATION_TYPES } = require("../../lib/fleets/schema");
const { createHostility } = require("../../lib/battle/data/hostility");
const P = require("../../lib/world/invasions/rollPlanner");
const { PROFILES, tagOf, INVADER_PROFILES_VERSION } = require("../../lib/world/invasions/data/invaderProfiles");
const { createInvasionService, getProfiles } = require("../../lib/world/invasions/invasionService");
const { HULL_CLASS_BY_GROUP } = require("../../lib/adapter/data/liveProfiles");
const { INVADER_LIVE_PROFILES } = require("../../lib/adapter/data/invaderLiveProfiles");
const { createRng } = require("../../lib/util/rng");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const REPO_ROOT = path.resolve(MOD_DIR, "..", "..");
const CATALOG = path.join(REPO_ROOT, "server", "src", "space", "npc", "trigDrifter", "trigDrifterNpcCatalog.js");
const COMPOSE = path.join(REPO_ROOT, "compose.yaml");
const DRIFTERS = 500024;

function configOf(env = {}) {
  const r = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(), ...env } });
  assert.deepStrictEqual(r.errors || [], []);
  return r;
}

function registryOf(enabledFlags) {
  return createFactionRegistry(REGISTRY_DATA_V1, { hullGroups: HULL_GROUPS, fleetRoles: FLEET_ROLES,
    operationTypes: OPERATION_TYPES, hostility: createHostility(), maxFactions: 64, maxCampaignSystems: 40,
    maxShipsPerFleet: 500, maxCompositionEntries: 32, maxResourceUnits: 1000000000, enabledFlags });
}

const drifterProfile = () => PROFILES.find((p) => p.profileId === "drifter-wormhole-v1");

module.exports = ({ test, skip }) => {
  test("TDI1 flag off: 500024 not active, the roll with the Drifter eligible:false = the roll without it", () => {
    const built = registryOf([]);
    assert.ok(built.ok, JSON.stringify(built));
    assert.strictEqual(built.registry.isActive(DRIFTERS), false);
    const real = getProfiles(built.registry);
    assert.deepStrictEqual(real.filter((p) => !p.eligible).map((p) => p.profileId), ["drifter-wormhole-v1"]);
    assert.strictEqual(INVADER_PROFILES_VERSION, 7);
    assert.strictEqual(PROFILES[PROFILES.length - 1].profileId, "drifter-wormhole-v1");
    const entry = (systemId, c) => ({ systemId, row: { occupationState: "STABLE", controllerFactionId: c },
      liveStations: 0, observed: false, claimed: false, inTheatre: false, openBeachhead: false, core: false,
      category: P.controllerCategoryOf(c, built.registry) });
    const base = PROFILES.filter((p) => p.factionId !== DRIFTERS)
      .map((p) => ({ ...p, eligible: true }));
    const withDrifter = [...base, { ...drifterProfile(), eligible: false }];
    const params = { chancePermille: 1000, maxActive: 3, maxActivePerFaction: 1, weightFree: 3, weightActive: 100,
      weightControlled: 1, avoidObservedSystems: true, avoidStationSystems: true, avoidCampaignTheatres: true,
      requireSovCheck: true, beachheadCaptureRangeJumps: 3 };
    const snap = (profiles) => ({ round: 7, rollSeed: 41, sampleSeed: 42, openTotal: 0, openByFaction: new Map(),
      profiles, sampled: [entry(30000001, null), entry(30000002, 500001), entry(30000003, null)], stationsReady: true });
    for (const seed of [1, 41, 977]) {
      const a = P.planRoll(snap(withDrifter), params, createRng(seed));
      const b = P.planRoll(snap(base), params, createRng(seed));
      assert.deepStrictEqual(a, b, `seed ${seed}`);
      assert.strictEqual(a.outcome, "SPAWN", JSON.stringify(a));
    }
  });

  test("TDI2 flag on: registry ok, 500024 active invader on drifter-invader-v1, profile eligible facts true", () => {
    const built = registryOf(["drifters"]);
    assert.ok(built.ok, JSON.stringify(built));
    const { registry } = built;
    assert.strictEqual(registry.isActive(DRIFTERS), true);
    const f = registry.getFaction(DRIFTERS);
    assert.strictEqual(f.kind, "invader");
    assert.strictEqual(f.doctrineId, "drifter-invader-v1");
    assert.strictEqual(f.hqSystemId, null);
    assert.deepStrictEqual(f.startStations, []);
    const d = registry.getDoctrine("drifter-invader-v1");
    assert.strictEqual(d.kind, "invader");
    assert.deepStrictEqual(d.operationTypes, ["recon", "invasion"]);
    assert.strictEqual(d.templates.garrison.some((e) => e.hullGroup === "battleship"), false);
    assert.strictEqual(d.templates.invasion.some((e) => e.hullGroup === "battleship"), false);
    assert.ok(f.kind === "invader" && registry.isActive(drifterProfile().factionId));
    assert.strictEqual(tagOf("drifter-wormhole-v1"), "DRF");
    assert.deepStrictEqual(enabledFlagsOf({ invasions: { drifters: { enabled: true } } }), ["drifters"]);
    assert.deepStrictEqual(enabledFlagsOf({ hive: { enabled: true }, invasions: { drifters: { enabled: false } } }),
      ["hive"]);
  });

  test("TDI3 config: default off / 72 h, env switch on, warning without modules.strategy", () => {
    const def = configOf();
    assert.strictEqual(def.config.invasions.drifters.enabled, false);
    assert.strictEqual(def.config.invasions.drifterWithdrawAfterMs, 259200000);
    assert.ok(!def.warnings.some((w) => w.includes("Drifters do not play")));
    const on = configOf({ EVEJS_LNE_INVASIONS_DRIFTERS_ENABLED: "1" });
    assert.strictEqual(on.config.invasions.drifters.enabled, true);
    assert.ok(!on.warnings.some((w) => w.includes("Drifters do not play")), on.warnings.join("\n"));
    const noStrategy = configOf({ EVEJS_LNE_INVASIONS_DRIFTERS_ENABLED: "1", EVEJS_LNE_STRATEGY_ENABLED: "0" });
    assert.ok(noStrategy.warnings.some((w) => w.includes("Drifters do not play")), noStrategy.warnings.join("\n"));
  });

  if (!fs.existsSync(CATALOG) || !fs.existsSync(COMPOSE)) {
    skip("TDI4 vendor fact + compose", "server/src or compose.yaml not found");
  } else {
    test("TDI4 doctrine hull groups have Drifter LIVE profiles of real vendor variants; 3 compose lines", () => {
      const table = INVADER_LIVE_PROFILES[DRIFTERS];
      const built = registryOf(["drifters"]);
      assert.ok(built.ok, JSON.stringify(built));
      const d = built.registry.getDoctrine("drifter-invader-v1");
      for (const [role, entries] of Object.entries(d.templates)) {
        for (const e of entries) {
          const cls = HULL_CLASS_BY_GROUP[e.hullGroup];
          assert.ok(cls && typeof table[cls] === "string", `${role}.${e.hullGroup} -> ${cls}`);
        }
      }
      const src = fs.readFileSync(CATALOG, "utf8").replace(/\r\n/g, "\n");
      assert.match(src, /function getDrifterProfileID\(variant\) \{\n {2}return `parity_drifter_\$\{variant\.key\}`;/);
      assert.match(src, /const DRIFTER_FACTION_ID = 500024;/);
      for (const profileId of new Set(Object.values(table))) {
        const key = profileId.slice("parity_drifter_".length);
        assert.ok(src.includes(`key: "${key}"`), `vendor variant key ${key}`);
      }
      const compose = fs.readFileSync(COMPOSE, "utf8").replace(/\r\n/g, "\n");
      for (const line of [
        "EVEJS_LNE_INVASIONS_DRIFTERS_ENABLED: ${EVEJS_LNE_INVASIONS_DRIFTERS_ENABLED:-0}",
        "EVEJS_LNE_INVASIONS_DRIFTER_WITHDRAW_AFTER_MS: ${EVEJS_LNE_INVASIONS_DRIFTER_WITHDRAW_AFTER_MS:-}",
        "EVEJS_LNE_MATERIALIZATION_INVADER_PROFILES_ENABLED: ${EVEJS_LNE_MATERIALIZATION_INVADER_PROFILES_ENABLED:-0}",
      ]) {
        assert.ok(compose.split("\n").some((l) => l.trim() === line), line);
      }
    });
  }

  test("TDI5 withdrawal of a Drifter row = started_at + drifterWithdrawAfterMs; no key -> none, no throw", () => {
    const { config } = configOf();
    const row = { withdraw_at: null, started_at: 1000, profile_id: "drifter-wormhole-v1" };
    const svc = createInvasionService({ config, coreIndex: { systems: new Set() } });
    assert.strictEqual(svc.effectiveWithdrawAtOf(row), 1000 + 259200000);
    const { drifterWithdrawAfterMs: _drop, ...rest } = config.invasions;
    const bare = createInvasionService({ config: { ...config, invasions: rest }, coreIndex: { systems: new Set() } });
    assert.strictEqual(bare.effectiveWithdrawAtOf(row), null);
    assert.strictEqual(bare.effectiveWithdrawAtOf({ ...row, withdraw_at: 5000 }), 5000);
  });
};
