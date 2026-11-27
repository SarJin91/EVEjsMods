"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const REPO_DIR = path.resolve(MOD_DIR, "..", "..");
const CREDITS = path.join(MOD_DIR, "CREDITS.md");
const SCAN_DIRS = ["lib", "tools", "web"];

const COMMENT_RE = /^\s*(\/\/|\/?\*)/;
const PORT_RE = /\b(Port(ed)?|adapted from|Adaptation of)\b/i;
const EXTERNAL = ["X-Eve", "xEve", "Seeder", "EveJS", "EFS", "zKillboard", "Fuzzwork", "SDE"];
const EXTERNAL_RE = new RegExp(`\\b(${EXTERNAL.map((s) => s.replace(/-/g, "\\-")).join("|")})\\b`);
const LINE_REF_RE = /([A-Za-z0-9_./-]*[A-Za-z0-9_-]+\.js):\d+/g;
const INTERNAL_PORT_ALLOW = Object.freeze([]);
const VENDOR_PATHS = Object.freeze([
  "tools/DatabaseCreator/setupInputs/seeds/npcProfiles.json",
  "tools/DatabaseCreator/setupInputs/overrides/capitalNpcs.json",
]);
const CREDITS_PATH_RE = /(?<![A-Za-z0-9_./-])(lib|tools|web|data|test)\/[A-Za-z0-9_./*-]+\.(js|json)\b/g;

function jsFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) jsFiles(p, out);
    else if (e.isFile() && e.name.endsWith(".js")) out.push(p);
  }
  return out;
}

function isModFile(ref, fromFile) {
  return [MOD_DIR, path.dirname(fromFile)].some((base) => fs.existsSync(path.resolve(base, ref)));
}

function namesExternal(line, fromFile) {
  if (EXTERNAL_RE.test(line)) return true;
  for (const m of line.matchAll(LINE_REF_RE)) {
    if (!isModFile(m[1], fromFile)) return true;
  }
  return false;
}

function isExternalPort(file) {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    if (!COMMENT_RE.test(lines[i]) || !PORT_RE.test(lines[i])) continue;
    for (let j = i; j <= i + 2 && j < lines.length; j += 1) {
      if (namesExternal(lines[j], file)) return true;
    }
  }
  return false;
}

function mentions(text, rel) {
  const esc = rel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_./-])${esc}(?![A-Za-z0-9_/-])`).test(text);
}

function rel(file) {
  return path.relative(MOD_DIR, file).split(path.sep).join("/");
}

module.exports = ({ test }) => {
  test("CRD1 every external port marked in lib/tools/web is listed in CREDITS.md", () => {
    const credits = fs.readFileSync(CREDITS, "utf8");
    const ports = SCAN_DIRS.flatMap((d) => jsFiles(path.join(MOD_DIR, d))).filter(isExternalPort).map(rel);
    assert.ok(ports.length >= 10, `the scan must find the known ports, found ${ports.length}`);
    for (const known of ["lib/util/rng.js", "lib/scheduler/deadlineQueue.js", "lib/fleets/travel.js"]) {
      assert.ok(ports.includes(known), `the scan must find ${known}`);
    }
    const missing = ports.filter((p) => !INTERNAL_PORT_ALLOW.includes(p) && !mentions(credits, p));
    assert.deepStrictEqual(missing, [], `ports missing in CREDITS.md: ${missing.join(", ")}`);
  });

  test("CRD2 every mod path named in CREDITS.md exists", () => {
    const credits = fs.readFileSync(CREDITS, "utf8");
    const paths = [...new Set([...credits.matchAll(CREDITS_PATH_RE)].map((m) => m[0]))];
    assert.ok(paths.length >= 20, `the scan must find the CREDITS paths, found ${paths.length}`);
    const dead = paths.filter((p) => !p.includes("*")).filter((p) => VENDOR_PATHS.includes(p)
      ? !fs.existsSync(path.join(REPO_DIR, p))
      : !fs.existsSync(path.join(MOD_DIR, p)));
    assert.deepStrictEqual(dead, [], `CREDITS.md paths without a file: ${dead.join(", ")}`);
  });
};
