"use strict";

const assert = require("node:assert");

const { LAYER_ID, LEGEND, EVENT_STYLES, buildEventsLayerView } = require("../../lib/events/eventsLayer");

const NOW = 1700000000000;
const REFRESH = 30000;
const SYS_A = 30001001;
const SYS_B = 30001002;
const SYS_C = 30001003;

function row(over) {
  return Object.freeze({ eventId: "ev", planKey: "pk", eventType: "sansha_incursion_staging", catalogVersion: 1,
    systemId: SYS_A, factionId: 500019, campaignId: null, cause: "OCCUPATION", templateId: "t", templateIds: ["t"],
    label: "Event", state: "PLANNED", spawnBudget: 3, sitesCreated: 0, createdAt: NOW - 1000, dueAt: NOW,
    expiresAt: NOW + 3600000, endedAt: null, seed: 1, reason: null, resultReference: null, result: null,
    cleanupPending: null, updatedAt: NOW, version: 1, corrupt: false, ...over });
}

function env(rows, over = {}) {
  const calls = { tx: [], list: [], observe: [] };
  const st = { open: true, admits: true, mark: 0 };
  const store = {
    isOpen: () => st.open,
    transaction(name, fn) {
      calls.tx.push(name);
      return { ok: true, value: fn({ db: true }) };
    },
  };
  const repository = { listOpen(db, opts) {
    calls.list.push(opts);
    return { ok: true, events: rows, truncated: false };
  } };
  const view = buildEventsLayerView({ store, repository, clock: { now: () => NOW },
    getGovernor: () => ({ admits: (cls) => (cls === "MAINTENANCE" ? st.admits : true) }),
    getPulseMark: () => st.mark, telemetry: { observe: (name, v) => calls.observe.push([name, v]) },
    nowMs: () => 0, maxEvents: 8, maxSystems: 128, refreshMs: REFRESH, presenceActivation: true, ...over });
  return { view, calls, st };
}

module.exports = ({ test }) => {
  test("EL1 layer-events: one mark per system, style by priority (ACTIVE > COMPLETING > PLANNED), label +N "
    + "tooltip line per event with trigger and sites; maxSystems cut -> +N more systems; one read, one histogram",
  () => {
    const rows = [
      row({ eventId: "a2", systemId: SYS_A, label: "Staging A2", state: "PLANNED", dueAt: NOW - 50 }),
      row({ eventId: "a1", systemId: SYS_A, label: "Staging A1", state: "ACTIVE", dueAt: NOW - 10, sitesCreated: 2,
        spawnBudget: 3, result: { activation: { trigger: "presence", distance: 1 } } }),
      row({ eventId: "b1", systemId: SYS_B, label: "Cleanup B", state: "COMPLETING", sitesCreated: 3,
        spawnBudget: 3 }),
      row({ eventId: "c1", systemId: SYS_C, label: "Waiting C", state: "PLANNED" }),
    ];
    const { view, calls } = env(rows);
    assert.deepStrictEqual([LAYER_ID, view.title, view.listed, view.mapLayer], ["layer-events", "Events", false,
      { kind: "marks", order: 19 }]);
    const data = view.getData();
    assert.strictEqual(data.available, true);
    assert.deepStrictEqual(data.items.map((i) => [i[0], i[1], i[2], i[3].length]), [
      [SYS_A, "events-active", "Staging A1 +1", 2],
      [SYS_B, "events-completing", "Cleanup B", 1],
      [SYS_C, "events-planned", "Waiting C", 1],
    ]);
    const [a, b, c] = data.items;
    assert.strictEqual(a[3][0], "Staging A1 · sansha_incursion_staging · faction 500019 · cause OCCUPATION · ACTIVE · "
      + "trigger presence (d=1) · sites 2/3");
    assert.ok(a[3][1].includes("trigger waiting for a player"), a[3][1]);
    assert.ok(b[3][0].includes("· COMPLETING · trigger due · sites 3/3"), b[3][0]);
    assert.ok(c[3][0].includes("trigger waiting for a player"), c[3][0]);
    assert.strictEqual(data.note, "4 open events in 3 systems");
    assert.deepStrictEqual([calls.tx, calls.list], [["observer.galaxyEvents"], [{ limit: 8 }]]);
    assert.deepStrictEqual(calls.observe, [["observer.galaxyEventsMs", 0]]);

    const cut = env(rows, { maxSystems: 2 }).view.getData();
    assert.deepStrictEqual(cut.items.map((i) => i[0]), [SYS_A, SYS_B]);
    assert.ok(cut.note.includes("(+1 more systems)"), cut.note);
  });

  test("EL2 layer-events: governor HOLD / closed store -> cacheKey null and {available:false} without a "
    + "transaction; admitted -> e1:<bucket>:<pulseMark>, a new pulse mark changes the key", () => {
    const { view, calls, st } = env([row({})]);
    st.admits = false;
    assert.strictEqual(view.cacheKey(), null);
    assert.deepStrictEqual(view.getData(), { available: false, reason: "GOVERNOR_HOLD" });
    st.admits = true;
    st.open = false;
    assert.strictEqual(view.cacheKey(), null);
    assert.deepStrictEqual(view.getData(), { available: false, reason: "STORE_CLOSED" });
    assert.deepStrictEqual(calls.tx, []);
    st.open = true;
    st.mark = 0;
    assert.strictEqual(view.cacheKey(), `e1:${Math.floor(NOW / REFRESH)}:0`);
    st.mark = NOW - 5;
    assert.strictEqual(view.cacheKey(), `e1:${Math.floor(NOW / REFRESH)}:${NOW - 5}`);
  });

  test("EL3 layer-events: labels and causes stay raw text (no escaping, no markup added); items are numbers "
    + "strings / string arrays; legend colours only from the fixed palette", () => {
    const { view } = env([row({ label: "<b>x</b>", cause: "<img src=x>" })]);
    const data = view.getData();
    const [item] = data.items;
    assert.strictEqual(item[2], "<b>x</b>");
    assert.ok(item[3][0].includes("cause <img src=x>"), item[3][0]);
    for (const it of data.items) {
      assert.deepStrictEqual([typeof it[0], typeof it[1], typeof it[2], Array.isArray(it[3])],
        ["number", "string", "string", true]);
      for (const l of it[3]) assert.strictEqual(typeof l, "string");
    }
    const palette = EVENT_STYLES.map((s) => s.colour);
    assert.deepStrictEqual(data.legend, LEGEND.map((l) => [...l]));
    for (const l of data.legend) {
      assert.match(l[2], /^#[0-9a-f]{6}$/);
      assert.ok(palette.includes(l[2]), l[2]);
    }
  });
};
