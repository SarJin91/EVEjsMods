"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const config = require("../../config");
const { findCompose, readCompose } = require("../config/composeKeys.test");
const { createWaitStep, WAIT_MAX_PER_THREAD } = require("../../lib/gameMaster/steps/wait");
const { createStepRegistry, MAX_KINDS, MAX_HINT_SOURCES, RESERVED } = require("../../lib/gameMaster/registry");
const { readHints } = require("../../lib/gameMaster/ai");
const { hintOf } = require("../../lib/seasons/hint");
const { STATE: SEASON_STATE } = require("../../lib/seasons/schema");
const { createDevHints } = require("../../lib/world/devIndices/gmHint");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const GM_DOC = path.join(MOD_DIR, "docs", "game-master.md");
const W91_PREFIX = "gameMaster.maxSiteStepsPerThread x";
const PRINTABLE_RE = /^[\x20-\x7e]+$/;

function configOf(env) {
  const r = config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(), ...env } });
  assert.deepStrictEqual(r.errors, []);
  return r;
}

function readSection(prefix) {
  const text = fs.readFileSync(GM_DOC, "utf8").replace(/\r\n/g, "\n");
  const start = text.indexOf(`\n${prefix}`);
  assert.ok(start >= 0, `docs/game-master.md has no section "${prefix}"`);
  const end = text.indexOf("\n## ", start + prefix.length + 1);
  return text.slice(start + 1, end < 0 ? text.length : end);
}

function onlyKnownTokens(line, allowed) {
  const words = line.split(/[^A-Za-z0-9]+/).filter((w) => w !== "" && !/^\d{1,5}$/.test(w));
  return words.filter((w) => !allowed.has(w));
}

