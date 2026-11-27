"use strict";

const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");

const config = require("../../config");
const { createJournal } = require("../../lib/persistence/journal");
const { JOURNAL_TABLE } = require("../../lib/persistence/migrations");
const policy = require("../../lib/officers/policy");
const { createOfficerSpawns } = require("../../lib/officers/service");
const { startOfficerSpawns, createUnavailableOfficerSpawns } = require("../../lib/officers");
const { factionKeyOf } = require("../../lib/adapter/officerSpawn");
const { loadDriver, withStore } = require("../notices/storeHelper");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const T0 = 1760000000000;
const DAY_MS = 86400000;
const SYS_A = 30000142;
const SYS_B = 30000144;
const SYS_C = 30000145;
const CHAR = 91000001;
const SEED = 12345;

function resolve(env = {}) {
  return config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(), ...env } });
}

function section(over = {}) {
  return { ...resolve().config.officerSpawns, enabled: true, huntEnabled: true, salvageEnabled: true,
    huntChancePermille: 1000, salvageChancePermille: 1000, ...over };
}

function fakeSeam(opts = {}) {
  const calls = { spawn: 0, reserve: 0, inputs: [] };
  let seq = 0;
  return { calls, seam: {
    factionKeyOf,
    spawnOfficer(input) {
      calls.inputs.push(input);
      if (opts.refuse) return { ok: false, reason: opts.refuse };
      calls.reserve += 1;
      const r = input.reserve();
      if (!r || r.ok !== true) return { ok: false, reason: "RESERVE_REFUSED", detail: r && r.reason };
      if (opts.spawnFail) return { ok: false, reason: "SPAWN_FAILED", detail: "NO_RESULT" };
      calls.spawn += 1;
      seq += 1;
      return { ok: true, entityIds: [700000 + seq], profileIds: ["p"], factionKey: input.factionKey || "guristas" };
    },
  } };
}

function rig(opened, conf, opts = {}) {
  const clock = opts.clock || { t: T0, now() { return this.t; } };
  const journal = opts.journal || createJournal({ clock, maxPayloadBytes: 16384, maxRows: 500 });
  const fake = opts.fake || fakeSeam(opts.seam);
  const logger = { lines: [], log(l) { this.lines.push(l); } };
  const svc = createOfficerSpawns({ store: opened.store, journal, clock, worldSeed: SEED, config: conf,
    getSeam: () => fake.seam, logger });
  const rows = () => {
    const r = opened.store.transaction("of.test", (db) => db.prepare(`SELECT idempotency_key AS key, aggregate_type AS t,`
      + ` aggregate_id AS a, event_type AS e FROM ${JOURNAL_TABLE} WHERE idempotency_key LIKE 'officer:%'`
      + " ORDER BY journal_id").all());
    assert.ok(r.ok, JSON.stringify(r));
    return r.value;
  };
  return { svc, clock, journal, fake, rows, logger };
}

const hunt = (huntId, systemId = SYS_A, factionId = 500010) => ({ huntId, systemId, characterId: CHAR, factionId });

