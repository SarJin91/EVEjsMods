"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const config = require("../../config");
const RV = require("../../lib/bounty/revenge");
const RR = require("../../lib/bounty/revengeRepository");
const { decideRevengeStart, REVENGE_SEC_CLASSES } = require("../../lib/bounty/revengePolicy");
const { LEVELS } = require("../../lib/bounty/data/levels");
const { planFameBounty } = require("../../lib/fame/bounty");
const { createJournal } = require("../../lib/persistence/journal");
const CR = require("../../lib/adapter/concordResponse");
const { GAME_MODULES } = require("../../lib/adapter/gameModules");
const { loadDriver, withStore } = require("../notices/storeHelper");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SERVER_SRC = path.resolve(__dirname, "..", "..", "..", "..", "server", "src");
const readSource = (rel) => fs.readFileSync(path.join(SERVER_SRC, rel), "utf8").replace(/\r\n/g, "\n");
const T0 = 1760000000000;
const GURISTAS = 500010;
const KILL_SYS = 4;
const HS9 = 5;
const HS5 = 6;
const HS46 = 7;
const POS = Object.freeze({ x: 1e9, y: 0, z: 0 });
const GATE = Object.freeze({ x: 5e12, y: 0, z: 0 });
const CONCORD_IDS = Object.freeze([8000001, 8000002]);

let cached = null;
function cfg() {
  if (!cached) {
    const r = config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir() }, settings: {}, envFile: {} });
    assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
    cached = r.config;
  }
  return cached;
}

function graph() {
  const sec = (id) => (id === HS9 ? ["highsec", 0.9] : id === HS5 ? ["highsec", 0.5]
    : id === HS46 ? ["highsec", 0.46] : ["lowsec", 0.3]);
  return {
    getSystem: (id) => (Number.isInteger(id) && id >= 1 && id <= 10 ? { id, secClass: sec(id)[0], security: sec(id)[1],
      regionId: 10000001 } : null),
    findRoute: (a, b) => ({ ok: true, jumps: Math.abs(a - b) }),
  };
}

