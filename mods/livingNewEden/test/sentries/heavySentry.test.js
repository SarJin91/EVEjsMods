"use strict";

const assert = require("node:assert");
const path = require("node:path");

const config = require("../../config");
const { createJournal } = require("../../lib/persistence/journal");
const { startScheduler } = require("../../lib/scheduler");
const seams = require("../../lib/adapter/sentrySeams");
const combat = require("../../lib/adapter/sentryCombat");
const T = require("../../lib/adapter/data/sentryTypes");
const { startSentries } = require("../../lib/sentries");
const { createSentryService } = require("../../lib/sentries/service");
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
const CORP2 = 98000002;
const CORP3 = 98000003;
const CHAR = 90000001;
const GATE = 50000001;
const POST = 340520;
const GUN = 340501;
const HEAVY = 340522;
const ENEMY = 500010;
const SESSION = Object.freeze({ characterID: CHAR, _space: Object.freeze({ systemID: SYS, shipID: 1 }) });
const near = (a, b) => Math.abs(a - b) < 0.01;

function item(itemID, typeID, ownerID, spaceState) {
  return Object.freeze({ itemID, typeID, ownerID, locationID: SYS, flagID: 0, categoryID: 23,
    groupID: typeID === POST ? 709 : 449, spaceState: Object.freeze({ systemID: SYS, ...spaceState }) });
}

