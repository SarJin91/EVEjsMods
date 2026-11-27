"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const structures = require("../../lib/adapter/structures");
const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
const { createStructuresService } = require("../../lib/stations/structures/structuresService");
const { planPass } = require("../../lib/stations/structures/projection");
const SOV = require("../../lib/world/sovStructures/schema");
const { harness: X } = require("./sovStructures.test");

const { H, AMARR, SANSHA, GURISTAS } = X;
const MOD_DIR = path.resolve(__dirname, "..", "..");
const TCU = 32226;
const CORP = 1000084;
const STATES = Object.freeze({ ANCHORING: 2, SHIELD_VULNERABLE: 110, ARMOR_REINFORCE: 111, ARMOR_VULNERABLE: 112,
  HULL_REINFORCE: 113, HULL_VULNERABLE: 114, ANCHOR_VULNERABLE: 115 });
const HUB = Object.freeze({ x: 1e9, y: 1e5, z: -5e8 });
const clone = (v) => JSON.parse(JSON.stringify(v));

function fakeVendor() {
  const calls = [];
  let rows = [];
  let nextId = 1040000000000;
  const at = (id) => rows.findIndex((r) => r.structureID === id);
  const state = {
    STRUCTURES_TABLE: "structures",
    getStructureTypeByID: (id) => (id === TCU || id === 35832 ? { typeID: id } : null),
    listStructures: () => rows.map(clone),
    getStructureByID: (id) => (at(id) >= 0 ? clone(rows[at(id)]) : null),
    createStructure(record) {
      calls.push("createStructure");
      const row = { ...clone(record), structureID: nextId, destroyedAt: null };
      nextId += 1;
      rows.push(row);
      return { success: true, data: clone(row) };
    },
    updateStructureRecord(id, updater) {
      calls.push("updateStructureRecord");
      const i = at(id);
      if (i < 0) return { success: false, errorMsg: "STRUCTURE_NOT_FOUND" };
      rows[i] = clone(updater(clone(rows[i])) || rows[i]);
      return { success: true, data: clone(rows[i]) };
    },
    destroyStructure(id, o) {
      calls.push("destroyStructure");
      rows[at(id)] = { ...rows[at(id)], destroyedAt: o.nowMs };
      return { success: true };
    },
    removeStructure(id) {
      calls.push("removeStructure");
      rows = rows.filter((r) => r.structureID !== id);
      return { success: true };
    },
    registerStructureChangeListener: () => () => {},
  };
  const modules = {
    state,
    constants: { STRUCTURE_STATE: { ...STATES }, STRUCTURE_UPKEEP_STATE: { FULL_POWER: 1 } },
    placement: { validateDeploymentPlacement: () => ({ success: true, data: {} }) },
    worldData: { getCelestialsForSystem: () => [] },
    gameStore: { flushTableSync: () => {
      calls.push("flushTableSync");
      return { success: true };
    } },
  };
  const sovPlacement = { getDefaultHubPosition: (sys) => (sys === 1 ? null : { ...HUB }) };
  const requireGame = (p) => {
    if (p === structures.SOV_PLACEMENT_PATH) return { ok: true, exports: sovPlacement };
    const key = Object.keys(structures.PATHS).find((k) => structures.PATHS[k] === p);
    return key ? { ok: true, exports: modules[key] } : { ok: false, reason: "missing" };
  };
  return { modules, calls, rows: () => rows, requireGame,
    shoot: (id, nowMs) => { rows[at(id)] = { ...rows[at(id)], destroyedAt: nowMs }; } };
}

const SOV_INPUT = Object.freeze({ tag: { sovStructureId: "sovg:30002000:500003:1", world: 7 }, typeId: TCU,
  systemId: 30002000, ownerCorpId: CORP, name: null, position: { x: 1, y: 2, z: 3 }, state: 110, stateEndsAt: null,
  condition: { damage: 0 }, docking: "none", quantumCore: false, at: 5000 });

