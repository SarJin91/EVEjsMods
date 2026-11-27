"use strict";

const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const P = require("../../lib/world/invasions/rollPlanner");
const { PROFILES } = require("../../lib/world/invasions/data/invaderProfiles");
const { createInvasionService } = require("../../lib/world/invasions/invasionService");
const { createRng } = require("../../lib/util/rng");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const TRIG = 500026;
const DEATHLESS = 500029;
const REGION_HOT = 10000001;
const REGION_COLD = 10000002;
const SYSTEMS = Array.from({ length: 8 }, (_, i) => 30000001 + i);
const regionOfSystem = (id) => (id <= 30000004 ? REGION_HOT : REGION_COLD);

const BASE = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir() } });

const entry = (systemId, attention) => ({ systemId, row: { occupationState: "STABLE", controllerFactionId: null },
  liveStations: 0, observed: false, claimed: false, inTheatre: false, openBeachhead: false, core: false,
  category: "free", ...(attention === undefined ? {} : { attention }) });
const PARAMS = { chancePermille: 1000, maxActive: 3, maxActivePerFaction: 1, weightFree: 3, weightActive: 5,
  weightControlled: 1, avoidObservedSystems: true, avoidStationSystems: true, avoidCampaignTheatres: true,
  requireSovCheck: false, beachheadCaptureRangeJumps: 3 };
const profileOf = (f) => ({ ...PROFILES.find((p) => p.factionId === f), eligible: true });
const snap = (profiles, sampled) => ({ round: 4, rollSeed: 9, sampleSeed: 10, openTotal: 0, openByFaction: new Map(),
  profiles, sampled, stationsReady: true });

function rig({ attention, getAbyssal }) {
  const counted = [];
  const c = BASE.config;
  const config = { ...c, invasions: { ...c.invasions, chancePermille: 1000, maxActivePerFaction: 3 },
    abyssal: { ...c.abyssal, enabled: attention, pressureEnabled: attention } };
  const registry = { getFaction: (f) => (f === TRIG ? { kind: "invader" } : null), isActive: (f) => f === TRIG,
    getDoctrine: () => null };
  const graph = { getSystemsBySecClass: (k) => (k === "nullsec" ? SYSTEMS : []),
    getSystem: (id) => (SYSTEMS.includes(id) ? { systemId: id, secClass: "nullsec", regionId: regionOfSystem(id) } : null) };
  const fakeTx = { prepare: () => ({ get: () => ({ c: 0 }), all: () => [] }) };
  const svc = createInvasionService({ config, coreIndex: { enabled: false, systems: new Map() },
    store: { transaction: (_n, fn) => ({ ok: true, value: fn(fakeTx) }) },
    repository: { getSystem: () => ({ ok: true, system: { occupationState: "STABLE", controllerFactionId: null } }) },
    graph: { getGraph: () => ({ ok: true, graph }) },
    stations: { getMode: () => "ready", repository: { countLiveBySystem: () => ({ ok: true, rows: [] }) } },
    sovClaims: { claimOf: () => ({ ok: true, claimed: false }) }, strategy: { registry },
    telemetry: { count: (name, n) => counted.push([name, n]) }, logger: { log() {} }, nowMs: () => 0, worldSeed: 5,
    getAbyssal });
  const roll = (round) => {
    const r = svc.rollHandlerFn({ payload: { round } }, { now: 0 });
    assert.ok(r.ok, JSON.stringify(r));
    r.onCommitted({ ok: true });
    return svc.getStatus().lastDecision;
  };
  return { svc, roll, counted };
}

module.exports = ({ test }) => {
  test("AP3 planRoll: off = today, Trig x2 on the attention system = hand computed pick2, Deathless unchanged", () => {
    const plain = [entry(30000001), entry(30000002), entry(30000003)];
    const marked = [entry(30000001, false), entry(30000002, true), entry(30000003, false)];
    const on = { ...PARAMS, attentionWeightPermille: 2000 };
    let changed = 0;
    for (const seed of [1, 2, 3, 7, 11, 19, 23, 41]) {
      const today = P.planRoll(snap([profileOf(TRIG)], plain), PARAMS, createRng(seed));
      assert.strictEqual(today.outcome, "SPAWN");
      assert.deepStrictEqual(P.planRoll(snap([profileOf(TRIG)], marked), PARAMS, createRng(seed)), today);
      assert.deepStrictEqual(P.planRoll(snap([profileOf(DEATHLESS)], marked), on, createRng(seed)),
        P.planRoll(snap([profileOf(DEATHLESS)], plain), PARAMS, createRng(seed)));
      const rng = createRng(seed);
      rng.nextInt(1, 1000);
      rng.nextInt(1, profileOf(TRIG).weight);
      const pick2 = rng.nextInt(1, 12);
      const expected = pick2 <= 3 ? 30000001 : pick2 <= 9 ? 30000002 : 30000003;
      const d = P.planRoll(snap([profileOf(TRIG)], marked), on, createRng(seed));
      assert.strictEqual(d.targetSystemId, expected, `seed ${seed} pick2 ${pick2}`);
      if (d.targetSystemId !== today.targetSystemId) changed += 1;
    }
    assert.ok(changed > 0, "the multiplier moves at least one decision");
    assert.strictEqual(P.targetWeight(entry(1, true), { ...on, weightFree: 3, attentionWeightPermille: 1500 },
      profileOf(TRIG)), 4);
    assert.strictEqual(P.targetWeight(entry(1, true), on), 3);
  });

  test("AP4 throwing attention facade -> roll without attention, attentionUnavailable 1, no throw; hot region boosts", () => {
    const off = rig({ attention: false, getAbyssal: () => { throw new Error("must not be read"); } });
    const broken = rig({ attention: true, getAbyssal: () => ({ topRegions: () => { throw new Error("boom"); } }) });
    const d = broken.roll(3);
    assert.deepStrictEqual(d, off.roll(3));
    assert.strictEqual(broken.svc.getStatus().counters.attentionUnavailable, 1);
    assert.strictEqual(broken.svc.getStatus().counters.attentionBoosted, 0);
    assert.ok(!("attentionUnavailable" in off.svc.getStatus().counters), "off: no attention counters");
    const threshold = BASE.config.abyssal.pressureThresholdMilli;
    const hot = rig({ attention: true, getAbyssal: () => ({ topRegions: (n) => {
      assert.strictEqual(n, 32);
      return { ok: true, atMs: 0, regions: [{ regionId: REGION_HOT, milli: threshold },
        { regionId: REGION_COLD, milli: threshold - 1 }] };
    } }) });
    let boosted = 0;
    for (let round = 1; round <= 12; round += 1) {
      const x = hot.roll(round);
      assert.strictEqual(x.factionId, TRIG);
      if (regionOfSystem(x.targetSystemId) === REGION_HOT) boosted += 1;
    }
    assert.ok(boosted > 0, "some Triglavian target in the hot region");
    assert.strictEqual(hot.svc.getStatus().counters.attentionBoosted, boosted);
    assert.strictEqual(hot.svc.getStatus().counters.attentionUnavailable, 0);
  });
};
