"use strict";

const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");

const config = require("../../config");
const { createJournal } = require("../../lib/persistence/journal");
const { startHeavyEvents } = require("../../lib/heavyEvents");
const { createHeavyEventRepository } = require("../../lib/heavyEvents/repository");
const { createHeavyEventPayoutRepository } = require("../../lib/heavyEvents/payoutRepository");
const { startFactionIncursions } = require("../../lib/factionIncursions");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const T0 = 1760000000000;
const TRIG = 500026;
const DEFENDER = 500001;
const CHAR = 91000007;
const CONSTELLATION = 20000001;
const REGION = 10000001;
const SYS = Object.freeze([30000001, 30000002, 30000003, 30000004, 30000005, 30000006, 30000007]);
const TARGET = SYS[0];
const EDGES = Object.freeze([[0, 1], [0, 2], [1, 3], [2, 4], [3, 5], [0, 6]]);
const BASE_ENV = Object.freeze({ EVEJS_DATA_ROOT: os.tmpdir(), EVEJS_LNE_FACTION_INCURSIONS_ENABLED: "1",
  EVEJS_LNE_FACTION_INCURSIONS_SETTLE_ENABLED: "1" });

function fakeGraph(systems, edges) {
  const byId = new Map(systems.map((s) => [s.id, Object.freeze({ ...s })]));
  const nb = new Map(systems.map((s) => [s.id, []]));
  for (const [a, b] of edges) {
    nb.get(a).push(b);
    nb.get(b).push(a);
  }
  for (const list of nb.values()) list.sort((x, y) => x - y);
  return Object.freeze({ getSystem: (id) => byId.get(id) || null, getNeighbors: (id) => (nb.has(id) ? nb.get(id) : null) });
}

function constellationGraph() {
  return fakeGraph(SYS.map((id, i) => ({ id, constellationId: CONSTELLATION, regionId: REGION,
    secClass: i === 6 ? "lowsec" : "nullsec" })), EDGES.map(([a, b]) => [SYS[a], SYS[b]]));
}

const configCache = new Map();
function cfg(env = {}) {
  const key = JSON.stringify(env);
  if (!configCache.has(key)) {
    const r = config.resolveConfig({ modDir: MOD_DIR, env: { ...BASE_ENV, ...env } });
    assert.deepStrictEqual(r.errors || [], []);
    configCache.set(key, r.config);
  }
  return configCache.get(key);
}

function heavyConfigOf(c) {
  return { ...c, modules: { ...c.modules, world: { ...c.modules.world, enabled: true },
    sites: { ...c.modules.sites, enabled: true } }, heavyEvents: { ...c.heavyEvents, enabled: false },
    powerSites: { ...c.powerSites, enabled: false }, eventAnomalies: { ...c.eventAnomalies, enabled: false } };
}

const run = (store, fn) => {
  const r = store.transaction("t", fn);
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
};

