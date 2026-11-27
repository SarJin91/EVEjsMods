"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createDroneJournal, JOURNAL_FILE_NAME } = require("../../lib/store/droneJournal");
const { createDroneAccess } = require("../../lib/adapter/droneAccess");
const { createDroneSidecar } = require("../../lib/core/droneTask");

const OWNER = 90000001;
const SHIP = 501;
const OTHER_SHIP = 502;
const SYSTEM = 30000142;
const DRONE_BAY = 87;
const TWIN = 4200000000000001;
const RAT = 9000001;

function tempJournal() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shipwing-drones-"));
  return { dir, file: path.join(dir, "mods", "shipWing", JOURNAL_FILE_NAME) };
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_err) {
  }
}

function entry(droneId, extra = {}) {
  return { droneId, shipItemId: SHIP, ownerCharacterId: OWNER, systemId: SYSTEM, launchedAtMs: 1000, ...extra };
}

function fakeVendor() {
  const v = { calls: [], items: new Map(), scenes: new Map() };
  v.items.set(SHIP, { itemID: SHIP, ownerID: OWNER, locationID: 60003760, flagID: 4 });
  const inSpace = (id, extra = {}) => v.items.set(id, { itemID: id, typeID: 2488, ownerID: OWNER, locationID: SYSTEM,
    flagID: 0, launcherID: SHIP, spaceState: { mode: "STOP" },
    conditionState: { damage: 0.1, armorDamage: 0.3, shieldCharge: 0.2, charge: 0.5 }, ...extra });
  v.inSpace = inSpace;
  const testing = {
    recallDronesToShipBay(scene, shipRecord, list, flag) {
      v.calls.push(["recall", shipRecord.itemID, list.map((e) => e.itemID), flag]);
      for (const e of list) {
        scene.entities.delete(e.itemID);
        v.items.set(e.itemID, { ...v.items.get(e.itemID), locationID: shipRecord.itemID, flagID: flag });
      }
      return { success: true, data: { droneIDs: list.map((e) => e.itemID) } };
    },
    serializePlayerCompanionScopeMetadata: () => ({}),
  };
  v.deps = {
    testing: () => testing,
    itemCustody: {
      CUSTODY_REASON: { DRONE_LAUNCH: "drone-launch", DRONE_RECOVER: "drone-recover" },
      custodyRef: {
        shipBay: (ownerID, shipID, flagID) => ({ kind: "ship-bay", ownerID, locationID: shipID, flagID }),
        inSpace: (ownerID, systemID) => ({ kind: "in-space", ownerID, locationID: systemID, flagID: 0 }),
      },
      transfer(cmd) {
        v.calls.push(["transfer", cmd.reason, cmd.idempotencyKey, cmd.from.kind, cmd.to.kind]);
        const item = v.items.get(cmd.items.itemID);
        if (!item || item.locationID !== cmd.from.locationID || item.flagID !== 0) {
          return { success: false, errorMsg: "ITEM_NOT_FOUND" };
        }
        const patch = (cmd.options && cmd.options.destinationItemPatch) || {};
        v.items.set(item.itemID, { ...item, ...patch, locationID: cmd.to.locationID, flagID: cmd.to.flagID });
        return { success: true, data: { changes: [] } };
      },
    },
    itemStore: {
      ITEM_FLAGS: { DRONE_BAY },
      findItemById: (id) => v.items.get(Number(id)) || null,
      normalizeShipConditionState: (cs) => ({ damage: cs.damage, armorDamage: cs.armorDamage,
        shieldCharge: cs.shieldCharge, charge: cs.charge, normalized: true }),
    },
    runtime: {
      scenes: v.scenes,
      isSolarSystemSceneLoaded: (id) => v.scenes.has(id),
    },
  };
  return v;
}

