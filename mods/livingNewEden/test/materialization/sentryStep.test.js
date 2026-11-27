"use strict";

const assert = require("node:assert");

const { createSentryStep } = require("../../lib/materialization/sentryStep");
const combat = require("../../lib/adapter/sentryCombat");
const { GROUPS: STRENGTH_GROUPS } = require("../../lib/battle/data/strengthCatalog");
const { expandStrengthGroups } = require("../../lib/battle/strength");
const { capitalPowerOverlayOf } = require("../../lib/battle/data/capitalStrengthRows");

const SYS = 30002000;
const OTHER_SYS = 30002001;
const CHAR = 90000001;
const PIRATE = 500010;
const EMPIRE = 500001;
const SENTRY = 7001;
const ADOPTED = 7002;
const LIVE = Object.freeze({ maxEngagesPerPass: 32, maxStandingReadsPerPass: 32, proxyDpsPerShip: 0,
  proxyRangeM: 50000, maxProxyHitsPerPass: 16 });

const at = (x) => Object.freeze({ x, y: 0, z: 0 });
const ref = (sentryId, itemId, characterId) => Object.freeze({ sentryId, itemId, ownerKind: "player", factionId: null,
  characterId, typeId: 340501, systemId: SYS });

function fakeEnv(liveOver = {}, extraDeps = {}) {
  const env = { views: new Map(), positions: new Map(), reads: 0, groupsRead: 0, calls: [], groups: [],
    refs: new Map([[SYS, [ref("sp-7001", SENTRY, CHAR), ref("sa-7002", ADOPTED, null)]]]) };
  const seam = Object.freeze({
    readSentryScene(systemId, ids, lneIds) {
      env.reads += 1;
      const positions = new Map(lneIds.filter((id) => env.positions.has(id)).map((id) => [id, env.positions.get(id)]));
      return { ok: true, loaded: true, sentries: ids.map((id) => env.views.get(id)).filter(Boolean),
        players: [{ characterId: CHAR, entityId: 900, position: at(1000) }], positions };
    },
    engage: (systemId, itemId, targetId) => {
      env.calls.push(["engage", itemId, targetId]);
      return { ok: true, pending: false, alreadyActive: false };
    },
    release: (systemId, itemId, reason) => {
      env.calls.push(["release", itemId, reason]);
      return { ok: true, stopped: true };
    },
    applySentryDamage: (itemId, hp) => {
      env.calls.push(["damage", itemId, hp]);
      return { ok: true, destroyed: false, layer: "shield" };
    },
  });
  const sentries = Object.freeze({ getMode: () => "ready", listLiveInSystem: (id) => env.refs.get(id) || [],
    markEnded: (sentryId, reason) => {
      env.calls.push(["markEnded", sentryId, reason]);
      return { ok: true };
    }, isArmed: () => true });
  const standing = new Map([[`${CHAR}:${PIRATE}`, -6], [`${CHAR}:${EMPIRE}`, 0]]);
  env.step = createSentryStep({
    getSentries: () => sentries,
    getSeam: () => seam,
    readStanding: (c, f) => (standing.has(`${c}:${f}`) ? { ok: true, standing: standing.get(`${c}:${f}`) }
      : { ok: false, reason: "NO_ROW" }),
    getFactionKind: (f) => (f === PIRATE ? "pirate" : "empire"),
    thresholds: Object.freeze({ hostileMax: -5, friendlyMin: 5 }),
    neutralPolicy: Object.freeze({ pirate: "hostile", empire: "ignore" }),
    relationGroups: () => {
      env.groupsRead += 1;
      return env.groups;
    },
    settings: { ...LIVE, ...liveOver },
    pumpMs: 2000,
    ...extraDeps,
  });
  env.presence =(systems) => Object.freeze({ observedSystems: () => systems });
  return env;
}

const view = (itemId, over = {}) => ({ itemId, typeId: 340501, position: at(0), maxRangeM: 100000, targetId: null,
  active: false, alive: true, inScene: true, gone: false, ...over });

