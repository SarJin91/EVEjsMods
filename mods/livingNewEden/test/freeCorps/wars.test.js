"use strict";

const assert = require("node:assert");
const path = require("node:path");

const config = require("../../config");
const { createJournal } = require("../../lib/persistence/journal");
const { createManualClock } = require("../../lib/util/clock");
const { createViewRegistry } = require("../../lib/observer/views");
const { startFreeCorps } = require("../../lib/freeCorps");
const wars = require("../../lib/freeCorps/wars");
const { WAR_ROW_KEYS } = require("../../lib/freeCorps/view");
const { loadDriver, withStore } = require("../notices/storeHelper");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const T0 = 2000000000000;
const ON_ENV = Object.freeze({ EVEJS_LNE_FREE_CORPS_ENABLED: "1", EVEJS_LNE_VIRTUALCORPS_ENABLED: "1" });
const A = 30000001;
const B = 30000002;

function cfgOf() {
  const r = config.resolveConfig({ modDir: MOD_DIR, env: ON_ENV });
  assert.deepStrictEqual(r.errors, []);
  const c = r.config;
  const f = c.freeCorps;
  return { ...c, freeCorps: { ...f, targetCorps: 0,
    ventures: { ...f.ventures, enabled: true, loss: { highsecPermille: 0, lowsecPermille: 0, nullsecPermille: 0 } },
    lifecycle: { ...f.lifecycle, growthIskThreshold: 1000000000000 },
    wars: { ...f.wars, enabled: true, declareChancePermille: 1000, declareDelayMs: 0, raidWeight: 0 } } };
}

function graph() {
  const sys = (id, links) => ({ id, name: `S${id}`, regionId: 10000002, constellationId: 20000020, secClass: "highsec",
    links });
  const byId = new Map([[A, sys(A, [B])], [B, sys(B, [A])]]);
  return { getSystem: (id) => byId.get(id) || null,
    getSystemsBySecClass: (band) => [...byId.values()].filter((v) => v.secClass === band).map((v) => v.id),
    getNeighbors: (id) => (byId.has(id) ? byId.get(id).links.slice() : null) };
}

const linked = (corporationId) => ({ ok: true, state: "LINKED", corporationId, ceoCharacterId: corporationId + 1,
  characterIds: [corporationId * 10, corporationId * 10 + 1, corporationId * 10 + 2], refusedMemberCount: 0 });

const exec = (opened, sql, ...args) => {
  const r = opened.store.transaction("t.exec", (db) => db.prepare(sql).run(...args));
  assert.ok(r.ok, JSON.stringify(r));
};
const all = (opened, sql, ...args) => {
  const r = opened.store.transaction("t.all", (db) => db.prepare(sql).all(...args));
  assert.ok(r.ok, JSON.stringify(r));
  return r.value.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k,
    typeof v === "bigint" ? Number(v) : v])));
};

function seedCorp(opened, { corpId, home, isk, nextAt }) {
  exec(opened, "INSERT INTO world_free_corps (corp_id, archetype, state, open, name, ticker, sec_band, home_system_id, "
    + "home_station_id, home_station_corp_id, race_faction_id, members_target, corporation_id, isk, struggle_count, "
    + "seed, name_attempt, venture_seq, next_at, founded_at, updated_at, version) VALUES (?, 'miner', 'ACTIVE', 1, ?, "
    + "?, 'highsec', ?, 60000001, 1000100, 500001, 3, ?, ?, 0, ?, 0, 0, ?, ?, ?, 1)", corpId, `Corp ${corpId}`,
  `TC${corpId}`, home, 98000000 + corpId, isk, 1000 + corpId, nextAt, T0 - 1000, T0 - 1000);
}

