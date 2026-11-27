"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const { createNoiseTracker } = require("../../lib/miningEncounters/noise");
const { planWave } = require("../../lib/miningEncounters/wavePlan");
const { startMiningEncounters } = require("../../lib/miningEncounters/index");
const { DEFAULT_SECURITY_BANDS, parseSecurityBands,
  selectSecurityBand } = require("../../lib/miningEncounters/securityBands");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const DEFAULTS = resolveConfig({ modDir: MOD_DIR, env: {} }).config.miningEncounters;

function cfg(over = {}) {
  return { ...DEFAULTS, ...over };
}

function seq(...values) {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}

const ME = (characterId, systemId, band, atMs) => ({ characterId, systemId, band, atMs });

function driveToDue(tracker, ev, stepMs, maxSteps = 50) {
  let t = ev.atMs;
  for (let i = 0; i < maxSteps; i += 1, t += stepMs) {
    const r = tracker.noteEvent({ ...ev, atMs: t });
    assert.strictEqual(r.ok, true);
    if (r.due) return t;
  }
  throw new Error("never DUE");
}

module.exports = ({ test }) => {
  test("ME1 planWave: escalation 1/3/5 -> (3,5) (5,7) (7,8); officer-only weights -> full chain; specials off -> []",
    () => {
      const S = cfg({ growthPerWave: 1, maxShipsPerWave: 8 });
      const sizes = [1, 3, 5].map((waveNumber) => {
        const p = planWave({ waveNumber, baseMin: 3, baseMax: 5, config: S, rng: seq(0.99),
          vendorSpecialsEnabled: true });
        return [p.minCount, p.maxCount, p.specialChain.length];
      });
      assert.deepStrictEqual(sizes, [[3, 5, 0], [5, 7, 0], [7, 8, 0]]);
      const officer = cfg({ specialWeightHauler: 0, specialWeightCommander: 0, specialWeightOfficer: 3 });
      const hit = planWave({ waveNumber: 3, baseMin: 3, baseMax: 5, config: officer, rng: seq(0, 0.5),
        vendorSpecialsEnabled: true });
      assert.deepStrictEqual(hit.specialChain, ["officer", "commander", "hauler"]);
      assert.deepStrictEqual(planWave({ waveNumber: 1, baseMin: 3, baseMax: 5, config: officer, rng: seq(0),
        vendorSpecialsEnabled: true }).specialChain, []);
      assert.deepStrictEqual(planWave({ waveNumber: 3, baseMin: 3, baseMax: 5, config: officer, rng: seq(0, 0.5),
        vendorSpecialsEnabled: false }).specialChain, []);
      assert.deepStrictEqual(planWave({ waveNumber: 3, baseMin: 3, baseMax: 5, config: cfg(), rng: seq(0, 0.99),
        vendorSpecialsEnabled: true }).specialChain, ["hauler"]);
    });

  test("ME2 noise machine: CAPPED per minute, threshold -> DUE, spawned -> QUIET 1 wave, maxWaves -> EXHAUSTED, "
    + "idle reset -> QUIET 0", () => {
    const S = cfg({ noisePerEvent: 2, maxNoisePerMinute: 3, threshold: 6, waveCooldownMs: 30000, maxWaves: 2,
      chanceLowsec: 0.6 });
    const tracker = createNoiseTracker({ config: S, rng: seq(0) });
    const t0 = 1000000;
    const r = [0, 20000, 40000, 60000, 80000].map((dt) => tracker.noteEvent(ME(7, 30002, "lowsec", t0 + dt)));
    assert.deepStrictEqual(r.map((x) => [x.added, x.due, x.reason || null]),
      [[2, false, null], [1, false, null], [0, false, "CAPPED"], [2, false, null], [1, true, null]]);
    const key = r[4].key;
    assert.strictEqual(tracker.peek(key).state, "DUE");
    assert.deepStrictEqual(tracker.takeDue(5).map((d) => [d.key, d.band]), [[key, "lowsec"]]);
    assert.deepStrictEqual(tracker.prepare(key, { beltId: 100, atMs: t0 + 80000 }), { ok: true, waveNumber: 1 });
    assert.strictEqual(tracker.settle(key, "spawned", { atMs: t0 + 80000 }).ok, true);
    let e = tracker.peek(key);
    assert.deepStrictEqual([e.state, e.wavesSpawned, e.noise], ["QUIET", 1, 0]);
    const t2 = driveToDue(tracker, ME(7, 30002, "lowsec", t0 + 100000), 20000);
    assert.ok(t2 - (t0 + 80000) >= 30000, "cooldown respected");
    assert.deepStrictEqual(tracker.prepare(key, { beltId: 100, atMs: t2 }), { ok: true, waveNumber: 2 });
    tracker.settle(key, "spawned", { atMs: t2 });
    assert.strictEqual(tracker.peek(key).state, "EXHAUSTED");
    assert.strictEqual(tracker.noteEvent(ME(7, 30002, "lowsec", t2 + 20000)).reason, "EXHAUSTED");
    assert.deepStrictEqual(tracker.settle(key, "spawned", { atMs: t2 }), { ok: false, reason: "NOT_DUE" });
    tracker.noteEvent(ME(7, 30002, "lowsec", t2 + 20000 + S.idleResetMs + 1));
    e = tracker.peek(key);
    assert.deepStrictEqual([e.state, e.wavesSpawned, e.beltId], ["QUIET", 0, null]);
    assert.deepStrictEqual(tracker.prepare("1:1", { beltId: 1 }), { ok: false, reason: "UNKNOWN_KEY" });
    assert.deepStrictEqual(tracker.noteEvent({ characterId: 0, systemId: 1, band: "lowsec", atMs: 1 }),
      { ok: false, reason: "BAD_EVENT" });
  });

  test("ME3 belt change resets the escalation; deferred keeps the noise (DUE at once), refused drops it", () => {
    const S = cfg({ noisePerEvent: 3, maxNoisePerMinute: 3, threshold: 6, waveCooldownMs: 30000, maxWaves: 5 });
    let roll = 0;
    const tracker = createNoiseTracker({ config: S, rng: () => roll });
    const ev = ME(9, 30003, "nullsec", 2000000);
    let t = driveToDue(tracker, ev, 20000);
    const key = "9:30003";
    assert.strictEqual(tracker.prepare(key, { beltId: 100, atMs: t }).waveNumber, 1);
    tracker.settle(key, "spawned", { atMs: t });
    t = driveToDue(tracker, { ...ev, atMs: t + 40000 }, 20000);
    assert.strictEqual(tracker.prepare(key, { beltId: 200, atMs: t }).waveNumber, 1, "another belt = wave 1");
    tracker.settle(key, "deferred", { atMs: t });
    assert.ok(tracker.peek(key).noise >= S.threshold, "deferred keeps the noise");
    roll = 0.99;
    const next = tracker.noteEvent({ ...ev, atMs: t + 1000 });
    assert.deepStrictEqual([next.due, next.added], [true, 0], "DUE at once, the minute ceiling already full");
    tracker.settle(key, "refused", { atMs: t + 1000 });
    const e = tracker.peek(key);
    assert.deepStrictEqual([e.state, e.noise], ["QUIET", 0]);
    assert.strictEqual(tracker.status().dueQueue, 0);
  });

  test("ME4 service on a fake seam: HIGHSEC_OFF before locate, one defer for two DUE, GOVERNOR, BELT_BUSY, wave, "
    + "security band scales the counts", () => {
    const calls = { locate: 0, bandOf: 0, spawn: [] };
    const busy = new Set();
    const bands = {
      30001: { ok: true, band: "highsec", eligible: true, baseMin: 1, baseMax: 2, security: 0.9 },
      30002: { ok: true, band: "lowsec", eligible: true, baseMin: 2, baseMax: 4, security: 0.3 },
    };
    const seam = {
      bandOf: (id) => { calls.bandOf += 1; return bands[id] || { ok: false, reason: "READ_FAILED" }; },
      locate: ({ characterId }) => { calls.locate += 1;
        return { ok: true, beltId: 500 + characterId, shipId: 900 + characterId,
          groupsOnBelt: busy.has(characterId) ? 1 : 0, groupsInSystem: 0 }; },
      spawnWave: (args) => { calls.spawn.push(args); return { ok: true, kind: "normal", ships: args.minCount,
        degraded: false }; },
      readVendorBeltFlags: () => ({ ok: true, ratsEnabled: true, specialsEnabled: false }),
    };
    const deferred = [];
    const counts = new Map();
    const telemetry = { count: (name, n) => counts.set(name, (counts.get(name) || 0) + n), observe() {} };
    let admits = false;
    const governor = { admits: (cls) => { assert.strictEqual(cls, "OPERATIONAL"); return admits; } };
    let now = 5000000;
    const started = startMiningEncounters({ config: { miningEncounters: cfg({ enabled: true, highsecEnabled: false,
      threshold: 1, noisePerEvent: 1 }) }, clock: { now: () => now }, telemetry, seam, rng: seq(0),
      getGovernor: () => governor, defer: (fn) => deferred.push(fn) });
    assert.strictEqual(started.ok, true);
    const enc = started.encounters;

    enc.onLedgerEvent({ characterId: 1, systemId: 30001, atMs: now });
    assert.deepStrictEqual([counts.get("world.miningEncounters.refused.HIGHSEC_OFF"), calls.locate, deferred.length],
      [1, 0, 0]);
    enc.onLedgerEvent({ characterId: 1, systemId: 30002, atMs: now });
    enc.onLedgerEvent({ characterId: 2, systemId: 30002, atMs: now });
    assert.strictEqual(deferred.length, 1, "two DUE, one defer");
    assert.strictEqual(calls.bandOf, 2, "bandOf once per system");
    deferred.shift()();
    assert.strictEqual(counts.get("world.miningEncounters.deferred.GOVERNOR"), 2);
    assert.strictEqual(calls.locate, 0);

    admits = true;
    busy.add(1);
    now += 1000;
    enc.onLedgerEvent({ characterId: 1, systemId: 30002, atMs: now });
    enc.onLedgerEvent({ characterId: 2, systemId: 30002, atMs: now });
    assert.strictEqual(deferred.length, 1);
    const out = enc.flushNow();
    assert.deepStrictEqual([out.spawned, out.deferred, out.refused], [1, 1, 0]);
    assert.strictEqual(counts.get("world.miningEncounters.deferred.BELT_BUSY"), 1);
    assert.strictEqual(counts.get("world.miningEncounters.wave"), 1);
    assert.deepStrictEqual(calls.spawn.map((a) => [a.characterId, a.beltId, a.minCount, a.maxCount, a.specialChain]),
      [[2, 502, 3, 6, []]]);
    deferred.shift()();
    enc.stop("test");
    enc.onLedgerEvent({ characterId: 3, systemId: 30002, atMs: now });
    assert.strictEqual(enc.getStatus().tracked, 0);
    assert.deepStrictEqual(startMiningEncounters({ config: { miningEncounters: cfg() }, seam }),
      { ok: false, reason: "disabled_by_config" });
    assert.deepStrictEqual(startMiningEncounters({ config: { miningEncounters: cfg({ enabled: true }) },
      seam: { bandOf() {} } }), { ok: false, reason: "SEAM_UNAVAILABLE" });
  });

  test("ME5 config: defaults, clamp, specialChanceBase > specialChanceMax warning, bad securityBands ignored", () => {
    const r = resolveConfig({ modDir: MOD_DIR, env: {} });
    assert.strictEqual(r.ok, true);
    const me = r.config.miningEncounters;
    assert.deepStrictEqual([me.enabled, me.highsecEnabled, me.threshold, me.chanceNullsec, me.maxWaves,
      me.specialWeightOfficer, me.maxSpawnsPerFlush, me.securityBands],
    [false, true, 12, 0.75, 5, 3, 2, DEFAULT_SECURITY_BANDS]);
    assert.ok(!r.warnings.some((w) => w.startsWith("miningEncounters.")), r.warnings.join("\n"));
    const w = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_MINING_ENCOUNTERS_THRESHOLD: "99999",
      EVEJS_LNE_MINING_ENCOUNTERS_SPECIAL_CHANCE_BASE: "0.5", EVEJS_LNE_MINING_ENCOUNTERS_SECURITY_BANDS: "0.5:0:1" } });
    assert.strictEqual(w.config.miningEncounters.threshold, 10000);
    assert.ok(w.warnings.some((x) => x.startsWith("miningEncounters.specialChanceBase=0.5 above specialChanceMax=0.25")),
      w.warnings.join("\n"));
    assert.ok(w.warnings.some((x) => x.startsWith("EVEJS_LNE_MINING_ENCOUNTERS_SECURITY_BANDS=")
      || x.includes("miningEncounters.securityBands")), w.warnings.join("\n"));
    assert.strictEqual(w.config.miningEncounters.securityBands, DEFAULT_SECURITY_BANDS);
  });

  test("ME6 security bands: select by security, higher security = smaller wave, bad tables refused", () => {
    const parsed = parseSecurityBands(DEFAULT_SECURITY_BANDS);
    assert.strictEqual(parsed.ok, true);
    const mult = [1.0, 0.8, 0.7, 0.6, 0.5, 0.45, 0.4, 0.1, 0.0, -0.01, -1].map((sec) =>
      selectSecurityBand(parsed.bands, sec).sizeMultiplier);
    assert.deepStrictEqual(mult, [0.5, 0.5, 0.75, 0.75, 1, 1, 1.5, 1.5, 1.5, 2, 2]);
    assert.strictEqual(selectSecurityBand(parsed.bands, Number.NaN), null);
    const S = cfg();
    const sizes = [0.9, 0.7, 0.5, 0.3, -0.5].map((sec) => {
      const b = selectSecurityBand(parsed.bands, sec);
      const p = planWave({ waveNumber: 1, baseMin: 3, baseMax: 5, config: S, rng: seq(0.99),
        vendorSpecialsEnabled: true, sizeMultiplier: b.sizeMultiplier,
        specialChanceMultiplier: b.specialChanceMultiplier });
      return [p.minCount, p.maxCount];
    });
    assert.deepStrictEqual(sizes, [[2, 3], [2, 4], [3, 5], [5, 8], [6, 8]]);
    for (const bad of ["", "0.5:1", "0.5:0:1", "2:1:1", "0.5:1:1;0.5:2:2", "a:b:c"]) {
      assert.strictEqual(parseSecurityBands(bad).ok, false, bad);
    }
  });

  test("ME7 hauler wave warp-off watch: poller only while tracked, force after the time, gone/landed drop, flag off",
    () => {
      assert.deepStrictEqual([DEFAULTS.haulerWarpOutEnabled, DEFAULTS.haulerWarpOutRangeMeters,
        DEFAULTS.haulerWarpOutAfterMs, DEFAULTS.haulerWarpOutCheckMs], [true, 150000, 180000, 5000]);
      const run = (over = {}) => {
        let now = 1e7;
        const timers = [];
        const calls = [];
        const replies = [];
        const seam = {
          bandOf: () => ({ ok: true, band: "lowsec", eligible: true, baseMin: 2, baseMax: 3, security: 0.3 }),
          locate: () => ({ ok: true, beltId: 7, shipId: 5, groupsOnBelt: 0, groupsInSystem: 0 }),
          spawnWave: () => ({ ok: true, kind: "hauler", ships: 2, degraded: false, entityIds: [801, 802] }),
          readVendorBeltFlags: () => ({ ok: true, ratsEnabled: true, specialsEnabled: true }),
          warpOutHaulers: (a) => { calls.push(a); return replies.shift() || { ok: true, ships: [] }; },
        };
        const setTimer = (fn, ms) => {
          const t = { fn, ms, cancelled: false, cancel: () => { t.cancelled = true; }, hasRef: () => false };
          timers.push(t);
          return t;
        };
        const enc = startMiningEncounters({ config: { miningEncounters: cfg({ enabled: true, threshold: 1, ...over }) },
          clock: { now: () => now }, seam, rng: () => 0, defer: () => {}, setTimer }).encounters;
        enc.onLedgerEvent({ characterId: 90000123, systemId: 30002510, yieldKind: "ore" });
        enc.flushNow();
        const live = () => timers.filter((t) => !t.cancelled && !t.fired);
        const fire = (advanceMs) => {
          now += advanceMs;
          const t = live()[0];
          t.fired = true;
          t.fn();
        };
        return { enc, timers, calls, replies, live, fire };
      };
      const r = run();
      assert.deepStrictEqual([r.enc.getStatus().haulerWaves, r.live().length, r.live()[0].ms], [1, 1, 5000]);
      r.replies.push({ ok: true, ships: [{ entityId: 801, state: "ordered" }, { entityId: 802, state: "staying" }] });
      r.fire(5000);
      assert.deepStrictEqual(r.calls[0], { systemId: 30002510, characterId: 90000123, entityIds: [801, 802],
        rangeMeters: 150000, force: false });
      r.replies.push({ ok: true, ships: [{ entityId: 801, state: "leaving" }, { entityId: 802, state: "ordered" }] });
      r.fire(180000);
      assert.strictEqual(r.calls[1].force, true, "past haulerWarpOutAfterMs: every hauler");
      r.replies.push({ ok: true, ships: [{ entityId: 801, state: "gone" }, { entityId: 802, state: "gone" }] });
      r.fire(5000);
      const st = r.enc.getStatus();
      assert.deepStrictEqual([st.haulerWaves, r.live().length, st.counters["hauler.tracked"],
        st.counters["hauler.warpOut"], st.counters["hauler.gone"]], [0, 0, 1, 2, 2], "no timer once nothing is watched");
      const u = run();
      u.replies.push({ ok: false, reason: "SCENE_NOT_LOADED" });
      u.fire(5000);
      assert.deepStrictEqual([u.enc.getStatus().haulerWaves, u.enc.getStatus().counters["hauler.dropped"],
        u.live().length], [0, 1, 0]);
      const s = run();
      s.enc.stop("test");
      assert.deepStrictEqual([s.enc.getStatus().haulerWaves, s.live().length], [0, 0]);
      const off = run({ haulerWarpOutEnabled: false });
      assert.deepStrictEqual([off.enc.getStatus().haulerWaves, off.timers.length], [0, 0]);
    });
};
