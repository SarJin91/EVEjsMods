"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const config = require("../../config");
const { openStore } = require("../../lib/persistence/store");
const { createJournal } = require("../../lib/persistence/journal");
const { MIGRATIONS, LATEST_SCHEMA_VERSION } = require("../../lib/persistence/migrations");
const { createManualClock } = require("../../lib/util/clock");
const { createViewRegistry } = require("../../lib/observer/views");
const { startBattle } = require("../../lib/battle");
const { crewTargets, diffSeats, pickPilots, pickReclaim } = require("../../lib/crews/plan");
const { buildCrewPool } = require("../../lib/crews/pool");
const { startCrews, createUnavailableCrews } = require("../../lib/crews");
const { FACADE_METHODS } = require("../../lib/crews/schema");
const { harness: H } = require("../battle/settlement.test");
const { harness: C } = require("../battle/contacts.test");
const { settlementRowsLimit } = require("../../lib/battle/settlementPlan");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const T0 = 1760000000000;
const FACTION = 500019;
const CORP = 98000001;
const SYS1 = 30000001;
const SYS2 = 30000002;
const FRIG = (count) => [{ hullGroup: "frigate", typeId: null, count }];
const NO_TIMER = () => ({ cancel() {}, hasRef: () => false });

function crewsConfig(over = {}) {
  const c = JSON.parse(JSON.stringify(config.resolveConfig({ modDir: MOD_DIR, env: {} }).config));
  Object.assign(c.crews, { enabled: true }, over);
  return c;
}

function candidate(characterId, corporationId, ownerKind = "faction", ownerId = FACTION) {
  return { characterId, ownerKind, ownerId, name: `P${characterId}`, corporationId, allianceId: 99000001 };
}

function world(candidates) {
  const fleets = new Map();
  const observed = new Set();
  const vc = { version: 1, candidates };
  const byId = (a, b) => (a.fleetId < b.fleetId ? -1 : (a.fleetId > b.fleetId ? 1 : 0));
  const repository = {
    getFleet: (_tx, id) => ({ ok: true, fleet: fleets.get(id) || null }),
    getFleets: (_tx, ids) => ({ ok: true, fleets: ids.map((id) => fleets.get(id)).filter(Boolean), missing: [] }),
    listFleetsInSystems: (_tx, systemIds, opts) => ({ ok: true, bySystem: new Map(systemIds.map((s) => [s,
      [...fleets.values()].filter((f) => f.currentSystemId === s && opts.states.includes(f.state)).sort(byId)])) }),
    listFleetsByFaction(_tx, factionId, opts) {
      const all = [...fleets.values()].filter((f) => f.factionId === factionId && opts.states.includes(f.state)
        && f.fleetId > (opts.afterFleetId || "")).sort(byId);
      const page = all.slice(0, opts.limit);
      return { ok: true, fleets: page, nextAfterFleetId: page.length === opts.limit ? page[page.length - 1].fleetId : null };
    },
  };
  return {
    fleets, observed, vc,
    add(fleetId, over = {}) {
      fleets.set(fleetId, { fleetId, factionId: FACTION, corporationId: null, currentSystemId: SYS1, state: "IDLE",
        composition: FRIG(1), ...over });
    },
    set(fleetId, over) {
      fleets.set(fleetId, { ...fleets.get(fleetId), ...over });
    },
    ctx(persistence) {
      return { persistence, fleets: { repository },
        presence: { observedSystems: () => [...observed], isObserved: (s) => observed.has(s) },
        virtualCorps: { listPilotCandidates: () => ({ ok: true, version: vc.version, candidates: vc.version > 0
          ? vc.candidates : [] }), nameOf: (id) => `N${id}` } };
    },
  };
}

function openFile(driver, file, migrations = MIGRATIONS) {
  const o = openStore({ filePath: file, openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
    busyTimeoutMs: 0, maxRowsPerTransaction: 1000, maxWriteMsPerPass: 5, randomSeed: () => 1, migrations });
  assert.ok(o.ok, JSON.stringify(o));
  return o;
}