module.exports = ({ test }) => {
  test("DJ1 reclaim: a drone in space of the owner (launcherID the ship or null) -> custody DRONE_RECOVER "
    + "(key wing-drone-boot:<drone>:<ship>, full shield and capacitor, armor/hull damage kept, no launcher/space "
    + "state); a loaded scene with the entity -> the vendor recall; OWNER_CHANGED / SHIP_GONE refused, no move", () => {
    const v = fakeVendor();
    const access = createDroneAccess({ deps: v.deps, config: {} });
    v.inSpace(8001, { launcherID: null });
    assert.deepStrictEqual(access.reclaim(entry(8001)), { ok: true, how: "custody" });
    assert.deepStrictEqual(v.calls, [["transfer", "drone-recover", `wing-drone-boot:8001:${SHIP}`, "in-space",
      "ship-bay"]]);
    const row = v.items.get(8001);
    assert.deepStrictEqual([row.locationID, row.flagID, row.launcherID, row.spaceState, row.singleton, row.quantity],
      [SHIP, DRONE_BAY, null, null, 1, 1]);
    assert.deepStrictEqual(row.conditionState, { damage: 0.1, armorDamage: 0.3, shieldCharge: 1, charge: 1,
      normalized: true });
    v.calls.length = 0;
    v.inSpace(8002);
    v.scenes.set(SYSTEM, { systemID: SYSTEM, entities: new Map([[8002, { itemID: 8002 }]]),
      getEntityByID(id) { return this.entities.get(id) || null; } });
    assert.deepStrictEqual(access.reclaim(entry(8002)), { ok: true, how: "scene" });
    assert.deepStrictEqual(v.calls, [["recall", SHIP, [8002], DRONE_BAY]]);
    v.calls.length = 0;
    v.inSpace(8003, { launcherID: OTHER_SHIP });
    assert.deepStrictEqual(access.reclaim(entry(8003)), { ok: false, reason: "OWNER_CHANGED" });
    v.inSpace(8004);
    v.items.set(SHIP, { ...v.items.get(SHIP), ownerID: 90000099 });
    assert.deepStrictEqual(access.reclaim(entry(8004)), { ok: false, reason: "SHIP_GONE" });
    assert.deepStrictEqual(v.calls, []);
    const c = access.stats().counters;
    assert.deepStrictEqual([c["drone.reclaim.ok"], c["drone.reclaim.skipped.OWNER_CHANGED"],
      c["drone.reclaim.skipped.SHIP_GONE"]], [2, 1, 1]);
  });

  test("DJ2 the sidecar journal: launch -> entry; a failed rollback -> entry, drone.stranded; a refused end "
    + "recall (also drone by drone) keeps the entry; RESTART keeps; one write per flush; at the restart the "
    + "drone in space goes back, the one already in the bay is skipped (NOT_IN_SPACE) and every entry leaves", () => {
    const { dir, file } = tempJournal();
    try {
      const journal = createDroneJournal({ filePath: file });
      assert.strictEqual(journal.load().count, 0);
      const scene = { systemID: SYSTEM, entities: new Map([[RAT, { itemID: RAT }]]) };
      const twin = { itemID: TWIN, systemID: SYSTEM };
      scene.entities.set(TWIN, twin);
      const recalls = [];
      const access = {
        makeProxy: () => ({}),
        bayDrones: () => ({ ok: true, drones: [{ itemId: 701, typeId: 2488, quantity: 1, bandwidth: 5,
          kind: "combat" }, { itemId: 702, typeId: 2488, quantity: 1, bandwidth: 5, kind: "combat" }] }),
        limits: () => ({ ok: true, maxActive: 5, bandwidth: 25 }),
        launch(_scene, _twin, o) {
          if (o.itemId === 702) return { ok: false, reason: "SPAWN_FAILED", droneId: 8002 };
          scene.entities.set(8001, { itemID: 8001, kind: "drone", controllerID: TWIN });
          return { ok: true, droneId: 8001 };
        },
        recall(_s, _ship, list) {
          recalls.push(list.map((e) => e.itemID));
          return { ok: false, reason: "DRONE_INVENTORY_SOURCE_INVALID" };
        },
        combatSnapshot: () => ({ ok: false, reason: "NO_SNAPSHOT" }),
        ranges: () => ({ orbitDistance: 500, engagementRange: 500, movementRange: 500 }),
        orbit: () => true,
      };
      const ts = { simNow: () => 10000, entity: (s, id) => s.entities.get(Number(id)) || null,
        surfaceDistance: () => 1000 };
      const sidecar = createDroneSidecar({ access, scene: ts, combat: { checkTarget: () => ({ ok: true }) },
        journal, config: { droneMaxPerCopy: 5, droneLaunchesPerTick: 5, droneMaxCyclesPerTick: 5 } });
      const record = { shipItemId: SHIP, ownerCharacterId: OWNER, twinEntityId: TWIN, launchedAtMs: 1 };
      const rt = { task: "ATTACK", combat: { targetId: RAT } };
      sidecar.step(rt, { twin, host: { itemID: 1 }, record, scene, nowMs: 5000 });
      assert.deepStrictEqual(journal.list().map((e) => [e.droneId, e.systemId, e.launchedAtMs]),
        [[8001, SYSTEM, 5000], [8002, SYSTEM, 5000]]);
      assert.strictEqual(fs.existsSync(file), false, "no write per change");
      sidecar.beforeEnd(rt, "RECALL_DONE", { record, scene });
      sidecar.dispose(rt, "RESTART");
      assert.deepStrictEqual(recalls, [[8001]], "one drone out: no second try of a batch of one");
      assert.deepStrictEqual(sidecar.flush(), { ok: true, written: true });
      assert.deepStrictEqual(sidecar.flush(), { ok: true, written: false });
      assert.strictEqual(sidecar.stats().counters["drone.stranded"], 2);
      const v = fakeVendor();
      v.inSpace(8001);
      v.items.set(8002, { itemID: 8002, ownerID: OWNER, locationID: SHIP, flagID: DRONE_BAY });
      const reread = createDroneJournal({ filePath: file });
      assert.strictEqual(reread.load().count, 2);
      const boot = createDroneSidecar({ access: createDroneAccess({ deps: v.deps, config: {} }), scene: ts,
        journal: reread, config: {} });
      assert.deepStrictEqual(boot.reclaimBoot({ enabled: true }), { entries: 2, reclaimed: 1, skipped: 1,
        flushed: true });
      assert.deepStrictEqual([v.items.get(8001).locationID, v.items.get(8001).flagID], [SHIP, DRONE_BAY]);
      assert.strictEqual(boot.stats().counters["drone.reclaim.skipped.NOT_IN_SPACE"], 1);
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, "utf8")), { schemaVersion: 1, drones: [] });
    } finally {
      cleanup(dir);
    }
  });

  test("DJ4: the boot reclaim skips a ship with a LOST/SETTLED record (the drone stays in space "
    + "skipped.lost, the entry leaves; a throwing predicate = a loss); dispose(LOST) drops every entry of the ship "
    + "(also an earlier twin's) and writes at once; a drone that does not fit the drone bay (bay + the reserve of "
    + "the ship's other drones in space) -> BAY_FULL, no move", () => {
    const { dir, file } = tempJournal();
    try {
      const v = fakeVendor();
      v.items.set(OTHER_SHIP, { itemID: OTHER_SHIP, ownerID: OWNER, locationID: 60003760, flagID: 4 });
      v.inSpace(8001);
      v.inSpace(8002, { launcherID: OTHER_SHIP });
      const journal = createDroneJournal({ filePath: file });
      journal.add(entry(8001));
      journal.add(entry(8002, { shipItemId: OTHER_SHIP }));
      const ts = { simNow: () => 0, entity: () => null, surfaceDistance: () => 0 };
      const boot = createDroneSidecar({ access: createDroneAccess({ deps: v.deps, config: {} }), scene: ts, journal,
        config: {} });
      const out = boot.reclaimBoot({ enabled: true, hasLoss: (ship) => ship === SHIP });
      assert.deepStrictEqual(out, { entries: 2, reclaimed: 1, skipped: 1, flushed: true });
      assert.deepStrictEqual([v.items.get(8001).locationID, v.items.get(8001).flagID], [SYSTEM, 0], "stays in space");
      assert.deepStrictEqual([v.items.get(8002).locationID, v.items.get(8002).flagID], [OTHER_SHIP, DRONE_BAY]);
      assert.strictEqual(boot.stats().counters["drone.reclaim.skipped.lost"], 1);
      assert.deepStrictEqual(journal.list(), []);
      journal.add(entry(8001));
      v.calls.length = 0;
      boot.reclaimBoot({ enabled: true, hasLoss: () => { throw new Error("core down"); } });
      assert.deepStrictEqual(v.calls, [], "a throwing predicate moves nothing");
      journal.add(entry(8001));
      journal.add(entry(8003));
      journal.add(entry(8004, { shipItemId: OTHER_SHIP }));
      boot.dispose({ drones: null }, "LOST", { shipItemId: SHIP });
      assert.deepStrictEqual(journal.list().map((e) => e.droneId), [8004]);
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, "utf8")).drones.map((e) => e.droneId), [8004],
        "written at once");
      assert.strictEqual(boot.stats().counters["drone.reclaim.skipped.lost"], 4);
      const access = createDroneAccess({ deps: v.deps, config: {} });
      v.items.set(9001, { itemID: 9001, ownerID: OWNER, locationID: SHIP, flagID: DRONE_BAY, volume: 5, quantity: 2 });
      v.inSpace(9002, { volume: 6, singleton: 1 });
      v.inSpace(9003, { volume: 10, singleton: 1 });
      v.deps.isDroneItemRecord = () => true;
      v.deps.getShipFittingSnapshot = () => ({ resourceState: { droneCapacity: 25 }, shipAttributes: {} });
      v.deps.itemStore.listContainerItems = (owner, loc, flag) => [...v.items.values()]
        .filter((i) => i.ownerID === owner && i.locationID === loc && i.flagID === flag);
      v.calls.length = 0;
      assert.deepStrictEqual(access.reclaim(entry(9003)), { ok: false, reason: "BAY_FULL" });
      assert.deepStrictEqual([v.items.get(9003).locationID, v.calls], [SYSTEM, []]);
      v.items.set(9002, { ...v.items.get(9002), volume: 5 });
      assert.deepStrictEqual(access.reclaim(entry(9003)), { ok: true, how: "custody" });
      assert.strictEqual(access.stats().counters["drone.reclaim.skipped.BAY_FULL"], 1);
    } finally {
      cleanup(dir);
    }
  });

  test("DJ3 a corrupt wingDrones.json is moved to .corrupt-<ms>, the journal starts empty and writes again", () => {
    const { dir, file } = tempJournal();
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "{ not json");
      const journal = createDroneJournal({ filePath: file, now: () => 777 });
      const loaded = journal.load();
      assert.deepStrictEqual([loaded.count, loaded.readOnly, loaded.recovered.reason, loaded.recovered.movedTo],
        [0, false, "bad_json", `${file}.corrupt-777`]);
      assert.strictEqual(fs.readFileSync(`${file}.corrupt-777`, "utf8"), "{ not json");
      assert.deepStrictEqual(journal.add(entry(8001)), { ok: true });
      assert.deepStrictEqual(journal.add(entry(0)), { ok: false, reason: "BAD_ENTRY" });
      assert.deepStrictEqual(journal.flush(), { ok: true, written: true });
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, "utf8")), { schemaVersion: 1, drones: [entry(8001)] });
      assert.strictEqual(journal.stats().counters["drone.journal.load.corrupt"], 1);
    } finally {
      cleanup(dir);
    }
  });
};
