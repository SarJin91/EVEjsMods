"use strict";

const STATE = Object.freeze({ OFF: "off", RUNNING: "running", DISABLED: "disabled", STOPPED: "stopped" });
const LANE_STATE = Object.freeze({ OFF: "off", RUNNING: "running", DISABLED: "disabled",
  DISABLED_BY_DEPENDENCY: "disabled_by_dependency", STOPPED: "stopped" });

const METRIC_LOCAL_LINES = "npcVoices.localLines";
const METRIC_AI_LINES = "npcVoices.aiLines";
const METRIC_GLYPH_LINES = "npcVoices.glyphLines";
const METRIC_SEND_FAILED = "npcVoices.sendFailed";
const METRIC_RATE_LIMITED = "npcVoices.rateLimited";
const METRIC_PASS_MS = "npcVoices.passMs";
const METRIC_SITE_ENTRIES = "npcVoices.siteEntries";
const METRIC_SITE_EXCHANGES = "npcVoices.siteExchanges";
const METRIC_SITE_LINES = "npcVoices.siteLines";

const LOCAL_COUNTER_NAMES = Object.freeze(["passes", "notes", "lines", "aiLines", "glyphLines", "staticLines",
  "addressLines", "sendFailed", "noSocket", "rateLimited", "noVoice", "noLine", "systemsDropped", "errors",
  "fameLines", "fameCooldown", "fameNoCandidate"]);

const SITE_COUNTER_NAMES = Object.freeze(["passes", "entries", "queueFull", "kindFiltered", "noFaction", "noVoice",
  "cooldown", "roomRoll", "rateLimited", "pendingFull", "exchanges", "done", "aborted", "leftSystem", "noSession",
  "lines", "aiLines", "glyphLines", "staticLines", "noLine", "sendFailed", "errors"]);

const TALK_COUNTER_NAMES = Object.freeze(["playerLines", "npcLines", "noted", "skipped", "notes", "errors"]);
const TALK_LANE_COUNTER_NAMES = Object.freeze(["passes", "turns", "replies", "followUps", "aiLines", "fallbackLines",
  "glyphLines", "failed", "stale", "noSpeaker", "noVoice", "rateLimited", "sendFailed", "noSocket", "noLine"]);
const METRICS = Object.freeze({
  talkLines: "npcVoices.talkLines",
  talkReplies: "npcVoices.talkReplies",
  talkFallback: "npcVoices.talkFallback",
  talkFailed: "npcVoices.talkFailed",
  talkMs: "npcVoices.talkMs",
});

const EXCHANGE_STATE = Object.freeze({ PLANNED: "PLANNED", SPEAKING: "SPEAKING", DONE: "DONE", ABORTED: "ABORTED" });

const GENERAL_INTEGER_KEYS = Object.freeze(["maxLineChars"]);
const GLYPH_INTEGER_KEYS = Object.freeze(["minWords", "maxWords", "minWordLen", "maxWordLen"]);
const GLYPH_PAIRS = Object.freeze([["minWords", "maxWords"], ["minWordLen", "maxWordLen"]]);
const LOCAL_INTEGER_KEYS = Object.freeze(["tickMs", "minGapMs", "maxGapMs", "maxLinesPerMinute",
  "maxLinesPerSystemPerHour", "addressPermille", "addressCooldownMs", "recentLinesPerSystem", "maxSystems"]);
const LOCAL_PAIRS = Object.freeze([["minGapMs", "maxGapMs"]]);
const SITE_INTEGER_KEYS = Object.freeze(["tickMs", "firstDelayMs", "lineGapMinMs", "lineGapMaxMs", "minLines",
  "maxLines", "characterCooldownMs", "roomCooldownMs", "otherRoomPermille", "maxExchangesPerHour",
  "maxExchangesPerCharacterPerHour", "maxPending", "maxEntryQueue"]);
const SITE_PAIRS = Object.freeze([["lineGapMinMs", "lineGapMaxMs"], ["minLines", "maxLines"]]);
const TALK_INTEGER_KEYS = Object.freeze(["transcriptLines", "contextMaxAgeMs", "lineChars", "maxSystems",
  "tickMs", "minGapMs", "maxGapMs", "contextLines", "maxLineChars", "minLineChars", "replyPermille", "replyDelayMinMs",
  "replyDelayMaxMs", "replyCooldownMs", "followUpPermille", "followUpDelayMinMs", "followUpDelayMaxMs",
  "maxFollowUpsInRow", "maxInFlight", "maxLinesPerMinute", "maxLinesPerSystemPerHour", "staleMs", "fallbackPermille"]);
const TALK_PAIRS = Object.freeze([["minGapMs", "maxGapMs"], ["minLineChars", "maxLineChars"],
  ["replyDelayMinMs", "replyDelayMaxMs"], ["followUpDelayMinMs", "followUpDelayMaxMs"],
  ["contextLines", "transcriptLines"]]);
const SITE_KIND_RE = /^[a-z_]{1,32}$/;

function invalid(detail) {
  return { ok: false, reason: "INVALID_SETTINGS", detail };
}

function integersOf(block, keys, prefix, out) {
  for (const key of keys) {
    const v = block[key];
    if (!Number.isSafeInteger(v) || v < 0) return `${prefix}.${key}: not a safe integer >= 0`;
    out[key] = v;
  }
  return null;
}

function pairsOf(out, pairs, prefix) {
  for (const [low, high] of pairs) {
    if (out[low] > out[high]) return `${prefix}.${low} above ${prefix}.${high}`;
  }
  return null;
}

