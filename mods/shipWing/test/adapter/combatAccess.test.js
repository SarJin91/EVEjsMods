"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { createCombatAccess, createCombatAccessFromGame, COMBAT_COUNTER_NAMES } = require("../../lib/adapter/combatAccess");
const { createTwinScene } = require("../../lib/adapter/twinScene");
const { createAdapter, probeModules, formatProbeLog, symbolPresent } = require("../../lib/adapter/index");
const { GAME_MODULES } = require("../../lib/adapter/gameModules");
const { weaponsStatus } = require("../../loader");

const OWNER = 90000001;
const OTHER = 90000002;

function makeTwin() {
  return {
    itemID: 4200000000000001, kind: "ship", pilotCharacterID: OWNER, characterID: 0, systemID: 30000142,
    fittedItems: [
      { itemID: 1002, flagID: 28, typeID: 3146 },
      { itemID: 1001, flagID: 27, typeID: 3146 },
      { itemID: 1003, flagID: 29, typeID: 2410 },
      { itemID: 1004, flagID: 30, typeID: 3146, offline: true },
    ],
    nativeCargoItems: [{ itemID: 2001, typeID: 230, moduleID: 1001, quantity: 100 }],
    skillMap: new Map([[3300, 5]]),
  };
}

function makeRat(extra = {}) {
  return { itemID: 9000001, kind: "ship", nativeNpc: true, npcEntityType: "npc", typeID: 23, bounty: 1000,
    hp: 100, ...extra };
}

function fakeBounty() {
  const book = { buckets: new Map(), calls: 0, events: new Set() };
  book.recordNpcBountyKill = (victim, attacker) => {
    book.calls += 1;
    const characterID = [attacker.characterID, attacker.pilotCharacterID, attacker.session
      && attacker.session.characterID].map((v) => Math.trunc(Number(v)) || 0).find((v) => v > 0) || null;
    const eventID = victim._bountyEventID || `boot:30000142:${victim.itemID}`;
    if (book.events.has(eventID)) return { alreadyRecorded: true, characterID };
    book.events.add(eventID);
    victim._bountyEventID = eventID;
    book.buckets.set(characterID, (book.buckets.get(characterID) || 0) + 1);
    return { alreadyRecorded: false, characterID };
  };
  return book;
}

const DEFENDER_GROUP = 395;
const STANDARD_GROUP = 386;

function fixture(opts = {}) {
  const calls = { snapshot: [], shot: [], apply: [], note: [], enqueue: [], record: [], fx: [], launch: [],
    sync: [], advance: [], reset: [], vshot: [], arcShot: [], select: [], vfx: [] };
  const space = { distance: opts.distance === undefined ? 4000 : opts.distance };
  const bounty = fakeBounty();
  const shipItem = { itemID: 4200000000000001, typeID: 641 };
  const killmailTracker = {
    noteDamage: (...args) => calls.note.push(args),
    enqueueKillmailFromDestruction: (target, destroyResult, options) => {
      calls.enqueue.push([target, destroyResult, options]);
      const final = options.attackerEntity;
      bounty.recordNpcBountyKill(target, { characterID: final.pilotCharacterID ?? final.characterID });
    },
    recordKillmailFromDestruction: (...args) => calls.record.push(args),
  };
  const deps = {
    buildWeaponSnapshotForEntity: (entity, module, charge, options) => {
      calls.snapshot.push({ entity, module, charge, options });
      if (opts.snapshotThrows) throw new Error("vendor broke");
      if (opts.noSnapshot) return null;
      if (module.typeID === 2410) {
        const chargeGroupID = charge ? charge.groupID : 0;
        return { family: opts.missileFamily || "missileLauncher", chargeMode: "stack", durationMs: 8000,
          approxRange: opts.approxRange === undefined ? 40000 : opts.approxRange, chargeTypeID: charge.typeID,
          chargeGroupID, moduleGroupID: module.groupID, isDefenderMissile: chargeGroupID === DEFENDER_GROUP };
      }
      if (opts.families && opts.families[module.itemID] === "precursorTurret") {
        return { family: "precursorTurret", chargeMode: "stack", durationMs: 5000, effectGUID: "effects.TriglavianBeam",
          optimalRange: 6000, falloff: 0, damageMultiplier: 2, chargeTypeID: charge ? charge.typeID : 0 };
      }
      if (opts.families && opts.families[module.itemID] === "vortonProjector") {
        return { family: "vortonProjector", chargeMode: "stack", durationMs: 6000,
          effectGUID: "effects.UpwellChainWeaponMedium", optimalRange: 8000, falloff: 0, arcRange: 10000,
          arcTargets: 10, chargeTypeID: charge ? charge.typeID : 0 };
      }
      return { family: opts.snapshotFamily || "hybridTurret", chargeMode: opts.chargeMode || "stack",
        durationMs: 5000, effectGUID: "effects.HybridFire", chargeTypeID: charge ? charge.typeID : 0 };
    },
    resolveTurretShot: (input) => {
      calls.shot.push(input);
      return { hit: opts.miss !== true, shotDamage: { kinetic: 150 } };
    },
    applyWeaponDamageToTarget: (scene, attacker, target, shotDamage, whenMs, options) => {
      calls.apply.push({ scene, attacker, target, shotDamage, whenMs, options });
      const applied = Math.min(target.hp, shotDamage.kinetic);
      target.hp -= applied;
      let destroyResult = null;
      if (target.hp <= 0) {
        destroyResult = { success: true, data: {} };
        bounty.recordNpcBountyKill(target, attacker);
      }
      return { damageResult: { success: true, data: { perLayer: [{ appliedEffective: applied }] } }, destroyResult };
    },
    killmailTracker,
    getAppliedDamageAmount: (damageResult) => (damageResult && damageResult.success === true
      ? damageResult.data.perLayer.reduce((sum, l) => sum + l.appliedEffective, 0) : 0),
    resolveWeaponFamily: (module) => (opts.families && opts.families[module.itemID])
      || (module.typeID === 2410 ? "missileLauncher" : "hybridTurret"),
    isTurretCycleWeaponFamily: (f) => ["laserTurret", "hybridTurret", "projectileTurret", "precursorTurret",
      "vortonProjector"].includes(f),
    isVortonWeaponFamily: (f) => f === "vortonProjector",
    isPrecursorTurretFamily: (f) => f === "precursorTurret",
    isChargeOptionalTurretWeapon: () => opts.chargeOptional === true,
    resolveWeaponSpecialFxGUID: () => "",
    hasDamageableHealth: (e) => opts.noHealth !== true && e.hp > 0,
    isRuntimeEntityDestroyingOrDestroyed: (e) => e.destroying === true,
    canEntitiesInteractLocally: (a, b) => (Number(a && a.airInstanceID) || 0) === (Number(b && b.airInstanceID) || 0),
    buildRuntimeShipItemFromEntity: () => shipItem,
    getLocationModifierSourcesForSystem: (systemID) => [{ systemID }],
    isCrystalBurnedOut: (item, snap) => {
      calls.crystal = [item, snap];
      return opts.burnedOut === true;
    },
    buildCrystalDurabilitySnapshot: (typeID, attributes) => ({ typeID, attributes }),
    getTypeDogmaAttributes: (typeID) => ({ typeID, volatility: 1 }),
    isModuleOnline: (module) => module.offline !== true,
    isMissileWeaponFamily: (f) => ["missileLauncher", "festivalLauncher", "breacherPodLauncher"].includes(f),
    isDefenderMissileWeaponSnapshot: (s) => Boolean(s) && (s.isDefenderMissile === true
      || s.chargeGroupID === DEFENDER_GROUP),
    synchronizePrecursorTurretEffectState: (s, snap, now) => {
      calls.sync.push([s.targetID, now]);
      const prev = Math.trunc(Number(s.precursorSpoolTargetID)) || 0;
      if (prev > 0 && s.targetID > 0 && prev !== s.targetID) s.precursorSpoolCurrent = 0;
      Object.assign(s, { precursorTurret: true, precursorSpoolTargetID: s.targetID, precursorSpoolPerCycle: 0.5,
        precursorSpoolMax: 1.5, precursorSpoolCurrent: Math.min(1.5, Number(s.precursorSpoolCurrent) || 0) });
      return s;
    },
    advancePrecursorTurretSpool: (s, snap, now) => {
      calls.advance.push([snap, now]);
      s.precursorSpoolCurrent = Math.min(s.precursorSpoolMax, s.precursorSpoolCurrent + s.precursorSpoolPerCycle);
      return s;
    },
    resetPrecursorTurretSpool: (s) => {
      calls.reset.push(s.precursorSpoolCurrent);
      Object.assign(s, { precursorSpoolCurrent: 0, precursorSpoolTargetID: 0 });
      return s;
    },
    applyPrecursorTurretSpoolToSnapshot: (snap, s) => (s.precursorSpoolCurrent > 0
      ? { ...snap, damageMultiplier: snap.damageMultiplier * (1 + s.precursorSpoolCurrent) } : snap),
    buildPrecursorTurretGraphicInfo: (s) => ({ mulitplierBonusPerCycle: s.precursorSpoolPerCycle,
      multiplierBonusPerCycle: s.precursorSpoolPerCycle, multiplierBonusMax: s.precursorSpoolMax }),
    resolveVortonShot: (input) => {
      calls.vshot.push(input);
      return { hit: true, shotDamage: { kinetic: 150 } };
    },
    resolveVortonArcShot: (input) => {
      calls.arcShot.push(input);
      return { hit: true, shotDamage: { kinetic: 100 } };
    },
    selectVortonArcTargets: (input) => {
      calls.select.push(input);
      return [...input.candidateEntities].sort((a, b) => a.itemID - b.itemID).slice(0, input.weaponSnapshot.arcTargets - 1)
        .map((entity, i) => ({ entity, linkIndex: i + 1, distanceFromPrimaryTarget: 1000 }));
    },
    broadcastVortonCycleSpecialFx: (scene, entity, state) => {
      calls.vfx.push({ scene, entity, state: { ...state }, damageCallsBefore: calls.apply.length });
    },
  };
  const entities = new Map();
  const scene = {
    dynamicEntities: entities,
    getEntityByID: (id) => entities.get(id) || null,
    broadcastSpecialFx: (...args) => {
      calls.fx.push(args);
      if (opts.fxThrows) throw new Error("fx broke");
    },
    getTargetersForEntity: () => [9000002, 9000001],
    getEntitySurfaceDistance: (_a, b) => (b && Number.isFinite(b.hostDistM) ? b.hostDistM : space.distance),
    launchMissile: (...args) => {
      calls.launch.push(args);
      return opts.launchResult || { success: true, data: { missileEntity: { itemID: 77 } } };
    },
  };
  const twin = makeTwin();
  if (opts.missileCharge) {
    twin.fittedItems[2].groupID = 507;
    twin.nativeCargoItems.push({ itemID: 2003, typeID: 209, groupID: opts.missileCharge, moduleID: 1003,
      quantity: 20 });
  }
  if (opts.precursorCharge) {
    twin.nativeCargoItems.push({ itemID: 2002, typeID: 47924, moduleID: 1002, quantity: 50 });
  }
  if (opts.vortonCharge) {
    twin.nativeCargoItems.push({ itemID: 2004, typeID: 54781, moduleID: 1002, quantity: 40 });
  }
  const rat = makeRat(opts.rat);
  entities.set(twin.itemID, twin);
  entities.set(rat.itemID, rat);
  const access = createCombatAccess({ deps, scene: createTwinScene(),
    config: { combatFxEnabled: opts.fx !== false, controlRangeMeters: 20000, combatEngageRangeMeters: 15000, ...opts.config },
    isConsumerAvailable: opts.consumers });
  return { access, calls, bounty, scene, twin, rat, entities, shipItem, deps, space };
}

const WEAPON = Object.freeze({ moduleId: 1001, flagId: 27, family: "hybridTurret", needsAmmo: true });

