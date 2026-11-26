"use strict";

const { THEMES, TEXTS, LORE } = require("./data/themes");
const { deterministicUnit } = require("../util/rng");

const MAX_LINE = 400;
const ELLIPSIS = "...";
const PLACEHOLDERS = Object.freeze(["theme", "n", "N", "system", "region", "hostile", "r", "deadline", "kind",
  "state", "lore", "closes"]);
const PLACEHOLDER_RE = /\{([A-Za-z]+)\}/g;

const textsOf = (language) => TEXTS[language === "pl" ? "pl" : "en"];
const langOf = (language) => (language === "pl" ? "pl" : "en");
const pad = (n) => String(n).padStart(2, "0");

function cut(text, max) {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - ELLIPSIS.length))}${ELLIPSIS}`;
}

function fill(template, values) {
  return template.replace(PLACEHOLDER_RE, (all, name) => (PLACEHOLDERS.includes(name)
    && Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : all));
}

function formatUtc(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:`
    + pad(d.getUTCMinutes());
}

function themeName(theme, language) {
  const t = THEMES[theme];
  return t ? t.adjective[langOf(language)] : String(theme);
}

const nameOr = (name, id) => (typeof name === "string" && name !== "" ? name : String(id));

function startLine(spec) {
  return cut(fill(textsOf(spec.language).start, { theme: themeName(spec.theme, spec.language) }), MAX_LINE);
}

function hintLine(spec) {
  const t = textsOf(spec.language);
  if (spec.kind === "WH") {
    return cut(fill(t.hintWh, { theme: themeName(spec.theme, spec.language), n: spec.stageNo, N: spec.stageCount,
      system: nameOr(spec.entrySystemName, spec.entrySystemId), region: nameOr(spec.regionName, spec.regionId),
      closes: formatUtc(spec.closesAt), deadline: formatUtc(spec.deadlineAt) }), MAX_LINE);
  }
  return cut(fill(t.hint, { theme: themeName(spec.theme, spec.language), n: spec.stageNo, N: spec.stageCount,
    system: nameOr(spec.systemName, spec.systemId), region: nameOr(spec.regionName, spec.regionId),
    hostile: spec.hostile ? t.hostile : "", r: spec.radiusJumps, deadline: formatUtc(spec.deadlineAt) }), MAX_LINE);
}

function relicReply(spec) {
  const t = textsOf(spec.language);
  const max = Number.isSafeInteger(spec.max) && spec.max > 0 ? spec.max : MAX_LINE;
  if (!spec.full) return cut(fill(t.replyShort, { n: spec.stageNo, N: spec.stageCount }), max);
  return cut(fill(t.reply, { theme: themeName(spec.theme, spec.language), n: spec.stageNo, N: spec.stageCount,
    system: nameOr(spec.systemName, spec.systemId), region: nameOr(spec.regionName, spec.regionId),
    kind: t.kind[spec.stageKind] || String(spec.stageKind), state: t.state[spec.stageState] || String(spec.stageState),
    deadline: formatUtc(spec.deadlineAt) }), max);
}

function loreOf(spec) {
  const byTheme = LORE[spec.theme];
  const list = byTheme ? byTheme[langOf(spec.language)] : null;
  if (!Array.isArray(list) || list.length === 0) return null;
  const used = [...(spec.usedTexts || [])].filter((t) => typeof t === "string");
  const isUsed = (text) => used.some((t) => t === text || t.endsWith(`: ${text}`));
  const start = Math.floor(deterministicUnit(spec.seed, "lore", spec.stageNo) * list.length) % list.length;
  for (let i = 0; i < list.length; i += 1) {
    const text = list[(start + i) % list.length];
    if (!isUsed(text)) return text;
  }
  return list[start];
}

function loreLine(spec) {
  return cut(fill(textsOf(spec.language).lore, { theme: themeName(spec.theme, spec.language), n: spec.stageNo,
    N: spec.stageCount, lore: spec.lore }), MAX_LINE);
}

function foundLine(spec) {
  return cut(textsOf(spec.language).found, MAX_LINE);
}

function endLine(spec) {
  return cut(fill(textsOf(spec.language).end, { theme: themeName(spec.theme, spec.language), N: spec.stageCount }),
    MAX_LINE);
}

function stolenHintLine(spec) {
  return cut(`${textsOf(spec.language).stolen}${hintLine(spec)}`, MAX_LINE);
}

function stolenEndLine(spec) {
  return cut(fill(textsOf(spec.language).stolenEnd, { theme: themeName(spec.theme, spec.language) }), MAX_LINE);
}

function whClosedHintLine(spec) {
  return cut(`${textsOf(spec.language).whClosed}${hintLine(spec)}`, MAX_LINE);
}

module.exports = { MAX_LINE, PLACEHOLDERS, formatUtc, startLine, hintLine, relicReply, textsOf, cut, loreOf, loreLine,
  foundLine, endLine, stolenHintLine, stolenEndLine, whClosedHintLine };
