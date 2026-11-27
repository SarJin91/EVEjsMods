"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO = path.resolve(__dirname, "..", "..", "..", "..");
const DEPLOY_DIR = path.join(REPO, "tools", "deploy");

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `lne-dg-${tag}-`));
}

function writeFile(root, rel, text) {
  const abs = path.join(root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
}

function snapshotTree(root) {
  const out = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else {
        const st = fs.statSync(abs);
        out[path.relative(root, abs)] = `${st.size}:${st.mtimeMs}`;
      }
    }
  };
  walk(root);
  return out;
}

module.exports = ({ test, skip }) => {
  if (!fs.existsSync(path.join(DEPLOY_DIR, "deploy.js"))) {
    skip("DG1-DG5 deploy guard", "tools/deploy not present (image without the deploy script)");
    return;
  }
  const { parseDockerignore, isShipped, includeRoots } = require(path.join(DEPLOY_DIR, "lib", "dockerignore.js"));
  const { guardedRootsOf, selectOverlay, planOverlay } = require(path.join(DEPLOY_DIR, "lib", "overlay.js"));
  const { runDeploy } = require(path.join(DEPLOY_DIR, "deploy.js"));
  const { hashFiles, buildManifest, compareManifest, SCHEMA } = require(path.join(REPO, "docker", "build-inputs.js"));
  const policy = JSON.parse(fs.readFileSync(path.join(DEPLOY_DIR, "deploy.config.json"), "utf8"));
  const dockerignoreText = fs.readFileSync(path.join(REPO, ".dockerignore"), "utf8");
  const rules = parseDockerignore(dockerignoreText).rules;

  test("DG1 deploy guard: the .dockerignore matcher on the real file ships the incident paths, not caches", () => {
    const shipped = [
      "content-packs/evejs-incursions-1.0.0.json",
      "config/world.json",
      "tools/DatabaseCreator/setupInputs/seeds/npcProfiles.json",
      "tools/ClientDungeonCompiler/lib/resourceCompiler.js",
      "tools/market-seederv3/data/price-manifest.json",
      "externalservices/market-server/src/main.rs",
      "docker/build-inputs.json",
      "mods/livingNewEden/loader.js",
      "tools/deploy/deploy.js",
    ];
    const notShipped = [
      "content-packs/build/x.json",
      "tools/DatabaseCreator/staticTables/agentAuthority/data.json",
      "mods/rpg/a.js",
      ".env",
      "config/.env.local",
      "server/logs/a.log",
      "externalservices/market-server/target/x",
      "externalservices/market-server/data/generated/market.sqlite",
      "externalservices/market-server/data/generated/big.bin",
      "tools/market-seederv3/cache/a",
      "x/node_modules/y",
      "server/node_modules/better-sqlite3/index.js",
    ];
    const wrongIn = shipped.filter((p) => !isShipped(rules, p));
    const wrongOut = notShipped.filter((p) => isShipped(rules, p));
    assert.deepStrictEqual({ wrongIn, wrongOut }, { wrongIn: [], wrongOut: [] });
  });

  test("DG2 deploy guard: every `!` root of .dockerignore is guarded or code, the guarded list is pinned", () => {
    const code = policy.codeRoots;
    const guarded = guardedRootsOf(rules, policy);
    const unclassified = includeRoots(rules).filter((root) => !guarded.includes(root)
      && !code.some((c) => root === c || root.startsWith(`${c}/`)));
    assert.deepStrictEqual(unclassified, [], "every root is guarded or code");
    for (const need of ["content-packs", "config", "tools/DatabaseCreator", "tools/market-seed", "tools/market-seederv2",
      "tools/market-seederv3", "externalservices/market-server"]) {
      assert.ok(guarded.includes(need), `guarded root ${need}`);
    }
    const pinned = ["config", "content-packs", "externalservices/market-server",
      "scripts/ContentPacks/enrich-retained-security-missions.js", "scripts/ContentPacks/lib/packBuilder.js",
      "scripts/DataSync/generate-expert-systems.js", "scripts/DataSync/import-skinr-client-export.js",
      "tools/ClientDungeonCompiler/build-booster-site-target-manifests.js",
      "tools/ClientDungeonCompiler/build-combat-anomaly-target-manifest.js",
      "tools/ClientDungeonCompiler/build-ded-rated-site-target-manifest.js",
      "tools/ClientDungeonCompiler/build-drone-anomaly-target-manifest.js",
      "tools/ClientDungeonCompiler/build-ghost-site-target-manifest.js",
      "tools/ClientDungeonCompiler/build-mining-mission-target-manifests.js",
      "tools/ClientDungeonCompiler/build-pirate-exploration-target-manifests.js",
      "tools/ClientDungeonCompiler/build-resource-target-manifest.js",
      "tools/ClientDungeonCompiler/build-wormhole-site-target-manifests.js", "tools/ClientDungeonCompiler/lib",
      "tools/ClientDungeonCompiler/spec/boosterSiteComposition.js",
      "tools/ClientDungeonCompiler/spec/pirateExplorationComposition.js",
      "tools/ClientSETUP/blue_patch_recipe.json", "tools/ClientSETUP/crash_upload_patch_recipe.json",
      "tools/ClientSETUP/launchdarkly_localhost_upgrade_recipe.json", "tools/ClientSETUP/launchdarkly_patch_recipe.json",
      "tools/ContentPacks", "tools/DatabaseCreator", "tools/ErrorReport",
      "tools/Maintenance/download-npc-portraits.js", "tools/Maintenance/preserve-skinr-catalogue.js",
      "tools/Maintenance/refresh-static-data.js", "tools/Maintenance/reset-character-missions.js",
      "tools/Maintenance/upgrade-legacy-save.js",
      "tools/market-seed", "tools/market-seederv2", "tools/market-seederv3",
      "tools/moon-data/generate-moon-composition-pack.js"];
    assert.deepStrictEqual({ added: guarded.filter((r) => !pinned.includes(r)), gone: pinned.filter((r) => !guarded.includes(r)) },
      { added: [], gone: [] });
    const fresh = parseDockerignore(`${dockerignoreText}\n!newstuff/\n!newstuff/**\n`).rules;
    assert.ok(guardedRootsOf(fresh, policy).includes("newstuff"), "a new `!` root becomes guarded (and fails the pin)");
  });

  test("DG3 deploy guard: selectOverlay puts every listed file in its bucket", () => {
    const out = selectOverlay({
      rules,
      ignoredFiles: ["content-packs/a.json", "content-packs/build/b.json", "mods/x/__pycache__/c.pyc",
        "externalservices/market-server/target/d", "config/advancedUtilityDrones.players.json", ".env"],
      modifiedTracked: ["config/world.json"],
      policy,
    });
    assert.deepStrictEqual(out.overlay,
      ["config/advancedUtilityDrones.players.json", "config/world.json", "content-packs/a.json"]);
    assert.deepStrictEqual(out.notShipped,
      [".env", "content-packs/build/b.json", "externalservices/market-server/target/d"]);
    assert.deepStrictEqual(out.skippedNoise, ["mods/x/__pycache__/c.pyc"]);
    assert.deepStrictEqual(out.skippedCode, []);
    assert.deepStrictEqual(out.unguarded, []);
    const code = selectOverlay({ rules, ignoredFiles: ["mods/livingNewEden/x.js", "tools/lne-check/y.js"],
      modifiedTracked: [], policy });
    assert.deepStrictEqual([code.skippedCode, code.unguarded], [["mods/livingNewEden/x.js"], ["tools/lne-check/y.js"]]);
  });

  test("DG4 deploy guard: planOverlay and compareManifest find 2 of 3 packs missing, a size change, a secret", () => {
    const source = tmpDir("src");
    const context = tmpDir("ctx");
    try {
      const packs = ["content-packs/p1.json", "content-packs/p2.json", "content-packs/p3.json"];
      packs.forEach((p, i) => writeFile(source, p, `{"pack":${i}}`));
      writeFile(context, packs[0], '{"pack":0}');
      const plan = planOverlay(source, context, packs);
      assert.deepStrictEqual(plan.missingInContext, [packs[1], packs[2]]);
      assert.deepStrictEqual(plan.same, [packs[0]]);
      assert.deepStrictEqual(plan.toCopy, [packs[1], packs[2]]);

      const hashed = hashFiles(source, packs);
      assert.strictEqual(hashed.ok, true);
      const manifest = buildManifest({ files: hashed.files, guardedRoots: ["config", "content-packs"],
        contextCommit: "a".repeat(40), contextKind: "worktree", generatedAt: "2026-11-15T12:00:00.000Z" });
      assert.deepStrictEqual(manifest.counts, { config: 0, "content-packs": 3 });
      const observe = () => packs.map((p) => {
        const abs = path.join(context, ...p.split("/"));
        return { path: p, size: fs.existsSync(abs) ? fs.statSync(abs).size : null };
      });
      const cmp = compareManifest(manifest, observe(), { hashes: false });
      assert.strictEqual(cmp.ok, false);
      assert.deepStrictEqual(cmp.missing, [packs[1], packs[2]]);
      assert.deepStrictEqual(cmp.byRoot["content-packs"], { expected: 3, missing: 2 });

      writeFile(context, packs[0], '{"pack":0,"x":1}');
      packs.slice(1).forEach((p, i) => writeFile(context, p, `{"pack":${i + 1}}`));
      const sized = compareManifest(manifest, observe(), { hashes: false });
      assert.deepStrictEqual([sized.missing, sized.sizeMismatch], [[], [packs[0]]]);

      fs.writeFileSync(path.join(source, ".env"), "SECRET=1");
      const secret = hashFiles(source, [packs[0], ".env"]);
      assert.deepStrictEqual(secret, { ok: false, reason: "SECRET_PATH", path: ".env" });

      const modCore = require("../../lib/adapter/buildInputs");
      assert.strictEqual(modCore.MANIFEST_SCHEMA, SCHEMA);
    } finally {
      fs.rmSync(source, { recursive: true, force: true });
      fs.rmSync(context, { recursive: true, force: true });
    }
  });

  function rig(verifyResult, { ignored = "content-packs/a.json\0content-packs/b.json\0", porcelain = "" } = {}) {
    const source = tmpDir("src");
    const context = tmpDir("ctx");
    fs.writeFileSync(path.join(source, ".dockerignore"), dockerignoreText);
    fs.writeFileSync(path.join(context, ".dockerignore"), dockerignoreText);
    writeFile(source, "content-packs/a.json", '{"a":1}');
    writeFile(source, "content-packs/b.json", '{"b":1}');
    writeFile(context, "content-packs/a.json", '{"a":1}');
    const calls = [];
    const exec = (cmd, args) => {
      calls.push([cmd, ...args]);
      const line = args.join(" ");
      if (cmd === "git" && line.includes("rev-parse")) return { status: 0, stdout: `${"c".repeat(40)}\n`, stderr: "" };
      if (cmd === "git" && line.includes("ls-files") && args.includes("-o")) {
        return { status: 0, stdout: ignored, stderr: "" };
      }
      if (cmd === "git" && args.includes("status")) return { status: 0, stdout: porcelain, stderr: "" };
      if (cmd === "docker" && args[0] === "run") {
        return { status: 2, stdout: `${JSON.stringify(verifyResult)}\n`, stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    };
    const deps = { exec, sourceDir: source, policy, log: () => {}, now: () => Date.UTC(2026, 10, 15, 12, 0),
      sleep: async () => {}, httpGet: async () => ({ status: 200, body: "{}" }) };
    const done = () => {
      fs.rmSync(source, { recursive: true, force: true });
      fs.rmSync(context, { recursive: true, force: true });
    };
    return { source, context, calls, deps, done };
  }

  test("DG5 deploy guard: link B not ok never reaches up and restores the tag; --dry-run calls no docker", async () => {
    const bad = { ok: false, missing: ["content-packs/b.json"], sizeMismatch: [], hashMismatch: [],
      byRoot: { "content-packs": { expected: 2, missing: 1 } }, files: 2 };
    const a = rig(bad);
    try {
      const res = await runDeploy(["--context", a.context, "--services", "server,market"], a.deps);
      assert.deepStrictEqual([res.ok, res.step, res.exitCode], [false, 8, 3]);
      assert.strictEqual(res.rollbackTag, "evejs-local:rollback-202611151200");
      assert.ok(!a.calls.some((c) => c[0] === "docker" && c.includes("up")), "no docker compose up");
      assert.ok(a.calls.some((c) => c.join(" ") === "docker tag evejs-local:rollback-202611151200 evejs-local"),
        "the image tag points at the rollback tag again");
      assert.ok(fs.existsSync(path.join(a.context, "content-packs", "b.json")));
      const manifest = JSON.parse(fs.readFileSync(path.join(a.context, "docker", "build-inputs.json"), "utf8"));
      assert.deepStrictEqual(manifest.files.map((f) => f.path), ["content-packs/a.json", "content-packs/b.json"]);
    } finally {
      a.done();
    }

    const b = rig(bad, { ignored: "content-packs/a.json\0content-packs/b.json\0tools/.elysian-suite/logs/x.log\0" });
    try {
      const before = [snapshotTree(b.source), snapshotTree(b.context)];
      const res = await runDeploy(["--context", b.context, "--dry-run"], b.deps);
      assert.deepStrictEqual([res.ok, res.step, res.exitCode], [true, 5, 0]);
      assert.deepStrictEqual(b.calls.filter((c) => c[0] === "docker" || c.includes("worktree")), []);
      assert.deepStrictEqual([snapshotTree(b.source), snapshotTree(b.context)], before);
      assert.deepStrictEqual(res.report.overlay.missingInContext, { "content-packs": 1 });
      const lsOther = b.calls.find((c) => c[0] === "git" && c.includes("-o"));
      assert.ok(lsOther.includes("tools") && lsOther.includes("externalservices"), "git asked about the parents");
      assert.deepStrictEqual(res.report.overlay.unguarded, { "tools/.elysian-suite": 1 });
    } finally {
      b.done();
    }
  });

  test("DG5c deploy guard: a rerun on a pre-guard worktree skips its own untracked manifest, other changes stop", async () => {
    const ok = { ok: true, missing: [], sizeMismatch: [], hashMismatch: [], byRoot: {}, files: 2 };
    const c = rig(ok, { porcelain: "?? docker/build-inputs.json\n" });
    try {
      const res = await runDeploy(["--context", c.context, "--no-up"], c.deps);
      assert.deepStrictEqual([res.ok, res.step, res.exitCode, res.report.codeRootsDirty], [true, 10, 0, 0]);
      assert.ok(c.calls.some((call) => call[0] === "docker" && call[1] === "run"), "link B (step 8) reached");
    } finally {
      c.done();
    }
    const d = rig(ok, { porcelain: "?? docker/build-inputs.json\n M docker/entrypoint.sh\n" });
    try {
      const res = await runDeploy(["--context", d.context, "--no-up"], d.deps);
      assert.deepStrictEqual([res.ok, res.step, res.exitCode, res.report.codeRootsDirty], [false, 4, 2, 1]);
    } finally {
      d.done();
    }
  });
};
