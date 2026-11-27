"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const config = require("../../config");
const S = require("../../lib/stations/harvestRaid/schema");
const { planRaidStart, decideRaidStep, skyhookWindowOf } = require("../../lib/stations/harvestRaid/machine");
const { planSkyhookLoss } = require("../../lib/stations/harvestRaid/lossPlan");
const { createHarvestRaidRepository } = require("../../lib/stations/harvestRaid/repository");
const { createHarvestRaidService } = require("../../lib/stations/harvestRaid/service");
const { startHarvestRaid } = require("../../lib/stations/harvestRaid");
const PS = require("../../lib/adapter/playerSkyhooks");
const { createJournal } = require("../../lib/persistence/journal");
const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
const { loadDriver, withStore } = require("../notices/storeHelper");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const T0 = 1760000000000;
const SYS = 30000001;
const FACTION = 500010;
const OWNER = 98000001;
const SKY = 1040001;
const GAS = 81143;
const OIL = 81144;
const MIN = 60000;

let base = null;
function baseConfig() {
  if (!base) {
    const r = config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir() } });
    assert.deepStrictEqual(r.errors || [], []);
    base = r.config;
  }
  return base;
}
function cfg(over = {}) {
  const c = baseConfig();
  return { ...c, harvestRaid: { ...c.harvestRaid, enabled: true, ...over }, notices: { ...c.notices, enabled: true } };
}
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function record(over = {}) {
  return { skyhookID: SKY, solarSystemID: SYS, corporationID: OWNER, active: true, destroyed: false, deployedItem: true,
    theftVulnerability: { startMs: T0 - 10 * MIN, endMs: T0 + 50 * MIN },
    raid: { schemaVersion: 1, generation: "g1", activeLink: null, pendingSettlement: null, closed: false },
    reagentSimulations: [{ reagentTypeID: GAS, securedStock: 400, unsecuredStock: 601, lastCycleMs: 0 },
      { reagentTypeID: OIL, securedStock: 9, unsecuredStock: 3, lastCycleMs: 0 }], ...over };
}

function fakeVendor(rec) {
  const box = { table: { skyhooks: { [String(SKY)]: rec } }, mutations: 0, projections: 0 };
  box.vendor = {
    sov: {
      listRaidSkyhooks: () => Object.values(box.table.skyhooks).filter((r) => r.deployedItem === true).map(clone),
      getRaidSkyhook: (id) => {
        const r = box.table.skyhooks[String(id)];
        return r && r.deployedItem === true ? clone(r) : null;
      },
      mutateSkyhookRaid: (id, mutation) => {
        box.mutations += 1;
        const working = clone(box.table);
        const r = working.skyhooks[String(id)];
        if (!r || !r.deployedItem) throw new Error("SKYHOOK_NOT_FOUND");
        const result = mutation(r);
        box.table = working;
        return result;
      },
    },
    harvest: { settleSkyhookHarvest: (r) => {
      box.projections += 1;
      return r;
    } },
    rules: { isWindowOpen: (r, nowMs) => Boolean(r && r.active && !r.destroyed && r.theftVulnerability
      && r.theftVulnerability.startMs <= nowMs && nowMs < r.theftVulnerability.endMs) },
    types: { resolveItemByTypeID: (t) => ({ [GAS]: { volume: 0.01 }, [OIL]: { volume: 1.5 } }[t] || null) },
  };
  box.rec = () => box.table.skyhooks[String(SKY)];
  return box;
}

const steal = (box, over = {}) => PS.stealSkyhookReagentsFrom(box.vendor, { skyhookId: SKY, raidId: "hr:skyhook:1:1",
  generation: "g1", lines: [{ typeId: GAS, units: 90 }], nowMs: T0, ...over }, { now: () => 0 });

function serverSrc() {
  const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
  assert.ok(found.ok, found.reason);
  return found.srcDir;
}
const readVendor = (rel) => fs.readFileSync(path.join(serverSrc(), rel), "utf8").replace(/\r\n/g, "\n");
const bodyOf = (text, head) => {
  const at = text.indexOf(head);
  assert.ok(at >= 0, head);
  const end = text.indexOf("\nfunction ", at + head.length);
  return text.slice(at, end < 0 ? text.length : end);
};

