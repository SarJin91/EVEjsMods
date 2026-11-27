"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { wrapNpcKillStandingLoss, observeKill, setLiberation, getLiberation, setStandings, setNavyKillsLiberate,
  navyKillsLiberate, WRAPPED, killObservationCounters } = require("../../lib/adapter/killObservation");
const { isTrafficVictim } = require("../../lib/adapter/highsecTrafficScene");
const { planGrant } = require("../../lib/world/standings/standingsRules");
const { STANDINGS_DATA_V1 } = require("../../lib/world/standings/data/standingsData");

const SERVER_SRC = path.resolve(__dirname, "..", "..", "..", "..", "server", "src");

module.exports = ({ test }) => {
  test("L7-01 wrap: the original runs first, its result is returned unchanged, the kill reaches the service", () => {
    const seen = [];
    setLiberation({ onNpcKill(kill) { seen.push(kill); return { ok: true, outcome: "APPLIED" }; } });
    const original = (victimEntity, killerCharacterID, options) => ({ applied: true,
      characterID: killerCharacterID, factionID: victimEntity.warFactionID, systemID: options.systemID });
    const wrap = wrapNpcKillStandingLoss(original, { resolveVictimFactionID: (e) => e.warFactionID });
    assert.ok(wrap.ok, JSON.stringify(wrap));
    const r = wrap.wrapped({ warFactionID: 500001, systemID: 30000001 }, 42,
      { nowMs: 1700000000000, systemID: 30000001 });
    assert.deepStrictEqual(r, { applied: true, characterID: 42, factionID: 500001, systemID: 30000001 });
    assert.deepStrictEqual(seen, [{ characterId: 42, victimFactionId: 500001, systemId: 30000001,
      atMs: 1700000000000, rewardable: true }]);
    const ctx = { pirateIds: new Set([500010]), data: STANDINGS_DATA_V1,
      params: { debounceWindowMs: 0, rawChangePerGrant: 2e-4 } };
    const sys = { controllerFactionId: 500010, occupierFactionId: null, occupationState: "STABLE" };
    const pirateKill = { ...seen[0], victimFactionId: 500010 };
    const { rewardable: _r, ...plain } = pirateKill;
    const g = planGrant(pirateKill, sys, null, ctx);
    assert.strictEqual(g.ok, true, JSON.stringify(g));
    assert.deepStrictEqual(g, planGrant(plain, sys, null, ctx));
    setLiberation(null);
  });

  test("L7-02 wrap: suppressed (abyssal policy) and unresolved victims are skipped", () => {
    const seen = [];
    setLiberation({ onNpcKill(k) { seen.push(k); return { ok: true }; } });
    const suppressed = wrapNpcKillStandingLoss(() => ({ applied: false, suppressed: true }),
      { resolveVictimFactionID: () => 500001 });
    suppressed.wrapped({ warFactionID: 500001 }, 42, { nowMs: 1, systemID: 3 });
    const noFaction = wrapNpcKillStandingLoss(() => null, { resolveVictimFactionID: () => 0 });
    noFaction.wrapped({}, 42, { nowMs: 1, systemID: 3 });
    assert.deepStrictEqual(seen, []);
    setLiberation(null);
  });

  test("L7-03 wrap: an observer failure never reaches the caller, the original result stands", () => {
    setLiberation({ onNpcKill() { throw new Error("observer boom"); } });
    const wrap = wrapNpcKillStandingLoss(() => ({ applied: true }), { resolveVictimFactionID: () => 7 });
    assert.deepStrictEqual(wrap.wrapped({}, 1, { nowMs: 2, systemID: 9 }), { applied: true });
    setLiberation(null);
  });

  test("L7-04 wrap: a throw of the original propagates (vendor behaviour untouched)", () => {
    const wrap = wrapNpcKillStandingLoss(() => { throw new Error("vendor boom"); },
      { resolveVictimFactionID: () => 7 });
    assert.throws(() => wrap.wrapped({}, 1, { nowMs: 1, systemID: 2 }), /vendor boom/);
  });

  test("L7-05 wrap: no handler registered -> safe fallback, the original runs", () => {
    setLiberation(null);
    const wrap = wrapNpcKillStandingLoss(() => ({ applied: true }), { resolveVictimFactionID: () => 7 });
    assert.deepStrictEqual(wrap.wrapped({}, 1, { nowMs: 1, systemID: 2 }), { applied: true });
    assert.strictEqual(getLiberation(), null);
  });

  test("L7-06 wrap: double wrap is a no-op; the WRAPPED symbol marks only the wrapper", () => {
    const original = () => null;
    const first = wrapNpcKillStandingLoss(original, {});
    const second = wrapNpcKillStandingLoss(first.wrapped, {});
    assert.strictEqual(second.noop, true);
    assert.strictEqual(second.wrapped, first.wrapped);
    assert.strictEqual(first.wrapped[WRAPPED], true);
    assert.strictEqual(original[WRAPPED], undefined);
    setLiberation(null);
  });

  test("L7-07 observeKill skips (no killer/system/time) and the victim-entity system fallback", () => {
    const seen = [];
    const deps = { getLiberation: () => ({ onNpcKill(k) { seen.push(k); return { ok: true }; } }),
      resolveVictimFactionID: () => 11 };
    assert.strictEqual(observeKill(null, {}, 0, { nowMs: 1, systemID: 2 }, deps).skipped, "NO_KILLER");
    assert.strictEqual(observeKill(null, {}, 1, { nowMs: 1 }, deps).skipped, "NO_SYSTEM");
    assert.strictEqual(observeKill(null, {}, 1, { systemID: 2 }, deps).skipped, "NO_TIME");
    observeKill(null, { systemID: 5 }, 1, { nowMs: 9 }, deps);
    assert.deepStrictEqual(seen, [{ characterId: 1, victimFactionId: 11, systemId: 5, atMs: 9, rewardable: true }]);
    observeKill(null, { systemID: 5, itemID: 3000000123 }, 1, { nowMs: 9 }, deps);
    assert.strictEqual(seen[1].victimId, 3000000123, "The victim itemID is the kill identity");
    assert.ok(!Object.prototype.hasOwnProperty.call(seen[0], "victimId"), "no itemID -> no victimId");
    observeKill(null, { systemID: 5, itemID: 0 }, 1, { nowMs: 9 }, deps);
    assert.deepStrictEqual(seen[2], { characterId: 1, victimFactionId: 11, systemId: 5, atMs: 9, rewardable: true });
  });

  test("L11 belt navy kill: no liberation by default, liberation with liberationKills, standings always", () => {
    const liberated = [];
    const standing = [];
    setLiberation({ onNpcKill(k) { liberated.push(k); return { ok: true }; } });
    setStandings({ onNpcKill(k) { standing.push(k); return { ok: false, reason: "NOT_PIRATE" }; } });
    try {
      const wrap = wrapNpcKillStandingLoss(() => ({ applied: true }), { resolveVictimFactionID: () => 500003 });
      const navy = { selectionID: "belt_navy:500003:belt_rat:angels:nullsec", systemID: 5, itemID: 77 };
      const options = { nowMs: 9, systemID: 5 };
      const expected = { characterId: 1, victimFactionId: 500003, systemId: 5, atMs: 9, victimId: 77, rewardable: true,
        navy: true };

      assert.deepStrictEqual(wrap.wrapped(navy, 1, options), { applied: true });
      assert.deepStrictEqual(liberated, [], "default: the navy kill skips liberation");
      assert.deepStrictEqual(standing, [expected], "standings gets the kill as before");

      setNavyKillsLiberate(true);
      wrap.wrapped(navy, 1, options);
      assert.deepStrictEqual(liberated, [expected], "liberationKills on: the kill reaches liberation");

      setNavyKillsLiberate(false);
      wrap.wrapped({ selectionID: "belt_rat:angels:nullsec", systemID: 5, itemID: 78 }, 1, options);
      assert.deepStrictEqual(liberated[1], { characterId: 1, victimFactionId: 500003, systemId: 5, atMs: 9,
        victimId: 78, rewardable: true });
    } finally {
      setNavyKillsLiberate(false);
      setLiberation(null);
      setStandings(null);
    }
  });

  test("L12 loader hook passes world.beltNavy.liberationKills to the observation", () => {
    const { buildHooks } = require("../../loader");
    const silent = { log() {}, debug() {}, logError() {} };
    const flagAfter = (world) => {
      setNavyKillsLiberate(false);
      const config = { modules: { world: { enabled: true } }, occupation: { enabled: true },
        liberation: { enabled: true }, world };
      const ctx = { logger: silent, state: { configResult: { ok: true, config } } };
      const exportsObj = { recordNpcFactionStandingLoss: () => null, resolveVictimFactionID: () => 0 };
      buildHooks(ctx).find((h) => h.name === "npcKillLiberation").run(exportsObj, "factionKillStandingRuntime", null);
      return navyKillsLiberate();
    };
    try {
      assert.strictEqual(flagAfter({ beltNavy: { liberationKills: true } }), true);
      assert.strictEqual(flagAfter({ beltNavy: { liberationKills: false } }), false);
      assert.strictEqual(flagAfter(undefined), false, "no section -> off");
    } finally {
      setNavyKillsLiberate(false);
    }
  });

  test("L13 (T4): a traffic hauler (lneTraffic) reaches no listener, counter +1", () => {
    const seen = { liberation: [], standings: [], playerActivity: [], frontJobs: [] };
    const spy = (name) => () => ({ onNpcKill(k) { seen[name].push(k.victimId); return { ok: true }; } });
    const before = killObservationCounters().trafficVictimSkipped;
    const wrap = wrapNpcKillStandingLoss(() => ({ applied: true }), { resolveVictimFactionID: () => 500014,
      getLiberation: spy("liberation"), getStandings: spy("standings"), getPlayerActivity: spy("playerActivity"),
      getFrontJobs: spy("frontJobs"), isNavyVictim: () => false });
    const options = { nowMs: 9, systemID: 30000144 };
    assert.deepStrictEqual(wrap.wrapped({ operatorKind: "lneTraffic", itemID: 1, systemID: 30000144 }, 7, options),
      { applied: true }, "the vendor result is returned unchanged");
    assert.deepStrictEqual(seen, { liberation: [], standings: [], playerActivity: [], frontJobs: [] });
    assert.strictEqual(killObservationCounters().trafficVictimSkipped, before + 1);
    assert.deepStrictEqual(observeKill({ applied: true }, { operatorKind: " lneTraffic " }, 7, options,
      { isTrafficVictim }), { skipped: "TRAFFIC" });
    wrap.wrapped({ operatorKind: "lne", itemID: 2 }, 7, options);
    assert.deepStrictEqual(seen.liberation, [2], "a LIVE battle ship still reaches the listeners");
  });

  test("CV1: a registered convoy ship carries the owner faction, liberation skips it", () => {
    const convoyVictims = require("../../lib/adapter/convoyVictims");
    const seen = { liberation: [], standings: [], playerActivity: [], frontJobs: [] };
    const spy = (name) => () => ({ onNpcKill(k) { seen[name].push(k); return { ok: true }; } });
    convoyVictims.resetConvoyVictimsForTests();
    try {
      const wrap = wrapNpcKillStandingLoss(() => ({ applied: true }), { resolveVictimFactionID: (e) => e.factionID,
        getLiberation: spy("liberation"), getStandings: spy("standings"), getPlayerActivity: spy("playerActivity"),
        getFrontJobs: spy("frontJobs"), isNavyVictim: () => false });
      const ship = { itemID: 7001, factionID: 500014, systemID: 30000144 };
      const options = { nowMs: 9, systemID: 30000144 };
      const before = killObservationCounters().convoyVictimSeen;
      assert.deepStrictEqual(convoyVictims.markConvoyShips([7001], { ownerFactionId: 500003, fleetId: "vf-1", cap: 2 }),
        { ok: true, marked: 1, evicted: 0 });
      assert.deepStrictEqual(wrap.wrapped(ship, 7, options), { applied: true });
      const expected = { characterId: 7, victimFactionId: 500003, systemId: 30000144, atMs: 9, victimId: 7001,
        rewardable: true, convoyOwnerFactionId: 500003 };
      assert.deepStrictEqual(seen.standings, [expected]);
      assert.deepStrictEqual(seen.playerActivity, [expected]);
      assert.deepStrictEqual(seen.frontJobs, [expected]);
      assert.deepStrictEqual(seen.liberation, [], "liberation skips a convoy kill");
      assert.strictEqual(killObservationCounters().convoyVictimSeen, before + 1);

      const plain = { characterId: 7, victimFactionId: 500014, systemId: 30000144, atMs: 9, victimId: 7002,
        rewardable: true };
      wrap.wrapped({ itemID: 7002, factionID: 500014, systemID: 30000144 }, 7, options);
      assert.deepStrictEqual(seen.liberation, [plain]);
      assert.deepStrictEqual(seen.standings[1], plain);

      assert.deepStrictEqual(convoyVictims.forgetConvoyShips([7001]), { ok: true, forgotten: 1 });
      wrap.wrapped(ship, 7, options);
      assert.deepStrictEqual(seen.standings[2], { ...plain, victimId: 7001 });
      assert.strictEqual(seen.liberation.length, 2);

      convoyVictims.markConvoyShips([1, 2], { ownerFactionId: 500003, fleetId: "vf-2", cap: 2 });
      assert.deepStrictEqual(convoyVictims.markConvoyShips([3], { ownerFactionId: 500003, fleetId: "vf-2", cap: 2 }),
        { ok: true, marked: 1, evicted: 1 });
      assert.strictEqual(convoyVictims.convoyOwnerOf({ itemID: 1 }), null);
      assert.strictEqual(convoyVictims.convoyOwnerOf({ itemID: 2 }), 500003);
      assert.strictEqual(convoyVictims.convoyOwnerOf({ itemID: 3 }), 500003);
      assert.deepStrictEqual(convoyVictims.markConvoyShips([4], { ownerFactionId: 0, fleetId: "vf", cap: 2 }),
        { ok: false, reason: "INVALID_INPUT" });
      assert.strictEqual(convoyVictims.convoyVictimsStatus().size, 2);
    } finally {
      convoyVictims.resetConvoyVictimsForTests();
    }
  });

  test("L8 vendor facts (v0.12.9): the seam exports and the NPC-only guard at the call site", () => {
    const runtime = fs.readFileSync(path.join(SERVER_SRC, "services", "character",
      "factionKillStandingRuntime.js"), "utf8");
    assert.ok(/module\.exports\s*=\s*\{[^}]*recordNpcFactionStandingLoss/s.test(runtime), "seam export exists");
    assert.ok(/module\.exports\s*=\s*\{[^}]*resolveVictimFactionID/s.test(runtime), "faction resolver export exists");
    const tracker = fs.readFileSync(path.join(SERVER_SRC, "space", "combat", "killmailTracker.js"), "utf8");
    assert.ok(/isNpcVictimEntity\(targetEntity\)[\s\S]{0,400}recordNpcFactionStandingLoss/.test(tracker),
      "the call site is NPC-only (a capsuleer victim never reaches the wrap)");
    assert.ok(/recordNpcFactionStandingLoss\(\s*targetEntity,/.test(tracker), "E5 the first argument is targetEntity");
    const native = fs.readFileSync(path.join(SERVER_SRC, "space", "npc", "nativeNpcService.js"), "utf8");
    const ctxSpawn = native.slice(native.indexOf("function spawnNativeNpcEntityInContext("));
    assert.ok(/entity: materializeResult\.data\.entity,/.test(ctxSpawn.slice(0, ctxSpawn.search(/^\}/m))),
      "E5 the native spawn returns the runtime scene entity as data.entity");
    const spawn = fs.readFileSync(path.join(__dirname, "..", "..", "lib", "adapter", "npcSpawn.js"), "utf8");
    assert.ok(spawn.includes("const entityId = toPositiveInt(result.data && result.data.entity && "
      + "result.data.entity.itemID);"), "E5 spawnShip entityId = data.entity.itemID");
    const victims = fs.readFileSync(path.join(__dirname, "..", "..", "lib", "adapter", "convoyVictims.js"), "utf8");
    assert.ok(/function convoyOwnerOf\(entity\)[\s\S]{0,200}toPositiveInt\(entity\.itemID\)/.test(victims),
      "E5 the register looks the victim up by entity.itemID");
  });
  test("L10 loader hook: wrap installed only with world + occupation + liberation on (cascade, DoD 13)", () => {
    const { buildHooks } = require("../../loader");
    const silent = { log() {}, debug() {}, logError() {} };
    const run = (config) => {
      const ctx = { logger: silent, state: { configResult: { ok: true, config } } };
      const hook = buildHooks(ctx).find((h) => h.name === "npcKillLiberation");
      const original = () => null;
      const exportsObj = { recordNpcFactionStandingLoss: original, resolveVictimFactionID: () => 0 };
      assert.strictEqual(hook.match("x/services/character/factionKillStandingRuntime.js", exportsObj), true);
      hook.run(exportsObj, "factionKillStandingRuntime", null);
      return exportsObj.recordNpcFactionStandingLoss !== original;
    };
    const on = { modules: { world: { enabled: true } }, occupation: { enabled: true }, liberation: { enabled: true } };
    assert.strictEqual(run(on), true, "all on -> wrapped");
    assert.strictEqual(run({ ...on, liberation: { enabled: false } }), false, "liberation off");
    assert.strictEqual(run({ ...on, occupation: { enabled: false } }), false, "occupation off");
    assert.strictEqual(run({ ...on, modules: { world: { enabled: false } } }), false, "world off");
    assert.strictEqual(run({ modules: {} }), false, "no liberation section");
    const failed = { logger: silent, state: { configResult: { ok: false, config: { modules: {} } } } };
    const hook = buildHooks(failed).find((h) => h.name === "npcKillLiberation");
    const exportsObj = { recordNpcFactionStandingLoss: () => null, resolveVictimFactionID: () => 0 };
    const before = exportsObj.recordNpcFactionStandingLoss;
    hook.run(exportsObj, "factionKillStandingRuntime", null);
    assert.strictEqual(exportsObj.recordNpcFactionStandingLoss, before, "failed config -> no wrap");
  });
};
