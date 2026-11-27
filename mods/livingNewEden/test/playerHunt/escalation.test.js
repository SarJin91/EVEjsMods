"use strict";

const assert = require("node:assert");

const P = require("../../lib/playerHunt/policy");
const S = require("../../lib/playerHunt/schema");
const { createHuntRepository, membersOf, pickDetachment, pickMatchedDetachment }
  = require("../../lib/playerHunt/huntRepository");
const { harness: H } = require("../materialization/huntStep.test");

const SIX_HEAVY = Object.freeze([{ hullGroup: "cruiser", count: 4 }, { hullGroup: "battlecruiser", count: 2 }]);
const EIGHT_LIGHT = Object.freeze([{ hullGroup: "frigate", count: 4 }, { hullGroup: "cruiser", count: 4 }]);
const MIXED = Object.freeze([{ hullGroup: "battlecruiser", count: 2 }, { hullGroup: "cruiser", count: 4 },
  { hullGroup: "frigate", count: 2 }]);
const QUARRY = 102;
const RIFTER = Object.freeze({ typeId: 587, groupId: 25 });
const destroyed = (n) => Array.from({ length: n }, (_, i) => ({ memberKey: `m${i}`, hullGroup: "frigate",
  typeId: null, state: "DESTROYED" }));
const spawned = (n) => Array.from({ length: n }, (_, i) => ({ memberKey: `s${i}`, hullGroup: "frigate",
  typeId: null, state: "SPAWNED" }));

