"use strict";

const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const config = require("../../config");
const { placeAround } = require("../../lib/factionIncursions/placement");
const { projectMilli, applyCompletion, initialMilli } = require("../../lib/factionIncursions/influence");
const R = require("../../lib/factionIncursions/rules");
const { PORTS, bodyOf } = require("../../lib/factionIncursions/vendorPorts");
const { FACTIONS, rulesOf } = require("../../lib/factionIncursions/data/catalog");
const { startFactionIncursions } = require("../../lib/factionIncursions");
const W = require("../../lib/heavyEvents/world/schema");
const { isWorldVariant } = require("../../lib/heavyEvents/world/catalog");
const { findCompose, readCompose } = require("../config/composeKeys.test");
const { SYS, TARGET, CONSTELLATION, constellationGraph, fakeGraph } = require("./harness");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SERVER_SRC = path.resolve(__dirname, "..", "..", "..", "..", "server", "src");
const COMPOSE_KEYS = Object.freeze(["EVEJS_LNE_FACTION_INCURSIONS_ENABLED",
  "EVEJS_LNE_FACTION_INCURSIONS_SETTLE_ENABLED", "EVEJS_LNE_FACTION_INCURSIONS_FACTION_IDS",
  "EVEJS_LNE_FACTION_INCURSIONS_ALLOW_EMPIRE_FACTIONS"]);

