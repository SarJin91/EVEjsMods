"use strict";

const assert = require("assert");

const { createStructuresSystemFilter, toPositiveInt } = require("../lib/structuresSystemFilter");

const clone = (v) => JSON.parse(JSON.stringify(v));

const ROWS = Object.freeze([
  { structureID: 1001, solarSystemID: 30000142, name: "A", destroyedAt: 0, nested: { hp: [1, 2] } },
  { structureID: 1002, solarSystemID: 30000144, name: "B", destroyedAt: 0, nested: { hp: [3] } },
  { structureID: 1003, solarSystemID: 30000142, name: "C", destroyedAt: 1700000000000, nested: {} },
  { structureID: 1004, solarSystemID: 30000142, name: "D", destroyedAt: null, nested: { x: null } },
  { structureID: 1005, solarSystemID: "30000142", name: "E-string", destroyedAt: 0 },
]);

function fakeState(rows, onTick) {
  const st = { cache: { rows: rows.map(clone) }, ticks: 0, peeks: 0 };
  function tickStructures() {
    st.ticks += 1;
    if (onTick) st.cache = { rows: onTick(st.cache.rows.map(clone)) };
    return st.cache.rows.map(clone);
  }
  function listStructures(options = {}) {
    if (options.refresh !== false) tickStructures(Date.now());
    const includeDestroyed = options.includeDestroyed === true;
    return st.cache.rows.filter((e) => includeDestroyed || !e.destroyedAt).map((e) => clone(e));
  }
  function listStructuresForSystem(solarSystemID, options = {}) {
    const n = toPositiveInt(solarSystemID, 0);
    if (!n) return [];
    return listStructures(options).filter((e) => e.solarSystemID === n);
  }
  function peekStructures(options = {}) {
    st.peeks += 1;
    return options.includeDestroyed === true ? st.cache.rows.slice() : st.cache.rows.filter((e) => !e.destroyedAt);
  }
  function peekStructuresForSystem(solarSystemID, options = {}) {
    const n = toPositiveInt(solarSystemID, 0);
    if (!n) return [];
    return peekStructures(options).filter((e) => e.solarSystemID === n);
  }
  st.exports = { tickStructures, listStructures, listStructuresForSystem, peekStructures, peekStructuresForSystem };
  st.original = listStructuresForSystem;
  return st;
}

function wrapped(rows, cfg = {}, onTick) {
  const lines = [];
  const st = fakeState(rows, onTick);
  const f = createStructuresSystemFilter({ config: { structuresSystemFilterParityCheck: false, ...cfg }, log: (l) => lines.push(l) });
  assert.strictEqual(f.setDeps(st.exports), true);
  st.exports.listStructuresForSystem = f.wrapListForSystem(st.exports.listStructuresForSystem);
  return { st, f, lines };
}

