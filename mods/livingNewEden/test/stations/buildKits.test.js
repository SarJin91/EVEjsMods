"use strict";

const assert = require("node:assert");
const path = require("node:path");

const config = require("../../config");
const { createIndustryCatalog } = require("../../lib/economy/industry/catalog");
const { BUILD_KIT_FAMILIES, BUILD_KITS_VERSION, buildKitTable } = require("../../lib/stations/data/buildKits");
const { STRUCTURE_TYPE_IDS } = require("../../lib/stations/data/structureTypes");
const { STRUCTURE_DEFENSE, TIMER_SECONDS } = require("../../lib/stations/data/structureDefense");
const { buildPlan } = require("../../lib/stations/siege/siegeMachine");
const { constructionReceiveRows } = require("../../lib/stations/construction/schema");
const { startConstruction } = require("../../lib/stations/construction");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const DEFAULTS = config.resolveConfig({ modDir: MOD_DIR, env: {} }).config;
const CATALOG = createIndustryCatalog().catalog;
const MINERAL_KEYS = ["mineral/type:34", "mineral/type:35", "mineral/type:36", "mineral/type:37", "mineral/type:38",
  "mineral/type:39", "mineral/type:40"];

const paramsOf = (o = {}) => ({ componentWeightPermille: DEFAULTS.production.componentWeightPermille,
  componentFactorMaxPermille: DEFAULTS.production.componentFactorMaxPermille,
  kitComponentFactorPermille: DEFAULTS.construction.kitComponentFactorPermille, ...o });
const sum = (items) => Object.values(items).reduce((a, b) => a + b, 0);
const mineralsOf = (family) => Object.fromEntries(Object.entries(CATALOG.kit(family).minerals)
  .filter(([, v]) => v > 0).map(([k, v]) => [`mineral/${k}`, v]));

function startOn(cfg) {
  const lines = [];
  const r = startConstruction({ config: cfg,
    persistence: { ok: true, store: { transaction: () => ({ ok: false, reason: "FAKE_STORE" }) },
      journal: { applyOnce() {}, findByKey() {} } },
    clock: { now: () => 0 }, ids: { next: (p) => `${p}_1` },
    scheduler: { getStatus: () => ({ state: "ready" }), registerHandler: () => ({ ok: true, unregister() {} }) },
    world: { repository: { getSystems: () => ({ ok: true, systems: [], missing: [] }) } },
    strategy: { registry: { isActive: () => true, getFaction: () => null } },
    logger: { log: (l) => lines.push(l) } });
  return { r, lines };
}

const withKit = (kitId) => ({ ...DEFAULTS, enabled: true,
  modules: { ...DEFAULTS.modules, strategy: { ...DEFAULTS.modules.strategy, enabled: true } },
  stations: { ...DEFAULTS.stations, enabled: true },
  construction: { ...DEFAULTS.construction, enabled: true, kitId } });

