"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

const config = require("../../config");
const { createJournal } = require("../../lib/persistence/journal");
const { startNativeIncursions } = require("../../lib/nativeIncursions");
const { createNativeIncursionRepository } = require("../../lib/nativeIncursions/repository");
const NIS = require("../../lib/nativeIncursions/schema");
const SRC = require("../../lib/notices/sources");
const { createTail } = require("../../lib/notices/tail");
const { createNoticeRepository } = require("../../lib/notices/repository");
const { createViewRegistry } = require("../../lib/observer/views");
const { loadDriver, withStore } = require("../notices/storeHelper");
const { findCompose, readCompose } = require("../config/composeKeys.test");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const T0 = 1760000000000;
const TARGET = 30000014;
const TARGET_B = 30000020;
const NEAR = 30000015;
const TALE_A = 8000000000002;
const TALE_B = 8000000000004;
const TALE_C = 8000000000006;
const TALE_D = 8000000000008;
const CHARS = [91000001, 91000002];
const BASE_ENV = { EVEJS_DATA_ROOT: os.tmpdir(), EVEJS_LNE_NATIVE_INCURSIONS_ENABLED: "1",
  EVEJS_LNE_NATIVE_INCURSIONS_SETTLE_ENABLED: "1" };

const cfg = (env = {}) => {
  const r = config.resolveConfig({ modDir: MOD_DIR, env: { ...BASE_ENV, ...env } });
  assert.deepStrictEqual(r.errors || [], []);
  return r;
};

function tx(store, fn) {
  const r = store.transaction("t", fn);
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
}

function bindRow(store, journal, repo, taleId, targetSystemId, at) {
  tx(store, (db) => {
    const ap = journal.applyOnce(db, { key: NIS.bindKey(taleId, 1), aggregate: { type: NIS.AGGREGATE,
      id: String(taleId) }, eventType: NIS.EVENT_BIND, payload: { taleId, generation: 1 } },
    (db2) => repo.insertBoundInTx(db2, { taleId, generation: 1, factionId: 500019, constellationId: 20000002,
      band: "null", targetSystemId, steered: true, boundAt: at, expiresAt: at + 600000 }));
    assert.ok(ap.ok, JSON.stringify(ap));
    return ap;
  });
}

function settleRow(store, journal, repo, taleId, targetSystemId, outcome, at) {
  tx(store, (db) => {
    const ap = journal.applyOnce(db, { key: NIS.settleKey(taleId, 1), aggregate: { type: NIS.AGGREGATE,
      id: String(taleId) }, eventType: NIS.EVENT_SETTLE, payload: { taleId, generation: 1, outcome, targetSystemId } },
    (db2) => repo.settleInTx(db2, taleId, 1, { outcome, terminalEventId: null, effect: "RECORDED", settledAt: at }));
    assert.ok(ap.ok, JSON.stringify(ap));
    return ap;
  });
}

const fakeAdapter = () => ({
  nativeIncursionsSetTargets: () => ({ ok: true, installed: false }),
  nativeIncursionsListTales: () => ({ ok: true, tales: [], truncated: false }),
  nativeIncursionsBossParticipants: () => ({ ok: true, characterIds: [] }),
  nativeIncursionsVendorBands: () => ({ ok: true, bands: { high: true, low: false, null: true } }),
  nativeIncursionsStats: () => ({ installed: true, drift: false, hits: 0, passthrough: 0, exclusiveNull: 0,
    errors: 0, steerLog: [] }),
});

function tailOf(store, journal, settings, extra) {
  const graph = { getNeighbors: (id) => (id === TARGET ? [NEAR] : (id === NEAR ? [TARGET] : [])),
    getSystem: (id) => ({ name: `S${id}`, regionId: null }) };
  return createTail({ store, journal, repo: createNoticeRepository(), settings,
    getWorldRepository: () => ({ listSystems: () => ({ ok: true, systems: [], nextAfterSystemId: null }) }),
    getPresence: () => ({ getStatus: () => ({ available: true, stale: false }),
      getSystemPresence: (id) => ({ characters: id === NEAR ? CHARS.map((characterId) => ({ characterId })) : [] }) }),
    getGraph: () => ({ getGraph: () => ({ ok: true, graph }) }), ...extra });
}