module.exports = ({ test, skip }) => {
  test("FI1 placeAround / projectMilli / applyCompletion / validateRules / refresh / recordClear", () => {
    const graph = constellationGraph();
    const placed = placeAround(graph, TARGET, { systems: 4, minSystems: 4 });
    assert.deepStrictEqual(placed, { ok: true, constellationId: CONSTELLATION, regionId: 10000001, secClass: "nullsec",
      systems: [{ systemId: SYS[0], role: "hq" }, { systemId: SYS[1], role: "assault" },
        { systemId: SYS[2], role: "vanguard" }, { systemId: SYS[3], role: "staging" }] });
    assert.deepStrictEqual(placeAround(graph, TARGET, { systems: 4, minSystems: 4 }), placed, "deterministic");
    const small = fakeGraph([1, 2, 3].map((n) => ({ id: 30000100 + n, constellationId: 7, regionId: 8,
      secClass: "lowsec" })), [[30000101, 30000102], [30000102, 30000103]]);
    assert.deepStrictEqual(placeAround(small, 30000101, { systems: 4, minSystems: 4 }), { ok: false,
      reason: "TOO_SMALL" });
    assert.strictEqual(placeAround(small, 30000101, { systems: 4, minSystems: 2 }).systems.length, 3);
    assert.strictEqual(placeAround(graph, 30009999, { systems: 4, minSystems: 4 }).reason, "NO_SYSTEM");

    const snap = { valueMilli: 500, updatedAt: 0, graceMinutes: 10, decayMilliPerHour: 60 };
    assert.strictEqual(projectMilli(snap, 10 * 60000), 500, "inside the grace");
    assert.strictEqual(projectMilli(snap, 15 * 60000 + 59999), 495, "5 whole minutes x 1/min");
    assert.strictEqual(projectMilli(snap, 1000 * 60000), 0, "clamped at 0");
    assert.strictEqual(projectMilli({ ...snap, valueMilli: 1001 }, 0), null);
    assert.deepStrictEqual(applyCompletion(snap, 60000, 60000, 250), { accepted: false, before: 500, valueMilli: 500,
      updatedAt: 0 });
    assert.deepStrictEqual(applyCompletion(snap, 60000, 60001, 600), { accepted: true, before: 500, valueMilli: 1000,
      updatedAt: 60000 });
    assert.deepStrictEqual([initialMilli(0, { initialMaxMilli: 600, initialMinMilli: 0 }),
      initialMilli(50, { initialMaxMilli: 600, initialMinMilli: 0 }),
      initialMilli(250, { initialMaxMilli: 600, initialMinMilli: 0 })], [600, 300, 0]);

    const rules = rulesOf(500026);
    assert.deepStrictEqual(R.validateRules(rules), { ok: true });
    const cyc = { stages: [{ key: "a", slots: 1, repeat: true, prerequisites: ["b"], unlock: null },
      { key: "b", slots: 1, repeat: true, prerequisites: ["a"], unlock: null }], completion: { stage: "a" } };
    assert.strictEqual(R.validateRules(cyc).reason, "RULES_CYCLE");
    const unknown = { stages: [{ key: "a", slots: 1, repeat: true, prerequisites: [], unlock: null }],
      completion: { stage: "zz" } };
    assert.strictEqual(R.validateRules(unknown).reason, "RULES_INVALID");
    const facts = (influenceMilli) => ({ influenceMilli, hqUnlockMilli: 1000 });
    const p0 = R.refresh(R.createProgress(rules), rules, facts(999));
    assert.deepStrictEqual(Object.keys(p0.stages).filter((k) => p0.stages[k].active), ["staging", "vanguard", "assault"]);
    const p1 = R.refresh(p0, rules, facts(1000));
    assert.strictEqual(p1.stages.hq.active, true, "hq at hqUnlockMilli");
    assert.strictEqual(R.refresh(p1, rules, facts(0)).stages.hq.active, true, "an active stage stays active");
    const c1 = R.recordClear(p1, rules, { stageKey: "staging", receiptId: "hin:1:staging:1" });
    assert.deepStrictEqual([c1.ok, c1.duplicate, c1.progress.stages.staging.clears], [true, false, 1]);
    const c2 = R.recordClear(c1.progress, rules, { stageKey: "staging", receiptId: "hin:1:staging:1" });
    assert.deepStrictEqual([c2.ok, c2.duplicate, c2.progress.stages.staging.clears], [true, true, 1]);
    assert.strictEqual(R.recordClear(p0, rules, { stageKey: "hq", receiptId: "x" }).reason, "STAGE_INACTIVE");
    assert.strictEqual(R.recordClear(c1.progress, rules, { stageKey: "vanguard", receiptId: "y", maxReceipts: 1 })
      .reason, "CLEARS_CAPPED");
  });

  const name = "FI2 vendor port fingerprints + factionIncursions.* defaults off + compose keys + catalogue kinds";
  const missing = [...new Set(PORTS.map((p) => p.file))].filter((f) => !fs.existsSync(path.join(SERVER_SRC, f)));
  if (missing.length > 0) {
    skip(name, `vendor file not found: ${missing.join(", ")}`);
    return;
  }
  test(name, () => {
    const review = [];
    for (const p of PORTS) {
      const body = bodyOf(fs.readFileSync(path.join(SERVER_SRC, p.file), "utf8"), p.symbol);
      const sha = body === null ? null : crypto.createHash("sha256").update(body).digest("hex");
      if (sha !== p.sha256) review.push(`${p.file} ${p.symbol} (port ${p.lne}; review differences: ${p.differences.join("; ")})`);
    }
    assert.deepStrictEqual(review, [], `vendor bodies changed - to review:\n${review.join("\n")}`);

    const rows = config.SCHEMA.filter((row) => row.key.startsWith("factionIncursions."));
    assert.ok(rows.length >= 27, `factionIncursions.* rows: ${rows.length}`);
    assert.deepStrictEqual(rows.filter((row) => row.type === "boolean").map((row) => [row.key, row.default]),
      [["factionIncursions.enabled", false], ["factionIncursions.settle.enabled", false],
        ["factionIncursions.allowEmpireFactions", false],
        ["factionIncursions.ui.enabled", false], ["factionIncursions.hud.enabled", false],
        ["factionIncursions.effects.enabled", false],
        ["factionIncursions.rewards.enabled", false],
        ["factionIncursions.consequences.enabled", false], ["factionIncursions.consequences.newsEnabled", false]]);
    const r = config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir() } });
    assert.deepStrictEqual(r.errors || [], []);
    let touched = 0;
    const store = { transaction: () => {
      touched += 1;
      return { ok: true, value: { ok: true, count: 0 } };
    } };
    assert.deepStrictEqual(startFactionIncursions({ config: r.config, clock: { now: () => 1 },
      persistence: { ok: true, store, journal: {} } }), { ok: false, reason: "disabled_by_config" });
    assert.strictEqual(touched, 1, "flag off: one count of the open rows, nothing else");

    for (const [factionId, f] of Object.entries(FACTIONS)) {
      for (const st of f.stages) {
        assert.ok(W.KINDS.includes(st.kind), `${factionId} ${st.key} kind ${st.kind}`);
        assert.ok(isWorldVariant(W.MECHANIC_OF[st.kind], st.kind), `${st.kind} world variant`);
      }
    }

    const composeFile = findCompose();
    if (!composeFile) return;
    const text = fs.readFileSync(composeFile, "utf8");
    const { env } = readCompose(composeFile);
    for (const key of COMPOSE_KEYS) {
      assert.ok(Object.prototype.hasOwnProperty.call(env, key), `compose env ${key}`);
      assert.ok(text.includes(`\${${key}:-}`), `compose \${${key}:-}`);
    }
  });
};
