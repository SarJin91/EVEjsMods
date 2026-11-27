"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { isDeepStrictEqual } = require("node:util");

const config = require("../../config");
const S = require("../../lib/stations/harvestRaid/schema");
const { planRaidStart, decideRaidStep, canTransition } = require("../../lib/stations/harvestRaid/machine");
const { planMetenoxLoss } = require("../../lib/stations/harvestRaid/lossPlan");
const { createHarvestRaidRepository } = require("../../lib/stations/harvestRaid/repository");
const { createHarvestRaidService } = require("../../lib/stations/harvestRaid/service");
const { startHarvestRaid } = require("../../lib/stations/harvestRaid");
const HB = require("../../lib/adapter/harvestBays");
const { GAME_MODULES } = require("../../lib/adapter/gameModules");
const { GROUPS: STRENGTH_GROUPS } = require("../../lib/battle/data/strengthCatalog");
const { expandStrengthGroups } = require("../../lib/battle/strength");
const { createJournal } = require("../../lib/persistence/journal");
const { createAbortSentinel } = require("../../lib/persistence/store");
const { TABLE_POLICY, ACTION } = require("../../lib/persistence/worldReset");
const { MIGRATIONS } = require("../../lib/persistence/migrations");
const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
const { loadDriver, withStore } = require("../notices/storeHelper");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const T0 = 1760000000000;
const SYS = 30000001;
const FACTION = 500010;
const OWNER = 98000001;
const METENOX = 9001;
const METENOX_B = 9002;
const MAT_A = 16634;
const MAT_B = 16635;
const FUEL = 4051;
const ABORT = createAbortSentinel("harvestRaid.test");

let base = null;
function resolved(env = {}) {
  return config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(), ...env } });
}
function baseConfig() {
  if (!base) {
    const r = resolved();
    assert.deepStrictEqual(r.errors || [], []);
    base = r.config;
  }
  return base;
}
function cfg(over = {}) {
  const c = baseConfig();
  return { ...c, harvestRaid: { ...c.harvestRaid, enabled: true, ...over }, notices: { ...c.notices, enabled: true } };
}

const P = () => {
  const C = baseConfig().harvestRaid;
  return { targetCooldownMs: C.targetCooldownMs, ownerCooldownMs: C.ownerCooldownMs, maxOpen: C.maxOpen,
    maxOpenPerFaction: C.maxOpenPerFaction, minLootVolumeM3: C.minLootVolumeM3, wallDeadlineMs: C.wallDeadlineMs,
    warningMs: C.warningMs, sampleMs: C.sampleMs, raidMs: C.raidMs };
};

function startInput(over = {}) {
  return { at: T0, secClass: "nullsec", secClasses: ["lowsec", "nullsec"],
    operation: { operationId: "op1", factionId: FACTION, operationType: "harvest_raid", state: "ACTIVE",
      targetSystemId: SYS },
    target: { structureId: METENOX, systemId: SYS, typeId: 81826, ownerCorpId: OWNER, destroyed: false,
      virtualOwner: false },
    hostile: true, ownerOnline: true, siegeOpen: false, openOnTarget: false, lastTargetEndedAt: null,
    lastOwnerStartedAt: null, openTotal: 0, openByFaction: 0, attackerShips: 5, lootVolumeM3: 100, params: P(),
    ...over };
}

