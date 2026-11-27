"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { hackWinsOf, subscribeFrom, MAX_WINS_PER_EMISSION } = require("../../lib/adapter/siteHacks");
const { SITE_ORIGIN } = require("../../lib/adapter/dungeonSites");
const { createAdapter } = require("../../lib/adapter");
const { GAME_MODULES } = require("../../lib/adapter/gameModules");

const SRC = path.join(path.sep, "x", "server", "src");
const SERVER_SRC = path.resolve(__dirname, "..", "..", "..", "..", "server", "src");
const HACKING_FILE = path.join(SERVER_SRC, "services", "exploration", "hackingContainerState.js");
const RUNTIME_FILE = path.join(SERVER_SRC, "services", "dungeon", "dungeonRuntime.js");

const receipt = (id, extra = {}) => ({ outcomeID: id, outcome: "won", atMs: 1000, nowMs: 1000, characterID: 90000001,
  successEffectsDelivered: false, ...extra });

function instance(containers, extra = {}) {
  return { instanceID: 4242, solarSystemID: 30002187, templateID: "client-dungeon:1808", siteFamily: "relic",
    siteKind: "signature", siteOrigin: "universe_dungeon", instanceScope: "shared", metadata: {}, runtimeFlags: {},
    spawnState: containers === null ? {} : { hackingContainers: containers }, ...extra };
}

const payload = (beforeContainers, afterContainers, extra = {}) => ({ changeType: "updated", instanceID: 4242,
  before: instance(beforeContainers, extra), after: instance(afterContainers, extra),
  metadata: { source: "merge:spawnState" } });

function fakeRuntime() {
  const listeners = new Set();
  return {
    listeners,
    registerInstanceChangeListener(l) {
      listeners.add(l);
      return true;
    },
    unregisterInstanceChangeListener: (l) => listeners.delete(l),
    emit(p) {
      for (const l of [...listeners]) l(p);
    },
  };
}

function listJs(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) listJs(full, out);
    else if (e.name.endsWith(".js")) out.push(full);
  }
  return out;
}

