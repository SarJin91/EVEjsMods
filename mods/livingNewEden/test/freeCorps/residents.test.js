"use strict";

const assert = require("node:assert");
const path = require("node:path");

const config = require("../../config");
const { createJournal } = require("../../lib/persistence/journal");
const { createManualClock } = require("../../lib/util/clock");
const { startFreeCorps } = require("../../lib/freeCorps");
const { FACADE_METHODS } = require("../../lib/freeCorps/schema");
const { buildCapsuleersLayerView, mergeFreeCorps, LEGEND } = require("../../lib/strategy/capsuleers/capsuleersLayer");
const { loadDriver, withStore } = require("../notices/storeHelper");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const T0 = 2000000000000;
const ON_ENV = Object.freeze({ EVEJS_LNE_FREE_CORPS_ENABLED: "1", EVEJS_LNE_VIRTUALCORPS_ENABLED: "1" });
const X = 30000001;
const Y = 30000002;
const Z = 30000003;
const charsOf = (corpId, n) => Array.from({ length: n }, (_v, i) => 91000000 + corpId * 100 + i);

function cfgOf({ local = {}, map = {}, ventures = true } = {}) {
  const r = config.resolveConfig({ modDir: MOD_DIR, env: ON_ENV });
  assert.deepStrictEqual(r.errors, []);
  const c = r.config;
  const f = c.freeCorps;
  return { ...c, freeCorps: { ...f, targetCorps: 0, ventures: { ...f.ventures, enabled: ventures },
    local: { ...f.local, enabled: true, homeIdlePermille: 1000, ...local },
    map: { ...f.map, enabled: true, ...map } } };
}

function fakeVc(identities) {
  return { calls: 0, ensureOwnerIdentity: () => ({ ok: true, queued: true }),
    getOwnerIdentity(kind, id) {
      this.calls += 1;
      assert.strictEqual(kind, "free");
      const ids = identities.get(id);
      return ids ? { ok: true, state: "LINKED", corporationId: 98000000 + id, characterIds: ids.slice() }
        : { ok: true, state: "PENDING" };
    },
    getMapVersion: () => 7,
    countOwnerCharacters: () => ({ ok: true, ready: true, total: 0 }) };
}

function boot(opened, cfg) {
  const clock = createManualClock(T0);
  const vc = fakeVc(new Map([[1, charsOf(1, 5)], [2, charsOf(2, 4)], [3, charsOf(3, 3)], [4, charsOf(4, 3)]]));
  const r = startFreeCorps({ config: cfg, clock, logger: { log() {} }, telemetry: null,
    persistence: { store: opened.store, journal: createJournal({ clock, maxPayloadBytes: 16384, maxRows: 500 }),
      worldSeed: opened.worldSeed },
    getGraph: () => null, getVirtualCorps: () => vc, getGovernor: () => null,
    listStations: () => ({ ok: true, stations: [] }), bloodlinesOf: () => [1], raceSourceFactionIds: [500001],
    excludedRegionIds: [], reservedNames: () => ({ names: new Set(), tickers: new Set() }),
    setTimer: () => ({ cancel() {}, hasRef: () => false }), nowMs: () => 0 });
  assert.ok(r.ok, JSON.stringify(r));
  return { fc: r.freeCorps, vc };
}

function exec(opened, sql, ...args) {
  const r = opened.store.transaction("t.exec", (db) => db.prepare(sql).run(...args));
  assert.ok(r.ok, JSON.stringify(r));
}

function corp(opened, corpId, archetype, state, home, members) {
  exec(opened, "INSERT INTO world_free_corps (corp_id, archetype, state, open, name, ticker, sec_band, home_system_id, "
    + "home_station_id, home_station_corp_id, race_faction_id, members_target, corporation_id, isk, struggle_count, "
    + "seed, name_attempt, venture_seq, next_at, founded_at, updated_at, version) VALUES (?, ?, ?, 1, ?, ?, 'highsec', "
    + "?, 60000001, 1000100, 500001, ?, ?, 200000000, 0, 1, 0, 0, ?, ?, ?, 1)", corpId, archetype, state,
  `Corp ${corpId}`, `TC${corpId}`, home, members, state === "FOUNDING" ? null : 98000000 + corpId, T0 + 3600000, T0,
  T0);
}

