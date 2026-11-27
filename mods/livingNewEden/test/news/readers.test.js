"use strict";

const assert = require("node:assert");

const { createNewsRepository } = require("../../lib/news/repository");
const { weightOf } = require("../../lib/news/data/kinds");
const { createReaders } = require("../../lib/news/mail/readers");
const { createEditions } = require("../../lib/news/editions");
const { MIGRATIONS } = require("../../lib/persistence/migrations");
const { loadDriver, withStore } = require("../notices/storeHelper");
const R = require("./mailRig");

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  if (!driver.ok) {
    skip("RD1 news readers (store)", `no sqlite driver: ${driver.detail}`);
    return;
  }

  test("RD1 news readers: touch once per readerTouchMs, stale presence skipped; the publication skips opted-out and "
    + "inactive readers, the most active up to the limit", () => withStore(driver, (opened) => {
    const m99 = MIGRATIONS.find((x) => x.version === 99);
    assert.ok(m99 && m99.name === "news_mail");
    const store = opened.store;
    const repo = createNewsRepository({ weightOf });
    const s = R.settingsOf({ EVEJS_LNE_NEWS_MAIL_MAX_RECIPIENTS_PER_EDITION: "2" });
    const counts = {};
    const bump = (k, n = 1) => {
      counts[k] = (counts[k] || 0) + n;
    };
    const presence = { stale: false, list: [{ systemId: 1, characters: [{ characterId: 9001 }, { characterId: 9002 }] },
      { systemId: 2, characters: [{ characterId: 9001 }] }] };
    const readers = createReaders({ store, repo, settings: s, rowsCap: (n) => n, bump,
      getPresence: () => ({ getStatus: () => ({ available: true, stale: presence.stale }),
        listPresence: () => presence.list }) });
    const T = R.B - 5 * R.H;
    const reader = (id) => R.txOf(store)((db) => repo.getReaderInTx(db, id)).reader;
    assert.deepStrictEqual(readers.touch(T), { ok: true, touched: 2 });
    assert.deepStrictEqual(readers.touch(T + 1000), { ok: true, touched: 0 }, "within readerTouchMs");
    assert.strictEqual(reader(9001).lastSeenAt, T);
    presence.stale = true;
    assert.deepStrictEqual(readers.touch(T + s.mail.readerTouchMs), { ok: true, touched: 0,
      skipped: "PRESENCE_UNAVAILABLE" });
    presence.stale = false;
    assert.deepStrictEqual(readers.touch(T + s.mail.readerTouchMs), { ok: true, touched: 2 });
    assert.strictEqual(reader(9001).lastSeenAt, T + s.mail.readerTouchMs);
    assert.strictEqual(counts.readersTouched, 4);

    assert.deepStrictEqual(readers.optOut(9002, true, T), { ok: true, changed: true });
    R.touchAt(store, [9003], R.B - s.mail.readerActiveMs - R.H);
    R.touchAt(store, [9004], T - 2 * R.H);
    R.touchAt(store, [9005], T - R.H);
    R.addFact(store, "w:1", R.B);
    const editions = createEditions({ store, repo, settings: s, bump, now: () => R.B,
      mailPlan: { readerActiveMs: s.mail.readerActiveMs, maxRecipients: s.mail.maxRecipientsPerEdition } });
    const step = editions.runStep(R.B + s.settleDelayMs);
    assert.ok(step.ok, JSON.stringify(step));
    const rows = R.deliveries(store);
    assert.deepStrictEqual(rows.map((x) => [x.c, x.state]), [[9001, "PENDING"], [9005, "PENDING"]],
      "most active first, opted-out and inactive skipped");
    const e = R.txOf(store)((db) => repo.latestEditionInTx(db)).edition;
    assert.deepStrictEqual([e.state, e.recipients], ["PUBLISHED", 2]);
    assert.deepStrictEqual([counts.deliveriesQueued, counts.recipientsTruncated, counts.optOuts], [2, 1, 1]);
  }));
};