function fakeVendor() {
  const items = new Map();
  const receipts = new Map();
  const uncertain = new Map();
  const diverged = new Set();
  const calls = { consume: 0, receiptReads: 0 };
  const hooks = { beforeConsume: null };
  const types = new Map([[MAT_A, { groupID: 427, volume: 0.05 }], [MAT_B, { groupID: 427, volume: 0.05 }],
    [FUEL, { groupID: 1136, volume: 5 }]]);
  const structures = new Map([[METENOX, { structureID: METENOX, solarSystemID: SYS, typeID: 81826, ownerCorpID: OWNER,
    destroyedAt: 0 }], [METENOX_B, { structureID: METENOX_B, solarSystemID: SYS, typeID: 81826, ownerCorpID: OWNER,
    destroyedAt: 0 }]]);
  const clone = (v) => (v ? JSON.parse(JSON.stringify(v)) : null);
  const add = (itemID, typeID, stacksize, extra = {}) => items.set(itemID, { itemID, typeID, ownerID: OWNER,
    locationID: METENOX, flagID: 186, singleton: 0, stacksize, ...extra });
  const applyConsume = (itemId, qty, opts) => {
    const it = items.get(itemId);
    if (!it) return { success: false, errorMsg: "ITEM_NOT_FOUND" };
    if (qty > it.stacksize) return { success: false, errorMsg: "INSUFFICIENT_ITEMS" };
    calls.consume += 1;
    if (qty === it.stacksize) items.delete(itemId);
    else it.stacksize -= qty;
    receipts.set(opts.receiptKey, { receiptKey: opts.receiptKey, operation: "consume-inventory-item-quantity",
      fingerprint: clone(opts.fingerprint) });
    return { success: true, duplicate: false, data: { changes: [] } };
  };
  const vendor = {
    itemStore: {
      listContainerItems: (_o, loc, flag) => [...items.values()].filter((i) => i.locationID === loc
        && (flag === null || i.flagID === flag)).map(clone),
      findItemById: (id) => clone(items.get(id)),
      getIdempotentGrantReceipt: (key, opts = {}) => {
        calls.receiptReads += 1;
        if (uncertain.get(key) === "write" && opts.reconcileWriteRefusal === true && !diverged.has(key)) {
          uncertain.delete(key);
        }
        if (uncertain.get(key) === "write") {
          return { success: false, durable: false, ambiguous: true, errorMsg: "IDEMPOTENT_GRANT_WRITE_OUTCOME_AMBIGUOUS",
            data: null };
        }
        return { success: true, durable: receipts.has(key), found: receipts.has(key), data: receipts.get(key) || null };
      },
      consumeInventoryItemQuantityIdempotent: (itemId, qty, opts) => {
        const prior = receipts.get(opts.receiptKey);
        if (prior) {
          return isDeepStrictEqual(prior.fingerprint, opts.fingerprint) ? { success: true, duplicate: true, data: {} }
            : { success: false, ambiguous: true, errorMsg: "IDEMPOTENCY_RECEIPT_MISMATCH" };
        }
        if (hooks.beforeConsume) {
          const h = hooks.beforeConsume(itemId, qty, opts);
          if (h && h.errorMsg === "IDEMPOTENT_INVENTORY_WRITE_OUTCOME_AMBIGUOUS" && receipts.has(opts.receiptKey)) {
            uncertain.set(opts.receiptKey, "write");
          }
          if (h) return h;
        }
        return applyConsume(itemId, qty, opts);
      },
    },
    types: { resolveItemByTypeID: (t) => clone(types.get(t)) },
    state: { getStructureByID: (id) => clone(structures.get(id)) },
  };
  return { vendor, items, receipts, uncertain, diverged, calls, hooks, add, applyConsume, structures };
}

const seamOf = (vendor) => HB.createHarvestBaySeam({ requireGame: (p) => {
  const key = Object.keys(HB.PATHS).find((k) => HB.PATHS[k] === p);
  return { ok: true, exports: vendor[key] };
}, disabledReason: () => null });

function fakeScheduler() {
  const queued = [];
  return { queued,
    enqueue: (eventType, aggregateId, dueAt, payload, idempotencyKey) => {
      queued.push({ eventType, aggregateId, dueAt, payload, idempotencyKey });
      return { ok: true, duplicate: false };
    },
    enqueueMany: (specs) => ({ ok: true, enqueued: specs.length, duplicates: 0 }),
    findByKey: () => ({ ok: true, found: false }) };
}

function serviceOf(store, journal, bays, sched, opts = {}) {
  const fleet = { fleetId: "f1", factionId: FACTION, fleetRole: "invasion", state: "STAGED", operationId: "op1",
    composition: [{ hullGroup: "cruiser", count: 5 }] };
  const op = { operationId: "op1", operationType: "harvest_raid", state: "ACTIVE", factionId: FACTION,
    targetSystemId: SYS };
  return createHarvestRaidService({ store, raids: createHarvestRaidRepository({ journal }), scheduler: sched,
    fleetRepository: {
      getFleet: (_tx, id) => ({ ok: true, fleet: id === "f1" ? fleet : null }),
      getOperation: () => ({ ok: true, operation: op }),
      listFleetsInSystem: () => ({ ok: true, fleets: opts.noFleet ? [] : [fleet], nextAfterFleetId: null }),
    },
    registry: { isActive: () => true, getFaction: () => ({ kind: "pirate" }) },
    structures: {
      listCandidates: () => ({ ok: true, bySystem: new Map([[SYS, [{ structureId: METENOX, systemId: SYS,
        typeId: 81826, ownerCorpId: OWNER }]]]) }),
      readOwnerFace: () => ({ ok: true, npc: false, ceoId: 90000001 }),
    },
    bays, readStanding: () => ({ ok: true, standing: -10 }),
    getVirtualCorps: () => ({ isVirtualCorporation: () => false }), getPlayerSiege: () => null,
    getNotices: () => ({ getStatus: () => ({ state: opts.noticesState || "running" }) }),
    ownerOnline: () => ({ online: opts.online !== false, reason: null }), hostility: () => true,
    groups: expandStrengthGroups(STRENGTH_GROUPS, null, null),
    getGraph: () => ({ ok: true, graph: { getSystem: () => ({ secClass: "nullsec" }) } }),
    config: cfg(opts.over || {}), clock: { now: () => (opts.now ? opts.now() : T0) },
    logger: { log() {} } });
}