module.exports = ({ test, skip }) => {
  test("HSK1 heavy kinds: 340522-340525 heavy_sentry; faction types never heavy; default ammo of a heavy = XL ref", () => {
    assert.deepStrictEqual([340522, 340523, 340524, 340525, 340526].map((id) => T.kindOfType(id)),
      ["heavy_sentry", "heavy_sentry", "heavy_sentry", "heavy_sentry", null]);
    assert.deepStrictEqual(T.WEAPON_TYPES.map((t) => t.typeId), [340500, 340501, 340502, 340503]);
    for (const factionId of [...Object.keys(T.FACTION_FAMILY).map(Number), 99999999]) {
      const typeId = T.sentryTypeOfFaction(factionId);
      assert.strictEqual(T.kindOfType(typeId), "sentry", String(factionId));
      assert.strictEqual(T.defaultAmmoOfType(typeId), T.DEFAULT_AMMO[T.familyOfFaction(factionId)]);
    }
    assert.deepStrictEqual([340522, 340523, 340524, 340525].map((id) => T.defaultAmmoOfType(id)),
      [{ typeId: 17668, damage: 96 }, { typeId: 17648, damage: 96 }, { typeId: 17686, damage: 96 },
        { typeId: 17859, damage: 5885 }]);
    assert.ok([340522, 340523, 340524, 340525].every((id) => T.isSentryTypeId(id)), "sentry path (wraps)");
  });

  test("HSK2 readSentryCombat heavy: DPS from ammo.damage (271 / 268 / 284 / 613); a small type unchanged", () => {
    const profiles = new Map([
      [340522, { attributes: { 64: 81, 51: 28690, 552: 18000, 620: 1000 } }],
      [340523, { attributes: { 64: 40, 51: 14350, 552: 18000, 620: 1000 } }],
      [340524, { attributes: { 64: 40, 51: 13500, 552: 18000, 620: 1000 } }],
      [340525, { attributes: { 212: 2.5, 506: 24000, 552: 18000 } }],
      [GUN, { attributes: { 64: 18, 51: 6380, 552: 6000, 620: 125 } }]]);
    const vendor = { defense: { getBatteryProfile: (t) => profiles.get(Number(t)) || null } };
    const dps = [340522, 340523, 340524, 340525, GUN].map((id) => combat.readSentryCombatFrom(vendor, id));
    assert.ok(dps.every((r) => r.ok === true), JSON.stringify(dps));
    const expected = [81 * 96 / 28.69, 40 * 96 / 14.35, 40 * 96 / 13.5, 2.5 * 5885 / 24, 18 * 24 / 6.38];
    assert.ok(dps.every((r, i) => near(r.dps, expected[i])), JSON.stringify(dps.map((r) => r.dps)));
    assert.ok(near(dps[0].dps, 271.04) && near(dps[3].dps, 613.02) && near(dps[4].dps, 67.71));
    assert.deepStrictEqual(dps.map((r) => [r.signature, r.designSig]),
      [[18000, 1000], [18000, 1000], [18000, 1000], [18000, null], [6000, 125]]);
  });

  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  function rig(opened, over) {
    const shared = H.sharedOf();
    const clock = shared.clock;
    const se = DEFAULTS.sentries;
    const cfg = { ...H.CONFIG, modules: { ...H.CONFIG.modules, strategy: { enabled: true } },
      sentries: { ...se, enabled: true, maxPerAnchor: 16, player: { ...se.player, ...over.player },
        heavy: { ...se.heavy, ...over.heavy } },
      listeningPost: { ...DEFAULTS.listeningPost, enabled: true } };
    const journal = createJournal({ clock, maxPayloadBytes: 16384, maxRows: 500 });
    const sr = startScheduler({ config: cfg, persistence: { ok: true, store: opened.store }, clock, ids: shared.ids,
      nowMs: () => 0 });
    assert.ok(sr.ok, JSON.stringify(sr));
    const items = new Map();
    const world = { sec: "lowsec" };
    const put = (id, typeId, x, owner = CORP) => items.set(id, item(id, typeId, owner, { position: { x, y: 0, z: 0 },
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
        items.set(id, item(id, cur.typeID, cur.ownerID, { ...cur.spaceState, anchorState: "anchored",
          onlineState: "online", online: 1 }));
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

  needsDriver("HSA1 anchor of a heavy sentry: off -> KIND_DISABLED; highsec -> KIND_SEC; limits per kind (: a "
    + "post / small gun never count for the gun / heavy limit); 2 heavy in the system -> 3rd SENTRY_LIMIT, a gun passes",
  () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    const off = rig(opened, { player: {}, heavy: { enabled: false } });
    off.put(8000, HEAVY, 12000);
    assert.deepStrictEqual(off.anchor(8000), { ok: false, reason: "SENTRY_KIND_DISABLED" });
    assert.strictEqual(off.service.getStatus().counters.kindRefused, 1);
    off.sentries.stop("test");

    const env = rig(opened, { player: { allowHighsec: true, maxPerSystemPerOwner: 1 }, heavy: { enabled: true } });
    assert.deepStrictEqual([DEFAULTS.sentries.heavy.maxPerSystem, DEFAULTS.sentries.heavy.maxPerSystemPerOwner],
      [2, 1], "expected defaults");
    env.world.sec = "highsec";
    env.put(8010, HEAVY, 12000);
    assert.deepStrictEqual(env.anchor(8010), { ok: false, reason: "SENTRY_KIND_SEC" });
    env.world.sec = "lowsec";
    env.put(8001, POST, 12000);
    env.put(8002, GUN, 15000);
    env.put(8003, HEAVY, 18000);
    env.put(8004, HEAVY, 21000);
    env.put(8005, HEAVY, 24000, CORP2);
    env.put(8006, HEAVY, 27000, CORP3);
    env.put(8007, GUN, 30000, CORP2);
    const res = (id) => {
      const r = env.anchor(id);
      return r.ok ? r.sentryId : r.reason;
    };
    assert.deepStrictEqual([res(8001), res(8002), res(8003)], ["sp-8001", "sp-8002", "sp-8003"]);
    assert.deepStrictEqual([res(8004), res(8005), res(8006), res(8007)],
      ["SENTRY_LIMIT", "sp-8005", "SENTRY_LIMIT", "sp-8007"]);
    assert.deepStrictEqual([env.sentries.listLiveOfKind("heavy_sentry").map((r) => r.sentryId),
      env.service.getStatus().counters.heavyAnchored], [["sp-8003", "sp-8005"], 2]);
    env.sentries.stop("test");
  }));

  needsDriver("HSB1 battle round: heavy dps = profile x battle.dpsPermille x heavy.battleDpsPermille, ammo read with "
    + "its XL type; the small gun unchanged", () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    const { clock } = H.sharedOf();
    const journal = createJournal({ clock, maxPayloadBytes: 16384, maxRows: 500 });
    const gun = { sentryId: "sf-1", itemId: 7001, typeId: GUN, ownerKind: "faction", factionId: 500020,
      ownerCorpId: 1000125, characterId: null, systemId: SYS, state: S.ACTIVE, armedAt: 0 };
    const heavy = { sentryId: "sp-7010", itemId: 7010, typeId: HEAVY, ownerKind: "player", factionId: null,
      ownerCorpId: CORP, characterId: CHAR, systemId: SYS, state: S.ACTIVE, armedAt: 0 };
    const ammoReads = [];
    const seam = { readSentryItem: (id) => ({ ok: true, item: { hp: id === 7010 ? 1700000 : 500000, destroyed: false,
      incapacitated: false } }),
    readSentryCombat: (typeId) => (typeId === HEAVY ? { ok: true, dps: 270, signature: 18000, designSig: 1000 }
      : { ok: true, dps: 67.7, signature: 6000, designSig: 125 }),
    readAmmo: (id, typeId) => {
      ammoReads.push([id, typeId]);
      return { ok: true, units: 50, capacityUnits: 100 };
    } };
    const calls = [];
    const facade = { getStatus: () => ({ state: "ready" }), createFixedDefenseBattleInTx(tx, spec, key) {
      calls.push({ spec, key });
      return { ok: true, duplicate: false, battleId: `b-${calls.length}` };
    } };
    const cfg = { ...DEFAULTS, sentries: { ...DEFAULTS.sentries, enabled: true,
      battle: { ...DEFAULTS.sentries.battle, enabled: true, dpsPermille: 2000 },
      heavy: { ...DEFAULTS.sentries.heavy, battleDpsPermille: 500 } } };
    const fleet = { fleetId: "f-1", factionId: ENEMY, version: 3, fleetRole: "patrol", state: "IDLE", shipCount: 10,
      currentSystemId: SYS, composition: [{ hullGroup: "frigate", count: 10 }] };
    const service = createSentryService({ store: opened.store, config: cfg, clock, seam, journal,
      repository: { listActive: () => ({ ok: true, sentries: [gun, heavy], truncated: false }) },
      scheduler: { enqueue: () => ({ ok: true }) },
      fleetRepository: { listFleetsInSystem: () => ({ ok: true, nextAfterFleetId: null, fleets: [fleet] }) },
      getPresence: () => ({ distanceToObserved: () => ({ ok: true, distance: null }) }), groups: GROUPS,
      hostility: { isFactionEnemy: (f, g) => g === ENEMY, readStanding: () => ({ ok: true, standing: -10 }),
        getFactionKind: () => "pirate", thresholds: huntThresholds(DEFAULTS.playerHunt),
        neutralPolicy: { pirate: "hostile" } },
      getBattle: () => facade });
    assert.ok(service.rebuildArmed().ok);
    const R = cfg.sentries.battle.roundMs;
    const k = Math.floor(clock.now() / R) + 1;
    const r = service.onAttrition({ payload: { systemId: SYS, round: k }, dueAt: k * R }, { anchorAt: k * R });
    assert.strictEqual(r.outcome, "BATTLE", JSON.stringify(r));
    const tx = opened.store.transaction("test", (db) => r.effect(db));
    assert.ok(tx.ok, JSON.stringify(tx));
    r.onCommitted(tx.value);
    assert.deepStrictEqual(calls[0].spec.fixedDefenses.entries.map((e) => [e.sentryId, e.dps, e.signature]),
      [["sf-1", 135.4, 6000], ["sp-7010", 270, 18000]]);
    assert.deepStrictEqual(ammoReads.filter(([id]) => id === 7010), [[7010, 17668]]);
    service.stop();
  }));

  needsDriver("HSB2: heavy designSig from sentries.heavy.designSig (0 = profile), heavy missile dps x "
    + "missileDpsPermille; the small gun unchanged", () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    const { clock } = H.sharedOf();
    const journal = createJournal({ clock, maxPayloadBytes: 16384, maxRows: 500 });
    const ref = (sentryId, itemId, typeId) => ({ sentryId, itemId, typeId, ownerKind: "player", factionId: null,
      ownerCorpId: CORP, characterId: CHAR, systemId: SYS, state: S.ACTIVE, armedAt: 0 });
    const live = [ref("sp-7101", 7101, GUN), ref("sp-7102", 7102, HEAVY), ref("sp-7103", 7103, 340525)];
    const profiles = { [GUN]: { ok: true, dps: 67.7, signature: 6000, designSig: 150 },
      [HEAVY]: { ok: true, dps: 271.04, signature: 18000, designSig: 1000 },
      340525: { ok: true, dps: 613.02, signature: 18000, designSig: null } };
    const seam = { readSentryItem: () => ({ ok: true, item: { hp: 1700000, destroyed: false, incapacitated: false } }),
      readSentryCombat: (typeId) => profiles[typeId], readAmmo: () => ({ ok: true, units: 50, capacityUnits: 100 }) };
    const fleet = { fleetId: "f-1", factionId: ENEMY, version: 3, fleetRole: "patrol", state: "IDLE", shipCount: 10,
      currentSystemId: SYS, composition: [{ hullGroup: "frigate", count: 10 }] };
    const R = DEFAULTS.sentries.battle.roundMs;
    const entriesOf = (heavyOver, round) => {
      const calls = [];
      const facade = { getStatus: () => ({ state: "ready" }), createFixedDefenseBattleInTx(tx, spec) {
        calls.push(spec);
        return { ok: true, duplicate: false, battleId: `b-${round}` };
      } };
      const cfg = { ...DEFAULTS, sentries: { ...DEFAULTS.sentries, enabled: true,
        battle: { ...DEFAULTS.sentries.battle, enabled: true, dpsPermille: 1000 },
        heavy: { ...DEFAULTS.sentries.heavy, ...heavyOver } } };
      const service = createSentryService({ store: opened.store, config: cfg, clock, seam, journal,
        repository: { listActive: () => ({ ok: true, sentries: live, truncated: false }) },
        scheduler: { enqueue: () => ({ ok: true }) },
        fleetRepository: { listFleetsInSystem: () => ({ ok: true, nextAfterFleetId: null, fleets: [fleet] }) },
        getPresence: () => ({ distanceToObserved: () => ({ ok: true, distance: null }) }), groups: GROUPS,
        hostility: { isFactionEnemy: (f, g) => g === ENEMY, readStanding: () => ({ ok: true, standing: -10 }),
          getFactionKind: () => "pirate", thresholds: huntThresholds(DEFAULTS.playerHunt),
          neutralPolicy: { pirate: "hostile" } },
        getBattle: () => facade });
      assert.ok(service.rebuildArmed().ok);
      const k = Math.floor(clock.now() / R) + round;
      const r = service.onAttrition({ payload: { systemId: SYS, round: k }, dueAt: k * R }, { anchorAt: k * R });
      assert.strictEqual(r.outcome, "BATTLE", JSON.stringify(r));
      const tx = opened.store.transaction("test", (db) => r.effect(db));
      assert.ok(tx.ok, JSON.stringify(tx));
      r.onCommitted(tx.value);
      service.stop();
      return calls[0].fixedDefenses.entries.map((e) => [e.sentryId, e.dps, e.designSig]);
    };
    assert.deepStrictEqual([DEFAULTS.sentries.heavy.designSig, DEFAULTS.sentries.heavy.missileDpsPermille], [125, 440]);
    const def = entriesOf({}, 1);
    assert.deepStrictEqual(def.map(([id, , sig]) => [id, sig]), [["sp-7101", 150], ["sp-7102", 125], ["sp-7103", 125]]);
    assert.ok(near(def[0][1], 67.7) && near(def[1][1], 271.04) && near(def[2][1], 613.02 * 0.44), JSON.stringify(def));
    const zero = entriesOf({ designSig: 0 }, 3);
    assert.deepStrictEqual(zero.map(([id, , sig]) => [id, sig]),
      [["sp-7101", 150], ["sp-7102", 1000], ["sp-7103", DEFAULTS.sentries.battle.defaultDesignSig]]);
  }));
};