function physicalEnv(reopen, shared, envOver = {}) {
  const vendor = fakeVendor();
  const seam = structures.createStructureSeam({ requireGame: vendor.requireGame });
  const observed = { list: [] };
  const env = X.bootSov(reopen(), shared, { EVEJS_LNE_SOV_STRUCTURES_PHYSICAL_LINGER_MS: "60000", ...envOver }, null, {
    adapter: { sovStructureSeams: () => ({ ok: true, seam }) },
    getPresence: () => ({ observedSystems: () => [...observed.list], getStatus: () => ({ available: true }),
      distanceToObserved: () => ({ ok: false, reason: "UNAVAILABLE" }) }),
    getRegistry: () => ({ corporationFor: () => CORP }),
    setTimer: () => ({ cancel() {}, hasRef: () => false }),
  });
  assert.ok(env.physical, "physical pump started");
  return { env, vendor, observed };
}

function heldSystem(env, systemId, controller, capturedAt) {
  X.seedSystem(env, systemId, controller);
  const r = env.tx((db) => env.repo.applyChange(db, { systemId, expectedVersion: 1, reason: "OCCUPATION_PHASE",
    state: { capturedAt } }, `test:capture:${systemId}`));
  assert.ok(r.ok, JSON.stringify(r));
}

const itemOf = (env, id) => X.rowOf(env, id).evejsItemId;
const journalCount = (env, key) => env.tx((db) => db.prepare("SELECT count(*) AS n FROM world_event_journal "
  + "WHERE idempotency_key = ?").get(key)).n;

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  test("SOVP1 vendor facts (source text): TCU 32226 required structure type, not a sov hub type, no sov-automation "
    + "key of the mod, getDefaultHubPosition exported, createStructure loads no scene, damage blocked only in the "
    + "reinforce states", () => {
    const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
    assert.ok(found.ok, JSON.stringify(found));
    const read = (...p) => fs.readFileSync(path.join(found.srcDir, ...p), "utf8").replace(/\r\n/g, "\n");
    const state = read("services", "structure", "structureState.js");
    const required = /const REQUIRED_NON_CATEGORY_STRUCTURE_TYPE_IDS = Object\.freeze\(\[([^\]]*)\]\)/.exec(state);
    assert.ok(required, "REQUIRED_NON_CATEGORY_STRUCTURE_TYPE_IDS");
    assert.ok(/\b32226\b/.test(required[1]), "32226 required");
    assert.strictEqual((state.match(/ensureScene/g) || []).length, 0, "structureState never loads a scene");

    const interop = read("services", "sovereignty", "sovSpaceInterop.js");
    const sovTypes = /const SOVEREIGNTY_TYPE_IDS = new Set\(\[([^\]]*)\]\)/.exec(interop);
    assert.ok(sovTypes, "SOVEREIGNTY_TYPE_IDS");
    assert.deepStrictEqual(sovTypes[1].split(",").map((t) => t.trim()).filter(Boolean),
      ["TYPE_INFRASTRUCTURE_HUB", "34832"]);
    assert.ok(/const TYPE_INFRASTRUCTURE_HUB = 32458;/.test(read("services", "sovereignty", "sovConstants.js")));
    const aux = interop.slice(interop.indexOf("function isSovereigntyAuxiliaryStructure("));
    const auxBody = aux.slice(0, aux.indexOf("\n}\n"));
    assert.ok(/devFlags\.sovAutomation === true/.test(auxBody), "aux body located");
    assert.ok(!auxBody.includes(structures.SOV_TAG_KEY) && !auxBody.includes("lne"), "no key of the mod");

    const placement = read("services", "sovereignty", "sovHubPlacement.js");
    assert.ok(/\nfunction getDefaultHubPosition\(solarSystemID\)/.test(placement));
    assert.ok(/module\.exports = \{[^}]*\bgetDefaultHubPosition,/.test(placement), "exported");

    const damage = read("space", "runtime", "targetDamageApplication.js");
    assert.ok(/targetEntity\.kind === "structure" &&\n\s*!STRUCTURE_VULNERABLE_STATES\.has\(toInt\(targetEntity\.state, 0\)\)/
      .test(damage), "damage gate");
    const constants = read("services", "structure", "structureConstants.js");
    const vulnerable = /const STRUCTURE_VULNERABLE_STATES = new Set\(\[([^\]]*)\]\)/.exec(constants);
    assert.ok(vulnerable, "STRUCTURE_VULNERABLE_STATES");
    assert.deepStrictEqual(vulnerable[1].split(",").map((t) => t.trim()).filter(Boolean),
      ["STRUCTURE_STATE.ONLINING_VULNERABLE", "STRUCTURE_STATE.SHIELD_VULNERABLE", "STRUCTURE_STATE.ARMOR_VULNERABLE",
        "STRUCTURE_STATE.HULL_VULNERABLE", "STRUCTURE_STATE.ANCHOR_VULNERABLE", "STRUCTURE_STATE.DEPLOY_VULNERABLE"]);
  });

  test("SOVP2 adapter sov methods on a fake vendor: create -> ALREADY_TAGGED at the second; the station tag of a sov "
    + "TCU is null and the station cleanup / full plan never touches it; destroy writes lneModDestroyedAt; NO_SUN", () => {
    const v = fakeVendor();
    const seam = structures.createStructureSeam({ requireGame: v.requireGame });
    const created = seam.createSovTaggedStructure(SOV_INPUT);
    assert.strictEqual(created.ok, true, JSON.stringify(created));
    assert.deepStrictEqual(seam.createSovTaggedStructure(SOV_INPUT), { ok: false, reason: "ALREADY_TAGGED",
      structureId: created.structureId });
    const row = v.rows()[0];
    assert.deepStrictEqual(row.devFlags, { lneSovStructureId: "sovg:30002000:500003:1", lneWorld: 7 });
    assert.strictEqual(structures.tagOfRow(row), null, "no station tag");
    assert.deepStrictEqual(seam.getSovStructure(created.structureId).row.tag,
      { sovStructureId: "sovg:30002000:500003:1", world: 7 });
    assert.deepStrictEqual(seam.listTaggedStructures().rows, [], "station listing");
    assert.strictEqual(seam.listSovTaggedStructures().rows.length, 1);

    const cleanup = createStructuresService({ seam, states: seam.readStructureStates(), store: null,
      clock: { now: () => 9000 }, worldSeed: null, settings: { passMs: 1000, maxWritesPerPass: 4 }, mode: "cleanup",
      setTimer: () => ({ cancel() {}, hasRef: () => false }) });
    cleanup.runPass();
    assert.deepStrictEqual([v.calls.includes("removeStructure"), cleanup.getStatus().remaining], [false, 0]);
    assert.deepStrictEqual(planPass({ live: [], tagged: new Map(), dirty: null, applied: new Map(), now: 9000,
      cfg: { dockingAccess: "public", quantumCore: false }, states: seam.readStructureStates(), world: 7,
      maxWrites: 8 }).ops, []);

    const tag = { sovStructureId: "sovg:30002000:500003:1", world: 7 };
    assert.strictEqual(seam.destroyTaggedStructure(created.structureId, { stationId: "x", world: 7 }, 9100).reason,
      "TAG_MISMATCH", "a station tag never destroys a TCU");
    assert.deepStrictEqual(seam.destroySovTaggedStructure(created.structureId, tag, 9100),
      { ok: true, alreadyDestroyed: false });
    const destroyed = seam.getSovStructure(created.structureId).row;
    assert.deepStrictEqual([destroyed.destroyedAt, destroyed.modDestroyed, v.rows()[0].devFlags.lneModDestroyedAt],
      [9100, true, 9100]);
    assert.deepStrictEqual(seam.sovPosition(30002000, 30000), { ok: true,
      position: { x: HUB.x + 30000, y: HUB.y, z: HUB.z } });
    assert.deepStrictEqual(seam.sovPosition(1, 30000), { ok: false, reason: "NO_SUN", detail: "1" });
  });

  needsDriver("SOVP3 pump: an observed system with a live row -> CREATE (TCU 32226, SHIELD_VULNERABLE, sov tag, owner "
    + "corporation, hub + offset) + evejs_item_id after the flush; a second pass writes nothing; unobserved for "
    + "lingerMs -> REMOVE + evejs_item_id NULL", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const { env, vendor, observed } = physicalEnv(reopen, shared);
      const now = shared.clock.now();
      heldSystem(env, H.S.N5, GURISTAS, 1000);
      const id = SOV.grandfatheredIdOf(H.S.N5, GURISTAS, 1000);
      env.tx((db) => env.sovRepo.insertGrandfathered(db, { systemId: H.S.N5, factionId: GURISTAS, capturedAt: 1000,
        at: now }));
      env.physical.runPass();
      assert.deepStrictEqual(vendor.rows(), [], "not observed: nothing");
      observed.list = [H.S.N5];
      env.physical.runPass();
      const tcu = vendor.rows()[0];
      const worldSeed = env.tx((db) => db.prepare("SELECT value FROM lne_meta WHERE key = 'world_seed'").get()).value;
      assert.deepStrictEqual([vendor.rows().length, tcu.typeID, tcu.state, tcu.ownerCorpID, tcu.solarSystemID,
        tcu.devFlags, tcu.position, tcu.accessProfile.docking, tcu.hasQuantumCore], [1, TCU,
        STATES.SHIELD_VULNERABLE, CORP, H.S.N5, { lneSovStructureId: id, lneWorld: worldSeed },
        { x: HUB.x + 30000, y: HUB.y, z: HUB.z }, "none", false]);
      assert.strictEqual(itemOf(env, id), tcu.structureID);
      assert.deepStrictEqual(vendor.calls, ["createStructure", "flushTableSync"]);
      env.physical.runPass();
      assert.deepStrictEqual(vendor.calls, ["createStructure", "flushTableSync"], "level: nothing to do");

      observed.list = [];
      shared.clock.advance(30000);
      env.physical.runPass();
      assert.strictEqual(vendor.rows().length, 1, "lingers");
      shared.clock.advance(30000);
      env.physical.runPass();
      assert.deepStrictEqual([vendor.rows().length, itemOf(env, id), vendor.calls.slice(2)],
        [0, null, ["removeStructure", "flushTableSync"]]);
      const c = env.sov.getStatus().physical.counters;
      assert.deepStrictEqual([c.physicalCreated, c.physicalRemoved, c.physicalRefused, c.liveKills], [1, 1, 0, 0]);
      assert.strictEqual(X.rowOf(env, id).state, SOV.ONLINE, "the row stays live");
    }));

  needsDriver("SOVP3b durable flush: the pass waits for it, a second pass joins the one in flight, the item id is "
    + "recorded after it; stopped before it settles -> nothing recorded", async () => {
    const run = (stopFirst) => H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const { env, vendor, observed } = physicalEnv(reopen, shared);
      let release = null;
      vendor.modules.gameStore.flushTableDurable = () => {
        vendor.calls.push("flushTableDurable");
        return new Promise((resolve) => { release = () => resolve({ success: true }); });
      };
      heldSystem(env, H.S.N5, GURISTAS, 1000);
      const id = SOV.grandfatheredIdOf(H.S.N5, GURISTAS, 1000);
      env.tx((db) => env.sovRepo.insertGrandfathered(db, { systemId: H.S.N5, factionId: GURISTAS, capturedAt: 1000,
        at: shared.clock.now() }));
      observed.list = [H.S.N5];
      const first = env.physical.runPass();
      const second = env.physical.runPass();
      assert.ok(first && typeof first.then === "function" && second === first, "one pass in flight");
      assert.deepStrictEqual([vendor.calls, itemOf(env, id)], [["createStructure", "flushTableDurable"], null]);
      if (stopFirst) env.physical.stop();
      release();
      await first;
      return [vendor.rows().length, itemOf(env, id) === (vendor.rows()[0] || {}).structureID, itemOf(env, id)];
    });
    const done = await run(false);
    assert.deepStrictEqual(done.slice(0, 2), [1, true], "recorded after the flush");
    assert.deepStrictEqual(await run(true), [1, false, null], "no record after stop");
  });

  needsDriver("SOVP4 pump: a TCU destroyed in EveJS without the mod mark -> DESTROYED LIVE_KILL + evejs_item_id NULL "
    + "+ abandonInTx once for the controller (controller null); the pretender's ANCHORING TCU -> LIVE_KILL without an "
    + "abandon; a second pass changes nothing", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const { env, vendor, observed } = physicalEnv(reopen, shared);
      const now = shared.clock.now();
      heldSystem(env, H.S.N5, GURISTAS, 1000);
      const held = SOV.grandfatheredIdOf(H.S.N5, GURISTAS, 1000);
      env.tx((db) => env.sovRepo.insertGrandfathered(db, { systemId: H.S.N5, factionId: GURISTAS, capturedAt: 1000,
        at: now }));
      X.seedSystem(env, H.S.N6, AMARR, SANSHA);
      const a = env.tx((db) => env.sov.applyOpsInTx(db, { systemId: H.S.N6,
        ops: [{ op: SOV.OP.ANCHOR, factionId: SANSHA, claimSeq: 2 }], at: now }, "test:sovp4:anchor"));
      assert.ok(a.ok && a.results[0].outcome === SOV.OUTCOME.APPLIED, JSON.stringify(a));
      const pretender = a.results[0].structureId;
      observed.list = [H.S.N5, H.S.N6];
      env.physical.runPass();
      const tcuOf = (id) => vendor.rows().find((r) => r.devFlags.lneSovStructureId === id);
      assert.deepStrictEqual([tcuOf(held).state, tcuOf(pretender).state, tcuOf(pretender).stateEndsAt],
        [STATES.SHIELD_VULNERABLE, STATES.ANCHOR_VULNERABLE, X.rowOf(env, pretender).dueAt]);

      shared.clock.advance(1000);
      vendor.shoot(tcuOf(held).structureID, shared.clock.now());
      vendor.shoot(tcuOf(pretender).structureID, shared.clock.now());
      env.physical.runPass();
      env.physical.runPass();
      const rowOf = (id) => { const r = X.rowOf(env, id); return [r.state, r.endReason, r.evejsItemId]; };
      const sysOf = (sys) => env.tx((db) => env.repo.getSystem(db, sys, {})).system;
      assert.deepStrictEqual({ held: rowOf(held), pretender: rowOf(pretender),
        controllers: [sysOf(H.S.N5).controllerFactionId, sysOf(H.S.N6).controllerFactionId],
        abandons: [journalCount(env, SOV.abandonKey(held)), journalCount(env, SOV.abandonKey(pretender))],
        liveKills: env.sov.getStatus().physical.counters.liveKills }, {
        held: [SOV.DESTROYED, SOV.REASON.LIVE_KILL, null],
        pretender: [SOV.DESTROYED, SOV.REASON.LIVE_KILL, null],
        controllers: [null, AMARR],
        abandons: [1, 0],
        liveKills: 2,
      });
      assert.ok(!vendor.calls.includes("destroyStructure"), "the mod never destroys a TCU the player destroyed");
    }));

  needsDriver("SOVP6: an unobserved TCU in HULL_REINFORCE outlives lingerMs and goes once it "
    + "rests again; a TCU outside a resting state longer than reinforceHoldMaxMs goes (reinforceHoldExpired)", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const { env, vendor, observed } = physicalEnv(reopen, shared,
        { EVEJS_LNE_SOV_STRUCTURES_PHYSICAL_REINFORCE_HOLD_MAX_MS: "200000" });
      const now = shared.clock.now();
      for (const sys of [H.S.N5, H.S.N6]) {
        heldSystem(env, sys, GURISTAS, 1000);
        env.tx((db) => env.sovRepo.insertGrandfathered(db, { systemId: sys, factionId: GURISTAS, capturedAt: 1000,
          at: now }));
      }
      const tcuIn = (sys) => vendor.rows().find((r) => r.solarSystemID === sys);
      observed.list = [H.S.N5, H.S.N6];
      env.physical.runPass();
      assert.strictEqual(vendor.rows().length, 2);
      tcuIn(H.S.N5).state = STATES.HULL_REINFORCE;
      tcuIn(H.S.N6).state = STATES.HULL_REINFORCE;
      env.physical.runPass();
      observed.list = [];
      shared.clock.advance(120000);
      env.physical.runPass();
      assert.deepStrictEqual([vendor.rows().length, tcuIn(H.S.N5).state], [2, STATES.HULL_REINFORCE],
        "held past lingerMs, the reinforce state untouched");
      tcuIn(H.S.N5).state = STATES.SHIELD_VULNERABLE;
      env.physical.runPass();
      assert.deepStrictEqual([tcuIn(H.S.N5), !!tcuIn(H.S.N6)], [undefined, true], "rests again -> the linger goes on");
      shared.clock.advance(80000);
      env.physical.runPass();
      const c = env.sov.getStatus().physical.counters;
      assert.deepStrictEqual([vendor.rows().length, c.physicalRemoved, c.reinforceHoldExpired, c.physicalRefused],
        [0, 2, 1, 0]);
    }));

  test("SOVP7 desiredPatch: an ANCHORING row whose TCU the vendor already moved further "
    + "(ANCHORING / SHIELD_VULNERABLE) is not patched back; a new TCU still gets ANCHOR_VULNERABLE", () => {
    const { desiredPatch } = require("../../lib/world/sovStructures/physical");
    const row = { state: SOV.ANCHORING, dueAt: 9000 };
    assert.deepStrictEqual([desiredPatch(row, { state: STATES.ANCHORING }, STATES, 5000),
      desiredPatch(row, { state: STATES.SHIELD_VULNERABLE }, STATES, 5000)], [null, null]);
    const fresh = desiredPatch(row, { state: null }, STATES, 5000);
    assert.deepStrictEqual([fresh.state, fresh.stateEndsAt], [STATES.ANCHOR_VULNERABLE, 9000]);
  });

  test("SOVP5 the real structure facade has the station + sov methods (rule unknown-method); without a vendor every "
    + "sov method refuses STRUCTURES_SEAM_UNAVAILABLE; adapter.sovStructureSeams after a probe without server src -> "
    + "SEAM_UNAVAILABLE", () => {
    const seam = structures.createStructureSeam({ requireGame: () => ({ ok: false, reason: "not_booted" }) });
    assert.deepStrictEqual(Object.keys(seam), [...structures.SEAM_METHODS]);
    assert.deepStrictEqual(structures.SEAM_METHODS, [...structures.STATION_SEAM_METHODS,
      ...structures.SOV_SEAM_METHODS, ...structures.FC_SEAM_METHODS]);
    assert.deepStrictEqual(structures.SOV_SEAM_METHODS, ["listSovTaggedStructures", "getSovStructure",
      "createSovTaggedStructure", "updateSovTaggedStructure", "destroySovTaggedStructure", "removeSovTaggedStructure",
      "sovPosition"]);
    for (const name of structures.SOV_SEAM_METHODS) {
      assert.strictEqual(seam[name](1, { sovStructureId: "s", world: 1 }, { at: 1 }).reason,
        "STRUCTURES_SEAM_UNAVAILABLE", name);
    }
    const { createAdapter } = require("../../lib/adapter");
    const adapter = createAdapter({ moduleApi: { _cache: {} } });
    const before = adapter.sovStructureSeams();
    assert.strictEqual(before.ok, true);
    assert.strictEqual(before.seam, adapter.getStructureSeam(), "the one structure facade of the adapter");
    adapter.runProbe();
    assert.deepStrictEqual(adapter.sovStructureSeams(), { ok: false, reason: "SEAM_UNAVAILABLE",
      detail: "server_src_not_found" });
  });
};
