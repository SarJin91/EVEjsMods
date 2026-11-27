"use strict";

const assert = require("node:assert");
const R = require("../../tools/measure/battleshipReport");
const { DOCTRINES_V1 } = require("../../lib/strategy/data/doctrines");
const { FACTIONS_V1 } = require("../../lib/strategy/data/factions");

const H = 3600000;
const DAY = 24 * H;

function segment(index, from) {
  return { index, startVirtualAt: from, stopVirtualAt: from + 15 * H,
    report: { startVirtualAt: from, stopVirtualAt: from + 15 * H, checks: { runs: 1, pass: 1, fail: 0, error: 0 } },
    telemetry: null, status: [{ scheduler: { passP95Ms: 4, latenessP95Ms: 1000 } }],
    logErrors: 0, logRowLimit: 0, logOverlayDropped: 0, exitCode: 0 };
}

function summary(patch = {}) {
  return { ok: true, windowMs: 60 * H, segments: 4, exitOk: true, checks: { runs: 4, pass: 4, fail: 0, error: 0 },
    logErrors: 0, logRowLimit: 0, logOverlayDropped: 0,
    logStrategyLine: "strategy: battleshipDoctrines=on calibrated=on garrisonOverlay=4",
    mobilized: { w1: 100, w2: 100 }, noHulls: { w1: 5, w2: 5 }, captures: 20, garrisonsByFaction: { 500010: 10 },
    pirateUnpaidStreak: {}, nativeAttacks: 10, fleetsPerInvasion: 2, passP95MsMedian: 5, latenessP95MsMedian: 2000,
    ...patch };
}

const ROLES = Object.freeze({ off: "off", noise: "noise", direct: "direct", ramp: "ramp" });
const OFF_LINE = null;

module.exports = ({ test }) => {
  test("BS1 summarize: windows w1/w2, unpaid streak, nativeAttacks, fleetsPerInvasion; native battleship factions",
    () => {
      const t0 = 10 * DAY;
      const days = [1, 2, 3, 4].map((n) => segment(n, t0 + (n - 1) * 15 * H));
      days[0].strategyLine = "strategy: battleshipDoctrines=on calibrated=on garrisonOverlay=4";
      const day0 = Math.floor(t0 / DAY);
      const s = R.summarize({ days, mobilizedBySeg: [10, 20, 30, 40], noHullsBySeg: [1, 2, 3, 4],
        battles: [
          { createdAt: t0 + H, objective: "capture", factionsB: [500019] },
          { createdAt: t0 + 2 * H, objective: "destroy", factionsB: [500003, 500019] },
          { createdAt: t0 + 3 * H, objective: "defend", factionsB: [500019] },
          { createdAt: t0 + 4 * H, objective: "capture", factionsB: [500003] },
          { createdAt: t0 - H, objective: "capture", factionsB: [500019] },
        ],
        captures: [{ capturedAt: t0 + H }, { capturedAt: t0 + 61 * H }],
        garrisonsByFaction: { 500019: 3, 500003: 4 },
        unpaidDays: [
          { factionId: 500010, kind: "pirate", day: day0, unpaid: 5 },
          { factionId: 500010, kind: "pirate", day: day0 + 1, unpaid: 7 },
          { factionId: 500010, kind: "pirate", day: day0 + 2, unpaid: 0 },
          { factionId: 500011, kind: "pirate", day: day0 + 2, unpaid: 1 },
          { factionId: 500003, kind: "empire", day: day0, unpaid: 9 },
          { factionId: 500003, kind: "empire", day: day0 + 1, unpaid: 9 },
        ],
        invasions: [{ factionId: 500019, fleets: 2, plannedAt: t0 + H }, { factionId: 500019, fleets: 4 },
          { factionId: 500019, fleets: 9, plannedAt: t0 + 70 * H }],
        nativeBsFactions: [500019] });
      assert.strictEqual(s.ok, true, JSON.stringify(s));
      assert.deepStrictEqual({ mobilized: s.mobilized, noHulls: s.noHulls, captures: s.captures,
        nativeAttacks: s.nativeAttacks, fleetsPerInvasion: s.fleetsPerInvasion, streak: s.pirateUnpaidStreak,
        garrisons: s.garrisonsByFaction, checks: s.checks, exitOk: s.exitOk, line: s.logStrategyLine }, {
        mobilized: { w1: 30, w2: 70 }, noHulls: { w1: 3, w2: 7 }, captures: 1, nativeAttacks: 2, fleetsPerInvasion: 3,
        streak: { 500010: 2, 500011: 1 }, garrisons: { 500003: 4, 500019: 3 },
        checks: { runs: 4, pass: 4, fail: 0, error: 0 }, exitOk: true,
        line: "strategy: battleshipDoctrines=on calibrated=on garrisonOverlay=4" });
      assert.deepStrictEqual(R.summarize({ days: [] }), { ok: false, reason: "INVALID_INPUT", detail: "days" });

      const native = R.nativeBattleshipFactions(DOCTRINES_V1, FACTIONS_V1);
      for (const doctrineId of ["sansha-incursion-v1", "triglavian-invader-v1", "sleeper-invader-v1"]) {
        const ids = FACTIONS_V1.filter((f) => f.doctrineId === doctrineId).map((f) => f.factionId);
        assert.ok(ids.length > 0, doctrineId);
        for (const id of ids) assert.ok(native.includes(id), `${doctrineId} ${id}`);
      }
      const empire = FACTIONS_V1.filter((f) => f.doctrineId === "empire-border-defense-v2").map((f) => f.factionId);
      assert.ok(empire.length > 0 && empire.every((id) => !native.includes(id)));
    });

  test("BS2 verdict: direct GO -> A; direct B2 w1 only + ramp GO -> B; native attacks doubled -> NO_GO", () => {
    const off = summary({ logStrategyLine: OFF_LINE });
    const noise = summary({ logStrategyLine: OFF_LINE, captures: 21, nativeAttacks: 11 });
    const a = R.verdict({ off, noise, direct: summary(), ramp: summary() }, ROLES);
    assert.deepStrictEqual([a.result, a.pmStep, a.variants.direct.verdict, a.variants.ramp.verdict],
      ["GO_A", "A", "GO", "GO"], JSON.stringify(a.variants.direct.gates));

    const slow = summary({ mobilized: { w1: 50, w2: 90 } });
    const b = R.verdict({ off, noise, direct: slow, ramp: summary({ mobilized: { w1: 40, w2: 95 } }) }, ROLES);
    assert.deepStrictEqual([b.result, b.pmStep, b.variants.direct.verdict, b.variants.ramp.verdict],
      ["GO_B", "B", "NO_GO", "GO"]);
    assert.ok(b.variants.direct.gates.B2.detail.some((d) => d.startsWith("FAIL mobilized.w1")));

    const doubled = summary({ nativeAttacks: 25 });
    const c = R.verdict({ off, noise, direct: doubled, ramp: doubled }, ROLES);
    assert.deepStrictEqual([c.result, c.pmStep, c.variants.direct.gates.B6.pass], ["NO_GO", null, false]);
    const noLine = R.verdict({ off, noise, direct: summary({ logStrategyLine: OFF_LINE }), ramp: summary() }, ROLES);
    assert.deepStrictEqual([noLine.result, noLine.variants.direct.gates.B1.pass], ["NO_GO", false]);
  });
};
