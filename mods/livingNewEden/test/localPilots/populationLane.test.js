"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const seamModule = require("../../lib/adapter/localPilots");
const { createPilotStore } = require("../../lib/population/store");
const { STATE: POP_STATE } = require("../../lib/population/schema");
const { createUnavailablePopulation, POPULATION_METHODS } = require("../../lib/population");
const { createUnavailableLocalPilots } = require("../../lib/localPilots");
const { leaseCharacters } = require("../../lib/localPilots/lease");
const { resolveConfig } = require("../../config");
const { mask } = require("../_support/sourceScan");
const LP = require("./localPilots.test").harness;

const MOD_DIR = path.resolve(__dirname, "..", "..");
const S1 = 30000142;
const S2 = 30000144;
const AWAY = 30000999;
const BASE_ID = 91000001;
const civIds = (n) => Array.from({ length: n }, (_, i) => 92000001 + i);

function popRow(pilotId, systemId, state = POP_STATE.ACTIVE) {
  return { pilotId, systemId, prevId: 0, destId: 0, homeId: systemId, shipTypeId: 0, archetype: 1, intent: 1, state,
    seq: 0, sinceAt: 0, dueAt: 0, flags: 0 };
}

function fakePopulation(store, state = "running") {
  const p = { state, calls: { getStatus: 0, localIdsIn: 0 }, limits: [],
    getStatus() {
      p.calls.getStatus += 1;
      return { state: p.state };
    },
    localIdsIn(systemId, limit) {
      p.calls.localIdsIn += 1;
      p.limits.push([systemId, limit]);
      return Object.freeze(store.localIdsIn(systemId, limit));
    } };
  return p;
}

function fakeHighsecLife(civilians) {
  const hs = { calls: { civilianTargets: 0, civilianOrder: 0, civilianChurn: 0 }, notes: [],
    getStatus: () => ({ state: "running" }),
    civilianTargets(systems) {
      hs.calls.civilianTargets += 1;
      return { ok: true, targets: new Map(systems.map((id) => [id, civilians])), bucket: 1 };
    },
    civilianChurn() {
      hs.calls.civilianChurn += 1;
      return new Set();
    },
    civilianOrder(ids) {
      hs.calls.civilianOrder += 1;
      return ids.slice();
    },
    noteCivilians: (m) => hs.notes.push(new Map([...m].map(([k, v]) => [k, [...v]]))) };
  return hs;
}

function scene(opts) {
  const metrics = [];
  const telemetry = {};
  for (const kind of ["count", "gauge", "observe"]) {
    telemetry[kind] = (name, value) => metrics.push([kind, name, kind === "observe" ? "ms" : value]);
  }
  const pool = opts.pool || civIds(10);
  const w = LP.world();
  for (const id of pool) if (!w.records.has(id)) w.records.set(id, { corporationID: 98700001, allianceID: 0 });
  const env = LP.boot({ world: w, telemetry, settings: { maxPilotsPerSystem: opts.maxPilots || 40 },
    presenceState: { observed: opts.observed || [S1] },
    fleets: new Map([[S1, [LP.fleet(LP.FACTION, null, 1)]]]),
    virtualCorps: { listCivilianCandidates: () => ({ ok: true, version: 1, characterIds: pool.slice() }) },
    ...(opts.highsecLife ? { highsecLife: opts.highsecLife } : {}),
    ...(opts.population ? { population: opts.population } : {}),
    ...(opts.populationConfig ? { populationConfig: opts.populationConfig } : {}) });
  return { ...env, metrics };
}

const LIVE_ON = (max = 100) => ({ enabled: true, live: { localEnabled: true, maxLocalPerSystem: max } });

function lastRoster(log) {
  const out = new Map();
  for (const [sid, ids] of log.setRoster) out.set(sid, ids);
  return out;
}

function leaseOf(lp, pilotIds) {
  return pilotIds.map((id) => lp.populationLeaseOf(id).characterId);
}

