"use strict";

const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");

const OS = require("../../../lib/world/occupation/schema");
const { playerGate } = require("../../../lib/world/occupation/machine");
const { createPlayerSovSiege, startPlayerSovSiege } = require("../../../lib/world/playerSov/siege");
const { createPlayerSovClockRepository } = require("../../../lib/world/playerSov/clock");
const { createOwnerOnline } = require("../../../lib/world/playerSov/ownerOnline");
const { createPlayerSovRepository } = require("../../../lib/world/playerSov/repository");
const { createJournal } = require("../../../lib/persistence/journal");
const { createWorldStateRepository } = require("../../../lib/world/worldStateRepository");
const { startOccupation } = require("../../../lib/world/occupation");
const { startSovStructures } = require("../../../lib/world/sovStructures");
const { createViewRegistry } = require("../../../lib/observer/views");
const { classifyEntries, KINDS } = require("../../../lib/notices/sources");
const { formatNoticeLine } = require("../../../lib/notices/format");
const { resolveConfig } = require("../../../config");
const { harness: H } = require("../../battle/settlement.test");

const MOD_DIR = path.resolve(__dirname, "..", "..", "..");
const MIN = 60000;
const HOUR = 3600000;
const SYS = 30004000;
const A = 99000001;
const CORP = 98000001;
const HUB = 1700000001;
const SANSHA = 500019;
const AMARR = 500003;
const LIMITS = Object.freeze({ maxFactionsPerSystem: 8, maxBatchReadIds: 400, maxListLimit: 500 });

function configOf(env = {}) {
  const r = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(), EVEJS_LNE_PLAYER_SOV_ENABLED: "1",
    EVEJS_LNE_PLAYER_SOV_SIEGE_HOLD_MS: String(30 * MIN), EVEJS_LNE_PLAYER_SOV_REINFORCE_MS: String(HOUR), ...env } });
  assert.deepStrictEqual(r.errors || [], []);
  return r.config;
}