function harness(store, opts = {}) {
  const claimFactionId = opts.factionId || TRIG;
  const h = { now: T0, claimFactionId, claims: [{ systemId: TARGET, occupationState: "INVASION", phaseSeq: 3,
    controllerFactionId: DEFENDER, influence: [{ factionId: claimFactionId, influenceScore: 0 }] }] };
  const clock = { now: () => h.now };
  const journal = createJournal({ clock, maxPayloadBytes: 16384, maxRows: 500 });
  const sites = { calls: [],
    createSiteInTx(tx, req) {
      assert.strictEqual(tx.inTransaction, true);
      this.calls.push(["create", req.eventId, req.label, req.siteKind || null]);
      return { ok: true, siteKey: `${req.eventId}:0`, created: true, state: "CREATING" };
    },
    cleanupSitesInTx(tx, eventId, reason) {
      assert.strictEqual(tx.inTransaction, true);
      this.calls.push(["cleanup", eventId, reason]);
      return { ok: true, released: 1 };
    },
    countLive: () => ({ ok: true, count: 0 }) };
  const occupation = { repel: [], drops: [], next: [], dropNext: [], dropAuxRows: 9,
    applyPlayerRepelInTx(tx, spec, key) {
      assert.strictEqual(tx.inTransaction, true);
      this.repel.push({ spec, key });
      return this.next.length > 0 ? this.next.shift() : { ok: true, outcome: "APPLIED", state: "INVASION" };
    },
    dropInfluenceInTx(tx, spec, key) {
      assert.strictEqual(tx.inTransaction, true);
      this.drops.push({ spec, key });
      const forced = this.dropNext.length > 0 ? this.dropNext.shift() : null;
      if (forced) return forced;
      const ap = journal.applyOnce(tx, { key, aggregate: { type: "world_system", id: String(spec.systemId) },
        eventType: "FAKE_INFLUENCE_DROP", payload: { ...spec } }, (db) => {
        for (let i = 0; i < this.dropAuxRows; i += 1) {
          const aux = journal.applyOnce(db, { key: `${key}:aux:${i}`, aggregate: { type: "world_system",
            id: String(spec.systemId) }, eventType: "FAKE_INFLUENCE_AUX", payload: { i } }, () => ({ ok: true }));
          if (!aux.ok) return aux;
        }
        return { ok: true };
      });
      if (!ap.ok) return { ok: false, reason: "OCCUPATION_DROP_FAILED" };
      return ap.duplicate ? { ok: true, outcome: "DUPLICATE" } : { ok: true, outcome: "APPLIED", written: true };
    } };
  h.systems = {};
  h.getSystemsCalls = 0;
  const worldRepository = {
    listByOccupier: (_db, factionId) => ({ ok: true, nextAfterSystemId: null,
      systems: factionId === h.claimFactionId ? h.claims : [] }),
    getSystem: (_tx, id) => ({ ok: true, system: { systemId: id, controllerFactionId: DEFENDER } }),
    getSystems: (db, ids, opts) => {
      assert.strictEqual(db.inTransaction, true);
      assert.deepStrictEqual(opts, { includeInfluence: false });
      h.getSystemsCalls += 1;
      const systems = ids.filter((id) => h.systems[id]).map((id) => ({ systemId: id, ...h.systems[id] }));
      return { ok: true, systems, missing: ids.filter((id) => !h.systems[id]) };
    },
  };
  const graph = constellationGraph();
  const ctx = { persistence: { ok: true, store, journal, worldSeed: 7 },
    stations: { getMode: () => "ready", repository: null }, sites, occupation, world: { repository: worldRepository },
    graph: { getGraph: () => ({ ok: true, graph }) } };
  const noTimer = () => ({ cancel() {}, hasRef: () => false });
  const startHeavy = (c) => startHeavyEvents({ config: heavyConfigOf(c), ctx, clock, getFactionKind: () => "faction",
    setTimer: noTimer, logger: { log() {} } });
  const lines = [];
  const startFi = (c) => startFactionIncursions({ config: c, persistence: ctx.persistence, clock,
    logger: { log: (l) => lines.push(l) }, getWorldRepository: () => worldRepository,
    getOccupation: () => occupation, getHeavyEvents: () => ctx.heavyEvents || null, getGraph: () => ctx.graph,
    setTimer: noTimer });
  const repo = createHeavyEventRepository({ journal });
  const payouts = createHeavyEventPayoutRepository();
  const clearSite = (eventId, at, withPayout) => run(store, (tx) => {
    let row = repo.getInTx(tx, eventId).row;
    assert.ok(row, `no row ${eventId}`);
    const e = repo.transitionInTx(tx, { eventId, expectedVersion: row.version, from: "PLANNED", to: "ENGAGED",
      patch: { engagedAt: at }, at });
    assert.ok(e.ok, JSON.stringify(e));
    row = e.row;
    const c = repo.transitionInTx(tx, { eventId, expectedVersion: row.version, from: "ENGAGED", to: "CLEARED",
      patch: { rewardState: "PENDING" }, at, reason: "CLEARED" });
    assert.ok(c.ok, JSON.stringify(c));
    if (withPayout) {
      assert.ok(payouts.planPayoutsInTx(tx, { eventId, issuerFactionId: DEFENDER, systemId: row.systemId,
        characterIds: [CHAR], iskAmount: 0, lpAmount: 0, standingMicro: 0, at }).ok);
    }
  });
  const heavyRow = (eventId) => run(store, (tx) => repo.getInTx(tx, eventId).row);
  const heavyOpen = () => run(store, (tx) => repo.listOpenInTx(tx, { limit: 64 }).rows);
  const incursion = (id) => run(store, (tx) => tx.prepare(
    "SELECT state, outcome, effect, attempts, influence_milli, decided_at, hq_event_id FROM world_faction_incursions "
    + "WHERE incursion_id = ?").get(id) || null);
  const count = () => Number(run(store, (tx) => tx.prepare("SELECT count(*) AS n FROM world_faction_incursions")
    .get().n));
  const slots = (id) => run(store, (tx) => tx.prepare("SELECT slot_key, state, event_id, incarnation, clears "
    + "FROM world_faction_incursion_sites WHERE incursion_id = ? ORDER BY slot_key").all(id))
    .map((r) => ({ slot: r.slot_key, state: r.state, eventId: r.event_id, inc: Number(r.incarnation),
      clears: Number(r.clears) }));
  return Object.assign(h, { clock, journal, sites, occupation, worldRepository, graph, ctx, startHeavy, startFi, repo,
    payouts, clearSite, heavyRow, heavyOpen, incursion, count, slots, lines, run: (fn) => run(store, fn) });
}

function boot(h, env = {}) {
  const c = cfg(env);
  if (!h.ctx.heavyEvents) {
    const heavy = h.startHeavy(c);
    assert.ok(heavy.ok, JSON.stringify(heavy));
    h.ctx.heavyEvents = heavy.heavyEvents;
  }
  const fi = h.startFi(c);
  assert.ok(fi.ok, JSON.stringify(fi));
  return fi.factionIncursions;
}

module.exports = { T0, TRIG, DEFENDER, CHAR, CONSTELLATION, REGION, SYS, TARGET, cfg, heavyConfigOf, fakeGraph,
  constellationGraph, harness, boot };
