"use strict";

const { createPoller } = require("../../presence/poller");
const { filterReply } = require("../filter");
const { cleanUserText } = require("../conversation");
const { MAIL_TEXT } = require("../data/persona");
const { METRIC, MAIL_MODES, LANGUAGE_CODES } = require("../schema");
const { selectMails, buildMailItems, buildMailMessages, parseMailReply, staticMailLines } = require("./digest");

const WORK_CLASS = "MAINTENANCE";
const LANE = "mail";
const STATE = Object.freeze({ OFF: "off", RUNNING: "running", SCAN_ONLY: "scan_only", DISABLED: "disabled",
  STOPPED: "stopped" });
const IDS_PER_DIGEST_FACTOR = 2;
const MAX_ASK = 99;
const COUNTER_NAMES = Object.freeze(["passes", "skippedGovernor", "listenerCalls", "digests", "staticDigests",
  "modelRequests", "fallbacks", "baselines", "stale", "gone", "suspicious", "skipped", "factsNoted", "deliveryFailed",
  "sqlFailed", "readFailed", "droppedMode", "asks",
  "worldNewsSkipped"]);

function noop() {}

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const codeOf = (value) => String(value ?? "unknown").replace(/[^\w:.\-]/g, "_").slice(0, 60);
const valueOf = (res) => (res && res.ok && res.value && res.value.ok ? res.value : null);
const langOf = (language) => (LANGUAGE_CODES.includes(language) ? language : "en");

