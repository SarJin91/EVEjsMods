"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const W = require("../../lib/adapter/shipAiWing");
const { bandOf } = require("../../lib/shipAi/wingHp");
const { createAdapter } = require("../../lib/adapter");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const MODS = path.resolve(MOD_DIR, "..");
const SHIP_WING = path.join(MODS, "shipWing");
const SERVER_SRC = path.resolve(MODS, "..", "server", "src");
const JITA = 30000142;
const OWNER = 7;
const SHIP = 990001;

const condition = (shield, armor, hull) => ({ shieldCharge: shield, armorDamage: 1 - armor, damage: 1 - hull });
const copyOf = (itemID, more) => ({ kind: "ship", transient: true, characterID: 0, pilotCharacterID: OWNER,
  ownerID: OWNER, itemID, typeID: 16227, itemName: "Ferox", session: null, conditionState: condition(1, 1, 1),
  ...(more || {}) });

function runtimeOf(entities, loaded = true) {
  const scene = { dynamicEntities: new Map(entities.map((e) => [e.itemID, e])) };
  return { isSolarSystemSceneLoaded: (id) => loaded && id === JITA, scenes: new Map([[JITA, scene]]) };
}

const read = (rel) => fs.readFileSync(rel, "utf8").replace(/\r\n/g, "\n");

