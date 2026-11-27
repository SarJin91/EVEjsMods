"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const config = require("../../config");
const { createJournal } = require("../../lib/persistence/journal");
const { startScheduler } = require("../../lib/scheduler");
const { findServerSrcOnDisk } = require("../../lib/adapter/locator");
const seams = require("../../lib/adapter/sentrySeams");
const combat = require("../../lib/adapter/sentryCombat");
const { checkPlacement, checkLimits } = require("../../lib/sentries/policy");
const { startSentries } = require("../../lib/sentries");
const { createSentryStep } = require("../../lib/materialization/sentryStep");
const S = require("../../lib/sentries/schema");
const { harness: H } = require("../battle/settlement.test");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const DEFAULTS = config.resolveConfig({ modDir: MOD_DIR, env: {} }).config;
const FAKE_SRC = path.join(MOD_DIR, "test", "fixture", "fake-server-src");
const SYS = 30002000;
const OWNER = 98000001;
const CHAR = 90000001;
const GATE = 50000001;
const SENTRY_TYPE = 340501;
const VANILLA_TYPE = 16690;
const SESSION = Object.freeze({ characterID: CHAR, _space: Object.freeze({ systemID: SYS, shipID: 1 }) });

function item(itemID, typeID, over = {}) {
  return Object.freeze({ itemID, typeID, ownerID: OWNER, locationID: SYS, flagID: 0, categoryID: 23, groupID: 449,
    spaceState: Object.freeze({ systemID: SYS, position: Object.freeze({ x: 15000, y: 0, z: 0 }),
      anchorState: "anchored", onlineState: "online", online: 1, ...(over.spaceState || {}) }),
    ...over.top });
}

function cacheOf(modules) {
  const cache = {};
  for (const [rel, exports] of Object.entries(modules)) cache[path.join(FAKE_SRC, `${rel}.js`)] = { exports };
  return cache;
}

const optsOf = (cache, rel) => ({ cache, filename: path.join(FAKE_SRC, `${rel}.js`) });

