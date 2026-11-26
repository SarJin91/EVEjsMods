"use strict";

const { buildSystemPrompt } = require("../persona");
const { checkInjection } = require("../memory/guard");
const { parseExtraction } = require("../memory/extract");
const { sanitizeGameText } = require("../context");
const { MAIL_RULE, MAIL_USER, MAIL_HIDDEN, MAIL_TEXT } = require("../data/persona");
const { LANGUAGE_CODES } = require("../schema");
const { mailText, mailTitle } = require("./text");

const MAX_NAME_CHARS = 40;
const BASE_LANGUAGE = "en";
const META_LINE_RE = /^[\s>*\-•`]*(?:fact|summary)\s*\|/i;

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const langOf = (language) => (LANGUAGE_CODES.includes(language) ? language : BASE_LANGUAGE);
const fill = (text, values) => text.replace(/\{(\w+)\}/g, (m, key) => (key in values ? String(values[key]) : m));

function selectMails(mails, opts) {
  const o = opts || {};
  const ai = o.aiIds instanceof Set ? o.aiIds : new Set();
  const kept = [];
  let skipped = 0;
  for (const m of Array.isArray(mails) ? mails : []) {
    if (!m || ai.has(m.senderId) || m.senderId === o.playerId) {
      skipped += 1;
      continue;
    }
    kept.push(m);
  }
  kept.sort((a, b) => a.messageId - b.messageId);
  const limit = Number.isSafeInteger(o.limit) && o.limit > 0 ? o.limit : 1;
  const items = kept.slice(-limit);
  return { items, more: kept.length - items.length, skipped };
}

function buildMailItems(mails, opts) {
  const S = opts.S;
  return (Array.isArray(mails) ? mails : []).map((m, i) => {
    let info = { name: null, system: false };
    try {
      const r = isId(m.senderId) && typeof opts.senderInfo === "function" ? opts.senderInfo(m.senderId) : null;
      if (r && typeof r === "object") info = r;
    } catch (_err) {
    }
    const name = typeof info.name === "string" ? sanitizeGameText(info.name, MAX_NAME_CHARS) : "";
    let fromKind = "unknown";
    if (info.system === true) fromKind = "system";
    else if (isId(m.toListId)) fromKind = "list";
    else if (isId(m.toCorpOrAllianceId)) fromKind = "corp";
    else if (name !== "") fromKind = "pilot";
    const subject = mailTitle(m.title, S.mailMaxTitleChars);
    const body = mailText(m.body, S.mailMaxBodyChars);
    const suspicious = !checkInjection(subject).ok || !checkInjection(body).ok;
    return { n: i + 1, from: name === "" ? null : name, fromKind, subject: suspicious ? MAIL_HIDDEN : subject,
      body: suspicious ? MAIL_HIDDEN : body, suspicious };
  });
}

function buildMailMessages(spec) {
  const s = spec;
  const S = s.S;
  const persona = s.persona || {};
  const snap = typeof s.snapshotJson === "string" && s.snapshotJson !== "" ? s.snapshotJson : "{}";
  const mails = (Array.isArray(s.items) ? s.items : []).map((it) => ({ n: it.n, from: it.from, fromKind: it.fromKind,
    subject: it.subject, text: it.body, suspicious: it.suspicious }));
  const question = typeof s.question === "string" && s.question !== "" ? s.question : null;
  return [
    { role: "system", content: buildSystemPrompt({ aiName: persona.aiName, playerName: persona.playerName,
      language: S.language, maxLines: S.maxLinesPerReply, preset: persona.preset, custom: persona.custom,
      profanity: S.profanity, customMaxChars: S.personaCustomMaxChars }) },
    { role: "system", content: `DATA {"snapshot":${snap}}` },
    { role: "system", content: fill(MAIL_RULE, { lines: S.maxLinesPerReply, facts: S.mailFactsPerDigest }) },
    { role: "system", content: `MAIL ${JSON.stringify({ away: s.away === true, more: s.more > 0 ? s.more : 0,
      mails })}` },
    { role: "user", content: question === null ? MAIL_USER : question },
  ];
}

function parseMailReply(text) {
  const raw = String(text ?? "");
  const facts = parseExtraction(raw).facts;
  const rest = raw.split(/\r?\n/).filter((line) => !META_LINE_RE.test(line)).join("\n").trim();
  return { text: rest, facts };
}

function staticMailLines(items, more, away, language, limits) {
  const T = MAIL_TEXT[langOf(language)];
  const list = Array.isArray(items) ? items : [];
  const maxLines = limits && isId(limits.maxLinesPerReply) ? limits.maxLinesPerReply : 1;
  const maxChars = limits && isId(limits.maxLineChars) ? limits.maxLineChars : 200;
  const cut = (line) => (line.length > maxChars ? `${line.slice(0, Math.max(1, maxChars - 3))}...` : line);
  const total = list.length + (more > 0 ? more : 0);
  const lines = [cut(fill(away ? T.headerAway : T.header, { count: total }))];
  const room = maxLines - 1;
  const fits = list.length <= room && !(more > 0);
  const shown = fits ? list.length : Math.max(0, Math.min(list.length, room - 1));
  for (const it of list.slice(0, shown)) {
    const from = it.fromKind === "system" ? (it.from || T.system) : (it.from || T.unknown);
    lines.push(cut(fill(T.item, { n: it.n, from, subject: it.subject })));
  }
  if (!fits && room > 0) lines.push(cut(fill(T.more, { k: total - shown })));
  return lines;
}

module.exports = { selectMails, buildMailItems, buildMailMessages, parseMailReply, staticMailLines };
