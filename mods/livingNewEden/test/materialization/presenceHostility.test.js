"use strict";

const assert = require("node:assert");
const path = require("node:path");

const PH = require("../../lib/materialization/presenceHostility");
const { harness: H } = require("../battle/settlement.test");
const { harness: P } = require("./presenceStep.test");
const { resolveConfig } = require("../../config");
const { findCompose, readCompose } = require("../config/composeKeys.test");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const { S, FACTION_A } = H;
const { CHAR, PLAYER_SHIP, pos } = P;
const FAR = 1e12;

const player = (characterId, entityId, x, extra = {}) => ({ characterId, entityId, position: pos(x), inWarp: false,
  cloaked: false, jumpCloaked: false, capsule: false, ...extra });

function hostileRig(base, hostileEnabled, extraSettings = {}) {
  const spy = { claims: [], ends: 0, reads: 0, attacks: [], near: true };
  const t = P.setup(base, { settings: { hostileEnabled, ...extraSettings }, deps: ({ w, facade }) => ({
    getFleetExposure: () => ({ ...facade,
      claimInTx: (db, x) => {
        spy.claims.push(x);
        return facade.claimInTx(db, x);
      },
      endInTx: (db, x) => {
        spy.ends += 1;
        return facade.endInTx(db, x);
      } }),
    readStanding: () => {
      spy.reads += 1;
      return { ok: true, standing: 0 };
    },
    getFactionKind: () => "pirate",
    huntSettings: resolveConfig({ modDir: MOD_DIR, env: {} }).config.playerHunt,
    excludedFactionIds: [500018],
    getGraph: () => ({ getGraph: () => ({ ok: true, graph: { getSystem: () => ({ secClass: "nullsec" }) } }) }),
  }) });
  t.w.scene.readPlayerShips = (sys) => {
    if (!t.w.loaded.has(sys)) return { ok: false, reason: "SCENE_NOT_LOADED" };
    const first = [...t.w.npc.values()][0];
    const x = spy.near && first ? first.position.x + 100000 : FAR;
    return { ok: true, ships: [player(CHAR, PLAYER_SHIP, x)] };
  };
  t.w.scene.attackTargets = (sys, ids, targets) => {
    spy.attacks.push({ ids: [...ids], targets: [...targets] });
    return { ok: true, failed: [] };
  };
  return Object.assign(t, { spy });
}

function idleFleet(t, tag) {
  const r = t.env.fleets.createFleet({ factionId: FACTION_A, currentSystemId: S.N0, homeSystemId: S.N0,
    fleetRole: "garrison", composition: [{ hullGroup: "frigate", count: 2 }] }, `${tag}:create`);
  assert.ok(r.ok, JSON.stringify(r));
  return r.fleetId;
}

function refitFleet(t, tag, due) {
  const id = idleFleet(t, tag);
  const f = t.fleetOf(id);
  const r = t.env.tx((db) => t.env.fleets.repository.transition(db, { fleetId: id, expectedVersion: f.version,
    from: "IDLE", to: "REFITTING", patch: { nextActionAt: due } }, `${tag}:refit`));
  assert.ok(r.ok, JSON.stringify(r));
  return id;
}

function plannedFleet(t, tag) {
  const id = idleFleet(t, tag);
  const op = t.env.fleets.createOperation({ operationType: "invasion", factionId: FACTION_A, originSystemId: S.N0,
    targetSystemId: S.N0, objective: "capture", dueAt: null, fleets: [{ fleetId: id, expectedVersion: 1 }] },
  `${tag}:op`);
  assert.ok(op.ok, JSON.stringify(op));
  assert.strictEqual(t.fleetOf(id).state, "PLANNED");
  return id;
}

const fromStateOf = (t, fleetId) => t.env.tx((db) => db.prepare("SELECT from_state FROM world_fleet_exposures "
  + "WHERE fleet_id = ? ORDER BY started_at DESC LIMIT 1").get(fleetId)).from_state;

