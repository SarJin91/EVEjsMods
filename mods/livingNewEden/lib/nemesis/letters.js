"use strict";

const S = require("./schema");
const NR = require("./repository");
const { rankTitleOf, GANG_FALLBACK } = require("./data/ranks");
const L = require("./data/letters");
const { slimNameOf } = require("../bounty/live");
const { deriveSeed } = require("../util/rng");

const DAY_MS = 86400000;
const MAX_DETAIL = 160;
const ASCII_RE = /^[\x20-\x7E]+$/;
const FRAME_FIELD_RE = /\{(nick|gang|title|pilot|body)\}/g;
const isId = (v) => Number.isSafeInteger(v) && v > 0;
const messageOf = (err) => String((err && err.message) || err).slice(0, MAX_DETAIL);

function safeCall(fn, fallback) {
  try {
    return typeof fn === "function" ? fn() : fallback;
  } catch (_err) {
    return fallback;
  }
}

function cleanField(v, fallback) {
  const s = typeof v === "string" ? v.replace(/[^\x20-\x7E]/g, "").replace(/[{}]/g, "").trim() : "";
  return s !== "" ? s : fallback;
}

function frameLetter({ kind, nick, gang, title, pilot, body, maxChars }) {
  const frame = L.FRAMES[kind];
  if (typeof frame !== "string" || typeof body !== "string") return null;
  if (body !== "" && !ASCII_RE.test(body)) return null;
  const fields = { nick: cleanField(nick, L.NICK_FALLBACK), gang: cleanField(gang, GANG_FALLBACK),
    title: cleanField(title, rankTitleOf(1)), pilot: cleanField(pilot, L.PILOT_FALLBACK), body: body.trim() };
  const line = frame.replace(FRAME_FIELD_RE, (_m, k) => fields[k]);
  return ASCII_RE.test(line) && line.length <= maxChars ? line : null;
}

function buildLetterMessages({ kind, nick, gang, title, factionName, playerHullClass, maxChars }) {
  const who = cleanField(nick, L.NICK_FALLBACK);
  const g = cleanField(gang, GANG_FALLBACK);
  const f = cleanField(factionName, "pirates");
  const phrase = L.EVENT_PHRASES[kind] || L.EVENT_PHRASES.WON;
  return [{ role: "system", content: `You are ${who}, ${cleanField(title, rankTitleOf(1))} of the pirate gang ${g} `
    + `(${f}) in EVE Online. Write one short line, in English, to the capsuleer you ${phrase}. Speak to them as "you". `
    + `No names, no numbers, no links, no quotes. At most ${maxChars} characters.` },
  { role: "user", content: `Event: ${kind}. Their ship class: ${cleanField(playerHullClass, "unknown")}.` }];
}

function lastOfKind(history, kind) {
  const list = Array.isArray(history) ? history : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (Array.isArray(list[i]) && list[i][1] === kind) return list[i];
  }
  return null;
}

function lastHullOf(history) {
  const list = Array.isArray(history) ? history : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (Array.isArray(list[i]) && typeof list[i][3] === "string" && list[i][3] !== "") return list[i][3];
  }
  return null;
}

function entryOf(nem) {
  const h = lastOfKind(nem.history, nem.letterKind);
  return Object.freeze({ nemesisId: nem.nemesisId, characterId: nem.characterId, seq: nem.letterSeq,
    kind: nem.letterKind, nick: slimNameOf(nem.name), gangId: nem.gangId, commanderId: nem.commanderId,
    factionId: nem.factionId, rank: nem.rank, hullClass: h && typeof h[3] === "string" ? h[3] : null,
    systemId: h && Number.isSafeInteger(h[2]) && h[2] >= 0 ? h[2] : nem.originSystemId,
    eventAt: h && Number.isSafeInteger(h[0]) && h[0] >= 0 ? h[0] : nem.updatedAt, seed: nem.seed });
}