function rig(opened, o = {}) {
  const P = { ...cfg().bountyHunters, enabled: true, liveEnabled: true, revengeEnabled: true, revengeMaxLive: 4 };
  const H = { enabled: true, spawnEnabled: false, extraMs: 0, fallbackMs: 15000, killMs: 30000, leaveMs: 10000,
    maxLive: 1, minSecurity: 0.5, maxSecurity: 1, ...o.highsec };
  const journal = createJournal({ clock: { now: () => T0 }, maxPayloadBytes: 4096, maxRows: 500 });
  const clock = { t: T0 };
  const where = new Map();
  const own = new Map();
  const counts = {};
  const calls = { attack: [], warp: [], despawn: [], spawn: [], gate: 0, delay: 0 };
  const hooks = [];
  const logs = [];
  const concord = {
    gate: { ok: true, enabled: false },
    delay: { ok: true, ms: 19000 },
    spawnAnswer: { ok: true, entityIds: [...CONCORD_IDS] },
    readConcordGateNpcAggro() {
      calls.gate += 1;
      return concord.gate;
    },
    concordResponseDelayMs() {
      calls.delay += 1;
      return concord.delay;
    },
    spawnConcordAgainst(systemId, targetIds, anchor) {
      calls.spawn.push({ systemId, targetIds: targetIds.slice(), anchor: { ...anchor } });
      return concord.spawnAnswer;
    },
  };
  const shipsIn = (systemId) => [...where].filter(([, s]) => s === systemId).map(([cid]) => ({ characterId: cid,
    entityId: 900000 + cid, typeId: 587, groupId: 25, position: { ...POS }, inWarp: false, cloaked: false,
    capsule: false, signatureRadius: 100 }));
  const hunt = {
    readPlayerShips: (systemId) => (r.sceneGone ? { ok: false, reason: "SCENE_NOT_LOADED" }
      : { ok: true, ships: shipsIn(systemId) }),
    readShips: (_s, ids) => ({ ok: true, ships: ids.filter((id) => own.has(id)).map((id) => ({ entityId: id,
      position: { ...POS }, inWarp: false })) }),
    readAggressors: () => ({ ok: true, aggressors: [] }),
    setSearch: () => ({ ok: true, failed: [] }),
    warpShips: (_s, ids, point) => {
      calls.warp.push({ at: clock.t, ids: ids.slice(), point: { ...point } });
      return { ok: true, warped: ids.length, failed: [] };
    },
    attackTargets: (_s, ids, targets) => {
      calls.attack.push({ at: clock.t, ids: ids.slice(), targets: targets.slice() });
      return { ok: true, failed: [] };
    },
  };
  let next = 6000000000;
  const scene = {
    spawnGroup: (spec) => {
      const bossId = (next += 1);
      const escortIds = spec.escorts.map(() => (next += 1));
      for (const id of [bossId, ...escortIds]) own.set(id, true);
      return { ok: true, bossId, escortIds, anchorPoint: { ...GATE } };
    },
    despawn: (_s, ids) => {
      calls.despawn.push(ids.slice());
      for (const id of ids) own.delete(id);
      return { ok: true };
    },
    markShips: () => ({ ok: true }),
    forgetShips: () => ({ ok: true }),
  };
  const presence = {
    observedSystems: () => [...new Set(where.values())],
    getSystemPresence: (id) => ({ systemId: id, characters: [...where].filter(([, s]) => s === id)
      .map(([cid]) => ({ characterId: cid, state: "space" })) }),
  };
  const step = RV.createRevengeStep({ settings: P, store: opened.store, worldSeed: 7, journal,
    getPresence: () => presence, getGraph: () => graph(), bump: (n, k = 1) => { counts[n] = (counts[n] || 0) + k; },
    log: (line) => logs.push(line), onStale() {}, levels: LEVELS, getScene: () => scene, getHuntScene: () => hunt,
    getHuntParams: () => cfg().playerHunt, getVirtualCorps: () => null, sendCharacterSystemLine: () => ({ ok: true }),
    onRevengeEndInTx: (_tx, ended, outcome) => {
      hooks.push(outcome);
      return null;
    },
    fameHighsec: H, getConcord: () => concord });
  const killedAt = T0 - P.revengeDelayMs - 1000;
  const spec = (wantedId, characterId, extra = {}) => ({ wantedId, characterId, factionId: GURISTAS, gangId: 1,
    bossCharacterId: 7010, targetLevel: 4, killSystemId: KILL_SYS, killedAt, seed: characterId, delayMs: P.revengeDelayMs,
    windowMs: P.revengeWindowMs, ...extra });
  const r = { P, H, step, where, own, counts, calls, hooks, logs, concord, clock, sceneGone: false };
  r.rows = (list) => {
    const made = opened.store.transaction("fh.rows", (tx) => list.map((x) => {
      where.set(x.cid, x.systemId);
      if (x.kind === "fame") {
        return step.createFameInTx(tx, { wantedId: `fame:${x.cid}:${GURISTAS}:1`, characterId: x.cid,
          factionId: GURISTAS, level: 4, systemId: x.systemId, at: killedAt, delayMs: P.revengeDelayMs,
          windowMs: P.revengeWindowMs }, { gangId: 1, bossCharacterId: 7010 }).outcome;
      }
      const extra = x.kind === "nemesis" ? { nemesisId: `nm:${x.cid}` } : {};
      return RR.createRevengeInTx(tx, spec(`bnt:${x.cid}:1`, x.cid, extra), killedAt).created ? "created" : "no";
    }));
    assert.ok(made.ok && made.value.every((v) => v === "created"), JSON.stringify(made));
    const read = opened.store.transaction("fh.read", (tx) => step.readInTx(tx, T0, false));
    step.load(read.value.rows);
  };
  r.at = (t) => {
    clock.t = t;
    step.step(t);
  };
  r.c = (name) => counts[name] || 0;
  r.squads = () => step.status().squads;
  return r;
}

