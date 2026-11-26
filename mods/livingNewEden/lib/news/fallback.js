"use strict";

const { MS_PER_HOUR, LANGUAGES } = require("./schema");
const { KIND_DATA, HULL_LABELS, UNKNOWN } = require("./data/kinds");

const PLACEHOLDER_RE = /\{(system|region|a|b|hull|n|m)\}/g;
const ELLIPSIS = "...";
const DEFAULT_MAX_TITLE = 100;
const TEXT = Object.freeze({
  en: Object.freeze({ name: "Scope News", quiet: "a quiet cycle",
    intro: (seq, day, from, to) => `Scope News #${seq}, ${day}: the events of ${from}–${to} UTC.`,
    none: "No major event was reported in this period." }),
  pl: Object.freeze({ name: "Scope News", quiet: "spokojny okres",
    intro: (seq, day, from, to) => `Scope News #${seq}, ${day}: wydarzenia z okresu ${from}–${to} UTC.`,
    none: "W tym okresie nie odnotowano ważnych wydarzeń." }),
});

function clean(v) {
  return typeof v === "string" ? v.replace(/[{}]/g, "").replace(/\s+/g, " ").trim() : "";
}

function cut(text, max) {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - ELLIPSIS.length))}${ELLIPSIS}`;
}

function hhmm(at) {
  return new Date(at).toISOString().slice(11, 16);
}

function sentenceOf(fact, lang) {
  const k = KIND_DATA[fact.kind];
  const d = fact.data || {};
  const hull = HULL_LABELS[d.hullClass] ? HULL_LABELS[d.hullClass][lang] : "";
  const values = { system: clean(d.systemName), region: clean(d.regionName), a: clean(d.factionA),
    b: clean(d.factionB), hull, n: Number.isSafeInteger(d.destroyed) ? String(d.destroyed) : "",
    m: Number.isSafeInteger(d.lost) ? String(d.lost) : "" };
  const template = k ? k.template[lang] : "{system} ({region}).";
  return template.replace(PLACEHOLDER_RE, (_m, name) => values[name] || UNKNOWN[name][lang]);
}

function renderFallback(selected, opts) {
  const lang = LANGUAGES.includes(opts.language) ? opts.language : "en";
  const t = TEXT[lang];
  const max = Number.isSafeInteger(opts.maxTitleChars) && opts.maxTitleChars > 0 ? opts.maxTitleChars
    : DEFAULT_MAX_TITLE;
  const facts = Array.isArray(selected) ? selected : [];
  const to = opts.boundaryAt;
  const from = to - opts.cycleHours * MS_PER_HOUR;
  const intro = t.intro(opts.seq, new Date(to).toISOString().slice(0, 10), hhmm(from), hhmm(to));
  let title;
  if (facts.length === 0) title = `${t.name}: ${t.quiet}`;
  else {
    const top = facts[0];
    const k = KIND_DATA[top.kind];
    const label = k ? k.label[lang] : t.name;
    const place = clean(top.data && top.data.systemName);
    const who = clean(top.data && top.data.factionA);
    title = place ? `${label}: ${place}` : (who ? `${label}: ${who}` : label);
  }
  const paragraphs = [intro, ...(facts.length === 0 ? [t.none] : facts.map((f) => sentenceOf(f, lang)))];
  return { title: cut(title, max), paragraphs };
}

module.exports = { renderFallback, sentenceOf };
