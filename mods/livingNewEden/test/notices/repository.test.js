"use strict";

const assert = require("node:assert");

const { LATEST_SCHEMA_VERSION } = require("../../lib/persistence/migrations");
const { createNoticeRepository } = require("../../lib/notices/repository");
const S = require("../../lib/notices/schema");
const { loadDriver, withStore } = require("./storeHelper");

const T0 = 1760000000000;
const CHAR_A = 90000001;
const CHAR_B = 90000002;
const SENDER = 140000004;

function item(key, characterId, extra = {}) {
  return { eventKey: key, characterId, kind: "ATTACK_STARTED", systemId: 30000142, line: `line ${key}`,
    eventAt: T0, ...extra };
}

const render = (lines) => ({ title: `T${lines.length}`, body: lines.join("<br>") });

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  if (!driver.ok) {
    skip("NR1 notices repository", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }

  test("NR1 migration 51, enqueue dedupe, open/finish SENT|FAILED|max attempts, expire, cap, prune", () => {
    withStore(driver, (opened) => {
      assert.ok(LATEST_SCHEMA_VERSION >= 51);
      assert.strictEqual(opened.schemaVersion, LATEST_SCHEMA_VERSION);
      const store = opened.store;
      const repo = createNoticeRepository();
      const tx = (fn) => {
        const r = store.transaction("test", fn);
        assert.ok(r.ok, JSON.stringify(r));
        return r.value;
      };
      const names = tx((db) => db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'world_notice%' ORDER BY name")
        .all().map((r) => r.name));
      assert.deepStrictEqual(names, ["world_notice_batches", "world_notice_batches_char", "world_notice_batches_sending",
        "world_notice_items", "world_notice_items_batch", "world_notice_items_done", "world_notice_items_pending",
        "world_notice_items_system"]);
      const stateOf = (key, c) => tx((db) => db.prepare(
        "SELECT state, batch_key AS b, attempts AS a FROM world_notice_items WHERE event_key = ? AND character_id = ?")
        .get(key, c));

      const first = tx((db) => repo.enqueueItemsInTx(db,
        Array.from({ length: 12 }, (_, i) => item(`k${i}`, CHAR_A)), T0));
      assert.deepStrictEqual(first, { ok: true, inserted: 12, duplicates: 0 });
      const again = tx((db) => repo.enqueueItemsInTx(db, [item("k0", CHAR_A), item("k0", CHAR_B)], T0));
      assert.deepStrictEqual(again, { ok: true, inserted: 1, duplicates: 1 });
      assert.strictEqual(tx((db) => repo.enqueueItemsInTx(db, [item("", CHAR_A)], T0)).reason, "INVALID_INPUT");

      const due = tx((db) => repo.listDueCharactersInTx(db, { now: T0, minMailIntervalMs: 60000, limit: 5 }));
      assert.deepStrictEqual(due.characterIds, [CHAR_A, CHAR_B]);

      const open1 = tx((db) => repo.openBatchInTx(db, { characterId: CHAR_A, senderId: SENDER, now: T0 + 1,
        maxItems: 10, render }));
      const b1 = open1.batch;
      assert.strictEqual(b1.batchKey, `b:${CHAR_A}:${T0 + 1}`);
      assert.strictEqual(b1.sentDate, ((BigInt(T0 + 1) * 10000n) + 116444736000000000n).toString());
      assert.strictEqual(b1.itemIds.length, 10);
      assert.strictEqual(b1.title, "T10");
      assert.deepStrictEqual(stateOf("k9", CHAR_A), { state: "SENDING", b: b1.batchKey, a: 1 });
      assert.deepStrictEqual(stateOf("k10", CHAR_A), { state: "PENDING", b: null, a: 0 });
      assert.deepStrictEqual(tx((db) => repo.listDueCharactersInTx(db, { now: T0 + 1, minMailIntervalMs: 60000,
        limit: 5 })).characterIds, [CHAR_B]);
      assert.deepStrictEqual(tx((db) => repo.listSendingInTx(db, 5)).batches.map((b) => b.batchKey), [b1.batchKey]);

      const f1 = tx((db) => repo.finishBatchInTx(db, b1.batchKey, { outcome: "FAILED", error: "MAIL_REFUSED",
        now: T0 + 2, maxAttempts: 2 }));
      assert.deepStrictEqual(f1, { ok: true, outcome: "FAILED", items: 10, requeued: 10, failed: 0 });
      assert.deepStrictEqual(stateOf("k0", CHAR_A), { state: "PENDING", b: null, a: 1 });
      assert.strictEqual(tx((db) => repo.finishBatchInTx(db, b1.batchKey, { outcome: "SENT", now: T0 + 2,
        maxAttempts: 2 })).reason, "STATE_MISMATCH");

      const b2 = tx((db) => repo.openBatchInTx(db, { characterId: CHAR_A, senderId: SENDER, now: T0 + 3,
        maxItems: 12, render })).batch;
      assert.strictEqual(b2.itemIds.length, 12);
      const f2 = tx((db) => repo.finishBatchInTx(db, b2.batchKey, { outcome: "LOST", now: T0 + 4, maxAttempts: 2 }));
      assert.deepStrictEqual(f2, { ok: true, outcome: "LOST", items: 12, requeued: 2, failed: 10 });
      assert.deepStrictEqual(stateOf("k0", CHAR_A), { state: "FAILED", b: b2.batchKey, a: 2 });
      assert.deepStrictEqual(stateOf("k11", CHAR_A), { state: "PENDING", b: null, a: 1 });

      const b3 = tx((db) => repo.openBatchInTx(db, { characterId: CHAR_A, senderId: SENDER, now: T0 + 5,
        maxItems: 10, render })).batch;
      assert.strictEqual(b3.itemIds.length, 2);
      const f3 = tx((db) => repo.finishBatchInTx(db, b3.batchKey, { outcome: "SENT", messageId: 77, now: T0 + 6,
        maxAttempts: 2 }));
      assert.deepStrictEqual(f3, { ok: true, outcome: "SENT", items: 2, requeued: 0, failed: 0 });
      assert.strictEqual(stateOf("k11", CHAR_A).state, "SENT");
      assert.strictEqual(tx((db) => db.prepare("SELECT message_id AS m FROM world_notice_batches WHERE batch_key = ?")
        .get(b3.batchKey)).m, 77);
      assert.strictEqual(tx((db) => repo.openBatchInTx(db, { characterId: CHAR_A, senderId: SENDER, now: T0 + 7,
        maxItems: 10, render })).batch, null);

      assert.deepStrictEqual(tx((db) => repo.expireInTx(db, { before: T0 + 1, limit: 10, now: T0 + 8 })),
        { ok: true, expired: 1 });
      assert.strictEqual(stateOf("k0", CHAR_B).state, "EXPIRED");

      tx((db) => repo.enqueueItemsInTx(db, Array.from({ length: 7 }, (_, i) => item(`c${i}`, CHAR_B,
        { kind: S.KIND_PLAYER_IMPACT, eventAt: T0 + 10 })), T0 + 10));
      assert.deepStrictEqual(tx((db) => repo.capPendingInTx(db, { characterId: CHAR_B, max: 5, now: T0 + 11 })),
        { ok: true, dropped: 2 });
      assert.strictEqual(stateOf("c0", CHAR_B).state, "DROPPED");
      assert.strictEqual(stateOf("c2", CHAR_B).state, "PENDING");
      assert.deepStrictEqual(tx((db) => repo.listImpactContributorsInTx(db, { systemId: 30000142, since: T0 + 10,
        limit: 5 })).characterIds, [CHAR_B]);

      const pr = tx((db) => repo.pruneInTx(db, { before: T0 + 100, limit: 1000 }));
      assert.deepStrictEqual(pr, { ok: true, items: 15, batches: 3 });
      const left = tx((db) => db.prepare("SELECT state, count(*) AS n FROM world_notice_items GROUP BY state").all());
      assert.deepStrictEqual(left.map((r) => [r.state, r.n]), [["PENDING", 5]]);
    }, { fresh: true });
  });
};
