"use strict";

const SLOW_MARK = ": slow ";
const BOOT_LINE = /slow tx population\.(?:seed|load)\b/u;
const TIMESTAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})\s/u;

function decodeLog(buf) {
  if (typeof buf === "string") return buf;
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return b.toString("utf16le", 2);
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return b.toString("utf8", 3);
  return b.toString("utf8");
}

function timestampOf(line) {
  const m = TIMESTAMP.exec(line);
  if (!m) return null;
  const ms = (m[2] || "").padEnd(3, "0").slice(0, 3);
  const t = Date.parse(`${m[1]}.${ms}${m[3]}`);
  return Number.isFinite(t) ? t : null;
}

function scanSlowLines(text, opts) {
  const out = { steady: [], warmup: [], boot: [] };
  const end = opts && Number.isFinite(opts.warmupEndsAtMs) ? opts.warmupEndsAtMs : -Infinity;
  for (const raw of String(text || "").split(/\r?\n/u)) {
    const line = raw.trimEnd();
    if (!line.includes(SLOW_MARK) || !line.includes("population")) continue;
    if (BOOT_LINE.test(line)) {
      out.boot.push(line);
      continue;
    }
    const t = timestampOf(line);
    if (t !== null && t < end) out.warmup.push(line);
    else out.steady.push(line);
  }
  return out;
}

module.exports = { decodeLog, scanSlowLines, timestampOf };