function insertEnded(db, r) {
  db.prepare(`INSERT INTO world_player_hunts (hunt_id, fleet_id, faction_id, system_id, character_id, mode, state,
    standing, members_json, seed, started_at, live_at, ended_at, end_reason, losses_json, updated_at, version)
    VALUES (?, 'f-x', ?, 30000142, ?, ?, 'ENDED', -6, ?, 1, ?, ?, ?, ?, '[]', ?, 3)`)
    .run(r.huntId, r.factionId, r.characterId, r.mode || "SWEEP", r.membersJson || JSON.stringify(r.members),
      r.endedAt - 10, r.endedAt - 5, r.endedAt, r.endReason, r.endedAt);
}

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  const scene = (opened, ph, { won = false, comps = [SIX_HEAVY, EIGHT_LIGHT] } = {}) => {
    const env = H.setup(opened, { ph });
    const ids = comps.map((composition, i) => env.newFleet(`he:${i}`, H.PIRATE, { composition }));
    if (won) {
      env.tx((db) => insertEnded(db, { huntId: "ph:old:1", factionId: H.PIRATE, characterId: QUARRY,
        members: destroyed(2), endReason: "WIPED",
        endedAt: H.START_MS - env.config.playerHunt.cooldownMs - 1000 }));
    }
    const real = env.ph;
    const heatReads = [];
    const claims = [];
    env.ph = { ...real,
      recentEndedInTx: (...args) => {
        heatReads.push(args.slice(1));
        return real.recentEndedInTx(...args);
      },
      claimInTx: (db, req) => {
        claims.push({ ...req });
        return real.claimInTx(db, req);
      } };
    env.w.player(QUARRY, RIFTER);
    return { env, ids, heatReads, claims };
  };
  const startedFleet = (env, ids) => {
    const rows = env.rows().filter((r) => r.state === "LIVE");
    assert.strictEqual(rows.length, 1, JSON.stringify(rows));
    return ids.findIndex((id) => rows[0].hunt_id === S.huntIdOf(id, 1));
  };

  needsDriver("HE1 flags off: the candidate by shipCount (8 light before 6 heavy), every member, the claim request as "
    + "before, no heat read, no escalation counter", () => {
    H.withStore(driver, (opened) => {
      const { env, ids, heatReads, claims } = scene(opened, {}, { won: true });
      assert.deepStrictEqual([env.config.playerHunt.escalationEnabled, env.config.playerHunt.detachmentMatchEnabled],
        [false, false]);
      env.pass(1000);
      assert.strictEqual(startedFleet(env, ids), 1);
      assert.strictEqual(env.w.count("spawnShip"), 8);
      assert.deepStrictEqual(claims.map((c) => Object.keys(c).sort()), [["at", "characterId", "expectedVersion",
        "fleetId", "mode", "standing", "systemId"]]);
      assert.deepStrictEqual(heatReads, []);
      const c = env.counters();
      assert.deepStrictEqual([c.escalationHeatReads, c.escalationHeated, c.escalationReadFailed, c.detachmentMatched],
        [0, 0, 0, 0]);
    });
  });

  test("HE2 heatOf: a wiped detachment (LOSSES), RETREATED and a TIMEOUT without losses -> 2; never spawned / below "
    + "the threshold = 0; the ceiling maxHeat", () => {
    const p = { lossPermille: 500, maxHeat: 3 };
    const rows = [{ endReason: "WIPED", members: destroyed(3) }, { endReason: "RETREATED", members: spawned(2) },
      { endReason: "TIMEOUT", members: spawned(4) }];
    assert.strictEqual(P.heatOf(rows, p), 2);
    assert.strictEqual(P.heatOf([{ endReason: "SPAWN_FAILED", members: [{ state: "PLANNED" }] },
      { endReason: "TIMEOUT", members: [...destroyed(1), ...spawned(3)] }], p), 0);
    assert.strictEqual(P.heatOf(Array.from({ length: 6 }, () => rows[0]), p), 3);
    assert.strictEqual(P.heatOf(Array.from({ length: 6 }, () => rows[0]), { ...p, maxHeat: 1 }), 1);
    assert.strictEqual(P.heatOf(null, p), 0);
  });

  test("HE3 compareHeavyCandidates: 6 ships 4cr+2BC before 8 ships 4fr+4cr (tie -> shipCount, fleetId); "
    + "escalatedApproachJumps / escalatedCap", () => {
    const heavy = { fleetId: "b", shipCount: 6, composition: SIX_HEAVY };
    const light = { fleetId: "a", shipCount: 8, composition: EIGHT_LIGHT };
    assert.deepStrictEqual([light, heavy].sort(P.compareHeavyCandidates).map((f) => f.fleetId), ["b", "a"]);
    assert.deepStrictEqual([heavy, light].sort(P.compareHuntCandidates).map((f) => f.fleetId), ["a", "b"]);
    const twin = { ...heavy, fleetId: "a" };
    assert.deepStrictEqual([heavy, twin].sort(P.compareHeavyCandidates).map((f) => f.fleetId), ["a", "b"]);
    assert.deepStrictEqual([P.heavyScoreOf(SIX_HEAVY), P.heavyScoreOf(EIGHT_LIGHT)], [22, 16]);
    assert.deepStrictEqual([P.escalatedApproachJumps(2, 3, 4), P.escalatedApproachJumps(2, 1, 4),
      P.escalatedApproachJumps(2, 0, 4), P.escalatedApproachJumps(3, 2, 2)], [4, 3, 2, 3]);
    assert.deepStrictEqual([P.escalatedCap(2, 1, 500, 10), P.escalatedCap(4, 3, 500, 10), P.escalatedCap(2, 0, 500, 10),
      P.escalatedCap(1, 1, 500, 10)], [3, 10, 2, 1]);
  });

  needsDriver("HE3 step: a won hunt of the window -> the heavy fleet hunts, one heat read per pair, escalationHeated; "
    + "with scaleEnabled the frigate gang 2 -> 3", () => {
    H.withStore(driver, (opened) => {
      const { env, ids, heatReads } = scene(opened, { escalationEnabled: true }, { won: true });
      env.pass(1000);
      assert.strictEqual(startedFleet(env, ids), 0);
      assert.strictEqual(heatReads.length, 1);
      const [characterId, factionId, since, limit] = heatReads[0];
      assert.deepStrictEqual([characterId, factionId, since, limit], [QUARRY, H.PIRATE,
        env.clock.now() - env.config.playerHunt.escalationWindowMs, env.config.playerHunt.escalationMaxHeat * 4]);
      const c = env.counters();
      assert.deepStrictEqual([c.escalationHeatReads, c.escalationHeated, c.escalationReadFailed], [1, 1, 0]);
    });
    H.withStore(driver, (opened) => {
      const { env, ids, claims } = scene(opened, { escalationEnabled: true, scaleEnabled: true }, { won: true });
      env.pass(1000);
      assert.strictEqual(startedFleet(env, ids), 0);
      assert.deepStrictEqual([env.w.count("spawnShip"), claims.map((c) => c.maxMembers)], [3, [3]]);
    });
    H.withStore(driver, (opened) => {
      const { env, ids, heatReads } = scene(opened, { escalationEnabled: true });
      env.pass(1000);
      assert.deepStrictEqual([startedFleet(env, ids), heatReads.length, env.counters().escalationHeated], [1, 1, 0],
        "heat 0 -> the order of shipCount");
    });
  });

  test("HE4 orderForQuarry: frigate -> the frigates first (pickDetachment 2 = 2 frigates); battleship -> BC first; "
    + "capsule / null / unknown -> unchanged", () => {
    const all = membersOf("F", MIXED);
    const groups = (list) => list.map((m) => m.hullGroup);
    assert.deepStrictEqual(groups(all), ["battlecruiser", "battlecruiser", "cruiser", "cruiser", "cruiser", "cruiser",
      "frigate", "frigate"]);
    const frig = P.orderForQuarry(all, "frigate");
    assert.deepStrictEqual(groups(frig).slice(0, 3), ["frigate", "frigate", "cruiser"]);
    assert.deepStrictEqual(groups(pickMatchedDetachment(all, "frigate", 2)), ["frigate", "frigate"]);
    assert.deepStrictEqual(groups(pickMatchedDetachment(all, "frigate", 3)), ["frigate", "frigate", "cruiser"]);
    assert.deepStrictEqual(groups(pickDetachment(all, 2)), ["battlecruiser", "cruiser"]);
    assert.deepStrictEqual(groups(P.orderForQuarry(all, "battleship")).slice(0, 3),
      ["battlecruiser", "battlecruiser", "cruiser"]);
    assert.deepStrictEqual(groups(pickMatchedDetachment(all, "battleship", 2)), ["battlecruiser", "battlecruiser"]);
    assert.deepStrictEqual(groups(P.orderForQuarry(all, "destroyer")).slice(0, 5),
      ["cruiser", "cruiser", "cruiser", "cruiser", "frigate"]);
    assert.deepStrictEqual(groups(pickMatchedDetachment(all, "destroyer", 2)), ["cruiser", "frigate"]);
    for (const q of ["capsule", null, "nonsense"]) {
      const same = P.orderForQuarry(all, q);
      assert.notStrictEqual(same, all);
      assert.deepStrictEqual(same, all);
      assert.deepStrictEqual(pickMatchedDetachment(all, q, 2), pickDetachment(all, 2));
    }
  });

  needsDriver("HE4b detachmentMatchEnabled: a frigate quarry of a 2BC+4cr+2fr fleet (scale 2) -> the claim gets "
    + "quarryClass, the row members = the 2 spawned frigates; claimInTx without quarryClass = the payload of today", () => {
    H.withStore(driver, (opened) => {
      const { env, ids, claims } = scene(opened, { detachmentMatchEnabled: true, scaleEnabled: true },
        { comps: [MIXED] });
      env.pass(1000);
      assert.strictEqual(startedFleet(env, ids), 0);
      assert.deepStrictEqual(claims.map((c) => [c.maxMembers, c.quarryClass]), [[2, "frigate"]]);
      const row = env.rows()[0];
      const members = JSON.parse(row.members_json);
      const expected = pickMatchedDetachment(membersOf(ids[0], MIXED), "frigate", 2);
      assert.deepStrictEqual(members.map((m) => m.memberKey), expected.map((m) => m.memberKey));
      assert.deepStrictEqual(members.map((m) => m.hullGroup), ["frigate", "frigate"]);
      const profiles = [...env.w.profileOf.values()];
      assert.deepStrictEqual(profiles, [`p_${H.PIRATE}_frigate`, `p_${H.PIRATE}_frigate`]);
      assert.strictEqual(env.counters().detachmentMatched, 1);
      const other = env.newFleet("he4b:other", H.PIRATE, { composition: MIXED });
      const req = { fleetId: other, expectedVersion: 1, characterId: QUARRY, systemId: H.SYS, mode: "SWEEP",
        standing: -6, at: env.clock.now(), maxMembers: 2 };
      const got = env.tx((db) => env.ph.claimInTx(db, req));
      assert.strictEqual(got.ok, true, JSON.stringify(got));
      assert.deepStrictEqual(got.members.map((m) => m.hullGroup), ["battlecruiser", "cruiser"]);
      const payload = env.tx((db) => JSON.parse(db.prepare("SELECT payload FROM world_event_journal WHERE "
        + "idempotency_key = ?").get(S.claimKey(got.huntId)).payload));
      assert.deepStrictEqual(payload, req);
      const bad = env.tx((db) => env.ph.claimInTx(db, { ...req, expectedVersion: 2, quarryClass: "" }));
      assert.deepStrictEqual([bad.ok, bad.reason, bad.detail], [false, "PLAYER_HUNT_INVALID_INPUT", "quarryClass"]);
    });
    H.withStore(driver, (opened) => {
      const { env, claims } = scene(opened, { detachmentMatchEnabled: true, scaleEnabled: true }, { comps: [MIXED] });
      env.w.player(QUARRY, { typeId: 670, groupId: 29, capsule: true });
      env.pass(1000);
      assert.deepStrictEqual([claims.map((c) => Object.prototype.hasOwnProperty.call(c, "quarryClass")),
        env.counters().detachmentMatched], [[false], 0], "a capsule -> the order of today");
    });
  });

  needsDriver("HE5 recentEndedInTx on :memory: (schema DDL): modes SWEEP / SCAN only, the window, no RESTART, newest "
    + "first, limit, a non-array members_json skipped; the plan uses world_player_hunts_cooldown", () => {
    const db = new driver.Database(":memory:");
    try {
      S.upPlayerHunts(db);
      const C = 90000001;
      const F = 500019;
      const rows = [
        { huntId: "h1", mode: "SWEEP", endReason: "WIPED", endedAt: 1000 },
        { huntId: "h2", mode: "SCAN", endReason: "TIMEOUT", endedAt: 2000 },
        { huntId: "h3", mode: "PATROL", endReason: "WIPED", endedAt: 3000 },
        { huntId: "h4", mode: "SWEEP", endReason: "RESTART", endedAt: 4000 },
        { huntId: "h5", mode: "SWEEP", endReason: "WIPED", endedAt: 500 },
        { huntId: "h6", mode: "SWEEP", endReason: "WIPED", endedAt: 1500, membersJson: "{}" },
        { huntId: "h7", mode: "SWEEP", endReason: "WIPED", endedAt: 2500, factionId: 500010 },
        { huntId: "h8", mode: "SWEEP", endReason: "WIPED", endedAt: 2500, characterId: 90000002 },
      ];
      for (const r of rows) {
        insertEnded(db, { factionId: F, characterId: C, members: destroyed(1), ...r });
      }
      const noop = () => ({ ok: true });
      const repo = createHuntRepository({ journal: { applyOnce: noop },
        fleetRepository: { getFleet: noop, transition: noop, applyLosses: noop }, worldSeed: 1 });
      db.exec("BEGIN");
      const got = repo.recentEndedInTx(db, C, F, 900, 12);
      assert.deepStrictEqual({ ...got, rows: got.rows.map((r) => r.endReason) },
        { ok: true, rows: ["TIMEOUT", "WIPED"], skipped: 1 });
      assert.deepStrictEqual(got.rows[1].members, destroyed(1));
      assert.deepStrictEqual(repo.recentEndedInTx(db, C, F, 900, 1).rows.map((r) => r.endReason), ["TIMEOUT"]);
      assert.strictEqual(repo.recentEndedInTx(db, C, F, 900, 0).reason, "PLAYER_HUNT_INVALID_INPUT");
      const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT end_reason, members_json FROM world_player_hunts
        WHERE character_id = ? AND faction_id = ? AND mode IN ('SWEEP','SCAN') AND end_reason NOT IN ('RESTART')
        AND ended_at >= ? ORDER BY ended_at DESC LIMIT ?`).all(C, F, 900, 12).map((r) => r.detail).join(" | ");
      assert.ok(plan.includes("world_player_hunts_cooldown"), plan);
      db.exec("ROLLBACK");
      assert.strictEqual(repo.recentEndedInTx(db, C, F, 900, 12).reason, "TX_REQUIRED");
    } finally {
      db.close();
    }
  });
};
