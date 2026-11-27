"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { createNoticeRepository } = require("../../lib/notices/repository");
const { startNotices } = require("../../lib/notices");
const S = require("../../lib/notices/schema");
const { resolveConfig } = require("../../config");
const { loadDriver, withStore } = require("./storeHelper");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const T0 = 1760000000000;
const NOW = T0 + 3600000;
const SENDER = 140000004;
const [A, B, C, D, E, F, G] = [91000001, 91000002, 91000003, 91000004, 91000005, 91000006, 91000007];
const ETA = ["BATTLE_ETA"];
const render = (lines) => ({ title: `T${lines.length}`, body: lines.join("<br>") });

function line(key, characterId, kind = "ATTACK_STARTED") {
  return { eventKey: key, characterId, kind, systemId: 30000142, line: `line ${key}`, eventAt: T0 };
}

function config(env = {}) {
  return resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_NOTICES_ENABLED: "1", ...env } });
}

module.exports = ({ test, skip }) => {
  test("NPR3 config: defaults, parsePriorityKinds, a bad list ignored, warning priority > minMailIntervalMs", () => {
    const def = config();
    assert.deepStrictEqual([def.config.notices.priorityKinds, def.config.notices.priorityMinIntervalMs],
      ["BATTLE_ETA,HARVEST_RAID_WARNED", 60000]);
    assert.ok(!def.warnings.some((w) => w.includes("priority")), JSON.stringify(def.warnings));
    assert.deepStrictEqual([S.parsePriorityKinds("none"), S.parsePriorityKinds(" BATTLE_ETA , BATTLE_END "),
      S.parsePriorityKinds("battle_eta"), S.parsePriorityKinds("A,A"), S.parsePriorityKinds("HUNT_WARNING"),
      S.parsePriorityKinds("X".repeat(33)), S.parsePriorityKinds(7)],
    [[], ["BATTLE_ETA", "BATTLE_END"], null, null, null, null, null]);
    const off = config({ EVEJS_LNE_NOTICES_PRIORITY_KINDS: "none" });
    assert.strictEqual(off.config.notices.priorityKinds, "none");
    const bad = config({ EVEJS_LNE_NOTICES_PRIORITY_KINDS: "battle_eta" });
    assert.strictEqual(bad.config.notices.priorityKinds, "BATTLE_ETA,HARVEST_RAID_WARNED");
    assert.ok(bad.warnings.some((w) => w.includes("EVEJS_LNE_NOTICES_PRIORITY_KINDS") && w.includes("ignored")),
      JSON.stringify(bad.warnings));
    const slow = config({ EVEJS_LNE_NOTICES_PRIORITY_MIN_INTERVAL_MS: "1000000" });
    assert.ok(slow.warnings.some((w) => w.includes("notices.priorityMinIntervalMs=1000000 above")),
      JSON.stringify(slow.warnings));
    const slowOff = config({ EVEJS_LNE_NOTICES_PRIORITY_MIN_INTERVAL_MS: "1000000",
      EVEJS_LNE_NOTICES_PRIORITY_KINDS: "none" });
    assert.ok(!slowOff.warnings.some((w) => w.includes("priorityMinIntervalMs")), JSON.stringify(slowOff.warnings));
  });

  const driver = loadDriver();
  if (!driver.ok) {
    skip("NPR1-NPR2 notices priority path", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }

  test("NPR1 due list: plain result without priority lines; BATTLE_ETA after priorityMinIntervalMs, first", () => {
    withStore(driver, (opened) => {
      const repo = createNoticeRepository();
      const tx = (fn) => {
        const r = opened.store.transaction("test", fn);
        assert.ok(r.ok, JSON.stringify(r));
        return r.value;
      };
      const enqueue = (...items) => assert.ok(tx((db) => repo.enqueueItemsInTx(db, items, T0)).ok);
      const mail = (c, at, sent = true) => tx((db) => {
        const o = repo.openBatchInTx(db, { characterId: c, senderId: SENDER, now: at, maxItems: 10, render });
        assert.ok(o.ok && o.batch, JSON.stringify(o));
        if (sent) assert.ok(repo.finishBatchInTx(db, o.batch.batchKey, { outcome: "SENT", now: at, maxAttempts: 3 }).ok);
        return o;
      });
      enqueue(line("a0", A), line("b0", B), line("d0", D), line("f0", F));
      mail(A, NOW - 300000);
      mail(B, NOW - 1200000);
      mail(D, NOW - 1000, false);
      mail(F, NOW - 30000);
      enqueue(line("a1", A), line("b1", B), line("c1", C), line("d1", D), line("e1", E, S.KIND_HUNT_WARNING),
        line("f1", F));
      const due = (o) => {
        const r = tx((db) => repo.listDueCharactersInTx(db, { now: NOW, minMailIntervalMs: 900000, ...o }));
        assert.ok(r.ok, JSON.stringify(r));
        return r.characterIds;
      };
      const prio = (limit, ms = 60000) => due({ limit, priorityKinds: ETA, priorityMinIntervalMs: ms });
      for (const limit of [1, 2, 5]) assert.deepStrictEqual(prio(limit), due({ limit }), `limit ${limit}`);
      assert.deepStrictEqual(due({ limit: 5 }), [B, C]);
      assert.deepStrictEqual(due({ limit: 5, priorityKinds: [] }), [B, C]);
      enqueue(line("f-eta", F, "BATTLE_ETA"), line("a-eta", A, "BATTLE_ETA"), line("d-eta", D, "BATTLE_ETA"),
        line("g-eta", G, "BATTLE_ETA"));
      assert.deepStrictEqual(prio(5), [A, G, B, C]);
      assert.deepStrictEqual(prio(3), [A, G, B]);
      assert.deepStrictEqual(prio(5, 0), [F, A, G, B, C]);
      assert.deepStrictEqual(due({ limit: 5 }), [B, C, G]);
      assert.deepStrictEqual(due({ limit: 5, priorityKinds: ["BATTLE_END"], priorityMinIntervalMs: 60000 }),
        [B, C, G]);
      for (const bad of [{ priorityKinds: "BATTLE_ETA", priorityMinIntervalMs: 0 }, { priorityKinds: [""] },
        { priorityKinds: ETA }, { priorityKinds: ETA, priorityMinIntervalMs: -1 }]) {
        const r = tx((db) => repo.listDueCharactersInTx(db, { now: NOW, minMailIntervalMs: 900000, limit: 5, ...bad }));
        assert.strictEqual(r.reason, "INVALID_INPUT", JSON.stringify(bad));
      }
    });
  });

  test("NPR2 dispatcher: an ETA line after priorityMinIntervalMs, a plain line waits; priorityKinds=none waits", () => {
    for (const [env, expected] of [[{}, 2], [{ EVEJS_LNE_NOTICES_PRIORITY_KINDS: "none" }, 1]]) {
      withStore(driver, (opened) => {
        const box = [];
        const adapter = {
          sendPlayerMail(spec) {
            box.push({ characterId: spec.toCharacterId, body: spec.body });
            return { ok: true, messageId: box.length };
          },
          findPlayerMail: () => ({ ok: true, found: false }),
          defaultMailSender: () => ({ ok: true, senderId: SENDER }),
        };
        let t = T0;
        const clock = { now: () => t };
        const timers = [];
        const started = startNotices({ config: config(env).config, ctx: { persistence: { ok: true,
          store: opened.store } }, adapter, clock, telemetry: null,
        setTimer: (fn) => {
          const timer = { fn, cancel() {} };
          timers.push(timer);
          return timer;
        } });
        assert.ok(started.ok, JSON.stringify(started));
        const n = started.notices;
        const pass = () => timers.shift().fn();
        const enqueue = (...items) => {
          const r = opened.store.transaction("test", (db) => n.enqueueItemsInTx(db, items, t));
          assert.ok(r.ok && r.value.ok, JSON.stringify(r));
        };
        enqueue(line("p0", A), line("q0", B));
        pass();
        assert.strictEqual(box.length, 2);
        t += 30000;
        enqueue(...Array.from({ length: 12 }, (_, i) => line(`old${i}`, A)));
        enqueue(line("eta", A, "BATTLE_ETA"), line("q1", B));
        pass();
        assert.strictEqual(box.length, 2);
        t += 30000;
        pass();
        assert.strictEqual(box.length, 1 + expected, JSON.stringify(env));
        if (expected === 2) {
          assert.strictEqual(box[2].characterId, A);
          assert.ok(box[2].body.includes("line eta"), box[2].body);
          t += 60000;
          pass();
          assert.strictEqual(box.length, 3);
        }
        n.stop("test");
      });
    }
  });

  test("NPR4 openBatchInTx: the ETA line in the first mail of > maxItems lines; [] / missing = the old SQL", () => {
    withStore(driver, (opened) => {
      const repo = createNoticeRepository();
      const tx = (fn) => {
        const r = opened.store.transaction("test", fn);
        assert.ok(r.ok, JSON.stringify(r));
        return r.value;
      };
      const plainSql = `SELECT item_id AS id, line, attempts FROM ${S.ITEMS_TABLE}
        WHERE character_id = ? AND state = 'PENDING' AND kind <> ? ORDER BY item_id ASC LIMIT ?`;
      const open = (c, at, extra) => tx((db) => {
        const seen = [];
        const spy = Object.create(db);
        spy.prepare = (sql) => {
          seen.push(sql);
          return db.prepare(sql);
        };
        const o = repo.openBatchInTx(spy, { characterId: c, senderId: SENDER, now: at, maxItems: 10, render, ...extra });
        assert.ok(o.ok && o.batch, JSON.stringify(o));
        return { batch: o.batch, select: seen[0] };
      });
      const lines = (c) => [...Array.from({ length: 12 }, (_, i) => line(`${c}-old${i}`, c)), line(`${c}-eta`, c,
        "BATTLE_ETA")];
      assert.ok(tx((db) => repo.enqueueItemsInTx(db, [...lines(A), ...lines(B), ...lines(C)], T0)).ok);
      const prio = open(A, NOW, { priorityKinds: ETA });
      assert.strictEqual(prio.batch.itemIds.length, 10);
      assert.ok(prio.batch.body.startsWith("line 91000001-eta<br>line 91000001-old0<br>"), prio.batch.body);
      assert.ok(!prio.batch.body.includes("old9"), prio.batch.body);
      assert.notStrictEqual(prio.select, plainSql);
      for (const [c, extra] of [[B, { priorityKinds: [] }], [C, {}]]) {
        const plain = open(c, NOW, extra);
        assert.strictEqual(plain.select, plainSql);
        assert.ok(!plain.batch.body.includes("-eta"), plain.batch.body);
      }
      for (const bad of ["BATTLE_ETA", [""], ["X".repeat(S.MAX_KIND + 1)]]) {
        const r = tx((db) => repo.openBatchInTx(db, { characterId: D, senderId: SENDER, now: NOW, maxItems: 10,
          render, priorityKinds: bad }));
        assert.strictEqual(r.reason, "INVALID_INPUT", JSON.stringify(bad));
      }
    });
  });
};
