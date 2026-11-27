"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const config = require("../../config");
const { FACTIONS, FACTION_IDS, EMPIRE_FACTION_IDS, rulesOf } = require("../../lib/factionIncursions/data/catalog");
const R = require("../../lib/factionIncursions/rules");
const S = require("../../lib/factionIncursions/schema");
const { settingsOf } = require("../../lib/factionIncursions");
const W = require("../../lib/heavyEvents/world/schema");
const { TIERS, isWorldVariant } = require("../../lib/heavyEvents/world/catalog");
const { SUBSTITUTE } = require("../../lib/heavyEvents/catalog");
const { HULL_CLASS_BY_GROUP, CAPITAL_LIVE_GROUPS, PIRATE_KEY_BY_FACTION_ID } =
  require("../../lib/adapter/data/liveProfiles");
const { NAVY_PROFILES_BY_FACTION_ID } = require("../../lib/adapter/empireNavyCatalog");
const { INVADER_LIVE_PROFILES } = require("../../lib/adapter/data/invaderLiveProfiles");
const { FACTIONS_V1 } = require("../../lib/strategy/data/factions");
const { loadDriver, withStore } = require("../notices/storeHelper");
const { T0, harness, boot } = require("./harness");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const VENDOR_POOLS = path.resolve(__dirname, "..", "..", "..", "..", "server", "src", "space", "npc",
  "pirateHullProfiles.js");
const PIRATE_POOL_CLASSES = Object.freeze(["frigate", "destroyer", "cruiser", "battlecruiser", "battleship"]);
const STANDARD_KEYS = Object.freeze(["angels", "blood", "guristas", "sanshas", "serpentis"]);
const POOL_CLASSES_OF = (key) => (STANDARD_KEYS.includes(key) ? PIRATE_POOL_CLASSES
  : key === "sleepers" ? ["frigate", "cruiser", "battleship"] : []);
const ROLES = Object.freeze(["assault", "hq", "staging", "vanguard"]);
const has = (o, k) => Boolean(o) && Object.prototype.hasOwnProperty.call(o, k);

function classChain(hullGroup, substitute) {
  const chain = [hullGroup];
  let current = hullGroup;
  while (has(substitute, current)) {
    const next = substitute[current];
    if (typeof next !== "string" || next === "" || chain.includes(next)) break;
    chain.push(next);
    current = next;
  }
  return chain;
}

function hasSource(factionId, group) {
  if (CAPITAL_LIVE_GROUPS.includes(group)) return false;
  const hullClass = HULL_CLASS_BY_GROUP[group];
  if (!hullClass) return false;
  return has(NAVY_PROFILES_BY_FACTION_ID[factionId], hullClass) || has(INVADER_LIVE_PROFILES[factionId], hullClass)
    || (has(PIRATE_KEY_BY_FACTION_ID, factionId) && POOL_CLASSES_OF(PIRATE_KEY_BY_FACTION_ID[factionId])
      .includes(hullClass));
}

function unreachable(factionId, kind, tierMax) {
  const tiers = TIERS[W.MECHANIC_OF[kind]][kind];
  const out = [];
  for (let t = 1; t <= tierMax; t += 1) {
    const def = tiers[t - 1];
    const groups = [...def.pockets.flatMap((p) => p.phases.flat()), ...def.scaling].map((m) => m.hullGroup);
    for (const group of new Set(groups)) {
      if (!classChain(group, SUBSTITUTE).some((c) => hasSource(factionId, c))) out.push(`${kind} ${t} ${group}`);
    }
  }
  return out;
}

const resolve = (env) => config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(),
  EVEJS_LNE_FACTION_INCURSIONS_ENABLED: "1", ...env } });

