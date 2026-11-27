"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

const config = require("../../config");
const { createAdapter } = require("../../lib/adapter");
const { GAME_MODULES } = require("../../lib/adapter/gameModules");
const E = require("../../lib/adapter/incursionEffects");
const { createEffectsDriver, entriesOf } = require("../../lib/factionIncursions/effects");
const { startFactionIncursions } = require("../../lib/factionIncursions");
const { SCENE_OF_ROLE } = require("../../lib/factionIncursions/schema");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SERVER_SRC = path.resolve(__dirname, "..", "..", "..", "..", "server", "src");
const T0 = 1760000000000;
const [A, B, C, D, F, OUT] = [30000001, 30000002, 30000003, 30000004, 30000005, 30000099];
const INC = 7;
const PILOT = 90000001;

const abs = (rel) => path.join(SERVER_SRC, ...`${rel}.js`.split("/"));
const EFFECTS_FILE = abs(E.EFFECTS_PATH);
const CONTRACT_FILE = abs(E.CONTRACT_PATH);
const RUNTIME_FILE = abs("space/runtime");

const ship = (systemID, extra = {}) => ({ kind: "ship", systemID, pilotCharacterID: PILOT, ...extra });
const drone = (systemID) => ({ kind: "drone", systemID, ownerID: PILOT });
const npc = (systemID) => ({ kind: "ship", systemID, nativeNpc: true });

function vendorEffects(contract, vendorTales) {
  const text = fs.readFileSync(EFFECTS_FILE, "utf8");
  const fakes = {
    "./incursionClock": { now: () => T0 },
    "./incursionSystemEffectContract": contract,
    "./incursionLifecycleContract": { projectInfluence: (influence) => influence.value,
      fingerprint: (value) => JSON.stringify(value) },
    "./incursionPresentation": { forSystem: (id) => vendorTales.get(Number(id)) || null },
  };
  const fakeRequire = (request) => {
    if (!Object.prototype.hasOwnProperty.call(fakes, request)) throw new Error(`unexpected ${request}`);
    return fakes[request];
  };
  const factory = vm.runInThisContext(`(function (require, module, exports) {${text}\n})`, { filename: EFFECTS_FILE });
  const module = { exports: {} };
  factory(fakeRequire, module, module.exports);
  return module.exports;
}

function vendorTale(contract, systemId, sceneType, influence) {
  return { taleID: 900, revision: 1, policy: { effects: { application: contract.policy() } },
    placement: { systems: [{ solarSystemID: systemId, sceneType }] }, influence: { value: influence } };
}

function rig(opts = {}) {
  const contract = require(CONTRACT_FILE);
  const vendorTales = new Map();
  const effects = vendorEffects(contract, vendorTales);
  const originals = Object.fromEntries(E.SWAPPED.map((n) => [n, effects[n]]));
  const scenes = new Map();
  const reads = { effects: 0, contract: 0 };
  const cache = { [RUNTIME_FILE]: { exports: { scenes } } };
  Object.defineProperty(cache, EFFECTS_FILE, { enumerable: true, get: () => {
    reads.effects += 1;
    return { exports: effects };
  } });
  Object.defineProperty(cache, CONTRACT_FILE, { enumerable: true, get: () => {
    reads.contract += 1;
    return { exports: contract };
  } });
  const adapter = createAdapter({ moduleApi: { _cache: cache }, readFileSync: opts.readFileSync });
  adapter.setServerSrc(SERVER_SRC);
  return { contract, vendorTales, effects, originals, scenes, reads, adapter };
}

const entry = (systemId, sceneType, opposition, incursionId = INC) => ({ systemId, incursionId, sceneType,
  opposition });

function scene(systemId, ships) {
  const calls = [];
  const dynamicEntities = new Map(ships.map((s, i) => [i + 1, s]));
  return { systemID: systemId, dynamicEntities, calls,
    refreshShipEntityDerivedState: (entity, options) => {
      calls.push([entity, options]);
      return { success: true };
    } };
}

