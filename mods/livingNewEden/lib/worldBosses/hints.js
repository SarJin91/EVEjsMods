"use strict";

const MAX_LINES = 3;
const MAX_CHARS = 160;
const ASCII_RE = /^[\x20-\x7E]+$/;
const DIGIT_RUN_RE = /\d{6,}/;

function clean(text) {
  return typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
}

function hintLinesOf(openRows, regionName, kinds) {
  const lines = [];
  const seen = new Set();
  for (const row of Array.isArray(openRows) ? openRows : []) {
    if (lines.length >= MAX_LINES) break;
    if (!row || typeof row.kind !== "string") continue;
    const entry = kinds && typeof kinds.get === "function" ? kinds.get(row.kind) : null;
    const label = clean(entry && entry.label);
    let region = "";
    try {
      region = clean(typeof regionName === "function" ? regionName(row.regionId) : null);
    } catch (_err) {
      region = "";
    }
    if (label === "" || region === "") continue;
    const line = `A ${label} roams ${region}.`;
    if (line.length > MAX_CHARS || !ASCII_RE.test(line) || DIGIT_RUN_RE.test(line) || seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  return lines;
}

module.exports = { hintLinesOf, MAX_LINES };
