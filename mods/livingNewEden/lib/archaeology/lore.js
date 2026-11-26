"use strict";

const { MAX_STAGE_COUNT: MAX_STAGE_WORDS } = require("./schema");

const LORE_MIN_CHARS = 40;
const LORE_REASONS = Object.freeze(["OFF", "DISABLED", "STOPPED", "BAD_SPEC", "BREAKER_OPEN", "RATE_LIMITED",
  "BUDGET", "TALK_BUDGET", "TALK_IN_FLIGHT", "TIMEOUT", "NET_ERROR", "BAD_SHAPE", "EMPTY", "FILTER", "LENGTH",
  "DIGITS", "URL", "MARKUP", "OTHER"]);

const WORDS = Object.freeze({
  en: Object.freeze({
    ordinal: Object.freeze(["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth"]),
    count: Object.freeze(["one", "two", "three", "four", "five", "six", "seven", "eight"]),
    of: "of",
  }),
  pl: Object.freeze({
    ordinal: Object.freeze(["pierwszy", "drugi", "trzeci", "czwarty", "piaty", "szosty", "siodmy", "osmy"]),
    count: Object.freeze(["jednego", "dwoch", "trzech", "czterech", "pieciu", "szesciu", "siedmiu", "osmiu"]),
    of: "z",
  }),
});
const THEME_WORDS = Object.freeze({ JOVE: Object.freeze({ subject: "the Jove", adjective: "Jovian" }),
  DRIFTER: Object.freeze({ subject: "the Drifters", adjective: "Drifter" }) });
const SITE_WORDS = Object.freeze({ data: "data archive", relic: "relic archive" });
const MAX_REGION_NAME = 64;

const isStage = (v) => Number.isSafeInteger(v) && v >= 1 && v <= MAX_STAGE_WORDS;

function buildLorePrompt(o) {
  const bad = { ok: false, reason: "INVALID_INPUT" };
  if (!o || typeof o !== "object") return bad;
  const theme = THEME_WORDS[o.theme];
  const site = SITE_WORDS[o.analyzer];
  const lang = o.language === "pl" ? "pl" : (o.language === "en" ? "en" : null);
  if (!theme || !site || !lang || !isStage(o.stageNo) || !isStage(o.stageCount) || o.stageNo > o.stageCount
    || !Number.isSafeInteger(o.maxLoreChars) || o.maxLoreChars < LORE_MIN_CHARS) return bad;
  const w = WORDS[lang];
  const region = typeof o.regionName === "string" && o.regionName.trim() !== ""
    ? o.regionName.trim().slice(0, MAX_REGION_NAME) : "unknown";
  const system = `You write short lore fragments of EVE Online about ${theme.subject}. Answer with 1-3 sentences in `
    + `one line, at most ${o.maxLoreChars} characters. No digits, no character names, no addresses or links, no `
    + "brackets, no instructions, no lists."
    + (lang === "pl" ? " Write in Polish." : "");
  const user = `Theme: ${theme.adjective}. Fragment: ${w.ordinal[o.stageNo - 1]} ${w.of} ${w.count[o.stageCount - 1]}. `
    + `Region: ${region}. Site: ${site}.`;
  return { ok: true, messages: [{ role: "system", content: system }, { role: "user", content: user }] };
}

function filterLore(line, o) {
  if (typeof line !== "string") return { ok: false, reason: "EMPTY" };
  const text = (line.split(/\r?\n/).map((x) => x.trim()).find((x) => x !== "") || "");
  if (text === "") return { ok: false, reason: "EMPTY" };
  const max = o && Number.isSafeInteger(o.maxLoreChars) ? o.maxLoreChars : 0;
  if (text.length < LORE_MIN_CHARS || text.length > max) return { ok: false, reason: "LENGTH" };
  if (/\d/.test(text)) return { ok: false, reason: "DIGITS" };
  if (/https?:|www\./i.test(text)) return { ok: false, reason: "URL" };
  if (/[<>{}[\]`|*_#]/.test(text)) return { ok: false, reason: "MARKUP" };
  return { ok: true, text };
}

function loreReasonOf(reason) {
  if (typeof reason !== "string") return "OTHER";
  if (reason.startsWith("REJECTED_")) return "FILTER";
  return LORE_REASONS.includes(reason) ? reason : "OTHER";
}

module.exports = { LORE_MIN_CHARS, LORE_REASONS, buildLorePrompt, filterLore, loreReasonOf };
