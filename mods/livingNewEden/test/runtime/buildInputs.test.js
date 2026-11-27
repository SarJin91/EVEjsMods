"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { readBuildInputsFrom, MANIFEST_SCHEMA } = require("../../lib/adapter/buildInputs");
const { evaluateBuildInputs, formatBuildInputsLine } = require("../../lib/runtime/buildInputsCheck");
const { GAME_MODULES } = require("../../lib/adapter/gameModules");
const { createAdapter } = require("../../lib/adapter");
const { buildStatusView } = require("../../lib/observer/builtinViews");

const SHA = "0".repeat(64);
const PACKS = Array.from({ length: 29 }, (_, i) => `content-packs/evejs-pack-${String(i).padStart(2, "0")}-1.0.0.json`);

function appRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lne-bi-"));
}

function put(root, rel, text) {
  const abs = path.join(root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
}

function manifestOf(paths, extra = {}) {
  return { schema: MANIFEST_SCHEMA, generatedAt: "2026-11-15T12:00:00.000Z", contextCommit: "17c7c1d8".padEnd(40, "0"),
    contextKind: "worktree", guardedRoots: ["config", "content-packs", "tools/DatabaseCreator"],
    files: paths.map((p) => ({ path: p, size: 2, sha256: SHA })), ...extra };
}

const registry = { readRegistry: () => ({ installed: [{ id: "evejs-pack-00", version: "1.0.0" }] }) };

function read(root, maxFiles = 20000) {
  return readBuildInputsFrom({ dropDirectory: path.join(root, "content-packs"), contentPackManager: registry, fs,
    maxFiles });
}

module.exports = ({ test }) => {
  test("BI1 build inputs: ok, 19 missing packs, no manifest (required or not), MANIFEST_SCHEMA", () => {
    const root = appRoot();
    try {
      const all = [...PACKS, "config/world.json", "tools/DatabaseCreator/staticTables/a/data.json"];
      for (const p of all) put(root, p, "{}");
      put(root, "docker/build-inputs.json", JSON.stringify(manifestOf(all)));
      const ok = evaluateBuildInputs({ read: read(root), requireManifest: true, listLimit: 10 });
      assert.deepStrictEqual([ok.state, ok.degraded, ok.missing, ok.packs],
        ["ok", false, 0, { expectedFiles: 29, presentFiles: 29, active: 1 }]);
      assert.match(formatBuildInputsLine(ok, { requireManifest: true }),
        /^buildInputs: ok - 31 files match docker\/build-inputs\.json \(commit 17c7c1d, content packs 29\/29, active 1\)$/);

      for (const p of PACKS.slice(10)) fs.rmSync(path.join(root, ...p.split("/")));
      const miss = evaluateBuildInputs({ read: read(root), requireManifest: false, listLimit: 3 });
      assert.deepStrictEqual([miss.state, miss.degraded, miss.missing, miss.first.length], ["missing", true, 19, 3]);
      assert.deepStrictEqual(miss.byRoot["content-packs"], { expected: 29, missing: 19 });
      assert.deepStrictEqual(miss.byRoot.config, { expected: 1, missing: 0 });
      const line = formatBuildInputsLine(miss, { requireManifest: false });
      assert.ok(line.startsWith("buildInputs: ERROR 19 file(s) missing from the image (content-packs 10/29)"), line);
      assert.ok(line.includes("rebuild with tools/deploy"), line);

      fs.rmSync(path.join(root, "docker", "build-inputs.json"));
      const req = evaluateBuildInputs({ read: read(root), requireManifest: true, listLimit: 10 });
      assert.deepStrictEqual([req.state, req.reason, req.degraded], ["unverified", "MANIFEST_MISSING", true]);
      assert.ok(formatBuildInputsLine(req, { requireManifest: true }).startsWith("buildInputs: ERROR no build manifest"));
      const loose = evaluateBuildInputs({ read: read(root), requireManifest: false, listLimit: 10 });
      assert.deepStrictEqual([loose.state, loose.degraded], ["unverified", false]);
      assert.strictEqual(formatBuildInputsLine(loose, { requireManifest: false }), "buildInputs: unverified (MANIFEST_MISSING)");

      put(root, "docker/build-inputs.json", JSON.stringify(manifestOf(["content-packs/../../etc/passwd"])));
      const bad = evaluateBuildInputs({ read: read(root), requireManifest: false, listLimit: 10 });
      assert.deepStrictEqual([bad.state, bad.reason], ["unverified", "MANIFEST_SCHEMA"]);
      put(root, "docker/build-inputs.json", JSON.stringify(manifestOf(PACKS)));
      assert.strictEqual(read(root, 20).manifestReason, "MANIFEST_TOO_LARGE");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("BI2 build inputs: GAME_MODULES seams for buildInputs, the real facade reads through requireGame", () => {
    const symbol = (p, name) => (GAME_MODULES.find((e) => e.path === p) || { symbols: [] }).symbols
      .find((s) => s.name === name);
    const drop = symbol("contentPacks/autoInstallContentPacks", "DROP_DIRECTORY");
    const reg = symbol("contentPacks/contentPackManager", "readRegistry");
    assert.ok(drop && reg, "both seams listed");
    assert.deepStrictEqual([drop.kind, drop.valueType, [...drop.consumers]], ["export", "string", ["buildInputs"]]);
    assert.deepStrictEqual([reg.kind, [...reg.consumers]], ["export", ["buildInputs"]]);

    const root = appRoot();
    try {
      put(root, "content-packs/a.json", "{}");
      const src = path.join(root, "server", "src");
      const cache = {
        [path.join(src, "contentPacks/autoInstallContentPacks.js")]: { exports: { DROP_DIRECTORY: path.join(root,
          "content-packs") } },
        [path.join(src, "contentPacks/contentPackManager.js")]: { exports: registry },
      };
      const adapter = createAdapter({ moduleApi: { _cache: cache } });
      assert.strictEqual(typeof adapter.readBuildInputs, "function");
      assert.strictEqual(adapter.setServerSrc(src).ok, true);
      const res = adapter.readBuildInputs({ maxFiles: 100 });
      assert.deepStrictEqual([res.ok, res.manifest, res.manifestReason, res.dropFiles, res.activePacks],
        [true, null, "MANIFEST_MISSING", ["a.json"], [{ id: "evejs-pack-00", version: "1.0.0" }]]);
      const none = createAdapter({ moduleApi: { _cache: {} } });
      none.setServerSrc(src);
      assert.deepStrictEqual(none.readBuildInputs({ maxFiles: 100 }),
        { ok: false, reason: "SEAM_UNAVAILABLE", detail: "not_booted" });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("BI3 build inputs: a degraded check makes the status degraded with a build inputs problem", () => {
    const statusOf = (buildInputs) => buildStatusView({ ctx: { state: { buildInputs } }, config: {},
      getObserverStats: () => ({}) }).getData();
    const missing = statusOf({ state: "missing", degraded: true, missing: 19,
      packs: { expectedFiles: 29, presentFiles: 10, active: 10 } });
    assert.strictEqual(missing.overall, "degraded");
    assert.ok(missing.problems.includes("build inputs: missing - 19 missing (content-packs 10/29)"), missing.problems);
    assert.strictEqual(missing.buildInputs.state, "missing");
    const ok = statusOf({ state: "ok", degraded: false, missing: 0, packs: { expectedFiles: 29, presentFiles: 29 } });
    assert.ok(!ok.problems.some((p) => p.startsWith("build inputs:")), ok.problems);
    assert.deepStrictEqual(statusOf(undefined).buildInputs, { state: "not_run" });
  });
};