const isPending = (nem) => Boolean(nem) && Number.isSafeInteger(nem.letterSeq) && nem.letterSeq > nem.letterSentSeq
  && Object.values(S.LETTER_KINDS).includes(nem.letterKind) && isId(nem.characterId);

function createLetterPump(deps) {
  const N = deps.settings;
  const bump = typeof deps.bump === "function" ? deps.bump : () => {};
  const log = typeof deps.log === "function" ? deps.log : () => {};
  const pending = new Map();
  const lastLetterAt = new Map();
  const returnTexts = new Map();
  let inFlight = null;
  let day = -1;
  let today = 0;

  const on = () => N.letterEnabled === true;

  function rollDay(now) {
    const d = Math.floor(now / DAY_MS);
    if (d !== day) {
      day = d;
      today = 0;
    }
  }

  function noticesNow(ctx) {
    const n = safeCall(ctx.getNotices, null);
    if (!n || typeof n.enqueueItemsInTx !== "function" || typeof n.getStatus !== "function") return null;
    const st = safeCall(() => n.getStatus(), null);
    return st && st.state === "running" ? n : null;
  }

  function namesOf(e, ctx, withPilot) {
    const m = safeCall(() => ctx.memberOf(e.gangId, e.commanderId), null);
    const gang = m && typeof m.corpName === "string" && m.corpName !== "" ? m.corpName : GANG_FALLBACK;
    const pilot = withPilot ? safeCall(() => ctx.pilotNameOf(e.characterId), null) : null;
    const factionName = safeCall(() => ctx.factionNameOf(e.factionId), null);
    return { nick: e.nick, gang, title: rankTitleOf(e.rank), pilot: typeof pilot === "string" ? pilot : null,
      factionName: typeof factionName === "string" ? factionName : null };
  }

  function templateLineOf(e, names) {
    const list = L.TEMPLATES[e.kind] || [];
    if (list.length === 0) return null;
    const at = deriveSeed(e.seed >>> 0, S.RNG_STREAM_LETTER, e.seq) % list.length;
    for (let i = 0; i < list.length; i += 1) {
      const line = frameLetter({ kind: e.kind, ...names, body: list[(at + i) % list.length], maxChars: N.letterMaxChars });
      if (line !== null) return line;
    }
    const long = frameLetter({ kind: e.kind, ...names, body: list[at], maxChars: Number.MAX_SAFE_INTEGER });
    return long ? long.slice(0, N.letterMaxChars).trimEnd() : null;
  }

  const bodyOk = (text, bodyMax) => typeof text === "string" && text.trim().length >= S.LETTER_MIN_CHARS
    && text.length <= bodyMax && ASCII_RE.test(text) && !/[{}]/.test(text);

  function finalize(e, result, now, ctx) {
    let outcome = result;
    let line = null;
    let llm = false;
    const notices = outcome.type === "send" ? noticesNow(ctx) : null;
    if (outcome.type === "send" && !notices) outcome = { type: "skip", counter: "nemesisLetterNoNotices" };
    if (outcome.type === "send") {
      const names = namesOf(e, ctx, true);
      if (outcome.text !== null) {
        line = frameLetter({ kind: e.kind, ...names, body: outcome.text, maxChars: N.letterMaxChars });
        llm = line !== null;
      }
      if (line === null) line = templateLineOf(e, names);
      if (line === null) outcome = { type: "skip", counter: "nemesisLetterFailed" };
    }
    const item = outcome.type === "send" ? { eventKey: S.letterEventKeyOf(e.nemesisId, e.seq),
      characterId: e.characterId, kind: S.LETTER_NOTICE_KIND, systemId: e.systemId, line, eventAt: e.eventAt } : null;
    let res = null;
    try {
      res = deps.store.transaction("bounty.nemesis", (tx) => {
        const m = NR.markLetterSentInTx(tx, e.nemesisId, e.seq);
        if (!m.ok) return { marked: false, reason: m.reason };
        if (!item) return { marked: true, queued: null };
        let q = null;
        try {
          q = notices.enqueueItemsInTx(tx, [item], now);
        } catch (err) {
          if (tx && tx.inTransaction === false) throw err;
          q = { ok: false, reason: messageOf(err) };
        }
        return { marked: true, queued: q };
      });
    } catch (err) {
      res = { ok: false, reason: messageOf(err) };
    }
    if (!res || res.ok !== true || !res.value) {
      bump("nemesisLetterFailed");
      log(`nemesis letter ${e.nemesisId} refused - ${String((res && res.reason) || "no_result").slice(0, MAX_DETAIL)}`);
      return false;
    }
    const cur = pending.get(e.nemesisId);
    if (cur && cur.seq === e.seq) pending.delete(e.nemesisId);
    if (res.value.marked !== true) return false;
    if (outcome.type === "skip") {
      bump(outcome.counter);
      return false;
    }
    const q = res.value.queued;
    if (!q || q.ok !== true) {
      bump("nemesisLetterNoNotices");
      return false;
    }
    if (!(q.inserted > 0)) {
      bump("nemesisLetterDuplicate");
      return false;
    }
    lastLetterAt.set(e.characterId, now);
    bump("nemesisLetterQueued");
    bump(llm ? "nemesisLetterLlm" : "nemesisLetterTemplate");
    return true;
  }

  function ask(ai, spec, fl) {
    let p = null;
    try {
      p = ai.complete(spec);
    } catch (_err) {
      p = null;
    }
    if (!p || typeof p.then !== "function") return false;
    inFlight = fl;
    p.then((r) => {
      if (r && r.ok === true && bodyOk(r.line, fl.bodyMax)) fl.text = r.line.trim();
      fl.done = true;
    }, () => {
      fl.done = true;
    });
    return true;
  }

  const aiOf = (ctx) => {
    const ai = safeCall(ctx.getChatterAi, null);
    return ai && typeof ai.complete === "function" ? ai : null;
  };

  const specOf = (kind, nick, gang, messages, bodyMax) => ({ lane: "talk", key: `nemesis:${kind}`, messages,
    minChars: S.LETTER_MIN_CHARS, maxChars: bodyMax, speakerName: cleanField(nick, L.NICK_FALLBACK),
    names: [cleanField(nick, L.NICK_FALLBACK), cleanField(gang, GANG_FALLBACK)], profanityCap: "mild", recent: [] });

  const roomOf = (kind, names) => {
    const empty = frameLetter({ kind, ...names, body: "", maxChars: Number.MAX_SAFE_INTEGER });
    return empty === null ? 0 : N.letterMaxChars - empty.length;
  };

  function settle(fl, now, ctx) {
    inFlight = null;
    if (fl.kind === "letter") return finalize(fl.entry, { type: "send", text: fl.text }, now, ctx);
    if (fl.text !== null && returnTexts.size < N.maxActiveTotal) {
      const line = frameLetter({ kind: S.LETTER_KIND_RETURN, ...fl.names, pilot: null, body: fl.text,
        maxChars: N.letterMaxChars });
      if (line !== null) returnTexts.set(fl.revengeId, { nemesisId: fl.nemesisId, line });
    }
    return false;
  }

  function step(now, ctx) {
    const out = { sent: 0, requested: false };
    if (!on() || !ctx || !Number.isSafeInteger(now)) return out;
    rollDay(now);
    if (inFlight) {
      if (!inFlight.done && now - inFlight.startedAt < N.letterWaitMs) return out;
      if (settle(inFlight, now, ctx)) out.sent += 1;
    }
    const e = pending.values().next().value;
    if (!e) return out;
    if (now - e.eventAt > N.letterMaxAgeMs) {
      finalize(e, { type: "skip", counter: "nemesisLetterStale" }, now, ctx);
      return out;
    }
    const last = lastLetterAt.get(e.characterId);
    if (Number.isSafeInteger(last) && now - last < N.letterMinGapMs) {
      finalize(e, { type: "skip", counter: "nemesisLetterCapped" }, now, ctx);
      return out;
    }
    if (!noticesNow(ctx)) {
      finalize(e, { type: "skip", counter: "nemesisLetterNoNotices" }, now, ctx);
      return out;
    }
    const ai = aiOf(ctx);
    const names = namesOf(e, ctx, true);
    const bodyMax = roomOf(e.kind, names);
    if (ai && today >= N.letterMaxPerDay) bump("nemesisLetterCapped");
    if (!ai || today >= N.letterMaxPerDay || bodyMax < S.LETTER_MIN_CHARS) {
      if (finalize(e, { type: "send", text: null }, now, ctx)) out.sent += 1;
      return out;
    }
    const messages = buildLetterMessages({ kind: e.kind, nick: names.nick, gang: names.gang, title: names.title,
      factionName: names.factionName, playerHullClass: e.hullClass, maxChars: bodyMax });
    today += 1;
    const fl = { kind: "letter", entry: e, startedAt: now, bodyMax, text: null, done: false };
    if (!ask(ai, specOf(e.kind, names.nick, names.gang, messages, bodyMax), fl)) {
      if (finalize(e, { type: "send", text: null }, now, ctx)) out.sent += 1;
      return out;
    }
    out.requested = true;
    return out;
  }

  function prepareReturn(nem, revengeId, now, ctx) {
    try {
      if (!on() || inFlight || !ctx || !nem || typeof revengeId !== "string" || !Number.isSafeInteger(now)) return;
      rollDay(now);
      if (today >= N.letterMaxPerDay || returnTexts.size >= N.maxActiveTotal) return;
      const ai = aiOf(ctx);
      if (!ai) return;
      const e = { nick: slimNameOf(nem.name), gangId: nem.gangId, commanderId: nem.commanderId,
        factionId: nem.factionId, rank: nem.rank, characterId: nem.characterId };
      const names = namesOf(e, ctx, false);
      const bodyMax = roomOf(S.LETTER_KIND_RETURN, names);
      if (bodyMax < S.LETTER_MIN_CHARS) return;
      const messages = buildLetterMessages({ kind: S.LETTER_KIND_RETURN, nick: names.nick, gang: names.gang,
        title: names.title, factionName: names.factionName, playerHullClass: lastHullOf(nem.history),
        maxChars: bodyMax });
      today += 1;
      ask(ai, specOf(S.LETTER_KIND_RETURN, names.nick, names.gang, messages, bodyMax), { kind: "return", revengeId,
        nemesisId: nem.nemesisId, names: { nick: names.nick, gang: names.gang, title: names.title }, startedAt: now,
        bodyMax, text: null, done: false });
    } catch (_err) {
    }
  }

  return {
    noteCommitted(nem) {
      if (!nem || typeof nem.nemesisId !== "string") return;
      for (const [k, v] of returnTexts) if (v.nemesisId === nem.nemesisId) returnTexts.delete(k);
      if (!on() || !isPending(nem)) return;
      if (!pending.has(nem.nemesisId) && pending.size >= N.maxActiveTotal) return;
      pending.set(nem.nemesisId, entryOf(nem));
    },
    load(rows) {
      pending.clear();
      if (!on()) return;
      for (const r of Array.isArray(rows) ? rows : []) {
        if (pending.size >= N.maxActiveTotal) break;
        if (isPending(r)) pending.set(r.nemesisId, entryOf(r));
      }
    },
    step,
    prepareReturn,
    takeReturnLine(revengeId) {
      const t = returnTexts.get(revengeId);
      if (!t) return null;
      returnTexts.delete(revengeId);
      bump("nemesisReturnLineLlm");
      return t.line;
    },
    status: () => Object.freeze({ pending: pending.size, inFlight: inFlight !== null, today }),
    stop() {
      pending.clear();
      lastLetterAt.clear();
      returnTexts.clear();
      inFlight = null;
    },
  };
}

module.exports = { createLetterPump, buildLetterMessages, frameLetter };
