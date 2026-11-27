"use strict";

const assert = require("node:assert");

const { harness: SH } = require("./siege.test");
const { harness: H } = require("../battle/settlement.test");
const { harness: GD } = require("../strategy/gridDefense.test");
const { harness: CH } = require("../battle/contacts.test");
const M = require("../../lib/stations/siege/siegeMachine");
const PM = require("../../lib/stations/playerSiege/machine");
const G = require("../../lib/stations/siege/gridScope");
const PS = require("../../lib/stations/playerSiege/schema");
const { startPlayerSiege } = require("../../lib/stations/playerSiege");
const { createUnavailableSiege } = require("../../lib/stations/siege");
const { rankPosts } = require("../../lib/strategy/gridDefense/posts");
const { REQUIRED } = require("../../lib/strategy/gridDefense");
const { createJournal } = require("../../lib/persistence/journal");
const { startScheduler } = require("../../lib/scheduler");
const { GROUPS } = require("../../lib/battle/data/strengthCatalog");

const { S } = H;
const { SANSHA, OWNER, HOUR, DEFAULTS } = SH;
const CALDARI = 500001;
const AU = 149597870700;
const GATE_N0 = 50005001;
const GATE_N6 = 50005002;
const NPC = 60005001;
const STATION_GRID = `station:${NPC}`;
const GRID = Object.freeze({ ...DEFAULTS.grid, enabled: true, movesEnabled: true });
const isHostile = (a, b) => a !== b;

const anchor = (kind, id, x, extra = {}) => ({ kind, id, position: { x, y: 0, z: 0 }, toSystemId: null,
  lneStationId: null, lneSovStructureId: null, ownerCorpId: null, ...extra });
const siegeAdapter = () => ({ readGridAnchors(systemId) {
  if (systemId !== S.N5) return { ok: true, truncated: false, anchors: [] };
  return { ok: true, truncated: false, anchors: [anchor("gate", GATE_N0, 0, { toSystemId: S.N0 }),
    anchor("gate", GATE_N6, AU, { toSystemId: S.N6 }), anchor("station", NPC, 5 * AU)] };
} });

const fleet = (fleetId, factionId, state = "IDLE", fleetRole = "invasion", count = 20) => ({ fleetId, factionId, state,
  fleetRole, legSeq: 1, composition: [{ hullGroup: "battleship", count }] });

const gridOpts = (siege = {}) => ({ grid: GRID, gridAdapter: siegeAdapter(), siege: { gridEnabled: true, ...siege } });
const visitOf = (env, id) => env.tx((db) => db.prepare("SELECT move_seq, purpose, to_kind, to_id, arrive_at FROM "
  + "world_fleet_grid_visits WHERE fleet_id = ?").get(id)) || null;
const siegeVisits = (env) => SH.countOf(env, "SELECT count(*) AS n FROM world_fleet_grid_visits WHERE purpose = "
  + "'SIEGE'");

async function arrive(env, shared, tag, opType = "structure_assault", objective = "destroy") {
  const t0 = shared.clock.now();
  const id = SH.newFleet(env, tag, SANSHA, S.N0);
  const op = env.fleets.createOperation({ operationType: opType, factionId: SANSHA, originSystemId: S.N0,
    targetSystemId: S.N5, objective, dueAt: t0 + 1000 * HOUR, fleets: [{ fleetId: id, expectedVersion: 1 }] },
  `${tag}:op`);
  assert.ok(op.ok, JSON.stringify(op));
  const p = env.fleets.planTravel({ fleetId: id, targetSystemId: S.N5 }, `${tag}:plan`);
  assert.ok(p.ok, JSON.stringify(p));
  await SH.settleAt(env, shared, p.arriveAt);
  const f = env.tx((db) => env.fleets.repository.getFleet(db, id)).fleet;
  assert.deepStrictEqual([f.currentSystemId, f.state], [S.N5, "STAGED"]);
  return f;
}

