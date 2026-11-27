"use strict";

const assert = require("node:assert");

const { createUnavailableBattle } = require("../../lib/battle");
const { LIVE_METHODS } = require("../../lib/battle/liveBridge");
const { createLiveMemberRepository } = require("../../lib/battle/liveMemberRepository");
const { planLiveMembers, buildLiveResult } = require("../../lib/battle/liveMembers");
const { validateResult } = require("../../lib/battle/contract");
const { MIGRATIONS } = require("../../lib/persistence/migrations");
const { TABLE_POLICY } = require("../../lib/persistence/worldReset");
const { harness: H } = require("./settlement.test");
const { harness: C } = require("./contacts.test");

const COMP2 = Object.freeze([{ hullGroup: "cruiser", count: 2 }]);
const AT = 1760000600000;
const BOOT_AT = 1760000000000;

function setup(driver, opts = {}) {
  const seam = C.seamResolver(() => "DRAW");
  const env = C.createEnv(driver, { resolver: seam, config: opts.config });
  const T = (fn) => {
    const r = env.store.transaction("test.live", fn);
    assert.ok(r.ok, JSON.stringify(r));
    return r.value;
  };
  const members = createLiveMemberRepository({ clock: env.clock });
  const battle = (id) => T((db) => env.battle.repository.getBattle(db, id)).battle;
  let n = 0;
  const mk = (opts = {}) => {
    n += 1;
    const system = opts.systemId || H.S.N5;
    const a = env.newFleet(`lb-a${n}`, C.SANSHA, system, opts.compA || COMP2);
    const b = env.newFleet(`lb-b${n}`, C.GURISTAS, system, opts.compB || COMP2);
    const side = (factionId, id) => ({ factionId, fleets: [{ fleetId: id, expectedVersion: env.fleet(id).version }] });
    const spec = { systemId: system, environment: "nullsec", objective: "destroy", resolverVersion: "internal-v1",
      maxResolutionMs: 20, garrison: opts.garrison || null, sideA: side(C.SANSHA, a), sideB: side(C.GURISTAS, b),
      ...(opts.structure || {}) };
    const created = T((db) => env.battle.repository.createBattle(db, spec, `lb:${n}:battle`));
    assert.strictEqual(created.ok, true, JSON.stringify(created));
    return { battleId: created.battleId, a, b };
  };
  const specsOf = (b, profileId = "prof_test") => planLiveMembers(b.input, { maxShips: 256 }).members
    .map((m) => ({ ...m, profileId }));
  const rows = (id) => env.q("SELECT * FROM battle_live_members WHERE battle_id = ? ORDER BY member_key", id);
  return { env, seam, T, members, battle, mk, specsOf, rows, live: env.battle.live };
}

