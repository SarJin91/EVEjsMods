"use strict";

const assert = require("node:assert");

const { createNewsRepository } = require("../../lib/news/repository");
const { weightOf } = require("../../lib/news/data/kinds");
const { createMailDispatcher } = require("../../lib/news/mail/dispatcher");
const { filetimeOf } = require("../../lib/notices/schema");
const { loadDriver, withStore } = require("../notices/storeHelper");
const R = require("./mailRig");

const SENDER = 90000099;

function fakeMail(store, script) {
  const sends = [];
  const finds = [];
  return { sends, finds,
    defaultMailSender: () => (script.noSender ? { ok: false, reason: "MAIL_NO_SENDER" } : { ok: true, senderId: SENDER }),
    sendPlayerMail(spec) {
      const row = store.transaction("probe", (db) => db.prepare("SELECT state FROM lne_news_deliveries "
        + "WHERE character_id = ?").get(spec.toCharacterId)).value;
      sends.push({ spec, stateAtCall: row ? row.state : null });
      const f = script.send[spec.toCharacterId];
      return typeof f === "function" ? f(spec) : { ok: true, messageId: 7000 + sends.length };
    },
    findPlayerMail(spec) {
      finds.push(spec);
      const f = script.find[spec.characterId];
      return typeof f === "function" ? f(spec) : { ok: true, found: false };
    } };
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  if (!driver.ok) {
    skip("MD1 news mail dispatcher (store)", `no sqlite driver: ${driver.detail}`);
    return;
  }

  test("MD1 news mail: SENDING before the vendor call, SENT once; definite:false hit / miss; seam missing -> PENDING "
    + "and stop; reconcile SENT / LOST; no sender", () => withStore(driver, (opened) => {
    const store = opened.store;
    const repo = createNewsRepository({ weightOf });
    const s = R.settingsOf();
    const now = R.B + 10 * 60000;
    R.touchAt(store, [9001, 9002, 9003, 9004, 9005], now - R.H);
    const pub = R.publishEdition(store, { boundaryAt: R.B, now, title: "System captured: Jita",
      paragraphs: ["Scope News #1: the events.", "Jita <b> & co."], activeSince: now - s.mail.readerActiveMs, limit: 50 });
    assert.strictEqual(pub.queued, 5);
    const script = { send: {
      9002: () => ({ ok: false, reason: "MAIL_REFUSED", definite: false, detail: "x" }),
      9003: () => ({ ok: false, reason: "MAIL_THREW", definite: false, detail: "y" }),
      9004: () => ({ ok: false, reason: "MAIL_SEAM_UNAVAILABLE", definite: true }),
    }, find: { 9002: () => ({ ok: true, found: true, messageId: 8002 }) } };
    const mail = fakeMail(store, script);
    const d = createMailDispatcher({ store, repo, adapter: mail, settings: s });
    const r1 = d.runPass(now);
    assert.deepStrictEqual([r1.sent, r1.failed, r1.stopped], [2, 1, "MAIL_SEAM_UNAVAILABLE"]);
    assert.deepStrictEqual(mail.sends.map((x) => [x.spec.toCharacterId, x.stateAtCall]),
      [[9001, "SENDING"], [9002, "SENDING"], [9003, "SENDING"], [9004, "SENDING"]], "SENDING before every call; "
        + "the pass stops at 9004, 9005 waits");
    const first = mail.sends[0].spec;
    assert.deepStrictEqual([first.senderId, first.sentDate, first.title], [SENDER, filetimeOf(now),
      "Scope News #1: System captured: Jita"]);
    assert.ok(first.body.includes("Jita &lt;b&gt; &amp; co.") && first.body.includes("!news off"), first.body);
    let rows = R.deliveries(store);
    assert.deepStrictEqual(rows.map((x) => [x.c, x.state, x.m]), [[9001, "SENT", 7001], [9002, "SENT", 8002],
      [9003, "FAILED", null], [9004, "PENDING", null], [9005, "PENDING", null]]);
    assert.deepStrictEqual([rows[3].s, rows[3].d, rows[3].title], [null, null, null], "the undone row has no print");

    delete script.send[9004];
    const r2 = d.runPass(now + 60000);
    assert.strictEqual(r2.sent, 2);
    assert.deepStrictEqual(mail.sends.slice(4).map((x) => x.spec.toCharacterId), [9004, 9005]);
    assert.strictEqual(d.runPass(now + 120000).sent, 0, "nothing left");
    assert.strictEqual(mail.sends.length, 6);

    R.touchAt(store, [9101, 9102], now);
    const pub2 = R.publishEdition(store, { boundaryAt: R.B + 24 * R.H, now: now + 24 * R.H, title: "Day 2",
      paragraphs: ["Text."], activeSince: now, limit: 2 });
    assert.strictEqual(pub2.queued, 2);
    R.txOf(store)((db) => {
      for (const c of [9101, 9102]) {
        assert.ok(repo.openDeliveryInTx(db, { editionId: pub2.editionId, characterId: c, senderId: SENDER,
          sentDate: "1", title: "Scope News #2: Day 2", now: now + 24 * R.H }).ok);
      }
      return { ok: true };
    });
    const after = fakeMail(store, { send: {}, find: { 9101: () => ({ ok: true, found: true, messageId: 9901 }) } });
    const rc = createMailDispatcher({ store, repo, adapter: after, settings: s }).reconcile(now + 24 * R.H + 1000);
    assert.deepStrictEqual([rc.ok, rc.reconciled, rc.lost, after.sends.length], [true, 1, 1, 0]);
    rows = R.deliveries(store).filter((x) => x.e === pub2.editionId);
    assert.deepStrictEqual(rows.map((x) => [x.c, x.state]), [[9101, "SENT"], [9102, "LOST"]]);

    R.touchAt(store, [9201], now + 48 * R.H);
    R.publishEdition(store, { boundaryAt: R.B + 48 * R.H, now: now + 48 * R.H, title: "Day 3", paragraphs: ["T."],
      activeSince: now + 47 * R.H, limit: 5 });
    const silent = fakeMail(store, { noSender: true, send: {}, find: {} });
    const r3 = createMailDispatcher({ store, repo, adapter: silent, settings: s }).runPass(now + 48 * R.H);
    assert.deepStrictEqual([r3.stopped, silent.sends.length], ["NO_SENDER", 0]);
  }));
};
