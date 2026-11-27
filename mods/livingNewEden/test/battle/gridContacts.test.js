"use strict";

const assert = require("node:assert");

const { planContact } = require("../../lib/battle/contacts");
const { planGridContact, gridGarrisonOf, stationAnchorRef } = require("../../lib/battle/gridContacts");
const { createContactService, gridContactKey } = require("../../lib/battle/contactService");
const { createBattleRepository } = require("../../lib/battle/battleRepository");
const { createHostility } = require("../../lib/battle/data/hostility");
const { createGrid } = require("../../lib/fleets/grid");
const { LATEST_SCHEMA_VERSION } = require("../../lib/persistence/migrations");
const { CLASSES, validateClasses } = require("../../lib/retention/classes");
const { SCHEMA, resolveConfig } = require("../../config");
const { harness: C } = require("./contacts.test");
const { harness: H } = require("./settlement.test");

const { SANSHA, GURISTAS } = C;
const S = H.S;
const AU = 149597870700;
const GATE_N0 = 50009001;
const GATE_N6 = 50009002;
const STATION = 60009001;
const STATION_N0 = 60009101;
const GATE_N0_L1 = 50009101;
const LIMITS = Object.freeze({ maxFleetsPerSide: 8, maxSettlementRows: 450 });
const BATTLE_LIMITS = Object.freeze({ maxFleetsPerSide: 8, maxCompositionEntries: 32, maxShipsPerFleet: 500,
  maxResolutionMs: 50, maxInputBytes: 65536, maxResultBytes: 65536, maxListLimit: 500, maxSettlementRows: 450 });
const isHostile = createHostility();

const anchor = (kind, id, x, extra = {}) => ({ kind, id, position: { x, y: 0, z: 0 }, toSystemId: null,
  lneStationId: null, lneSovStructureId: null, ownerCorpId: null, ...extra });

const fakeAdapter = () => ({ readGridAnchors(systemId) {
  if (systemId === S.N5) {
    return { ok: true, truncated: false, anchors: [anchor("gate", GATE_N0, 0, { toSystemId: S.N0 }),
      anchor("gate", GATE_N6, AU, { toSystemId: S.N6 }), anchor("station", STATION, 5 * AU)] };
  }
  if (systemId === S.N0) {
    return { ok: true, truncated: false, anchors: [anchor("station", STATION_N0, 0),
      anchor("gate", GATE_N0_L1, 2 * AU, { toSystemId: S.L1 })] };
  }
  return { ok: true, truncated: false, anchors: [] };
} });

const GRID_CFG = Object.freeze({ "grid.enabled": true, "grid.movesEnabled": true });

const fl = (fleetId, factionId) => ({ fleetId, factionId, fleetRole: "patrol", operationId: null, state: "STAGED",
  shipCount: 2, version: 1, composition: [{ hullGroup: "cruiser", typeId: null, count: 2 }] });
const at = (gridKey) => ({ kind: "anchor", gridKey });

const visitOf = (env, fleetId) => env.q("SELECT system_id, leg_seq, move_seq, to_kind, to_id, depart_at, arrive_at, "
  + "version FROM world_fleet_grid_visits WHERE fleet_id = ?", fleetId)[0] || null;
const contactEvents = (env) => env.q("SELECT idempotency_key, state, outcome FROM world_scheduled_events WHERE "
  + "event_type = 'BATTLE_CONTACT_CHECK' ORDER BY created_at, idempotency_key");

function directService(env, counters, created, opts = {}) {
  return createContactService({ store: env.store, scheduler: env.scheduler,
    battleRepository: { createBattle: (tx, spec) => {
      created.push(spec);
      return { ok: true, battleId: `battle_gc_${opts.tag || ""}${created.length}`, duplicate: false };
    } },
    cooldownRepository: { listForSystem: () => ({ ok: true, cooldowns: new Map() }) },
    fleetRepository: env.fleets.repository, getGraph: () => env.graph, worldRepository: opts.worldRepository || null,
    resolverVersion: "internal-v1", settings: { engageDelayMs: 1000, recontactCooldownMs: 1, contactScanMaxFleets: 64,
      maxResolutionMs: 20, influenceGarrison: "off", gridContactsEnabled: true, ...(opts.settings || {}) },
    grid: opts.grid || env.fleets.grid, getStations: opts.getStations, limits: LIMITS, isHostile,
    bump: (name, n = 1) => {
      counters[name] = (counters[name] || 0) + n;
    }, logger: { log() {} }, isActive: () => true });
}

