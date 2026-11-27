"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const config = require("../../config");
const { createJournal } = require("../../lib/persistence/journal");
const { startScheduler } = require("../../lib/scheduler");
const { findServerSrcOnDisk } = require("../../lib/adapter/locator");
const seams = require("../../lib/adapter/sentrySeams");
const { startSentries } = require("../../lib/sentries");
const { ringPosition } = require("../../lib/sentries/service");
const { planSentries } = require("../../lib/strategy/ai/sentries");
const { createTreasuryRepository } = require("../../lib/economy/treasury/treasuryRepository");
const { createTreasuryService } = require("../../lib/economy/treasury/treasuryService");
const S = require("../../lib/sentries/schema");
const { harness: H } = require("../battle/settlement.test");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const DEFAULTS = config.resolveConfig({ modDir: MOD_DIR, env: {} }).config;
const SYS = 30002000;
const NEXT_SYS = 30002001;
const FACTION = 500020;
const POOR = 500019;
const CORP = 1000125;
const GATE = 50000001;
const STRUCTURE = 1030000001;
const COST = 1000;

function fakeVendor() {
  const v = { items: new Map(), receipts: new Map(), nextId: 9000001, sceneLoaded: false, mismatch: false,
    grants: 0, spawned: [], updates: 0, posDamage: 0 };
  const put = (item) => v.items.set(item.itemID, Object.freeze(item));
  const grant = (owner, loc, flag, typeId, qty, opts) => {
    const key = opts.receiptKey;
    const prior = v.receipts.get(key);
    if (prior || v.mismatch) {
      if (v.mismatch || prior.typeId !== typeId || prior.qty !== qty || prior.loc !== loc) {
        return { success: false, ambiguous: true, errorMsg: "IDEMPOTENCY_RECEIPT_MISMATCH" };
      }
      return { success: true, duplicate: true, data: { itemIDs: [prior.itemId] } };
    }
    v.grants += 1;
    const itemID = v.nextId;
    v.nextId += 1;
    const sentry = flag === 0;
    put({ itemID, typeID: typeId, ownerID: owner, locationID: loc, flagID: flag, categoryID: sentry ? 23 : 8,
      groupID: sentry ? 449 : 85, singleton: sentry ? 1 : 0, quantity: qty, spaceState: null });
    v.receipts.set(key, Object.freeze({ itemId: itemID, typeId, qty, loc }));
    return { success: true, duplicate: false, data: { items: [{ itemID }] } };
  };
  const anchors = { gates: [{ itemID: GATE, position: { x: 0, y: 0, z: 0 }, radius: 5000,
    destinationSolarSystemID: NEXT_SYS }],
  structures: [{ structureID: STRUCTURE, solarSystemID: SYS, position: { x: 1e6, y: 0, z: 0 }, radius: 8000,
    devFlags: { lneStationId: "st-x" } }] };
  v.anchors = anchors;
  v.modules = {
    "services/inventory/itemStore": Object.freeze({
      findItemById: (id) => v.items.get(id) || null,
      listStarbaseItems: (q) => [...v.items.values()].filter((i) => i.categoryID === 23 && (q.systemID
        ? i.locationID === q.systemID : i.typeID === q.typeID)),
      grantItemToOwnerLocationIdempotent: grant,
      getIdempotentGrantReceipt: (key) => ({ success: true, found: v.receipts.has(key),
        data: v.receipts.get(key) || null }),
      updateInventoryItem: (id, fn) => {
        const cur = v.items.get(id);
        if (!cur) return { success: false, errorMsg: "ITEM_NOT_FOUND" };
        if (v.failUpdate) return { success: false, errorMsg: "ITEM_UPDATE_FAILED" };
        v.updates += 1;
        const next = fn(JSON.parse(JSON.stringify(cur)));
        put(next);
        return { success: true, data: next };
      },
      listContainerItems: (owner, loc, flag) => [...v.items.values()].filter((i) => i.locationID === loc
        && i.flagID === flag),
      pruneIdempotentGrantReceipts: (predicate) => {
        if (typeof predicate !== "function") {
          return { success: false, removed: 0, errorMsg: "INVALID_RECEIPT_PRUNE_PREDICATE" };
        }
        const removedReceiptKeys = [];
        for (const [receiptKey, r] of [...v.receipts]) {
          let dead = false;
          try {
            dead = predicate({ ...r, receiptKey }) === true;
          } catch (_err) {
            dead = false;
          }
          if (dead) {
            v.receipts.delete(receiptKey);
            removedReceiptKeys.push(receiptKey);
          }
        }
        return { success: true, removed: removedReceiptKeys.length, removedReceiptKeys };
      },
    }),
    "space/worldData": Object.freeze({ getStargatesForSystem: () => anchors.gates, getStationsForSystem: () => [] }),
    "services/structure/structureState": Object.freeze({ peekStructures: () => anchors.structures }),
    "services/starbase/posGmState": Object.freeze({ forcePosOnlineState: () => ({ success: true }),
      applyPosDamage: () => {
        v.posDamage += 1;
        return { success: true, data: { destroyed: false } };
      } }),
    "space/runtime": Object.freeze({ isSolarSystemSceneLoaded: () => v.sceneLoaded, scenes: new Map(),
      spawnDynamicInventoryEntity: (systemId, itemId) => {
        if (v.spawnFails) return { success: false, errorMsg: "SPAWN_FAILED" };
        v.spawned.push(itemId);
        return { success: true };
      } }),
    "services/starbase/starbaseDefenseRuntime": Object.freeze({ hasUnavailableHealth: () => false,
      getBatteryProfile: () => ({ attributes: { 263: 1000, 265: 1000, 9: 1000, 76: 50000 }, effectName: "x" }),
      hydrateBatteryActor() {}, getBatterySession() {}, getBatteryModuleView() {}, stopBattery() {},
      isBatteryManuallyControlled: () => false, validateBatteryOperation: () => ({ success: true }) }),
    "services/starbase/starbaseAnchoringPolicy": Object.freeze({ validateCorporationAuthority: () => ({ success: true }) }),
    "services/corporation/corporationState": Object.freeze({ isNpcCorporationID: (id) => id < 2000000 }),
    "services/starbase/starbaseInventoryRuntime": Object.freeze({ getBatteryAmmoCapacity: () => 100 }),
    "services/inventory/itemTypeRegistry": Object.freeze({ resolveItemByTypeID: () => ({ volume: 0.025 }) }),
    "services/fitting/liveFittingState": Object.freeze({ isChargeCompatibleWithModule: () => true }),
  };
  return v;
}

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  function rig(reopen, factionOver = {}, extra = {}) {
    const opened = reopen();
    const shared = H.sharedOf();
    const clock = shared.clock;
    const cfg = { ...H.CONFIG, modules: { ...H.CONFIG.modules, strategy: { enabled: true } },
      sentries: { ...DEFAULTS.sentries, enabled: true, faction: { ...DEFAULTS.sentries.faction, enabled: true,
        costIsk: COST, ...factionOver } },
      observer: { ...H.CONFIG.observer, sentriesMaxRows: extra.maxRows || 0 } };
    const journal = createJournal({ clock, maxPayloadBytes: 16384, maxRows: 500 });
    const sr = startScheduler({ config: cfg, persistence: { ok: true, store: opened.store }, clock, ids: shared.ids,
      nowMs: () => 0 });
    assert.ok(sr.ok, JSON.stringify(sr));
    const tx = (fn) => {
      const r = opened.store.transaction("test", fn);
      assert.ok(r.ok, JSON.stringify(r));
      return r.value;
    };
    const tRepo = createTreasuryRepository({ journal, clock });
    const treasury = createTreasuryService({ store: opened.store, repository: tRepo, clock, hullValues: { version: 1 },
      config: { treasury: { ...DEFAULTS.treasury, enabled: true }, strategy: {} } });
    for (const [f, isk] of [[FACTION, 5000], [POOR, 500]]) {
      tx((db) => assert.ok(tRepo.seedInTx(db, { factionId: f, kind: "empire", initialIsk: isk, at: clock.now() },
        `test:seed:${f}`).ok));
    }
    const v = fakeVendor();
    const seam = seams.createSentrySeam({ requireGame: (rel) => ({ ok: true, exports: v.modules[rel] }) });
    const adapter = { sentrySeams: () => ({ ok: true, seam, optional: {} }), bindSentryPolicy: () => ({ ok: true }) };
    const started = startSentries({ config: cfg, persistence: { ok: true, store: opened.store, journal }, clock,
      scheduler: sr.scheduler, adapter, getTreasury: () => treasury,
      graph: { getGraph: () => ({ ok: true, graph: { getSystem: (id) => ({ systemId: id, secClass: "nullsec" }) } }) },
      ...(extra.deps || {}) });
    assert.ok(started.ok, JSON.stringify(started));
    const row = (sentryId) => tx((db) => db.prepare("SELECT state, slot, item_id, end_reason, ammo_grants, cost_isk "
      + "FROM world_sentries WHERE sentry_id = ?").get(sentryId)) || null;
    const balance = (f) => tx((db) => tRepo.getInDb(db, f)).treasury.balanceIsk;
    const events = () => tx((db) => db.prepare("SELECT idempotency_key AS k FROM world_scheduled_events "
      + "WHERE event_type = ? ORDER BY idempotency_key").all(S.DEPLOY_EVENT_TYPE).map((r) => r.k));
    const build = (f, ik, anchorKind, anchorRef) => tx((db) => started.sentries.requestBuildInTx(db, {
      factionId: f, ownerCorpId: CORP, systemId: SYS, anchorKind, anchorRef, typeId: 340501, at: clock.now() }, ik));
    const deploy = (sentryId) => {
      const r = started.service.onDeploy({ payload: { sentryId } }, { now: clock.now() });
      if (typeof r.effect === "function") r.onCommitted(tx((db) => r.effect(db)));
      return r;
    };
    return { clock, tx, v, row, balance, events, build, deploy, service: started.service, sentries: started.sentries,
      journal, scheduler: sr.scheduler, seam };
  }

  needsDriver("SF2 faction sentry build: fee + PENDING row + deploy deadline together, smallest free slot, "
    + "TREASURY_INSUFFICIENT writes nothing, ANCHOR_UNKNOWN", () => H.withStore(driver, async (reopen) => {
    const env = rig(reopen);
    const a = env.build(FACTION, "strategy:review:500020:1:3:SENTRY_BUILD", "gate", { toSystemId: NEXT_SYS });
    const b = env.build(FACTION, "strategy:review:500020:2:3:SENTRY_BUILD", "gate", { toSystemId: NEXT_SYS });
    const again = env.build(FACTION, "strategy:review:500020:1:3:SENTRY_BUILD", "gate", { toSystemId: NEXT_SYS });
    assert.deepStrictEqual([a.ok, a.slot, b.slot, again.duplicate, again.sentryId === a.sentryId], [true, 0, 1, true,
      true], JSON.stringify([a, b, again]));
    assert.deepStrictEqual([env.row(a.sentryId), env.balance(FACTION), env.events()], [
      { state: "PENDING_DEPLOY", slot: 0, item_id: null, end_reason: null, ammo_grants: 0, cost_isk: COST },
      5000 - 2 * COST, [S.deployKey(a.sentryId), S.deployKey(b.sentryId)].sort()]);
    const poor = env.build(POOR, "strategy:review:500019:1:0:SENTRY_BUILD", "station", { stationId: "st-x" });
    const unknown = env.build(FACTION, "strategy:review:500020:3:0:SENTRY_BUILD", "station", { stationId: "st-zz" });
    const rows = env.tx((db) => db.prepare("SELECT count(*) AS n FROM world_sentries").get().n);
    assert.deepStrictEqual([poor.reason, unknown.reason, env.balance(POOR), rows, env.events().length],
      ["TREASURY_INSUFFICIENT", "ANCHOR_UNKNOWN", 500, 2, 2]);
    env.sentries.stop("test");
  }));

  needsDriver("SF3 SENTRY_DEPLOY: replay after a crash -> the same itemId and one ACTIVE transition, MISMATCH -> "
    + "CANCELLED without refund, ammo top-up in an unloaded scene, ringPosition", () => H.withStore(driver,
    async (reopen) => {
    const env = rig(reopen);
    const a = env.build(FACTION, "strategy:review:500020:1:0:SENTRY_BUILD", "station", { stationId: "st-x" });
    const ev = { payload: { sentryId: a.sentryId } };
    const now = env.clock.now();
    const crashed = env.service.onDeploy(ev, { now });
    const replay = env.service.onDeploy(ev, { now });
    const value = env.tx((db) => replay.effect(db));
    replay.onCommitted(value);
    const third = env.service.onDeploy(ev, { now });
    const itemId = env.row(a.sentryId).item_id;
    const item = env.v.items.get(itemId);
    assert.deepStrictEqual([crashed.outcome, replay.outcome, third.outcome, env.v.grants, env.row(a.sentryId).state,
      env.row(a.sentryId).ammo_grants, item.locationID, item.flagID, item.spaceState.anchorState,
      item.spaceState.onlineState, env.v.spawned.length], ["DEPLOYED", "DEPLOYED_REPLAY", "STALE", 2, "ACTIVE", 1, SYS,
      0, "anchored", "online", 0]);
    const ammo = [...env.v.items.values()].filter((i) => i.locationID === itemId && i.flagID === 27);
    assert.deepStrictEqual(ammo.map((i) => [i.typeID, i.quantity]), [[230, 2000]], "hybrid ammo, 2000 <= 4000");
    assert.deepStrictEqual(env.sentries.listLiveInSystem(SYS).map((r) => [r.sentryId, r.ownerKind, r.factionId]),
      [[a.sentryId, "faction", FACTION]]);

    for (const i of ammo) env.v.items.delete(i.itemID);
    env.v.sceneLoaded = true;
    const hot = env.sentries.reconcile(env.clock.now());
    env.v.sceneLoaded = false;
    const cold = env.sentries.reconcile(env.clock.now());
    const refill = [...env.v.items.values()].filter((i) => i.locationID === itemId && i.flagID === 27);
    assert.deepStrictEqual([hot.topUps, cold.topUps, env.row(a.sentryId).ammo_grants, refill.map((i) => i.quantity),
      env.v.receipts.has(`lne-sentry-ammo:${a.sentryId}:1`)], [0, 1, 2, [4000], true]);

    const b = env.build(FACTION, "strategy:review:500020:2:0:SENTRY_BUILD", "gate", { toSystemId: NEXT_SYS });
    const paid = env.balance(FACTION);
    env.v.mismatch = true;
    const failed = env.service.onDeploy({ payload: { sentryId: b.sentryId } }, { now });
    failed.onCommitted(env.tx((db) => failed.effect(db)));
    assert.deepStrictEqual([failed.outcome, env.row(b.sentryId).state, env.row(b.sentryId).end_reason,
      env.balance(FACTION) === paid, env.service.getStatus().counters.factionDeployFailed], ["DEPLOY_FAILED",
      "CANCELLED", "DEPLOY_FAILED", true, 1]);

    const C = { ...DEFAULTS.sentries, ...DEFAULTS.sentries.faction };
    const anchor = { position: { x: 100, y: 50, z: -100 }, radius: 5000 };
    const ring = Array.from({ length: C.maxPerAnchor }, (_, slot) => ringPosition(anchor, slot, C));
    const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
    const surface = ring.map((p) => dist(p, anchor.position) - anchor.radius);
    let spacing = Infinity;
    for (let i = 0; i < ring.length; i += 1) for (let j = i + 1; j < ring.length; j += 1) {
      spacing = Math.min(spacing, dist(ring[i], ring[j]));
    }
    assert.ok(surface.every((s) => s >= C.anchorMinDistanceM - 1e-6 && s <= C.anchorMaxDistanceM + 1e-6),
      JSON.stringify(surface));
    assert.ok(spacing >= C.minSpacingM, String(spacing));
    assert.ok(ring.every((p) => p.y === anchor.position.y));
    env.sentries.stop("test");
  }));

  needsDriver("SF3b SENTRY_DEPLOY slower than sentries.slowDeployLogMs logs its phase timings, a fast one logs "
    + "nothing", () => H.withStore(driver, async (reopen) => {
    let t = 0;
    let step = 40;
    const lines = [];
    const env = rig(reopen, {}, { deps: { nowMs: () => { t += step; return t; },
      logger: { log: (line) => lines.push(line) } } });
    const a = env.build(FACTION, "strategy:review:500020:1:0:SENTRY_BUILD", "station", { stationId: "st-x" });
    assert.strictEqual(env.deploy(a.sentryId).outcome, "DEPLOYED");
    const slow = lines.filter((l) => l.includes("slow SENTRY_DEPLOY"));
    assert.strictEqual(slow.length, 1, JSON.stringify(lines));
    assert.match(slow[0], new RegExp(`sentry=${a.sentryId} system=${SYS} outcome=OK totalMs=\\d+\\.\\d phaseMs `
      + "readAnchors=40\\.0 grantItem=40\\.0 updateItem=40\\.0 ammoCapacity=40\\.0 grantAmmo=40\\.0$"));
    step = 0;
    const b = env.build(FACTION, "strategy:review:500020:2:0:SENTRY_BUILD", "gate", { toSystemId: NEXT_SYS });
    env.deploy(b.sentryId);
    assert.strictEqual(lines.filter((l) => l.includes("slow SENTRY_DEPLOY")).length, 1, "a fast deploy logs nothing");
    env.sentries.stop("test");
  }));

  needsDriver("SF6 a player's sentry on the station counts for the planner (readForReview anchors, every owner) "
    + "> the gate is planned and built; a loaded scene refusing the entity -> spawnFailed", () =>
    H.withStore(driver, async (reopen) => {
    const env = rig(reopen);
    env.tx((db) => db.prepare("INSERT INTO world_sentries (sentry_id, owner_kind, faction_id, owner_corp_id, "
      + "anchored_by_character_id, item_id, type_id, system_id, anchor_kind, anchor_id, slot, state, armed_at, cost_isk, "
      + "ammo_grants, end_reason, created_at, updated_at, ended_at, version) VALUES ('sp-1', 'player', NULL, 98000001, "
      + "90000001, 8000001, 340501, ?, 'structure', ?, 0, 'ACTIVE', 0, 0, 0, NULL, 0, 0, NULL, 1)").run(SYS, STRUCTURE));
    const read = env.tx((db) => env.sentries.readForReview(db, FACTION, { maxCandidateSystems: 16, systemIds: [SYS] }));
    assert.deepStrictEqual(read.anchors, [{ systemId: SYS, anchorKind: "station", anchorRef: { stationId: "st-x" },
      live: 1 }]);
    const snapshot = { faction: { status: "ACTIVE" }, treasury: { mode: "ready", balanceIsk: 5000 },
      isHostile: () => true, sentries: { mode: "ready", typeId: 340501, factionLive: read.factionLive, total: read.total,
        rows: read.rows, anchors: read.anchors, systems: [{ systemId: SYS, secClass: "nullsec", occupationState: "STABLE",
          stations: [{ stationId: "st-x", kind: "upwell" }], neighbours: [{ systemId: NEXT_SYS, controllerFactionId: 1 }] }] } };
    const P = { ...DEFAULTS.sentries.faction, costIsk: COST, minBalanceMultiple: 1, maxPerAnchor: 1, maxTotal: 500 };
    const plan = planSentries(snapshot, { sentries: P });
    assert.deepStrictEqual(plan.intents.map((i) => [i.anchorKind, i.anchorRef]), [["gate", { toSystemId: NEXT_SYS }]],
      JSON.stringify(plan));
    const built = env.build(FACTION, "strategy:review:500020:1:0:SENTRY_BUILD", "gate", { toSystemId: NEXT_SYS });
    env.v.sceneLoaded = true;
    env.v.spawnFails = true;
    const d = env.deploy(built.sentryId);
    assert.deepStrictEqual([built.ok, d.outcome, env.row(built.sentryId).state,
      env.service.getStatus().counters.spawnFailed, env.service.getStatus().counters.vendorPartial,
      env.v.spawned.length], [true, "DEPLOYED", "ACTIVE", 1, 0, 0]);
    env.sentries.stop("test");
  }));

  needsDriver("SF7 the top-up budget rotates past FULL sentries (the empty last one gets its grant in pass 2) "
    + "Receipts of a sentry without a row pruned, the others kept", () => H.withStore(driver, async (reopen) => {
    const env = rig(reopen, { maxTopUpsPerPass: 2 });
    const ids = [1, 2, 3].map((n) => env.build(FACTION, `strategy:review:500020:${n}:0:SENTRY_BUILD`, "gate",
      { toSystemId: NEXT_SYS }).sentryId).sort();
    for (const id of ids) assert.strictEqual(env.deploy(id).outcome, "DEPLOYED");
    const chargesOf = (id) => [...env.v.items.values()].filter((i) => i.locationID === env.row(id).item_id
      && i.flagID === 27);
    for (const i of chargesOf(ids[2])) env.v.items.delete(i.itemID);
    const passes = [env.sentries.reconcile(env.clock.now()), env.sentries.reconcile(env.clock.now())];
    assert.deepStrictEqual([passes.map((p) => p.topUps), env.row(ids[2]).ammo_grants,
      chargesOf(ids[2]).map((i) => i.quantity)], [[0, 1], 2, [4000]], JSON.stringify(passes));

    const itemA = env.row(ids[0]).item_id;
    env.tx((db) => db.prepare("UPDATE world_sentries SET state = 'DESTROYED', end_reason = 'VANISHED', ended_at = ? "
      + "WHERE sentry_id = ?").run(env.clock.now(), ids[0]));
    env.v.items.delete(itemA);
    env.v.receipts.set("other-mod:1", Object.freeze({ itemId: 1, typeId: 1, qty: 1, loc: 1 }));
    env.sentries.reconcile(env.clock.now() + DEFAULTS.sentries.retentionMs + 1);
    assert.strictEqual(env.row(ids[0]), null);
    assert.deepStrictEqual([...env.v.receipts.keys()].sort(), ["other-mod:1",
      `lne-sentry-ammo:${ids[1]}:0`, `lne-sentry-ammo:${ids[2]}:0`, `lne-sentry-ammo:${ids[2]}:1`,
      `lne-sentry:${ids[1]}`, `lne-sentry:${ids[2]}`].sort());
    assert.strictEqual(env.service.getStatus().counters.receiptsPruned, 2);
    env.sentries.stop("test");
  }));

  test("SF5 faction sentry vendor facts: grant destination rule ids > 0 only, flag 27 charges, receipt read, "
    + "spawnDynamicInventoryEntity loads a scene", () => {
    const found = findServerSrcOnDisk(MOD_DIR, 5, fs.existsSync);
    assert.ok(found.ok, "EveJS server/src not found above the mod");
    const read = (rel) => fs.readFileSync(path.join(found.srcDir, `${rel}.js`), "utf8").replace(/\r\n/g, "\n");
    const problems = [];
    const store = read("services/inventory/itemStore");
    const body = (name) => {
      const at = store.indexOf(`\nfunction ${name}(`);
      return at < 0 ? "" : store.slice(at, store.indexOf("\n}\n", at));
    };
    const idem = body("grantItemToOwnerLocationIdempotent");
    if (!/numericOwnerID <= 0 \|\|\s*numericLocationID <= 0 \|\|\s*numericTypeID <= 0/.test(idem)
      || !idem.includes("\"INVALID_GRANT_DESTINATION\"")) problems.push("idempotent grant: ids > 0 only");
    if (!idem.includes("errorMsg: \"IDEMPOTENCY_RECEIPT_MISMATCH\"") || !idem.includes("itemIDs: readReceiptItemIDs("))
      problems.push("idempotent grant: replay itemIDs / mismatch");
    const many = body("grantItemsToOwnerLocation");
    if (!many.includes("return grantItemsToCharacterLocation(") || /LOCATION_NOT_FOUND|INVALID_LOCATION|DESTINATION/
      .test(many)) problems.push("grantItemsToOwnerLocation: destination rule");
    if (!many.includes("spaceState: options.spaceState || null,")) problems.push("grant: item build");
    if (!/^const FLAG_CHARGES = 27;$/m.test(read("services/starbase/starbaseDefenseRuntime"))) problems.push("flag 27");
    if (!body("getIdempotentGrantReceipt").includes("found: Boolean(receipt),")) problems.push("receipt found");
    if (!/^function getBatteryAmmoCapacity\(item, flag\) \{$/m.test(read("services/starbase/starbaseInventoryRuntime"))) {
      problems.push("getBatteryAmmoCapacity");
    }
    const dyn = read("space/runtime/spaceRuntime/dynamicEntities");
    const spawnAt = dyn.indexOf("spawnDynamicInventoryEntity(systemID, itemID, options = {}) {");
    if (spawnAt < 0 || !dyn.slice(spawnAt, spawnAt + 1500).includes("this.ensureScene(")) {
      problems.push("spawnDynamicInventoryEntity ensureScene (the mod calls it only with a loaded scene)");
    }
    if (!/^function updateInventoryItem\(itemId, updater, resultMode = null\) \{$/m.test(store)) problems.push("updateInventoryItem");
    const prune = body("pruneIdempotentGrantReceipts");
    if (!prune.startsWith("\nfunction pruneIdempotentGrantReceipts(predicate) {")
      || !prune.includes("dead = predicate(cloneValue(receipt)) === true;") || !/^ {2}pruneIdempotentGrantReceipts,$/m
      .test(store)) problems.push("pruneIdempotentGrantReceipts(predicate)");
    assert.deepStrictEqual(problems, []);
  });
};

module.exports.fakeVendor = fakeVendor;