module.exports = ({ test, skip }) => {
  test("FI-S6a catalogue: 10 factions, 4 roles, world kinds, rules, reachability, empire, vendor pools", () => {
    assert.deepStrictEqual([...FACTION_IDS], [500001, 500002, 500003, 500004, 500010, 500011, 500012, 500020, 500024,
      500026]);
    for (const out of [500019, 500021, 500025, 500029]) assert.ok(!has(FACTIONS, out), `${out} outside the catalogue`);
    assert.deepStrictEqual([...EMPIRE_FACTION_IDS], [500001, 500002, 500003, 500004]);
    const kindOf = new Map(FACTIONS_V1.map((f) => [f.factionId, f.kind]));
    for (const id of FACTION_IDS) {
      const f = FACTIONS[id];
      assert.deepStrictEqual(f.stages.map((st) => st.role).sort(), [...ROLES], `${id} roles`);
      for (const st of f.stages) {
        assert.ok(W.KINDS.includes(st.kind) && isWorldVariant(W.MECHANIC_OF[st.kind], st.kind), `${id} ${st.kind}`);
        assert.deepStrictEqual(unreachable(id, st.kind, st.tier), [], `${id} ${st.key} reachable`);
      }
      assert.deepStrictEqual(R.validateRules(rulesOf(id)), { ok: true }, `${id} rules`);
      assert.strictEqual(f.empire, kindOf.get(id) === "empire", `${id} empire`);
    }
    assert.deepStrictEqual(unreachable(500021, "warcamp", 1), ["warcamp 1 destroyer"], "Sleepers: no destroyer");

    if (!fs.existsSync(VENDOR_POOLS)) return;
    const text = fs.readFileSync(VENDOR_POOLS, "utf8");
    const pools = /STANDARD_POOL_QUERY_BY_FACTION\s*=\s*Object\.freeze\(\{([^}]*)\}\)/.exec(text);
    assert.ok(pools, "vendor STANDARD_POOL_QUERY_BY_FACTION");
    for (const id of FACTION_IDS.filter((x) => has(PIRATE_KEY_BY_FACTION_ID, x))) {
      const key = PIRATE_KEY_BY_FACTION_ID[id];
      assert.ok(new RegExp(`\\b${key}:\\s*"${key}_standard"`).test(pools[1]), `vendor pool ${key}_standard`);
    }
    const classes = /const HULL_CLASSES\s*=\s*Object\.freeze\(\[([^\]]*)\]\)/.exec(text);
    assert.ok(classes, "vendor HULL_CLASSES");
    assert.deepStrictEqual(classes[1].split(",").map((s) => s.trim().replace(/"/g, "")).filter(Boolean),
      [...PIRATE_POOL_CLASSES]);
  });

  test("FI-S6b factionIds outside the catalogue ignored; W243 + settingsOf skips the empires without the flag", () => {
    const w243 = (r) => r.warnings.filter((w) => w.includes("W243")).length;
    for (const ids of ["500026,500029", "500019"]) {
      const r = resolve({ EVEJS_LNE_FACTION_INCURSIONS_FACTION_IDS: ids });
      assert.ok(r.warnings.some((w) => w.includes(`"${ids}" is not`) && w.endsWith("- ignored")), ids);
      assert.strictEqual(r.config.factionIncursions.factionIds, "500026", ids);
    }
    const pirates = resolve({ EVEJS_LNE_FACTION_INCURSIONS_FACTION_IDS: "500024,500010" });
    assert.deepStrictEqual(pirates.warnings.filter((w) => /faction_?incursions|W243/i.test(w)), []);
    assert.deepStrictEqual(settingsOf(pirates.config.factionIncursions).settings.factionIds, [500024, 500010]);

    const off = resolve({ EVEJS_LNE_FACTION_INCURSIONS_FACTION_IDS: "500026,500003" });
    assert.strictEqual(w243(off), 1);
    const sOff = settingsOf(off.config.factionIncursions).settings;
    assert.deepStrictEqual([[...sOff.factionIds], [...sOff.skippedEmpireFactionIds]], [[500026], [500003]]);
    const on = resolve({ EVEJS_LNE_FACTION_INCURSIONS_FACTION_IDS: "500026,500003",
      EVEJS_LNE_FACTION_INCURSIONS_ALLOW_EMPIRE_FACTIONS: "1" });
    assert.strictEqual(w243(on), 0);
    const sOn = settingsOf(on.config.factionIncursions).settings;
    assert.deepStrictEqual([[...sOn.factionIds], [...sOn.skippedEmpireFactionIds]], [[500026, 500003], []]);
    const def = resolve({});
    assert.strictEqual(w243(def), 0);
    const sDef = settingsOf(def.config.factionIncursions).settings;
    assert.deepStrictEqual([[...sDef.factionIds], [...sDef.skippedEmpireFactionIds]], [[500026], []]);
  });

  const driver = loadDriver();
  if (!driver.ok) {
    skip("FI-S6c pirate incursion end to end", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }
  test("FI-S6c pirate 500010: warcamp/hideout slots, rules_json frozen, hin: rows muster/hunt/muster", () => {
    withStore(driver, ({ store }) => {
      const h = harness(store, { factionId: 500010 });
      const svc = boot(h, { EVEJS_LNE_FACTION_INCURSIONS_FACTION_IDS: "500010" });
      assert.strictEqual(svc.runPass(T0).created, 1, JSON.stringify(h.lines));
      svc.runPass(T0);
      const row = h.run((tx) => tx.prepare("SELECT faction_id, rules_json FROM world_faction_incursions "
        + "WHERE incursion_id = 1").get());
      assert.strictEqual(Number(row.faction_id), 500010);
      assert.deepStrictEqual(JSON.parse(row.rules_json), rulesOf(500010));
      const kinds = h.run((tx) => tx.prepare("SELECT slot_key, kind FROM world_faction_incursion_sites "
        + "WHERE incursion_id = 1 ORDER BY slot_key").all()).map((r) => [r.slot_key, r.kind]);
      assert.deepStrictEqual(kinds, [["assault", "warcamp"], ["hq", "hideout"], ["staging", "warcamp"],
        ["vanguard", "hideout"]]);
      const rows = ["staging", "vanguard", "assault"].map((slot) => h.heavyRow(S.siteEventIdOf(1, T0, slot, 1)));
      assert.deepStrictEqual(rows.map((r) => r && [r.eventType, r.variant, r.factionId]),
        [["muster", "warcamp", 500010], ["hunt", "hideout", 500010], ["muster", "warcamp", 500010]]);
      svc.stop();
    });
  });
};
