"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { completionOf, subscribeFrom, MAX_COMPLETION_CHARACTERS, OWN_SITE_ORIGIN } =
  require("../../lib/adapter/siteCompletion");
const { SITE_ORIGIN } = require("../../lib/adapter/dungeonSites");
const { createAdapter } = require("../../lib/adapter");
const { GAME_MODULES } = require("../../lib/adapter/gameModules");

const SRC = path.join(path.sep, "x", "server", "src");

function payload(overrides = {}) {
  const after = {
    instanceID: 4242,
    solarSystemID: 30002187,
    templateID: "client-dungeon:9001",
    factionID: 500010,
    siteFamily: "combat",
    siteKind: "anomaly",
    siteOrigin: "universe_dungeon",
    lifecycleState: "completed",
    lifecycleReason: "encounters_cleared",
    instanceScope: "shared",
    ownership: { visibilityScope: "public" },
    metadata: {},
    runtimeFlags: {},
    timers: { completedAtMs: 1700000000000 },
    spawnState: { achievementCompletionCharacterIDs: [90000003, 90000001, 90000003, 0, -5, "x", 90000002] },
    ...(overrides.after || {}),
  };
  const before = { ...after, lifecycleState: "active", lifecycleReason: null, ...(overrides.before || {}) };
  return { changeType: "updated", instanceID: after.instanceID, solarSystemID: after.solarSystemID, before, after,
    metadata: { source: "setLifecycleState" }, ...(overrides.top || {}) };
}

function fakeRuntime() {
  const listeners = new Set();
  let unregisters = 0;
  return {
    listeners,
    unregisterCount: () => unregisters,
    registerInstanceChangeListener(listener) {
      if (typeof listener !== "function") return false;
      listeners.add(listener);
      return true;
    },
    unregisterInstanceChangeListener(listener) {
      unregisters += 1;
      return listeners.delete(listener);
    },
    emit(p) {
      for (const l of [...listeners]) {
        try { l(p); } catch (_err) { throw new Error("listener exception reached the vendor"); }
      }
    },
  };
}