function seedWorld(opened) {
  corp(opened, 1, "miner", "ACTIVE", Y, 5);
  corp(opened, 2, "hauler", "ACTIVE", Y, 4);
  corp(opened, 3, "ratter", "STRUGGLING", Z, 3);
  corp(opened, 4, "explorer", "FOUNDING", Y, 3);
  exec(opened, "INSERT INTO world_free_corp_ventures (venture_id, corp_id, seq, kind, state, open, home_system_id, "
    + "system_id, target_system_id, sec_band, jumps, crew, step, travel_steps, work_steps, steps_total, yield_isk, "
    + "cost_isk, started_at, step_due_at, updated_at, version) VALUES ('fcv:1:1', 1, 1, 'MINE', 'WORKING', 1, ?, ?, ?, "
    + "'highsec', 1, 3, 2, 1, 2, 4, 0, 0, ?, ?, ?, 1)", Y, X, X, T0, T0 + 900000, T0);
}

const plain = (bySystem) => Object.fromEntries([...bySystem].map(([k, v]) => [k, [...v]]));

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("FC4-1 residentsFor: crew in the venture system, the rest at home, FOUNDING / other homes absent, "
    + "cut, permille 0, memo, ventures off, TOO_MANY_SYSTEMS, LOCAL_DISABLED, facade keys", () => {
    withStore(driver, (opened) => {
      seedWorld(opened);
      const A = charsOf(1, 5);
      const B = charsOf(2, 4);
      const env = boot(opened, cfgOf());
      assert.deepStrictEqual(Object.keys(env.fc).filter((k) => FACADE_METHODS.includes(k)).sort(),
        FACADE_METHODS.slice().sort(), "the real facade has every FACADE_METHODS");
      const r = env.fc.residentsFor([Y, X, X], T0);
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      assert.deepStrictEqual(plain(r.bySystem), { [X]: A.slice(0, 3), [Y]: [...A.slice(3), ...B] });
      const all = [...r.bySystem.values()].flat();
      assert.strictEqual(new Set(all).size, all.length, "each character once");
      assert.deepStrictEqual([r.cut, r.cached], [0, false]);
      const reads = env.fc.getStatus().counters.residentsReads;
      assert.strictEqual(reads, 1);
      const again = env.fc.residentsFor([X, Y], T0 + 1);
      assert.deepStrictEqual([again.cached, plain(again.bySystem)], [true, plain(r.bySystem)]);
      assert.strictEqual(env.fc.getStatus().counters.residentsReads, reads, "memo hit: no read");
      assert.strictEqual(env.fc.getStatus().counters.residentsCached, 1);
      const nine = Array.from({ length: 9 }, (_v, i) => X + i);
      assert.deepStrictEqual(env.fc.residentsFor(nine, T0), { ok: false, reason: "TOO_MANY_SYSTEMS" });
      assert.deepStrictEqual(env.fc.residentsFor("x", T0), { ok: false, reason: "INVALID_INPUT" });
      assert.deepStrictEqual(env.fc.getStatus().local, { enabled: true, lastAt: T0, systems: 2, residents: 9, cut: 0 });
      env.fc.stop();

      const cut = boot(opened, cfgOf({ local: { maxResidentsPerSystem: 4 } }));
      const rc = cut.fc.residentsFor([X, Y], T0);
      assert.deepStrictEqual([plain(rc.bySystem), rc.cut], [{ [X]: A.slice(0, 3), [Y]: [...A.slice(3), ...B.slice(0, 2)] },
        2]);
      assert.strictEqual(cut.fc.getStatus().counters.residentsCut, 2);
      cut.fc.stop();

      const none = boot(opened, cfgOf({ local: { homeIdlePermille: 0 } }));
      assert.deepStrictEqual(plain(none.fc.residentsFor([X, Y], T0).bySystem), { [X]: A.slice(0, 3) });
      none.fc.stop();

      const off = boot(opened, cfgOf({ ventures: false }));
      assert.deepStrictEqual(plain(off.fc.residentsFor([X, Y], T0).bySystem), { [Y]: [...A, ...B] },
        "ventures off: A whole at home, X empty");
      off.fc.stop();

      const disabled = boot(opened, cfgOf({ local: { enabled: false } }));
      assert.deepStrictEqual(disabled.fc.residentsFor([X], T0), { ok: false, reason: "LOCAL_DISABLED" });
      assert.strictEqual(disabled.vc.calls, 0);
      disabled.fc.stop();
    });
  });

  needsDriver("FC4-4 map marks: maxMarks 2 of 3 systems -> 2 marks truncated, 8 legend rows, fc-<archetype> of the "
    + "most pilots; mergeFreeCorps; the layer with / without getFreeCorps", () => {
    let marks = null;
    withStore(driver, (opened) => {
      seedWorld(opened);
      const env = boot(opened, cfgOf({ map: { maxMarks: 2 } }));
      marks = env.fc.listMapMarks({ maxLines: 6 });
      assert.strictEqual(marks.ok, true, JSON.stringify(marks));
      assert.deepStrictEqual([marks.marks.length, marks.truncated, marks.legend.length, marks.cached], [2, true, 8, false]);
      assert.deepStrictEqual(marks.marks.map((m) => [m.systemId, m.style, m.pilots]), [[Y, "fc-hauler", 6],
        [X, "fc-miner", 3]]);
      assert.deepStrictEqual(marks.marks[0].lines, ["6 free corp pilots · 2 corps", "Corp 2 [TC2] · hauler · home (4)",
        "Corp 1 [TC1] · miner · home (2)"]);
      assert.deepStrictEqual(marks.marks[1].lines, ["3 free corp pilots · 1 corps",
        "Corp 1 [TC1] · miner · MINE WORKING 2/4 (3)"]);
      assert.strictEqual(env.fc.listMapMarks({ maxLines: 6 }).cached, true);
      assert.deepStrictEqual([env.fc.getStatus().counters.mapReads, env.fc.getStatus().counters.mapCached], [1, 1]);
      env.fc.stop();
      const off = boot(opened, cfgOf({ map: { enabled: false } }));
      assert.deepStrictEqual(off.fc.listMapMarks({ maxLines: 6 }), { ok: false, reason: "MAP_DISABLED" });
      off.fc.stop();
    });

    const merged = mergeFreeCorps([[X, "ratting", "2", ["2 pilots · 1 fleets"], null]],
      [{ systemId: X, style: "fc-miner", pilots: 3, lines: ["fc line"] }, { systemId: Z, style: "fc-ratter", pilots: 4,
        lines: ["z"] }]);
    assert.deepStrictEqual(merged, { items: [[X, "ratting", "5", ["2 pilots · 1 fleets", "fc line"], null],
      [Z, "fc-ratter", "4", ["z"], null]], pilots: 7, systems: 2 });

    const layer = (extra) => buildCapsuleersLayerView({ store: { isOpen: () => true,
      transaction: (name, fn) => ({ ok: true, value: fn({}) }) },
    repository: { listFleetsByFaction: () => ({ ok: true, fleets: [], nextAfterFleetId: null }) },
    clock: { now: () => 1000 }, listCorps: () => [], listTrips: () => [], listContracts: () => [],
    telemetry: null, nowMs: () => 0, maxFleets: 256, maxLines: 6, refreshMs: 1000, ...extra }).getData();
    const base = layer({});
    const seen = [];
    const data = layer({ getFreeCorps: () => ({ listMapMarks: (o) => {
      seen.push(o);
      return marks;
    } }) });
    assert.deepStrictEqual(seen, [{ maxLines: 6 }]);
    assert.deepStrictEqual(data.legend.slice(0, LEGEND.length), base.legend);
    const fcRows = data.legend.slice(LEGEND.length);
    assert.strictEqual(fcRows.length, 8);
    assert.ok(fcRows.every((l) => l.length === 4 && l[0].startsWith("fc-") && l[3] === "pip"), JSON.stringify(fcRows));
    assert.deepStrictEqual(data.items.map((i) => [i[0], i[1], i[2], i[4]]), [[Y, "fc-hauler", "6", null],
      [X, "fc-miner", "3", null]]);
    assert.strictEqual(data.note, `${base.note} · 9 free corp pilots in 2 systems (truncated)`);
    const pick = (d) => [d.items, d.legend, d.note];
    for (const getFreeCorps of [() => null, () => ({ listMapMarks: () => ({ ok: false, reason: "X" }) }), () => {
      throw new Error("boom");
    }, () => ({ listMapMarks: () => {
      throw new Error("boom");
    } })]) {
      assert.deepStrictEqual(pick(layer({ getFreeCorps })), pick(base));
    }
  });
};