module.exports = ({ test }) => {
  test("CB2 reward gate: a killing volley -> applyWeaponDamageToTarget 1x, noteDamage 1x, "
    + "enqueueKillmailFromDestruction 1x (never record...), all with attackerEntity === twin (pilot = owner, "
    + "characterID 0, no nativeNpc); one bounty bucket, for the owner only; miss and no damageable health -> no "
    + "damage, no ledger", () => {
    const f = fixture({ rat: { hp: 100 } });
    const out = f.access.fireVolley(f.scene, f.twin, WEAPON, f.rat, 777000);
    assert.deepStrictEqual(out, { ok: true, durationMs: 5000, data: { hit: true, applied: 100, destroyed: true,
      chargeItemId: 2001, chargeMode: "stack" } });
    assert.strictEqual(f.calls.apply.length, 1);
    assert.strictEqual(f.calls.note.length, 1);
    assert.strictEqual(f.calls.enqueue.length, 1, "The vendor's enqueue path");
    assert.strictEqual(f.calls.record.length, 0, "never recordKillmailFromDestruction");
    const a = f.calls.apply[0];
    assert.strictEqual(a.attacker, f.twin);
    assert.strictEqual(a.scene, f.scene);
    assert.strictEqual(a.whenMs, 777000);
    assert.deepStrictEqual(a.options, { fabricatorDamageKind: null, incursionWeaponKind: "turret" }, "261108.1 vendor options");
    assert.deepStrictEqual(a.shotDamage, { kinetic: 150 });
    const [noteAttacker, noteTarget, noteApplied, noteOpts] = f.calls.note[0];
    assert.strictEqual(noteAttacker, f.twin);
    assert.strictEqual(noteTarget, f.rat);
    assert.strictEqual(noteApplied, 100);
    assert.strictEqual(noteOpts.whenMs, 777000);
    assert.strictEqual(noteOpts.moduleItem, f.twin.fittedItems[1]);
    assert.strictEqual(noteOpts.chargeItem, f.twin.nativeCargoItems[0]);
    const [kmTarget, kmDestroy, kmOpts] = f.calls.enqueue[0];
    assert.strictEqual(kmTarget, f.rat);
    assert.strictEqual(kmDestroy.success, true);
    assert.strictEqual(kmOpts.attackerEntity, f.twin);
    assert.strictEqual(kmOpts.whenMs, 777000);
    assert.strictEqual(kmOpts.moduleItem, f.twin.fittedItems[1]);
    assert.strictEqual(kmOpts.weaponSnapshot, noteOpts.weaponSnapshot);
    assert.strictEqual(f.twin.pilotCharacterID, OWNER);
    assert.strictEqual(f.twin.characterID, 0);
    assert.strictEqual(f.twin.nativeNpc, undefined);
    assert.deepStrictEqual([...f.bounty.buckets.entries()], [[OWNER, 1]], "one bucket, main character only");
    assert.strictEqual(f.bounty.buckets.has(OTHER), false);
    assert.strictEqual(f.bounty.calls, 2, "destruction + killmail both reach the book, deduped to one bucket");
    assert.ok(!Object.keys(f.deps).some((k) => /bounty/i.test(k)), "the mod has no bounty function at all");
    const stats = f.access.stats().counters;
    assert.strictEqual(stats["combat.volley.fired"], 1);
    assert.strictEqual(stats["combat.volley.hit"], 1);
    assert.strictEqual(stats["combat.volley.kill"], 1);

    const hurt = fixture({ rat: { hp: 1000 } });
    assert.deepStrictEqual(hurt.access.fireVolley(hurt.scene, hurt.twin, WEAPON, hurt.rat, 1),
      { ok: true, durationMs: 5000, data: { hit: true, applied: 150, destroyed: false, chargeItemId: 2001,
        chargeMode: "stack" } });
    assert.deepStrictEqual([hurt.calls.apply.length, hurt.calls.note.length, hurt.calls.enqueue.length], [1, 1, 0]);

    const miss = fixture({ miss: true });
    assert.deepStrictEqual(miss.access.fireVolley(miss.scene, miss.twin, WEAPON, miss.rat, 1),
      { ok: true, durationMs: 5000, data: { hit: false, applied: 0, destroyed: false, chargeItemId: 2001,
        chargeMode: "stack" } });
    assert.deepStrictEqual([miss.calls.apply.length, miss.calls.note.length, miss.calls.enqueue.length], [0, 0, 0]);
    assert.strictEqual(miss.access.stats().counters["combat.volley.miss"], 1);

    const immune = fixture({ noHealth: true });
    const immuneOut = immune.access.fireVolley(immune.scene, immune.twin, WEAPON, immune.rat, 1);
    assert.strictEqual(immuneOut.ok, true);
    assert.strictEqual(immuneOut.data.applied, 0);
    assert.deepStrictEqual([immune.calls.apply.length, immune.calls.note.length], [0, 0]);
    assert.strictEqual(immune.bounty.calls, 0);
  });

  test("CB3 snapshot from the twin (hull, fit, skills, charge by moduleID), refusals NO_AMMO (no charge, burned-out "
    + "crystal), UNSUPPORTED_FAMILY (Vorton, Precursor, missile), TARGET_GONE, NO_SNAPSHOT, vendor throw -> ERROR "
    + "without throw; an FX error leaves the damage result as it is; listWeapons, checkTarget, host targets, threats",
  () => {
    const f = fixture({ rat: { hp: 1000 } });
    f.access.fireVolley(f.scene, f.twin, WEAPON, f.rat, 10);
    const s = f.calls.snapshot[0];
    assert.strictEqual(s.entity, f.twin);
    assert.strictEqual(s.module, f.twin.fittedItems[1]);
    assert.strictEqual(s.charge, f.twin.nativeCargoItems[0], "charge = the cargo row with moduleID 1001");
    assert.strictEqual(s.options.shipItem, f.shipItem, "twinShipItem(twin)");
    assert.strictEqual(s.options.fittedItems, f.twin.fittedItems);
    assert.strictEqual(s.options.skillMap, f.twin.skillMap);
    assert.deepStrictEqual(s.options.activeModuleContexts, []);
    assert.deepStrictEqual(s.options.additionalLocationModifierSources, [{ systemID: 30000142 }]);
    assert.strictEqual(f.calls.shot[0].attackerEntity, f.twin);
    assert.strictEqual(f.calls.shot[0].targetEntity, f.rat);
    assert.strictEqual(f.calls.fx.length, 1);
    const [fxShip, fxGuid, fxOpts, fxVis] = f.calls.fx[0];
    assert.deepStrictEqual([fxShip, fxGuid, fxVis], [f.twin.itemID, "effects.HybridFire", f.twin]);
    assert.deepStrictEqual(fxOpts, { moduleID: 1001, moduleTypeID: 3146, targetID: 9000001, chargeTypeID: 230,
      start: true, active: false, duration: 5000 });

    const noAmmo = fixture();
    noAmmo.twin.nativeCargoItems = [];
    assert.deepStrictEqual(noAmmo.access.fireVolley(noAmmo.scene, noAmmo.twin, WEAPON, noAmmo.rat, 1),
      { ok: false, reason: "NO_AMMO", retryMs: null });
    assert.strictEqual(noAmmo.calls.snapshot.length, 0);
    assert.strictEqual(noAmmo.access.stats().counters["combat.volley.skip.NO_AMMO"], 1);
    const optional = fixture({ chargeOptional: true });
    optional.twin.nativeCargoItems = [];
    assert.strictEqual(optional.access.fireVolley(optional.scene, optional.twin, WEAPON, optional.rat, 1).ok, true,
      "a charge-optional turret fires without a charge");

    const burned = fixture({ chargeMode: "crystal", burnedOut: true });
    assert.deepStrictEqual(burned.access.fireVolley(burned.scene, burned.twin, WEAPON, burned.rat, 1),
      { ok: false, reason: "NO_AMMO", retryMs: 5000 });
    assert.strictEqual(burned.calls.shot.length, 0);
    assert.strictEqual(burned.calls.crystal[0], burned.twin.nativeCargoItems[0]);
    assert.deepStrictEqual(burned.calls.crystal[1], { typeID: 230, attributes: { typeID: 230, volatility: 1 } },
      "vendor input: buildCrystalDurabilitySnapshot(typeID, getTypeDogmaAttributes(typeID))");
    const fresh = fixture({ chargeMode: "crystal", burnedOut: false });
    assert.strictEqual(fresh.access.fireVolley(fresh.scene, fresh.twin, WEAPON, fresh.rat, 1).ok, true);

    for (const family of ["vortonProjector", "precursorTurret", "missileLauncher"]) {
      const u = fixture({ families: { 1001: family } });
      assert.deepStrictEqual(u.access.fireVolley(u.scene, u.twin, WEAPON, u.rat, 1),
        { ok: false, reason: "UNSUPPORTED_FAMILY", retryMs: null }, family);
      const late = fixture({ snapshotFamily: family });
      assert.deepStrictEqual(late.access.fireVolley(late.scene, late.twin, WEAPON, late.rat, 1),
        { ok: false, reason: "UNSUPPORTED_FAMILY", retryMs: 5000 }, `${family} (snapshot)`);
    }

    const gone = fixture({ rat: { destroying: true } });
    assert.deepStrictEqual(gone.access.fireVolley(gone.scene, gone.twin, WEAPON, gone.rat, 1),
      { ok: false, reason: "TARGET_GONE", retryMs: null });
    const removed = fixture();
    removed.entities.delete(removed.rat.itemID);
    assert.strictEqual(removed.access.fireVolley(removed.scene, removed.twin, WEAPON, removed.rat, 1).reason,
      "TARGET_GONE");
    assert.strictEqual(removed.access.stats().counters["combat.volley.skip.TARGET_GONE"], 1);

    const nosnap = fixture({ noSnapshot: true });
    assert.deepStrictEqual(nosnap.access.fireVolley(nosnap.scene, nosnap.twin, WEAPON, nosnap.rat, 1),
      { ok: false, reason: "NO_SNAPSHOT", retryMs: null });
    const nomod = fixture();
    assert.strictEqual(nomod.access.fireVolley(nomod.scene, nomod.twin, { moduleId: 5, flagId: 99 }, nomod.rat, 1)
      .reason, "NO_SNAPSHOT");

    const broken = fixture({ snapshotThrows: true });
    let thrown = null;
    let out;
    try {
      out = broken.access.fireVolley(broken.scene, broken.twin, WEAPON, broken.rat, 1);
    } catch (err) {
      thrown = err;
    }
    assert.strictEqual(thrown, null, "never throws");
    assert.deepStrictEqual(out, { ok: false, reason: "ERROR", retryMs: null });
    assert.strictEqual(broken.access.stats().counters["combat.volley.error"], 1);

    const fxBad = fixture({ fxThrows: true, rat: { hp: 100 } });
    const fxOk = fixture({ fx: false, rat: { hp: 100 } });
    const badOut = fxBad.access.fireVolley(fxBad.scene, fxBad.twin, WEAPON, fxBad.rat, 1);
    assert.deepStrictEqual(badOut, fxOk.access.fireVolley(fxOk.scene, fxOk.twin, WEAPON, fxOk.rat, 1));
    assert.strictEqual(badOut.data.destroyed, true);
    assert.strictEqual(fxBad.access.stats().counters["combat.fx.error"], 1);
    assert.strictEqual(fxOk.calls.fx.length, 0, "combatFxEnabled=false -> no FX");
    assert.strictEqual(fxBad.calls.enqueue.length, 1);

    const TURRET = { kind: "turret", steers: true, needsLock: true };
    assert.deepStrictEqual(f.access.listWeapons(f.twin), [
      { moduleId: 1001, flagId: 27, family: "hybridTurret", needsAmmo: true, chargeItemId: 2001, chargeQuantity: 100,
        ...TURRET },
      { moduleId: 1002, flagId: 28, family: "hybridTurret", needsAmmo: true, chargeItemId: 0, chargeQuantity: 0,
        ...TURRET },
    ]);
    const host = { itemID: 1000000501 };
    assert.deepStrictEqual(f.access.checkTarget(f.scene, f.twin, host, f.rat), { ok: true });
    assert.deepStrictEqual(f.access.checkTarget(f.scene, f.twin, host, { ...f.rat, itemID: 1 }),
      { ok: false, reason: "TARGET_OUT_OF_RANGE" }, "not in the twin's scene");
    assert.deepStrictEqual(f.access.checkTarget(f.scene, f.twin, host, { ...f.rat, destroying: true }),
      { ok: false, reason: "NO_TARGET" }, "destroying (combatDestruction)");
    f.entities.set(9000009, { itemID: 9000009, kind: "ship", session: {}, pilotCharacterID: OTHER });
    assert.deepStrictEqual(f.access.checkTarget(f.scene, f.twin, host, f.entities.get(9000009)),
      { ok: false, reason: "TARGET_NOT_NPC" });
    assert.strictEqual(f.access.stats().counters["combat.target.refused.TARGET_NOT_NPC"], 1);
    const hostShip = { activeModuleEffects: new Map([
      [1, { weaponFamily: "hybridTurret", targetID: 9000003 }],
      [2, { weaponFamily: "", targetID: 9000004 }],
      [3, { weaponFamily: "laserTurret", targetID: 9000003 }],
      [4, { weaponFamily: "missileLauncher", targetID: 9000001 }],
      [5, { weaponFamily: "hybridTurret", targetID: 0 }],
    ]) };
    assert.deepStrictEqual(f.access.hostWeaponTargets(hostShip), [9000001, 9000003]);
    assert.deepStrictEqual(f.access.hostWeaponTargets({}), []);
    assert.deepStrictEqual(f.access.threatsOf(f.scene, f.twin), [9000001, 9000002]);
    for (const name of Object.keys(f.access.stats().counters)) assert.ok(COMBAT_COUNTER_NAMES.includes(name), name);

    const adapter = { isConsumerAvailable: (c) => c !== "combat", requireGame: () => assert.fail("no require") };
    assert.deepStrictEqual(createCombatAccessFromGame(adapter, {}), { ok: false, reason: "probe_combat_unavailable" });

    const g = fixture({ rat: { hp: 100 } });
    const d = g.deps;
    const modules = {
      "space/runtime/weaponSnapshot": { buildWeaponSnapshotForEntity: d.buildWeaponSnapshotForEntity },
      "space/combat/laserTurrets": { resolveTurretShot: d.resolveTurretShot },
      "space/runtime/targetDamageApplication": { applyWeaponDamageToTarget: d.applyWeaponDamageToTarget },
      "space/combat/killmailTracker": d.killmailTracker,
      "space/combat/weaponDogma": { resolveWeaponFamily: d.resolveWeaponFamily,
        isTurretCycleWeaponFamily: d.isTurretCycleWeaponFamily, isVortonWeaponFamily: d.isVortonWeaponFamily,
        isChargeOptionalTurretWeapon: d.isChargeOptionalTurretWeapon,
        resolveWeaponSpecialFxGUID: d.resolveWeaponSpecialFxGUID },
      "space/combat/precursorTurrets": { isPrecursorTurretFamily: d.isPrecursorTurretFamily },
      "space/combat/damage": { hasDamageableHealth: d.hasDamageableHealth },
      "space/runtime/combatDestruction": { isRuntimeEntityDestroyingOrDestroyed: d.isRuntimeEntityDestroyingOrDestroyed },
      "space/runtime/combatDamageMessages": { getAppliedDamageAmount: d.getAppliedDamageAmount },
      "space/runtime/entityDogmaView": { buildRuntimeShipItemFromEntity: d.buildRuntimeShipItemFromEntity },
      "services/exploration/wormholes/wormholeEnvironmentRuntime": {
        getLocationModifierSourcesForSystem: d.getLocationModifierSourcesForSystem },
      "services/dogma/crystalDurability": { isCrystalBurnedOut: d.isCrystalBurnedOut,
        buildCrystalDurabilitySnapshot: d.buildCrystalDurabilitySnapshot },
      "services/fitting/liveFittingState": { getTypeDogmaAttributes: d.getTypeDogmaAttributes,
        isModuleOnline: d.isModuleOnline },
      "services/inventory/itemStore": { consumeInventoryItemQuantityIdempotent: () => ({ success: true }) },
      "space/destiny/identity/interactionScope": { canEntitiesInteractLocally: d.canEntitiesInteractLocally },
    };
    const live = createCombatAccessFromGame({ isConsumerAvailable: () => true,
      requireGame: (rel) => (modules[rel] ? { ok: true, exports: modules[rel] } : { ok: false, reason: "nope" }) },
    { scene: createTwinScene(), config: { combatFxEnabled: false } });
    assert.strictEqual(live.ok, true);
    const original = d.killmailTracker.enqueueKillmailFromDestruction;
    const wrapped = [];
    d.killmailTracker.enqueueKillmailFromDestruction = function otherModWrap(...args) {
      wrapped.push(args[2].attackerEntity);
      return original.apply(this, args);
    };
    assert.strictEqual(live.access.fireVolley(g.scene, g.twin, WEAPON, g.rat, 5).data.destroyed, true);
    assert.deepStrictEqual(wrapped, [g.twin], "the later wrap saw the twin's kill once");
    assert.strictEqual(g.calls.enqueue.length, 1);
    const missing = createCombatAccessFromGame({ isConsumerAvailable: () => true,
      requireGame: () => ({ ok: false, reason: "not_booted" }) }, {});
    assert.strictEqual(missing.ok, false);
    assert.ok(missing.reason.startsWith("require_failed:"), missing.reason);
  });

  const MISSILES_ON = Object.freeze({ combatMissilesEnabled: true, combatReacquireMs: 2000 });
  const LAUNCHER = Object.freeze({ moduleId: 1003, flagId: 29 });
  const unsupported = (f, id) => f.access.stats().counters[`combat.weapons.unsupported.${id}`];

  test("CB4 listWeapons through the registry: launcher + missile -> kind missile; a defender "
    + "-> not listed + unsupported.defender; flag off or no `combatMissile` probe -> not listed + unsupported.missile; "
    + "Vorton -> unsupported.vorton; counted only with countUnsupported; turrets unchanged", () => {
    const TURRETS = [[1001, "turret"], [1002, "turret"]];
    const on = fixture({ missileCharge: STANDARD_GROUP, config: MISSILES_ON });
    const list = on.access.listWeapons(on.twin, { countUnsupported: true });
    assert.deepStrictEqual(list.map((w) => [w.moduleId, w.kind]), [...TURRETS, [1003, "missile"]]);
    assert.deepStrictEqual(list[2], { moduleId: 1003, flagId: 29, family: "missileLauncher", kind: "missile",
      steers: true, needsLock: true, needsAmmo: true, chargeItemId: 2003, chargeQuantity: 20 });
    assert.deepStrictEqual(list[0], { moduleId: 1001, flagId: 27, family: "hybridTurret", kind: "turret", steers: true,
      needsLock: true, needsAmmo: true, chargeItemId: 2001, chargeQuantity: 100 }, "turret as before + handler fields");
    assert.deepStrictEqual(on.access.weaponKinds(), ["turret", "missile"]);
    assert.ok(Object.entries(on.access.stats().counters).every(([n, v]) => !n.startsWith("combat.weapons.") || v === 0),
      "the offline module is not a weapon of the list and not counted");

    const def = fixture({ missileCharge: DEFENDER_GROUP, config: MISSILES_ON });
    assert.deepStrictEqual(def.access.listWeapons(def.twin, { countUnsupported: true }).map((w) => [w.moduleId, w.kind]),
      TURRETS);
    def.access.listWeapons(def.twin);
    assert.deepStrictEqual([unsupported(def, "defender"), unsupported(def, "missile")], [1, 0]);

    const off = fixture({ missileCharge: STANDARD_GROUP });
    const noProbe = fixture({ missileCharge: STANDARD_GROUP, config: MISSILES_ON,
      consumers: (name) => name !== "combatMissile" });
    for (const f of [off, noProbe]) {
      assert.deepStrictEqual(f.access.listWeapons(f.twin, { countUnsupported: true }).map((w) => [w.moduleId, w.kind]),
        TURRETS);
      assert.strictEqual(unsupported(f, "missile"), 1);
      assert.deepStrictEqual(f.access.weaponKinds(), ["turret"]);
    }

    const vorton = fixture({ families: { 1002: "vortonProjector" } });
    assert.deepStrictEqual(vorton.access.listWeapons(vorton.twin, { countUnsupported: true }).map((w) => w.moduleId),
      [1001]);
    assert.deepStrictEqual([unsupported(vorton, "vorton"), unsupported(vorton, "missile")], [1, 1],
      "the empty launcher with the flag off is a missile weapon too");
  });

  test("CB5 a twin's missile: one scene.launchMissile(twin, targetID, snapshot "
    + "{skipRangeCheck:true, launchModules:[module]}) -> chargesUsed 1, no damage path of the mod; target beyond "
    + "approxRange -> OUT_OF_RANGE, nothing launched; success:false -> LAUNCH_FAILED (code counted), no chargesUsed; "
    + "defender, breacher pod, no charge -> refused; festival launches; weaponRange = approxRange", () => {
    const f = fixture({ missileCharge: STANDARD_GROUP, config: MISSILES_ON, rat: { hp: 100 } });
    const out = f.access.fireVolley(f.scene, f.twin, LAUNCHER, f.rat, 777, { ammoLeft: 20 });
    assert.deepStrictEqual(out, { ok: true, durationMs: 8000, data: { hit: false, applied: 0, destroyed: false,
      chargeItemId: 2003, chargeMode: "stack", chargesUsed: 1 } });
    assert.strictEqual(f.calls.launch.length, 1);
    const [attacker, targetId, snapshot, options] = f.calls.launch[0];
    assert.strictEqual(attacker, f.twin, "the twin is the source of the missile (AW-F13)");
    assert.strictEqual(targetId, f.rat.itemID);
    assert.deepStrictEqual([snapshot.family, snapshot.approxRange, snapshot.chargeTypeID], ["missileLauncher", 40000,
      209]);
    assert.deepStrictEqual(Object.keys(options).sort(), ["chargeItem", "launchModules", "launchTimeMs", "moduleItem",
      "skipRangeCheck"]);
    assert.strictEqual(options.chargeItem, f.twin.nativeCargoItems[1]);
    assert.strictEqual(options.moduleItem, f.twin.fittedItems[2]);
    assert.deepStrictEqual([options.launchTimeMs, options.launchModules, options.skipRangeCheck], [777, [1003], true]);
    assert.strictEqual(f.calls.snapshot[0].options.shipItem, f.shipItem, "the snapshot input");
    assert.deepStrictEqual([f.calls.apply.length, f.calls.note.length, f.calls.enqueue.length, f.calls.shot.length],
      [0, 0, 0, 0], "flight and impact stay with the vendor");
    const c = f.access.stats().counters;
    assert.deepStrictEqual([c["combat.missile.launched"], c["combat.volley.fired"]], [1, 0]);
    assert.deepStrictEqual(f.access.weaponRange(f.twin, LAUNCHER), { ok: true, optimalM: 40000, falloffM: 0 });

    const far = fixture({ missileCharge: STANDARD_GROUP, config: MISSILES_ON, approxRange: 3000 });
    assert.deepStrictEqual(far.access.fireVolley(far.scene, far.twin, LAUNCHER, far.rat, 1),
      { ok: false, reason: "OUT_OF_RANGE", retryMs: 2000 }, "4000 m > approxRange 3000 m");
    assert.strictEqual(far.calls.launch.length, 0);
    assert.strictEqual(far.access.stats().counters["combat.volley.skip.OUT_OF_RANGE"], 1);

    for (const [errorMsg, code] of [["TARGET_NOT_FOUND", "TARGET_NOT_FOUND"], ["WEIRD", "OTHER"]]) {
      const bad = fixture({ missileCharge: STANDARD_GROUP, config: MISSILES_ON,
        launchResult: { success: false, errorMsg } });
      assert.deepStrictEqual(bad.access.fireVolley(bad.scene, bad.twin, LAUNCHER, bad.rat, 1),
        { ok: false, reason: "LAUNCH_FAILED", retryMs: 2000 });
      assert.strictEqual(bad.calls.launch.length, 1);
      assert.strictEqual(bad.access.stats().counters[`combat.missile.launchFailed.${code}`], 1, code);
      assert.strictEqual(bad.access.stats().counters["combat.missile.launched"], 0);
    }

    const refused = [
      ["defender", fixture({ missileCharge: DEFENDER_GROUP, config: MISSILES_ON }), "UNSUPPORTED_FAMILY", null],
      ["breacher", fixture({ missileCharge: STANDARD_GROUP, config: MISSILES_ON,
        families: { 1003: "breacherPodLauncher" } }), "UNSUPPORTED_FAMILY", null],
      ["breacher snapshot", fixture({ missileCharge: STANDARD_GROUP, config: MISSILES_ON,
        missileFamily: "breacherPodLauncher" }), "UNSUPPORTED_FAMILY", 8000],
      ["no charge", fixture({ config: MISSILES_ON }), "NO_AMMO", null],
    ];
    for (const [label, r, reason, retryMs] of refused) {
      assert.deepStrictEqual(r.access.fireVolley(r.scene, r.twin, LAUNCHER, r.rat, 1), { ok: false, reason, retryMs },
        label);
      assert.strictEqual(r.calls.launch.length, 0, label);
    }

    const festival = fixture({ missileCharge: STANDARD_GROUP, config: MISSILES_ON,
      families: { 1003: "festivalLauncher" }, missileFamily: "festivalLauncher" });
    assert.strictEqual(festival.access.fireVolley(festival.scene, festival.twin, LAUNCHER, festival.rat, 1).data
      .chargesUsed, 1);
    assert.strictEqual(festival.calls.launch.length, 1);
  });

  test("CB6 probe: a DRIFT of SolarSystemScene.launchMissile disables only the consumer "
    + "`combatMissile` - the combat access is made, turrets fire, launchers are unsupported, ready `weapons=turret`; "
    + "the probe rows of the missiles are combatMissile only", () => {
    const g = fixture({ missileCharge: STANDARD_GROUP, config: MISSILES_ON, fx: false, rat: { hp: 1000 } });
    const d = g.deps;
    const table = GAME_MODULES.map((m) => ({ path: m.path,
      symbols: m.symbols.filter((s) => s.consumer === "combat" || s.consumer === "combatMissile") }))
      .filter((m) => m.symbols.length > 0);
    assert.deepStrictEqual(table.flatMap((m) => m.symbols.filter((s) => s.consumer === "combatMissile")
      .map((s) => [m.path, s.name, s.kind, s.wrap === true, s.firstLoad === true])), [
      ["space/runtime/solarSystemScene", "launchMissile", "exportClassPrototypeMethod", false, false],
      ["space/combat/weaponDogma", "isMissileWeaponFamily", "export", false, false],
      ["space/combat/weaponDogma", "isDefenderMissileWeaponSnapshot", "export", false, false],
    ]);
    class SolarSystemScene {}
    SolarSystemScene.prototype.broadcastSpecialFx = () => {};
    SolarSystemScene.prototype.getTargetersForEntity = () => [];
    SolarSystemScene.prototype.getEntityByID = () => null;
    const srcDir = path.join(path.sep, "srv", "server", "src");
    const cache = {};
    for (const m of table) {
      const file = path.join(srcDir, `${m.path}.js`);
      const exportsObject = m.path === "space/combat/killmailTracker" ? d.killmailTracker
        : (cache[file] ? cache[file].exports : {});
      for (const s of m.symbols) {
        if (s.kind === "exportClassPrototypeMethod") exportsObject[s.exportName] = SolarSystemScene;
        else if (!(s.name in exportsObject)) exportsObject[s.name] = d[s.name] || (() => ({ success: true }));
      }
      cache[file] = { exports: exportsObject };
    }
    const adapter = createAdapter({ moduleApi: { _cache: cache }, gameModules: table });
    assert.strictEqual(adapter.setServerSrc(srcDir).ok, true);
    assert.deepStrictEqual(adapter.runProbe().disabled,
      { combatMissile: "drift:space/runtime/solarSystemScene.launchMissile" });
    const made = createCombatAccessFromGame(adapter, { scene: createTwinScene(), config: {
      combatMissilesEnabled: true, combatReacquireMs: 2000, combatFxEnabled: false, combatEngageRangeMeters: 15000 } });
    assert.strictEqual(made.ok, true, made.reason);
    const access = made.access;
    assert.deepStrictEqual(access.weaponKinds(), ["turret"]);
    assert.deepStrictEqual(access.listWeapons(g.twin, { countUnsupported: true }).map((w) => w.kind),
      ["turret", "turret"]);
    assert.strictEqual(access.stats().counters["combat.weapons.unsupported.missile"], 1);
    assert.strictEqual(access.fireVolley(g.scene, g.twin, WEAPON, g.rat, 5).ok, true, "turrets fire");
    assert.deepStrictEqual(access.fireVolley(g.scene, g.twin, LAUNCHER, g.rat, 5),
      { ok: false, reason: "UNSUPPORTED_FAMILY", retryMs: null });
    assert.deepStrictEqual([g.calls.apply.length, g.calls.launch.length], [1, 0]);
    assert.strictEqual(weaponsStatus({ combatAccess: access }, "ok"), "turret");
    const both = fixture({ config: MISSILES_ON });
    assert.strictEqual(weaponsStatus({ combatAccess: both.access }, "ok"), "turret,missile");
    assert.strictEqual(weaponsStatus({ combatAccess: null }, "off"), "off");
    assert.strictEqual(weaponsStatus({ combatAccess: null }, "probe_combat_unavailable"), "probe_combat_unavailable");
  });

  const PRECURSOR_ON = Object.freeze({ combatPrecursorEnabled: true, combatPrecursorSpoolKeepCycles: 1,
    combatReacquireMs: 2000 });
  const precursorFixture = (extra = {}) => fixture({ families: { 1002: "precursorTurret" }, precursorCharge: true,
    config: PRECURSOR_ON, rat: { hp: 100000 }, ...extra });

  test("CB7 (tests 2-4) Precursor: listWeapons gives kind precursor + its state; three volleys at one "
    + "target -> damageMultiplier of the shot 2, 3, 4 (noteDamage gets the spooled snapshot, advance the base one); "
    + "FX with graphicInfo; another target -> spool 0; a pause = (1 + keep) x cycle keeps it, longer -> spoolReset; "
    + "out of optimal -> OUT_OF_RANGE, no shot, no advance, spool reset as the vendor", () => {
    const f = precursorFixture();
    const dis = f.access.listWeapons(f.twin, { countUnsupported: true }).find((w) => w.moduleId === 1002);
    assert.deepStrictEqual(dis, { moduleId: 1002, flagId: 28, family: "precursorTurret", kind: "precursor",
      steers: true, needsLock: true, needsAmmo: true, chargeItemId: 2002, chargeQuantity: 50,
      state: { weaponFamily: "precursorTurret", moduleID: 1002, targetID: 0, lastFireSimMs: null } });
    assert.deepStrictEqual(f.access.weaponKinds(), ["turret", "precursor"]);
    assert.deepStrictEqual(f.access.weaponRange(f.twin, dis), { ok: true, optimalM: 6000, falloffM: 0 });
    const multipliers = () => f.calls.shot.map((s) => s.weaponSnapshot.damageMultiplier);
    for (const simMs of [10000, 15000, 20000]) {
      assert.deepStrictEqual(f.access.fireVolley(f.scene, f.twin, dis, f.rat, simMs), { ok: true, durationMs: 5000,
        data: { hit: true, applied: 150, destroyed: false, chargeItemId: 2002, chargeMode: "stack" } });
    }
    assert.deepStrictEqual(multipliers(), [2, 3, 4], "the spool grows every volley");
    assert.strictEqual(f.calls.note[2][3].weaponSnapshot.damageMultiplier, 4, "the ledger sees the spooled shot");
    assert.deepStrictEqual(f.calls.advance.map(([snap, now]) => [snap.damageMultiplier, now]),
      [[2, 10000], [2, 15000], [2, 20000]], "advance after the shot, on the base snapshot");
    const [fxShip, fxGuid, fxOpts] = f.calls.fx[0];
    assert.deepStrictEqual([fxShip, fxGuid, fxOpts.moduleID, fxOpts.targetID], [f.twin.itemID,
      "effects.TriglavianBeam", 1002, f.rat.itemID]);
    assert.deepStrictEqual(fxOpts.graphicInfo, { mulitplierBonusPerCycle: 0.5, multiplierBonusPerCycle: 0.5,
      multiplierBonusMax: 1.5 });
    const rat2 = makeRat({ itemID: 9000003, hp: 100000 });
    f.entities.set(rat2.itemID, rat2);
    f.access.fireVolley(f.scene, f.twin, dis, rat2, 25000);
    f.access.fireVolley(f.scene, f.twin, dis, rat2, 35000);
    f.access.fireVolley(f.scene, f.twin, dis, rat2, 45001);
    assert.deepStrictEqual(multipliers().slice(3), [2, 3, 2], "target change -> 0; pause 10000 kept; 10001 reset");
    assert.strictEqual(f.access.stats().counters["combat.precursor.spoolReset"], 1);
    assert.deepStrictEqual(f.calls.reset, [1], "the vendor reset, once (spool 1.0 then)");
    f.space.distance = 6001;
    assert.deepStrictEqual(f.access.fireVolley(f.scene, f.twin, dis, rat2, 50000),
      { ok: false, reason: "OUT_OF_RANGE", retryMs: 2000 });
    assert.deepStrictEqual([f.calls.shot.length, f.calls.advance.length, dis.state.lastFireSimMs], [6, 6, null]);
    assert.strictEqual(f.access.stats().counters["combat.volley.skip.OUT_OF_RANGE"], 1);
    assert.deepStrictEqual(f.calls.reset, [1, 0.5], "OUT_OF_RANGE: the vendor reset (spool 0.5 then)");
    assert.strictEqual(dis.state.precursorSpoolCurrent, 0);
    f.access.fireVolley(f.scene, f.twin, dis, rat2, 52000);
    assert.strictEqual(f.access.stats().counters["combat.precursor.spoolReset"], 2, "one count per stretch");
    f.space.distance = 5000;
    f.access.fireVolley(f.scene, f.twin, dis, rat2, 54000);
    assert.deepStrictEqual(multipliers().slice(6), [2], "spool 0 after OUT_OF_RANGE (before: 3, spool kept)");
    f.space.distance = 6001;
    assert.strictEqual(f.access.fireVolley(f.scene, f.twin, dis, rat2, 64001).reason, "OUT_OF_RANGE");
    assert.strictEqual(f.access.stats().counters["combat.precursor.spoolReset"], 3, "Counted once");
  });

  test("CB8 (tests 1+5) flag off or no `combatPrecursor` probe -> the disintegrator is not listed "
    + "unsupported.precursor, a volley = UNSUPPORTED_FAMILY without vendor spool calls (as before); the probe "
    + "rows; ready `weapons=turret,missile,precursor`", () => {
    const off = precursorFixture({ config: { combatReacquireMs: 2000 } });
    const noProbe = precursorFixture({ consumers: (name) => name !== "combatPrecursor" });
    const DIS = Object.freeze({ moduleId: 1002, flagId: 28 });
    for (const f of [off, noProbe]) {
      assert.deepStrictEqual(f.access.listWeapons(f.twin, { countUnsupported: true }).map((w) => [w.moduleId, w.kind]),
        [[1001, "turret"]]);
      assert.strictEqual(unsupported(f, "precursor"), 1);
      assert.deepStrictEqual(f.access.weaponKinds(), ["turret"]);
      assert.deepStrictEqual(f.access.fireVolley(f.scene, f.twin, DIS, f.rat, 1),
        { ok: false, reason: "UNSUPPORTED_FAMILY", retryMs: null });
      assert.deepStrictEqual([f.calls.shot.length, f.calls.sync.length, f.calls.advance.length], [0, 0, 0]);
    }
    assert.deepStrictEqual(GAME_MODULES.flatMap((m) => m.symbols.filter((s) => s.consumer === "combatPrecursor")
      .map((s) => [m.path, s.name, s.kind, s.wrap === true, s.firstLoad === true])),
    ["synchronizePrecursorTurretEffectState", "advancePrecursorTurretSpool", "resetPrecursorTurretSpool",
      "applyPrecursorTurretSpoolToSnapshot", "buildPrecursorTurretGraphicInfo"]
      .map((name) => ["space/combat/precursorTurrets", name, "export", false, false]));
    const all = precursorFixture({ config: { ...PRECURSOR_ON, combatMissilesEnabled: true } });
    assert.strictEqual(weaponsStatus({ combatAccess: all.access }, "ok"), "turret,missile,precursor",
      "the token appended, the order of the earlier slices kept");
  });

  const VORTON_ON = Object.freeze({ combatVortonEnabled: true, combatVortonArcsEnabled: true,
    combatReacquireMs: 2000 });
  const VORTON = Object.freeze({ moduleId: 1002, flagId: 28 });
  const vortonScene = (extra = {}) => {
    const f = fixture({ families: { 1002: "vortonProjector" }, vortonCharge: true, config: VORTON_ON,
      rat: { hp: 100000 }, ...extra });
    const add = (e) => {
      f.entities.set(e.itemID, e);
      return e;
    };
    const host = add({ itemID: 9000014, kind: "ship", characterID: OWNER, session: { characterID: OWNER }, hp: 1000 });
    const s = {
      host,
      npcA: add(makeRat({ itemID: 9000011, hp: 1000 })),
      npcB: add(makeRat({ itemID: 9000012, hp: 50 })),
      player: add({ itemID: 9000013, kind: "ship", characterID: OTHER, session: { characterID: OTHER }, hp: 1000 }),
      otherTwin: add({ itemID: 9000015, kind: "ship", pilotCharacterID: OTHER, characterID: 0, hp: 1000 }),
      drone: add({ itemID: 9000016, kind: "drone", nativeNpc: true, hp: 1000 }),
      concord: add(makeRat({ itemID: 9000017, npcEntityType: "concord", hp: 1000 })),
      far: add(makeRat({ itemID: 9000018, hp: 1000, hostDistM: 25000 })),
    };
    return { f, ...s };
  };

  test("CB9 Vorton arcs: the primary NPC + 2 NPCs + a player, the host, another twin, a drone "
    + "CONCORD and an NPC too far from the host in arcRange -> the candidates are the 2 NPCs only (same rule as "
    + "checkTarget, no refusal counters); FX with their IDs before any damage; damage on 3 NPCs only", () => {
    const v = vortonScene();
    const { f } = v;
    assert.deepStrictEqual(f.access.listWeapons(f.twin).map((w) => [w.moduleId, w.kind, w.needsAmmo]),
      [[1001, "turret", true], [1002, "vorton", true]]);
    assert.deepStrictEqual(f.access.weaponRange(f.twin, VORTON), { ok: true, optimalM: 8000, falloffM: 0 });
    const refusedBefore = TARGET_REFUSED(f);
    const out = f.access.fireVolley(f.scene, f.twin, VORTON, f.rat, 9000, { ammoLeft: 40, host: v.host });
    assert.deepStrictEqual(out, { ok: true, durationMs: 6000, data: { hit: true, applied: 150, destroyed: false,
      chargeItemId: 2004, chargeMode: "stack" } });
    assert.strictEqual(f.calls.select.length, 1);
    const sel = f.calls.select[0];
    assert.strictEqual(sel.attackerEntity, f.twin);
    assert.strictEqual(sel.primaryTargetEntity, f.rat);
    assert.deepStrictEqual(sel.candidateEntities.map((e) => e.itemID).sort(), [9000011, 9000012]);
    assert.deepStrictEqual(f.calls.apply.map((a) => [a.target.itemID, a.attacker === f.twin, a.options]),
      [[f.rat.itemID, true, { fabricatorDamageKind: "vorton" }], [9000011, true, { fabricatorDamageKind: "vorton" }],
        [9000012, true, { fabricatorDamageKind: "vorton" }]], "primary first, then the arcs; never anyone else");
    for (const safe of [v.host, v.player, v.otherTwin, v.drone, v.concord, v.far]) assert.strictEqual(safe.hp, 1000);
    assert.strictEqual(f.calls.vfx.length, 1);
    const fx = f.calls.vfx[0];
    assert.strictEqual(fx.damageCallsBefore, 0, "FX before any damage (weaponCycle.js:331-338)");
    assert.strictEqual(fx.entity, f.twin);
    assert.deepStrictEqual(fx.state, { weaponFamily: "vortonProjector", moduleID: 1002, typeID: 3146,
      targetID: f.rat.itemID, chargeTypeID: 54781, durationMs: 6000, guid: "effects.UpwellChainWeaponMedium",
      vortonArcTargetIDs: [9000011, 9000012] });
    assert.deepStrictEqual(TARGET_REFUSED(f), refusedBefore, "candidates do not count refusals");
  });

  test("CB10 an arc kills an NPC -> noteDamage + enqueueKillmailFromDestruction with the twin as "
    + "the attacker (bounty to the owner), arc counters; the primary lives -> data.destroyed false", () => {
    const v = vortonScene();
    const { f } = v;
    const out = f.access.fireVolley(f.scene, f.twin, VORTON, f.rat, 9000, { host: v.host });
    assert.strictEqual(out.data.destroyed, false, "arcs never change the engine's target");
    assert.strictEqual(f.calls.enqueue.length, 1);
    const [kmTarget, kmDestroy, kmOpts] = f.calls.enqueue[0];
    assert.deepStrictEqual([kmTarget, kmDestroy.success, kmOpts.attackerEntity, kmOpts.whenMs,
      kmOpts.moduleItem.itemID], [v.npcB, true, f.twin, 9000, 1002]);
    assert.deepStrictEqual(f.calls.note.map(([a, t, applied]) => [a === f.twin, t.itemID, applied]),
      [[true, f.rat.itemID, 150], [true, 9000011, 100], [true, 9000012, 50]]);
    assert.deepStrictEqual([...f.bounty.buckets.entries()], [[OWNER, 1]], "the arc kill pays the main character");
    assert.strictEqual(f.calls.record.length, 0);
    const c = f.access.stats().counters;
    assert.deepStrictEqual([c["combat.vorton.arc.hit"], c["combat.vorton.arc.miss"], c["combat.vorton.arc.kill"],
      c["combat.vorton.arc.error"], c["combat.volley.kill"]], [2, 0, 1, 0, 0]);
  });

  test("CB11 combatVortonArcsEnabled=false or no host -> no selectVortonArcTargets, the primary "
    + "only; flag off or no `combatVorton` probe -> unsupported.vorton, UNSUPPORTED_FAMILY (as before); probe "
    + "rows; ready `weapons=turret,missile,precursor,vorton`", () => {
    const noArcs = vortonScene({ config: { ...VORTON_ON, combatVortonArcsEnabled: false } });
    const noHost = vortonScene();
    for (const [v, host] of [[noArcs, noArcs.host], [noHost, null]]) {
      const out = v.f.access.fireVolley(v.f.scene, v.f.twin, VORTON, v.f.rat, 1, { host });
      assert.strictEqual(out.ok, true);
      assert.strictEqual(v.f.calls.select.length, 0);
      assert.deepStrictEqual(v.f.calls.apply.map((a) => a.target.itemID), [v.f.rat.itemID]);
      assert.deepStrictEqual(v.f.calls.vfx[0].state.vortonArcTargetIDs, []);
    }
    const off = vortonScene({ config: { combatReacquireMs: 2000 } });
    const noProbe = vortonScene({ consumers: (name) => name !== "combatVorton" });
    for (const { f } of [off, noProbe]) {
      assert.deepStrictEqual(f.access.listWeapons(f.twin, { countUnsupported: true }).map((w) => w.kind), ["turret"]);
      assert.strictEqual(unsupported(f, "vorton"), 1);
      assert.deepStrictEqual(f.access.fireVolley(f.scene, f.twin, VORTON, f.rat, 1),
        { ok: false, reason: "UNSUPPORTED_FAMILY", retryMs: null });
      assert.deepStrictEqual([f.calls.vshot.length, f.calls.select.length, f.calls.vfx.length], [0, 0, 0]);
    }
    assert.deepStrictEqual(GAME_MODULES.flatMap((m) => m.symbols.filter((s) => s.consumer === "combatVorton")
      .map((s) => [m.path, s.name, s.kind, s.wrap === true, s.firstLoad === true])), [
      ["space/combat/vortonProjectors", "resolveVortonShot", "export", false, false],
      ["space/combat/vortonProjectors", "resolveVortonArcShot", "export", false, false],
      ["space/combat/vortonProjectors", "selectVortonArcTargets", "export", false, false],
      ["space/runtime/moduleSpecialFx", "broadcastVortonCycleSpecialFx", "export", false, false],
      ["space/runtime/solarSystemScene", "dynamicEntities", "exportClassInstanceField", false, false],
    ]);
    const all = vortonScene({ config: { ...VORTON_ON, ...PRECURSOR_ON, combatMissilesEnabled: true } });
    assert.strictEqual(weaponsStatus({ combatAccess: all.f.access }, "ok"), "turret,missile,precursor,vorton",
      "the token appended, the order of the earlier slices kept");
  });

  test("CB12 out of optimal (8000 m) -> OUT_OF_RANGE with combatReacquireMs, no shot, no FX, no "
    + "damage, no charge (no CycleResult data)", () => {
    const v = vortonScene({ distance: 8001 });
    const { f } = v;
    assert.deepStrictEqual(f.access.fireVolley(f.scene, f.twin, VORTON, f.rat, 1, { host: v.host }),
      { ok: false, reason: "OUT_OF_RANGE", retryMs: 2000 });
    assert.deepStrictEqual([f.calls.vshot.length, f.calls.select.length, f.calls.vfx.length, f.calls.apply.length],
      [0, 0, 0, 0]);
    assert.strictEqual(f.access.stats().counters["combat.volley.skip.OUT_OF_RANGE"], 1);
  });

  test("CB13 (combat-audit) an NPC in another AIR instance: checkTarget TARGET_OUT_OF_RANGE "
    + "never an arc candidate, no damage; a throw of the vendor scope = NO_TARGET; a repeated link of the vendor "
    + "selection strikes its victim once; a scene without its dynamicEntities Map = no arcs + arc.error", () => {
    const v = vortonScene();
    const { f } = v;
    const instanced = makeRat({ itemID: 9000019, hp: 1000, airInstanceID: 77 });
    f.entities.set(instanced.itemID, instanced);
    assert.deepStrictEqual(f.access.checkTarget(f.scene, f.twin, v.host, instanced),
      { ok: false, reason: "TARGET_OUT_OF_RANGE" });
    assert.strictEqual(f.access.fireVolley(f.scene, f.twin, VORTON, f.rat, 9000, { host: v.host }).ok, true);
    assert.deepStrictEqual(f.calls.select[0].candidateEntities.map((e) => e.itemID).sort(), [9000011, 9000012],
      "the instanced NPC is no candidate (vendor vortonArcChain.js:58)");
    assert.strictEqual(instanced.hp, 1000);
    const throwing = vortonScene();
    throwing.f.deps.canEntitiesInteractLocally = () => { throw new Error("scope broke"); };
    assert.deepStrictEqual(throwing.f.access.checkTarget(throwing.f.scene, throwing.f.twin, throwing.host,
      throwing.f.rat), { ok: false, reason: "NO_TARGET" });

    const dup = vortonScene();
    dup.f.deps.selectVortonArcTargets = (input) => {
      const [a, b] = [...input.candidateEntities].sort((x, y) => x.itemID - y.itemID);
      return [a, a, b, a].map((entity, i) => ({ entity, linkIndex: i + 1 }));
    };
    dup.f.access.fireVolley(dup.f.scene, dup.f.twin, VORTON, dup.f.rat, 9000, { host: dup.host });
    assert.deepStrictEqual(dup.f.calls.apply.map((a) => a.target.itemID), [dup.f.rat.itemID, 9000011, 9000012]);
    assert.deepStrictEqual(dup.f.calls.vfx[0].state.vortonArcTargetIDs, [9000011, 9000012]);

    const noPool = vortonScene();
    noPool.f.scene.dynamicEntities = [...noPool.f.entities.values()];
    assert.strictEqual(noPool.f.access.fireVolley(noPool.f.scene, noPool.f.twin, VORTON, noPool.f.rat, 9000,
      { host: noPool.host }).ok, true, "the primary shot goes on");
    assert.deepStrictEqual([noPool.f.calls.select.length, noPool.f.access.stats().counters["combat.vorton.arc.error"]],
      [0, 1]);
  });

  test("CB14 (combat-audit) probe: a DRIFT of an optional symbol (FX, targeters) is reported but keeps "
    + "its consumer on (combat, active, logi, prop); getEntityByID is a hard row of combat; the scene field "
    + "dynamicEntities is read from the class source (exportClassInstanceField); every scene method the adapter calls "
    + "has a row", () => {
    const optional = GAME_MODULES.flatMap((m) => m.symbols.filter((s) => s.optional === true)
      .map((s) => `${s.name}:${s.consumer}`)).sort();
    assert.deepStrictEqual(optional, ["_testing:burst",
      "broadcastDamageStateChange:burst",
      "broadcastSlimItemChanges:spawn",
      "broadcastSpecialFx:active", "broadcastSpecialFx:combat", "broadcastSpecialFx:ewar",
      "broadcastSpecialFx:logi", "broadcastSpecialFx:prop",
      "broadcastVortonCycleSpecialFx:combatVorton", "buildGenericModuleSpecialFxGraphicInfo:combatArea",
      "dynamicEntities:mirror",
      "getEntitySurfaceDistance:mining", "getEntitySurfaceDistance:spawn",
      "getEntitySurfaceDistance:twinControl", "getShipChangePursuitError:board", "getTargetersForEntity:combat",
      "isBreacherPodTarget:combatBreacher"]);
    const hardById = GAME_MODULES.flatMap((m) => m.symbols.filter((s) => s.name === "getEntityByID" && !s.optional)
      .map((s) => s.consumer)).sort();
    assert.deepStrictEqual(hardById, ["active", "combat", "ewar", "mining", "spawn", "twinControl"]);

    const table = GAME_MODULES.filter((m) => m.path === "space/runtime/solarSystemScene")
      .map((m) => ({ path: m.path, symbols: m.symbols.filter((s) => ["combat", "active", "logi", "prop"]
        .includes(s.consumer)) })).filter((m) => m.symbols.length > 0);
    class SolarSystemScene {}
    for (const s of table.flatMap((m) => m.symbols)) {
      if (!["broadcastSpecialFx", "getTargetersForEntity"].includes(s.name)) {
        SolarSystemScene.prototype[s.name] = () => null;
      }
    }
    const report = probeModules(table, () => ({ ok: true, exports: { SolarSystemScene } }));
    assert.deepStrictEqual(report.disabled, {}, "no consumer off");
    assert.strictEqual(report.counts.drift, 4);
    assert.ok(formatProbeLog(report).some((l) => l.includes("missing broadcastSpecialFx, getTargetersForEntity")
      && l.includes("(affects: combat (optional))")), formatProbeLog(report).join("\n"));
    delete SolarSystemScene.prototype.getEntityByID;
    assert.deepStrictEqual(probeModules(table, () => ({ ok: true, exports: { SolarSystemScene } })).disabled,
      { combat: "drift:space/runtime/solarSystemScene.getEntityByID",
        active: "drift:space/runtime/solarSystemScene.getEntityByID" }, "a hard row still turns its consumer off");

    const field = { name: "dynamicEntities", kind: "exportClassInstanceField", exportName: "SolarSystemScene" };
    class WithField { constructor() { this.dynamicEntities = new Map(); } }
    class WithoutField { constructor() { this.staticEntities = new Map(); } }
    assert.deepStrictEqual([symbolPresent({ SolarSystemScene: WithField }, field),
      symbolPresent({ SolarSystemScene: WithoutField }, field), symbolPresent({}, field)], [true, false, false]);

    const names = new Set(GAME_MODULES.flatMap((m) => m.symbols.map((s) => s.name)));
    const dir = path.join(__dirname, "..", "..", "lib", "adapter");
    const files = [...fs.readdirSync(dir).map((f) => path.join(dir, f)),
      ...fs.readdirSync(path.join(dir, "weapons")).map((f) => path.join(dir, "weapons", f))]
      .filter((f) => f.endsWith(".js"));
    const unrowed = new Set();
    for (const file of files) {
      const code = fs.readFileSync(file, "utf8").split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n");
      for (const m of code.matchAll(/\bscene\.([A-Za-z_]+)\(/g)) {
        if (!names.has(m[1])) unrowed.add(`${path.basename(file)}:${m[1]}`);
      }
    }
    assert.deepStrictEqual([...unrowed], []);
    assert.ok(names.has("dynamicEntities"), "the arc pool field has its row");
  });

  const SB_TYPE = 3937;
  const PD_TYPE = 47911;
  const AREA_ON = Object.freeze({ combatAreaEnabled: true, combatReacquireMs: 2000 });
  const AREA = Object.freeze({ moduleId: 1002, flagId: 28 });
  const areaScene = (kind, extra = {}) => {
    const f = fixture({ config: AREA_ON, rat: { hp: 100000 }, ...extra });
    const spy = { evaluate: 0, record: 0, tether: 0, sbResolve: [], pdResolve: [], exec: 0, damage: [], consume: [] };
    const mod = f.twin.fittedItems[0];
    Object.assign(mod, kind === "pd" ? { typeID: PD_TYPE, groupID: 1543 } : { typeID: SB_TYPE, groupID: 72 });
    if (kind === "pd") f.twin.nativeCargoItems.push({ itemID: 2005, typeID: 32014, moduleID: 1002, quantity: 30 });
    const d = f.deps;
    const baseFamily = d.resolveWeaponFamily;
    d.resolveWeaponFamily = (m, c) => ([SB_TYPE, PD_TYPE].includes(m.typeID) ? null : baseFamily(m, c));
    d.resolveDefaultActivationEffect = (typeID) => ({ [SB_TYPE]: { name: "empWave", guid: "effects.EMPWave" },
      [PD_TYPE]: { name: "pointDefense", guid: "effects.PointDefense" } }[typeID] || { name: "targetAttack" });
    d.isSmartbombEffect = (rec, m) => String(rec && rec.name).toLowerCase() === "empwave" || m.groupID === 72;
    d.isPointDefenseEffect = (rec) => String(rec && rec.name).toLowerCase() === "pointdefense";
    d.isHighSecuritySystem = (system) => Boolean(system) && system.security >= 0.45;
    d.buildGenericModuleSpecialFxGraphicInfo = (s) => (s.smartbombEffect ? null : { hitRange: s.pointDefenseRangeMeters });
    d.resolveSmartbombActivation = (input) => {
      spy.sbResolve.push(input);
      return { matched: true, success: true, data: { runtimeAttrs: { durationMs: 10000 }, effectStatePatch: {
        smartbombEffect: true, smartbombRangeMeters: 5000, smartbombDamage: { kinetic: 100 } } } };
    };
    d.resolvePointDefenseActivation = (input) => {
      spy.pdResolve.push(input);
      if (d.isHighSecuritySystem(input.scene.system)) {
        return { matched: true, success: false, errorMsg: "MODULE_DISALLOWED_IN_HIGHSEC" };
      }
      if (!input.chargeItem || input.chargeItem.stacksize < 3) return { matched: true, success: false, errorMsg: "NO_AMMO" };
      return { matched: true, success: true, data: { runtimeAttrs: { durationMs: 1000 }, effectStatePatch: {
        pointDefenseEffect: true, pointDefenseRangeMeters: 6000, pointDefenseChargeRate: 3,
        pointDefenseDamage: { kinetic: 100 } } } };
    };
    const vendorCallbacks = (scene, listName, applyName) => ({
      [listName]: (source, rangeM) => [...scene.dynamicEntities.values()].filter((e) => e !== source && e.hp > 0
        && (Number.isFinite(e.waveDistM) ? e.waveDistM : 1000) <= rangeM),
      [applyName]: (attacker, target, m, damage, when) => {
        spy.damage.push([attacker, target.itemID]);
        return d.applyWeaponDamageToTarget(scene, attacker, target, damage, when, { fabricatorDamageKind: "smartbomb" });
      },
      evaluateOffensiveAggression: () => {
        spy.evaluate += 1;
        return { success: true, data: { legal: true, consequence: "none" } };
      },
      recordOffensiveAggression: () => {
        spy.record += 1;
        return { success: true };
      },
      breakEntityStructureTether: () => { spy.tether += 1; },
    });
    d.buildSmartbombRuntimeCallbacks = (scene) => vendorCallbacks(scene, "listDamageableEntitiesInSmartbombRange",
      "applySmartbombDamage");
    d.buildPointDefenseRuntimeCallbacks = (scene) => {
      const cb = vendorCallbacks(scene, "listDamageableEntitiesInRange", "applyPointDefenseDamage");
      delete cb.recordOffensiveAggression;
      return { ...cb, getEntityRuntimeLoadedCharge: () => null, consumeLoadedCharge: () => ({ success: false }) };
    };
    const run = (cb, targets, apply, extraStep) => {
      targets.forEach(() => {
        if (typeof cb.evaluateOffensiveAggression === "function") cb.evaluateOffensiveAggression();
        if (typeof cb.recordOffensiveAggression === "function") cb.recordOffensiveAggression();
      });
      if (extraStep) {
        const r = extraStep();
        if (r) return r;
      }
      return { success: true, data: { damageResults: targets.map((t) => ({ targetID: t.itemID,
        damageResult: cb[apply](null, t) })) } };
    };
    d.executeSmartbombCycle = ({ entity, effectState, callbacks, nowMs }) => {
      spy.exec += 1;
      if ((typeof callbacks.evaluateOffensiveAggression === "function")
        !== (typeof callbacks.recordOffensiveAggression === "function")) {
        return { success: false, errorMsg: "CRIMEWATCH_UNAVAILABLE" };
      }
      const targets = callbacks.listDamageableEntitiesInSmartbombRange(entity, effectState.smartbombRangeMeters);
      const wrapped = { ...callbacks, applySmartbombDamage: (_a, t) => callbacks.applySmartbombDamage(entity, t, null,
        effectState.smartbombDamage, nowMs) };
      return run(wrapped, targets, "applySmartbombDamage");
    };
    d.executePointDefenseCycle = ({ entity, moduleItem, effectState, callbacks, nowMs }) => {
      spy.exec += 1;
      const charge = callbacks.getEntityRuntimeLoadedCharge(entity, moduleItem);
      const targets = callbacks.listDamageableEntitiesInRange(entity, effectState.pointDefenseRangeMeters);
      const wrapped = { ...callbacks, applyPointDefenseDamage: (_a, t) => callbacks.applyPointDefenseDamage(entity, t,
        null, effectState.pointDefenseDamage, nowMs) };
      return run(wrapped, targets, "applyPointDefenseDamage", () => {
        const c = callbacks.consumeLoadedCharge(entity, moduleItem, charge, effectState.pointDefenseChargeRate, nowMs);
        spy.consume.push([charge.stacksize, effectState.pointDefenseChargeRate, spy.damage.length]);
        if (!c || c.success !== true) return { success: false, errorMsg: "AMMO_UPDATE_FAILED" };
        if (typeof callbacks.breakEntityStructureTether === "function") callbacks.breakEntityStructureTether();
        return null;
      });
    };
    const add = (e) => {
      f.entities.set(e.itemID, e);
      return e;
    };
    const s = {
      host: add({ itemID: 9000014, kind: "ship", characterID: OWNER, session: { characterID: OWNER }, hp: 1000 }),
      npcA: add(makeRat({ itemID: 9000011, hp: 50 })),
      player: add({ itemID: 9000013, kind: "ship", characterID: OTHER, session: { characterID: OTHER }, hp: 1000 }),
      otherTwin: add({ itemID: 9000015, kind: "ship", pilotCharacterID: OTHER, characterID: 0, ownerID: OTHER,
        hp: 1000 }),
      drone: add({ itemID: 9000016, kind: "drone", ownerID: OTHER, hp: 1000 }),
      concord: add(makeRat({ itemID: 9000017, npcEntityType: "concord", hp: 1000 })),
      far: add(makeRat({ itemID: 9000018, hp: 1000, hostDistM: 25000 })),
    };
    return { f, spy, d, ...s };
  };
  const areaCounters = (f, names) => names.map((n) => f.access.stats().counters[n]);

  test("CB15 (tests 2+5) smartbomb: the wave hits only the 2 allowed NPCs (target "
    + "NPC; never the player, host, another twin, a drone, CONCORD, an NPC far from the host), the twin as the "
    + "attacker, no crimewatch callback, FX with graphicInfo null, area counters only; registry: kind area, flag off "
    + "-> unsupported.area, DRIFT/failed load -> no area and no counter; `weapons=...,vorton,area`", () => {
    const v = areaScene("sb");
    const { f, spy } = v;
    assert.deepStrictEqual(f.access.listWeapons(f.twin).map((w) => [w.moduleId, w.kind, w.steers, w.needsLock,
      w.needsAmmo, w.chargeItemId]), [[1001, "turret", true, true, true, 2001], [1002, "area", false, false, false, 0]]);
    assert.deepStrictEqual(f.access.weaponRange(f.twin, AREA), { ok: true, optimalM: 5000, falloffM: 0 });
    const out = f.access.fireVolley(f.scene, f.twin, AREA, f.rat, 9000, { ammoLeft: Infinity, host: v.host });
    assert.deepStrictEqual(out, { ok: true, durationMs: 10000, data: { hit: true, applied: 150, destroyed: false,
      chargeItemId: 0, chargeMode: "", chargesUsed: 0 } });
    assert.deepStrictEqual(spy.damage.map(([a, id]) => [a === f.twin, id]), [[true, f.rat.itemID], [true, 9000011]]);
    for (const safe of [v.host, v.player, v.otherTwin, v.drone, v.concord, v.far]) assert.strictEqual(safe.hp, 1000);
    assert.deepStrictEqual([spy.evaluate, spy.record], [0, 0], "no crimewatch callback");
    assert.deepStrictEqual([...f.bounty.buckets.entries()], [[OWNER, 1]], "the kill pays the main character");
    const sb = spy.sbResolve[1];
    assert.deepStrictEqual([sb.entity === f.twin, sb.shipItem === f.shipItem, sb.activeModuleContexts,
      sb.additionalLocationModifierSources], [true, true, [], [{ systemID: 30000142 }]]);
    assert.strictEqual(f.calls.fx.length, 1);
    const [fxId, guid, fxOpts] = f.calls.fx[0];
    assert.deepStrictEqual([fxId, guid, fxOpts.graphicInfo, fxOpts.targetID, fxOpts.duration],
      [f.twin.itemID, "effects.EMPWave", null, 0, 10000]);
    assert.deepStrictEqual(areaCounters(f, ["combat.area.cycle", "combat.area.hit", "combat.area.kill",
      "combat.volley.fired", "combat.volley.hit"]), [1, 2, 1, 0, 0]);

    const off = areaScene("sb", { config: { combatReacquireMs: 2000 } });
    assert.deepStrictEqual(off.f.access.listWeapons(off.f.twin, { countUnsupported: true }).map((w) => w.kind),
      ["turret"]);
    assert.deepStrictEqual(areaCounters(off.f, ["combat.weapons.unsupported.area", "combat.weapons.unsupported.OTHER"]),
      [1, 0]);
    assert.deepStrictEqual(off.f.access.weaponKinds(), ["turret"]);
    const drift = areaScene("sb", { consumers: (name) => name !== "combatArea" });
    drift.d.resolveDefaultActivationEffect = () => { throw new TypeError("module not loaded"); };
    assert.deepStrictEqual(drift.f.access.listWeapons(drift.f.twin, { countUnsupported: true }).map((w) => w.kind),
      ["turret"]);
    assert.deepStrictEqual(areaCounters(drift.f, ["combat.weapons.unsupported.area",
      "combat.weapons.unsupported.OTHER"]), [0, 0], "No counter on a DRIFT");
    const required = [];
    const made = createCombatAccessFromGame({ isConsumerAvailable: () => true, requireGame: (rel) => {
      required.push(rel);
      return rel === "space/modules/pointDefenseRuntime" ? { ok: false, reason: "boom" } : { ok: true, exports: {} };
    } }, { scene: createTwinScene(), config: { combatVortonEnabled: true, combatAreaEnabled: true } });
    assert.strictEqual(made.ok, true);
    assert.deepStrictEqual(made.access.weaponKinds(), ["turret", "vorton"]);
    assert.strictEqual(required.filter((r) => r === "space/runtime/moduleSpecialFx").length, 1);
    const all = areaScene("sb", { config: { ...AREA_ON, ...VORTON_ON, ...PRECURSOR_ON, combatMissilesEnabled: true } });
    assert.strictEqual(weaponsStatus({ combatAccess: all.f.access }, "ok"), "turret,missile,precursor,vorton,area");
  });

  test("CB16 gates: highsec -> HIGHSEC without a vendor call (AllowHighsec=true fires) "
    + "HoldWhenBystander + a foreign player/twin/drone or CONCORD in range -> BYSTANDER (the host, a sibling twin, an "
    + "own drone and an NPC far from the host are no bystanders); no host or no "
    + "allowed NPC -> NO_TARGETS, no FX, no data; WARP -> VENDOR_REFUSED + refused.CANNOT_ACTIVATE_IN_WARP", () => {
    const hs = areaScene("sb");
    hs.f.scene.system = { security: 0.9 };
    assert.deepStrictEqual(hs.f.access.fireVolley(hs.f.scene, hs.f.twin, AREA, hs.f.rat, 1, { host: hs.host }),
      { ok: false, reason: "HIGHSEC", retryMs: 2000 });
    assert.deepStrictEqual([hs.spy.sbResolve.length, hs.spy.exec, hs.f.calls.fx.length], [0, 0, 0]);
    const hsOk = areaScene("sb", { config: { ...AREA_ON, combatAreaAllowHighsec: true } });
    hsOk.f.scene.system = { security: 0.9 };
    assert.strictEqual(hsOk.f.access.fireVolley(hsOk.f.scene, hsOk.f.twin, AREA, hsOk.f.rat, 1,
      { host: hsOk.host }).ok, true);

    const by = areaScene("sb", { config: { ...AREA_ON, combatAreaHoldWhenBystander: true } });
    assert.deepStrictEqual(by.f.access.fireVolley(by.f.scene, by.f.twin, AREA, by.f.rat, 1, { host: by.host }),
      { ok: false, reason: "BYSTANDER", retryMs: 2000 });
    assert.strictEqual(by.spy.exec, 0);
    const ownScene = () => {
      const v = areaScene("sb", { config: { ...AREA_ON, combatAreaHoldWhenBystander: true } });
      v.f.twin.ownerID = OWNER;
      const add = (e) => { v.f.entities.set(e.itemID, e); return e; };
      v.sibling = add({ itemID: 9000019, kind: "ship", pilotCharacterID: OWNER, characterID: 0, ownerID: OWNER,
        hp: 1000 });
      v.ownDrone = add({ itemID: 9000020, kind: "drone", ownerID: OWNER, hp: 1000 });
      for (const e of [v.player, v.otherTwin, v.drone, v.concord]) e.waveDistM = 9000;
      return v;
    };
    const own = ownScene();
    assert.strictEqual(own.f.access.fireVolley(own.f.scene, own.f.twin, AREA, own.f.rat, 1, { host: own.host }).ok,
      true, "host, sibling twin, own drone and the far NPC hold nothing");
    for (const safe of [own.host, own.sibling, own.ownDrone]) assert.strictEqual(safe.hp, 1000);
    for (const pick of [(v) => v.player, (v) => v.concord, (v) => v.otherTwin, (v) => v.drone]) {
      const v = ownScene();
      pick(v).waveDistM = 1000;
      assert.deepStrictEqual(v.f.access.fireVolley(v.f.scene, v.f.twin, AREA, v.f.rat, 1, { host: v.host }),
        { ok: false, reason: "BYSTANDER", retryMs: 2000 });
      assert.strictEqual(v.spy.exec, 0);
    }

    const noHost = areaScene("sb");
    const noNpc = areaScene("sb");
    for (const e of [noNpc.f.rat, noNpc.npcA]) e.waveDistM = 9000;
    for (const [v, host] of [[noHost, null], [noNpc, noNpc.host]]) {
      assert.deepStrictEqual(v.f.access.fireVolley(v.f.scene, v.f.twin, AREA, v.f.rat, 1, { host }),
        { ok: false, reason: "NO_TARGETS", retryMs: 2000 });
      assert.deepStrictEqual([v.spy.exec, v.f.calls.fx.length, v.spy.damage.length], [0, 0, 0]);
    }

    const warp = areaScene("sb");
    warp.f.twin.mode = "WARP";
    assert.deepStrictEqual(warp.f.access.fireVolley(warp.f.scene, warp.f.twin, AREA, warp.f.rat, 1,
      { host: warp.host }), { ok: false, reason: "VENDOR_REFUSED", retryMs: 2000 });
    assert.deepStrictEqual(areaCounters(warp.f, ["combat.area.refused.CANNOT_ACTIVATE_IN_WARP",
      "combat.volley.skip.VENDOR_REFUSED"]), [1, 1]);
    assert.strictEqual(warp.spy.sbResolve.length, 0);
  });

  test("CB17 point defense: the vendor gets the charge row with stacksize = floor(ammoLeft) "
    + "uses the rate through our consumeLoadedCharge before the damage -> chargesUsed = rate; no evaluator, no tether "
    + "break; highsec -> refused.MODULE_DISALLOWED_IN_HIGHSEC; ammoLeft < rate -> NO_AMMO, zero damage", () => {
    const v = areaScene("pd");
    const { f, spy } = v;
    assert.deepStrictEqual(f.access.listWeapons(f.twin).filter((w) => w.kind === "area")
      .map((w) => [w.needsAmmo, w.chargeItemId, w.chargeQuantity]), [[true, 2005, 30]]);
    assert.deepStrictEqual(f.access.weaponRange(f.twin, AREA), { ok: true, optimalM: 6000, falloffM: 0 });
    const out = f.access.fireVolley(f.scene, f.twin, AREA, f.rat, 500, { ammoLeft: 10.5, host: v.host });
    assert.deepStrictEqual(out, { ok: true, durationMs: 1000, data: { hit: true, applied: 150, destroyed: false,
      chargeItemId: 2005, chargeMode: "stack", chargesUsed: 3 } });
    const pd = spy.pdResolve[1];
    assert.deepStrictEqual([pd.chargeItem.itemID, pd.chargeItem.stacksize, pd.chargeItem.quantity, pd.scene === f.scene],
      [2005, 10, 10, true]);
    assert.deepStrictEqual(spy.consume, [[10, 3, 0]], "consumed before any damage");
    assert.deepStrictEqual([spy.evaluate, spy.record, spy.tether], [0, 0, 0]);
    assert.deepStrictEqual(spy.damage.map(([, id]) => id), [f.rat.itemID, 9000011]);
    assert.deepStrictEqual(f.calls.fx[0].slice(1, 2).concat([f.calls.fx[0][2].graphicInfo]),
      ["effects.PointDefense", { hitRange: 6000 }]);

    const hs = areaScene("pd");
    hs.f.scene.system = { security: 0.7 };
    assert.deepStrictEqual(hs.f.access.fireVolley(hs.f.scene, hs.f.twin, AREA, hs.f.rat, 1, { ammoLeft: 30,
      host: hs.host }), { ok: false, reason: "VENDOR_REFUSED", retryMs: 2000 });
    assert.deepStrictEqual(areaCounters(hs.f, ["combat.area.refused.MODULE_DISALLOWED_IN_HIGHSEC"]), [1]);
    for (const ammoLeft of [2, 0]) {
      const low = areaScene("pd");
      assert.deepStrictEqual(low.f.access.fireVolley(low.f.scene, low.f.twin, AREA, low.f.rat, 1, { ammoLeft,
        host: low.host }), { ok: false, reason: "NO_AMMO", retryMs: null });
      assert.deepStrictEqual([low.spy.exec, low.spy.damage.length, low.spy.pdResolve.length], [0, 0, ammoLeft > 0 ? 1 : 0]);
    }
  });

  const PROJ_ON = Object.freeze({ combatBreacherEnabled: true, combatBombsEnabled: true, combatBombMaxAngleDeg: 10,
    combatReacquireMs: 2000 });
  const PROJ = Object.freeze({ moduleId: 1002, flagId: 28 });
  const projScene = (kind, extra = {}) => {
    const family = kind === "breacher" ? "breacherPodLauncher" : "bombLauncher";
    const f = fixture({ config: PROJ_ON, rat: { hp: 100000 }, families: { 1002: family }, ...extra });
    const spy = { stage: [], resolve: [], exec: [], flights: [], timer: 0, vendorAggression: 0, vendorConsume: 0,
      damage: [] };
    const mod = f.twin.fittedItems[0];
    Object.assign(mod, kind === "breacher" ? { typeID: 87000, groupID: 4807 } : { typeID: 12346, groupID: 862 });
    f.twin.nativeCargoItems.push({ itemID: 2006, typeID: 27920, moduleID: 1002, quantity: 8 });
    Object.assign(f.twin, { ownerID: OWNER, position: { x: 0, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 } });
    f.rat.position = { x: 4000, y: 0, z: 0 };
    const d = f.deps;
    const baseSnapshot = d.buildWeaponSnapshotForEntity;
    d.buildWeaponSnapshotForEntity = (e, m, c, o) => (m.itemID === 1002 ? { family, chargeMode: "stack",
      durationMs: 10000, approxRange: 30000, maxVelocity: 2500, flightTimeMs: 12000, chargeTypeID: c.typeID }
      : baseSnapshot(e, m, c, o));
    d.isValidBreacherSnapshot = (s) => s.family === "breacherPodLauncher";
    d.isBombLauncher = (m) => m.groupID === 862;
    d.buildBombRuntimeCallbacks = () => ({
      allocateEntityID: () => 777, hasCurrentSourceOwner: () => false, publishBomb: () => {}, warn: () => {},
      consumeLoadedCharge: () => {
        spy.vendorConsume += 1;
        return { success: true, data: { nextQuantity: 0 } };
      },
      recordLaunch: () => { spy.timer += 1; },
      recordAggression: () => {
        spy.vendorAggression += 1;
        return { success: true };
      },
      applyDamage: (attacker, target) => spy.damage.push([attacker, target.itemID]),
    });
    d.stageBreacherLaunch = (input) => {
      spy.stage.push(input);
      if (extra.stageError) return { success: false, errorMsg: extra.stageError };
      const consumption = input.callbacks.consumeLoadedCharge(input.attacker, input.moduleItem, input.chargeItem,
        input.nowMs);
      return { success: true, data: { entity: { itemID: 778 }, consumption } };
    };
    d.resolveBombLauncherActivation = (input) => {
      spy.resolve.push(input);
      if (input.scene.system && input.scene.system.security > 0) {
        return { matched: true, success: false, errorMsg: "BOMB_IN_EMPIRE_SPACE" };
      }
      return { matched: true, success: true, data: { snapshot: { ...input.snapshot, blastRange: 15000 } } };
    };
    d.executeBombLaunchCycle = ({ entity, effectState, callbacks, nowMs, moduleItem, chargeItem }) => {
      spy.exec.push(effectState);
      if (effectState.bombLaunched === true) return { success: true, data: { duplicate: true } };
      const consumption = callbacks.consumeLoadedCharge(entity, moduleItem, chargeItem, nowMs);
      effectState.bombLaunched = true;
      if (typeof callbacks.recordLaunch === "function") callbacks.recordLaunch(entity, nowMs);
      spy.flights.push({ source: entity, callbacks });
      return { success: true, data: { entity: { itemID: 777 }, consumption } };
    };
    return { f, spy, d };
  };

  test("CB18 (tests 2+5) breacher: stageLaunch with the twin as the attacker and our "
    + "consumeLoadedCharge -> chargesUsed 1, no vendor consume; BREACHER_TARGET_LOST -> launchFailed, no charge; out "
    + "of approxRange -> OUT_OF_RANGE, no vendor call; registry: flags off -> unsupported.breacher|bomb and no "
    + "tokens, flags on -> `weapons=...,area,breacher,bomb`", () => {
    const { f, spy } = projScene("breacher");
    assert.deepStrictEqual(f.access.listWeapons(f.twin).filter((w) => w.moduleId === 1002).map((w) => [w.kind,
      w.steers, w.needsLock, w.needsAmmo, w.chargeItemId, w.keepsMoving]), [["breacher", true, true, true, 2006,
      undefined]]);
    assert.deepStrictEqual(f.access.weaponRange(f.twin, PROJ), { ok: true, optimalM: 30000, falloffM: 0 });
    const out = f.access.fireVolley(f.scene, f.twin, PROJ, f.rat, 9000, { ammoLeft: 8 });
    assert.deepStrictEqual(out, { ok: true, durationMs: 10000, data: { hit: false, applied: 0, destroyed: false,
      chargeItemId: 2006, chargeMode: "stack", chargesUsed: 1 } });
    const s = spy.stage[0];
    assert.deepStrictEqual([s.attacker === f.twin, s.target === f.rat, s.moduleItem.itemID, s.chargeItem.itemID,
      s.nowMs, s.scene === f.scene], [true, true, 1002, 2006, 9000, true]);
    assert.deepStrictEqual(s.callbacks.consumeLoadedCharge(), { success: true, data: { nextQuantity: 7 } });
    assert.deepStrictEqual([spy.vendorConsume, spy.timer, spy.vendorAggression], [0, 0, 0]);
    const counters = f.access.stats().counters;
    assert.deepStrictEqual([counters["combat.breacher.launched"], counters["combat.volley.fired"]], [1, 0]);

    const lost = projScene("breacher", { stageError: "BREACHER_TARGET_LOST" });
    assert.deepStrictEqual(lost.f.access.fireVolley(lost.f.scene, lost.f.twin, PROJ, lost.f.rat, 1, { ammoLeft: 8 }),
      { ok: false, reason: "LAUNCH_FAILED", retryMs: 2000 });
    assert.strictEqual(lost.f.access.stats().counters["combat.breacher.launchFailed.BREACHER_TARGET_LOST"], 1);
    const far = projScene("breacher", { distance: 31000 });
    assert.deepStrictEqual(far.f.access.fireVolley(far.f.scene, far.f.twin, PROJ, far.f.rat, 1, { ammoLeft: 8 }),
      { ok: false, reason: "OUT_OF_RANGE", retryMs: 2000 });
    assert.strictEqual(far.spy.stage.length, 0);

    for (const kind of ["breacher", "bomb"]) {
      const off = projScene(kind, { config: { combatReacquireMs: 2000 } });
      assert.deepStrictEqual(off.f.access.listWeapons(off.f.twin, { countUnsupported: true }).map((w) => w.kind),
        ["turret"]);
      assert.strictEqual(off.f.access.stats().counters[`combat.weapons.unsupported.${kind}`], 1);
      assert.deepStrictEqual(off.f.access.weaponKinds(), ["turret"]);
    }
    assert.ok(!COMBAT_COUNTER_NAMES.includes("combat.weapons.unsupported.projectile"));
    const all = projScene("bomb", { config: { ...PROJ_ON, ...AREA_ON, ...VORTON_ON, ...PRECURSOR_ON,
      combatMissilesEnabled: true } });
    assert.strictEqual(weaponsStatus({ combatAccess: all.f.access }, "ok"),
      "turret,missile,precursor,vorton,area,breacher,bomb");
    const drift = projScene("bomb", { consumers: (name) => name !== "combatBomb" });
    assert.deepStrictEqual(drift.f.access.weaponKinds(), ["turret", "breacher"]);
  });

  test("CB19 bomb start: an angle above combatBombMaxAngleDeg or a target beyond "
    + "the flight -> no start, no charge, aimMiss; BOMB_IN_EMPIRE_SPACE -> VENDOR_REFUSED + refused.<code>; success "
    + "-> chargesUsed 1, a new effectState per volley, no vendor weapon timer", () => {
    const { f, spy } = projScene("bomb");
    assert.deepStrictEqual(f.access.listWeapons(f.twin).filter((w) => w.moduleId === 1002).map((w) => [w.kind,
      w.steers, w.needsLock, w.keepsMoving]), [["bomb", false, false, true]]);
    assert.deepStrictEqual(f.access.weaponRange(f.twin, PROJ), { ok: true, optimalM: 30000, falloffM: 0 });
    for (const simMs of [9000, 19000]) {
      assert.deepStrictEqual(f.access.fireVolley(f.scene, f.twin, PROJ, f.rat, simMs, { ammoLeft: 8 }),
        { ok: true, durationMs: 10000, data: { hit: false, applied: 0, destroyed: false, chargeItemId: 2006,
          chargeMode: "stack", chargesUsed: 1 } });
    }
    assert.deepStrictEqual(spy.exec.map((e) => [e.bombLaunched, e.bombSnapshot.blastRange]), [[true, 15000],
      [true, 15000]]);
    assert.notStrictEqual(spy.exec[0], spy.exec[1], "a new effectState per volley");
    assert.deepStrictEqual([spy.timer, spy.vendorConsume, spy.vendorAggression], [0, 0, 0]);
    assert.strictEqual(f.access.stats().counters["combat.bomb.launched"], 2);

    const aim = projScene("bomb");
    aim.f.rat.position = { x: 3000, y: 2000, z: 0 };
    const far = projScene("bomb", { distance: 30001 });
    for (const v of [aim, far]) {
      assert.deepStrictEqual(v.f.access.fireVolley(v.f.scene, v.f.twin, PROJ, v.f.rat, 1, { ammoLeft: 8 }),
        { ok: false, reason: "OUT_OF_RANGE", retryMs: 2000 });
      assert.deepStrictEqual([v.spy.resolve.length, v.spy.exec.length], [0, 0]);
    }
    assert.deepStrictEqual([aim.f.access.stats().counters["combat.bomb.aimMiss"],
      far.f.access.stats().counters["combat.bomb.aimMiss"]], [1, 0]);
    const wide = projScene("bomb", { config: { ...PROJ_ON, combatBombMaxAngleDeg: 40 } });
    wide.f.rat.position = { x: 3000, y: 2000, z: 0 };
    assert.strictEqual(wide.f.access.fireVolley(wide.f.scene, wide.f.twin, PROJ, wide.f.rat, 1, { ammoLeft: 8 }).ok,
      true);

    const empire = projScene("bomb");
    empire.f.scene.system = { security: 0.3 };
    assert.deepStrictEqual(empire.f.access.fireVolley(empire.f.scene, empire.f.twin, PROJ, empire.f.rat, 1,
      { ammoLeft: 8 }), { ok: false, reason: "VENDOR_REFUSED", retryMs: 2000 });
    assert.deepStrictEqual(["combat.bomb.refused.BOMB_IN_EMPIRE_SPACE", "combat.volley.skip.VENDOR_REFUSED"]
      .map((n) => empire.f.access.stats().counters[n]), [1, 1]);
    assert.strictEqual(empire.spy.exec.length, 0);
  });

  test("CB20 bomb blast: the kept callbacks, called after the twin left the scene and "
    + "without a host: recordAggression succeeds only for the 3 NPCs (also one far from the host); the player, the "
    + "host and another twin get no damage; blast.hit / blast.skipped counted", () => {
    const { f, spy } = projScene("bomb");
    const add = (e) => {
      f.entities.set(e.itemID, e);
      return e;
    };
    const npcA = add(makeRat({ itemID: 9000011 }));
    const far = add(makeRat({ itemID: 9000018, hostDistM: 900000 }));
    const host = add({ itemID: 9000014, kind: "ship", characterID: OWNER, session: { characterID: OWNER }, hp: 1000 });
    const player = add({ itemID: 9000013, kind: "ship", characterID: OTHER, session: { characterID: OTHER }, hp: 1000 });
    const otherTwin = add({ itemID: 9000015, kind: "ship", pilotCharacterID: OTHER, characterID: 0, ownerID: OTHER,
      hp: 1000 });
    assert.strictEqual(f.access.fireVolley(f.scene, f.twin, PROJ, f.rat, 9000, { ammoLeft: 8 }).ok, true);
    const flight = spy.flights[0];
    f.entities.delete(f.twin.itemID);
    f.entities.delete(host.itemID);
    const detonate = [f.rat, npcA, far, player, otherTwin, host].filter((t) => {
      const aggression = flight.callbacks.recordAggression(flight.source, t, 20000);
      if (!aggression || aggression.success !== true) return false;
      flight.callbacks.applyDamage(flight.source, t);
      return true;
    }).map((t) => t.itemID);
    assert.deepStrictEqual(detonate, [f.rat.itemID, 9000011, 9000018]);
    assert.deepStrictEqual(spy.damage.map(([, id]) => id), [f.rat.itemID, 9000011, 9000018]);
    assert.strictEqual(flight.callbacks.hasCurrentSourceOwner(f.twin), true);
    assert.deepStrictEqual(["combat.bomb.blast.hit", "combat.bomb.blast.skipped"]
      .map((n) => f.access.stats().counters[n]), [3, 3]);
    assert.deepStrictEqual([spy.vendorAggression, spy.timer], [0, 0], "no crimewatch, no weapon timer");
    assert.deepStrictEqual(flight.callbacks.recordAggression(null, undefined), { success: false }, "never throws");
  });

  test("CB21 (bug-review pkt 5-7,..3) a scene without broadcastSpecialFx: turret volley ok "
    + "no combat.fx.error; the FX helpers of area and Vorton are optional probe rows and their absence is no error; "
    + "breacher: a target isBreacherPodTarget refuses -> BREACHER_TARGET_INVALID, no stageLaunch, no vendor warn; no "
    + "symbol or a throw -> the launch as before", () => {
    const t = fixture({ rat: { hp: 1000 } });
    delete t.scene.broadcastSpecialFx;
    assert.strictEqual(t.access.fireVolley(t.scene, t.twin, WEAPON, t.rat, 1).ok, true);
    assert.strictEqual(t.access.stats().counters["combat.fx.error"], 0);

    const lacking = ["buildGenericModuleSpecialFxGraphicInfo", "broadcastVortonCycleSpecialFx"];
    assert.ok(lacking.every((name) => GAME_MODULES.some((m) => m.symbols.some((s) => s.name === name
      && s.optional === true))), "both rows optional");
    const table = GAME_MODULES.map((m) => ({ path: m.path, symbols: m.symbols.filter((s) => ["combatArea",
      "combatVorton", "combatAuto"].includes(s.consumer)) })).filter((m) => m.symbols.length > 0);
    class SolarSystemScene { constructor() { this.dynamicEntities = new Map(); } }
    const exportsOf = () => {
      const e = { SolarSystemScene };
      for (const s of table.flatMap((m) => m.symbols)) {
        if (s.kind === "export" && !lacking.includes(s.name)) e[s.name] = () => null;
      }
      return { ok: true, exports: e };
    };
    const report = probeModules(table, exportsOf);
    assert.deepStrictEqual(report.disabled, {}, formatProbeLog(report).join("\n"));
    assert.ok(formatProbeLog(report).some((l) => l.includes("(affects: combatArea (optional))")));
    const sb = areaScene("sb");
    delete sb.d.buildGenericModuleSpecialFxGraphicInfo;
    assert.strictEqual(sb.f.access.fireVolley(sb.f.scene, sb.f.twin, AREA, sb.f.rat, 9000, { ammoLeft: Infinity,
      host: sb.host }).ok, true);
    assert.deepStrictEqual([sb.f.calls.fx.length, sb.f.calls.fx[0][2].graphicInfo,
      sb.f.access.stats().counters["combat.fx.error"]], [1, null, 0], "the FX without graphicInfo, no error");
    const vo = vortonScene();
    delete vo.f.deps.broadcastVortonCycleSpecialFx;
    assert.strictEqual(vo.f.access.fireVolley(vo.f.scene, vo.f.twin, VORTON, vo.f.rat, 9000, { ammoLeft: 40,
      host: vo.host }).ok, true);
    assert.deepStrictEqual([vo.f.calls.vfx.length, vo.f.access.stats().counters["combat.fx.error"]], [0, 0]);

    assert.ok(GAME_MODULES.some((m) => m.path === "space/combat/breacherPods" && m.symbols.some((s) =>
      s.name === "isBreacherPodTarget" && s.consumer === "combatBreacher" && s.optional === true)));
    const bad = projScene("breacher");
    const asked = [];
    let warned = 0;
    const vendorCallbacks = bad.d.buildBombRuntimeCallbacks;
    bad.d.buildBombRuntimeCallbacks = (scene) => ({ ...vendorCallbacks(scene), warn: () => { warned += 1; } });
    bad.d.isBreacherPodTarget = (target, listID) => {
      asked.push([target.itemID, listID]);
      return target.typeID !== 23;
    };
    assert.deepStrictEqual(bad.f.access.fireVolley(bad.f.scene, bad.f.twin, PROJ, bad.f.rat, 1, { ammoLeft: 8 }),
      { ok: false, reason: "BREACHER_TARGET_INVALID", retryMs: 2000 });
    assert.deepStrictEqual([asked.length, asked[0][0], bad.spy.stage.length, warned], [1, bad.f.rat.itemID, 0, 0]);
    assert.strictEqual(bad.f.access.stats().counters["combat.volley.skip.BREACHER_TARGET_INVALID"], 1);
    bad.f.rat.typeID = 24;
    assert.strictEqual(bad.f.access.fireVolley(bad.f.scene, bad.f.twin, PROJ, bad.f.rat, 2, { ammoLeft: 8 }).ok, true);
    assert.strictEqual(bad.spy.stage.length, 1);
    for (const variant of ["none", "throws"]) {
      const p = projScene("breacher");
      if (variant === "throws") p.d.isBreacherPodTarget = () => { throw new Error("list gone"); };
      assert.strictEqual(p.f.access.fireVolley(p.f.scene, p.f.twin, PROJ, p.f.rat, 1, { ammoLeft: 8 }).ok, true,
        `${variant}as before`);
      assert.strictEqual(p.spy.stage.length, 1);
    }
  });

  test("AC1 autoCandidates: one pass over dynamicEntities keeps only allowed NPCs within rangeM of "
    + "the host (no player, CONCORD, twin, drone, destroying, far); maxEntities cuts (truncated + counter); no "
    + "combatAuto -> UNAVAILABLE; no Map -> NO_SCENE + error; vendor facts and the GAME_MODULES row", () => {
    const f = fixture();
    const add = (e) => {
      f.entities.set(e.itemID, e);
      return e;
    };
    const host = add({ itemID: 9000014, kind: "ship", characterID: OWNER, session: { characterID: OWNER }, hp: 1000 });
    add(makeRat({ itemID: 9000012, hostDistM: 2000 }));
    add({ itemID: 9000013, kind: "ship", characterID: OTHER, session: { characterID: OTHER }, hp: 1000 });
    add({ itemID: 9000015, kind: "ship", nativeNpc: true, pilotCharacterID: OTHER, characterID: 0, hp: 1000 });
    add({ itemID: 9000016, kind: "drone", nativeNpc: true, hp: 1000 });
    add(makeRat({ itemID: 9000017, npcEntityType: "concord" }));
    add(makeRat({ itemID: 9000018, destroying: true }));
    add(makeRat({ itemID: 9000019, hostDistM: 12000 }));
    const refusedBefore = TARGET_REFUSED(f);
    const out = f.access.autoCandidates(f.scene, f.twin, host, { rangeM: 10000, maxEntities: 2000 });
    assert.deepStrictEqual(out, { ok: true, candidates: [{ id: 9000001, hostDistanceM: 4000 },
      { id: 9000012, hostDistanceM: 2000 }], scanned: 10, truncated: false });
    assert.strictEqual(TARGET_REFUSED(f), refusedBefore, "no refusal counters");
    assert.strictEqual(f.access.autoAvailable(), true);
    const cut = f.access.autoCandidates(f.scene, f.twin, host, { rangeM: 10000, maxEntities: 3 });
    assert.deepStrictEqual(cut, { ok: true, candidates: [{ id: 9000001, hostDistanceM: 4000 }], scanned: 3,
      truncated: true });
    assert.strictEqual(f.access.stats().counters["combat.auto.scan.truncated"], 1);

    const drift = fixture({ consumers: (name) => name !== "combatAuto" });
    assert.strictEqual(drift.access.autoAvailable(), false);
    assert.deepStrictEqual(drift.access.autoCandidates(drift.scene, drift.twin, host, { rangeM: 10000,
      maxEntities: 2000 }), { ok: false, reason: "UNAVAILABLE" });
    assert.deepStrictEqual(f.access.autoCandidates(f.scene, f.twin, null, { rangeM: 1, maxEntities: 1 }),
      { ok: false, reason: "NO_HOST" });
    f.scene.dynamicEntities = [...f.entities.values()];
    assert.deepStrictEqual(f.access.autoCandidates(f.scene, f.twin, host, { rangeM: 10000, maxEntities: 2000 }),
      { ok: false, reason: "NO_SCENE" });
    assert.strictEqual(f.access.stats().counters["combat.auto.scan.error"], 1);

    const server = path.resolve(__dirname, "..", "..", "..", "..", "server", "src", "space", "runtime");
    const read = (name) => fs.readFileSync(path.join(server, name), "utf8").replace(/\r\n/g, "\n");
    assert.ok(read("solarSystemScene.js").includes("this.dynamicEntities = new ForceFieldIndexedEntityMap()"));
    assert.ok(read("forceFieldContainment.js").includes("class ForceFieldIndexedEntityMap extends Map"));
    assert.deepStrictEqual(GAME_MODULES.flatMap((m) => m.symbols.filter((s) => s.consumer === "combatAuto")
      .map((s) => [m.path, s.name, s.kind, s.exportName, s.wrap === true, s.firstLoad === true,
        s.optional === true])),
    [["space/runtime/solarSystemScene", "dynamicEntities", "exportClassInstanceField", "SolarSystemScene", false,
      false, false]]);
  });

  test("CA-S an NPC site structure in staticEntitiesByID: checkTarget -> ok "
    + "combat.target.structure 1; targetAllowed (area, Vorton) and npcAllowed (bomb) -> false; no damageable health "
    + "-> TARGET_NOT_NPC; autoCandidates never lists it (also when it sits in dynamicEntities)", () => {
    const STRUCT_ON = { combatAllowNpcStructureTargets: true };
    const makeHabitat = () => ({ itemID: 9500002, kind: "siteEnvironmentProp", typeID: 17401, groupID: 319,
      categoryID: 11, ownerID: 1, dungeonMaterializedSiteContent: true, dungeonMaterializedEnvironment: true,
      hp: 1000 });
    const f = fixture({ config: STRUCT_ON });
    const habitat = makeHabitat();
    const statics = new Map([[habitat.itemID, habitat]]);
    f.scene.staticEntitiesByID = statics;
    f.scene.getEntityByID = (id) => f.entities.get(id) || statics.get(id) || null;
    const host = { itemID: 9000014, kind: "ship", characterID: OWNER, session: { characterID: OWNER }, hp: 1000 };
    f.entities.set(host.itemID, host);
    assert.deepStrictEqual(f.access.checkTarget(f.scene, f.twin, host, habitat), { ok: true });
    assert.strictEqual(f.access.stats().counters["combat.target.structure"], 1);
    assert.deepStrictEqual(f.access.checkTarget(f.scene, f.twin, host, f.rat), { ok: true });
    assert.strictEqual(f.access.stats().counters["combat.target.structure"], 1, "a ship is not counted");

    const v = areaScene("sb", { config: { ...AREA_ON, ...STRUCT_ON } });
    const hab2 = makeHabitat();
    v.f.entities.set(hab2.itemID, hab2);
    assert.strictEqual(v.f.access.fireVolley(v.f.scene, v.f.twin, AREA, v.f.rat, 9000, { ammoLeft: Infinity,
      host: v.host }).ok, true);
    assert.ok(v.spy.damage.some(([, id]) => id === v.f.rat.itemID));
    assert.ok(!v.spy.damage.some(([, id]) => id === hab2.itemID), "area: ships only");
    assert.strictEqual(hab2.hp, 1000);
    const b = projScene("bomb", { config: { ...PROJ_ON, ...STRUCT_ON } });
    const hab3 = makeHabitat();
    b.f.entities.set(hab3.itemID, hab3);
    assert.strictEqual(b.f.access.fireVolley(b.f.scene, b.f.twin, PROJ, b.f.rat, 9000, { ammoLeft: 8 }).ok, true);
    const flight = b.spy.flights[0];
    const blast = (t) => flight.callbacks.recordAggression(flight.source, t, 20000);
    assert.strictEqual(blast(b.f.rat).success, true);
    assert.notStrictEqual(blast(hab3).success, true, "bomb blast: ships only");

    habitat.hp = 0;
    assert.deepStrictEqual(f.access.checkTarget(f.scene, f.twin, host, habitat),
      { ok: false, reason: "TARGET_NOT_NPC" }, "hasDamageableHealth false");
    habitat.hp = 1000;
    f.entities.set(habitat.itemID, habitat);
    const out = f.access.autoCandidates(f.scene, f.twin, host, { rangeM: 10000, maxEntities: 2000 });
    assert.deepStrictEqual(out.candidates.map((c) => c.id), [f.rat.itemID], "auto-target: no structures");
  });

  test("CA-S2 checkTarget reads hasDamageableHealth only with combatAllowNpcStructureTargets and "
    + "for a non-ship target: a ship (flag on or off) and a structure with the flag off = no vendor call", () => {
    const habitat = () => ({ itemID: 9500003, kind: "siteEnvironmentProp", typeID: 17401, groupID: 319,
      categoryID: 11, ownerID: 1, dungeonMaterializedSiteContent: true, dungeonMaterializedEnvironment: true,
      hp: 1000 });
    const run = (config) => {
      const f = fixture({ config });
      const seen = [];
      const health = f.deps.hasDamageableHealth;
      f.deps.hasDamageableHealth = (e) => {
        seen.push(e.itemID);
        return health(e);
      };
      const hab = habitat();
      f.entities.set(hab.itemID, hab);
      const host = { itemID: 9000015, kind: "ship", characterID: OWNER, session: { characterID: OWNER }, hp: 1000 };
      f.entities.set(host.itemID, host);
      const ship = f.access.checkTarget(f.scene, f.twin, host, f.rat);
      const struct = f.access.checkTarget(f.scene, f.twin, host, hab);
      return { seen, ship, struct, hab };
    };
    const off = run({ combatAllowNpcStructureTargets: false });
    assert.deepStrictEqual([off.seen, off.ship.ok, off.struct.ok], [[], true, false]);
    const on = run({ combatAllowNpcStructureTargets: true });
    assert.deepStrictEqual([on.seen, on.ship.ok, on.struct.ok], [[on.hab.itemID], true, true],
      "only the structure is read");
  });
};

function TARGET_REFUSED(f) {
  const c = f.access.stats().counters;
  return Object.keys(c).filter((k) => k.startsWith("combat.target.refused.")).reduce((sum, k) => sum + c[k], 0);
}
