"use strict";

const assert = require("node:assert");

const { createViewRegistry } = require("../../lib/observer/views");
const { createRouter } = require("../../lib/observer/router");
const { buildLogisticsView } = require("../../lib/economy/logistics/logisticsView");

function harness(arg = {}) {
  const extra = typeof arg === "function" ? { governor: arg } : (arg || {});
  const clock = { t: 1000 };
  const views = createViewRegistry();
  const router = createRouter({ views, assets: {},
    config: { maxResponseBytes: 100000, refreshSeconds: 5, ...(extra.config || {}) },
    modVersion: "t", now: () => clock.t, telemetry: extra.telemetry || (() => null),
    governor: extra.governor, getGovernor: extra.getGovernor });
  const get = (id) => {
    const r = router.route({ method: "GET", url: `/api/views/${id}`, host: "127.0.0.1:26410" });
    assert.strictEqual(r.status, 200, String(r.body));
    return JSON.parse(String(r.body));
  };
  return { clock, views, get };
}

function heldView(gov) {
  const s = { reads: 0 };
  s.def = { title: "T", getData: () => {
    if (gov.closed) return { available: false, reason: "STORE_CLOSED" };
    if (!gov.admit) return { available: false, reason: "GOVERNOR_HOLD" };
    s.reads += 1;
    return { available: true, n: s.reads, reason: "own" };
  } };
  return s;
}

