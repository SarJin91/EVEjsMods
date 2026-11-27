"use strict";

const assert = require("node:assert");
const path = require("node:path");

const config = require("../../config");
const { createMapWindow } = require("../../lib/inGameMap/window/service");
const { mergeCorpMarks } = require("../../lib/inGameMap/window/corpMarks");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const CHAR = 90000001;
const CHAR2 = 90000002;
const CHAR3 = 90000003;
const CORP_A = 98000001;
const CORP_B = 98000002;
const R1 = 10000001;
const R2 = 10000002;
const ON = { EVEJS_LNE_INGAME_MAP_ENABLED: "1", EVEJS_LNE_INGAME_MAP_WINDOW_ENABLED: "1" };
const SIGHTING_ROW = [6, "sighting", 0x60, 0xff, 0x90];

function resolve(env) {
  const r = config.resolveConfig({ modDir: MOD_DIR, env });
  assert.ok(r.ok, JSON.stringify(r.errors));
  return r.config;
}

function withMap(cfg, over) {
  return { ...cfg, inGameMap: { ...cfg.inGameMap, ...over } };
}

function fakeViews(extraEvents) {
  const defs = new Map();
  const add = (id, data, key) => defs.set(id, { data, key });
  add("galaxy-static", { available: true, key: "g1",
    systems: { count: 8, id: [30000001, 30000002, 30000003, 30000004, 30000005, 30000006, 30000007, 30000008],
      x: [0, 10, 20, 30, 60, 70, 80, 90], y: [0, 5, 0, 5, 0, 5, 0, 5], sec: [5, 4, 3, 2, -1, -2, -3, -4],
      cls: [0, 1, 1, 1, 2, 2, 2, 2], region: [0, 0, 0, 0, 1, 1, 1, 1],
      name: ["A", "B", "C", "D", "E", "F", "G", "H"] },
    regions: [[R1, "The Forge"], [R2, "Lonetrek"]], edges: [0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7] }, "g1");
  add("galaxy-state", { available: true, key: "s1", systems: [[30000001, 500001, "STABLE", []]], names: [],
    bastions: [] }, "s1");
  add("layer-fleets", { available: true, items: [[[30000001, 30000002, 30000003], 0, 0.5, "5", [], 500001]] }, "f1");
  add("layer-battles-open", { available: true, items: [[30000006, 0, "b", ["x", "y"], null]] }, "b1");
  add("layer-events", { available: true, items: extraEvents ? [[30000001, 0, "e", ["a"], null],
    [30000004, 0, "e", ["a"], null]] : [] }, "e1");
  add("layer-invasions", { available: true, items: [[30000003, 0, "i", ["z"], null]] }, "i1");
  return { getView: (id) => {
    const d = defs.get(id);
    return d ? { cacheKey: () => d.key, getData: () => d.data } : null;
  } };
}

function fakePosts(byCorp) {
  const calls = [];
  return { calls, markersFor(q) {
    calls.push(q);
    return { ok: true, markers: byCorp[q.corpId] || [], truncated: false };
  } };
}

function rig(cfg, opts = {}) {
  const now = { t: 6000000 };
  const counts = {};
  const adapter = { handlers: null, registerMapClientService(world, spec) {
    adapter.handlers = spec.handlers;
    return { ok: true, unregister() {} };
  }, boardHookState: () => ({ status: "ABSENT" }), publishClientPart: () => ({ ok: false, reason: "BAD_PART" }),
  sendMapNotification: () => ({ ok: false, reason: "NO_SESSION" }) };
  const ctx = { views: fakeViews(opts.extraEvents) };
  if (opts.posts) ctx.listeningPosts = opts.posts;
  const w = createMapWindow({ config: cfg, ctx, adapter, world: {}, clock: { now: () => now.t },
    telemetry: { count: (name, n) => {
      counts[name] = (counts[name] || 0) + n;
    }, observe: () => {} }, log: () => {}, nowMs: () => 0 });
  assert.strictEqual(w.ok, true, JSON.stringify(w));
  const call = (characterId, corporationId, args) => adapter.handlers.GetMap({ characterId, systemId: 30000001,
    corporationId, args, badArgs: false });
  return { now, counts, call, ctx };
}

const sight = (systemId, count, factionId = 500001) => ({ systemId, factionId, sizeClass: "small", count,
  lastSeenAt: 1 });

