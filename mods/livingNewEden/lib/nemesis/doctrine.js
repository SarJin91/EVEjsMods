"use strict";

const { createRng, deriveSeed } = require("../util/rng");
const { ESCORT_CLASSES } = require("../bounty/data/levels");
const { RNG_STREAM_DOCTRINE } = require("./schema");

const NOT_ADAPTED = Object.freeze({ adapted: false, dominant: null, escorts: Object.freeze([]), ewarFamily: null });

function dominantOf(profile, table) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) return null;
  let best = null;
  for (const cls of Object.keys(profile).sort()) {
    const n = profile[cls];
    if (!Number.isSafeInteger(n) || n <= 0 || !Object.hasOwn(table, cls)) continue;
    if (best === null || n > profile[best]) best = cls;
  }
  return best;
}

function topClassOf(level, ladder) {
  const classes = ESCORT_CLASSES[level];
  if (!Array.isArray(classes)) return null;
  let top = -1;
  for (const c of classes) top = Math.max(top, ladder.indexOf(c));
  return top >= 0 ? ladder[top] : null;
}

function doctrineOf(input, data, params) {
  const { profile, hunterLevel, rank, seed, escortCount } = input || {};
  if (!data || !data.DOCTRINE || !Array.isArray(data.HULL_LADDER)) return NOT_ADAPTED;
  if (!Number.isSafeInteger(escortCount) || escortCount <= 0 || !Number.isSafeInteger(seed)) return NOT_ADAPTED;
  const dominant = dominantOf(profile, data.DOCTRINE);
  if (dominant === null) return NOT_ADAPTED;
  const row = data.DOCTRINE[dominant];
  const ladder = data.HULL_LADDER;
  const classes = Array.isArray(row.escortClasses) ? row.escortClasses.filter((c) => ladder.includes(c)) : [];
  const top = topClassOf(hunterLevel, ladder);
  if (classes.length === 0 || top === null) return NOT_ADAPTED;
  const cap = ladder.indexOf(top);
  const maxEwar = Number.isSafeInteger(params && params.maxEwarEscorts) ? params.maxEwarEscorts : 0;
  const ewarCount = Math.max(0, Math.min(maxEwar, Number.isSafeInteger(rank) ? rank : 1, escortCount));
  const family = typeof row.ewarFamily === "string" && row.ewarFamily !== "" ? row.ewarFamily : null;
  const escorts = [];
  for (let i = 0; i < escortCount; i += 1) {
    const rng = createRng(deriveSeed(seed >>> 0, RNG_STREAM_DOCTRINE, "class", i));
    const picked = classes[rng.nextInt(0, classes.length - 1)];
    const hullClass = ladder.indexOf(picked) > cap ? top : picked;
    escorts.push(Object.freeze({ hullClass, ewarFamily: family !== null && i < ewarCount ? family : null }));
  }
  return Object.freeze({ adapted: true, dominant, escorts: Object.freeze(escorts),
    ewarFamily: ewarCount > 0 ? family : null });
}

module.exports = { doctrineOf, dominantOf };