module.exports = ({ test, skip }) => {
  test("PH1 targetsOf: hostility by the injected rule, aggressor always, warp / cloak / jump cloak / capsule out, "
    + "range, order by distance", () => {
    const ships = [{ entityId: 1, position: pos(0) }];
    const hostile = new Set([11, 13]);
    const input = (players, extra = {}) => ({ ships, players, aggressorEntityIds: new Set(),
      isHostile: (c) => hostile.has(c), rangeMeters: 150000, ...extra });
    const ids = (r) => r.map((x) => x.entityId);
    assert.deepStrictEqual(ids(PH.targetsOf(input([player(11, 101, 1000), player(12, 102, 1000),
      player(13, 103, 500), player(14, 104, 100)]))), [103, 101]);
    const agg = PH.targetsOf(input([player(14, 104, 900000)], { aggressorEntityIds: new Set([104]) }));
    assert.deepStrictEqual(agg.map((x) => [x.entityId, x.retaliation]), [[104, true]], "aggressor always");
    const states = [{ inWarp: true }, { cloaked: true }, { jumpCloaked: true }, { capsule: true }];
    assert.deepStrictEqual(states.map((s) => PH.targetsOf(input([player(11, 101, 10, s)],
      { aggressorEntityIds: new Set([101]) })).length), [0, 0, 0, 0]);
    assert.deepStrictEqual(PH.targetsOf(input([player(11, 101, 150001)])), [], "out of range");
    assert.deepStrictEqual(ids(PH.targetsOf(input([player(11, 109, 2000), player(13, 108, 2000)]))), [108, 109],
      "tie -> entityId");
    assert.deepStrictEqual(PH.targetsOf(null), []);
    assert.deepStrictEqual(PH.targetsOf(input([player(11, 101, 10)], { isHostile: () => {
      throw new Error("x");
    } })), []);
  });

  test("PH2 admitWake: highsec limit 1, class off the list / null refused, pass / system / global limits; orderPlan "
    + "i % n, skips ships on a target, maxOrders, [] without a target", () => {
    const p = { hostileMaxEngagedPerSystem: 4, hostileHighsecMaxEngagedPerSystem: 1, hostileMaxEngagedGlobal: 16,
      hostileMaxWakesPerPass: 2 };
    const all = ["highsec", "lowsec", "nullsec", "wormhole"];
    const f = (x) => ({ secClass: "nullsec", secClasses: all, engagedInSystem: 0, engagedGlobal: 0, wakesThisPass: 0,
      ...x });
    const why = (x) => PH.admitWake(f(x), p).reason || "OK";
    assert.deepStrictEqual([why({}), why({ secClass: "highsec" }), why({ secClass: "highsec", engagedInSystem: 1 }),
      why({ engagedInSystem: 3 }), why({ engagedInSystem: 4 }), why({ secClass: null }),
      why({ secClass: "nullsec", secClasses: ["highsec"] }), why({ secClasses: [] }), why({ wakesThisPass: 2 }),
      why({ engagedGlobal: 16 })],
    ["OK", "OK", "SYSTEM_LIMIT", "OK", "SYSTEM_LIMIT", "NO_SEC_CLASS", "SEC_CLASS", "SEC_CLASS", "PASS_LIMIT",
      "GLOBAL_LIMIT"]);
    const ships = [{ entityId: 1, attackTargetId: 0 }, { entityId: 2, attackTargetId: 201 },
      { entityId: 3, attackTargetId: 999 }, { entityId: 4, attackTargetId: 0 }];
    const targets = [{ entityId: 201 }, { entityId: 202 }];
    assert.deepStrictEqual(PH.orderPlan(ships, targets, 24), [{ entityId: 1, targetId: 201 },
      { entityId: 3, targetId: 202 }, { entityId: 4, targetId: 201 }]);
    assert.deepStrictEqual(PH.orderPlan(ships, targets, 2).length, 2);
    assert.deepStrictEqual(PH.orderPlan(ships, [], 24), []);
    assert.deepStrictEqual(PH.orderPlan(ships, targets, 0), []);
  });

  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("PH3 wake: flag off -> zero claims, attack orders and standing reads; flag on, a hostile player at "
    + "100 km for hostileWakeDelayMs -> one claimInTx PRESENCE with the character and attackTargets on his ship", () =>
    H.withStore(driver, async (reopen) => {
      const off = hostileRig(reopen, false);
      const g = idleFleet(off, "ph3");
      off.w.player(S.N0);
      off.pass();
      off.pass(1000);
      off.pass(off.settings.hostileWakeDelayMs);
      off.pass(off.settings.hostileWakeDelayMs);
      assert.deepStrictEqual([off.entryOf(g).phase, off.spy.claims.length, off.spy.attacks.length, off.spy.reads],
        ["VISIBLE", 0, 0, 0]);
      assert.strictEqual(off.step.getStatus().hostile.enabled, false);

      const t = hostileRig(off.base, true);
      t.w.player(S.N0);
      t.pass();
      assert.strictEqual(t.entryOf(g).phase, "VISIBLE");
      t.pass(1000);
      assert.deepStrictEqual([t.entryOf(g).phase, t.spy.claims.length], ["VISIBLE", 0], "wake delay");
      t.pass(t.settings.hostileWakeDelayMs);
      assert.strictEqual(t.spy.claims.length, 1);
      assert.deepStrictEqual([t.spy.claims[0].kind, t.spy.claims[0].characterId], ["PRESENCE", CHAR]);
      assert.deepStrictEqual([t.entryOf(g).phase, t.entryOf(g).hostileCharacterId, t.fleetOf(g).state],
        ["HELD", CHAR, "MATERIALIZED"]);
      assert.ok(t.spy.attacks.length >= 1 && t.spy.attacks.every((a) => a.targets[0] === PLAYER_SHIP),
        JSON.stringify(t.spy.attacks));
      assert.deepStrictEqual([t.counters().presenceHostileWakes, t.step.getStatus().hostile.engaged], [1, 1]);
      t.pass(1000);
      assert.strictEqual(t.spy.claims.length, 1, "no second claim");
    }));

  needsDriver("PH4 hold: HELD with the target in range after holdQuietMs stays HELD; the target leaves -> EXIT after "
    + "holdQuietMs, END with one endInTx; the next pass with the player in range -> no claim (cooldown)", () =>
    H.withStore(driver, async (reopen) => {
      const t = hostileRig(reopen, true);
      const g = idleFleet(t, "ph4");
      t.w.player(S.N0);
      t.pass();
      t.pass(1000);
      t.pass(t.settings.hostileWakeDelayMs);
      assert.strictEqual(t.entryOf(g).phase, "HELD");
      t.pass(t.held.holdQuietMs);
      assert.strictEqual(t.entryOf(g).phase, "HELD", "target in the chase range");
      t.spy.near = false;
      t.pass(1000);
      assert.strictEqual(t.entryOf(g).phase, "HELD");
      t.pass(t.held.holdQuietMs);
      assert.strictEqual(t.entryOf(g).phase, "EXITING");
      t.pass(1000);
      assert.deepStrictEqual([t.entryOf(g), t.spy.ends, t.fleetOf(g).state, t.counters().presenceHostileEnded],
        [null, 1, "IDLE", 1]);
      t.spy.near = true;
      t.pass(t.settings.scanIntervalMs);
      assert.strictEqual(t.entryOf(g).phase, "VISIBLE", "shown again");
      t.pass(1000);
      t.pass(t.settings.hostileWakeDelayMs);
      assert.deepStrictEqual([t.entryOf(g).phase, t.spy.claims.length, t.spy.ends], ["VISIBLE", 1, 1]);
      assert.ok(t.counters().presenceHostileCooled > 0);
      assert.strictEqual(t.step.getStatus().hostile.cooled, 1);
    }));

  needsDriver("PH6: a REFITTING fleet with a hostile player in range wakes - one "
    + "claimInTx PRESENCE (from_state REFITTING) + attackTargets; the end releases it to REFITTING with the same "
    + "deadline (one endInTx)", () => H.withStore(driver, async (reopen) => {
    const t = hostileRig(reopen, true);
    assert.strictEqual(t.settings.hostileClaimStates, "IDLE,STAGED,REFITTING");
    const due = t.clock.now() + 86400000;
    const g = refitFleet(t, "ph6", due);
    t.w.player(S.N0);
    t.pass();
    assert.deepStrictEqual([t.entryOf(g).phase, t.entryOf(g).fleetState], ["VISIBLE", "REFITTING"]);
    t.pass(1000);
    t.pass(t.settings.hostileWakeDelayMs);
    assert.deepStrictEqual([t.spy.claims.length, t.spy.claims[0].kind, t.entryOf(g).phase, t.fleetOf(g).state,
      fromStateOf(t, g)], [1, "PRESENCE", "HELD", "MATERIALIZED", "REFITTING"]);
    assert.ok(t.spy.attacks.length >= 1 && t.spy.attacks.every((a) => a.targets[0] === PLAYER_SHIP),
      JSON.stringify(t.spy.attacks));
    assert.deepStrictEqual([t.counters().presenceHostileWakes, t.counters().presenceHostileSkippedState,
      t.counters().presenceHostileWithdrawn], [1, 0, 0]);
    t.pass(t.held.holdQuietMs);
    t.spy.near = false;
    t.pass(1000);
    t.pass(t.held.holdQuietMs);
    assert.strictEqual(t.entryOf(g).phase, "EXITING");
    t.pass(1000);
    const f = t.fleetOf(g);
    assert.deepStrictEqual([t.entryOf(g), t.spy.ends, f.state, f.nextActionAt, f.shipCount],
      [null, 1, "REFITTING", due, 2]);
  }));

  needsDriver("PH7: an aggression on a REFITTING fleet with the flag on -> claim "
    + "retaliation (attackTargets on the aggressor), no despawn UNCLAIMABLE", () =>
    H.withStore(driver, async (reopen) => {
      const t = hostileRig(reopen, true);
      t.spy.near = false;
      const g = refitFleet(t, "ph7", t.clock.now() + 86400000);
      t.w.player(S.N0);
      t.pass();
      assert.strictEqual(t.entryOf(g).phase, "VISIBLE");
      t.w.aggressors.set(t.entryOf(g).entityIds[0], {});
      t.pass(1000);
      assert.deepStrictEqual([t.entryOf(g).phase, t.fleetOf(g).state, fromStateOf(t, g),
        t.counters().presenceHostileRetaliations, t.counters().presenceUnclaimable],
      ["HELD", "MATERIALIZED", "REFITTING", 1, 0]);
      assert.ok(t.spy.attacks.some((a) => a.targets[0] === PLAYER_SHIP), JSON.stringify(t.spy.attacks));
    }));

  needsDriver("PH8: a PLANNED fleet with a hostile player in range for hostileWakeDelayMs -> "
    + "despawn + cooldown (presenceHostileWithdrawn), no claim, no row; flag off -> shown as before", () =>
    H.withStore(driver, async (reopen) => {
      const t = hostileRig(reopen, true);
      const g = plannedFleet(t, "ph8");
      t.w.player(S.N0);
      t.pass();
      const rows0 = t.rows();
      assert.strictEqual(t.entryOf(g).fleetState, "PLANNED");
      t.pass(1000);
      assert.strictEqual(t.entryOf(g).phase, "VISIBLE", "wake delay");
      t.pass(t.settings.hostileWakeDelayMs);
      assert.deepStrictEqual([t.entryOf(g), t.counters().presenceHostileWithdrawn, t.spy.claims.length, t.rows()],
        [null, 1, 0, rows0]);
      t.pass(t.settings.scanIntervalMs);
      assert.strictEqual(t.entryOf(g), null, "cooldown");

      const off = hostileRig(t.base, false);
      off.w.player(S.N0);
      off.pass();
      off.pass(1000);
      off.pass(off.settings.hostileWakeDelayMs);
      assert.deepStrictEqual([off.entryOf(g).phase, off.counters().presenceHostileWithdrawn, off.spy.claims.length],
        ["VISIBLE", 0, 0]);
    }));

  needsDriver("PH9: hostileClaimStates none -> a REFITTING fleet with a hostile player in range "
    + "stays shown only (skipped, no claim, no withdrawal, no write)", () => H.withStore(driver, async (reopen) => {
    const t = hostileRig(reopen, true, { hostileClaimStates: "none" });
    const g = refitFleet(t, "ph9", t.clock.now() + 86400000);
    t.w.player(S.N0);
    t.pass();
    const rows0 = t.rows();
    t.pass(1000);
    t.pass(t.settings.hostileWakeDelayMs);
    t.pass(t.settings.hostileWakeDelayMs);
    assert.deepStrictEqual([t.entryOf(g).phase, t.spy.claims.length, t.counters().presenceHostileSkippedState,
      t.counters().presenceHostileWithdrawn, t.rows()], ["VISIBLE", 0, 1, 0, rows0]);
  }));

  needsDriver("PH10 debt-sweep: a kill of a VISIBLE REFITTING ship (flag on, no wake) -> stepPending keeps it pending, "
    + "one claim PRESENCE from_state REFITTING with the loss, presenceLossDropped 0, one ship less", () =>
    H.withStore(driver, async (reopen) => {
      const t = hostileRig(reopen, true);
      t.spy.near = false;
      const g = refitFleet(t, "ph10", t.clock.now() + 86400000);
      t.w.player(S.N0);
      t.pass();
      assert.deepStrictEqual([t.entryOf(g).phase, t.entryOf(g).fleetState], ["VISIBLE", "REFITTING"]);
      t.w.kill(t.entryOf(g).entityIds[0]);
      t.step.stepPending(t.clock.now(), { refused: {} });
      assert.deepStrictEqual([t.step.hasPendingLoss(g), t.entryOf(g).phase, t.counters().presenceLossDropped],
        [true, "VISIBLE", 0], "pending, not dropped");
      t.pass(1000);
      assert.deepStrictEqual([t.spy.claims.length, t.spy.claims[0].kind, t.entryOf(g).phase, t.fleetOf(g).state,
        fromStateOf(t, g), t.counters().presenceLossImported, t.counters().presenceLossDropped,
        t.counters().presenceUnclaimable], [1, "PRESENCE", "HELD", "MATERIALIZED", "REFITTING", 1, 0, 0]);
      t.pass(t.held.holdQuietMs);
      t.pass(1000);
      t.pass(t.held.holdQuietMs);
      t.pass(1000);
      const f = t.fleetOf(g);
      assert.deepStrictEqual([t.entryOf(g), f.state, f.shipCount, t.spy.ends], [null, "REFITTING", 1, 1]);
    }));

  test("PH5 config: defaults (hostileEnabled false), clamp, chase < aggro -> warning + aggro, hostile without "
    + "presence -> warning; the flag passes compose with 0", () => {
    const d = resolveConfig({ modDir: MOD_DIR, env: {} });
    const p = d.config.fleetExposure.presence;
    assert.deepStrictEqual([p.hostileEnabled, p.hostileAggroRangeMeters, p.hostileChaseRangeMeters,
      p.hostileWakeDelayMs, p.hostileMaxWakesPerPass, p.hostileMaxEngagedPerSystem, p.hostileHighsecMaxEngagedPerSystem,
      p.hostileMaxEngagedGlobal, p.hostileSecClasses, p.hostileRewakeCooldownMs, p.hostileMaxOrdersPerPass,
      p.hostileMaxStandingReadsPerPass, p.hostileStandingTtlMs],
    [false, 150000, 250000, 3000, 2, 4, 1, 16, "highsec,lowsec,nullsec,wormhole", 300000, 24, 32, 30000]);
    assert.deepStrictEqual(d.warnings.filter((w) => w.includes("presence.hostile")), []);
    const E = "EVEJS_LNE_FLEET_EXPOSURE_PRESENCE_";
    const c = resolveConfig({ modDir: MOD_DIR, env: { [`${E}HOSTILE_AGGRO_RANGE_METERS`]: "1",
      [`${E}HOSTILE_MAX_WAKES_PER_PASS`]: "99" } }).config.fleetExposure.presence;
    assert.deepStrictEqual([c.hostileAggroRangeMeters, c.hostileMaxWakesPerPass], [10000, 16]);
    const r = resolveConfig({ modDir: MOD_DIR, env: { [`${E}HOSTILE_AGGRO_RANGE_METERS`]: "200000",
      [`${E}HOSTILE_CHASE_RANGE_METERS`]: "100000", [`${E}HOSTILE_ENABLED`]: "1" } });
    assert.strictEqual(r.config.fleetExposure.presence.hostileChaseRangeMeters, 200000);
    assert.ok(r.warnings.some((w) => w.startsWith("fleetExposure.presence.hostileChaseRangeMeters=100000")),
      JSON.stringify(r.warnings));
    assert.ok(r.warnings.some((w) => w.startsWith("fleetExposure.presence.hostileEnabled without")));
    const none = resolveConfig({ modDir: MOD_DIR, env: { [`${E}HOSTILE_SEC_CLASSES`]: "none" } });
    assert.strictEqual(none.config.fleetExposure.presence.hostileSecClasses, "none");
    const claimStates = (v) => resolveConfig({ modDir: MOD_DIR, env: { [`${E}HOSTILE_CLAIM_STATES`]: v } })
      .config.fleetExposure.presence.hostileClaimStates;
    assert.deepStrictEqual([p.hostileClaimStates, claimStates("none"), claimStates("REFITTING"),
      claimStates("PLANNED")], ["IDLE,STAGED,REFITTING", "none", "REFITTING", "IDLE,STAGED,REFITTING"]);
    const file = findCompose();
    if (file) assert.strictEqual(readCompose(file).env[`${E}HOSTILE_ENABLED`], "0");
  });
};
