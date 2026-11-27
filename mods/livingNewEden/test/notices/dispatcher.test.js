"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { createManualClock } = require("../../lib/util/clock");
const { createNoticeRepository } = require("../../lib/notices/repository");
const { startNotices, createUnavailableNotices, NOTICES_METHODS } = require("../../lib/notices");
const { resolveConfig } = require("../../config");
const { loadDriver, withStore } = require("./storeHelper");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const T0 = 1760000000000;
const CHAR_A = 90000001;
const CHAR_B = 90000002;
const SENDER = 140000004;

function config(env = {}) {
  return JSON.parse(JSON.stringify(resolveConfig({ modDir: MOD_DIR,
    env: { EVEJS_LNE_NOTICES_ENABLED: "1", ...env } }).config));
}

function fakeAdapter() {
  const box = [];
  const a = {
    box,
    sends: 0,
    mode: "ok",
    findMode: "ok",
    findFailFor: new Set(),
    sendPlayerMail(spec) {
      a.sends += 1;
      if (a.mode === "refuse") return { ok: false, reason: "MAIL_REFUSED", definite: false, detail: "WRITE_ERROR" };
      if (a.mode === "seam") return { ok: false, reason: "MAIL_SEAM_UNAVAILABLE", definite: true, detail: "sendMail" };
      box.push({ messageId: box.length + 1, characterId: spec.toCharacterId, senderId: spec.senderId,
        sentDate: spec.sentDate, title: spec.title.trim().slice(0, 150), body: spec.body });
      if (a.mode === "throw") return { ok: false, reason: "MAIL_THREW", definite: false, detail: "push failed" };
      return { ok: true, messageId: box.length };
    },
    findPlayerMail(fp) {
      if (a.findMode === "fail" || a.findFailFor.has(fp.characterId)) {
        return { ok: false, reason: "MAIL_THREW", detail: "x" };
      }
      if (a.findMode === "seam") return { ok: false, reason: "MAIL_SEAM_UNAVAILABLE", detail: "getMailboxEntries" };
      const m = box.find((x) => x.characterId === fp.characterId && x.senderId === fp.senderId
        && x.sentDate === fp.sentDate && x.title === fp.title.trim().slice(0, 150));
      return m ? { ok: true, found: true, messageId: m.messageId } : { ok: true, found: false };
    },
    defaultMailSender: () => ({ ok: true, senderId: SENDER }),
  };
  return a;
}