module.exports = ({ test, skip }) => {
  if (!fs.existsSync(EFFECTS_FILE) || !fs.existsSync(CONTRACT_FILE)) {
    skip("FI13-FI16 faction incursion system effects", `server/src not found (${SERVER_SRC})`);
    return;
  }

  test("FI13 GAME_MODULES entries + install on the real createAdapter; effects flag off -> no driver, no reads", () => {
    const shape = (rel) => GAME_MODULES.find((m) => m.path === rel).symbols.map((s) => [s.name, s.kind,
      s.wrap === true, s.firstLoad === true, [...s.consumers], s.valueType || "function"]);
    const C1 = ["factionIncursions.effects"];
    assert.deepStrictEqual(shape(E.EFFECTS_PATH), [["shipModifiers", "export", true, false, C1, "function"],
      ["damageMultiplier", "export", false, false, C1, "function"], ["bountyMultiplier", "export", true, false, C1,
        "function"], ["blocksCyno", "export", true, false, C1, "function"]]);
    assert.deepStrictEqual(shape(E.CONTRACT_PATH), [["policy", "export", false, false, C1, "function"],
      ["VERSION", "export", false, false, C1, "string"], ["RESONANCES", "export", false, false, C1, "object"]]);
    const scenesSym = GAME_MODULES.find((m) => m.path === "space/runtime").symbols.find((s) => s.name === "scenes");
    assert.ok(scenesSym.consumers.includes(E.CONSUMER), "scenes consumer");

    const r = rig();
    assert.deepStrictEqual(r.adapter.factionIncursionEffectsSet(null, 0.05), { ok: true, installed: false,
      changed: 0 });
    assert.deepStrictEqual(r.reads, { effects: 0, contract: 0 });
    const set = r.adapter.factionIncursionEffectsSet([entry(A, 1, 1)], 0.05);
    assert.deepStrictEqual(set, { ok: true, installed: true, changed: 1 });
    for (const name of E.SWAPPED) {
      assert.notStrictEqual(r.effects[name], r.originals[name], `${name} swapped`);
      assert.ok(r.effects[name][E.MARKER], `${name} marker`);
    }
    assert.strictEqual(r.adapter.factionIncursionEffectsStats().installed, true);
    const swapped = E.SWAPPED.map((n) => r.effects[n]);
    r.adapter.factionIncursionEffectsSet([entry(A, 1, 1)], 0.05);
    assert.deepStrictEqual(E.SWAPPED.map((n) => r.effects[n]), swapped);

    const store = { transaction: () => ({ ok: true, value: { ok: true, count: 0 } }) };
    const boot = (env) => {
      const x = rig();
      const calls = [];
      const spy = {};
      const methods = ["factionIncursionEffectsSet", "factionIncursionEffectsRefresh", "factionIncursionEffectsStats"];
      for (const m of methods) {
        spy[m] = (...args) => {
          calls.push(m);
          return x.adapter[m](...args);
        };
      }
      const c = config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(),
        EVEJS_LNE_FACTION_INCURSIONS_ENABLED: "1", ...env } });
      assert.deepStrictEqual(c.errors || [], []);
      const fi = startFactionIncursions({ config: c.config, clock: { now: () => T0 }, setTimer: () => ({ cancel() {},
        hasRef: () => false }), persistence: { ok: true, store, journal: {} }, getAdapter: () => spy });
      assert.strictEqual(fi.ok, true, JSON.stringify(fi));
      return { fi: fi.factionIncursions, calls, x };
    };
    const off = boot({});
    assert.strictEqual("effects" in off.fi.getStatus(), false, "effects off: no driver");
    off.fi.stop();
    assert.deepStrictEqual([off.calls, off.x.reads], [[], { effects: 0, contract: 0 }]);
    assert.deepStrictEqual(E.SWAPPED.map((n) => off.x.effects[n]), E.SWAPPED.map((n) => off.x.originals[n]));
    const on = boot({ EVEJS_LNE_FACTION_INCURSIONS_EFFECTS_ENABLED: "1" });
    assert.strictEqual(on.fi.getStatus().effects.state, "running");
    on.fi.stop();
    assert.deepStrictEqual([on.calls, on.x.reads], [["factionIncursionEffectsSet"], { effects: 0, contract: 0 }]);
  });

  test("FI14 the real vendor policy: HQ 50 % / x0.5 at influence 0, neutral at 1000, the vendor wins", () => {
    const r = rig();
    const { VERSION, RESONANCES } = r.contract;
    r.vendorTales.set(C, vendorTale(r.contract, C, 2, 0));
    r.vendorTales.set(D, vendorTale(r.contract, D, 1, 1));
    const set = r.adapter.factionIncursionEffectsSet([entry(A, 1, 1), entry(B, 1, 0), entry(C, 1, 1),
      entry(D, 1, 1)], 0.05);
    assert.strictEqual(set.ok, true, JSON.stringify(set));
    const fx = r.effects;
    assert.deepStrictEqual(fx.shipModifiers(ship(A)), RESONANCES.map((id) => ({ modifiedAttributeID: id,
      operation: 6, value: 50, stackingPenalized: false, modifierSourceKey: `lne-incursion:${INC}:${VERSION}` })));
    assert.strictEqual(fx.damageMultiplier(ship(A), "turret"), 0.5);
    assert.strictEqual(fx.damageMultiplier(drone(A), "drone", A), 0.5);
    assert.strictEqual(fx.damageMultiplier(npc(A), "turret"), 1);
    assert.strictEqual(fx.damageMultiplier(ship(A), "bomb"), 1);
    assert.deepStrictEqual(fx.shipModifiers(npc(A)), []);
    assert.deepStrictEqual([fx.bountyMultiplier(A), fx.blocksCyno(A)], [0.5, true]);
    assert.deepStrictEqual(fx.shipModifiers(ship(B)), []);
    assert.strictEqual(fx.damageMultiplier(ship(B), "launcher"), 1);
    assert.deepStrictEqual([fx.bountyMultiplier(B), fx.blocksCyno(B)], [0.5, true]);
    assert.deepStrictEqual([fx.shipModifiers(ship(OUT)), fx.damageMultiplier(ship(OUT), "turret"),
      fx.bountyMultiplier(OUT), fx.blocksCyno(OUT)], [[], 1, 1, false]);
    const vendorC = fx.shipModifiers(ship(C));
    assert.deepStrictEqual(vendorC.map((m) => [m.value, m.modifierSourceKey]), RESONANCES.map(() => [25,
      `incursion:900:${VERSION}`]));
    assert.strictEqual(fx.damageMultiplier(ship(C), "turret"), 0.75);
    assert.deepStrictEqual(fx.shipModifiers(ship(D)), []);
    assert.strictEqual(fx.damageMultiplier(ship(D), "turret"), 1);
    const st = r.adapter.factionIncursionEffectsStats();
    assert.deepStrictEqual([st.systems, st.errors], [4, 0]);
    assert.ok(st.vendorWins >= 4 && st.hits >= 6, JSON.stringify(st));
  });

  test("FI15 DRIFT leaves the exports, effectsDrift once; a sceneType outside the policy and an empty map", () => {
    const changed = (absPath, enc) => {
      const text = fs.readFileSync(absPath, enc);
      return absPath === EFFECTS_FILE ? `${text}\n// changed` : text;
    };
    const d = rig({ readFileSync: changed });
    const refused = d.adapter.factionIncursionEffectsSet([entry(A, 1, 1)], 0.05);
    assert.deepStrictEqual([refused.ok, refused.reason, refused.detail], [false, "INCURSION_EFFECTS_DRIFT",
      `${E.EFFECTS_PATH}.js sha1`]);
    assert.deepStrictEqual(E.SWAPPED.map((n) => d.effects[n]), E.SWAPPED.map((n) => d.originals[n]), "untouched");
    assert.strictEqual(d.adapter.factionIncursionEffectsStats().drift, true);
    const bumps = [];
    const lines = [];
    const listed = { ok: true, incursions: [{ incursionId: INC, state: "ACTIVE", phase: "ESTABLISHED",
      influenceMilli: 0, systems: [{ systemId: A, role: "hq" }] }] };
    const driver = createEffectsDriver({ getAdapter: () => d.adapter, listActive: () => listed,
      settings: { maxActive: 1, maxRefreshPerPass: 64, refreshDeltaMilli: 50 }, bump: (n, k) => bumps.push([n, k]),
      logger: { log: (line) => lines.push(line) } });
    assert.strictEqual(driver.publish().reason, "INCURSION_EFFECTS_DRIFT");
    assert.strictEqual(driver.publish().reason, "EFFECTS_DRIFT");
    assert.deepStrictEqual([bumps, lines.length, driver.status().state], [[["effectsDrift", 1]], 1, "drift"]);

    const r = rig();
    assert.strictEqual(r.adapter.factionIncursionEffectsSet([entry(A, 9, 1)], 0.05).ok, true);
    assert.deepStrictEqual(r.effects.shipModifiers(ship(A)), []);
    assert.strictEqual(r.effects.damageMultiplier(ship(A), "turret"), 1);
    assert.strictEqual(r.adapter.factionIncursionEffectsStats().errors, 2);
    const before = r.adapter.factionIncursionEffectsStats();
    assert.deepStrictEqual(r.adapter.factionIncursionEffectsSet(null, 0.05), { ok: true, installed: true,
      changed: 1 });
    assert.ok(r.effects.shipModifiers[E.MARKER], "never uninstalled");
    assert.deepStrictEqual([r.effects.shipModifiers(ship(A)), r.effects.damageMultiplier(ship(A), "turret"),
      r.effects.bountyMultiplier(A), r.effects.blocksCyno(A)], [[], 1, 1, false]);
    const after = r.adapter.factionIncursionEffectsStats();
    assert.deepStrictEqual([after.hits, after.vendorWins, after.errors, after.systems],
      [before.hits, before.vendorWins, before.errors, 0]);
  });

  test("FI16 driver: only ACTIVE, roles -> sceneType, small change = no refresh, budget 2 of 3, stop", () => {
    const pure = entriesOf([{ incursionId: INC, state: "ACTIVE", phase: "ESTABLISHED", influenceMilli: 400,
      systems: [{ systemId: A, role: "hq" }, { systemId: B, role: "assault" }, { systemId: C, role: "vanguard" },
        { systemId: D, role: "staging" }] }, { incursionId: 8, state: "DECIDED", phase: "ESTABLISHED",
      influenceMilli: 0, systems: [{ systemId: F, role: "hq" }] }]);
    assert.deepStrictEqual(pure.map((e) => [e.systemId, e.sceneType, e.opposition]), [[A, SCENE_OF_ROLE.hq, 0.6],
      [B, SCENE_OF_ROLE.assault, 0.6], [C, SCENE_OF_ROLE.vanguard, 0.6], [D, SCENE_OF_ROLE.staging, 0.6]]);

    const r = rig();
    const sA = scene(A, [ship(A), ship(A), npc(A), ship(A)]);
    r.scenes.set(A, sA);
    let influenceMilli = 400;
    const listed = () => ({ ok: true, incursions: [{ incursionId: INC, state: "ACTIVE", phase: "ESTABLISHED",
      influenceMilli, systems: [{ systemId: A, role: "hq" }, { systemId: B, role: "assault" },
        { systemId: C, role: "vanguard" }, { systemId: D, role: "staging" }] }, { incursionId: 8, state: "DECIDED",
      phase: "ESTABLISHED", influenceMilli: 0, systems: [{ systemId: F, role: "hq" }] }] });
    const bumps = {};
    const sets = [];
    const spy = { ...r.adapter, factionIncursionEffectsSet: (entries, delta) => {
      const out = r.adapter.factionIncursionEffectsSet(entries, delta);
      sets.push([entries === null ? null : entries.length, out.changed]);
      return out;
    } };
    const driver = createEffectsDriver({ getAdapter: () => spy, listActive: listed,
      settings: { maxActive: 2, maxRefreshPerPass: 2, refreshDeltaMilli: 50 },
      bump: (n, k) => { bumps[n] = (bumps[n] || 0) + k; } });
    assert.deepStrictEqual(driver.publish(), { ok: true, systems: 4 });
    assert.deepStrictEqual([sets.at(-1), sA.calls.length, driver.status().pending], [[4, 4], 2, 1]);
    assert.ok(sA.calls.every(([e, o]) => e.kind === "ship" && e.nativeNpc !== true
      && o.notifyDerivedAttributes === true));
    assert.strictEqual(r.effects.shipModifiers(ship(B))[0].value, 15);
    assert.strictEqual(r.effects.shipModifiers(ship(C))[0].value, 6);
    assert.deepStrictEqual([r.effects.shipModifiers(ship(D)), r.effects.damageMultiplier(ship(F), "turret")], [[], 1]);
    influenceMilli = 420;
    driver.publish();
    assert.deepStrictEqual([sets.at(-1), sA.calls.length, driver.status().pending], [[4, 0], 3, 0]);
    driver.publish();
    assert.strictEqual(sA.calls.length, 3, "current stamps: no refresh");
    assert.deepStrictEqual(bumps, { effectsPublished: 4, effectsRefreshed: 3 });
    driver.stop();
    assert.deepStrictEqual([sets.at(-1), sA.calls.length, driver.status().state, driver.status().pending],
      [[null, 4], 5, "stopped", 1]);
    assert.deepStrictEqual(r.effects.shipModifiers(ship(A)), []);
  });
};