module.exports = ({ test }) => {
  test("ESA2 completionOf: qualifying payload -> DTO (fields, characterIds unique ascending capped, own for "
    + "lne_event); every exclusion alone -> null; garbage -> null", () => {
    assert.strictEqual(OWN_SITE_ORIGIN, SITE_ORIGIN);
    assert.deepStrictEqual(completionOf(payload()), {
      instanceId: 4242,
      systemId: 30002187,
      templateId: "client-dungeon:9001",
      factionId: 500010,
      siteOrigin: "universe_dungeon",
      own: false,
      completedAtMs: 1700000000000,
      characterIds: [90000001, 90000002, 90000003],
    });
    const own = completionOf(payload({ after: { siteOrigin: "LNE_EVENT", factionID: 0 } }));
    assert.strictEqual(own.own, true);
    assert.strictEqual(own.siteOrigin, "lne_event");
    assert.strictEqual(own.factionId, null);
    const many = Array.from({ length: 100 }, (_, i) => 1000 + (99 - i));
    const capped = completionOf(payload({ after: { spawnState: { achievementCompletionCharacterIDs: many } } }));
    assert.strictEqual(capped.characterIds.length, MAX_COMPLETION_CHARACTERS);
    assert.strictEqual(capped.characterIds[0], 1000);
    assert.strictEqual(capped.characterIds[63], 1063);
    assert.deepStrictEqual(completionOf(payload({ after: { spawnState: null } })).characterIds, []);

    const excluded = {
      changeType: payload({ top: { changeType: "created" } }),
      beforeNotActive: payload({ before: { lifecycleState: "seeded" } }),
      afterNotCompleted: payload({ after: { lifecycleState: "failed" } }),
      reasonContainers: payload({ after: { lifecycleReason: "containers_cleared" } }),
      familyData: payload({ after: { siteFamily: "data" } }),
      kindSignature: payload({ after: { siteKind: "signature" } }),
      privateScope: payload({ after: { instanceScope: "private" } }),
      privateOwnership: payload({ after: { ownership: { visibilityScope: "private" } } }),
      missionFlag: payload({ after: { runtimeFlags: { missionRuntime: true } } }),
      missionMetadata: payload({ after: { metadata: { missionRuntime: true } } }),
      privateOperation: payload({ after: { metadata: { privateOperation: true } } }),
      eventId: payload({ after: { metadata: { eventID: "ev-1" } } }),
      eventKey: payload({ after: { metadata: { eventKey: "k" } } }),
      campaignId: payload({ after: { metadata: { campaignID: 7 } } }),
      timeLimitedMetadata: payload({ after: { metadata: { timeLimited: true } } }),
      timeLimitedFlag: payload({ after: { runtimeFlags: { timeLimited: true } } }),
      seasonalFlag: payload({ after: { runtimeFlags: { seasonalEvent: true } } }),
      election: payload({ after: { templateID: "evejs-election:abc" } }),
      noCompletedAt: payload({ after: { timers: {} } }),
      zeroCompletedAt: payload({ after: { timers: { completedAtMs: 0 } } }),
      badInstance: payload({ after: { instanceID: 0 } }),
      badSystem: payload({ after: { solarSystemID: "x" } }),
    };
    for (const [why, p] of Object.entries(excluded)) assert.strictEqual(completionOf(p), null, why);
    for (const garbage of [null, undefined, 1, "x", [], {}, { changeType: "updated" },
      { changeType: "updated", before: {}, after: null }]) {
      assert.strictEqual(completionOf(garbage), null, JSON.stringify(garbage));
    }
    const throwing = payload();
    Object.defineProperty(throwing.after, "siteFamily", { get() { throw new Error("boom"); } });
    assert.strictEqual(completionOf(throwing), null, "a throwing getter -> null");
  });

  test("ESA3 subscribeFrom: registers through the module object, fn only for qualifying payloads, fn exception "
    + "stays inside (one log line), unsubscribe twice = one unregister; missing functions / refused register -> "
    + "SEAM_UNAVAILABLE; adapter.onCombatSiteCompleted binds dungeonRuntime", () => {
    const rt = fakeRuntime();
    const got = [];
    const sub = subscribeFrom(rt, (c) => got.push(c.instanceId));
    assert.strictEqual(sub.ok, true);
    assert.strictEqual(rt.listeners.size, 1);
    rt.emit(payload());
    rt.emit(payload({ after: { siteKind: "signature" } }));
    rt.emit({ changeType: "created", before: null, after: {} });
    assert.deepStrictEqual(got, [4242]);
    sub.unsubscribe();
    sub.unsubscribe();
    assert.strictEqual(rt.unregisterCount(), 1);
    assert.strictEqual(rt.listeners.size, 0);

    const logs = [];
    const rt2 = fakeRuntime();
    const sub2 = subscribeFrom(rt2, () => { throw new Error("consumer bug"); }, { log: (l) => logs.push(l) });
    assert.strictEqual(sub2.ok, true);
    rt2.emit(payload());
    rt2.emit(payload());
    assert.strictEqual(logs.length, 1, "one log line per subscription");
    assert.ok(logs[0].includes("consumer bug"));

    assert.strictEqual(subscribeFrom({}, () => {}).reason, "SEAM_UNAVAILABLE");
    assert.strictEqual(subscribeFrom(null, () => {}).reason, "SEAM_UNAVAILABLE");
    assert.strictEqual(subscribeFrom(rt, null).reason, "SEAM_UNAVAILABLE");
    const refusing = { registerInstanceChangeListener: () => false, unregisterInstanceChangeListener: () => true };
    assert.deepStrictEqual(subscribeFrom(refusing, () => {}),
      { ok: false, reason: "SEAM_UNAVAILABLE", detail: "register_refused" });

    const rt3 = fakeRuntime();
    const file = path.join(SRC, "services", "dungeon", "dungeonRuntime.js");
    const adapter = createAdapter({ moduleApi: { _cache: { [file]: { exports: rt3 } } }, gameModules: GAME_MODULES,
      existsSync: () => true });
    assert.strictEqual(adapter.onCombatSiteCompleted(() => {}).detail, "dungeonRuntime_server_src_unknown");
    adapter.setServerSrc(SRC);
    const seen = [];
    const bound = adapter.onCombatSiteCompleted((c) => seen.push(c.systemId));
    assert.strictEqual(bound.ok, true, JSON.stringify(bound));
    rt3.emit(payload());
    assert.deepStrictEqual(seen, [30002187]);
    bound.unsubscribe();
    assert.strictEqual(rt3.listeners.size, 0);
  });

  test("ESA4 DRIFT: dungeonRuntime without the listener functions -> the probe disables the consumer "
    + "escalations and onCombatSiteCompleted refuses SEAM_UNAVAILABLE drift_* without touching the module", () => {
    const drifted = { getInstance() { return null; } };
    const file = path.join(SRC, "services", "dungeon", "dungeonRuntime.js");
    const adapter = createAdapter({ moduleApi: { _cache: { [file]: { exports: drifted } } }, gameModules: GAME_MODULES,
      existsSync: () => true });
    adapter.setServerSrc(SRC);
    const report = adapter.runProbe();
    assert.ok(report.disabledModules && typeof report.disabledModules.escalations === "string",
      JSON.stringify(report.disabledModules));
    const r = adapter.onCombatSiteCompleted(() => {});
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, "SEAM_UNAVAILABLE");
    assert.ok(r.detail.startsWith("drift_"), r.detail);
    assert.deepStrictEqual(Object.keys(drifted), ["getInstance"], "nothing written onto the vendor module");
  });
};
