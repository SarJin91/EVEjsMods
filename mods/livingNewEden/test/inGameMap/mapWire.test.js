"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const config = require("../../config");
const { factionRgb } = require("../../lib/inGameMap/window/colors");
const { createMapWindow } = require("../../lib/inGameMap/window/service");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const CHAR = 90000001;
const CHAR2 = 90000002;
const R1 = 10000001;
const R2 = 10000002;
const J_SPACE = 31000005;
const ON = { EVEJS_LNE_INGAME_MAP_ENABLED: "1", EVEJS_LNE_INGAME_MAP_WINDOW_ENABLED: "1" };

function resolve(env) {
  const r = config.resolveConfig({ modDir: MOD_DIR, env });
  assert.ok(r.ok, JSON.stringify(r.errors));
  return r;
}

function withMap(cfg, over) {
  return { ...cfg, inGameMap: { ...cfg.inGameMap, ...over } };
}

function staticData() {
  return {
    available: true, key: "g1",
    systems: { count: 8, id: [30000001, 30000002, 30000003, 30000004, 30000005, 30000006, 30000007, 30000008],
      x: [0, 10, 20, 30, 60, 70, 80, 90], y: [0, 5, 0, 5, 0, 5, 0, 5], sec: [5, 4, 3, 2, -1, -2, -3, -4],
      cls: [0, 1, 1, 1, 2, 2, 2, 2], region: [0, 0, 0, 0, 1, 1, 1, 1],
      name: ["Jitä", "B".repeat(40), "C", "D", "E", "F", "G", "H"] },
    regions: [[R1, "The Forge"], [R2, "Lonetrek"]],
    edges: [0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7],
  };
}

function stateData() {
  return {
    available: true, key: "s1",
    systems: [[30000001, 500001, "STABLE", []], [30000002, 500001, "OCCUPIED", []], [30000003, 500002, "STABLE", []],
      [30000005, 500002, "STABLE", []], [30000006, 500002, "CONTESTED", []]],
    names: [[500001, "Caldari State"], [500002, null], [500003, "Amarr Empire"]],
    bastions: [[30000004, 500003]],
  };
}

function fakeViews() {
  const calls = { getView: 0, getData: 0 };
  const defs = new Map();
  const add = (id, data, key) => defs.set(id, { data, key });
  add("galaxy-static", staticData(), "g1");
  add("galaxy-state", stateData(), "s1");
  add("layer-fleets", { available: true, items: [[[30000001, 30000002, 30000003], 0, 0.5, "5", [], 500001]] }, "f1");
  add("layer-battles-open", { available: true, items: [[30000006, 0, "b", ["x", "y"], null]] }, "b1");
  add("layer-events", { available: true, items: [] }, "e1");
  add("layer-invasions", { available: true, items: [[30000003, 0, "i", ["z"], null]] }, "i1");
  const views = {
    getView(id) {
      calls.getView += 1;
      const d = defs.get(id);
      if (!d) return null;
      return { cacheKey: () => d.key, getData: () => {
        calls.getData += 1;
        return d.data;
      } };
    },
  };
  return { views, calls, defs };
}

function fakeAdapter() {
  const adapter = { handlers: null, registerMapClientService(world, spec) {
    adapter.handlers = spec.handlers;
    return { ok: true, unregister() {} };
  }, boardHookState: () => ({ status: "ABSENT" }), publishClientPart: () => ({ ok: false, reason: "BAD_PART" }),
  sendMapNotification: () => ({ ok: false, reason: "NO_SESSION" }) };
  return adapter;
}

function rig(cfg, ctxOver = {}) {
  const now = { t: 5000000 };
  const clock = { now: () => now.t };
  const v = fakeViews();
  const counts = {};
  const telemetry = { count: (name, n) => {
    counts[name] = (counts[name] || 0) + n;
  }, observe: () => {} };
  const adapter = fakeAdapter();
  const w = createMapWindow({ config: cfg, ctx: { views: v.views, ...ctxOver }, adapter, world: {}, clock, telemetry,
    log: () => {}, nowMs: () => 0 });
  assert.strictEqual(w.ok, true, JSON.stringify(w));
  const call = (characterId, args, systemId = 30000001) => adapter.handlers.GetMap({ characterId, systemId, args,
    badArgs: false });
  return { now, v, counts, call, w: w.window, adapter };
}

