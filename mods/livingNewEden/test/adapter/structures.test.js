"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const structures = require("../../lib/adapter/structures");
const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
const { createAdapter } = require("../../lib/adapter");
const { SEAM_REASONS } = require("../../lib/stations/structures/schema");
const { planPass } = require("../../lib/stations/structures/projection");
const { createFakeStructureSeam, DEFAULT_STATES, DEFAULT_UPKEEP } = require("../_support/fakeStructureSeam");

const clone = (v) => JSON.parse(JSON.stringify(v));
const TAG = Object.freeze({ stationId: "st-amarr-1", world: 7 });
const MOD_DIR = path.resolve(__dirname, "..", "..");

const toInt = (v, fb = 0) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : fb);
const normalizeLikeVendor = (e) => ({ ...e,
  stateEndsAt: Number.isFinite(Number(e.stateEndsAt)) ? toInt(e.stateEndsAt, 0) : null,
  destroyedAt: Number.isFinite(Number(e.destroyedAt)) ? toInt(e.destroyedAt, 0) : null });

function fakeVendor() {
  const calls = [];
  const listeners = new Set();
  let rows = [];
  let nextId = 1030000000000;
  const persist = (next) => {
    const prev = rows.map(clone);
    rows = next.map(clone).map(normalizeLikeVendor);
    const prevById = new Map(prev.map((r) => [r.structureID, r]));
    const nextById = new Map(rows.map((r) => [r.structureID, r]));
    const systemIDs = [...new Set([...prevById.keys(), ...nextById.keys()]
      .filter((id) => JSON.stringify(prevById.get(id) || null) !== JSON.stringify(nextById.get(id) || null))
      .flatMap((id) => [prevById.get(id), nextById.get(id)])
      .filter(Boolean).map((r) => r.solarSystemID))];
    for (const fn of listeners) {
      try { fn({ systemIDs, previousRows: prev.map(clone), nextRows: rows.map(clone) }); } catch (err) {}
    }
    return { success: true };
  };
  const state = {
    STRUCTURES_TABLE: "structures",
    getStructureTypeByID: (id) => (id === 35832 ? { typeID: id, name: "Astrahus" } : null),
    listStructures: (o) => { calls.push(["listStructures", o]); return rows.map(clone); },
    getStructureByID: (id, o) => {
      calls.push(["getStructureByID", id, o]);
      return rows.find((r) => r.structureID === id) || null;
    },
    createStructure(record) {
      calls.push(["createStructure", clone(record)]);
      const row = { ...clone(record), structureID: nextId, destroyedAt: null };
      nextId += 1;
      persist([...rows, row]);
      return { success: true, data: clone(rows.find((r) => r.structureID === row.structureID)) };
    },
    updateStructureRecord(id, updater) {
      calls.push(["updateStructureRecord", id]);
      const cur = rows.find((r) => r.structureID === id);
      if (!cur) return { success: false, errorMsg: "STRUCTURE_NOT_FOUND" };
      const next = updater(clone(cur)) || cur;
      persist(rows.map((r) => (r.structureID === id ? next : r)));
      return { success: true, data: clone(next) };
    },
    destroyStructure(id, o) {
      calls.push(["destroyStructure", id, o]);
      persist(rows.map((r) => (r.structureID === id ? { ...r, destroyedAt: o.nowMs } : r)));
      return { success: true };
    },
    removeStructure(id, o) {
      calls.push(["removeStructure", id, o]);
      if (id === 999) return { success: false, errorMsg: "STRUCTURE_NOT_EMPTY" };
      persist(rows.filter((r) => r.structureID !== id));
      return { success: true };
    },
    registerStructureChangeListener(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  const vendor = {
    state,
    constants: { STRUCTURE_STATE: { ANCHORING: 2, SHIELD_VULNERABLE: 110, ARMOR_REINFORCE: 111, ARMOR_VULNERABLE: 112,
      HULL_REINFORCE: 113, HULL_VULNERABLE: 114, ANCHOR_VULNERABLE: 115 }, STRUCTURE_UPKEEP_STATE: { FULL_POWER: 1 } },
    placement: { validateDeploymentPlacement: (i) => (i.position.x === 0
      ? { success: false, errorMsg: "DEPLOYMENT_CONFLICT", data: { blockerItemID: 40000001 } }
      : { success: true, data: {} }) },
    worldData: { getCelestialsForSystem: () => [{ itemID: 2, typeID: 6, position: { x: 1, y: 2, z: 3 } },
      { itemID: 1, typeID: 7, position: { x: 4, y: 5, z: 6 }, radius: 9 }, { itemID: 3, position: null }] },
    gameStore: { flushTableSync: (t) => { calls.push(["flushTableSync", t]); return { success: true }; } },
  };
  return { vendor, calls, listeners, rows: () => rows, foreign: (next) => persist(next) };
}

const CREATE = Object.freeze({ tag: TAG, typeId: 35832, systemId: 30001721, ownerCorpId: 1000084, name: null,
  position: { x: 1e7, y: 0, z: 0 }, state: 110, stateEndsAt: null, condition: { damage: 0 }, docking: "public",
  quantumCore: false, at: 5000 });

function seamOn(vendor) {
  const loads = [];
  const seam = structures.createStructureSeam({ requireGame: (p) => {
    loads.push(p);
    const key = Object.keys(structures.PATHS).find((k) => structures.PATHS[k] === p);
    return { ok: true, exports: vendor[key] };
  } });
  return { seam, loads };
}

module.exports = ({ test }) => {
  test("TS4 structure seam: tag guard before the vendor, selfWrite mutes the listener, SEAM_ERROR, flush "
    + "ambiguous, lazy facade, fake parity", () => {
    const f = fakeVendor();
    const { seam, loads } = seamOn(f.vendor);
    assert.deepStrictEqual(loads, [], "lazy: nothing required before the first call");
    assert.deepStrictEqual(seam.checkStructureSeams(), { ok: true });
    assert.deepStrictEqual(loads, Object.values(structures.PATHS));
    assert.deepStrictEqual(seam.readStructureStates().states.ANCHOR_VULNERABLE, 115);

    const heard = [];
    const sub = seam.subscribeStructureChanges((evt) => heard.push(evt.stationIds));
    assert.strictEqual(sub.ok, true);
    const created = seam.createTaggedStructure(CREATE);
    assert.strictEqual(created.ok, true);
    const id = created.structureId;
    const record = f.calls.find((c) => c[0] === "createStructure")[1];
    assert.deepStrictEqual([record.devFlags, record.accessProfile, record.rotation, record.stateStartedAt,
      record.upkeepState, record.allianceID, "name" in record], [{ lneStationId: "st-amarr-1", lneWorld: 7 },
      { docking: "public", tethering: "none" }, [0, 0, 0], 5000, 1, null, false]);
    assert.ok(f.calls.filter((c) => c[0] === "listStructures").every((c) => c[1].refresh === false), "refresh:false");
    assert.deepStrictEqual([f.rows()[0].stateEndsAt, f.rows()[0].destroyedAt], [0, 0]);
    assert.deepStrictEqual(seam.createTaggedStructure(CREATE),
      { ok: false, reason: "ALREADY_TAGGED", structureId: id });
    assert.deepStrictEqual(seam.createTaggedStructure({ ...CREATE, tag: { stationId: "x", world: 7 }, typeId: 1 }),
      { ok: false, reason: "TYPE_UNKNOWN", detail: "1" });

    assert.deepStrictEqual(seam.updateTaggedStructure(id, TAG, { state: 111, stateEndsAt: 9000, at: 6000 }),
      { ok: true });
    assert.deepStrictEqual(heard, []);
    const row = f.rows().find((r) => r.structureID === id);
    assert.deepStrictEqual([row.state, row.stateStartedAt, row.stateEndsAt, row.devFlags.lneStationId],
      [111, 6000, 9000, "st-amarr-1"]);
    f.foreign(f.rows().map((r) => (r.structureID === id ? { ...r, state: 112 } : r)));
    f.foreign([...f.rows(), { structureID: 5, solarSystemID: 30001721, devFlags: {} }]);
    assert.deepStrictEqual(heard, [["st-amarr-1"]]);

    const before = f.calls.length;
    const other = { stationId: "st-other", world: 7 };
    assert.deepStrictEqual(seam.updateTaggedStructure(id, other, { state: 110, at: 1 }),
      { ok: false, reason: "TAG_MISMATCH" });
    assert.deepStrictEqual(seam.destroyTaggedStructure(id, { ...TAG, world: 8 }, 1),
      { ok: false, reason: "TAG_MISMATCH" });
    assert.deepStrictEqual(seam.removeTaggedStructure(5, TAG), { ok: false, reason: "TAG_MISMATCH" });
    assert.deepStrictEqual(seam.updateTaggedStructure(id, null, { at: 1 }), { ok: false, reason: "TAG_REQUIRED" });
    assert.deepStrictEqual(seam.createTaggedStructure({ ...CREATE, tag: undefined }),
      { ok: false, reason: "TAG_REQUIRED" });
    assert.deepStrictEqual(f.calls.slice(before).map((c) => c[0]).filter((n) => !n.startsWith("get")
      && n !== "listStructures"), []);

    assert.deepStrictEqual(seam.destroyTaggedStructure(id, TAG, 7000), { ok: true, alreadyDestroyed: false });
    assert.deepStrictEqual(seam.destroyTaggedStructure(id, TAG, 8000), { ok: true, alreadyDestroyed: true });
    assert.strictEqual(f.calls.filter((c) => c[0] === "destroyStructure").length, 1, "destroyStructure once");
    assert.deepStrictEqual(seam.updateTaggedStructure(id, TAG, { at: 1 }), { ok: false, reason: "DESTROYED" });
    assert.deepStrictEqual(heard, [["st-amarr-1"]], "still muted");
    const listed = seam.listTaggedStructures();
    assert.deepStrictEqual(listed.rows.map((r) => [r.structureId, r.tag, r.destroyedAt]), [[id, TAG, 7000]]);
    assert.deepStrictEqual(seam.getStructure(id).row.tag, TAG);

    assert.deepStrictEqual(seam.listPlacementAnchors(30001721).anchors.map((a) => [a.itemId, a.radius]),
      [[1, 9], [2, 0]]);
    assert.deepStrictEqual(seam.validatePlacement({ systemId: 1, typeId: 35832, position: { x: 0, y: 0, z: 0 } }),
      { ok: true, valid: false, conflict: "DEPLOYMENT_CONFLICT:40000001" });
    assert.deepStrictEqual(seam.flushStructures(), { ok: true });
    assert.deepStrictEqual(f.calls[f.calls.length - 1], ["flushTableSync", "structures"]);

    f.vendor.state.updateStructureRecord = () => { throw new Error("boom"); };
    f.foreign([...f.rows(), { structureID: 7, solarSystemID: 30001721, devFlags: { lneStationId: "s7", lneWorld: 7 },
      destroyedAt: null }]);
    assert.deepStrictEqual(seam.updateTaggedStructure(7, { stationId: "s7", world: 7 }, { at: 1 }),
      { ok: false, reason: "SEAM_ERROR", detail: "boom" });
    f.vendor.gameStore.flushTableSync = () => ({ success: false, errorMsg: "WRITE_ERROR" });
    assert.deepStrictEqual(seam.flushStructures(), { ok: false, reason: "FLUSH_FAILED", ambiguous: true,
      detail: "WRITE_ERROR" });
    f.vendor.gameStore.flushTableSync = () => { throw new Error("role"); };
    assert.strictEqual(seam.flushStructures().ambiguous, true);
    assert.strictEqual(seam.removeTaggedStructure(998, TAG).reason, "NOT_FOUND");
    const s9 = { stationId: "s9", world: null };
    f.foreign([...f.rows(), { structureID: 999, solarSystemID: 1, devFlags: { lneStationId: "s9" },
      destroyedAt: null }]);
    assert.deepStrictEqual(seam.removeTaggedStructure(999, s9), { ok: false, reason: "NOT_EMPTY",
      detail: "STRUCTURE_NOT_EMPTY" });
    assert.deepStrictEqual(f.calls[f.calls.length - 1], ["removeStructure", 999, {}], "no discardContents");

    const sub2 = seam.subscribeStructureChanges(() => { throw new Error("subscriber"); });
    assert.strictEqual(f.listeners.size, 1);
    f.foreign(f.rows().map((r) => (r.structureID === 7 ? { ...r, state: 110 } : r)));
    sub.unsubscribe();
    sub2.unsubscribe();
    assert.strictEqual(f.listeners.size, 0);

    const broken = structures.createStructureSeam({ requireGame: () => ({ ok: false, reason: "not_booted" }) });
    assert.strictEqual(broken.listTaggedStructures().reason, "STRUCTURES_SEAM_UNAVAILABLE");
    const brokenFlush = broken.flushStructures();
    assert.deepStrictEqual([brokenFlush.reason, brokenFlush.ambiguous], ["FLUSH_FAILED", true]);
    assert.deepStrictEqual(Object.keys(seam).sort(), [...structures.SEAM_METHODS].sort());
    assert.deepStrictEqual(Object.keys(createFakeStructureSeam().seam).sort(),
      [...structures.STATION_SEAM_METHODS, ...structures.FC_SEAM_METHODS].sort());
    assert.deepStrictEqual({ ...SEAM_REASONS }, { ...structures.REASONS });
    const fake = createFakeStructureSeam();
    for (const bad of [{ ...CREATE, ownerCorpId: 0 }, { ...CREATE, docking: "corp?" }, { ...CREATE, at: -1 },
      { ...CREATE, stateEndsAt: 1.5 }, { ...CREATE, tag: { stationId: "", world: 7 } }]) {
      assert.deepStrictEqual(fake.seam.createTaggedStructure(bad), seam.createTaggedStructure(bad), JSON.stringify(bad));
    }
    assert.deepStrictEqual(fake.seam.updateTaggedStructure(7, TAG, { state: 110 }),
      seam.updateTaggedStructure(7, TAG, { state: 110 }), "patch without at");
    assert.deepStrictEqual(fake.seam.getStructure(0), seam.getStructure(0));
    assert.deepStrictEqual(fake.seam.validatePlacement({ systemId: 1, typeId: 35832 }),
      seam.validatePlacement({ systemId: 1, typeId: 35832 }));
    assert.strictEqual(fake.seam.createTaggedStructure(CREATE).ok, true);
    assert.deepStrictEqual(Object.keys(fake.seam.listTaggedStructures().rows[0]),
      Object.keys(seam.listTaggedStructures().rows[0]), "same StructureView fields");

    const adapter = createAdapter({ moduleApi: { _cache: {} } });
    assert.strictEqual(adapter.getStructureSeam(), adapter.getStructureSeam(), "singleton");
    assert.strictEqual(adapter.checkStructureSeams().reason, "STRUCTURES_SEAM_UNAVAILABLE");
  });

  test("NN1: destroyTaggedStructure marks devFlags.lneModDestroyedAt after "
    + "destroyStructure, view modDestroyed, alreadyDestroyed does not mark, a failed mark -> markFailed; vendor facts",
  () => {
    const f = fakeVendor();
    const { seam } = seamOn(f.vendor);
    const id = seam.createTaggedStructure(CREATE).structureId;
    assert.strictEqual(seam.getStructure(id).row.modDestroyed, false);
    const from = f.calls.length;
    assert.deepStrictEqual(seam.destroyTaggedStructure(id, TAG, 7000), { ok: true, alreadyDestroyed: false });
    assert.deepStrictEqual(f.calls.slice(from).map((c) => c[0]).filter((n) => !n.startsWith("get")),
      ["destroyStructure", "updateStructureRecord"]);
    const row = f.rows().find((r) => r.structureID === id);
    assert.deepStrictEqual([row.devFlags.lneModDestroyedAt, row.devFlags.lneStationId, row.destroyedAt],
      [7000, "st-amarr-1", 7000]);
    assert.deepStrictEqual([seam.getStructure(id).row.modDestroyed, seam.listTaggedStructures().rows[0].modDestroyed],
      [true, true]);
    const marks = () => f.calls.filter((c) => c[0] === "updateStructureRecord").length;
    assert.deepStrictEqual([seam.destroyTaggedStructure(id, TAG, 8000), marks()],
      [{ ok: true, alreadyDestroyed: true }, 1], "alreadyDestroyed: no mark");

    const g = fakeVendor();
    const s2 = seamOn(g.vendor).seam;
    const id2 = s2.createTaggedStructure(CREATE).structureId;
    g.vendor.state.updateStructureRecord = () => ({ success: false, errorMsg: "WRITE_ERROR" });
    assert.deepStrictEqual(s2.destroyTaggedStructure(id2, TAG, 7000),
      { ok: true, alreadyDestroyed: false, markFailed: true });
    assert.deepStrictEqual([g.rows()[0].destroyedAt, s2.getStructure(id2).row.modDestroyed], [7000, false]);
    const h = fakeVendor();
    const s3 = seamOn(h.vendor).seam;
    const id3 = s3.createTaggedStructure(CREATE).structureId;
    h.vendor.state.updateStructureRecord = () => { throw new Error("boom"); };
    assert.deepStrictEqual(s3.destroyTaggedStructure(id3, TAG, 7000),
      { ok: true, alreadyDestroyed: false, markFailed: true });

    const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
    assert.ok(found.ok, JSON.stringify(found));
    const text = fs.readFileSync(path.join(found.srcDir, "services", "structure", "structureState.js"), "utf8");
    const body = (name) => {
      const at = text.indexOf(`\nfunction ${name}(`);
      assert.ok(at >= 0, name);
      return text.slice(at, text.indexOf("\nfunction ", at + 1));
    };
    assert.ok(/listStructures\(\{\s*includeDestroyed: true,/.test(body("updateStructureRecord")), "includeDestroyed");
    assert.ok(/\(currentStructure\) => \(\{\s*\.\.\.currentStructure,\s*destroyedAt: nowMs,/
      .test(body("destroyStructure")), "destroyStructure spreads ...currentStructure");
    assert.ok(/\.filter\(\(entry\) => includeDestroyed \|\| !entry\.destroyedAt\)/.test(body("listStructures")),
      "listStructures without includeDestroyed drops destroyed rows");
  });

  test("TS4 vendor row after normalization (null -> 0): view null, planPass ONLINE NOOP / DESTROYED "
    + "DESTROY; systemIDs filter", () => {
    const row = normalizeLikeVendor(normalizeLikeVendor({ structureID: 1030000000000, typeID: 35832,
      solarSystemID: 30001721, ownerCorpID: 1000084, state: 110, stateEndsAt: null, upkeepState: 1,
      hasQuantumCore: false, accessProfile: { docking: "public", tethering: "none" },
      devFlags: { lneStationId: "s1", lneWorld: 77 } }));
    assert.deepStrictEqual([row.stateEndsAt, row.destroyedAt], [0, 0], "vendor shape after the second write");
    const views = structures.listTaggedStructuresFrom({ state: { listStructures: () => [row] } }).rows;
    assert.deepStrictEqual([views[0].stateEndsAt, views[0].destroyedAt], [null, null]);
    const timed = structures.listTaggedStructuresFrom({ state: { listStructures: () => [{ ...row,
      stateEndsAt: 9000, destroyedAt: 7000 }] } }).rows[0];
    assert.deepStrictEqual([timed.stateEndsAt, timed.destroyedAt], [9000, 7000]);

    const station = (state) => ({ stationId: "s1", kind: "upwell", typeId: 35832, systemId: 30001721,
      ownerCorporationId: 1000084, state, stateUntilAt: null, name: null });
    const plan = (state) => planPass({ live: [station(state)], tagged: new Map([["s1", views]]), dirty: null,
      applied: new Map(), now: 1e12, cfg: { dockingAccess: "public", quantumCore: false },
      states: { states: DEFAULT_STATES, upkeep: DEFAULT_UPKEEP }, world: 77, maxWrites: 8 }).ops.map((o) => o.op);
    assert.deepStrictEqual(plan("ONLINE"), []);
    assert.deepStrictEqual(plan("DESTROYED"), ["DESTROY"]);

    const tagged = { structureID: 5, solarSystemID: 30001721, state: 110, devFlags: { lneStationId: "s5" } };
    const payload = (systemIDs) => ({ systemIDs, previousRows: [tagged], nextRows: [{ ...tagged, state: 111 }] });
    assert.deepStrictEqual(structures.changedStationIds(payload([30000142])), []);
    assert.deepStrictEqual(structures.changedStationIds(payload([30001721])), ["s5"]);
  });
};