module.exports = ({ test, skip }) => {
  test("NI12 config: 5 keys (defaults, clamps), W248, compose lines, native kinds not ship AI world news", () => {
    const d = config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir() } }).config.nativeIncursions;
    assert.deepStrictEqual([d.observerEnabled, d.noticesEnabled, d.observerSettledRows, d.noticeRadiusJumps,
      d.noticeMaxRecipients], [false, false, 16, 3, 50]);
    const hi = cfg({ EVEJS_LNE_NATIVE_INCURSIONS_OBSERVER_SETTLED_ROWS: "999",
      EVEJS_LNE_NATIVE_INCURSIONS_NOTICE_RADIUS_JUMPS: "99", EVEJS_LNE_NATIVE_INCURSIONS_NOTICE_MAX_RECIPIENTS: "0" })
      .config.nativeIncursions;
    assert.deepStrictEqual([hi.observerSettledRows, hi.noticeRadiusJumps, hi.noticeMaxRecipients], [64, 10, 1]);
    const w = (env) => cfg(env).warnings.filter((x) => x.includes("W248"));
    assert.strictEqual(w({ EVEJS_LNE_NATIVE_INCURSIONS_NOTICES_ENABLED: "1", EVEJS_LNE_NOTICES_ENABLED: "0" }).length, 1);
    assert.strictEqual(w({ EVEJS_LNE_NATIVE_INCURSIONS_NOTICES_ENABLED: "1", EVEJS_LNE_NOTICES_ENABLED: "1" }).length, 0);
    assert.strictEqual(w({}).length, 0);
    const { WORLD_NOTICE_KINDS } = require("../../lib/shipAi/triggers");
    assert.ok(SRC.KINDS.includes("NATIVE_INCURSION_STARTED") && SRC.KINDS.includes("NATIVE_INCURSION_ENDED"));
    assert.ok(!WORLD_NOTICE_KINDS.includes("NATIVE_INCURSION_STARTED")
      && !WORLD_NOTICE_KINDS.includes("NATIVE_INCURSION_ENDED"), "native incursion kinds are not world notices");
    const composeFile = findCompose();
    if (!composeFile) return;
    const text = fs.readFileSync(composeFile, "utf8");
    const { env } = readCompose(composeFile);
    for (const suffix of ["OBSERVER_ENABLED", "NOTICES_ENABLED", "OBSERVER_SETTLED_ROWS", "NOTICE_RADIUS_JUMPS",
      "NOTICE_MAX_RECIPIENTS"]) {
      const key = `EVEJS_LNE_NATIVE_INCURSIONS_${suffix}`;
      assert.ok(Object.prototype.hasOwnProperty.call(env, key), `compose env ${key}`);
      assert.ok(text.includes(`\${${key}:-}`), `compose \${${key}:-}`);
    }
  });

  const driver = loadDriver();
  if (!driver.ok) {
    skip("NI9-NI11 native incursions visibility", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }

  test("NI9 views: layer marks 26 + panel 78 on 1 BOUND + 2 SETTLED; flag off = no registerView; galaxy off = panel", () => {
    withStore(driver, (opened) => {
      const store = opened.store;
      const clock = { now: () => T0 };
      const journal = createJournal({ clock, maxPayloadBytes: 16384, maxRows: 500 });
      const repo = createNativeIncursionRepository();
      bindRow(store, journal, repo, TALE_A, TARGET, T0 - 60000);
      bindRow(store, journal, repo, TALE_B, TARGET_B, T0 - 50000);
      bindRow(store, journal, repo, TALE_C, TARGET_B, T0 - 40000);
      settleRow(store, journal, repo, TALE_B, TARGET_B, "defeated", T0 - 30000);
      settleRow(store, journal, repo, TALE_C, TARGET_B, "expired", T0 - 20000);
      const boot = (env) => {
        const calls = [];
        const reg = createViewRegistry();
        const views = { registerView: (id, def) => {
          calls.push(id);
          return reg.registerView(id, def);
        } };
        const started = startNativeIncursions({ config: cfg(env).config, clock, adapter: fakeAdapter(),
          persistence: { ok: true, store, journal }, views,
          getGraph: () => ({ getSystem: (id) => ({ name: `S${id}` }) }),
          setTimer: () => ({ cancel() {}, hasRef: () => false }) });
        assert.strictEqual(started.ok, true, JSON.stringify(started));
        return { svc: started.nativeIncursions, calls, reg };
      };
      const off = boot({});
      assert.deepStrictEqual(off.calls, [], "observerEnabled off: registerView never called");
      off.svc.stop();
      const noGalaxy = boot({ EVEJS_LNE_NATIVE_INCURSIONS_OBSERVER_ENABLED: "1", EVEJS_LNE_OBSERVER_GALAXY_ENABLED: "0" });
      assert.deepStrictEqual(noGalaxy.calls, [NIS.VIEW_ID]);
      noGalaxy.svc.stop();

      const on = boot({ EVEJS_LNE_NATIVE_INCURSIONS_OBSERVER_ENABLED: "1" });
      assert.deepStrictEqual(on.calls, [NIS.VIEW_ID, NIS.LAYER_ID]);
      on.svc.runPass(T0);
      const layer = on.reg.getView(NIS.LAYER_ID);
      assert.deepStrictEqual([layer.listed, layer.mapLayer], [false, { kind: "marks", order: 26 }]);
      const ld = layer.getData();
      assert.strictEqual(ld.available, true, JSON.stringify(ld));
      assert.deepStrictEqual(ld.items, [[TARGET, "bound", "I", [`tale ${TALE_A} g1 null steered`, "9 min left"], null]]);
      const sandbox = { window: {} };
      vm.runInNewContext(fs.readFileSync(path.join(MOD_DIR, "web", "galaxy.js"), "utf8"), sandbox,
        { filename: "galaxy.js" });
      const pure = sandbox.window.LneGalaxy._pure;
      assert.deepStrictEqual(ld.legend.map((l) => [l[0], pure.markShape(l[3])]), [["bound", "diamond"]]);
      const panel = on.reg.getView(NIS.VIEW_ID);
      assert.deepStrictEqual([panel.listed, panel.order], [true, 78]);
      const pd = panel.getData();
      assert.strictEqual(pd.available, true, JSON.stringify(pd));
      assert.deepStrictEqual(pd.bound.map((b) => [b.taleId, b.targetSystemId, b.system, b.steered]),
        [[TALE_A, TARGET, `S${TARGET}`, true]]);
      assert.deepStrictEqual(pd.settled.map((s) => [s.taleId, s.outcome, s.effect, s.settledAt]),
        [[TALE_C, "expired", "RECORDED", T0 - 20000], [TALE_B, "defeated", "RECORDED", T0 - 30000]]);
      assert.deepStrictEqual([pd.status.vendorBands, pd.status.drift, pd.status.mode],
        [{ high: true, low: false, null: true }, false, "steer"]);
      on.svc.stop();
      assert.deepStrictEqual([on.reg.getView(NIS.VIEW_ID), on.reg.getView(NIS.LAYER_ID)], [null, null], "stop unregisters");
    });
  });

  test("NI10 classification: BIND / defeated / expired -> 3 events, vanished none; off: base aggregates, 0 events", () => {
    withStore(driver, (opened) => {
      const store = opened.store;
      const clock = { now: () => T0 };
      const journal = createJournal({ clock, maxPayloadBytes: 16384, maxRows: 500 });
      const repo = createNativeIncursionRepository();
      const head = tx(store, (db) => journal.headId(db)).headId;
      bindRow(store, journal, repo, TALE_A, TARGET, T0);
      bindRow(store, journal, repo, TALE_B, TARGET, T0);
      bindRow(store, journal, repo, TALE_C, TARGET_B, T0);
      bindRow(store, journal, repo, TALE_D, TARGET_B, T0);
      settleRow(store, journal, repo, TALE_B, TARGET, "defeated", T0);
      settleRow(store, journal, repo, TALE_C, TARGET_B, "expired", T0);
      settleRow(store, journal, repo, TALE_D, TARGET_B, "vanished", T0);
      assert.deepStrictEqual([SRC.NATIVE_AGGREGATE, SRC.NATIVE_EVENT_BIND, SRC.NATIVE_EVENT_SETTLE,
        SRC.NATIVE_FACTION_ID, SRC.nativeNoticeKeyOf(5, "bound")], [NIS.AGGREGATE, NIS.EVENT_BIND, NIS.EVENT_SETTLE,
        NIS.NATIVE_FACTION_ID, NIS.noticeKeyOf(5, NIS.NOTICE_STATE.BOUND)]);
      assert.ok(!SRC.AGGREGATE_TYPES.includes(NIS.AGGREGATE), "AGGREGATE_TYPES unchanged");
      const listed = tx(store, (db) => journal.listAfter(db, { afterId: head, uptoId: head + 100,
        aggregateTypes: [...SRC.AGGREGATE_TYPES, SRC.NATIVE_AGGREGATE], limit: 50 }));
      assert.ok(listed.ok, JSON.stringify(listed));
      const bindIds = SRC.nativeBindTaleIds(listed.entries, 10);
      assert.deepStrictEqual(bindIds, [TALE_A, TALE_B, TALE_C, TALE_D]);
      const r = SRC.classifyEntries(listed.entries.filter((e) => e.eventType !== NIS.EVENT_BIND
        || e.payload.taleId === TALE_A), new Map(), { now: T0, maxEventAgeMs: 3600000, kinds: new Set(SRC.KINDS),
        nativeTargets: new Map([[TALE_A, TARGET]]) });
      assert.deepStrictEqual(r.events.map((e) => [e.kind, e.eventKey, e.systemId, e.attacker, e.outcome || null]), [
        ["NATIVE_INCURSION_STARTED", `nincursion:notice:${TALE_A}:bound`, TARGET, 500019, null],
        ["NATIVE_INCURSION_ENDED", `nincursion:notice:${TALE_B}:defeated`, TARGET, 500019, "defeated"],
        ["NATIVE_INCURSION_ENDED", `nincursion:notice:${TALE_C}:expired`, TARGET_B, 500019, "expired"]]);
      const missing = SRC.classifyEntries(listed.entries.filter((e) => e.eventType === NIS.EVENT_BIND), new Map(),
        { now: T0, maxEventAgeMs: 3600000, kinds: new Set(SRC.KINDS), nativeTargets: new Map() });
      assert.deepStrictEqual([missing.events.length, missing.skipped], [0, { BAD_PAYLOAD: 4 }]);

      const asked = [];
      let heads = 0;
      const fakeJournal = { headId: () => {
        heads += 1;
        return { ok: true, headId: heads === 1 ? head : head + 7 };
      },
        listAfter: (_db, o) => {
          asked.push([...o.aggregateTypes]);
          const entries = listed.entries.filter((e) => o.aggregateTypes.includes(e.aggregateType));
          return { ok: true, entries, scannedUpTo: o.uptoId };
        } };
      const settings = cfg().config.notices;
      let queued = 0;
      const tail = tailOf(store, fakeJournal, settings, { enqueue: (_db, items) => {
        queued += items.length;
        return { ok: true, inserted: items.length, duplicates: 0 };
      } });
      assert.strictEqual(tail.bootstrap().ok, true);
      const pass = tail.runPass(T0);
      assert.ok(pass.ok, JSON.stringify(pass));
      assert.deepStrictEqual(asked, [[...SRC.AGGREGATE_TYPES]]);
      assert.deepStrictEqual([pass.events, queued], [0, 0]);
    });
  });

  test("NI11 duplicate: the same rows queued twice -> one line per character, itemsDuplicate = recipients", () => {
    withStore(driver, (opened) => {
      const store = opened.store;
      const clock = { now: () => T0 };
      const journal = createJournal({ clock, maxPayloadBytes: 16384, maxRows: 500 });
      const repo = createNativeIncursionRepository();
      const notices = createNoticeRepository();
      const head = tx(store, (db) => journal.headId(db)).headId;
      bindRow(store, journal, repo, TALE_A, TARGET, T0);
      settleRow(store, journal, repo, TALE_A, TARGET, "defeated", T0);
      const c = cfg({ EVEJS_LNE_NATIVE_INCURSIONS_NOTICES_ENABLED: "1", EVEJS_LNE_NOTICES_ENABLED: "1" }).config;
      const counters = { itemsQueued: 0, itemsDuplicate: 0 };
      const enqueue = (db, items, now) => {
        const r = notices.enqueueItemsInTx(db, items, now);
        if (r.ok) {
          counters.itemsQueued += r.inserted;
          counters.itemsDuplicate += r.duplicates;
        }
        return r;
      };
      const run = () => {
        let boot = true;
        const j = { ...journal, headId: (db) => (boot ? { ok: true, headId: head } : journal.headId(db)) };
        const tail = tailOf(store, j, c.notices, { enqueue, nativeSettings: { radiusJumps: c.nativeIncursions
          .noticeRadiusJumps, maxRecipients: c.nativeIncursions.noticeMaxRecipients },
        getNativeIncursionRow: (db, taleId) => repo.getInTx(db, taleId) });
        assert.strictEqual(tail.bootstrap().ok, true);
        boot = false;
        const p = tail.runPass(T0);
        assert.ok(p.ok, JSON.stringify(p));
        return p;
      };
      assert.strictEqual(run().events, 2);
      assert.deepStrictEqual(counters, { itemsQueued: 4, itemsDuplicate: 0 });
      assert.strictEqual(run().events, 2);
      assert.deepStrictEqual(counters, { itemsQueued: 4, itemsDuplicate: 4 });
      const rows = tx(store, (db) => db.prepare("SELECT event_key AS k, character_id AS c, kind, line FROM "
        + "world_notice_items ORDER BY event_key, character_id").all());
      assert.deepStrictEqual(rows.map((x) => [x.k, Number(x.c), x.kind]), [
        [`nincursion:notice:${TALE_A}:bound`, CHARS[0], "NATIVE_INCURSION_STARTED"],
        [`nincursion:notice:${TALE_A}:bound`, CHARS[1], "NATIVE_INCURSION_STARTED"],
        [`nincursion:notice:${TALE_A}:defeated`, CHARS[0], "NATIVE_INCURSION_ENDED"],
        [`nincursion:notice:${TALE_A}:defeated`, CHARS[1], "NATIVE_INCURSION_ENDED"]]);
      assert.ok(rows[2].line.includes(`Sansha's Nation incursion in S${TARGET} was defeated.`), rows[2].line);
    });
  });
};