const warRow = (opened) => all(opened, "SELECT * FROM world_free_corp_wars")[0];

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("FC7-4 war: DECLARED with the fee, ACTIVE at active_at with the panel rows, ENDED TIMEOUT with a winner; "
    + "pure reviewWar SURRENDER / SIDE_CLOSED", () => {
    withStore(driver, (opened) => {
      const cfg = cfgOf();
      const Wr = cfg.freeCorps.wars;
      seedCorp(opened, { corpId: 1, home: A, isk: 5000000000, nextAt: T0 });
      seedCorp(opened, { corpId: 2, home: B, isk: 300000000, nextAt: T0 + 86400000 * 30 });
      const clock = createManualClock(T0);
      const vc = { getOwnerIdentity: (kind, id) => linked(98000000 + id), ensureOwnerIdentity: () => ({ ok: true }),
        countOwnerCharacters: () => ({ ok: true, ready: true, total: 0, byKind: { capsuleer: 0, civilian: 0, free: 0 } }) };
      const views = createViewRegistry();
      const g = graph();
      const r = startFreeCorps({ config: cfg, clock, logger: { log() {} }, telemetry: null,
        persistence: { store: opened.store, journal: createJournal({ clock, maxPayloadBytes: 16384, maxRows: 500 }),
          worldSeed: opened.worldSeed },
        views, getGraph: () => ({ ok: true, graph: g }), getVirtualCorps: () => vc, getGovernor: () => null,
        listStations: (id) => ({ ok: true, stations: [{ stationId: id === A ? 60000001 : 60000002,
          corporationId: 1000100 }] }),
        bloodlinesOf: () => [1, 2], raceSourceFactionIds: [500001], excludedRegionIds: [],
        reservedNames: () => ({ names: new Set(), tickers: new Set() }),
        setTimer: () => ({ cancel() {}, hasRef: () => false }), nowMs: () => 0,
        bfs: require("../../lib/strategy/ai/bfs").bfs,
        readSystemBelts: (ids) => ({ ok: true, counts: new Map(ids.map((id) => [id, 2])) }), getPresence: () => null });
      assert.ok(r.ok, JSON.stringify(r));
      const fc = r.freeCorps;
      const run = () => {
        const p = fc.runPassNow();
        assert.deepStrictEqual(p, { ok: true, ran: true }, JSON.stringify(fc.getStatus().lastError));
        return fc.getStatus();
      };
      let st = run();
      let w = warRow(opened);
      assert.deepStrictEqual([w.war_id, w.state, w.corp_a, w.corp_b, w.declarer_corp_id, w.ally_corp_id, w.active_at,
        w.ends_at], ["fcw:1:2:1", "DECLARED", 1, 2, 1, null, T0, T0 + Wr.warDurationMs]);
      const upkeep = 3 * cfg.freeCorps.lifecycle.upkeepIskPerMember;
      assert.strictEqual(all(opened, "SELECT isk FROM world_free_corps WHERE corp_id = 1")[0].isk,
        5000000000 - upkeep - Wr.declareCostIsk, "declaration fee taken");
      assert.strictEqual(st.counters.warsDeclared, 1);
      assert.deepStrictEqual(st.wars, { enabled: true, open: 1 });
      clock.advance(1000);
      st = run();
      w = warRow(opened);
      assert.deepStrictEqual([w.state, w.next_at], ["ACTIVE", T0 + 1000 + Wr.reviewMs]);
      assert.strictEqual(st.counters.warsActivated, 1);
      const data = views.getView("free-corps").getData({});
      assert.strictEqual(data.wars.enabled, true);
      assert.strictEqual(data.wars.open, 1);
      assert.deepStrictEqual(Object.keys(data.wars.rows[0]), WAR_ROW_KEYS);
      assert.deepStrictEqual([data.wars.rows[0].sideA, data.wars.rows[0].state], ["Corp 1 [TC1]", "ACTIVE"]);
      exec(opened, "UPDATE world_free_corp_wars SET isk_lost_b = 40000000, kills_a = 2 WHERE war_id = 'fcw:1:2:1'");
      clock.set(T0 + Wr.warDurationMs);
      st = run();
      w = warRow(opened);
      assert.deepStrictEqual([w.state, w.open, w.end_reason, w.winner, w.ended_at],
        ["ENDED", 0, "TIMEOUT", 1, T0 + Wr.warDurationMs]);
      assert.strictEqual(st.counters.warsTimedOut, 1);
      assert.deepStrictEqual(st.wars, { enabled: true, open: 0 });
      fc.stop();
    });

    const S = cfgOf().freeCorps;
    const war = { war_id: "fcw:1:2:1", corp_a: 1, corp_b: 2, state: "ACTIVE", open: 1, active_at: T0,
      ends_at: T0 + 86400000, next_at: T0, ended_at: null, kills_a: 0, kills_b: 0, isk_lost_a: 0, isk_lost_b: 0,
      skirmishes: 0, surrender_isk: 0, winner: null, end_reason: null, version: 2 };
    const a = { corp_id: 1, state: "ACTIVE", isk: 1000 };
    const b = { corp_id: 2, state: "STRUGGLING", isk: 123456789 };
    const sur = wars.reviewWar(war, a, b, T0 + 1000, S);
    assert.deepStrictEqual([sur.op, sur.reason, sur.row.winner, sur.row.surrender_isk], ["end", "SURRENDER", 1,
      Math.floor(123456789 * 100 / 1000)]);
    assert.deepStrictEqual(sur.transfer, { fromCorpId: 2, toCorpId: 1, isk: Math.floor(123456789 * 100 / 1000) });
    const closed = wars.reviewWar(war, null, b, T0 + 1000, S);
    assert.deepStrictEqual([closed.op, closed.reason, closed.row.winner, closed.row.state, closed.transfer],
      ["end", "SIDE_CLOSED", 2, "ENDED", null]);
  });
};