module.exports = ({ test, skip }) => {
  const composeFile = findCompose();
  if (!composeFile) {
    skip("GMC1 gameMaster compose keys", "compose.yaml not found above the mod (Docker image)");
  } else {
    test("GMC1 compose: every gameMaster.* / chatterAi.plot* SCHEMA key has a ${NAME:-...} line, flags :-0", () => {
      const text = fs.readFileSync(composeFile, "utf8");
      const { env } = readCompose(composeFile);
      const gm = config.SCHEMA.filter((row) => row.key.startsWith("gameMaster."));
      const plot = config.SCHEMA.filter((row) => row.key.startsWith("chatterAi.plot"));
      assert.ok(gm.length >= 38, `gameMaster.* SCHEMA rows: ${gm.length}`);
      assert.strictEqual(plot.length, 4, `chatterAi.plot* SCHEMA rows: ${plot.length}`);
      const rows = [...gm, ...plot];
      const missing = rows.filter((row) => !Object.prototype.hasOwnProperty.call(env, row.env)).map((row) => row.env);
      assert.deepStrictEqual(missing, [], `missing in compose env: ${missing.join(", ")}`);
      const noDefault = rows.filter((row) => !text.includes(`\${${row.env}:-`)).map((row) => row.env);
      assert.deepStrictEqual(noDefault, [], `no \${NAME:-} line: ${noDefault.join(", ")}`);
      const flags = rows.filter((row) => row.type === "boolean" && row.default === false);
      for (const key of ["gameMaster.enabled", "gameMaster.aiEnabled"]) {
        assert.ok(flags.some((row) => row.key === key), `${key} is a flag`);
      }
      const wrong = flags.filter((row) => env[row.env] !== "0").map((row) => `${row.env}=${env[row.env]}`);
      assert.deepStrictEqual(wrong, [], `flags without :-0: ${wrong.join(", ")}`);
    });
  }

  test("GMC2 W91: WAIT capped at WAIT_MAX_PER_THREAD, defaults and 8 steps quiet, 3 SITE steps = TOO_LONG", () => {
    assert.strictEqual(WAIT_MAX_PER_THREAD, 2);
    assert.strictEqual(createWaitStep({ waitMaxHours: 12 }).maxPerThread, WAIT_MAX_PER_THREAD);
    const w91 = (env) => configOf({ EVEJS_LNE_GAMEMASTER_ENABLED: "1", EVEJS_LNE_NEWS_ENABLED: "1",
      EVEJS_LNE_NOTICES_ENABLED: "1", ...env }).warnings.filter((w) => w.startsWith(W91_PREFIX));
    assert.deepStrictEqual(w91({}), []);
    assert.deepStrictEqual(w91({ EVEJS_LNE_GAMEMASTER_MAX_STEPS_PER_THREAD: "8" }), []);
    const three = w91({ EVEJS_LNE_GAMEMASTER_MAX_SITE_STEPS_PER_THREAD: "3" });
    assert.strictEqual(three.length, 1, JSON.stringify(three));
    assert.ok(three[0].includes("TOO_LONG"), three[0]);
    assert.ok(three[0].includes(`${(3 * 12 + 2 * 12) * 3600000} ms`), three[0]);
  });

  test("GMC3 hint sources: readHints drops a line with >= 6 digits; seasons / devIndices lines are names only", () => {
    const reg = createStepRegistry();
    const bad = reg.registerHintSource({ key: "probe", read: () => ({ lines: ["Pilot 90000123 seen in Amamake",
      "Season 3 crisis: Guristas (stage 2/4, 12 days left)"] }) });
    assert.strictEqual(bad.ok, true);
    assert.deepStrictEqual(readHints(reg), [{ key: "probe",
      lines: ["Season 3 crisis: Guristas (stage 2/4, 12 days left)"], arcBias: [] }]);
    bad.unregister();

    const now = 1_800_000_000_000;
    const factions = { 500010: "Guristas Pirates" };
    const regions = { 10000002: "The Forge", 10000069: "Black Rise" };
    const names = { factionName: (id) => factions[id] || null, regionName: (id) => regions[id] || null };
    const season = { state: SEASON_STATE.ACTIVE, seasonNo: 3, factionId: 500010, crisisKind: "PIRATE_SURGE",
      regionIds: [10000002, 10000069], stage: 1, stageCount: 4, endsAt: now + 12 * 86400000 };
    const systems = { 30000142: "Jita", 30002813: "Amamake" };
    const dev = createDevHints({ systemNameOf: (id) => systems[id] || null, bump: () => {} });
    dev.push([{ kind: "boom", systemId: 30000142, index: "trade", level: 5 },
      { kind: "collapse", systemId: 30002813, index: "mil", level: 1 }, { kind: "boom", systemId: 31000005,
        index: "ind", level: 5 }]);
    assert.ok(reg.registerHintSource({ key: "seasons", read: () => hintOf(season, names, now) }).ok);
    assert.ok(reg.registerHintSource({ key: "devIndices", read: () => dev.read() }).ok);

    const out = readHints(reg);
    assert.deepStrictEqual(out.map((h) => h.key), ["devIndices", "seasons"]);
    const nameTokens = [...Object.values(factions), ...Object.values(regions), ...Object.values(systems)]
      .flatMap((n) => n.split(" "));
    const allowed = new Set([...nameTokens, "Season", "crisis", "pirate", "surge", "stage", "days", "left", "Crisis",
      "regions", "Boom", "Collapse", "military", "industry", "trade", "fell", "to"]);
    const lines = out.flatMap((h) => h.lines);
    assert.strictEqual(lines.length, 4, JSON.stringify(out));
    for (const line of lines) {
      assert.ok(PRINTABLE_RE.test(line) && line.length <= 160, line);
      assert.ok(!/\d{6,}/.test(line), line);
      assert.deepStrictEqual(onlyKnownTokens(line, allowed), [], line);
    }
    assert.ok(lines.includes("Boom: Jita trade 5") && lines.includes("Crisis regions: The Forge, Black Rise"),
      JSON.stringify(lines));
  });

  test("GMC4 liveSim: gameMaster.aiEnabled forced false with one line, enabled from the profile", () => {
    const { buildLiveConfig } = require("../../tools/liveSim/profile");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lne-gmc4-"));
    try {
      const build = (set) => {
        const r = buildLiveConfig({ set, envFile: null, settings: null, port: null }, { dataDir: dir });
        assert.strictEqual(r.ok, true, JSON.stringify(r));
        return r;
      };
      const on = build({ "gameMaster.enabled": "1", "gameMaster.aiEnabled": "1" });
      assert.strictEqual(on.config.gameMaster.enabled, true);
      assert.strictEqual(on.config.gameMaster.aiEnabled, false);
      const lines = on.forced.filter((l) => l.includes("gameMaster."));
      assert.strictEqual(lines.length, 1, JSON.stringify(lines));
      assert.ok(lines[0].startsWith("liveSim: forced gameMaster.aiEnabled=false ("), lines[0]);
      const plain = build({ "gameMaster.enabled": "1" });
      assert.deepStrictEqual(plain.forced.filter((l) => l.includes("gameMaster.")), []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("GMC5 docs/game-master.md: section AI Game Master with the ctx.gmSteps contract, drain note and P1-P5", () => {
    const sec = readSection("## AI Game Master");
    assert.ok(sec.includes("registerHintSource"));
    assert.ok(new RegExp(`MAX_KINDS\`? ${MAX_KINDS}\\b`).test(sec), "MAX_KINDS with its number");
    assert.ok(new RegExp(`MAX_HINT_SOURCES\`? ${MAX_HINT_SOURCES}\\b`).test(sec), "MAX_HINT_SOURCES with its number");
    for (const name of [...RESERVED, "BAD_KIND", "DUPLICATE", "FULL", "BAD_SOURCE"]) {
      assert.ok(sec.includes(name), name);
    }
    const drain = sec.split("\n").find((l) => l.startsWith("3. Drain"));
    assert.ok(drain && drain.includes("cancelInTx"), "drain note with cancelInTx");
    for (const p of ["P1", "P2", "P3", "P4", "P5"]) assert.ok(sec.includes(`- ${p} (`), p);
  });
};
