"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { createSpawnBackoff, failureReasonOf, PERMANENT_REASONS } = require("../../lib/materialization/spawnBackoff");
const { resolveConfig, SCHEMA } = require("../../config");
const { helpers: G } = require("./garrisonStep.test");
const { harness: HU } = require("./huntStep.test");
const { findCompose, readCompose } = require("../config/composeKeys.test");
const { createConvoyAmbush } = require("../../lib/materialization/convoyAmbush");
const { harness: XR } = require("../battle/settlement.test");
const { rig: XS } = require("./exposureStep.test");
const { rig: SH } = require("./sentryHold.test");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const LIVE_PASS_MS = 36000;
const S = Object.freeze({ enabled: true, baseMs: 60000, maxMs: 3600000, permanentMs: 21600000, maxEntries: 4096 });

function settingsOf(env) {
  const r = resolveConfig({ modDir: MOD_DIR, env: env || {} });
  assert.strictEqual(r.ok, true);
  return r.config.materialization.spawnBackoff;
}

function refuseSlots(w) {
  w.npcSpawn.spawnShip = () => {
    w.calls.push(["spawnShip"]);
    return { ok: false, reason: "SPAWN_FAILED", detail: "NPC_NATIVE_NO_FREE_SLOT" };
  };
}

module.exports = ({ test, skip }) => {
  test("SB1 spawnBackoff: base*2^(n-1) up to maxMs, deterministic reason (also in detail) -> permanentMs, first once "
    + "per (key, reason), overflow drops the smallest retryAt, disabled holds nothing", () => {
    const b = createSpawnBackoff(S);
    const waits = [];
    for (let i = 0; i < 8; i += 1) waits.push(b.note("f1", "SPAWN_FAILED", 0).retryAt);
    assert.deepStrictEqual(waits, [60000, 120000, 240000, 480000, 960000, 1920000, 3600000, 3600000]);
    assert.deepStrictEqual(b.blocked("f1", 3599999), { retryAt: 3600000, reason: "SPAWN_FAILED", failures: 8 });
    assert.strictEqual(b.blocked("f1", 3600000), null, "retryAt reached");
    const p = b.note("f2", failureReasonOf("SPAWN_FAILED", "NPC_NATIVE_NO_FREE_SLOT"), 1000);
    assert.deepStrictEqual(p, { retryAt: 1000 + S.permanentMs, failures: 1, first: true });
    assert.strictEqual(b.note("f2", "NPC_NATIVE_NO_FREE_SLOT", 2000).first, false, "one log line per (key, reason)");
    assert.strictEqual(b.note("f2", "PUBLISH_FAILED", 3000).first, true, "a new reason logs again");
    assert.deepStrictEqual(PERMANENT_REASONS.map((r) => failureReasonOf(r, null)), [...PERMANENT_REASONS]);
    assert.strictEqual(failureReasonOf("SPAWN_THREW", "boom"), "SPAWN_THREW");
    assert.deepStrictEqual(b.note("arm:9", "ARM_FAILED", 0, { escalate: false }).retryAt, 60000);
    assert.deepStrictEqual(b.note("arm:9", "ARM_FAILED", 0, { escalate: false }).retryAt, 60000, "no escalation");
    b.clear("f1");
    assert.strictEqual(b.blocked("f1", 0), null);
    const small = createSpawnBackoff({ ...S, maxEntries: 2 });
    small.note("a", "X", 500);
    small.note("b", "X", 100);
    small.note("c", "X", 300);
    assert.deepStrictEqual([small.size(), small.blocked("b", 0), small.blocked("a", 0) !== null,
      small.blocked("c", 0) !== null], [2, null, true, true]);
    const off = createSpawnBackoff({ ...S, enabled: false });
    assert.deepStrictEqual(off.note("a", "NPC_NATIVE_NO_FREE_SLOT", 5), { retryAt: 5, failures: 0, first: true });
    assert.deepStrictEqual([off.blocked("a", 5), off.size(), createSpawnBackoff(null).blocked("a", 0)], [null, 0, null]);
  });

  const driver = G.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  function patrolTwice(opened, spawnSettings) {
    const env = G.setup(opened, { gp: { startDelayMs: 0 }, deps: { spawnBackoff: createSpawnBackoff(spawnSettings) } });
    refuseSlots(env.w);
    env.newFleet("sb-g");
    env.w.player(101);
    env.pass(0);
    const first = [env.rows().length, env.w.count("spawnShip")];
    env.pass(LIVE_PASS_MS);
    return { first, second: [env.rows().length, env.w.count("spawnShip")], counters: env.counters(),
      rolled: env.lines.filter((l) => l.includes("rolled back")) };
  }

  function huntTwice(opened, spawnSettings) {
    const env = HU.setup(opened, { ph: { cooldownMs: 0 }, deps: { spawnBackoff: createSpawnBackoff(spawnSettings) } });
    refuseSlots(env.w);
    env.newFleet("sb-h", HU.PIRATE);
    env.standings.set(`103:${HU.PIRATE}`, -6);
    env.w.player(103);
    env.pass(0);
    const first = [env.rows().length, env.w.count("spawnShip")];
    env.pass(LIVE_PASS_MS);
    return { first, second: [env.rows().length, env.w.count("spawnShip")], counters: env.counters(),
      rolled: env.lines.filter((l) => l.includes("rolled back")) };
  }

  needsDriver("SB2 NPC_NATIVE_NO_FREE_SLOT: garrison patrol and player hunt - pass 1 claim + rollback, pass 2 (+36 s) "
    + "no claim and no vendor spawn (refusedBackoff 1), one rollback line with the detail and the backoff", () => {
    for (const [name, run] of [["garrison", patrolTwice], ["hunt", huntTwice]]) {
      G.withStore(driver, (opened) => {
        const r = run(opened, settingsOf());
        assert.deepStrictEqual(r.first, [1, 1], `${name}: one claim, one spawn try`);
        assert.deepStrictEqual(r.second, [1, 1], `${name}: no claim / spawn in the backoff`);
        assert.deepStrictEqual([r.counters.spawnFailed, r.counters.refusedBackoff], [1, 1], name);
        assert.strictEqual(r.rolled.length, 1, r.rolled.join("\n"));
        assert.ok(r.rolled[0].includes("NPC_NATIVE_NO_FREE_SLOT") && r.rolled[0].includes("backoff=21600000ms"),
          r.rolled[0]);
      });
    }
  });

  needsDriver("SB3 armFor: an id of failed is not handed to armNpcCombat again before retryAt (lneArmBackoff), after "
    + "baseMs it is", () => {
    G.withStore(driver, (opened) => {
      const ENEMY = 500010;
      const E1 = 8001;
      const groups = [];
      const env = G.setup(opened, { gp: { startDelayMs: 0 }, deps: { spawnBackoff: createSpawnBackoff(settingsOf()),
        getLneGroups: () => groups, isFactionEnemy: (f, g) => f === G.PIRATE && g === ENEMY } });
      env.w.graph = { getGraph: () => ({ ok: true, graph: { getSystem: () => ({ secClass: "nullsec",
        factionId: G.PIRATE }) } }) };
      env.newFleet("sb3");
      const player = env.w.player(101);
      env.pass(0);
      const ships = [...env.w.npc.keys()];
      assert.strictEqual(ships.length, 3);
      const lead = env.w.npc.get(ships[0]).position;
      env.w.npc.set(E1, { systemId: G.SYS, position: { x: lead.x + 1000, y: 0, z: 0 } });
      groups.push({ systemId: G.SYS, factionId: ENEMY, entityIds: [E1], source: "hunt", groupId: "h1" });
      player.position = { ...lead };
      env.w.armFail = new Set([E1]);
      const arms = () => env.w.calls.filter((c) => c[0] === "armNpcCombat").map((c) => c[2]);
      env.pass(1000);
      assert.deepStrictEqual(arms(), [[...ships, E1]]);
      env.pass(1000);
      assert.deepStrictEqual(arms(), [[...ships, E1]], "E1 held: no second arm call");
      assert.strictEqual(env.counters().lneArmBackoff, 1);
      env.w.armFail = new Set();
      env.pass(settingsOf().baseMs);
      assert.deepStrictEqual(arms(), [[...ships, E1], [E1]], "after retryAt the id is armed again");
    });
  });

  needsDriver("SB4 materialization.spawnBackoff.enabled=false -> pass 2 claims again (as before); env 0 -> false", () => {
    const off = settingsOf({ EVEJS_LNE_MATERIALIZATION_SPAWN_BACKOFF_ENABLED: "0" });
    assert.deepStrictEqual([settingsOf().enabled, off.enabled], [true, false]);
    for (const run of [patrolTwice, huntTwice]) {
      G.withStore(driver, (opened) => {
        const r = run(opened, off);
        assert.deepStrictEqual([r.first[0], r.second[0], r.counters.refusedBackoff], [1, 2, 0]);
        assert.strictEqual(r.rolled.length, 2, "a line per rollback, as before");
      });
    }
  });

  needsDriver("SB5: a fleet in the spawn backoff takes no slot - garrison patrol (maxNewPerPass 1) and player "
    + "hunt start the other fleet of the system in the same pass; backoff off: the held note is ignored", () => {
    let huntHeld = 0;
    for (const held of [0, 1]) {
      G.withStore(driver, (opened) => {
        const b = createSpawnBackoff(settingsOf());
        const env = G.setup(opened, { gp: { startDelayMs: 0, maxNewPerPass: 1 }, deps: { spawnBackoff: b } });
        const ids = [env.newFleet("sb5-a"), env.newFleet("sb5-b")];
        b.note(ids[held], "NPC_NATIVE_NO_FREE_SLOT", env.clock.now());
        env.w.player(101);
        env.pass(0);
        assert.deepStrictEqual(env.rows().map((r) => r.fleet_id), [ids[1 - held]], `garrison held=${held}`);
        assert.strictEqual(env.counters().refusedBackoff, 1);
      });
      G.withStore(driver, (opened) => {
        const b = createSpawnBackoff(settingsOf());
        const env = HU.setup(opened, { ph: { cooldownMs: 0 }, deps: { spawnBackoff: b } });
        const ids = [env.newFleet("sb5-c", HU.PIRATE), env.newFleet("sb5-d", HU.PIRATE)];
        b.note(ids[held], "NPC_NATIVE_NO_FREE_SLOT", env.clock.now());
        env.standings.set(`103:${HU.PIRATE}`, -6);
        env.w.player(103);
        env.pass(0);
        assert.deepStrictEqual(env.step.getStatus().hunts.map((h) => h.fleetId), [ids[1 - held]], `hunt held=${held}`);
        huntHeld += env.counters().refusedBackoff;
      });
    }
    assert.strictEqual(huntHeld, 1, "the hunt passed over the held fleet in one of the two orders");
    G.withStore(driver, (opened) => {
      const off =createSpawnBackoff(settingsOf({ EVEJS_LNE_MATERIALIZATION_SPAWN_BACKOFF_ENABLED: "0" }));
      const env = G.setup(opened, { gp: { startDelayMs: 0, maxNewPerPass: 1 }, deps: { spawnBackoff: off } });
      const ids = [env.newFleet("sb5-e"), env.newFleet("sb5-f")];
      for (const id of ids) off.note(id, "NPC_NATIVE_NO_FREE_SLOT", env.clock.now());
      env.w.player(101);
      env.pass(0);
      assert.deepStrictEqual([env.rows().length, env.counters().refusedBackoff], [1, 0]);
    });
  });

  needsDriver("SB6: NPC_NATIVE_NO_FREE_SLOT - exposure (miner) and sentry hold: pass 2 no vendor spawn "
    + "(refusedBackoff / holdRefusedBackoff 1), one rollback line; SCENE_NPC_BUDGET never held; ambush: next crossing "
    + "skipped SPAWN_BACKOFF, scene refusal and flag off try again", async () => {
    const refuseWith = (npcSpawn, calls, detail) => {
      npcSpawn.spawnShip = () => {
        calls.n += 1;
        return detail === "SCENE_NPC_BUDGET" ? { ok: false, reason: "SCENE_NPC_BUDGET" }
          : { ok: false, reason: "SPAWN_FAILED", detail };
      };
    };
    for (const detail of ["NPC_NATIVE_NO_FREE_SLOT", "SCENE_NPC_BUDGET"]) {
      const held = detail !== "SCENE_NPC_BUDGET";
      await XR.withStore(driver, async (reopen) => {
        const t = XS.setup(reopen, { spawnBackoff: createSpawnBackoff(settingsOf()) });
        XS.stagedMiner(t, `sb6x-${held ? "h" : "s"}`);
        const calls = { n: 0 };
        refuseWith(t.w.npcSpawn, calls, detail);
        t.w.player(XR.S.N0);
        t.pass();
        t.pass(t.settings.scanIntervalMs);
        const rolled = t.lines.filter((l) => l.startsWith("fleetExposure: spawn ") && l.includes("rolled back"));
        assert.deepStrictEqual([calls.n, t.counters().refusedBackoff, rolled.length], held ? [1, 1, 1] : [2, 0, 2],
          `exposure ${detail}`);
      });
      await XR.withStore(driver, async (reopen) => {
        const t = SH.setup(reopen, { spawnBackoff: createSpawnBackoff(settingsOf()) });
        SH.stagedSiege(t, `sb6h-${held ? "h" : "s"}`);
        const calls = { n: 0 };
        refuseWith(t.w.npcSpawn, calls, detail);
        t.w.player(SH.SYS);
        t.pass(0);
        t.pass(t.settings.scanIntervalMs);
        const rolled = t.base.lines.filter((l) => l.startsWith("sentries: hold spawn ") && l.includes("rolled back"));
        assert.deepStrictEqual([calls.n, t.counters().holdRefusedBackoff, rolled.length], held ? [1, 1, 1] : [2, 0, 2],
          `sentry hold ${detail}`);
      });
    }
    const fx = { ...resolveConfig({ modDir: MOD_DIR, env: {} }).config.fleetExposure, ambushDelayMs: 0,
      ambushChancePermilleNullsec: 1000, ambushMaxStartsPerPass: 5 };
    const ambushRun = (spawnSettings, detail) => {
      const counts = {};
      const calls = { n: 0 };
      const npcSpawn = { resolveProfiles: (reqs) => ({ ok: true, profiles: reqs.map((r) => `p_${r.hullGroup}`) }) };
      refuseWith(npcSpawn, calls, detail);
      const lines = [];
      const amb = createConvoyAmbush({ npcSpawn, settings: fx, worldSeed: 7,
        budget: { canReserve: () => ({ ok: true }), reserve: () => ({ ok: true }), release: () => ({ ok: true }) },
        secClassOf: () => "nullsec", pirateFactionOf: () => 500010, carrierGroups: ["industrial"],
        bump: (name) => { counts[name] = (counts[name] || 0) + 1; }, logLimited: (_now, l) => lines.push(l),
        spawnBackoff: createSpawnBackoff(spawnSettings) });
      const entry = (legSeq) => ({ kind: "CONVOY", fleetId: "sb6-convoy", factionId: 500001, systemId: 30000001,
        phase: "VISIBLE", despawned: false, startedAt: 0, members: [], ambush: null,
        crossing: { legSeq, systemIndex: 2, windowEnd: 1e9 },
        exitGate: { kind: "stargate", itemId: 50000001, position: { x: 1, y: 0, z: 0 } } });
      const e1 = entry(1);
      const e2 = entry(2);
      amb.step(e1, { sceneLoaded: true, alive: [] }, 1, 1000);
      amb.step(e2, { sceneLoaded: true, alive: [] }, 1, 2000);
      return { calls: calls.n, skip: [e1.ambush.skipReason, e2.ambush.skipReason], counts, lines };
    };
    const on = ambushRun(settingsOf(), "NPC_NATIVE_NO_FREE_SLOT");
    assert.ok(on.calls === 1 && on.skip[1] === "SPAWN_BACKOFF" && on.counts.ambushRefusedBackoff === 1,
      JSON.stringify(on));
    assert.strictEqual(on.lines.filter((l) => l.includes("rolled back")).length, 1);
    const scene = ambushRun(settingsOf(), "SCENE_NPC_BUDGET");
    assert.deepStrictEqual([scene.calls, scene.skip, scene.counts.ambushRefusedBackoff],
      [2, ["SCENE_NPC_BUDGET", "SCENE_NPC_BUDGET"], undefined]);
    const off = ambushRun(settingsOf({ EVEJS_LNE_MATERIALIZATION_SPAWN_BACKOFF_ENABLED: "0" }),
      "NPC_NATIVE_NO_FREE_SLOT");
    assert.deepStrictEqual([off.calls, off.skip, off.lines.length], [2, ["SPAWN_FAILED", "SPAWN_FAILED"], 2]);
  });

  const composeFile = findCompose();
  if (!composeFile) {
    skip("SB4 compose spawnBackoff keys", "compose.yaml not found above the mod (Docker image)");
  } else {
    test("SB4 compose: every materialization.spawnBackoff.* SCHEMA key has a ${NAME:-} line (pattern LPC1)", () => {
      const text = fs.readFileSync(composeFile, "utf8");
      const { env } = readCompose(composeFile);
      const rows = SCHEMA.filter((row) => row.key.startsWith("materialization.spawnBackoff."));
      assert.strictEqual(rows.length, 5);
      const missing = rows.filter((row) => !Object.prototype.hasOwnProperty.call(env, row.env)
        || !text.includes(`\${${row.env}:-}`)).map((row) => row.env);
      assert.deepStrictEqual(missing, []);
    });
  }
};