const txOf = (env) => (fn) => {
  const r = env.store.transaction("test", fn);
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
};

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  test("GC1 grid planGridContact: GRID_APART, common grid, trigger grid first, warp skipped, fallback, cooldown",
    () => {
      const base = { triggerFleetId: null, isHostile, cooldowns: new Map(), at: 0, limits: LIMITS };
      const fleets = [fl("a1", SANSHA), fl("b1", GURISTAS)];
      const apart = planGridContact({ ...base, fleets, positions: new Map([["a1", at("gate:1")],
        ["b1", at("station:2")]]) });
      assert.deepStrictEqual([apart.contact, apart.reason, apart.gridsChecked, apart.fallback], [null, "GRID_APART", 2,
        false]);
      const common = planGridContact({ ...base, fleets, positions: new Map([["a1", at("station:2")],
        ["b1", at("station:2")]]) });
      assert.deepStrictEqual([Boolean(common.contact), common.gridKey], [true, "station:2"]);

      const four = [fl("a1", SANSHA), fl("b1", GURISTAS), fl("a2", SANSHA), fl("b2", GURISTAS)];
      const trig = planGridContact({ ...base, fleets: four, triggerFleetId: "a2", positions: new Map([
        ["a1", at("station:2")], ["b1", at("station:2")], ["a2", at("x:9")], ["b2", at("x:9")]]) });
      assert.deepStrictEqual([trig.gridKey, trig.contact.objectiveFleetId, trig.gridsChecked], ["x:9", "a2", 1]);

      const warp = planGridContact({ ...base, fleets: [...fleets, fl("b3", GURISTAS)], positions: new Map([
        ["a1", at("gate:1")], ["b1", { kind: "warp" }], ["b3", at("gate:1")]]) });
      const ids = [...warp.contact.sideA.fleets, ...warp.contact.sideB.fleets].map((f) => f.fleetId).sort();
      assert.deepStrictEqual([warp.warpSkipped, warp.gridKey, ids], [1, "gate:1", ["a1", "b3"]]);

      const fb = planGridContact({ ...base, fleets, positions: null });
      const plain = planContact({ ...base, fleets });
      assert.deepStrictEqual(fb.contact, plain.contact);
      assert.deepStrictEqual([fb.fallback, fb.gridKey], [true, null]);

      const cd = planGridContact({ ...base, fleets, cooldowns: new Map([[`${GURISTAS}:${SANSHA}`, 10]]),
        positions: new Map([["a1", at("gate:1")], ["b1", at("gate:1")]]) });
      assert.deepStrictEqual([cd.contact, cd.reason], [null, "ON_COOLDOWN"]);
    });

  test("GC2 grid gridGarrisonOf + stationAnchorRef: pool B in the CP grid or its station grid, station points "
    + "and structure records of the battle grid only", () => {
    assert.strictEqual(stationAnchorRef({ kind: "npc", npcStationId: 60001, evejsItemId: null }), "station:60001");
    assert.strictEqual(stationAnchorRef({ kind: "upwell", npcStationId: null, evejsItemId: 1022 }), "structure:1022");
    assert.strictEqual(stationAnchorRef({ kind: "upwell", npcStationId: null, evejsItemId: null }), null);
    const A = 1;
    const B = 2;
    const gridOf = new Map([["station:10", "station:10"], ["structure:20", "gate:5"], ["gate:5", "gate:5"]]);
    const records = [
      { stationId: "s1", kind: "npc", npcStationId: 10, evejsItemId: null, state: "ONLINE", ownerFactionId: A },
      { stationId: "s2", kind: "upwell", npcStationId: null, evejsItemId: 20, state: "ONLINE", ownerFactionId: B },
      { stationId: "s3", kind: "upwell", npcStationId: null, evejsItemId: null, state: "ONLINE", ownerFactionId: B },
    ];
    const spec = { cpGridKey: "station:10", gridOf, records, factionA: A, factionB: B, garrisonPoints: () => 80 };
    const cp = gridGarrisonOf({ ...spec, gridKey: "station:10" });
    assert.deepStrictEqual([cp.stationA, cp.stationB, cp.influenceAllowed, cp.structureRecords.map((s) => s.stationId)],
      [80, 80, true, ["s1", "s3"]], "CP grid: s1 + s3 (no anchor)");
    const gate = gridGarrisonOf({ ...spec, gridKey: "gate:5" });
    assert.deepStrictEqual([gate.stationA, gate.stationB, gate.influenceAllowed,
      gate.structureRecords.map((s) => s.stationId)], [0, 80, true, ["s2"]], "grid of the station of B");
    const belt = gridGarrisonOf({ ...spec, gridKey: "belt:7" });
    assert.deepStrictEqual([belt.stationA, belt.stationB, belt.influenceAllowed, belt.structureRecords], [0, 0, false,
      []], "a belt: no pool, no stations");
    const ofA = gridGarrisonOf({ ...spec, gridKey: "gate:5", factionA: B, factionB: A });
    assert.strictEqual(ofA.influenceAllowed, false, "the station in the grid belongs to A, not to B");
  });

  needsDriver("GC3 grid integration: flag on GRID_APART at the arrival, FLEET_GRID_ARRIVAL -> one grid contact and "
    + "a battle with grid station; flag off -> the arrival battle, grid null, the input of a run without grids",
  async () => {
    const run = async (over, adapter) => {
      const env = C.createEnv(driver, { config: over, adapter });
      try {
        const a = env.newFleet("a", SANSHA, S.N0);
        const b = env.newFleet("b", GURISTAS, S.N5);
        const pa = env.travel(a, SANSHA, S.N0, S.N5, "a");
        await env.drive(pa.arriveAt);
        const out = { env, a, b, pa, arrival: contactEvents(env), battlesAtArrival: env.battles() };
        const v = visitOf(env, a);
        if (v && v.arrive_at !== null) {
          await env.drive(Number(v.arrive_at));
          out.visit = v;
        }
        out.battles = env.battles();
        out.contacts = contactEvents(env);
        out.counts = { ...env.telemetry.counts };
        return out;
      } finally {
        env.close();
      }
    };

    const on = await run({ ...GRID_CFG, "battle.gridContacts.enabled": true }, fakeAdapter());
    assert.deepStrictEqual(on.arrival.map((e) => [e.idempotency_key, e.state, e.outcome]),
      [[`contact:${S.N5}:arr:${on.a}:${on.pa.legSeq}`, "DONE", "GRID_APART"]], "A in warp at its arrival");
    assert.strictEqual(on.battlesAtArrival.length, 0);
    assert.ok(on.visit && on.visit.to_kind === "station" && Number(on.visit.move_seq) === 1, JSON.stringify(on.visit));
    const gridKey = gridContactKey(S.N5, on.a, on.pa.legSeq, 1);
    assert.deepStrictEqual(on.contacts.filter((e) => e.idempotency_key === gridKey).map((e) => [e.state, e.outcome]),
      [["DONE", "BATTLE"]]);
    assert.strictEqual(on.battles.length, 1);
    assert.deepStrictEqual([on.battles[0].grid_kind, Number(on.battles[0].grid_id)], ["station", STATION]);
    assert.deepStrictEqual([on.counts["battle.contacts.gridApart"], on.counts["battle.contacts.gridWarpSkipped"],
      on.counts["battle.contacts.gridQueued"]], [1, 1, 1]);
    assert.ok(on.contacts.every((e) => e.state === "DONE"), JSON.stringify(on.contacts));

    const plain = await run({}, undefined);
    const offGrid = await run({ "grid.enabled": true }, fakeAdapter());
    const offMoves = await run({ ...GRID_CFG }, fakeAdapter());
    for (const r of [plain, offGrid, offMoves]) {
      assert.strictEqual(r.battlesAtArrival.length, 1, "system battle at the arrival");
      assert.deepStrictEqual([r.battles[0].grid_kind, r.battles[0].grid_id], [null, null]);
      assert.deepStrictEqual(r.arrival.map((e) => e.outcome), ["BATTLE"]);
    }
    assert.deepStrictEqual([offGrid.battles[0].input_hash, offGrid.battles[0].input_json, offGrid.contacts.length],
      [plain.battles[0].input_hash, plain.battles[0].input_json, plain.contacts.length], "flag off = the same input");
    const row = SCHEMA.find((r) => r.key === "battle.gridContacts.enabled");
    assert.deepStrictEqual([row.type, row.default, row.env], ["boolean", false, "EVEJS_LNE_BATTLE_GRID_CONTACTS_ENABLED"]);
    const warn = resolveConfig({ modDir: require("node:path").resolve(__dirname, "..", ".."),
      env: { EVEJS_LNE_BATTLE_GRID_CONTACTS_ENABLED: "1" } }).warnings;
    assert.ok(warn.includes("battle.gridContacts.enabled without grid.enabled - system contacts"), warn.join("\n"));
  });

  needsDriver("GC4 grid idempotency: listener twice -> one event; participant in warp before the effect -> "
    + "gridMoved, no battle; createBattle grid columns, replay, INPUT_INVALID; schema 70", async () => {
    assert.ok(LATEST_SCHEMA_VERSION >= 70, String(LATEST_SCHEMA_VERSION));
    const env = C.createEnv(driver, { config: GRID_CFG, adapter: fakeAdapter() });
    try {
      const tx = txOf(env);
      const counters = {};
      const created = [];
      const svc = directService(env, counters, created);
      const a = env.newFleet("a", SANSHA, S.N5);
      const b = env.newFleet("b", GURISTAS, S.N5);
      const t = env.clock.now();
      const fa = env.fleet(a);
      const payload = { fleetId: a, systemId: S.N5, legSeq: fa.legSeq, moveSeq: 4, at: t };
      tx((db) => {
        svc.onGridArrival(db, payload);
        svc.onGridArrival(db, payload);
      });
      const key = gridContactKey(S.N5, a, fa.legSeq, 4);
      assert.strictEqual(contactEvents(env).filter((e) => e.idempotency_key === key).length, 1);
      assert.deepStrictEqual([counters["contacts.gridQueued"], counters["contacts.gridEnqueueRefused"]], [1, undefined]);

      const ev = { payload: { systemId: S.N5, at: t, triggerFleetId: null }, idempotencyKey: "contact:gc4" };
      const r1 = svc.onContactCheck(ev);
      assert.strictEqual(r1.outcome, "BATTLE", JSON.stringify(r1));
      const fb = env.fleet(b);
      const m = tx((db) => env.fleets.grid.moveInTx(db, { fleetId: b, systemId: S.N5, legSeq: fb.legSeq, at: t,
        to: { kind: "gate", id: GATE_N6 }, purpose: "WORK" }));
      assert.strictEqual(m.ok, true, JSON.stringify(m));
      assert.deepStrictEqual(tx((db) => r1.effect(db, ev)), { ok: true });
      assert.deepStrictEqual([created.length, counters["contacts.gridMoved"]], [0, 1]);
      assert.strictEqual(svc.onContactCheck(ev).outcome, "GRID_APART");
      const later = { payload: { systemId: S.N5, at: m.arriveAt, triggerFleetId: null }, idempotencyKey: "contact:x" };
      assert.strictEqual(svc.onContactCheck(later).outcome, "GRID_APART");

      const repo = createBattleRepository({ journal: env.journal, fleetRepository: env.fleets.repository,
        clock: env.clock, ids: env.shared.ids, worldSeed: env.battleDeps.persistence.worldSeed, limits: BATTLE_LIMITS });
      const side = (factionId, id) => ({ factionId, fleets: [{ fleetId: id, expectedVersion: env.fleet(id).version }] });
      const spec = { systemId: S.N5, environment: "nullsec", objective: "destroy", resolverVersion: "internal-v1",
        maxResolutionMs: 20, garrison: null, sideA: side(SANSHA, a), sideB: side(GURISTAS, b),
        grid: { kind: "station", id: STATION } };
      assert.deepStrictEqual(tx((db) => repo.createBattle(db, { ...spec, grid: { kind: "", id: 1 } }, "gc4:bad")),
        { ok: false, reason: "INPUT_INVALID", detail: "grid" });
      const c1 = tx((db) => repo.createBattle(db, spec, "gc4:battle"));
      assert.strictEqual(c1.ok, true, JSON.stringify(c1));
      const rowOf = () => env.q("SELECT grid_kind, grid_id FROM battle_records WHERE battle_id = ?", c1.battleId)[0];
      assert.deepStrictEqual([rowOf().grid_kind, Number(rowOf().grid_id)], ["station", STATION]);
      assert.deepStrictEqual(tx((db) => repo.getBattle(db, c1.battleId)).battle.grid, { kind: "station", id: STATION });
      const again = tx((db) => repo.createBattle(db, { ...spec, sideA: { factionId: SANSHA, fleets: [{ fleetId: a,
        expectedVersion: 1 }] }, sideB: { factionId: GURISTAS, fleets: [{ fleetId: b, expectedVersion: 1 }] } },
      "gc4:battle"));
      assert.deepStrictEqual([again.ok, again.duplicate, again.battleId], [true, true, c1.battleId]);
      assert.deepStrictEqual([rowOf().grid_kind, Number(rowOf().grid_id)], ["station", STATION]);
      const input = tx((db) => repo.getBattle(db, c1.battleId)).battle.input;
      assert.ok(!Object.prototype.hasOwnProperty.call(input, "grid"), "grid outside the battle input");
    } finally {
      env.close();
    }
  });

  needsDriver("GC5 grid ENQUEUE_DUPLICATE rolls back; fresh visit at the same leg_seq continues "
    + "move_seq; contact-arrival pattern", async () => {
    const env = C.createEnv(driver, { config: GRID_CFG, adapter: fakeAdapter() });
    try {
      const tx = txOf(env);
      const f = env.newFleet("f", SANSHA, S.N5);
      const e = env.newFleet("e", GURISTAS, S.N0);
      const legSeq = env.fleet(f).legSeq;
      const move = (grid, systemId, t, to) => tx((db) => grid.moveInTx(db, { fleetId: f, systemId, legSeq, at: t, to,
        purpose: "WORK" }));
      const t0 = env.clock.now();
      const m1 = move(env.fleets.grid, S.N5, t0, { kind: "gate", id: GATE_N0 });
      assert.strictEqual(m1.moveSeq, 1, JSON.stringify(m1));
      const before = visitOf(env, f);
      const dup = createGrid({ config: env.cfg, adapter: fakeAdapter(), clock: env.clock, store: env.store,
        repository: env.fleets.repository, scheduler: { enqueue: () => ({ ok: true, duplicate: true }) },
        worldSeed: env.battleDeps.persistence.worldSeed });
      const refused = move(dup.facade, S.N5, m1.arriveAt, { kind: "gate", id: GATE_N6 });
      assert.deepStrictEqual([refused.ok, refused.reason], [false, "ENQUEUE_DUPLICATE"]);
      assert.deepStrictEqual(visitOf(env, f), before, "the savepoint rolled the visit back");
      const m2 = move(env.fleets.grid, S.N5, m1.arriveAt, { kind: "gate", id: GATE_N6 });
      assert.strictEqual(m2.moveSeq, 2, JSON.stringify(m2));

      const repo = createBattleRepository({ journal: env.journal, fleetRepository: env.fleets.repository,
        clock: env.clock, ids: env.shared.ids, worldSeed: env.battleDeps.persistence.worldSeed, limits: BATTLE_LIMITS });
      const side = (factionId, id) => ({ factionId, fleets: [{ fleetId: id, expectedVersion: env.fleet(id).version }] });
      const bspec = { systemId: S.N0, environment: "nullsec", objective: "destroy", resolverVersion: "internal-v1",
        maxResolutionMs: 20, garrison: null, sideA: side(SANSHA, f), sideB: side(GURISTAS, e) };
      const c = tx((db) => repo.createBattle(db, bspec, "gc5:battle"));
      assert.strictEqual(c.ok, true, JSON.stringify(c));
      const engaged = env.fleet(f);
      const idle = tx((db) => env.fleets.repository.transition(db, { fleetId: f, expectedVersion: engaged.version,
        from: "ENGAGED", to: "IDLE" }, "gc5:idle"));
      assert.strictEqual(idle.ok, true, JSON.stringify(idle));
      assert.deepStrictEqual([env.fleet(f).currentSystemId, env.fleet(f).legSeq], [S.N0, legSeq]);
      const m3 = move(env.fleets.grid, S.N0, m2.arriveAt, { kind: "gate", id: GATE_N0_L1 });
      assert.deepStrictEqual([m3.ok, m3.moveSeq], [true, 3], JSON.stringify(m3));
      const v = visitOf(env, f);
      assert.deepStrictEqual([Number(v.system_id), Number(v.move_seq)], [S.N0, 3]);
      assert.strictEqual(env.q("SELECT count(*) AS n FROM world_scheduled_events WHERE idempotency_key = ?",
        `grid:${f}:${legSeq}:3`)[0].n, 1);

      const cls = CLASSES.find((x) => x.id === "contact-arrival");
      assert.ok(cls.pattern.test("contact:30000142:grid:f1:2:3"));
      assert.ok(cls.pattern.test("contact:30000142:arr:f1:2"));
      assert.ok(!cls.pattern.test("contact:30000142:after:b1"));
      assert.strictEqual(validateClasses(CLASSES), CLASSES);
    } finally {
      env.close();
    }
  });

  needsDriver("GDF6 grid LOW: gridGarrisonDropped only for a created battle; anchors lost in the effect -> "
    + "the planned battle + gridAnchorsLost; switches off + legacy pool -> a station of B outside the CP lets the pool in",
  async () => {
    const STRUCTURE = 1022;
    const adapter = { readGridAnchors(systemId) {
      const base = fakeAdapter().readGridAnchors(systemId);
      if (systemId !== S.N5) return base;
      return { ...base, anchors: [...base.anchors, anchor("structure", STRUCTURE, AU + 1000)] };
    } };
    const env = C.createEnv(driver, { config: GRID_CFG, adapter });
    try {
      const tx = txOf(env);
      const a = env.newFleet("a", SANSHA, S.N5);
      const b = env.newFleet("b", GURISTAS, S.N5);
      const t = env.clock.now();
      let arriveAt = 0;
      for (const id of [a, b]) {
        const f = env.fleet(id);
        const m = tx((db) => env.fleets.grid.moveInTx(db, { fleetId: id, systemId: S.N5, legSeq: f.legSeq, at: t,
          to: { kind: "gate", id: GATE_N6 }, purpose: "WORK" }));
        assert.strictEqual(m.ok, true, JSON.stringify(m));
        arriveAt = Math.max(arriveAt, m.arriveAt);
      }
      const ev = { payload: { systemId: S.N5, at: arriveAt, triggerFleetId: null }, idempotencyKey: "contact:gd6" };
      const npc = { stationId: "s1", kind: "npc", npcStationId: STATION, evejsItemId: null, state: "ONLINE",
        ownerFactionId: SANSHA, structureFamily: null };
      const stations = (records) => () => ({ getMode: () => "ready", repository: { listStationsInSystem: () => ({
        ok: true, records }) } });

      const ca = {};
      const createdA = [];
      const svcA = directService(env, ca, createdA, { tag: "a", settings: { stationGarrisonEnabled: true },
        getStations: stations([npc]) });
      const ok1 = svcA.onContactCheck(ev);
      assert.strictEqual(ok1.outcome, "BATTLE", JSON.stringify(ok1));
      assert.strictEqual(ca["contacts.gridGarrisonDropped"], undefined, "nothing counted before the effect");
      assert.deepStrictEqual(tx((db) => ok1.effect(db, ev)).ok, true);
      assert.deepStrictEqual([createdA.length, ca["contacts.gridGarrisonDropped"]], [1, 1]);
      const moved = svcA.onContactCheck(ev);
      const fb = env.fleet(b);
      const away = tx((db) => env.fleets.grid.moveInTx(db, { fleetId: b, systemId: S.N5, legSeq: fb.legSeq,
        at: arriveAt, to: { kind: "station", id: STATION }, purpose: "WORK" }));
      assert.strictEqual(away.ok, true, JSON.stringify(away));
      assert.deepStrictEqual(tx((db) => moved.effect(db, ev)), { ok: true });
      assert.deepStrictEqual([createdA.length, ca["contacts.gridMoved"], ca["contacts.gridGarrisonDropped"]], [1, 1, 1],
        "gridMoved: no battle, no second gridGarrisonDropped");

      const backB = tx((db) => env.fleets.grid.moveInTx(db, { fleetId: b, systemId: S.N5, legSeq: fb.legSeq,
        at: away.arriveAt, to: { kind: "gate", id: GATE_N6 }, purpose: "WORK" }));
      assert.strictEqual(backB.ok, true, JSON.stringify(backB));
      const atB = { ...ev, payload: { ...ev.payload, at: backB.arriveAt } };
      let lost = false;
      const grid = { ...env.fleets.grid, positionsOf: (db, systemId, fleets, at2, o) => (lost
        ? { ok: true, anchorsReason: "GRID_ANCHORS_UNAVAILABLE", positions: new Map(fleets.map((f) => [f.fleetId,
          { kind: "anchor", gridKey: `system:${systemId}` }])) }
        : env.fleets.grid.positionsOf(db, systemId, fleets, at2, o)) };
      const cb = {};
      const createdB = [];
      const svcB = directService(env, cb, createdB, { tag: "b", grid });
      const plan = svcB.onContactCheck(atB);
      assert.strictEqual(plan.outcome, "BATTLE", JSON.stringify(plan));
      lost = true;
      assert.strictEqual(tx((db) => plan.effect(db, atB)).ok, true);
      assert.deepStrictEqual([createdB.length, createdB[0].grid, cb["contacts.gridAnchorsLost"], cb["contacts.gridMoved"]],
        [1, { kind: "gate", id: GATE_N6 }, 1, undefined]);

      const upwell = { stationId: "s2", kind: "upwell", npcStationId: null, evejsItemId: STRUCTURE, state: "ONLINE",
        ownerFactionId: SANSHA, structureFamily: "astrahus" };
      const worldRepository = { getSystem: () => ({ ok: true, system: { influence: [{ factionId: SANSHA,
        garrisonStrength: 50 }] } }) };
      const pool = (records) => {
        const cc = {};
        const created = [];
        const svc = directService(env, cc, created, { tag: `c${records.length}`, worldRepository,
          getStations: stations(records),
          settings: { influenceGarrison: "legacy" } });
        const r = svc.onContactCheck(atB);
        assert.strictEqual(r.outcome, "BATTLE", JSON.stringify(r));
        tx((db) => r.effect(db, atB));
        return { garrison: created[0].garrison, dropped: cc["contacts.gridGarrisonDropped"] };
      };
      assert.deepStrictEqual(pool([upwell]), { garrison: { side: "B", factionId: SANSHA, strength: 50 },
        dropped: undefined });
      assert.deepStrictEqual(pool([]), { garrison: null, dropped: 1 });
    } finally {
      env.close();
    }
  });
};
