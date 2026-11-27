"use strict";

const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");

const { createSovProjectionFacade } = require("../../../lib/world/sovProjection");
const { createSovBudgetFromConfig, createProjectionPacer } = require("../../../lib/world/sovProjection/budget");
const { createPlayerSovService } = require("../../../lib/world/playerSov/service");
const { createPlayerSovRepository } = require("../../../lib/world/playerSov/repository");
const { createPlayerSovClockRepository } = require("../../../lib/world/playerSov/clock");
const { buildPlayerSovView, ROW_KEYS } = require("../../../lib/world/playerSov/view");
const { journalKeyOf } = require("../../../lib/world/playerSov/siege");
const { createPlayerOrgNames } = require("../../../lib/adapter/playerOrgNames");
const { createJournal } = require("../../../lib/persistence/journal");
const { classifyEntries, KINDS } = require("../../../lib/notices/sources");
const { resolveConfig } = require("../../../config");
const { harness: H } = require("../../battle/settlement.test");

const MOD_DIR = path.resolve(__dirname, "..", "..", "..");
const HOUR = 3600000;
const SANSHA = 500019;
const A = 99000001;
const CORP = 98000001;
const HUB = 1700000001;

function configOf(env = {}) {
  const r = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(), EVEJS_LNE_PLAYER_SOV_ENABLED: "1",
    ...env } });
  assert.deepStrictEqual(r.errors || [], []);
  return r.config;
}

const tick = () => new Promise((r) => setImmediate(r));