module.exports = ({ test }) => {
  test("SH1 hold without an earlier answer -> available:false GOVERNOR_HOLD, not stale", () => {
    const h = harness();
    const gov = { admit: false };
    h.views.registerView("v", heldView(gov).def);
    const r = h.get("v");
    assert.deepStrictEqual(r.data, { available: false, reason: "GOVERNOR_HOLD" });
    assert.strictEqual(r.stale, false);
  });

  test("SH2 hold after a good answer -> the old data, stale:true, staleSinceMs, reason GOVERNOR_HOLD", () => {
    const h = harness();
    const gov = { admit: true };
    const v = heldView(gov);
    const handle = h.views.registerView("v", v.def);
    assert.deepStrictEqual(h.get("v").data, { available: true, n: 1, reason: "own" });
    gov.admit = false;
    h.clock.t = 4500;
    const out = [h.get("v")];
    h.clock.t = 9000;
    out.push(h.get("v"));
    assert.deepStrictEqual(out.map((r) => [r.stale, r.data]), [
      [true, { available: true, n: 1, reason: "GOVERNOR_HOLD", stale: true, staleSinceMs: 1000, staleAgeMs: 3500 }],
      [true, { available: true, n: 1, reason: "GOVERNOR_HOLD", stale: true, staleSinceMs: 1000, staleAgeMs: 8000 }],
    ]);
    assert.strictEqual(v.reads, 1, "no read while held");
    handle.unregister();
    h.views.registerView("v", heldView(gov).def);
    const a = h.get("v");
    const b = h.get("v");
    assert.deepStrictEqual([a.stale, b.stale, b.data], [false, false, { available: false, reason: "GOVERNOR_HOLD" }]);
  });

  test("SH3 admitted again -> fresh data, stale:false; the next hold is stale since the fresh one", () => {
    const h = harness();
    const gov = { admit: true };
    h.views.registerView("v", heldView(gov).def);
    h.get("v");
    gov.admit = false;
    h.clock.t = 2000;
    assert.strictEqual(h.get("v").stale, true);
    gov.admit = true;
    h.clock.t = 3000;
    const fresh = h.get("v");
    assert.deepStrictEqual([fresh.stale, fresh.data], [false, { available: true, n: 2, reason: "own" }]);
    gov.admit = false;
    h.clock.t = 3500;
    const again = h.get("v");
    assert.deepStrictEqual([again.stale, again.data.n, again.data.staleSinceMs], [true, 2, 3000]);
    gov.closed = true;
    const closed = h.get("v");
    assert.deepStrictEqual([closed.stale, closed.data], [false, { available: false, reason: "STORE_CLOSED" }]);
  });

  function scopedGovernor() {
    const g = { admit: false, shed: false, depth: 0 };
    g.api = {
      admits: () => g.depth > 0 || g.admit,
      runAdmitted: (fn) => {
        if (g.shed) return { ok: false, reason: "SHED" };
        g.depth += 1;
        try {
          return { ok: true, value: fn() };
        } finally {
          g.depth -= 1;
        }
      },
    };
    return g;
  }

  function gatedView(g) {
    const s = { reads: 0 };
    s.def = { title: "T", getData: () => {
      if (!g.api.admits("MAINTENANCE")) return { available: false, reason: "GOVERNOR_HOLD" };
      s.reads += 1;
      return { available: true, n: s.reads };
    } };
    return s;
  }

  test("SH5 held past maxStaleMs -> one forced refresh per slot per maxStaleMs, not in SHED, counted", () => {
    const counts = [];
    const g = scopedGovernor();
    const h = harness({ config: { maxStaleMs: 1000, maxForcedRefreshesPerMinute: 6 }, getGovernor: () => g.api,
      telemetry: () => ({ count: (name) => counts.push(name) }) });
    const v = gatedView(g);
    h.views.registerView("v", v.def);
    g.admit = true;
    h.get("v");
    g.admit = false;
    h.clock.t = 2000;
    assert.deepStrictEqual([h.get("v").stale, v.reads], [true, 1], "age 1000 = not over maxStaleMs");
    h.clock.t = 2001;
    const forced = h.get("v");
    assert.deepStrictEqual([forced.stale, forced.data, v.reads], [false, { available: true, n: 2 }, 2]);
    h.clock.t = 2500;
    assert.deepStrictEqual([h.get("v").stale, v.reads], [true, 2], "fresh again, held -> stale");
    h.clock.t = 4000;
    g.shed = true;
    assert.deepStrictEqual([h.get("v").stale, v.reads], [true, 2], "SHED: no forced refresh");
    g.shed = false;
    const again = h.get("v");
    assert.deepStrictEqual([again.stale, again.data.n], [false, 3], "after SHED the due refresh runs");
    assert.strictEqual(counts.filter((n) => n === "observer.staleForcedRefreshes").length, 2);
    const stuck = { title: "S", getData: () => ({ available: false, reason: "GOVERNOR_HOLD" }) };
    let stuckRuns = 0;
    h.views.registerView("s", { title: "S", getData: (req) => { stuckRuns += 1; return stuck.getData(req); } });
    h.get("s");
    h.clock.t = 5001;
    h.get("s");
    h.clock.t = 5500;
    h.get("s");
    assert.strictEqual(stuckRuns, 5, "(plain + forced) at 4000 + (plain + forced) at 5001 + plain at 5500 (SLOT_RATE)");
  });

  test("SH7: a slot without a good answer refreshes at once; SLOT_RATE, GLOBAL_CAP, not in SHED", () => {
    const { createForcedRefreshLimiter } = require("../../lib/observer/forcedRefresh");
    const counts = [];
    const g = scopedGovernor();
    const h = harness({ config: { maxStaleMs: 1000, maxForcedRefreshesPerMinute: 2 }, getGovernor: () => g.api,
      telemetry: () => ({ count: (name) => counts.push(name) }) });
    const forcedCount = () => counts.filter((n) => n === "observer.staleForcedRefreshes").length;
    const a = gatedView(g);
    h.views.registerView("a", a.def);
    const first = h.get("a");
    assert.deepStrictEqual([first.stale, first.data, a.reads, forcedCount()], [false, { available: true, n: 1 }, 1, 1]);
    let stuckRuns = 0;
    h.views.registerView("b", { title: "B", getData: () => {
      stuckRuns += 1;
      return { available: false, reason: "GOVERNOR_HOLD" };
    } });
    h.get("b");
    assert.deepStrictEqual([stuckRuns, forcedCount()], [2, 2], "plain + forced");
    h.clock.t = 1500;
    h.get("b");
    assert.deepStrictEqual([stuckRuns, forcedCount()], [3, 2], "SLOT_RATE: plain only");
    const lim = createForcedRefreshLimiter({ maxStaleMs: 1000, maxPerMinute: 2 });
    assert.deepStrictEqual(lim.check("a", null, 0), { ok: true });
    lim.commit("a", 0);
    assert.deepStrictEqual(lim.check("a", null, 500), { ok: false, reason: "SLOT_RATE" });
    lim.commit("b", 500);
    assert.deepStrictEqual(lim.check("c", null, 600), { ok: false, reason: "GLOBAL_CAP" });
    assert.deepStrictEqual(lim.check("c", 100, 600), { ok: false, reason: "FRESH" });
    h.clock.t = 1500 + 60000;
    g.shed = true;
    const d = gatedView(g);
    h.views.registerView("d", d.def);
    const shed = h.get("d");
    assert.deepStrictEqual([shed.stale, shed.data, d.reads, forcedCount()],
      [false, { available: false, reason: "GOVERNOR_HOLD" }, 0, 2]);
    g.shed = false;
    assert.deepStrictEqual([h.get("d").data, d.reads, forcedCount()], [{ available: true, n: 1 }, 1, 3]);
  });

  test("SH6 global cap per minute; 0 = off; no runAdmitted = no forced refresh", () => {
    const g = scopedGovernor();
    const h = harness({ config: { maxStaleMs: 100, maxForcedRefreshesPerMinute: 2 }, getGovernor: () => g.api });
    const vs = ["a", "b", "c"].map((id) => {
      const v = gatedView(g);
      h.views.registerView(id, v.def);
      return v;
    });
    g.admit = true;
    for (const id of ["a", "b", "c"]) h.get(id);
    g.admit = false;
    h.clock.t = 2000;
    const fresh = ["a", "b", "c"].map((id) => h.get(id).stale);
    assert.deepStrictEqual(fresh, [false, false, true], "cap 2 per 60 s");
    h.clock.t = 2000 + 60000;
    assert.strictEqual(h.get("c").stale, false, "next window");
    assert.deepStrictEqual(vs.map((v) => v.reads), [2, 2, 2]);

    for (const extra of [{ config: { maxStaleMs: 0, maxForcedRefreshesPerMinute: 6 }, getGovernor: () => g.api },
      { config: { maxStaleMs: 100, maxForcedRefreshesPerMinute: 0 }, getGovernor: () => g.api },
      { config: { maxStaleMs: 100, maxForcedRefreshesPerMinute: 6 }, getGovernor: () => ({ admits: () => g.admit }) }]) {
      const h2 = harness(extra);
      const v = gatedView(g);
      h2.views.registerView("v", v.def);
      g.admit = true;
      h2.get("v");
      g.admit = false;
      h2.clock.t = 100000;
      assert.deepStrictEqual([h2.get("v").stale, v.reads], [true, 1]);
    }
  });

  test("SH4 logistics view while held: no store call, stale answer; a cache hit keeps it fresh", () => {
    const h = harness();
    const gov = { admit: true };
    const calls = { isOpen: 0, transaction: 0 };
    const store = {
      isOpen: () => { calls.isOpen += 1; return true; },
      transaction: (_name, fn) => { calls.transaction += 1; return { ok: true, value: fn({}) }; },
    };
    const convoys = {
      getChangeCount: () => 7,
      listTotals: () => ({ ok: true, totals: [] }),
      listOpen: () => ({ ok: true, convoys: [] }),
      recentEnded: () => ({ ok: true, rows: [] }),
      recentDelivered: () => ({ ok: true, rows: [] }),
    };
    const view = buildLogisticsView({ store, convoys, clock: { now: () => h.clock.t }, getStatus: () => ({ seq: 1 }),
      getGovernor: () => ({ admits: () => gov.admit }), maxOpenRows: 1 });
    h.views.registerView("logistics", view);
    const first = h.get("logistics");
    assert.deepStrictEqual([first.stale, first.data.available, calls.transaction], [false, true, 1]);
    h.clock.t = 6000;
    const hit = h.get("logistics");
    assert.deepStrictEqual([hit.cached, hit.stale], [true, false]);
    gov.admit = false;
    const before = { ...calls };
    h.clock.t = 8000;
    const held = h.get("logistics");
    assert.deepStrictEqual([held.stale, held.data.available, held.data.reason, held.data.staleSinceMs,
      held.data.staleAgeMs], [true, true, "GOVERNOR_HOLD", 6000, 2000]);
    assert.strictEqual(calls.transaction, before.transaction, "no store transaction while held");
  });

  test("SH5: GOVERNOR_DEFERRED served stale like a hold; staleGovernor = real mode", () => {
    const status = { mode: "SHED", baseMode: "NORMAL", overlay: "shed", reason: "emergency_background_shed" };
    const h = harness(() => ({ getStatus: () => status }));
    const gov = { admit: true };
    const reads = { n: 0 };
    h.views.registerView("occupation", { title: "O", getData: () => {
      if (!gov.admit) return { available: false, reason: "GOVERNOR_DEFERRED" };
      reads.n += 1;
      return { available: true, n: reads.n };
    } });
    h.get("occupation");
    gov.admit = false;
    h.clock.t = 7000;
    const held = h.get("occupation");
    assert.deepStrictEqual([held.stale, held.data], [true, { available: true, n: 1, stale: true, staleSinceMs: 1000,
      staleAgeMs: 6000, staleGovernor: { mode: "SHED", baseMode: "NORMAL", overlay: "shed" },
      reason: "GOVERNOR_DEFERRED" }]);
    assert.strictEqual(reads.n, 1, "no read while deferred");
    const h2 = harness(() => { throw new Error("x"); });
    const g2 = { admit: true };
    h2.views.registerView("v", heldView(g2).def);
    h2.get("v");
    g2.admit = false;
    const noGov = h2.get("v");
    assert.deepStrictEqual([noGov.stale, "staleGovernor" in noGov.data], [true, false]);
  });

  test("SH6 real occupationView / liberationView held by the governor are served stale", () => {
    const { buildOccupationView } = require("../../lib/world/occupation/occupationView");
    const { buildLiberationView } = require("../../lib/world/liberation/liberationView");
    const h = harness(() => ({ getStatus: () => ({ mode: "CONSTRAINED" }) }));
    const gov = { admit: true };
    const store = { isOpen: () => true, transaction: (_n, fn) => ({ ok: true, value: fn(null) }) };
    const system = { systemId: 30000142, occupationState: "CONTESTED", controllerFactionId: 500001,
      occupierFactionId: 500002, previousControllerFactionId: 500001, lastStateChangeAt: 0, phaseSeq: 1, influence: [] };
    const repository = {
      getChangeCount: () => 1,
      listActiveOccupations: () => ({ ok: true, systems: [system] }),
      countDetachedByController: () => ({ ok: true, rows: [] }),
      listLiberated: () => ({ ok: true, systems: [system], nextAfterSystemId: null }),
    };
    const deps = { store, repository, getStatus: () => ({ state: "running", seq: 1 }), maxRows: 10,
      getGovernor: () => ({ admits: () => gov.admit }) };
    h.views.registerView("occupation", buildOccupationView(deps));
    h.views.registerView("liberation", buildLiberationView(deps));
    for (const id of ["occupation", "liberation"]) assert.strictEqual(h.get(id).data.available, true, id);
    gov.admit = false;
    h.clock.t = 4000;
    for (const id of ["occupation", "liberation"]) {
      const held = h.get(id);
      assert.deepStrictEqual([held.stale, held.data.available, held.data.reason, held.data.staleSinceMs],
        [true, true, "GOVERNOR_DEFERRED", 1000], `${id}: ${JSON.stringify(held)}`);
    }
  });
};