module.exports = ({ test, skip }) => {
  test("WA1 readWingCopiesFrom: only the copy (NPC, wreck, FireShow, parked, player, destroying, overlay, unreadable "
    + "skipped); per mille of hpPermille; scanMax; SCENE_NOT_LOADED never reads the scenes", () => {
    const overlay = copyOf(106);
    Object.defineProperty(overlay, "session", { get: () => ({ characterID: OWNER, shipWingNpcAggro: true }),
      configurable: true, enumerable: false });
    const scoped = copyOf(107);
    Object.defineProperty(scoped, "session", { get: () => null, configurable: true, enumerable: false });
    const entities = [
      { kind: "ship", itemID: 101, characterID: 0, pilotCharacterID: 0, nativeNpc: true, typeID: 1 },
      { kind: "ship", itemID: 102, transient: true, characterID: 0, pilotCharacterID: 0, typeID: 2 },
      { kind: "ship", itemID: 103, transient: true, characterID: 0, pilotCharacterID: OWNER, nativeNpc: true },
      { kind: "ship", itemID: 104, characterID: 0, pilotCharacterID: OWNER, conditionState: condition(1, 1, 1) },
      { kind: "ship", itemID: 105, characterID: OWNER, pilotCharacterID: OWNER, session: { characterID: OWNER },
        conditionState: condition(1, 1, 1) },
      overlay, scoped,
      copyOf(108, { destroying: true, destructionState: "destroying" }),
      copyOf(109, { conditionState: {} }),
      copyOf(110, { conditionState: condition(0.855, 0.7, 0.4996), itemName: " " }),
    ];
    const r = W.readWingCopiesFrom({ runtime: runtimeOf(entities) }, JITA, { scanMax: 100 });
    assert.deepStrictEqual(r, { ok: true, truncated: false, unreadable: 1, copies: [
      { entityId: 107, ownerId: OWNER, typeId: 16227, name: "Ferox", hp: [1000, 1000, 1000] },
      { entityId: 110, ownerId: OWNER, typeId: 16227, name: null, hp: [855, 700, 500] }] });
    assert.strictEqual(W.isWingCopyEntity(overlay), false, "H-WING-1: an active overlay is not read");
    assert.strictEqual(W.isWingCopyShape(copyOf(1, { destroying: true })), true, "the loss path: shape only");
    const cut = W.readWingCopiesFrom({ runtime: runtimeOf(entities) }, JITA, { scanMax: 7 });
    assert.deepStrictEqual([cut.truncated, cut.copies.map((c) => c.entityId)], [true, [107]]);

    const scenes = new Map();
    scenes.get = () => {
      throw new Error("never read");
    };
    assert.deepStrictEqual(W.readWingCopiesFrom({ runtime: { isSolarSystemSceneLoaded: () => false, scenes } }, JITA,
      { scanMax: 10 }), { ok: false, reason: "SCENE_NOT_LOADED" });
    assert.deepStrictEqual(W.readWingCopiesFrom({ runtime: null }, JITA, { scanMax: 10 }),
      { ok: false, reason: "SEAM_UNAVAILABLE" });
    assert.deepStrictEqual(W.readWingCopiesFrom({ runtime: runtimeOf([]) }, 0, { scanMax: 10 }),
      { ok: false, reason: "INVALID_INPUT" });
  });

  test("WA2 readShipWingHpMarks: the real ShipWing config = 90 / 50; critical >= warn = BAD_MARKS; none = "
    + "CONFIG_MISSING", () => {
    const bad = W.readShipWingHpMarks({ loadModConfig: () => ({ ok: true, modDir: "x", exports: {
      loadConfig: () => ({ ok: true, config: { hpWarnPct: 50, hpCriticalPct: 50 } }) } }), env: {} });
    assert.deepStrictEqual(bad, { ok: false, reason: "BAD_MARKS" });
    assert.deepStrictEqual(W.readShipWingHpMarks({ loadModConfig: () => ({ ok: false, reason: "CONFIG_MISSING" }) }),
      { ok: false, reason: "CONFIG_MISSING" });
    assert.deepStrictEqual(W.readShipWingHpMarks({}), { ok: false, reason: "CONFIG_MISSING" });
    if (!fs.existsSync(path.join(SHIP_WING, "config.js"))) return;
    const adapter = createAdapter({ moduleApi: { _cache: {} }, logger: { log() {} } });
    const real = W.readShipWingHpMarks({ loadModConfig: adapter.loadModConfig,
      env: { EVEJS_MOD_SETTINGS_OVERRIDES_IGNORE: "1" } });
    assert.deepStrictEqual(real, { ok: true, warnPct: 90, criticalPct: 50 }, JSON.stringify(real));
  });

  const haveWing = fs.existsSync(path.join(SHIP_WING, "client", "wing.py"));
  const name3 = "WA3 facts: shipEntity transient / characterID, damage.js layers, twinSpec copy shape, wing.py marks "
    + "(bandOf parity), npcAggro getter returns the spawn value outside the NPC tick scope";
  if (!haveWing) {
    skip(name3, "mods/shipWing absent (optional mod)");
  } else {
    test(name3, () => {
      const ship = read(path.join(SERVER_SRC, "space", "runtime", "shipEntity.js"));
      assert.ok(ship.includes("transient: source && source.transient === true"), "shipEntity transient");
      assert.ok(ship.includes("characterID: toInt(source.characterID, 0)"), "shipEntity characterID");
      const damage = read(path.join(SERVER_SRC, "space", "combat", "damage.js"));
      assert.ok(/module\.exports = \{[\s\S]*getEntityCurrentHealthLayers,/.test(damage), "damage exports layers");
      assert.ok(damage.includes("conditionState.shieldCharge"), "damage reads conditionState.shieldCharge");
      const twin = read(path.join(SHIP_WING, "lib", "core", "twinSpec.js"));
      for (const t of ["transient: true", "characterID: 0", "pilotCharacterID: owner.characterId"]) {
        assert.ok(twin.includes(t), t);
      }
      const wing = read(path.join(SHIP_WING, "client", "wing.py"));
      assert.ok(wing.includes("pct = value // 10"), "per mille // 10");
      const body = wing.slice(wing.indexOf("def _sw_hp_color(pct, marks):"));
      assert.ok(body.indexOf("if pct < marks[1]:") > 0 && body.indexOf("if pct < marks[1]:")
        < body.indexOf("if pct < marks[0]:"), "red (critical) tested before orange");
      assert.ok(wing.includes("_SW_HP_WARN_PCT = 90") && wing.includes("_SW_HP_CRITICAL_PCT = 50"));
      const marks = { warnPct: 90, criticalPct: 50 };
      const py = (v) => {
        const pct = Math.floor(v / 10);
        if (pct < marks.criticalPct) return 2;
        if (pct < marks.warnPct) return 1;
        return 0;
      };
      for (const v of [0, 499, 500, 501, 899, 900, 999, 1000]) assert.strictEqual(bandOf(v, marks), py(v), String(v));
      const aggro = read(path.join(SHIP_WING, "lib", "adapter", "npcAggro.js"));
      assert.ok(aggro.includes("if (!active || depth === 0 || suspended > 0) return base;"), "H-WING-1 scope");
      assert.ok(aggro.includes("if (entity.destroying === true || entity.destructionState === \"destroying\""),
        "H-WING-2: no overlay while destroyed");
    });
  }

  test("WA4 facade: consumer shipAiWing on scenes / isSolarSystemSceneLoaded; their DRIFT refuses only "
    + "sensors.wingCopies, the telemetry reads; shipWingLoaded / shipWingHpMarks shapes", () => {
    const { GAME_MODULES } = require("../../lib/adapter/gameModules");
    const entry = GAME_MODULES.find((e) => e.path === "space/runtime");
    const symOf = (name) => entry.symbols.find((s) => s.name === name);
    assert.ok(symOf("scenes").consumers.includes("shipAiWing"));
    assert.ok(symOf("isSolarSystemSceneLoaded").consumers.includes("shipAiWing"));

    const SRC = path.join(path.sep, "x", "server", "src");
    const key = (rel) => path.join(SRC, `${rel}.js`);
    const base = { [key("_secondary/chat/chatRuntime")]: { exports: {} },
      [key("services/chat/xmppStubServer")]: { exports: {} },
      [key("services/chat/sessionRegistry")]: { exports: {
        getSessions: () => [{ characterID: OWNER, stationid: 60003760, shipID: SHIP }] } },
      [key("services/inventory/itemStore")]: { exports: {
        findItemById: (id) => (id === SHIP ? { typeID: 587, conditionState: {} } : null) } } };

    const live = createAdapter({ moduleApi: { _cache: { ...base,
      [key("space/runtime")]: { exports: runtimeOf([copyOf(201)]) } } }, logger: { log() {} } });
    live.setServerSrc(SRC);
    const ok = live.shipAiSeams().seam.sensors.wingCopies(JITA, { scanMax: 10 });
    assert.deepStrictEqual([ok.ok, ok.copies.map((c) => c.entityId)], [true, [201]], JSON.stringify(ok));
    const loaded = live.shipWingLoaded();
    assert.deepStrictEqual([loaded.ok, typeof loaded.loaded], [true, "boolean"]);
    const marks = live.shipWingHpMarks();
    assert.ok(marks.ok === true ? marks.criticalPct < marks.warnPct : typeof marks.reason === "string");

    const table = GAME_MODULES.map((e) => (e.path === "space/runtime"
      ? { ...e, symbols: e.symbols.filter((s) => s.name === "scenes" || s.name === "isSolarSystemSceneLoaded") }
      : { ...e, symbols: [] }));
    const drift = createAdapter({ moduleApi: { _cache: { ...base, [key("space/runtime")]: { exports: {} } } },
      logger: { log() {} }, gameModules: table });
    drift.setServerSrc(SRC);
    const report = drift.runProbe();
    assert.ok(Object.keys(report.disabledModules).includes("shipAiWing"), JSON.stringify(report.disabledModules));
    assert.ok(!Object.keys(report.disabledModules).includes("shipAiTools"));
    const sensors = drift.shipAiSeams().seam.sensors;
    assert.deepStrictEqual(sensors.wingCopies(JITA, { scanMax: 10 }), { ok: false, reason: "SEAM_UNAVAILABLE" });
    const t = sensors.telemetry(OWNER);
    assert.deepStrictEqual([t.ok, t.docked, t.shipTypeId], [true, true, 587], JSON.stringify(t));
  });
};