function engaged(r, cid = 101) {
  r.rows([{ kind: "fame", cid, systemId: HS5 }]);
  r.at(T0);
  assert.strictEqual(r.squads().length, 1, JSON.stringify(r.counts));
  r.at(T0 + 1000);
  assert.strictEqual(r.calls.attack.length, 1, "the first attack");
  assert.strictEqual(r.c("concordTimers"), 1);
  return T0 + 1000;
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  test("FH1 planFameBounty highsec, decideRevengeStart secClassesOf; the highsec gate on a store: gang / nemesis "
    + "SEC_CLASS, fame start, gate flag, security, maxLive", () => {
    const p = { bountyEnabled: true, bountyDelayAfterTierMs: 0, bountyCooldownMs: 86400000, enemyMax: -2,
      bountyLevelBase: 2, bountyLevelStep: 1.5, bountyMaxLevel: 5 };
    const pair = { tier: "PUBLIC_ENEMY", standing: -2, enemySince: T0 };
    const facts = { now: T0, located: { systemId: HS5, state: "space" }, secClass: "highsec" };
    assert.deepStrictEqual(planFameBounty(pair, facts, p), { post: false, wait: "SEC_CLASS" });
    assert.strictEqual(planFameBounty(pair, facts, { ...p, bountyHighsecEnabled: true }).post, true);
    assert.deepStrictEqual(planFameBounty(pair, { ...facts, secClass: null }, { ...p, bountyHighsecEnabled: true }),
      { post: false, wait: "SEC_CLASS" }, "unknown class stays a wait");
    const row = { dueAt: 0, expiresAt: T0 + 1 };
    const f = { now: T0, located: { systemId: HS5, state: "space" }, system: { secClass: "highsec", regionId: 1 },
      route: { ok: true, jumps: 1 }, capsule: null };
    const base = { maxJumps: 5, excludedRegions: new Set() };
    assert.deepStrictEqual(decideRevengeStart(row, f, base), { ready: false, reason: "SEC_CLASS" });
    assert.deepStrictEqual(decideRevengeStart(row, f, { ...base, secClassesOf: () => ["highsec"] }),
      { ready: true, systemId: HS5, jumps: 1 });
    assert.strictEqual(decideRevengeStart(row, f, { ...base, secClassesOf: () => "x" }).reason, "SEC_CLASS");
    assert.deepStrictEqual([...REVENGE_SEC_CLASSES], ["lowsec", "nullsec"]);
    assert.deepStrictEqual([RV.displaySecurity(0.45), RV.displaySecurity(0.449), RV.displaySecurity(0.84)],
      [0.5, 0.4, 0.8], "shown security = tenths (crimewatchState.js:1407)");
    if (!driver.ok) return;
    withStore(driver, (opened) => {
      const r = rig(opened);
      r.rows([{ kind: "gang", cid: 101, systemId: HS5 }, { kind: "nemesis", cid: 102, systemId: HS5 },
        { kind: "fame", cid: 103, systemId: HS5 }]);
      r.at(T0);
      assert.deepStrictEqual([r.c("revengeWaitSecClass"), r.c("revengeReady"), r.c("highsecStarted"),
        r.calls.gate, r.squads().length], [2, 1, 1, 1, 1], JSON.stringify(r.counts));
      r.step.stop();
    });
    withStore(driver, (opened) => {
      const r = rig(opened);
      r.concord.gate = { ok: true, enabled: true };
      r.rows([{ kind: "fame", cid: 103, systemId: HS5 }]);
      r.at(T0);
      r.concord.gate = { ok: false, reason: "READ_FAILED" };
      r.at(T0 + r.P.revengeCheckEveryMs);
      assert.deepStrictEqual([r.c("highsecGateConcord"), r.c("revengeReady"), r.squads().length], [2, 0, 0]);
      r.concord.gate = { ok: true, enabled: false };
      r.at(T0 + 2 * r.P.revengeCheckEveryMs);
      assert.deepStrictEqual([r.c("highsecStarted"), r.squads().length], [1, 1]);
      r.step.stop();
    });
    withStore(driver, (opened) => {
      const r = rig(opened, { highsec: { maxSecurity: 0.8 } });
      r.rows([{ kind: "fame", cid: 104, systemId: HS9 }]);
      r.at(T0);
      assert.deepStrictEqual([r.c("highsecSecurity"), r.squads().length], [1, 0]);
      r.step.stop();
    });
    withStore(driver, (opened) => {
      const r = rig(opened, { highsec: { minSecurity: cfg().fame.bountyHighsecMinSecurity } });
      r.rows([{ kind: "fame", cid: 107, systemId: HS46 }]);
      r.at(T0);
      assert.deepStrictEqual([r.c("highsecStarted"), r.c("highsecSecurity"), r.squads().length], [1, 0, 1],
        JSON.stringify(r.counts));
      r.step.stop();
    });
    withStore(driver, (opened) => {
      const r = rig(opened, { highsec: { fallbackMs: 600000 } });
      r.concord.delay = { ok: false, reason: "SEAM_UNAVAILABLE" };
      r.rows([{ kind: "fame", cid: 105, systemId: HS5 }, { kind: "fame", cid: 106, systemId: HS5 }]);
      r.at(T0);
      assert.deepStrictEqual([r.c("revengeReady"), r.squads().length], [2, 1], "both ready, one squad");
      r.at(T0 + 1);
      assert.deepStrictEqual([r.squads().length, r.step.status().readyNow], [1, 1], "the mark stays (startStep)");
      r.at(T0 + r.P.revengeCheckEveryMs);
      assert.deepStrictEqual([r.c("highsecFull"), r.squads().length], [1, 1]);
      r.step.stop();
    });
  });

  if (!driver.ok) {
    skip("FH2/FH3 highsec squads on a store", `better-sqlite3 unavailable (${driver.detail})`);
  } else {
    test("FH2 CONCORD timer after the first attack, spawn off -> leave to the gate, finish CONCORD; fallback", () => {
      withStore(driver, (opened) => {
        const r = rig(opened);
        const t1 = engaged(r);
        r.at(t1 + 18999);
        assert.strictEqual(r.calls.warp.length, 0, "not yet");
        const phase = r.squads()[0].phase;
        r.at(t1 + 19000);
        assert.deepStrictEqual([r.c("concordNoSpawn"), r.calls.warp.length, r.calls.spawn.length], [1, 1, 0]);
        assert.deepStrictEqual(r.calls.warp[0].point, GATE);
        r.at(t1 + 19000 + 9999);
        assert.deepStrictEqual([r.squads().length, r.squads()[0].phase, r.calls.attack.length], [1, phase, 1],
          "LEAVE: no hunt decision");
        r.at(t1 + 19000 + 10000);
        assert.deepStrictEqual([r.squads().length, r.c("concordEnded"), r.c("revengeDone")], [0, 1, 1]);
        assert.deepStrictEqual([r.hooks[0].state, r.hooks[0].reason, r.hooks[0].engaged], ["DONE", "CONCORD", true]);
      });
      for (const answer of [{ ok: false, reason: "SEAM_UNAVAILABLE" }, { ok: true, ms: 0 }]) {
        withStore(driver, (opened) => {
          const r = rig(opened);
          r.concord.delay = answer;
          const t1 = engaged(r);
          r.at(t1 + 14999);
          assert.strictEqual(r.calls.warp.length, 0, JSON.stringify(answer));
          r.at(t1 + 15000);
          assert.strictEqual(r.calls.warp.length, 1, `fallback 15000 ${JSON.stringify(answer)}`);
          r.step.stop();
        });
      }
    });

    test("FH3 spawn on: one CONCORD spawn, <= 1 CONCORD attack per pass, leave after killMs, despawn both; refusal; "
      + "hunters dead", () => {
      withStore(driver, (opened) => {
        const r = rig(opened, { highsec: { spawnEnabled: true } });
        const t1 = engaged(r);
        const hunters = [...r.own.keys()];
        const a = t1 + 19000;
        r.at(a);
        assert.deepStrictEqual(r.calls.spawn, [{ systemId: HS5, targetIds: hunters, anchor: { ...POS } }]);
        const concordAttacks = () => r.calls.attack.filter((x) => x.ids.join() === CONCORD_IDS.join());
        assert.deepStrictEqual(concordAttacks().map((x) => x.targets), [hunters]);
        r.at(a + 1000);
        assert.deepStrictEqual([concordAttacks().length, r.calls.spawn.length, r.c("concordSpawned")], [2, 1, 1]);
        assert.strictEqual(r.squads()[0].ships, hunters.length, "ships = hunters only");
        r.at(a + 30000);
        assert.deepStrictEqual([concordAttacks().length, r.calls.warp.length], [2, 1], "LEAVE after killMs");
        r.at(a + 40000);
        assert.strictEqual(r.squads().length, 0);
        assert.deepStrictEqual(r.calls.despawn, [[...hunters, ...CONCORD_IDS]]);
        assert.deepStrictEqual([r.hooks[0].reason, r.hooks[0].bossKilled, r.c("concordEnded")], ["CONCORD", false, 1]);
      });
      withStore(driver, (opened) => {
        const r = rig(opened, { highsec: { spawnEnabled: true } });
        r.concord.spawnAnswer = { ok: false, reason: "SCENE_NOT_LOADED" };
        const t1 = engaged(r);
        r.at(t1 + 19000);
        assert.deepStrictEqual([r.c("concordSpawnRefused"), r.calls.warp.length, r.logs.filter((l) => l.includes(
          "CONCORD spawn")).length], [1, 1, 1]);
        r.step.stop();
      });
      withStore(driver, (opened) => {
        const r = rig(opened, { highsec: { spawnEnabled: true } });
        const t1 = engaged(r);
        r.at(t1 + 19000);
        r.own.clear();
        r.at(t1 + 20000);
        assert.deepStrictEqual([r.squads().length, r.c("concordEnded"), r.hooks[0].reason], [0, 1, "CONCORD"]);
      });
      withStore(driver, (opened) => {
        const r = rig(opened, { highsec: { spawnEnabled: true } });
        const t1 = engaged(r);
        r.sceneGone = true;
        r.at(t1 + 19000);
        assert.deepStrictEqual([r.squads().length, r.c("concordEnded"), r.calls.spawn.length, r.hooks.length,
          r.hooks[0] && r.hooks[0].reason, r.hooks[0] && r.hooks[0].state], [0, 0, 0, 1, "SCENE_GONE", "DONE"],
        JSON.stringify(r.counts));
      });
    });
  }

  test("FH4 vendor facts: response time, spawn group, autoAggro false, spawnGroupInSystem, broadcast, CONCORD friends, "
    + "ENTITY_TYPE; GAME_MODULES fameConcord; the methods of the real adapter", () => {
    const cw = readSource("services/security/crimewatchState.js");
    assert.match(cw, /^function getConcordResponseDelayMsForSystem\(system\) \{$/m);
    assert.match(cw, /^ {2}getConcordResponseDelayMsForSystem,$/m);
    const ec = readSource("space/entityConstants.js");
    assert.ok(ec.includes(`const CONCORD_RESPONSE_SPAWN_GROUP_ID = "${CR.SPAWN_GROUP_QUERY}";`));
    assert.ok(/const \{\s+CONCORD_RESPONSE_SPAWN_GROUP_ID,\s+ENTITY_TYPE,\s+\} = require\(path\.join\(__dirname, "\.\.\/\.\.\/space\/entityConstants"\)\);/
      .test(cw), "crimewatch takes the spawn group id from entityConstants");
    assert.ok(cw.includes("spawnGroupQuery: CONCORD_RESPONSE_SPAWN_GROUP_ID,"));
    assert.ok(cw.includes(`CONCORD_RESPONSE_WARP_ORIGIN_LOCAL_SPAWN_DISTANCE_METERS = 1_000;`)
      && cw.includes(`CONCORD_RESPONSE_WARP_ORIGIN_LOCAL_SPAWN_SPREAD_METERS = 12_000;`));
    assert.deepStrictEqual([CR.SPAWN_DISTANCE_METERS, CR.SPAWN_SPREAD_METERS], [1000, 12000]);
    const spawn = cw.slice(cw.indexOf("function spawnConcordResponders("));
    const body = spawn.slice(0, spawn.indexOf("\n}\n"));
    assert.ok(body.includes("autoAggro: false,") && body.includes("preferredTargetID: offenderEntity.itemID,")
      && body.includes("getNpcRuntime().spawnGroupInSystem(scene.systemID, {"), "spawnConcordResponders");
    const rt = readSource("space/npc/npcRuntime.js");
    assert.match(rt, /^function spawnGroupInSystem\(systemID, options = \{\}\) \{$/m);
    assert.match(rt, /^ {2}spawnGroupInSystem,$/m);
    assert.ok(readSource("space/npc/nativeNpcService.js").includes("if (scene && options.broadcast !== false) {"));
    assert.ok(readSource("space/npc/npcBehaviorLoop.js").includes("if (sourceClass === ENTITY_TYPE.CONCORD) {\n"
      + "    return targetClass === ENTITY_TYPE.CONCORD;"), "CONCORD is friendly only to CONCORD");
    assert.ok(ec.includes("  CONCORD: \"concord\",")
      && ec.includes("module.exports = { CONCORD_RESPONSE_SPAWN_GROUP_ID, ENTITY_TYPE };"));
    const has = (p, name) => GAME_MODULES.some((e) => e.path === p && e.symbols.some((s) => s.name === name
      && s.consumers.includes("fameConcord") && s.wrap !== true && s.firstLoad !== true));
    for (const [p, name] of [[CR.PATHS.crimewatch, "getConcordResponseDelayMsForSystem"],
      [CR.PATHS.npcRuntime, "spawnGroupInSystem"], [CR.PATHS.entityConstants, "ENTITY_TYPE"],
      [CR.PATHS.runtime, "isSolarSystemSceneLoaded"], [CR.PATHS.worldData, "getSolarSystemByID"]]) {
      assert.ok(has(p, name), `${p}.${name}`);
    }
    assert.ok(!config.MODULE_NAMES.includes("fameConcord"));
    const { createAdapter } = require("../../lib/adapter");
    const adapter = createAdapter({ moduleApi: { _cache: {} } });
    assert.deepStrictEqual([typeof adapter.concordResponseDelayMs, typeof adapter.spawnConcordAgainst],
      ["function", "function"]);
    assert.strictEqual(adapter.concordResponseDelayMs(30000001).ok, false, "server src unknown: refusal");
    assert.strictEqual(adapter.spawnConcordAgainst(30000001, [1], { ...POS }).ok, false);
  });

  test("FH5 concordResponse on a fake requireGame: spawn options, SPAWN_FAILED, throw, SCENE_NOT_LOADED, delay", () => {
    const seen = [];
    const spawns = [];
    const state = { loaded: true, answer: null, throwSpawn: false };
    const mods = {
      [CR.PATHS.crimewatch]: { getConcordResponseDelayMsForSystem: (sys) => {
        seen.push(sys);
        return 19000;
      } },
      [CR.PATHS.worldData]: { getSolarSystemByID: (id) => (id === 30000001 ? { solarSystemID: id, security: 0.5 }
        : null) },
      [CR.PATHS.npcRuntime]: { spawnGroupInSystem: (systemId, options) => {
        if (state.throwSpawn) throw new Error("boom");
        spawns.push({ systemId, options });
        return state.answer;
      } },
      [CR.PATHS.entityConstants]: { ENTITY_TYPE: { CONCORD: "concord" } },
      [CR.PATHS.runtime]: { isSolarSystemSceneLoaded: () => state.loaded },
    };
    const rg = (rel) => (mods[rel] ? { ok: true, exports: mods[rel] } : { ok: false, reason: "MODULE_NOT_FOUND" });
    assert.deepStrictEqual(CR.concordResponseDelayMsFrom(rg, 30000001), { ok: true, ms: 19000 });
    assert.deepStrictEqual(seen, [{ solarSystemID: 30000001, security: 0.5 }], "the system object");
    assert.strictEqual(CR.concordResponseDelayMsFrom(rg, 30000002).reason, "NO_SYSTEM");
    assert.strictEqual(CR.concordResponseDelayMsFrom(rg, 0).reason, "INVALID_INPUT");
    assert.strictEqual(CR.concordResponseDelayMsFrom(() => ({ ok: false }), 30000001).reason, "SEAM_UNAVAILABLE");

    state.answer = { success: true, data: { spawned: [{ entity: { itemID: 5 } }, { entity: { itemID: 6 } }] } };
    assert.deepStrictEqual(CR.spawnConcordAgainstFrom(rg, 30000001, [101, 102], { x: 1, y: 2, z: 3 }),
      { ok: true, entityIds: [5, 6] });
    assert.deepStrictEqual(spawns[0], { systemId: 30000001, options: { entityType: "concord",
      runtimeKind: "nativeCombat", spawnGroupQuery: "concord_crimewatch_response", anchorDescriptor: { kind: "coordinates",
        position: { x: 1, y: 2, z: 3 }, direction: { x: 1, y: 0, z: 0 }, name: CR.ANCHOR_NAME }, preferredTargetID: 101,
      behaviorOverrides: { autoAggro: false, autoActivateWeapons: true, returnToHomeWhenIdle: false, leashRangeMeters: 0,
        allowPodKill: false }, transient: true, spawnDistanceMeters: 1000, spreadMeters: 12000 } }, "no broadcast:false");
    state.answer = { success: true, data: { spawned: [{ entity: {} }] } };
    assert.strictEqual(CR.spawnConcordAgainstFrom(rg, 30000001, [101], POS).reason, "SPAWN_FAILED");
    state.answer = { success: false, errorMsg: "NO_GROUP" };
    assert.strictEqual(CR.spawnConcordAgainstFrom(rg, 30000001, [101], POS).reason, "SPAWN_FAILED");
    state.throwSpawn = true;
    assert.strictEqual(CR.spawnConcordAgainstFrom(rg, 30000001, [101], POS).ok, false, "a throw is a refusal");
    state.throwSpawn = false;
    state.loaded = false;
    const before = spawns.length;
    assert.strictEqual(CR.spawnConcordAgainstFrom(rg, 30000001, [101], POS).reason, "SCENE_NOT_LOADED");
    assert.strictEqual(spawns.length, before, "no spawn into an unloaded scene");
    assert.strictEqual(CR.spawnConcordAgainstFrom(rg, 30000001, [], POS).reason, "INVALID_INPUT");
    assert.strictEqual(CR.spawnConcordAgainstFrom(() => ({ ok: false }), 30000001, [101], POS).reason,
      "SEAM_UNAVAILABLE");
  });
};
