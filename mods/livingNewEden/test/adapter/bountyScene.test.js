"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const killObservation = require("../../lib/adapter/killObservation");
const bountyVictims = require("../../lib/adapter/bountyVictims");
const liveProfiles = require("../../lib/adapter/data/liveProfiles");
const { createNpcSpawn } = require("../../lib/adapter/npcSpawn");
const dormancyGuard = require("../../lib/adapter/dormancyGuard");
const { GAME_MODULES } = require("../../lib/adapter/gameModules");

const SERVER_SRC = path.resolve(__dirname, "..", "..", "..", "..", "server", "src");
const SYSTEM = 30002510;
const BOSS = 9100000001;

function readSource(rel) {
  return fs.readFileSync(path.join(SERVER_SRC, rel), "utf8").replace(/\r\n/g, "\n");
}

module.exports = ({ test }) => {
  test("L1 a registered bounty ship reaches only the bounty listener ({skipped:\"BOUNTY\"} for the world)", () => {
    bountyVictims.resetBountyVictimsForTests();
    const seen = { liberation: 0, standings: 0, playerActivity: 0, frontJobs: 0, bounty: [] };
    const world = (name) => ({ onNpcKill() { seen[name] += 1; return { ok: true }; } });
    const bountyListener = { onNpcKill(obs) { seen.bounty.push(obs); return { ok: true, outcome: "KILLED" }; } };
    const deps = { resolveVictimFactionID: () => 500010, getLiberation: () => world("liberation"),
      getStandings: () => world("standings"), getPlayerActivity: () => world("playerActivity"),
      getFrontJobs: () => world("frontJobs"), bountyShipOf: bountyVictims.bountyShipOf, getBounty: () => bountyListener };
    assert.deepStrictEqual(bountyVictims.markBountyShips([BOSS], { wantedId: "bnt:3:1", version: 4, role: "boss",
      cap: 64 }), { ok: true, marked: 1, evicted: 0 });
    const r = killObservation.observeKill(null, { itemID: BOSS, systemID: SYSTEM, warFactionID: 500010 }, 42,
      { nowMs: 1700000000000, systemID: SYSTEM }, deps);
    assert.strictEqual(r.skipped, "BOUNTY");
    assert.deepStrictEqual(r.bounty, { ok: true, outcome: "KILLED" });
    assert.deepStrictEqual(seen.bounty, [{ characterId: 42, victimId: BOSS, wantedId: "bnt:3:1", version: 4,
      role: "boss", systemId: SYSTEM, atMs: 1700000000000 }]);
    assert.deepStrictEqual([seen.liberation, seen.standings, seen.playerActivity, seen.frontJobs], [0, 0, 0, 0]);
    const before = killObservation.killObservationCounters().bountyVictimSeen;
    killObservation.setBounty(bountyListener);
    killObservation.setLiberation(world("liberation"));
    try {
      const wrap = killObservation.wrapNpcKillStandingLoss(() => ({ applied: true }),
        { resolveVictimFactionID: () => 500010 });
      wrap.wrapped({ itemID: BOSS, systemID: SYSTEM }, 43, { nowMs: 5, systemID: SYSTEM });
      assert.strictEqual(seen.bounty.length, 2);
      assert.strictEqual(seen.bounty[1].characterId, 43);
      assert.strictEqual(seen.liberation, 0);
      assert.strictEqual(killObservation.killObservationCounters().bountyVictimSeen, before + 1);
      bountyVictims.forgetBountyShips([BOSS]);
      wrap.wrapped({ itemID: BOSS, systemID: SYSTEM }, 43, { nowMs: 6, systemID: SYSTEM });
      assert.deepStrictEqual([seen.bounty.length, seen.liberation], [2, 1]);
    } finally {
      killObservation.setBounty(null);
      killObservation.setLiberation(null);
      bountyVictims.resetBountyVictimsForTests();
    }
  });

  test("L3 spawnShip purpose bounty: slimNameOverride, lneBounty, no ownerIDOverride; BOUNTY_BEHAVIOR keys; vendor "
    + "facts; GAME_MODULES consumer", () => {
    const spawns = [];
    const modules = {
      "space/runtime": { isSolarSystemSceneLoaded: (id) => id === SYSTEM, scenes: new Map() },
      "space/npc/nativeNpcService": { spawnNativeNpcEntityInSystem: (systemId, options) => {
        spawns.push([systemId, options]);
        return { success: true, data: { entity: { itemID: BOSS + spawns.length } } };
      } },
    };
    const requireGame = (rel) => (modules[rel] ? { ok: true, exports: modules[rel] } : { ok: false, reason: "missing" });
    const spawn = createNpcSpawn({ requireGame, navyProfiles: {}, data: liveProfiles });
    const anchorDescriptor = { kind: "entity", itemID: 40000001 };
    const r = spawn.spawnShip(SYSTEM, { profileId: "parity_guristas_frigate_1", anchorDescriptor, purpose: "bounty",
      archetype: "RUNNER", slimName: "Kaito 'Viper' Ishimura", ownerId: 98000001 });
    assert.deepStrictEqual(r, { ok: true, entityId: BOSS + 1 });
    const o = spawns[0][1];
    assert.strictEqual(o.slimNameOverride, "Kaito 'Viper' Ishimura");
    assert.strictEqual(o.operatorKind, "lneBounty");
    assert.ok(!Object.prototype.hasOwnProperty.call(o, "ownerIDOverride"), "never ownerIDOverride");
    assert.deepStrictEqual(o.behaviorOverrides, { autoAggro: false, proximityAggroRangeMeters: 0 });
    assert.deepStrictEqual([o.transient, o.broadcast], [true, false]);
    spawn.spawnShip(SYSTEM, { profileId: "p", anchorDescriptor, purpose: "bounty", archetype: "ESCORT" });
    assert.ok(!Object.prototype.hasOwnProperty.call(spawns[1][1], "slimNameOverride"));
    spawn.spawnShip(SYSTEM, { profileId: "p", anchorDescriptor, purpose: "bounty", archetype: "KITER", capital: true });
    assert.deepStrictEqual(spawns[2][1].behaviorOverrides, { autoAggro: true, autoActivateWeapons: true });
    for (const bad of [{ archetype: "PIRATE" }, { archetype: "RUNNER", slimName: "<b>x</b>" },
      { archetype: "RUNNER", slimName: "ab" }, { archetype: "RUNNER", guard: {} }]) {
      assert.strictEqual(spawn.spawnShip(SYSTEM, { profileId: "p", anchorDescriptor, purpose: "bounty", ...bad }).reason,
        "INVALID_INPUT", JSON.stringify(bad));
    }
    for (const id of [BOSS + 1, BOSS + 2, BOSS + 3]) dormancyGuard.release(id);

    for (const [name, b] of Object.entries(liveProfiles.BOUNTY_BEHAVIOR)) {
      for (const key of ["allowFriendlyNpcTargets", "targetPreference", "autoAggroTargetClasses"]) {
        assert.ok(!Object.prototype.hasOwnProperty.call(b, key), `${name}.${key}`);
      }
    }

    const native = readSource("space/npc/nativeNpcService.js");
    assert.ok(native.includes("options.slimNameOverride"), "slimNameOverride");
    const inSystem = native.slice(native.indexOf("function spawnNativeNpcEntityInSystem("));
    assert.ok(inSystem.slice(0, inSystem.indexOf("\n}\n")).includes("...options,"), "...options in InSystem");
    assert.ok(readSource("space/npc/npcBehaviorLoop.js").includes("manualOrder.type === \"warpOff\""), "warpOff");
    assert.ok(readSource("services/security/crimewatchState.js").includes("\"NON_PLAYER_COMBAT\""), "NON_PLAYER_COMBAT");
    assert.ok(readSource("space/npc/npcDefaultConcordRules.js")
      .includes("npcDefaultConcordGateAutoAggroNpcsEnabled === true"), "gate NPC aggro only under the flag");

    const consumer = (p, name) => (GAME_MODULES.find((e) => e.path === p && e.symbols.some((s) => s.name === name))
      || { symbols: [] }).symbols.find((s) => s.name === name && s.consumers.includes("bounty"));
    for (const [p, name] of [["space/npc/nativeNpcService", "spawnNativeNpcEntityInSystem"],
      ["space/npc/nativeNpcService", "spawnNativeDefinitionsInContext"], ["space/npc/beltRatRuntime",
        "buildBeltRatSpawnPlan"], ["space/npc/npcService", "getControllerByEntityID"],
      ["space/npc/npcService", "issueManualOrder"], ["space/npc/npcService", "wakeNpcController"],
      ["space/runtime", "isSolarSystemSceneLoaded"], ["space/runtime", "scenes"]]) {
      assert.ok(consumer(p, name), `${p}.${name}`);
    }
  });

  test("L4: spawnGroup wakes the autoAggro ships after the publish "
    + "(BRAWLER / KITER boss, ESCORT), never a passive archetype; a refused / throwing wake is counted; vendor facts",
  () => {
    const native = readSource("space/npc/nativeNpcService.js");
    const record = native.slice(native.indexOf("function buildNativeControllerRecord("));
    assert.match(record.slice(0, record.indexOf("\n}\n")),
      /options\.skipInitialBehaviorTick === true \|\|[\s\S]{0,80}\? Number\.MAX_SAFE_INTEGER/);
    assert.ok(readSource("space/npc/npcBehaviorLoop.js")
      .includes("if (toFiniteNumber(controller.nextThinkAtMs, 0) > now) {"), "think gate");
    const spawnSrc = fs.readFileSync(path.join(__dirname, "..", "..", "lib", "adapter", "npcSpawn.js"), "utf8");
    const bountyCall = spawnSrc.slice(spawnSrc.indexOf("bounty !== null ? {"));
    assert.ok(bountyCall.slice(0, bountyCall.indexOf("} : {")).includes("skipInitialBehaviorTick: true"),
      "the bounty spawn skips the initial tick");

    const bountyScene = require("../../lib/adapter/bountyScene");
    const belt = { kind: "asteroidBelt", itemID: 40000001, position: { x: 1, y: 2, z: 3 } };
    const scenes = new Map([[SYSTEM, { staticEntities: [belt], getEntityByID: () => null }]]);
    const calls = [];
    let wakeMode = "ok";
    const npc = { getControllerByEntityID() {}, issueManualOrder() {},
      wakeNpcController(id, when) {
        calls.push(["wake", id, when]);
        if (wakeMode === "throw") throw new Error("boom");
        return wakeMode === "refuse" ? { success: false, errorMsg: "NPC_NOT_FOUND" } : { success: true };
      } };
    const modules = { "space/runtime": { isSolarSystemSceneLoaded: (id) => scenes.has(id), scenes },
      "space/npc/npcService": npc };
    let next = 8000000;
    const spawn = { resolveProfiles: () => ({ ok: true, profiles: ["parity_guristas_frigate_1"] }),
      spawnShip: () => ({ ok: true, entityId: (next += 1) }),
      publish: (_sys, ids) => { calls.push(["publish", ids.slice()]); return { ok: true }; },
      despawn: () => ({ ok: true }) };
    const seam = bountyScene.createBountyScene({ requireGame: (rel) => (modules[rel] ? { ok: true,
      exports: modules[rel] } : { ok: false }), getSpawn: () => spawn, getSpawnTools: () => ({ ok: false }) });
    const spec = (archetype, extra = {}) => ({ systemId: SYSTEM, anchor: { kind: "belt", index: 0 }, factionId: 500010,
      boss: { kind: "hull", hullClass: "frigate" }, escorts: [{ hullClass: "frigate" }], slimName: "Bo Brawler",
      archetype, seedKey: "bnt:1:1", ...extra });

    const r = seam.spawnGroup(spec("BRAWLER"));
    assert.deepStrictEqual([r.ok, r.bossId, r.escortIds, r.wake], [true, 8000001, [8000002], { woken: 2, failed: 0 }]);
    assert.deepStrictEqual(calls, [["publish", [8000001, 8000002]], ["wake", 8000001, 0], ["wake", 8000002, 0]],
      "boss and escort woken after the publish");
    calls.length = 0;
    assert.deepStrictEqual(seam.spawnGroup(spec("KITER")).wake, { woken: 2, failed: 0 });
    calls.length = 0;
    assert.deepStrictEqual(seam.spawnGroup(spec("RUNNER")).wake, { woken: 1, failed: 0 });
    assert.deepStrictEqual(calls.filter((c) => c[0] === "wake").map((c) => c[1]), [8000006]);
    calls.length = 0;
    assert.deepStrictEqual(seam.spawnGroup(spec("SMUGGLER")).wake, { woken: 1, failed: 0 });
    assert.deepStrictEqual(calls.filter((c) => c[0] === "wake").map((c) => c[1]), [8000008]);
    calls.length = 0;
    assert.deepStrictEqual(seam.spawnGroup(spec("HUNTER")).wake, { woken: 0, failed: 0 });
    assert.strictEqual(calls.filter((c) => c[0] === "wake").length, 0, "passive archetypes never woken");
    assert.deepStrictEqual(seam.spawnGroup(spec("AMBUSH", { escorts: [] })).wake, { woken: 0, failed: 0 });
    const late = seam.spawnGroup(spec("AMBUSH", { boss: null, slimName: null, anchor: { kind: "belt", index: 0 } }));
    assert.deepStrictEqual([late.ok, late.bossId, late.wake], [true, null, { woken: 1, failed: 0 }]);
    wakeMode = "refuse";
    const refused = seam.spawnGroup(spec("BRAWLER"));
    assert.deepStrictEqual([refused.ok, refused.wake], [true, { woken: 0, failed: 2 }]);
    wakeMode = "throw";
    const thrown = seam.spawnGroup(spec("BRAWLER"));
    assert.deepStrictEqual([thrown.ok, thrown.wake], [true, { woken: 0, failed: 2 }]);
    for (let id = 8000001; id <= next; id += 1) dormancyGuard.release(id);
  });

  test("BTA4: fleeToGate picks the gate by destinationSolarSystemID, align + warp without "
    + "forceImmediateStart, TOO_CLOSE -> approach, in range -> atGate; jumpAtGate JumpOut at the gate; gateTo anchor",
  () => {
    const bountyScene = require("../../lib/adapter/bountyScene");
    const TO = 30002511;
    const belt = { kind: "asteroidBelt", itemID: 40000001, position: { x: -5e6, y: 0, z: 0 } };
    const gate = { kind: "stargate", itemID: 50000010, destinationSolarSystemID: TO, radius: 5000,
      position: { x: 1e7, y: 0, z: 0 } };
    const other = { kind: "stargate", itemID: 50000005, destinationSolarSystemID: 30002599, radius: 5000,
      position: { x: 0, y: 1e7, z: 0 } };
    const boss = { itemID: BOSS, kind: "ship", mode: "STOP", position: { x: 0, y: 0, z: 0 } };
    const calls = [];
    let warpResult = { success: true };
    let fxThrows = false;
    const scene = { staticEntities: [belt, other, gate],
      getEntityByID: (id) => (id === BOSS ? boss : null),
      warpDynamicEntityToPoint(...args) {
        calls.push(["warp", ...args]);
        return warpResult;
      },
      broadcastSpecialFx(...args) {
        calls.push(["fx", ...args]);
        if (fxThrows) throw new Error("fx");
      } };
    const npc = { getControllerByEntityID: (id) => (id === BOSS ? { lastAggressorID: 0 } : null),
      issueManualOrder(id, order) { calls.push(["order", id, order]); return { success: true }; },
      wakeNpcController(id, at) { calls.push(["wake", id, at]); return { success: true }; } };
    const modules = { "space/runtime": { isSolarSystemSceneLoaded: (id) => id === SYSTEM,
      scenes: new Map([[SYSTEM, scene]]) }, "space/npc/npcService": npc };
    let next = 8100000;
    const spawn = { resolveProfiles: () => ({ ok: true, profiles: ["parity_guristas_frigate_1"] }),
      spawnShip: (_sys, o) => {
        calls.push(["spawn", o.anchorDescriptor.itemID]);
        return { ok: true, entityId: (next += 1) };
      },
      publish: () => ({ ok: true }), despawn: () => ({ ok: true }) };
    const seam = bountyScene.createBountyScene({ requireGame: (rel) => (modules[rel] ? { ok: true,
      exports: modules[rel] } : { ok: false }), getSpawn: () => spawn, getSpawnTools: () => ({ ok: false }) });
    assert.ok(bountyScene.SEAM_METHODS.includes("fleeToGate") && bountyScene.SEAM_METHODS.includes("jumpAtGate"));
    const o = { landingMeters: 2000, jumpRangeMeters: 2500 };

    assert.deepStrictEqual(seam.fleeToGate(SYSTEM, BOSS, TO, o), { ok: true, gateId: 50000010, mode: "warp" });
    const landing = { x: 1e7 - 7000, y: 0, z: 0 };
    assert.deepStrictEqual(calls, [["order", BOSS, { type: "align", direction: landing }], ["wake", BOSS, 0],
      ["warp", boss, landing]], "align + wake, then a plain warp (no options = no forceImmediateStart)");
    assert.deepStrictEqual(seam.fleeToGate(SYSTEM, BOSS, 30002600, o), { ok: false, reason: "NO_GATE" });
    assert.strictEqual(seam.fleeToGate(SYSTEM, BOSS + 1, TO, o).reason, "GONE");
    assert.strictEqual(seam.fleeToGate(SYSTEM, BOSS, TO, { landingMeters: -1, jumpRangeMeters: 1 }).reason,
      "INVALID_INPUT");
    warpResult = { success: false, errorMsg: "WARP_DISTANCE_TOO_CLOSE" };
    assert.deepStrictEqual(seam.fleeToGate(SYSTEM, BOSS, TO, o), { ok: true, gateId: 50000010, mode: "approach" });
    warpResult = { success: false, errorMsg: "WARP_SCRAMBLED" };
    assert.deepStrictEqual(seam.fleeToGate(SYSTEM, BOSS, TO, o), { ok: false, reason: "ORDER_FAILED",
      detail: "WARP_SCRAMBLED" });

    calls.length = 0;
    assert.deepStrictEqual(seam.jumpAtGate(SYSTEM, BOSS, 50000010, o), { ok: true, jumped: false,
      distanceMeters: 1e7 - 5000 });
    boss.position = { x: 1e7 - 6000, y: 0, z: 0 };
    assert.deepStrictEqual(seam.fleeToGate(SYSTEM, BOSS, TO, o), { ok: true, gateId: 50000010, mode: "atGate" });
    assert.deepStrictEqual(calls, [], "atGate: nothing ordered");
    boss.mode = "WARP";
    assert.strictEqual(seam.jumpAtGate(SYSTEM, BOSS, 50000010, o).jumped, false, "in warp");
    boss.mode = "STOP";
    assert.deepStrictEqual(seam.jumpAtGate(SYSTEM, BOSS, 50000010, o), { ok: true, jumped: true, fx: true });
    assert.deepStrictEqual(calls, [["fx", BOSS, "effects.JumpOut", { targetID: 50000010,
      graphicInfo: { type: "tuple", items: [TO, null] }, start: true, active: false }, boss]]);
    fxThrows = true;
    assert.deepStrictEqual(seam.jumpAtGate(SYSTEM, BOSS, 50000010, o), { ok: true, jumped: true, fx: false });
    assert.strictEqual(seam.jumpAtGate(SYSTEM, BOSS, 50000099, o).reason, "NO_GATE");
    assert.deepStrictEqual(seam.readAggression(SYSTEM, [BOSS]).ships[0].position, boss.position);

    calls.length = 0;
    const spec = (systemId) => ({ systemId: SYSTEM, anchor: { kind: "gateTo", systemId, index: 0, gateFallback: true },
      factionId: 500010, boss: { kind: "hull", hullClass: "frigate" }, escorts: [], slimName: null,
      archetype: "RUNNER", seedKey: "bnt:1:1" });
    const r = seam.spawnGroup(spec(TO));
    assert.deepStrictEqual([r.ok, r.arrivalGate, calls[0]], [true, true, ["spawn", 50000010]]);
    assert.deepStrictEqual(calls[1].slice(0, 4), ["fx", r.bossId, "effects.JumpIn", { duration: 5000 }]);
    calls.length = 0;
    const fallback = seam.spawnGroup(spec(30002600));
    assert.deepStrictEqual([fallback.ok, fallback.arrivalGate, calls], [true, false, [["spawn", 40000001]]]);
    for (let id = 8100001; id <= next; id += 1) dormancyGuard.release(id);
  });

  test("BTA5 vendor facts: align order, syncNpcAlign, effects.JumpOut, destinationSolarSystemID "
    + "WARP_DISTANCE_TOO_CLOSE", () => {
    const loop = readSource("space/npc/npcBehaviorLoop.js");
    assert.ok(loop.includes("manualOrder.type === \"align\""), "align order");
    assert.ok(loop.includes("function syncNpcAlign"), "syncNpcAlign");
    assert.ok(readSource("space/runtime/spaceRuntime/stargateJump.js").includes("\"effects.JumpOut\""), "JumpOut");
    assert.ok(readSource("space/runtime/staticSceneEntity.js").includes("destinationSolarSystemID"), "gate field");
    assert.ok(readSource("space/destiny/commands/warpCommands.js").includes("WARP_DISTANCE_TOO_CLOSE"), "too close");
  });
};