const siegeRows = (env) => env.tx((db) => db.prepare("SELECT * FROM world_station_sieges ORDER BY station_id, "
  + "siege_no").all()).map(({ siege_id: _id, created_at: _c, updated_at: _u, ...rest }) => rest);

const SYS = 30000142;
const POWNER = 98000001;
const SID = 1035000001;
const PIRATE = 500019;
const pview = (over = {}) => Object.freeze({ structureId: SID, systemId: SYS, typeId: 35832, family: "citadel",
  size: "medium", ownerCorpId: POWNER, allianceId: null, state: "SHIELD_VULNERABLE", stateEndsAt: null, name: "Fort",
  stateId: 3, destroyedAt: null, upkeep: "FULL_POWER", ehp: Object.freeze({ shield: 1e6, armor: 1e6, hull: 1e6 }),
  damageLimit: Object.freeze({ shield: 0, armor: 0, hull: 0 }), assetSafety: true, tagged: false, ...over });

function playerRig(reopen) {
  const opened = reopen();
  const shared = H.sharedOf();
  const clock = shared.clock;
  const cfg = { ...H.CONFIG, modules: { ...H.CONFIG.modules, strategy: { enabled: true } },
    playerSiege: { ...DEFAULTS.playerSiege, enabled: true }, playerHunt: DEFAULTS.playerHunt,
    strategy: DEFAULTS.strategy, persistence: { ...H.CONFIG.persistence, maxRowsPerTransaction: 500 },
    siege: { ...DEFAULTS.siege, gridEnabled: true } };
  const journal = createJournal({ clock, maxPayloadBytes: 16384, maxRows: 500 });
  const sr = startScheduler({ config: cfg, persistence: { ok: true, store: opened.store }, clock, ids: shared.ids,
    nowMs: () => 0 });
  assert.ok(sr.ok, JSON.stringify(sr));
  const vendor = { hits: 0 };
  const seam = {
    listCandidates: () => ({ ok: true, bySystem: new Map([[SYS, Object.freeze([pview()])]]), total: 1,
      truncated: false, builtAt: clock.now() }),
    readStructure: () => ({ ok: true, view: pview() }),
    applySiegeHit: () => {
      vendor.hits += 1;
      return { ok: true, view: pview({ state: "ARMOR_REINFORCE", stateEndsAt: clock.now() + 24 * HOUR }),
        destroyed: false, flushed: true };
    },
    readOwnerFace: () => ({ ok: true, ceoId: 90000001, npc: false }),
    readOwnerActivity: () => ({ ok: true, onlineNow: true, lastSeenMs: null, members: 1, truncated: false }),
  };
  const list = [{ ...fleet("f1", PIRATE), currentSystemId: SYS }];
  const moves = [];
  const place = new Map([["f1", { kind: "anchor", gridKey: "gate:1" }]]);
  const grid = { isEnabled: () => true, movesEnabled: () => true,
    readSystemGrid: () => ({ ok: true, grids: [{ gridKey: "gate:1", anchors: [{ kind: "gate", id: 1 }] },
      { gridKey: `structure:${SID}`, anchors: [{ kind: "structure", id: SID }] }] }),
    positionsOf: (tx, systemId, fleets) => ({ ok: true, anchorsReason: null,
      positions: new Map(fleets.map((f) => [f.fleetId, place.get(f.fleetId)])) }),
    moveInTx: (tx, spec) => {
      moves.push(spec);
      return { ok: true, moved: true, arriveAt: spec.at + 120000 };
    } };
  const fleets = { repository: { listFleetsInSystem: (tx, systemId, opts) => ({ ok: true,
    fleets: list.filter((f) => opts.states.includes(f.state)), nextAfterFleetId: null }) },
  travel: { addArrivalListener: () => ({ ok: true, remove() {} }) }, grid };
  const started = startPlayerSiege({ config: cfg, persistence: { ok: true, store: opened.store, journal }, clock,
    ids: shared.ids, scheduler: sr.scheduler, fleets, strategy: { registry: { isActive: () => true,
      getFaction: () => ({ kind: "pirate" }) } },
    graph: { getGraph: () => ({ ok: true, graph: { getSystem: (id) => ({ systemId: id, secClass: "nullsec" }) } }) },
    adapter: { playerStructureSeams: () => ({ ok: true }), playerStructures: seam,
      readCharacterStanding: () => ({ ok: true, found: true, standing: -10 }) },
    getVirtualCorps: () => ({ isVirtualCorporation: () => false }) });
  assert.ok(started.ok, JSON.stringify(started));
  const ps = started.playerSiege;
  const openList = () => {
    const r = opened.store.transaction("test", (db) => ps.listOpen(db, { limit: 8 }));
    assert.ok(r.ok, JSON.stringify(r));
    return r.value.sieges;
  };
  return { sr, ps, clock, vendor, moves, openList };
}