module.exports = ({ test, skip }) => {
  test("A2 siteHacks.hackWinsOf: new won = 1, same receipt = 0, lost / characterID 0 = 0, cap 8, foreign = []; own, "
    + "lneEventId, excluded; subscribeFrom + adapter.onSiteContainerHacked, DRIFT refuses", () => {
    const one = hackWinsOf(payload({ "k:1": { outcomes: {} } }, { "k:1": { outcomes: { "o-1": receipt("o-1") } } }));
    assert.deepStrictEqual(one, [{ instanceId: 4242, systemId: 30002187, siteFamily: "relic", siteKind: "signature",
      templateId: "client-dungeon:1808", own: false, lneEventId: null, excluded: false, contentKey: "k:1",
      outcomeId: "o-1", characterId: 90000001, atMs: 1000 }]);
    const same = { "k:1": { outcomes: { "o-1": receipt("o-1", { successEffectsDelivered: true }) } } };
    assert.deepStrictEqual(hackWinsOf(payload({ "k:1": { outcomes: { "o-1": receipt("o-1") } } }, same)), [],
      "the second write of the same receipt");
    assert.deepStrictEqual(hackWinsOf(payload(null, { k: { outcomes: { a: receipt("a", { outcome: "lost" }) } } })), []);
    assert.deepStrictEqual(hackWinsOf(payload(null, { k: { outcomes: { a: receipt("a", { characterID: 0 }) } } })), []);
    assert.strictEqual(hackWinsOf(payload(null, { k: { outcomes: { a: receipt("a") } } })).length, 1, "no before record");
    const many = {};
    for (let i = 0; i < 12; i += 1) many[`c:${i}`] = { outcomes: { [`o${i}`]: receipt(`o${i}`, { atMs: 2000 - i }) } };
    const capped = hackWinsOf(payload({}, many));
    assert.strictEqual(capped.length, MAX_WINS_PER_EMISSION);
    assert.deepStrictEqual(capped.map((w) => w.atMs), [1989, 1990, 1991, 1992, 1993, 1994, 1995, 1996]);
    for (const bad of [null, {}, { changeType: "created" }, { changeType: "updated", before: null, after: {} },
      payload(null, null), { changeType: "updated", before: instance(null), after: instance("x") }]) {
      assert.deepStrictEqual(hackWinsOf(bad), []);
    }
    const own = hackWinsOf(payload({}, { k: { outcomes: { a: receipt("a") } } },
      { siteOrigin: SITE_ORIGIN, metadata: { lneEventId: "arc:s0:9:1" } }))[0];
    assert.deepStrictEqual([own.own, own.lneEventId, own.excluded], [true, "arc:s0:9:1", false]);
    const priv = hackWinsOf(payload({}, { k: { outcomes: { a: receipt("a") } } }, { instanceScope: "private" }))[0];
    assert.deepStrictEqual([priv.own, priv.lneEventId, priv.excluded], [false, null, true]);

    const rt = fakeRuntime();
    const seen = [];
    const logs = [];
    const sub = subscribeFrom(rt, (w) => {
      seen.push(w.outcomeId);
      throw new Error("consumer bug");
    }, { log: (l) => logs.push(l) });
    assert.strictEqual(sub.ok, true);
    rt.emit(payload({}, { k: { outcomes: { a: receipt("a"), b: receipt("b") } } }));
    assert.deepStrictEqual([seen, logs.length], [["a", "b"], 1]);
    sub.unsubscribe();
    assert.strictEqual(rt.listeners.size, 0);

    const rt3 = fakeRuntime();
    const file = path.join(SRC, "services", "dungeon", "dungeonRuntime.js");
    const adapter = createAdapter({ moduleApi: { _cache: { [file]: { exports: rt3 } } }, gameModules: GAME_MODULES,
      existsSync: () => true });
    adapter.setServerSrc(SRC);
    const got = [];
    const bound = adapter.onSiteContainerHacked((w) => got.push(w.systemId));
    assert.strictEqual(bound.ok, true, JSON.stringify(bound));
    rt3.emit(payload({}, { k: { outcomes: { a: receipt("a") } } }));
    assert.deepStrictEqual(got, [30002187]);
    bound.unsubscribe();
    assert.strictEqual(rt3.listeners.size, 0);

    const drifted = { getInstance() { return null; } };
    const a2 = createAdapter({ moduleApi: { _cache: { [file]: { exports: drifted } } }, gameModules: GAME_MODULES,
      existsSync: () => true });
    a2.setServerSrc(SRC);
    const report = a2.runProbe();
    assert.strictEqual(typeof report.disabledModules.archaeology, "string", JSON.stringify(report.disabledModules));
    const r = a2.onSiteContainerHacked(() => {});
    assert.strictEqual(r.reason, "SEAM_UNAVAILABLE");
    assert.ok(r.detail.startsWith("drift_"), r.detail);
  });

  if (!fs.existsSync(HACKING_FILE) || !fs.existsSync(RUNTIME_FILE)) {
    skip("A5 archaeology vendor facts", "vendor hackingContainerState.js / dungeonRuntime.js not found");
    return;
  }
  test("A5 vendor facts: receipts in record.outcomes, writeRecord through mergeSpawnState, mergeStateField emits "
    + "updated, no destructured instance change listener in server/src", () => {
    const text = (f) => fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n");
    const hacking = text(HACKING_FILE);
    assert.ok(hacking.includes("outcomes: { ...receipts, [outcomeID]: receipt }"), "receipt map");
    assert.ok(hacking.includes("runtime.mergeSpawnState(id.instanceID, {"), "writeRecord -> mergeSpawnState");
    assert.ok(hacking.includes("hackingContainers: { ...object(instance.spawnState?.hackingContainers), [id.key]: record }"),
      "hackingContainers[key] = record");
    assert.ok(/outcomeID, outcome, atMs: nowMs/.test(hacking), "receipt fields");
    const runtime = text(RUNTIME_FILE);
    const at = runtime.indexOf("\nfunction mergeStateField(");
    const body = runtime.slice(at, runtime.indexOf("\nfunction ", at + 1));
    assert.ok(at > 0 && body.includes("emitInstanceChange(\"updated\", existing, updated, {"), "mergeStateField emits");
    assert.ok(runtime.includes("return mergeStateField(instanceID, \"spawnState\", patch, options);"),
      "mergeSpawnState = mergeStateField spawnState");
    const destructured = listJs(SERVER_SRC).filter((f) => /\{\s*(?:un)?registerInstanceChangeListener\b/
      .test(fs.readFileSync(f, "utf8")));
    assert.deepStrictEqual(destructured.map((f) => path.relative(SERVER_SRC, f)), []);
  });
};