function countingSkyhooks(impl = {}) {
  const calls = [];
  const seam = new Proxy({}, { get(_t, k) {
    calls.push(String(k));
    return impl[k];
  } });
  return { seam, calls };
}

function view(over = {}) {
  return { skyhookId: SKY, systemId: SYS, corpId: OWNER, active: true, destroyed: false,
    window: { startMs: T0 + 30 * MIN, endMs: T0 + 90 * MIN }, windowOpen: false, raidState: "ready", generation: "g1",
    busy: false, unsecured: [{ typeId: GAS, units: 601, unitVolume: 0.01 }], ...over };
}

function fakeService(over, skyhooks, extra = {}) {
  const fleet = { fleetId: "f1", factionId: FACTION, fleetRole: "invasion", state: "STAGED", operationId: "op1",
    composition: [{ hullGroup: "cruiser", count: 5 }] };
  const op = { operationId: "op1", operationType: "harvest_raid", state: "ACTIVE", factionId: FACTION,
    targetSystemId: SYS };
  return createHarvestRaidService({ store: extra.store || { transaction: (_n, fn) => ({ ok: true,
    value: fn({ inTransaction: true }) }) },
  raids: extra.raids || { countOpen: () => ({ ok: true, count: 0 }), getLastByTarget: () => ({ ok: true, raid: null }),
    getLastOwnerStart: () => ({ ok: true, startedAt: null }) },
  scheduler: { enqueue: () => ({ ok: true }) },
  fleetRepository: { getFleet: () => ({ ok: true, fleet }), getOperation: () => ({ ok: true, operation: op }),
    listFleetsInSystem: () => ({ ok: true, fleets: [fleet] }) },
  registry: { isActive: () => true, getFaction: () => ({ kind: "pirate" }) },
  structures: { listCandidates: () => ({ ok: true, bySystem: new Map(), truncated: false }),
    readOwnerFace: () => ({ ok: true, npc: false, ceoId: 90000001 }) },
  bays: { readMetenoxBay: () => ({ ok: false, reason: "NOT_FOUND" }) }, skyhooks,
  readStanding: () => ({ ok: true, standing: -10 }), getVirtualCorps: () => ({ isVirtualCorporation: () => false }),
  getPlayerSiege: () => null, getNotices: () => ({ getStatus: () => ({ state: "running" }) }),
  ownerOnline: () => ({ online: true }), hostility: () => true, groups: {},
  getGraph: () => ({ ok: true, graph: { getSystem: () => ({ secClass: "nullsec" }) } }), config: cfg(over),
  clock: { now: extra.now || (() => T0) }, logger: { log() {} } });
}