function parseColor(text) {
  if (text.startsWith("#")) {
    const n = Number.parseInt(text.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const m = /^hsl\((\d+), (\d+)%, (\d+)%\)$/.exec(text);
  assert.ok(m, text);
  const h = Number(m[1]) / 360;
  const s = Number(m[2]) / 100;
  const l = Number(m[3]) / 100;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t0) => {
    let t = t0;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [hue(h + 1 / 3), hue(h), hue(h - 1 / 3)].map((x) => Math.round(x * 255));
}

module.exports = ({ test }) => {
  test("IGM-W1 colours: factionRgb = observer factionColor (vm), +-1 per channel", () => {
    const sandbox = { window: {} };
    vm.runInNewContext(fs.readFileSync(path.join(MOD_DIR, "web", "galaxy.js"), "utf8"), sandbox,
      { filename: "galaxy.js" });
    const pure = sandbox.window.LneGalaxy._pure;
    for (const id of [500001, 500010, 500016, 500021, 1000125, 98000001]) {
      const expected = parseColor(pure.factionColor(id));
      const got = factionRgb(id);
      assert.strictEqual(got.length, 3);
      got.forEach((c, i) => assert.ok(Math.abs(c - expected[i]) <= 1, `${id}: ${got} vs ${expected}`));
    }
  });

  test("IGM-W2 region: ids + outer neighbour, xy 0..1000, ed, ASCII names, trunc.sys, here in J-space", () => {
    const cfg = resolve(ON).config;
    const r = rig(cfg);
    const a = r.call(CHAR, [1, "region", R1, "", ""]);
    assert.strictEqual(a.ok, true, JSON.stringify(a));
    assert.deepStrictEqual([a.v, a.scope, a.id], [1, "region", R1]);
    assert.ok(/^[0-9a-f]{12}$/.test(a.sk) && /^[0-9a-f]{12}$/.test(a.st), `${a.sk} ${a.st}`);
    assert.deepStrictEqual(a.static.ids, [30000001, 30000002, 30000003, 30000004, 30000005]);
    assert.deepStrictEqual(a.static.ext, [4]);
    assert.strictEqual(a.static.xy.length, 10);
    assert.ok(a.static.xy.every((c) => Number.isInteger(c) && c >= 0 && c <= 1000));
    assert.ok(a.static.xy.includes(1000));
    assert.deepStrictEqual(a.static.ed, [0, 1, 1, 2, 2, 3, 3, 4], "only between chosen nodes");
    assert.ok(a.static.nm.every((n) => /^[\x20-\x7e]*$/.test(n) && n.length <= 32), JSON.stringify(a.static.nm));
    assert.strictEqual(a.static.nm[0], "Jit?");
    assert.deepStrictEqual(a.static.sec, [5, 4, 3, 2, -1]);
    assert.deepStrictEqual(a.trunc, { sys: 0, mk: 0 });
    assert.deepStrictEqual(a.ui, { pollMs: 30000, cacheRegions: 8, maxLabels: 150 });

    const small = rig(withMap(cfg, { windowMaxSystems: 4 }));
    const b = small.call(CHAR, [1, "region", R1, "", ""]);
    assert.deepStrictEqual([b.static.ids.length, b.static.ext, b.trunc.sys], [4, [], 1]);
    assert.deepStrictEqual(b.static.ed, [0, 1, 1, 2, 2, 3]);

    const here = rig(cfg);
    const j = here.call(CHAR, [1, "here", 0, "", ""], J_SPACE);
    assert.deepStrictEqual([j.ok, j.scope, j.id, j.static && j.static.ids], [true, "galaxy", 0, [R1, R2]],
      JSON.stringify(j));
    const h2 = here.call(CHAR2, [1, "here", 0, "", ""], 30000006);
    assert.deepStrictEqual([h2.ok, h2.scope, h2.id], [true, "region", R2], "here = region from the session");
    assert.strictEqual(here.call(90000003, [1, "region", 123, "", ""]).reason, "NOT_ON_MAP");
  });

  test("IGM-W3 galaxy + state + marks: dominant own, fac rgb, bastion bit, OCCUPIED, fleet midpoint, trunc.mk", () => {
    const cfg = resolve(ON).config;
    const r = rig(cfg);
    const g = r.call(CHAR, [1, "galaxy", 0, "", ""]);
    assert.strictEqual(g.ok, true, JSON.stringify(g));
    assert.deepStrictEqual([g.scope, g.id, g.static.ids, g.static.nm, g.static.ed, g.static.ext],
      ["galaxy", 0, [R1, R2], ["The Forge", "Lonetrek"], [0, 1], []]);
    assert.deepStrictEqual(g.state.fac, [[500001, "Caldari State", ...factionRgb(500001)],
      [500002, "Faction 500002", ...factionRgb(500002)]]);
    assert.deepStrictEqual(g.state.own, [0, 1], "dominant controller per region");
    assert.deepStrictEqual(g.state.fl, [0, 0]);
    assert.deepStrictEqual(g.state.mk, [[1, 0, 1], [2, 1, 2], [4, 0, 1]]);
    assert.deepStrictEqual(g.state.mkl, [[1, "fleets", 255, 176, 0], [2, "battle", 255, 64, 64],
      [4, "invasion", 192, 64, 255]]);
    assert.ok(g.state.miss.includes("layer-situations"), JSON.stringify(g.state.miss));

    const reg = r.call(CHAR2, [1, "region", R1, "", ""]);
    assert.deepStrictEqual(reg.state.own, [0, 0, 1, -1, 1]);
    assert.deepStrictEqual(reg.state.fl, [0, 4, 0, 7 | 8, 0], "OCCUPIED = 4, bastion without a row = 15");
    assert.deepStrictEqual(reg.state.mk, [[1, 1, 1], [4, 2, 1]], "the fleet half way = the middle system");

    const one = rig(withMap(cfg, { windowMaxMarkers: 1 }));
    const t = one.call(CHAR, [1, "galaxy", 0, "", ""]);
    assert.deepStrictEqual([t.state.mk, t.trunc.mk, t.state.mkl], [[[1, 0, 1]], 2, [[1, "fleets", 255, 176, 0]]]);
    assert.strictEqual(one.counts["inGameMap.window.mapTruncMk"], 1);

    const noState = rig(cfg);
    noState.v.defs.delete("galaxy-state");
    const ns = noState.call(CHAR, [1, "region", R1, "", ""]);
    assert.deepStrictEqual([ns.ok, ns.state.own, ns.state.fl, ns.state.fac], [true, [-1, -1, -1, -1, -1],
      [7, 7, 7, 7, 7], []]);
    assert.ok(ns.state.miss.includes("galaxy-state"));
    const nsg = noState.call(CHAR2, [1, "galaxy", 0, "", ""]);
    assert.deepStrictEqual([nsg.state.own, nsg.state.fl], [[-1, -1], [7, 7]]);
  });

  test("IGM-W4 unchanged + cache: known keys, new layer key = new st same sk, second player = cache hit", () => {
    const cfg = resolve(ON).config;
    const r = rig(cfg);
    const first = r.call(CHAR, [1, "region", R1, "", ""]);
    r.now.t += cfg.inGameMap.windowMinIntervalMs;
    const same = r.call(CHAR, [1, "region", R1, first.sk, first.st]);
    assert.strictEqual(same.ok, true);
    assert.ok(!("static" in same) && !("state" in same), JSON.stringify(same));
    assert.ok(JSON.stringify(same).length < 200, "a few dozen bytes");
    assert.strictEqual(r.counts["inGameMap.window.mapUnchanged"], 1);
    const onlyState = r.call(CHAR2, [1, "region", R1, first.sk, ""]);
    assert.ok(!("static" in onlyState) && "state" in onlyState);

    r.v.defs.get("layer-battles-open").key = "b2";
    r.now.t += cfg.inGameMap.windowMinIntervalMs;
    const changed = r.call(CHAR, [1, "region", R1, first.sk, first.st]);
    assert.strictEqual(changed.sk, first.sk);
    assert.notStrictEqual(changed.st, first.st);
    assert.ok(!("static" in changed) && "state" in changed);

    const hits = r.counts["inGameMap.window.mapCacheHits"] || 0;
    const reads = r.v.calls.getData;
    r.now.t += cfg.inGameMap.windowMinIntervalMs;
    const other = r.call(CHAR2, [1, "region", R1, "", ""]);
    assert.deepStrictEqual([other.sk, other.st], [changed.sk, changed.st]);
    assert.strictEqual(r.counts["inGameMap.window.mapCacheHits"], hits + 1);
    assert.strictEqual(r.v.calls.getData, reads, "zero getData");
    assert.strictEqual(r.w.status().map.cached > 0, true);
    r.w.stop("test");
    assert.strictEqual(r.w.status().map.cached, 0, "stop clears the cache");
  });

  test("IGM-W5 refusals: DISABLED without reads, BAD_ARGS, RATE_LIMIT, BUSY without getData, W194", () => {
    const probeOnly = resolve({ EVEJS_LNE_INGAME_MAP_ENABLED: "1", EVEJS_LNE_INGAME_MAP_CLIENT_PROBE_ENABLED: "1" })
      .config;
    const off = rig(withMap(probeOnly, { windowEnabled: false }), {});
    assert.deepStrictEqual(off.call(CHAR, [1, "region", R1, "", ""]), { v: 1, ok: false, reason: "DISABLED" });
    assert.deepStrictEqual(off.v.calls, { getView: 0, getData: 0 });

    const cfg = resolve(ON).config;
    const r = rig(cfg);
    assert.strictEqual(r.call(CHAR, [2, "region", R1, "", ""]).reason, "BAD_ARGS");
    assert.strictEqual(r.call(CHAR, [1, "nope", R1, "", ""]).reason, "BAD_ARGS");
    assert.strictEqual(r.call(CHAR, [1, "region", R1, 5, ""]).reason, "BAD_ARGS");
    assert.strictEqual(r.call(0, [1, "region", R1, "", ""]).reason, "NO_CHARACTER");
    assert.strictEqual(r.v.calls.getView, 0, "refusals before the sources");
    assert.strictEqual(r.call(CHAR, [1, "region", R1, "", ""]).ok, true);
    const limited = r.call(CHAR, [1, "region", R1, "", ""]);
    assert.strictEqual(limited.reason, "RATE_LIMIT");
    assert.ok(limited.retryMs > 0, JSON.stringify(limited));
    const js = rig(cfg);
    assert.strictEqual(js.call(CHAR, [1, "here", 0, "", ""], J_SPACE).scope, "galaxy");
    const again = js.call(CHAR, [1, "galaxy", 0, "", ""], J_SPACE);
    assert.ok(again.reason === "RATE_LIMIT" && again.retryMs > 0, JSON.stringify(again));

    const busy = rig(cfg, { governor: { admits: (cls) => cls !== "MAINTENANCE" } });
    assert.deepStrictEqual(busy.call(CHAR, [1, "region", R1, "", ""]), { v: 1, ok: false, reason: "BUSY",
      retryMs: cfg.inGameMap.windowMinIntervalMs });
    assert.strictEqual(busy.v.calls.getData, 0);
    assert.strictEqual(busy.counts["inGameMap.window.mapBusy"], 1);

    const noStatic = rig(cfg);
    noStatic.v.defs.delete("galaxy-static");
    assert.strictEqual(noStatic.call(CHAR, [1, "galaxy", 0, "", ""]).reason, "NO_DATA");

    const W194 = "inGameMap.windowEnabled with observer.galaxyEnabled=false - the map window has no data (NO_DATA)";
    assert.ok(resolve({ ...ON, EVEJS_LNE_OBSERVER_GALAXY_ENABLED: "0" }).warnings.includes(W194));
    assert.ok(!resolve(ON).warnings.includes(W194));
    assert.deepStrictEqual(resolve({}).warnings.filter((w) => w.startsWith("inGameMap.")), [], "defaults");
    const def = resolve({}).config.inGameMap;
    assert.deepStrictEqual([def.windowEnabled, def.windowPollMs, def.windowMinIntervalMs, def.windowMaxReadsPerMinute,
      def.windowMaxSystems, def.windowMaxMarkers, def.windowNeighborJumps, def.windowCacheEntries,
      def.windowClientCacheRegions, def.windowMaxLabels, def.windowStateMinRefreshMs],
    [false, 30000, 5000, 120, 300, 200, 1, 64, 8, 150, 10000]);
  });
};
