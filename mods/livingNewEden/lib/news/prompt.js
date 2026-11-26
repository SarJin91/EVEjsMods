"use strict";

const { MS_PER_HOUR, LANGUAGES } = require("./schema");
const { KIND_DATA } = require("./data/kinds");
const { sentenceOf } = require("./fallback");

const DIGITS_RE = /\d+/g;
const NAME_FIELDS = Object.freeze(["systemName", "regionName", "factionA", "factionB"]);
const DEFAULTS = Object.freeze({ minParagraphs: 2, maxParagraphs: 8, minBodyChars: 400, maxBodyChars: 3000,
  maxTitleChars: 100 });

function hhmm(at) {
  return new Date(at).toISOString().slice(11, 16);
}

function stamp(at) {
  return new Date(at).toISOString().slice(0, 16).replace("T", " ");
}

function intOr(v, fallback) {
  return Number.isSafeInteger(v) && v > 0 ? v : fallback;
}

function systemText(lang, o) {
  if (lang === "pl") {
    return [
      "Jesteś redaktorem serwisu informacyjnego Scope w New Eden, w grze science fiction w stylu EVE Online.",
      "Napisz jedno wydanie wiadomości po polsku wyłącznie z podanych faktów.",
      "Zasady: tylko podane fakty; żadnych nazw, liczb, dat, osób ani przyczyn spoza faktów; liczby przepisuj dokładnie;",
      "nazwy systemów, regionów i frakcji przepisuj dokładnie w podanej formie, bez odmiany; bez linków, bez Markdown,",
      "bez list; tylko litery, cyfry i zwykła interpunkcja (. , : ; ! ? ' \" ( ) - /).",
      `Pierwsza linia: "TYTUŁ: <nagłówek>" (najwyżej ${o.maxTitleChars} znaków).`,
      `Potem od ${o.minParagraphs} do ${o.maxParagraphs} akapitów oddzielonych jedną pustą linią, razem od`,
      `${o.minBodyChars} do ${o.maxBodyChars} znaków. Najpierw najważniejsze fakty (pierwsze na liście).`,
    ].join(" ");
  }
  return [
    "You are the editor of Scope, the news service of New Eden in a science fiction game in the style of EVE Online.",
    "Write one news edition in English from the given facts only.",
    "Rules: only the given facts; no names, numbers, dates, people or causes that are not in the facts; copy every",
    "number exactly; write the names of systems, regions and factions exactly as given; no links, no Markdown, no",
    "lists; plain letters, digits and basic punctuation only (. , : ; ! ? ' \" ( ) - /).",
    `The first line is "TITLE: <headline>" (at most ${o.maxTitleChars} characters).`,
    `Then ${o.minParagraphs} to ${o.maxParagraphs} paragraphs separated by one empty line, ${o.minBodyChars} to`,
    `${o.maxBodyChars} characters in total. The most important facts (first in the list) first.`,
  ].join(" ");
}

function factLineOf(fact, i, lang) {
  const k = KIND_DATA[fact.kind];
  const label = k ? k.label[lang] : String(fact.kind);
  const sentence = sentenceOf(fact, lang).replace(/\s*\|\s*/g, " ");
  return `F${i + 1} | ${label} | ${sentence} | ${hhmm(fact.at)} UTC`;
}

function numbersOf(text) {
  const out = new Set();
  for (const m of String(text).matchAll(DIGITS_RE)) {
    out.add(m[0]);
    out.add(String(Number(m[0])));
  }
  return out;
}

function namesOf(facts) {
  const out = new Set();
  for (const f of facts) {
    const d = (f && f.data) || {};
    for (const field of NAME_FIELDS) {
      const v = d[field];
      if (typeof v === "string" && v.trim() !== "") out.add(v.replace(/[{}]/g, "").replace(/\s+/g, " ").trim());
    }
  }
  return [...out].filter((n) => n !== "");
}

function buildNewsMessages(selected, opts) {
  const o = opts || {};
  const lang = LANGUAGES.includes(o.language) ? o.language : "en";
  const rules = { minParagraphs: intOr(o.minParagraphs, DEFAULTS.minParagraphs),
    maxParagraphs: intOr(o.maxParagraphs, DEFAULTS.maxParagraphs),
    minBodyChars: intOr(o.minBodyChars, DEFAULTS.minBodyChars), maxBodyChars: intOr(o.maxBodyChars, DEFAULTS.maxBodyChars),
    maxTitleChars: intOr(o.maxTitleChars, DEFAULTS.maxTitleChars) };
  const max = intOr(o.maxPromptChars, Infinity);
  const facts = Array.isArray(selected) ? selected.filter((f) => f && typeof f === "object") : [];
  const to = Number.isSafeInteger(o.boundaryAt) ? o.boundaryAt : 0;
  const from = to - intOr(o.cycleHours, 24) * MS_PER_HOUR;
  const header = `FACTS ${stamp(from)} - ${stamp(to)} UTC`;
  const lines = facts.map((f, i) => factLineOf(f, i, lang));
  let kept = lines.length;
  const userOf = (n) => [header, ...lines.slice(0, n)].join("\n");
  while (kept > 0 && userOf(kept).length > max) kept -= 1;
  const user = userOf(kept);
  const system = systemText(lang, rules);
  return { messages: [{ role: "system", content: system }, { role: "user", content: user }],
    factLines: lines.slice(0, kept), numbers: numbersOf(user), factNames: namesOf(facts.slice(0, kept)) };
}

module.exports = { buildNewsMessages };
