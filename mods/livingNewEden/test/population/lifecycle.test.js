"use strict";

const assert = require("node:assert");

const { loadDriver } = require("../notices/storeHelper");
const { createPopulationService } = require("../../lib/population/service");
const { settingsOf, ARCHETYPE } = require("../../lib/population/schema");
const { identityKey } = require("../../lib/population/lifecycle/schema");
const { buildStandingTables, createStandings } = require("../../lib/population/standings");
const { displayNameOf } = require("../../lib/population/near");
const { ARCHETYPES } = require("../../lib/population/data/archetypes");
const repo = require("../../lib/population/repository");
const { MIGRATIONS } = require("../../lib/persistence/migrations");
const { buildHubDistance } = require("../../lib/highsecLife/density");
const F = require("./fixture");

const SEED = 77;
const T0 = 1700000000000;
const N = 300;
const HOUR = 3600000;
const DAY = 24 * HOUR;
const BASE = { enabled: true, size: N, seedRowsPerSlice: 100, flushRowsPerSlice: 400, maxEventsPerPass: 5000,
  maxPassMs: 50, maxRoutesPerPass: 100 };
const AWAY_ALL = { enabled: true, awayPerDayPermille: 1000, maxAwayPermille: 1000, awayMinMs: HOUR, awayMaxMs: HOUR };
const FACTIONS = Object.freeze([{ factionId: 500001, kind: "empire", homeRegionIds: [10] },
  { factionId: 500019, kind: "pirate" }]);
const LIFE_COLS = ["gen", "career", "xp", "wealth"];

function settingsWith(life, extra = {}) {
  const cfg = F.populationConfig({ ...BASE, ...extra, ...(life ? { lifecycle: life } : {}) });
  if (!life) delete cfg.lifecycle;
  return settingsOf({ population: cfg });
}

function makeService(store, settings, opts = {}) {
  const graph = F.fakeGraph();
  const clock = opts.clock || { t: T0, now() { return this.t; } };
  const svc = createPopulationService({ store, worldSeed: SEED, clock, settings, telemetry: opts.telemetry,
    getGraph: () => ({ whenReady: () => Promise.resolve({ ok: true, graph }) }),
    listStations: F.listStations, buildHubDistance, yieldTurn: () => Promise.resolve(), nowMs: () => 0,
    ...(opts.factions ? { standingFactions: opts.factions } : {}),
    ...(opts.presence ? { getPresence: () => opts.presence } : {}) });
  return { svc, clock };
}

async function booted(store, settings, opts) {
  const m = makeService(store, settings, opts);
  assert.strictEqual(await m.svc.boot(), "running");
  return m;
}

function gauges() {
  const g = {};
  return { g, telemetry: { count() {}, observe() {}, gauge(name, value) {
    g[name] = value;
  } } };
}

