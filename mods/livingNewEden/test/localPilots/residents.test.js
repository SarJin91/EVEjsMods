"use strict";

const assert = require("node:assert");
const path = require("node:path");

const seamModule = require("../../lib/adapter/localPilots");
const { createUnavailableFreeCorps } = require("../../lib/freeCorps");
const { resolveConfig } = require("../../config");
const LP = require("./localPilots.test").harness;

const MOD_DIR = path.resolve(__dirname, "..", "..");
const S = 30000142;
const CIVS = Object.freeze([92000001, 92000002]);
const RESIDENTS = Object.freeze([93000001, 93000002, 93000003, 93000004, 93000005]);
const FC_ON = Object.freeze({ enabled: true, local: { enabled: true } });

function worldWith(extra) {
  const w = LP.world();
  for (const id of [...CIVS, ...RESIDENTS]) w.records.set(id, { corporationID: 98700001, allianceID: 0 });
  for (const id of extra || []) w.records.delete(id);
  return w;
}

function fakeFreeCorps(ids, state = "running") {
  const fc = { calls: 0, getStatus: () => ({ state }),
    residentsFor(systems, atMs) {
      fc.calls += 1;
      assert.ok(Array.isArray(systems) && Number.isFinite(atMs));
      return { ok: true, bySystem: new Map([[S, ids.slice()]]), bucket: 0, cut: 0, cached: false };
    } };
  return fc;
}

function fakeHighsecLife() {
  const hs = { residentNotes: [], getStatus: () => ({ state: "running" }),
    civilianTargets: (systems) => ({ ok: true, targets: new Map(systems.map((id) => [id, CIVS.length])), bucket: 1 }),
    civilianChurn: () => new Set(), civilianOrder: (ids) => ids.slice(), noteCivilians: () => {},
    noteResidents: (m) => hs.residentNotes.push(new Map([...m].map(([k, v]) => [k, [...v]]))) };
  return hs;
}

function scene(opts) {
  const metrics = [];
  const telemetry = {};
  for (const kind of ["count", "gauge", "observe"]) {
    telemetry[kind] = (name, value) => metrics.push([kind, name, kind === "observe" ? "ms" : value]);
  }
  const hs = opts.civilians ? fakeHighsecLife() : null;
  const env = LP.boot({ world: opts.world || worldWith(), telemetry, settings: { maxPilotsPerSystem: 6 },
    presenceState: { observed: [S] }, fleets: new Map([[S, [LP.fleet(LP.FACTION, null, 1)]]]),
    ...(hs ? { highsecLife: hs, virtualCorps: { listCivilianCandidates: () => ({ ok: true,
      version: 1, characterIds: CIVS.slice() }) } } : {}),
    ...(opts.freeCorps ? { freeCorps: opts.freeCorps } : {}),
    ...(opts.freeCorpsConfig ? { freeCorpsConfig: opts.freeCorpsConfig } : {}) });
  return { ...env, metrics, hs };
}

const lastRoster = (log) => {
  const out = new Map();
  for (const [sid, ids] of log.setRoster) out.set(sid, ids);
  return out;
};

