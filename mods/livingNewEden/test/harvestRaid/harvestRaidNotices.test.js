"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const config = require("../../config");
const HS = require("../../lib/stations/harvestRaid/schema");
const { startHarvestRaid } = require("../../lib/stations/harvestRaid");
const { createHarvestRaidService } = require("../../lib/stations/harvestRaid/service");
const { classifyEntries, harvestRaidLossTypeIds, KIND } = require("../../lib/notices/sources");
const { createTail, kindsOf } = require("../../lib/notices/tail");
const { formatNoticeLine } = require("../../lib/notices/format");
const { createNoticeRepository } = require("../../lib/notices/repository");
const NS = require("../../lib/notices/schema");
const HB = require("../../lib/adapter/harvestBays");
const { buildSiegesLayerView, mergeRaidItems, RAID_LEGEND } = require("../../lib/stations/siege/siegesLayer");
const { GROUPS: STRENGTH_GROUPS } = require("../../lib/battle/data/strengthCatalog");
const { expandStrengthGroups } = require("../../lib/battle/strength");
const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
const { loadDriver, withStore } = require("../notices/storeHelper");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const T0 = 1760000000000;
const SYS = 30000001;
const CORP = 98000001;
const FACTION = 500010;
const RAID = `hr:metenox:9001:${T0}`;
const MAT_A = 16634;
const MAT_B = 16635;
const SENDER = 140000004;

function resolved(env = {}) {
  return config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(), ...env } });
}
let base = null;
function baseConfig() {
  if (!base) base = resolved().config;
  return base;
}
const noticesSettings = () => ({ ...baseConfig().notices, enabled: true });

function hraidEntry(journalId, eventType, payload) {
  return { journalId, aggregateType: HS.AGGREGATE, aggregateId: RAID, eventType, createdAt: T0, key: `k${journalId}`,
    payload };
}
const WARNED = { raidId: RAID, targetKind: "metenox", targetId: 9001, systemId: SYS, ownerCorpId: CORP,
  attackerFactionId: FACTION, operationId: "op1", wallDeadlineAt: T0 + 21600000 };
const tr = (from, to, endReason, extra = {}) => ({ raidId: RAID, targetKind: "metenox", targetId: 9001, systemId: SYS,
  ownerCorpId: CORP, attackerFactionId: FACTION, from, to, endReason, ...extra });

function fakeStore(calls) {
  return Object.freeze({
    isOpen: () => true,
    limits: Object.freeze({ maxRowsPerTransaction: 500 }),
    transaction: (_name, fn) => {
      if (calls) calls.tx += 1;
      try {
        return { ok: true, value: fn(Object.freeze({ inTransaction: true })) };
      } catch (error) {
        return { ok: false, reason: "TX_FAILED", error };
      }
    },
  });
}

function serverSrc() {
  const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
  assert.ok(found.ok, found.reason);
  return found.srcDir;
}

