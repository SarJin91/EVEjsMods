"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { relationOf, classifyStanding, isTarget, huntThresholds } = require("../../lib/playerHunt/policy");
const { combineRelations, createRelationPainter } = require("../../lib/materialization/relationPaint");
const ns = require("../../lib/adapter/npcSpawn");
const liveProfiles = require("../../lib/adapter/data/liveProfiles");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SERVER_SRC = path.resolve(MOD_DIR, "..", "..", "server", "src");
const SYS = 30000142;
const EMPIRE = 500001;
const PIRATE = 500010;
const POLICY = Object.freeze({ pirate: "hostile", empire: "ignore" });
const T = huntThresholds({ hostileStandingMax: -5, friendlyStandingMin: 5 });
const KIND = Object.freeze({ [EMPIRE]: "empire", [PIRATE]: "pirate" });

function readSource(rel) {
  return fs.readFileSync(path.join(SERVER_SRC, rel), "utf8").replace(/\r\n/g, "\n");
}

function fakePainter(opts = {}) {
  const env = { ships: new Map(opts.ships || []), standing: new Map(opts.standing || []), reads: 0, sets: [],
    counters: {}, applied: new Map() };
  env.painter = createRelationPainter({
    readPlayerShips: (systemId) => ({ ok: true, ships: env.ships.get(systemId) || [] }),
    readStanding: (characterId, factionId) => {
      env.reads += 1;
      const v = env.standing.get(`${characterId}:${factionId}`);
      return v === undefined ? { ok: false, reason: "NO_ROW" } : { ok: true, standing: v };
    },
    getFactionKind: (factionId) => KIND[factionId] || null,
    thresholds: T,
    neutralPolicy: POLICY,
    setRelation: (systemId, ids, relation) => {
      env.sets.push([systemId, [...ids], relation]);
      let changed = 0;
      for (const id of ids) {
        if (env.applied.get(id) !== relation) changed += 1;
        env.applied.set(id, relation);
      }
      return { ok: true, changed, unchanged: ids.length - changed, missing: 0, broadcast: changed > 0 };
    },
    maxStandingReadsPerPass: opts.maxReads === undefined ? 32 : opts.maxReads,
    maxRepaintsPerPass: opts.maxRepaints === undefined ? 64 : opts.maxRepaints,
    bump: (name, n = 1) => { env.counters[name] = (env.counters[name] || 0) + n; },
  });
  return env;
}

function fakeGame(withBroadcast = true) {
  const entities = new Map();
  const broadcasts = [];
  const scene = { getEntityByID: (id) => entities.get(id) || null };
  if (withBroadcast) scene.broadcastSlimItemChanges = (list) => { broadcasts.push(list.map((e) => e.itemID)); };
  const runtime = { scenes: new Map([[SYS, scene]]), isSolarSystemSceneLoaded(id) { return this.scenes.has(id); } };
  const requireGame = (rel) => (rel === ns.MODULE_PATHS.runtime ? { ok: true, exports: runtime }
    : { ok: false, reason: "file_not_found" });
  const seam = ns.createNpcSpawn({ requireGame, navyProfiles: {}, data: liveProfiles });
  const npc = (id) => {
    const e = { itemID: id, kind: "ship", nativeNpc: true, hostileResponseThreshold: 11, friendlyResponseThreshold: 11 };
    entities.set(id, e);
    return e;
  };
  return { entities, broadcasts, seam, npc };
}