function harness(opened, cfg = config(), adapter = fakeAdapter()) {
  const clock = createManualClock(T0);
  const timers = [];
  let txCount = 0;
  const realStore = opened.store;
  const store = { transaction: (name, fn) => {
    txCount += 1;
    return realStore.transaction(name, fn);
  } };
  const governor = { allow: true, admits: (cls) => (cls === "MAINTENANCE" ? governor.allow : true) };
  const ctx = { persistence: { ok: true, store }, governor };
  const start = () => {
    const started = startNotices({ config: cfg, ctx, adapter, clock, telemetry: null,
      setTimer: (fn, ms) => {
        const t = { fn, ms, cancelled: false, cancel: () => { t.cancelled = true; } };
        timers.push(t);
        return t;
      } });
    assert.ok(started.ok, JSON.stringify(started));
    return started.notices;
  };
  const pass = () => {
    const t = timers.shift();
    assert.ok(t && !t.cancelled, "an armed timer");
    t.fn();
  };
  const tx = (fn) => {
    const r = realStore.transaction("test", fn);
    assert.ok(r.ok, JSON.stringify(r));
    return r.value;
  };
  const items = (characterId, n, prefix = "e") => Array.from({ length: n }, (_, i) => ({
    eventKey: `${prefix}${i}`, characterId, kind: "ATTACK_STARTED", systemId: 30000142,
    line: `${prefix} line ${i}`, eventAt: clock.now() }));
  const countRows = () => tx((db) => db.prepare("SELECT (SELECT count(*) FROM world_notice_items)"
    + " + (SELECT count(*) FROM world_notice_batches) AS n").get().n);
  return { clock, timers, adapter, ctx, governor, start, pass, tx, items, countRows, cfg,
    txCount: () => txCount };
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("NMD1 one mail of <= maxItemsPerMail lines per character per window, maxMailsPerPass per pass", () => {
    withStore(driver, (opened) => {
      const h = harness(opened);
      const n = h.start();
      assert.strictEqual(h.timers[0].ms, 30000);
      h.tx((db) => n.enqueueItemsInTx(db, [...h.items(CHAR_A, 12), ...h.items(CHAR_B, 12)], h.clock.now()));
      h.clock.advance(30000);
      h.pass();
      assert.strictEqual(h.adapter.box.length, 2);
      for (const [i, c] of [[0, CHAR_A], [1, CHAR_B]]) {
        const m = h.adapter.box[i];
        assert.strictEqual(m.characterId, c);
        assert.strictEqual(m.senderId, SENDER);
        assert.strictEqual(m.title, "LNE front report: 10 events");
        assert.strictEqual(m.body.split("<br>").filter((l) => / line /.test(l)).length, 10);
      }
      assert.strictEqual(n.getStatus().mailsSent, 2);
      assert.strictEqual(n.getStatus().itemsQueued, 24);
      h.clock.advance(30000);
      h.pass();
      assert.strictEqual(h.adapter.box.length, 2);
      h.clock.advance(h.cfg.notices.minMailIntervalMs);
      h.pass();
      assert.strictEqual(h.adapter.box.length, 4);
      assert.strictEqual(h.adapter.box[2].title, "LNE front report: 2 events");
      const states = h.tx((db) => db.prepare("SELECT state, count(*) AS c FROM world_notice_items GROUP BY state")
        .all().map((r) => [r.state, r.c]));
      assert.deepStrictEqual(states, [["SENT", 24]]);
      n.stop("test");
      assert.ok(h.timers.every((t) => t.cancelled));
    });
    withStore(driver, (opened) => {
      const h = harness(opened, config({ EVEJS_LNE_NOTICES_MAX_MAILS_PER_PASS: "1" }));
      const n = h.start();
      h.tx((db) => n.enqueueItemsInTx(db, [...h.items(CHAR_A, 1), ...h.items(CHAR_B, 1)], h.clock.now()));
      h.pass();
      assert.deepStrictEqual(h.adapter.box.map((m) => m.characterId), [CHAR_A]);
      assert.strictEqual(h.adapter.box[0].title, "LNE: e line 0");
      h.pass();
      assert.deepStrictEqual(h.adapter.box.map((m) => m.characterId), [CHAR_A, CHAR_B]);
    });
  });

  needsDriver("NMD2 governor MAINTENANCE refused -> no send, no transaction", () => {
    withStore(driver, (opened) => {
      const h = harness(opened);
      const n = h.start();
      h.tx((db) => n.enqueueItemsInTx(db, h.items(CHAR_A, 3), h.clock.now()));
      h.governor.allow = false;
      const before = h.txCount();
      h.pass();
      assert.strictEqual(h.txCount(), before);
      assert.strictEqual(h.adapter.sends, 0);
      assert.strictEqual(n.getStatus().deferrals, 1);
      h.governor.allow = true;
      h.pass();
      assert.strictEqual(h.adapter.sends, 1);
    });
  });

  needsDriver("NMD3 restart: SENDING with the fingerprint -> SENT without sendMail; without it -> LOST, one resend",
    () => {
      withStore(driver, (opened) => {
        const h = harness(opened);
        const repo = createNoticeRepository();
        const render = (lines) => ({ title: `LNE front report: ${lines.length} events`, body: lines.join("<br>") });
        h.tx((db) => repo.enqueueItemsInTx(db, [...h.items(CHAR_A, 2), ...h.items(CHAR_B, 2)], T0));
        const bA = h.tx((db) => repo.openBatchInTx(db, { characterId: CHAR_A, senderId: SENDER, now: T0,
          maxItems: 10, render })).batch;
        h.tx((db) => repo.openBatchInTx(db, { characterId: CHAR_B, senderId: SENDER, now: T0, maxItems: 10, render }));
        h.adapter.box.push({ messageId: 1, characterId: CHAR_A, senderId: SENDER, sentDate: bA.sentDate,
          title: bA.title, body: bA.body });
        h.clock.advance(5000);
        const n = h.start();
        assert.strictEqual(h.adapter.sends, 0, "reconcile never sends");
        const batches = h.tx((db) => db.prepare("SELECT character_id AS c, state, message_id AS m"
          + " FROM world_notice_batches ORDER BY character_id").all().map((r) => [r.c, r.state, r.m]));
        assert.deepStrictEqual(batches, [[CHAR_A, "SENT", 1], [CHAR_B, "LOST", null]]);
        const st = n.getStatus();
        assert.strictEqual(st.mailsReconciled, 1);
        assert.strictEqual(st.mailsLost, 1);
        h.pass();
        assert.strictEqual(h.adapter.sends, 1);
        assert.deepStrictEqual(h.adapter.box.map((m) => m.characterId), [CHAR_A, CHAR_B]);
        h.clock.advance(h.cfg.notices.minMailIntervalMs + 1);
        h.pass();
        assert.strictEqual(h.adapter.sends, 1, "no duplicate later");
      });
    });

  needsDriver("NMD4 sendMail threw after the write -> lookup -> SENT once; a failed lookup keeps SENDING", () => {
    withStore(driver, (opened) => {
      const h = harness(opened);
      const n = h.start();
      h.tx((db) => n.enqueueItemsInTx(db, [...h.items(CHAR_A, 1), ...h.items(CHAR_B, 1)], h.clock.now()));
      h.adapter.mode = "throw";
      h.pass();
      assert.strictEqual(h.adapter.box.length, 2);
      assert.strictEqual(n.getStatus().mailsSent, 2);
      assert.strictEqual(n.getStatus().mailsReconciled, 2);
      h.tx((db) => n.enqueueItemsInTx(db, h.items(CHAR_A, 1, "f"), h.clock.now()));
      h.clock.advance(h.cfg.notices.minMailIntervalMs + 1);
      h.adapter.findMode = "fail";
      h.pass();
      assert.strictEqual(h.adapter.box.length, 3);
      const sending = () => h.tx((db) => db.prepare("SELECT count(*) AS c FROM world_notice_batches"
        + " WHERE state = 'SENDING'").get().c);
      assert.strictEqual(sending(), 1);
      h.clock.advance(h.cfg.notices.passIntervalMs + 1);
      h.pass();
      assert.strictEqual(h.adapter.sends, 3, "no second mail while SENDING");
      h.adapter.findMode = "ok";
      h.clock.advance(h.cfg.notices.passIntervalMs + 1);
      h.pass();
      assert.strictEqual(sending(), 0);
      assert.strictEqual(h.adapter.box.length, 3);
      assert.strictEqual(h.adapter.sends, 3);
    });
  });

  needsDriver("NMD5 off -> disabled_by_config, nothing written; facade and stub methods", () => {
    withStore(driver, (opened) => {
      const h = harness(opened);
      const off = startNotices({ config: config({ EVEJS_LNE_NOTICES_ENABLED: "0" }), ctx: h.ctx,
        adapter: h.adapter, clock: h.clock, setTimer: () => assert.fail("no timer when off") });
      assert.deepStrictEqual(off, { ok: false, reason: "disabled_by_config" });
      assert.strictEqual(config({ EVEJS_LNE_NOTICES_ENABLED: "" }).notices.enabled, false, "default off");
      assert.strictEqual(h.txCount(), 0);
      assert.strictEqual(h.countRows(), 0);
      const stub = createUnavailableNotices("NOTICES_DISABLED", "disabled_by_config");
      assert.deepStrictEqual(stub.enqueueItemsInTx({}, [], 0), { ok: false, reason: "NOTICES_DISABLED" });
      const live = h.start();
      assert.deepStrictEqual(Object.keys(live).sort(), [...NOTICES_METHODS].sort());
      assert.deepStrictEqual(Object.keys(stub).sort(), [...NOTICES_METHODS].sort());
      assert.ok(NOTICES_METHODS.includes("onWarEvents"));
      assert.deepStrictEqual(stub.onWarEvents(() => {}), { ok: false, reason: "NOTICES_DISABLED" });
    });
  });

  needsDriver("NMD6 a failed lookup skips one SENDING batch; after maxNoticeAgeMs FAILED (LOOKUP_TIMEOUT)", () => {
    withStore(driver, (opened) => {
      const h = harness(opened);
      const n = h.start();
      const repo = createNoticeRepository();
      const render = (lines) => ({ title: `LNE front report: ${lines.length} events`, body: lines.join("<br>") });
      h.tx((db) => repo.enqueueItemsInTx(db, [...h.items(CHAR_A, 1), ...h.items(CHAR_B, 1)], T0));
      h.tx((db) => repo.openBatchInTx(db, { characterId: CHAR_A, senderId: SENDER, now: T0, maxItems: 10, render }));
      const bB = h.tx((db) => repo.openBatchInTx(db, { characterId: CHAR_B, senderId: SENDER, now: T0 + 1,
        maxItems: 10, render })).batch;
      h.adapter.box.push({ messageId: 1, characterId: CHAR_B, senderId: SENDER, sentDate: bB.sentDate,
        title: bB.title, body: bB.body });
      const batches = () => h.tx((db) => db.prepare("SELECT character_id AS c, state, error FROM world_notice_batches"
        + " ORDER BY created_at, batch_key").all().map((r) => [r.c, r.state, r.error]));
      h.adapter.findMode = "seam";
      h.clock.advance(h.cfg.notices.passIntervalMs + 2);
      h.pass();
      assert.deepStrictEqual(batches(), [[CHAR_A, "SENDING", null], [CHAR_B, "SENDING", null]]);
      assert.strictEqual(n.getStatus().sendingHeld, 2);
      h.adapter.findMode = "ok";
      h.adapter.findFailFor.add(CHAR_A);
      h.pass();
      assert.deepStrictEqual(batches(), [[CHAR_A, "SENDING", null], [CHAR_B, "SENT", null]]);
      assert.strictEqual(n.getStatus().mailsReconciled, 1);
      assert.strictEqual(n.getStatus().sendingHeld, 1);
      h.clock.advance(h.cfg.notices.maxNoticeAgeMs);
      h.tx((db) => n.enqueueItemsInTx(db, h.items(CHAR_A, 1, "f"), h.clock.now()));
      h.pass();
      const rows = batches();
      assert.deepStrictEqual(rows.slice(0, 2), [[CHAR_A, "FAILED", "LOOKUP_TIMEOUT"], [CHAR_B, "SENT", null]]);
      const itemsA = h.tx((db) => db.prepare("SELECT event_key AS k, state FROM world_notice_items"
        + " WHERE character_id = ? ORDER BY item_id").all(CHAR_A).map((r) => [r.k, r.state]));
      assert.deepStrictEqual(itemsA, [["e0", "FAILED"], ["f0", "SENT"]]);
      assert.strictEqual(h.adapter.sends, 1, "the new item of A is sent in the same pass, the old one never");
      assert.deepStrictEqual(h.adapter.box.map((m) => m.characterId), [CHAR_B, CHAR_A]);
      assert.strictEqual(n.getStatus().sendingHeld, 0);
      assert.strictEqual(n.getStatus().mailsFailed, 1);
    });
  });

  needsDriver("NMD7 DRIFT of sendMail -> batch undone, attempts unchanged, the pass stops", () => {
    withStore(driver, (opened) => {
      const h = harness(opened);
      const n = h.start();
      h.tx((db) => n.enqueueItemsInTx(db, [...h.items(CHAR_A, 2), ...h.items(CHAR_B, 1)], h.clock.now()));
      h.adapter.mode = "seam";
      const items = () => h.tx((db) => db.prepare("SELECT state, batch_key AS b, attempts AS a FROM world_notice_items"
        + " ORDER BY item_id").all().map((r) => [r.state, r.b, r.a]));
      for (let i = 1; i <= 4; i += 1) {
        h.clock.advance(h.cfg.notices.passIntervalMs);
        h.pass();
        assert.strictEqual(h.adapter.sends, i, "one try per pass, the pass stops");
      }
      assert.deepStrictEqual(items(), [["PENDING", null, 0], ["PENDING", null, 0], ["PENDING", null, 0]]);
      assert.strictEqual(h.countRows(), 3, "no batch row left");
      assert.strictEqual(n.getStatus().mailsFailed, 0);
      h.adapter.mode = "ok";
      h.pass();
      assert.deepStrictEqual(h.adapter.box.map((m) => m.characterId), [CHAR_A, CHAR_B]);
    });
  });

  needsDriver("NMD8 1200 PENDING of one character do not block the mail of another; pruneBatch 400 warns",
    () => {
      withStore(driver, (opened) => {
        const h = harness(opened);
        const n = h.start();
        for (let c = 0; c < 3; c += 1) {
          h.tx((db) => n.enqueueItemsInTx(db, h.items(CHAR_A, 400, `p${c}-`), h.clock.now()));
        }
        h.tx((db) => n.enqueueItemsInTx(db, h.items(CHAR_B, 1), h.clock.now()));
        h.pass();
        assert.deepStrictEqual(h.adapter.box.map((m) => m.characterId), [CHAR_A, CHAR_B]);
        const budget = Math.max(h.cfg.notices.pruneBatch, h.cfg.notices.maxItemsPerMail);
        assert.strictEqual(n.getStatus().itemsDropped, budget);
        assert.strictEqual(n.getStatus().errors, 0);
      });
      const warnings = (env) => resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_NOTICES_ENABLED: "1", ...env } })
        .warnings;
      const warned = warnings({ EVEJS_LNE_NOTICES_PRUNE_BATCH: "400" });
      assert.ok(warned.some((w) => w.includes("notices.pruneBatch=400")), warned.join("\n"));
      const quiet = warnings({});
      assert.ok(!quiet.some((w) => w.includes("notices.pruneBatch")), quiet.join("\n"));
      const off = warnings({ EVEJS_LNE_NOTICES_ENABLED: "0", EVEJS_LNE_NOTICES_PRUNE_BATCH: "400" });
      assert.ok(!off.some((w) => w.includes("notices.pruneBatch")), "no warning when notices are off");
    });

  needsDriver("NMD9 sendUrgent: only its own line, inside minMailIntervalMs and with other "
    + "PENDING lines; the same eventKey again -> duplicate, no adapter call; stopped / stub -> refusal", () => {
    withStore(driver, (opened) => {
      const h = harness(opened);
      const n = h.start();
      h.tx((db) => n.enqueueItemsInTx(db, h.items(CHAR_A, 1), h.clock.now()));
      h.pass();
      h.tx((db) => n.enqueueItemsInTx(db, h.items(CHAR_A, 2, "g"), h.clock.now()));
      h.clock.advance(1000);
      const now = h.clock.now();
      const ev = { eventKey: `phwarn:${CHAR_A}:7`, characterId: CHAR_A, kind: "HUNT_WARNING", systemId: 30000142,
        factionId: 500019, at: now };
      assert.deepStrictEqual(n.sendUrgent(ev, now), { ok: true, sent: true, duplicate: false });
      assert.deepStrictEqual(h.adapter.box.map((m) => m.characterId), [CHAR_A, CHAR_A]);
      const m = h.adapter.box[1];
      const line = "Scout report: an unknown faction scout spotted you in an unknown system. Hunters are on their way.";
      assert.ok(m.title.startsWith("LNE: [") && m.title.endsWith(line), m.title);
      assert.strictEqual(m.body.split("<br>").filter((l) => l.includes("Scout report")).length, 1);
      const items = () => h.tx((db) => db.prepare("SELECT event_key AS k, state FROM world_notice_items"
        + " WHERE character_id = ? ORDER BY item_id").all(CHAR_A).map((r) => [r.k, r.state]));
      assert.deepStrictEqual(items(), [["e0", "SENT"], ["g0", "PENDING"], ["g1", "PENDING"], [ev.eventKey, "SENT"]]);
      const sends = h.adapter.sends;
      assert.deepStrictEqual(n.sendUrgent({ ...ev, at: now + 5 }, now + 5), { ok: true, sent: false, duplicate: true });
      assert.strictEqual(h.adapter.sends, sends, "no adapter call for a known eventKey");
      const st = n.getStatus();
      assert.deepStrictEqual([st.urgentSent, st.urgentFailed, st.mailsSent, st.itemsDuplicate], [1, 0, 2, 1]);
      assert.deepStrictEqual(n.sendUrgent({ ...ev, eventKey: "x", kind: "ATTACK_STARTED" }, now),
        { ok: false, reason: "INVALID_INPUT", detail: "kind" });
      n.stop("test");
      assert.deepStrictEqual(n.sendUrgent({ ...ev, eventKey: "y" }, now), { ok: false, reason: "NOTICES_UNAVAILABLE" });
    });
    const stub = createUnavailableNotices("NOTICES_DISABLED", "disabled_by_config");
    assert.deepStrictEqual(stub.sendUrgent({}, 0), { ok: false, reason: "NOTICES_DISABLED" });
    assert.ok(NOTICES_METHODS.includes("sendUrgent"));
  });

  const urgentOf = (at) => ({ eventKey: `phwarn:${CHAR_A}:9`, characterId: CHAR_A, kind: "HUNT_WARNING",
    systemId: 30000142, factionId: 500019, at });
  const scoutLines = (h) => h.adapter.box.filter((m) => m.body.includes("Scout report")).length;
  const itemsOf = (h) => h.tx((db) => db.prepare("SELECT kind, state, batch_key AS b FROM world_notice_items"
    + " ORDER BY item_id").all().map((r) => [r.kind, r.state, r.b === null ? null : "batch"]));

  needsDriver("NMD10 sendUrgent MAIL_FAILED / MAIL_SEAM_UNAVAILABLE / HELD then LOST -> the warning item "
    + "FAILED at once (never PENDING); the next runPass sends the front report of A without the Scout line", () => {
    const paths = [
      { name: "MAIL_FAILED", mode: "refuse", findMode: "ok", reason: "MAIL_FAILED", batch: "FAILED" },
      { name: "MAIL_SEAM_UNAVAILABLE", mode: "seam", findMode: "ok", reason: "MAIL_SEAM_UNAVAILABLE", batch: null },
      { name: "LOST", mode: "refuse", findMode: "fail", reason: "MAIL_UNCONFIRMED", batch: "LOST" },
    ];
    for (const p of paths) {
      withStore(driver, (opened) => {
        const h = harness(opened);
        const n = h.start();
        h.adapter.mode = p.mode;
        h.adapter.findMode = p.findMode;
        const now = h.clock.now();
        assert.deepStrictEqual(n.sendUrgent(urgentOf(now), now), { ok: false, reason: p.reason }, p.name);
        if (p.name === "LOST") {
          assert.deepStrictEqual(itemsOf(h), [["HUNT_WARNING", "SENDING", "batch"]], p.name);
          h.adapter.findMode = "ok";
        } else {
          assert.deepStrictEqual(itemsOf(h), [["HUNT_WARNING", "FAILED", p.name === "MAIL_FAILED" ? "batch" : null]],
            p.name);
        }
        h.adapter.mode = "ok";
        h.tx((db) => n.enqueueItemsInTx(db, h.items(CHAR_A, 1), h.clock.now()));
        h.clock.advance(h.cfg.notices.passIntervalMs + 1);
        h.pass();
        assert.deepStrictEqual(itemsOf(h).map((r) => [r[0], r[1]]), [["HUNT_WARNING", "FAILED"],
          ["ATTACK_STARTED", "SENT"]], p.name);
        const batches = h.tx((db) => db.prepare("SELECT state FROM world_notice_batches ORDER BY created_at")
          .all().map((r) => r.state));
        assert.deepStrictEqual(batches, p.batch ? [p.batch, "SENT"] : ["SENT"], p.name);
        assert.deepStrictEqual([h.adapter.box.length, scoutLines(h)], [1, 0], p.name);
        h.clock.advance(h.cfg.notices.minMailIntervalMs + 1);
        h.pass();
        assert.deepStrictEqual([h.adapter.box.length, scoutLines(h)], [1, 0], `${p.name} later`);
      });
    }
  });

  needsDriver("NMD11 a PENDING HUNT_WARNING (older build): not due, not in a plain batch (repository) "
    + "runPass expires it in housekeep and the front report of A has no Scout line", () => {
    const render = (lines) => ({ title: `LNE front report: ${lines.length} events`, body: lines.join("<br>") });
    const warning = (characterId) => ({ eventKey: `phwarn:${characterId}:1`, characterId, kind: "HUNT_WARNING",
      systemId: 30000142, line: "Scout report: legacy", eventAt: T0 });
    withStore(driver, (opened) => {
      const h = harness(opened);
      const repo = createNoticeRepository();
      h.tx((db) => repo.enqueueItemsInTx(db, [warning(CHAR_B), warning(CHAR_A), ...h.items(CHAR_A, 1)], T0));
      const due = h.tx((db) => repo.listDueCharactersInTx(db, { now: T0, minMailIntervalMs: 0, limit: 10 }));
      assert.deepStrictEqual(due.characterIds, [CHAR_A], "B has only a warning: no slot");
      const opened1 = h.tx((db) => repo.openBatchInTx(db, { characterId: CHAR_A, senderId: SENDER, now: T0,
        maxItems: 10, render }));
      assert.strictEqual(opened1.batch.body, "e line 0");
      assert.deepStrictEqual(itemsOf(h).map((r) => [r[0], r[1]]), [["HUNT_WARNING", "PENDING"],
        ["HUNT_WARNING", "PENDING"], ["ATTACK_STARTED", "SENDING"]]);
      const byKey = h.tx((db) => repo.openBatchInTx(db, { characterId: CHAR_B, senderId: SENDER, now: T0 + 1,
        maxItems: 1, render, eventKey: `phwarn:${CHAR_B}:1` }));
      assert.strictEqual(byKey.batch.body, "Scout report: legacy", "sendUrgent (eventKey) still takes its own item");
    });
    withStore(driver, (opened) => {
      const h = harness(opened);
      const repo = createNoticeRepository();
      h.tx((db) => repo.enqueueItemsInTx(db, [warning(CHAR_B), warning(CHAR_A), ...h.items(CHAR_A, 1)], T0));
      const n = h.start();
      h.pass();
      assert.deepStrictEqual(itemsOf(h).map((r) => [r[0], r[1]]), [["HUNT_WARNING", "EXPIRED"],
        ["HUNT_WARNING", "EXPIRED"], ["ATTACK_STARTED", "SENT"]]);
      assert.deepStrictEqual([h.adapter.box.map((m) => m.characterId), scoutLines(h), n.getStatus().itemsExpired],
        [[CHAR_A], 0, 2]);
    });
  });

  needsDriver("NMD12 housekeep row budget: rowBudget 1, one old item and two PENDING "
    + "HUNT_WARNING -> pass 1 expires only the old item, each later pass one warning", () => {
    const warning = (characterId, i, eventAt) => ({ eventKey: `phwarn:${characterId}:${i}`, characterId,
      kind: "HUNT_WARNING", systemId: 30000142, line: "Scout report: legacy", eventAt });
    withStore(driver, (opened) => {
      const cfg = config();
      cfg.notices.pruneBatch = 1;
      cfg.notices.maxItemsPerMail = 1;
      const h = harness(opened, cfg);
      const repo = createNoticeRepository();
      h.tx((db) => repo.enqueueItemsInTx(db, h.items(CHAR_A, 1, "old"), T0));
      h.clock.advance(cfg.notices.maxNoticeAgeMs + 1);
      const now = h.clock.now();
      h.tx((db) => repo.enqueueItemsInTx(db, [1, 2].map((i) => warning(CHAR_B, i, now)), now));
      const n = h.start();
      const states = () => itemsOf(h).map((r) => [r[0], r[1]]);
      h.pass();
      assert.deepStrictEqual([states(), n.getStatus().itemsExpired], [[["ATTACK_STARTED", "EXPIRED"],
        ["HUNT_WARNING", "PENDING"], ["HUNT_WARNING", "PENDING"]], 1]);
      h.clock.advance(cfg.notices.passIntervalMs);
      h.pass();
      assert.deepStrictEqual([states(), n.getStatus().itemsExpired], [[["ATTACK_STARTED", "EXPIRED"],
        ["HUNT_WARNING", "EXPIRED"], ["HUNT_WARNING", "PENDING"]], 2]);
    });
  });
};
