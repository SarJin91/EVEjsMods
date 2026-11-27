"use strict";

const assert = require("node:assert");

const { harness } = require("./garrisonDefense.test");
const { campPoint } = require("../../lib/garrisonPatrol/policy");
const { TRIGGER_REINFORCE } = require("../../lib/garrisonPatrol/schema");
const { reinforceChainIdOf } = require("../../lib/playerHunt/schema");
const { createUnavailablePlayerHunt, PLAYER_HUNT_METHODS } = require("../../lib/playerHunt");
const { COUNTER_NAMES, GARRISON_STEP_METHODS } = require("../../lib/materialization/garrisonStep");
const { resolveConfig } = require("../../config");

const { loadDriver, withStore, setup, pick, SYS, SYS2, GATE, AT_GATE, MOD_DIR } = harness;
const FLIGHT_MS = 60000;
const NEW_COUNTERS = ["defenseReinforceSent", "defenseReinforceNoCandidate", "defenseReinforceLimited",
  "defenseReinforceRefused", "defenseReinforceStarted", "defenseReinforceStayed", "defenseReinforceLost"];

function reinforceSetup(opened, gp) {
  const ctl = { listed: [], reads: 0, neighbour: [], override: null, flights: [], refuse: null };
  const env = setup(opened, gp, (fleets) => ({ getFleets: () => ({ repository: { ...fleets,
    listFleetsInSystems: (db, ids, o) => {
      ctl.listed.push([[...ids], { ...o }]);
      return { ok: true, bySystem: new Map(ids.map((id) => [id, id === SYS2 ? ctl.neighbour.map((f) => ({ ...f,
        fleetRole: "garrison", currentSystemId: SYS2 })) : []])) };
    },
    getFleet: (db, id) => {
      ctl.reads += 1;
      const got = fleets.getFleet(db, id);
      return ctl.override && got.ok && got.fleet ? { ok: true, fleet: ctl.override(got.fleet) } : got;
    } } }) }));
  env.approach = (db, req) => {
    ctl.flights.push(req);
    if (ctl.refuse) return { ok: false, reason: ctl.refuse };
    return { ok: true, operationId: "op-rnf", fleetVersion: req.expectedVersion + 1,
      arriveAt: env.clock.now() + FLIGHT_MS, jumps: 1 };
  };
  env.reinforcer = () => {
    const id = env.newFleet("r-big", { fleetRole: "reserve", composition: [{ hullGroup: "cruiser", count: 5 }] });
    const keep = env.newFleet("r-keep", { fleetRole: "reserve" });
    ctl.neighbour = [env.fleet(id), env.fleet(keep)];
    return id;
  };
  env.call = (characterId = 101) => {
    env.w.player(characterId, AT_GATE);
    return env.pass(1000);
  };
  env.ctl = ctl;
  return env;
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("R2 reinforce call: defenseNoFleet -> one approachInTx rnf:<fleet>:<v> SYS2 -> SYS maxJumps 1, Sent; the "
    + "same character again in the cooldown -> Limited, zero calls; faction 1/h -> the second character Limited; a "
    + "refused approachInTx -> Refused, no entry", () => {
    withStore(driver, (opened) => {
      const env = reinforceSetup(opened);
      const id = env.reinforcer();
      const version = env.fleet(id).version;
      env.pass(0);
      env.call();
      assert.deepStrictEqual(env.ctl.flights, [{ chainId: reinforceChainIdOf(id, version), fleetId: id,
        expectedVersion: version, fromSystemId: SYS2, targetSystemId: SYS, at: env.clock.now(),
        constraints: { maxJumps: 1 } }]);
      assert.deepStrictEqual(env.ctl.listed.map((l) => l[0]), [[SYS2]]);
      assert.deepStrictEqual(pick(env.counters(), ["defenseNoFleet", "defenseReinforceSent"]), [1, 1]);
      assert.strictEqual(env.step.getStatus().reinforcements, 1);
      assert.ok(env.lines.some((l) => l.includes(`reinforce rnf:${id}:${version} ${SYS2} -> ${SYS} trigger=101`)),
        env.lines.join("\n"));
      env.w.players = [];
      env.pass(1000);
      env.call();
      assert.deepStrictEqual(pick(env.counters(), ["defenseNoFleet", "defenseReinforceLimited"]), [2, 1]);
      assert.strictEqual(env.ctl.flights.length, 1, "no second flight");
      assert.strictEqual(env.ctl.listed.length, 1, "a limit reads nothing");
    });
    withStore(driver, (opened) => {
      const env = reinforceSetup(opened, { defenseReinforceMaxPerFactionHour: 1, defenseReinforcePerSystem: 4 });
      env.reinforcer();
      env.pass(0);
      env.call(101);
      env.call(102);
      assert.deepStrictEqual(pick(env.counters(), ["defenseReinforceSent", "defenseReinforceLimited"]), [1, 1]);
      assert.strictEqual(env.ctl.flights.length, 1);
    });
    withStore(driver, (opened) => {
      const env = reinforceSetup(opened);
      env.reinforcer();
      env.ctl.refuse = "TOO_FAR";
      env.pass(0);
      const out = env.call();
      assert.deepStrictEqual(pick(env.counters(), ["defenseReinforceRefused", "defenseReinforceSent"]), [1, 0]);
      assert.strictEqual(out.refused["patrol:TOO_FAR"], 1);
      assert.strictEqual(env.step.getStatus().reinforcements, 0);
    });
  });

  needsDriver("R3 reinforce arrival: zero reads before arriveAt; after it IDLE in SYS with the player -> GATE_CAMP "
    + "claim at campPoint of the gate towards SYS2, defense reinforce, Started; the player gone -> Stayed, zero "
    + "claims; TRAVELLING after the window -> Lost", () => {
    withStore(driver, (opened) => {
      const env = reinforceSetup(opened);
      const id = env.reinforcer();
      const G = env.config.garrisonPatrol;
      env.pass(0);
      env.call();
      env.pass(1000);
      assert.strictEqual(env.ctl.reads, 0, "nothing before arriveAt");
      env.pass(FLIGHT_MS);
      assert.strictEqual(env.ctl.reads, 1);
      assert.deepStrictEqual(env.claims.map((c) => [c.fleetId, c.mode, c.characterId]), [[id, "GATE_CAMP", 101]]);
      const point = campPoint(GATE, G.campStandoffMeters);
      assert.ok(env.w.spawns.length === 5 && env.w.spawns.every((s) => JSON.stringify(s.anchorDescriptor.position)
        === JSON.stringify(point)), "spawned at the gate towards the source");
      const [entry] = env.step.getStatus().list;
      assert.deepStrictEqual([entry.defense, entry.campGate], [TRIGGER_REINFORCE, GATE.itemId]);
      assert.deepStrictEqual(pick(env.counters(), ["defenseReinforceStarted", "defenseStarted", "startedCamp"]),
        [1, 1, 1]);
      assert.strictEqual(env.step.getStatus().reinforcements, 0);
      assert.ok(env.lines.some((l) => l.includes(`defense reinforce gate=${GATE.itemId} system=${SYS} trigger=101`)),
        env.lines.join("\n"));
    });
    withStore(driver, (opened) => {
      const env = reinforceSetup(opened);
      env.reinforcer();
      env.pass(0);
      env.call();
      env.w.players = [];
      env.pass(FLIGHT_MS);
      assert.deepStrictEqual(pick(env.counters(), ["defenseReinforceStayed", "defenseReinforceStarted"]), [1, 0]);
      assert.strictEqual(env.claims.length, 0);
    });
    withStore(driver, (opened) => {
      const env = reinforceSetup(opened);
      env.reinforcer();
      const G = env.config.garrisonPatrol;
      env.pass(0);
      env.call();
      env.ctl.override = (f) => ({ ...f, state: "TRAVELLING", operationId: "op-rnf" });
      env.pass(FLIGHT_MS);
      assert.deepStrictEqual(pick(env.counters(), ["defenseReinforceLost"]), [0], "en route inside the window");
      env.pass(G.defenseReinforceArrivalWaitMs + 1);
      assert.deepStrictEqual(pick(env.counters(), ["defenseReinforceLost", "defenseReinforceStarted"]), [1, 0]);
      assert.strictEqual(env.claims.length, 0);
    });
  });

  needsDriver("R4 reinforce off and facades: defenseReinforceEnabled false -> the scene calls of the flag on, zero "
    + "listFleetsInSystems / approachInTx; 7 counters; defaults and ranges; warning only when set explicitly; "
    + "ctx.playerHunt facade and stub have approachInTx; GARRISON_STEP_METHODS unchanged", () => {
    const sceneCalls = [];
    for (const on of [true, false]) {
      withStore(driver, (opened) => {
        const env = reinforceSetup(opened, { defenseReinforceEnabled: on });
        env.reinforcer();
        env.pass(0);
        env.call();
        sceneCalls.push(env.w.calls.map((c) => c[0]));
        assert.deepStrictEqual([env.ctl.listed.length, env.ctl.flights.length], on ? [1, 1] : [0, 0]);
        assert.strictEqual(env.counters().defenseNoFleet, 1);
        if (!on) assert.ok(NEW_COUNTERS.every((n) => env.counters()[n] === 0));
      });
    }
    assert.deepStrictEqual(sceneCalls[1], sceneCalls[0], "the flag adds no scene call");
    assert.ok(PLAYER_HUNT_METHODS.includes("approachInTx"));
    assert.strictEqual(typeof createUnavailablePlayerHunt("x").approachInTx, "function");
    assert.ok(NEW_COUNTERS.every((n) => COUNTER_NAMES.includes(n)));
    assert.deepStrictEqual([...GARRISON_STEP_METHODS], ["stepPending", "step", "getStatus", "stop", "addLiveLosses",
      "relationGroups"]);
    const r = resolveConfig({ modDir: MOD_DIR, env: {} });
    const gp = r.config.garrisonPatrol;
    assert.deepStrictEqual([gp.defenseReinforceEnabled, gp.defenseReinforceRoles, gp.defenseReinforceKeepPerSystem,
      gp.defenseReinforceMaxJumps, gp.defenseReinforcePerSystem, gp.defenseReinforceMaxActive,
      gp.defenseReinforceMaxPerPass, gp.defenseReinforceMaxPerFactionHour, gp.defenseReinforceCooldownMs,
      gp.defenseReinforceArrivalWaitMs, gp.defenseReinforceMaxReadsPerPass],
    [true, "garrison,patrol", 1, 1, 1, 4, 1, 6, 600000, 30000, 2]);
    assert.ok(!r.warnings.some((w) => w.includes("defenseReinforce")), "defaults: no warning");
    const P = "EVEJS_LNE_GARRISON_PATROL_";
    const bad = resolveConfig({ modDir: MOD_DIR, env: { [`${P}ENABLED`]: "1", [`${P}DEFENSE_ENABLED`]: "0",
      [`${P}DEFENSE_REINFORCE_ENABLED`]: "1", [`${P}DEFENSE_REINFORCE_MAX_JUMPS`]: "3",
      [`${P}DEFENSE_REINFORCE_ROLES`]: "dragon", [`${P}DEFENSE_REINFORCE_COOLDOWN_MS`]: "1" } });
    const b = bad.config.garrisonPatrol;
    assert.deepStrictEqual([b.defenseReinforceMaxJumps, b.defenseReinforceRoles, b.defenseReinforceCooldownMs],
      [1, "garrison,patrol", 60000]);
    assert.ok(bad.warnings.some((w) => w.includes("defenseReinforceEnabled without garrisonPatrol.defenseEnabled")),
      bad.warnings.join("\n"));
  });
};
