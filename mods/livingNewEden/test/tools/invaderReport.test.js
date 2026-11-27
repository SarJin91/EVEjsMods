"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { summarize, verdict, main } = require("../../tools/measure/invaderReport");

const H = 3600000;
const T0 = 1794000000000;
const HQ = 30002797;
const T = 500026;

function segment(index, start, stop) {
  return { index, startVirtualAt: start, stopVirtualAt: stop, report: { checks: { runs: 2, pass: 2, fail: 0, error: 0 } },
    telemetry: { channels: { strategy: { "invaderEconomy.triglavian.yieldIsk": index * 10,
      "invaderEconomy.homePoolMobilize": 2 } } }, status: [{ scheduler: { passP95Ms: 4, latenessP95Ms: 100 } }],
    logErrors: 0, logRowLimit: 0, invaderWarnings: 0, exitCode: 0 };
}

function faction(over = {}) {
  return { iskIncomePerDay: 1e10, iskBalanceEnd: 5e11, treasuryMode: "NORMAL", unitsDelta: 100, fleetsEnd: 20,
    fleetsEndByRole: {}, poolFleetsEnd: 0, fleetsInHqEnd: 2, fleetsCreatedPerDay: 2,
    invasionsPerDay: { conduit: 0, roll: 0.3 }, reviewInvasionsPerDay: 0, raidsPerDay: 0, capturesPerDay: 0,
    openRaidsEnd: 0, openConduitEnd: 0, conduitSpawnsMaxPerUtcDay: 0, conduitOutcomes: {},
    notes: { INVADER_RAIDS_NO_FOOTHOLDS: 0, RAID_FRONT_LIMIT: 0, INSUFFICIENT_RESOURCES: 0,
      INVADER_HOME_POOL_FULL: 0, NO_TEMPLATE: 0 }, frontLimit: 1,
    counts: { invasions: 1, conduit: 0, roll: 1, reviewInvasions: 0, raids: 0, captures: 0, fleetsCreated: 4 },
    ...over };
}

function summary(target = {}, other = {}, top = {}) {
  return { ok: true, hours: 45, segments: 3, exitOk: true, checks: { runs: 3, pass: 3, fail: 0, error: 0 },
    logErrors: 1, logRowLimit: 0, invaderWarnings: 0, logMissing: [], passP95MsMedian: 5, latenessP95MsMedian: 1000,
    yieldIskLast: null, yieldUnitsLast: null, telemetry: { homePoolMobilize: 0, raidFrontLimit: 0, insufficientResources: 0 },
    factions: { [T]: faction(target), 500029: faction({ counts: { ...faction().counts, invasions: 6 }, ...other }),
      500021: faction({ counts: { ...faction().counts, invasions: 4 } }) }, ...top };
}

const ROLES = { base: "off7", noise: "off8", yield: "yield", pool: "pool", raid: "raid" };

function goSummaries() {
  const on = { iskIncomePerDay: 2e10, unitsDelta: 300 };
  const pool = { ...on, fleetsEnd: 28, poolFleetsEnd: 5, fleetsCreatedPerDay: 4,
    invasionsPerDay: { conduit: 1, roll: 0.3 }, openConduitEnd: 1, conduitSpawnsMaxPerUtcDay: 1,
    counts: { ...faction().counts, invasions: 3 } };
  const yieldTop = { yieldIskLast: 1.6e10, yieldUnitsLast: 135 };
  return { off7: summary(), off8: summary(), yield: summary(on, {}, yieldTop), pool: summary(pool, {}, yieldTop),
    raid: summary({ ...pool, raidsPerDay: 1.5, openRaidsEnd: 2, frontLimit: 3 }, {}, yieldTop) };
}

