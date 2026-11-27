"use strict";

const assert = require("node:assert");
const path = require("node:path");

const config = require("../../config");
const { createJournal } = require("../../lib/persistence/journal");
const { MIGRATIONS, runMigrations } = require("../../lib/persistence/migrations");
const { startScheduler } = require("../../lib/scheduler");
const seams = require("../../lib/adapter/sentrySeams");
const { startSentries } = require("../../lib/sentries");
const { checkPlacement, checkFreeLimits } = require("../../lib/sentries/policy");
const { sentryGridScopeOf } = require("../../lib/sentries/gridScope");
const S = require("../../lib/sentries/schema");
const { harness: H } = require("../battle/settlement.test");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const DEFAULTS = config.resolveConfig({ modDir: MOD_DIR, env: {} }).config;
const SYS = 30002000;
const CORP = 98000001;
const CORP2 = 98000002;
const CORP3 = 98000003;
const CHAR = 90000001;
const GATE = 50000001;
const POST = 340520;
const GUN = 340501;
const HEAVY = 340522;
const SESSION = Object.freeze({ characterID: CHAR, _space: Object.freeze({ systemID: SYS, shipID: 1 }) });
const NO_ANCHOR = "SENTRY_NO_ANCHOR";

function item(itemID, typeID, ownerID, spaceState) {
  return Object.freeze({ itemID, typeID, ownerID, locationID: SYS, flagID: 0, categoryID: 23,
    groupID: typeID === POST ? 709 : 449, spaceState: Object.freeze({ systemID: SYS, ...spaceState }) });
}

