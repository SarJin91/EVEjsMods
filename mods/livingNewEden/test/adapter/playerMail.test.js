"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { createPlayerMailAdapter, MAIL_STATE_PATH } = require("../../lib/adapter/playerMail");

const SERVER_SRC = path.resolve(__dirname, "..", "..", "..", "..", "server", "src");
const TRASHED = 2;

function readSource(file) {
  return fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
}

function bodyOf(source, name) {
  const start = source.indexOf(`\nfunction ${name}(`);
  assert.ok(start >= 0, `function ${name} not found`);
  const next = source.slice(start + 1).search(/\n(async )?function /);
  return source.slice(start, next < 0 ? source.length : start + 1 + next);
}

function fakeMailState() {
  const messages = [];
  const calls = [];
  const api = {
    mode: "ok",
    sendMail(options = {}) {
      calls.push(options);
      if (api.mode === "refuse") return { success: false, errorMsg: "WRITE_ERROR" };
      const messageID = messages.length + 1;
      const title = String(options.title || "").trim().slice(0, 150);
      messages.push({ to: options.toCharacterIDs[0], status: { statusMask: 0 },
        message: { messageID, senderID: options.senderID, title, sentDate: options.sentDate } });
      if (api.mode === "throw") throw new Error("push failed");
      return { success: true, messageID, sentDate: options.sentDate, recipients: options.toCharacterIDs };
    },
    getMailboxEntries(characterID, options = {}) {
      return messages.filter((m) => m.to === characterID
        && (options.includeTrashed || (m.status.statusMask & TRASHED) === 0))
        .map((m) => JSON.parse(JSON.stringify({ message: m.message, status: m.status })));
    },
    resolveWelcomeSenderID: () => 140000004,
  };
  return { api, calls, messages };
}

function adapterWith(exportsObject) {
  const paths = [];
  const adapter = createPlayerMailAdapter({ requireGame: (p) => {
    paths.push(p);
    return exportsObject ? { ok: true, exports: exportsObject } : { ok: false, reason: "not_booted" };
  } });
  return { adapter, paths };
}

