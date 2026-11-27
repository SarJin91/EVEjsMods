"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { SCHEMA, MODULE_NAMES } = require("../../config");
const { NO_INSTALL_ENV } = require("../../loader");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const README = path.join(MOD_DIR, "README.md");
const SECTIONS = ["## What you see with the default settings", "## Off by default", "## Modules", "## Configuration",
  "## Install notes", "## Operator tools", "## Backups", "## Chat commands", "## Known limits", "## Tests"];
const MODULES_SECTION = "## Modules";
const HEADER = ["Key", "Env", "Default", "When off"];
const PATH_RE = /(?:^|[\s`(])(?:\.\/)?(?:mods\/livingNewEden\/)?((?:tools|docs)\/[A-Za-z0-9_./-]+\.(?:js|md))/g;
const ENV_RE = /\bEVEJS_LNE_[A-Z0-9_]+(\*)?/g;

function readLines() {
  return fs.readFileSync(README, "utf8").split(/\r?\n/);
}

function unquote(cell) {
  const m = /^`([^`]*)`$/.exec(cell);
  return m ? m[1] : cell;
}

function readTable(section, header) {
  const lines = readLines();
  const start = lines.findIndex((l) => l.trim() === section);
  assert.ok(start >= 0, `README has no section "${section}"`);
  let end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  if (end < 0) end = lines.length;
  const table = [];
  let i = start + 1;
  while (i < end && !lines[i].startsWith("|")) i += 1;
  while (i < end && lines[i].startsWith("|")) {
    const cells = lines[i].trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
    table.push({ line: i + 1, cells });
    i += 1;
  }
  assert.ok(table.length >= 2, "the section has no table");
  assert.deepStrictEqual(table[0].cells, header, "table header");
  assert.ok(table[1].cells.every((c) => /^-{3,}$/.test(c)), "table separator row");
  return table.slice(2);
}

module.exports = ({ test }) => {
  test("DOC1 README has the user sections in order", () => {
    const lines = readLines().map((l) => l.trim());
    const at = SECTIONS.map((s) => lines.indexOf(s));
    assert.deepStrictEqual(SECTIONS.filter((s, i) => at[i] < 0), [], "missing sections");
    assert.deepStrictEqual(at, [...at].sort((a, b) => a - b), "section order");
  });

  test("DOC2 README module table: every modules.<name>.enabled in order, env and default as in SCHEMA", () => {
    const byKey = new Map(SCHEMA.map((row) => [row.key, row]));
    const rows = readTable(MODULES_SECTION, HEADER);
    assert.deepStrictEqual(rows.map((r) => unquote(r.cells[0] || "")), MODULE_NAMES.map((n) => `modules.${n}.enabled`));
    const problems = [];
    for (const { line, cells } of rows) {
      const key = unquote(cells[0]);
      const row = byKey.get(key);
      if (cells.length !== HEADER.length) { problems.push(`:${line} ${cells.length} cells`); continue; }
      if (!row) { problems.push(`:${line} ${key} not in SCHEMA`); continue; }
      if (unquote(cells[1]) !== row.env) problems.push(`:${line} ${key} env ${cells[1]} != ${row.env}`);
      if (unquote(cells[2]) !== String(row.default)) problems.push(`:${line} ${key} default ${cells[2]} != ${row.default}`);
      if (!cells[3]) problems.push(`:${line} ${key} empty effect`);
    }
    assert.deepStrictEqual(problems, []);
  });

  test("DOC3 README: every tools/ and docs/ path it names exists in the mod", () => {
    const text = fs.readFileSync(README, "utf8");
    const paths = [...new Set([...text.matchAll(PATH_RE)].map((m) => m[1]))];
    assert.ok(paths.length >= 8, `the scan must find the README paths, found ${paths.length}`);
    const dead = paths.filter((p) => !fs.existsSync(path.join(MOD_DIR, p)));
    assert.deepStrictEqual(dead, [], `README paths without a file: ${dead.join(", ")}`);
  });

  test("DOC4 README: every EVEJS_LNE_* variable it names is a SCHEMA env (a trailing * is a prefix)", () => {
    const envs = new Set(SCHEMA.map((row) => row.env).filter(Boolean));
    envs.add(NO_INSTALL_ENV);
    const text = fs.readFileSync(README, "utf8");
    const unknown = [];
    for (const m of text.matchAll(ENV_RE)) {
      const name = m[0].replace(/\*$/, "");
      const ok = m[1] ? [...envs].some((e) => e.startsWith(name)) : envs.has(name);
      if (!ok) unknown.push(m[0]);
    }
    assert.deepStrictEqual([...new Set(unknown)], []);
  });

  test("DOC5 README: the status page address uses the observer port default", () => {
    const port = SCHEMA.find((row) => row.key === "observer.port");
    assert.ok(port, "observer.port in SCHEMA");
    assert.ok(fs.readFileSync(README, "utf8").includes(`http://127.0.0.1:${port.default}/`));
  });
};
