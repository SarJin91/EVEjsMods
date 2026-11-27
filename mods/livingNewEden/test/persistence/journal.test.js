"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
const { resolveSqliteDriver } = require("../../lib/adapter/sqliteDriver");
const { MIGRATIONS, LATEST_SCHEMA_VERSION } = require("../../lib/persistence/migrations");
const { openStore } = require("../../lib/persistence/store");
const { seedDbFile } = require("../_support/dbTemplate");
const { createJournal } = require("../../lib/persistence/journal");
const { defineTable, updateWithVersion } = require("../../lib/persistence/repository");
const { createManualClock } = require("../../lib/util/clock");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const START_MS = 1760000000000;
const MAX_ROWS = 50;

function loadDriver() {
  const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
  if (!found.ok) return { ok: false, detail: found.reason };
  return resolveSqliteDriver(found.srcDir);
}

const EFFECT_MIGRATION = {
  version: LATEST_SCHEMA_VERSION + 1,
  name: "test_effects",
  up(db) {
    db.exec(`CREATE TABLE lne_effect (id INTEGER PRIMARY KEY, tag TEXT NOT NULL) STRICT;
      CREATE TABLE lne_fleet (fleet_id TEXT PRIMARY KEY NOT NULL, ships INTEGER NOT NULL,
        version INTEGER NOT NULL CHECK (version >= 1)) STRICT`);
  },
};

function withStore(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-j-"));
  const file = path.join(tmp, "world.sqlite");
  const open = [];
  const driver = loadDriver();
  const migrations = [...MIGRATIONS, EFFECT_MIGRATION];
  const reopen = () => {
    seedDbFile(driver, file, { migrations, seed: 1 });
    const opened = openStore({ filePath: file, openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
      busyTimeoutMs: 0, maxRowsPerTransaction: 500, maxWriteMsPerPass: 5, randomSeed: () => 1,
      migrations });
    assert.ok(opened.ok, JSON.stringify(opened));
    open.push(opened.store);
    return opened.store;
  };
  try {
    return fn(reopen);
  } finally {
    for (const s of open) s.close("test_cleanup");
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch (_err) {
    }
  }
}

function journalWith(counts, clock = createManualClock(START_MS), details = null) {
  return createJournal({ clock, maxPayloadBytes: 512, maxRows: MAX_ROWS,
    onCount: (name, n, detail) => {
      counts.push([name, n]);
      if (details && detail !== undefined) details.push({ ...detail });
    } });
}

const spec = (key, payload = { winner: "amarr", losses: [1, 2] }) => ({
  key, aggregate: { type: "battle", id: 77 }, eventType: "BATTLE_SETTLED", payload,
});

const addEffect = (tag) => (tx) => {
  tx.prepare("INSERT INTO lne_effect (tag) VALUES (?)").run(tag);
  return tag;
};