module.exports = ({ test }) => {
  test("IRP1 summarize: window, conduit vs roll, per day from hours, deltas vs seed, pool fleets, notes", () => {
    const days = [segment(2, T0 + 12 * H, T0 + 24 * H), segment(1, T0, T0 + 12 * H)];
    const fleetsEnd = [
      { factionId: T, role: "garrison", state: "IDLE", homeSystemId: HQ, systemId: HQ },
      { factionId: T, role: "garrison", state: "IDLE", homeSystemId: 1, systemId: HQ },
      { factionId: T, role: "garrison", state: "IDLE", homeSystemId: HQ, systemId: 2 },
      { factionId: T, role: "invasion", state: "STAGED", homeSystemId: HQ, systemId: 3 },
      { factionId: T, role: "garrison", state: "DESTROYED", homeSystemId: HQ, systemId: HQ },
      { factionId: 500029, role: "invasion", state: "IDLE", homeSystemId: null, systemId: 4 },
    ];
    const s = summarize({
      days,
      seed: { treasury: { [T]: { iskBalance: 1e11, incomeTotal: 1e12 } }, resourceUnits: { [T]: 50 } },
      end: { treasury: { [T]: { iskBalance: 3e11, incomeTotal: 1e12 + 4e10, mode: "NORMAL" } },
        resourceUnits: { [T]: 80 }, frontLimit: { [T]: 3 } },
      fleetsEnd,
      fleetsCreated: [{ factionId: T, createdAt: T0 + H }, { factionId: T, createdAt: T0 - 1 },
        { factionId: 500029, createdAt: T0 + 2 * H }],
      invasions: [
        { factionId: T, invasionId: "inv-c-5", startedAt: T0 + H, open: true },
        { factionId: T, invasionId: "inv-c-6", startedAt: T0 + 2 * H, open: false },
        { factionId: T, invasionId: "inv-7", startedAt: T0 + 13 * H, open: true },
        { factionId: T, invasionId: "inv-c-1", startedAt: T0 - H, open: true },
        { factionId: T, invasionId: "inv-c-9", startedAt: T0 + 24 * H, open: false },
      ],
      operations: [
        { factionId: T, operationType: "raid", plannedAt: T0 + 3 * H, state: "ACTIVE" },
        { factionId: T, operationType: "raid", plannedAt: T0 - H, state: "PLANNED" },
        { factionId: T, operationType: "raid", plannedAt: T0 + 4 * H, state: "COMPLETED" },
        { factionId: T, operationType: "invasion", plannedAt: T0 + 5 * H, state: "COMPLETED" },
        { factionId: T, operationType: "gank", plannedAt: T0 + 6 * H, state: "ACTIVE" },
      ],
      conduitRolls: [{ factionId: T, createdAt: T0 + H, outcome: "SPAWN" },
        { factionId: T, createdAt: T0 + 3 * H, outcome: "NO_ROLL" }, { factionId: T, createdAt: T0 - H, outcome: "NO_ROLL" }],
      captures: [{ controllerFactionId: T, capturedAt: T0 + 6 * H }, { controllerFactionId: T, capturedAt: T0 + 30 * H }],
      notes: { [T]: { RAID_FRONT_LIMIT: 3 } },
    }, { hqSystemId: HQ });
    assert.strictEqual(s.ok, true, JSON.stringify(s));
    assert.deepStrictEqual([s.hours, s.segments, s.exitOk, s.checks], [24, 2, true, { runs: 4, pass: 4, fail: 0, error: 0 }]);
    assert.deepStrictEqual([s.yieldIskLast, s.yieldUnitsLast, s.telemetry.homePoolMobilize], [20, 0, 4]);
    const t = s.factions[T];
    assert.deepStrictEqual([t.iskIncomePerDay, t.iskBalanceEnd, t.unitsDelta, t.frontLimit], [4e10, 3e11, 30, 3]);
    assert.deepStrictEqual([t.fleetsEnd, t.poolFleetsEnd, t.fleetsInHqEnd, t.fleetsEndByRole],
      [4, 1, 2, { garrison: 3, invasion: 1 }]);
    assert.deepStrictEqual([t.fleetsCreatedPerDay, t.invasionsPerDay, t.reviewInvasionsPerDay, t.raidsPerDay],
      [1, { conduit: 2, roll: 1 }, 1, 2]);
    assert.deepStrictEqual([t.openRaidsEnd, t.openConduitEnd, t.conduitSpawnsMaxPerUtcDay, t.capturesPerDay],
      [2, 2, 2, 1]);
    assert.deepStrictEqual([t.ganksPerDay, t.counts.ganks], [1, 1]);
    assert.deepStrictEqual(t.conduitOutcomes, { SPAWN: 1, NO_ROLL: 1 });
    assert.deepStrictEqual([t.notes.RAID_FRONT_LIMIT, t.notes.NO_TEMPLATE], [3, 0]);
    assert.strictEqual(t.counts.invasions, 4);
    assert.deepStrictEqual([s.factions[500029].fleetsEnd, s.factions[500029].iskIncomePerDay], [1, null]);
  });

  test("IRP2 verdict: (a) both GO; (b) raids 0 + RAID_FRONT_LIMIT -> B NO_GO, maxRaidFronts 3; (c) harm -> null", () => {
    const a = verdict(goSummaries(), ROLES);
    assert.deepStrictEqual([a.phaseA, a.phaseB, a.calibration], ["GO", "GO", null], JSON.stringify(a.gates));

    const b = goSummaries();
    b.raid = summary({ ...b.raid.factions[T], raidsPerDay: 0, openRaidsEnd: 0,
      notes: { ...faction().notes, RAID_FRONT_LIMIT: 4 } }, {}, { yieldIskLast: 1, yieldUnitsLast: 1 });
    const vb = verdict(b, ROLES);
    assert.deepStrictEqual([vb.phaseA, vb.phaseB], ["GO", "NO_GO"], JSON.stringify(vb.gates.I2));
    assert.deepStrictEqual(vb.calibration && vb.calibration.set, { maxRaidFronts: 3 });
    const g = goSummaries();
    g.raid = summary({ ...g.raid.factions[T], raidsPerDay: 0, ganksPerDay: 3 }, {}, { yieldIskLast: 1, yieldUnitsLast: 1 });
    assert.strictEqual(verdict(g, ROLES).phaseB, "GO", JSON.stringify(verdict(g, ROLES).gates.I2));

    const c = goSummaries();
    c.pool.factions[500029] = faction({ counts: { ...faction().counts, invasions: 0 } });
    const vc = verdict(c, ROLES);
    assert.deepStrictEqual([vc.phaseA, vc.phaseB, vc.gates.I3.pass, vc.calibration], ["NO_GO", "NO_GO", false, null]);
  });

  test("IRP4: a segment without its log -> logMissing [segN], I1 fails, phase A NO_GO; no field -> fail closed", () => {
    const days = [segment(1, T0, T0 + 12 * H), { ...segment(2, T0 + 12 * H, T0 + 24 * H), logMissing: true }];
    const s = summarize({ days, seed: {}, end: {}, fleetsEnd: [], fleetsCreated: [], invasions: [], operations: [],
      conduitRolls: [], captures: [], notes: {} }, { hqSystemId: HQ });
    assert.deepStrictEqual([s.ok, s.logErrors, s.logMissing], [true, 0, ["seg2"]]);

    const m = goSummaries();
    m.pool = { ...m.pool, logMissing: ["seg2"] };
    const vm = verdict(m, ROLES);
    assert.deepStrictEqual([vm.phaseA, vm.gates.I1.pass], ["NO_GO", false], JSON.stringify(vm.gates.I1));
    assert.ok(vm.gates.I1.detail.some((l) => l.includes("logMissing: [seg2]")), vm.gates.I1.detail.join("\n"));

    const { logMissing: _drop, ...older } = goSummaries().pool;
    const o = goSummaries();
    o.pool = older;
    assert.strictEqual(verdict(o, ROLES).phaseA, "NO_GO");
  });

  test("IRP3 CLI: empty directory -> exit 1 one line; unknown argument -> exit 1", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lne-irp3-"));
    try {
      const lines = [];
      const io = { out: () => {}, err: (s) => lines.push(s) };
      const args = ["--seed", dir, "--variant", `off7=${dir}`, "--base", "off7", "--noise", "off7", "--yield", "off7",
        "--pool", "off7", "--raid", "off7"];
      assert.strictEqual(main(args, io), 1);
      assert.strictEqual(lines.length, 1, lines.join("\n"));
      assert.ok(!lines[0].includes("\n"));
      const l2 = [];
      assert.strictEqual(main([...args, "--bogus", "x"], { out: () => {}, err: (s) => l2.push(s) }), 1);
      assert.ok(l2.length === 1 && l2[0].includes("unknown argument --bogus"), l2.join("\n"));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
};
