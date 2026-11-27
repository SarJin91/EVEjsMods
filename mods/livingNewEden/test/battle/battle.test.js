"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { SCHEMA, resolveConfig } = require("../../config");
const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
const { resolveSqliteDriver } = require("../../lib/adapter/sqliteDriver");
const { MIGRATIONS, LATEST_SCHEMA_VERSION } = require("../../lib/persistence/migrations");
const { openStore } = require("../../lib/persistence/store");
const { seedDbFile } = require("../_support/dbTemplate");
const { createJournal } = require("../../lib/persistence/journal");
const { createFleetRepository } = require("../../lib/fleets/fleetRepository");
const { createBattleRepository } = require("../../lib/battle/battleRepository");
const { OPEN_BATTLE_STATES } = require("../../lib/battle/schema");
const { toItems: toOpenItems, buildBattlesOpenLayerView } = require("../../lib/battle/battlesOpenLayer");
const { settlementSeed, createRng } = require("../../lib/util/rng");
const { createIdGenerator } = require("../../lib/util/ids");
const { createManualClock } = require("../../lib/util/clock");
const { HASH_LIMITS, validateInput, validateResult, hashInput } = require("../../lib/battle/contract");
const { canTransitionBattle, checkMode, listBattleEdges } = require("../../lib/battle/stateMachine");

const START_MS = 1760000000000;
const LIMITS = Object.freeze({ maxFleetsPerSide: 8, maxCompositionEntries: 32, maxShipsPerFleet: 500,
  maxResolutionMs: 50 });
const RESULT_LIMITS = Object.freeze({ maxResultBytes: 65536 });

const EXPECTED_EDGES = [
  "PENDING>PENDING", "PENDING>CLAIMED", "PENDING>FAILED", "PENDING>QUARANTINED",
  "CLAIMED>CLAIMED", "CLAIMED>RESOLVING", "CLAIMED>LIVE", "CLAIMED>FAILED", "CLAIMED>QUARANTINED",
  "RESOLVING>SETTLING", "RESOLVING>FAILED", "RESOLVING>QUARANTINED",
  "LIVE>SETTLING", "LIVE>FAILED", "LIVE>QUARANTINED",
  "SETTLING>COMPLETED", "SETTLING>FAILED", "SETTLING>QUARANTINED",
].sort();

const battleIdOf = (n) => createIdGenerator({ clock: createManualClock(START_MS + n), rng: createRng(n) }).next("battle");

function sampleInput(battleId = battleIdOf(1)) {
  return {
    v: 1, battleId, seed: 12345, systemId: 30000142, environment: "lowsec", objective: "capture",
    garrison: { side: "B", factionId: 500010, strength: 40 }, resolverVersion: "internal-v1", maxResolutionMs: 20,
    sideA: { factionId: 500019, fleets: [
      { fleetId: "fleet_b", factionId: 500019, fleetRole: "invasion", doctrineId: null, supplyState: 100,
        composition: [{ hullGroup: "frigate", typeId: 587, count: 5 }, { hullGroup: "cruiser", count: 3 }] },
      { fleetId: "fleet_a", factionId: 500019, fleetRole: "patrol", doctrineId: "d1", supplyState: 80,
        composition: [{ hullGroup: "destroyer", typeId: null, count: 2 }] },
    ] },
    sideB: { factionId: 500010, fleets: [
      { fleetId: "fleet_c", factionId: 500010, fleetRole: "garrison", doctrineId: null, supplyState: 100,
        composition: [{ hullGroup: "battleship", typeId: 641, count: 1 }] },
    ] },
  };
}

function sampleResult(input, tweak) {
  const surviving = [];
  for (const side of [input.sideA, input.sideB]) {
    for (const f of side.fleets) {
      for (const e of f.composition) surviving.push({ fleetId: f.fleetId, hullGroup: e.hullGroup, typeId: e.typeId, count: e.count });
    }
  }
  const result = { battleId: input.battleId, resolver: input.resolverVersion, outcome: "A_WIN", destroyedShips: [],
    escapedShips: [], survivingShips: surviving, objectiveAchieved: true, estimatedDurationSec: 120, confidence: 0.8,
    diagnostics: { rounds: 3, note: "test" } };
  if (tweak) tweak(result);
  return result;
}

