"use strict";

const fs = require("node:fs");
const { diffDigests } = require("./digest");

const DIFF_MAX = 64;

function tablesOf(file) {
  try {
    const report = JSON.parse(fs.readFileSync(file, "utf8"));
    const tables = report && report.digest && report.digest.semanticTables;
    if (!tables || typeof tables !== "object") return { ok: false, reason: "NO_SEMANTIC_TABLES", detail: file };
    return { ok: true, tables };
  } catch (err) {
    return { ok: false, reason: "REPORT_UNREADABLE", detail: `${file}: ${String((err && err.message) || err)}` };
  }
}

function diffReports(fileA, fileB) {
  const a = tablesOf(fileA);
  if (!a.ok) return a;
  const b = tablesOf(fileB);
  if (!b.ok) return b;
  const diff = diffDigests({ tables: a.tables }, { tables: b.tables }, DIFF_MAX);
  const rows = diff.map((entry) => {
    const name = entry.replace(/\(.*$/, "");
    const ra = a.tables[name] ? a.tables[name].rows : null;
    const rb = b.tables[name] ? b.tables[name].rows : null;
    return { name, a: ra, b: rb, delta: ra !== null && rb !== null ? rb - ra : null };
  });
  return { ok: true, diff, rows };
}

function main() {
  const [fileA, fileB] = process.argv.slice(2);
  if (!fileA || !fileB) {
    process.stdout.write("usage: digestDiff.js <a.json> <b.json>\n");
    process.exitCode = 1;
    return;
  }
  const r = diffReports(fileA, fileB);
  if (!r.ok) {
    process.stdout.write(`digestDiff: FAIL ${r.reason} ${r.detail}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`digestDiff: ${r.diff.length} table(s) differ${r.diff.length >= DIFF_MAX ? " (cut)" : ""}\n`);
  for (const row of r.rows) {
    process.stdout.write(`  ${row.name}: rows ${row.a === null ? "-" : row.a} -> ${row.b === null ? "-" : row.b}`
      + `${row.delta === null ? "" : ` (${row.delta >= 0 ? "+" : ""}${row.delta})`}\n`);
  }
}

if (require.main === module) main();

module.exports = { diffReports };