module.exports = ({ test, skip }) => {
  test("SN1 sentry wraps: vanilla -> original (this, args, result), sentry -> expected table, frozen exports -> "
    + "SEAM_NOT_WRITABLE without a throw, defineProperty path, second install alreadyInstalled", () => {
    seams.resetForTests();
    try {
      const items = new Map([[1, item(1, VANILLA_TYPE)], [2, item(2, SENTRY_TYPE)],
        [3, item(3, SENTRY_TYPE, { spaceState: { onlineState: "offline", online: 0 } })]]);
      const ship = Object.freeze({ itemID: 1, position: { x: 0, y: 0, z: 0 }, radius: 50 });
      const cache = cacheOf({
        "services/inventory/itemStore": { findItemById: (id) => items.get(Number(id)) || null },
        "services/corporation/corporationState": { isNpcCorporationID: (id) => id < 2000000 },
        "services/starbase/starbaseAnchoringPolicy": { validateCorporationAuthority: () => ({ success: true }) },
        "space/runtime": { getSceneForSession: () => ({ getEntitySurfaceDistance: (s, m) => (m.itemID === 3 ? 100
          : 1000) }),
          getEntity: (s, id) => (id === 1 ? ship : { itemID: id }) },
      });
      const calls = [];
      const orig = (name) => function original(...args) {
        calls.push([name, this, args]);
        return { success: true, vendor: name };
      };
      const moduleRuntime = { startAnchorTransition: orig("anchor"), reconcileStarbaseModule: orig("reconcile"),
        setOnlineState: orig("online"), getState: () => null };
      const defense = { validateBatteryOperation: orig("battery"), hasUnavailableHealth: () => false,
        getBatteryProfile: () => ({ effectName: "targetAttack", passive: false }) };
      const inventory = {};
      Object.defineProperty(inventory, "validateBatteryAmmoInventoryAccess", { value: orig("ammo"), writable: false,
        enumerable: true, configurable: true });
      const frozen = Object.freeze({ startAnchorTransition: orig("x"), reconcileStarbaseModule: orig("x"),
        setOnlineState: orig("x") });
      const refused = seams.installModuleRuntime(frozen, optsOf(cache, "services/starbase/starbaseModuleRuntime"));
      assert.deepStrictEqual([refused.ok, refused.reason, frozen.startAnchorTransition.name],
        [false, "SEAM_NOT_WRITABLE", "original"]);
      assert.strictEqual(seams.checkWraps().ok, false);
      const r1 = seams.installModuleRuntime(moduleRuntime, optsOf(cache, "services/starbase/starbaseModuleRuntime"));
      const r2 = seams.installDefenseRuntime(defense, optsOf(cache, "services/starbase/starbaseDefenseRuntime"));
      const r3 = seams.installInventoryRuntime(inventory, optsOf(cache, "services/starbase/starbaseInventoryRuntime"));
      assert.deepStrictEqual([r1.ok, r2.ok, r3.ok, Object.getOwnPropertyDescriptor(inventory,
        "validateBatteryAmmoInventoryAccess").value.name], [true, true, true,
        "livingNewEden_sentry_validateBatteryAmmoInventoryAccess"]);
      assert.deepStrictEqual(seams.installModuleRuntime(moduleRuntime,
        optsOf(cache, "services/starbase/starbaseModuleRuntime")).alreadyInstalled, true);
      assert.strictEqual(seams.checkWraps().ok, true);

      const self = { tag: "caller" };
      const vanilla = [moduleRuntime.startAnchorTransition.call(self, SESSION, 1, "anchorDrop", { x: 1 }),
        moduleRuntime.reconcileStarbaseModule.call(self, 1, { schedule: false }),
        moduleRuntime.setOnlineState.call(self, SESSION, 1, true),
        defense.validateBatteryOperation.call(self, 1),
        inventory.validateBatteryAmmoInventoryAccess.call(self, SESSION, 1, "viewput")];
      assert.deepStrictEqual(vanilla.map((v) => v.vendor), ["anchor", "reconcile", "online", "battery", "ammo"]);
      assert.ok(calls.every(([, t]) => t === self));
      assert.deepStrictEqual(calls.map(([n, , a]) => [n, a.length]), [["anchor", 4], ["reconcile", 2],
        ["online", 3], ["battery", 1], ["ammo", 3]]);

      calls.length = 0;
      const noPolicy = [moduleRuntime.startAnchorTransition(SESSION, 2, "anchorDrop").errorMsg,
        moduleRuntime.setOnlineState(SESSION, 3, true).errorMsg, defense.validateBatteryOperation(2).errorMsg,
        moduleRuntime.reconcileStarbaseModule(2).completed, inventory.validateBatteryAmmoInventoryAccess(SESSION, 2,
          "viewput").success];
      assert.deepStrictEqual(noPolicy, ["STARBASE_ANCHORING_RESTRICTED_IN_SYSTEM", "CONTROL_TOWER_NOT_ONLINE",
        "MODULE_NOT_ONLINE", false, true]);
      moduleRuntime.startAnchorTransition(SESSION, 2, "anchorLiftForStructures");
      moduleRuntime.setOnlineState(SESSION, 2, false);
      moduleRuntime.reconcileStarbaseModule(3);
      assert.deepStrictEqual(calls.map(([n]) => n), ["anchor", "online", "reconcile"]);

      const armedIds = new Set([2]);
      const asked = [];
      assert.ok(seams.bindPolicy({ anchor: (req) => { asked.push(["anchor", req.itemId]); return { ok: false,
        reason: "SENTRY_TOO_CLOSE" }; }, online: (req) => { asked.push(["online", req.itemId]); return { ok: true }; },
      isArmed: (id) => armedIds.has(id) }, { accessRangeM: 500, messages: { SENTRY_TOO_CLOSE: "too close" } }).ok);
      const DogmaService = class {};
      DogmaService.prototype._formatStarbaseModuleUserError = function format(code) {
        return `vendor:${code}`;
      };
      assert.ok(seams.installDogmaErrors(DogmaService, optsOf(cache, "services/dogma/dogmaService")).ok);
      const withPolicy = [moduleRuntime.startAnchorTransition(SESSION, 2, "anchorDrop").errorMsg,
        moduleRuntime.startAnchorTransition(SESSION, 3, "anchorDrop").errorMsg,
        moduleRuntime.setOnlineState(SESSION, 3, true).success, defense.validateBatteryOperation(2).data.tower,
        defense.validateBatteryOperation({ itemID: 3, typeID: SENTRY_TYPE }).errorMsg,
        inventory.validateBatteryAmmoInventoryAccess(SESSION, 2, "viewput").errorMsg,
        new DogmaService()._formatStarbaseModuleUserError("SENTRY_TOO_CLOSE"),
        new DogmaService()._formatStarbaseModuleUserError("MODULE_NOT_ONLINE")];
      assert.deepStrictEqual(withPolicy, ["STARBASE_STRUCTURE_TOO_FAR", "SENTRY_TOO_CLOSE", true, null, "MODULE_NOT_ONLINE",
        "STARBASE_STRUCTURE_TOO_FAR", "too close", "vendor:MODULE_NOT_ONLINE"]);
      armedIds.clear();
      assert.strictEqual(defense.validateBatteryOperation(2).errorMsg, "SENTRY_NOT_ARMED");
      assert.deepStrictEqual(asked, [["anchor", 3], ["online", 3]]);

      cache[path.join(FAKE_SRC, "common/machoErrors.js")] = { exports: { throwWrappedUserError: (msg, values) => {
        throw Object.assign(new Error("mod"), { msg, values });
      } } };
      class PosMgr {
        Handle_AnchorStructure(args) {
          if (args === "boom") throw new Error("boom");
          const r = moduleRuntime.startAnchorTransition(SESSION, args, "anchorDropForStructures", {});
          if (!r.success) throw Object.assign(new Error("vendor"), { values: { notify: "generic" } });
          return "bound";
        }
      }
      assert.ok(seams.installPosMgrErrors(PosMgr, optsOf(cache, "services/planet/posMgrService")).ok);
      const pm = new PosMgr();
      const notifyOf = (arg) => {
        try {
          return pm.Handle_AnchorStructure(arg);
        } catch (err) {
          return err.values ? err.values.notify : err.message;
        }
      };
      assert.deepStrictEqual([notifyOf(3), notifyOf(2), notifyOf("boom"), notifyOf(1),
        moduleRuntime.startAnchorTransition(SESSION, 3, "anchorDrop").errorMsg],
      ["too close", "generic", "boom", "bound", "SENTRY_TOO_CLOSE"]);
    } finally {
      seams.resetForTests();
    }
  });

  test("SN2 sentry policy: closest anchor in the band, too close, a foreign structure is no player anchor, LIMIT "
    + "anchor first", () => {
    const anchors = [
      { kind: "gate", id: 2, position: { x: 0, y: 0, z: 0 }, radius: 5000, ownerCorpId: null },
      { kind: "station", id: 1, position: { x: 40000, y: 0, z: 0 }, radius: 10000, ownerCorpId: 1000125 },
      { kind: "structure", id: 3, position: { x: 15000, y: 9000, z: 0 }, radius: 1000, ownerCorpId: 98000999 },
    ];
    const base = { position: { x: 15000, y: 0, z: 0 }, anchors, others: [], ownerCorpId: OWNER, ownerKind: "player",
      minM: 5000, maxM: 30000, spacingM: 2000 };
    const got = [
      checkPlacement(base),
      checkPlacement({ ...base, others: [{ itemId: 9, position: { x: 16000, y: 0, z: 0 } }] }).reason,
      checkPlacement({ ...base, anchors: [anchors[2]] }).reason,
      checkPlacement({ ...base, anchors: [{ ...anchors[2], ownerCorpId: OWNER }] }).anchor.kind,
      checkLimits({ perAnchor: 6, perSystemOwner: 6, perOwner: 30, total: 500 }, { maxPerAnchor: 6,
        maxPerSystemPerOwner: 6, maxPerOwner: 30, maxTotal: 500 }),
      checkLimits({ perAnchor: 0, perSystemOwner: 0, perOwner: 0, total: 0 }, { maxPerAnchor: 6,
        maxPerSystemPerOwner: 6, maxPerOwner: 30, maxTotal: 500 }),
    ];
    assert.deepStrictEqual(got, [{ ok: true, anchor: { kind: "gate", id: 2, surfaceM: 10000 } }, "SENTRY_TOO_CLOSE",
      "SENTRY_NO_ANCHOR", "structure", { ok: false, reason: "SENTRY_LIMIT", detail: "anchor" }, { ok: true }]);
  });

  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  function rig(reopen, over = {}) {
    const opened = reopen();
    const shared = H.sharedOf();
    const clock = shared.clock;
    const cfg = { ...H.CONFIG, modules: { ...H.CONFIG.modules, strategy: { enabled: true } },
      sentries: { ...DEFAULTS.sentries, enabled: true, ...over } };
    const journal = createJournal({ clock, maxPayloadBytes: 16384, maxRows: 500 });
    const sr = startScheduler({ config: cfg, persistence: { ok: true, store: opened.store }, clock, ids: shared.ids,
      nowMs: () => 0 });
    assert.ok(sr.ok, JSON.stringify(sr));
    const tx = (fn) => {
      const r = opened.store.transaction("test", fn);
      assert.ok(r.ok, JSON.stringify(r));
      return r.value;
    };
    const rowOf = (itemId) => tx((db) => db.prepare("SELECT sentry_id, state, end_reason FROM world_sentries "
      + "WHERE item_id = ?").get(itemId)) || null;
    const items = new Map();
    const vendor = { refuse: null, partial: null, sceneLoaded: true, forced: [] };
    const put = (id, x, over = {}) => items.set(id, item(id, SENTRY_TYPE, { spaceState: { position: { x, y: 0, z: 0 },
      anchorState: "unanchored", onlineState: "offline", online: 0, ...over } }));
    const modules = {
      "services/inventory/itemStore": { findItemById: (id) => items.get(id) || null,
        listStarbaseItems: (q) => [...items.values()].filter((i) => (q.systemID ? i.spaceState.systemID === q.systemID
          : i.typeID === q.typeID)) },
      "space/worldData": { getStargatesForSystem: () => [{ itemID: GATE, position: { x: 0, y: 0, z: 0 },
        radius: 5000 }], getStationsForSystem: () => [] },
      "services/structure/structureState": { peekStructures: () => [] },
      "services/starbase/posGmState": { forcePosOnlineState: (id) => {
        vendor.forced.push([id, rowOf(id) && rowOf(id).state]);
        if (vendor.refuse) return { success: false, errorMsg: vendor.refuse };
        const cur = items.get(id);
        items.set(id, item(id, cur.typeID, { spaceState: { ...cur.spaceState, anchorState: "anchored",
          onlineState: "online", online: 1 } }));
        return vendor.partial ? { success: false, errorMsg: vendor.partial } : { success: true };
      } },
      "space/runtime": { isSolarSystemSceneLoaded() { return vendor.sceneLoaded; } },
      "services/starbase/starbaseDefenseRuntime": { hasUnavailableHealth: () => false },
      "services/starbase/starbaseAnchoringPolicy": { validateCorporationAuthority: () => ({ success: true }) },
      "services/corporation/corporationState": { isNpcCorporationID: (id) => id < 2000000 },
    };
    const seam = seams.createSentrySeam({ requireGame: (rel) => ({ ok: true, exports: modules[rel] }) });
    let policy = null;
    const adapter = { sentrySeams: () => ({ ok: true, seam, optional: {} }),
      bindSentryPolicy: (p) => {
        policy = p;
        return { ok: true };
      } };
    const started = startSentries({ config: cfg, persistence: { ok: true, store: opened.store, journal }, clock,
      scheduler: sr.scheduler, adapter,
      graph: { getGraph: () => ({ ok: true, graph: { getSystem: (id) => ({ systemId: id, secClass: "lowsec" }) } }) } });
    assert.ok(started.ok, JSON.stringify(started));
    return { clock, items, put, vendor, rowOf, tx, policy: () => policy, sentries: started.sentries,
      service: started.service, scheduler: sr.scheduler };
  }

  needsDriver("SN3 sentry anchor: row ACTIVE before forceOnline, vendor refusal -> RETIRED VENDOR_REFUSED, again -> "
    + "REANCHORED, a second anchor -> duplicate", () => H.withStore(driver, async (reopen) => {
    const env = rig(reopen);
    env.put(7001, 15000);
    env.vendor.refuse = "UNSUPPORTED_POS_RUNTIME";
    const refused = env.policy().anchor({ session: SESSION, itemId: 7001 });
    assert.deepStrictEqual([refused, env.rowOf(7001)], [{ ok: false, reason: "UNSUPPORTED_POS_RUNTIME" },
      { sentry_id: "sp-7001", state: "RETIRED", end_reason: "VENDOR_REFUSED" }]);
    env.vendor.refuse = null;
    const ok = env.policy().anchor({ session: SESSION, itemId: 7001 });
    const dup = env.policy().anchor({ session: SESSION, itemId: 7001 });
    assert.deepStrictEqual([ok, dup, env.rowOf(7001).state], [{ ok: true, sentryId: "sp-7001", duplicate: false },
      { ok: true, sentryId: "sp-7001", duplicate: true }, "ACTIVE"]);
    assert.deepStrictEqual(env.vendor.forced, [[7001, "ACTIVE"], [7001, "ACTIVE"]]);
    env.put(7002, 18000);
    env.vendor.partial = "POS_RUNTIME_SYNC_FAILED";
    assert.deepStrictEqual([env.policy().anchor({ session: SESSION, itemId: 7002 }), env.rowOf(7002).state,
      env.service.getStatus().counters.vendorPartial], [{ ok: true, sentryId: "sp-7002", duplicate: false }, "ACTIVE", 1]);
    env.vendor.partial = null;
    assert.strictEqual(env.policy().isArmed(7001), false, "armDelayMs");
    env.clock.set(env.clock.now() + DEFAULTS.sentries.armDelayMs);
    assert.strictEqual(env.policy().isArmed(7001), true);
    env.sentries.stop("test");
    assert.strictEqual(env.policy(), null, "stop unbinds the policy");
  }));

  needsDriver("SN4 sentry reconcile: no item -> DESTROYED, unanchored -> RETIRED, orphan -> adopted, offline -> healed",
    () => H.withStore(driver, async (reopen) => {
      const env = rig(reopen);
      for (const [id, x] of [[7101, 15000], [7102, 18000], [7103, 21000]]) {
        env.put(id, x);
        assert.ok(env.policy().anchor({ session: SESSION, itemId: id }).ok, String(id));
      }
      env.items.delete(7101);
      env.put(7102, 18000, { anchorState: "unanchored" });
      const shutdown = (atMs) => ({ anchorState: "anchored", onlineState: "offline",
        starbaseDisabledReason: "CONTROL_TOWER_NOT_FOUND", starbaseDisabledAtMs: atMs });
      env.put(7103, 21000, shutdown(1000));
      env.put(7104, 24000, { anchorState: "anchored", onlineState: "online", online: 1 });
      env.vendor.forced.length = 0;
      const r = env.sentries.reconcile(env.clock.now());
      assert.deepStrictEqual([r.ok, r.destroyed, r.retired, r.adopted, r.healed],
        [true, 1, 1, 1, 1], JSON.stringify(r));
      assert.deepStrictEqual([7101, 7102, 7103, 7104].map((id) => env.rowOf(id)), [
        { sentry_id: "sp-7101", state: "DESTROYED", end_reason: "VANISHED" },
        { sentry_id: "sp-7102", state: "RETIRED", end_reason: "UNANCHORED" },
        { sentry_id: "sp-7103", state: "ACTIVE", end_reason: null },
        { sentry_id: "sa-7104", state: "ACTIVE", end_reason: null }]);
      assert.deepStrictEqual(env.vendor.forced, [[7103, "ACTIVE"]]);
      const again = env.sentries.reconcile(env.clock.now());
      assert.deepStrictEqual([again.destroyed, again.retired, again.adopted, again.healed], [0, 0, 0, 0]);
      env.put(7103, 21000, shutdown(1000));
      env.put(7104, 24000, { anchorState: "anchored", onlineState: "offline" });
      env.vendor.forced.length = 0;
      const manual = env.sentries.reconcile(env.clock.now());
      assert.deepStrictEqual([manual.healed, manual.deferred, env.vendor.forced], [0, 0, []]);
      env.put(7103, 21000, shutdown(2000));
      env.vendor.forced.length = 0;
      env.vendor.sceneLoaded = false;
      const cold = env.sentries.reconcile(env.clock.now());
      assert.deepStrictEqual([cold.healed, cold.deferred, env.vendor.forced.length, env.rowOf(7103).state],
        [0, 1, 0, "ACTIVE"]);
      env.vendor.sceneLoaded = true;
      const warm = env.sentries.reconcile(env.clock.now());
      assert.deepStrictEqual([warm.healed, warm.deferred, env.vendor.forced], [1, 0, [[7103, "ACTIVE"]]]);
      env.sentries.stop("test");
    }));

  needsDriver("SN4r restart after downtime: a live SENTRY_RECONCILE row (cursor in the payload) + bootstrap -> "
    + "no second head, the catch-up pass reschedules with the cursor, 0 conflicts, 0 quarantines, one QUEUED row",
  () => H.withStore(driver, async (reopen) => {
    const env = rig(reopen, { reconcileMaxRows: 1 });
    const I = DEFAULTS.sentries.reconcileIntervalMs;
    for (const [id, x] of [[7401, 15000], [7402, 18000], [7403, 21000]]) {
      env.put(id, x);
      assert.ok(env.policy().anchor({ session: SESSION, itemId: id }).ok, String(id));
    }
    const rows = () => env.tx((db) => db.prepare("SELECT state, payload FROM "
      + "world_scheduled_events WHERE event_type = 'SENTRY_RECONCILE' ORDER BY due_at").all())
      .map((r) => [r.state, JSON.parse(r.payload)]);
    const b0 = Math.floor(env.clock.now() / I);
    env.clock.set((b0 + 1) * I);
    await env.scheduler.runPass();
    assert.deepStrictEqual(rows(), [["DONE", { bucket: b0 + 1, afterSentryId: "" }],
      ["QUEUED", { bucket: b0 + 2, afterSentryId: "sp-7401" }]]);
    env.clock.set((b0 + 12) * I + 1);
    const boot = env.service.bootstrap();
    assert.deepStrictEqual([boot.ok, boot.joined, env.service.getStatus().counters.reconcileChainJoined],
      [true, true, 1], JSON.stringify(boot));
    await env.scheduler.runPass();
    const B = Math.floor(env.clock.now() / I) + 1;
    const live = rows().filter(([s]) => s !== "DONE");
    assert.deepStrictEqual(live, [["QUEUED", { bucket: B, afterSentryId: "sp-7402" }]], JSON.stringify(rows()));
    assert.strictEqual(rows().filter(([s]) => s === "QUARANTINED" || s === "RETRY").length, 0);
    env.tx((db) => db.prepare("UPDATE world_scheduled_events SET state = 'QUARANTINED', last_error = 'x', "
      + "finished_at = 1 WHERE event_type = 'SENTRY_RECONCILE' AND state = 'QUEUED'").run());
    env.clock.set(B * I + 1);
    const fresh = env.service.bootstrap();
    assert.deepStrictEqual([fresh.ok, fresh.joined, fresh.duplicate, fresh.bucket], [true, undefined, false, B + 1]);
    env.sentries.stop("test");
  }));

  needsDriver("SN6 sentry LIVE step: the item gone -> one markEnded LIVE_KILL, a second pass and a second markEnded "
    + "write no journal", () => H.withStore(driver, async (reopen) => {
    const env = rig(reopen);
    env.put(7201, 15000);
    assert.ok(env.policy().anchor({ session: SESSION, itemId: 7201 }).ok);
    assert.deepStrictEqual(env.sentries.listLiveInSystem(SYS).map((r) => [r.sentryId, r.itemId, r.characterId]),
      [["sp-7201", 7201, CHAR]]);
    let reads = 0;
    const seam = Object.freeze({ readSentryScene: (systemId, ids) => {
      reads += 1;
      return { ok: true, loaded: true, sentries: ids.map((itemId) => ({ itemId, gone: true, alive: false })),
        players: [], positions: new Map() };
    } });
    const step = createSentryStep({ getSentries: () => env.sentries, getSeam: () => seam, relationGroups: () => [],
      settings: DEFAULTS.sentries.live, pumpMs: 2000 });
    const presence = Object.freeze({ observedSystems: () => [SYS] });
    const journalOf = () => env.tx((db) => db.prepare("SELECT count(*) AS n FROM world_event_journal "
      + "WHERE aggregate_id = 'sp-7201' AND event_type = 'SENTRY_STATE'").get().n);
    const out = {};
    step.step(env.clock.now(), presence, out);
    const first = journalOf();
    step.step(env.clock.now() + 2000, presence, {});
    const second = env.sentries.markEnded("sp-7201", "LIVE_KILL");
    assert.deepStrictEqual([out.sentries.kills, step.stats().counters.liveKills, env.rowOf(7201), first, reads,
      second, journalOf(), env.sentries.listLiveInSystem(SYS)], [1, 1,
      { sentry_id: "sp-7201", state: "DESTROYED", end_reason: "LIVE_KILL" }, 1, 1, { ok: false, reason: "STALE" }, 1,
      []]);
    env.sentries.stop("test");
  }));

  test("SN5 sentry vendor facts: symbols, call forms through the module object, no frozen exports, DogmaService "
    + "prototype writable/configurable, internal calls pinned", () => {
    const found = findServerSrcOnDisk(MOD_DIR, 5, fs.existsSync);
    assert.ok(found.ok, "EveJS server/src not found above the mod");
    const src = found.srcDir;
    const read = (rel) => fs.readFileSync(path.join(src, `${rel}.js`), "utf8").replace(/\r\n/g, "\n");
    const count = (text, re) => (text.match(re) || []).length;
    const problems = [];
    const starbase = ["starbaseModuleRuntime", "starbaseDefenseRuntime", "starbaseInventoryRuntime"]
      .map((n) => [n, read(`services/starbase/${n}`)]);
    for (const [name, text] of starbase) {
      if (/Object\.freeze\(\s*module\.exports/.test(text) || /module\.exports\s*=\s*Object\.freeze\(/.test(text)) {
        problems.push(`${name}: frozen exports`);
      }
    }
    const [mr, def, inv] = starbase.map(([, t]) => t);
    const pins = [[mr, /\breconcileStarbaseModule\s*\(/g, 3], [mr, /\bstartAnchorTransition\s*\(/g, 1],
      [mr, /\bsetOnlineState\s*\(/g, 1], [def, /\bvalidateBatteryOperation\s*\(/g, 2],
      [inv, /\bvalidateBatteryAmmoInventoryAccess\s*\(/g, 1]];
    for (const [text, re, n] of pins) if (count(text, re) !== n) problems.push(`${re} x${count(text, re)} != ${n}`);
    if (!mr.includes("const result = reconcileStarbaseModule(itemID, { nowMs: Date.now(), schedule: true });")) {
      problems.push("timer reconcile :266");
    }
    if (!def.includes("function prepareBatteryActor(scene, batteryID) {\n  const validation = "
      + "validateBatteryOperation(batteryID);")) problems.push("prepareBatteryActor :135");
    const consumers = [
      ["space/runtime/scene/modules", "starbaseDefenseRuntime.validateBatteryOperation(entity.itemID)"],
      ["space/runtime/scene/tick", "starbaseDefenseRuntime.validateBatteryOperation(entity.itemID)"],
      ["space/runtime/inventorySpaceEntity", "moduleRuntime.reconcileStarbaseModule(item.itemID, {"],
      ["services/inventory/invBrokerService", "starbaseInventoryRuntime.validateBatteryAmmoInventoryAccess(session, "],
      ["services/dogma/dogmaService/moduleOperation", ")).startAnchorTransition(session, requestedItemID, effectName)"],
      ["services/dogma/dogmaService/moduleOperation", ")).setOnlineState(session, requestedItemID, true)"],
      ["services/dogma/dogmaService/moduleOperation", "this._formatStarbaseModuleUserError(result.errorMsg"],
      ["services/starbase/posChatCommands", "runtime.setOnlineState(session, item.itemID"],
      ["services/planet/posMgrService", ".startAnchorTransition(session, itemID, effectName, options);"],
      ["services/planet/posMgrService", "notify: formatStarbaseAnchorError(result.errorMsg),"],
      ["services/planet/posMgrService", "const {\n  throwWrappedUserError,\n} = require(path.join(__dirname, "
        + "\"../../common/machoErrors\"));"],
      ["services/planet/posMgrService", "  Handle_AnchorStructure(args, session) {"],
      ["services/planet/posMgrService", "module.exports = PosMgrService;"],
    ];
    for (const [rel, needle] of consumers) if (!read(rel).includes(needle)) problems.push(`${rel}: ${needle}`);
    const dogma = read("services/dogma/dogmaService");
    if (!/Object\.defineProperty\(DogmaService\.prototype, name, \{\s*value: method,\s*writable: true,\s*configurable: true,/
      .test(dogma)) problems.push("attachDogmaServiceMethods writable/configurable");
    if (!/^module\.exports = DogmaService;$/m.test(dogma)) problems.push("module.exports = DogmaService");
    if (!/^ {2}_formatStarbaseModuleUserError\(errorMsg = "", data = null\) \{$/m
      .test(read("services/dogma/dogmaService/moduleOperation"))) problems.push("_formatStarbaseModuleUserError");
    if (!/^function forcePosOnlineState\(itemID, online, options = \{\}\) \{$/m
      .test(read("services/starbase/posGmState"))) problems.push("forcePosOnlineState");
    if (!/^function listStarbaseItems\(options = \{\}\) \{$/m.test(read("services/inventory/itemStore"))) {
      problems.push("listStarbaseItems");
    }
    assert.deepStrictEqual(problems, []);
    assert.deepStrictEqual([S.RECONCILE_EVENT_TYPE, seams.REQUIRED_WRAPS], ["SENTRY_RECONCILE",
      ["moduleRuntime", "defenseRuntime", "inventoryRuntime"]]);
  });

  test("FD-V1 sentry battle vendor facts: getBatteryProfile takes a type id and returns attributes: row.attributes "
    + "(numeric keys, attributes[76]); the pure DPS of the 340501 attributes ~ 67.7, the missile battery 15.6 without "
    + "designSig, readSentryCombat cached per type, NO_PROFILE", () => {
    const found = findServerSrcOnDisk(MOD_DIR, 5, fs.existsSync);
    assert.ok(found.ok, "EveJS server/src not found above the mod");
    const def = fs.readFileSync(path.join(found.srcDir, "services/starbase/starbaseDefenseRuntime.js"), "utf8")
      .replace(/\r\n/g, "\n");
    const facts = ["function getBatteryProfile(itemOrType) {\n  const typeID = number(itemOrType && itemOrType.typeID "
      + "|| itemOrType);", "    attributes: row.attributes || {},", "  entity.maxTargetRange = number(attributes[76]);"];
    assert.deepStrictEqual(facts.filter((f) => !def.includes(f)), []);
    const gun = combat.sentryCombatOf({ 64: 18, 51: 6380, 552: 6000, 620: 125 }, "hybrid", 24);
    const missile = combat.sentryCombatOf({ 212: 1, 506: 24000, 552: 12000 }, "missile", 375);
    assert.ok(Math.abs(gun.dps - 67.7) < 0.05, String(gun.dps));
    assert.deepStrictEqual([gun.signature, gun.designSig, missile, combat.sentryCombatOf({ 64: 18, 552: 6000 },
      "hybrid", 24)], [6000, 125, { dps: 15.625, signature: 12000, designSig: null }, null]);
    let reads = 0;
    const defense = { getBatteryProfile: (t) => {
      reads += 1;
      return t === 340501 ? { attributes: { 64: 18, 51: 6380, 552: 6000, 620: 125 } } : null;
    }, hasUnavailableHealth: () => false };
    const vendor = {
      itemStore: { findItemById: () => null, listStarbaseItems: () => [] },
      worldData: { getStargatesForSystem: () => [], getStationsForSystem: () => [] },
      structures: { peekStructures: () => [] }, gm: { forcePosOnlineState: () => ({ success: true }) }, defense,
      anchoring: { validateCorporationAuthority: () => ({ success: true }) }, corp: { isNpcCorporationID: () => false },
      runtime: { isSolarSystemSceneLoaded: () => false } };
    const keyOf = { "services/inventory/itemStore": "itemStore", "space/worldData": "worldData",
      "services/structure/structureState": "structures", "services/starbase/posGmState": "gm",
      "services/starbase/starbaseDefenseRuntime": "defense", "services/starbase/starbaseAnchoringPolicy": "anchoring",
      "services/corporation/corporationState": "corp", "space/runtime": "runtime" };
    const seam = seams.createSentrySeam({ requireGame: (rel) => ({ ok: true, exports: vendor[keyOf[rel]] }) });
    const first = seam.readSentryCombat(340501);
    const again = seam.readSentryCombat(340501);
    assert.deepStrictEqual([first.ok, first.dps === gun.dps, again === first, seam.readSentryCombat(340503).reason,
      seam.readSentryCombat(16690).reason, reads], [true, true, true, "NO_PROFILE", "NO_PROFILE", 2]);
  });
};
