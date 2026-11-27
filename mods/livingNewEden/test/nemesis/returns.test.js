"use strict";

const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");

const config = require("../../config");
const { createBountyService } = require("../../lib/bounty/service");
const RR = require("../../lib/bounty/revengeRepository");
const { LEVELS } = require("../../lib/bounty/data/levels");
const { escortsOf } = require("../../lib/bounty/live");
const { createJournal } = require("../../lib/persistence/journal");
const NS = require("../../lib/nemesis");
const NR = require("../../lib/nemesis/repository");
const NP = require("../../lib/nemesis/policy");
const { TYPES } = require("../../lib/battle/data/strengthCatalog");
const { loadDriver, withStore } = require("../notices/storeHelper");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const T0 = 1760000000000;
const FACTION = 500010;
const KILLER = 42;
const KILLER_SHIP = 900001;
const CAPTAIN = 7002;
const SYS = 4;
const GATE = Object.freeze({ x: 1000000000, y: 0, z: 0 });
const GANG = Object.freeze({ ok: true, state: "LINKED", characterIds: [7000, 7001, 7002, 7003],
  memberNames: [null, "Ana Hunter", "Bo Hunter", null], name: "Blood Gang" });
const HULL = Object.values(TYPES).find((t) => Number.isSafeInteger(t.typeId) && typeof t.hullGroup === "string"
  && t.hullGroup !== "" && t.hullGroup !== "capsule");
const NEM_ID = `nem:${KILLER}:${CAPTAIN}`;

let resolved = null;
function base() {
  if (!resolved) {
    const r = config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir() } });
    assert.deepStrictEqual(r.errors || [], []);
    resolved = r.config;
  }
  return resolved;
}
const settings = () => ({ ...base().bountyHunters, enabled: true, liveEnabled: true, revengeEnabled: true });
const nemesisOn = (over = {}) => ({ ...base().nemesis, enabled: true, ...over });

function line() {
  return {
    getSystem: (id) => (Number.isInteger(id) && id >= 1 && id <= 10 ? { id, secClass: "lowsec", regionId: 10000001,
      constellationId: 20000001 } : null),
    getNeighbors: (id) => [id - 1, id + 1].filter((n) => n >= 1 && n <= 10),
    getSystemIds: () => Array.from({ length: 10 }, (_v, i) => i + 1),
    findRoute: (a, b) => ({ ok: true, jumps: Math.abs(a - b) }),
  };
}

function fakeHunt() {
  const h = { calls: [], players: new Map(), own: new Map() };
  Object.assign(h, {
    readPlayerShips: (sys) => ({ ok: true, ships: (h.players.get(sys) || []).map((s) => ({ ...s })) }),
    readShips: (_sys, ids) => ({ ok: true, ships: ids.filter((id) => h.own.has(id))
      .map((id) => ({ entityId: id, ...h.own.get(id) })) }),
    readAggressors: () => ({ ok: true, aggressors: [] }),
    setSearch: () => ({ ok: true, failed: [] }),
    warpShips(_sys, ids) {
      h.calls.push(["warp", ids.slice()]);
      return { ok: true, warped: ids.length, failed: [] };
    },
    attackTargets(_sys, ids, targets) {
      h.calls.push(["attack", ids.slice(), targets.slice()]);
      return { ok: true, failed: [] };
    },
  });
  h.of = (name) => h.calls.filter((c) => c[0] === name);
  h.killerAt = (pos, over = {}) => h.players.set(SYS, [{ characterId: KILLER, entityId: KILLER_SHIP, position: pos,
    inWarp: false, cloaked: false, capsule: false, signatureRadius: 100, typeId: HULL.typeId, groupId: HULL.groupId,
    ...over }]);
  h.moveOwn = (pos) => {
    for (const id of h.own.keys()) h.own.set(id, { position: { ...pos }, inWarp: false });
  };
  return h;
}

