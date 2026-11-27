"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { createJournal } = require("../../lib/persistence/journal");
const { createWorldStateRepository } = require("../../lib/world/worldStateRepository");
const { createNoticeRepository } = require("../../lib/notices/repository");
const { createTail } = require("../../lib/notices/tail");
const { startNotices, MAX_WAR_LISTENERS } = require("../../lib/notices");
const { createManualClock } = require("../../lib/util/clock");
const { resolveConfig } = require("../../config");
const F = require("./sourceFixture");
const { loadDriver, withStore } = require("./storeHelper");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const T0 = 1760000000000;
const SYS = 30002101;
const C1 = 90000201;
const LIMITS = Object.freeze({ maxFactionsPerSystem: 8, maxBatchReadIds: 400, maxListLimit: 500 });
const graph = Object.freeze({
  getNeighbors: (id) => (id === SYS ? [] : null),
  getSystem: (id) => (id === SYS ? { systemId: id, name: "Ichoriya", regionId: 10000002 } : null),
  getRegionName: () => "The Forge",
});
const presence = Object.freeze({
  getStatus: () => ({ available: true, stale: false }),
  getSystemPresence: (id) => ({ characters: id === SYS ? [{ characterId: C1, name: "x", state: "space" }] : [] }),
});
const NAMES = new Map([[F.ATTACKER, "Amarr Empire"], [F.DEFENDER, "Sansha's Nation"]]);
const adapter = Object.freeze({ readFactionNames: () => ({ ok: true, names: NAMES }),
  sendPlayerMail: () => ({ ok: true, messageId: 1 }), findPlayerMail: () => ({ ok: true, found: false }),
  defaultMailSender: () => ({ ok: true, senderId: 7 }) });

function config() {
  return resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_NOTICES_ENABLED: "1" } }).config;
}

function env(opened) {
  const clock = createManualClock(T0);
  const journal = createJournal({ clock, maxPayloadBytes: 8192, maxRows: 500 });
  const world = createWorldStateRepository({ journal, clock, limits: LIMITS });
  const repo = createNoticeRepository();
  const store = opened.store;
  const tx = (fn) => {
    const r = store.transaction("test", fn);
    assert.ok(r.ok, JSON.stringify(r));
    return r.value;
  };
  let version = 0;
  const change = (state, reason, key) => {
    const r = tx((db) => world.applyChange(db, { systemId: SYS, expectedVersion: version, reason, state }, key));
    assert.ok(r.ok && !r.duplicate, JSON.stringify(r));
    version = r.version;
    return r.journalId;
  };
  const seed = () => change({ securityClass: "nullsec", controllerFactionId: F.DEFENDER }, "SEED_CONTROL", "we:seed");
  const p = F.occupationSteps(SYS);
  const attack = () => {
    change({ occupationState: "CONTESTED", occupierFactionId: F.ATTACKER }, "OCCUPATION_SIGNAL", "we:sig");
    return change(p.invade, "OCCUPATION_PHASE_CHANGE", "we:inv");
  };
  const capture = () => change(p.capture, "OCCUPATION_PHASE_CHANGE", "we:cap");
  const release = () => change({ occupationState: "STABLE", controllerFactionId: null,
    previousControllerFactionId: F.ATTACKER, occupierFactionId: null, capturedAt: null }, "OCCUPATION_ABANDON",
  "we:release");
  const makeTail = (deps) => createTail({ store, journal, repo, settings: config().notices,
    enqueue: (db, items, now) => repo.enqueueItemsInTx(db, items, now),
    getWorldRepository: () => world, getPresence: () => presence,
    getGraph: () => ({ getGraph: () => ({ ok: true, graph }) }), adapter, listLimit: 500, ...deps });
  const head = () => tx((db) => journal.headId(db)).headId;
  return { clock, journal, world, store, seed, attack, capture, release, makeTail, head };
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  if (!driver.ok) {
    skip("CH5 notices war events hook", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }

  test("CH5 notices.onWarEvents: views only after the commit of notices.tail (names, place), a throwing / refusing "
    + "enqueue -> zero calls and the cursor unchanged, no listener -> no views; a throwing listener -> cursor moves, "
    + "warListenerErrors 1", () => {
    withStore(driver, (opened) => {
      const e = env(opened);
      e.seed();
      const calls = [];
      let mode = "ok";
      let listening = true;
      const t = e.makeTail({
        enqueue: (db, items, now) => {
          if (mode === "throw") throw new Error("enqueue boom");
          if (mode === "refuse") return { ok: false, reason: "TEST_REFUSED" };
          return createNoticeRepository().enqueueItemsInTx(db, items, now);
        },
        hasWarListeners: () => listening,
        onCommitted: (views) => calls.push({ views }),
      });
      assert.ok(t.bootstrap().ok);
      const start = t.getStatus().cursor;
      e.attack();
      for (const m of ["throw", "refuse"]) {
        mode = m;
        const r = t.runPass(e.clock.now());
        assert.strictEqual(r.ok, false, `${m}: ${JSON.stringify(r)}`);
        assert.deepStrictEqual([calls.length, t.getStatus().cursor], [0, start], `${m}: zero calls, cursor unchanged`);
      }
      mode = "ok";
      const r = t.runPass(e.clock.now());
      assert.deepStrictEqual([r.ok, r.events, t.getStatus().cursor], [true, 1, e.head()], JSON.stringify(r));
      assert.strictEqual(calls.length, 1);
      const [v] = calls[0].views;
      assert.deepStrictEqual(v, { eventKey: v.eventKey, kind: "ATTACK_STARTED", systemId: SYS, at: v.at,
        attackerName: "Amarr Empire", defenderName: "Sansha's Nation", systemName: "Ichoriya",
        regionName: "The Forge", recipients: [C1], outcome: null });
      assert.ok(Object.isFrozen(v) && Object.isFrozen(calls[0].views) && calls[0].views.length === 1);
      assert.ok(typeof v.eventKey === "string" && v.eventKey.endsWith(":ATTACK_STARTED"), v.eventKey);

      listening = false;
      e.capture();
      assert.strictEqual(t.runPass(e.clock.now()).events, 1);
      assert.strictEqual(calls.length, 1, "no listener -> no call");

      const ctx = { persistence: { ok: true, store: e.store, journal: e.journal }, world: { repository: e.world },
        presence, graph: { getGraph: () => ({ ok: true, graph }) } };
      const started = startNotices({ config: config(), ctx, adapter, clock: e.clock,
        setTimer: () => ({ cancel: () => {} }) });
      assert.ok(started.ok, JSON.stringify(started));
      const n = started.notices;
      assert.deepStrictEqual(n.onWarEvents(42), { ok: false, reason: "BAD_LISTENER" });
      const got = [];
      const quiet = n.onWarEvents((views) => got.push(views.length));
      const loud = n.onWarEvents(() => { throw new Error("listener boom"); });
      assert.ok(quiet.ok && loud.ok);
      const extra = [];
      for (let i = 2; i < MAX_WAR_LISTENERS; i += 1) extra.push(n.onWarEvents(() => {}));
      assert.deepStrictEqual(n.onWarEvents(() => {}), { ok: false, reason: "TOO_MANY_LISTENERS" });
      for (const x of extra) {
        x.unsubscribe();
        x.unsubscribe();
      }
      e.release();
      n.stop("test");
      const st = n.getStatus();
      assert.deepStrictEqual([got, st.warListenerErrors, st.cursor], [[1], 1, e.head()], JSON.stringify(st));
      assert.deepStrictEqual(n.onWarEvents(() => {}), { ok: false, reason: "NOTICES_UNAVAILABLE" });
    });
  });
};