module.exports = ({ test, skip }) => {
  test("FP1 checkPlacement free anchor: off / on, clearance, classic wins, spacing, no itemId; checkFreeLimits; text",
    () => {
      const base = { position: { x: 0, y: 0, z: 0 }, anchors: [], others: [], ownerCorpId: CORP, ownerKind: "player",
        minM: 5000, maxM: 30000, spacingM: 2000, itemId: 9001 };
      const on = { enabled: true, clearanceM: 150000 };
      const at = (kind, id, x, ownerCorpId = null) => ({ kind, id, position: { x, y: 0, z: 0 }, radius: 0, ownerCorpId });
      assert.deepStrictEqual(checkPlacement(base), { ok: false, reason: NO_ANCHOR }, "free off = as before");
      assert.deepStrictEqual(checkPlacement({ ...base, free: { enabled: false, clearanceM: 150000 } }),
        { ok: false, reason: NO_ANCHOR });
      assert.deepStrictEqual(checkPlacement({ ...base, free: on }),
        { ok: true, anchor: { kind: "space", id: 9001, surfaceM: null } });
      assert.deepStrictEqual(checkPlacement({ ...base, free: on, anchors: [at("gate", GATE, 60000)] }),
        { ok: false, reason: NO_ANCHOR, detail: "clearance" });
      assert.deepStrictEqual(checkPlacement({ ...base, free: on, anchors: [at("gate", GATE, 10000)] }).anchor,
        { kind: "gate", id: GATE, surfaceM: 10000 }, "classic anchor wins");
      assert.deepStrictEqual(checkPlacement({ ...base, free: on, anchors: [at("structure", 1022, 20000, CORP2)] }),
        { ok: false, reason: NO_ANCHOR, detail: "clearance" }, "foreign structure");
      assert.deepStrictEqual(checkPlacement({ ...base, free: on, anchors: [at("gate", GATE, 200000)] }).anchor,
        { kind: "space", id: 9001, surfaceM: 200000 });
      assert.deepStrictEqual(checkPlacement({ ...base, free: on, anchors: [at("gate", GATE, 200000)],
        anchorsTruncated: true }), { ok: false, reason: NO_ANCHOR, detail: "clearance" }, "truncated list");
      assert.deepStrictEqual(checkPlacement({ ...base, free: on, anchors: [at("gate", GATE, 10000)],
        anchorsTruncated: true }).anchor, { kind: "gate", id: GATE, surfaceM: 10000 }, "truncated, classic wins");
      assert.deepStrictEqual(checkPlacement({ ...base, free: on, others: [{ itemId: 9002, position: { x: 1000, y: 0,
        z: 0 } }] }), { ok: false, reason: "SENTRY_TOO_CLOSE" });
      const { itemId: _drop, ...noItem } = base;
      assert.deepStrictEqual(checkPlacement({ ...noItem, free: on }), { ok: false, reason: NO_ANCHOR });
      const L = { maxPerSystemPerOwner: 3, maxPerOwner: 12 };
      assert.deepStrictEqual([checkFreeLimits({ perSystemOwner: 2, perOwner: 11 }, L),
        checkFreeLimits({ perSystemOwner: 3, perOwner: 3 }, L), checkFreeLimits({ perSystemOwner: 0, perOwner: 12 }, L)],
      [{ ok: true }, { ok: false, reason: "SENTRY_LIMIT", detail: "freeSystem" },
        { ok: false, reason: "SENTRY_LIMIT", detail: "freeOwner" }]);
      const se = DEFAULTS.sentries;
      assert.deepStrictEqual([se.player.freeEnabled, se.player.freeClearanceM, se.player.freeMaxPerSystemPerOwner,
        se.player.freeMaxPerOwner, se.heavy.allowFree], [false, 150000, 3, 12, true], "expected defaults");
      assert.ok(!S.messagesOf(se).SENTRY_NO_ANCHOR.includes("Or anchor"));
      assert.ok(S.messagesOf({ ...se, player: { ...se.player, freeEnabled: true } }).SENTRY_NO_ANCHOR
        .endsWith(" Or anchor it at least 150 km from every stargate, station and structure."));
    });

  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  function rig(opened, over) {
    const shared = H.sharedOf();
    const clock = shared.clock;
    const se = DEFAULTS.sentries;
    const cfg = { ...H.CONFIG, modules: { ...H.CONFIG.modules, strategy: { enabled: true } },
      sentries: { ...se, enabled: true, player: { ...se.player, ...over.player },
        heavy: { ...se.heavy, enabled: true, ...over.heavy } },
      listeningPost: { ...DEFAULTS.listeningPost, enabled: true } };
    const journal = createJournal({ clock, maxPayloadBytes: 16384, maxRows: 500 });
    const sr = startScheduler({ config: cfg, persistence: { ok: true, store: opened.store }, clock, ids: shared.ids,
      nowMs: () => 0 });
    assert.ok(sr.ok, JSON.stringify(sr));
    const items = over.items || new Map();
    const put = (id, typeId, x, owner = CORP, state = {}) => items.set(id, item(id, typeId, owner,
      { position: { x, y: 0, z: 0 }, anchorState: "unanchored", onlineState: "offline", online: 0, ...state }));
    const modules = {
      "services/inventory/itemStore": { findItemById: (id) => items.get(id) || null,
        listStarbaseItems: (q) => [...items.values()].filter((i) => (q.systemID ? i.spaceState.systemID === q.systemID
          : i.typeID === q.typeID)) },
      "space/worldData": { getStargatesForSystem: () => [{ itemID: GATE, position: { x: 0, y: 0, z: 0 },
        radius: 5000 }], getStationsForSystem: () => [] },
      "services/structure/structureState": { peekStructures: () => [] },
      "services/starbase/posGmState": { forcePosOnlineState: (id) => {
        const cur = items.get(id);
        items.set(id, item(id, cur.typeID, cur.ownerID, { ...cur.spaceState, anchorState: "anchored",
          onlineState: "online", online: 1 }));
        return { success: true };
      } },
      "space/runtime": { isSolarSystemSceneLoaded: () => true },
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
    const res = (id) => {
      const r = policy.anchor({ session: SESSION, itemId: id });
      return r.ok ? r.sentryId : r.reason;
    };
    const row = (itemId) => {
      const r = opened.store.transaction("test", (db) => db.prepare("SELECT sentry_id, state, anchor_kind, anchor_id, "
        + "end_reason, version FROM world_sentries WHERE item_id = ?").get(itemId));
      assert.ok(r.ok, JSON.stringify(r));
      return r.value ? { ...r.value, anchor_id: Number(r.value.anchor_id), version: Number(r.value.version) } : null;
    };
    return { put, items, res, row, clock, sentries: started.sentries, service: started.service };
  }

  needsDriver("FP2 anchor anywhere: space row + freeAnchored; 4th free in the system SENTRY_LIMIT; heavy allowFree on / "
    + "off; listening post never free; flag off = SENTRY_NO_ANCHOR", () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    const off = rig(opened, { player: {} });
    off.put(9000, GUN, 200000);
    assert.strictEqual(off.res(9000), NO_ANCHOR, "flag off = as before");
    off.sentries.stop("test");

    const env = rig(opened, { player: { freeEnabled: true } });
    [9001, 9002, 9003, 9004].forEach((id, i) => env.put(id, GUN, 200000 + i * 5000));
    assert.deepStrictEqual([9001, 9002, 9003, 9004].map(env.res), ["sp-9001", "sp-9002", "sp-9003", "SENTRY_LIMIT"]);
    assert.deepStrictEqual(env.row(9001), { sentry_id: "sp-9001", state: "ACTIVE", anchor_kind: "space",
      anchor_id: 9001, end_reason: null, version: 1 });
    assert.deepStrictEqual(env.sentries.listLiveInSystem(SYS).map((r) => [r.sentryId, r.anchorKind, r.anchorId]),
      [["sp-9001", "space", 9001], ["sp-9002", "space", 9002], ["sp-9003", "space", 9003]]);
    env.put(9010, HEAVY, 240000, CORP2);
    env.put(9012, POST, 260000, CORP3);
    assert.deepStrictEqual([env.res(9010), env.res(9012)], ["sp-9010", NO_ANCHOR], "heavy free, post never");
    assert.strictEqual(env.service.getStatus().counters.freeAnchored, 4);
    env.sentries.stop("test");

    const noHeavy = rig(opened, { player: { freeEnabled: true }, heavy: { allowFree: false } });
    noHeavy.put(9011, HEAVY, 280000, CORP3);
    assert.strictEqual(noHeavy.res(9011), NO_ANCHOR, "heavy with allowFree off");
    noHeavy.sentries.stop("test");
  }));

  needsDriver("FP3 REANCHORED RETIRED gate -> ACTIVE space; orphan far away adopts space (on) / nearest anchor (off)",
    () => H.withStore(driver, async (reopen) => {
      const opened = reopen();
      const items = new Map();
      const off = rig(opened, { player: {}, items });
      off.put(9031, GUN, 405000, CORP, { anchorState: "anchored", onlineState: "online", online: 1 });
      assert.ok(off.service.reconcile(off.clock.now(), "").ok);
      assert.deepStrictEqual([off.row(9031).sentry_id, off.row(9031).anchor_kind, off.row(9031).anchor_id],
        ["sa-9031", "gate", GATE], "flag off = the nearest anchor");
      off.sentries.stop("test");

      const env = rig(opened, { player: { freeEnabled: true }, items });
      env.put(9020, GUN, 15000);
      assert.strictEqual(env.res(9020), "sp-9020");
      assert.strictEqual(env.row(9020).anchor_kind, "gate");
      env.put(9020, GUN, 15000);
      env.put(9030, GUN, 400000, CORP, { anchorState: "anchored", onlineState: "online", online: 1 });
      assert.ok(env.service.reconcile(env.clock.now(), "").ok);
      assert.deepStrictEqual([env.row(9020).state, env.row(9020).end_reason], ["RETIRED", "UNANCHORED"]);
      assert.deepStrictEqual([env.row(9030).sentry_id, env.row(9030).anchor_kind, env.row(9030).anchor_id],
        ["sa-9030", "space", 9030], "orphan far from the anchors adopts itself");
      env.put(9020, GUN, 300000);
      assert.strictEqual(env.res(9020), "sp-9020");
      assert.deepStrictEqual(env.row(9020), { sentry_id: "sp-9020", state: "ACTIVE", anchor_kind: "space",
        anchor_id: 9020, end_reason: null, version: 3 }, "RETIRED -> ACTIVE REANCHORED with the free anchor");
      env.sentries.stop("test");
    }));

  needsDriver("FP4 migration 113: gate row kept 1:1, space admitted, bogus refused, 6 indexes; space row in no grid", () => {
    const idx = MIGRATIONS.findIndex((m) => m.name === "world_sentries_space_anchor");
    assert.ok(idx > 0 && MIGRATIONS[idx].up === S.upSentriesSpaceAnchor, "registered");
    const db = new driver.Database(":memory:");
    try {
      const ctx = { randomSeed: () => 1 };
      const before = runMigrations(db, MIGRATIONS.slice(0, idx), ctx);
      assert.ok(before.ok, JSON.stringify(before));
      db.prepare(`INSERT INTO world_sentries (sentry_id, owner_kind, faction_id, owner_corp_id, anchored_by_character_id,
        item_id, type_id, system_id, anchor_kind, anchor_id, slot, state, armed_at, cost_isk, ammo_grants, end_reason,
        created_at, updated_at, ended_at, version) VALUES ('sp-1', 'player', NULL, ?, ?, 1, ?, ?, 'gate', ?, 2,
        'RETIRED', 60000, 5, 3, 'UNANCHORED', 10, 20, 30, 4)`).run(CORP, CHAR, GUN, SYS, GATE);
      const old = db.prepare("SELECT * FROM world_sentries").all();
      const up = runMigrations(db, MIGRATIONS, ctx);
      assert.deepStrictEqual([up.ok, up.applied, up.to], [true, MIGRATIONS.length - idx, MIGRATIONS.length]);
      assert.deepStrictEqual(db.prepare("SELECT * FROM world_sentries").all(), old, "row kept 1:1");
      db.prepare(`INSERT INTO world_sentries (sentry_id, owner_kind, owner_corp_id, item_id, type_id, system_id,
        anchor_kind, anchor_id, state, created_at, updated_at) VALUES ('sp-2', 'player', ?, 2, ?, ?, 'space', 2,
        'ACTIVE', 1, 1)`).run(CORP, GUN, SYS);
      assert.throws(() => db.prepare(`INSERT INTO world_sentries (sentry_id, owner_kind, owner_corp_id, item_id, type_id,
        system_id, anchor_kind, anchor_id, state, created_at, updated_at) VALUES ('sp-3', 'player', ?, 3, ?, ?, 'bogus',
        3, 'ACTIVE', 1, 1)`).run(CORP, GUN, SYS), /CHECK/);
      const names = db.prepare("PRAGMA index_list('world_sentries')").all().map((r) => r.name)
        .filter((n) => n.startsWith("world_sentries_")).sort();
      assert.deepStrictEqual(names, ["world_sentries_anchor", "world_sentries_ended", "world_sentries_faction",
        "world_sentries_item", "world_sentries_owner", "world_sentries_system"]);
    } finally {
      db.close();
    }
    const scope = sentryGridScopeOf({ positions: new Map(), grids: [{ gridKey: "g1", anchors: [{ kind: "gate",
      id: GATE }] }], sentries: [{ sentryId: "sp-2", anchorKind: "space", anchorId: 2 }] });
    assert.deepStrictEqual([scope.gridOfSentry.get("sp-2"), scope.noAnchor], [null, 1]);
  });
};