function npcVoicesSettingsOf(config) {
  const V = config && config.npcVoices;
  if (!V || typeof V !== "object") return invalid("npcVoices: no settings block");
  if (typeof V.enabled !== "boolean") return invalid("npcVoices.enabled: not a boolean");
  const out = { enabled: V.enabled };
  let miss = integersOf(V, GENERAL_INTEGER_KEYS, "npcVoices", out);
  if (miss) return invalid(miss);
  if (out.maxLineChars < 1) return invalid("npcVoices.maxLineChars: below 1");
  const G = V.glyphs;
  if (!G || typeof G !== "object") return invalid("npcVoices.glyphs: no settings block");
  if (typeof G.extended !== "boolean") return invalid("npcVoices.glyphs.extended: not a boolean");
  const glyphs = { extended: G.extended };
  miss = integersOf(G, GLYPH_INTEGER_KEYS, "npcVoices.glyphs", glyphs) || pairsOf(glyphs, GLYPH_PAIRS, "npcVoices.glyphs");
  if (miss) return invalid(miss);
  if (glyphs.minWords < 1 || glyphs.minWordLen < 1) return invalid("npcVoices.glyphs: minWords / minWordLen below 1");
  out.glyphs = Object.freeze(glyphs);
  return { ok: true, settings: Object.freeze(out) };
}

function localSettingsOf(config) {
  const L = config && config.npcVoices && config.npcVoices.local;
  if (!L || typeof L !== "object") return invalid("npcVoices.local: no settings block");
  if (typeof L.enabled !== "boolean") return invalid("npcVoices.local.enabled: not a boolean");
  const out = { enabled: L.enabled };
  const miss = integersOf(L, LOCAL_INTEGER_KEYS, "npcVoices.local", out) || pairsOf(out, LOCAL_PAIRS, "npcVoices.local");
  if (miss) return invalid(miss);
  if (out.tickMs < 1 || out.minGapMs < 1) return invalid("npcVoices.local: tickMs / minGapMs below 1");
  return { ok: true, settings: Object.freeze(out) };
}

function siteSettingsOf(config) {
  const S = config && config.npcVoices && config.npcVoices.site;
  if (!S || typeof S !== "object") return invalid("npcVoices.site: no settings block");
  if (typeof S.enabled !== "boolean") return invalid("npcVoices.site.enabled: not a boolean");
  if (typeof S.colorSpeakers !== "boolean") return invalid("npcVoices.site.colorSpeakers: not a boolean");
  const out = { enabled: S.enabled, colorSpeakers: S.colorSpeakers };
  const miss = integersOf(S, SITE_INTEGER_KEYS, "npcVoices.site", out) || pairsOf(out, SITE_PAIRS, "npcVoices.site");
  if (miss) return invalid(miss);
  if (out.tickMs < 1 || out.minLines < 1 || out.maxPending < 1 || out.maxEntryQueue < 1) {
    return invalid("npcVoices.site: tickMs / minLines / maxPending / maxEntryQueue below 1");
  }
  const kinds = typeof S.siteKinds === "string"
    ? S.siteKinds.split(",").map((k) => k.trim().toLowerCase()).filter((k) => k !== "") : [];
  if (kinds.length === 0 || !kinds.every((k) => SITE_KIND_RE.test(k))) {
    return invalid("npcVoices.site.siteKinds: not a CSV of kinds");
  }
  out.siteKinds = Object.freeze([...new Set(kinds)]);
  return { ok: true, settings: Object.freeze(out) };
}

function talkSettingsOf(config) {
  const T = config && config.npcVoices && config.npcVoices.talk;
  if (!T || typeof T !== "object") return invalid("npcVoices.talk: no settings block");
  if (typeof T.enabled !== "boolean") return invalid("npcVoices.talk.enabled: not a boolean");
  if (typeof T.sharePlayerText !== "boolean") return invalid("npcVoices.talk.sharePlayerText: not a boolean");
  if (typeof T.requirePlayer !== "boolean") return invalid("npcVoices.talk.requirePlayer: not a boolean");
  const out = { enabled: T.enabled, sharePlayerText: T.sharePlayerText, requirePlayer: T.requirePlayer };
  const miss = integersOf(T, TALK_INTEGER_KEYS, "npcVoices.talk", out) || pairsOf(out, TALK_PAIRS, "npcVoices.talk");
  if (miss) return invalid(miss);
  if (out.transcriptLines < 1 || out.lineChars < 1 || out.maxSystems < 1) {
    return invalid("npcVoices.talk: transcriptLines / lineChars / maxSystems below 1");
  }
  if (out.tickMs < 1 || out.minGapMs < 1 || out.minLineChars < 1 || out.staleMs < 1) {
    return invalid("npcVoices.talk: tickMs / minGapMs / minLineChars / staleMs below 1");
  }
  return { ok: true, settings: Object.freeze(out) };
}

module.exports = {
  STATE,
  LANE_STATE,
  METRIC_LOCAL_LINES,
  METRIC_AI_LINES,
  METRIC_GLYPH_LINES,
  METRIC_SEND_FAILED,
  METRIC_RATE_LIMITED,
  METRIC_PASS_MS,
  METRIC_SITE_ENTRIES,
  METRIC_SITE_EXCHANGES,
  METRIC_SITE_LINES,
  LOCAL_COUNTER_NAMES,
  SITE_COUNTER_NAMES,
  TALK_COUNTER_NAMES,
  TALK_LANE_COUNTER_NAMES,
  METRICS,
  EXCHANGE_STATE,
  npcVoicesSettingsOf,
  localSettingsOf,
  siteSettingsOf,
  talkSettingsOf,
};
