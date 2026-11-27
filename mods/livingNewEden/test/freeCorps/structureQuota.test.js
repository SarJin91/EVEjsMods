"use strict";

const assert = require("node:assert");
const path = require("node:path");

const config = require("../../config");
const H = require("./hunting.test").harness;
const { createFreeCorpRepository } = require("../../lib/freeCorps/repository");
const structureModule = require("../../lib/freeCorps/structureRepository");
const { planAnchors } = require("../../lib/freeCorps/structures");
const ventures = require("../../lib/freeCorps/ventures");
const { placementCandidates } = require("../../lib/stations/structures/projection");
const { CONDITION_FULL, CONDITION_ARMOR_STAGE } = require("../../lib/stations/structures/schema");
const { loadDriver, withStore } = require("../notices/storeHelper");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const T0 = H.T0;
const H1 = 30000001;
const L1 = H.L1;
const L2 = H.L2;
const N1 = 30000021;
const SPEC = Object.freeze({ [H1]: { band: "highsec", links: [] }, [L1]: { band: "lowsec", links: [L2] },
  [L2]: { band: "lowsec", links: [L1, N1] }, [N1]: { band: "nullsec", links: [L2] } });
const KIT = Object.freeze({ placementCandidates, CONDITION_FULL, CONDITION_ARMOR_STAGE });
const PUMP = Object.freeze({ structureKit: KIT, systemBlockedInTx: () => ({ ok: true, blocked: null }) });

function cfgOf({ fc = {}, st = {}, hunting = { enabled: false } } = {}) {
  const base = H.cfgOf({ fc, hunting });
  const f = base.freeCorps;
  return { ...base, freeCorps: { ...f, structures: { ...f.structures, enabled: true, ...st } } };
}

const boot = (opened, cfg, extra = PUMP) => H.boot(opened, { cfg, spec: SPEC, stationSystems: [H1, L1, N1], extra });
const corps = (opened) => H.all(opened, "SELECT corp_id, archetype, sec_band, home_system_id, name, isk, state "
  + "FROM world_free_corps ORDER BY corp_id");
const statsOf = (opened) => opened.store.transaction("t.st", (db) => createFreeCorpRepository().statsInTx(db)).value;

