"use strict";

const assert = require("node:assert");

const { createJournal } = require("../../lib/persistence/journal");
const { createManualClock } = require("../../lib/util/clock");
const { startNews } = require("../../lib/news");
const { matchNewsCommand } = require("../../lib/news/command");
const { formatEditionMail } = require("../../lib/news/mail/format");
const { loadDriver, withStore } = require("../notices/storeHelper");
const R = require("./mailRig");

module.exports = ({ test, skip }) => {
  test("NC1a news mail text: ASCII title <= 150, body <= 8000 by whole paragraphs, escaped, footer, stable", () => {
    const e = { seq: 12, title: `Łódź – żółć ${"x".repeat(200)}`, fallbackTitle: "f", paragraphs: ["a <b> & c",
      ...Array.from({ length: 30 }, (_v, i) => `${i} ${"y".repeat(400)}`)], fallbackParagraphs: [] };
    const opts = { maxTitleChars: 150, maxBodyChars: 8000, lineBreak: "<br>", language: "pl" };
    const mail = formatEditionMail(e, opts);
    assert.ok(mail.title.startsWith("Scope News #12: Lodz - zolc x") && mail.title.length <= 150, mail.title);
    assert.ok(/^[\x20-\x7E]+$/.test(mail.title), mail.title);
    assert.ok(mail.body.length <= 8000, String(mail.body.length));
    assert.ok(mail.body.startsWith("a &lt;b&gt; &amp; c<br><br>0 y"), mail.body.slice(0, 40));
    assert.ok(mail.body.endsWith("Wpisz !news off w czacie lokalnym, aby wyłączyć te maile."), mail.body.slice(-80));
    assert.ok(!mail.body.includes("29 y"), "whole paragraphs cut from the end");
    assert.deepStrictEqual(formatEditionMail(e, opts), mail, "the same row -> the same text");
  });

  const driver = loadDriver();
  if (!driver.ok) {
    skip("NC1b news !news (store)", `no sqlite driver: ${driver.detail}`);
    return;
  }

  test("NC1b !news: none / latest, off -> skipped by the next publication, on, usage, no character; registered "
    + "and uninstalled", () => withStore(driver, (opened) => {
    const clock = createManualClock(R.B - 3 * R.H);
    const journal = createJournal({ clock, maxPayloadBytes: 8192, maxRows: 500 });
    const installs = [];
    const removed = [];
    const adapter = { readFactionNames: () => ({ ok: true, names: new Map() }),
      installChatCommand: (o) => {
        installs.push(o);
        return { ok: true };
      },
      uninstallChatCommand: (name) => removed.push(name),
      sendPlayerMail: () => ({ ok: true, messageId: 1 }), findPlayerMail: () => ({ ok: true, found: false }),
      defaultMailSender: () => ({ ok: true, senderId: 90000099 }) };
    const config = R.configOf({ EVEJS_LNE_FRONT_CHAT_MAX_REPLY_CHARS: "200" });
    const presence = { getStatus: () => ({ available: true, stale: false }),
      listPresence: () => [{ systemId: 1, characters: [{ characterId: 9001 }, { characterId: 9002 }] }] };
    const started = startNews({ config, adapter, clock, setTimer: () => ({ cancel() {}, hasRef: () => false }),
      ctx: { persistence: { ok: true, store: opened.store, journal }, presence,
        notices: { onWarEvents: () => ({ ok: false, reason: "NOTICES_DISABLED" }) } } });
    assert.ok(started.ok, JSON.stringify(started));
    const news = started.news;
    assert.deepStrictEqual([installs.length, installs[0].name, news.getStatus().command], [1, "news", "on"]);
    const say = (text, rec = { characterId: 9001 }) => installs[0].handle(rec, text, { transport: "xmpp" });
    assert.ok(matchNewsCommand("!news") && matchNewsCommand("!news off") && !matchNewsCommand("!newsx"));
    assert.strictEqual(say("!news"), "Scope News: no edition yet.");
    news.runPassNow(R.B - 2 * R.H);
    R.addFact(opened.store, "w:1", R.B);
    news.runPassNow(R.B + config.news.settleDelayMs);
    const latest = say("!news");
    assert.ok(latest.startsWith("Scope News #1: System captured: Jita<br>Scope News #1,") && latest.length <= 200,
      latest);
    assert.deepStrictEqual(R.deliveries(opened.store).map((x) => x.c), [9001, 9002]);
    assert.strictEqual(say("!news off"), "Scope News: you will get no more news mails.");
    R.addFact(opened.store, "w:2", R.B + 24 * R.H);
    news.runPassNow(R.B + 24 * R.H + config.news.settleDelayMs);
    const day2 = R.deliveries(opened.store).filter((x) => x.e === `ed:${R.B + 24 * R.H}`).map((x) => x.c);
    assert.deepStrictEqual(day2, [9002], "the opted-out reader is skipped");
    assert.strictEqual(say("!news on"), "Scope News: you will get the news mails again.");
    assert.strictEqual(say("!news help"), "Scope News: !news | !news off | !news on");
    assert.strictEqual(say("!news off", null), "Scope News unavailable.");
    const st = news.getStatus();
    assert.deepStrictEqual([st.optOuts, st.chatReplies, st.chatErrors, st.mail.state], [1, 5, 1, "on"]);
    assert.ok(st.mail.sentLastEdition >= 1, JSON.stringify(st.mail));
    news.stop("test");
    assert.deepStrictEqual(removed, ["news"]);
  }));
};