module.exports = ({ test, skip }) => {
  test("OF1 policy: rollHit deterministic (0 never, 1000 always), keys and ranges", () => {
    for (const seed of [1, 7, 99, 123456]) {
      assert.strictEqual(policy.rollHit(seed, 500), policy.rollHit(seed, 500));
      assert.strictEqual(policy.rollHit(seed, 0), false);
      assert.strictEqual(policy.rollHit(seed, 1000), true);
    }
    let hits = 0;
    for (let s = 1; s <= 400; s += 1) if (policy.rollHit(s * 2654435761 >>> 0, 300)) hits += 1;
    assert.ok(hits > 80 && hits < 160, `300 permille over 400 seeds: ${hits}`);
    const day = policy.dayOf(T0);
    assert.strictEqual(day, Math.floor(T0 / DAY_MS));
    assert.strictEqual(policy.officerKeyOf(day, SYS_A, "hunt", "h1"), `officer:${day}:${SYS_A}:hunt:h1`);
    assert.strictEqual(policy.sourceKeyOf("hunt", "h1"), "officer:src:hunt:h1");
    const [sf, st] = policy.systemRangeOf(day, SYS_A);
    assert.deepStrictEqual([sf, st], [`officer:${day}:${SYS_A}:`, `officer:${day}:${SYS_A};`]);
    const inside = (k, [f, t]) => k >= f && k < t;
    assert.ok(inside(policy.officerKeyOf(day, SYS_A, "salvage", "a1"), [sf, st]));
    assert.ok(!inside(policy.officerKeyOf(day, 300001420, "hunt", "h1"), [sf, st]), "300001420 is another system");
    const dr = policy.dayRangeOf(day);
    assert.deepStrictEqual(dr, [`officer:${day}:`, `officer:${day};`]);
    assert.ok(inside(policy.officerKeyOf(day, 300001420, "hunt", "h1"), dr));
    assert.ok(!inside(policy.officerKeyOf(day + 1, SYS_A, "hunt", "h1"), dr));
    assert.ok(!inside(policy.sourceKeyOf("hunt", "h1"), dr), "source key outside the day range");
  });

  const driver = loadDriver();
  if (!driver.ok) {
    skip("OF2-OF4 officer spawns service", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }

  test("OF2 tryHunt hit: two journal rows in one reservation, spawned; the same huntId again -> DUPLICATE", () => {
    withStore(driver, (opened) => {
      const h = rig(opened, section());
      const r = h.svc.tryHunt(hunt("h1"));
      assert.deepStrictEqual(r, { ok: true, spawned: true, entityIds: [700001] });
      const day = policy.dayOf(T0);
      assert.deepStrictEqual(h.rows(), [
        { key: `officer:${day}:${SYS_A}:hunt:h1`, t: "lne_officer", a: String(SYS_A), e: "OFFICER_SPAWN_RESERVED" },
        { key: "officer:src:hunt:h1", t: "lne_officer", a: String(SYS_A), e: "OFFICER_SOURCE_USED" }]);
      assert.strictEqual(h.fake.calls.inputs[0].factionKey, "guristas");
      assert.strictEqual(h.fake.calls.inputs[0].distanceMeters, 30000);
      assert.ok(h.logger.lines.some((l) => l === `officerSpawns: guristas officer in ${SYS_A} for ${CHAR} (hunt h1)`),
        h.logger.lines.join("\n"));
      const again = h.svc.tryHunt(hunt("h1"));
      assert.deepStrictEqual(again, { ok: false, reason: "DUPLICATE" });
      assert.strictEqual(h.rows().length, 2);
      assert.strictEqual(h.fake.calls.spawn, 1);
      const c = h.svc.getStatus().counters;
      assert.deepStrictEqual([c.attempt, c.reserved, c.spawned, c.duplicate, c["source.hunt"]], [2, 1, 1, 1, 2]);
    });
  });

  test("OF3 limits per system and day, the next UTC day, DUPLICATE across days and restart", () => {
    withStore(driver, (opened) => {
      const conf = section({ maxPerSystemPerDay: 1, maxPerDay: 2 });
      const h = rig(opened, conf);
      assert.strictEqual(h.svc.tryHunt(hunt("h1", SYS_A)).ok, true);
      assert.strictEqual(h.svc.tryHunt(hunt("h2", SYS_A)).reason, "LIMIT_SYSTEM");
      assert.strictEqual(h.svc.tryHunt(hunt("h3", SYS_B)).ok, true);
      assert.strictEqual(h.svc.tryHunt(hunt("h4", SYS_C)).reason, "LIMIT_DAY");
      assert.strictEqual(h.rows().length, 4);
      const r2 = rig(opened, conf, { clock: h.clock });
      assert.strictEqual(r2.svc.tryHunt(hunt("h5", SYS_C)).reason, "LIMIT_DAY");
      assert.strictEqual(r2.svc.tryHunt(hunt("h1", SYS_A)).reason, "DUPLICATE");
      h.clock.t = T0 + DAY_MS;
      assert.strictEqual(r2.svc.tryHunt(hunt("h6", SYS_A)).ok, true, "next UTC day");
      assert.strictEqual(r2.svc.tryHunt(hunt("h1", SYS_B)).reason, "DUPLICATE", "an old huntId stays used");
      assert.strictEqual(r2.svc.tryHunt(hunt("h7", SYS_A)).reason, "LIMIT_SYSTEM");
      assert.strictEqual(h.rows().length, 6);
      const c = r2.svc.getStatus().counters;
      assert.deepStrictEqual([c.limitDay, c.duplicate, c.limitSystem], [1, 2, 1]);
    });
  });

  test("OF4 refusals before the reservation, SPAWN_FAILED keeps the slot; config keys, clamp, warning; start", () => {
    withStore(driver, (opened) => {
      const off = rig(opened, section({ enabled: false }));
      assert.deepStrictEqual(off.svc.tryHunt(hunt("x1")), { ok: false, reason: "DISABLED" });
      assert.strictEqual(off.fake.calls.inputs.length, 0);
      const noHunt = rig(opened, section({ huntEnabled: false }));
      assert.strictEqual(noHunt.svc.tryHunt(hunt("x2")).reason, "SOURCE_DISABLED");
      assert.strictEqual(noHunt.svc.trySalvage({ anomalyId: "a0", systemId: SYS_A, characterId: CHAR,
        factionId: null }).ok, true, "salvage on its own flag");
      assert.strictEqual(rig(opened, section({ huntChancePermille: 0 })).svc.tryHunt(hunt("x3")).reason,
        "CHANCE_MISS");
      const empire = rig(opened, section());
      assert.strictEqual(empire.svc.tryHunt(hunt("x4", SYS_B, 500001)).reason, "NOT_PIRATE");
      assert.strictEqual(empire.fake.calls.inputs.length, 0);
      for (const reason of ["NOT_ELIGIBLE", "NO_SHIP", "SCENE_NOT_LOADED"]) {
        const s = rig(opened, section(), { seam: { refuse: reason } });
        assert.strictEqual(s.svc.tryHunt(hunt(`r-${reason}`, SYS_B)).reason, reason);
        assert.strictEqual(s.fake.calls.reserve, 0);
      }
      assert.deepStrictEqual(off.rows().map((r) => r.key), [`officer:${policy.dayOf(T0)}:${SYS_A}:salvage:a0`,
        "officer:src:salvage:a0"]);
      const failed = rig(opened, section(), { seam: { spawnFail: true } });
      assert.strictEqual(failed.svc.tryHunt(hunt("f1", SYS_C)).reason, "SPAWN_FAILED");
      assert.strictEqual(off.rows().length, 4, "the reservation row stays");
      assert.strictEqual(failed.svc.getStatus().counters.spawnFailed, 1);
      assert.strictEqual(failed.svc.tryHunt(hunt("f1", SYS_C)).reason, "DUPLICATE");

      const base = resolve();
      assert.deepStrictEqual(base.config.officerSpawns, { enabled: false, huntEnabled: false, salvageEnabled: false,
        huntChancePermille: 30, salvageChancePermille: 50, maxPerSystemPerDay: 1, maxPerDay: 6,
        spawnDistanceMeters: 30000 });
      const clamped = resolve({ EVEJS_LNE_OFFICER_SPAWNS_HUNT_CHANCE_PERMILLE: "5000",
        EVEJS_LNE_OFFICER_SPAWNS_SPAWN_DISTANCE_METERS: "1", EVEJS_LNE_OFFICER_SPAWNS_MAX_PER_SYSTEM_PER_DAY: "9",
        EVEJS_LNE_OFFICER_SPAWNS_MAX_PER_DAY: "3" });
      const c = clamped.config.officerSpawns;
      assert.deepStrictEqual([c.huntChancePermille, c.spawnDistanceMeters], [1000, 5000]);
      assert.ok(clamped.warnings.some((w) => w.startsWith("officerSpawns.maxPerSystemPerDay=9 above maxPerDay=3")),
        clamped.warnings.join("\n"));
      assert.ok(!base.warnings.some((w) => w.startsWith("officerSpawns.")));

      let seamCalls = 0;
      const getSeam = () => { seamCalls += 1; return null; };
      assert.deepStrictEqual(startOfficerSpawns({ config: base.config, persistence: opened, getSeam }),
        { ok: false, reason: "disabled_by_config" });
      const onCfg = resolve({ EVEJS_LNE_OFFICER_SPAWNS_ENABLED: "1" }).config;
      const persistence = { store: opened.store, journal: off.journal, worldSeed: SEED };
      const started = startOfficerSpawns({ config: onCfg, persistence, clock: off.clock, getSeam });
      assert.strictEqual(started.ok, true, JSON.stringify(started));
      assert.strictEqual(started.officerSpawns.tryHunt(hunt("s1")).reason, "SOURCE_DISABLED");
      assert.strictEqual(seamCalls, 0);
      assert.strictEqual(startOfficerSpawns({ config: onCfg, persistence: { store: opened.store }, clock: off.clock })
        .reason, "OFFICER_SPAWNS_DEPENDENCY_UNAVAILABLE");
      const stub = createUnavailableOfficerSpawns("OFFICER_SPAWNS_DISABLED");
      assert.deepStrictEqual([stub.tryHunt(hunt("z")), stub.trySalvage({}), stub.getStatus().state],
        [{ ok: false, reason: "OFFICER_SPAWNS_DISABLED" }, { ok: false, reason: "OFFICER_SPAWNS_DISABLED" },
          "unavailable"]);
    });
  });
};
