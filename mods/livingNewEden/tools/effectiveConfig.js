"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { SCHEMA, MODULE_NAMES, resolveConfig } = require("../config");
const { buildDefaultServiceDefs } = require("../lib/runtime/services");
const { describeConfig } = require("../lib/observer/effectiveConfig");
const { parseComposeEnv } = require("./liveSim/compose");

const MOD_DIR = path.resolve(__dirname, "..");
const DEFAULT_COMPOSE = path.resolve(MOD_DIR, "..", "..", "compose.yaml");
const ORIGIN_CHARS = 0;

function buildReport(text) {
  const parsed = parseComposeEnv(String(text).replace(/^\u{FEFF}/u, ""));
  if (!parsed.ok) return { ok: false, reason: parsed.reason, detail: parsed.detail };
  const resolved = resolveConfig({ env: parsed.values, settings: {}, envFile: {}, modDir: MOD_DIR });
  const described = describeConfig({
    schema: SCHEMA, config: resolved.config, sources: resolved.sources, warnings: resolved.warnings,
    errors: resolved.errors, services: null, serviceNames: buildDefaultServiceDefs().map((d) => d.name),
    moduleNames: MODULE_NAMES, originChars: ORIGIN_CHARS,
  });
  const composeKeys = Object.keys(parsed.values).length;
  return { ok: true, service: parsed.service, composeKeys, emptyDefaults: parsed.keys - composeKeys,
    names: parsed.entries.map((e) => e.name), ...described };
}

function shown(v) {
  return v === null || v === undefined ? "-" : String(v);
}

function renderText(report, file) {
  if (!report.ok) return `effectiveConfig: compose refused - ${report.detail}`;
  const lines = [];
  const s = report.summary;
  lines.push(`effective config of ${path.basename(file)}: ${report.composeKeys} EVEJS_LNE_* keys resolved `
    + `(service ${report.service}, ${report.emptyDefaults} empty defaults)`);
  lines.push(`flags ${s.flags}: on ${s.on}, off ${s.off}, shadowed ${s.shadowed}, unknown ${s.unknown} `
    + `(unknown = flag of a service, no live registry); differs ${s.differs}, pinned ${s.pinned}, masked ${s.masked}`);
  lines.push("");
  lines.push("| flag | value | default | source | mark | state | by |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const f of report.flags) {
    const mark = f.differs ? "DIFFERS" : (f.pinned ? "pinned" : "");
    lines.push(`| ${f.key} | ${shown(f.value)} | ${shown(f.default)} | ${f.source} | ${mark} | ${f.state} | ${shown(f.by)} |`);
  }
  lines.push("");
  lines.push(`overrides (non-flag keys set by compose): ${report.overrides.length}`);
  for (const o of report.overrides) {
    lines.push(`- ${o.key} = ${shown(o.value)} (default ${shown(o.default)})${o.differs ? "" : " pinned"}`);
  }
  lines.push("");
  lines.push(`warnings: ${report.warnings.length}`);
  for (const w of report.warnings) lines.push(`- ${w}`);
  if (report.errors.length) {
    lines.push(`errors: ${report.errors.length}`);
    for (const e of report.errors) lines.push(`- ${e}`);
  }
  return lines.join("\n");
}

function main(io) {
  const argv = io.argv || [];
  const out = typeof io.out === "function" ? io.out : (t) => process.stdout.write(`${t}\n`);
  const readFile = typeof io.readFile === "function" ? io.readFile : (f) => fs.readFileSync(f, "utf8");
  const at = argv.indexOf("--compose");
  const file = at >= 0 && argv[at + 1] ? path.resolve(argv[at + 1]) : DEFAULT_COMPOSE;
  let text;
  try {
    text = readFile(file);
  } catch (err) {
    out(`effectiveConfig: cannot read ${path.basename(file)} - ${(err && err.code) || "ERROR"}`);
    return 0;
  }
  const report = buildReport(text);
  out(argv.includes("--json") ? JSON.stringify(report, null, 2) : renderText(report, file));
  return 0;
}

if (require.main === module) process.exitCode = main({ argv: process.argv.slice(2) });

module.exports = { DEFAULT_COMPOSE, buildReport, main };