function fakeScene(hunt) {
  let next = 6000000000;
  const s = { calls: [] };
  Object.assign(s, {
    spawnGroup(spec) {
      const bossId = (next += 1);
      const escortIds = spec.escorts.map(() => (next += 1));
      for (const id of [bossId, ...escortIds]) hunt.own.set(id, { position: { ...GATE }, inWarp: false });
      s.calls.push(["spawnGroup", spec, bossId]);
      return { ok: true, bossId, escortIds, anchorPoint: { ...GATE },
        cargo: { seeded: Array.isArray(spec.cargo) ? spec.cargo.length : 0, skipped: 0 } };
    },
    despawn(_sys, ids) {
      for (const id of ids) hunt.own.delete(id);
      return { ok: true, removed: ids.length, missing: 0 };
    },
    markShips: (ids) => ({ ok: true, marked: ids.length, evicted: 0 }),
    forgetShips: (ids) => ({ ok: true, forgotten: ids.length }),
  });
  s.of = (name) => s.calls.filter((c) => c[0] === name);
  return s;
}

function fakePresence() {
  const p = { chars: new Map(), space: new Map() };
  p.observedSystems = () => [...new Set([...p.space.keys(), ...[...p.chars.values()].map((c) => c.systemId)])];
  p.getSystemPresence = (id) => ({ systemId: id, space: p.space.get(id) || 0, docked: 0, transit: 0,
    characters: [...p.chars].filter(([, c]) => c.systemId === id).map(([characterId, c]) => ({ characterId,
      state: c.state })) });
  return p;
}

const sql = (opened, text, ...args) => {
  const r = opened.store.transaction("nr.sql", (db) => db.prepare(text).all(...args).map((x) => ({ ...x })));
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
};
const exec = (opened, text, ...args) => {
  const r = opened.store.transaction("nr.exec", (db) => db.prepare(text).run(...args).changes);
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
};
const nem = (opened) => sql(opened, "SELECT * FROM world_nemesis WHERE nemesis_id = ?", NEM_ID)[0];
const returnRows = (opened) => sql(opened, "SELECT * FROM world_bounty_revenge WHERE nemesis_id IS NOT NULL "
  + "ORDER BY revenge_id");

function nemesisRow(opened, N, patch = {}) {
  const at = T0 - N.returnCooldownMs;
  const r = opened.store.transaction("nr.nem", (tx) => NR.createNemesisInTx(tx, { nemesisId: NEM_ID,
    characterId: KILLER, commanderId: CAPTAIN, factionId: FACTION, gangId: 1, name: "Bo Hunter", baseLevel: 3,
    originRevengeId: "rev:old", originSystemId: SYS, seed: 11, profile: {}, history: [] }, at));
  assert.ok(r.ok && r.value.created, JSON.stringify(r));
  for (const [col, v] of Object.entries(patch)) {
    exec(opened, `UPDATE world_nemesis SET ${col} = ? WHERE nemesis_id = ?`, v, NEM_ID);
  }
}

function gangRevenge(opened, P, wantedId, characterId = KILLER, nemesisId = null) {
  const killedAt = T0 - P.revengeDelayMs - 1000;
  const r = opened.store.transaction("nr.rev", (tx) => RR.createRevengeInTx(tx, { wantedId, characterId,
    factionId: FACTION, gangId: 1, bossCharacterId: 7000, targetLevel: 4, killSystemId: SYS, killedAt, seed: 4,
    delayMs: P.revengeDelayMs, windowMs: P.revengeWindowMs, nemesisId }, killedAt));
  assert.ok(r.ok && r.value.ok && r.value.created, JSON.stringify(r));
  return r.value.revenge;
}