module.exports = ({ test }) => {
  test("S1 planSkyhookLoss: floor permille, 0-lines dropped, 501 CONFIG_INVALID, maxPlanLines cuts", () => {
    const unsecured = [{ typeId: OIL, units: 3, unitVolume: 1.5 }, { typeId: GAS, units: 601, unitVolume: 0.01 }];
    const r = planSkyhookLoss({ unsecured, lossPermille: 150, maxPlanLines: 32 });
    assert.deepStrictEqual([r.ok, r.plan.map((l) => ({ ...l })), r.units], [true,
      [{ typeId: GAS, units: 90, unitVolume: 0.01 }], 90]);
    assert.deepStrictEqual(planSkyhookLoss({ unsecured, lossPermille: 501, maxPlanLines: 32 }),
      { ok: false, reason: "CONFIG_INVALID", detail: "lossPermille" });
    const cut = planSkyhookLoss({ unsecured: [{ typeId: 9, units: 100, unitVolume: 1 }, { typeId: 7, units: 100,
      unitVolume: 1 }, { typeId: 8, units: 100, unitVolume: 1 }], lossPermille: 500, maxPlanLines: 2 });
    assert.deepStrictEqual(cut.plan.map((l) => l.typeId), [7, 8]);
  });

  test("S2 stealSkyhookReagentsFrom: missing raid, BUSY, take + mark, replay, generation, window, 8 ids", () => {
    let box = fakeVendor(record({ raid: null }));
    let before = clone(box.rec());
    assert.deepStrictEqual(steal(box), { ok: false, reason: "SKYHOOK_RAID_STATE_MISSING", permanent: false,
      writeMs: 0 });
    assert.deepStrictEqual(box.rec(), before);
    for (const raidOver of [{ pendingSettlement: { settlementID: "s" } }, { activeLink: { characterID: 1 } }]) {
      box = fakeVendor(record({ raid: { ...record().raid, ...raidOver } }));
      before = clone(box.rec());
      const busy = steal(box);
      assert.deepStrictEqual([busy.ok, busy.reason, busy.permanent], [false, "SKYHOOK_BUSY", false]);
      assert.deepStrictEqual(box.rec(), before);
    }
    box = fakeVendor(record());
    const ok = steal(box, { lines: [{ typeId: GAS, units: 90 }, { typeId: OIL, units: 50 }] });
    assert.deepStrictEqual(ok, { ok: true, duplicate: false, taken: [{ typeId: GAS, units: 90 },
      { typeId: OIL, units: 3 }], writeMs: 0 });
    const sims = box.rec().reagentSimulations;
    assert.deepStrictEqual(sims.map((s) => [s.unsecuredStock, s.securedStock]), [[511, 400], [0, 9]]);
    assert.ok(box.rec().raid.lneTheft.ids.includes("hr:skyhook:1:1"));
    assert.strictEqual(box.projections, 1, "the harvest projection inside the mutation");
    box.table.skyhooks[String(SKY)].raid.activeLink = { characterID: 1 };
    const again = steal(box);
    assert.deepStrictEqual([again.ok, again.duplicate, again.taken], [true, true, [{ typeId: GAS, units: 90 },
      { typeId: OIL, units: 3 }]]);
    assert.deepStrictEqual(box.rec().reagentSimulations.map((s) => s.unsecuredStock), [511, 0]);
    assert.deepStrictEqual(PS.readSkyhookTheftFrom(box.vendor, { skyhookId: SKY, raidId: "hr:skyhook:1:1" }),
      { ok: true, found: true, taken: [{ typeId: GAS, units: 90 }, { typeId: OIL, units: 3 }] });
    box = fakeVendor(record());
    before = clone(box.rec());
    const gen = steal(box, { generation: "g0" });
    assert.deepStrictEqual([gen.reason, gen.permanent], ["SKYHOOK_GENERATION_CHANGED", true]);
    const closed = steal(box, { nowMs: T0 + 50 * MIN });
    assert.deepStrictEqual([closed.reason, closed.permanent], ["SKYHOOK_WINDOW_CLOSED", true]);
    assert.deepStrictEqual(box.rec(), before);
    for (let i = 1; i <= 9; i += 1) {
      assert.strictEqual(steal(box, { raidId: `r${i}`, lines: [{ typeId: GAS, units: 1 }] }).ok, true);
    }
    assert.deepStrictEqual(box.rec().raid.lneTheft.ids, ["r2", "r3", "r4", "r5", "r6", "r7", "r8", "r9"]);
    assert.ok(box.rec().reagentSimulations.every((s, i) => s.securedStock >= before.reagentSimulations[i].securedStock));
  });

  test("S3 machine (window, lead, busy, imminent, closed, inactive) + service SETTLE BUSY -> deferUntil -> SETTLED []",
    () => {
      const C = cfg().harvestRaid;
      const params = { targetCooldownMs: C.targetCooldownMs, ownerCooldownMs: C.ownerCooldownMs, maxOpen: C.maxOpen,
        maxOpenPerFaction: C.maxOpenPerFaction, minLootVolumeM3: C.minLootVolumeM3, wallDeadlineMs: C.wallDeadlineMs,
        warningMs: C.warningMs, sampleMs: C.sampleMs, raidMs: C.raidMs, skyhookMinLootUnits: C.skyhookMinLootUnits };
      const input = (sk, over = {}) => ({ at: T0, secClass: "nullsec", secClasses: ["nullsec"],
        operation: { operationId: "op1", factionId: FACTION, operationType: "harvest_raid", state: "ACTIVE",
          targetSystemId: SYS },
        target: { kind: "skyhook", structureId: SKY, systemId: SYS, ownerCorpId: OWNER, destroyed: false,
          active: sk.active, raidState: sk.raidState, busy: sk.busy, virtualOwner: false },
        window: skyhookWindowOf(sk, T0, C.skyhookLaunchLeadMs), hostile: true, ownerOnline: true, siegeOpen: false,
        openOnTarget: false, lastTargetEndedAt: null, lastOwnerStartedAt: null, openTotal: 0, openByFaction: 0,
        attackerShips: 5, lootUnits: 90, lootVolumeM3: 0.9, params, ...over });
      const open = planRaidStart(input(view({ windowOpen: true, window: { startMs: T0 - MIN, endMs: T0 + 59 * MIN } })));
      assert.deepStrictEqual([open.start.targetKind, open.start.raidId], ["skyhook", `hr:skyhook:${SKY}:${T0}`]);
      const lead = C.skyhookLaunchLeadMs;
      assert.ok(planRaidStart(input(view({ window: { startMs: T0 + lead, endMs: T0 + lead + 60 * MIN } }))).start);
      assert.deepStrictEqual(planRaidStart(input(view({ window: { startMs: T0 + lead + 1, endMs: T0 + lead + 61 * MIN } }))),
        { start: null, reason: "WINDOW" });
      assert.deepStrictEqual(planRaidStart(input(view({ busy: true }))), { start: null, reason: "VENDOR_BUSY" });

      const raid = { state: S.RAIDING, targetKind: "skyhook", creditedMs: 0, lastSampleAt: T0,
        wallDeadlineAt: T0 + C.wallDeadlineMs, ownerCorpId: OWNER };
      const facts = (window, target = { destroyed: false, ownerCorpId: OWNER, active: true }) => ({ at: T0 + C.sampleMs,
        ownerOnline: true, attackerShips: 5, engaged: false, target, siegeOpen: false, window, params });
      const wait = decideRaidStep(raid, facts({ open: false, imminent: true }));
      assert.deepStrictEqual([wait.action, wait.creditedMs, wait.credited], ["SAMPLE", 0, false]);
      assert.deepStrictEqual(decideRaidStep(raid, facts({ open: false, imminent: false })),
        { action: "END", to: S.EXPIRED, reason: "WINDOW_CLOSED" });
      assert.deepStrictEqual(decideRaidStep(raid, facts({ open: true, imminent: false }, { destroyed: false,
        ownerCorpId: OWNER, active: false })), { action: "END", to: S.ABORTED, reason: "TARGET_INACTIVE" });

      const loaded = loadDriver();
      assert.ok(loaded.ok, loaded.detail);
      withStore(loaded, (opened) => {
        const store = opened.store;
        const raids = createHarvestRaidRepository({ journal: createJournal({ clock: { now: () => T0 },
          maxPayloadBytes: 4096, maxRows: 500 }) });
        const raidId = `hr:skyhook:${SKY}:${T0}`;
        const plan = { generation: "g1", lines: [{ typeId: GAS, units: 90, unitVolume: 0.01 }] };
        const made = store.transaction("test.sky", (db) => {
          raids.createRaid(db, { raidId, targetKind: "skyhook", targetId: SKY, systemId: SYS, ownerCorpId: OWNER,
            attackerFactionId: FACTION, operationId: null, at: T0, wallDeadlineAt: T0 + 1 });
          let row = raids.getRaid(db, raidId).raid;
          row = raids.transition(db, { raid: row, to: S.RAIDING, at: T0, patch: { creditedMs: 0 } }).raid;
          return raids.transition(db, { raid: row, to: S.SETTLING, at: T0, patch: { planJson: JSON.stringify(plan) } });
        });
        assert.ok(made.ok && made.value.ok, JSON.stringify(made));
        let clock = T0;
        const sk = { steal: 0, theft: 0 };
        const skyhooks = { stealSkyhookReagents: () => {
          sk.steal += 1;
          return { ok: false, reason: "SKYHOOK_BUSY", permanent: false, writeMs: 3 };
        }, readSkyhookTheft: () => {
          sk.theft += 1;
          return { ok: true, found: false, taken: null };
        } };
        const svc = fakeService({ skyhookEnabled: true }, skyhooks, { store, raids, now: () => clock });
        const ev = { payload: { raidId }, dueAt: T0, idempotencyKey: S.settleKey(raidId) };
        const early = svc.onSettle(ev);
        assert.deepStrictEqual([early.ok, early.reason, early.deferUntil <= T0 + C.settleWallMs],
          [false, "HARVEST_RAID_VENDOR_UNCERTAIN", true]);
        clock = T0 + C.settleWallMs;
        const late = svc.onSettle(ev);
        assert.strictEqual(typeof late.effect, "function", JSON.stringify(late));
        const t = store.transaction("test.settle", (db) => late.effect(db, ev));
        assert.ok(t.ok && t.value.ok, JSON.stringify(t));
        late.onCommitted(t.value);
        const row = store.transaction("test.read", (db) => raids.getRaid(db, raidId)).value.raid;
        assert.deepStrictEqual([row.state, row.loss, row.endReason], [S.SETTLED, [], "NOTHING_TAKEN"]);
        assert.deepStrictEqual([sk.steal, sk.theft], [2, 1], "after settleWallMs only the mark decides");
        assert.ok(svc.getStatus().counters.skyhookBusy > 0);
      });
    });

  test("S4 vendor facts: raid survives normalize, mutateTable clone + throw, flush, initializeRecord, window, "
    + "SEAM_METHODS = facade", () => {
    const sov = readVendor("services/sovereignty/sovModernState.js");
    assert.ok(bodyOf(sov, "function normalizeSkyhookRecord(").includes("raid: cloneValue(value.raid || null),"));
    const mt = bodyOf(sov, "function mutateTable(mutator) {");
    assert.ok(mt.indexOf("mutator(workingTable)") > 0
      && mt.indexOf("mutator(workingTable)") < mt.indexOf("writeSovereigntyTable(workingTable)"));
    assert.ok(mt.includes("mergeSovereigntyTableDefaults(table)")
      && !mt.slice(0, mt.indexOf("writeSovereigntyTable(workingTable)")).includes("try {"));
    const ms = bodyOf(sov, "function mutateSkyhookRaid(skyhookID, mutation) {");
    assert.ok(ms.includes("database.flushTableSync(\"sovereignty\")") && ms.includes("SKYHOOK_RAID_NOT_DURABLE")
      && ms.includes("throw new Error(\"SKYHOOK_NOT_FOUND\")"));
    for (const name of ["listRaidSkyhooks", "getRaidSkyhook", "mutateSkyhookRaid"]) {
      assert.match(sov.slice(sov.lastIndexOf("module.exports")), new RegExp(`\\n {2}${name},\\n`), name);
    }
    const runtime = readVendor("services/sovereignty/skyhookRaidRuntime.js");
    assert.strictEqual(runtime.split("next.raid = {").length, 2, "next.raid = { exactly once");
    const init = bodyOf(runtime, "function initializeRecord(record) {");
    assert.ok(init.includes("next.raid = { schemaVersion: 1, generation,"));
    assert.ok(bodyOf(runtime, "function settleRaidReceipt(").includes("SKYHOOK_RESERVED_STOCK_CHANGED"));
    const rules = readVendor("services/sovereignty/skyhookRaidRules.js");
    assert.ok(rules.includes("const RAID_WINDOW_MS = 3600000;") && rules.includes("const SKYHOOK_TYPE_ID = 81080;"));
    assert.deepStrictEqual([S.SKYHOOK_RAID_WINDOW_MS, S.SKYHOOK_TYPE_ID, S.MAX_THEFT_IDS], [3600000, 81080,
      PS.MAX_THEFT_IDS]);
    assert.match(bodyOf(rules, "function isWindowOpen(record, nowMs) {"), /window\.startMs <= nowMs && nowMs < window\.endMs/);
    const harvest = readVendor("services/sovereignty/skyhookHarvest.js");
    assert.ok(harvest.includes("function settleSkyhookHarvest(skyhook, nowMs = getWallclockNowMs()) {"));
    const store = readVendor("services/sovereignty/sovStore.js");
    assert.ok(bodyOf(store, "function mergeSovereigntyTableDefaults(").includes("cloneValue(value)"));
    const facade = PS.createPlayerSkyhookSeam({ requireGame: () => ({ ok: false }) });
    assert.deepStrictEqual(Object.keys(facade).sort(), [...PS.SEAM_METHODS].sort());
    assert.strictEqual(facade.checkRaidSeams().reason, "HARVEST_RAID_SKYHOOK_SEAM_UNAVAILABLE");
  });

  test("S5 skyhookEnabled=false: 0 calls of playerSkyhooks; true + imminent -> skyhook target; seam refused -> "
    + "status off:, Metenox runs", () => {
    const tx = Object.freeze({ inTransaction: true });
    const off = countingSkyhooks();
    const svcOff = fakeService({ skyhookEnabled: false, metenoxEnabled: true }, off.seam);
    svcOff.onArrival(tx, { state: "STAGED", fleetRole: "invasion", systemId: SYS, fleetId: "f1", at: T0, legSeq: 1 });
    svcOff.onCheck({ payload: { systemId: SYS, at: T0, triggerFleetId: "f1" }, dueAt: T0 });
    svcOff.readTargetsForFaction(tx, FACTION, { systems: [SYS], at: T0 });
    assert.deepStrictEqual(off.calls, []);
    assert.strictEqual(svcOff.getStatus().skyhook, "disabled");
    let touched = 0;
    const calls = { handlers: 0 };
    const deps = (over) => ({ config: cfg(over), clock: { now: () => T0 },
      persistence: { ok: true, store: {}, journal: { applyOnce() {} } },
      scheduler: { getStatus: () => ({ state: "ready" }), registerHandler: () => {
        calls.handlers += 1;
        return { ok: true, unregister() {} };
      }, enqueue() {}, enqueueMany() {}, findByKey() {} },
      fleets: { repository: { listFleetsInSystem() {}, getFleet() {}, getOperation() {} },
        travel: { addArrivalListener: () => ({ ok: true, remove() {} }) } },
      strategy: { registry: { isActive() {}, getFaction() {} } },
      adapter: { harvestBays: { checkSeams: () => ({ ok: true }) }, playerStructures: { listCandidates() {} },
        playerStructureSeams: () => ({ ok: true }),
        get playerSkyhooks() {
          touched += 1;
          return PS.createPlayerSkyhookSeam({ requireGame: () => ({ ok: true, exports: {} }),
            disabledReason: (c) => (c === PS.RAID_CONSUMER ? "DRIFT mutateSkyhookRaid" : null) });
        } }, logger: { log() {} } });
    const r0 = startHarvestRaid(deps({ skyhookEnabled: false }));
    assert.deepStrictEqual([r0.ok, touched], [true, 0], JSON.stringify(r0));
    r0.harvestRaid.stop();
    const r1 = startHarvestRaid(deps({ skyhookEnabled: true }));
    assert.strictEqual(r1.ok, true, JSON.stringify(r1));
    assert.match(r1.harvestRaid.getStatus().skyhook, /^off:DRIFT mutateSkyhookRaid/);
    assert.strictEqual(calls.handlers, 6, "both starts register the three handlers");
    r1.harvestRaid.stop();
    const on = countingSkyhooks({
      listPlayerSkyhooks: () => ({ ok: true, truncated: false, skyhooks: [{ skyhookId: SKY, systemId: SYS,
        corpId: OWNER, active: true, destroyed: false }] }),
      readSkyhook: () => ({ ok: true, skyhook: view() }) });
    const svcOn = fakeService({ skyhookEnabled: true }, on.seam);
    const t = svcOn.readTargetsForFaction(tx, FACTION, { systems: [SYS], at: T0 });
    assert.deepStrictEqual([t.ok, t.targets.map((x) => [x.targetKind, x.targetId, x.systemId, x.ownerCorpId])],
      [true, [["skyhook", SKY, SYS, OWNER]]], JSON.stringify(t));
    assert.ok(Math.abs(t.targets[0].lootVolumeM3 - 0.9) < 1e-9);
    assert.strictEqual(svcOn.getStatus().skyhook, "on");
  });
};