module.exports = ({ test }) => {
  test("PM1 sendPlayerMail args and results, findPlayerMail fingerprint with trash, defaultMailSender", () => {
    const fake = fakeMailState();
    const { adapter, paths } = adapterWith(fake.api);
    const spec = { senderId: 140000004, toCharacterId: 90000001, title: "  LNE: attack  ", body: "a<br>b",
      sentDate: "133000000000000000" };
    assert.deepStrictEqual(adapter.sendPlayerMail(spec), { ok: true, messageId: 1 });
    assert.deepStrictEqual(fake.calls[0], { senderID: 140000004, toCharacterIDs: [90000001], title: "  LNE: attack  ",
      body: "a<br>b", sentDate: "133000000000000000", saveSenderCopy: false });
    assert.ok(paths.every((p) => p === MAIL_STATE_PATH));

    const fp = { characterId: 90000001, senderId: 140000004, sentDate: "133000000000000000", title: "  LNE: attack  " };
    assert.deepStrictEqual(adapter.findPlayerMail(fp), { ok: true, found: true, messageId: 1 });
    assert.deepStrictEqual(adapter.findPlayerMail({ ...fp, senderId: 140000005 }), { ok: true, found: false });
    assert.deepStrictEqual(adapter.findPlayerMail({ ...fp, sentDate: "133000000000000001" }), { ok: true, found: false });
    assert.deepStrictEqual(adapter.findPlayerMail({ ...fp, title: "LNE: other" }), { ok: true, found: false });
    assert.deepStrictEqual(adapter.findPlayerMail({ ...fp, characterId: 90000002 }), { ok: true, found: false });
    fake.messages[0].status.statusMask = TRASHED;
    assert.deepStrictEqual(adapter.findPlayerMail(fp), { ok: true, found: true, messageId: 1 });
    const long = "t".repeat(160);
    adapter.sendPlayerMail({ ...spec, title: long, sentDate: "2" });
    assert.strictEqual(adapter.findPlayerMail({ ...fp, title: long, sentDate: "2" }).found, true);

    fake.api.mode = "refuse";
    assert.deepStrictEqual(adapter.sendPlayerMail(spec),
      { ok: false, reason: "MAIL_REFUSED", definite: false, detail: "WRITE_ERROR" });
    fake.api.mode = "throw";
    assert.deepStrictEqual(adapter.sendPlayerMail({ ...spec, sentDate: "3" }),
      { ok: false, reason: "MAIL_THREW", definite: false, detail: "push failed" });
    assert.strictEqual(adapter.findPlayerMail({ ...fp, sentDate: "3" }).found, true, "the mail is in the state");
    assert.deepStrictEqual(adapter.sendPlayerMail({ ...spec, sentDate: "x1" }),
      { ok: false, reason: "MAIL_INVALID_INPUT", definite: true });
    assert.deepStrictEqual(adapter.defaultMailSender(), { ok: true, senderId: 140000004 });

    const missing = adapterWith(null).adapter;
    assert.deepStrictEqual(missing.sendPlayerMail(spec),
      { ok: false, reason: "MAIL_SEAM_UNAVAILABLE", detail: "mailState_not_booted", definite: true });
    assert.strictEqual(missing.findPlayerMail(fp).reason, "MAIL_SEAM_UNAVAILABLE");
    assert.strictEqual(missing.defaultMailSender().reason, "MAIL_SEAM_UNAVAILABLE");
    const boom = adapterWith({ ...fake.api, getMailboxEntries: () => { throw new Error("x"); } }).adapter;
    assert.deepStrictEqual(boom.findPlayerMail(fp), { ok: false, reason: "MAIL_THREW", detail: "x" });
  });

  test("PM2 vendor facts: sendMail options, getMailboxEntries includeTrashed, exports, mail table role world", () => {
    const mail = readSource(path.join(SERVER_SRC, "services", "mail", "mailState.js"));
    const send = bodyOf(mail, "sendMail");
    assert.ok(send.startsWith("\nfunction sendMail(options = {}) {"), send.slice(0, 80));
    assert.ok(send.includes("const title = normalizeSubject(options.title);"));
    assert.ok(send.includes("const saveSenderCopy = options.saveSenderCopy !== false;"));
    assert.ok(send.includes("const sentDate = normalizeText(options.sentDate, \"\") || currentFileTimeString();"));
    assert.ok(send.includes("return { success: false, errorMsg: \"WRITE_ERROR\" };"));
    assert.ok(/messageID,\n\s*sentDate,\n\s*recipients: recipientCharacterIDs,/.test(send));
    const subject = bodyOf(mail, "normalizeSubject");
    assert.ok(subject.includes(".trim()") && subject.includes("MAIL_MAX_SUBJECT_SIZE"));
    assert.ok(mail.includes("const MAIL_MAX_SUBJECT_SIZE = 150;") && mail.includes("const MAIL_MAX_BODY_SIZE = 8000;"));
    assert.ok(mail.includes("(BigInt(Date.now()) * 10000n + 116444736000000000n).toString()"));
    const box = bodyOf(mail, "getMailboxEntries");
    assert.ok(box.startsWith("\nfunction getMailboxEntries(characterID, options = {}) {"));
    assert.ok(box.includes("const includeTrashed = Boolean(options.includeTrashed);"));
    const exportsAt = mail.lastIndexOf("module.exports = {");
    assert.ok(exportsAt > 0);
    const exported = mail.slice(exportsAt);
    for (const name of ["sendMail", "getMailboxEntries", "resolveWelcomeSenderID"]) {
      assert.ok(new RegExp(`\\n\\s*${name},`).test(exported), `export ${name}`);
    }
    const roles = readSource(path.join(SERVER_SRC, "gameStore", "persistenceRoles.js"));
    const table = /TABLE_ROLE[\s\S]*?\}\);?/.exec(roles);
    assert.ok(table, "TABLE_ROLE found");
    assert.ok(!/\bmail\s*:/.test(table[0]) && !/["']mail["']/.test(table[0]), "mail is not in TABLE_ROLE");
    assert.ok(roles.includes("return TABLE_ROLE[String(table || \"\")] || ROLE.WORLD;"), "unlisted table -> world");
  });

  test("PM3 listIncomingMail (copy of the sender, trash, maxId past the skipped ones, max=0) "
    + "and readIncomingMail (found:false for the copy of the sender and the trash)", () => {
    const ME = 90000001;
    const OTHER = 90000002;
    const box = [
      { message: { messageID: 3, senderID: OTHER, title: "a", body: "<b>x</b>", sentDate: "1", toListID: null,
        toCorpOrAllianceID: null }, status: { statusMask: 1 } },
      { message: { messageID: 5, senderID: ME, title: "mine", body: "", sentDate: "2" }, status: { statusMask: 0 } },
      { message: { messageID: 7, senderID: OTHER, title: "trash", body: "", sentDate: "3" }, status: { statusMask: 8 } },
      { message: { messageID: 9, senderID: OTHER, title: "b", body: "y", sentDate: "4", toListID: 77 },
        status: { statusMask: 0 } },
      { message: { messageID: 4, senderID: OTHER, title: "c", body: "z", sentDate: "5" }, status: { statusMask: 0 } },
    ];
    const seen = [];
    const api = {
      getMailboxEntries: (id, options) => {
        seen.push([id, options]);
        return JSON.parse(JSON.stringify(box));
      },
      getMessageByIDForCharacter: (id, messageId) => {
        const e = box.find((x) => x.message.messageID === messageId);
        return e ? JSON.parse(JSON.stringify(e)) : null;
      },
    };
    const { adapter } = adapterWith(api);
    const all = adapter.listIncomingMail({ characterId: ME, afterId: 0, max: 10 });
    assert.deepStrictEqual(seen[0], [ME, { includeTrashed: true }]);
    assert.deepStrictEqual(all.mails.map((m) => m.messageId), [3, 4, 9], "ascending, no copy, no trash");
    assert.deepStrictEqual([all.maxId, all.truncated, all.count], [9, false, 3]);
    assert.deepStrictEqual(all.mails[0], { messageId: 3, senderId: OTHER, title: "a", body: "<b>x</b>", sentDate: "1",
      toListId: null, toCorpOrAllianceId: null, read: true });
    assert.strictEqual(all.mails[2].toListId, 77);
    const after = adapter.listIncomingMail({ characterId: ME, afterId: 3, max: 1 });
    assert.deepStrictEqual([after.mails.map((m) => m.messageId), after.maxId, after.truncated], [[9], 9, true]);
    assert.deepStrictEqual(adapter.listIncomingMail({ characterId: ME, afterId: 0, max: 0 }),
      { ok: true, mails: [], maxId: 9, truncated: true, count: 3 }, "max=0: only the baseline");
    assert.strictEqual(adapter.listIncomingMail({ characterId: ME, afterId: 20, max: 5 }).maxId, 20);
    assert.strictEqual(adapter.listIncomingMail({ characterId: ME, afterId: -1, max: 5 }).reason,
      "MAIL_INVALID_INPUT");
    assert.deepStrictEqual(adapter.readIncomingMail({ characterId: ME, messageId: 5 }), { ok: true, found: false });
    assert.deepStrictEqual(adapter.readIncomingMail({ characterId: ME, messageId: 7 }), { ok: true, found: false });
    assert.deepStrictEqual(adapter.readIncomingMail({ characterId: ME, messageId: 99 }), { ok: true, found: false });
    assert.strictEqual(adapter.readIncomingMail({ characterId: ME, messageId: 9 }).mail.title, "b");
    assert.strictEqual(adapterWith(null).adapter.readIncomingMail({ characterId: ME, messageId: 9 }).reason,
      "MAIL_SEAM_UNAVAILABLE");
  });

  test("PM4 vendor facts: mailState destructures sendMailSentNotification from "
    + "./mailNotifications and calls it per recipient; allocateMessageID = nextMessageID + 1; ensureStatusEntry keeps "
    + "no isSenderCopy; mailNotifications exports it in its literal; getMessageByIDForCharacter exported", () => {
    const mail = readSource(path.join(SERVER_SRC, "services", "mail", "mailState.js"));
    assert.ok(/const \{[^}]*\n\s*sendMailSentNotification,\n[^}]*\} = require\(path\.join\(__dirname, "\.\/mailNotifications"\)\);/
      .test(mail), "destructured at the first require");
    assert.ok(mail.includes("sendMailSentNotification(characterID, message, recipientStatus.statusMask);"));
    assert.ok(mail.includes("sendMailSentNotification(senderID, message, senderStatus.statusMask);"));
    const alloc = bodyOf(mail, "allocateMessageID");
    assert.ok(alloc.includes("state._meta.nextMessageID = nextMessageID + 1;"), "monotonic ids");
    const status = bodyOf(mail, "ensureStatusEntry");
    assert.ok(status.includes("messageID,\n    statusMask: 0,\n    labelMask: 0,\n  };"), status.slice(0, 400));
    assert.ok(!/existing\.isSenderCopy|isSenderCopy:(?!\s*Boolean\(options\.isSenderCopy\))/.test(status),
      "no isSenderCopy in the status");
    assert.ok(bodyOf(mail, "getMessageByIDForCharacter").includes("if (!status || !message) {"));
    const exported = mail.slice(mail.lastIndexOf("module.exports = {"));
    assert.ok(/\n\s*getMessageByIDForCharacter,/.test(exported));
    const notes = readSource(path.join(SERVER_SRC, "services", "mail", "mailNotifications.js"));
    assert.ok(notes.includes("function sendMailSentNotification(characterID, message, statusMask, options = {}) {"));
    assert.ok(/module\.exports = \{[^}]*\n\s*sendMailSentNotification,/.test(notes), "export literal");
  });
};
