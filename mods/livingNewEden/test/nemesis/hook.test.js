"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const config = require("../../config");
const { createBountyService } = require("../../lib/bounty/service");
const RR = require("../../lib/bounty/revengeRepository");
const { LEVELS } = require("../../lib/bounty/data/levels");
const { createJournal } = require("../../lib/persistence/journal");
const NS = require("../../lib/nemesis");
const NR = require("../../lib/nemesis/repository");
const { TYPES } = require("../../lib/battle/data/strengthCatalog");
const { loadDriver, withStore } = require("../notices/storeHelper");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const T0 = 1760000000000;
const FACTION = 500010;
const KILLER = 42;
const KILLER_SHIP = 900001;
const BOSS_A = 7000;
const SYS = 4;
const GATE = Object.freeze({ x: 1000000000, y: 0, z: 0 });
const GANG = Object.freeze({ ok: true, state: "LINKED", characterIds: [BOSS_A, 7001, 7002, 7003],
  memberNames: [null, "Ana Hunter", "Bo Hunter", null], name: "Blood Gang" });
const HULL = Object.values(TYPES).find((t) => Number.isSafeInteger(t.typeId) && typeof t.hullGroup === "string"
  && t.hullGroup !== "" && t.hullGroup !== "capsule");

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
  const h = { calls: [], players: new Map(), own: new Map(), aggressors: [] };
  Object.assign(h, {
    readPlayerShips: (sys) => ({ ok: true, ships: (h.players.get(sys) || []).map((s) => ({ ...s })) }),
    readShips: (_sys, ids) => ({ ok: true, ships: ids.filter((id) => h.own.has(id))
      .map((id) => ({ entityId: id, ...h.own.get(id) })) }),
    readAggressors: () => ({ ok: true, aggressors: [] }),
    setSearch: () => ({ ok: true, failed: [] }),
    warpShips(_sys, ids, point) {
      h.calls.push(["warp", ids.slice(), point]);
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
      return { ok: true, bossId, escortIds, anchorPoint: { ...GATE } };
    },
    despawn(_sys, ids) {
      for (const id of ids) hunt.own.delete(id);
      return { ok: true, removed: ids.length, missing: 0 };
    },
    markShips(ids) {
      s.calls.push(["mark", ids.slice()]);
      return { ok: true, marked: ids.length, evicted: 0 };
    },
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
  const r = opened.store.transaction("nm.sql", (db) => db.prepare(text).all(...args).map((x) => ({ ...x })));
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
};
const exec = (opened, text, ...args) => {
  const r = opened.store.transaction("nm.exec", (db) => db.prepare(text).run(...args).changes);
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
};
const revRow = (opened, id) => sql(opened, "SELECT * FROM world_bounty_revenge WHERE revenge_id = ?", id)[0];
const nemRows = (opened) => sql(opened, "SELECT * FROM world_nemesis ORDER BY nemesis_id");

function revengeRow(opened, P, wantedId = "bnt:1:1", characterId = KILLER) {
  const killedAt = T0 - P.revengeDelayMs - 1000;
  const r = opened.store.transaction("nm.rev", (tx) => RR.createRevengeInTx(tx, { wantedId, characterId,
    factionId: FACTION, gangId: 1, bossCharacterId: BOSS_A, targetLevel: 4, killSystemId: 3, killedAt, seed: 4,
    delayMs: P.revengeDelayMs, windowMs: P.revengeWindowMs }, killedAt));
  assert.ok(r.ok && r.value.ok && r.value.created, JSON.stringify(r));
  return r.value.revenge;
}

function nemesisRow(opened, characterId, commanderId, patch = null) {
  const r = opened.store.transaction("nm.nem", (tx) => NR.createNemesisInTx(tx, { nemesisId:
    `nem:${characterId}:${commanderId}`, characterId, commanderId, factionId: FACTION, gangId: 1, name: "Bo Hunter",
  baseLevel: 3, originRevengeId: "rev:old", originSystemId: SYS, seed: 1, profile: {}, history: [] }, T0 - 5000));
  assert.ok(r.ok && r.value.created, JSON.stringify(r));
  if (patch) {
    exec(opened, "UPDATE world_nemesis SET state = ?, ended_at = ? WHERE nemesis_id = ?", patch.state, patch.endedAt,
      `nem:${characterId}:${commanderId}`);
  }
}

function rig(opened, P, opts = {}) {
  const hunt = fakeHunt();
  const scene = fakeScene(hunt);
  const presence = fakePresence();
  const g = line();
  const lines = [];
  const vc = { getOwnerIdentity: (_kind, gangId) => (gangId === 1 ? { ...GANG } : { ok: true, state: "PENDING" }) };
  const real = createJournal({ clock: { now: () => T0 }, maxPayloadBytes: 4096, maxRows: 500 });
  const journal = opts.journal ? opts.journal(real) : real;
  const steps = [];
  const factory = opts.factory === false ? null : (d) => {
    const step = NS.createNemesisStep(d);
    steps.push(step);
    return opts.wrap ? opts.wrap(step) : step;
  };
  const svc = createBountyService({ store: opened.store, worldSeed: 7, logger: { log: (l) => lines.push(l) },
    settings: P, factionIds: [FACTION], levels: LEVELS, getGraph: () => g, getVirtualCorps: () => vc,
    homeStationOf: () => ({ stationId: 60000001, corporationId: 1000127, systemId: 1 }), bloodlinesOf: () => [1],
    ownerCharacterBudget: 2048, systemFactionsOf: (ids) => ({ ok: true, entries: ids.map((systemId) => ({ systemId,
      factionId: FACTION })) }), getPresence: () => presence, getBountyScene: () => scene,
    getHuntScene: () => hunt, getHuntParams: () => base().playerHunt, characterNameOf: (id) => `Pilot ${id}`,
    sendCharacterSystemLine: () => ({ ok: true }), journal, createNemesisStep: factory,
    nemesisSettings: opts.nemesis === undefined ? nemesisOn() : opts.nemesis });
  assert.strictEqual(svc.boot(T0).ok, true);
  const pass = (t) => {
    const r = svc.runPass(t);
    assert.strictEqual(r.ok, true, `${JSON.stringify(r)} ${lines.join(" | ")}`);
    return r;
  };
  presence.chars.set(KILLER, { systemId: SYS, state: "space" });
  presence.space.set(SYS, 1);
  hunt.killerAt({ x: 0, y: 0, z: 0 });
  return { svc, hunt, scene, pass, lines, step: () => steps[0], status: () => svc.getStatus() };
}

function contactThenGone(r) {
  const HP = base().playerHunt;
  const t1 = T0 + 1000;
  r.pass(t1);
  r.hunt.moveOwn({ x: 1000, y: 0, z: 0 });
  r.pass(t1 + 1000);
  assert.strictEqual(r.hunt.of("attack").length, 1, "contact");
  r.hunt.players.set(SYS, []);
  r.pass(t1 + 2000);
  r.pass(t1 + 2000 + HP.exitGraceMs);
  return t1 + 2000 + HP.exitGraceMs;
}

module.exports = ({ test, skip }) => {
  test("NM5b no lib/bounty file requires lib/nemesis; W70 / W73", () => {
    const dir = path.join(MOD_DIR, "lib", "bounty");
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".js"))) {
      const text = fs.readFileSync(path.join(dir, f), "utf8");
      assert.ok(!/require\([^)]*nemesis/.test(text), f);
    }
    assert.strictEqual(base().nemesis.enabled, false);
    const r = config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(),
      EVEJS_LNE_NEMESIS_ENABLED: "1", EVEJS_LNE_NEMESIS_MAX_ACTIVE_PER_PLAYER: "4",
      EVEJS_LNE_NEMESIS_MAX_ACTIVE_TOTAL: "2" } });
    assert.deepStrictEqual(r.errors || [], []);
    const w = r.warnings.join(" | ");
    assert.ok(w.includes("nemesis.enabled without bountyHunters.enabled"), w);
    assert.ok(w.includes("nemesis.maxActiveTotal=2 below maxActivePerPlayer=4"), w);
  });

  const driver = loadDriver();
  if (!driver.ok) {
    skip("NM3/NM4/NM5 the end hook on a store", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }

  test("NM3 contact, boss alive, TARGET_DOWN -> ACTIVE rank 1; replay -> duplicate; a throwing hook -> DONE + "
    + "nemesisHookFailed", () => {
    withStore(driver, (opened) => {
      const P = settings();
      const HP = base().playerHunt;
      const rev = revengeRow(opened, P);
      const r = rig(opened, P);
      const t1 = T0 + 1000;
      r.pass(t1);
      r.pass(t1 + HP.scanCycleMs);
      r.hunt.moveOwn({ x: HP.warpInDistanceMeters, y: 0, z: 0 });
      r.pass(t1 + HP.scanCycleMs + 1000);
      assert.strictEqual(r.hunt.of("attack").length, 1, "contact");
      r.hunt.killerAt({ x: 0, y: 0, z: 0 }, { capsule: true, typeId: 670, groupId: 29 });
      const t3 = t1 + HP.scanCycleMs + 2000;
      r.pass(t3);
      r.pass(t3 + HP.warpStartGraceMs);
      const ended = revRow(opened, rev.revengeId);
      assert.deepStrictEqual([ended.state, ended.end_reason, ended.commander_id, ended.nemesis_id],
        ["DONE", "TARGET_DOWN", 7002, null]);
      const rows = nemRows(opened);
      assert.strictEqual(rows.length, 1);
      const n = rows[0];
      assert.deepStrictEqual([n.nemesis_id, n.state, n.rank, n.base_level, n.encounters, n.name, n.origin_revenge_id,
        n.origin_system_id, n.character_id, n.commander_id], ["nem:42:7002", "ACTIVE", 1, 3, 1, "Bo Hunter",
        rev.revengeId, SYS, KILLER, 7002]);
      const history = JSON.parse(n.history_json);
      assert.deepStrictEqual([history.length, history[0][1], history[0][2], history[0][3]],
        [1, "CREATED", SYS, HULL.hullGroup]);
      assert.deepStrictEqual(JSON.parse(n.profile_json), { [HULL.hullGroup]: 1 }, "raw ship, the capsule ignored");
      const st = r.status().nemesis;
      assert.deepStrictEqual([st.active, st.hunting, st.byRank, st.counters.nemesisCreated], [1, 0, { 1: 1 }, 1]);
      assert.strictEqual(r.step().isCaptain(7002), true);
      const o = { revengeId: rev.revengeId, nemesisId: null, state: "DONE", reason: "TARGET_DOWN", engaged: true,
        bossKilled: false, commanderId: 7002, commanderName: "Bo Hunter", characterId: KILLER, factionId: FACTION,
        gangId: 1, hunterLevel: 3, systemId: SYS, killSystemId: 3, quarryTypeId: null, quarryGroupId: null };
      const endedRow = RR.toRevenge(revRow(opened, rev.revengeId));
      const again = opened.store.transaction("nm.replay", (tx) => r.step().onRevengeEndInTx(tx, endedRow, o,
        t3 + 9000));
      assert.deepStrictEqual(again.value, { outcome: "duplicate" });
      assert.strictEqual(nemRows(opened).length, 1);
      r.svc.stop();
    });
    withStore(driver, (opened) => {
      const P = settings();
      const rev = revengeRow(opened, P);
      const r = rig(opened, P, { journal: (real) => ({ applyOnce: real.applyOnce, findByKey() {
        throw new Error("boom");
      } }) });
      contactThenGone(r);
      assert.deepStrictEqual([revRow(opened, rev.revengeId).state, nemRows(opened).length], ["DONE", 0]);
      assert.strictEqual(r.status().nemesis.counters.nemesisHookFailed, 1);
      assert.ok(r.lines.some((l) => l.includes("nemesis hook refused - boom")), r.lines.join(" | "));
      r.svc.stop();
    });
  });

  test("NM4 boss killed -> BOSS_KILLED; ACTIVE captain not a leader; pruneInTx; status", () => {
    withStore(driver, (opened) => {
      const P = settings();
      const rev = revengeRow(opened, P);
      const seen = [];
      const r = rig(opened, P, { wrap: (step) => ({ ...step, onRevengeEndInTx: (...a) => {
        const out = step.onRevengeEndInTx(...a);
        seen.push(out);
        return out;
      } }) });
      const t1 = T0 + 1000;
      r.pass(t1);
      r.hunt.moveOwn({ x: 1000, y: 0, z: 0 });
      r.pass(t1 + 1000);
      const bossId = r.scene.of("spawnGroup")[0][2];
      const row = revRow(opened, rev.revengeId);
      r.hunt.own.delete(bossId);
      assert.deepStrictEqual(r.svc.onNpcKill({ characterId: KILLER, victimId: bossId, wantedId: rev.revengeId,
        version: row.version, role: "hunter", systemId: SYS, atMs: t1 + 1500 }, t1 + 1500),
      { ok: true, outcome: "HUNTER_LOST" });
      r.hunt.players.set(SYS, []);
      r.pass(t1 + 2000);
      r.pass(t1 + 2000 + base().playerHunt.exitGraceMs);
      assert.strictEqual(revRow(opened, rev.revengeId).state, "DONE");
      assert.deepStrictEqual([seen, nemRows(opened).length], [[{ outcome: "none", reason: "BOSS_KILLED" }], 0]);
      r.svc.stop();
    });
    withStore(driver, (opened) => {
      const P = settings();
      const N = nemesisOn();
      nemesisRow(opened, 77, 7002);
      nemesisRow(opened, 78, 7003, { state: "RETIRED", endedAt: T0 - N.retentionMs - 1 });
      nemesisRow(opened, 79, 7001, { state: "RETIRED", endedAt: T0 - 1000 });
      const rev = revengeRow(opened, P);
      const r = rig(opened, P);
      assert.deepStrictEqual(r.status().nemesis.byRank, { 1: 1 });
      assert.deepStrictEqual([r.status().nemesis.active, r.status().nemesis.hunting], [1, 0]);
      r.pass(T0 + 1000);
      assert.strictEqual(revRow(opened, rev.revengeId).commander_id, 7001);
      assert.deepStrictEqual(nemRows(opened).map((x) => x.nemesis_id), ["nem:77:7002", "nem:79:7001"]);
      assert.strictEqual(r.status().nemesis.counters.nemesisPruned, 1);
      const pr = opened.store.transaction("nm.prune", (tx) => r.step().pruneInTx(tx, T0 + 1000, 10));
      assert.deepStrictEqual(pr.value, { pruned: 0 });
      r.svc.stop();
    });
  });

  test("NM5 flag off / no factory: an end after a contact writes no nemesis row, no nemesis in the status", () => {
    for (const opts of [{ nemesis: { ...base().nemesis, enabled: false } }, { factory: false }]) {
      withStore(driver, (opened) => {
        const P = settings();
        const rev = revengeRow(opened, P);
        const r = rig(opened, P, opts);
        contactThenGone(r);
        assert.deepStrictEqual([revRow(opened, rev.revengeId).state, nemRows(opened).length], ["DONE", 0]);
        assert.ok(!("nemesis" in r.status()));
        assert.strictEqual(r.step(), undefined, "no step built");
        r.svc.stop();
      });
    }
  });
};