module.exports = ({ test }) => {
  test("LPM1 shape + cut: [6, idx, sum], mkl kind 6, off-scope absent, trunc.mk, no mutation, galaxy", () => {
    const cfg = resolve(ON);
    const posts = fakePosts({ [CORP_A]: [sight(30000002, 2), sight(30000002, 3, 500002), sight(30000008, 4)] });
    const r = rig(cfg, { posts });
    const base = r.call(CHAR2, 0, [1, "region", R1, "", ""]);
    assert.deepStrictEqual(base.state.mk, [[1, 1, 1], [4, 2, 1]]);
    const a = r.call(CHAR, CORP_A, [1, "region", R1, "", ""]);
    assert.strictEqual(a.ok, true, JSON.stringify(a));
    assert.deepStrictEqual(a.state.mk, [[1, 1, 1], [4, 2, 1], [6, 1, 5]], "two groups summed, 30000008 off the scope");
    assert.deepStrictEqual(a.state.mkl[a.state.mkl.length - 1], SIGHTING_ROW);
    assert.deepStrictEqual(posts.calls[0].systemIds, [30000001, 30000002, 30000003, 30000004, 30000005]);
    assert.strictEqual(posts.calls[0].corpId, CORP_A);
    assert.notStrictEqual(a.st, base.st);
    assert.strictEqual(a.sk, base.sk);
    const after = r.call(CHAR3, 0, [1, "region", R1, "", ""]);
    assert.deepStrictEqual([after.st, after.state.mk, after.state.mkl], [base.st, base.state.mk, base.state.mkl],
      "the shared cache entry is not mutated");

    r.now.t += cfg.inGameMap.windowMinIntervalMs;
    const g = r.call(CHAR, CORP_A, [1, "galaxy", 0, "", ""]);
    assert.strictEqual(posts.calls[1].systemIds, undefined, "galaxy: every watched system of the corporation");
    assert.deepStrictEqual(g.state.mk.filter((m) => m[0] === 6), [[6, 0, 5], [6, 1, 4]], "the region index");

    const cut = rig(withMap(cfg, { windowMaxMarkers: 3 }), { extraEvents: true,
      posts: fakePosts({ [CORP_A]: [sight(30000002, 1)] }) });
    const c = cut.call(CHAR, CORP_A, [1, "region", R1, "", ""]);
    assert.deepStrictEqual([c.state.mk, c.trunc.mk], [[[1, 1, 1], [3, 0, 1], [6, 1, 1]], 2]);
    assert.deepStrictEqual(c.state.mkl.map((row) => row[0]), [1, 3, 6]);

    const entry = Object.freeze({ state: Object.freeze({ mk: Object.freeze([Object.freeze([1, 0, 1])]),
      mkl: Object.freeze([Object.freeze([1, "fleets", 1, 2, 3])]), own: [] }), trunc: Object.freeze({ mk: 0 }),
    nodeOf: (sid) => (sid === 30000001 ? 0 : -1) });
    const m = mergeCorpMarks(entry, new Map([[30000001, 2], [30000009, 1]]), { maxMarkers: 1, lpMaxMarkers: 50 });
    assert.deepStrictEqual([m.state.mk, m.truncMk, m.state.mkl.map((row) => row[0])], [[[6, 0, 2]], 1, [6]]);
    assert.strictEqual(entry.state.mk.length, 1);
    const zero = mergeCorpMarks(entry, new Map([[30000001, 2]]), { maxMarkers: 0, lpMaxMarkers: 50 });
    assert.deepStrictEqual([zero.state === entry.state, zero.added], [true, []]);
  });

  test("LPM2 privacy: own corpId per caller, different mk; corporationId 0 -> zero markersFor calls", () => {
    const cfg = resolve(ON);
    const posts = fakePosts({ [CORP_A]: [sight(30000002, 1)], [CORP_B]: [sight(30000003, 2)] });
    const r = rig(cfg, { posts });
    const none = r.call(CHAR3, 0, [1, "region", R1, "", ""]);
    assert.strictEqual(posts.calls.length, 0, "no corporation = no read");
    assert.ok(!none.state.mk.some((m) => m[0] === 6));
    const a = r.call(CHAR, CORP_A, [1, "region", R1, "", ""]);
    const b = r.call(CHAR2, CORP_B, [1, "region", R1, "", ""]);
    assert.deepStrictEqual(posts.calls.map((q) => q.corpId), [CORP_A, CORP_B]);
    assert.deepStrictEqual(a.state.mk.filter((m) => m[0] === 6), [[6, 1, 1]]);
    assert.deepStrictEqual(b.state.mk.filter((m) => m[0] === 6), [[6, 2, 2]]);
    assert.notStrictEqual(a.st, b.st);
  });

  test("LPM3 off + memo: stub = identical answer and st; one markersFor per bucket; new bucket = same st", () => {
    const cfg = resolve(ON);
    const plain = rig(cfg).call(CHAR, CORP_A, [1, "region", R1, "", ""]);
    let stubCalls = 0;
    const stub = rig(cfg, { posts: { markersFor: () => {
      stubCalls += 1;
      return { ok: false, reason: "LISTENING_POST_OFF" };
    } } });
    assert.deepStrictEqual(stub.call(CHAR, CORP_A, [1, "region", R1, "", ""]), plain);
    stub.call(CHAR2, CORP_A, [1, "region", R1, "", ""]);
    assert.strictEqual(stubCalls, 1, "a refusal is remembered for the bucket");
    assert.strictEqual(stub.counts["inGameMap.window.mapCorpMarkRefused"], 1);

    const posts = fakePosts({ [CORP_A]: [sight(30000002, 1)] });
    const r = rig(cfg, { posts });
    const first = r.call(CHAR, CORP_A, [1, "region", R1, "", ""]);
    const second = r.call(CHAR2, CORP_A, [1, "region", R1, "", ""]);
    assert.strictEqual(posts.calls.length, 1, "one markersFor per corporation and scope per bucket");
    assert.strictEqual(second.st, first.st);
    assert.deepStrictEqual([r.counts["inGameMap.window.mapCorpMarkReads"], r.counts["inGameMap.window.mapCorpMarkHits"]],
      [1, 1]);
    r.now.t += cfg.inGameMap.windowCorpMarksRefreshMs;
    const next = r.call(CHAR, CORP_A, [1, "region", R1, first.sk, first.st]);
    assert.strictEqual(posts.calls.length, 2, "a new bucket reads again");
    assert.strictEqual(next.st, first.st, "no bucket in st");
    assert.ok(!("state" in next), "unchanged state is not sent again");
  });
};