module.exports = ({ test }) => {
  test("STS1 sentry targeting: never a player, hostile yes, neutral no, keep the target, nearest after it is gone",
    () => {
      const env = fakeEnv();
      env.groups = [{ systemId: SYS, factionId: PIRATE, entityIds: [101, 102] },
        { systemId: SYS, factionId: EMPIRE, entityIds: [103] }];
      env.positions = new Map([[101, at(20000)], [102, at(10000)], [103, at(5000)]]);
      env.views.set(SENTRY, view(SENTRY));
      env.views.set(ADOPTED, view(ADOPTED));
      const out1 = {};
      env.step.step(1000, env.presence([SYS]), out1);
      env.views.set(SENTRY, view(SENTRY, { targetId: 102, active: true }));
      env.step.step(3000, env.presence([SYS]), {});
      const kept = env.calls.length;
      env.positions.delete(102);
      env.step.step(5000, env.presence([SYS]), {});
      assert.deepStrictEqual([env.calls, kept, out1.sentries], [
        [["engage", SENTRY, 102], ["release", SENTRY, "targetIneligible"], ["engage", SENTRY, 101]], 1,
        { systems: 1, engaged: 1, released: 0, proxyHits: 0, kills: 0 }]);
      assert.deepStrictEqual(env.step.stats().counters, { engaged: 2, released: 1, engageFailed: 0, proxyHits: 0,
        proxyDeferred: 0, proxyKills: 0, liveKills: 0, standingDeferred: 0, proxyCatalogShips: 0, proxyFlatShips: 0,
        engagedLne: 0, engagedRat: 0, engagedAggressor: 0, defendScanTruncated: 0, defendRefuseSkipped: 0,
        engagedPlayer: 0, defendPlayerDeferred: 0, defendPlayerReadFailed: 0 });
    });

  test("STS2 sentry damage cascade: shield / armor / hull / kill borders, one applyPosDamage, no scene -> no call",
    () => {
      const max = { shield: 25000, armor: 375000, hull: 100000 };
      const plans = [1, 25000, 25001, 400000, 400001, 499999, 500000].map((hp) => combat.damagePlan(max, null, hp));
      assert.deepStrictEqual(plans, [{ layer: "shield", amount: 1 }, { layer: "shield", amount: 25000 },
        { layer: "armor", amount: 1 }, { layer: "armor", amount: 375000 }, { layer: "hull", amount: 1 },
        { layer: "hull", amount: 99999 }, { layer: "kill", amount: null }]);
      assert.deepStrictEqual(combat.damagePlan(max, { shieldCharge: 0.5, armorDamage: 1, damage: 0 }, 12501),
        { layer: "hull", amount: 1 });
      const calls = [];
      let loaded = true;
      const item = Object.freeze({ itemID: SENTRY, typeID: 340501, locationID: SYS,
        spaceState: Object.freeze({ systemID: SYS }), conditionState: Object.freeze({ shieldCharge: 0.2 }) });
      const vendor = Object.freeze({
        itemStore: Object.freeze({ findItemById: (id) => (id === SENTRY ? item : null) }),
        gm: Object.freeze({ applyPosDamage: (...args) => {
          calls.push(args);
          return { success: true, data: { destroyed: args[1] === "kill" } };
        } }),
        defense: Object.freeze({ getBatteryProfile: () => ({ attributes: { 263: 25000, 265: 375000, 9: 100000 } }),
          hasUnavailableHealth: () => false, hydrateBatteryActor() {}, getBatterySession() {},
          getBatteryModuleView() {}, stopBattery() {}, isBatteryManuallyControlled() {},
          validateBatteryOperation: () => ({ success: true }) }),
        runtime: Object.freeze({ isSolarSystemSceneLoaded: () => loaded, scenes: new Map() }),
      });
      const hit = combat.applySentryDamageFrom(vendor, SENTRY, 6000);
      const kill = combat.applySentryDamageFrom(vendor, SENTRY, 480000);
      loaded = false;
      const cold = combat.applySentryDamageFrom(vendor, SENTRY, 10);
      assert.deepStrictEqual([hit, kill, cold, calls], [{ ok: true, destroyed: false, layer: "armor" },
        { ok: true, destroyed: true, layer: "kill" }, { ok: false, reason: "SENTRY_SCENE_NOT_LOADED" },
        [[SENTRY, "armor", 1000], [SENTRY, "kill"]]]);
    });

  test("STS3 sentry engage on a fake scene: vendor call order, pending lock, alreadyActive, no scene -> no read", () => {
    const log = [];
    const state = { pending: true, loaded: true, sceneReads: 0, online: true };
    const item = Object.freeze({ itemID: SENTRY, typeID: 340501, locationID: SYS });
    const entity = { itemID: SENTRY, kind: "starbase", activeModuleEffects: new Map() };
    const target = Object.freeze({ itemID: 101, kind: "ship" });
    const scene = Object.freeze({
      getEntityByID: (id) => (id === SENTRY ? entity : id === 101 ? target : null),
      validateTargetLockRequest: (s, src, tgt, opts) => {
        log.push(["validateTargetLockRequest", src.itemID, tgt.itemID, opts.ignoreCapacity]);
        return { success: true };
      },
      addTarget: (s, id) => {
        log.push(["addTarget", id]);
        return { success: true, data: { pending: state.pending } };
      },
      activateGenericModule: (s, module, effectName, opts) => {
        log.push(["activateGenericModule", module.itemID, effectName, opts.targetID, opts.repeat]);
        const effectState = { targetID: opts.targetID };
        entity.activeModuleEffects.set(SENTRY, effectState);
        return { success: true, data: { effectState } };
      },
    });
    const scenes = new Map([[SYS, scene]]);
    const getScene = scenes.get.bind(scenes);
    scenes.get = (id) => {
      state.sceneReads += 1;
      return getScene(id);
    };
    const vendor = Object.freeze({
      itemStore: Object.freeze({ findItemById: (id) => (id === SENTRY ? item : null) }),
      gm: Object.freeze({ applyPosDamage() {} }),
      defense: Object.freeze({
        getBatteryProfile: () => ({ passive: false, effectName: "projectileFired", attributes: { 76: 100000 } }),
        hasUnavailableHealth: () => false,
        validateBatteryOperation: (id) => {
          log.push(["validateBatteryOperation", id]);
          return state.online ? { success: true } : { success: false, errorMsg: "MODULE_NOT_ONLINE" };
        },
        isBatteryManuallyControlled: (e) => {
          log.push(["isBatteryManuallyControlled", e.itemID]);
          return false;
        },
        hydrateBatteryActor: (e, i) => {
          log.push(["hydrateBatteryActor", e.itemID, i.itemID]);
          return e;
        },
        getBatterySession: (sc, e) => {
          log.push(["getBatterySession", e.itemID]);
          return Object.freeze({ shipID: e.itemID });
        },
        getBatteryModuleView: (id) => Object.freeze({ itemID: id }),
        stopBattery: () => ({ success: true, data: { stopped: true } }),
      }),
      runtime: Object.freeze({ isSolarSystemSceneLoaded: (id) => state.loaded && id === SYS, scenes }),
    });
    const pending = combat.engageFrom(vendor, SYS, SENTRY, 101);
    const pendingLog = log.splice(0);
    state.pending = false;
    const fired = combat.engageFrom(vendor, SYS, SENTRY, 101);
    const firedLog = log.splice(0);
    const again = combat.engageFrom(vendor, SYS, SENTRY, 101);
    const againLog = log.splice(0).map((e) => e[0]);
    state.online = false;
    const offline = combat.engageFrom(vendor, SYS, SENTRY, 101);
    const offlineLog = log.splice(0).map((e) => e[0]);
    state.online = true;
    assert.deepStrictEqual([offline, offlineLog], [{ ok: false, reason: "MODULE_NOT_ONLINE" },
      ["validateBatteryOperation"]]);
    state.loaded = false;
    const reads = state.sceneReads;
    const cold = combat.engageFrom(vendor, SYS, SENTRY, 101);
    assert.deepStrictEqual([pending, pendingLog], [{ ok: true, pending: true, alreadyActive: false }, [
      ["validateBatteryOperation", SENTRY], ["isBatteryManuallyControlled", SENTRY], ["hydrateBatteryActor", SENTRY, SENTRY], ["getBatterySession", SENTRY],
      ["validateTargetLockRequest", SENTRY, 101, true], ["addTarget", 101]]]);
    assert.deepStrictEqual([fired, firedLog.slice(-2)], [{ ok: true, pending: false, alreadyActive: false },
      [["addTarget", 101], ["activateGenericModule", SENTRY, "projectileFired", 101, 9999999]]]);
    assert.deepStrictEqual([again, againLog.includes("addTarget"), entity.starbaseAutomaticTargetID,
      entity.activeModuleEffects.get(SENTRY).starbaseAutomatic], [{ ok: true, pending: false, alreadyActive: true },
      false, 101, true]);
    assert.deepStrictEqual([cold, state.sceneReads - reads], [{ ok: false, reason: "SENTRY_SCENE_NOT_LOADED" }, 0]);
  });

  test("STS5 faction sentry step: a hostile player and an enemy LNE ship are targets, a neutral player and an ally "
    + "ship are not; proxy fire only from enemy ships", () => {
    const OWN = 500020;
    const ALLY = 500004;
    const ENEMY_F = 500010;
    const calls = [];
    const state = { players: [{ characterId: CHAR, entityId: 900, position: at(10000) },
      { characterId: 90000002, entityId: 901, position: at(2000) }] };
    const positions = new Map([[201, at(30000)], [202, at(5000)]]);
    const fref = Object.freeze({ sentryId: "sf-a", itemId: SENTRY, ownerKind: "faction", factionId: OWN,
      characterId: null, typeId: 340501, systemId: SYS });
    const seam = Object.freeze({
      readSentryScene: (systemId, ids, lneIds) => ({ ok: true, loaded: true, sentries: [view(SENTRY,
        state.target ? { targetId: state.target, active: true } : {})], players: state.players,
      positions: new Map(lneIds.filter((id) => positions.has(id)).map((id) => [id, positions.get(id)])) }),
      engage: (systemId, itemId, targetId) => {
        calls.push(["engage", targetId]);
        return { ok: true };
      },
      release: (systemId, itemId, reason) => {
        calls.push(["release", reason]);
        return { ok: true, stopped: true };
      },
      applySentryDamage: (itemId, hp) => {
        calls.push(["damage", hp]);
        return { ok: true, destroyed: false };
      },
    });
    const standing = new Map([[`${CHAR}:${OWN}`, -6], [`90000002:${OWN}`, 0]]);
    const step = createSentryStep({
      getSentries: () => Object.freeze({ getMode: () => "ready", listLiveInSystem: () => [fref], markEnded: () => ({}),
        isArmed: () => true }),
      getSeam: () => seam,
      readStanding: (c, f) => (standing.has(`${c}:${f}`) ? { ok: true, standing: standing.get(`${c}:${f}`) }
        : { ok: false }),
      getFactionKind: () => "empire",
      isFactionEnemy: (f, o) => f === OWN && o === ENEMY_F,
      thresholds: Object.freeze({ hostileMax: -5, friendlyMin: 5 }),
      neutralPolicy: Object.freeze({ empire: "ignore" }),
      relationGroups: () => [{ systemId: SYS, factionId: ENEMY_F, entityIds: [201] },
        { systemId: SYS, factionId: ALLY, entityIds: [202] }],
      settings: { ...LIVE, proxyDpsPerShip: 10 },
      pumpMs: 2000,
    });
    const presence = Object.freeze({ observedSystems: () => [SYS] });
    step.step(1000, presence, {});
    state.target = 900;
    state.players = [];
    step.step(3000, presence, {});
    assert.deepStrictEqual(calls, [["engage", 900], ["damage", 20], ["release", "targetIneligible"], ["engage", 201],
      ["damage", 20]]);
  });

  test("STS4 sentry step: a system without sentries -> no readSentryScene and no LNE groups read", () => {
    const env = fakeEnv();
    env.groups = [{ systemId: OTHER_SYS, factionId: PIRATE, entityIds: [101] }];
    const out = {};
    env.step.step(1000, env.presence([OTHER_SYS]), out);
    env.step.step(3000, env.presence([]), out);
    assert.deepStrictEqual([env.reads, env.groupsRead, env.calls, out.sentries], [0, 0, [], undefined]);
  });

  test("AT5 (of): a sentry with its armour at 0 (incapacitated view) releases its target and "
    + "never engages; the proxy fire goes on into the hull; sentryViewOf reads armorDamage >= 1", () => {
    const env = fakeEnv({ proxyDpsPerShip: 100 });
    env.refs = new Map([[SYS, [ref("sp-7001", SENTRY, CHAR)]]]);
    env.groups = [{ systemId: SYS, factionId: PIRATE, entityIds: [101] }];
    env.positions = new Map([[101, at(10000)]]);
    env.views.set(SENTRY, view(SENTRY, { targetId: 101, active: true, incapacitated: true }));
    env.step.step(1000, env.presence([SYS]), {});
    const entity = { itemID: SENTRY, position: at(0) };
    const item = Object.freeze({ itemID: SENTRY, typeID: 340501, conditionState: Object.freeze({ armorDamage: 1 }) });
    const vendor = Object.freeze({ itemStore: Object.freeze({ findItemById: () => item }),
      defense: Object.freeze({ getBatteryProfile: () => null, hasUnavailableHealth: () => false }) });
    const scene = Object.freeze({ getEntityByID: () => entity });
    assert.deepStrictEqual([env.calls, combat.sentryViewOf(vendor, scene, SENTRY).incapacitated], [
      [["release", SENTRY, "incapacitated"], ["damage", SENTRY, 200]], true]);
  });

  test("FD-SV6: proxy fire of 2 cruisers + 1 frigate - flag off = 3 x flat "
    + "flag on = catalog dps per hull group, unknown hull = flat, proxyDpsPerShip 0 = no fire; engageAfter skips",
  () => {
    const groups = expandStrengthGroups(STRENGTH_GROUPS, null, capitalPowerOverlayOf(undefined));
    const run = (liveOver, hulls, group = {}) => {
      const env = fakeEnv({ proxyDpsPerShip: 100, ...liveOver }, { strengthGroups: groups });
      env.refs = new Map([[SYS, [ref("sp-7001", SENTRY, CHAR)]]]);
      env.groups = [{ systemId: SYS, factionId: PIRATE, entityIds: [101, 102, 103], hullGroups: hulls, ...group }];
      env.positions = new Map([[101, at(10000)], [102, at(11000)], [103, at(12000)]]);
      env.views.set(SENTRY, view(SENTRY, { incapacitated: true }));
      env.step.step(1000, env.presence([SYS]), {});
      return [env.calls.filter((c) => c[0] === "damage").map((c) => c[2]),
        env.step.stats().counters.proxyCatalogShips, env.step.stats().counters.proxyFlatShips];
    };
    const hulls = ["cruiser", "cruiser", "frigate"];
    const elapsed = 2000;
    const catalog = groups.cruiser.dps * 2 + groups.frigate.dps;
    assert.deepStrictEqual([groups.cruiser.dps, groups.frigate.dps], [115.5, 37.8]);
    assert.deepStrictEqual([
      run({}, hulls),
      run({ proxyDpsFromCatalog: true }, hulls),
      run({ proxyDpsFromCatalog: true }, ["cruiser", "nope", "frigate"]),
      run({ proxyDpsFromCatalog: true, proxyDpsPerShip: 0 }, hulls),
      run({ proxyDpsFromCatalog: true }, hulls, { engageAfter: 1001 }),
    ], [
      [[Math.round(3 * 100 * elapsed / 1000)], 0, 0],
      [[Math.round(catalog * elapsed / 1000)], 3, 0],
      [[Math.round((groups.cruiser.dps + 100 + groups.frigate.dps) * elapsed / 1000)], 2, 1],
      [[], 0, 0],
      [[], 0, 0],
    ]);
  });

  test("FD-SV7: proxySplitEnabled - each ship hits only its nearest hostile sentry (tie: "
    + "lower itemId), N sentries in range = the same total hp as 1; flag off = full dps on each; dps 0 = no fire; "
    + "catalog dps in split mode", () => {
    const groups = expandStrengthGroups(STRENGTH_GROUPS, null, capitalPowerOverlayOf(undefined));
    const S3 = 7003;
    const S4 = 7004;
    const run = (liveOver, sentryIds = [SENTRY, S3, S4], hulls = undefined) => {
      const env = fakeEnv({ proxyDpsPerShip: 100, ...liveOver }, { strengthGroups: groups });
      const xs = new Map([[SENTRY, 0], [S3, 20000], [S4, 40000]]);
      env.refs = new Map([[SYS, [...sentryIds].sort((a, b) => b - a).map((id) => ref(`sp-${id}`, id, CHAR))]]);
      for (const id of sentryIds) env.views.set(id, view(id, { position: at(xs.get(id)), incapacitated: true }));
      env.groups = [{ systemId: SYS, factionId: PIRATE, entityIds: [101, 102, 103],
        ...(hulls ? { hullGroups: hulls } : {}) }];
      env.positions = new Map([[101, at(1000)], [102, at(19000)], [103, at(30000)]]);
      env.step.step(1000, env.presence([SYS]), {});
      return env.calls.filter((c) => c[0] === "damage").map((c) => [c[1], c[2]]).sort((a, b) => a[0] - b[0]);
    };
    const ship = Math.round(100 * 2000 / 1000);
    const total = (calls) => calls.reduce((s, c) => s + c[1], 0);
    const on = run({ proxySplitEnabled: true });
    assert.deepStrictEqual(on, [[SENTRY, ship], [S3, 2 * ship]]);
    assert.deepStrictEqual(run({ proxySplitEnabled: true }, [SENTRY]), [[SENTRY, 3 * ship]]);
    assert.strictEqual(total(on), total(run({ proxySplitEnabled: true }, [SENTRY])));
    assert.deepStrictEqual(run({}), [[SENTRY, 3 * ship], [S3, 3 * ship], [S4, 3 * ship]]);
    assert.deepStrictEqual(run({ proxySplitEnabled: true, proxyDpsPerShip: 0 }), []);
    assert.deepStrictEqual(run({ proxySplitEnabled: true, proxyDpsFromCatalog: true }, undefined,
      ["cruiser", "cruiser", "frigate"]), [[SENTRY, Math.round(groups.cruiser.dps * 2)],
      [S3, Math.round((groups.cruiser.dps + groups.frigate.dps) * 2)]]);
  });
};