module.exports = ({ test, skip }) => {
  test("PSV3 makeDecision: readSovState playerHub true -> NONE PLAYER_CLAIM_PROTECTED skip; refused -> "
    + "CLAIM_READ_FAILED; playerHub false -> GAIN", async () => {
    const FACTION = 500016;
    const ALLIANCE = 98000001;
    let hub = { ok: true, claim: null, playerHub: true };
    const sovModules = {
      "services/sovereignty/sovSystemRules": { isSovereigntyClaimableSolarSystem: () => true },
      "services/sovereignty/sovState": { getSystemSovClaim: () => null },
      "services/sovereignty/sovGmState": {},
    };
    const requireGame = (rel) => (sovModules[rel] ? { ok: true, exports: sovModules[rel] } : { ok: false, reason: "x" });
    const vendorCalls = [];
    const adapter = { requireGame, getSovProjection: () => ({ requireGame, readSovState: async () => hub,
      projectSovCall: async (systemId, action) => {
        vendorCalls.push([systemId, action]);
        return { ok: true, action };
      } }) };
    const clock = { now: () => 1000000 };
    const config = { world: { sovProjection: { syncBatchSize: 500, syncSliceMs: 4, invaderFactionIds: "500021" } },
      limits: { maxSovWritesPerWindow: 8, sovWriteWindowMs: 300000 } };
    const facade = createSovProjectionFacade({ adapter, budget: createSovBudgetFromConfig(config, clock.now),
      journal: null, persistence: { ok: true, store: null, journal: null },
      telemetry: { count() {}, observe() {}, gauge() {} }, config, clock, logger: { log() {}, warn() {}, error() {} },
      world: { getSystem: () => ({ ok: false, reason: "NOT_FOUND" }), listSystems: () => ({ systems: [] }) },
      virtualCorps: { getFactionIdentity: () => ({ ok: true, allianceId: ALLIANCE, corporationIds: [CORP] }),
        isVirtualAlliance: (a) => a === ALLIANCE },
      pacer: createProjectionPacer({ minSpacingMs: 0, costFactor: 0, now: clock.now }), nowMs: clock.now,
      getGovernor: () => null });
    assert.ok(facade && typeof facade.makeDecision === "function");
    const decide = () => facade.makeDecision(30004000, { controllerFactionId: FACTION, phaseSeq: 1 },
      { ok: true, log: null });
    const brief = (d) => [d.action, d.reason, d.skip];
    assert.deepStrictEqual(brief(await decide()), ["NONE", "PLAYER_CLAIM_PROTECTED", true]);
    hub = { ok: false, reason: "getSystemState_failed: x" };
    assert.deepStrictEqual(brief(await decide()), ["NONE", "CLAIM_READ_FAILED", true]);
    hub = { ok: true, claim: null, playerHub: false };
    assert.deepStrictEqual(brief(await decide()), ["GAIN", "CONTROLLER_GAINED", false]);
    assert.deepStrictEqual(vendorCalls, [], "a decision writes nothing");
  });

  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("PSV4 auto-capture refusal deferred without dirty (next pass skippedUnchanged, the younger claim), "
    + "retried after retakeRetryMs; the mirror END of RETAKING writes PLAYER_SOV_LOST (mail kind)", () =>
    H.withStore(driver, async (reopen) => {
    const { store } = reopen();
    let t = 10 * HOUR;
    const clock = { now: () => t };
    const journal = createJournal({ clock, maxPayloadBytes: 8192, maxRows: 500 });
    const config = configOf({ EVEJS_LNE_PLAYER_SOV_AUTO_CAPTURE_MS: "60000", EVEJS_LNE_PLAYER_SOV_MAX_RETAKES_PER_PASS:
      "1" });
    const repo = createPlayerSovRepository();
    const [S1, S2, S3] = [30004001, 30004002, 30004003];
    const tx = (fn) => {
      const r = store.transaction("test", fn);
      assert.ok(r.ok, JSON.stringify(r));
      return r.value;
    };
    const retaking = tx((db) => {
      repo.insertClaim(db, { systemId: S1, allianceId: A, corpId: CORP, hubItemId: HUB, origin: "MIRROR",
        state: "CAPTURING", at: 1000 });
      repo.insertClaim(db, { systemId: S2, allianceId: A + 1, corpId: CORP, hubItemId: HUB + 1, origin: "MIRROR",
        state: "CAPTURING", at: 2000 });
      let c = repo.insertClaim(db, { systemId: S3, allianceId: A + 2, corpId: CORP, hubItemId: HUB + 2,
        origin: "MIRROR", state: "HELD", at: 3000 }).claim;
      c = repo.transition(db, { claim: c, to: "SIEGED", at: 4000, attackerFactionId: SANSHA }).claim;
      c = repo.transition(db, { claim: c, to: "REINFORCED", at: 5000, reinforcedUntil: 6000 }).claim;
      return repo.transition(db, { claim: c, to: "RETAKING", at: 7000 }).claim;
    });
    const neutral = (systemId, allianceId, itemId) => ({ systemId, allianceId: null, corpId: null, hubItemId: null,
      neutralHub: { itemId, allianceId, corpId: CORP }, virtualClaim: false });
    const captures = [];
    const adapter = { readSovereigntyTableUpdatedAt: () => ({ ok: true, updatedAt: 1 }),
      readPlayerSov: () => ({ ok: true, rows: [neutral(S1, A, HUB), neutral(S2, A + 1, HUB + 1)] }),
      capturePlayerSov: (systemId) => {
        captures.push(systemId);
        return Promise.resolve(systemId === S2 ? { ok: true, outcome: "captured" }
          : { ok: false, reason: "SOV_CALL_FAILED" });
      } };
    const service = createPlayerSovService({ store, repository: repo, adapter, config, clock, chunkRows: 50, journal,
      virtualCorps: { whenReady: () => Promise.resolve(), isVirtualAlliance: () => false } });
    await tick();
    const pass = async () => {
      const r = service.runPass();
      await tick();
      return r;
    };
    await pass();
    assert.deepStrictEqual(captures, [S1]);
    t += 1000;
    const second = await pass();
    assert.deepStrictEqual([second.skipped, service.getStatus().counters.skippedUnchanged, captures], [true, 1, [S1, S2]]);
    t += config.playerSov.retakeRetryMs;
    await pass();
    const c = service.getStatus().counters;
    assert.deepStrictEqual([captures, c.autoCaptured, c.autoCaptureRefused, c.skippedUnchanged], [[S1, S2, S1], 1, 2, 1]);

    const lost = tx((db) => repo.getById(db, retaking.claimId)).claim;
    assert.deepStrictEqual([lost.state, lost.endReason], ["LOST", "RETAKEN"]);
    const entries = tx((db) => journal.listAfter(db, { afterId: 0, uptoId: journal.headId(db).headId,
      aggregateTypes: ["player_sov"], limit: 100 })).entries;
    assert.deepStrictEqual(entries.map((e) => [e.eventType, e.key]), [["PLAYER_SOV_LOST", journalKeyOf(lost)]]);
    const mail = classifyEntries(entries, new Map(), { now: t, maxEventAgeMs: 30 * 24 * HOUR, kinds: new Set(KINDS),
      sieges: new Map(), allianceNames: new Map() });
    assert.deepStrictEqual(mail.events.map((e) => [e.kind, e.ownerCorpId, e.attacker]),
      [["PLAYER_SOV_LOST", CORP, SANSHA]]);
  }));

  needsDriver("PSV5 panel player-sov: names from one readPlayerOrgNames call (null -> id), clock creditedMs/needMs "
    + "of the stage; DRIFT of playerSovNames -> ids, panel available", () => H.withStore(driver, async (reopen) => {
    const { store } = reopen();
    const t = 10 * HOUR;
    const repo = createPlayerSovRepository();
    const clockRepo = createPlayerSovClockRepository();
    const tx = (fn) => {
      const r = store.transaction("test", fn);
      assert.ok(r.ok, JSON.stringify(r));
      return r.value;
    };
    tx((db) => {
      let c = repo.insertClaim(db, { systemId: 30004001, allianceId: A, corpId: CORP, hubItemId: HUB, origin: "MIRROR",
        state: "HELD", at: t - 2 * HOUR }).claim;
      c = repo.transition(db, { claim: c, to: "SIEGED", at: t - HOUR, attackerFactionId: SANSHA }).claim;
      assert.ok(clockRepo.put(db, { claimId: c.claimId, phase: "SIEGED", phaseKey: c.attackStartedAt,
        creditedMs: 600000, sampledAt: t, expectVersion: null }).ok);
      return repo.insertClaim(db, { systemId: 30004002, allianceId: A + 1, corpId: CORP + 1, hubItemId: HUB + 1,
        origin: "MIRROR", state: "HELD", at: t });
    });
    let drift = null;
    const vendor = { getAllianceRecord: (id) => (id === A ? { allianceName: "Alpha Alliance" } : null),
      getCorporationRecord: (id) => (id === CORP ? { corporationName: "Corp One" } : null) };
    const names = createPlayerOrgNames({ requireGame: () => ({ ok: true, exports: vendor }), disabledReason: () => drift });
    const calls = [];
    const view = buildPlayerSovView({ store, repository: repo, maxRows: 10, clockRepo,
      needMs: { SIEGED: HOUR, REINFORCED: 2 * HOUR }, readOrgNames: (spec) => {
        calls.push(spec);
        return names.read(spec);
      } });
    const pick = (d) => d.claims.map((r) => [r.systemId, r.alliance, r.corp, r.clockCreditedMs, r.clockNeedMs]);
    const data = view.getData();
    assert.strictEqual(data.available, true);
    assert.deepStrictEqual(data.claims.map((r) => Object.keys(r)), [[...ROW_KEYS], [...ROW_KEYS]]);
    assert.deepStrictEqual(pick(data).sort((a, b) => a[0] - b[0]), [
      [30004001, "Alpha Alliance", "Corp One", 600000, HOUR], [30004002, String(A + 1), String(CORP + 1), null, null]]);
    assert.strictEqual(calls.length, 1, "one names call per render");
    drift = "DRIFT:services/corporation/corporationState";
    const drifted = view.getData();
    assert.deepStrictEqual([drifted.available, pick(drifted).sort((a, b) => a[0] - b[0])], [true, [
      [30004001, String(A), String(CORP), 600000, HOUR], [30004002, String(A + 1), String(CORP + 1), null, null]]]);
  }));
};