function rig(opened, P, opts = {}) {
  const hunt = fakeHunt();
  const scene = fakeScene(hunt);
  const presence = fakePresence();
  const g = line();
  const lines = [];
  const sent = [];
  const vc = { getOwnerIdentity: (_kind, gangId) => (gangId === 1 ? { ...GANG } : { ok: true, state: "PENDING" }) };
  const journal = createJournal({ clock: { now: () => T0 }, maxPayloadBytes: 4096, maxRows: 500 });
  const steps = [];
  const factory = opts.factory === false ? null : (d) => {
    const step = NS.createNemesisStep(d);
    steps.push(step);
    return step;
  };
  const svc = createBountyService({ store: opened.store, worldSeed: 7, logger: { log: (l) => lines.push(l) },
    settings: P, factionIds: [FACTION], levels: LEVELS, getGraph: () => g, getVirtualCorps: () => vc,
    homeStationOf: () => ({ stationId: 60000001, corporationId: 1000127, systemId: 1 }), bloodlinesOf: () => [1],
    ownerCharacterBudget: 2048, systemFactionsOf: (ids) => ({ ok: true, entries: ids.map((systemId) => ({ systemId,
      factionId: FACTION })) }), getPresence: () => presence, getBountyScene: () => scene,
    getHuntScene: () => hunt, getHuntParams: () => base().playerHunt, characterNameOf: (id) => `Pilot ${id}`,
    sendCharacterSystemLine: (spec) => {
      sent.push(spec.text);
      return { ok: true };
    },
    rollOfficerLoot: () => ({ ok: true, items: [{ typeId: 5000, quantity: 1 }], skipped: 0 }),
    typesKnown: (ids) => ({ ok: true, facts: new Map(), missing: ids.filter((id) => id === 99999999) }),
    journal, createNemesisStep: factory, nemesisSettings: opts.nemesis === undefined ? nemesisOn() : opts.nemesis,
    ewarProfilesOf: opts.ewarProfilesOf,
    getChatterAi: opts.getChatterAi, getNotices: opts.getNotices });
  assert.strictEqual(svc.boot(T0).ok, true);
  const pass = (t) => {
    const r = svc.runPass(t);
    assert.strictEqual(r.ok, true, `${JSON.stringify(r)} ${lines.join(" | ")}`);
    return r;
  };
  const at = (state) => presence.chars.set(KILLER, { systemId: SYS, state });
  at("space");
  presence.space.set(SYS, 1);
  hunt.killerAt({ x: 0, y: 0, z: 0 });
  return { svc, hunt, scene, pass, lines, sent, at, step: () => steps[0], counters: () => svc.getStatus().nemesis
    ? svc.getStatus().nemesis.counters : null, revCounters: () => svc.getStatus().counters };
}

function returnAndStart(r, N) {
  const t1 = T0 + 1000;
  r.pass(t1);
  const t2 = t1 + N.returnLeadMs;
  r.pass(t2);
  assert.strictEqual(r.scene.of("spawnGroup").length, 1, `start ${r.lines.join(" | ")}`);
  return t2;
}

const F = (over = {}) => ({ now: 100000, located: { state: "space", systemId: SYS },
  system: { secClass: "lowsec", regionId: 1 }, openRevenge: false, lastReturnAt: null, commanderBusy: false,
  member: true, ...over });