function createShipAiMail(deps) {
  const d = deps;
  const S = d.S;
  const T = MAIL_TEXT[langOf(S.language)];
  const logger = d.logger && typeof d.logger.log === "function" ? d.logger : { log: noop };
  const telemetry = d.telemetry && typeof d.telemetry.count === "function" ? d.telemetry : null;
  const counters = Object.fromEntries(COUNTER_NAMES.map((n) => [n, 0]));
  const seam = d.seam && typeof d.seam.listIncoming === "function" ? d.seam : null;
  const enabled = S.mailEnabled === true;
  const prefs = new Map(d.initialPrefs instanceof Map ? d.initialPrefs : []);
  const entries = new Map();
  const lastDigestAt = new Map();
  let online = new Set();
  let state = !enabled ? STATE.OFF : (seam ? STATE.RUNNING : STATE.DISABLED);
  let hook = "not_installed";
  let removeListener = null;
  let inflight = false;
  let stopped = false;
  let generation = 0;
  let lastRescanAt = null;
  let started = false;

  const log = (line) => {
    try {
      logger.log(line);
    } catch (_err) {
    }
  };
  const metric = (name, n) => {
    if (!telemetry || n <= 0) return;
    try {
      telemetry.count(name, n);
    } catch (_err) {
    }
  };
  const governorAdmits = () => {
    try {
      const g = typeof d.getGovernor === "function" ? d.getGovernor() : null;
      return !g || typeof g.admits !== "function" || g.admits(WORK_CLASS) !== false;
    } catch (_err) {
      return true;
    }
  };
  const tx = (name, fn) => {
    const res = d.store.transaction(name, fn);
    const v = valueOf(res);
    if (!v) {
      counters.sqlFailed += 1;
      log(`shipAi mail: ${name} failed - ${codeOf(res && (res.ok ? res.value && res.value.reason : res.reason))}`);
    }
    return v;
  };
  const prefsOf = (playerId) => prefs.get(playerId) || { mailMode: "on", mailSeenId: null };
  const aiIdsNow = () => {
    try {
      const s = d.aiIds();
      return s instanceof Set ? s : new Set();
    } catch (_err) {
      return new Set();
    }
  };
  const isWatched = (playerId) => {
    try {
      return isId(playerId) && isId(d.aiIdOf(playerId)) && d.isAllowed(playerId) === true
        && prefsOf(playerId).mailMode !== "off";
    } catch (_err) {
      return false;
    }
  };
  const available = () => enabled && seam !== null && !stopped;
  const skip = (n) => {
    if (n <= 0) return;
    counters.skipped += n;
    metric(METRIC.mailSkipped, n);
  };

  function advance(playerId, seenId) {
    const v = tx("shipAi.mail.seen", (db) => d.prefsRepo.advanceMailSeen(db, { playerId, seenId,
      nowMs: d.nowMs() }));
    if (!v) return null;
    const p = prefsOf(playerId);
    const cur = p.mailSeenId === null ? -1 : p.mailSeenId;
    prefs.set(playerId, { ...p, mailSeenId: Math.max(cur, seenId) });
    if (v.changed === 1) return "moved";
    counters.stale += 1;
    return "stale";
  }

  function baseline(playerId) {
    const r = seam.listIncoming({ characterId: playerId, afterId: 0, max: 0 });
    if (!r || !r.ok) {
      counters.readFailed += 1;
      log(`shipAi mail: baseline read failed - ${codeOf(r && r.reason)}`);
      return;
    }
    if (advance(playerId, r.maxId) !== null) counters.baselines += 1;
  }

  function onMail(facts) {
    try {
      counters.listenerCalls += 1;
      if (!available() || !facts || !isId(facts.characterId) || !isId(facts.messageId)) return;
      const playerId = facts.characterId;
      if (!isWatched(playerId)) return;
      if (aiIdsNow().has(facts.senderId)) {
        skip(1);
        return;
      }
      const now = d.nowMs();
      let e = entries.get(playerId);
      if (!e) {
        const last = lastDigestAt.get(playerId);
        e = { dueAt: Math.max(now + S.mailDigestWindowMs, last === undefined ? 0 : last + S.mailMinIntervalMs),
          ids: [], scan: false, away: !online.has(playerId) };
        entries.set(playerId, e);
      }
      if (e.scan) return;
      e.ids.push(facts.messageId);
      if (e.ids.length > IDS_PER_DIGEST_FACTOR * S.mailMaxPerDigest) {
        e.scan = true;
        e.ids = [];
      }
    } catch (_err) {
    }
  }

  function collect(playerId, e, cursor) {
    if (e.scan) {
      const r = seam.listIncoming({ characterId: playerId, afterId: cursor,
        max: e.away ? S.mailOfflineDigestMax : S.mailMaxPerDigest });
      if (!r || !r.ok) return null;
      const count = Number.isSafeInteger(r.count) ? r.count : r.mails.length;
      return { mails: r.mails, maxId: r.maxId, extra: Math.max(0, count - r.mails.length) };
    }
    const ids = [...new Set(e.ids)].sort((a, b) => a - b);
    const mails = [];
    for (const id of ids) {
      if (id <= cursor) continue;
      const r = seam.readIncoming({ characterId: playerId, messageId: id });
      if (!r || !r.ok) return null;
      if (r.found) mails.push(r.mail);
      else counters.gone += 1;
    }
    if (ids.length > mails.length) skip(ids.filter((id) => id > cursor).length - mails.length);
    return { mails, maxId: ids.length > 0 ? ids[ids.length - 1] : cursor, extra: 0 };
  }

  function deliverLines(playerId, lines) {
    let r = null;
    try {
      r = d.deliver(playerId, lines);
    } catch (_err) {
      r = null;
    }
    if (!r || (r.failed >= lines.length && lines.length > 0)) counters.deliveryFailed += 1;
  }

  function staticOut(playerId, items, more, away) {
    counters.staticDigests += 1;
    counters.digests += 1;
    metric(METRIC.mailDigests, 1);
    deliverLines(playerId, staticMailLines(items, more, away, S.language, S));
  }

  const clientUp = () => {
    try {
      const st = typeof d.client.getStatus === "function" ? d.client.getStatus() : null;
      return !st || st.state === undefined || st.state === "running";
    } catch (_err) {
      return false;
    }
  };

  function modelOut(playerId, items, more, away, question, digest) {
    inflight = true;
    counters.modelRequests += 1;
    const gen = generation;
    const epoch = d.memory && typeof d.memory.epochOf === "function" ? d.memory.epochOf(playerId) : 0;
    let promise;
    try {
      const snap = d.snapshot(playerId);
      const p = typeof d.personaOf === "function" ? d.personaOf(playerId) : null;
      const messages = buildMailMessages({ persona: { aiName: d.nameOf(playerId),
        playerName: snap && snap.presence ? snap.presence.name : null, preset: p ? p.preset : undefined,
        custom: p ? p.custom : null },
      snapshotJson: snap && typeof snap.json === "string" ? snap.json : "{}", items, more, away, question, S });
      promise = Promise.resolve(d.client.request({ playerId, messages, lane: LANE, maxTokens: S.maxTokens }));
    } catch (_err) {
      promise = Promise.resolve({ ok: false, reason: "CONTEXT" });
    }
    const settle = (res) => {
      if (stopped || gen !== generation) return;
      inflight = false;
      try {
        const mode = prefsOf(playerId).mailMode;
        if (mode === "off") {
          counters.droppedMode += 1;
          return;
        }
        if (mode === "quiet") {
          staticOut(playerId, items, more, away);
          return;
        }
        const parsed = res && res.ok === true && typeof res.text === "string" ? parseMailReply(res.text) : null;
        const filtered = parsed ? filterReply(parsed.text, S, S.language) : null;
        if (!filtered || !filtered.ok) {
          counters.fallbacks += 1;
          log(`shipAi mail: digest fallback - ${codeOf(filtered ? filtered.reason : res && res.reason)}`);
          staticOut(playerId, items, more, away);
          return;
        }
        counters.digests += 1;
        metric(METRIC.mailDigests, 1);
        deliverLines(playerId, filtered.lines);
        if (digest && parsed.facts.length > 0 && d.memory && typeof d.memory.noteMailFacts === "function") {
          const noted = d.memory.noteMailFacts(playerId, parsed.facts, epoch);
          if (noted && noted.ok) counters.factsNoted += noted.written;
        }
      } catch (err) {
        log(`shipAi mail: digest failed - ${codeOf(err && (err.code || err.name))}`);
      }
    };
    promise.then(settle, () => settle({ ok: false, reason: "NET_ERROR" }));
  }

  function toldByWorldNews(playerId, mail) {
    try {
      if (!mail || typeof d.worldNewsToldMail !== "function" || typeof d.isNoticesSender !== "function") return false;
      if (d.isNoticesSender(mail.senderId) !== true || d.worldNewsToldMail(playerId, mail.messageId) !== true) {
        return false;
      }
      skip(1);
      counters.worldNewsSkipped += 1;
      return true;
    } catch (_err) {
      return false;
    }
  }

  function processEntry(playerId, e) {
    const p = prefsOf(playerId);
    if (p.mailSeenId === null) {
      baseline(playerId);
      return;
    }
    const got = collect(playerId, e, p.mailSeenId);
    if (!got) {
      counters.readFailed += 1;
      log("shipAi mail: mailbox read failed - MAIL_READ");
      return;
    }
    const mails = (Array.isArray(got.mails) ? got.mails : []).filter((m) => !toldByWorldNews(playerId, m));
    const sel = selectMails(mails, { playerId, aiIds: aiIdsNow(),
      limit: e.away ? S.mailOfflineDigestMax : S.mailMaxPerDigest });
    skip(sel.skipped);
    if (got.maxId <= p.mailSeenId) return;
    const moved = advance(playerId, got.maxId);
    if (moved !== "moved" || sel.items.length === 0) return;
    lastDigestAt.set(playerId, d.nowMs());
    const items = buildMailItems(sel.items, { senderInfo: (id) => seam.senderInfo(id), S });
    counters.suspicious += items.filter((it) => it.suspicious).length;
    metric(METRIC.mailSeen, items.length);
    const more = sel.more + got.extra;
    if (p.mailMode === "quiet" || !clientUp()) {
      staticOut(playerId, items, more, e.away);
      return;
    }
    modelOut(playerId, items, more, e.away, null, true);
  }

  function runPass() {
    if (!available()) return;
    if (!governorAdmits()) {
      counters.skippedGovernor += 1;
      return;
    }
    counters.passes += 1;
    const now = d.nowMs();
    const res = typeof d.readPresence === "function" ? d.readPresence() : null;
    const chars = res && res.ok && Array.isArray(res.characters) ? res.characters : [];
    const seen = new Set();
    for (const rec of chars) {
      const id = rec ? rec.characterId : null;
      if (!isId(id) || seen.has(id)) continue;
      seen.add(id);
      if (!online.has(id) && isWatched(id)) {
        entries.set(id, { dueAt: now + S.mailLoginDelayMs, ids: [], scan: true, away: true });
      }
    }
    online = seen;
    if (hook !== "installed" && S.mailRescanMs > 0 && (lastRescanAt === null || now - lastRescanAt >= S.mailRescanMs)) {
      lastRescanAt = now;
      for (const id of seen) {
        if (!entries.has(id) && isWatched(id)) entries.set(id, { dueAt: now, ids: [], scan: true, away: false });
      }
    }
    let handled = 0;
    for (const [playerId, e] of [...entries]) {
      if (handled >= S.mailPlayersPerPass) break;
      if (e.dueAt > now || !seen.has(playerId)) continue;
      if (!isWatched(playerId)) {
        entries.delete(playerId);
        continue;
      }
      const p = prefsOf(playerId);
      if (inflight && p.mailMode === "on" && p.mailSeenId !== null) continue;
      handled += 1;
      entries.delete(playerId);
      try {
        processEntry(playerId, e);
      } catch (err) {
        log(`shipAi mail: digest failed - ${codeOf(err && (err.code || err.name))}`);
      }
    }
  }

  const poller = createPoller({ runPass, intervalMs: S.mailPollMs, now: () => d.nowMs(), setTimer: d.setTimer,
    onError: (err) => log(`shipAi mail: pass failed - ${codeOf(err && (err.code || err.name))}`) });

  function start() {
    if (started || !available()) return { ok: true, running: false, state };
    started = true;
    try {
      hook = seam.hookState() === "installed" ? "installed" : "not_installed";
    } catch (_err) {
      hook = "not_installed";
    }
    if (hook === "installed") {
      const added = seam.addListener(onMail);
      if (added && added.ok && typeof added.remove === "function") removeListener = added.remove;
      else hook = "not_installed";
    }
    state = hook === "installed" ? STATE.RUNNING : STATE.SCAN_ONLY;
    if (hook !== "installed") log("shipAi mail: hook not installed - scan only");
    poller.start();
    return { ok: true, running: true, state };
  }

  function setMode(playerId, mode) {
    if (!MAIL_MODES.includes(mode)) return { ok: false, reason: "INVALID_MODE" };
    if (!isId(d.aiIdOf(playerId))) return { ok: false, reason: "NO_PAIR" };
    const v = tx("shipAi.mail.mode", (db) => d.prefsRepo.setMailMode(db, { playerId, mode, nowMs: d.nowMs() }));
    if (!v) return { ok: false, reason: "MAIL_FAILED" };
    prefs.set(playerId, { mailMode: v.row.mailMode, mailSeenId: v.row.mailSeenId });
    if (mode === "off") entries.delete(playerId);
    return { ok: true, mode: v.row.mailMode };
  }

  function onPairAdded(playerId) {
    try {
      if (!prefs.has(playerId)) prefs.set(playerId, { mailMode: "on", mailSeenId: null });
      if (available() && prefsOf(playerId).mailSeenId === null) baseline(playerId);
    } catch (err) {
      log(`shipAi mail: baseline failed - ${codeOf(err && (err.code || err.name))}`);
    }
  }

  function ask(playerId, n, question) {
    counters.asks += 1;
    if (!available()) return { ok: true, lines: [T.off] };
    if (!isId(d.aiIdOf(playerId))) return { ok: true, lines: [T.first] };
    const k = Number.isSafeInteger(n) && n >= 1 && n <= MAX_ASK ? n : 1;
    const ai = aiIdsNow();
    const r = seam.listIncoming({ characterId: playerId, afterId: 0, max: MAX_ASK });
    if (!r || !r.ok) {
      counters.readFailed += 1;
      return { ok: true, lines: [T.none] };
    }
    const sel = selectMails(r.mails, { playerId, aiIds: ai, limit: MAX_ASK });
    if (sel.items.length < k) return { ok: true, lines: [T.none] };
    const items = buildMailItems([sel.items[sel.items.length - k]], { senderInfo: (id) => seam.senderInfo(id), S })
      .map((it) => ({ ...it, n: k }));
    counters.suspicious += items.filter((it) => it.suspicious).length;
    const text = typeof question === "string" ? cleanUserText(question, S.maxUserChars) : "";
    if (prefsOf(playerId).mailMode !== "on" || inflight || !clientUp()) {
      return { ok: true, lines: staticMailLines(items, 0, false, S.language, S).slice(1) };
    }
    modelOut(playerId, items, 0, false, text === "" ? null : text, false);
    return { ok: true, lines: null };
  }

  function statusLine(playerId) {
    if (!available()) return T.off;
    return T.status.replace("{mode}", T.modes[prefsOf(playerId).mailMode] || T.modes.on);
  }

  function modeOf(playerId) {
    if (!available()) return null;
    const mode = prefsOf(playerId).mailMode;
    return MAIL_MODES.includes(mode) ? mode : "on";
  }

  function modeLine(res) {
    if (!available()) return T.off;
    if (!res.ok) return res.reason === "NO_PAIR" ? T.first : T.failed;
    return T.modeSet.replace("{mode}", T.modes[res.mode] || res.mode);
  }

  function getStatus() {
    return { state: stopped ? STATE.STOPPED : state, hook, entries: entries.size, inflight,
      counters: { ...counters } };
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    generation += 1;
    poller.stop();
    if (removeListener) {
      try {
        removeListener();
      } catch (_err) {
      }
      removeListener = null;
    }
    entries.clear();
  }

  return Object.freeze({ start, stop, setMode, ask, statusLine, modeLine, modeOf, onPairAdded, getStatus, runPass,
    onMail, available });
}

function noticesSenderOf(configured, senderInfo) {
  const fixed = Number.isSafeInteger(configured) && configured > 0 ? configured : 0;
  return (id) => {
    if (!isId(id)) return false;
    if (fixed > 0) return id === fixed;
    try {
      const info = typeof senderInfo === "function" ? senderInfo(id) : null;
      return Boolean(info) && info.system === true;
    } catch (_err) {
      return false;
    }
  };
}

module.exports = { createShipAiMail, COUNTER_NAMES, STATE, WORK_CLASS, noticesSenderOf };