module.exports = ({ test }) => {
  test("K1 buildKitTable: catalogue x factor 2000, 8 families, weight 0 / floor 1000 = minerals, ceiling "
    + "KITS_INVALID", () => {
    assert.strictEqual(BUILD_KITS_VERSION, 2);
    assert.strictEqual(DEFAULTS.construction.kitComponentFactorPermille, 2000);
    const t = buildKitTable(CATALOG, paramsOf());
    assert.ok(t.ok, JSON.stringify(t));
    assert.ok(Object.isFrozen(t.kits) && Object.isFrozen(t.kits.astrahus.items));
    assert.deepStrictEqual(Object.keys(t.kits), [...BUILD_KIT_FAMILIES]);
    const a = t.kits.astrahus;
    assert.deepStrictEqual(Object.keys(a.items), MINERAL_KEYS);
    for (const k of MINERAL_KEYS) {
      assert.strictEqual(a.items[k], Math.ceil((CATALOG.kit("astrahus").minerals[k.slice(8)] * 2000) / 1000), k);
    }
    assert.deepStrictEqual([sum(a.items), a.factorPermille, a.kind, a.structureFamily, a.typeId],
      [24329500, 2000, "upwell", "astrahus", 35832]);
    for (const f of BUILD_KIT_FAMILIES) {
      assert.ok(t.kits[f].typeId === STRUCTURE_TYPE_IDS[f] && t.kits[f].typeId === CATALOG.kit(f).typeId, f);
      assert.ok(Object.values(t.kits[f].items).every(Number.isSafeInteger), f);
    }
    for (const o of [{ componentWeightPermille: 0 }, { kitComponentFactorPermille: 1000 }]) {
      const m = buildKitTable(CATALOG, paramsOf(o));
      assert.ok(m.ok);
      for (const f of BUILD_KIT_FAMILIES) assert.deepStrictEqual(m.kits[f].items, mineralsOf(f), `${f} ${JSON.stringify(o)}`);
    }
    assert.strictEqual(buildKitTable(CATALOG, paramsOf({ componentFactorMaxPermille: 1500 })).kits.raitaru
      .factorPermille, 1500);
    const without = { kit: (f) => (f === "tatara" ? null : CATALOG.kit(f)) };
    const otherId = { kit: (f) => (f === "azbel" ? { ...CATALOG.kit(f), typeId: 1 } : CATALOG.kit(f)) };
    assert.deepStrictEqual(buildKitTable(without, paramsOf()), { ok: false, reason: "KITS_INVALID",
      detail: "family tatara" });
    assert.deepStrictEqual(buildKitTable(otherId, paramsOf()), { ok: false, reason: "KITS_INVALID",
      detail: "typeId azbel" });
    assert.strictEqual(buildKitTable(null, paramsOf()).reason, "KITS_INVALID");
  });

  test("K2 construction.kitId=raitaru starts, kitId=foo -> warning + astrahus, siege plan of a raitaru", () => {
    const { r } = startOn(withKit("raitaru"));
    assert.ok(r.ok, JSON.stringify(r));
    const kit = r.construction.getKit("raitaru");
    assert.deepStrictEqual([kit.typeId, kit.structureFamily, kit.kind], [35825, "raitaru", "upwell"]);
    const st = r.construction.getStatus();
    assert.deepStrictEqual([st.kitId, st.kitUnits, st.kitFactorPermille], ["raitaru", sum(kit.items), 2000]);
    r.construction.stop("test");

    const foo = config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_CONSTRUCTION_KIT_ID: "foo" } });
    assert.strictEqual(foo.config.construction.kitId, "astrahus");
    assert.ok(foo.warnings.some((w) => /CONSTRUCTION_KIT_ID=.*foo.* is not one of raitaru\|.*tatara - ignored/.test(w)),
      JSON.stringify(foo.warnings));
    const ok = config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_CONSTRUCTION_KIT_ID: "sotiyo" } });
    assert.strictEqual(ok.config.construction.kitId, "sotiyo");

    assert.strictEqual(STRUCTURE_DEFENSE.raitaru.size, "medium");
    const plan = buildPlan({ kind: "upwell", structureFamily: "raitaru" }, "nullsec",
      { timerScale: 1, assaultMinMs: 0, assaultMaxMs: 0 });
    assert.ok(plan.ok, JSON.stringify(plan));
    assert.deepStrictEqual([plan.plan.family, plan.plan.armorTimerMs], ["raitaru",
      TIMER_SECONDS.armorMedium.null * 1000]);
    assert.strictEqual(buildPlan({ kind: "upwell", structureFamily: "sotiyo" }, "nullsec",
      { timerScale: 1, assaultMinMs: 0, assaultMaxMs: 0 }).plan.armorTimerMs, TIMER_SECONDS.armorDefault * 1000);
  });

  test("K4 every family: constructionReceiveRows(7) and the start checks (rows, maxDeltasPerChange)", () => {
    const t = buildKitTable(CATALOG, paramsOf());
    for (const f of BUILD_KIT_FAMILIES) {
      assert.strictEqual(constructionReceiveRows(Object.keys(t.kits[f].items).length), constructionReceiveRows(7), f);
      const { r } = startOn(withKit(f));
      assert.ok(r.ok, `${f} ${JSON.stringify(r)}`);
      assert.strictEqual(r.construction.getStatus().kitUnits, sum(t.kits[f].items), f);
      r.construction.stop("test");
    }
  });
};