const MOD_DIR = path.resolve(__dirname, "..", "..");
const FACTION_A = 500019;
const FACTION_B = 500010;
const HOME = 30000142;
const TARGET = 30000144;
const BATTLE_SYSTEM = 30000143;
const ENGAGED_STATE = "ENGAGED";
const FLEET_LIMITS = Object.freeze({ maxVirtualFleets: 50, maxCompositionEntries: 32, maxShipsPerFleet: 500,
  maxFleetsPerOperation: 16, maxJsonBytes: 4096, maxListLimit: 500 });
const BATTLE_LIMITS = Object.freeze({ ...LIMITS, maxInputBytes: 65536, maxResultBytes: 65536, maxListLimit: 500,
  maxSettlementRows: 450 });
const COMPOSITION = Object.freeze([{ hullGroup: "frigate", typeId: 587, count: 5 }, { hullGroup: "cruiser", count: 3 }]);

function loadDriver() {
  const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
  if (!found.ok) return { ok: false, detail: found.reason };
  return resolveSqliteDriver(found.srcDir);
}

function withStore(driver, fn, { fresh = false } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-b-"));
  const file = path.join(tmp, "world.sqlite");
  const open = [];
  const reopen = () => {
    if (!fresh) seedDbFile(driver, file, { seed: 1 });
    const opened = openStore({ filePath: file, openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
      busyTimeoutMs: 0, maxRowsPerTransaction: 500, maxWriteMsPerPass: 5, randomSeed: () => 1, migrations: MIGRATIONS });
    assert.ok(opened.ok, JSON.stringify(opened));
    open.push(opened.store);
    return opened;
  };
  try {
    return fn(reopen);
  } finally {
    for (const s of open) s.close("test_cleanup");
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch (_err) {
    }
  }
}

function makeRepos(opened, clock, idGen) {
  const journal = createJournal({ clock, maxPayloadBytes: 16384, maxRows: 500 });
  const fleets = createFleetRepository({ journal, clock, ids: idGen, worldSeed: opened.worldSeed,
    limits: FLEET_LIMITS });
  const battles = createBattleRepository({ journal, fleetRepository: fleets, clock, ids: idGen,
    worldSeed: opened.worldSeed, limits: BATTLE_LIMITS });
  const tx = (fn) => {
    const r = opened.store.transaction("test", fn);
    assert.ok(r.ok, JSON.stringify(r));
    return r.value;
  };
  return { fleets, battles, tx };
}

const fleetOf = (h, fleetId) => h.tx((db) => h.fleets.getFleet(db, fleetId)).fleet;
const battleOf = (h, battleId) => h.tx((db) => h.battles.getBattle(db, battleId)).battle;

function newFleet(h, key, factionId) {
  const r = h.tx((db) => h.fleets.createFleet(db, { factionId, currentSystemId: HOME, homeSystemId: HOME,
    fleetRole: "invasion", composition: COMPOSITION }, key));
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  return r.fleetId;
}

function travelling(h, key, factionId) {
  const fleetId = newFleet(h, key, factionId);
  const op = h.tx((db) => h.fleets.createOperation(db, { operationType: "invasion", factionId, originSystemId: HOME,
    targetSystemId: TARGET, objective: "capture", fleets: [{ fleetId, expectedVersion: 1 }] }, `${key}:op`));
  assert.strictEqual(op.ok, true, JSON.stringify(op));
  const f = fleetOf(h, fleetId);
  const r = h.tx((db) => h.fleets.transition(db, { fleetId, expectedVersion: f.version, from: "PLANNED",
    to: "TRAVELLING", patch: { targetSystemId: TARGET, route: { systems: [HOME, BATTLE_SYSTEM, TARGET] },
      routeGraphVersion: 1, nextActionAt: START_MS + 30000, legSeq: 1 } }, `${key}:travel`));
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  return fleetId;
}

function battleSpec(h, aIds, bIds) {
  const side = (factionId, list) => ({ factionId,
    fleets: list.map((fleetId) => ({ fleetId, expectedVersion: fleetOf(h, fleetId).version })) });
  return { systemId: BATTLE_SYSTEM, environment: "nullsec", objective: "destroy", resolverVersion: "internal-v1",
    maxResolutionMs: 20, garrison: null, sideA: side(FACTION_A, aIds), sideB: side(FACTION_B, bIds) };
}