module.exports = ({ test }) => {
  test("PL1 flag off / population failed: the civilian pass bit for bit, zero calls into the population", () => {
    const run = (opts) => {
      try {
        const hs = fakeHighsecLife(2);
        const env = scene({ highsecLife: hs, ...opts });
        assert.deepStrictEqual(env.lp.runPassNow(), { ok: true });
        assert.deepStrictEqual(env.lp.runPassNow(), { ok: true });
        const { ms: _ms, ...lastPass } = env.lp.getStatus().lastPass;
        return { setRoster: env.vendor.log.setRoster, repush: env.vendor.log.repush, lastPass, metrics: env.metrics,
          notes: hs.notes, hsCalls: hs.calls, speakers: env.lp.speakersOf(S1).civilians };
      } finally {
        seamModule._resetForTest();
      }
    };
    const store = createPilotStore(10);
    store.put(popRow(1, S1));
    const plain = run({});
    assert.deepStrictEqual(plain.lastPass.civilians.assigned, 2, "the civilian step ran");
    const offSpy = fakePopulation(store);
    assert.deepStrictEqual(run({ population: offSpy, populationConfig: { enabled: true,
      live: { localEnabled: false, maxLocalPerSystem: 100 } } }), plain, "flag off");
    assert.deepStrictEqual(offSpy.calls, { getStatus: 0, localIdsIn: 0 }, "flag off: no call at all");
    const noSection = fakePopulation(store);
    assert.deepStrictEqual(run({ population: noSection }), plain, "no population section");
    assert.deepStrictEqual(noSection.calls, { getStatus: 0, localIdsIn: 0 });
    const failed = fakePopulation(store, "failed");
    assert.deepStrictEqual(run({ population: failed, populationConfig: LIVE_ON() }), plain, "population failed");
    assert.strictEqual(failed.calls.localIdsIn, 0, "population failed: no localIdsIn");
    assert.strictEqual(plain.lastPass.population, undefined);
    assert.ok(!plain.metrics.some((m) => /localPilots\.population/.test(m[1])), "no population metric");
  });

  test("PL2 lease: 14 pilots on a pool of 10 -> 10 unique characters, shortfall 4; base never leased; room and "
    + "maxLocalPerSystem cut want; POD out", () => {
    try {
      const store = createPilotStore(20);
      for (let id = 1; id <= 10; id += 1) store.put(popRow(id, S1, id === 2 ? POP_STATE.POD : POP_STATE.ACTIVE));
      for (let id = 11; id <= 16; id += 1) store.put(popRow(id, S2));
      const pop = fakePopulation(store);
      const env = scene({ observed: [S1, S2], maxPilots: 9, pool: [BASE_ID, ...civIds(10)], population: pop,
        populationConfig: LIVE_ON(8) });
      assert.deepStrictEqual(env.lp.runPassNow(), { ok: true });
      assert.deepStrictEqual(pop.limits, [[S1, 8], [S2, 8]]);
      assert.deepStrictEqual([...store.localIdsIn(S1, 8)], [1, 3, 4, 5, 6, 7, 8, 9], "POD pilot 2 out, cut at 8");
      const roster = lastRoster(env.vendor.log);
      const r1 = roster.get(S1);
      const r2 = roster.get(S2) || [];
      assert.strictEqual(r1[0], BASE_ID, "base first");
      const leased = [...r1.slice(1), ...r2];
      assert.strictEqual(leased.length, 10);
      assert.strictEqual(new Set(leased).size, 10, "never twice, also across systems");
      assert.ok(!leased.includes(BASE_ID), "the base character is never leased");
      assert.ok(leased.every((id) => civIds(10).includes(id)));
      assert.deepStrictEqual(env.lp.getStatus().lastPass.population,
        { wanted: 14, assigned: 10, shortfall: 4, pool: 11 });
      assert.strictEqual(env.lp.populationLeaseOf(2).characterId, null, "POD: no lease");
      assert.deepStrictEqual(env.metrics.filter((m) => m[1] === "localPilots.populationShortfall"),
        [["count", "localPilots.populationShortfall", 4]]);
      assert.deepStrictEqual(env.metrics.filter((m) => m[1] === "localPilots.population"),
        [["gauge", "localPilots.population", 10]]);
      const empty = leaseCharacters({ poolIds: [], demand: [{ systemId: S1, pilotIds: [1, 3] }], previous: new Map(),
        taken: new Set() });
      assert.deepStrictEqual([empty.assigned, empty.shortfall, empty.bySystem.size], [0, 2, 0]);
      env.lp.stop("test");
      assert.deepStrictEqual(env.metrics.filter((m) => m[1] === "localPilots.population").slice(-1),
        [["gauge", "localPilots.population", 0]], "stop closes the gauge");
      assert.deepStrictEqual(env.lp.populationLeaseOf(1), { ok: false, reason: "NOT_RUNNING" });
    } finally {
      seamModule._resetForTest();
    }
  });

  test("PL3 stickiness: leave releases, another pilot takes it, back = same character if free, restart = same "
    + "roster", () => {
    try {
      const store = createPilotStore(20);
      for (const id of [1, 2, 3]) store.put(popRow(id, S1));
      const env = scene({ population: fakePopulation(store), populationConfig: LIVE_ON() });
      assert.deepStrictEqual(env.lp.runPassNow(), { ok: true });
      const first = leaseOf(env.lp, [1, 2, 3]);
      const firstRoster = lastRoster(env.vendor.log).get(S1);
      assert.ok(first.every((c) => c !== null));
      store.apply(1, { systemId: AWAY });
      assert.deepStrictEqual(env.lp.runPassNow(), { ok: true });
      assert.strictEqual(env.lp.populationLeaseOf(1).characterId, null, "left LIVE -> no lease");
      assert.ok(!lastRoster(env.vendor.log).get(S1).includes(first[0]), "its character left Local");
      assert.deepStrictEqual(leaseOf(env.lp, [2, 3]), first.slice(1), "the others keep theirs");
      store.apply(1, { systemId: S1 });
      assert.deepStrictEqual(env.lp.runPassNow(), { ok: true });
      assert.deepStrictEqual(leaseOf(env.lp, [1, 2, 3]), first, "back -> the same character");
      env.lp.stop("test");
      seamModule._resetForTest();

      const again = scene({ population: fakePopulation(store), populationConfig: LIVE_ON() });
      assert.deepStrictEqual(again.lp.runPassNow(), { ok: true });
      assert.deepStrictEqual(lastRoster(again.vendor.log).get(S1), firstRoster, "restart: same roster");
      again.lp.stop("test");
      seamModule._resetForTest();

      const full = createPilotStore(20);
      for (const id of [1, 2, 3]) full.put(popRow(id, S1));
      const tight = scene({ pool: civIds(3), population: fakePopulation(full), populationConfig: LIVE_ON() });
      assert.deepStrictEqual(tight.lp.runPassNow(), { ok: true });
      const c1 = tight.lp.populationLeaseOf(1).characterId;
      full.apply(1, { systemId: AWAY });
      full.put(popRow(4, S1));
      assert.deepStrictEqual(tight.lp.runPassNow(), { ok: true });
      assert.strictEqual(tight.lp.populationLeaseOf(4).characterId, c1, "another pilot takes the freed character");
      full.apply(1, { systemId: S1 });
      assert.deepStrictEqual(tight.lp.runPassNow(), { ok: true });
      assert.deepStrictEqual([tight.lp.populationLeaseOf(4).characterId, tight.lp.populationLeaseOf(1).characterId],
        [c1, null], "not free -> no lease for the returning pilot");
      assert.strictEqual(tight.lp.getStatus().lastPass.population.shortfall, 1);
      tight.lp.stop("test");
    } finally {
      seamModule._resetForTest();
    }
  });

  test("PL4 never both lanes: no civilian targets / order / churn in the population lane; notes and speakers get "
    + "the leases; a lane switch both ways clears the other lane", () => {
    try {
      const store = createPilotStore(20);
      for (const id of [5, 6]) store.put(popRow(id, S1));
      const hs = fakeHighsecLife(3);
      const pop = fakePopulation(store, "starting");
      const env = scene({ highsecLife: hs, population: pop, populationConfig: LIVE_ON() });
      assert.deepStrictEqual(env.lp.runPassNow(), { ok: true });
      assert.strictEqual(env.lp.getStatus().lastPass.civilians.assigned, 3);
      assert.strictEqual(pop.calls.localIdsIn, 0);
      const civCalls = { ...hs.calls };
      pop.state = "running";
      assert.deepStrictEqual(env.lp.runPassNow(), { ok: true });
      assert.deepStrictEqual(hs.calls, civCalls, "no civilianTargets / civilianOrder / civilianChurn");
      const leases = leaseOf(env.lp, [5, 6]);
      assert.ok(leases.every((c) => c !== null));
      assert.deepStrictEqual(lastRoster(env.vendor.log).get(S1), [BASE_ID, ...leases], "base + leases, no civilians");
      assert.deepStrictEqual(hs.notes.slice(-1), [new Map([[S1, leases]])], "noteCivilians = the population roster");
      assert.deepStrictEqual(env.lp.speakersOf(S1).civilians, [...leases].sort((a, b) => a - b));
      const pass2 = env.lp.getStatus().lastPass;
      assert.strictEqual(pass2.civilians, undefined, "no civilian lastPass in the population lane");
      assert.deepStrictEqual(pass2.population, { wanted: 2, assigned: 2, shortfall: 0, pool: 10 });
      assert.deepStrictEqual(env.metrics.filter((m) => /highsecLife/.test(m[1]) && m[0] === "gauge").slice(-2)
        .map((m) => m[2]), [0, 0], "the civilian gauges closed");
      pop.state = "stopped";
      assert.deepStrictEqual(env.lp.runPassNow(), { ok: true });
      assert.deepStrictEqual(leaseOf(env.lp, [5, 6]), [null, null]);
      assert.strictEqual(hs.calls.civilianTargets, civCalls.civilianTargets + 1);
      assert.strictEqual(hs.calls.civilianChurn, civCalls.civilianChurn, "cleared bucket -> no churn call");
      assert.strictEqual(env.lp.getStatus().lastPass.civilians.assigned, 3);
      assert.deepStrictEqual(env.metrics.filter((m) => m[1] === "localPilots.population").map((m) => m[2]), [2, 0],
        "the population gauge closes with one 0");
      env.lp.stop("test");
    } finally {
      seamModule._resetForTest();
    }
  });

  test("PL5 source and config: no identity saga from the population or lease.js; stub localIdsIn; defaults; W199",
    () => {
      const files = [path.join(MOD_DIR, "lib", "localPilots", "lease.js")];
      const popDir = path.join(MOD_DIR, "lib", "population");
      for (const name of fs.readdirSync(popDir)) if (name.endsWith(".js")) files.push(path.join(popDir, name));
      const offenders = [];
      for (const file of files) {
        const text = mask(fs.readFileSync(file, "utf8"), { strings: false });
        if (/ensureOwnerIdentity|ensureIdentities|virtualCorps|highsecLife|localPilots|identitySaga/.test(text)) {
          offenders.push(path.basename(file));
        }
      }
      assert.deepStrictEqual(offenders, []);
      const stub = createUnavailablePopulation("disabled_by_config");
      assert.ok(POPULATION_METHODS.includes("localIdsIn"));
      assert.deepStrictEqual(stub.localIdsIn(S1, 10), []);
      assert.deepStrictEqual(createUnavailableLocalPilots("off").populationLeaseOf(1),
        { ok: false, reason: "NOT_RUNNING" });

      const def = resolveConfig({ modDir: MOD_DIR, env: {} });
      assert.deepStrictEqual(def.config.population.live, { localEnabled: false, maxLocalPerSystem: 100,
        trafficEnabled: false, trafficMode: "replace", cloneDelayMs: 1800000, ownMaxMs: 900000, maxEventAgeMs: 60000,
        spawnGapMs: 15000, maxSpawnsPerSystemPass: 2,
        standingAggroEnabled: false, standingAggroRangeMeters: 100000, standingAggroMaxSystemsPerPass: 4,
        standingAggroMaxAttackers: 2, standingAggroMaxCandidates: 32, standingAggroHoldMs: 120000,
        standingAggroCooldownMs: 60000,
        vendorRatAggroEnabled: false, vendorRatAggroMaxPerSystemWindow: 1, vendorRatAggroWindowMs: 3600000 });
      assert.ok(!def.warnings.some((w) => /population\.live/.test(w)));
      const alone = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_POPULATION_LIVE_LOCAL_ENABLED: "1" } });
      assert.ok(alone.warnings.some((w) => w.startsWith("population.live.localEnabled without population.enabled")),
        alone.warnings.join(" | "));
      const noCiv = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_POPULATION_LIVE_LOCAL_ENABLED: "1",
        EVEJS_LNE_POPULATION_ENABLED: "1" } });
      assert.ok(noCiv.warnings.some((w) => /civilian character pool may be empty/.test(w)));
    });
};
