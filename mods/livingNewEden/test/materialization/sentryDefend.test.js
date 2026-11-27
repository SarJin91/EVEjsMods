"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { createSentryStep, COUNTER_NAMES } = require("../../lib/materialization/sentryStep");
const combat = require("../../lib/adapter/sentryCombat");
const { aggroesPlayers } = require("../../lib/adapter/data/npcAggro");
const { GAME_MODULES } = require("../../lib/adapter/gameModules");
const { createSentrySeam } = require("../../lib/adapter/sentrySeams");
const config = require("../../config");
const { findCompose, readCompose } = require("../config/composeKeys.test");

const SYS = 30002000;
const CHAR = 90000001;
const OTHER_CHAR = 90000002;
const CORP = 98000001;
const OTHER_CORP = 98000002;
const EMPIRE = 500001;
const SENTRY = 7001;
const CORP_SENTRY = 7003;
const OWNER_SHIP = 900;
const FOREIGN_SHIP = 901;
const LIVE = Object.freeze({ maxEngagesPerPass: 32, maxStandingReadsPerPass: 32, proxyDpsPerShip: 0,
  proxyRangeM: 50000, maxProxyHitsPerPass: 16, defendEnabled: true, defendMaxSceneScan: 512,
  defendMaxCandidates: 64 });
const SERVER_SRC = path.resolve(__dirname, "..", "..", "..", "..", "server", "src");

const at = (x) => Object.freeze({ x, y: 0, z: 0 });
const ref = (itemId, characterId) => Object.freeze({ sentryId: `sp-${itemId}`, itemId, ownerKind: "player",
  factionId: null, characterId, ownerCorpId: CORP, typeId: 340501, systemId: SYS });
const npc = (itemID, x, over = {}) => ({ itemID, kind: "ship", nativeNpc: true, npcEntityType: "npc",
  position: at(x), ...over });

function fakeVendor({ entities = [], controllers = new Map(), sessions = [], registry = true } = {}) {
  const dynamic = new Map();
  for (const id of [SENTRY, CORP_SENTRY]) dynamic.set(id, { itemID: id, kind: "starbase", position: at(0) });
  for (const e of entities) dynamic.set(e.itemID, e);
  const ships = new Map();
  for (const s of sessions) {
    const ship = { itemID: s.shipId, kind: "ship", session: { characterID: s.characterID }, position: at(s.x),
      lockedTargets: new Map((s.locks || []).map((id) => [id, {}])),
      pendingTargetLocks: new Map((s.pending || []).map((id) => [id, {}])), groupID: s.groupID || 25 };
    dynamic.set(s.shipId, ship);
    ships.set(s.characterID, ship);
  }
  const scene = Object.freeze({
    dynamicEntities: dynamic,
    sessions: new Map(sessions.map((s, i) => [i, { characterID: s.characterID, corporationID: s.corp }])),
    getShipEntityForSession: (s) => ships.get(s.characterID) || null,
    getEntityByID: (id) => dynamic.get(id) || null,
  });
  return Object.freeze({
    itemStore: Object.freeze({ findItemById: (id) => ([SENTRY, CORP_SENTRY].includes(id)
      ? Object.freeze({ itemID: id, typeID: 340501, conditionState: Object.freeze({}) }) : null) }),
    gm: Object.freeze({ applyPosDamage: () => ({ success: true }) }),
    defense: Object.freeze({ getBatteryProfile: () => ({ passive: false, effectName: "projectileFired",
      attributes: { 76: 100000 } }), hasUnavailableHealth: () => false, hydrateBatteryActor() {},
    getBatterySession() {}, getBatteryModuleView() {}, stopBattery() {}, isBatteryManuallyControlled() {},
    validateBatteryOperation: () => ({ success: true }) }),
    runtime: Object.freeze({ isSolarSystemSceneLoaded: () => true, scenes: new Map([[SYS, scene]]) }),
    registry: registry ? Object.freeze({ getControllerByEntityID: (id) => controllers.get(id) || null }) : null,
  });
}