function boot(opened, w, clock, over, more = {}) {
  const journal = createJournal({ clock, maxPayloadBytes: 16384, maxRows: 500 });
  const persistence = { ok: true, store: opened.store, journal };
  const ctx = Object.assign(w.ctx(persistence), more.ctx || {});
  const r = startCrews({ config: crewsConfig(over), ctx, clock, setTimer: NO_TIMER,
    ...(more.setImmediate ? { setImmediate: more.setImmediate } : {}) });
  assert.ok(r.ok, JSON.stringify(r));
  const tx = (fn) => {
    const res = opened.store.transaction("test", fn);
    assert.ok(res.ok, JSON.stringify(res));
    return res.value;
  };
  const seatsOf = (fleetId) => tx((db) => db.prepare("SELECT seat, character_id AS c FROM world_fleet_crew_seats "
    + "WHERE fleet_id = ? ORDER BY seat").all(fleetId)).map((s) => [s.seat, s.c]);
  const header = (fleetId) => tx((db) => db.prepare("SELECT * FROM world_fleet_crews WHERE fleet_id = ?").get(fleetId));
  const pilots = () => tx((db) => db.prepare("SELECT character_id AS c, losses, cooldown_until AS until "
    + "FROM world_crew_pilots ORDER BY character_id").all());
  return { crews: r.crews, tx, seatsOf, header, pilots };
}

