"use strict";

const { ALPHABETS, EXTENDED_ALPHABETS } = require("./data/glyphs");

const SEPARATOR = " ";

function glyphLine(rng, alphabet, G) {
  const signs = typeof alphabet === "string" ? Array.from(alphabet) : (Array.isArray(alphabet) ? alphabet : []);
  if (signs.length === 0 || !G) return null;
  const ok = (a, b) => Number.isSafeInteger(a) && Number.isSafeInteger(b) && a >= 1 && a <= b;
  if (!ok(G.minWords, G.maxWords) || !ok(G.minWordLen, G.maxWordLen)) return null;
  const words = [];
  const n = rng.nextInt(G.minWords, G.maxWords);
  for (let w = 0; w < n; w += 1) {
    const len = rng.nextInt(G.minWordLen, G.maxWordLen);
    let word = "";
    for (let i = 0; i < len; i += 1) word += signs[rng.nextInt(0, signs.length - 1)];
    words.push(word);
  }
  return words.join(SEPARATOR);
}

function alphabetOf(voice, extended) {
  const table = extended === true ? EXTENDED_ALPHABETS : ALPHABETS;
  return Object.prototype.hasOwnProperty.call(table, voice) ? table[voice] : null;
}

module.exports = { glyphLine, alphabetOf };