function rig(vendor, { live = LIVE, groups = [], lneAll = new Set(), standing = 0, refuse = new Set(),
  le = new Set(), leResult = null, engageFn = null, refs = null, armed = [SENTRY] } = {}) {
  const env = { calls: [], opts: [], leCalls: [], pass: 0 };
  const seam = Object.freeze({
    readSentryScene(systemId, ids, lneIds, opts) {
      env.opts.push(opts);
      return combat.readSentrySceneFrom(vendor, systemId, ids, lneIds, opts);
    },
    engage: (systemId, itemId, targetId) => {
      env.calls.push(["engage", itemId, targetId]);
      if (engageFn !== null) return engageFn(targetId, env.pass);
      if (refuse.has(targetId)) return { ok: false, reason: "TARGET_NOT_VISIBLE", scope: "target" };
      return { ok: true, pending: false, alreadyActive: false };
    },
    hasLimitedEngagement: (a, b) => {
      env.leCalls.push([a, b]);
      if (leResult !== null) return leResult;
      return { ok: true, active: le.has(a < b ? `${a}:${b}` : `${b}:${a}`) };
    },
    release: (systemId, itemId, reason) => {
      env.calls.push(["release", itemId, reason]);
      return { ok: true, stopped: true };
    },
    applySentryDamage: () => ({ ok: true, destroyed: false }),
    isNpcCorporation: (corpId) => ({ ok: true, npc: corpId !== CORP && corpId !== OTHER_CORP }),
  });
  const sentries = Object.freeze({ getMode: () => "ready",
    listLiveInSystem: () => refs || [ref(SENTRY, CHAR), ref(CORP_SENTRY, null)], markEnded: () => ({ ok: true }),
    isArmed: (id) => armed.includes(id) });
  env.step = createSentryStep({ getSentries: () => sentries, getSeam: () => seam,
    readStanding: () => ({ ok: true, standing }), getFactionKind: () => "empire",
    thresholds: Object.freeze({ hostileMax: -5, friendlyMin: 5 }), neutralPolicy: Object.freeze({ empire: "ignore" }),
    relationGroups: () => groups, lneEntityIdsAll: () => lneAll, settings: live, pumpMs: 2000 });
  env.run = () => {
    env.pass += 1;
    env.step.step(1000, Object.freeze({ observedSystems: () => [SYS] }), {});
    return env;
  };
  return env;
}

const zero = () => Object.fromEntries(COUNTER_NAMES.map((n) => [n, 0]));
const OWNER = Object.freeze({ characterID: CHAR, corp: CORP, shipId: OWNER_SHIP, x: 1000 });
const FOREIGN = Object.freeze({ characterID: OTHER_CHAR, corp: OTHER_CORP, shipId: FOREIGN_SHIP, x: 2000 });
const DEFAULT_PROFILE = Object.freeze({ behaviorProfile: Object.freeze({}) });
const PASSIVE = Object.freeze({ behaviorProfile: Object.freeze({ autoAggro: false, targetPreference: "none",
  proximityAggroRangeMeters: 0 }) });

function aggressorScene() {
  return fakeVendor({ sessions: [OWNER],
    entities: [npc(301, 10000), npc(501, 50000)],
    controllers: new Map([[301, DEFAULT_PROFILE], [501, { ...PASSIVE, currentTargetID: OWNER_SHIP }]]) });
}

