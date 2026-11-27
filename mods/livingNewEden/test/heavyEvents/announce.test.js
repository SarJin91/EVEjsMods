"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { loadDriver, withStore } = require("../notices/storeHelper");
const { resolveConfig } = require("../../config");
const { createJournal } = require("../../lib/persistence/journal");
const { createManualClock } = require("../../lib/util/clock");
const { createNoticeRepository } = require("../../lib/notices/repository");
const { createTail } = require("../../lib/notices/tail");
const { createHeavyEventRepository } = require("../../lib/heavyEvents/repository");
const { buildHeavyEventsView, ROW_KEYS } = require("../../lib/heavyEvents/view");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const T0 = 1760000000000;
const SYS = 30002001;
const NEAR = 30002002;
const FAR = 30002003;
const C1 = 90000101;
const C2 = 90000102;
const C3 = 90000103;
const PIRATE = 500010;
const EMPIRE = 500001;

const EDGES = new Map([[SYS, [NEAR]], [NEAR, [SYS, FAR]], [FAR, [NEAR]]]);
const graph = Object.freeze({
  getNeighbors: (id) => EDGES.get(id) || null,
  getSystem: (id) => (EDGES.has(id) ? { systemId: id, name: `S-${id}`, regionId: 10000001 } : null),
  getRegionName: () => "Testregion",
});
const AT = new Map([[SYS, [C1]], [NEAR, [C2]], [FAR, [C3]]]);
const presenceOf = (stale) => Object.freeze({
  getStatus: () => ({ available: true, stale }),
  getSystemPresence: (id) => ({ characters: (AT.get(id) || []).map((characterId) => ({ characterId, name: "x",
    state: "space" })) }),
});

const CONFIG = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_NOTICES_ENABLED: "1" } }).config;

function env(opened, stale) {
  const store = opened.store;
  const clock = createManualClock(T0);
  const journal = createJournal({ clock, maxPayloadBytes: 8192, maxRows: 500 });
  const heavy = createHeavyEventRepository({ journal });
  const notices = createNoticeRepository();
  const counts = {};
  const tx = (fn) => {
    const r = store.transaction("test", fn);
    assert.ok(r.ok, JSON.stringify(r));
    return r.value;
  };
  const tail = createTail({ store, journal, repo: notices, settings: CONFIG.notices,
    heavySettings: { ...CONFIG.heavyEvents, announceRadiusJumps: 1 },
    enqueue: (db, items, now) => notices.enqueueItemsInTx(db, items, now),
    getWorldRepository: () => ({ listSystems: () => ({ ok: true, systems: [], nextAfterSystemId: null }) }),
    getPresence: () => presenceOf(stale), getGraph: () => ({ getGraph: () => ({ ok: true, graph }) }),
    adapter: { readFactionNames: () => ({ ok: true, names: new Map([[PIRATE, "Red Cutthroats"]]) }) },
    bump: (name, n = 1) => {
      counts[name] = (counts[name] || 0) + n;
    } });
  const plan = (eventId, eventType, tier, factionId, beneficiaryFactionId) => tx((db) => {
    const r = heavy.planInTx(db, { eventId, planKey: `1:${eventId}`, eventType, tier, systemId: SYS, factionId,
      beneficiaryFactionId, stationId: "st:1", funded: false, integrity: null, seed: 1, at: T0, expiresAt: T0 + 1000,
      dueAt: null, members: [{ key: "p1:0", phase: 1, step: null, hullGroup: "cruiser", state: "RESERVED" }] });
    assert.ok(r.ok, JSON.stringify(r));
  });
  const items = () => tx((db) => db.prepare(`SELECT character_id AS c, kind, line FROM world_notice_items
    ORDER BY character_id`).all());
  return { store, tx, tail, heavy, plan, items, counts };
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  if (!driver.ok) {
    skip("HA1-HA3 heavy events announce / panel", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }

  test("HA1 HEAVY_EVENT_PLANNED -> HEAVY_EVENT_STARTED for the players within announceRadiusJumps", () => withStore(
    driver, (opened) => {
      const e = env(opened, false);
      assert.ok(e.tail.bootstrap().ok);
      e.plan("hev:1:0", "redoubt", 2, PIRATE, null);
      const r = e.tail.runPass(T0);
      assert.ok(r.ok, JSON.stringify(r));
      const got = e.items();
      assert.deepStrictEqual(got.map((i) => [i.c, i.kind]), [[C1, "HEAVY_EVENT_STARTED"], [C2, "HEAVY_EVENT_STARTED"]]);
      assert.match(got[0].line, /Redoubt \(tier II\): Red Cutthroats have set up in S-30002001 \(Testregion\)/);
      assert.ok(e.tail.runPass(T0).ok);
      assert.strictEqual(e.items().length, 2, "a second pass queues nothing");
    }));

  test("HA2 panel heavy-events: open + ended rows with names, state and end reason", () => withStore(driver,
    (opened) => {
      const e = env(opened, false);
      e.plan("hev:1:0", "redoubt", 1, PIRATE, null);
      e.plan("hev:1:1", "defense", 3, PIRATE, EMPIRE);
      e.tx((db) => assert.ok(e.heavy.transitionInTx(db, { eventId: "hev:1:0", expectedVersion: 1, from: "PLANNED",
        to: "EXPIRED", patch: { endedAt: T0 + 5, endReason: "EXPIRED" }, at: T0 + 5, reason: "EXPIRED" }).ok));
      const view = buildHeavyEventsView({ store: e.store, repository: e.heavy, maxEnded: 20,
        graph: { getGraph: () => ({ ok: true, graph }) }, factionNames: new Map([[PIRATE, "Red Cutthroats"]]) });
      assert.strictEqual(view.listed, true);
      const data = view.getData();
      assert.strictEqual(data.available, true, JSON.stringify(data));
      assert.deepStrictEqual(data.open.map((r) => [r.eventId, r.eventType, r.tier, r.state, r.faction, r.beneficiary,
        r.system]), [["hev:1:1", "defense", 3, "PLANNED", "Red Cutthroats", null, "S-30002001"]]);
      assert.deepStrictEqual(data.ended.map((r) => [r.eventId, r.state, r.endReason, r.endedAt, r.open]),
        [["hev:1:0", "EXPIRED", "EXPIRED", T0 + 5, false]]);
      assert.deepStrictEqual(Object.keys(data.open[0]), [...ROW_KEYS]);
    }));

  test("HA3 presence stale -> no recipient, nothing queued", () => withStore(driver, (opened) => {
    const e = env(opened, true);
    assert.ok(e.tail.bootstrap().ok);
    e.plan("hev:1:0", "foundry", 1, PIRATE, null);
    assert.ok(e.tail.runPass(T0).ok);
    assert.deepStrictEqual(e.items(), []);
    assert.strictEqual(e.counts.recipientsUnavailable, 1);
  }));
};
