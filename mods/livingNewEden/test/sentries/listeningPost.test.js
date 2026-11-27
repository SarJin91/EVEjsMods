"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const config = require("../../config");
const { createJournal } = require("../../lib/persistence/journal");
const { startScheduler } = require("../../lib/scheduler");
const { findServerSrcOnDisk } = require("../../lib/adapter/locator");
const seams = require("../../lib/adapter/sentrySeams");
const combat = require("../../lib/adapter/sentryCombat");
const T = require("../../lib/adapter/data/sentryTypes");
const { startSentries, createUnavailableSentries, FACADE_METHODS } = require("../../lib/sentries");
const { createSentryService } = require("../../lib/sentries/service");
const { createSentryStep } = require("../../lib/materialization/sentryStep");
const { startPlayerValue } = require("../../lib/world/playerValue");
const { VALUE_KINDS } = require("../../lib/world/playerValue/rules");
const { huntThresholds } = require("../../lib/playerHunt/policy");
const S = require("../../lib/sentries/schema");
const { GROUPS: STRENGTH_GROUPS } = require("../../lib/battle/data/strengthCatalog");
const { expandStrengthGroups } = require("../../lib/battle/strength");
const { capitalPowerOverlayOf } = require("../../lib/battle/data/capitalStrengthRows");
const { harness: H } = require("../battle/settlement.test");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const DEFAULTS = config.resolveConfig({ modDir: MOD_DIR, env: {} }).config;
const GROUPS = expandStrengthGroups(STRENGTH_GROUPS, null, capitalPowerOverlayOf(undefined));
const SYS = 30002000;
const CORP = 98000001;
const CHAR = 90000001;
const GATE = 50000001;
const POST = 340520;
const GUN = 340501;
const ENEMY = 500010;
const SESSION = Object.freeze({ characterID: CHAR, _space: Object.freeze({ systemID: SYS, shipID: 1 }) });

function item(itemID, typeID, spaceState) {
  return Object.freeze({ itemID, typeID, ownerID: CORP, locationID: SYS, flagID: 0, categoryID: 23,
    groupID: typeID === POST ? 709 : 449, spaceState: Object.freeze({ systemID: SYS, ...spaceState }) });
}