module.exports = ({ test, skip }) => {
  test("SD1 defend: a vendor rat (default profile) in range is engaged (engagedRat 1); out of range = nothing", () => {
    const near = rig(fakeVendor({ sessions: [OWNER], entities: [npc(301, 10000)],
      controllers: new Map([[301, DEFAULT_PROFILE]]) })).run();
    const far = rig(fakeVendor({ sessions: [OWNER], entities: [npc(302, 200000)],
      controllers: new Map([[302, DEFAULT_PROFILE]]) })).run();
    assert.deepStrictEqual([near.calls, near.step.stats().counters.engagedRat, near.step.stats().counters.engaged],
      [[["engage", SENTRY, 301]], 1, 1]);
    assert.deepStrictEqual([far.calls, far.step.stats().counters], [[], zero()]);
    assert.deepStrictEqual(near.opts, [{ defendScanMax: 512 }]);
  });

  test("SD2 defend never: CONCORD, empireSentry, a player, a wing copy, passive LNE presence, a friendly LNE ship "
    + "with a player profile, autoAggro false without proximity, targetPreference none", () => {
    const entities = [npc(401, 5000, { npcEntityType: "concord" }), npc(402, 5100, { empireSentry: true }),
      npc(404, 5300, { nativeNpc: false }), npc(405, 5400), npc(406, 5500), npc(407, 5600), npc(408, 5700)];
    const controllers = new Map([[401, DEFAULT_PROFILE], [402, DEFAULT_PROFILE], [404, DEFAULT_PROFILE],
      [405, PASSIVE], [406, DEFAULT_PROFILE],
      [407, { behaviorProfile: { autoAggro: false, proximityAggroRangeMeters: 0 } }],
      [408, { behaviorProfile: {}, behaviorOverrides: { targetPreference: "none" } }]]);
    const env = rig(fakeVendor({ sessions: [OWNER, { ...FOREIGN, x: 5200 }], entities, controllers }),
      { groups: [{ systemId: SYS, factionId: EMPIRE, entityIds: [406] }], lneAll: new Set([405, 406]) }).run();
    assert.deepStrictEqual([env.calls, env.step.stats().counters], [[], zero()]);
    assert.deepStrictEqual([aggroesPlayers(DEFAULT_PROFILE), aggroesPlayers(PASSIVE), aggroesPlayers(controllers.get(407)),
      aggroesPlayers(controllers.get(408)), aggroesPlayers({ behaviorProfile: { autoAggro: false,
        proximityAggroRangeMeters: 5000 } }), aggroesPlayers({ behaviorProfile: { targetPreference: "nearestNpc" } }),
      aggroesPlayers({ behaviorProfile: { autoAggroTargetClasses: [] } })], [true, false, false, false, true, false,
      false]);
  });

  test("SD3 defend: an aggressor of the owner ship beats a nearer rat; manualOrder attack on a corp sentry; an NPC "
    + "targeting a foreign player is no aggressor", () => {
    const owner = rig(aggressorScene(), { lneAll: new Set([501]) }).run();
    const corpSentry = rig(fakeVendor({ sessions: [OWNER], entities: [npc(301, 10000), npc(502, 60000)],
      controllers: new Map([[301, DEFAULT_PROFILE],
        [502, { ...PASSIVE, manualOrder: { type: "attack", targetID: CORP_SENTRY } }]]) }),
    { lneAll: new Set([502]) }).run();
    const foreign = rig(fakeVendor({ sessions: [OWNER, FOREIGN], entities: [npc(503, 30000)],
      controllers: new Map([[503, { ...PASSIVE, currentTargetID: FOREIGN_SHIP }]]) }), { lneAll: new Set([503]) }).run();
    assert.deepStrictEqual([owner.calls, owner.step.stats().counters.engagedAggressor,
      owner.step.stats().counters.engagedRat], [[["engage", SENTRY, 501]], 1, 0]);
    assert.deepStrictEqual([corpSentry.calls, corpSentry.step.stats().counters.engagedAggressor],
      [[["engage", SENTRY, 502]], 1]);
    assert.deepStrictEqual([foreign.calls, foreign.step.stats().counters], [[], zero()]);
  });

  test("SD4 adapter scan: defendScanMax 2 of 3 -> truncated (+ step counter); no registry -> targetId 0 / no aggro; "
    + "no opts -> npcs []; vendor facts of the port", () => {
    const three = { entities: [npc(301, 1000), npc(302, 2000), npc(303, 3000)],
      controllers: new Map([[301, { ...DEFAULT_PROFILE, currentTargetID: OWNER_SHIP }]]) };
    const v = fakeVendor(three);
    const cut = combat.readSentrySceneFrom(v, SYS, [SENTRY], [], { defendScanMax: 3 });
    const whole = combat.readSentrySceneFrom(v, SYS, [SENTRY], [], { defendScanMax: 5 });
    const bare = combat.readSentrySceneFrom(fakeVendor({ ...three, registry: false }), SYS, [SENTRY], [],
      { defendScanMax: 512 });
    const none = combat.readSentrySceneFrom(v, SYS, [SENTRY], []);
    assert.deepStrictEqual([cut.npcScanTruncated, cut.npcs.map((n) => n.entityId)], [true, [301]]);
    assert.deepStrictEqual([whole.npcScanTruncated, whole.npcs.map((n) => [n.entityId, n.targetId, n.aggroPlayers])],
      [false, [[301, OWNER_SHIP, true], [302, 0, false], [303, 0, false]]]);
    assert.deepStrictEqual(bare.npcs.map((n) => [n.targetId, n.aggroPlayers]), [[0, false], [0, false], [0, false]]);
    assert.deepStrictEqual([none.npcs, none.npcScanTruncated], [[], false]);
    const step = rig(fakeVendor(three), { live: { ...LIVE, defendMaxSceneScan: 2 } }).run();
    assert.strictEqual(step.step.stats().counters.defendScanTruncated, 1);
    const sym = GAME_MODULES.find((e) => e.path === "space/npc/npcRegistry").symbols
      .find((s) => s.name === "getControllerByEntityID");
    assert.deepStrictEqual([sym.consumers.includes("sentryDefend"), config.MODULE_NAMES.includes("sentryDefend")],
      [true, false]);
    if (!fs.existsSync(path.join(SERVER_SRC, "space", "npc", "npcBehaviorLoop.js"))) {
      skip("SD4 vendor facts", "server/src not found (Docker image)");
      return;
    }
    const read = (rel) => fs.readFileSync(path.join(SERVER_SRC, rel), "utf8").replace(/\r\n/g, "\n");
    const loop = read("space/npc/npcBehaviorLoop.js");
    assert.match(loop, /function resolveEffectiveBehaviorProfile\(controller\) \{\n {2}return \{\n {4}\.\.\.\(controller && controller\.behaviorProfile \? controller\.behaviorProfile : \{\}\),\n {4}\.\.\.normalizeBehaviorOverrides\(controller && controller\.behaviorOverrides\),/);
    for (const c of ["none", "preferredtargetonly", "nearestnpc", "preferredtargetthennearestnpc",
      "preferredtargetthennearestrat", "preferredtargetthennearestnonconcord", "nearesteligible",
      "preferredtargetthennearesteligible", "nearestplayer", "preferredtargetthennearestplayer"]) {
      assert.ok(loop.includes(`    case "${c}":`), `case ${c}`);
    }
    for (const k of ["\"autoAggro\",", "\"proximityAggroRangeMeters\",", "overrides.targetPreference !== undefined",
      "overrides.autoAggroTargetClasses !== undefined", "overrides.proximityAggroTargetClasses !== undefined"]) {
      assert.ok(loop.includes(k), `normalizeBehaviorOverrides whitelist ${k}`);
    }
    assert.ok(loop.includes("if (behaviorProfile.autoAggro === false) {"));
    assert.match(read("space/npc/npcRegistry.js"), /^ {2}getControllerByEntityID,$/m);
    assert.ok(read("space/npc/nativeNpcService.js").includes("npcEntityType: entityRecord.npcEntityType"));
  });

  test("SD5 defendEnabled false: the same scenes -> no rat / aggressor engage, no scan, counters of before; compose "
    + "lines of the three keys (DEFEND_ENABLED :-1)", () => {
    const off = { ...LIVE, defendEnabled: false };
    const rat = rig(fakeVendor({ sessions: [OWNER], entities: [npc(301, 10000)],
      controllers: new Map([[301, DEFAULT_PROFILE]]) }), { live: off }).run();
    const aggr = rig(aggressorScene(), { live: off, lneAll: new Set([501]) }).run();
    assert.deepStrictEqual([rat.calls, aggr.calls, rat.opts, rat.step.stats().counters, aggr.step.stats().counters],
      [[], [], [undefined], zero(), zero()]);
    const file = findCompose();
    if (!file) {
      skip("SD5 compose", "compose.yaml not found above the mod (Docker image)");
      return;
    }
    const { env } = readCompose(file);
    const rows = config.SCHEMA.filter((r) => r.key.startsWith("sentries.live.defend"));
    assert.deepStrictEqual(rows.map((r) => [r.key, r.default, env[r.env]]), [
      ["sentries.live.defendEnabled", true, "1"], ["sentries.live.defendMaxSceneScan", 512, ""],
      ["sentries.live.defendMaxCandidates", 64, ""], ["sentries.live.defendRefuseTtlPasses", 10, ""],
      ["sentries.live.defendRefuseMaxEntries", 4096, ""],
      ["sentries.live.defendPlayersEnabled", false, "0"], ["sentries.live.defendMaxPlayerReadsPerPass", 16, ""]]);
  });

  test("SD6 refusal memory: 3 refusing rats nearest -> pass 1 tries them, pass 2 skips them (no tries, no "
    + "budget) and engages the LNE hostile behind; after the TTL the pair is tried again", () => {
    const refusing = new Set([301, 302, 303]);
    const vendor = fakeVendor({ sessions: [OWNER], entities: [npc(301, 1000), npc(302, 2000), npc(303, 3000),
      npc(601, 9000)], controllers: new Map([[301, DEFAULT_PROFILE], [302, DEFAULT_PROFILE], [303, DEFAULT_PROFILE]]) });
    const groups = [{ systemId: SYS, factionId: EMPIRE, entityIds: [601] }];
    const env = rig(vendor, { live: { ...LIVE, maxEngagesPerPass: 4, maxEngageTriesPerSentry: 3,
      defendRefuseTtlPasses: 2, defendRefuseMaxEntries: 16 }, groups, lneAll: new Set([601]), standing: -10,
    refuse: refusing });
    const passes = [];
    for (let i = 0; i < 4; i += 1) {
      env.calls.length = 0;
      env.run();
      passes.push(env.calls.map((c) => c[2]));
    }
    assert.deepStrictEqual(passes, [[301, 302, 303], [601], [601], [301, 302, 303]]);
    const c = env.step.stats().counters;
    assert.deepStrictEqual([c.engageFailed, c.defendRefuseSkipped, c.engaged, c.engagedLne], [6, 6, 2, 2]);
  });

  test("SD7 flag off and TTL 0: the same refusing scene -> 3 tries every pass, no skip; the memory is bounded "
    + "by defendRefuseMaxEntries", () => {
    const refusing = new Set([301, 302, 303]);
    const scene = () => fakeVendor({ sessions: [OWNER], entities: [npc(301, 1000), npc(302, 2000), npc(303, 3000)],
      controllers: new Map([[301, DEFAULT_PROFILE], [302, DEFAULT_PROFILE], [303, DEFAULT_PROFILE]]) });
    const ttl0 = rig(scene(), { live: { ...LIVE, defendRefuseTtlPasses: 0, defendRefuseMaxEntries: 16 },
      refuse: refusing });
    ttl0.run();
    ttl0.run();
    assert.deepStrictEqual([ttl0.calls.length, ttl0.step.stats().counters.defendRefuseSkipped,
      ttl0.step.stats().counters.engageFailed], [6, 0, 6]);
    const bounded = rig(scene(), { live: { ...LIVE, defendRefuseTtlPasses: 10, defendRefuseMaxEntries: 2 },
      refuse: refusing });
    bounded.run();
    bounded.calls.length = 0;
    bounded.run();
    assert.deepStrictEqual([bounded.calls.map((x) => x[2]), bounded.step.stats().counters.defendRefuseSkipped],
      [[301, 302, 303], 0]);
    const off = rig(fakeVendor({ sessions: [OWNER], entities: [npc(601, 1000), npc(602, 2000), npc(603, 3000),
      npc(604, 4000)] }), { live: { ...LIVE, defendEnabled: false, defendRefuseTtlPasses: 10,
      defendRefuseMaxEntries: 16 }, groups: [{ systemId: SYS, factionId: EMPIRE, entityIds: [601, 602, 603, 604] }],
    standing: -10, refuse: new Set([601, 602, 603]) });
    off.run();
    off.run();
    assert.deepStrictEqual([off.calls.map((x) => x[2]), off.step.stats().counters.defendRefuseSkipped],
      [[601, 602, 603, 601, 602, 603], 0]);
  });

  test("SD8 defendPlayersEnabled off: a pilot with LE and a lock on the owner ship in range -> no engage, no LE "
    + "read, opts without defendPlayers, players without lockedIds", () => {
    const pilot = { ...FOREIGN, locks: [OWNER_SHIP] };
    const vendor = fakeVendor({ sessions: [OWNER, pilot] });
    const env = rig(vendor, { le: new Set([`${CHAR}:${OTHER_CHAR}`]) }).run();
    assert.deepStrictEqual([env.calls, env.leCalls, env.opts, env.step.stats().counters], [[], [],
      [{ defendScanMax: 512 }], zero()]);
    const players = combat.readSentrySceneFrom(vendor, SYS, [SENTRY], [], { defendScanMax: 512 }).players;
    assert.deepStrictEqual(players.map((p) => Object.prototype.hasOwnProperty.call(p, "lockedIds")), [false, false]);
  });

  const PLAYERS_ON = Object.freeze({ ...LIVE, defendPlayersEnabled: true, defendMaxPlayerReadsPerPass: 16 });
  const LE_PAIR = `${CHAR}:${OTHER_CHAR}`;
  const THIRD_CHAR = 90000003;
  const MEMBER_CHAR = 90000004;
  const THIRD_SHIP = 902;
  const MEMBER_SHIP = 903;

  test("SD9 flag on: LE + lock on the owner ship / a corp sentry -> engage (engagedPlayer); no LE, a lock on a "
    + "foreign ship, a corp member, an adopted sentry -> no; a pilot aggressor before a nearer rat", () => {
    const run = (sessions, opts = {}) => rig(fakeVendor({ sessions: [OWNER, ...sessions], ...opts.scene }),
      { live: PLAYERS_ON, le: new Set([LE_PAIR, `${CHAR}:${MEMBER_CHAR}`]), ...opts.rig }).run();
    const owner = run([{ ...FOREIGN, locks: [OWNER_SHIP] }]);
    assert.deepStrictEqual([owner.calls, owner.step.stats().counters.engagedPlayer, owner.step.stats().counters.engaged,
      owner.opts], [[["engage", SENTRY, FOREIGN_SHIP]], 1, 1, [{ defendScanMax: 512, defendPlayers: true }]]);
    const corpSentry = run([{ ...FOREIGN, locks: [CORP_SENTRY] }]);
    assert.deepStrictEqual(corpSentry.calls, [["engage", SENTRY, FOREIGN_SHIP]]);
    const noLe = run([{ characterID: THIRD_CHAR, corp: OTHER_CORP, shipId: THIRD_SHIP, x: 2000, locks: [OWNER_SHIP] }]);
    assert.deepStrictEqual([noLe.calls, noLe.leCalls, noLe.step.stats().counters.engagedPlayer],
      [[], [[CHAR, THIRD_CHAR]], 0]);
    const foreignLock = run([{ ...FOREIGN, locks: [THIRD_SHIP] },
      { characterID: THIRD_CHAR, corp: OTHER_CORP, shipId: THIRD_SHIP, x: 3000 }]);
    assert.deepStrictEqual([foreignLock.calls, foreignLock.leCalls], [[], []]);
    const member = run([{ characterID: MEMBER_CHAR, corp: CORP, shipId: MEMBER_SHIP, x: 2000, locks: [OWNER_SHIP] }]);
    assert.deepStrictEqual([member.calls, member.leCalls], [[], []]);
    const adopted = run([{ ...FOREIGN, locks: [OWNER_SHIP] }], { rig: { refs: [ref(SENTRY, null)] } });
    assert.deepStrictEqual([adopted.calls, adopted.leCalls], [[], []]);
    const withRat = run([{ ...FOREIGN, locks: [OWNER_SHIP] }], { scene: { entities: [npc(301, 1000)],
      controllers: new Map([[301, DEFAULT_PROFILE]]) } });
    assert.deepStrictEqual([withRat.calls, withRat.step.stats().counters.engagedRat], [[["engage", SENTRY,
      FOREIGN_SHIP]], 0]);
  });

  test("SD10 budget + memo + refusal; adapter lockedIds / limitedEngagementFrom / facade; vendor facts", () => {
    const third = { characterID: THIRD_CHAR, corp: OTHER_CORP, shipId: THIRD_SHIP, x: 3000, locks: [OWNER_SHIP] };
    const both = new Set([LE_PAIR, `${CHAR}:${THIRD_CHAR}`]);
    const budget = rig(fakeVendor({ sessions: [OWNER, { ...FOREIGN, locks: [OWNER_SHIP] }, third] }),
      { live: { ...PLAYERS_ON, defendMaxPlayerReadsPerPass: 1 }, le: both }).run();
    assert.deepStrictEqual([budget.leCalls, budget.calls, budget.step.stats().counters.defendPlayerDeferred],
      [[[CHAR, OTHER_CHAR]], [["engage", SENTRY, FOREIGN_SHIP]], 1]);
    const memo = rig(fakeVendor({ sessions: [OWNER, { ...FOREIGN, locks: [OWNER_SHIP] }] }), { live: PLAYERS_ON,
      le: both, refs: [ref(SENTRY, CHAR), ref(CORP_SENTRY, CHAR)], armed: [SENTRY, CORP_SENTRY] }).run();
    assert.deepStrictEqual([memo.leCalls.length, memo.calls], [1, [["engage", SENTRY, FOREIGN_SHIP],
      ["engage", CORP_SENTRY, FOREIGN_SHIP]]]);
    const failed = rig(fakeVendor({ sessions: [OWNER, { ...FOREIGN, locks: [OWNER_SHIP] }] }), { live: PLAYERS_ON,
      leResult: { ok: false, reason: "SENTRY_COMBAT_UNAVAILABLE" } }).run();
    assert.deepStrictEqual([failed.calls, failed.step.stats().counters.defendPlayerReadFailed], [[], 1]);
    const v = fakeVendor({ sessions: [OWNER, { ...FOREIGN, locks: [CORP_SENTRY, 55555, OWNER_SHIP, SENTRY],
      pending: [THIRD_SHIP] }, { ...third, groupID: 29, locks: [OWNER_SHIP] }] });
    const read = combat.readSentrySceneFrom(v, SYS, [SENTRY, CORP_SENTRY], [], { defendPlayers: true });
    assert.deepStrictEqual(read.players.map((p) => [p.entityId, p.lockedIds]), [[OWNER_SHIP, []],
      [FOREIGN_SHIP, [OWNER_SHIP, SENTRY, CORP_SENTRY]], [THIRD_SHIP, []]]);
    const args = [];
    const cw = { hasActiveLimitedEngagement: (...a) => {
      args.push(a);
      return true;
    } };
    assert.deepStrictEqual([combat.limitedEngagementFrom(cw, CHAR, CHAR).reason,
      combat.limitedEngagementFrom({}, CHAR, OTHER_CHAR).reason, combat.limitedEngagementFrom(cw, CHAR, OTHER_CHAR),
      combat.limitedEngagementFrom({ hasActiveLimitedEngagement: () => { throw new Error("x"); } }, CHAR,
        OTHER_CHAR).reason, args], ["INVALID_INPUT", "SENTRY_COMBAT_UNAVAILABLE", { ok: true, active: true },
      "SEAM_ERROR", [[CHAR, OTHER_CHAR]]]);
    const loaded = [];
    const facade = createSentrySeam({ requireGame: (rel) => {
      loaded.push(rel);
      return rel === "services/security/crimewatchState" ? { ok: true, exports: cw } : { ok: false, reason: "X" };
    } });
    assert.deepStrictEqual([facade.hasLimitedEngagement(CHAR, OTHER_CHAR), loaded],
      [{ ok: true, active: true }, ["services/security/crimewatchState"]]);
    const sym = GAME_MODULES.find((e) => e.path === "services/security/crimewatchState").symbols
      .find((s) => s.name === "hasActiveLimitedEngagement");
    assert.deepStrictEqual([sym.kind, sym.consumers, config.MODULE_NAMES.includes("sentryDefend")],
      ["export", ["sentryDefend"], false]);
    if (!fs.existsSync(path.join(SERVER_SRC, "services", "security", "crimewatchState.js"))) {
      skip("SD10 vendor facts", "server/src not found (Docker image)");
      return;
    }
    const read2 = (rel) => fs.readFileSync(path.join(SERVER_SRC, rel), "utf8").replace(/\r\n/g, "\n");
    const cwSrc = read2("services/security/crimewatchState.js");
    assert.match(cwSrc, /^ {2}hasActiveLimitedEngagement,$/m);
    assert.match(cwSrc, /function hasActiveLimitedEngagement\([^{]*\) \{\n {2}return Boolean\(\n {4}getLimitedEngagement\(firstCharacterID, secondCharacterID, now\),/);
    const getLe = cwSrc.slice(cwSrc.indexOf("function getLimitedEngagement("),
      cwSrc.indexOf("function hasActiveLimitedEngagement("));
    assert.strictEqual(getLe.split("removeLimitedEngagement(").length - 1, 1, "one write in getLimitedEngagement");
    assert.ok(getLe.indexOf("if (engagement.expiresAtMs <= normalizedNow) {") >= 0
      && getLe.indexOf("if (engagement.expiresAtMs <= normalizedNow) {") < getLe.indexOf("removeLimitedEngagement("),
    "the write only in the expired branch");
    const manual = cwSrc.slice(cwSrc.indexOf("function resolveManualStarbaseAggressor("));
    assert.ok(manual.slice(0, 900).includes("const context = observer && control.getControlledBatteryContext(observer, "
      + "entity);\n  if (!context || context.entity !== entity) return entity;"));
    const targeting = read2("space/runtime/scene/targeting.js");
    assert.ok(targeting.includes("sourceState.lockedTargets.set(targetID, {")
      && targeting.includes("targetState.targetedBy.add(sourceID);"));
    assert.ok(read2("services/starbase/starbaseDefenseRuntime.js").includes("  entity.characterID = 0;\n"));
  });

  test("SD11: a refusal of the sentry (no scope) = 1 try, no memory; pass 2 engages the same aggressor "
    + "a target refusal is remembered; a throw (null) is not", () => {
    const live = { ...LIVE, maxEngageTriesPerSentry: 3, defendRefuseTtlPasses: 10, defendRefuseMaxEntries: 16 };
    const ok = { ok: true, pending: false, alreadyActive: false };
    const controlled = rig(aggressorScene(), { live, lneAll: new Set([501]),
      engageFn: (id, pass) => (pass === 1 ? { ok: false, reason: "STARBASE_BATTERY_CONTROLLED" } : ok) });
    controlled.run();
    const c1 = { ...controlled.step.stats().counters };
    assert.deepStrictEqual([controlled.calls, c1.engageFailed, c1.defendRefuseSkipped],
      [[["engage", SENTRY, 501]], 1, 0]);
    controlled.calls.length = 0;
    controlled.run();
    assert.deepStrictEqual([controlled.calls, controlled.step.stats().counters.engagedAggressor],
      [[["engage", SENTRY, 501]], 1]);
    const target = rig(aggressorScene(), { live, lneAll: new Set([501]),
      engageFn: (id) => (id === 501 ? { ok: false, reason: "TARGET_NOT_IN_SCENE", scope: "target" } : ok) });
    target.run();
    target.run();
    assert.deepStrictEqual([target.calls.map((x) => x[2]), target.step.stats().counters.defendRefuseSkipped],
      [[501, 301, 301], 1]);
    const thrown = rig(aggressorScene(), { live, lneAll: new Set([501]), engageFn: () => {
      throw new Error("boom");
    } });
    thrown.run();
    thrown.run();
    assert.deepStrictEqual([thrown.calls.map((x) => x[2]), thrown.step.stats().counters.defendRefuseSkipped],
      [[501, 501], 0]);
  });

  test("SD12 adapter engageFrom: the battery profile is read before the target; a throw of the target "
    + "stage = SEAM_ERROR scope target, a throw of the sentry stage = SEAM_ERROR without scope", () => {
    const log = [];
    const fail = { profile: false, lock: false };
    const item = Object.freeze({ itemID: SENTRY, typeID: 340501, locationID: SYS });
    const entity = { itemID: SENTRY, kind: "starbase", activeModuleEffects: new Map() };
    const target = Object.freeze({ itemID: 501, kind: "ship" });
    const scene = Object.freeze({
      getEntityByID: (id) => {
        log.push(["getEntityByID", id]);
        return id === SENTRY ? entity : id === 501 ? target : null;
      },
      validateTargetLockRequest: () => {
        log.push(["validateTargetLockRequest"]);
        if (fail.lock) throw new Error("lock boom");
        return { success: true };
      },
      addTarget: () => ({ success: true, data: { pending: true } }),
      activateGenericModule: () => ({ success: true, data: {} }),
    });
    const vendor = Object.freeze({
      itemStore: Object.freeze({ findItemById: (id) => (id === SENTRY ? item : null) }),
      gm: Object.freeze({ applyPosDamage() {} }),
      defense: Object.freeze({
        getBatteryProfile: () => {
          log.push(["getBatteryProfile"]);
          if (fail.profile) throw new Error("profile boom");
          return { passive: false, effectName: "projectileFired", attributes: {} };
        },
        hasUnavailableHealth: () => false,
        validateBatteryOperation: () => ({ success: true }),
        isBatteryManuallyControlled: () => false,
        hydrateBatteryActor: (e) => e,
        getBatterySession: (sc, e) => Object.freeze({ shipID: e.itemID }),
        getBatteryModuleView: (id) => Object.freeze({ itemID: id }),
        stopBattery: () => ({ success: true, data: { stopped: true } }),
      }),
      runtime: Object.freeze({ isSolarSystemSceneLoaded: (id) => id === SYS, scenes: new Map([[SYS, scene]]) }),
    });
    const okRes = combat.engageFrom(vendor, SYS, SENTRY, 501);
    const okLog = log.splice(0);
    fail.lock = true;
    const targetThrow = combat.engageFrom(vendor, SYS, SENTRY, 501);
    log.length = 0;
    fail.lock = false;
    fail.profile = true;
    const sentryThrow = combat.engageFrom(vendor, SYS, SENTRY, 501);
    const sentryLog = log.splice(0);
    assert.deepStrictEqual([okRes, okLog], [{ ok: true, pending: true, alreadyActive: false }, [
      ["getEntityByID", SENTRY], ["getBatteryProfile"], ["getEntityByID", 501], ["validateTargetLockRequest"]]]);
    assert.deepStrictEqual([targetThrow, sentryThrow, sentryLog], [
      { ok: false, reason: "SEAM_ERROR", detail: "lock boom", scope: "target" },
      { ok: false, reason: "SEAM_ERROR", detail: "profile boom" },
      [["getEntityByID", SENTRY], ["getBatteryProfile"]]]);
  });
};
