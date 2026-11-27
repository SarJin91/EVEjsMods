"use strict";

const assert = require("node:assert");
const path = require("node:path");
const { withHarness, loadDriver, deferred, settle, T0, FAKE_SRC } = require("./harness");

const MOD_DIR = path.resolve(__dirname, "..", "..", "..");
const SS = 30000142;
const F = 500016;
const A = 98000001;
const G = 500017;
const B = 98000002;
const PLAYER = 99000050;
const IDS = [[F, A], [G, B]];

function lossFacts(h, ss) {
  return h.facts(`sov:native:${ss}:%`).filter((f) => !/:(drop|abandon)$/.test(f.idempotency_key));
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  const needsDriver = (name, fn) => (driver.ok ? test(name, fn) : skip(name, `better-sqlite3 unavailable (${driver.detail})`));

  needsDriver("TD1 happy path: real GAIN -> hub destroyed -> episode opened by the pass -> drop+abandon, log NATIVE_LOSS, one fact; no loop", async () => {
    await withHarness(async (h) => {
      h.seedSystem(SS, F);
      await h.gain(SS);
      assert.deepStrictEqual([h.logOf(SS).last_action, h.logOf(SS).last_controller, h.logOf(SS).last_alliance], ["GAIN", F, A]);
      const rec = await h.startReconcile();

      rec.runPass();
      assert.strictEqual(rec.getStatus().counters.markedForeign, 0);
      assert.strictEqual(rec.getStatus().state, "ready");

      h.clock.advance(60000);
      h.vendor.destroyHub(SS, A, h.clock.now() - 1000);
      const before = h.influenceOf(SS, F);
      rec.runPass();
      const c = rec.getStatus().counters;
      assert.deepStrictEqual([c.markedForeign, c.factsApplied, c.dropApplied, c.abandonApplied, c.governorRefused],
        [1, 1, 1, 1, 0], JSON.stringify(c));
      const lg = h.logOf(SS);
      assert.deepStrictEqual([lg.last_action, lg.last_controller, lg.last_alliance], ["NATIVE_LOSS", null, null]);
      assert.deepStrictEqual(h.episodes(SS), []);
      const facts = lossFacts(h, SS);
      assert.strictEqual(facts.length, 1);
      assert.match(facts[0].idempotency_key, new RegExp(`^sov:native:${SS}:\\d+:\\d+:HUB_DESTROYED$`));
      assert.strictEqual(h.system(SS).controllerFactionId, null);
      assert.ok(h.influenceOf(SS, F) < before, "influence dropped");

      const anchors = h.vendor.calls.filter((x) => x[0] === "anchor").length;
      rec.runPass();
      rec.runPass();
      assert.strictEqual(rec.getStatus().counters.factsApplied, 1);
      assert.strictEqual(rec.getStatus().counters.markedForeign, 1);
      await h.ctx.sovProjection.requestProject(SS);
      await settle();
      assert.strictEqual(h.vendor.calls.filter((x) => x[0] === "anchor").length, anchors, "projection does not re-anchor");
    }, { identities: IDS });
  });

  needsDriver("TD2 restart: abandonInTx throws after the drop -> full rollback (episode kept), new instance -> one fact, third -> none", async () => {
    await withHarness(async (h) => {
      h.seedSystem(SS, F);
      await h.gain(SS);
      h.clock.advance(60000);
      h.vendor.destroyHub(SS, A, h.clock.now() - 1000);
      const before = h.influenceOf(SS, F);
      const failing = { ...h.occupation, abandonInTx: () => { throw new Error("ABANDON_FAILED"); } };
      const rec1 = await h.startReconcile({ occupation: failing });
      rec1.runPass();
      const c1 = rec1.getStatus().counters;
      assert.deepStrictEqual([c1.markedForeign, c1.factsApplied, c1.factsFailed], [1, 0, 1], JSON.stringify(c1));
      assert.strictEqual(h.episodes(SS).length, 1, "episode committed by the mark TX");
      assert.strictEqual(h.influenceOf(SS, F), before, "drop rolled back");
      assert.strictEqual(h.logOf(SS).last_action, "GAIN");
      assert.strictEqual(rec1.getStatus().cursor, 0, "cursor stays after an unclean pass");
      rec1.stop("test");

      const rec2 = await h.startReconcile();
      rec2.runPass();
      assert.strictEqual(rec2.getStatus().counters.factsApplied, 1);
      assert.strictEqual(rec2.getStatus().counters.markedForeign, 0, "the same episode, not a new one");
      rec2.stop("test");
      const rec3 = await h.startReconcile();
      rec3.runPass();
      assert.strictEqual(rec3.getStatus().counters.factsApplied, 0);
      assert.strictEqual(lossFacts(h, SS).length, 1);
    }, { identities: IDS });
  });

  needsDriver("TD3 kinds: PLAYER_CLAIM loss; CONTESTED -> DEFERRED -> RESTORED; DEFERRED past maxDeferMs -> DROP_ONLY; DEFENDED x2 once", async () => {
    await withHarness(async (h) => {
      const sPlayer = SS;
      const sRestored = SS + 1;
      const sDropOnly = SS + 2;
      const sDefended = SS + 3;
      for (const ss of [sPlayer, sRestored, sDropOnly, sDefended]) {
        h.seedSystem(ss, F);
        await h.gain(ss);
      }
      const rec = await h.startReconcile();
      rec.runPass();
      h.clock.advance(60000);
      h.vendor.setClaim(sPlayer, PLAYER);
      h.setState(sRestored, { occupationState: "CONTESTED" });
      h.vendor.setClaim(sRestored, PLAYER);
      h.setState(sDropOnly, { occupationState: "CONTESTED" });
      h.vendor.setClaim(sDropOnly, PLAYER);
      h.vendor.addReceipt(sDefended, { allianceId: A, result: "defender", completedAtMs: h.clock.now() - 2, epoch: "d1" });
      h.vendor.addReceipt(sDefended, { allianceId: A, result: "defender", completedAtMs: h.clock.now() - 1, epoch: "d2" });
      rec.runPass();
      let c = rec.getStatus().counters;
      assert.deepStrictEqual([c.markedForeign, c.factsApplied, c.abandonApplied, c.defendedProcessed, c.deferredRows],
        [3, 1, 1, 2, 2], JSON.stringify(c));
      assert.strictEqual(h.logOf(sPlayer).last_action, "NATIVE_LOSS");
      assert.match(lossFacts(h, sPlayer)[0].idempotency_key, /:PLAYER_CLAIM$/);
      assert.deepStrictEqual(h.facts(`sov:native:${sDefended}:camp:%`).map((f) => f.event_type), ["DEFENDED", "DEFENDED"]);
      assert.strictEqual(h.system(sDefended).controllerFactionId, F, "DEFENDED leaves the world unchanged");
      assert.strictEqual(h.episodes(sRestored).length, 1);

      h.vendor.setClaim(sRestored, A);
      h.clock.advance(h.config.world.sovReconcile.maxDeferMs + 1);
      rec.runPass();
      c = rec.getStatus().counters;
      assert.strictEqual(c.deletedRestored, 1);
      assert.deepStrictEqual(h.episodes(sRestored), []);
      assert.deepStrictEqual(lossFacts(h, sRestored), [], "RESTORED is not a fact");
      assert.strictEqual(h.logOf(sDropOnly).last_action, "NATIVE_LOSS");
      assert.strictEqual(h.system(sDropOnly).controllerFactionId, F, "DROP_ONLY: no abandon");
      assert.deepStrictEqual([c.factsApplied, c.dropApplied, c.abandonApplied, c.defendedProcessed], [2, 2, 1, 2],
        JSON.stringify(c));
    }, { identities: IDS });
  });

  needsDriver("TD3a SUPERSEDED: world controller != episode faction -> NATIVE_LOSS, no drop, no abandon", async () => {
    await withHarness(async (h) => {
      h.seedSystem(SS, F);
      await h.gain(SS);
      assert.deepStrictEqual([h.logOf(SS).last_action, h.logOf(SS).last_controller, h.logOf(SS).last_alliance], ["GAIN", F, A]);
      h.setState(SS, { occupationState: "CONTESTED" });
      h.vendor.setClaim(SS, PLAYER);
      h.clock.advance(1000);
      h.vendor.addReceipt(SS, { allianceId: A, result: "attacker", completedAtMs: h.clock.now(), epoch: `att-${SS}` });
      const rec = await h.startReconcile();
      await settle(1);
      rec.runPass();
      const c1 = rec.getStatus().counters;
      assert.strictEqual(c1.markedForeign, 1, "episode marked");
      assert.strictEqual(c1.factsApplied, 0, "fact deferred");
      assert.strictEqual(h.episodes(SS).length, 1, "episode exists");
      
      h.setState(SS, { controllerFactionId: G });
      h.clock.advance(60000);
      const before = h.influenceOf(SS, F);
      rec.runPass();
      const c = rec.getStatus().counters;
      assert.deepStrictEqual([c.markedForeign, c.factsApplied, c.dropApplied, c.abandonApplied, c.coreProtected, c.stale, c.factsStale, c.episodeDeleted],
        [1, 1, 0, 0, 0, 0, 0, 1], JSON.stringify(c));
      const lg = h.logOf(SS);
      assert.deepStrictEqual([lg.last_action, lg.last_controller, lg.last_alliance], ["NATIVE_LOSS", null, null]);
      assert.strictEqual(h.episodes(SS).length, 0, "episode deleted");
      const facts = lossFacts(h, SS);
      assert.strictEqual(facts.length, 1);
      assert.match(facts[0].idempotency_key, new RegExp(`^sov:native:${SS}:\\d+:\\d+:HUB_DESTROYED$`));
      assert.strictEqual(h.system(SS).controllerFactionId, G, "SUPERSEDED: controller stays G");
      assert.strictEqual(h.influenceOf(SS, F), before, "SUPERSEDED: no influence drop");
    }, { identities: IDS });
  });

  needsDriver("TD3b hubLossInfluencePoints=0: LOSS_APPLIED without drop, abandon still runs", async () => {
    await withHarness(async (h) => {
      h.seedSystem(SS, F);
      await h.gain(SS);
      const rec = await h.startReconcile({ config: { ...h.config, world: { ...h.config.world, sovReconcile: { ...h.config.world.sovReconcile, hubLossInfluencePoints: 0 } } } });
      rec.runPass();
      h.clock.advance(60000);
      h.vendor.destroyHub(SS, A, h.clock.now() - 1000);
      const before = h.influenceOf(SS, F);
      rec.runPass();
      const c = rec.getStatus().counters;
      assert.deepStrictEqual([c.markedForeign, c.factsApplied, c.dropApplied, c.abandonApplied],
        [1, 1, 0, 1], JSON.stringify(c));
      const lg = h.logOf(SS);
      assert.deepStrictEqual([lg.last_action, lg.last_controller, lg.last_alliance], ["NATIVE_LOSS", null, null]);
      assert.strictEqual(h.episodes(SS).length, 0);
      const facts = lossFacts(h, SS);
      assert.strictEqual(facts.length, 1);
      assert.match(facts[0].idempotency_key, new RegExp(`^sov:native:${SS}:\\d+:\\d+:HUB_DESTROYED$`));
      assert.strictEqual(h.system(SS).controllerFactionId, null, "controller becomes null after abandon");
      assert.strictEqual(h.influenceOf(SS, F), before, "no influence drop when points=0");
    }, { identities: IDS });
  });

  needsDriver("TD3c STALE: log rewritten after mark -> episode deleted, zero facts", async () => {
    await withHarness(async (h) => {
      h.seedSystem(SS, F);
      await h.gain(SS);
      h.setState(SS, { occupationState: "CONTESTED" });
      h.vendor.setClaim(SS, PLAYER);
      const rec1 = await h.startReconcile();
      await settle(1);
      rec1.runPass();
      const c1 = rec1.getStatus().counters;
      assert.strictEqual(c1.markedForeign, 1, "episode marked");
      assert.strictEqual(c1.factsApplied, 0, "fact deferred");
      assert.strictEqual(h.episodes(SS).length, 1, "episode exists");
      
      h.writeLog(SS, { action: "REPROJECT", seq: h.logOf(SS).last_seq + 1 });
      
      h.clock.advance(h.config.world.sovReconcile.maxDeferMs + 1);
      
      const rec2 = await h.startReconcile();
      h.vendor.addReceipt(SS, { allianceId: A, result: "attacker", completedAtMs: h.clock.now() - 1000, epoch: `att-${SS}` });
      rec2.runPass();
      const c2 = rec2.getStatus().counters;
      assert.deepStrictEqual([c2.markedForeign, c2.factsApplied, c2.stale, c2.factsStale, c2.episodeDeleted],
        [0, 0, 1, 1, 1], JSON.stringify(c2));
      assert.strictEqual(h.episodes(SS).length, 0);
      assert.strictEqual(h.logOf(SS).last_action, "REPROJECT");
      assert.strictEqual(lossFacts(h, SS).length, 0);
    }, { identities: IDS });
  });

  needsDriver("TD4 gates: real governor OVERLOADED -> zero work, NORMAL -> work; virtualCorps pending -> zero work, then MOD_OTHER -> REPROJECT; STALE_SEQ -> stale, rollback", async () => {
    await withHarness(async (h) => {
      h.seedSystem(SS, F);
      await h.gain(SS);
      h.seedSystem(SS + 1, F);
      await h.gain(SS + 1);

      const vcGate = deferred();
      const vc = { ...h.virtualCorps, whenReady: () => vcGate.promise };
      const rec = await h.startReconcile({ virtualCorps: vc });
      h.clock.advance(60000);
      h.vendor.setClaim(SS, B);
      assert.strictEqual(h.setLoad(135), "OVERLOADED");
      rec.runPass();
      assert.deepStrictEqual([rec.getStatus().state, rec.getStatus().reason], ["idle", "GOVERNOR_DEFERRED"]);
      assert.strictEqual(rec.getStatus().counters.governorRefused, 1);
      assert.strictEqual(h.setLoad(100), "NORMAL");

      rec.runPass();
      assert.deepStrictEqual([rec.getStatus().reason, rec.getStatus().counters.markedForeign], ["VCORPS_PENDING", 0]);
      vcGate.resolve();
      await settle(1);
      rec.runPass();
      let c = rec.getStatus().counters;
      assert.deepStrictEqual([c.markedForeign, c.factsApplied, c.abandonApplied, c.dropApplied], [1, 1, 0, 0], JSON.stringify(c));
      assert.match(lossFacts(h, SS)[0].idempotency_key, /:MOD_OTHER$/);
      assert.strictEqual(h.logOf(SS).last_action, "REPROJECT");

      const lg = h.logOf(SS + 1);
      h.writeLog(SS + 1, { controller: lg.last_controller, alliance: lg.last_alliance, corp: lg.last_corp,
        action: "SYNC", seq: lg.last_seq + 100 });
      h.vendor.destroyHub(SS + 1, A, h.clock.now() - 1);
      const before = h.influenceOf(SS + 1, F);
      rec.runPass();
      c = rec.getStatus().counters;
      assert.deepStrictEqual([c.stale, c.factsFailed], [1, 0], JSON.stringify(c));
      assert.strictEqual(h.influenceOf(SS + 1, F), before);
      assert.strictEqual(h.logOf(SS + 1).last_action, "SYNC");
    }, { identities: IDS });
  });

  needsDriver("TD4a enabled=false: startSovReconcile returns disabled_by_config", async () => {
    const { startSovReconcile } = require("../../../lib/world/sovReconcile");
    const { startSovProjection } = require("../../../lib/world/sovProjection");
    const driver = loadDriver();
    const tmp = require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "lne-sovrec-"));
    const file = require("node:path").join(tmp, "world.sqlite");
    const { seedDbFile } = require("../../_support/dbTemplate");
    const { MIGRATIONS } = require("../../../lib/persistence/migrations");
    const { openStore } = require("../../../lib/persistence/store");
    seedDbFile(driver, file, { migrations: MIGRATIONS, seed: 1 });
    const opened = openStore({ filePath: file, openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
      busyTimeoutMs: 0, maxRowsPerTransaction: 500, maxWriteMsPerPass: 5, randomSeed: () => 1, migrations: MIGRATIONS });
    assert.ok(opened.ok);
    const store = opened.store;
    const { createJournal } = require("../../../lib/persistence/journal");
    const { createWorldStateRepository } = require("../../../lib/world/worldStateRepository");
    const { createOccupationService } = require("../../../lib/world/occupation/occupationService");
    const { createAdapter } = require("../../../lib/adapter");
    const { resolveConfig } = require("../../../config");
    const { createLoadGovernor, normalizeOptions } = require("../../../lib/telemetry/loadGovernor");
    const { governorOptionsFromConfig } = require("../../../lib/telemetry/governorService");
    const clock = { now: () => T0 };
    const journal = createJournal({ clock, maxPayloadBytes: 4096, maxRows: 100000 });
    const repo = createWorldStateRepository({ journal, clock, limits: { maxFactionsPerSystem: 5, maxBatchReadIds: 100, maxListLimit: 1000 } });
    const unwrap = (r) => (r && r.ok ? r.value : { ok: false, reason: (r && r.reason) || "TX_FAILED" });
    const world = { repository: repo, getSystem: (id, o) => unwrap(store.transaction("w.getSystem", (tx) => repo.getSystem(tx, id, o))), listSystems: () => ({ ok: true, systems: [], nextAfterSystemId: null }) };
    const occupation = createOccupationService({ store, repository: repo, fleets: { repository: { listFleetsInSystem: () => ({ ok: true, fleets: [] }) } }, scheduler: null, clock, config: resolveConfig({ modDir: MOD_DIR }).config });
    const vcReady = { promise: Promise.resolve(), resolve() {} };
    const virtualCorps = { whenReady: () => vcReady.promise, getFactionIdentity: () => ({ ok: true, allianceId: 0, corporationIds: [], characterIds: [] }), isVirtualAlliance: () => false };
    const adapter = createAdapter({ moduleApi: { _cache: {} } });
    adapter.setServerSrc(FAKE_SRC);
    adapter.markBooted();
    adapter.getProcessRole = () => "world";
    const options = normalizeOptions({ ...governorOptionsFromConfig(resolveConfig({ modDir: MOD_DIR }).config),
      signal: "p95" }).options;
    const governor = createLoadGovernor({ options, tickAvailable: true, nowMs: 0 });
    const config = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_WORLD_SOVRECONCILE_ENABLED: "0", EVEJS_LNE_SOVPROJECTION_ENABLED: "1" } }).config;
    const ctx = { config, persistence: { ok: true, store, journal }, adapter, virtualCorps, occupation, world, telemetry: { count() {}, gauge() {}, observe() {} }, logger: { log() {} }, clock, getGovernor: () => governor, fail: () => {} };
    const proj = startSovProjection(ctx);
    assert.ok(proj.ok);
    const rec = startSovReconcile(ctx);
    assert.strictEqual(rec.ok, false);
    assert.strictEqual(rec.reason, "disabled_by_config");
    store.close("test_cleanup");
    require("node:fs").rmSync(tmp, { recursive: true, force: true });
  });

  needsDriver("TD4b sovProjection stopped: runPass returns dependency_disabled:sovProjection", async () => {
    await withHarness(async (h) => {
      h.ctx.sovProjection.stop("test");
      await settle(1);
      const rec = await h.startReconcile();
      const res = rec.runPass();
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.reason, "dependency_disabled:sovProjection");
      const c = rec.getStatus().counters;
      assert.strictEqual(c.projectionDisabled, 1);
    }, { identities: IDS });
  });

  needsDriver("TD4c syncState pending: runPass returns SOV_SYNC_PENDING", async () => {
    await withHarness(async (h) => {
      const pendingProjection = {
        ...h.ctx.sovProjection,
        getStatus: () => ({ ...h.ctx.sovProjection.getStatus(), syncState: "pending" }),
      };
      const rec = await h.startReconcile({ sovProjection: pendingProjection });
      const res = rec.runPass();
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.reason, "SOV_SYNC_PENDING");
      const c = rec.getStatus().counters;
      assert.strictEqual(c.syncPending, 1);
    }, { identities: IDS });
  });

  needsDriver("TD4d DRIFT checkSovNativeSeams fail: startSovReconcile returns SOV_SEAM_UNAVAILABLE", async () => {
    const { startSovReconcile } = require("../../../lib/world/sovReconcile");
    const { startSovProjection, stopSovProjection } = require("../../../lib/world/sovProjection");
    const driver = loadDriver();
    const tmp = require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "lne-sovrec-"));
    const file = require("node:path").join(tmp, "world.sqlite");
    const { seedDbFile } = require("../../_support/dbTemplate");
    const { MIGRATIONS } = require("../../../lib/persistence/migrations");
    const { openStore } = require("../../../lib/persistence/store");
    seedDbFile(driver, file, { migrations: MIGRATIONS, seed: 1 });
    const opened = openStore({ filePath: file, openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
      busyTimeoutMs: 0, maxRowsPerTransaction: 500, maxWriteMsPerPass: 5, randomSeed: () => 1, migrations: MIGRATIONS });
    assert.ok(opened.ok);
    const store = opened.store;
    const { createJournal } = require("../../../lib/persistence/journal");
    const { createWorldStateRepository } = require("../../../lib/world/worldStateRepository");
    const { createOccupationService } = require("../../../lib/world/occupation/occupationService");
    const { createAdapter } = require("../../../lib/adapter");
    const { resolveConfig } = require("../../../config");
    const { createLoadGovernor, normalizeOptions } = require("../../../lib/telemetry/loadGovernor");
    const { governorOptionsFromConfig } = require("../../../lib/telemetry/governorService");
    const clock = { now: () => T0 };
    const journal = createJournal({ clock, maxPayloadBytes: 4096, maxRows: 100000 });
    const repo = createWorldStateRepository({ journal, clock, limits: { maxFactionsPerSystem: 5, maxBatchReadIds: 100, maxListLimit: 1000 } });
    const unwrap = (r) => (r && r.ok ? r.value : { ok: false, reason: (r && r.reason) || "TX_FAILED" });
    const world = { repository: repo, getSystem: (id, o) => unwrap(store.transaction("w.getSystem", (tx) => repo.getSystem(tx, id, o))), listSystems: () => ({ ok: true, systems: [], nextAfterSystemId: null }) };
    const occupation = createOccupationService({ store, repository: repo, fleets: { repository: { listFleetsInSystem: () => ({ ok: true, fleets: [] }) } }, scheduler: null, clock, config: resolveConfig({ modDir: MOD_DIR }).config });
    const vcReady = { promise: Promise.resolve(), resolve() {} };
    const virtualCorps = { whenReady: () => vcReady.promise, getFactionIdentity: () => ({ ok: true, allianceId: 0, corporationIds: [], characterIds: [] }), isVirtualAlliance: () => false };
    const adapter = createAdapter({ moduleApi: { _cache: {} } });
    adapter.setServerSrc(FAKE_SRC);
    adapter.markBooted();
    adapter.getProcessRole = () => "world";
    adapter.getSovNative = () => ({ checkSovNativeSeams: () => ({ ok: false, reason: "DRIFT", missing: ["sovState.getSystemState"] }) });
    const options = normalizeOptions({ ...governorOptionsFromConfig(resolveConfig({ modDir: MOD_DIR }).config),
      signal: "p95" }).options;
    const governor = createLoadGovernor({ options, tickAvailable: true, nowMs: 0 });
    const config = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_WORLD_SOVRECONCILE_ENABLED: "1", EVEJS_LNE_SOVPROJECTION_ENABLED: "1" } }).config;
    const ctx = { config, persistence: { ok: true, store, journal }, adapter, virtualCorps, occupation, world, telemetry: { count() {}, gauge() {}, observe() {} }, logger: { log() {} }, clock, getGovernor: () => governor, fail: () => {} };
    const proj = startSovProjection(ctx);
    assert.ok(proj.ok);
    await proj.whenReady;
    for (let i = 0; i < 50 && !["done", "failed"].includes(ctx.sovProjection.getStatus().syncState); i += 1) await settle(1);
    const projStatus = proj.service.getStatus();
    assert.strictEqual(projStatus.state, "ready", `projection state should be ready, got ${projStatus.state}`);
    assert.notStrictEqual(projStatus.syncState, "unavailable", "projection should not be unavailable");
    assert.notStrictEqual(projStatus.syncState, "stopped", "projection should not be stopped");
    const rec = startSovReconcile(ctx);
    assert.strictEqual(rec.ok, false);
    assert.strictEqual(rec.reason, "SOV_SEAM_UNAVAILABLE");
    assert.ok(rec.detail && rec.detail.missing && rec.detail.missing.includes("sovState.getSystemState"));
    assert.strictEqual(proj.service.getStatus().state, "ready");
    stopSovProjection(ctx);
    store.close("test_cleanup");
    require("node:fs").rmSync(tmp, { recursive: true, force: true });
  });

  needsDriver("TD4e isProjecting: system skipped, inFlightSkipped counter incremented", async () => {
    await withHarness(async (h) => {
      h.seedSystem(SS, F);
      await h.gain(SS);
      h.setState(SS, { occupationState: "CONTESTED" });
      h.vendor.setClaim(SS, PLAYER);
      const normalRec = await h.startReconcile();
      await settle(1);
      normalRec.runPass();
      assert.strictEqual(normalRec.getStatus().counters.factsApplied, 0, "fact deferred");
      assert.strictEqual(h.episodes(SS).length, 1, "episode exists");
      normalRec.stop("test");
      
      const projectingProjection = {
        ...h.ctx.sovProjection,
        isProjecting: (sid) => sid === SS,
      };
      const rec = await h.startReconcile({ sovProjection: projectingProjection });
      h.clock.advance(60000);
      h.vendor.destroyHub(SS, A, h.clock.now() - 1000);
      h.vendor.addReceipt(SS, { allianceId: A, result: "attacker", completedAtMs: h.clock.now() - 1000, epoch: `att-${SS}` });
      rec.runPass();
      const c = rec.getStatus().counters;
      assert.strictEqual(c.inFlightSkipped, 1, "inFlightSkipped should be 1");
      assert.strictEqual(c.factsApplied, 0, "no facts applied when projecting");
      assert.strictEqual(c.markedForeign, 0, "no new marks when projecting (already marked)");
      assert.strictEqual(h.episodes(SS).length, 1, "episode still open");
    }, { identities: IDS });
  });

  needsDriver("TD5 config, reset, cursor: 12 keys, governorWorkClass = WORK_CLASS_ORDER, WIPE; cursor over log rows; vendor claim fault -> no fact, cursor stays", async () => {
    const { SCHEMA, resolveConfig } = require("../../../config");
    const { WORK_CLASS_ORDER } = require("../../../lib/telemetry/loadGovernor");
    assert.strictEqual(SCHEMA.filter((k) => k.key.startsWith("world.sovReconcile.")).length, 13);
    for (const wc of WORK_CLASS_ORDER) {
      const r = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_WORLD_SOVRECONCILE_GOVERNOR_WORK_CLASS: wc } });
      assert.strictEqual(r.config.world.sovReconcile.governorWorkClass, wc);
    }
    const bad = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_WORLD_SOVRECONCILE_GOVERNOR_WORK_CLASS: "BUSY" } });
    assert.strictEqual(bad.config.world.sovReconcile.governorWorkClass, "OPERATIONAL");
    assert.ok(bad.warnings.some((w) => w.includes("GOVERNOR_WORK_CLASS")));
    const { TABLE_POLICY, ACTION } = require("../../../lib/persistence/worldReset");
    assert.strictEqual(TABLE_POLICY.world_sov_reconcile, ACTION.WIPE);
    assert.ok(require("../../../lib/telemetry/registry").CHANNELS.includes("sovReconcile"));

    await withHarness(async (h) => {
      for (let i = 0; i < 5; i += 1) {
        h.seedSystem(SS + i, F);
        await h.gain(SS + i);
      }
      const rec = await h.startReconcile();
      rec.runPass();
      assert.strictEqual(rec.getStatus().cursor, SS + 1);
      h.vendor.faults.claimThrows = true;
      h.vendor.destroyHub(SS + 2, A, h.clock.now());
      rec.runPass();
      let c = rec.getStatus().counters;
      assert.deepStrictEqual([c.seamUnavailable > 0, c.markedForeign, c.factsApplied, rec.getStatus().cursor],
        [true, 0, 0, SS + 1], JSON.stringify(c));
      h.vendor.faults.claimThrows = false;
      h.clock.advance(1000);
      rec.runPass();
      assert.strictEqual(rec.getStatus().cursor, SS + 3);
      c = rec.getStatus().counters;
      assert.deepStrictEqual([c.markedForeign, c.factsApplied], [1, 1]);
      rec.runPass();
      assert.strictEqual(rec.getStatus().cursor, 0, "short page wraps around");
    }, { identities: IDS, env: { EVEJS_LNE_WORLD_SOVRECONCILE_MAX_ROWS_PER_PASS: "2" } });
  });

  needsDriver("TD6 core protected: NATIVE_LOSS -> DROP_ONLY, no abandon, one fact, controller stays, idempotent", async () => {
    const { getCoreIndex } = require("../../../lib/world/core/index");
    const baseIndex = getCoreIndex({
      world: { coreProtectionEnabled: true, coreMaxSystemsPerFaction: 3 },
    });
    const coreIdx = Object.freeze({
      ...baseIndex,
      systems: new Map([[SS, F]]),
      enabled: true,
    });

    await withHarness(async (h) => {
      h.seedSystem(SS, F);
      await h.gain(SS);
      assert.deepStrictEqual([h.logOf(SS).last_action, h.logOf(SS).last_controller, h.logOf(SS).last_alliance], ["GAIN", F, A]);
      const rec = await h.startReconcile({ coreIndex: coreIdx });

      rec.runPass();
      assert.strictEqual(rec.getStatus().counters.markedForeign, 0);
      assert.strictEqual(rec.getStatus().state, "ready");

      h.clock.advance(60000);
      h.vendor.destroyHub(SS, A, h.clock.now() - 1000);
      const before = h.influenceOf(SS, F);
      rec.runPass();
      const c = rec.getStatus().counters;
      assert.deepStrictEqual([c.markedForeign, c.factsApplied, c.dropApplied, c.abandonApplied, c.coreProtected],
        [1, 1, 1, 0, 1], JSON.stringify(c));
      const lg = h.logOf(SS);
      assert.deepStrictEqual([lg.last_action, lg.last_controller, lg.last_alliance], ["NATIVE_LOSS", null, null]);
      assert.strictEqual(h.system(SS).controllerFactionId, F, "controller stays F");
      const facts = lossFacts(h, SS);
      assert.strictEqual(facts.length, 1);
      assert.match(facts[0].idempotency_key, new RegExp(`^sov:native:${SS}:\\d+:\\d+:HUB_DESTROYED$`));
      assert.ok(h.influenceOf(SS, F) < before, "influence dropped");

      rec.runPass();
      assert.strictEqual(rec.getStatus().counters.factsApplied, 1);
      assert.strictEqual(lossFacts(h, SS).length, 1, "still exactly one fact");
      assert.strictEqual(h.system(SS).controllerFactionId, F, "controller still F after repeat");
    }, { identities: IDS });
  });

  needsDriver("TD7a maxRowRetries: abandonInTx throws for system on page 1, cursor advances after 3 retries, page 3 system gets fact", async () => {
    await withHarness(async (h) => {
      const systems = [SS, SS+1, SS+2, SS+3, SS+4];
      for (const ss of systems) {
        h.seedSystem(ss, F);
        await h.gain(ss);
        h.clock.advance(1000);
      }
      h.clock.advance(60000);
      for (const ss of systems) {
        h.vendor.destroyHub(ss, A, h.clock.now() - 1000);
      }
      
      let failSystem = null;
      const controlledOccupation = Object.assign(Object.create(Object.getPrototypeOf(h.occupation)), h.occupation, {
        abandonInTx: (tx, args, key) => {
          if (failSystem !== null && args.systemId === failSystem) throw new Error("ABANDON_FAILED_INJECTED");
          return h.occupation.abandonInTx(tx, args, key);
        }
      });
      
      const rec = await h.startReconcile({
        occupation: controlledOccupation,
        config: { ...h.config, world: { ...h.config.world, sovReconcile: { ...h.config.world.sovReconcile, maxRowsPerPass: 2, maxRowRetries: 3 } } }
      });
      
      failSystem = SS;
      let res = rec.runPass();
      assert.strictEqual(res.clean, false, "pass 1 not clean");
      assert.strictEqual(res.gaveUp, 0, "pass 1 gaveUp=0");
      assert.strictEqual(rec.getStatus().cursor, 0, "pass 1 cursor stays at 0");
      
      res = rec.runPass();
      assert.strictEqual(res.clean, false, "pass 2 not clean");
      assert.strictEqual(res.gaveUp, 0, "pass 2 gaveUp=0");
      assert.strictEqual(rec.getStatus().cursor, 0, "pass 2 cursor stays at 0");
      
      res = rec.runPass();
      assert.strictEqual(res.clean, false, "pass 3 not clean (SS given up, but pass has failures)");
      assert.strictEqual(res.gaveUp, 1, "pass 3 gaveUp=1");
      assert.strictEqual(rec.getStatus().cursor, SS+1, "pass 3 cursor advances to next page start");
      assert.strictEqual(rec.getStatus().counters.rowsGivenUp, 1, "rowsGivenUp=1");
      
      failSystem = null;
      res = rec.runPass();
      assert.strictEqual(res.clean, true, "pass 4 clean");
      assert.strictEqual(res.gaveUp, 0, "pass 4 gaveUp=0");
      assert.strictEqual(rec.getStatus().cursor, SS+3, "pass 4 cursor advances to page 3 start");
      
      res = rec.runPass();
      assert.strictEqual(res.clean, true, "pass 5 clean");
      assert.strictEqual(res.gaveUp, 0, "pass 5 gaveUp=0");
      
      const facts = lossFacts(h, SS+4);
      assert.strictEqual(facts.length, 1, "SS+4 got fact after cursor advanced past failed system");
    }, { identities: IDS, env: { EVEJS_LNE_WORLD_SOVRECONCILE_MAX_ROWS_PER_PASS: "2" } });
  });

  needsDriver("TD7b maxRowRetries: seam unavailable for all rows, cursor stays, rowsGivenUp=0", async () => {
    await withHarness(async (h) => {
      h.seedSystem(SS, F);
      await h.gain(SS);
      h.seedSystem(SS + 1, F);
      await h.gain(SS + 1);
      h.clock.advance(60000);
      h.vendor.destroyHub(SS, A, h.clock.now() - 1000);
      h.vendor.destroyHub(SS + 1, A, h.clock.now() - 1000);

      const rec = await h.startReconcile({
        config: { ...h.config, world: { ...h.config.world, sovReconcile: { ...h.config.world.sovReconcile, maxRowsPerPass: 2, maxRowRetries: 2 } } }
      });
      
      h.vendor.faults.claimThrows = true;
      
      for (let i = 0; i < 4; i += 1) {
        const res = rec.runPass();
        assert.strictEqual(res.ok, true, `pass ${i+1} ok=true (clean=false)`);
        assert.strictEqual(res.clean, false, `pass ${i+1} clean=false`);
        assert.strictEqual(res.gaveUp, 0, `pass ${i+1} gaveUp=0`);
        assert.strictEqual(rec.getStatus().cursor, 0, `pass ${i+1} cursor stays at 0`);
      }
      assert.strictEqual(rec.getStatus().counters.rowsGivenUp, 0, "rowsGivenUp=0");
      assert.ok(rec.getStatus().counters.seamUnavailable >= 4, "seamUnavailable counted each pass");
      
      h.vendor.faults.claimThrows = false;
      const res = rec.runPass();
      assert.strictEqual(res.clean, true, "pass after restore is clean");
    }, { identities: IDS });
  });

  needsDriver("TD7b2 maxRowRetries: seam unavailable with non-candidate row on page, cursor stays, rowsGivenUp=0", async () => {
    await withHarness(async (h) => {
      h.seedSystem(SS, F);
      await h.gain(SS);
      h.seedSystem(SS + 1, F);
      h.seedSystem(SS + 2, F);
      await h.gain(SS + 2);
      h.clock.advance(60000);
      h.vendor.destroyHub(SS, A, h.clock.now() - 1000);
      h.vendor.destroyHub(SS + 2, A, h.clock.now() - 1000);

      const rec = await h.startReconcile({
        config: { ...h.config, world: { ...h.config.world, sovReconcile: { ...h.config.world.sovReconcile, maxRowsPerPass: 3, maxRowRetries: 2 } } }
      });
      
      h.vendor.faults.claimThrows = true;
      
      for (let i = 0; i < 4; i += 1) {
        const res = rec.runPass();
        assert.strictEqual(res.ok, true, `pass ${i+1} ok=true (clean=false)`);
        assert.strictEqual(res.clean, false, `pass ${i+1} clean=false`);
        assert.strictEqual(res.gaveUp, 0, `pass ${i+1} gaveUp=0`);
        assert.strictEqual(rec.getStatus().cursor, 0, `pass ${i+1} cursor stays at 0`);
      }
      assert.strictEqual(rec.getStatus().counters.rowsGivenUp, 0, "rowsGivenUp=0 (seamUnavailable blocks give-up)");
      assert.ok(rec.getStatus().counters.seamUnavailable >= 4, "seamUnavailable counted each pass");
      
      h.vendor.faults.claimThrows = false;
      h.clock.advance(1000);
      h.vendor.destroyHub(SS + 1, A, h.clock.now() - 1000);
      const res = rec.runPass();
      assert.strictEqual(res.clean, true, "pass after restore is clean");
    }, { identities: IDS });
  });

  needsDriver("TD8 single attempted row with claim read fault: gives up after maxRowRetries, next page gets fact", async () => {
    await withHarness(async (h) => {
      h.seedSystem(SS, F);
      await h.gain(SS);
      h.writeLog(SS + 1, {});
      h.seedSystem(SS + 2, F);
      await h.gain(SS + 2);
      h.clock.advance(60000);
      h.vendor.destroyHub(SS, A, h.clock.now() - 1000);
      h.vendor.destroyHub(SS + 2, A, h.clock.now() - 1000);

      const sovState = h.vendor.modules["services/sovereignty/sovState"];
      const originalClaim = sovState.getSystemSovClaim;
      sovState.getSystemSovClaim = (ss) => {
        if (ss === SS) throw new Error("INJECTED_CLAIM_FAULT_ONE_SYSTEM");
        return originalClaim(ss);
      };

      const rec = await h.startReconcile({
        config: { ...h.config, world: { ...h.config.world, sovReconcile: { ...h.config.world.sovReconcile, maxRowsPerPass: 2, maxRowRetries: 3 } } }
      });

      for (let i = 1; i <= 2; i += 1) {
        const res = rec.runPass();
        assert.strictEqual(res.rows, 2, `pass ${i} page = SS, SS+1`);
        assert.strictEqual(res.clean, false, `pass ${i} not clean`);
        assert.strictEqual(res.gaveUp, 0, `pass ${i} gaveUp=0`);
        assert.strictEqual(rec.getStatus().cursor, 0, `pass ${i} cursor stays at 0`);
      }
      let res = rec.runPass();
      assert.strictEqual(res.gaveUp, 1, "pass 3 gaveUp=1");
      assert.strictEqual(rec.getStatus().cursor, SS + 1, "pass 3 cursor moves past page 1");
      assert.strictEqual(rec.getStatus().counters.rowsGivenUp, 1, "rowsGivenUp=1");

      res = rec.runPass();
      assert.strictEqual(res.clean, true, "pass 4 (page SS+2) clean");
      assert.strictEqual(lossFacts(h, SS + 2).length, 1, "SS+2 on the next page got its fact");
      assert.strictEqual(lossFacts(h, SS).length, 0, "SS (claim fault) got no fact");
    }, { identities: IDS });
  });

  needsDriver("TD9 defended fact failure: non-full pass does not reset the retry count, give-up on the 3rd failed full pass", async () => {
    await withHarness(async (h) => {
      h.seedSystem(SS, F);
      await h.gain(SS);
      let marker = "m1";
      h.vendor.modules["services/sovereignty/sovStore"].readSovereigntyTableUpdatedAt = () => marker;

      let defendedWrites = 0;
      const failingJournal = Object.assign(Object.create(Object.getPrototypeOf(h.journal)), h.journal, {
        applyOnce: (tx, ev, fn) => {
          if (ev && ev.eventType === "DEFENDED") {
            defendedWrites += 1;
            throw new Error("DEFENDED_APPLY_FAILED_INJECTED");
          }
          return h.journal.applyOnce(tx, ev, fn);
        },
      });
      const rec = await h.startReconcile({
        persistence: { ...h.ctx.persistence, journal: failingJournal },
        config: { ...h.config, world: { ...h.config.world, sovReconcile: { ...h.config.world.sovReconcile, maxRowsPerPass: 1, maxRowRetries: 3 } } }
      });

      let res = rec.runPass();
      assert.deepStrictEqual([res.full, res.clean, rec.getStatus().cursor], [true, true, SS], "pass 0 clean full");
      res = rec.runPass();
      assert.deepStrictEqual([res.rows, res.clean, rec.getStatus().cursor], [0, true, 0], "empty page wraps");

      h.vendor.addReceipt(SS, { allianceId: A, result: "defender", completedAtMs: h.clock.now(), epoch: "d1" });
      marker = "m2";
      for (let i = 1; i <= 2; i += 1) {
        res = rec.runPass();
        assert.deepStrictEqual([res.full, res.clean, res.gaveUp], [true, false, 0], `failed full pass ${i}`);
        assert.strictEqual(defendedWrites, i, `DEFENDED write attempted on full pass ${i}`);
        assert.strictEqual(rec.getStatus().cursor, 0, `full pass ${i} cursor stays`);
      }

      marker = "m1";
      res = rec.runPass();
      assert.deepStrictEqual([res.full, res.clean, res.rows], [false, true, 1], "non-full pass: row attempted, no error");
      assert.strictEqual(defendedWrites, 2, "non-full pass does not read DEFENDED");
      res = rec.runPass();
      assert.deepStrictEqual([res.rows, rec.getStatus().cursor], [0, 0], "empty page wraps");

      marker = "m2";
      res = rec.runPass();
      assert.deepStrictEqual([res.full, res.clean], [true, false], "3rd failed full pass");
      assert.strictEqual(defendedWrites, 3);
      assert.strictEqual(res.gaveUp, 1, "retry count kept across the non-full pass -> give-up at maxRowRetries=3");
      assert.strictEqual(rec.getStatus().cursor, SS, "cursor moves on give-up");
      assert.strictEqual(rec.getStatus().counters.rowsGivenUp, 1);
      assert.strictEqual(h.facts(`sov:native:${SS}:camp:%`).length, 0, "no DEFENDED fact written");
    }, { identities: IDS });
  });

  needsDriver("TD7c maxRowRetries (M3): abandonInTx throws 2x, RESTORED clears retry map, 2 new failures start from 1", async () => {
    await withHarness(async (h) => {
      h.seedSystem(SS, F);
      h.setState(SS, { occupationState: "STABLE" });
      await h.gain(SS);
      h.clock.advance(60000);
      
      let failCount = 0;
      let shouldFailAbandon = true;
      const controlledOccupation = Object.assign(Object.create(Object.getPrototypeOf(h.occupation)), h.occupation, {
        abandonInTx: (tx, args, key) => {
          if (shouldFailAbandon && args.systemId === SS) {
            failCount += 1;
            throw new Error("ABANDON_FAILED_INJECTED");
          }
          return h.occupation.abandonInTx(tx, args, key);
        }
      });
      
      const rec = await h.startReconcile({
        occupation: controlledOccupation,
        config: { ...h.config, world: { ...h.config.world, sovReconcile: { ...h.config.world.sovReconcile, maxRowsPerPass: 1, maxRowRetries: 3 } } }
      });
      
      h.vendor.setClaim(SS, 99000050);
      shouldFailAbandon = true;
      let res = rec.runPass();
      assert.strictEqual(res.clean, false, "pass 1 not clean (abandon fail)");
      assert.strictEqual(res.gaveUp, 0, "pass 1 gaveUp=0");
      assert.strictEqual(failCount, 1, "failCount=1");
      assert.strictEqual(rec.getStatus().cursor, 0, "pass 1 cursor stays");
      
      h.vendor.setClaim(SS, 99000050);
      res = rec.runPass();
      assert.strictEqual(res.clean, false, "pass 2 not clean");
      assert.strictEqual(res.gaveUp, 0, "pass 2 gaveUp=0");
      assert.strictEqual(failCount, 2, "failCount=2");
      assert.strictEqual(rec.getStatus().cursor, 0, "pass 2 cursor stays");
      
      h.vendor.setClaim(SS, A);
      shouldFailAbandon = false;
      res = rec.runPass();
      assert.strictEqual(res.clean, true, "pass 3 clean (RESTORED)");
      assert.strictEqual(res.gaveUp, 0, "pass 3 gaveUp=0");
      assert.strictEqual(rec.getStatus().cursor, SS, "pass 3 cursor advances to SS (nextAfterSystemId)");
      assert.strictEqual(rec.getStatus().counters.rowsGivenUp, 0, "rowsGivenUp=0");
      const logAfterPass3 = h.logOf(SS);
      assert.strictEqual(logAfterPass3.last_action, "GAIN", "log still shows GAIN after RESTORED");
      assert.strictEqual(logAfterPass3.last_alliance, A, "log still shows alliance A after RESTORED");
      
      res = rec.runPass();
      assert.strictEqual(res.clean, true, "pass 4 clean (empty page)");
      assert.strictEqual(rec.getStatus().cursor, 0, "pass 4 cursor wraps to 0");
      
      h.vendor.setClaim(SS, 99000050);
      shouldFailAbandon = true;
      res = rec.runPass();
      assert.strictEqual(res.clean, false, "pass 5 not clean (new series attempt 1)");
      assert.strictEqual(res.gaveUp, 0, "pass 5 gaveUp=0 (counter reset)");
      assert.strictEqual(failCount, 3, "failCount=3 (new series)");
      
      h.vendor.setClaim(SS, 99000050);
      res = rec.runPass();
      assert.strictEqual(res.clean, false, "pass 6 not clean (new series attempt 2)");
      assert.strictEqual(res.gaveUp, 0, "pass 6 gaveUp=0");
      assert.strictEqual(failCount, 4, "failCount=4");
      
      h.vendor.setClaim(SS, 99000050);
      res = rec.runPass();
      assert.strictEqual(res.clean, false, "pass 7 not clean (new series attempt 3)");
      assert.strictEqual(res.gaveUp, 1, "pass 7 gaveUp=1 (reached maxRowRetries=3)");
      assert.strictEqual(rec.getStatus().cursor, SS, "pass 7 cursor advances to SS (nextAfterSystemId on give-up)");
      assert.strictEqual(rec.getStatus().counters.rowsGivenUp, 1, "rowsGivenUp=1");
      
    }, { identities: IDS });
  });

  needsDriver("TD7e maxRowRetries (M5): allAtLimit uses every - two systems reach limit at different times", async () => {
    await withHarness(async (h) => {
      h.seedSystem(SS, F);
      await h.gain(SS);
      h.seedSystem(SS + 1, F);
      await h.gain(SS + 1);
      h.clock.advance(60000);
      h.vendor.destroyHub(SS, A, h.clock.now() - 1000);
      h.vendor.destroyHub(SS + 1, A, h.clock.now() - 1000);
      
      let skipSS1 = true;
      let failSS = true;
      let failSS1 = true;
      const controlledOccupation = Object.assign(Object.create(Object.getPrototypeOf(h.occupation)), h.occupation, {
        abandonInTx: (tx, args, key) => {
          if (args.systemId === SS && failSS) throw new Error("ABANDON_FAILED_INJECTED");
          if (args.systemId === SS + 1 && failSS1) throw new Error("ABANDON_FAILED_INJECTED");
          return h.occupation.abandonInTx(tx, args, key);
        }
      });
      
      const originalProjection = h.ctx.sovProjection;
      const projectingProjection = {
        ...originalProjection,
        isProjecting: (sid) => sid === SS + 1 && skipSS1,
      };
      
      const rec = await h.startReconcile({
        occupation: controlledOccupation,
        sovProjection: projectingProjection,
        config: { ...h.config, world: { ...h.config.world, sovReconcile: { ...h.config.world.sovReconcile, maxRowsPerPass: 2, maxRowRetries: 3 } } }
      });
      
      skipSS1 = true; failSS = true; failSS1 = false;
      let res = rec.runPass();
      assert.strictEqual(res.clean, false, "pass 1 not clean (SS fails, SS+1 skipped)");
      assert.strictEqual(res.gaveUp, 0, "pass 1 gaveUp=0");
      assert.strictEqual(rec.getStatus().cursor, 0, "pass 1 cursor stays");
      
      skipSS1 = false; failSS = true; failSS1 = true;
      res = rec.runPass();
      assert.strictEqual(res.clean, false, "pass 2 not clean (both fail)");
      assert.strictEqual(res.gaveUp, 0, "pass 2 gaveUp=0");
      assert.strictEqual(rec.getStatus().cursor, 0, "pass 2 cursor stays");
      
      res = rec.runPass();
      assert.strictEqual(res.clean, false, "pass 3 not clean");
      assert.strictEqual(res.gaveUp, 0, "pass 3 gaveUp=0 (SS+1 not at limit yet)");
      assert.strictEqual(rec.getStatus().cursor, 0, "pass 3 cursor STAYS (allAtLimit=false with .every)");
      
      res = rec.runPass();
      assert.strictEqual(res.clean, false, "pass 4 not clean (both given up)");
      assert.strictEqual(res.gaveUp, 2, "pass 4 gaveUp=2 (both at limit)");
      assert.strictEqual(rec.getStatus().cursor, SS + 1, "pass 4 cursor advances to SS+1 (nextAfterSystemId)");
      assert.strictEqual(rec.getStatus().counters.rowsGivenUp, 2, "rowsGivenUp=2");
    }, { identities: IDS });
  });

  needsDriver("TD7f maxRowRetries (M4): lastUpdatedAt and lastFullAt unchanged on give-up", async () => {
    await withHarness(async (h) => {
      h.seedSystem(SS, F);
      await h.gain(SS);
      h.clock.advance(60000);
      h.vendor.destroyHub(SS, A, h.clock.now() - 1000);
      
      const controlledOccupation = Object.assign(Object.create(Object.getPrototypeOf(h.occupation)), h.occupation, {
        abandonInTx: (tx, args, key) => { throw new Error("ABANDON_FAILED_INJECTED"); }
      });
      
      const rec = await h.startReconcile({
        occupation: controlledOccupation,
        config: { ...h.config, world: { ...h.config.world, sovReconcile: { ...h.config.world.sovReconcile, maxRowsPerPass: 1, maxRowRetries: 2 } } }
      });
      
      let res = rec.runPass();
      assert.strictEqual(res.gaveUp, 0, "pass 1 gaveUp=0");
      
      const statusBefore = rec.getStatus();
      const lastUpdatedAtBefore = statusBefore.lastUpdatedAt;
      const lastFullAtBefore = statusBefore.lastFullAt;
      const cursorBefore = statusBefore.cursor;
      
      res = rec.runPass();
      assert.strictEqual(res.gaveUp, 1, "pass 2 gaveUp=1");
      assert.strictEqual(rec.getStatus().counters.rowsGivenUp, 1, "rowsGivenUp=1");
      assert.strictEqual(rec.getStatus().cursor, SS, "pass 2 cursor advances to SS (nextAfterSystemId)");
      
      const statusAfter = rec.getStatus();
      
      assert.strictEqual(statusAfter.lastUpdatedAt, lastUpdatedAtBefore, "lastUpdatedAt unchanged on give-up");
      assert.strictEqual(statusAfter.lastFullAt, lastFullAtBefore, "lastFullAt unchanged on give-up");
      assert.notStrictEqual(statusAfter.cursor, cursorBefore, "cursor advances on give-up");
      
      res = rec.runPass();
      assert.strictEqual(res.clean, true, "pass 3 clean (empty page)");
      assert.strictEqual(rec.getStatus().cursor, 0, "pass 3 cursor wraps to 0");
      
    }, { identities: IDS });
  });

  needsDriver("TD7d maxRowRetries config: default 5, clamp 0->1", async () => {
    const { resolveConfig } = require("../../../config");
    const MOD_DIR = path.resolve(__dirname, "..", "..", "..");
    
    const cfg1 = resolveConfig({ modDir: MOD_DIR });
    assert.strictEqual(cfg1.config.world.sovReconcile.maxRowRetries, 5, "default is 5");
    
    const cfg2 = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_WORLD_SOVRECONCILE_MAX_ROW_RETRIES: "0" } });
    assert.strictEqual(cfg2.config.world.sovReconcile.maxRowRetries, 1, "0 clamped to 1");
    assert.ok(cfg2.warnings.some((w) => w.includes("MAX_ROW_RETRIES") || w.includes("maxRowRetries")), "warning for clamp");
    
    const cfg3 = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_WORLD_SOVRECONCILE_MAX_ROW_RETRIES: "10" } });
    assert.strictEqual(cfg3.config.world.sovReconcile.maxRowRetries, 10, "10 accepted");
    
    const cfg4 = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_WORLD_SOVRECONCILE_MAX_ROW_RETRIES: "2000" } });
    assert.strictEqual(cfg4.config.world.sovReconcile.maxRowRetries, 1000, "2000 clamped to 1000");
    assert.ok(cfg4.warnings.some((w) => w.includes("MAX_ROW_RETRIES") || w.includes("maxRowRetries")), "warning for clamp max");
    
    const cfg5 = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_WORLD_SOVRECONCILE_MAX_ROW_RETRIES: "-5" } });
    assert.strictEqual(cfg5.config.world.sovReconcile.maxRowRetries, 1, "-5 clamped to 1");
  });
};