module.exports = ({ test }) => {
  test("RC1 relationOf: -6/0/+6 x empire (ignore) and pirate (hostile), null, loyaltySpare, = the attack rule", () => {
    const row = (kind) => [-6, 0, 6].map((s) => relationOf(s, kind, T, POLICY));
    assert.deepStrictEqual(row("empire"), ["hostile", "neutral", "friendly"]);
    assert.deepStrictEqual(row("pirate"), ["hostile", "hostile", "friendly"]);
    assert.strictEqual(relationOf(null, "empire", T, POLICY), null);
    const spare = huntThresholds({ hostileStandingMax: -5, friendlyStandingMin: 5, loyaltySpareEnabled: true,
      loyaltySpareStandingMin: 2 });
    assert.strictEqual(relationOf(3, "empire", spare, POLICY), "friendly");
    assert.strictEqual(relationOf(3, "empire", T, POLICY), "neutral");
    for (const kind of ["empire", "pirate", null]) {
      for (let s = -10; s <= 10; s += 0.5) {
        assert.strictEqual(relationOf(s, kind, T, POLICY) === "hostile",
          isTarget(classifyStanding(s, T), kind, POLICY), `standing ${s} kind ${kind}`);
      }
    }
  });

  test("RC2 combineRelations (equal / mixed / primary / unknown) and an aggressor is hostile without a read", () => {
    const p = (characterId, relation) => ({ characterId, relation });
    assert.strictEqual(combineRelations([p(1, "friendly"), p(2, "friendly")], null), "friendly");
    assert.strictEqual(combineRelations([p(1, "friendly"), p(2, "hostile")], null), "neutral");
    assert.strictEqual(combineRelations([p(1, "friendly"), p(2, "hostile")], 2), "hostile");
    assert.strictEqual(combineRelations([p(1, "friendly"), p(2, "hostile")], 9), "neutral");
    assert.strictEqual(combineRelations([p(1, null), p(2, null)], 1), null);
    assert.strictEqual(combineRelations([p(1, null), p(2, "friendly")], 1), "friendly");
    assert.strictEqual(combineRelations([], null), null);

    const env = fakePainter({ ships: [[SYS, [{ characterId: 90000001, entityId: 1001 }]]],
      standing: [[`90000001:${EMPIRE}`, 8]] });
    const r = env.painter.paint([{ systemId: SYS, factionId: EMPIRE, entityIds: [5001, 5002],
      aggressors: new Set([1001]), primaryCharacterId: null }]);
    assert.strictEqual(env.reads, 0);
    assert.deepStrictEqual(env.sets, [[SYS, [5001, 5002], "hostile"]]);
    assert.strictEqual(r.repainted, 2);
  });

  test("RC3 npcSpawn.setRelation: pair + one broadcast, compare-and-set, player ship missing, no broadcast method", () => {
    assert.ok(ns.SEAM_METHODS.includes("setRelation"));
    const g = fakeGame();
    g.npc(7001);
    g.npc(7002);
    const first = g.seam.setRelation(SYS, [7001, 7002], "friendly");
    assert.deepStrictEqual(first, { ok: true, changed: 2, unchanged: 0, missing: 0, broadcast: true });
    assert.deepStrictEqual([g.entities.get(7001).hostileResponseThreshold, g.entities.get(7001).friendlyResponseThreshold],
      [-11, -11]);
    assert.deepStrictEqual(g.broadcasts, [[7001, 7002]]);
    const again = g.seam.setRelation(SYS, [7001, 7002], "friendly");
    assert.deepStrictEqual(again, { ok: true, changed: 0, unchanged: 2, missing: 0, broadcast: false });
    assert.strictEqual(g.broadcasts.length, 1);
    g.entities.set(8001, { itemID: 8001, kind: "ship", hostileResponseThreshold: 0, friendlyResponseThreshold: 0 });
    const player = g.seam.setRelation(SYS, [8001, 9999], "hostile");
    assert.deepStrictEqual(player, { ok: true, changed: 0, unchanged: 0, missing: 2, broadcast: false });
    assert.deepStrictEqual([g.entities.get(8001).hostileResponseThreshold, g.entities.get(8001).friendlyResponseThreshold],
      [0, 0]);
    assert.strictEqual(g.seam.setRelation(SYS, [7001], "blue").reason, "INVALID_INPUT");
    assert.strictEqual(g.seam.setRelation(SYS + 1, [7001], "neutral").reason, "SCENE_NOT_LOADED");

    const nb = fakeGame(false);
    nb.npc(7101);
    assert.deepStrictEqual(nb.seam.setRelation(SYS, [7101], "neutral"),
      { ok: true, changed: 1, unchanged: 0, missing: 0, broadcast: false });
    assert.deepStrictEqual([nb.entities.get(7101).hostileResponseThreshold,
      nb.entities.get(7101).friendlyResponseThreshold], [-11, 11]);
  });

  test("RC4 painter over passes: -6 hostile, +6 friendly, the same again no repaint; the read limit", () => {
    const CH = 90000001;
    const env = fakePainter({ ships: [[SYS, [{ characterId: CH, entityId: 1001 }]]],
      standing: [[`${CH}:${EMPIRE}`, -6]] });
    const group = [{ systemId: SYS, factionId: EMPIRE, entityIds: [5001, 5002], aggressors: new Set(),
      primaryCharacterId: null }];
    env.painter.paint(group);
    assert.deepStrictEqual(env.sets.at(-1), [SYS, [5001, 5002], "hostile"]);
    env.standing.set(`${CH}:${EMPIRE}`, 6);
    env.painter.paint(group);
    assert.deepStrictEqual(env.sets.at(-1), [SYS, [5001, 5002], "friendly"]);
    assert.strictEqual(env.counters.relationRepainted, 4);
    env.painter.paint(group);
    assert.strictEqual(env.counters.relationRepainted, 4, "the third pass changes nothing");
    assert.strictEqual(env.counters.relationUnchanged, 2, "The third pass counts the unchanged ships");

    const two = fakePainter({ maxReads: 1,
      ships: [[SYS, [{ characterId: 1, entityId: 1001 }, { characterId: 2, entityId: 1002 }]]],
      standing: [[`1:${EMPIRE}`, 7], [`2:${EMPIRE}`, -7]] });
    two.painter.paint(group);
    assert.strictEqual(two.reads, 1);
    assert.deepStrictEqual(two.sets, [[SYS, [5001, 5002], "friendly"]], "the only known relation wins");

    const none = fakePainter({ ships: [[SYS, []]] });
    const r = none.painter.paint(group);
    assert.deepStrictEqual([r.unknown, none.sets.length], [1, 0]);
  });

  test("RC5 vendor facts: entity thresholds win in the slim, default NPC (11, 11), broadcastSlimItemChanges", () => {
    const destiny = readSource("space/destiny/index.js");
    assert.ok(destiny.includes("\"hostile_response_threshold\""));
    assert.ok(destiny.includes("\"friendly_response_threshold\""));
    const fieldAt = destiny.indexOf("? Number(entity.hostileResponseThreshold)");
    const tableAt = destiny.indexOf(": authoredStandings && authoredStandings.hostileResponseThreshold");
    assert.ok(fieldAt > 0 && tableAt > fieldAt, "the entity field comes before the type table");
    assert.ok(destiny.includes("appendEntityStandings(entries, entity, slimTypeID, isConcordResponse);"));
    assert.ok(destiny.includes("const isConcordResponse = entity?.nativeNpc === true && entity.spawnGroupID === "
      + "CONCORD_RESPONSE_SPAWN_GROUP_ID;"), "only the CONCORD crimewatch response skips the entity thresholds");
    const standings = destiny.slice(destiny.indexOf("function appendEntityStandings("));
    assert.ok(standings.indexOf("if (isConcordResponse) {") < standings.indexOf("const authoredStandings"));
    const presentation = readSource("space/npc/npcPresentation.js");
    assert.ok(presentation.includes("hostileResponseThreshold: 11,"));
    assert.ok(presentation.includes("friendlyResponseThreshold: 11,"));
    assert.ok(readSource("space/runtime/scene/presentation.js").includes("broadcastSlimItemChanges(entities) {"));
    assert.ok(readSource("space/npc/nativeNpcService.js").includes("entity.nativeNpc = true;"));
    assert.ok(readSource("space/runtime/shipEntity.js").includes("kind: \"ship\","));
  });

  test("RG-SRC gem: relationGroups source - battle / hunt / patrol / exposure, other fields and order "
    + "kept, a LIVE entry only", () => {
    const { collectRelationGroups } = require("../../lib/materialization/service");
    const live = { state: "LIVE", despawned: false, systemId: SYS, factionOf: new Map([[5001, PIRATE], [5002, EMPIRE]]),
      spawned: [{ entityId: 5001 }, { entityId: 5002 }] };
    const ended = { ...live, state: "ENDED" };
    const huntGroup = { systemId: SYS, factionId: PIRATE, entityIds: [6001], aggressors: new Set([1001]),
      primaryCharacterId: 91 };
    const step = (groups) => ({ relationGroups: () => groups });
    const groups = collectRelationGroups([live, ended],
      [[step([huntGroup]), "hunt"], [null, "patrol"], [step([{ systemId: SYS, factionId: EMPIRE, entityIds: [7001] }]),
        "patrol"], [step(null), "exposure"]], true);
    assert.deepStrictEqual(groups.map((g) => [g.source, g.entityIds]),
      [["battle", [5001]], ["battle", [5002]], ["hunt", [6001]], ["patrol", [7001]]]);
    assert.deepStrictEqual(groups[0], { systemId: SYS, factionId: PIRATE, entityIds: [5001], aggressors: null,
      primaryCharacterId: null, forced: "hostile", source: "battle" });
    assert.deepStrictEqual(groups[2], { ...huntGroup, source: "hunt" });
    assert.ok(!Object.prototype.hasOwnProperty.call(huntGroup, "source"), "the step's group is not mutated");
    assert.strictEqual(collectRelationGroups([live], [], false)[0].forced, null);
  });
};