const effects = (store) => store.transaction("count", (tx) => tx.prepare("SELECT count(*) AS n FROM lne_effect").get().n)
  .value;

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("J1 journal: applyOnce twice = one effect, conflict on another payload, duplicate after restart", () => {
    withStore((reopen) => {
      const counts = [];
      const details = [];
      const journal = journalWith(counts, undefined, details);
      let store = reopen();
      const first = store.transaction("settle", (tx) => journal.applyOnce(tx, spec("battle:77:settle:v1"), addEffect("a")));
      assert.ok(first.ok && first.value.ok, JSON.stringify(first));
      assert.deepStrictEqual([first.value.duplicate, first.value.value], [false, "a"]);
      const id = first.value.journalId;
      assert.ok(Number.isSafeInteger(id) && id >= 1);

      const again = store.transaction("settle", (tx) => journal.applyOnce(tx, spec("battle:77:settle:v1"), addEffect("b")));
      assert.deepStrictEqual(again.value, { ok: true, duplicate: true, journalId: id, state: "APPLIED" });
      assert.deepStrictEqual(counts, [["journal.duplicate", 1]]);
      assert.strictEqual(effects(store), 1);

      const conflict = store.transaction("settle", (tx) => journal.applyOnce(tx,
        spec("battle:77:settle:v1", { winner: "minmatar" }), addEffect("c")));
      assert.deepStrictEqual(conflict.value, { ok: false, reason: "IDEMPOTENCY_CONFLICT", journalId: id });
      assert.deepStrictEqual(counts[1], ["journal.conflict", 1]);
      assert.deepStrictEqual(details, [{ kind: "APPLY", key: "battle:77:settle:v1", eventType: "BATTLE_SETTLED",
        aggregateType: "battle", aggregateId: "77", journalId: id, existingKind: "APPLY",
        existingEventType: "BATTLE_SETTLED", existingAggregateType: "battle", existingAggregateId: "77" }]);

      const typed = store.transaction("typeof", (tx) => tx.prepare(
        "SELECT typeof(created_at) AS c, typeof(applied_at) AS a, created_at FROM world_event_journal").get());
      assert.deepStrictEqual(typed.value, { c: "integer", a: "integer", created_at: START_MS });

      store.close("restart");
      store = reopen();
      const restarted = createJournal({ clock: createManualClock(START_MS + 5), maxPayloadBytes: 512, maxRows: MAX_ROWS });
      const replay = store.transaction("settle", (tx) => restarted.applyOnce(tx, spec("battle:77:settle:v1"),
        addEffect("d")));
      assert.deepStrictEqual(replay.value, { ok: true, duplicate: true, journalId: id, state: "APPLIED" });
      assert.strictEqual(effects(store), 1);
      const seq = store.transaction("seq", (tx) => tx.prepare("SELECT seq FROM sqlite_sequence WHERE name = ?")
        .get("world_event_journal"));
      assert.deepStrictEqual(seq.value, { seq: id });
    });
  });

  needsDriver("J2 journal: applyFn throws/refuses -> savepoint rollback, retry works, input refusals", () => {
    withStore((reopen) => {
      const counts = [];
      const journal = journalWith(counts);
      const store = reopen();
      const key = "battle:1:settle:v1";
      const failed = store.transaction("settle", (tx) => {
        tx.prepare("INSERT INTO lne_effect (tag) VALUES ('marker')").run();
        return journal.applyOnce(tx, spec(key), (tx2) => { addEffect("x")(tx2); throw new Error("boom"); });
      });
      assert.ok(failed.ok, "outer transaction commits");
      assert.strictEqual(failed.value.reason, "APPLY_FAILED");
      assert.strictEqual(failed.value.error.message, "boom");
      const tags = store.transaction("tags", (tx) => tx.prepare("SELECT tag FROM lne_effect").all().map((r) => r.tag));
      assert.deepStrictEqual(tags.value, ["marker"]);
      assert.deepStrictEqual(store.transaction("find", (tx) => journal.findByKey(tx, key)).value, { ok: true, found: false });

      const refused = store.transaction("settle", (tx) => journal.applyOnce(tx, spec(key), (tx2) => {
        addEffect("y")(tx2);
        return { ok: false, reason: "X" };
      }));
      assert.deepStrictEqual(refused.value, { ok: false, reason: "APPLY_REFUSED", refusal: { ok: false, reason: "X" } });
      assert.strictEqual(effects(store), 1, "marker only");

      const asyncFn = store.transaction("settle", (tx) => journal.applyOnce(tx, spec(key), async () => 1));
      assert.strictEqual(asyncFn.value.reason, "APPLY_FAILED");

      const fixed = store.transaction("settle", (tx) => journal.applyOnce(tx, spec(key), addEffect("z")));
      assert.deepStrictEqual([fixed.value.ok, fixed.value.duplicate], [true, false]);
      assert.strictEqual(effects(store), 2);

      let stale;
      store.transaction("grab", (tx) => { stale = tx; });
      assert.deepStrictEqual(journal.applyOnce(stale, spec("k2"), addEffect("q")), { ok: false, reason: "TX_REQUIRED" });

      const refuse = (s, fn = addEffect("r")) => store.transaction("bad", (tx) => journal.applyOnce(tx, s, fn)).value;
      assert.strictEqual(refuse(spec("")).reason, "JOURNAL_INVALID_INPUT");
      assert.strictEqual(refuse(spec("")).detail, "key");
      assert.strictEqual(refuse(spec("k3", { a: undefined })).reason, "JOURNAL_INVALID_INPUT");
      const cyclic = { a: 1 };
      cyclic.self = cyclic;
      const cycle = refuse(spec("k3", cyclic));
      assert.strictEqual(cycle.reason, "JOURNAL_INVALID_INPUT");
      assert.ok(/cycle/.test(cycle.detail), cycle.detail);
      const shared = { n: 1 };
      assert.ok(refuse(spec("k-dag", { a: shared, b: shared })).ok, "shared reference without a cycle is legal");
      const big = refuse(spec("k4", { blob: "x".repeat(600) }));
      assert.strictEqual(big.reason, "JOURNAL_PAYLOAD_TOO_LARGE");
      assert.ok(big.bytes > 512 && big.limit === 512);
      assert.strictEqual(refuse(spec("k5"), "not a function").detail, "applyFn");
      assert.strictEqual(refuse({ ...spec("k6"), eventType: "lower" }).detail, "eventType");
      assert.strictEqual(refuse({ ...spec("k7"), aggregate: { type: "Battle", id: 1 } }).detail, "aggregate.type");
      assert.strictEqual(effects(store), 3, "only the DAG payload applied");
    });
  });

  needsDriver("J3 journal: outbox PENDING survives restart in created_at order, mark*, listRecent feed", () => {
    withStore((reopen) => {
      const clock = createManualClock(START_MS);
      const journal = journalWith([], clock);
      let store = reopen();
      const outbox = (key, aggregateId) => ({ key, aggregate: { type: "site", id: aggregateId }, eventType: "SPAWN_SITE",
        payload: { systemId: 30000142 } });
      const ids = store.transaction("enqueue", (tx) => {
        const a = journal.enqueueOutbox(tx, outbox("site:a", "a"));
        clock.advance(10);
        const b = journal.enqueueOutbox(tx, outbox("site:b", "b"));
        const c = journal.enqueueOutbox(tx, outbox("site:c", "c"));
        const again = journal.enqueueOutbox(tx, outbox("site:a", "a"));
        assert.deepStrictEqual([again.duplicate, again.journalId, again.state], [true, a.journalId, "PENDING"]);
        return [a, b, c].map((r) => { assert.ok(r.ok && !r.duplicate); return r.journalId; });
      }).value;
      const applied = store.transaction("apply", (tx) => journal.applyOnce(tx, spec("battle:9:settle:v1"), () => 1)).value;
      store.close("restart");

      store = reopen();
      const pending = store.transaction("pending", (tx) => journal.listPending(tx, { limit: 10 })).value;
      assert.deepStrictEqual(pending.entries.map((e) => e.journalId), ids);
      assert.deepStrictEqual(pending.entries.map((e) => e.createdAt), [START_MS, START_MS + 10, START_MS + 10]);
      assert.deepStrictEqual(pending.entries[0].payload, { systemId: 30000142 });
      assert.strictEqual(pending.entries[0].appliedAt, null);

      const tx = (fn) => store.transaction("mark", fn).value;
      assert.deepStrictEqual(tx((t) => journal.markApplied(t, ids[0])), { ok: true, alreadyApplied: false });
      assert.deepStrictEqual(tx((t) => journal.markApplied(t, ids[0])), { ok: true, alreadyApplied: true });
      assert.deepStrictEqual(tx((t) => journal.markFailed(t, ids[0], "late")),
        { ok: false, reason: "JOURNAL_STATE_INVALID", state: "APPLIED" });
      assert.deepStrictEqual(tx((t) => journal.markFailed(t, ids[1], "e".repeat(1200))), { ok: true, alreadyFailed: false });
      assert.deepStrictEqual(tx((t) => journal.markFailed(t, ids[1], "again")), { ok: true, alreadyFailed: true });
      assert.deepStrictEqual(tx((t) => journal.markApplied(t, ids[1])),
        { ok: false, reason: "JOURNAL_STATE_INVALID", state: "FAILED" });
      assert.strictEqual(tx((t) => journal.findByKey(t, "site:b")).entry.error.length, 1000);
      assert.deepStrictEqual(tx((t) => journal.markApplied(t, 99999)), { ok: false, reason: "JOURNAL_NOT_FOUND" });
      assert.deepStrictEqual(tx((t) => journal.markApplied(t, applied.journalId)), { ok: false, reason: "JOURNAL_NOT_OUTBOX" });
      assert.strictEqual(tx((t) => journal.markApplied(t, 0)).reason, "JOURNAL_INVALID_INPUT");
      assert.deepStrictEqual(tx((t) => journal.listPending(t, { limit: 10 })).entries.map((e) => e.journalId), [ids[2]]);
      assert.strictEqual(tx((t) => journal.listPending(t, {})).reason, "JOURNAL_INVALID_INPUT");

      const recent = tx((t) => journal.listRecent(t, { limit: 2 }));
      assert.deepStrictEqual(recent.entries.map((e) => e.journalId), [applied.journalId, ids[2]]);
      assert.deepStrictEqual(tx((t) => journal.listRecent(t, { limit: 10, afterId: ids[1] })).entries.map((e) => e.journalId),
        [applied.journalId, ids[2]]);
      const capped = tx((t) => journal.listRecent(t, { limit: MAX_ROWS + 100 }));
      assert.deepStrictEqual([capped.limit, capped.entries.length], [MAX_ROWS, 4]);
      assert.strictEqual(tx((t) => journal.listRecent(t, { limit: 1, afterId: -1 })).reason, "JOURNAL_INVALID_INPUT");
      assert.strictEqual(journal.listPending(null, { limit: 1 }).reason, "TX_REQUIRED");
    });
  });

  needsDriver("J4 repository: updateWithVersion ok, VERSION_CONFLICT unchanged, refusals, conflict refuses applyOnce", () => {
    withStore((reopen) => {
      const store = reopen();
      const journal = journalWith([]);
      const fleets = defineTable({ name: "lne_fleet", idColumn: "fleet_id", columns: ["ships"] });
      assert.throws(() => defineTable({ name: "bad name", idColumn: "id", columns: ["a"] }), TypeError);
      const run = (fn) => store.transaction("repo", fn).value;
      run((tx) => tx.prepare("INSERT INTO lne_fleet (fleet_id, ships, version) VALUES ('f1', 10, 1)").run());
      const row = () => run((tx) => tx.prepare("SELECT ships, version FROM lne_fleet WHERE fleet_id = 'f1'").get());

      assert.deepStrictEqual(run((tx) => updateWithVersion(tx, fleets, "f1", 1, { ships: 8 })), { ok: true, version: 2 });
      assert.deepStrictEqual(run((tx) => updateWithVersion(tx, fleets, "f1", 1, { ships: 1 })),
        { ok: false, reason: "VERSION_CONFLICT", expectedVersion: 1, actualVersion: 2 });
      assert.deepStrictEqual(row(), { ships: 8, version: 2 });
      assert.deepStrictEqual(run((tx) => updateWithVersion(tx, fleets, "nope", 1, { ships: 1 })),
        { ok: false, reason: "ROW_NOT_FOUND" });
      assert.strictEqual(run((tx) => updateWithVersion(tx, fleets, "f1", 2, { version: 9 })).reason, "REPO_INVALID_INPUT");
      assert.strictEqual(run((tx) => updateWithVersion(tx, fleets, "f1", 2, { ships: true })).reason, "REPO_INVALID_INPUT");
      assert.strictEqual(run((tx) => updateWithVersion(tx, fleets, "f1", 2, { ships: NaN })).reason, "REPO_INVALID_INPUT");
      assert.strictEqual(updateWithVersion(null, fleets, "f1", 2, { ships: 1 }).reason, "TX_REQUIRED");

      const lost = run((tx) => journal.applyOnce(tx, spec("fleet:f1:move:v1"),
        (tx2) => updateWithVersion(tx2, fleets, "f1", 1, { ships: 0 })));
      assert.strictEqual(lost.reason, "APPLY_REFUSED");
      assert.strictEqual(lost.refusal.reason, "VERSION_CONFLICT");
      assert.deepStrictEqual(run((tx) => journal.findByKey(tx, "fleet:f1:move:v1")), { ok: true, found: false });
      assert.deepStrictEqual(row(), { ships: 8, version: 2 });
    });
  });

  needsDriver("R1 repository: integer into STRICT TEXT binds '5', descriptor cache, only defineTable", () => {
    withStore((reopen) => {
      const store = reopen();
      const run = (fn) => store.transaction("repo", fn).value;
      run((tx) => tx.exec(`CREATE TABLE lne_r1 (id TEXT PRIMARY KEY, t TEXT, n INTEGER, alt TEXT UNIQUE,
        version INTEGER NOT NULL) STRICT;
        INSERT INTO lne_r1 (id, t, n, alt, version) VALUES ('5', 'a', 1, 'x', 1), ('6', 'b', 2, 'y', 1)`));
      const byId = defineTable({ name: "lne_r1", idColumn: "id", columns: ["t", "n"] });
      const byAlt = defineTable({ name: "lne_r1", idColumn: "alt", columns: ["t", "n"] });

      assert.deepStrictEqual(run((tx) => updateWithVersion(tx, byId, 5, 1, { t: 5 })), { ok: true, version: 2 });
      assert.deepStrictEqual(run((tx) => tx.prepare("SELECT t, typeof(t) AS ty FROM lne_r1 WHERE id = '5'").get()),
        { t: "5", ty: "text" });
      assert.deepStrictEqual(run((tx) => updateWithVersion(tx, byAlt, "y", 1, { t: "z" })), { ok: true, version: 2 });
      assert.deepStrictEqual(run((tx) => updateWithVersion(tx, byId, "5", 2, { t: "w" })), { ok: true, version: 3 });
      assert.deepStrictEqual(run((tx) => tx.prepare("SELECT id, t, version FROM lne_r1 ORDER BY id").all()),
        [{ id: "5", t: "w", version: 3 }, { id: "6", t: "z", version: 2 }]);

      const lookAlike = Object.freeze({ name: "lne_r1", idColumn: "id", columns: Object.freeze(["t"]) });
      const refused = (table, id) => run((tx) => updateWithVersion(tx, table, id, 3, { t: "q" })).reason;
      assert.strictEqual(refused(lookAlike, "5"), "REPO_INVALID_INPUT");
      assert.strictEqual(refused(byId, 2n ** 64n), "REPO_INVALID_INPUT");
    });
  });

  needsDriver("R2 journal: scanKeyRange order:recent returns newest first, rejects after+order:recent", () => {
    withStore((reopen) => {
      const counts = [];
      const journal = journalWith(counts);
      const store = reopen();
      const now = createManualClock(START_MS);

      const insertOrder = ["r:c", "r:a", "r:e", "r:b", "r:d"];
      for (let i = 0; i < insertOrder.length; i += 1) {
        now.advance(1);
        const spec = { key: insertOrder[i], aggregate: { type: "test", id: 1 }, eventType: "TEST", payload: { n: i } };
        const res = store.transaction("ins", (tx) => journal.applyOnce(tx, spec, (tx2) => tx2.prepare("INSERT INTO lne_effect (tag) VALUES (?)").run(insertOrder[i])));
        assert.ok(res.ok && res.value.ok, JSON.stringify(res));
      }

      const noOrder = store.transaction("scan", (tx) => journal.scanKeyRange(tx, "r:a", "r:z", 3, {}));
      assert.ok(noOrder.ok, JSON.stringify(noOrder));
      assert.deepStrictEqual(noOrder.value.rows.map((r) => r.key), ["r:a", "r:b", "r:c"]);

      const recent = store.transaction("scan", (tx) => journal.scanKeyRange(tx, "r:a", "r:z", 3, { order: "recent" }));
      assert.ok(recent.ok, JSON.stringify(recent));
      assert.deepStrictEqual(recent.value.rows.map((r) => r.key), ["r:d", "r:b", "r:e"]);

      const invalid = store.transaction("scan", (tx) => journal.scanKeyRange(tx, "r:a", "r:z", 3, { after: true, order: "recent" }));
      assert.deepStrictEqual(invalid.value, { ok: false, reason: "JOURNAL_INVALID_INPUT", detail: "opts" });

      const outside = store.transaction("scan", (tx) => journal.scanKeyRange(tx, "r:a", "r:d", 10, { order: "recent" }));
      assert.ok(outside.ok, JSON.stringify(outside));
      assert.deepStrictEqual(outside.value.rows.map((r) => r.key), ["r:b", "r:a", "r:c"]);
      assert.strictEqual(outside.value.rows.find((r) => r.key === "r:e"), undefined);
      assert.strictEqual(outside.value.rows.find((r) => r.key === "r:d"), undefined);
    });
  });

  needsDriver("J5 journal: listAfter ascending, uptoId window, type filter, scannedUpTo; headId empty/non-empty",
    () => {
      withStore((reopen) => {
        const journal = journalWith([]);
        const store = reopen();
        const read = (fn) => {
          const r = store.transaction("read", fn);
          assert.ok(r.ok, JSON.stringify(r));
          return r.value;
        };
        assert.deepStrictEqual(read((tx) => journal.headId(tx)), { ok: true, headId: 0 });
        const types = ["world_system", "station_siege", "world_system", "battle", "world_system"];
        const ids = types.map((type, i) => {
          const r = store.transaction("ins", (tx) => journal.applyOnce(tx, { key: `t:${i}`,
            aggregate: { type, id: i + 1 }, eventType: "TEST", payload: { n: i } }, () => ({ ok: true })));
          assert.ok(r.ok && r.value.ok, JSON.stringify(r));
          return r.value.journalId;
        });
        const head = read((tx) => journal.headId(tx)).headId;
        assert.strictEqual(head, ids[4]);
        const all = read((tx) => journal.listAfter(tx, { afterId: 0, uptoId: head,
          aggregateTypes: ["world_system", "station_siege"], limit: 10 }));
        assert.deepStrictEqual(all.entries.map((e) => [e.journalId, e.aggregateType, e.payload.n]),
          [[ids[0], "world_system", 0], [ids[1], "station_siege", 1], [ids[2], "world_system", 2],
            [ids[4], "world_system", 4]]);
        assert.strictEqual(all.scannedUpTo, head, "limit not full -> uptoId");
        const full = read((tx) => journal.listAfter(tx, { afterId: 0, uptoId: head, aggregateTypes: ["world_system"],
          limit: 2 }));
        assert.deepStrictEqual([full.entries.map((e) => e.journalId), full.scannedUpTo], [[ids[0], ids[2]], ids[2]]);
        const window = read((tx) => journal.listAfter(tx, { afterId: ids[0], uptoId: ids[3],
          aggregateTypes: ["world_system"], limit: 10 }));
        assert.deepStrictEqual([window.entries.map((e) => e.journalId), window.scannedUpTo], [[ids[2]], ids[3]]);
        assert.deepStrictEqual(read((tx) => journal.listAfter(tx, { afterId: 3, uptoId: 2, aggregateTypes: ["a"],
          limit: 1 })), { ok: false, reason: "JOURNAL_INVALID_INPUT", detail: "uptoId" });
        assert.deepStrictEqual(read((tx) => journal.listAfter(tx, { afterId: 0, uptoId: 2, aggregateTypes: ["Bad"],
          limit: 1 })), { ok: false, reason: "JOURNAL_INVALID_INPUT", detail: "aggregateTypes" });
        assert.deepStrictEqual(read((tx) => journal.listAfter(tx, { afterId: 0, uptoId: 2, aggregateTypes: ["a"],
          limit: MAX_ROWS + 1 })), { ok: false, reason: "JOURNAL_INVALID_INPUT", detail: "limit" });
        read((tx) => tx.prepare("DELETE FROM world_event_journal WHERE journal_id > ?").run(ids[0]));
        assert.strictEqual(read((tx) => journal.headId(tx)).headId, ids[4], "sequence, not max(journal_id)");
        const next = store.transaction("ins", (tx) => journal.applyOnce(tx, { key: "t:after-reset",
          aggregate: { type: "world_system", id: 9 }, eventType: "TEST", payload: { n: 9 } }, () => ({ ok: true })));
        assert.strictEqual(next.value.journalId, ids[4] + 1);
        assert.strictEqual(read((tx) => journal.headId(tx)).headId, ids[4] + 1);
      });
    });
};
