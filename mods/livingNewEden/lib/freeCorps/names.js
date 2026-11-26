"use strict";

const { createRng, deriveSeed } = require("../util/rng");
const { PREFIXES, NOUNS, SUFFIXES } = require("./data/nameParts");

const TICKER_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const TICKER_MAX_BASE = 4;
const TICKER_MIN_BASE = 3;
const TICKER_TAIL = 2;
const TICKER_PAD = "X";
const PATTERN_WITH_NOUN = 2;

function nameKey(name) {
  return String(name).trim().toLowerCase();
}

function tickerBase(words) {
  let base = words.map((w) => w.charAt(0).toUpperCase()).join("").slice(0, TICKER_MAX_BASE);
  const first = words[0].toUpperCase();
  for (let i = 1; base.length < TICKER_MIN_BASE && i < first.length; i += 1) base += first.charAt(i);
  while (base.length < TICKER_MIN_BASE) base += TICKER_PAD;
  return base;
}

function generateName(p) {
  const rng = createRng(deriveSeed(p.worldSeed, "fcname", p.corpId, p.attempt));
  const suffixes = SUFFIXES[p.archetype] || SUFFIXES.miner;
  const pattern = rng.nextInt(0, PATTERN_WITH_NOUN);
  const parts = [rng.pick(PREFIXES)];
  if (pattern === PATTERN_WITH_NOUN) parts.push(rng.pick(NOUNS));
  parts.push(rng.pick(suffixes));
  const name = parts.join(" ");
  const base = tickerBase(name.split(" "));
  if (p.attempt === 0) return { name, ticker: base };
  let tail = "";
  for (let i = 0; i < TICKER_TAIL; i += 1) tail += TICKER_CHARS.charAt(rng.nextInt(0, TICKER_CHARS.length - 1));
  return { name, ticker: base.slice(0, TICKER_MIN_BASE) + tail };
}

module.exports = { generateName, nameKey };
