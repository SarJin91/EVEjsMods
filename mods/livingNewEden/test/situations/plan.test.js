"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const S = require("../../lib/situations/schema");
const { CATALOG } = require("../../lib/situations/catalog");
const { rollSituation, decideStep, helpersOf, isTransition, eligibleKinds, pickKind } =
  require("../../lib/situations/plan");
const { deriveSeed } = require("../../lib/util/rng");
const { renderLine, MAX_LINE, SETS } = require("../../lib/situations/lines");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SYS = 30000144;

function settings(over) {
  const r = resolveConfig({ modDir: MOD_DIR, env: {} });
  const parsed = S.situationsSettingsOf({ situations: { ...r.config.situations, ...(over || {}) } });
  assert.ok(parsed.ok, JSON.stringify(parsed));
  return parsed.settings;
}

const ANCHORS = { belts: [{ itemId: 40001, position: { x: 0, y: 0, z: 0 } }, { itemId: 40002,
  position: { x: 1, y: 0, z: 0 } }], gates: [] };

module.exports = ({ test }) => {
  test("SI1 rollSituation deterministic per (seed, system, bucket); decideStep follows the state table", () => {
    const P = settings({ chancePermille: 1000 });
    const seed = deriveSeed(7, S.RNG_STREAM, SYS, 490000);
    const input = { seed, systemId: SYS, bucket: 490000, secClass: "highsec", anchors: ANCHORS, catalog: CATALOG };
    const a = rollSituation(input, P);
    assert.deepStrictEqual(rollSituation(input, P), a, "same seed, same roll");
    assert.strictEqual(a.roll, true);
    assert.strictEqual(a.kind, "BELT_RAID");
    assert.ok(a.victims >= 2 && a.victims <= 3 && a.pirates.length >= 2 && a.pirates.length <= 3, JSON.stringify(a));
    assert.ok(a.victims + a.pirates.length <= P.maxShipsPerSituation);
    assert.ok(a.pirates.every((p) => ["frigate", "destroyer"].includes(p.hullGroup)));
    assert.deepStrictEqual(rollSituation({ ...input, anchors: { belts: [] } }, P), { roll: false, reason: "NO_ANCHOR" });
    assert.deepStrictEqual(rollSituation({ ...input, secClass: "nullsec" }, P), { roll: false, reason: "NO_BAND" });
    const D = settings();
    let hits = 0;
    for (let b = 0; b < 2000; b += 1) {
      if (rollSituation({ ...input, seed: deriveSeed(7, S.RNG_STREAM, SYS, b), bucket: b }, D).roll) hits += 1;
    }
    assert.ok(hits > 230 && hits < 370, `hits ${hits}`);

    const T0 = 1000000;
    const calling = { phase: "CALLING", callingSince: T0, lastDistressAt: T0, distressSent: 1, engaged: false,
      absentSince: null };
    const base = { now: T0 + 1000, playersOnGrid: 0, sceneLoaded: true, victimsAlive: 2, piratesAlive: 0,
      pirateKillsByPlayers: 0, aggressors: 0, victimDied: false };
    assert.deepStrictEqual(decideStep(calling, base, D), { action: "NOOP" });
    assert.deepStrictEqual(decideStep(calling, { ...base, now: T0 + D.distressRepeatMs }, D), { action: "DISTRESS" });
    assert.deepStrictEqual(decideStep({ ...calling, distressSent: D.distressLines },
      { ...base, now: T0 + D.distressRepeatMs }, D), { action: "NOOP" }, "no line over distressLines");
    assert.deepStrictEqual(decideStep(calling, { ...base, playersOnGrid: 1 }, D), { action: "SPAWN_PIRATES" });
    assert.deepStrictEqual(decideStep(calling, { ...base, now: T0 + D.callingTimeoutMs }, D),
      { action: "RESOLVE", outcome: "UNANSWERED", reason: "TIMEOUT" });
    assert.deepStrictEqual(decideStep(calling, { ...base, sceneLoaded: false }, D),
      { action: "RESOLVE", outcome: "ABANDONED", reason: "SCENE_GONE" });

    const fight = { phase: "FIGHT", fightSince: T0, engaged: true, absentSince: null };
    const f = { ...base, playersOnGrid: 1, piratesAlive: 2 };
    assert.deepStrictEqual(decideStep({ ...fight, engaged: false }, f, D), { action: "ENGAGE" });
    assert.deepStrictEqual(decideStep(fight, f, D), { action: "NOOP" });
    assert.deepStrictEqual(decideStep(fight, { ...f, victimDied: true }, D), { action: "RETARGET" });
    assert.deepStrictEqual(decideStep(fight, { ...f, aggressors: 1 }, D), { action: "RETARGET" });
    assert.deepStrictEqual(decideStep(fight, { ...f, piratesAlive: 0, pirateKillsByPlayers: 1 }, D),
      { action: "RESOLVE", outcome: "RESCUED", reason: "PIRATES_DOWN" });
    assert.deepStrictEqual(decideStep(fight, { ...f, piratesAlive: 0 }, D),
      { action: "RESOLVE", outcome: "ABANDONED", reason: "NO_PLAYER_KILL" });
    assert.deepStrictEqual(decideStep(fight, { ...f, victimsAlive: 0 }, D),
      { action: "RESOLVE", outcome: "LOST", reason: "VICTIMS_GONE" });
    assert.deepStrictEqual(decideStep({ ...fight, absentSince: T0 }, { ...f, now: T0 + D.abandonGraceMs }, D),
      { action: "RESOLVE", outcome: "ABANDONED", reason: "NO_PLAYER" });
    assert.deepStrictEqual(decideStep(fight, { ...f, now: T0 + D.maxFightMs }, D),
      { action: "RESOLVE", outcome: "ABANDONED", reason: "FIGHT_TIMEOUT" });
    for (const to of ["UNANSWERED", "ABANDONED", "FIGHT"]) assert.ok(isTransition("CALLING", to), to);
    for (const to of ["RESCUED", "LOST", "ABANDONED"]) assert.ok(isTransition("FIGHT", to), to);
    assert.strictEqual(isTransition("CALLING", "RESCUED"), true);
    assert.strictEqual(isTransition("CALLING", "LOST"), false);

    assert.deepStrictEqual(helpersOf({ aggressors: new Set([9, 3]), killers: new Set([5, 3]), excluded: new Set([9]) },
      D), { characterIds: [3, 5] });
    assert.strictEqual(helpersOf({ aggressors: [1, 2, 3, 4, 5, 6, 7], killers: [], excluded: [] }, D)
      .characterIds.length, D.maxHelpers);
    for (const set of Object.keys(SETS)) {
      for (let i = 0; i < SETS[set].length; i += 1) {
        const line = renderLine(set, i, { belt: "Jita IV - Asteroid Belt 1", system: "Jita" });
        assert.ok(line.ok && line.text.length <= MAX_LINE && /^[\x20-\x7e]+$/.test(line.text), line.text);
        assert.ok(!line.text.includes("{"), line.text);
      }
    }
  });

  test("SC4a kind pick: defaults = BELT_RAID only and the roll of bit for bit; pickKind 1 kind no draw, 3 kinds "
    + "deterministic; GATE_AMBUSH anchors on hotGates (none -> not eligible); STRANDED_POD victims 1, pirates []", () => {
    const D = settings({ chancePermille: 1000 });
    const flags = settings({ chancePermille: 1000, gateAmbushEnabled: true, strandedPodEnabled: true });
    const hotGates = [{ itemId: 50001, position: { x: 9, y: 0, z: 0 }, name: "Stargate (Perimeter)" }];
    const def = eligibleKinds({ settings: D, beltCount: 2, hotGateCount: 1, podProfile: true, podKindOff: false });
    assert.deepStrictEqual(def, [{ kind: "BELT_RAID", weight: 2 }]);
    assert.strictEqual(pickKind(def, 0), "BELT_RAID", "one kind: no draw (any seed)");
    assert.deepStrictEqual(pickKind([], 1), null);
    for (let b = 0; b < 50; b += 1) {
      const seed = deriveSeed(7, S.RNG_STREAM, SYS, b);
      const old = rollSituation({ seed, systemId: SYS, bucket: b, secClass: "highsec", anchors: ANCHORS,
        catalog: CATALOG }, D);
      const now = rollSituation({ seed, systemId: SYS, bucket: b, secClass: "highsec", kind: pickKind(def, 0),
        anchors: { belts: ANCHORS.belts, hotGates }, catalog: CATALOG }, D);
      assert.deepStrictEqual(now, old, `bucket ${b}`);
    }
    const all = eligibleKinds({ settings: flags, beltCount: 2, hotGateCount: 1, podProfile: true, podKindOff: false });
    assert.deepStrictEqual(all.map((e) => e.kind), ["BELT_RAID", "GATE_AMBUSH", "STRANDED_POD"]);
    const seen = new Set();
    for (let b = 0; b < 300; b += 1) {
      const ks = deriveSeed(7, S.RNG_KIND_STREAM, SYS, b);
      assert.strictEqual(pickKind(all, ks), pickKind(all, ks));
      seen.add(pickKind(all, ks));
    }
    assert.deepStrictEqual([...seen].sort(), ["BELT_RAID", "GATE_AMBUSH", "STRANDED_POD"]);
    assert.deepStrictEqual(eligibleKinds({ settings: flags, beltCount: 2, hotGateCount: 0, podProfile: false,
      podKindOff: false }).map((e) => e.kind), ["BELT_RAID"], "no hot gate, no capsule profile");
    assert.deepStrictEqual(eligibleKinds({ settings: flags, beltCount: 0, hotGateCount: 1, podProfile: true,
      podKindOff: true }).map((e) => e.kind), ["GATE_AMBUSH"], "no belt, pod kind off");
    const seed = deriveSeed(7, S.RNG_STREAM, SYS, 490000);
    const input = { seed, systemId: SYS, bucket: 490000, secClass: "highsec", catalog: CATALOG,
      anchors: { belts: ANCHORS.belts, hotGates } };
    const raid = rollSituation(input, flags);
    const gate = rollSituation({ ...input, kind: "GATE_AMBUSH" }, flags);
    assert.deepStrictEqual([gate.kind, gate.anchorIndex, gate.victims, gate.pirates.length],
      ["GATE_AMBUSH", 0, raid.victims, raid.pirates.length]);
    assert.deepStrictEqual(rollSituation({ ...input, kind: "GATE_AMBUSH", anchors: { belts: ANCHORS.belts,
      hotGates: [] } }, flags), { roll: false, reason: "NO_ANCHOR" });
    const pod = rollSituation({ ...input, kind: "STRANDED_POD" }, flags);
    assert.deepStrictEqual([pod.kind, pod.victims, pod.pirates, pod.anchorIndex, pod.speakerPick, pod.victimPicks],
      ["STRANDED_POD", 1, [], raid.anchorIndex, raid.speakerPick, raid.victimPicks.slice(0, 1)]);
    assert.deepStrictEqual(rollSituation({ ...input, kind: null, anchors: { belts: [] } }, flags),
      { roll: false, reason: "NO_ANCHOR" });
  });

  test("SC4b STRANDED_POD decideStep: hold rescueHoldMs -> RESCUED PICKED_UP, before -> NOOP, reset hold -> no "
    + "RESCUED, timeout -> UNANSWERED; helpersOf takes the rescuers without the excluded", () => {
    const P = settings({ strandedPodEnabled: true });
    const T0 = 2000000;
    const pod = { kind: "STRANDED_POD", phase: "CALLING", callingSince: T0, lastDistressAt: T0, distressSent: 1,
      rescueSince: T0 + 1000 };
    const f = { now: T0 + 1000 + P.rescueHoldMs, sceneLoaded: true, victimsAlive: 1, playersOnGrid: 1,
      rescuersInRange: 1 };
    assert.deepStrictEqual(decideStep(pod, f, P), { action: "RESOLVE", outcome: "RESCUED", reason: "PICKED_UP" });
    assert.deepStrictEqual(decideStep(pod, { ...f, now: f.now - 1 }, P), { action: "NOOP" }, "before the hold");
    assert.deepStrictEqual(decideStep({ ...pod, rescueSince: null }, { ...f, rescuersInRange: 0 }, P),
      { action: "NOOP" });
    assert.deepStrictEqual(decideStep({ ...pod, rescueSince: null }, { ...f, rescuersInRange: 0,
      now: T0 + P.callingTimeoutMs }, P), { action: "RESOLVE", outcome: "UNANSWERED", reason: "TIMEOUT" });
    assert.deepStrictEqual(decideStep(pod, { ...f, victimsAlive: 0 }, P),
      { action: "RESOLVE", outcome: "ABANDONED", reason: "VICTIMS_GONE" }, "the capsule was shot");
    assert.deepStrictEqual(decideStep({ ...pod, rescueSince: null }, { ...f, rescuersInRange: 0, playersOnGrid: 1 },
      P), { action: "NOOP" }, "a player near the belt calls no pirates");
    assert.deepStrictEqual(helpersOf({ aggressors: [], killers: [], rescuers: new Set([8, 4]), excluded: new Set([8]) },
      P), { characterIds: [4] });
  });
};
