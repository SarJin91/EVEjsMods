"use strict";

const STATE = Object.freeze({ OFF: "off", RUNNING: "running", DISABLED: "disabled", STOPPED: "stopped" });
const BREAKER = Object.freeze({ CLOSED: "closed", OPEN: "open", HALF_OPEN: "half_open" });
const METRICS = Object.freeze({
  requests: "chatterAi.requests",
  failed: "chatterAi.failed",
  tokens: "chatterAi.tokens",
  linesAccepted: "chatterAi.linesAccepted",
  linesRejected: "chatterAi.linesRejected",
  breakerOpened: "chatterAi.breakerOpened",
  requestMs: "chatterAi.requestMs",
  voiceRequests: "chatterAi.voiceRequests",
  talkRequests: "chatterAi.talkRequests",
  newsRequests: "chatterAi.newsRequests",
  plotRequests: "chatterAi.plotRequests",
});
const LANGUAGE_CODES = Object.freeze(["en", "pl"]);
const PROFANITY_LEVELS = Object.freeze(["off", "mild", "full"]);
const LANES = Object.freeze(["civilian", "resident", "voice", "talk", "news", "plot"]);
const REJECT_REASONS = Object.freeze(["LENGTH", "CHARSET", "PLACEHOLDER", "LINK", "DIGITS", "COMMAND", "BANNED",
  "DUPLICATE"]);

const MODEL_RE = /^[A-Za-z0-9._:/-]{1,128}$/;

const INTEGER_KEYS = Object.freeze(["temperatureMilli", "topPMilli", "maxTokens", "linesPerRequest", "promptExamples",
  "minTemplateChars", "maxTemplateChars", "timeoutMs", "maxResponseBytes", "maxRequestsPerMinute", "maxInFlight",
  "dailyTokenBudget", "refillTickMs", "poolPerBucket", "lowWaterPerBucket", "lineMaxAgeMs", "usePermille",
  "breakerFailures", "breakerCooldownMs", "breakerMaxCooldownMs", "demandWindowMs", "voiceTokenSharePermille",
  "talkMaxTokens", "talkTokenSharePermille", "talkReservedPerMinute", "talkMaxInFlight", "talkMaxPromptChars",
  "newsMaxTokens", "newsTokenSharePermille", "newsMaxPromptChars", "newsTimeoutMs",
  "plotMaxTokens", "plotTokenSharePermille", "plotMaxPromptChars", "plotTimeoutMs"]);
const ORDERED_PAIRS = Object.freeze([
  ["lowWaterPerBucket", "poolPerBucket"],
  ["breakerCooldownMs", "breakerMaxCooldownMs"],
  ["minTemplateChars", "maxTemplateChars"],
]);

function checkBaseUrl(text) {
  if (typeof text !== "string" || text === "") return false;
  let url;
  try {
    url = new URL(text);
  } catch (_err) {
    return false;
  }
  return url.protocol === "https:" && url.username === "" && url.password === "" && url.search === ""
    && url.hash === "";
}

function checkModel(text) {
  return typeof text === "string" && MODEL_RE.test(text);
}

function parseWordList(text) {
  if (typeof text !== "string") return [];
  return text.split(",").map((s) => s.trim().toLowerCase()).filter((s) => s !== "");
}

function invalid(detail) {
  return { ok: false, reason: "INVALID_SETTINGS", detail };
}

function chatterAiSettingsOf(config) {
  const C = config && config.chatterAi;
  if (!C || typeof C !== "object") return invalid("chatterAi: no settings block");
  if (typeof C.enabled !== "boolean") return invalid("chatterAi.enabled: not a boolean");
  if (!checkBaseUrl(C.baseUrl)) {
    return invalid("chatterAi.baseUrl: not an https URL without user, password, query or fragment");
  }
  if (!checkModel(C.model)) return invalid("chatterAi.model: not 1-128 characters of A-Z a-z 0-9 . _ : / -");
  if (typeof C.bannedWords !== "string") return invalid("chatterAi.bannedWords: not a string");
  if (typeof C.reasoningOff !== "boolean") return invalid("chatterAi.reasoningOff: not a boolean");
  if (!LANGUAGE_CODES.includes(C.language)) return invalid(`chatterAi.language: not one of ${LANGUAGE_CODES.join(", ")}`);
  if (!PROFANITY_LEVELS.includes(C.profanity)) {
    return invalid(`chatterAi.profanity: not one of ${PROFANITY_LEVELS.join(", ")}`);
  }
  const out = { enabled: C.enabled, baseUrl: C.baseUrl, model: C.model, bannedWords: C.bannedWords,
    language: C.language, profanity: C.profanity, reasoningOff: C.reasoningOff };
  for (const key of INTEGER_KEYS) {
    const v = C[key];
    if (!Number.isSafeInteger(v) || v < 0) return invalid(`chatterAi.${key}: not a safe integer >= 0`);
    out[key] = v;
  }
  for (const [low, high] of ORDERED_PAIRS) {
    if (out[low] > out[high]) return invalid(`chatterAi.${low} above chatterAi.${high}`);
  }
  if (out.talkReservedPerMinute > 0 && out.talkReservedPerMinute >= out.maxRequestsPerMinute) {
    return invalid("chatterAi.talkReservedPerMinute not below chatterAi.maxRequestsPerMinute");
  }
  out.bannedWordList = Object.freeze(parseWordList(C.bannedWords));
  return { ok: true, settings: Object.freeze(out) };
}

function apiKeyOf(config) {
  const C = config && config.chatterAi;
  const key = C && C.apiKey;
  return typeof key === "string" ? key.trim() : "";
}

module.exports = {
  STATE,
  BREAKER,
  METRICS,
  REJECT_REASONS,
  LANGUAGE_CODES,
  PROFANITY_LEVELS,
  LANES,
  checkBaseUrl,
  checkModel,
  parseWordList,
  chatterAiSettingsOf,
  apiKeyOf,
};