module.exports = ({ test, skip }) => {
  test("SGR1 grid pure: gridHoldOf, planStart / planPlayerStart with and without spec.grid, GATHER, refs",
    () => {
      const att = fleet("a1", SANSHA);
      const enemy = fleet("e1", OWNER, "IDLE", "garrison");
      const battle = fleet("x1", CALDARI, "ENGAGED");
      const grids = (o) => new Map(Object.entries(o));
      const onGate = grids({ a1: "gate:1", e1: "gate:1", x1: "gate:1" });
      const h1 = G.gridHoldOf([att, enemy, battle], SANSHA, isHostile, GROUPS, onGate, STATION_GRID,
        { attackersAnywhere: true });
      assert.deepStrictEqual([h1.contested, h1.engaged, h1.attackerShips, h1.awayShips], [false, false, 20, 20]);
      const h2 = G.gridHoldOf([att, enemy, battle], SANSHA, isHostile, GROUPS, grids({ a1: "gate:1",
        e1: STATION_GRID, x1: STATION_GRID }), STATION_GRID, {});
      assert.deepStrictEqual([h2.contested, h2.engaged, h2.attackerShips, h2.awayShips], [true, true, 0, 20]);
      assert.deepStrictEqual(G.moversOf([att, enemy], SANSHA, onGate, STATION_GRID, 8), [{ fleetId: "a1", legSeq: 1 }]);
      assert.deepStrictEqual(G.moversOf([att], SANSHA, onGate, STATION_GRID, 0), []);

      const P = { timerScale: 0.25, assaultMinMs: 900000, assaultMaxMs: 21600000 };
      const npc = { stationId: "a", kind: "npc", state: "ONLINE", ownerFactionId: OWNER };
      const base = { system: { systemId: 1, secClass: "nullsec" }, openSieges: [], openTotal: 0,
        openByAttacker: new Map(), triggerFleetId: null, at: 0, isHostile, isActive: () => true, groups: GROUPS,
        params: { ...P, allowHighsec: false, maxOpenSieges: 64, maxOpenSiegesPerFaction: 4 },
        stations: [{ stationId: "b", kind: "upwell", structureFamily: "astrahus", state: "ONLINE", ownerFactionId: OWNER },
          npc, { stationId: "z", kind: "upwell", structureFamily: "astrahus", state: "ANCHORING", ownerFactionId: OWNER }],
        fleets: [fleet("f1", SANSHA), fleet("f2", 500003, "STAGED")] };
      const off = [M.planStart(base), M.planStart({ ...base, fleets: [...base.fleets, fleet("f3", CALDARI, "ENGAGED")] }),
        M.planStart({ ...base, fleets: [fleet("f1", SANSHA)], truncated: true })];
      assert.deepStrictEqual(off, [{ start: null, reason: "CONTESTED" }, { start: null, reason: "ENGAGED" },
        { start: null, reason: "CONTESTED" }]);
      const one = M.planStart({ ...base, fleets: [fleet("f1", SANSHA), fleet("f9", SANSHA, "IDLE", "scout")] });
      assert.deepStrictEqual([Object.keys(one), one.start.stationId, one.start.state, one.start.attackerShips],
        [["start"], "z", "ANCHOR_ASSAULT", 20]);
      const spec = (fleets, at, extra = {}) => ({ ...base, stations: [npc], fleets,
        grid: { gridOfFleet: grids(at), targetGridOf: new Map([["a", STATION_GRID]]) }, ...extra });
      const fl = [fleet("f1", SANSHA), fleet("d1", OWNER, "IDLE", "garrison"), fleet("x1", CALDARI, "ENGAGED")];
      assert.strictEqual(M.planStart({ ...base, stations: [npc], fleets: fl.slice(0, 2) }).reason, "CONTESTED",
        "system rule: the defender on the gate contests");
      const started = M.planStart(spec(fl, { f1: "gate:1", d1: "gate:1", x1: "gate:1" }));
      assert.deepStrictEqual([started.start.stationId, started.start.attackerFactionId, started.start.attackerShips],
        ["a", SANSHA, 20], JSON.stringify(started));
      assert.deepStrictEqual(M.planStart(spec(fl.slice(0, 2), { f1: "gate:1", d1: STATION_GRID })),
        { start: null, reason: "CONTESTED", approach: { stationId: "a", attackerFactionId: SANSHA } });
      assert.deepStrictEqual(M.planStart(spec(fl.slice(0, 2), { f1: "gate:1", d1: STATION_GRID }, { truncated: true })),
        { start: null, reason: "CONTESTED", approach: null });
      const pspec = (at, extra = {}) => ({ system: { systemId: SYS, secClass: "nullsec" }, structures: [pview()],
        fleets: [fleet("p1", PIRATE), fleet("o1", OWNER, "IDLE", "garrison")], truncated: false,
        openStructureIds: new Set(), openTotal: 0, openByFaction: new Map(), openByOwner: new Map(),
        lastByStructure: new Map(), triggerFleetId: null, at: 0, isActive: () => true,
        relation: (f) => (f === PIRATE ? "hostile" : "neutral"),
        isHostileFaction: isHostile, groups: GROUPS, params: { targetFamilies: ["citadel"],
          structureCooldownMs: HOUR, maxOpen: 4, maxOpenPerFaction: 2, maxOpenPerOwner: 1, assaultMinMs: 900000,
          assaultMaxMs: 21600000 }, ...(at ? { grid: { gridOfFleet: grids(at), targetGridOf: new Map([[SID,
          `structure:${SID}`]]) } } : {}), ...extra });
      assert.deepStrictEqual(PM.planPlayerStart(pspec(null)), { start: null, reason: "CONTESTED" });
      assert.strictEqual(PM.planPlayerStart(pspec({ p1: "gate:1", o1: "gate:1" })).start.structureId, SID);
      assert.deepStrictEqual(PM.planPlayerStart(pspec({ p1: "gate:1", o1: `structure:${SID}` })),
        { start: null, reason: "CONTESTED", approach: { structureId: SID, attackerFactionId: PIRATE } });

      const plan = M.buildPlan({ kind: "upwell", structureFamily: "astrahus" }, "nullsec", P).plan;
      const sg = (o) => ({ open: true, phaseSeq: 1, waitRound: 0, state: "SHIELD_ASSAULT", ownerFactionId: OWNER, plan,
        ...o });
      const st = { stationId: "st", kind: "upwell", state: "ONLINE", ownerFactionId: OWNER, version: 1 };
      const none = { attackerShips: 0, attackerDps: 0, engaged: false, contested: false };
      const F = { at: 1000, phaseSeq: 1, round: 0, maxWaitRounds: 2, canCapture: false, captureUpwell: false };
      const gone = { action: "REPEL", reason: "ATTACKER_GONE", stationTo: null };
      assert.deepStrictEqual([M.decideStep(sg(), st, none, { ...F, gridAway: 2 }),
        M.decideStep(sg(), st, none, { ...F, gridAway: 0 }), M.decideStep(sg(), st, none, F),
        M.decideStep(sg({ waitRound: 2 }), st, none, { ...F, round: 2, gridAway: 2 })],
      [{ action: "GATHER", round: 1 }, gone, gone, gone]);
      const prow = { siegeId: "ps", open: true, state: PS.SHIELD_ASSAULT, phaseSeq: 0, waitRound: 0,
        phaseStartedAt: 0, phaseEndsAt: 1000, ownerCorpId: POWNER };
      const pf = { at: 1000, phaseSeq: 0, round: 0, maxWaitRounds: 2, recheckMs: 300000, virtualOwner: false };
      assert.deepStrictEqual([PM.decidePlayerStep(prow, pview(), none, { ...pf, gridAway: 5 }),
        PM.decidePlayerStep(prow, pview(), none, pf)], [{ action: "WAIT", round: 1, dueAt: 301000, why: "GATHER" },
        { action: "END", to: PS.REPELLED, reason: "ATTACKER_GONE" }]);

      assert.deepStrictEqual([G.parseRef("station:60001"), G.parseRef("x"), G.parseRef("gate:0"),
        G.parseRef("gate:1.5"), G.parseRef(":5")], [{ kind: "station", id: 60001 }, null, null, null, null]);
      assert.deepStrictEqual([G.targetRefOf({ kind: "lne", record: { kind: "npc", npcStationId: 5 } }),
        G.targetRefOf({ kind: "lne", record: { kind: "upwell", evejsItemId: 77 } }),
        G.targetRefOf({ kind: "lne", record: { kind: "upwell", evejsItemId: null } }),
        G.targetRefOf({ kind: "player", structureId: 9 })], ["station:5", "structure:77", null, "structure:9"]);
    });

  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("SGR2 grid LNE station, flag on: START with a SIEGE move, GATHER -> ATTACKER_GONE with "
    + "gridMaxMovers 0, APPROACH with a garrison at the station, rows within the bound", async () => {
    await H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const env = await SH.boot(reopen(), shared, gridOpts());
      assert.ok(env.started.ok, JSON.stringify(env.started));
      SH.addStation(env, "st-npc", S.N5, OWNER, shared.clock.now(), "npc", NPC);
      const f = await arrive(env, shared, "g1");
      const sg = SH.siegeOfStation(env, "st-npc");
      assert.ok(sg && sg.state === "SHIELD_ASSAULT", env.lines.join("\n"));
      const v = visitOf(env, f.fleetId);
      assert.deepStrictEqual([Number(v.move_seq), v.purpose, v.to_kind, Number(v.to_id)], [1, "SIEGE", "station", NPC]);
      assert.strictEqual(SH.countOf(env, "SELECT count(*) AS n FROM world_scheduled_events WHERE event_type = "
        + "'FLEET_GRID_ARRIVAL' AND idempotency_key LIKE ?", `grid:${f.fleetId}:%`), 1);
      assert.strictEqual(SH.countOf(env, "SELECT count(*) AS n FROM world_scheduled_events WHERE idempotency_key = ?",
        `grid:${f.fleetId}:${f.legSeq}:1`), 1);
      assert.ok(sg.phaseEndsAt >= Number(v.arrive_at), `${sg.phaseEndsAt} >= ${v.arrive_at}`);
      const c = env.siege.getStatus().counters;
      assert.deepStrictEqual([c.started, c.gridMoves, c.gridMoveRefused, c.gridFallback], [1, 1, 0, 0]);
      assert.ok(Math.max(...env.rows.map((r) => r.rows || 0)) <= 500);
      SH.stopAll(env);
    });
    await H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const env = await SH.boot(reopen(), shared, gridOpts({ gridMaxMovers: 0 }));
      SH.addStation(env, "st-npc", S.N5, OWNER, shared.clock.now(), "npc", NPC);
      const f = await arrive(env, shared, "g2");
      const id = SH.siegeOfStation(env, "st-npc").siegeId;
      assert.strictEqual(visitOf(env, f.fleetId).purpose, null, "no SIEGE move with gridMaxMovers 0");
      await SH.settleAt(env, shared, SH.nextStepDue(env));
      const w = SH.siegeOf(env, id);
      assert.deepStrictEqual([w.state, w.waitRound, w.phaseSeq], ["SHIELD_ASSAULT", 1, 0], "GATHER, phase kept");
      await SH.drive(env, shared, () => !SH.siegeOf(env, id).open);
      const end = SH.siegeOf(env, id);
      assert.deepStrictEqual([end.state, end.endReason], ["REPELLED", "ATTACKER_GONE"]);
      assert.strictEqual(env.siege.getStatus().counters.gridGathers, 2);
      SH.stopAll(env);
    });
    await H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const env = await SH.boot(reopen(), shared, gridOpts());
      SH.addStation(env, "st-npc", S.N5, OWNER, shared.clock.now(), "npc", NPC);
      SH.newFleet(env, "d1", OWNER, S.N5, "garrison");
      const f = await arrive(env, shared, "g3");
      assert.strictEqual(SH.countOf(env, "SELECT count(*) AS n FROM world_station_sieges"), 0);
      const outcomes = env.tx((db) => db.prepare("SELECT outcome FROM world_scheduled_events WHERE event_type = "
        + "'STATION_SIEGE_CHECK'").all()).map((r) => r.outcome);
      assert.deepStrictEqual(outcomes, ["APPROACH"]);
      const v = visitOf(env, f.fleetId);
      assert.deepStrictEqual([v.purpose, v.to_kind, Number(v.to_id)], ["SIEGE", "station", NPC]);
      const c = env.siege.getStatus().counters;
      assert.deepStrictEqual([c.gridApproach, c.gridMoves, c.started], [1, 1, 0]);
      assert.ok(Math.max(...env.rows.map((r) => r.rows || 0)) <= 500);
      SH.stopAll(env);
    });
  });

  needsDriver("SGR3 grid restart during the SIEGE move -> the STEP after arrive_at counts the attacker in "
    + "the grid of the station; flag off with grid on = the siege rows of grid off, no SIEGE visit", async () => {
    await H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      let env = await SH.boot(reopen(), shared, gridOpts());
      SH.addStation(env, "st-npc", S.N5, OWNER, shared.clock.now(), "npc", NPC);
      const f = await arrive(env, shared, "r1");
      const sg = SH.siegeOfStation(env, "st-npc");
      const arriveAt = Number(visitOf(env, f.fleetId).arrive_at);
      assert.ok(shared.clock.now() < arriveAt, "the restart is inside the move");
      SH.stopAll(env);
      env = await SH.boot(reopen(), shared, gridOpts());
      assert.strictEqual(env.siege.getStatus().open, 1);
      const due = SH.nextStepDue(env);
      assert.ok(due >= arriveAt, `${due} >= ${arriveAt}`);
      await SH.settleAt(env, shared, due);
      const after = SH.siegeOf(env, sg.siegeId);
      assert.deepStrictEqual([after.state, after.phaseSeq, after.attackerShips], ["ARMOR_TIMER", 1, 20]);
      assert.strictEqual(env.siege.getStatus().counters.gridGathers, 0);
      SH.stopAll(env);
    });
    const runPin = (opts) => H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const env = await SH.boot(reopen(), shared, opts);
      SH.addStation(env, "st-own", S.N5, OWNER, shared.clock.now());
      await arrive(env, shared, "p1", "invasion", "capture");
      const id = SH.siegeOfStation(env, "st-own").siegeId;
      await SH.drive(env, shared, () => !SH.siegeOf(env, id).open);
      const out = { rows: siegeRows(env), siegeVisits: siegeVisits(env),
        visits: SH.countOf(env, "SELECT count(*) AS n FROM world_fleet_grid_visits") };
      SH.stopAll(env);
      return out;
    });
    const off = await runPin({});
    const pinned = await runPin({ grid: GRID, gridAdapter: siegeAdapter(), siege: { gridEnabled: false } });
    assert.deepStrictEqual(pinned.rows, off.rows);
    assert.deepStrictEqual([off.rows[0].state, off.visits, pinned.siegeVisits, pinned.visits > 0],
      ["DESTROYED", 0, 0, true]);
  });

  needsDriver("SGR4 grid player structure: start with a SIEGE move to the structure, a STEP with the "
    + "attacker outside the grid -> WAIT GATHER without a vendor hit", () => H.withStore(driver, async (reopen) => {
    const { sr, ps, clock, vendor, moves, openList } = playerRig(reopen);
    const at = clock.now();
    assert.ok(sr.scheduler.enqueue(PS.CHECK_EVENT_TYPE, String(SYS), at, { systemId: SYS, at, triggerFleetId: null },
      "test:check").ok);
    await sr.scheduler.runPass();
    const [siege] = openList();
    assert.ok(siege, JSON.stringify(ps.getStatus()));
    assert.deepStrictEqual(moves.map((m) => [m.fleetId, m.purpose, m.to.kind, m.to.id, m.at]),
      [["f1", "SIEGE", "structure", SID, at]]);
    assert.ok(siege.phaseEndsAt >= at + 120000);
    clock.set(siege.phaseEndsAt);
    await sr.scheduler.runPass();
    const w = openList()[0];
    assert.deepStrictEqual([w.state, w.waitRound, vendor.hits, moves.length], [PS.SHIELD_ASSAULT, 1, 0, 2]);
    const c = ps.getStatus().counters;
    assert.deepStrictEqual([c.gridGathers, c.gridMoves, c.hits], [1, 2, 0]);
    ps.stop("test");
  }));

  needsDriver("SGR5 grid gridDefense siege posts: rankPosts siegeRefs, POST to the besieged station off the "
    + "CP (siegePosts 1), facade methods of ctx.fleets.grid and ctx.siege", async () => {
    const STRUCT = 77;
    const anchors = [GD.anchor("gate", GD.GATE_N0, 0, { toSystemId: S.N0 }), GD.anchor("gate", GD.GATE_N6, GD.AU,
      { toSystemId: S.N6 }), GD.anchor("station", GD.STATION, 5 * GD.AU), GD.anchor("structure", STRUCT, 3 * GD.AU)];
    const gridOf = new Map(anchors.map((a) => [`${a.kind}:${a.id}`, `${a.kind}:${a.id}`]));
    const input = { anchors, gridOf, cp: anchors[2], factionId: 1, relationOf: new Map(), ownStationRefs: new Set() };
    assert.deepStrictEqual(rankPosts({ ...input, siegeRefs: new Set([`structure:${STRUCT}`]) }), [anchors[3]]);
    assert.deepStrictEqual(rankPosts({ ...input, siegeRefs: new Set() }), rankPosts(input));
    assert.deepStrictEqual(rankPosts({ ...input, siegeRefs: new Set(["structure:99"]) }), rankPosts(input));

    const { GURISTAS } = CH;
    const record = { stationId: "st-x", kind: "upwell", evejsItemId: STRUCT, npcStationId: null, systemId: S.N5,
      ownerFactionId: GURISTAS, state: "ONLINE" };
    const reads = [];
    const defenseDeps = {
      getStations: () => ({ getMode: () => "ready", repository: { listStationsInSystem: () => ({ ok: true,
        records: [record] }) } }),
      getSiege: () => ({ readForFaction: (db, factionId, opts) => {
        reads.push([factionId, opts.limit]);
        return { ok: true, attacking: [], truncated: false, defending: factionId === GURISTAS
          ? [{ siegeId: "sg_1", stationId: "st-x", systemId: S.N5 }] : [] };
      } }) };
    const adapter = { readGridAnchors: (systemId) => ({ ok: true, truncated: false,
      anchors: systemId === S.N5 ? anchors : [] }) };
    const env = GD.createScene(driver, { ...GD.ON, "siege.gridEnabled": true }, { adapter, defenseDeps });
    try {
      const d = env.fleetOf("d", GURISTAS, "garrison", GD.big(2), S.N0);
      const trip = env.trip(d, GURISTAS, S.N0, S.N5, "patrol", "patrol", "d");
      await env.drive(trip.arriveAt);
      const v = env.visit(d);
      assert.ok(v && v.purpose === "POST" && v.to_kind === "structure" && Number(v.to_id) === STRUCT,
        JSON.stringify(v));
      const c = env.defense().getStatus().counters;
      assert.deepStrictEqual([c.posts, c.siegePosts], [1, 1]);
      assert.deepStrictEqual(reads[0], [GURISTAS, DEFAULTS.siege.maxOpenSieges]);
    } finally {
      env.close();
    }

    const siegeState = { open: true, phaseEndsAt: 0 };
    const deps2 = { ...defenseDeps, getSiege: () => ({ readForFaction: (db, factionId) => ({ ok: true, attacking: [],
      truncated: false, defending: factionId === GURISTAS && siegeState.open ? [{ siegeId: "sg_1", stationId: "st-x",
        systemId: S.N5, phaseEndsAt: siegeState.phaseEndsAt }] : [] }) }) };
    const env2 = GD.createScene(driver, { ...GD.ON, "siege.gridEnabled": true }, { adapter, defenseDeps: deps2 });
    try {
      const ids = ["d1", "d2"].map((t) => env2.fleetOf(t, GURISTAS, "garrison", GD.big(2), S.N0));
      const trips = ids.map((id, i) => env2.trip(id, GURISTAS, S.N0, S.N5, "patrol", "patrol", `n${i}`));
      siegeState.phaseEndsAt = Math.max(...trips.map((t) => t.arriveAt)) + HOUR;
      await env2.drive(Math.max(...trips.map((t) => t.arriveAt)));
      for (const id of ids) assert.strictEqual(env2.visit(id).to_kind, "structure", id);
      const pending = () => env2.rows("GRID_DEFENSE_STEP").filter((r) => r.state === "QUEUED");
      const sp1 = pending();
      assert.deepStrictEqual(sp1.map((r) => r.idempotency_key.split(":").pop()), ["sp1", "sp1"]);
      assert.ok(sp1.every((r) => Number(r.due_at) >= siegeState.phaseEndsAt), JSON.stringify(sp1));
      await env2.drive(Math.max(...sp1.map((r) => Number(r.due_at))));
      assert.deepStrictEqual(pending().map((r) => r.idempotency_key.split(":").pop()), ["sp2", "sp2"],
        "the siege lasts: SAME_GRID, the next re-check");
      siegeState.open = false;
      await env2.drive(Math.max(...pending().map((r) => Number(r.due_at))));
      await env2.drive(env2.clock.now() + HOUR);
      const kinds = ids.map((id) => env2.visit(id)).map((v) => `${v.purpose}:${v.to_kind}`).sort();
      assert.deepStrictEqual(kinds, ["POST:gate", "POST:station"]);
      assert.deepStrictEqual(pending(), []);
      const c = env2.defense().getStatus().counters;
      assert.deepStrictEqual([c.siegeRechecks, c.siegeReleases], [4, 2]);
    } finally {
      env2.close();
    }

    await H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const real = await SH.boot(reopen(), shared, gridOpts());
      const missing = ["isEnabled", "movesEnabled", "readSystemGrid", "positionsOf", "moveInTx"]
        .filter((m) => typeof real.fleets.grid[m] !== "function");
      assert.deepStrictEqual(missing, []);
      assert.ok(REQUIRED.includes("siege.readForFaction"));
      assert.strictEqual(typeof real.siege.readForFaction, "function");
      assert.strictEqual(typeof createUnavailableSiege("x").readForFaction, "function");
      SH.stopAll(real);
    });
  });
};