module.exports = ({ test, skip }) => {
  test("LPK1 sentry kinds: kindOfType per catalog type, unknown = null; faction types and ammo never the post", () => {
    assert.deepStrictEqual([...T.SENTRY_KINDS], ["sentry", "heavy_sentry", "listening_post"]);
    assert.deepStrictEqual([340500, 340501, 340502, 340503, POST, 340521, 16216, 0, "x"].map((id) => T.kindOfType(id)),
      ["sentry", "sentry", "sentry", "sentry", "listening_post", null, null, null, null]);
    assert.ok(T.SENTRY_TYPES.every((t) => T.SENTRY_KINDS.includes(t.kind)), "every entry has a kind");
    const post = T.sentryTypeOf(POST);
    assert.deepStrictEqual([post.family, post.passive, T.isSentryTypeId(POST), T.defaultAmmoOfType(POST)],
      [null, true, true, null]);
    for (const factionId of [...Object.keys(T.FACTION_FAMILY).map(Number), 99999999]) {
      assert.strictEqual(T.kindOfType(T.sentryTypeOfFaction(factionId)), "sentry", String(factionId));
    }
    assert.deepStrictEqual(T.WEAPON_TYPES.map((t) => t.typeId), [340500, 340501, 340502, 340503]);
  });

  test("LPK2 readSentryCombat passive: dps 0 + signature (catalog / profile 552); weapon unchanged; post HP 200000",
    () => {
      const profiles = new Map([[GUN, { attributes: { 64: 18, 51: 6380, 552: 6000, 620: 125, 263: 1, 265: 1, 9: 1 } }]]);
      const vendor = { defense: { getBatteryProfile: (t) => profiles.get(Number(t && t.typeID ? t.typeID : t)) || null } };
      assert.deepStrictEqual(combat.readSentryCombatFrom(vendor, POST),
        { ok: true, dps: 0, signature: 2000, designSig: null, passive: true });
      profiles.set(POST, { attributes: { 552: 2500 } });
      assert.strictEqual(combat.readSentryCombatFrom(vendor, POST).signature, 2500);
      profiles.delete(POST);
      const gun = combat.readSentryCombatFrom(vendor, GUN);
      assert.ok(Math.abs(gun.dps - 67.7) < 0.05 && gun.passive === undefined, JSON.stringify(gun));
      assert.deepStrictEqual([gun.signature, gun.designSig], [6000, 125]);
      const fresh = item(1, POST, {});
      assert.deepStrictEqual(combat.hpLeftOf(vendor, fresh), { left: 200000, max: 200000 });
      assert.deepStrictEqual(combat.hpLeftOf(vendor, { ...fresh, conditionState: { shieldCharge: 0, armorDamage: 0.5 } }),
        { left: 100000, max: 200000 });
      assert.strictEqual(combat.hpLeftOf(vendor, item(2, 16216, {})), null, "no catalog type, no profile");
    });

  test("LPK3 ctx.sentries kindOf / listLiveOfKind: stub = FACADE_METHODS, no type = sentry; K2 value with the real "
    + "kindOf", () => {
    const stub = createUnavailableSentries("disabled_by_config");
    assert.deepStrictEqual(Object.keys(stub).sort(), [...FACADE_METHODS].sort());
    assert.deepStrictEqual([stub.kindOf({ typeId: POST }), stub.kindOf({ typeId: GUN }), stub.kindOf({}),
      stub.kindOf(null), stub.listLiveOfKind("listening_post"), stub.ownerOnlineOf({ typeId: POST })],
    ["listening_post", "sentry", "sentry", "sentry", [], false]);
    const weight = Object.fromEntries(VALUE_KINDS.map((k) => [k, DEFAULTS.playerValue.weight[k]]));
    const refs = [{ sentryId: "sp-1", ownerKind: "player", typeId: POST }, { sentryId: "sp-2", ownerKind: "player",
      typeId: GUN }, { sentryId: "sp-3", ownerKind: "player", typeId: 999 }];
    const sentries = { listLiveInSystem: (id) => (id === SYS ? refs : []), kindOf: stub.kindOf };
    const adapter = { playerStructures: { listCandidates: (o) => ({ ok: true, truncated: false, total: 0,
      builtAt: o.nowMs, bySystem: new Map() }) },
    playerSkyhooks: { listPlayerSkyhooks: () => ({ ok: true, truncated: false, skyhooks: [] }) } };
    const r = startPlayerValue({ config: { playerValue: { ...DEFAULTS.playerValue, enabled: true, weight,
      unclaimedPermille: 1000 } }, adapter, getSentries: () => sentries });
    assert.ok(r.ok, JSON.stringify(r));
    assert.deepStrictEqual(r.playerValue.valueOf(SYS, 1760000000000),
      { value: weight.listeningPost + 2 * weight.sentry, capped: false });
    assert.strictEqual(r.playerValue.getStatus().counters.unknownKind, 0);
  });

  test("LPV1 vendor fact: hydrateBatteryActor returns the entity early without a battery profile (profile.passive)",
    () => {
      const found = findServerSrcOnDisk(MOD_DIR, 5, fs.existsSync);
      assert.ok(found.ok, "EveJS server/src not found above the mod");
      const def = fs.readFileSync(path.join(found.srcDir, "services/starbase/starbaseDefenseRuntime.js"), "utf8")
        .replace(/\r\n/g, "\n");
      assert.ok(def.includes("function hydrateBatteryActor(entity, item) {\n  const profile = getBatteryProfile(item);\n"
        + "  if (!entity || !profile || profile.passive) return entity;"), "hydrateBatteryActor early return");
      assert.ok(/const BATTERY_GROUPS = Object\.freeze\(\{[^}]*\}\);/u.test(def) && !/\b709:/u.test(def), "no group 709");
    });

  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  function rig(opened, over) {
    const shared = H.sharedOf();
    const clock = shared.clock;
    const cfg = { ...H.CONFIG, modules: { ...H.CONFIG.modules, strategy: { enabled: true } },
      sentries: { ...DEFAULTS.sentries, enabled: true, player: { ...DEFAULTS.sentries.player, ...over.player } },
      listeningPost: { ...DEFAULTS.listeningPost, ...over.listeningPost } };
    const journal = createJournal({ clock, maxPayloadBytes: 16384, maxRows: 500 });
    const sr = startScheduler({ config: cfg, persistence: { ok: true, store: opened.store }, clock, ids: shared.ids,
      nowMs: () => 0 });
    assert.ok(sr.ok, JSON.stringify(sr));
    const items = new Map();
    const world = { sec: "lowsec" };
    const put = (id, typeId, x) => items.set(id, item(id, typeId, { position: { x, y: 0, z: 0 },
      anchorState: "unanchored", onlineState: "offline", online: 0 }));
    const modules = {
      "services/inventory/itemStore": { findItemById: (id) => items.get(id) || null,
        listStarbaseItems: (q) => [...items.values()].filter((i) => (q.systemID ? i.spaceState.systemID === q.systemID
          : i.typeID === q.typeID)) },
      "space/worldData": { getStargatesForSystem: () => [{ itemID: GATE, position: { x: 0, y: 0, z: 0 },
        radius: 5000 }], getStationsForSystem: () => [] },
      "services/structure/structureState": { peekStructures: () => [] },
      "services/starbase/posGmState": { forcePosOnlineState: (id) => {
        const cur = items.get(id);
        items.set(id, item(id, cur.typeID, { ...cur.spaceState, anchorState: "anchored", onlineState: "online",
          online: 1 }));
        return { success: true };
      } },
      "space/runtime": { isSolarSystemSceneLoaded: () => true },
      "services/starbase/starbaseDefenseRuntime": { hasUnavailableHealth: () => false },
      "services/starbase/starbaseAnchoringPolicy": { validateCorporationAuthority: () => ({ success: true }) },
      "services/corporation/corporationState": { isNpcCorporationID: (id) => id < 2000000 },
    };
    const seam = seams.createSentrySeam({ requireGame: (rel) => ({ ok: true, exports: modules[rel] }) });
    let policy = null;
    const adapter = { sentrySeams: () => ({ ok: true, seam, optional: {} }),
      bindSentryPolicy: (p) => {
        policy = p;
        return { ok: true };
      } };
    const started = startSentries({ config: cfg, persistence: { ok: true, store: opened.store, journal }, clock,
      scheduler: sr.scheduler, adapter,
      graph: { getGraph: () => ({ ok: true, graph: { getSystem: (id) => ({ systemId: id, secClass: world.sec }) } }) } });
    assert.ok(started.ok, JSON.stringify(started));
    const anchor = (itemId) => policy.anchor({ session: SESSION, itemId });
    return { put, world, anchor, sentries: started.sentries, service: started.service };
  }

  needsDriver("LPA1 anchor of a listening post: off -> KIND_DISABLED; highsec with allowHighsec -> KIND_SEC (a gun "
    + "passes); 2nd post of the corporation -> SENTRY_LIMIT, a gun next to it passes; kinds in the index",
  () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    const off = rig(opened, { player: {}, listeningPost: { enabled: false } });
    off.put(7001, POST, 15000);
    assert.deepStrictEqual(off.anchor(7001), { ok: false, reason: "SENTRY_KIND_DISABLED" });
    assert.strictEqual(off.service.getStatus().counters.kindRefused, 1);
    off.sentries.stop("test");

    const env = rig(opened, { player: { allowHighsec: true, maxPerSystemPerOwner: 1 },
      listeningPost: { enabled: true } });
    env.world.sec = "highsec";
    env.put(7101, POST, 15000);
    env.put(7102, GUN, 18000);
    assert.deepStrictEqual([env.anchor(7101), env.anchor(7102).ok], [{ ok: false, reason: "SENTRY_KIND_SEC" }, true]);
    env.world.sec = "lowsec";
    env.put(7103, POST, 21000);
    env.put(7104, POST, 24000);
    env.put(7105, GUN, 27000);
    assert.deepStrictEqual([env.anchor(7103), env.anchor(7104), env.anchor(7105)], [
      { ok: true, sentryId: "sp-7103", duplicate: false }, { ok: false, reason: "SENTRY_LIMIT" },
      { ok: false, reason: "SENTRY_LIMIT" }]);
    assert.deepStrictEqual([env.sentries.listLiveOfKind("listening_post").map((r) => [r.sentryId, r.kind,
      r.ownerCorpId]), env.sentries.listLiveOfKind("sentry").map((r) => r.sentryId), env.sentries.listLiveOfKind("x"),
    env.sentries.kindOf(env.sentries.listLiveInSystem(SYS)[0])],
    [[["sp-7103", "listening_post", CORP]], ["sp-7102"], [], "sentry"]);
    assert.deepStrictEqual(Object.keys(env.sentries).sort(), [...FACADE_METHODS].sort());
    env.sentries.stop("test");
  }));

  needsDriver("LPB1 battle round: a post of an offline owner left out (postOwnerOffline), online -> entry dps 0 without "
    + "an ammo read; weapons only = the entries of before, no owner read", () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    const { clock } = H.sharedOf();
    const journal = createJournal({ clock, maxPayloadBytes: 16384, maxRows: 500 });
    const gun = { sentryId: "sf-1", itemId: 7001, typeId: GUN, ownerKind: "faction", factionId: 500020,
      ownerCorpId: 1000125, characterId: null, systemId: SYS, state: S.ACTIVE, armedAt: 0 };
    const post = { sentryId: "sp-7009", itemId: 7009, typeId: POST, ownerKind: "player", factionId: null,
      ownerCorpId: CORP, characterId: CHAR, systemId: SYS, state: S.ACTIVE, armedAt: 0 };
    const rows = [gun, post];
    const ammoReads = [];
    const seam = { readSentryItem: (id) => ({ ok: true, item: { hp: id === 7009 ? 200000 : 500000, destroyed: false,
      incapacitated: false } }),
    readSentryCombat: (typeId) => (typeId === POST ? { ok: true, dps: 0, signature: 2000, designSig: null, passive: true }
      : { ok: true, dps: 67.7, signature: 6000, designSig: 125 }),
    readAmmo: (id) => {
      ammoReads.push(id);
      return { ok: true, units: 50, capacityUnits: 100 };
    } };
    const calls = [];
    const facade = { getStatus: () => ({ state: "ready" }), createFixedDefenseBattleInTx(tx, spec, key) {
      calls.push({ spec, key });
      return { ok: true, duplicate: false, battleId: `b-${calls.length}` };
    } };
    const owner = { online: false, reads: 0, throws: false };
    const cfg = { ...DEFAULTS, sentries: { ...DEFAULTS.sentries, enabled: true,
      battle: { ...DEFAULTS.sentries.battle, enabled: true } } };
    const fleet = { fleetId: "f-1", factionId: ENEMY, version: 3, fleetRole: "patrol", state: "IDLE", shipCount: 10,
      currentSystemId: SYS, composition: [{ hullGroup: "frigate", count: 10 }] };
    const make = (list) => createSentryService({ store: opened.store, config: cfg, clock, seam, journal,
      repository: { listActive: () => ({ ok: true, sentries: list, truncated: false }) },
      scheduler: { enqueue: () => ({ ok: true }) },
      fleetRepository: { listFleetsInSystem: () => ({ ok: true, nextAfterFleetId: null, fleets: [fleet] }) },
      getPresence: () => ({ distanceToObserved: () => ({ ok: true, distance: null }) }), groups: GROUPS,
      hostility: { isFactionEnemy: (f, g) => g === ENEMY, readStanding: () => ({ ok: true, standing: -10 }),
        getFactionKind: () => "pirate", thresholds: huntThresholds(DEFAULTS.playerHunt),
        neutralPolicy: { pirate: "hostile" } },
      getBattle: () => facade,
      getOwnerOnline: () => ({ ownerOnline: (corpId) => {
        owner.reads += 1;
        if (owner.throws) throw new Error("presence down");
        return { online: corpId === CORP && owner.online, reason: null };
      } }) });
    let service = make(rows);
    assert.ok(service.rebuildArmed().ok);
    const R = cfg.sentries.battle.roundMs;
    const base = Math.floor(clock.now() / R) + 1;
    const round = (k) => {
      const r = service.onAttrition({ payload: { systemId: SYS, round: base + k }, dueAt: (base + k) * R },
        { anchorAt: (base + k) * R });
      assert.strictEqual(r.outcome, "BATTLE", JSON.stringify(r));
      const tx = opened.store.transaction("test", (db) => r.effect(db));
      assert.ok(tx.ok, JSON.stringify(tx));
      r.onCommitted(tx.value);
      return calls[calls.length - 1].spec.fixedDefenses.entries.map((e) => [e.sentryId, e.dps, e.signature]);
    };
    assert.deepStrictEqual([round(0), owner.reads, service.getStatus().counters.postOwnerOffline],
      [[["sf-1", 67.7, 6000]], 1, 1]);
    owner.online = true;
    assert.deepStrictEqual([round(1), service.getStatus().counters.postOwnerOffline, ammoReads.includes(7009)],
      [[["sf-1", 67.7, 6000], ["sp-7009", 0, 2000]], 1, false]);
    owner.throws = true;
    assert.deepStrictEqual([round(2), service.ownerOnlineOf(post), service.ownerOnlineOf(gun)],
      [[["sf-1", 67.7, 6000]], false, true]);
    service.stop();
    service = make([gun]);
    assert.ok(service.rebuildArmed().ok);
    const readsBefore = owner.reads;
    assert.deepStrictEqual([round(3), owner.reads - readsBefore, service.getStatus().counters.postOwnerOffline],
      [[["sf-1", 67.7, 6000]], 0, 0]);
    service.stop();
  }));

  test("LPS1 LIVE step: a post never engages; proxy fire on it only with the owner online; the gun as before", () => {
    const at = (x) => Object.freeze({ x, y: 0, z: 0 });
    const refs = [{ sentryId: "sp-7001", itemId: 7001, ownerKind: "player", factionId: null, characterId: CHAR,
      ownerCorpId: CORP, typeId: GUN, systemId: SYS }, { sentryId: "sp-7009", itemId: 7009, ownerKind: "player",
      factionId: null, characterId: CHAR, ownerCorpId: CORP, typeId: POST, systemId: SYS }];
    const calls = [];
    let online = false;
    const view = (itemId) => ({ itemId, position: at(0), maxRangeM: 100000, targetId: null, active: false, alive: true,
      inScene: true, gone: false });
    const seam = { readSentryScene: (systemId, ids, lneIds) => ({ ok: true, loaded: true, sentries: ids.map(view),
      players: [], positions: new Map(lneIds.map((id) => [id, at(5000)])) }),
    engage: (s, itemId, target) => {
      calls.push(["engage", itemId, target]);
      return { ok: true };
    },
    release: (s, itemId) => {
      calls.push(["release", itemId]);
      return { ok: true };
    },
    applySentryDamage: (itemId, hp) => {
      calls.push(["damage", itemId, hp]);
      return { ok: true, destroyed: false };
    } };
    const sentries = { getMode: () => "ready", listLiveInSystem: () => refs, isArmed: () => true,
      markEnded: () => ({ ok: true }), kindOf: createUnavailableSentries("x").kindOf,
      ownerOnlineOf: (ref) => ref.ownerCorpId === CORP && online };
    const step = createSentryStep({ getSentries: () => sentries, getSeam: () => seam,
      readStanding: () => ({ ok: true, standing: -10 }), getFactionKind: () => "pirate",
      thresholds: { hostileMax: -5, friendlyMin: 5 }, neutralPolicy: { pirate: "hostile" },
      relationGroups: () => [{ systemId: SYS, factionId: ENEMY, entityIds: [101] }],
      settings: { maxEngagesPerPass: 8, maxStandingReadsPerPass: 8, proxyDpsPerShip: 10, proxyRangeM: 50000,
        maxProxyHitsPerPass: 8 }, pumpMs: 2000 });
    const presence = { observedSystems: () => [SYS] };
    step.step(2000, presence, {});
    online = true;
    step.step(4000, presence, {});
    assert.deepStrictEqual(calls, [["engage", 7001, 101], ["damage", 7001, 20], ["engage", 7001, 101],
      ["damage", 7001, 20], ["damage", 7009, 20]]);
  });
};
