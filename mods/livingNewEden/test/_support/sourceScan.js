"use strict";

const OPEN = Object.freeze({ "{": "}", "(": ")", "[": "]" });
const CLOSE = new Set(["}", ")", "]"]);
const REGEX_BEFORE = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<",
  ">", "~", "^"]);
const REGEX_KEYWORDS = /(?:^|[^\w$])(?:return|typeof|case|in|of|void|delete|throw|new)$/;
const SPECIAL = /[/"'`{}]/g;
const SPACE = /\s/;

function applyBlanks(text, ranges) {
  if (ranges.length === 0) return text;
  const parts = [];
  let at = 0;
  for (const [s, e] of ranges) {
    if (e <= s) continue;
    parts.push(text.slice(at, s), text.slice(s, e).replace(/[^\n\r]/g, " "));
    at = e;
  }
  parts.push(text.slice(at));
  return parts.join("");
}

function mask(text, opts) {
  const strings = Boolean(opts && opts.strings);
  const n = text.length;
  const blanks = [];
  const comments = [];
  const content = (s, e) => { if (strings && e > s) blanks.push([s, e]); };
  const prevSignificant = (at) => {
    let i = at - 1;
    let k = comments.length - 1;
    for (;;) {
      while (i >= 0 && SPACE.test(text[i])) i -= 1;
      while (k >= 0 && comments[k][1] > i + 1) k -= 1;
      if (k >= 0 && i >= 0 && comments[k][1] === i + 1) { i = comments[k][0] - 1; k -= 1; continue; }
      return i;
    }
  };
  const tpl = [];
  const templateBody = (from) => {
    let i = from;
    while (i < n && text[i] !== "`") {
      if (text[i] === "\\") i += 2;
      else if (text[i] === "$" && text[i + 1] === "{") { content(from, i); tpl.push(0); return i + 2; }
      else i += 1;
    }
    content(from, Math.min(i, n));
    return i + 1;
  };
  let i = 0;
  while (i < n) {
    SPECIAL.lastIndex = i;
    const m = SPECIAL.exec(text);
    if (!m) break;
    i = m.index;
    const c = text[i];
    const d = text[i + 1];
    if (c === "/" && d === "/") {
      let e = text.indexOf("\n", i);
      if (e < 0) e = n;
      blanks.push([i, e]);
      comments.push([i, e]);
      i = e;
      continue;
    }
    if (c === "/" && d === "*") {
      const end = text.indexOf("*/", i + 2);
      const e = end < 0 ? n : end + 2;
      blanks.push([i, e]);
      comments.push([i, e]);
      i = e;
      continue;
    }
    if (c === "\"" || c === "'") {
      let j = i + 1;
      while (j < n && text[j] !== c && text[j] !== "\n") j += text[j] === "\\" ? 2 : 1;
      content(i + 1, Math.min(j, n));
      i = j + 1;
      continue;
    }
    if (c === "`") { i = templateBody(i + 1); continue; }
    if (c === "}" && tpl.length > 0 && tpl[tpl.length - 1] === 0) { tpl.pop(); i = templateBody(i + 1); continue; }
    if (c === "/") {
      const p = prevSignificant(i);
      const word = p < 0 ? "" : text.slice(Math.max(0, p - 8), p + 1);
      if (p < 0 || REGEX_BEFORE.has(text[p]) || REGEX_KEYWORDS.test(word)) {
        let j = i + 1;
        let inClass = false;
        while (j < n && text[j] !== "\n") {
          if (text[j] === "\\") { j += 2; continue; }
          if (text[j] === "[") inClass = true;
          else if (text[j] === "]") inClass = false;
          else if (text[j] === "/" && !inClass) break;
          j += 1;
        }
        content(i + 1, Math.min(j, n));
        i = j + 1;
        continue;
      }
    }
    if (tpl.length > 0) {
      if (c === "{") tpl[tpl.length - 1] += 1;
      else if (c === "}") tpl[tpl.length - 1] -= 1;
    }
    i += 1;
  }
  return applyBlanks(text, blanks);
}

function matchClose(masked, openAt) {
  const stack = [];
  for (let i = openAt; i < masked.length; i += 1) {
    const c = masked[i];
    if (OPEN[c]) stack.push(OPEN[c]);
    else if (CLOSE.has(c)) {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

function topLevelSegments(masked, openAt) {
  const closeAt = matchClose(masked, openAt);
  if (closeAt < 0) return null;
  const segs = [];
  let depth = 0;
  let start = openAt + 1;
  for (let i = openAt + 1; i < closeAt; i += 1) {
    const c = masked[i];
    if (OPEN[c]) depth += 1;
    else if (CLOSE.has(c)) depth -= 1;
    else if (c === "," && depth === 0) { segs.push({ start, end: i }); start = i + 1; }
  }
  segs.push({ start, end: closeAt });
  return segs.filter((s) => masked.slice(s.start, s.end).trim() !== "");
}

const KEY_RE = /^\s*(?:async\s+|get\s+|set\s+)?(?:([A-Za-z_$][\w$]*)|"([^"]*)"|'([^']*)')\s*(:|\(|$)/;

function topLevelKeys(text, masked, openAt) {
  const segs = topLevelSegments(masked, openAt);
  if (!segs) return null;
  const keys = [];
  let spread = false;
  let computed = false;
  for (const s of segs) {
    const m = masked.slice(s.start, s.end);
    if (/^\s*\.\.\./.test(m)) { spread = true; continue; }
    if (/^\s*\[/.test(m)) { computed = true; continue; }
    const k = KEY_RE.exec(text.slice(s.start, s.end));
    if (k) keys.push(k[1] || k[2] || k[3]);
    else computed = true;
  }
  return { keys, spread, computed };
}

function lineOf(text, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i += 1) if (text[i] === "\n") line += 1;
  return line;
}

module.exports = { mask, matchClose, topLevelSegments, topLevelKeys, lineOf };