function withTmp(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-crews-"));
  const stores = [];
  const open = (driver, name, migrations) => {
    const o = openFile(driver, path.join(tmp, name), migrations);
    stores.push(o.store);
    return o;
  };
  try {
    return fn(open);
  } finally {
    for (const s of stores) {
      try {
        s.close("test");
      } catch (_err) {
      }
    }
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

const CORP_POOL = [1, 2, 3, 4, 5].map((n) => candidate(91000000 + n, CORP));

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  test("CR1 plan: crewTargets largest remainder, diffSeats drops the highest, pickPilots order, pickReclaim", () => {
    const cruiser = { hullGroup: "cruiser", typeId: null, count: 2 };
    assert.deepStrictEqual(crewTargets([{ hullGroup: "frigate", typeId: null, count: 3 }, cruiser],
      { shipsPerPilot: 1, maxCrewPerFleet: 4 }).map((t) => [t.hullGroup, t.seats]), [["frigate", 2], ["cruiser", 2]]);
    assert.deepStrictEqual(crewTargets([{ hullGroup: "a", typeId: null, count: 2 }, { hullGroup: "b", typeId: null,
      count: 2 }], { shipsPerPilot: 1, maxCrewPerFleet: 3 }).map((t) => t.seats), [2, 1]);
    assert.deepStrictEqual(crewTargets(FRIG(5), { shipsPerPilot: 2, maxCrewPerFleet: 64 })[0].seats, 3);
    const seats = [0, 1, 2, 3, 4].map((seat) => ({ seat, characterId: 100 + seat, hullGroup: "frigate", typeId: null }));
    const d = diffSeats(seats, [{ hullGroup: "frigate", typeId: null, seats: 3 }, { hullGroup: "cruiser", typeId: 7,
      seats: 1 }]);
    assert.deepStrictEqual([d.remove, d.add, d.wanted], [[3, 4], [{ seat: 5, hullGroup: "cruiser", typeId: 7 }], 4]);
    const pool = buildCrewPool([candidate(5, 77), candidate(3, 77), candidate(9, 88), candidate(1, 88)], 10, 1);
    const pick = pickPilots({ need: 3, preferred: [9], corporationId: 77, factionId: FACTION, pool, taken: new Set([5]),
      cooldown: new Map([[1, T0 + 1]]), at: T0 });
    assert.deepStrictEqual(pick, { picked: [9, 3], shortfall: 1 });
    const rec = pickReclaim({ need: 3, minIdleMs: 100, at: T0, victims: [
      { fleetId: "a", lastSeenAt: T0 - 500, seats: [{ seat: 0, characterId: 1 }] },
      { fleetId: "b", lastSeenAt: null, seats: [{ seat: 0, characterId: 2 }, { seat: 1, characterId: 3 }] },
      { fleetId: "c", lastSeenAt: T0 - 10, seats: [{ seat: 0, characterId: 4 }] }] });
    assert.deepStrictEqual(rec.map((r) => [r.fleetId, r.seat]), [["b", 1], ["b", 0], ["a", 0]]);
  });

  needsDriver("CR2 migration 55 (zero and 54 -> 55); pass crews an observed fleet; restart + jump -> same pilots, "
    + "zero writes", () => withTmp((open) => {
    assert.deepStrictEqual([LATEST_SCHEMA_VERSION >= 55, MIGRATIONS[54].name], [true, "crews"]);
    const fresh = open(driver, "fresh.sqlite");
    const meta = fresh.store.transaction("t", (db) => ({
      strict: db.prepare("SELECT name, strict FROM pragma_table_list WHERE name LIKE 'world_%crew%' ORDER BY name")
        .all().map((r) => `${r.name}:${r.strict}`),
      index: db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'world_fleet_crews_reclaim'")
        .pluck().all() })).value;
    assert.deepStrictEqual(meta, { strict: ["world_crew_pilots:1", "world_fleet_crew_seats:1", "world_fleet_crews:1"],
      index: ["world_fleet_crews_reclaim"] });
    const old = open(driver, "old.sqlite", MIGRATIONS.slice(0, 54));
    old.store.close("upgrade");
    const up = open(driver, "old.sqlite");
    assert.deepStrictEqual([up.schemaVersion, up.applied], [LATEST_SCHEMA_VERSION, LATEST_SCHEMA_VERSION - 54]);

    const clock = createManualClock(T0);
    const w = world([...CORP_POOL, candidate(91000010, 98000002)]);
    w.add("fleet:a", { corporationId: CORP, composition: FRIG(3) });
    w.observed.add(SYS1);
    const o1 = open(driver, "world.sqlite");
    const s1 = boot(o1, w, clock);
    assert.deepStrictEqual(s1.crews.runPassNow(), { ok: true });
    assert.deepStrictEqual(s1.seatsOf("fleet:a"), [[0, 91000001], [1, 91000002], [2, 91000003]]);
    const h1 = s1.header("fleet:a");
    assert.deepStrictEqual([h1.wanted, h1.seated, h1.version, h1.last_seen_at], [3, 3, 1, T0]);
    s1.crews.stop("test");
    o1.store.close("restart");

    w.set("fleet:a", { currentSystemId: SYS2 });
    w.observed.clear();
    w.observed.add(SYS2);
    clock.advance(1000);
    const o2 = open(driver, "world.sqlite");
    const s2 = boot(o2, w, clock);
    assert.deepStrictEqual(s2.crews.runPassNow(), { ok: true });
    assert.deepStrictEqual(s2.seatsOf("fleet:a"), [[0, 91000001], [1, 91000002], [2, 91000003]]);
    assert.deepStrictEqual(s2.header("fleet:a"), h1, "no header write");
    assert.strictEqual(s2.crews.getStatus().enlisted, 0);
    s2.crews.stop("test");
  }));

  needsDriver("CR3 consequence crews: 5 -> 3 drops the 2 highest seats with cooldown; repeat = zero changes; "
    + "DESTROYED -> header gone, every pilot lost", () => withTmp((open) => {
    const clock = createManualClock(T0);
    const w = world(CORP_POOL);
    w.add("fleet:b", { corporationId: CORP, composition: FRIG(5) });
    w.observed.add(SYS1);
    const s = boot(open(driver, "world.sqlite"), w, clock);
    s.crews.runPassNow();
    assert.strictEqual(s.seatsOf("fleet:b").length, 5);
    const cooldown = crewsConfig().crews.lostCooldownMs;
    const at = T0 + 5000;
    w.set("fleet:b", { composition: FRIG(3) });
    const settled = { battleId: "b1", at, fleets: [{ fleetId: "fleet:b", side: 0, factionId: FACTION,
      disposition: "HELD", lost: 2 }] };
    assert.deepStrictEqual(s.tx((db) => s.crews.consequence.apply(db, settled, "k:c:crews")),
      { ok: true, lost: 2, fleets: 1, truncated: 0, deferred: 0 });
    assert.deepStrictEqual(s.seatsOf("fleet:b"), [[0, 91000001], [1, 91000002], [2, 91000003]]);
    assert.deepStrictEqual(s.pilots(), [{ c: 91000004, losses: 1, until: at + cooldown },
      { c: 91000005, losses: 1, until: at + cooldown }]);
    const before = [s.seatsOf("fleet:b"), s.header("fleet:b"), s.pilots()];
    assert.deepStrictEqual(s.tx((db) => s.crews.consequence.apply(db, settled, "k:c:crews")),
      { ok: true, lost: 0, fleets: 1, truncated: 0, deferred: 0 });
    assert.deepStrictEqual([s.seatsOf("fleet:b"), s.header("fleet:b"), s.pilots()], before, "second apply: no change");
    w.set("fleet:b", { state: "DESTROYED", composition: [] });
    const r = s.tx((db) => s.crews.consequence.apply(db, { ...settled, battleId: "b2", fleets: [{ ...settled.fleets[0],
      disposition: "DESTROYED", lost: 3 }] }, "k2:c:crews"));
    assert.deepStrictEqual(r, { ok: true, lost: 3, fleets: 1, truncated: 0, deferred: 0 });
    assert.deepStrictEqual([s.seatsOf("fleet:b"), s.header("fleet:b")], [[], undefined]);
    assert.deepStrictEqual(s.pilots().map((p) => [p.c, p.losses]), CORP_POOL.map((c) => [c.characterId, 1]));
    s.crews.stop("test");
  }));

  needsDriver("CR4 reclaim: observed B takes the 2 highest seats of never-seen A, MATERIALIZED C untouched; pool "
    + "version 0 -> no drop, no enlist", () => withTmp((open) => {
    const clock = createManualClock(T0);
    const w = world([1, 2, 3, 4, 5, 6].map((n) => candidate(91000000 + n, null)));
    w.add("fleet:a", { composition: FRIG(4), currentSystemId: SYS2 });
    w.add("fleet:c", { composition: FRIG(2), currentSystemId: SYS2, state: "MATERIALIZED" });
    const s = boot(open(driver, "world.sqlite"), w, clock);
    s.crews.runPassNow();
    assert.deepStrictEqual(s.seatsOf("fleet:a"), [[0, 91000001], [1, 91000002], [2, 91000003], [3, 91000004]]);
    assert.deepStrictEqual(s.seatsOf("fleet:c"), [[0, 91000005], [1, 91000006]]);
    assert.strictEqual(s.header("fleet:a").last_seen_at, null, "background: never seen");
    w.add("fleet:b", { composition: FRIG(2), currentSystemId: SYS1 });
    w.observed.add(SYS1);
    clock.advance(1000);
    s.crews.runPassNow();
    assert.deepStrictEqual(s.seatsOf("fleet:b"), [[0, 91000004], [1, 91000003]]);
    assert.deepStrictEqual(s.seatsOf("fleet:a"), [[0, 91000001], [1, 91000002]]);
    assert.deepStrictEqual([s.header("fleet:a").seated, s.header("fleet:a").wanted], [2, 4]);
    assert.deepStrictEqual(s.seatsOf("fleet:c"), [[0, 91000005], [1, 91000006]]);
    assert.strictEqual(s.crews.getStatus().reclaimed, 2);

    const snapshot = () => ["fleet:a", "fleet:b", "fleet:c", "fleet:d"].map((id) => s.seatsOf(id));
    const before = snapshot();
    w.vc.version = 0;
    w.vc.candidates = [];
    w.set("fleet:a", { composition: FRIG(1) });
    w.add("fleet:d", { composition: FRIG(2), currentSystemId: SYS1 });
    clock.advance(1000);
    assert.deepStrictEqual(s.crews.runPassNow(), { ok: true });
    assert.deepStrictEqual(snapshot(), before, "pool version 0: zero STALE, zero drops, zero enlist");
    assert.strictEqual(s.crews.getStatus().poolReady, false);
    s.crews.stop("test");
  }));

  needsDriver("CR8 a virtual-corp fleet with no corp donor takes "
    + "seats of a STAGED NPC-corp donor of its faction; a donor of another faction is never taken", () => withTmp((open) => {
    const clock = createManualClock(T0);
    const OTHER = 500001;
    const npcCorp = 1000005;
    const vCorp = 98000002;
    const w = world([candidate(91000030, vCorp), ...[31, 32, 33].map((n) => candidate(91000000 + n, npcCorp)),
      ...[40, 41].map((n) => candidate(91000000 + n, 1000035, "faction", OTHER))]);
    w.add("fleet:s", { corporationId: npcCorp, composition: FRIG(4), currentSystemId: SYS2, state: "STAGED" });
    w.add("fleet:o", { factionId: OTHER, corporationId: 1000035, composition: FRIG(2), currentSystemId: SYS2 });
    const s = boot(open(driver, "world.sqlite"), w, clock);
    s.crews.runPassNow();
    assert.deepStrictEqual(s.seatsOf("fleet:s"), [[0, 91000031], [1, 91000032], [2, 91000033], [3, 91000030]],
      "the pool of the faction is exhausted, the virtual-corp pilot too");
    assert.deepStrictEqual(s.seatsOf("fleet:o"), [[0, 91000040], [1, 91000041]]);
    w.add("fleet:g", { corporationId: vCorp, composition: FRIG(4), currentSystemId: SYS1 });
    w.observed.add(SYS1);
    clock.advance(1000);
    s.crews.runPassNow();
    assert.deepStrictEqual(s.seatsOf("fleet:g"), [[0, 91000030], [1, 91000033], [2, 91000032], [3, 91000031]],
      "faction donor round after the empty corporation round");
    assert.deepStrictEqual(s.seatsOf("fleet:s"), []);
    assert.strictEqual(s.header("fleet:s").seated, 0);
    assert.deepStrictEqual(s.seatsOf("fleet:o"), [[0, 91000040], [1, 91000041]], "another faction: never a donor");
    assert.strictEqual(s.crews.getStatus().reclaimed, 4);
    s.crews.stop("test");
  }));

  needsDriver("CR5 contract seatsForMaterializationInTx / recordLiveLossInTx; enabled=false -> stub, same method list, "
    + "no crews consequence in battle", () => withTmp((open) => {
    const clock = createManualClock(T0);
    const w = world([...CORP_POOL, candidate(91000020, 98000002)]);
    w.add("fleet:e", { corporationId: CORP, composition: [{ hullGroup: "cruiser", typeId: null, count: 1 },
      { hullGroup: "frigate", typeId: null, count: 2 }] });
    const s = boot(open(driver, "world.sqlite"), w, clock);
    const members = [{ memberKey: "m2", hullGroup: "frigate", typeId: null },
      { memberKey: "m1", hullGroup: "frigate", typeId: null }, { memberKey: "m3", hullGroup: "cruiser", typeId: null },
      { memberKey: "m4", hullGroup: "battleship", typeId: null }];
    const r = s.tx((db) => s.crews.seatsForMaterializationInTx(db, { fleetId: "fleet:e", members, at: T0 }));
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.deepStrictEqual(r.seats.map((x) => [x.memberKey, x.characterId, x.ownerId, x.allianceId, x.name]), [
      ["m1", 91000002, CORP, 99000001, "P91000002"], ["m2", 91000003, CORP, 99000001, "P91000003"],
      ["m3", 91000001, CORP, 99000001, "P91000001"]]);
    assert.strictEqual(r.unmatched, 1);
    assert.strictEqual(s.header("fleet:e").last_seen_at, T0, "materialized = seen");
    const loss = { fleetId: "fleet:e", characterIds: [91000002], at: T0 + 10 };
    assert.deepStrictEqual(s.tx((db) => s.crews.recordLiveLossInTx(db, loss, "fx:1:loss:m1")),
      { ok: true, duplicate: false, lost: 1 });
    assert.deepStrictEqual(s.tx((db) => s.crews.recordLiveLossInTx(db, loss, "fx:1:loss:m1")),
      { ok: true, duplicate: true, lost: 0 });
    assert.deepStrictEqual(s.seatsOf("fleet:e"), [[0, 91000001], [2, 91000003]]);
    const stats = s.tx((db) => s.crews.listPilotStatsInTx(db, [91000002, 91000001]));
    assert.deepStrictEqual([stats.ok, [...stats.byId]], [true, [[91000002, { losses: 1 }]]], "one SELECT of losses");
    assert.deepStrictEqual(s.crews.describe(91000001), { ok: true, name: "P91000001",
      corporationId: CORP, allianceId: 99000001, corporationName: `N${CORP}`, allianceName: "N99000001" });

    assert.deepStrictEqual(startCrews({ config: crewsConfig({ enabled: false }), ctx: {} }),
      { ok: false, reason: "disabled_by_config" });
    const stub = createUnavailableCrews("disabled_by_config");
    assert.deepStrictEqual(Object.keys(stub).sort(), Object.keys(s.crews).sort());
    assert.deepStrictEqual(Object.keys(s.crews).filter((k) => typeof s.crews[k] === "function").sort(),
      [...FACADE_METHODS].sort());
    assert.ok(Object.isFrozen(s.crews) && Object.isFrozen(stub));
    assert.strictEqual(stub.consequence, null);
    assert.deepStrictEqual(stub.listSeatsInTx(), { ok: false, reason: "disabled_by_config" });
    assert.deepStrictEqual(stub.seatsForMaterializationInTx(), { ok: false, reason: "disabled_by_config" });
    s.crews.stop("test");

    const consequencesOf = (over) => {
      const env = C.createEnv(driver, { config: over });
      try {
        env.battle.stop("test");
        const b = startBattle({ ...env.battleDeps, views: createViewRegistry(), getCrews: () => null });
        assert.ok(b.ok, JSON.stringify(b));
        env.battle = b.battle;
        return [...b.battle.getStatus().consequences];
      } finally {
        env.close();
      }
    };
    const off = consequencesOf({});
    const on = consequencesOf({ "crews.enabled": true });
    assert.deepStrictEqual([off.includes("crews"), on[on.length - 1]], [false, "crews"]);
  }));

  needsDriver("CR6 large battle with crews on: consequence <= crews.maxSettleRows rows, the rest goes in the "
    + "next pass without a loss; settlement limit and", () => withTmp((open) => {
    const clock = createManualClock(T0);
    const pool = Array.from({ length: 40 }, (_, i) => candidate(92000000 + i, CORP));
    const w = world(pool);
    w.add("fleet:x", { corporationId: CORP, composition: FRIG(20) });
    w.add("fleet:y", { corporationId: CORP, composition: FRIG(20) });
    w.observed.add(SYS1);
    const s = boot(open(driver, "world.sqlite"), w, clock);
    s.crews.runPassNow();
    assert.deepStrictEqual([s.seatsOf("fleet:x").length, s.seatsOf("fleet:y").length], [20, 20]);
    const cap = crewsConfig().crews.maxSettleRows;
    assert.strictEqual(cap, 32);
    w.set("fleet:x", { state: "DESTROYED", composition: [] });
    w.set("fleet:y", { composition: FRIG(1) });
    const settled = { battleId: "b9", at: T0 + 5000, fleets: [
      { fleetId: "fleet:x", side: 0, factionId: FACTION, disposition: "DESTROYED", lost: 20 },
      { fleetId: "fleet:y", side: 0, factionId: FACTION, disposition: "HELD", lost: 19 }] };
    const [r, rows] = s.tx((db) => {
      const before = db.prepare("SELECT total_changes() AS n").get().n;
      const out = s.crews.consequence.apply(db, settled, "k9:c:crews");
      return [out, db.prepare("SELECT total_changes() AS n").get().n - before];
    });
    assert.deepStrictEqual(r, { ok: true, lost: 15, fleets: 1, truncated: 5, deferred: 1 });
    assert.ok(rows <= cap, `rows ${rows} <= ${cap} (unbounded: 41 + 39 = 80)`);
    assert.deepStrictEqual([s.seatsOf("fleet:x").length, s.header("fleet:x").seated, s.seatsOf("fleet:y").length],
      [5, 5, 20]);
    assert.strictEqual(s.crews.getStatus().truncated, 6);
    clock.advance(1000);
    assert.deepStrictEqual(s.crews.runPassNow(), { ok: true });
    assert.deepStrictEqual([s.seatsOf("fleet:x"), s.header("fleet:x"), s.seatsOf("fleet:y").length], [[], undefined, 1]);
    assert.strictEqual(s.pilots().length, 15, "the rest leaves as SHRINK / GONE, without a loss");
    s.crews.stop("test");

    const off = config.resolveConfig({ modDir: MOD_DIR, env: {} });
    const on = config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_CREWS_ENABLED: "1",
      EVEJS_LNE_CREWS_MAX_FLEETS_PER_PASS: "512" } });
    assert.deepStrictEqual([settlementRowsLimit(off.config), settlementRowsLimit(on.config)], [944, 912]);
    assert.deepStrictEqual(on.warnings.filter((x) => /settleRowsReserve|smallest full battle/.test(x)), []);
    assert.strictEqual(on.config.crews.maxFleetsPerPass, 500);
  }));

  needsDriver("CR7: a pass seating a requested fleet -> one Local pass via setImmediate (none "
    + "without a seated request); reconcileGuardedInTx LIVE with maxRows: losses within the ceiling, bad maxRows "
    + "refused", () => withTmp((open) => {
    const clock = createManualClock(T0);
    const w = world(CORP_POOL);
    w.add("fleet:r", { corporationId: CORP, composition: FRIG(5), currentSystemId: SYS2 });
    const later = [];
    let localPasses = 0;
    const s = boot(open(driver, "world.sqlite"), w, clock, { backgroundEnlist: false },
      { setImmediate: (fn) => later.push(fn), ctx: { localPilots: { runPassNow: () => { localPasses += 1; } } } });
    s.crews.runPassNow();
    assert.strictEqual(later.length, 0, "nothing requested");
    assert.deepStrictEqual(s.crews.requestEnlist(["fleet:r"]), { ok: true, queued: 1 });
    s.crews.runPassNow();
    assert.strictEqual(s.seatsOf("fleet:r").length, 5);
    assert.strictEqual(later.length, 1);
    later[0]();
    assert.strictEqual(localPasses, 1);
    s.crews.requestEnlist(["fleet:r"]);
    s.crews.runPassNow();
    assert.strictEqual(later.length, 1, "requested but nothing new seated");

    w.set("fleet:r", { composition: FRIG(1) });
    const guarded = (req, key) => s.tx((db) => s.crews.reconcileGuardedInTx(db, "fleet:r", req, key));
    assert.strictEqual(guarded({ cause: "LIVE", at: T0 + 10, maxRows: 0 }, "fexp:x:losses").reason, "INVALID_ARGUMENT");
    assert.deepStrictEqual(guarded({ cause: "LIVE", at: T0 + 10, maxRows: 5 }, "fexp:x:losses"),
      { ok: true, duplicate: false, lost: 2 });
    assert.strictEqual(s.seatsOf("fleet:r").length, 3, "2 losses (4 rows) + the header within 5 rows");
    assert.deepStrictEqual(guarded({ cause: "LIVE", at: T0 + 10, maxRows: 5 }, "fexp:x:losses"),
      { ok: true, duplicate: true, lost: 0 });
    s.crews.stop("test");
  }));
};