module.exports = ({ test, skip }) => {
  test("N1 sources: WARNED / end rows -> 2 raid kinds, middle transitions none, BAD_PAYLOAD, KIND_OFF; tail names", () => {
    const s = noticesSettings();
    const kinds = kindsOf(s);
    assert.ok(kinds.has(KIND.HARVEST_RAID_WARNED) && kinds.has(KIND.HARVEST_RAID_ENDED));
    const off = kindsOf({ ...s, kindHarvestRaid: false });
    assert.ok(!off.has(KIND.HARVEST_RAID_WARNED) && !off.has(KIND.HARVEST_RAID_ENDED));
    const entries = [
      hraidEntry(1, HS.EVENT_WARNED, WARNED),
      hraidEntry(2, HS.EVENT_TRANSITION, tr("WARNED", "RAIDING", null)),
      hraidEntry(3, HS.EVENT_TRANSITION, tr("RAIDING", "SETTLING", null)),
      hraidEntry(4, HS.EVENT_SETTLED, tr("SETTLING", "SETTLED", "TAKEN", { loss: [{ typeId: MAT_A, units: 300 },
        { typeId: MAT_B, units: 0 }, { typeId: MAT_B, units: 20 }] })),
      hraidEntry(5, HS.EVENT_TRANSITION, tr("WARNED", "REPELLED", "NO_HOLD")),
      hraidEntry(6, HS.EVENT_TRANSITION, tr("RAIDING", "EXPIRED", "WALL_DEADLINE")),
      hraidEntry(7, HS.EVENT_TRANSITION, tr("WARNED", "ABORTED", "TARGET_DESTROYED")),
    ];
    const ctx = { now: T0, maxEventAgeMs: s.maxEventAgeMs, kinds, harvestLeadMs: 3600000,
      typeNames: new Map([[MAT_A, "Cobaltite"]]) };
    const r = classifyEntries(entries, new Map(), ctx);
    assert.deepStrictEqual(r.skipped, {});
    assert.deepStrictEqual(r.events.map((e) => [e.eventKey, e.kind, e.systemId, e.ownerCorpId, e.attacker, e.targetKind,
      e.outcome, e.endReason]), [
      ["j:1:HARVEST_RAID_WARNED", "HARVEST_RAID_WARNED", SYS, CORP, FACTION, "metenox", undefined, undefined],
      ["j:4:HARVEST_RAID_ENDED", "HARVEST_RAID_ENDED", SYS, CORP, FACTION, "metenox", "SETTLED", "TAKEN"],
      ["j:5:HARVEST_RAID_ENDED", "HARVEST_RAID_ENDED", SYS, CORP, FACTION, "metenox", "REPELLED", "NO_HOLD"],
      ["j:6:HARVEST_RAID_ENDED", "HARVEST_RAID_ENDED", SYS, CORP, FACTION, "metenox", "EXPIRED", "WALL_DEADLINE"],
      ["j:7:HARVEST_RAID_ENDED", "HARVEST_RAID_ENDED", SYS, CORP, FACTION, "metenox", "ABORTED", "TARGET_DESTROYED"],
    ]);
    assert.deepStrictEqual([r.events[0].leadMs, r.events[0].wallDeadlineAt], [3600000, WARNED.wallDeadlineAt]);
    assert.deepStrictEqual(r.events[1].loss, [{ typeId: MAT_A, units: 300, name: "Cobaltite" },
      { typeId: MAT_B, units: 20, name: null }]);
    assert.deepStrictEqual(r.events[2].loss, []);
    const bad = classifyEntries([
      hraidEntry(11, HS.EVENT_WARNED, { ...WARNED, ownerCorpId: null }),
      hraidEntry(12, HS.EVENT_WARNED, { ...WARNED, targetKind: "tower" }),
      hraidEntry(13, HS.EVENT_SETTLED, tr("SETTLING", "SETTLED", "TAKEN", { loss: "x" })),
    ], new Map(), ctx);
    assert.deepStrictEqual([bad.events.length, bad.skipped], [0, { BAD_PAYLOAD: 3 }]);
    const kindOff = classifyEntries(entries.slice(0, 1), new Map(), { ...ctx, kinds: off });
    assert.deepStrictEqual([kindOff.events.length, kindOff.skipped], [0, { KIND_OFF: 1 }]);
    assert.deepStrictEqual(harvestRaidLossTypeIds(entries, 32), [MAT_A, MAT_B]);
    assert.deepStrictEqual(harvestRaidLossTypeIds(entries, 1), [MAT_A]);

    let head = 0;
    const journal = Object.freeze({
      headId: () => ({ ok: true, headId: head }),
      listAfter: (_db, o) => ({ ok: true, scannedUpTo: o.uptoId,
        entries: entries.filter((e) => e.journalId > o.afterId && e.journalId <= o.uptoId) }),
    });
    const queued = [];
    const nameCalls = [];
    const tail = createTail({ store: fakeStore(), journal, repo: Object.freeze({}), settings: s,
      enqueue: (_db, items) => {
        queued.push(...items);
        return { ok: true, inserted: items.length, duplicates: 0 };
      },
      getWorldRepository: () => Object.freeze({ listSystems: () => ({ ok: true, systems: [], nextAfterSystemId: null }) }),
      getPresence: () => null, getGraph: () => null, listLimit: 500,
      harvestSettings: { warningMs: 1800000, raidMs: 1800000 },
      adapter: Object.freeze({
        playerStructures: Object.freeze({ listOwnerMemberIds: (corpId) => ({ ok: true, characterIds: corpId === CORP
          ? [90000001] : [], truncated: false }) }),
        harvestBays: Object.freeze({ readTypeNames: (spec) => {
          nameCalls.push(spec.typeIds);
          return { ok: true, names: new Map([[MAT_B, "Zeolites"]]) };
        } }) }) });
    assert.ok(tail.bootstrap().ok);
    head = 7;
    const pass = tail.runPass(T0);
    assert.strictEqual(pass.ok, true, JSON.stringify(pass));
    assert.deepStrictEqual(nameCalls, [[MAT_A, MAT_B]]);
    assert.deepStrictEqual(queued.map((i) => [i.eventKey, i.characterId, i.kind]), [
      ["j:1:HARVEST_RAID_WARNED", 90000001, "HARVEST_RAID_WARNED"],
      ["j:4:HARVEST_RAID_ENDED", 90000001, "HARVEST_RAID_ENDED"],
      ["j:5:HARVEST_RAID_ENDED", 90000001, "HARVEST_RAID_ENDED"],
      ["j:6:HARVEST_RAID_ENDED", 90000001, "HARVEST_RAID_ENDED"],
      ["j:7:HARVEST_RAID_ENDED", 90000001, "HARVEST_RAID_ENDED"]]);
    assert.ok(queued[0].line.includes("In about 60 minutes of online time"), queued[0].line);
    assert.ok(queued[1].line.endsWith("took moon material x 300, Zeolites x 20."), queued[1].line);
  });

  test("N2 format: warning (60 min / Soon), 4 outcomes, unknown reason, 8 loss types -> 6 + 2 more; ASCII <= 400", () => {
    const opts = { systemName: "Tama", regionName: "The Citadel", names: new Map([[FACTION, "Guristas Pirates"]]) };
    const ev = (extra) => ({ systemId: SYS, at: T0, attacker: FACTION, defender: null, ownerCorpId: CORP,
      targetKind: "metenox", ...extra });
    const head = "[08:53 UTC] Raid over in Tama (The Citadel): your Metenox Moon Drill - ";
    const lines = [];
    const fmt = (extra) => {
      const line = formatNoticeLine(ev(extra), opts);
      lines.push(line);
      return line;
    };
    assert.strictEqual(fmt({ kind: "HARVEST_RAID_WARNED", leadMs: 3600000 }),
      "[08:53 UTC] Raid warning: Guristas Pirates raiders are at your Metenox Moon Drill in Tama (The Citadel). In "
      + "about 60 minutes of online time they take part of the moon material. The time counts only while a member of "
      + "your corporation is online. To stop it: move the moon material out of the structure, or destroy their fleet.");
    assert.ok(fmt({ kind: "HARVEST_RAID_WARNED", leadMs: null }).includes("(The Citadel). Soon they take part of the "
      + "moon material. The time"));
    assert.strictEqual(fmt({ kind: "HARVEST_RAID_ENDED", outcome: "REPELLED", endReason: "NO_HOLD", loss: [] }),
      `${head}the Guristas Pirates raiders left or were destroyed. Nothing was taken.`);
    assert.strictEqual(fmt({ kind: "HARVEST_RAID_ENDED", outcome: "EXPIRED", endReason: "WALL_DEADLINE", loss: [] }),
      `${head}the Guristas Pirates raiders ran out of time. Nothing was taken.`);
    assert.strictEqual(fmt({ kind: "HARVEST_RAID_ENDED", outcome: "ABORTED", endReason: "TARGET_DESTROYED", loss: [] }),
      `${head}the raid was called off (the structure was destroyed). Nothing was taken.`);
    assert.strictEqual(fmt({ kind: "HARVEST_RAID_ENDED", outcome: "ABORTED", endReason: "ODD_CODE", loss: [] }),
      `${head}the raid was called off (ODD_CODE). Nothing was taken.`);
    assert.strictEqual(fmt({ kind: "HARVEST_RAID_ENDED", outcome: "SETTLED", endReason: "NOTHING_TAKEN", loss: [] }),
      `${head}nothing was taken (the moon material was moved out).`);
    const loss = Array.from({ length: 8 }, (_, i) => ({ typeId: 100 + i, units: 10 * (i + 1),
      name: i === 7 ? null : `Ore ${i}` }));
    assert.strictEqual(fmt({ kind: "HARVEST_RAID_ENDED", outcome: "SETTLED", endReason: "TAKEN", loss }),
      `${head}Guristas Pirates took moon material x 80, Ore 6 x 70, Ore 5 x 60, Ore 4 x 50, Ore 3 x 40, Ore 2 x 30 and `
      + "2 more types.");
    fmt({ kind: "HARVEST_RAID_WARNED", leadMs: 3600000, targetKind: "skyhook" });
    for (const line of lines) {
      assert.ok(line.length <= 400 && /^[\x20-\x7E]*$/.test(line), line);
    }
  });

  const driver = loadDriver();
  if (!driver.ok) skip("N1b raid warning priority path", `better-sqlite3 unavailable (${driver.detail})`);
  else test("N1b priority path: the default priorityKinds makes a raid warning due after priorityMinIntervalMs", () => {
    const s = resolved({ EVEJS_LNE_NOTICES_ENABLED: "1" }).config.notices;
    const priorityKinds = NS.parsePriorityKinds(s.priorityKinds);
    assert.ok(priorityKinds.includes("HARVEST_RAID_WARNED"), s.priorityKinds);
    withStore(driver, (opened) => {
      const repo = createNoticeRepository();
      const tx = (fn) => {
        const r = opened.store.transaction("test", fn);
        assert.ok(r.ok, JSON.stringify(r));
        return r.value;
      };
      const [A, B] = [91000001, 91000002];
      const item = (key, characterId, kind) => ({ eventKey: key, characterId, kind, systemId: SYS, line: `line ${key}`,
        eventAt: T0 });
      const now = T0 + 3600000;
      const render = (l) => ({ title: `T${l.length}`, body: l.join("<br>") });
      assert.ok(tx((db) => repo.enqueueItemsInTx(db, [item("a0", A, "ATTACK_STARTED"), item("b0", B,
        "ATTACK_STARTED")], T0)).ok);
      for (const c of [A, B]) {
        tx((db) => {
          const o = repo.openBatchInTx(db, { characterId: c, senderId: SENDER, now: now - 300000, maxItems: 10, render });
          assert.ok(o.ok && o.batch, JSON.stringify(o));
          assert.ok(repo.finishBatchInTx(db, o.batch.batchKey, { outcome: "SENT", now: now - 300000, maxAttempts: 3 }).ok);
          return o;
        });
      }
      assert.ok(tx((db) => repo.enqueueItemsInTx(db, [item("a-warn", A, KIND.HARVEST_RAID_WARNED),
        item("b-end", B, KIND.HARVEST_RAID_ENDED)], T0)).ok);
      const due = tx((db) => repo.listDueCharactersInTx(db, { now, minMailIntervalMs: s.minMailIntervalMs, limit: 5,
        priorityKinds, priorityMinIntervalMs: s.priorityMinIntervalMs }));
      assert.ok(due.ok, JSON.stringify(due));
      assert.deepStrictEqual(due.characterIds, [A], "the warning after 60 s, the end line waits 15 min");
    });
  });

  test("N3a W158: dependency_disabled:notices (3 ways), both config texts; CHECK with notices off = no row", () => {
    const c = baseConfig();
    const on = { ...c, harvestRaid: { ...c.harvestRaid, enabled: true }, notices: { ...c.notices, enabled: true } };
    const deps = (cfg) => ({ config: cfg, clock: { now: () => T0 },
      persistence: { ok: true, store: {}, journal: { applyOnce() {} } }, scheduler: null });
    for (const cfg of [{ ...on, notices: { ...on.notices, enabled: false } },
      { ...on, notices: { ...on.notices, kindHarvestRaid: false } },
      { ...on, modules: { ...on.modules, world: { ...on.modules.world, enabled: false } } }]) {
      assert.deepStrictEqual(startHarvestRaid(deps(cfg)), { ok: false, reason: "dependency_disabled:notices" });
    }
    assert.strictEqual(startHarvestRaid(deps(on)).reason, "SCHEDULER_UNAVAILABLE");
    const W1 = "harvestRaid.enabled without the raid warning mail (notices.enabled / notices.kindHarvestRaid / "
      + "modules.world) - the raid module does not start";
    const W2 = "harvestRaid.enabled with HARVEST_RAID_WARNED not in notices.priorityKinds";
    const noMail = resolved({ EVEJS_LNE_HARVEST_RAID_ENABLED: "1" }).warnings;
    assert.ok(noMail.includes(W1), noMail.join("\n"));
    const kindOff = resolved({ EVEJS_LNE_HARVEST_RAID_ENABLED: "1", EVEJS_LNE_NOTICES_ENABLED: "1",
      EVEJS_LNE_NOTICES_KIND_HARVEST_RAID: "0" }).warnings;
    assert.ok(kindOff.includes(W1), kindOff.join("\n"));
    const slow = resolved({ EVEJS_LNE_HARVEST_RAID_ENABLED: "1", EVEJS_LNE_NOTICES_ENABLED: "1",
      EVEJS_LNE_NOTICES_PRIORITY_KINDS: "BATTLE_ETA" }).warnings;
    assert.ok(slow.some((w) => w.startsWith(W2)) && !slow.includes(W1), slow.join("\n"));
    const fine = resolved({ EVEJS_LNE_HARVEST_RAID_ENABLED: "1", EVEJS_LNE_NOTICES_ENABLED: "1" }).warnings;
    assert.ok(!fine.some((w) => w.includes("raid warning")), fine.join("\n"));

    const run = (state) => {
      const calls = { tx: 0, index: 0 };
      const svc = createHarvestRaidService({ store: fakeStore(calls), raids: {}, scheduler: {}, fleetRepository: {},
        registry: { isActive: () => true, getFaction: () => ({ kind: "pirate" }) },
        structures: { listCandidates: () => {
          calls.index += 1;
          return { ok: true, bySystem: new Map() };
        } },
        bays: {}, readStanding: null, getVirtualCorps: () => null, getPlayerSiege: () => null,
        getNotices: state === null ? undefined : () => ({ getStatus: () => ({ state }) }),
        ownerOnline: () => ({ online: true }), hostility: () => true, groups: expandStrengthGroups(STRENGTH_GROUPS,
          null, null), getGraph: () => ({ ok: true, graph: { getSystem: () => ({ secClass: "nullsec" }) } }),
        config: on, clock: { now: () => T0 }, logger: { log() {} } });
      const r = svc.onCheck({ payload: { systemId: SYS, at: T0, triggerFleetId: "f1" }, dueAt: T0,
        idempotencyKey: HS.arrivalCheckKey(SYS, "f1", 1) });
      assert.ok(r.ok === true && typeof r.effect !== "function", JSON.stringify(r));
      r.onCommitted(undefined);
      return { r, calls, counters: svc.getStatus().counters };
    };
    for (const state of ["unavailable", null]) {
      const got = run(state);
      assert.deepStrictEqual([got.r.outcome, got.calls, got.counters.noticesOff, got.counters.checks],
        ["NOTICES_OFF", { tx: 0, index: 0 }, 1, 1], String(state));
    }
    const running = run("running");
    assert.deepStrictEqual([running.r.outcome, running.calls.index, running.counters.noticesOff],
      ["NO_TARGET", 1, 0]);
  });

  test("N3b layer-sieges: hraid marks and tooltip lines, RAID_LEGEND + raids[].kind; off / throw = the old data", () => {
    const raid = (id, systemId, state, wallDeadlineAt) => ({ raidId: id, systemId, targetKind: "metenox",
      ownerCorpId: CORP, attackerFactionId: FACTION, state, creditedMs: 0, wallDeadlineAt });
    const siegeItem = [SYS, "siege-timer", "1v2", ["s1 - ARMOR TIMER - A 1 -> O 2 - 2h"], [[1, 1], [2, 1]], "dashed"];
    const merged = mergeRaidItems([siegeItem], [raid("r1", SYS, "RAIDING", T0 + 3600000),
      raid("r2", SYS + 1, "WARNED", T0 + 5400000), raid("r3", SYS + 2, "SETTLING", T0)], 6, T0);
    assert.deepStrictEqual(merged, [
      [SYS, "siege-timer", "1v2", ["s1 - ARMOR TIMER - A 1 -> O 2 - 2h",
        `r1 - raid RAIDING - A ${FACTION} -> corp ${CORP} (metenox) - 1h left`], [[1, 1], [2, 1]], "dashed"],
      [SYS + 1, "hraid-warned", `${FACTION}v raid`, [`r2 - raid WARNED - A ${FACTION} -> corp ${CORP} (metenox) - 2h left`],
        [[FACTION, 1]], "dashed"],
      [SYS + 2, "hraid-raiding", `${FACTION}v raid`, [`r3 - raid SETTLING - A ${FACTION} -> corp ${CORP} (metenox) - 0h left`],
        [[FACTION, 1]], "solid"],
    ]);
    assert.deepStrictEqual(siegeItem[3].length, 1, "the input item is not changed");

    const station = Object.freeze([Object.freeze({ siegeId: "s1", systemId: SYS, state: "ARMOR_TIMER",
      phaseEndsAt: T0 + 7200000, attackerFactionId: 1, ownerFactionId: 2 })]);
    const repository = Object.freeze({ listOpen: (_db, o) => ({ ok: true, sieges: station.slice(0, o.limit),
      truncated: false }) });
    const facade = (mode, listOpen) => Object.freeze({ getMode: () => mode, listOpen: listOpen || ((tx, o) => {
      assert.strictEqual(tx.inTransaction, true);
      return { ok: true, raids: [raid("r2", SYS + 1, "WARNED", T0 + 5400000)].slice(0, o.limit), truncated: false };
    }) });
    const build = (extra) => buildSiegesLayerView({ store: fakeStore(), repository, clock: { now: () => T0 },
      nowMs: () => 0, maxSieges: 100, maxSystems: 1000, maxLines: 6, refreshMs: 15000, ...extra }).getData();
    const before = build({});
    for (const hr of [null, facade("off"), facade("ready", () => {
      throw new Error("raid read down");
    }), facade("ready", () => ({ ok: false, reason: "TX_REQUIRED" }))]) {
      assert.deepStrictEqual(build({ getHarvestRaid: () => hr }), before);
    }
    const withRaid = build({ getHarvestRaid: () => facade("ready") });
    assert.deepStrictEqual(withRaid.legend.slice(-2), RAID_LEGEND.map((l) => [...l]));
    assert.deepStrictEqual(withRaid.legend.slice(0, -2), before.legend);
    assert.deepStrictEqual(withRaid.raids, [{ kind: "raid", raidId: "r2", systemId: SYS + 1, state: "WARNED",
      targetKind: "metenox", ownerCorpId: CORP, attackerFactionId: FACTION, creditedMs: 0, wallDeadlineAt: T0 + 5400000 }]);
    assert.deepStrictEqual(withRaid.items.map((i) => i[1]), ["siege-timer", "hraid-warned"]);
    assert.strictEqual(withRaid.note, "1 open sieges in 2 systems; 1 harvester raids");
  });

  test("N4 adapter readTypeNames (ASCII, <= 48, missing entry, INVALID_INPUT) + vendor fact itemTypeRegistry", () => {
    const meta = new Map([[1, { name: "  Zeolites " }], [2, { name: `Cobáltite ${"X".repeat(60)}` }],
      [4, { name: "" }]]);
    const vendor = { types: { resolveItemByTypeID: (t) => meta.get(t) || null } };
    const r = HB.readTypeNamesFrom(vendor, { typeIds: [1, 2, 3, 4] });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.deepStrictEqual([...r.names.entries()], [[1, "Zeolites"], [2, `Cobltite ${"X".repeat(39)}`]]);
    for (const bad of [[], Array.from({ length: HB.MAX_TYPE_NAMES + 1 }, (_, i) => i + 1), [1, 1], [0], null]) {
      assert.strictEqual(HB.readTypeNamesFrom(vendor, { typeIds: bad }).reason, "INVALID_INPUT", JSON.stringify(bad));
    }
    assert.strictEqual(HB.readTypeNamesFrom({}, { typeIds: [1] }).reason, "HARVEST_BAYS_SEAM_UNAVAILABLE");
    assert.strictEqual(HB.readTypeNamesFrom({ types: { resolveItemByTypeID: () => {
      throw new Error("boom");
    } } }, { typeIds: [1] }).reason, "SEAM_ERROR");
    const seam = HB.createHarvestBaySeam({ requireGame: (p) => ({ ok: true, exports: p === HB.PATHS.types
      ? vendor.types : {} }), disabledReason: () => null });
    assert.deepStrictEqual(Object.keys(seam), [...HB.SEAM_METHODS]);
    assert.deepStrictEqual([...seam.readTypeNames({ typeIds: [1] }).names.entries()], [[1, "Zeolites"]]);
    const text = fs.readFileSync(path.join(serverSrc(), "services/inventory/itemTypeRegistry.js"), "utf8");
    assert.ok(text.includes("name: String(entry.name") && text.includes("function resolveItemByTypeID"));
  });
};