function register(ctx) {
  const { test, src, config, loader } = ctx;
  const { createState, patchTarget, probeMessage, checkStructuresDrift, requestPatternFor, STRUCT_POINTS } = loader;

  test("H1 system structures: result = vendor (system with/without structures, includeDestroyed, refresh true/false, bad id), fresh clones", () => {
    const bump = (rows) => rows.map((r) => ({ ...r, ticked: (r.ticked || 0) + 1 }));
    const cases = [
      [30000142, undefined], [30000142, {}], [30000142, { refresh: false }], [30000142, { includeDestroyed: true }],
      [30000142, { includeDestroyed: true, refresh: false }], [30000144, { refresh: false }], [30000999, {}],
      ["30000142", { refresh: false }], [30000142.7, { refresh: false }], [0, {}], [-5, {}], ["abc", {}], [undefined, {}],
    ];
    for (const [id, opts] of cases) {
      const vendor = fakeState(ROWS, bump);
      const w = wrapped(ROWS, {}, bump);
      const args = opts === undefined ? [id] : [id, opts];
      const expected = vendor.exports.listStructuresForSystem(...args);
      const actual = w.st.exports.listStructuresForSystem(...args);
      const label = JSON.stringify(args);
      assert.deepStrictEqual(actual, expected, label);
      assert.strictEqual(w.st.ticks, vendor.ticks, `ticki ${label}`);
    }
    const w = wrapped(ROWS, {}, bump);
    const out = w.st.exports.listStructuresForSystem(30000142);
    assert.deepStrictEqual(out.map((r) => [r.structureID, r.ticked]), [[1001, 1], [1004, 1]]);
    out[0].nested.hp.push(99);
    out[0].name = "X";
    const again = w.st.exports.listStructuresForSystem(30000142, { refresh: false });
    assert.deepStrictEqual(again[0].nested.hp, [1, 2]);
    assert.strictEqual(again[0].name, "A");
    assert.notStrictEqual(again[0], w.st.cache.rows[0]);
    assert.notStrictEqual(again, w.st.exports.listStructuresForSystem(30000142, { refresh: false }));
    const vn = fakeState(ROWS);
    const wn = wrapped(ROWS);
    assert.throws(() => vn.exports.listStructuresForSystem(30000142, null), TypeError);
    assert.throws(() => wn.st.exports.listStructuresForSystem(30000142, null), TypeError);
    const wt = wrapped(ROWS);
    wt.st.exports.tickStructures = () => { throw new Error("tick boom"); };
    assert.throws(() => wt.st.exports.listStructuresForSystem(30000142), /tick boom/);
    assert.strictEqual(wt.f.status().disabledReason, null);
    const snap = w.f.statsSnapshot();
    assert.deepStrictEqual([snap.served, snap.cloned, snap.passthrough], [3, 6, 0]);
    assert.ok(/^stats structuresSystemFilter state=ready served=3 empty=0 passthrough=0 cloned=6 parityChecks=0 refreshRan=1 refreshSkipped=0 refreshAgeMaxMs=0 coalesce=off$/.test(w.f.drainStatsLines()[0]));
  });

  test("H2 system structures: peek error = disable and original without a second tick; parity; loader on/off, drift, order, probe", () => {
    const we = wrapped(ROWS);
    we.st.exports.peekStructuresForSystem = () => { throw new Error("peek boom"); };
    const res = we.st.exports.listStructuresForSystem(30000142);
    assert.deepStrictEqual(res.map((r) => r.structureID), [1001, 1004]);
    assert.strictEqual(we.st.ticks, 1, "one tick despite the fallback");
    assert.strictEqual(we.f.status().state, "disabled:error");
    assert.ok(we.lines.some((l) => l.startsWith("WARN structuresSystemFilter disabled: error (peek boom")), we.lines.join("|"));
    we.st.exports.listStructuresForSystem(30000142, { refresh: false });
    assert.strictEqual(we.f.statsSnapshot().passthrough, 1);

    const wp = wrapped(ROWS, { structuresSystemFilterParityCheck: true });
    wp.st.exports.listStructuresForSystem(30000142, { includeDestroyed: true });
    assert.strictEqual(wp.st.ticks, 1, "parity does not tick a second time");
    assert.deepStrictEqual([wp.f.statsSnapshot().parityChecks, wp.f.status().disabledReason], [1, null]);
    const real = wp.st.exports.peekStructuresForSystem;
    wp.st.exports.peekStructuresForSystem = (id, o) => real(id, o).map((r) => ({ ...r, name: "zly" }));
    const pv = wp.st.exports.listStructuresForSystem(30000142, { refresh: false });
    assert.strictEqual(pv[0].name, "A");
    assert.strictEqual(wp.f.status().state, "disabled:parity");

    const quiet = Object.fromEntries(loader.POINTS.map((p) => [p.flag, false]));
    const on = createState({ ...config, ...quiet, prewarmLocations: false, structuresSystemFilter: true }, null, { log: () => {} });
    const sv = fakeState(ROWS);
    const orig = sv.exports.listStructuresForSystem;
    patchTarget("structureState", sv.exports, on);
    for (const p of STRUCT_POINTS) assert.ok(on.patched.has(p.symbol), p.symbol);
    assert.strictEqual(sv.exports.listStructuresForSystem.__hotPathPerfStructures, orig);
    const first = sv.exports.listStructuresForSystem;
    on.patched.clear();
    patchTarget("structureState", sv.exports, on);
    assert.strictEqual(sv.exports.listStructuresForSystem, first, "no double wrap");
    on.gameSeen = true;
    assert.strictEqual(checkStructuresDrift(on), false);
    assert.ok(/^probe: passed \(2 /.test(probeMessage(on)), probeMessage(on));
    assert.ok(on.requestPattern.test("../services/structure/structureState") && on.requestPattern.test("./structureState"));
    assert.strictEqual(loader.targetOf("/app/server/src/services/structure/structureState.js"), "structureState");
    assert.strictEqual(loader.targetOf("/app/server/src/services/structure/loadedStructureState.js"), null);

    const off = createState({ ...config, ...quiet, prewarmLocations: false }, null);
    const so = fakeState(ROWS);
    patchTarget("structureState", so.exports, off);
    assert.strictEqual(off.structures, null);
    assert.strictEqual(so.exports.listStructuresForSystem, so.original);
    assert.strictEqual(off.requestPattern.source, requestPatternFor({}).source);
    assert.strictEqual(config.structuresSystemFilter, false, "mod default false");

    const drift = createState({ ...config, ...quiet, prewarmLocations: false, structuresSystemFilter: true }, null, { log: () => {} });
    const sd = fakeState(ROWS);
    delete sd.exports.peekStructuresForSystem;
    patchTarget("structureState", sd.exports, drift);
    drift.gameSeen = true;
    assert.strictEqual(checkStructuresDrift(drift), true);
    const msg = probeMessage(drift);
    assert.ok(msg.startsWith("DRIFT: structureState#structuresDeps") && msg.endsWith("; structuresSystemFilter disabled: drift"), msg);
    assert.deepStrictEqual(sd.exports.listStructuresForSystem(30000142, { refresh: false }).length, 2);

    const ord = createState({ ...config, ...quiet, prewarmLocations: false, structuresSystemFilter: true }, null, { log: () => {} });
    const sx = fakeState(ROWS);
    const inner = sx.exports.listStructuresForSystem;
    sx.exports.listStructuresForSystem = function otherMod() { return inner.apply(this, arguments); };
    patchTarget("structureState", sx.exports, ord);
    assert.strictEqual(ord.structures.status().state, "disabled:order");
    assert.strictEqual(sx.exports.listStructuresForSystem.name, "otherMod");
  });

  test("H3 vendor facts: listStructuresForSystem/peekStructuresForSystem as the fake's copy, exports, tick callers", () => {
    const text = src("services/structure/structureState.js").replace(/\r\n/g, "\n");
    assert.ok(text.includes('const { cloneValue: walkCloneValue } = require("../../common/clone");'));
    assert.ok(text.includes("function cloneValue(value) {\n  return value === undefined ? JSON.parse(JSON.stringify(value)) : walkCloneValue(value);\n}"));
    assert.ok(text.includes("function toPositiveInt(value, fallback = 0) {\n  const numeric = toInt(value, fallback);\n  return numeric > 0 ? numeric : fallback;\n}"));
    assert.ok(text.includes("function listStructures(options = {}) {\n  if (options.refresh !== false) {\n    tickStructures(Date.now());\n  }\n" +
      "  const includeDestroyed = options.includeDestroyed === true;\n  return ensureStructureCache().rows\n" +
      "    .filter((entry) => includeDestroyed || !entry.destroyedAt)\n    .map((entry) => cloneValue(entry));\n}"), "listStructures");
    assert.ok(text.includes("function listStructuresForSystem(solarSystemID, options = {}) {\n  const numericSystemID = toPositiveInt(solarSystemID, 0);\n" +
      "  if (!numericSystemID) {\n    return [];\n  }\n  return listStructures(options).filter((entry) => entry.solarSystemID === numericSystemID);\n}"), "listStructuresForSystem");
    assert.ok(text.includes("function peekStructures(options = {}) {\n  const rows = ensureStructureCache().rows;\n  return options.includeDestroyed === true\n" +
      "    ? rows.slice()\n    : rows.filter((entry) => !entry.destroyedAt);\n}"), "peekStructures");
    assert.ok(text.includes("function peekStructuresForSystem(solarSystemID, options = {}) {\n  const numericSystemID = toPositiveInt(solarSystemID, 0);\n" +
      "  if (!numericSystemID) {\n    return [];\n  }\n  return peekStructures(options)\n    .filter((entry) => entry.solarSystemID === numericSystemID);\n}"), "peekStructuresForSystem");
    for (const name of ["listStructuresForSystem", "peekStructuresForSystem", "tickStructures"]) {
      assert.ok(text.includes(`\n  ${name},\n`), `eksport ${name}`);
    }
    assert.ok(text.includes("setLoadedStructureState(module.exports)"), "worldData reads the same exports");
    const world = src("space/worldData.js").replace(/\r\n/g, "\n");
    assert.ok(world.includes("return getStructureState().listStructuresForSystem(solarSystemID, options);"));
    const tick = src("space/runtime/spaceRuntime/tick.js").replace(/\r\n/g, "\n");
    assert.ok(tick.includes("structureState.tickStructures(now);") && tick.includes("scene.syncStructureEntitiesFromState({ refresh: false });"));
  });
}

module.exports = { register };
