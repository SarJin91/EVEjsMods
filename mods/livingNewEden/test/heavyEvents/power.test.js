"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const { HULL_GROUPS } = require("../../lib/fleets/schema");
const { createRng, deriveSeed } = require("../../lib/util/rng");
const P = require("../../lib/heavyEvents/power/schema");
const C = require("../../lib/heavyEvents/power/catalog");
const { choosePower, labelOf } = require("../../lib/heavyEvents/power/choose");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const config = (env = {}) => resolveConfig({ modDir: MOD_DIR, env });
const BASE = config().config;
const STEPS = BASE.heavyEvents.maxUpscaleSteps;
const cfgOf = (over = {}) => ({ ...BASE.powerSites, maxUpscaleSteps: STEPS, ...over });
const rngOf = (n) => createRng(deriveSeed(7, "hpw", `pw:1800000:${n}:0`));

const NOW = 1000000000;
const FAT = Object.freeze({ frigate: 50, destroyer: 50, cruiser: 50, battlecruiser: 50, battleship: 50, logistics: 50,
  ewar: 50, tackle: 50, industrial: 50 });
const station = (stationId, hullStock = FAT, over = {}) => ({ stationId, state: "ONLINE", hullStock,
  mineralUnits: 1000000, ...over });
const sys = (systemId, factionId, over = {}) => ({ systemId, band: "nullsec", controllerFactionId: factionId,
  controllerKind: "pirate", ...over });
const factsOf = (systems, factions, over = {}) => ({ now: NOW, systems, factions: new Map(factions), open: [],
  lastPowerEndedAt: new Map(), ...over });