function windows(env, n, interval) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    env.clock.set(T0 + i * interval);
    out.push(H.pass(env));
  }
  return out;
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("SQ1 structures on with targetStructureCorps 0 = the foundings of the flag off bit for bit, no "
    + "structure corporation (also with a structure weight), no structureQuota status key", () => {
    const run = (cfg, extra) => {
      let rows = null;
      let st = null;
      let stats = null;
      withStore(driver, (opened) => {
        const env = boot(opened, cfg, extra);
        st = windows(env, 4, cfg.freeCorps.foundingIntervalMs).pop();
        rows = corps(opened);
        stats = statsOf(opened);
        env.fc.stop();
      });
      return { rows, st, stats };
    };
    const fc = { targetCorps: 4, maxFoundingOpen: 8 };
    const off = run(cfgOf({ fc, st: { enabled: false } }), {});
    const on = run(cfgOf({ fc, st: { targetStructureCorps: 0 } }), PUMP);
    assert.strictEqual(off.rows.length, 4);
    assert.deepStrictEqual(on.rows, off.rows, "bit for bit");
    assert.ok(on.rows.every((r) => r.archetype !== "structure"));
    assert.strictEqual(on.stats.structureCorps, 0);
    assert.strictEqual("structureQuota" in on.st, false);
    assert.strictEqual(on.st.counters.stQuotaRefused, 0);
    const weighted = run(cfgOf({ fc: { ...fc, archetypeWeights: "miner:20,structure:500" },
      st: { targetStructureCorps: 0 } }), PUMP);
    assert.ok(weighted.rows.length > 0 && weighted.rows.every((r) => r.archetype === "miner"),
      JSON.stringify(weighted.rows));
  });

  needsDriver("SQ2 targetCorps full, targetStructureCorps 2 -> one structure corporation per window (isk = "
    + "foundingIsk, lowsec / nullsec), the third window none; venture RAT / MINE; no pump -> no quota", () => {
    withStore(driver, (opened) => {
      const cfg = cfgOf({ fc: { targetCorps: 0 }, st: { targetStructureCorps: 2, foundingIsk: 6000000000 } });
      const interval = cfg.freeCorps.foundingIntervalMs;
      const env = boot(opened, cfg);
      let st = H.pass(env);
      assert.deepStrictEqual(corps(opened).map((r) => r.archetype), ["structure"], "one per window");
      assert.deepStrictEqual(st.structureQuota, { target: 2, corps: 1 });
      env.clock.set(T0 + interval);
      st = H.pass(env);
      const rows = corps(opened);
      assert.deepStrictEqual(rows.map((r) => [r.archetype, r.isk]), [["structure", 6000000000],
        ["structure", 6000000000]]);
      assert.ok(rows.every((r) => r.sec_band === "lowsec" || r.sec_band === "nullsec"), JSON.stringify(rows));
      for (const r of rows) env.vc.identities.set(r.corp_id, H.linked(10, 98000000 + r.corp_id));
      env.clock.set(T0 + 2 * interval);
      st = H.pass(env);
      assert.strictEqual(corps(opened).length, 2, "<= N");
      assert.deepStrictEqual(corps(opened).map((r) => r.state), ["ACTIVE", "ACTIVE"]);
      assert.deepStrictEqual(st.structureQuota, { target: 2, corps: 2 });
      assert.strictEqual(statsOf(opened).structureCorps, 2);
      env.clock.set(T0 + 2 * interval + cfg.freeCorps.activeIdleMs + 1);
      H.pass(env);
      const kinds = H.all(opened, "SELECT corp_id, kind FROM world_free_corp_ventures ORDER BY corp_id");
      assert.ok(kinds.length >= 1 && kinds.every((v) => v.kind === "RAT" || v.kind === "MINE"), JSON.stringify(kinds));
      assert.strictEqual(env.fc.getStatus().counters.ventureNoKind, 0);
      env.fc.stop();
    });
    withStore(driver, (opened) => {
      const env = boot(opened, cfgOf({ fc: { targetCorps: 0 }, st: { targetStructureCorps: 2 } }), {});
      const st = H.pass(env);
      assert.strictEqual(corps(opened).length, 0, "no structure pump = no quota");
      assert.strictEqual("structureQuota" in st, false);
      env.fc.stop();
    });
  });

  needsDriver("SQ3 the refusal chain: hunter quota -> structure quota -> plain founding in one step "
    + "(foundingQuotaRefused 1, stQuotaRefused 1); targetCorps full -> no founding", () => {
    const hunting = { enabled: true, targetHunters: 1 };
    withStore(driver, (opened) => {
      const env = boot(opened, cfgOf({ fc: { targetCorps: 1, bandWeights: "highsec:100" },
        st: { targetStructureCorps: 1 }, hunting }));
      const st = H.pass(env);
      const rows = corps(opened);
      assert.strictEqual(rows.length, 1);
      assert.deepStrictEqual([rows[0].sec_band, rows[0].home_system_id], ["highsec", H1]);
      assert.ok(rows[0].archetype !== "structure" && rows[0].archetype !== "hunter");
      assert.deepStrictEqual([st.counters.foundingQuotaRefused, st.counters.stQuotaRefused, st.counters.founded],
        [1, 1, 1]);
      env.fc.stop();
    });
    withStore(driver, (opened) => {
      const env = boot(opened, cfgOf({ fc: { targetCorps: 0, bandWeights: "highsec:100" },
        st: { targetStructureCorps: 1 }, hunting }));
      const st = H.pass(env);
      assert.strictEqual(corps(opened).length, 0);
      assert.deepStrictEqual([st.counters.foundingQuotaRefused, st.counters.stQuotaRefused, st.counters.founded],
        [1, 1, 0]);
      env.fc.stop();
    });
  });

  needsDriver("SQ4 the anchor priority: planAnchors and candidatesInTx put the structure corporation first", () => {
    const S = { ...H.cfgOf({ hunting: { enabled: false } }).freeCorps.structures, maxAnchorsPerPlan: 1 };
    const cand = (corp_id, archetype, isk) => ({ corp_id, archetype, isk, corporation_id: 98000000 + corp_id,
      home_system_id: 30000010 + corp_id, openOfCorp: 0, lastLostAt: null, structure_seq: 0 });
    const input = (candidates) => ({ now: T0, openTotal: 0, candidates, openInSystem: () => 0, blocked: () => null, S });
    const p1 = planAnchors(input([cand(1, "miner", 9000000000), cand(2, "structure", 6000000000)]));
    assert.deepStrictEqual(p1.picks.map((p) => p.corpId), [2]);
    assert.strictEqual(p1.skipped.CAP, 1);
    const p2 = planAnchors(input([cand(2, "ratter", 6000000000), cand(1, "miner", 9000000000)]));
    assert.deepStrictEqual(p2.picks.map((p) => p.corpId), [1], "order");
    withStore(driver, (opened) => {
      H.seedCorp(opened, { corpId: 1, archetype: "miner", isk: 9000000000 });
      H.seedCorp(opened, { corpId: 2, archetype: "structure", isk: 6000000000 });
      H.seedCorp(opened, { corpId: 3, archetype: "ratter", isk: 7000000000 });
      const repo = structureModule.createFreeCorpStructureRepository();
      const r = opened.store.transaction("t.c", (db) => repo.candidatesInTx(db, { minIsk: 5000000000, limit: 8 }));
      assert.ok(r.ok && r.value.ok, JSON.stringify(r));
      assert.deepStrictEqual(r.value.rows.map((c) => [c.corp_id, c.archetype]),
        [[2, "structure"], [1, "miner"], [3, "ratter"]]);
      const two = opened.store.transaction("t.c", (db) => repo.candidatesInTx(db, { minIsk: 5000000000, limit: 1 }));
      assert.deepStrictEqual(two.value.rows.map((c) => c.corp_id), [2], "not pushed out by LIMIT");
    });
  });

  needsDriver("SQ6 the review holds the growth of a structure corporation without a structure under the "
    + "anchoring floor (growthHeldStructure), the corporation stays a candidate; a miner grows; the flag off grows", () => {
    const run = (cfg, extra) => {
      let out = null;
      withStore(driver, (opened) => {
        H.seedCorp(opened, { corpId: 1, archetype: "structure", isk: 5300000000 });
        H.seedCorp(opened, { corpId: 2, archetype: "miner", isk: 5300000000 });
        const env = boot(opened, cfg, extra);
        for (const id of [1, 2]) env.vc.identities.set(id, H.linked(5, 98000000 + id));
        const st = H.pass(env);
        const rows = H.all(opened, "SELECT corp_id, members_target, isk FROM world_free_corps ORDER BY corp_id");
        const repo = structureModule.createFreeCorpStructureRepository();
        const c = opened.store.transaction("t.c", (db) => repo.candidatesInTx(db, { minIsk: 5000000000, limit: 8 }));
        out = { st, rows, cand: c.value.rows.map((r) => r.corp_id) };
        env.fc.stop();
      });
      return out;
    };
    const on = run(cfgOf({ fc: { targetCorps: 0 } }), PUMP);
    assert.strictEqual(on.st.counters.growthHeldStructure, 1, JSON.stringify(on.st.counters));
    assert.deepStrictEqual(on.rows.map((r) => r.members_target), [5, 6], "structure held, miner grew");
    assert.ok(on.cand.includes(1), `the quota corporation is still an anchor candidate ${JSON.stringify(on.rows)}`);
    const off = run(cfgOf({ fc: { targetCorps: 0 }, st: { enabled: false } }), {});
    assert.strictEqual(off.st.counters.growthHeldStructure, 0);
    assert.deepStrictEqual(off.rows.map((r) => r.members_target), [6, 6], "flag off = the growth of before");
    assert.ok(!off.cand.includes(1), "without the hold the growth drops it under the floor (the bug)");
    const S = cfgOf({}).freeCorps;
    const corp = { corp_id: 9, archetype: "structure", state: "ACTIVE", isk: 5300000000, members_target: 5,
      struggle_count: 0, isk_lost: 0, isk_earned: 0 };
    const hold = (open) => ({ minIsk: 5000000000, hasOpen: () => open });
    const env = (sh) => ({ now: T0, memberRoom: 10, structureHold: sh });
    assert.strictEqual(ventures.reviewCorp(corp, env(hold(false)), S).corp.members_target, 5);
    assert.strictEqual(ventures.reviewCorp(corp, env(hold(true)), S).corp.members_target, 6);
    assert.strictEqual(ventures.reviewCorp({ ...corp, isk: 9000000000 }, env(hold(false)), S).corp.members_target, 6);
    assert.deepStrictEqual(ventures.reviewCorp({ ...corp, archetype: "miner" }, env(hold(false)), S),
      ventures.reviewCorp({ ...corp, archetype: "miner" }, env(null), S), "other archetypes bit for bit");
  });

  test("SQ5 config: targetStructureCorps 0 / foundingIsk 6e9, W39-W43, W5 for structure only with the flag off",
    () => {
    const base = { EVEJS_LNE_FREE_CORPS_ENABLED: "1", EVEJS_LNE_VIRTUALCORPS_ENABLED: "1" };
    const resolve = (env) => config.resolveConfig({ modDir: MOD_DIR, env: { ...base, ...env } });
    const d = resolve({});
    assert.deepStrictEqual(d.errors, []);
    assert.deepStrictEqual([d.config.freeCorps.structures.targetStructureCorps,
      d.config.freeCorps.structures.foundingIsk], [0, 6000000000]);
    const has = (env, prefix) => resolve(env).warnings.filter((w) => w.startsWith(prefix)).length;
    const on = { EVEJS_LNE_FREE_CORPS_STRUCTURES_ENABLED: "1" };
    const q = { EVEJS_LNE_FREE_CORPS_STRUCTURES_TARGET_STRUCTURE_CORPS: "2" };
    const W39 = "freeCorps.structures.targetStructureCorps needs";
    assert.strictEqual(has(q, W39), 1, "W39 flag off");
    assert.strictEqual(has({ ...q, ...on }, W39), 0);
    assert.strictEqual(has({ ...q, ...on, EVEJS_LNE_FREE_CORPS_STRUCTURES_MAX_TOTAL: "1" },
      "freeCorps.structures.targetStructureCorps=2 above structures.maxTotal=1"), 1, "W40");
    assert.strictEqual(has({ ...q, ...on }, "freeCorps.structures.targetStructureCorps=2 above"), 0);
    const W41 = "freeCorps.structures.foundingIsk=";
    assert.strictEqual(has({ ...q, ...on, EVEJS_LNE_FREE_CORPS_STRUCTURES_FOUNDING_ISK: "4000000000" }, W41), 1, "W41");
    assert.strictEqual(has({ ...q, ...on }, W41), 0);
    const weights = { EVEJS_LNE_FREE_CORPS_ARCHETYPE_WEIGHTS: "miner:20,structure:5" };
    assert.strictEqual(has({ ...on, ...weights }, "freeCorps.structures.enabled with structure"), 1, "W42");
    assert.strictEqual(has({ ...on, ...weights }, "freeCorps.archetypeWeights: structure"), 0, "no W5 with the flag");
    assert.strictEqual(has(weights, "freeCorps.archetypeWeights: structure"), 1, "W5 with the flag off");
    const W43 = "freeCorps.structures.targetStructureCorps without a lowsec / nullsec weight";
    assert.strictEqual(has({ ...q, ...on, EVEJS_LNE_FREE_CORPS_BAND_WEIGHTS: "highsec:100" }, W43), 1, "W43");
    assert.strictEqual(has({ ...q, ...on }, W43), 0);
  });
};