const rowCounts = (h) => h.tx((db) => ({
  battles: db.prepare("SELECT count(*) AS n FROM battle_records").get().n,
  participants: db.prepare("SELECT count(*) AS n FROM battle_participants").get().n,
  journal: db.prepare("SELECT count(*) AS n FROM world_event_journal").get().n,
}));

const claimKey = (b, mode) => `battle:${b.battleId}:claim:${b.claimSeq + 1}:${mode}`;

function claimOk(h, battleId, mode) {
  const b = battleOf(h, battleId);
  const r = h.tx((db) => h.battles.claim(db, { battleId, expectedVersion: b.version, mode }, claimKey(b, mode)));
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  return r;
}

function moveOk(h, battleId, to, patch) {
  const b = battleOf(h, battleId);
  const r = h.tx((db) => h.battles.transition(db, { battleId, expectedVersion: b.version, from: b.state, to,
    ...(patch ? { patch } : {}) }, `battle:${battleId}:${b.state}>${to}`));
  assert.strictEqual(r.ok, true, `${b.state}->${to}: ${JSON.stringify(r)}`);
  return r;
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  test("B1 battle contract: validateInput / validateResult refusals, stable hashInput, settlementSeed", () => {
    const valid = validateInput(sampleInput(), LIMITS);
    assert.strictEqual(valid.ok, true, JSON.stringify(valid));
    assert.deepStrictEqual(valid.input.sideA.fleets.map((f) => f.fleetId), ["fleet_a", "fleet_b"]);
    assert.ok(Object.isFrozen(valid.input.sideA.fleets[0].composition));

    const noB = sampleInput();
    delete noB.sideB;
    const emptyA = sampleInput();
    emptyA.sideA.fleets = [];
    const emptyComposition = sampleInput();
    emptyComposition.sideB.fleets[0].composition = [];
    for (const bad of [noB, emptyA, emptyComposition]) {
      const r = validateInput(bad, LIMITS);
      assert.strictEqual(r.reason, "INPUT_INVALID", JSON.stringify(r));
    }

    const input = valid.input;
    const okResult = validateResult(input, sampleResult(input, (r) => {
      r.survivingShips[0].count -= 1;
      r.destroyedShips.push({ fleetId: r.survivingShips[0].fleetId, hullGroup: r.survivingShips[0].hullGroup,
        typeId: r.survivingShips[0].typeId, count: 1 });
    }), RESULT_LIMITS);
    assert.strictEqual(okResult.ok, true, JSON.stringify(okResult));
    const unbalanced = validateResult(input, sampleResult(input, (r) => { r.survivingShips[1].count -= 1; }),
      RESULT_LIMITS);
    assert.strictEqual(unbalanced.reason, "RESULT_UNBALANCED", JSON.stringify(unbalanced));
    const g = sampleResult(input).survivingShips[1];
    assert.deepStrictEqual(unbalanced.group, { fleetId: g.fleetId, hullGroup: g.hullGroup, typeId: g.typeId });
    assert.deepStrictEqual([unbalanced.expected, unbalanced.actual], [g.count, g.count - 1]);
    const groupIndex = (r, typeId) => r.survivingShips.findIndex((x) => x.typeId === typeId);
    const badTypes = [[587, "587"], [587, 587.5], [null, false], [null, "0"], [null, -1]];
    for (const [from, to] of badTypes) {
      const r = validateResult(input, sampleResult(input, (x) => { x.survivingShips[groupIndex(x, from)].typeId = to; }),
        RESULT_LIMITS);
      assert.strictEqual(r.reason, "RESULT_INVALID", `${from} -> ${JSON.stringify(to)}: ${JSON.stringify(r)}`);
    }
    const badFleet = validateResult(input, sampleResult(input, (x) => { x.survivingShips[0].hullGroup = ["frigate"]; }),
      RESULT_LIMITS);
    assert.strictEqual(badFleet.reason, "RESULT_INVALID", JSON.stringify(badFleet));
    const zeroForNull = validateResult(input, sampleResult(input, (x) => { x.survivingShips[groupIndex(x, null)].typeId = 0; }),
      RESULT_LIMITS);
    assert.strictEqual(zeroForNull.ok, true, JSON.stringify(zeroForNull));
    assert.ok(zeroForNull.result.survivingShips.every((x) => x.typeId === null || Number.isSafeInteger(x.typeId)));
    assert.strictEqual(zeroForNull.result.survivingShips.filter((x) => x.typeId === 0).length, 0);

    const base = sampleInput();
    const permuted = {};
    for (const key of Object.keys(base).reverse()) permuted[key] = base[key];
    permuted.sideA = { fleets: [...base.sideA.fleets].reverse(), factionId: base.sideA.factionId };
    assert.strictEqual(hashInput(permuted), hashInput(base));
    const bigger = sampleInput();
    bigger.sideA.fleets[0].composition[0].count += 1;
    assert.notStrictEqual(hashInput(bigger), hashInput(base));
    assert.match(hashInput(base), /^[0-9a-f]{64}$/);
    assert.throws(() => hashInput(noB), TypeError);

    const maxOf = (key) => SCHEMA.find((row) => row.key === key).max;
    assert.deepStrictEqual(HASH_LIMITS, { maxFleetsPerSide: maxOf("battle.maxFleetsPerSide"),
      maxResolutionMs: maxOf("battle.maxResolutionMs"), maxCompositionEntries: maxOf("fleets.maxCompositionEntries"),
      maxShipsPerFleet: maxOf("fleets.maxShipsPerFleet") });

    const id = battleIdOf(2);
    assert.strictEqual(settlementSeed(7, "battle", id), settlementSeed(7, "battle", id));
    assert.throws(() => settlementSeed(7, "battle", { id }), TypeError);
    assert.throws(() => settlementSeed(7, "fleet", id), TypeError);
  });

  test("B2 battle transition table: 18 edges, illegal examples, mode rules", () => {
    assert.deepStrictEqual(listBattleEdges().map(([f, t]) => `${f}>${t}`).sort(), EXPECTED_EDGES);
    for (const [from, to] of [["RESOLVING", "LIVE"], ["COMPLETED", "SETTLING"], ["LIVE", "RESOLVING"]]) {
      assert.deepStrictEqual(canTransitionBattle(from, to), { ok: false, reason: "ILLEGAL_TRANSITION", from, to });
    }
    assert.strictEqual(checkMode("RESOLVING", "LIVE_EVEJS").reason, "MODE_MISMATCH");
    assert.strictEqual(checkMode("LIVE", "VIRTUAL").reason, "MODE_MISMATCH");
    assert.strictEqual(checkMode("RESOLVING", "EFS_TEST").ok, true);
    assert.strictEqual(checkMode("LIVE", "LIVE_EVEJS").ok, true);
  });

  needsDriver("B3 createBattle: fleets ENGAGED atomically, retry duplicate, busy fleet -> FLEET_BUSY, nothing written", () => {
    withStore(driver, (reopen) => {
      const opened = reopen();
      assert.strictEqual(opened.schemaVersion, LATEST_SCHEMA_VERSION);
      const clock = createManualClock(START_MS);
      const h = makeRepos(opened, clock, createIdGenerator({ clock, rng: createRng(7) }));
      const f1 = newFleet(h, "f1", FACTION_A);
      const f2 = travelling(h, "f2", FACTION_B);
      const spec = battleSpec(h, [f1], [f2]);
      const created = h.tx((db) => h.battles.createBattle(db, spec, "test:battle:1"));
      assert.strictEqual(created.ok, true, JSON.stringify(created));
      assert.strictEqual(created.duplicate, false);
      for (const id of [f1, f2]) {
        const f = fleetOf(h, id);
        assert.deepStrictEqual([f.state, f.currentSystemId, f.route, f.nextActionAt], [ENGAGED_STATE, BATTLE_SYSTEM,
          null, null], id);
      }
      assert.strictEqual(fleetOf(h, f2).targetSystemId, TARGET, "target kept for the settlement");
      const b = battleOf(h, created.battleId);
      assert.deepStrictEqual([b.state, b.mode, b.claimSeq, b.version, b.seed, b.inputHash],
        ["PENDING", null, 0, 1, created.seed, created.inputHash]);
      assert.deepStrictEqual(b.fleetIds, [f1, f2].sort());
      assert.strictEqual(b.input.sideB.fleets[0].fleetId, f2);

      const retry = h.tx((db) => h.battles.createBattle(db, spec, "test:battle:1"));
      assert.deepStrictEqual([retry.ok, retry.duplicate, retry.battleId], [true, true, created.battleId]);

      const f3 = newFleet(h, "f3", FACTION_B);
      const before = rowCounts(h);
      const f3Version = fleetOf(h, f3).version;
      const busySpec = battleSpec(h, [f1], [f3]);
      const busy = h.tx((db) => h.battles.createBattle(db, busySpec, "test:battle:2"));
      assert.deepStrictEqual([busy.ok, busy.reason, busy.fleetId], [false, "FLEET_BUSY", f1]);
      assert.deepStrictEqual(rowCounts(h), before);
      assert.deepStrictEqual([fleetOf(h, f3).state, fleetOf(h, f3).version], ["IDLE", f3Version]);
    });
  });

  needsDriver("B4 claim: concurrent VIRTUAL / LIVE_EVEJS -> VERSION_CONFLICT; no claim after RESOLVING; unbalanced result", () => {
    withStore(driver, (reopen) => {
      const opened = reopen();
      const clock = createManualClock(START_MS);
      const h = makeRepos(opened, clock, createIdGenerator({ clock, rng: createRng(8) }));
      const spec = battleSpec(h, [newFleet(h, "a", FACTION_A)], [newFleet(h, "b", FACTION_B)]);
      const { battleId } = h.tx((db) => h.battles.createBattle(db, spec, "test:battle"));
      const b1 = battleOf(h, battleId);
      const first = h.tx((db) => h.battles.claim(db, { battleId, expectedVersion: 1, mode: "VIRTUAL" },
        claimKey(b1, "VIRTUAL")));
      const second = h.tx((db) => h.battles.claim(db, { battleId, expectedVersion: 1, mode: "LIVE_EVEJS" },
        claimKey(b1, "LIVE_EVEJS")));
      assert.deepStrictEqual([first.ok, first.mode, first.claimSeq], [true, "VIRTUAL", 1], JSON.stringify(first));
      assert.strictEqual(second.reason, "VERSION_CONFLICT", JSON.stringify(second));
      const again = h.tx((db) => h.battles.claim(db, { battleId, expectedVersion: 1, mode: "VIRTUAL" },
        claimKey(b1, "VIRTUAL")));
      assert.deepStrictEqual([again.ok, again.duplicate], [true, true], JSON.stringify(again));

      moveOk(h, battleId, "RESOLVING");
      const resolving = battleOf(h, battleId);
      const late = h.tx((db) => h.battles.claim(db, { battleId, expectedVersion: resolving.version,
        mode: "LIVE_EVEJS" }, claimKey(resolving, "LIVE_EVEJS")));
      assert.deepStrictEqual([late.reason, late.from], ["ILLEGAL_TRANSITION", "RESOLVING"], JSON.stringify(late));
      const toLive = h.tx((db) => h.battles.transition(db, { battleId, expectedVersion: resolving.version,
        from: "RESOLVING", to: "LIVE" }, "test:live"));
      assert.strictEqual(toLive.reason, "ILLEGAL_TRANSITION");

      const unbalanced = sampleResult(resolving.input, (r) => { r.survivingShips[0].count -= 1; });
      const settle = h.tx((db) => h.battles.transition(db, { battleId, expectedVersion: resolving.version,
        from: "RESOLVING", to: "SETTLING", patch: { result: unbalanced } }, "test:settle"));
      assert.strictEqual(settle.reason, "RESULT_UNBALANCED", JSON.stringify(settle));
      assert.deepStrictEqual(battleOf(h, battleId), resolving, "record unchanged");
      assert.strictEqual(h.tx((db) => h.battles.isApplied(db, "test:settle")).applied, false);
    });
  });

  needsDriver("B5 restart: a battle in every open state survives reopen and takes its next step", () => {
    withStore(driver, (reopen) => {
      const clock = createManualClock(START_MS);
      const idGen = createIdGenerator({ clock, rng: createRng(9) });
      const first = reopen();
      let h = makeRepos(first, clock, idGen);
      const plan = ["PENDING", "CLAIMED", "RESOLVING", "LIVE", "SETTLING"];
      const battles = {};
      const specs = {};
      for (const state of plan) {
        const spec = battleSpec(h, [newFleet(h, `${state}:a`, FACTION_A)], [newFleet(h, `${state}:b`, FACTION_B)]);
        specs[state] = spec;
        const { battleId } = h.tx((db) => h.battles.createBattle(db, spec, `test:battle:${state}`));
        battles[state] = battleId;
        if (state === "PENDING") continue;
        claimOk(h, battleId, state === "LIVE" ? "LIVE_EVEJS" : "VIRTUAL");
        if (state === "LIVE") moveOk(h, battleId, "LIVE");
        if (state === "RESOLVING" || state === "SETTLING") moveOk(h, battleId, "RESOLVING");
        if (state === "SETTLING") {
          moveOk(h, battleId, "SETTLING", { result: sampleResult(battleOf(h, battleId).input) });
        }
      }
      const snapshot = Object.fromEntries(plan.map((s) => [s, battleOf(h, battles[s])]));
      first.store.close("restart");

      const second = reopen();
      assert.strictEqual(second.schemaVersion, LATEST_SCHEMA_VERSION);
      h = makeRepos(second, clock, idGen);
      for (const state of plan) {
        const b = battleOf(h, battles[state]);
        assert.deepStrictEqual(b, snapshot[state], state);
        assert.strictEqual(b.state, state);
        for (const fleetId of b.fleetIds) {
          assert.strictEqual(fleetOf(h, fleetId).state, ENGAGED_STATE, `${state} ${fleetId}`);
          const open = h.tx((db) => h.battles.getByFleet(db, fleetId, { states: [...OPEN_BATTLE_STATES] }));
          assert.deepStrictEqual(open.battles.map((x) => x.battleId), [b.battleId], state);
        }
      }
      claimOk(h, battles.PENDING, "VIRTUAL");
      moveOk(h, battles.CLAIMED, "RESOLVING");
      moveOk(h, battles.RESOLVING, "SETTLING", { result: sampleResult(snapshot.RESOLVING.input) });
      moveOk(h, battles.LIVE, "SETTLING", { result: sampleResult(snapshot.LIVE.input) });
      moveOk(h, battles.SETTLING, "COMPLETED", { settlementKey: `settle:${battles.SETTLING}` });
      const done = battleOf(h, battles.SETTLING);
      assert.deepStrictEqual([done.state, done.settledAt], ["COMPLETED", START_MS]);
      const retry = h.tx((db) => h.battles.createBattle(db, specs.PENDING, "test:battle:PENDING"));
      assert.deepStrictEqual([retry.ok, retry.duplicate, retry.battleId], [true, true, battles.PENDING]);
      assert.deepStrictEqual(h.tx((db) => h.battles.countByState(db)).counts,
        { CLAIMED: 1, COMPLETED: 1, RESOLVING: 1, SETTLING: 2 });
    });
  });
  needsDriver("B-OL layer-battles-open: summarizeOpen sides, versus item of the oldest battle, held, gates", () => {
    withStore(driver, (reopen) => {
      const opened = reopen();
      const clock = createManualClock(START_MS);
      const h = makeRepos(opened, clock, createIdGenerator({ clock, rng: createRng(11) }));
      const OTHER_SYSTEM = 30000145;
      const make = (key, aN, bN, systemId) => {
        const a = Array.from({ length: aN }, (_, i) => newFleet(h, `${key}:a${i}`, FACTION_A));
        const b = Array.from({ length: bN }, (_, i) => newFleet(h, `${key}:b${i}`, FACTION_B));
        const spec = { ...battleSpec(h, a, b), systemId };
        const r = h.tx((db) => h.battles.createBattle(db, spec, `test:ol:${key}`));
        assert.strictEqual(r.ok, true, JSON.stringify(r));
        return r.battleId;
      };
      const first = make("first", 1, 2, BATTLE_SYSTEM);
      clock.advance(60000);
      const second = make("second", 1, 1, BATTLE_SYSTEM);
      moveOk(h, second, "PENDING", { holdReason: "AWAITING_LIVE" });
      const third = make("third", 2, 1, OTHER_SYSTEM);
      const read = h.tx((db) => h.battles.summarizeOpen(db, { limit: 10 }));
      assert.deepStrictEqual([read.ok, read.truncated, read.battles.map((b) => b.battleId)],
        [true, false, [first, second, third]]);
      assert.deepStrictEqual(read.battles[0].sides, { A: { factionId: FACTION_A, fleets: 1, ships: 8 },
        B: { factionId: FACTION_B, fleets: 2, ships: 16 } });
      assert.strictEqual(read.battles[1].holdReason, "AWAITING_LIVE");
      const cut = h.tx((db) => h.battles.summarizeOpen(db, { limit: 2 }));
      assert.deepStrictEqual([cut.battles.length, cut.truncated], [2, true]);
      assert.strictEqual(h.tx((db) => h.battles.summarizeOpen(db, { limit: 5001 })).reason, "BATTLE_INVALID_INPUT");

      const items = toOpenItems(read.battles, 6, clock.now());
      assert.deepStrictEqual(items.map((it) => it[0]), [BATTLE_SYSTEM, OTHER_SYSTEM].sort((x, y) => x - y));
      const sys = items.find((it) => it[0] === BATTLE_SYSTEM);
      assert.deepStrictEqual([sys[1], sys[2], sys[4]], ["battle-held", "1v2 \u00d72",
        [[FACTION_A, 1], [FACTION_B, 2]]]);
      assert.strictEqual(sys[3].length, 2);
      assert.strictEqual(sys[3][0], `${first} - PENDING - A faction ${FACTION_A} 1 fleets/8 ships -> B faction `
        + `${FACTION_B} 2/16 - 1 min`);
      assert.ok(sys[3][1].includes("PENDING (AWAITING_LIVE)"));
      const other = items.find((it) => it[0] === OTHER_SYSTEM);
      assert.deepStrictEqual([other[1], other[2]], ["battle", "2v1"]);
      assert.deepStrictEqual(toOpenItems(read.battles, 1, clock.now()).find((it) => it[0] === BATTLE_SYSTEM)[3]
        .slice(1), ["+1 more"]);

      const plan = h.tx((db) => db.prepare(`EXPLAIN QUERY PLAN SELECT battle_id, system_id, state, hold_reason,
        created_at FROM battle_records WHERE state IN (SELECT value FROM json_each(?)) ORDER BY created_at, battle_id
        LIMIT ?`).all(JSON.stringify(OPEN_BATTLE_STATES), 11));
      assert.ok(plan.some((row) => String(row.detail).includes("battle_records_state")), JSON.stringify(plan));

      let hold = false;
      let txCalls = 0;
      const real = opened.store;
      const store = { ...real, transaction: (name, fn) => {
        txCalls += 1;
        return real.transaction(name, fn);
      } };
      const observed = [];
      const view = buildBattlesOpenLayerView({ store, repository: h.battles, clock,
        getGovernor: () => ({ admits: () => !hold }), telemetry: { observe: (n, v) => observed.push([n, v]) },
        maxBattles: 2, maxLines: 6, refreshMs: 15000 });
      const data = view.getData();
      assert.deepStrictEqual([data.available, data.items.length, data.note], [true, 1,
        "2 battles in progress in 1 systems (truncated)"]);
      assert.deepStrictEqual(data.legend.map((l) => [l[0], l[3], l[5]]), [["battle", "versus", "solid"],
        ["battle-held", "versus", "dashed"]]);
      assert.strictEqual(view.cacheKey(), `o${Math.floor(clock.now() / 15000)}`);
      assert.ok(observed.some(([n]) => n === "observer.galaxyBattlesOpenMs"));
      assert.deepStrictEqual([view.title, view.listed, view.mapLayer.kind, view.mapLayer.order],
        ["Battles in progress", false, "marks", 17]);
      const before = txCalls;
      hold = true;
      assert.deepStrictEqual([view.cacheKey(), view.getData().reason, txCalls], [null, "GOVERNOR_HOLD", before]);
      const closed = buildBattlesOpenLayerView({ store: { isOpen: () => false }, repository: h.battles, clock,
        maxBattles: 2, maxLines: 6, refreshMs: 15000 });
      assert.deepStrictEqual([closed.cacheKey(), closed.getData().available, closed.getData().reason],
        [null, false, "STORE_CLOSED"]);

      const cfg = resolveConfig({ modDir: MOD_DIR, env: {} }).config.observer;
      assert.deepStrictEqual([cfg.galaxyBattlesOpenEnabled, cfg.galaxyBattlesOpenMaxBattles,
        cfg.galaxyBattlesOpenMaxLines, cfg.galaxyBattlesOpenRefreshMs], [true, 500, 6, 15000]);
      assert.strictEqual(resolveConfig({ modDir: MOD_DIR,
        env: { EVEJS_LNE_OBSERVER_GALAXY_BATTLES_OPEN_MAX_BATTLES: "99999" } }).config.observer
        .galaxyBattlesOpenMaxBattles, 5000);
    });
  });
};