function toLive(s, opts) {
  const { battleId, a, b } = s.mk(opts);
  const pending = s.battle(battleId);
  const c = s.T((db) => s.live.claimLiveInTx(db, { battleId, expectedVersion: pending.version }, s.specsOf(pending)));
  assert.strictEqual(c.ok, true, JSON.stringify(c));
  const spawned = s.rows(battleId).map((r, i) => ({ memberKey: r.member_key, entityId: 9000 + i }));
  const m = s.T((db) => s.live.markLiveInTx(db, { battleId, expectedVersion: c.version, claimSeq: c.claimSeq,
    bootAt: BOOT_AT, spawned }));
  assert.strictEqual(m.ok, true, JSON.stringify(m));
  return { battleId, a, b, claimSeq: c.claimSeq };
}

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("LB1 happy path: claim LIVE (4 PLANNED) -> LIVE (4 SPAWNED) -> 1 DESTROYED -> exit EXIT -> "
    + "COMPLETED once, LIVE_EVEJS, 1 loss row, fleets released, members deleted, wrecks skipped, no resolver call",
  async () => {
    const s = setup(driver);
    try {
      const { battleId, a, b } = s.mk();
      const pending = s.battle(battleId);
      assert.strictEqual(pending.state, "PENDING");
      const c = s.T((db) => s.live.claimLiveInTx(db, { battleId, expectedVersion: pending.version },
        s.specsOf(pending)));
      assert.deepStrictEqual([c.ok, c.duplicate, c.claimSeq], [true, false, 1], JSON.stringify(c));
      assert.deepStrictEqual([s.battle(battleId).state, s.battle(battleId).mode], ["CLAIMED", "LIVE_EVEJS"]);
      assert.deepStrictEqual(s.rows(battleId).map((r) => [r.state, r.claim_seq, r.profile_id]),
        Array(4).fill(["PLANNED", 1, "prof_test"]));

      const spawned = s.rows(battleId).map((r, i) => ({ memberKey: r.member_key, entityId: 7000 + i }));
      const m = s.T((db) => s.live.markLiveInTx(db, { battleId, expectedVersion: c.version, claimSeq: 1,
        bootAt: BOOT_AT, spawned }));
      assert.deepStrictEqual([m.ok, m.duplicate], [true, false], JSON.stringify(m));
      assert.strictEqual(s.battle(battleId).state, "LIVE");
      assert.deepStrictEqual(s.rows(battleId).map((r) => r.state), Array(4).fill("SPAWNED"));
      const found = s.T((db) => s.members.findByEntity(db, BOOT_AT, 7000));
      assert.strictEqual(found.member.battleId, battleId);

      const victim = s.rows(battleId).find((r) => r.fleet_id === b).member_key;
      const d = s.T((db) => s.members.markDestroyed(db, battleId, victim));
      assert.strictEqual(d.ok, true, JSON.stringify(d));

      const x = s.T((db) => s.live.exitLiveInTx(db, { battleId, at: AT, reason: "EXIT" }));
      assert.deepStrictEqual([x.ok, x.duplicate, x.outcome, x.membersDeleted], [true, false, "COMPLETED", 4],
        JSON.stringify(x));
      const done = s.battle(battleId);
      assert.deepStrictEqual([done.state, done.mode, done.settlementKey], ["COMPLETED", "LIVE_EVEJS",
        `battle:${battleId}:settle:v1`]);
      assert.strictEqual(done.result.outcome, "DRAW");
      assert.deepStrictEqual(done.result.diagnostics, { source: "live", exit: "EXIT" });
      assert.deepStrictEqual(s.env.q("SELECT fleet_id, hull_group, count FROM battle_losses WHERE battle_id = ?",
        battleId).map((r) => ({ ...r })), [{ fleet_id: b, hull_group: "cruiser", count: 1 }]);
      for (const id of [a, b]) {
        assert.ok(["STAGED", "IDLE"].includes(s.env.fleet(id).state), `${id}: ${s.env.fleet(id).state}`);
      }
      assert.strictEqual(s.env.fleet(b).shipCount, 1);
      assert.strictEqual(s.rows(battleId).length, 0, "members deleted with COMPLETED");
      assert.strictEqual(s.env.n("SELECT count(*) AS n FROM world_event_journal WHERE idempotency_key = ?",
        `battle:${battleId}:settle:v1:c:wrecks`), 1, "consequence wrecks applied (skipped)");
      assert.strictEqual(s.env.n("SELECT count(*) AS n FROM world_wreck_fields"), 0, "LIVE: no virtual wreck field");
      assert.strictEqual(s.env.n("SELECT count(*) AS n FROM world_event_journal WHERE event_type = 'BATTLE_SETTLED' "
        + "AND aggregate_id = ?", battleId), 1);
      assert.strictEqual(s.seam.calls, 0, "resolver not called");
      assert.strictEqual(s.env.battle.settlement.getCounters().liveCompleted, 1);
      for (const name of ["claimed", "live", "settled"]) {
        assert.strictEqual(s.env.telemetry.counts[`battle.live.${name}`], 1, name);
      }
    } finally {
      s.env.close();
    }
  });

  needsDriver("LB2 idempotency / never twice: claim twice = duplicate (4 rows), same member_key refused "
    + "exit twice = duplicate; virtual settle of LIVE and settleLive of VIRTUAL -> MODE_MISMATCH", async () => {
    const s = setup(driver);
    try {
      const { battleId } = s.mk();
      const pending = s.battle(battleId);
      const specs = s.specsOf(pending);
      const c1 = s.T((db) => s.live.claimLiveInTx(db, { battleId, expectedVersion: pending.version }, specs));
      const c2 = s.T((db) => s.live.claimLiveInTx(db, { battleId, expectedVersion: pending.version }, specs));
      assert.deepStrictEqual([c1.duplicate, c2.ok, c2.duplicate], [false, true, true], JSON.stringify(c2));
      const other = s.T((db) => s.live.claimLiveInTx(db, { battleId, expectedVersion: pending.version },
        s.specsOf(pending, "prof_other")));
      assert.strictEqual(other.reason, "IDEMPOTENCY_CONFLICT", JSON.stringify(other));
      assert.strictEqual(s.rows(battleId).length, 4);
      const again = s.T((db) => s.members.insertPlanned(db, battleId, 1, [specs[0]]));
      assert.strictEqual(again.reason, "MEMBER_EXISTS", JSON.stringify(again));
      assert.strictEqual(s.rows(battleId).length, 4);

      const spawned = s.rows(battleId).map((r, i) => ({ memberKey: r.member_key, entityId: 8000 + i }));
      const m = s.T((db) => s.live.markLiveInTx(db, { battleId, expectedVersion: c1.version, claimSeq: 1,
        bootAt: BOOT_AT, spawned }));
      assert.strictEqual(m.ok, true, JSON.stringify(m));
      const live = s.battle(battleId);
      const virtual = s.T((db) => s.env.battle.settlement.settle(db, { battleId, inputHash: live.inputHash,
        result: H.resultFor(live.input, "DRAW"), at: AT }, 1));
      assert.strictEqual(virtual.reason, "MODE_MISMATCH", JSON.stringify(virtual));

      const x1 = s.T((db) => s.live.exitLiveInTx(db, { battleId, at: AT, reason: "END" }));
      const x2 = s.T((db) => s.live.exitLiveInTx(db, { battleId, at: AT + 1, reason: "END" }));
      assert.deepStrictEqual([x1.duplicate, x2.ok, x2.duplicate, x2.outcome], [false, true, true, "COMPLETED"]);
      const late = s.T((db) => s.env.battle.settlement.settle(db, { battleId, inputHash: live.inputHash,
        result: H.resultFor(live.input, "DRAW"), at: AT }, 1));
      assert.deepStrictEqual([late.ok, late.duplicate], [true, true], "one settlement key for both modes");
      assert.strictEqual(s.env.n("SELECT count(*) AS n FROM world_event_journal WHERE event_type = 'BATTLE_SETTLED' "
        + "AND aggregate_id = ?", battleId), 1);

      const v = s.mk({ systemId: H.S.N6 });
      const vb = s.battle(v.battleId);
      const claimed = s.T((db) => s.env.battle.repository.claim(db, { battleId: v.battleId,
        expectedVersion: vb.version, mode: "VIRTUAL" }, `battle:${v.battleId}:claim:1:VIRTUAL`));
      assert.strictEqual(claimed.ok, true);
      const t = s.T((db) => s.env.battle.repository.transition(db, { battleId: v.battleId,
        expectedVersion: claimed.version, from: "CLAIMED", to: "RESOLVING" }, `battle:${v.battleId}:resolving:1`));
      assert.strictEqual(t.ok, true);
      const wrong = s.T((db) => s.env.battle.settlement.settleLive(db, { battleId: v.battleId,
        result: H.resultFor(vb.input, "DRAW"), at: AT }, 1));
      assert.strictEqual(wrong.reason, "MODE_MISMATCH", JSON.stringify(wrong));
    } finally {
      s.env.close();
    }
  });

  needsDriver("LB3 refusals change nothing: RESOLVING -> BATTLE_ALREADY_RESOLVING, other ordinal -> "
    + "MEMBERS_INVALID, garrison -> GARRISON_UNSUPPORTED (battle + members + journal equal before/after)", async () => {
    const s = setup(driver);
    try {
      const resolving = s.mk();
      const r0 = s.battle(resolving.battleId);
      const c = s.T((db) => s.env.battle.repository.claim(db, { battleId: resolving.battleId,
        expectedVersion: r0.version, mode: "VIRTUAL" }, `battle:${resolving.battleId}:claim:1:VIRTUAL`));
      s.T((db) => s.env.battle.repository.transition(db, { battleId: resolving.battleId, expectedVersion: c.version,
        from: "CLAIMED", to: "RESOLVING" }, `battle:${resolving.battleId}:resolving:1`));
      const pending = s.mk({ systemId: H.S.N6 });
      const garrisoned = s.mk({ systemId: H.S.N7, garrison: { side: "B", factionId: C.GURISTAS, strength: 10 } });

      const snapshot = () => ({
        battles: s.env.q("SELECT * FROM battle_records ORDER BY battle_id").map((r) => ({ ...r })),
        members: s.env.q("SELECT * FROM battle_live_members").map((r) => ({ ...r })),
        journal: s.env.q("SELECT count(*) AS n, max(journal_id) AS id FROM world_event_journal").map((r) => ({ ...r })),
      });
      const before = snapshot();
      const rb = s.battle(resolving.battleId);
      const r1 = s.T((db) => s.live.claimLiveInTx(db, { battleId: rb.battleId, expectedVersion: rb.version },
        s.specsOf(rb)));
      assert.strictEqual(r1.reason, "BATTLE_ALREADY_RESOLVING", JSON.stringify(r1));
      const pb = s.battle(pending.battleId);
      const shifted = s.specsOf(pb).map((m, i) => (i === 0 ? { ...m, ordinal: 9 } : m));
      const r2 = s.T((db) => s.live.claimLiveInTx(db, { battleId: pb.battleId, expectedVersion: pb.version }, shifted));
      assert.strictEqual(r2.reason, "MEMBERS_INVALID", JSON.stringify(r2));
      const gb = s.battle(garrisoned.battleId);
      const r3 = s.T((db) => s.live.claimLiveInTx(db, { battleId: gb.battleId, expectedVersion: gb.version },
        s.specsOf(gb)));
      assert.strictEqual(r3.reason, "GARRISON_UNSUPPORTED", JSON.stringify(r3));
      assert.deepStrictEqual(snapshot(), before);
    } finally {
      s.env.close();
    }
  });

  needsDriver("LB4 revert: CLAIMED LIVE_EVEJS -> CLAIMED VIRTUAL claimSeq+1, no rows, one BATTLE_RESOLUTION "
    + "resolve:r<n>; second revert duplicate; markUnsupported -> LIVE_UNSUPPORTED, not materializable", async () => {
    const s = setup(driver);
    try {
      const { battleId } = s.mk();
      const pending = s.battle(battleId);
      const listed = s.T((db) => s.live.listMaterializableInTx(db, H.S.N5, {}));
      assert.deepStrictEqual(listed.battles.map((x) => [x.battleId, x.state, x.shipCount]), [[battleId, "PENDING", 4]]);
      const c = s.T((db) => s.live.claimLiveInTx(db, { battleId, expectedVersion: pending.version },
        s.specsOf(pending)));
      assert.strictEqual(s.T((db) => s.live.listMaterializableInTx(db, H.S.N5)).battles.length, 0,
        "CLAIMED LIVE_EVEJS is not materializable");
      const req = { battleId, expectedVersion: c.version, claimSeq: c.claimSeq, at: AT, reason: "SPAWN_FAILED" };
      const r1 = s.T((db) => s.live.revertLiveClaimInTx(db, req));
      assert.deepStrictEqual([r1.ok, r1.duplicate, r1.claimSeq, r1.deleted], [true, false, c.claimSeq + 1, 4],
        JSON.stringify(r1));
      const back = s.battle(battleId);
      assert.deepStrictEqual([back.state, back.mode, back.claimSeq], ["CLAIMED", "VIRTUAL", c.claimSeq + 1]);
      assert.strictEqual(s.rows(battleId).length, 0);
      const events = s.env.q("SELECT idempotency_key, due_at FROM world_scheduled_events WHERE event_type = "
        + "'BATTLE_RESOLUTION' AND aggregate_id = ?", battleId);
      assert.deepStrictEqual(events.map((e) => [e.idempotency_key, Number(e.due_at)]),
        [[`battle:${battleId}:resolve:r${c.claimSeq}`, AT]]);
      const r2 = s.T((db) => s.live.revertLiveClaimInTx(db, req));
      assert.deepStrictEqual([r2.ok, r2.duplicate], [true, true]);
      assert.strictEqual(s.T((db) => s.live.listMaterializableInTx(db, H.S.N5)).battles[0].mode, "VIRTUAL");

      const other = s.mk({ systemId: H.S.N6 });
      const ob = s.battle(other.battleId);
      const u = s.T((db) => s.live.markUnsupportedInTx(db, { battleId: other.battleId, expectedVersion: ob.version,
        reason: "NO_PROFILE" }));
      assert.deepStrictEqual([u.ok, u.duplicate], [true, false], JSON.stringify(u));
      assert.strictEqual(s.battle(other.battleId).holdReason, "LIVE_UNSUPPORTED");
      assert.deepStrictEqual(s.T((db) => s.live.listMaterializableInTx(db, H.S.N6)).battles, []);
      const notPending = s.T((db) => s.live.markUnsupportedInTx(db, { battleId, expectedVersion: back.version,
        reason: "NO_PROFILE" }));
      assert.strictEqual(notPending.reason, "NOT_PENDING");
      assert.strictEqual(s.env.telemetry.counts["battle.live.reverted"], 1);
      assert.strictEqual(s.env.telemetry.counts["battle.live.unsupported"], 1);
    } finally {
      s.env.close();
    }
  });

  needsDriver("LB5 pure plan/result + facade: member order, LIVE_TOO_LARGE before expansion, A_WIN / B_WIN "
    + "DRAW pass validateResult; ctx.battle.live keys === stub keys", async () => {
    const s = setup(driver);
    try {
      const { battleId } = toLive(s, { compA: [{ hullGroup: "frigate", typeId: 587, count: 1 },
        { hullGroup: "cruiser", count: 2 }], compB: [{ hullGroup: "destroyer", count: 1 }] });
      const b = s.battle(battleId);
      const fa = b.input.sideA.fleets[0].fleetId;
      const fb = b.input.sideB.fleets[0].fleetId;
      const plan = planLiveMembers(b.input, { maxShips: 4 });
      assert.deepStrictEqual(plan.members.map((m) => [m.side, m.memberKey]), [["A", `${fa}:cruiser:0:1`],
        ["A", `${fa}:cruiser:0:2`], ["A", `${fa}:frigate:587:1`], ["B", `${fb}:destroyer:0:1`]]);
      assert.deepStrictEqual(planLiveMembers(b.input, { maxShips: 3 }), { ok: false, reason: "LIVE_TOO_LARGE", ships: 4,
        limit: 3 });
      const huge = JSON.parse(JSON.stringify(b.input));
      huge.sideA.fleets[0].composition[0].count = 99990;
      const tooLarge = planLiveMembers(huge, { maxShips: 256 });
      assert.deepStrictEqual([tooLarge.reason, tooLarge.ships, tooLarge.members], ["LIVE_TOO_LARGE", 99992, undefined]);

      const rowsOf = (dead) => s.T((db) => s.live.listMembersInTx(db, battleId)).members
        .map((m) => ({ ...m, state: dead(m) ? "DESTROYED" : m.state }));
      const limits = { maxResultBytes: 65536 };
      for (const [dead, outcome] of [[(m) => m.side === "B", "A_WIN"], [(m) => m.side === "A", "B_WIN"],
        [() => false, "DRAW"], [() => true, "DRAW"]]) {
        const r = buildLiveResult(b, rowsOf(dead), { at: b.updatedAt + 90500, reason: "RESTART" });
        assert.strictEqual(r.ok, true, JSON.stringify(r));
        assert.deepStrictEqual([r.result.outcome, r.result.objectiveAchieved, r.result.estimatedDurationSec],
          [outcome, outcome === "A_WIN", 90]);
        assert.strictEqual(validateResult(b.input, r.result, limits).ok, true, outcome);
      }
      const short = buildLiveResult(b, rowsOf(() => false).slice(1), { at: AT, reason: "EXIT" });
      assert.strictEqual(short.reason, "MEMBERS_INVALID");

      const real = Object.keys(s.env.battle.live).sort();
      const stub = createUnavailableBattle("disabled_by_config").live;
      assert.deepStrictEqual(real, [...LIVE_METHODS].sort());
      assert.deepStrictEqual(Object.keys(stub).sort(), real);
      assert.deepStrictEqual(stub.claimLiveInTx(), { ok: false, reason: "disabled_by_config" });
      assert.ok(LIVE_METHODS.includes("planGarrison") && typeof s.env.battle.live.planGarrison === "function");
      assert.deepStrictEqual(stub.planGarrison(), { ok: false, reason: "disabled_by_config" });
      assert.ok(LIVE_METHODS.includes("readLiveInTx"));
      assert.deepStrictEqual(stub.readLiveInTx(), { ok: false, reason: "disabled_by_config" });
      const journalBefore = s.env.n("SELECT count(*) AS n FROM world_event_journal");
      const rl = s.T((db) => s.live.readLiveInTx(db, battleId));
      assert.strictEqual(rl.ok, true, JSON.stringify(rl));
      assert.deepStrictEqual(Object.keys(rl.battle).sort(), ["battleId", "claimSeq", "grid", "input", "mode", "state",
        "systemId", "updatedAt", "version"]);
      assert.strictEqual(rl.battle.grid, null);
      assert.deepStrictEqual([rl.battle.state, rl.battle.mode, rl.battle.claimSeq, rl.battle.version,
        rl.battle.systemId, rl.battle.updatedAt], ["LIVE", "LIVE_EVEJS", 1, b.version, H.S.N5, b.updatedAt]);
      assert.deepStrictEqual(rl.battle.input, b.input);
      assert.ok(Object.isFrozen(rl.battle) && Object.isFrozen(rl.battle.input));
      assert.strictEqual(s.T((db) => s.live.readLiveInTx(db, "battle_missing")).reason, "BATTLE_NOT_FOUND");
      assert.strictEqual(s.live.readLiveInTx(null, battleId).reason, "TX_REQUIRED");
      assert.strictEqual(s.T((db) => s.live.readLiveInTx(db, "")).reason, "LIVE_INVALID_INPUT");
      assert.strictEqual(s.env.n("SELECT count(*) AS n FROM world_event_journal"), journalBefore);

      const migration = MIGRATIONS.find((m) => m.version === 34);
      assert.strictEqual(migration.name, "battle_live_members");
      assert.strictEqual(TABLE_POLICY.battle_live_members, "WIPE");
      s.env.battle.stop("test");
      assert.strictEqual(s.env.battle.live.listMembersInTx().reason, "BATTLE_STOPPED");
    } finally {
      s.env.close();
    }
  });

  needsDriver("SO2 exitLiveInTx(STRUCTURE_DESTROYED, structure destroyed) -> COMPLETED, structureDestroyed "
    + "members 0 (CR-M6); again -> duplicate, one settle:v1 (CR-M10); structure on a battle without structureId -> "
    + "LIVE_INVALID_INPUT, nothing changed", async () => {
    const s = setup(driver);
    try {
      const STRUCT = { structureId: 1030000000007, structureTypeId: 35832, structureSide: "B" };
      const { battleId } = toLive(s, { structure: STRUCT });
      const req = { battleId, at: AT, reason: "STRUCTURE_DESTROYED", structure: { destroyed: true } };
      const x1 = s.T((db) => s.live.exitLiveInTx(db, req));
      const done = s.battle(battleId);
      const x2 = s.T((db) => s.live.exitLiveInTx(db, { ...req, at: AT + 1 }));
      const plain = toLive(s, { systemId: H.S.N6 });
      const before = [s.battle(plain.battleId).version, s.rows(plain.battleId).length];
      const bad = s.T((db) => s.live.exitLiveInTx(db, { battleId: plain.battleId, at: AT, reason: "EXIT",
        structure: { destroyed: false } }));
      const settleKeys = s.env.n("SELECT count(*) AS n FROM world_event_journal WHERE idempotency_key = ?",
        `battle:${battleId}:settle:v1`);
      assert.deepStrictEqual({ x1: [x1.ok, x1.duplicate, x1.outcome, x1.membersDeleted],
        state: [done.state, done.result.structureDestroyed, done.result.objectiveAchieved, done.result.structureId,
          done.result.outcome, done.result.diagnostics.exit],
        rows: s.rows(battleId).length, x2: [x2.ok, x2.duplicate], settleKeys,
        bad: [bad.reason, bad.detail], after: [s.battle(plain.battleId).version, s.rows(plain.battleId).length,
          s.battle(plain.battleId).state] },
      { x1: [true, false, "COMPLETED", 4], state: ["COMPLETED", true, true, STRUCT.structureId, "DRAW",
        "STRUCTURE_DESTROYED"], rows: 0, x2: [true, true], settleKeys: 1,
      bad: ["LIVE_INVALID_INPUT", "structure: no structureId"], after: [...before, "LIVE"] });
    } finally {
      s.env.close();
    }
  });

  needsDriver("GLV5 flag on -> claim with 4 proxies; proxy on the wrong "
    + "side / other faction / ordinal gap / without a garrison -> MEMBERS_INVALID, nothing changed; LIVE, fleets dead + "
    + "proxies alive -> exit END COMPLETED B_WIN once (second exit duplicate), losses only of fleets, influence rows "
    + "unchanged, garrisonClaimed 1", async () => {
    const s = setup(driver, { config: { "battle.garrisonLive.enabled": true } });
    try {
      const GARRISON = { side: "B", factionId: C.GURISTAS, strength: 80 };
      const OPTS = { maxShips: 6, pointsPerShip: 25, hullGroup: "cruiser", room: 40 };
      const g = s.mk({ garrison: GARRISON });
      const plain = s.mk({ systemId: H.S.N6 });
      const gb = s.battle(g.battleId);
      const gp = s.live.planGarrison(gb.input, OPTS);
      assert.strictEqual(gp.ships, 4, JSON.stringify(gp));
      const proxies = gp.members.map((m) => ({ ...m, profileId: "prof_garrison" }));
      const specs = [...s.specsOf(gb), ...proxies];

      const snapshot = () => ({
        battles: s.env.q("SELECT * FROM battle_records ORDER BY battle_id").map((r) => ({ ...r })),
        members: s.env.q("SELECT * FROM battle_live_members").map((r) => ({ ...r })),
        journal: s.env.q("SELECT count(*) AS n, max(journal_id) AS id FROM world_event_journal").map((r) => ({ ...r })),
      });
      const before = snapshot();
      const proxyAt = (list, i, patch) => list.map((m, j) => (j === s.specsOf(gb).length + i ? { ...m, ...patch } : m));
      const pb = s.battle(plain.battleId);
      const refusals = {
        side: s.T((db) => s.live.claimLiveInTx(db, { battleId: g.battleId, expectedVersion: gb.version },
          proxyAt(specs, 0, { side: "A" }))).reason,
        faction: s.T((db) => s.live.claimLiveInTx(db, { battleId: g.battleId, expectedVersion: gb.version },
          proxyAt(specs, 1, { factionId: C.SANSHA }))).reason,
        gap: s.T((db) => s.live.claimLiveInTx(db, { battleId: g.battleId, expectedVersion: gb.version },
          proxyAt(specs, 3, { ordinal: 5, memberKey: "garrison:cruiser:0:5" }))).reason,
        noGarrison: s.T((db) => s.live.claimLiveInTx(db, { battleId: pb.battleId, expectedVersion: pb.version },
          [...s.specsOf(pb), ...proxies])).reason,
      };
      assert.deepStrictEqual(refusals, { side: "MEMBERS_INVALID", faction: "MEMBERS_INVALID", gap: "MEMBERS_INVALID",
        noGarrison: "MEMBERS_INVALID" });
      assert.deepStrictEqual(snapshot(), before, "refusals change nothing");

      const influence = () => s.env.q("SELECT * FROM world_system_influence ORDER BY 1, 2").map((r) => ({ ...r }));
      const influenceBefore = influence();
      const c = s.T((db) => s.live.claimLiveInTx(db, { battleId: g.battleId, expectedVersion: gb.version }, specs));
      assert.deepStrictEqual([c.ok, c.duplicate], [true, false], JSON.stringify(c));
      assert.deepStrictEqual(s.rows(g.battleId).filter((r) => r.fleet_id === "garrison")
        .map((r) => [r.side, r.faction_id, r.hull_group, r.type_id, r.state]), Array(4).fill(["B", C.GURISTAS,
        "cruiser", 0, "PLANNED"]));
      const spawned = s.rows(g.battleId).map((r, i) => ({ memberKey: r.member_key, entityId: 9100 + i }));
      const m = s.T((db) => s.live.markLiveInTx(db, { battleId: g.battleId, expectedVersion: c.version,
        claimSeq: c.claimSeq, bootAt: BOOT_AT, spawned }));
      assert.strictEqual(m.ok, true, JSON.stringify(m));
      for (const r of s.rows(g.battleId).filter((x) => x.fleet_id !== "garrison")) {
        assert.strictEqual(s.T((db) => s.live.markDestroyedInTx(db, { battleId: g.battleId,
          memberKey: r.member_key })).ok, true);
      }
      const x1 = s.T((db) => s.live.exitLiveInTx(db, { battleId: g.battleId, at: AT, reason: "END" }));
      const x2 = s.T((db) => s.live.exitLiveInTx(db, { battleId: g.battleId, at: AT + 1, reason: "END" }));
      const done = s.battle(g.battleId);
      const losses = s.env.q("SELECT fleet_id, hull_group, count FROM battle_losses WHERE battle_id = ? ORDER BY "
        + "fleet_id", g.battleId).map((r) => ({ ...r }));
      assert.deepStrictEqual({ x1: [x1.ok, x1.duplicate, x1.outcome, x1.membersDeleted], x2: [x2.ok, x2.duplicate],
        state: [done.state, done.mode, done.result.outcome, done.result.diagnostics], losses,
        settleKeys: s.env.n("SELECT count(*) AS n FROM world_event_journal WHERE idempotency_key = ?",
          `battle:${g.battleId}:settle:v1`), rows: s.rows(g.battleId).length,
        garrisonClaimed: s.env.telemetry.counts["battle.live.garrisonClaimed"] },
      { x1: [true, false, "COMPLETED", 8], x2: [true, true],
        state: ["COMPLETED", "LIVE_EVEJS", "B_WIN", { source: "live", exit: "END", garrisonShips: 4, garrisonLost: 0 }],
        losses: [{ fleet_id: g.a, hull_group: "cruiser", count: 2 }, { fleet_id: g.b, hull_group: "cruiser", count: 2 }]
          .sort((p, q) => (p.fleet_id < q.fleet_id ? -1 : 1)),
        settleKeys: 1, rows: 0, garrisonClaimed: 1 });
      assert.deepStrictEqual(influence(), influenceBefore, "No world write for the proxies");
      assert.strictEqual(validateResult(done.input, done.result, { maxResultBytes: 65536 }).ok, true);
    } finally {
      s.env.close();
    }
  });

  needsDriver("AV4-T3: markLiveInTx with reserve -> SPAWNED + RESERVE "
    + "(payload reserve/reserveHash); spawnReserveInTx RESERVE -> SPAWNED, the same again MEMBER_NOT_RESERVE without a "
    + "write; 2 DESTROYED -> exit EXIT COMPLETED, losses only from DESTROYED, the reserve survives, rows deleted",
  async () => {
    const s = setup(driver);
    try {
      const { battleId, a, b } = s.mk({ compA: [{ hullGroup: "cruiser", count: 4 }] });
      const pending = s.battle(battleId);
      const c = s.T((db) => s.live.claimLiveInTx(db, { battleId, expectedVersion: pending.version },
        s.specsOf(pending)));
      assert.strictEqual(c.ok, true, JSON.stringify(c));
      const keysOf = (fleetId) => s.rows(battleId).filter((r) => r.fleet_id === fleetId).map((r) => r.member_key);
      const [a1, a2, a3, a4] = keysOf(a);
      const [b1, b2] = keysOf(b);
      const spawned = [[a1, 9101], [a2, 9102], [b1, 9103]].map(([memberKey, entityId]) => ({ memberKey, entityId }));
      const m = s.T((db) => s.live.markLiveInTx(db, { battleId, expectedVersion: c.version, claimSeq: c.claimSeq,
        bootAt: BOOT_AT, spawned, reserve: [a3, a4, b2] }));
      assert.strictEqual(m.ok, true, JSON.stringify(m));
      const states = () => s.rows(battleId).map((r) => [r.member_key, r.state, r.entity_id === null ? null
        : Number(r.entity_id)]);
      assert.deepStrictEqual(states().filter((x) => x[1] === "RESERVE").map((x) => [x[0], x[2]]),
        [[a3, null], [a4, null], [b2, null]].sort());
      const payload = JSON.parse(s.env.q("SELECT payload FROM world_event_journal WHERE aggregate_id = ? AND "
        + "event_type = 'BATTLE_LIVE_STARTED'", battleId)[0].payload);
      assert.deepStrictEqual([payload.spawned, payload.reserve, typeof payload.reserveHash], [3, 3, "string"]);
      const versionBefore = s.battle(battleId).version;
      const req = { battleId, claimSeq: c.claimSeq, bootAt: BOOT_AT, spawned: [{ memberKey: a3, entityId: 9104 }] };
      const r1 = s.T((db) => s.live.spawnReserveInTx(db, req));
      assert.deepStrictEqual(r1, { ok: true, spawned: 1 });
      const after = states();
      const r2 = s.T((db) => s.live.spawnReserveInTx(db, { ...req, spawned: [{ memberKey: b2, entityId: 9105 },
        { memberKey: a3, entityId: 9106 }] }));
      assert.deepStrictEqual([r2.ok, r2.reason, r2.memberKey], [false, "MEMBER_NOT_RESERVE", a3]);
      assert.deepStrictEqual(states(), after, "check all before the first write: b2 stays RESERVE");
      assert.deepStrictEqual([s.battle(battleId).version, s.env.telemetry.counts["battle.live.reserveSpawned"]],
        [versionBefore, 1], "the battle row does not change");

      for (const victim of [a1, b1]) {
        const d = s.T((db) => s.live.markDestroyedInTx(db, { battleId, memberKey: victim }));
        assert.deepStrictEqual(d, { ok: true, duplicate: false });
      }
      const x = s.T((db) => s.live.exitLiveInTx(db, { battleId, at: AT, reason: "EXIT" }));
      assert.deepStrictEqual([x.ok, x.outcome, x.membersDeleted], [true, "COMPLETED", 6], JSON.stringify(x));
      const done = s.battle(battleId);
      const ships = (list) => list.map((g) => [g.fleetId, g.count]).sort();
      assert.deepStrictEqual({ destroyed: ships(done.result.destroyedShips), surviving: ships(done.result.survivingShips),
        rows: s.rows(battleId).length }, { destroyed: [[a, 1], [b, 1]].sort(), surviving: [[a, 3], [b, 1]].sort(),
        rows: 0 });
      assert.strictEqual(validateResult(done.input, done.result, { maxResultBytes: 65536 }).ok, true);
    } finally {
      s.env.close();
    }
  });
};