function apply(store, r, ev) {
  assert.ok(r && r.ok === true, JSON.stringify(r));
  if (typeof r.effect !== "function") {
    if (r.onCommitted) r.onCommitted(undefined);
    return undefined;
  }
  let value = null;
  const t = store.transaction("test.effect", (db) => {
    value = r.effect(db, ev);
    if (!value || value.ok !== true) throw ABORT;
    return value;
  });
  assert.ok(t.ok, `effect refused ${JSON.stringify(value)} ${t.reason}`);
  if (r.onCommitted) r.onCommitted(t.value);
  return t.value;
}

const evOf = (q) => ({ payload: q.payload, dueAt: q.dueAt, idempotencyKey: q.idempotencyKey });
const rowOf = (store, raids, raidId) => store.transaction("test.read", (db) => raids.getRaid(db, raidId)).value.raid;

function serverSrc() {
  const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
  assert.ok(found.ok, found.reason);
  return found.srcDir;
}
const readVendor = (rel) => fs.readFileSync(path.join(serverSrc(), rel), "utf8").replace(/\r\n/g, "\n");

module.exports = ({ test }) => {
  test("R1 machine: start table, online credit, delta cap, WARNED -> RAIDING -> SETTLING, ends, transitions", () => {
    const ok = planRaidStart(startInput());
    assert.deepStrictEqual({ ...ok.start }, { raidId: `hr:metenox:${METENOX}:${T0}`, targetKind: "metenox",
      targetId: METENOX, systemId: SYS, ownerCorpId: OWNER, attackerFactionId: FACTION, operationId: "op1", at: T0,
      wallDeadlineAt: T0 + P().wallDeadlineMs, firstStepAt: T0 + P().sampleMs });
    const C = P();
    const refusals = [
      [{ operation: null }, "NO_OPERATION"],
      [{ operation: { ...startInput().operation, operationType: "raid" } }, "NO_OPERATION"],
      [{ operation: { ...startInput().operation, state: "COMPLETED" } }, "NO_OPERATION"],
      [{ target: { ...startInput().target, typeId: 35835 } }, "NO_TARGET"],
      [{ secClass: "highsec" }, "SEC_CLASS"],
      [{ target: { ...startInput().target, destroyed: true } }, "NO_TARGET"],
      [{ target: { ...startInput().target, virtualOwner: true } }, "VIRTUAL_OWNER"],
      [{ hostile: false }, "NOT_HOSTILE"],
      [{ siegeOpen: true }, "SIEGE_OPEN"],
      [{ openOnTarget: true }, "BUSY"],
      [{ lastTargetEndedAt: T0 - C.targetCooldownMs + 1 }, "COOLDOWN"],
      [{ lastOwnerStartedAt: T0 - C.ownerCooldownMs + 1 }, "OWNER_COOLDOWN"],
      [{ openTotal: C.maxOpen }, "LIMIT"],
      [{ openByFaction: C.maxOpenPerFaction }, "LIMIT"],
      [{ attackerShips: 0 }, "NO_HOLD"],
      [{ ownerOnline: false }, "OWNER_OFFLINE"],
      [{ lootVolumeM3: C.minLootVolumeM3 - 1 }, "LOW_LOOT"],
    ];
    for (const [over, reason] of refusals) {
      assert.deepStrictEqual(planRaidStart(startInput(over)), { start: null, reason }, JSON.stringify(over));
    }
    assert.ok(planRaidStart(startInput({ lastTargetEndedAt: T0 - C.targetCooldownMs,
      lastOwnerStartedAt: T0 - C.ownerCooldownMs })).start);

    const raid = { state: S.WARNED, creditedMs: 0, lastSampleAt: T0, wallDeadlineAt: T0 + C.wallDeadlineMs,
      ownerCorpId: OWNER };
    const facts = (over = {}) => ({ at: T0 + C.sampleMs, ownerOnline: true, attackerShips: 5, engaged: false,
      target: { destroyed: false, ownerCorpId: OWNER }, siegeOpen: false, params: C, ...over });
    assert.deepStrictEqual(decideRaidStep(raid, facts()), { action: "SAMPLE", creditedMs: C.sampleMs,
      lastSampleAt: T0 + C.sampleMs, credited: true, dueAt: T0 + 2 * C.sampleMs });
    assert.strictEqual(decideRaidStep(raid, facts({ ownerOnline: false })).creditedMs, 0);
    assert.strictEqual(decideRaidStep(raid, facts({ engaged: true })).creditedMs, 0);
    assert.strictEqual(decideRaidStep(raid, facts({ at: T0 + 10 * C.sampleMs })).creditedMs, 2 * C.sampleMs);
    const adv = decideRaidStep({ ...raid, creditedMs: C.warningMs - C.sampleMs }, facts());
    assert.deepStrictEqual([adv.action, adv.to, adv.creditedMs], ["ADVANCE", S.RAIDING, 0]);
    const settle = decideRaidStep({ ...raid, state: S.RAIDING, creditedMs: C.raidMs - C.sampleMs }, facts());
    assert.deepStrictEqual([settle.action, settle.to], ["SETTLE", S.SETTLING]);
    const offline = decideRaidStep({ ...raid, state: S.RAIDING, creditedMs: C.raidMs - C.sampleMs },
      facts({ ownerOnline: false }));
    assert.strictEqual(offline.action, "SAMPLE");
    const ends = [
      [facts({ at: raid.wallDeadlineAt }), S.EXPIRED, "WALL_DEADLINE"],
      [facts({ target: null }), S.ABORTED, "TARGET_GONE"],
      [facts({ target: { destroyed: true, ownerCorpId: OWNER } }), S.ABORTED, "TARGET_DESTROYED"],
      [facts({ target: { destroyed: false, ownerCorpId: OWNER + 1 } }), S.ABORTED, "OWNER_CHANGED"],
      [facts({ siegeOpen: true }), S.ABORTED, "SIEGE_OPEN"],
      [facts({ attackerShips: 0 }), S.REPELLED, "NO_HOLD"],
    ];
    for (const [f, to, reason] of ends) {
      assert.deepStrictEqual(decideRaidStep(raid, f), { action: "END", to, reason });
      assert.deepStrictEqual(decideRaidStep({ ...raid, state: S.RAIDING }, f), { action: "END", to, reason });
    }
    assert.deepStrictEqual(decideRaidStep({ ...raid, state: S.SETTLING }, facts()), { action: "STALE" });
    assert.strictEqual(canTransition(S.SETTLING, S.SETTLED).ok, true);
    assert.strictEqual(canTransition(S.SETTLING, S.REPELLED).ok, false);
    assert.strictEqual(canTransition(S.WARNED, S.SETTLING).ok, false);
    assert.strictEqual(canTransition(S.SETTLED, S.SETTLING).ok, false);
  });

  test("R2 planMetenoxLoss: bay / group / owner filter, floor permille, volume scale, plan lines, permille range", () => {
    const line = (itemId, typeId, units, over = {}) => ({ itemId, typeId, units, unitVolume: 0.05, flagId: 186,
      groupId: 427, ownerId: OWNER, ...over });
    const lines = [line(1, MAT_A, 1000), line(2, FUEL, 1000, { groupId: 1136, unitVolume: 5 }),
      line(3, MAT_A, 1000, { flagId: 164 }), line(4, MAT_B, 1000, { ownerId: OWNER + 1 }), line(5, MAT_B, 7)];
    const r = planMetenoxLoss({ lines, ownerCorpId: OWNER, lossPermille: 150, maxLossVolumeM3: 2000, maxPlanLines: 32 });
    assert.deepStrictEqual(r.plan.map((l) => ({ ...l })), [{ itemId: 1, typeId: MAT_A, units: 150 },
      { itemId: 5, typeId: MAT_B, units: 1 }]);
    const big = planMetenoxLoss({ lines: [line(1, MAT_A, 100000, { unitVolume: 0.1 }),
      line(2, MAT_B, 100000, { unitVolume: 0.1 })], ownerCorpId: OWNER, lossPermille: 150, maxLossVolumeM3: 2000,
    maxPlanLines: 32 });
    assert.ok(big.volumeM3 <= 2000 && big.volumeM3 > 1990, String(big.volumeM3));
    assert.ok(big.plan.every((l) => l.units <= 15000 && l.units > 0));
    const cut = planMetenoxLoss({ lines: [line(9, MAT_A, 100), line(8, MAT_A, 100), line(7, MAT_A, 100)],
      ownerCorpId: OWNER, lossPermille: 500, maxLossVolumeM3: 2000, maxPlanLines: 2 });
    assert.deepStrictEqual(cut.plan.map((l) => l.itemId), [7, 8]);
    assert.deepStrictEqual(planMetenoxLoss({ lines, ownerCorpId: OWNER, lossPermille: 0, maxLossVolumeM3: 2000,
      maxPlanLines: 32 }).plan, []);
    for (const bad of [501, -1, 1.5]) {
      assert.deepStrictEqual(planMetenoxLoss({ lines, ownerCorpId: OWNER, lossPermille: bad, maxLossVolumeM3: 2000,
        maxPlanLines: 32 }), { ok: false, reason: "CONFIG_INVALID", detail: "lossPermille" });
    }
  });

  test("R3 settlement: CHECK -> SETTLING, interrupted at every step, each stack taken at most once; 0 lines; "
    + "uncertain lines; always SETTLED", () => {
    const loaded = loadDriver();
    assert.ok(loaded.ok, loaded.detail);
    withStore(loaded, (opened) => {
      const store = opened.store;
      const journal = createJournal({ clock: { now: () => T0 }, maxPayloadBytes: 4096, maxRows: 500 });
      const fv = fakeVendor();
      fv.add(101, MAT_A, 10000);
      fv.add(102, MAT_B, 20000);
      fv.add(103, MAT_A, 5000);
      fv.add(104, FUEL, 100);
      fv.add(105, MAT_A, 1000, { ownerID: OWNER + 1 });
      const bays = seamOf(fv.vendor);
      const sched = fakeScheduler();
      const C = cfg().harvestRaid;
      let svc = serviceOf(store, journal, bays, sched);
      const check = { payload: { systemId: SYS, at: T0, triggerFleetId: "f1" }, dueAt: T0,
        idempotencyKey: S.arrivalCheckKey(SYS, "f1", 3) };
      const checked = svc.onCheck(check);
      assert.strictEqual(checked.outcome, "START", JSON.stringify(checked));
      const started = apply(store, checked, check);
      assert.strictEqual(started.started, true);
      const raidId = `hr:metenox:${METENOX}:${T0}`;
      assert.strictEqual(rowOf(store, createHarvestRaidRepository({ journal }), raidId).state, S.WARNED);
      let guard = 0;
      while (!sched.queued.some((q) => q.eventType === S.SETTLE_EVENT_TYPE) && guard < 40) {
        guard += 1;
        const q = sched.queued.filter((e) => e.eventType === S.STEP_EVENT_TYPE).pop();
        apply(store, svc.onStep(evOf(q)), evOf(q));
      }
      const raids = createHarvestRaidRepository({ journal });
      const settling = rowOf(store, raids, raidId);
      assert.strictEqual(settling.state, S.SETTLING);
      assert.strictEqual(settling.startedAt + C.warningMs + C.raidMs, settling.updatedAt);
      assert.deepStrictEqual(settling.plan, [{ itemId: 101, typeId: MAT_A, units: 1500 },
        { itemId: 102, typeId: MAT_B, units: 3000 }, { itemId: 103, typeId: MAT_A, units: 750 }]);
      assert.strictEqual(fv.calls.consume, 0, "nothing taken before SETTLE");
      const settleEv = evOf(sched.queued.find((q) => q.eventType === S.SETTLE_EVENT_TYPE));
      svc = serviceOf(store, journal, bays, sched);
      fv.hooks.beforeConsume = (itemId) => {
        if (itemId !== 102) return null;
        fv.hooks.beforeConsume = null;
        throw new Error("crash");
      };
      const r1 = svc.onSettle(settleEv);
      assert.deepStrictEqual([r1.ok, r1.reason, Number.isSafeInteger(r1.deferUntil)],
        [false, "HARVEST_RAID_VENDOR_UNCERTAIN", true]);
      assert.strictEqual(fv.calls.consume, 2);
      svc = serviceOf(store, journal, bays, sched);
      const r2 = svc.onSettle(settleEv);
      assert.strictEqual(typeof r2.effect, "function");
      assert.strictEqual(fv.calls.consume, 3);
      assert.strictEqual(rowOf(store, raids, raidId).state, S.SETTLING);
      svc = serviceOf(store, journal, bays, sched);
      const done = apply(store, svc.onSettle(settleEv), settleEv);
      assert.strictEqual(done.stale, false);
      assert.strictEqual(fv.calls.consume, 3, "each stack taken once");
      assert.strictEqual(svc.getStatus().counters.receiptDuplicates, 3);
      assert.deepStrictEqual([fv.items.get(101).stacksize, fv.items.get(102).stacksize, fv.items.get(103).stacksize,
        fv.items.get(104).stacksize, fv.items.get(105).stacksize], [8500, 17000, 4250, 100, 1000]);
      const settled = rowOf(store, raids, raidId);
      assert.deepStrictEqual([settled.state, settled.open, settled.loss], [S.SETTLED, false,
        [{ typeId: MAT_A, units: 2250 }, { typeId: MAT_B, units: 3000 }]]);
      const again = svc.onSettle(settleEv);
      assert.strictEqual(again.outcome, "STALE");
      assert.strictEqual(fv.calls.consume, 3);

      fv.add(201, MAT_A, 10, { locationID: METENOX_B });
      fv.add(202, MAT_A, 100, { locationID: METENOX_B });
      fv.add(203, MAT_B, 100, { locationID: METENOX_B });
      fv.add(204, MAT_B, 100, { locationID: METENOX_B });
      const raidB = `hr:metenox:${METENOX_B}:${T0}`;
      const plan = [{ itemId: 200, typeId: MAT_A, units: 5 }, { itemId: 201, typeId: MAT_A, units: 50 },
        { itemId: 202, typeId: MAT_A, units: 15 }, { itemId: 203, typeId: MAT_B, units: 15 },
        { itemId: 204, typeId: MAT_B, units: 15 }];
      const made = store.transaction("test.raidB", (db) => {
        const c = raids.createRaid(db, { raidId: raidB, targetKind: "metenox", targetId: METENOX_B, systemId: SYS,
          ownerCorpId: OWNER, attackerFactionId: FACTION, operationId: null, at: T0, wallDeadlineAt: T0 + 1 });
        assert.ok(c.ok, JSON.stringify(c));
        let raid = raids.getRaid(db, raidB).raid;
        raid = raids.transition(db, { raid, to: S.RAIDING, at: T0, patch: { creditedMs: 0 } }).raid;
        return raids.transition(db, { raid, to: S.SETTLING, at: T0, patch: { planJson: JSON.stringify(plan) } });
      });
      assert.ok(made.ok && made.value.ok, JSON.stringify(made));
      let clock = T0;
      const key202 = HB.takeReceiptKey(raidB, 202);
      const key204 = HB.takeReceiptKey(raidB, 204);
      fv.diverged.add(key204);
      fv.hooks.beforeConsume = (itemId, qty, opts) => {
        if (itemId === 202 || itemId === 204) {
          fv.applyConsume(itemId, qty, opts);
          return { success: false, ambiguous: true, errorMsg: "IDEMPOTENT_INVENTORY_WRITE_OUTCOME_AMBIGUOUS" };
        }
        if (itemId === 203) return { success: false, ambiguous: true, errorMsg: "IDEMPOTENT_GRANT_RECEIPT_FLUSH_FAILED" };
        return null;
      };
      svc = serviceOf(store, journal, bays, sched, { now: () => clock });
      const evB = { payload: { raidId: raidB }, dueAt: T0, idempotencyKey: S.settleKey(raidB) };
      assert.strictEqual(svc.onSettle(evB).reason, "HARVEST_RAID_VENDOR_UNCERTAIN");
      assert.deepStrictEqual([fv.uncertain.has(key202), fv.uncertain.get(key204)], [false, "write"]);
      clock = T0 + C.settleWallMs;
      apply(store, svc.onSettle(evB), evB);
      const endB = rowOf(store, raids, raidB);
      assert.deepStrictEqual([endB.state, endB.loss, fv.items.get(203).stacksize, fv.items.get(201).stacksize],
        [S.SETTLED, [{ typeId: MAT_A, units: 15 }], 100, 10]);
      assert.strictEqual(fv.calls.consume, 5, "202 and 204 taken once each, never again");
      assert.strictEqual(svc.getStatus().counters.linesZero, 4);

      const raidC = `hr:metenox:${METENOX}:${T0 + 1}`;
      const madeC = store.transaction("test.raidC", (db) => raids.createRaid(db, { raidId: raidC, targetKind: "metenox",
        targetId: METENOX, systemId: SYS, ownerCorpId: OWNER, attackerFactionId: FACTION, operationId: null,
        at: T0 + 1, wallDeadlineAt: T0 + 2 }));
      assert.ok(madeC.ok && madeC.value.ok, JSON.stringify(madeC));
      const rowC = rowOf(store, raids, raidC);
      const getStructure = fv.vendor.state.getStructureByID;
      fv.vendor.state.getStructureByID = () => {
        throw new Error("structure seam down");
      };
      try {
        svc = serviceOf(store, journal, bays, sched);
        const stepC = (dueAt) => ({ payload: { raidId: raidC, phaseSeq: rowC.phaseSeq, round: rowC.version }, dueAt,
          idempotencyKey: S.stepKey(raidC, rowC.phaseSeq, rowC.version) });
        const early = svc.onStep(stepC(T0 + 1));
        assert.deepStrictEqual([early.ok, early.reason, Number.isSafeInteger(early.deferUntil)],
          [false, "SEAM_ERROR", true], "before the wall deadline the seam refusal still defers");
        const late = svc.onStep(stepC(T0 + 2));
        assert.strictEqual(late.outcome, "END", JSON.stringify(late));
        apply(store, late, stepC(T0 + 2));
      } finally {
        fv.vendor.state.getStructureByID = getStructure;
      }
      const endC = rowOf(store, raids, raidC);
      assert.deepStrictEqual([endC.state, endC.open, endC.endReason], [S.EXPIRED, false, "WALL_DEADLINE"]);
    });
  });

  test("R4 flag off before any read; DRIFT of harvestRaid = no start; presence off; GAME_MODULES; config; migration",
    () => {
      const touched = [];
      const spy = (name) => new Proxy({}, { get(_t, k) {
        touched.push(`${name}.${String(k)}`);
        return undefined;
      } });
      const off = startHarvestRaid({ config: cfg({ enabled: false }), persistence: spy("persistence"),
        scheduler: spy("scheduler"), fleets: spy("fleets"), strategy: spy("strategy"), adapter: spy("adapter"),
        clock: spy("clock"), graph: spy("graph") });
      assert.deepStrictEqual([off, touched], [{ ok: false, reason: "disabled_by_config" }, []]);

      const calls = { requireGame: 0, handlers: 0, listeners: 0 };
      const deps = (config, disabled) => ({ config, clock: { now: () => T0 },
        persistence: { ok: true, store: {}, journal: { applyOnce() {} } },
        scheduler: { getStatus: () => ({ state: "ready" }), registerHandler: () => {
          calls.handlers += 1;
          return { ok: true, unregister() {} };
        }, enqueue() {}, enqueueMany() {}, findByKey() {} },
        fleets: { repository: { listFleetsInSystem() {}, getFleet() {}, getOperation() {} },
          travel: { addArrivalListener: () => {
            calls.listeners += 1;
            return { ok: true, remove() {} };
          } } },
        strategy: { registry: { isActive() {}, getFaction() {} } },
        adapter: { harvestBays: HB.createHarvestBaySeam({ requireGame: () => {
          calls.requireGame += 1;
          return { ok: false, reason: "test" };
        }, disabledReason: (c) => (c === disabled ? "DRIFT itemStore.consumeInventoryItemQuantityIdempotent" : null) }),
        playerStructures: { listCandidates() {} }, playerStructureSeams: () => ({ ok: true }) } });
      const drift = startHarvestRaid(deps(cfg(), "harvestRaid"));
      assert.deepStrictEqual([drift.ok, drift.reason, calls], [false, "HARVEST_BAYS_SEAM_UNAVAILABLE",
        { requireGame: 0, handlers: 0, listeners: 0 }]);
      assert.match(drift.detail, /DRIFT/);
      const c = cfg();
      const noPresence = { ...c, modules: { ...c.modules, presence: { ...c.modules.presence, enabled: false } } };
      assert.deepStrictEqual(startHarvestRaid(deps(noPresence, null)), { ok: false,
        reason: "dependency_disabled:presence" });

      for (const key of Object.keys(HB.REQUIRED)) {
        const m = GAME_MODULES.find((g) => g.path === HB.PATHS[key]);
        assert.ok(m, HB.PATHS[key]);
        for (const name of HB.REQUIRED[key]) {
          const s = m.symbols.find((x) => x.name === name);
          assert.ok(s && s.consumers.includes(HB.CONSUMER) && s.wrap !== true, `${HB.PATHS[key]}.${name}`);
        }
      }
      const d = baseConfig().harvestRaid;
      assert.deepStrictEqual([d.enabled, d.lossPermille, d.maxLossVolumeM3, d.targetCooldownMs, d.ownerCooldownMs,
        d.secClasses], [false, 150, 2000, 259200000, 86400000, "lowsec,nullsec"]);
      const warned = resolved({ EVEJS_LNE_HARVEST_RAID_ENABLED: "1", EVEJS_LNE_HARVEST_RAID_LOSS_PERMILLE: "301",
        EVEJS_LNE_PRESENCE_ENABLED: "0" }).warnings;
      assert.ok(warned.some((w) => w.startsWith("harvestRaid.lossPermille 301 > 300")), warned.join("\n"));
      assert.ok(warned.some((w) => w.startsWith("harvestRaid.enabled with modules.presence.enabled=false")));
      assert.ok(!warned.some((w) => w.startsWith("harvestRaid.wallDeadlineMs")), warned.join("\n"));
      const short = resolved({ EVEJS_LNE_HARVEST_RAID_ENABLED: "1", EVEJS_LNE_HARVEST_RAID_WALL_DEADLINE_MS: "3600000",
        EVEJS_LNE_HARVEST_RAID_RAID_MS: "3600000" }).warnings;
      assert.ok(short.some((w) => w.startsWith("harvestRaid.wallDeadlineMs 3600000 < warningMs + raidMs (5400000)")),
        short.join("\n"));
      const pv = resolved({ EVEJS_LNE_PLAYER_VALUE_ENABLED: "1", EVEJS_LNE_PLAYER_SOV_ENABLED: "0" }).warnings
        .find((w) => w.startsWith("playerValue.enabled with playerSov.enabled=false"));
      assert.ok(pv && !pv.endsWith("no effect") && pv.includes("playerSiege"), String(pv));
      assert.deepStrictEqual(MIGRATIONS.filter((m) => m.name === "harvest_raids").map((m) => m.version), [110]);
      assert.strictEqual(TABLE_POLICY.world_harvest_raids, ACTION.WIPE);
    });

  test("R5 vendor facts: Metenox bay 186 / group 427, grant into the bay, 81826 REFINERY, idempotent consume", () => {
    const metenox = readVendor("services/structure/metenoxHarvest.js");
    assert.match(metenox, /const GROUP_MOON_MATERIAL = 427;/);
    assert.match(metenox, /const FLAG_MOON_MATERIAL_BAY = 186;/);
    assert.ok(metenox.replace(/\s+/g, "").includes("grantItemToOwnerLocation(ownerID,structureID,FLAG_MOON_MATERIAL_BAY,"));
    assert.ok(metenox.includes("structure.ownerCorpID || structure.ownerID"), "owner of the bay items = ownerCorpID");
    assert.deepStrictEqual([HB.FLAG_MOON_MATERIAL_BAY, HB.GROUP_MOON_MATERIAL, HB.METENOX_TYPE_ID],
      [S.MOON_MATERIAL_BAY_FLAG, S.MOON_MATERIAL_GROUP, S.METENOX_TYPE_ID]);
    assert.deepStrictEqual([S.MOON_MATERIAL_BAY_FLAG, S.MOON_MATERIAL_GROUP, S.METENOX_TYPE_ID], [186, 427, 81826]);
    const constants = readVendor("services/structure/structureConstants.js");
    const at = constants.indexOf("  81826: {");
    assert.ok(at > 0);
    assert.match(constants.slice(at, at + 200), /family: STRUCTURE_FAMILY\.REFINERY,/);
    const items = readVendor("services/inventory/itemStore.js");
    const consume = items.indexOf("function consumeInventoryItemQuantityIdempotent(");
    assert.ok(consume > 0);
    const body = items.slice(consume, items.indexOf("\n}\n", consume));
    assert.ok(body.includes("executeIdempotentInventoryMutation(") && body.includes("\"consume-inventory-item-quantity\""));
    const exec = items.indexOf("function executeIdempotentInventoryMutation(");
    const execBody = items.slice(exec, items.indexOf("\n}\n", exec));
    assert.ok(execBody.indexOf("if (existingReceipt) {") > 0
      && execBody.indexOf("if (existingReceipt) {") < execBody.indexOf("mutationResult = executor(receipt);"),
    "the receipt is checked before the executor");
    assert.ok(execBody.includes("errorMsg: \"IDEMPOTENCY_RECEIPT_MISMATCH\""));
    const receipt = items.indexOf("function getIdempotentGrantReceipt(");
    const receiptBody = items.slice(receipt, items.indexOf("\n}\n", receipt));
    assert.ok(receiptBody.includes("found: Boolean(receipt),"));
    assert.ok(receiptBody.includes("if (uncertainty === \"write\" && options.reconcileWriteRefusal === true) {"));
    assert.ok(execBody.includes("uncertainIdempotentGrantReceipts.set(receiptKey, \"write\");"));
    for (const name of ["consumeInventoryItemQuantityIdempotent", "getIdempotentGrantReceipt", "listContainerItems",
      "findItemById"]) {
      assert.match(items.slice(items.indexOf("module.exports = {")), new RegExp(`\\n  ${name},\\n`), name);
    }
  });
};