module.exports = ({ test }) => {
  test("PWS1 catalogue: member keys, HULL_GROUPS only, maxComposition = members <= maxShipsPerEvent, names", () => {
    const cfg = BASE.powerSites;
    const cap = cfg.maxShipsPerEvent;
    for (const type of P.POWER_TYPES) {
      assert.ok(type.length <= 16, type);
      assert.deepStrictEqual(Object.keys(C.TIERS[type]).sort(), [...P.VARIANTS[type]].sort(), type);
      for (const variant of P.VARIANTS[type]) {
        assert.ok(variant.length <= 16, variant);
        for (let tier = 1; tier <= P.TIER_COUNT; tier += 1) {
          const where = `${type}/${variant}/${tier}`;
          const r = C.phasesOf(type, tier, variant, cfg);
          const m = C.membersOf(type, tier, variant, STEPS, cfg);
          const max = C.maxComposition(type, tier, variant, STEPS, cfg);
          assert.ok(r.ok && m.ok && max.ok, where);
          assert.strictEqual(m.members.length, max.total, where);
          assert.strictEqual(new Set(m.members.map((x) => x.key)).size, m.members.length, `${where} unique keys`);
          for (const x of m.members) {
            assert.ok(HULL_GROUPS.includes(x.hullGroup) && !C.EXCLUDED_GROUPS.includes(x.hullGroup), where);
            assert.match(x.key, x.phase === null ? new RegExp(`^u${x.step}:\\d+$`) : new RegExp(`^p${x.phase}:\\d+$`));
            if (x.role !== undefined) assert.ok(P.ROLES.includes(x.role), where);
          }
          const scaling = r.def.scaling.reduce((a, x) => a + x.count, 0) * STEPS;
          if (type === P.TYPE.MUSTER) {
            assert.strictEqual(r.phases.length, cfg.musterWaves + tier - 1, where);
            for (const wave of r.phases) assert.ok(wave.reduce((a, x) => a + x.count, 0) + scaling <= cap, where);
          } else {
            assert.ok(max.total <= cap, `${where}: ${max.total}`);
          }
          assert.strictEqual(C.pocketOfPhase(type, tier, variant, r.phases.length, cfg), r.pockets.length - 1, where);
        }
      }
    }
    assert.strictEqual(C.pocketCountOf("trail", 1, "courier", cfg), cfg.trailPockets);
    assert.deepStrictEqual([0, 1, 2].map((k) => C.visibilityOfPocket("trail", 1, "courier", k, cfg)),
      ["anomaly", "signature", "signature"]);
    assert.strictEqual(C.visibilityOfPocket("cache", 1, "guard", 0), "signature");
    assert.strictEqual(C.visibilityOfPocket("outpost", 1, "brawl", 1), null);
    assert.ok(C.membersOf("hunt", 1, "guarded", 0).members.some((x) => x.role === "objective"));
    assert.strictEqual(C.membersOf("convoy", 2, "light", 0).members.filter((x) => x.role === "hauler").length, 4);
    assert.strictEqual(C.tierDefOf("redoubt", 1, "brawl").reason, "UNKNOWN_TYPE");
    assert.strictEqual(C.tierDefOf("outpost", 3, "brawl").reason, "UNKNOWN_TIER");
    assert.strictEqual(C.phasesOf("trail", 1, "courier", {}).reason, "INVALID_PARAMS");
    assert.strictEqual(P.eventIdOf(12, 1), "hpw:12:1");
    assert.strictEqual(P.planKeyOf(1800000, 12, 1), "pw:1800000:12:1");
    assert.strictEqual(P.rewardKeyOf(20, 30000001, "hpw:12:1"), "hpwrwd:20:30000001:hpw:12:1");
    assert.strictEqual(labelOf("Guristas Pirates", "outpost", "reinforced"), "Guristas Pirates Reinforced Lookout Nest");
    assert.strictEqual(labelOf("Guristas Pirates", "cache", "none"), "Guristas Pirates Buried Stash");
    const long = labelOf("X".repeat(50), "hunt", "fleeting");
    assert.ok(long.length <= P.LABEL_MAX && long.endsWith(" Marked Commander") && !long.includes("Fleeting"), long);
    assert.ok(P.POWER_COUNTER_NAMES.includes("power.refused.BUSY") && P.POWER_COUNTER_NAMES.includes("power.affix.rich"));
  });

  test("PWS2 choosePower deterministic, a system without a station is a candidate, fundFromStock false", () => {
    const facts = () => factsOf([sys(30000001, 500010)], [[500010, { stations: [station("st-b"), station("st-a")] }]]);
    const a = choosePower(facts(), cfgOf(), rngOf(1));
    const b = choosePower(facts(), cfgOf(), rngOf(1));
    assert.ok(a.ok, JSON.stringify(a));
    assert.deepStrictEqual(a, b);
    const c = a.candidate;
    assert.strictEqual(c.systemId, 30000001);
    assert.strictEqual(c.factionId, 500010);
    assert.ok(P.POWER_TYPES.includes(c.eventType) && P.VARIANTS[c.eventType].includes(c.variant));
    assert.ok(P.AFFIXES.includes(c.affix) && c.tier >= 1 && c.tier <= 2 && c.ttlMs > 0);
    assert.strictEqual(c.stationId, "st-a");
    assert.strictEqual(c.funded, true);
    assert.strictEqual(c.total, C.maxComposition(c.eventType, c.tier, c.variant, STEPS, cfgOf()).total);
    const big = { ...FAT, frigate: 500 };
    const r = choosePower(factsOf([sys(30000001, 500010)],
      [[500010, { stations: [station("st-a"), station("st-z", big)] }]]), cfgOf(), rngOf(1));
    assert.strictEqual(r.candidate.stationId, "st-z");
    const free = choosePower(facts(), cfgOf({ fundFromStock: false }), rngOf(1));
    assert.ok(free.ok);
    assert.strictEqual(free.candidate.stationId, null);
    assert.strictEqual(free.candidate.funded, false);
    const bare = choosePower(factsOf([sys(30000001, 500010)], []),
      cfgOf({ fundFromStock: false, cacheWeight: 0, convoyWeight: 0 }), rngOf(2));
    assert.ok(bare.ok && bare.candidate.stationId === null, JSON.stringify(bare));
  });

  test("PWS3 rotation: BUSY and the power cooldown exclude a system, maxOpenPerFaction excludes a faction", () => {
    const st = { stations: [station("st-1")] };
    const systems = [sys(1, 10), sys(2, 10), sys(3, 10)];
    const open = [{ systemId: 1, factionId: 10, eventType: "redoubt", state: "PLANNED" }];
    const lastPowerEndedAt = new Map([[2, NOW - 1000]]);
    for (let n = 0; n < 20; n += 1) {
      const r = choosePower(factsOf(systems, [[10, st]], { open, lastPowerEndedAt }), cfgOf(), rngOf(n));
      assert.strictEqual(r.ok && r.candidate.systemId, 3, JSON.stringify(r));
    }
    const after = new Map([[2, NOW - BASE.powerSites.systemCooldownMs]]);
    const back = new Set();
    for (let n = 0; n < 40; n += 1) {
      back.add(choosePower(factsOf(systems, [[10, st]], { open, lastPowerEndedAt: after }), cfgOf(), rngOf(n))
        .candidate.systemId);
    }
    assert.deepStrictEqual([...back].sort(), [2, 3]);
    const allBusy = [...open, { systemId: 3, factionId: 10, eventType: "outpost", state: "ENGAGED" }];
    assert.deepStrictEqual(choosePower(factsOf(systems, [[10, st]], { open: allBusy, lastPowerEndedAt }), cfgOf(),
      rngOf(0)), { ok: false, reason: "BUSY" });

    const full = [{ systemId: 90, factionId: 10, eventType: "cache", state: "PLANNED" },
      { systemId: 91, factionId: 10, eventType: "hunt", state: "CLEARED" },
      { systemId: 92, factionId: 20, eventType: "redoubt", state: "PLANNED" },
      { systemId: 93, factionId: 20, eventType: "foundry", state: "ENGAGED" }];
    const two = [sys(1, 10), sys(2, 20)];
    for (let n = 0; n < 20; n += 1) {
      const r = choosePower(factsOf(two, [[10, st], [20, st]], { open: full }), cfgOf(), rngOf(n));
      assert.strictEqual(r.ok && r.candidate.factionId, 20, JSON.stringify(r));
    }
    assert.deepStrictEqual(choosePower(factsOf([sys(1, 10)], [[10, st]], { open: full }), cfgOf(), rngOf(0)),
      { ok: false, reason: "LIMIT" });
  });

  test("PWS4 the faction draw is even: 1 system vs 20 systems, the small faction >= 30 %", () => {
    const st = { stations: [station("st-1")] };
    const systems = [sys(100, 7)];
    for (let i = 0; i < 20; i += 1) systems.push(sys(200 + i, 8));
    const seeds = 200;
    let small = 0;
    for (let n = 0; n < seeds; n += 1) {
      const r = choosePower(factsOf(systems, [[7, st], [8, st]]), cfgOf(), rngOf(n));
      assert.ok(r.ok);
      if (r.candidate.factionId === 7) small += 1;
    }
    assert.ok(small >= seeds * 0.3 && small <= seeds * 0.7, `small faction ${small}/${seeds}`);
  });

  test("PWS5 small stock lowers the tier, empty stock NO_STOCK, bad weights INVALID_INPUT, config cross check", () => {
    const only = { cacheWeight: 0, trailWeight: 0, huntWeight: 0, convoyWeight: 0, musterWeight: 0, outpostWeight: 1,
      tierWeights: "0,1" };
    const small = {};
    for (const variant of P.VARIANTS.outpost) {
      for (const x of C.maxComposition("outpost", 1, variant, STEPS).composition) {
        small[x.hullGroup] = Math.max(small[x.hullGroup] || 0, x.count);
      }
    }
    const facts = (stock) => factsOf([sys(5, 10)], [[10, { stations: [station("st-1", stock)] }]]);
    for (let n = 0; n < 10; n += 1) {
      const r = choosePower(facts(small), cfgOf(only), rngOf(n));
      assert.ok(r.ok && r.candidate.tier === 1 && r.candidate.stationId === "st-1", JSON.stringify(r));
    }
    assert.strictEqual(choosePower(facts(FAT), cfgOf(only), rngOf(0)).candidate.tier, 2);
    assert.deepStrictEqual(choosePower(facts({}), cfgOf(only), rngOf(0)), { ok: false, reason: "NO_STOCK" });
    assert.deepStrictEqual(choosePower(facts(FAT), cfgOf({ tierWeights: "0,0" }), rngOf(0)),
      { ok: false, reason: "INVALID_INPUT" });
    assert.deepStrictEqual(choosePower(facts(FAT), cfgOf({ affixWeights: "1,2" }), rngOf(0)),
      { ok: false, reason: "INVALID_INPUT" });
    assert.deepStrictEqual(choosePower(facts(FAT), cfgOf({ outpostWeight: 0, cacheWeight: 0, trailWeight: 0,
      huntWeight: 0, convoyWeight: 0, musterWeight: 0 }), rngOf(0)), { ok: false, reason: "TYPE_OFF" });

    assert.strictEqual(BASE.powerSites.enabled, false);
    assert.strictEqual(BASE.powerSites.fundFromStock, true);
    assert.strictEqual(BASE.powerSites.presenceRadiusJumps, 8);
    const bad = config({ EVEJS_LNE_POWER_SITES_MAX_OPEN: "3", EVEJS_LNE_POWER_SITES_MAX_OPEN_PER_FACTION: "5",
      EVEJS_LNE_POWER_SITES_PLANNED_TTL_MIN_MS: "9000000", EVEJS_LNE_POWER_SITES_PLANNED_TTL_MAX_MS: "8000000",
      EVEJS_LNE_POWER_SITES_TIER_WEIGHTS: "1,2,3" });
    assert.strictEqual(bad.config.powerSites.maxOpen, 6);
    assert.strictEqual(bad.config.powerSites.maxOpenPerFaction, 2);
    assert.strictEqual(bad.config.powerSites.plannedTtlMinMs, 7200000);
    assert.strictEqual(bad.config.powerSites.plannedTtlMaxMs, 21600000);
    assert.ok(bad.warnings.some((w) => w.includes("powerSites.maxOpenPerFaction=5")), bad.warnings.join("\n"));
    assert.ok(bad.warnings.some((w) => w.includes("powerSites.plannedTtlMinMs=9000000")));
    assert.strictEqual(bad.config.powerSites.tierWeights, "70,30");
  });
};
