"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const { HULL_GROUPS } = require("../../lib/fleets/schema");
const { FACTION_KINDS: REGISTRY_KINDS } = require("../../lib/strategy/registry");
const { createRng } = require("../../lib/util/rng");
const { MIGRATIONS, LATEST_SCHEMA_VERSION, validateMigrations } = require("../../lib/persistence/migrations");
const S = require("../../lib/heavyEvents/schema");
const C = require("../../lib/heavyEvents/catalog");
const { canTransition, decidePlanned, decideEngaged, abandonTargetOf } = require("../../lib/heavyEvents/machine");
const { fleetPowerOf, scaleStepsOf, membersOfPhase } = require("../../lib/heavyEvents/scale");
const { chooseCandidate } = require("../../lib/heavyEvents/candidates");
const { loadDriver } = require("../notices/storeHelper");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const config = (env = {}) => resolveConfig({ modDir: MOD_DIR, env });
const DEFAULTS = config().config.heavyEvents;

module.exports = ({ test, skip }) => {
  test("HE1 machine: edges, refusals, decideEngaged NEXT_PHASE / CLEAR / ABANDON / HOLD / FAIL", () => {
    assert.deepStrictEqual(canTransition("PLANNED", "ENGAGED"), { ok: true });
    assert.deepStrictEqual(canTransition("ENGAGED", "ENGAGED"), { ok: true });
    assert.deepStrictEqual(canTransition("CLEARED", "COMPLETED"), { ok: true });
    assert.strictEqual(canTransition("PLANNED", "CLEARED").reason, "TRANSITION_NOT_ALLOWED");
    assert.strictEqual(canTransition("COMPLETED", "PLANNED").reason, "TRANSITION_NOT_ALLOWED");
    assert.strictEqual(canTransition("CLEARED", "FAILED").reason, "TRANSITION_NOT_ALLOWED");
    assert.strictEqual(canTransition("ACTIVE", "PLANNED").reason, "UNKNOWN_STATE");

    const T0 = 1000000;
    const cfg = { engagedMaxMs: DEFAULTS.engagedMaxMs, abandonGraceMs: DEFAULTS.abandonGraceMs,
      defenseWaves: DEFAULTS.defenseWaves, waveGrowthPermille: DEFAULTS.waveGrowthPermille, maxAbandons: 3 };
    const row = (over) => ({ eventType: "redoubt", tier: 1, state: "ENGAGED", phase: 1, engagedAt: T0,
      expiresAt: T0 + 1, dueAt: null, abandons: 0, integrity: null, ...over });
    const facts = (over) => ({ now: T0 + 60000, sceneLoaded: true, gridPlayers: 2, phaseAlive: 3,
      phaseDestroyedNow: 0, lastGridSeenAt: T0 + 60000, ...over });
    assert.deepStrictEqual(decideEngaged(row(), facts({ phaseAlive: 0, phaseDestroyedNow: 2 }), cfg),
      { action: "NEXT_PHASE", reason: "PHASE_WIPED" });
    assert.deepStrictEqual(decideEngaged(row({ phase: 2 }), facts({ phaseAlive: 0 }), cfg), { action: "CLEAR" });
    assert.deepStrictEqual(decideEngaged(row(), facts(), cfg), { action: "HOLD" });
    const away = (sinceMs) => facts({ gridPlayers: 0, now: T0 + 400000, lastGridSeenAt: T0 + 400000 - sinceMs });
    assert.deepStrictEqual(decideEngaged(row(), away(cfg.abandonGraceMs), cfg), { action: "ABANDON", reason: "NO_PLAYER" });
    assert.deepStrictEqual(decideEngaged(row(), away(cfg.abandonGraceMs - 1), cfg),
      { action: "HOLD", reason: "NO_PLAYER_GRACE" });
    assert.strictEqual(decideEngaged(row({ phase: 2 }), { ...away(cfg.abandonGraceMs), phaseAlive: 0 }, cfg).action,
      "ABANDON");
    assert.deepStrictEqual(decideEngaged(row(), facts({ now: T0 + cfg.engagedMaxMs, phaseAlive: 0 }), cfg),
      { action: "FAIL", reason: "TIMEOUT" });
    assert.deepStrictEqual(decideEngaged(row(), facts({ sceneLoaded: false }), cfg),
      { action: "ABANDON", reason: "SCENE_GONE" });
    const def = (over) => row({ eventType: "defense", integrity: 500, ...over });
    assert.deepStrictEqual(decideEngaged(def(), facts({ integrity: 0 }), cfg), { action: "FAIL", reason: "INTEGRITY" });
    assert.deepStrictEqual(decideEngaged(def({ dueAt: T0 }), facts(), cfg), { action: "NEXT_PHASE", reason: "WAVE_DUE" });
    assert.deepStrictEqual(decideEngaged(def({ phase: 4, dueAt: T0 }), facts({ phaseAlive: 0 }), cfg),
      { action: "CLEAR" });
    assert.deepStrictEqual(decidePlanned({ ...row(), state: "PLANNED" }, { now: T0 + 1, siteActive: true,
      gridPlayers: 1, sceneLoaded: true, causeHolds: true }), { action: "EXPIRE", reason: "EXPIRED" });
    assert.deepStrictEqual([abandonTargetOf(row({ abandons: 1 }), cfg), abandonTargetOf(row({ abandons: 2 }), cfg)],
      ["PLANNED", "EXPIRED"]);
  });

  test("HE2 scaleStepsOf: monotonic, capped, copy weight; membersOfPhase", () => {
    const cfg = { maxUpscaleSteps: 3, shipsPerUpscaleStep: 3, copyWeightPermille: 500 };
    const tier = { fleetSize: 3 };
    assert.deepStrictEqual([0, 3, 4, 6, 7, 9, 10, 100].map((p) => scaleStepsOf(p, tier, 0, cfg)),
      [0, 0, 1, 1, 2, 2, 3, 3]);
    assert.strictEqual(scaleStepsOf(0, tier, 2, cfg), 2);
    let prev = 0;
    for (const p of [5, 2, 9, 1, 30, 0]) {
      const next = scaleStepsOf(p, tier, prev, cfg);
      assert.ok(next >= prev && next <= cfg.maxUpscaleSteps, `${p}: ${prev} -> ${next}`);
      prev = next;
    }
    assert.strictEqual(fleetPowerOf({ players: 3, copies: 2 }, cfg), 4);
    assert.strictEqual(scaleStepsOf(fleetPowerOf({ players: 3, copies: 2 }, cfg), tier, 0, cfg), 1);
    assert.strictEqual(scaleStepsOf(fleetPowerOf({ players: 3, copies: 2 }, { copyWeightPermille: 0 }), tier, 0, cfg), 0);
    assert.strictEqual(scaleStepsOf(9, tier, 0, { ...cfg, maxUpscaleSteps: 0 }), 0);

    const built = C.membersOf("redoubt", 1, 3);
    assert.ok(built.ok);
    const members = built.members.map((m) => (m.key === "p1:0" ? { ...m, state: "DESTROYED" } : m));
    const r = { members };
    assert.strictEqual(membersOfPhase(r, 1, 0).length, 6);
    assert.deepStrictEqual(membersOfPhase(r, 1, 2).map((m) => m.key).filter((k) => k.startsWith("u")),
      ["u1:0", "u1:1", "u2:0", "u2:1"]);
    assert.deepStrictEqual(membersOfPhase({ members_json: JSON.stringify(members) }, 2, 0).map((m) => m.hullGroup),
      ["battlecruiser", "battlecruiser", "battleship"]);
  });

  test("HE3 catalogue: groups in HULL_GROUPS, no fighter capitals, maxComposition <= maxShipsPerEvent", () => {
    const groups = C.catalogHullGroups();
    assert.deepStrictEqual(groups.filter((name) => !HULL_GROUPS.includes(name)), []);
    assert.deepStrictEqual(groups.filter((name) => C.EXCLUDED_GROUPS.includes(name)), []);
    assert.deepStrictEqual([...S.FACTION_KINDS], [...REGISTRY_KINDS]);
    const waves = { defenseWaves: DEFAULTS.defenseWaves, waveGrowthPermille: DEFAULTS.waveGrowthPermille };
    const totals = {};
    for (const type of S.TYPES) {
      for (let tier = 1; tier <= C.tierCountOf(type); tier += 1) {
        const max = C.maxComposition(type, tier, DEFAULTS.maxUpscaleSteps, waves);
        assert.ok(max.ok, `${type} ${tier}`);
        assert.strictEqual(C.membersOf(type, tier, DEFAULTS.maxUpscaleSteps, waves).members.length, max.total);
        totals[`${type}${tier}`] = max.total;
        if (type !== "defense") {
          assert.ok(max.total <= DEFAULTS.maxShipsPerEvent, `${type} ${tier}: ${max.total}`);
        } else {
          const p = C.phasesOf(type, tier, waves);
          const scaling = DEFAULTS.maxUpscaleSteps * C.tierDefOf(type, tier).def.scaling.length;
          for (const wave of p.phases) {
            assert.ok(wave.reduce((a, x) => a + x.count, 0) + scaling <= DEFAULTS.maxShipsPerEvent, type);
          }
        }
      }
    }
    assert.deepStrictEqual(totals, { redoubt1: 16, redoubt2: 24, redoubt3: 25, foundry1: 18, foundry2: 22,
      defense1: 40 });
    assert.deepStrictEqual(C.phasesOf("defense", 1, waves).phases.map((w) => w.reduce((a, x) => a + x.count, 0)),
      [6, 8, 11, 12]);
    assert.strictEqual(C.maxComposition("defense", 1, 3).reason, "INVALID_PARAMS");
    assert.strictEqual(C.maxComposition("redoubt", 4, 3).reason, "UNKNOWN_TIER");
    assert.deepStrictEqual([C.substituteOf("dreadnought"), C.substituteOf("battleship"), C.substituteOf("cruiser")],
      ["battleship", "battlecruiser", null]);
  });

  test("HE4 chooseCandidate: deterministic, tier lowered by stock, reason rank; config defaults and cross check", () => {
    const NOW = 50 * 86400000;
    const tier1 = C.maxComposition("redoubt", 1, DEFAULTS.maxUpscaleSteps).composition;
    const stockOf = (comp) => Object.fromEntries(comp.map((x) => [x.hullGroup, x.count]));
    const big = Object.fromEntries(HULL_GROUPS.map((name) => [name, 99]));
    const station = (stationId, factionId, hullStock) => ({ stationId, factionId, state: "ONLINE", hullStock,
      mineralUnits: 0 });
    const sys = (systemId, band, factionId, hullStock) => ({ systemId, band, controllerFactionId: factionId,
      controllerKind: "pirate", stations: [station(`st${systemId}`, factionId, hullStock)], occupation: null });
    const facts = { now: NOW, open: [], lastEndedAt: new Map(), systems: [sys(30000003, "nullsec", 500010, big),
      sys(30000001, "lowsec", 500011, big), sys(30000002, "highsec", 500012, big)] };
    const cfg = { ...DEFAULTS, foundryEnabled: false, defenseEnabled: false };
    const a = chooseCandidate(facts, cfg, createRng(77));
    const b = chooseCandidate(facts, cfg, createRng(77));
    assert.ok(a.ok, JSON.stringify(a));
    assert.deepStrictEqual(a, b);
    assert.notStrictEqual(a.candidate.systemId, 30000002);
    const small = { ...facts, systems: [sys(30000001, "lowsec", 500011, stockOf(tier1))] };
    const low = chooseCandidate(small, { ...cfg, tierWeights: "0,0,1" }, createRng(5));
    assert.deepStrictEqual([low.ok, low.candidate.tier, low.candidate.funded], [true, 1, true]);
    assert.strictEqual(chooseCandidate({ ...small, systems: [sys(30000001, "lowsec", 500011, big)] },
      { ...cfg, tierWeights: "0,0,1" }, createRng(5)).candidate.tier, 3);
    const busy = { ...facts, open: [{ systemId: 30000001, factionId: 1, eventType: "redoubt", state: "COMPLETED" },
      { systemId: 30000003, factionId: 1, eventType: "redoubt", state: "COMPLETED" }] };
    assert.deepStrictEqual(chooseCandidate(busy, cfg, createRng(1)), { ok: false, reason: "BUSY" });
    assert.deepStrictEqual(chooseCandidate({ ...small, systems: [sys(30000001, "lowsec", 500011, { cruiser: 99 })] },
      cfg, createRng(1)), { ok: false, reason: "NO_STOCK" });
    const full = { ...facts, open: [1, 2, 3].map((i) => ({ systemId: i, factionId: i, eventType: "redoubt",
      state: "PLANNED" })) };
    assert.deepStrictEqual(chooseCandidate(full, cfg, createRng(1)), { ok: false, reason: "LIMIT" });

    assert.strictEqual(DEFAULTS.enabled, false);
    assert.deepStrictEqual([DEFAULTS.securityBands, DEFAULTS.factionKinds, DEFAULTS.tierWeights, DEFAULTS.maxOpen,
      DEFAULTS.maxOpenPerFaction, DEFAULTS.planIntervalMs, DEFAULTS.systemCooldownMs],
    ["lowsec,nullsec", "pirate,invader,hive", "50,35,15", 3, 1, 3600000, 86400000]);
    assert.ok(!config().warnings.some((w) => w.includes("heavyEvents") || w.includes("HEAVY_EVENTS")));
    const bad = config({ EVEJS_LNE_HEAVY_EVENTS_LEASH_RANGE_M: "20000", EVEJS_LNE_HEAVY_EVENTS_TIER_WEIGHTS: "0,0,0" });
    assert.deepStrictEqual([bad.config.heavyEvents.leashRangeM, bad.config.heavyEvents.aggroRangeM,
      bad.config.heavyEvents.tierWeights], [150000, 100000, "50,35,15"]);
    assert.ok(bad.warnings.some((w) => w.startsWith("heavyEvents.leashRangeM=20000 below")), bad.warnings.join("\n"));
    assert.ok(bad.warnings.some((w) => w.includes("EVEJS_LNE_HEAVY_EVENTS_TIER_WEIGHTS")), bad.warnings.join("\n"));
    assert.deepStrictEqual(bad.errors, []);
  });

  const driver = loadDriver();
  if (!driver.ok) {
    skip("HE5 migration world_heavy_events", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }
  test("HE5 migration 64 on :memory:: table, indexes, partial index used by WHERE open = 1 AND system_id = ?", () => {
    const m = MIGRATIONS.find((x) => x.version === 64);
    assert.deepStrictEqual([m.name, m.up === S.upHeavyEvents], ["world_heavy_events", true]);
    assert.ok(LATEST_SCHEMA_VERSION >= 64);
    assert.ok(validateMigrations(MIGRATIONS).ok);
    const db = new driver.Database(":memory:");
    try {
      S.upHeavyEvents(db);
      const names = db.prepare("SELECT name FROM sqlite_master WHERE tbl_name = 'world_heavy_events' "
        + "AND type = 'index' AND name NOT LIKE 'sqlite_autoindex%' ORDER BY name").all().map((r) => r.name);
      assert.deepStrictEqual(names, ["world_heavy_events_ended", "world_heavy_events_open_faction",
        "world_heavy_events_open_system"]);
      const plan = db.prepare("EXPLAIN QUERY PLAN SELECT event_id FROM world_heavy_events WHERE open = 1 "
        + "AND system_id = ?").all(30000001).map((r) => r.detail).join(" | ");
      assert.ok(plan.includes("world_heavy_events_open_system"), plan);
      assert.throws(() => db.prepare("INSERT INTO world_heavy_events (event_id, plan_key, event_type, tier, system_id, "
        + "faction_id, state, open, members_json, seed, created_at, expires_at, updated_at) "
        + "VALUES ('hev:1:0', '3600000:1:0', 'redoubt', 4, 1, 1, 'PLANNED', 1, '[]', 1, 0, 1, 0)").run());
    } finally {
      db.close();
    }
  });
};