function fakes() {
  const f = { online: true, version: 1, released: [] };
  f.presence = { getStatus: () => ({ available: true, stale: false }), getVersion: () => f.version,
    listPresence: () => (f.online ? [{ systemId: 30000001, characters: [{ characterId: 7 }] }] : []),
    distanceToObserved: () => ({ ok: true, distance: 3 }) };
  f.setOnline = (on) => {
    f.online = on;
    f.version += 1;
  };
  f.adapter = { playerStructures: { listOwnerMemberIds: () => ({ ok: true, characterIds: [7, 8], truncated: false }),
    readOwnerFace: () => ({ ok: true, ceoId: 8, npc: false }) },
  readCharacterStanding: () => ({ ok: true, standing: -10 }),
  releasePlayerSov: (systemId, expect) => {
    f.released.push([systemId, expect.allianceId, expect.hubItemId]);
    return Promise.resolve({ ok: true, outcome: "released" });
  } };
  f.registry = { getFaction: () => ({ kind: "pirate" }) };
  return f;
}

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("R3 siege ops + clock on a migrated store: ATTACK (replay DUPLICATE), SAMPLE (replay STALE), LIFT back "
    + "to HELD, offline sample credits nothing, REINFORCE, RETAKE; one journal row per change of state; classifyEntries "
    + "gives the three mail kinds with the alliance name", () => H.withStore(driver, async (reopen) => {
    const { store } = reopen();
    let t = 10 * HOUR;
    const clock = { now: () => t };
    const journal = createJournal({ clock, maxPayloadBytes: 8192, maxRows: 500 });
    const config = configOf();
    const f = fakes();
    const repo = createPlayerSovRepository();
    const siege = createPlayerSovSiege({ journal, getPlayerSov: () => ({ getRepository: () => repo }),
      clockRepo: createPlayerSovClockRepository(), adapter: f.adapter, getRegistry: () => f.registry,
      getPresence: () => f.presence, config, ownerOnline: createOwnerOnline({ getPresence: () => f.presence,
        adapter: f.adapter, config }) });
    const tx = (fn) => {
      const r = store.transaction("test", fn);
      assert.ok(r.ok, JSON.stringify(r));
      return r.value;
    };
    assert.ok(tx((db) => repo.insertClaim(db, { systemId: SYS, allianceId: A, corpId: CORP, hubItemId: HUB,
      origin: "MIRROR", state: "HELD", at: t })).ok);
    let n = 0;
    const apply = (ops) => tx((db) => siege.applyOpsInTx(db, { systemId: SYS, ops, at: t }, `ev:${n}:psov`));
    const step = () => {
      n += 1;
      const c = tx((db) => siege.readForOccupationInTx(db, SYS, t)).claim;
      const g = playerGate({ playerClaim: c }, SANSHA, t);
      return { c, g, r: apply(g.ops) };
    };
    const outcomes = (r) => r.results.map((x) => `${x.op}:${x.outcome}`);
    const claimNow = () => tx((db) => repo.getLiveInSystem(db, SYS)).claim;
    const clockNow = (id) => tx((db) => db.prepare("SELECT * FROM world_player_sov_clock WHERE claim_id = ?").get(id));

    const first = step();
    assert.strictEqual(first.c.hostileTo(SANSHA), true);
    assert.deepStrictEqual(outcomes(first.r), ["P_ATTACK:APPLIED"]);
    assert.deepStrictEqual(outcomes(apply(first.g.ops)), ["P_ATTACK:DUPLICATE"]);
    t += 10 * MIN;
    const s1 = step();
    assert.deepStrictEqual([outcomes(s1.r), s1.r.results[0].creditedDeltaMs], [["P_SAMPLE:APPLIED"], 10 * MIN]);
    assert.deepStrictEqual(outcomes(apply(s1.g.ops)), ["P_SAMPLE:STALE"]);
    const lifted = apply([{ op: "P_LIFT", claimId: claimNow().claimId, version: claimNow().version }]);
    assert.deepStrictEqual([outcomes(lifted), claimNow().state, clockNow(claimNow().claimId)],
      [["P_LIFT:APPLIED"], "HELD", undefined]);
    t += MIN;
    assert.deepStrictEqual(outcomes(step().r), ["P_ATTACK:APPLIED"]);
    f.setOnline(false);
    t += 10 * MIN;
    const off = step();
    assert.deepStrictEqual([off.g.note, off.r.results[0].creditedDeltaMs], ["PLAYER_SOV_PAUSED_OFFLINE", 0]);
    f.setOnline(true);
    const until = (op) => {
      for (let i = 0; i < 20; i += 1) {
        t += 10 * MIN;
        const s = step();
        if (s.g.ops.some((o) => o.op === op)) return s;
      }
      return assert.fail(`no ${op}`);
    };
    assert.deepStrictEqual(outcomes(until("P_REINFORCE").r), ["P_SAMPLE:APPLIED", "P_REINFORCE:APPLIED"]);
    assert.deepStrictEqual([claimNow().state, clockNow(claimNow().claimId).phase], ["REINFORCED", "REINFORCED"]);
    assert.deepStrictEqual(outcomes(until("P_RETAKE").r), ["P_SAMPLE:APPLIED", "P_RETAKE:APPLIED"]);
    const retaking = claimNow();
    assert.deepStrictEqual([retaking.state, clockNow(retaking.claimId)], ["RETAKING", undefined]);
    assert.ok(tx((db) => siege.transitionInTx(db, retaking, { to: "LOST", reason: "RETAKEN", at: t },
      "PLAYER_SOV_LOST")).ok);

    const entries = tx((db) => journal.listAfter(db, { afterId: 0, uptoId: journal.headId(db).headId,
      aggregateTypes: ["player_sov"], limit: 100 })).entries;
    assert.deepStrictEqual(entries.map((e) => e.eventType), ["PLAYER_SOV_SIEGED", "PLAYER_SOV_LIFTED",
      "PLAYER_SOV_SIEGED", "PLAYER_SOV_REINFORCED", "PLAYER_SOV_LOST"]);
    assert.strictEqual(new Set(entries.map((e) => e.key)).size, entries.length);
    const c = classifyEntries(entries, new Map(), { now: t, maxEventAgeMs: 30 * 24 * HOUR, kinds: new Set(KINDS),
      sieges: new Map(), allianceNames: new Map([[A, "Test Alliance"]]) });
    assert.deepStrictEqual(c.events.map((e) => e.kind), ["PLAYER_SOV_SIEGE", "PLAYER_SOV_SIEGE",
      "PLAYER_SOV_REINFORCED", "PLAYER_SOV_LOST"]);
    assert.deepStrictEqual(c.events.map((e) => [e.ownerCorpId, e.attacker]), Array(4).fill([CORP, SANSHA]));
    const line = formatNoticeLine(c.events[2], { systemName: "X-7OMU", names: new Map([[SANSHA, "Sansha's Nation"]]) });
    assert.ok(line.includes("Sansha's Nation reinforced the sovereignty hub of Test Alliance in X-7OMU."), line);
    assert.ok(line.includes("The reinforcement timer (1 h) runs only while a member of your corporation is online; "
      + "earliest end "), line);
    assert.ok(/^[\x20-\x7E]+$/.test(line), "ASCII");
    const noName = formatNoticeLine({ ...c.events[3], allianceName: null }, { names: new Map() });
    assert.ok(noName.includes("from an unknown alliance."), noName);
  }));

  needsDriver("R5 occupation on a real store: INVASION over a HELD player claim -> no OCCUPIED, no LNE structure "
    + "ANCHOR through ATTACK, samples, REINFORCE and RETAKE; after the retake pump writes LOST -> ANCHOR as before",
  () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const opened = reopen();
    const env = H.boot(opened, shared);
    const sys = H.S.N0;
    const config = configOf({ EVEJS_LNE_SOV_STRUCTURES_ENABLED: "1" });
    assert.strictEqual(config.occupation.adjacencyGateEnabled, true);
    const f = fakes();
    const worldRepo = createWorldStateRepository({ journal: env.journal, clock: shared.clock, limits: LIMITS });
    const persistence = { ok: true, store: env.store, journal: env.journal, worldSeed: opened.worldSeed };
    const holder = { sov: null, siege: null, occupation: null };
    const stations = { getMode: () => "ready", repository: { countLiveBySystem: (db, ids) => ({ ok: true,
      rows: ids.includes(sys) ? [{ systemId: sys, factionId: SANSHA, count: 1 }] : [] }),
      listStationsOfFaction: (db, factionId) => ({ ok: true, records: factionId === SANSHA ? [{ systemId: sys }] : [] }) } };
    const o = startOccupation({ config, persistence, clock: shared.clock, scheduler: env.scheduler, fleets: env.fleets,
      world: { repository: worldRepo }, graph: { getGraph: () => ({ ok: true, graph: shared.graph }) },
      getStations: () => stations, views: createViewRegistry(), logger: { log() {} }, nowMs: () => 0,
      getSovStructures: () => holder.sov, needsSovStructureOf: () => true, getPlayerSovSiege: () => holder.siege });
    assert.ok(o.ok, JSON.stringify(o));
    holder.occupation = o.occupation;
    const s = startSovStructures({ config, persistence, clock: shared.clock, scheduler: env.scheduler,
      getOccupation: () => holder.occupation, getTreasury: () => null, logger: { log() {} } });
    assert.ok(s.ok, JSON.stringify(s));
    holder.sov = s.sovStructures;
    const repo = createPlayerSovRepository();
    const ps = startPlayerSovSiege({ config, persistence, clock: shared.clock, playerSov: { getRepository: () => repo },
      adapter: f.adapter, getPresence: () => f.presence, getRegistry: () => f.registry, logger: { log() {} },
      setTimer: () => ({ cancel() {}, hasRef: () => false }) });
    assert.ok(ps.ok, JSON.stringify(ps));
    holder.siege = ps.playerSovSiege;

    H.newFleet(env, "r5:sansha", SANSHA, [{ hullGroup: "cruiser", count: 5 }]);
    const seed = env.tx((db) => worldRepo.applyChange(db, { systemId: sys, expectedVersion: 0, reason: "SEED_CONTROL",
      state: { securityClass: "nullsec", controllerFactionId: AMARR },
      influence: [{ factionId: AMARR, influenceScore: 10 }, { factionId: SANSHA, influenceScore: 80 }] },
    `world:seed:v1:${sys}`));
    assert.ok(seed.ok, JSON.stringify(seed));
    assert.ok(env.tx((db) => worldRepo.applyChange(db, { systemId: sys, expectedVersion: 1, reason: "OCCUPATION_PHASE",
      state: { occupationState: OS.INVASION, occupierFactionId: SANSHA, phaseSeq: 2 } }, `test:invasion:${sys}`)).ok);
    assert.ok(env.tx((db) => repo.insertClaim(db, { systemId: sys, allianceId: A, corpId: CORP, hubItemId: HUB,
      origin: "MIRROR", state: "HELD", at: shared.clock.now() })).ok);
    shared.clock.advance(2 * HOUR);
    const e = env.scheduler.enqueue(OS.EVENT_TYPE, String(sys), shared.clock.now(),
      { systemId: sys, seq: 2, trigger: "tick" }, OS.tickKey(sys, 2, 1, 1));
    assert.ok(e.ok, JSON.stringify(e));

    const pass = async () => {
      for (let i = 0; i < 20; i += 1) {
        const p = await env.scheduler.runPass();
        assert.ok(p.ok, JSON.stringify(p));
        if (!p.jobs) return;
      }
    };
    const worldState = () => env.tx((db) => worldRepo.getSystem(db, sys, {})).system.occupationState;
    const sovRows = () => env.tx((db) => db.prepare("SELECT count(*) AS n FROM world_sov_structures").get()).n;
    const claimState = () => env.tx((db) => db.prepare("SELECT state FROM world_player_sov WHERE claim_id = ?")
      .get(`psov:${sys}:${A}:${HUB}`)).state;
    const seen = [];
    for (let i = 0; i < 30 && claimState() !== "RETAKING"; i += 1) {
      await pass();
      if (seen[seen.length - 1] !== claimState()) seen.push(claimState());
      assert.deepStrictEqual([worldState(), sovRows()], [OS.INVASION, 0], `step ${i}`);
      shared.clock.advance(10 * MIN);
    }
    assert.deepStrictEqual(seen, ["SIEGED", "REINFORCED", "RETAKING"]);
    await pass();
    assert.deepStrictEqual([worldState(), sovRows()], [OS.INVASION, 0]);

    const run = holder.siege.runRetakePass();
    assert.strictEqual(run.started, 1, JSON.stringify(run));
    await run.settled;
    assert.deepStrictEqual([claimState(), f.released], ["LOST", [[sys, A, HUB]]]);
    shared.clock.advance(config.occupation.evalIntervalMs);
    await pass();
    assert.deepStrictEqual([worldState(), sovRows()], [OS.INVASION, 1]);
    assert.strictEqual(env.tx((db) => db.prepare("SELECT state FROM world_sov_structures").get()).state, "ANCHORING");
    const counters = holder.siege.getStatus().counters;
    assert.deepStrictEqual([counters.attacks, counters.reinforced, counters.retakes, counters.retakeReleased],
      [1, 1, 1, 1]);
    holder.siege.stop();
  }));
};