module.exports = ({ test }) => {
  test("FC4-2 base -> civilians -> residents: room cut, lastPass.residents, one repush, no repush on the same "
    + "answer, no record -> noRecord, a resident equal to a civilian dropped", () => {
    try {
      const fc = fakeFreeCorps(RESIDENTS);
      const env = scene({ civilians: true, freeCorps: fc, freeCorpsConfig: FC_ON });
      assert.deepStrictEqual(env.lp.runPassNow(), { ok: true });
      assert.deepStrictEqual(lastRoster(env.vendor.log).get(S), [91000001, ...CIVS, ...RESIDENTS.slice(0, 3)]);
      assert.deepStrictEqual(env.lp.getStatus().lastPass.residents, { wanted: 5, assigned: 3, cut: 2 });
      assert.deepStrictEqual(env.vendor.log.repush, [S]);
      assert.deepStrictEqual(env.metrics.filter((m) => m[1] === "localPilots.residents"), [["gauge",
        "localPilots.residents", 3]]);
      assert.deepStrictEqual(env.lp.runPassNow(), { ok: true });
      assert.deepStrictEqual(env.vendor.log.repush, [S], "same roster -> no repush");
      assert.strictEqual(fc.calls, 2);
      assert.deepStrictEqual(env.hs.residentNotes, [], "FC5-3: freeCorps.chatter off -> no noteResidents");
      env.lp.stop("test");
      assert.deepStrictEqual(env.metrics.filter((m) => m[1] === "localPilots.residents").slice(-1),
        [["gauge", "localPilots.residents", 0]], "stop closes the gauge");
      seamModule._resetForTest();

      const chat = scene({ civilians: true, freeCorps: fakeFreeCorps(RESIDENTS),
        freeCorpsConfig: { ...FC_ON, chatter: { enabled: true } } });
      assert.deepStrictEqual(chat.lp.runPassNow(), { ok: true });
      assert.deepStrictEqual(chat.hs.residentNotes, [new Map([[S, RESIDENTS.slice(0, 3)]])]);
      chat.lp.stop("test");
      assert.deepStrictEqual(chat.hs.residentNotes.slice(-1), [new Map()], "stop sends an empty roster");
      seamModule._resetForTest();

      const missing = 93000009;
      const env2 = scene({ civilians: true, freeCorpsConfig: FC_ON,
        freeCorps: fakeFreeCorps([missing, CIVS[0], ...RESIDENTS.slice(0, 2)]) });
      const before = env2.lp.getStatus().noRecord;
      assert.deepStrictEqual(env2.lp.runPassNow(), { ok: true });
      const roster = lastRoster(env2.vendor.log).get(S);
      assert.deepStrictEqual(roster, [91000001, ...CIVS, ...RESIDENTS.slice(0, 2)]);
      assert.strictEqual(new Set(roster).size, roster.length, "no character twice");
      assert.strictEqual(env2.lp.getStatus().noRecord - before, 1, "no record -> noRecord");
      env2.lp.stop("test");
    } finally {
      seamModule._resetForTest();
    }
  });

  test("FC4-3 flag off = zero residentsFor calls and the pass bit for bit (local off, freeCorps off, stub); "
    + "defaults of both flags false", () => {
    const run = (opts) => {
      try {
        const env = scene(opts);
        assert.deepStrictEqual(env.lp.runPassNow(), { ok: true });
        const { ms: _ms, ...lastPass } = env.lp.getStatus().lastPass;
        return { setRoster: env.vendor.log.setRoster, repush: env.vendor.log.repush, lastPass, metrics: env.metrics };
      } finally {
        seamModule._resetForTest();
      }
    };
    const plain = run({});
    const stub = createUnavailableFreeCorps("disabled_by_config");
    let stubCalls = 0;
    const counted = { ...stub, residentsFor: (...a) => {
      stubCalls += 1;
      return stub.residentsFor(...a);
    } };
    const variants = [
      { name: "local off", fc: fakeFreeCorps(RESIDENTS), cfg: { enabled: true, local: { enabled: false } } },
      { name: "freeCorps off", fc: fakeFreeCorps(RESIDENTS), cfg: { enabled: false, local: { enabled: true } } },
      { name: "stub", fc: counted, cfg: FC_ON },
    ];
    for (const v of variants) {
      assert.deepStrictEqual(run({ freeCorps: v.fc, freeCorpsConfig: v.cfg }), plain, v.name);
      if (v.fc.calls !== undefined) assert.strictEqual(v.fc.calls, 0, v.name);
    }
    assert.strictEqual(stubCalls, 0, "stub: no call");
    assert.strictEqual(plain.lastPass.residents, undefined);
    const def = resolveConfig({ modDir: MOD_DIR, env: {} }).config.freeCorps;
    assert.deepStrictEqual([def.local.enabled, def.map.enabled], [false, false]);
  });

  test("TRV5 speakersOf: the civilians and residents of the last pass as sorted copies; a changed result never "
    + "reaches the service; BAD_SYSTEM; stop and stub = NOT_RUNNING", () => {
    try {
      const env = scene({ civilians: true, freeCorps: fakeFreeCorps([...RESIDENTS].reverse()), freeCorpsConfig: FC_ON });
      assert.deepStrictEqual(env.lp.speakersOf(S), { ok: true, civilians: [], residents: [], atMs: null },
        "before the first pass");
      assert.deepStrictEqual(env.lp.runPassNow(), { ok: true });
      const first = env.lp.speakersOf(S);
      assert.strictEqual(first.ok, true);
      assert.deepStrictEqual([first.civilians, first.residents],
        [[...CIVS], [...RESIDENTS].reverse().slice(0, 3).sort((a, b) => a - b)]);
      assert.ok(Number.isFinite(first.atMs), "atMs of the pass");
      first.civilians.push(1);
      first.residents.length = 0;
      const again = env.lp.speakersOf(S);
      assert.deepStrictEqual([again.civilians, again.residents.length], [[...CIVS], 3], "the memory is unchanged");
      assert.deepStrictEqual(env.lp.speakersOf(S + 1), { ok: true, civilians: [], residents: [], atMs: first.atMs });
      assert.deepStrictEqual(env.lp.speakersOf(0), { ok: false, reason: "BAD_SYSTEM" });
      env.lp.stop("test");
      assert.deepStrictEqual(env.lp.speakersOf(S), { ok: false, reason: "NOT_RUNNING" });
      const { createUnavailableLocalPilots } = require("../../lib/localPilots");
      assert.deepStrictEqual(createUnavailableLocalPilots("off").speakersOf(S), { ok: false, reason: "NOT_RUNNING" });
    } finally {
      seamModule._resetForTest();
    }
  });
};