module.exports = ({ test, skip }) => {
  test("NR1 decideNemesisReturn / squadSpecOf / decideNemesisOnEncounter; W71 W72 W74 W77", () => {
    const P = { idleRetireMs: 50000, returnCooldownMs: 1000, playerGapMs: 500, excludedRegions: new Set([9]) };
    const n = { lastEncounterAt: 60000, nextReturnAt: 0, createdAt: 0, rank: 1, baseLevel: 3, missed: 0 };
    const rows = [
      [n, F({ now: 110000 }), "IDLE"],
      [n, F({ member: false }), "MEMBER_GONE"],
      [{ ...n, nextReturnAt: 200000 }, F(), "NOT_DUE"],
      [{ ...n, createdAt: 99500 }, F(), "NOT_DUE"],
      [n, F({ lastReturnAt: 99900 }), "PLAYER_GAP"],
      [n, F({ openRevenge: true }), "OPEN_REVENGE"],
      [n, F({ commanderBusy: true }), "COMMANDER_BUSY"],
      [n, F({ member: null }), "COMMANDER_BUSY"],
      [n, F({ located: null }), "NOT_LOCATED"],
      [n, F({ located: { state: "docked", systemId: SYS } }), "NOT_IN_SPACE"],
      [n, F({ system: null }), "NOT_LOCATED"],
      [n, F({ system: { secClass: "highsec", regionId: 1 } }), "SEC_CLASS"],
      [n, F({ system: { secClass: "nullsec", regionId: 9 } }), "EXCLUDED_REGION"],
    ];
    for (const [nm, f, reason] of rows) assert.deepStrictEqual(NP.decideNemesisReturn(nm, f, P), { ready: false, reason });
    assert.deepStrictEqual(NP.decideNemesisReturn(n, F({ lastReturnAt: 99000 }), P), { ready: true, systemId: SYS });
    const sp = { maxHunterLevel: 5, maxExtraEscorts: 3 };
    assert.deepStrictEqual([1, 2, 3, 6].map((rank) => NP.squadSpecOf({ ...n, rank }, sp)), [
      { hunterLevel: 3, extraEscorts: 0 }, { hunterLevel: 4, extraEscorts: 1 }, { hunterLevel: 5, extraEscorts: 2 },
      { hunterLevel: 5, extraEscorts: 3 }]);
    const E = { maxMissedReturns: 2 };
    const o = (over) => ({ state: "DONE", reason: "TARGET_GONE", engaged: true, bossKilled: false, ...over });
    assert.deepStrictEqual([
      NP.decideNemesisOnEncounter(n, o({ bossKilled: true }), E).action,
      NP.decideNemesisOnEncounter(n, o({ reason: "WIPED", engaged: false }), E).action,
      NP.decideNemesisOnEncounter(n, o({ reason: "TARGET_DOWN" }), E).action,
      NP.decideNemesisOnEncounter(n, o({}), E).action,
      NP.decideNemesisOnEncounter(n, o({ engaged: false, reason: "RETREATED" }), E).action,
      NP.decideNemesisOnEncounter(n, o({ state: "EXPIRED", engaged: false }), E).action,
      NP.decideNemesisOnEncounter({ ...n, missed: 1 }, o({ state: "EXPIRED", engaged: false }), E).action,
      NP.decideNemesisOnEncounter(null, o({}), E).action],
    ["DEFEATED", "DEFEATED", "WON", "ESCAPED", "MISSED", "MISSED", "RETIRED", "NONE"]);
    const r = config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(),
      EVEJS_LNE_NEMESIS_ENABLED: "1", EVEJS_LNE_NEMESIS_RETURN_LEAD_MS: "900000",
      EVEJS_LNE_NEMESIS_RETURN_WINDOW_MS: "600000", EVEJS_LNE_NEMESIS_IDLE_RETIRE_MS: "86400000",
      EVEJS_LNE_NEMESIS_RETURN_COOLDOWN_MS: "86400000", EVEJS_LNE_NEMESIS_TROPHY_TYPE_IDS: "34, 35",
      EVEJS_LNE_NEMESIS_MAX_EXTRA_ESCORTS: "3" } });
    assert.deepStrictEqual(r.errors || [], []);
    const w = r.warnings.join(" | ");
    for (const part of ["returnWindowMs=600000 not above returnLeadMs=900000", "below bountyHunters.revengeRetryMs",
      "above bountyHunters.maxShipsPerTarget - 1", "idleRetireMs=86400000 not above returnCooldownMs"]) {
      assert.ok(w.includes(part), `${part} in ${w}`);
    }
    const bad = config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(),
      EVEJS_LNE_NEMESIS_TROPHY_TYPE_IDS: "34,x" } });
    assert.ok(bad.warnings.some((x) => x.includes("TROPHY_TYPE_IDS") && x.includes("ignored")), bad.warnings.join(" | "));
    assert.strictEqual(bad.config.nemesis.trophyTypeIds, "");
  });

  test("NR6 the defaults with nemesis + bounty live + revenge on give no nemesis warning", () => {
    const r = config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(),
      EVEJS_LNE_NEMESIS_ENABLED: "1", EVEJS_LNE_BOUNTY_ENABLED: "1", EVEJS_LNE_BOUNTY_LIVE_ENABLED: "1",
      EVEJS_LNE_BOUNTY_REVENGE_ENABLED: "1",
      EVEJS_LNE_ENABLED: "1", EVEJS_LNE_VIRTUALCORPS_ENABLED: "1" } });
    assert.deepStrictEqual(r.errors || [], []);
    assert.deepStrictEqual(r.warnings.filter((w) => /nemesis/i.test(w)), []);
    assert.strictEqual(r.config.nemesis.maxExtraEscorts, 2);
  });

  test("NR9 trophy skipped counted once at the spawn; a refused retire -> nemesisRetireFailed", () => {
    const N = nemesisOn({ trophyTypeIds: "34,99999999", trophyOfficerRolls: 0 });
    const lines = [];
    const step = NS.createNemesisStep({ settings: N, store: { transaction: () => ({ ok: false, reason: "DB_LOCKED" }) },
      journal: { applyOnce: () => null, findByKey: () => null }, worldSeed: 7, log: (l) => lines.push(l) });
    const row = (over) => ({ nemesisId: NEM_ID, characterId: KILLER, commanderId: CAPTAIN, factionId: FACTION,
      gangId: 1, name: "Bo Hunter", rank: 1, baseLevel: 3, returns: 1, seed: 11, history: [], profile: {},
      createdAt: T0 - N.idleRetireMs - 10, lastEncounterAt: T0 - N.idleRetireMs - 10, nextReturnAt: 0,
      updatedAt: T0 - 10, originSystemId: SYS, version: 1, ...over });
    step.load([row({ state: "HUNTING", openRevengeId: "rev:x" })]);
    const ctx = { typesKnown: (ids) => ({ ok: true, missing: ids.filter((id) => id === 99999999) }),
      isWantedBusy: () => false, isSquadCommander: () => false, memberOf: () => ({ member: true, corpName: "G" }) };
    const a = step.squadOf({ nemesisId: NEM_ID, revengeId: "rev:x" }, ctx);
    const b = step.squadOf({ nemesisId: NEM_ID, revengeId: "rev:x" }, ctx);
    assert.deepStrictEqual([a.cargo, b.cargo], [[{ typeId: 34, quantity: 1 }], [{ typeId: 34, quantity: 1 }]]);
    assert.strictEqual(step.status().counters.nemesisTrophySkipped, 0);
    a.onSpawn({ cargo: { seeded: 1, skipped: 1 } });
    assert.deepStrictEqual([step.status().counters.nemesisTrophySkipped, step.status().counters.nemesisTrophySeeded],
      [2, 1]);
    step.load([row({ state: "ACTIVE", openRevengeId: null })]);
    let stale = 0;
    const out = step.step(T0, { ...ctx, onStale: () => { stale += 1; } });
    assert.deepStrictEqual([out.retired, step.status().counters.nemesisIdle, step.status().counters.nemesisRetireFailed,
      stale], [0, 1, 1, 1]);
    assert.deepStrictEqual(lines.filter((l) => l.startsWith("nemesis retire")), [`nemesis retire ${NEM_ID} refused - DB_LOCKED`]);
  });

  const driver = loadDriver();
  if (!driver.ok) {
    skip("NR2-NR5 nemesis returns on a store", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }

  test("NR2 a due ACTIVE nemesis + the player in lowsec space -> HUNTING + one return row; OPEN_EXISTS", () => {
    withStore(driver, (opened) => {
      const P = settings();
      const N = nemesisOn();
      nemesisRow(opened, N);
      const r = rig(opened, P);
      const t1 = T0 + 1000;
      r.pass(t1);
      const rows = returnRows(opened);
      assert.strictEqual(rows.length, 1);
      assert.deepStrictEqual([rows[0].wanted_id, rows[0].nemesis_id, rows[0].hunter_level, rows[0].target_level,
        rows[0].boss_character_id, rows[0].kill_system_id, rows[0].state, rows[0].due_at, rows[0].expires_at],
      [`${NEM_ID}:r1`, NEM_ID, 3, 4, CAPTAIN, SYS, "WAITING", t1 + N.returnLeadMs, t1 + N.returnWindowMs]);
      const n1 = nem(opened);
      assert.deepStrictEqual([n1.state, n1.returns, n1.open_revenge_id, n1.rank], ["HUNTING", 1, rows[0].revenge_id, 1]);
      assert.strictEqual(JSON.parse(n1.history_json).slice(-1)[0][1], "RETURN");
      assert.strictEqual(r.counters().nemesisReturnCreated, 1);
      r.pass(t1 + N.checkEveryMs);
      assert.strictEqual(returnRows(opened).length, 1);
      assert.strictEqual(r.svc.getStatus().nemesis.hunting, 1);
      r.svc.stop();
    });
    withStore(driver, (opened) => {
      const P = settings();
      const N = nemesisOn();
      nemesisRow(opened, N);
      const r = rig(opened, P);
      gangRevenge(opened, P, "bnt:9:9");
      const before = nem(opened);
      r.pass(T0 + 1000);
      assert.deepStrictEqual(returnRows(opened), []);
      const after = nem(opened);
      assert.deepStrictEqual([after.state, after.version, after.returns, after.history_json],
        [before.state, before.version, before.returns, before.history_json]);
      assert.strictEqual(r.counters().nemesisWaitOpenRevenge, 1);
      r.svc.stop();
    });
  });

  test("NR3 return start: captain, extra escorts, trophy, line; gang row unchanged; no nemesisSquadOf -> no start", () => {
    withStore(driver, (opened) => {
      const P = settings();
      const N = nemesisOn({ trophyTypeIds: "34,99999999", trophyOfficerRolls: 1 });
      nemesisRow(opened, N, { rank: 3 });
      const r = rig(opened, P, { nemesis: N });
      returnAndStart(r, N);
      const row = returnRows(opened)[0];
      assert.deepStrictEqual([row.state, row.commander_id, row.hunter_level], ["LIVE", CAPTAIN, 5]);
      const spec = r.scene.of("spawnGroup")[0][1];
      const want = escortsOf({ level: 5, seed: row.seed, stayIndex: 0, escortsLost: 0 }, LEVELS, P.maxShipsPerTarget, 2);
      const plain = escortsOf({ level: 5, seed: row.seed, stayIndex: 0, escortsLost: 0 }, LEVELS, P.maxShipsPerTarget);
      assert.deepStrictEqual([spec.escorts.length, want.length - plain.length], [want.length, 2]);
      assert.deepStrictEqual([spec.slimName, spec.cargo], ["Bo Hunter", [{ typeId: 34, quantity: 1 },
        { typeId: 5000, quantity: 1 }]]);
      assert.deepStrictEqual(r.sent, ["Bo Hunter of Blood Gang is back for you. Rank: Commander."]);
      const c = r.counters();
      assert.deepStrictEqual([c.nemesisTrophySkipped, c.nemesisTrophySeeded], [1, 2]);
      r.svc.stop();
    });
    withStore(driver, (opened) => {
      const P = settings();
      gangRevenge(opened, P, "bnt:1:1");
      const r = rig(opened, P);
      r.pass(T0 + 1000);
      const spec = r.scene.of("spawnGroup")[0][1];
      assert.deepStrictEqual(["cargo" in spec, r.sent[0].endsWith("The gang wants its revenge.")], [false, true]);
      r.svc.stop();
    });
    withStore(driver, (opened) => {
      const P = settings();
      gangRevenge(opened, P, `${NEM_ID}:r1`, KILLER, NEM_ID);
      const r = rig(opened, P, { factory: false });
      r.pass(T0 + 1000);
      r.pass(T0 + 1000 + P.revengeCheckEveryMs);
      assert.deepStrictEqual([r.scene.of("spawnGroup").length, returnRows(opened)[0].state], [0, "WAITING"]);
      assert.ok(r.revCounters().revengeNemesisOff >= 1);
      r.svc.stop();
    });
  });

  test("NR4 WON -> rank 2; DEFEATED after bossKilled; EXPIRED x maxMissedReturns -> RETIRED; other row -> none", () => {
    const HP = base().playerHunt;
    withStore(driver, (opened) => {
      const P = settings();
      const N = nemesisOn();
      nemesisRow(opened, N);
      const r = rig(opened, P);
      const t2 = returnAndStart(r, N);
      r.pass(t2 + HP.scanCycleMs);
      r.hunt.moveOwn({ x: HP.warpInDistanceMeters, y: 0, z: 0 });
      r.pass(t2 + HP.scanCycleMs + 1000);
      assert.strictEqual(r.hunt.of("attack").length, 1, "contact");
      r.hunt.killerAt({ x: 0, y: 0, z: 0 }, { capsule: true, typeId: 670, groupId: 29 });
      const t3 = t2 + HP.scanCycleMs + 2000;
      r.pass(t3);
      r.pass(t3 + HP.warpStartGraceMs);
      const rev = returnRows(opened)[0];
      assert.deepStrictEqual([rev.state, rev.end_reason], ["DONE", "TARGET_DOWN"]);
      const n = nem(opened);
      assert.deepStrictEqual([n.state, n.rank, n.wins, n.encounters, n.open_revenge_id, n.next_return_at],
        ["ACTIVE", 2, 1, 2, null, t3 + HP.warpStartGraceMs + N.returnCooldownMs]);
      assert.deepStrictEqual(JSON.parse(n.history_json).map((h) => h[1]), ["RETURN", "WON"]);
      assert.deepStrictEqual(JSON.parse(n.profile_json), { [HULL.hullGroup]: 1 });
      assert.strictEqual(r.counters().nemesisWon, 1);
      const o = { revengeId: "rev:other", nemesisId: NEM_ID, state: "DONE", reason: "TARGET_DOWN", engaged: true,
        bossKilled: false, characterId: KILLER, systemId: SYS, killSystemId: SYS };
      const res = opened.store.transaction("nr.other", (tx) => r.step().onRevengeEndInTx(tx, { nemesisId: NEM_ID }, o,
        t3 + 99000));
      assert.deepStrictEqual(res.value, { outcome: "none", reason: "NOT_OPEN" });
      assert.strictEqual(nem(opened).version, n.version);
      r.svc.stop();
    });
    withStore(driver, (opened) => {
      const P = settings();
      const N = nemesisOn();
      nemesisRow(opened, N);
      const r = rig(opened, P);
      const t2 = returnAndStart(r, N);
      r.hunt.moveOwn({ x: 1000, y: 0, z: 0 });
      r.pass(t2 + 1000);
      const bossId = r.scene.of("spawnGroup")[0][2];
      const live = returnRows(opened)[0];
      r.hunt.own.delete(bossId);
      r.svc.onNpcKill({ characterId: KILLER, victimId: bossId, wantedId: live.revenge_id, version: live.version,
        role: "hunter", systemId: SYS, atMs: t2 + 1500 }, t2 + 1500);
      r.hunt.players.set(SYS, []);
      r.pass(t2 + 2000);
      r.pass(t2 + 2000 + HP.exitGraceMs);
      const n = nem(opened);
      assert.deepStrictEqual([n.state, n.end_reason, n.ended_at !== null, n.open_revenge_id],
        ["DEFEATED", "BOSS_KILLED", true, null]);
      assert.deepStrictEqual([r.counters().nemesisDefeated, r.step().isCaptain(CAPTAIN)], [1, false]);
      r.svc.stop();
    });
    withStore(driver, (opened) => {
      const P = settings();
      const N = nemesisOn({ maxMissedReturns: 2 });
      nemesisRow(opened, N);
      const r = rig(opened, P, { nemesis: N });
      let t = T0 + 1000;
      for (let i = 1; i <= 2; i += 1) {
        r.at("space");
        r.pass(t);
        assert.strictEqual(returnRows(opened).length, i, `return ${i}`);
        r.at("docked");
        r.pass(t + N.returnWindowMs);
        t += N.returnWindowMs + N.returnCooldownMs + N.checkEveryMs;
      }
      assert.deepStrictEqual(returnRows(opened).map((x) => x.state), ["EXPIRED", "EXPIRED"]);
      const n = nem(opened);
      assert.deepStrictEqual([n.state, n.missed, n.end_reason, n.returns], ["RETIRED", 2, "MISSED", 2]);
      assert.deepStrictEqual(JSON.parse(n.history_json).map((h) => h[1]), ["RETURN", "MISSED", "RETURN", "RETIRED"]);
      assert.deepStrictEqual([r.counters().nemesisMissed, r.counters().nemesisRetired], [1, 1]);
      r.svc.stop();
    });
  });

  test("NR5 boot HUNTING without an open revenge -> ACTIVE (nemesisRecovered); flag off -> no nemesis row", () => {
    withStore(driver, (opened) => {
      const P = settings();
      const N = nemesisOn();
      nemesisRow(opened, N, { state: "HUNTING", open_revenge_id: "rev:gone", rank: 2 });
      const r = rig(opened, P);
      const n = nem(opened);
      assert.deepStrictEqual([n.state, n.open_revenge_id, n.rank, n.next_return_at],
        ["ACTIVE", null, 2, T0 + N.returnCooldownMs]);
      assert.strictEqual(r.counters().nemesisRecovered, 1);
      r.svc.stop();
    });
    withStore(driver, (opened) => {
      const P = settings();
      const N = nemesisOn();
      const rev = gangRevenge(opened, P, `${NEM_ID}:r1`, KILLER, NEM_ID);
      nemesisRow(opened, N, { state: "HUNTING", open_revenge_id: rev.revengeId });
      const r = rig(opened, P);
      assert.deepStrictEqual([nem(opened).state, r.counters().nemesisRecovered], ["HUNTING", 0]);
      r.svc.stop();
    });
    for (const opts of [{ nemesis: { ...base().nemesis, enabled: false } }, { factory: false }]) {
      withStore(driver, (opened) => {
        const P = settings();
        const N = nemesisOn();
        nemesisRow(opened, N);
        const r = rig(opened, P, opts);
        r.pass(T0 + 1000);
        r.pass(T0 + 1000 + N.checkEveryMs);
        assert.deepStrictEqual([returnRows(opened).length, nem(opened).state], [0, "ACTIVE"]);
        r.svc.stop();
      });
    }
  });

  test("NR7 a resync read (recover false) also repairs an orphan HUNTING row", () => {
    withStore(driver, (opened) => {
      const P = settings();
      const N = nemesisOn();
      const done = gangRevenge(opened, P, `${NEM_ID}:r1`, KILLER, NEM_ID);
      exec(opened, "UPDATE world_bounty_revenge SET state = 'DONE', end_reason = 'TARGET_DOWN', ended_at = ? "
        + "WHERE revenge_id = ?", T0 - 5, done.revengeId);
      nemesisRow(opened, N, { state: "HUNTING", open_revenge_id: done.revengeId });
      const otherId = `nem:${KILLER}:7003`;
      const c = opened.store.transaction("nr.nem2", (tx) => NR.createNemesisInTx(tx, { nemesisId: otherId,
        characterId: KILLER, commanderId: 7003, factionId: FACTION, gangId: 1, name: "Cy Hunter", baseLevel: 3,
        originRevengeId: "rev:old2", originSystemId: SYS, seed: 12, profile: {}, history: [] }, T0 - 100));
      assert.ok(c.ok && c.value.created, JSON.stringify(c));
      const wait = gangRevenge(opened, P, `${otherId}:r1`, KILLER, otherId);
      exec(opened, "UPDATE world_nemesis SET state = 'HUNTING', open_revenge_id = ? WHERE nemesis_id = ?",
        wait.revengeId, otherId);
      const step = NS.createNemesisStep({ settings: N, store: opened.store, journal: null, worldSeed: 7 });
      const read = opened.store.transaction("nr.read", (tx) => step.readInTx(tx, T0, false));
      assert.ok(read.ok, JSON.stringify(read));
      step.load(read.value.rows, read.value.recovered);
      const n = nem(opened);
      assert.deepStrictEqual([n.state, n.open_revenge_id, n.next_return_at], ["ACTIVE", null, T0 + N.returnCooldownMs]);
      const o = sql(opened, "SELECT state, open_revenge_id FROM world_nemesis WHERE nemesis_id = ?", otherId)[0];
      assert.deepStrictEqual([o.state, o.open_revenge_id], ["HUNTING", wait.revengeId]);
      assert.strictEqual(step.status().counters.nemesisRecovered, 1);
    });
  });

  test("NR8 bossKilled without contact and a non-contact end -> DONE + DEFEATED, no retry", () => {
    const HP = base().playerHunt;
    withStore(driver, (opened) => {
      const P = settings();
      const N = nemesisOn();
      nemesisRow(opened, N);
      const r = rig(opened, P);
      const t2 = returnAndStart(r, N);
      const bossId = r.scene.of("spawnGroup")[0][2];
      const live = returnRows(opened)[0];
      assert.strictEqual(live.state, "LIVE");
      r.hunt.own.delete(bossId);
      r.svc.onNpcKill({ characterId: KILLER, victimId: bossId, wantedId: live.revenge_id, version: live.version,
        role: "hunter", systemId: SYS, atMs: t2 + 500 }, t2 + 500);
      r.hunt.players.set(SYS, []);
      for (const t of [t2 + 1000, t2 + 1000 + HP.exitGraceMs, t2 + P.idleDespawnMs + 2000]) {
        if (returnRows(opened)[0].state === "LIVE") r.pass(t);
      }
      const rev = returnRows(opened)[0];
      assert.ok(!["WIPED", "RETREATED"].includes(rev.end_reason), rev.end_reason);
      assert.strictEqual(rev.state, "DONE", rev.end_reason);
      const n = nem(opened);
      assert.deepStrictEqual([n.state, n.end_reason], ["DEFEATED", "BOSS_KILLED"]);
      const c = r.revCounters();
      assert.deepStrictEqual([c.revengeDone, c.revengeRetry || 0, c.revengeEngaged || 0], [1, 0, 0]);
      r.svc.stop();
    });
  });
};

module.exports.helpers = { rig, nemesisRow, returnAndStart, returnRows, settings, nemesisOn, sql, KILLER, CAPTAIN,
  FACTION, NEM_ID };