const views = (svc) => Array.from({ length: N }, (_, i) => svc.pilot(i + 1));
const withoutLife = (row) => Object.fromEntries(Object.entries(row).filter(([k]) => !LIFE_COLS.includes(k)));

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  if (!driver.ok) {
    for (const name of ["LC1", "LC2", "LC3", "LC4", "LC5", "LC6"]) {
      skip(`${name} population life cycle`, `no sqlite driver: ${driver.detail || driver.reason}`);
    }
    return;
  }

  test("LC1 bit for bit: no section, enabled false and zero chances give the same rows (life columns 0)", async () => {
    const runs = [];
    for (const life of [null, { enabled: false }, { enabled: true, awayPerDayPermille: 0, quitOnReturnPermille: 0 }]) {
      await F.withStore(driver, async (store) => {
        const { svc } = await booted(store, settingsWith(life));
        for (let k = 1; k <= 60; k += 1) svc.runPass(T0 + k * 30 * 60000);
        svc.stop();
        runs.push(F.dbRows(store));
      });
    }
    assert.strictEqual(runs[0].length, N);
    assert.ok(runs[0].some((r) => r.seq > 2), "the pilots moved");
    for (const rows of runs) {
      for (const r of rows) assert.deepStrictEqual(LIFE_COLS.map((k) => r[k]), [0, 0, 0, 0], `pilot ${r.pilot_id}`);
    }
    assert.deepStrictEqual(runs[1].map(withoutLife), runs[0].map(withoutLife), "enabled false = no section");
    assert.deepStrictEqual(runs[2].map(withoutLife), runs[0].map(withoutLife), "zero chances = flag off");
  });

  test("LC2 AWAY: system 0 outside Local, gauge population.away; the return docks in the system of the logoff",
    async () => {
      await F.withStore(driver, async (store) => {
        const { g, telemetry } = gauges();
        const { svc } = await booted(store, settingsWith({ ...AWAY_ALL, quitOnReturnPermille: 0 }), { telemetry });
        const before = views(svc);
        const t1 = T0 + DAY + HOUR;
        svc.runPass(t1);
        const away = views(svc);
        assert.ok(away.every((v) => v.state === "AWAY"), JSON.stringify(svc.getStatus().byState));
        for (let i = 0; i < N; i += 1) {
          assert.strictEqual(away[i].systemId, 0);
          assert.strictEqual(away[i].prevId, before[i].systemId, "prevId = the system of the logoff");
          assert.ok(!svc.localIdsIn(before[i].systemId, N).includes(i + 1), "not in Local");
        }
        assert.strictEqual(g["population.away"], N);
        assert.strictEqual(svc.getStatus().counters["lifecycle.away"], N);
        assert.strictEqual(svc.getStatus().byState.AWAY, N);
        assert.ok(svc.topSystems(10).every((s) => s.systemId !== 0), "system 0 is no system of the observer");
        svc.runPass(t1 + HOUR);
        const back = views(svc);
        for (let i = 0; i < N; i += 1) {
          assert.strictEqual(back[i].state, "DOCKED");
          assert.strictEqual(back[i].systemId, before[i].systemId, "docked again where it logged off");
          assert.strictEqual(back[i].gen, 0);
          assert.strictEqual(back[i].career, null);
        }
        assert.strictEqual(svc.getStatus().counters["lifecycle.returned"], N);
        assert.strictEqual(svc.getStatus().counters["lifecycle.quit"], 0);
        assert.strictEqual(g["population.away"], 0);
        svc.stop();
      });
    });

  test("LC3 quit: gen 1 in the starter system, ROOKIE, first hull, corp 0, new profile and name; fallback",
    async () => {
      const ROOKIE = F.sid(6);
      await F.withStore(driver, async (store) => {
        const S = settingsWith({ ...AWAY_ALL, quitOnReturnPermille: 1000, rookieSystemIds: String(ROOKIE) },
          { standings: { enabled: true } });
        const { svc } = await booted(store, S, { factions: FACTIONS });
        assert.strictEqual(svc.getStatus().lifecycle.rookieSystems, 1);
        const old = svc.pilot(1);
        const std = svc.standings();
        std.profileOfPilot(1);
        const t1 = T0 + DAY + HOUR;
        svc.runPass(t1);
        svc.runPass(t1 + HOUR);
        const st = svc.getStatus();
        assert.deepStrictEqual([st.counters["lifecycle.quit"], st.counters["lifecycle.reborn"],
          st.counters["lifecycle.rookieFallback"]], [N, N, 0]);
        const v = svc.pilot(1);
        assert.deepStrictEqual([v.gen, v.career, v.state, v.systemId, v.intent], [1, "ROOKIE", "DOCKED", ROOKIE, "DOCK"]);
        assert.ok([F.sid(1), F.sid(3), F.sid(6)].includes(v.homeId), `home ${v.homeId} in the starter region`);
        assert.strictEqual(v.shipTypeId, ARCHETYPES[ARCHETYPE[v.archetype]].hulls[0], "the first hull of the pool");
        const T = F.table(S);
        const fresh = createStandings({ tables: buildStandingTables({ worldSeed: SEED, factions: FACTIONS, table: T, S }),
          worldSeed: SEED, size: N, homeOf: () => v.homeId, indexOf: (id) => T.indexOf.get(id),
          identityOf: (id) => identityKey(id, 1) });
        assert.strictEqual(std.profileOfPilot(1), fresh.profileOfPilot(1), "the cache of the old identity is cleared");
        assert.notStrictEqual(displayNameOf(SEED, identityKey(1, 1)), displayNameOf(SEED, 1), "a new name");
        assert.ok(old.gen === 0 && old.career === null);
        svc.stop();
        const row = F.dbRows(store)[0];
        assert.deepStrictEqual([row.gen, row.career, row.corp_id, row.group_id, row.system_id], [1, 1, 0, 0, ROOKIE]);
      });
      await F.withStore(driver, async (store) => {
        const S = settingsWith({ ...AWAY_ALL, quitOnReturnPermille: 1000, rookieSystemIds: String(F.sid(2)) });
        const { svc } = await booted(store, S);
        assert.strictEqual(svc.getStatus().lifecycle.rookieSystems, 0);
        svc.runPass(T0 + DAY + HOUR);
        svc.runPass(T0 + DAY + 2 * HOUR);
        assert.strictEqual(svc.getStatus().counters["lifecycle.rookieFallback"], N);
        const v = svc.pilot(1);
        assert.deepStrictEqual([v.gen, v.state, v.systemId], [1, "DOCKED", v.homeId]);
        svc.stop();
      });
    });

  test("LC4 restart: the flushed AWAY rows give the same return / quit; flag off at load = DOCKED at home",
    async () => {
      const life = { ...AWAY_ALL, quitOnReturnPermille: 500, rookieSystemIds: String(F.sid(6)) };
      const t1 = T0 + DAY + HOUR;
      const t2 = t1 + HOUR;
      let reference = null;
      await F.withStore(driver, async (store) => {
        const { svc } = await booted(store, settingsWith(life));
        svc.runPass(t1);
        svc.runPass(t2);
        svc.stop();
        reference = F.dbRows(store);
      });
      const kinds = reference.map((r) => r.gen);
      assert.ok(kinds.includes(0) && kinds.includes(1), "both a return and a quit in the reference");
      await F.withStore(driver, async (store) => {
        const a = await booted(store, settingsWith(life));
        a.svc.runPass(t1);
        a.svc.stop();
        const b = await booted(store, settingsWith(life), { clock: { t: t1, now() { return this.t; } } });
        assert.strictEqual(b.svc.getStatus().byState.AWAY, N, "AWAY rows load as AWAY with the flag on");
        b.svc.runPass(t2);
        b.svc.stop();
        assert.deepStrictEqual(F.dbRows(store), reference, "the same rows as without the restart");
      });
      await F.withStore(driver, async (store) => {
        const a = await booted(store, settingsWith(life));
        a.svc.runPass(t1);
        a.svc.stop();
        const off = await booted(store, settingsWith({ enabled: false }), { clock: { t: t1, now() { return this.t; } } });
        const st = off.svc.getStatus();
        assert.strictEqual(st.counters.loadNormalized, N);
        assert.strictEqual(st.byState.AWAY, undefined, "no AWAY key with the flag off");
        for (const v of views(off.svc)) {
          assert.deepStrictEqual([v.state, v.systemId, v.intent], ["DOCKED", v.homeId, "DOCK"]);
        }
        off.svc.stop();
      });
    });

  test("LC5 migration + repository: 4 columns DEFAULT 0, written and read; maxAwayPermille 0 -> awayCapped",
    async () => {
      const m = MIGRATIONS.find((x) => x.name === "population-lifecycle");
      assert.ok(m, "migration population-lifecycle in MIGRATIONS");
      await F.withStore(driver, async (store) => {
        const r = store.transaction("test.cols", (tx) => tx.prepare("PRAGMA table_info(world_npc_pilots)").all());
        assert.ok(r.ok, JSON.stringify(r));
        const cols = Object.fromEntries(r.value.map((c) => [c.name, c]));
        for (const name of LIFE_COLS) {
          assert.ok(cols[name], `column ${name}`);
          assert.strictEqual(String(cols[name].dflt_value), "0");
          assert.strictEqual(Number(cols[name].notnull), 1);
        }
        const row = { pilotId: 7, systemId: F.sid(3), prevId: 0, destId: 0, homeId: F.sid(3), shipTypeId: 648,
          archetype: 1, intent: 1, state: 5, seq: 4, sinceAt: T0, dueAt: T0 + HOUR, flags: 0, corpId: 0, groupId: 0,
          gen: 3, career: 2, xp: 5, wealth: 7 };
        const w = store.transaction("test.write", (tx) => repo.upsertSliceInTx(tx, [row]));
        assert.ok(w.ok && w.value === 1, JSON.stringify(w));
        const l = store.transaction("test.load", (tx) => repo.loadAll(tx));
        assert.ok(l.ok, JSON.stringify(l));
        assert.deepStrictEqual(l.value.find((x) => x.pilotId === 7), row);
      });
      await F.withStore(driver, async (store) => {
        const { svc } = await booted(store, settingsWith({ ...AWAY_ALL, maxAwayPermille: 0 }));
        svc.runPass(T0 + DAY + HOUR);
        const st = svc.getStatus();
        assert.strictEqual(st.byState.AWAY, 0);
        assert.strictEqual(st.counters["lifecycle.away"], 0);
        assert.ok(st.counters["lifecycle.awayCapped"] > 0, JSON.stringify(st.counters));
        assert.strictEqual(st.lifecycle.awayCap, 0);
        svc.stop();
      });
    });

  test("LC6 NEAR on: the pre-warm name of a reborn pilot = displayNameOf(seed, identityKey(id, gen))", async () => {
    const ROOKIE = F.sid(6);
    await F.withStore(driver, async (store) => {
      const presence = F.fakePresence(F.fakeGraph());
      presence.set([ROOKIE]);
      const S = settingsWith({ ...AWAY_ALL, quitOnReturnPermille: 1000, rookieSystemIds: String(ROOKIE) },
        { near: { enabled: true } });
      const { svc } = await booted(store, S, { presence });
      const t1 = T0 + DAY + HOUR;
      svc.runPass(t1);
      svc.runPass(t1 + HOUR);
      svc.runPass(t1 + HOUR + 60000);
      assert.strictEqual(svc.getStatus().counters["lifecycle.reborn"], N);
      const warm = views(svc).filter((v) => v.near);
      const reborn = warm.filter((v) => v.gen >= 1);
      assert.ok(reborn.length > 0, `a reborn pilot is pre-warmed (${warm.length} warm)`);
      for (const v of warm) {
        assert.strictEqual(v.near.name, displayNameOf(SEED, identityKey(v.pilotId, v.gen)), `pilot ${v.pilotId}`);
      }
      assert.ok(reborn.some((v) => v.gen === 1 && v.near.name !== displayNameOf(SEED, v.pilotId)),
        "a gen 1 name differs from the name of the slot id");
      svc.stop();
    });
  });
};
