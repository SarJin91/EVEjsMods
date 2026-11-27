"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

const { SCHEMA, resolveConfig } = require("../../config");
const { IGNORE_ENV, OVERRIDE_SCHEMA_VERSION, overridePathOf, readOverrideFile, writeOverrideFileAtomic } =
  require("../../lib/modSettings/overrideFile");
const { LIVE_REGISTRY_KEY, LIVE_KEYS_LNE, createLiveConfig, createLiveApplier } =
  require("../../lib/modSettings/live");
const { LNE_LOCKS, createLocks } = require("../../lib/modSettings/locks");
const { startModSettings } = require("../../lib/modSettings");
const { startModsHelp } = require("../../lib/modsHelp");
const { startFrontChat } = require("../../lib/frontChat");
const { startInGameMap } = require("../../lib/inGameMap");
const { createRegistry } = require("../../lib/telemetry/registry");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SHIP_WING_DIR = path.resolve(MOD_DIR, "..", "shipWing");
const { createLiveSettings, registerLive, unregisterLive } =
  require(path.join(SHIP_WING_DIR, "lib", "core", "liveSettings.js"));
const { uiOf } = require(path.join(SHIP_WING_DIR, "lib", "channels", "clientWindow.js"));
const ACTOR = Object.freeze({ characterId: 90000001, characterName: "Pilot", channel: "web" });
const T0 = 1700000000000;
const GURISTAS = 500010;
const CALDARI = 500001;

function withDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lne-modsettings-live-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function chatAdapter() {
  const installs = [];
  return { installs,
    installChatCommand(opts) {
      installs.push(opts);
      return { ok: true };
    },
    uninstallChatCommand: () => ({ ok: true }),
    listChatCommands: () => Object.freeze(["front", "map", "mods", "settings", "wing", "ai", "aud", "jobs"]),
    listLoadedModDirs: () => ({ ok: true, dirs: Object.freeze(["livingNewEden", "shipWing", "AdvancedUtilityDrones",
      "hotPathPerf", "npcKillsGiveSp", "autopilotJumpZero"]) }),
    loadModConfig: (dir) => (dir === "shipWing"
      ? { ok: true, exports: require(path.join(SHIP_WING_DIR, "config.js")), modDir: SHIP_WING_DIR }
      : { ok: false, reason: "CONFIG_MISSING" }) };
}

function started(dir, extra = {}) {
  const env = { EVEJS_DATA_ROOT: dir, ...(extra.env || {}) };
  const base = resolveConfig({ env, settings: {}, envFile: {}, modDir: MOD_DIR }).config;
  const config = { ...base, dataDir: path.join(dir, "mods", "livingNewEden"),
    modSettings: { ...base.modSettings, enabled: true, mods: "livingNewEden,shipWing" } };
  const liveConfig = createLiveConfig(config);
  const registry = createRegistry({ histogramSamples: 8, maxMetrics: 64 });
  const globalObj = extra.globalObj || {};
  const r = startModSettings({ config, adapter: chatAdapter(), env, modDir: MOD_DIR, clock: { now: () => T0 },
    telemetry: registry, logger: { log() {} }, liveConfig, globalObj });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  let revision = 0;
  const write = (modId, key, value) => {
    const res = value === undefined
      ? r.modSettings.reset({ modId, key, expectedRevision: revision, actor: ACTOR })
      : r.modSettings.set({ modId, key, value, expectedRevision: revision, actor: ACTOR });
    if (res.ok === true) revision = res.revision;
    return res;
  };
  const setLive = (key, value) => {
    const res = write("livingNewEden", key, value);
    assert.deepStrictEqual([res.ok, res.apply, res.pending], [true, "live", false], JSON.stringify(res));
    return res;
  };
  return { ms: r.modSettings, config, liveConfig, registry, env, globalObj, write, setLive };
}

function frontSnapshot() {
  return { systemId: 30000142, systemName: "Jita", regionId: 10000002, regionName: "The Forge",
    names: new Map([[GURISTAS, "Guristas"], [CALDARI, "Caldari State"]]),
    card: { inWorld: true, system: { state: "CONTESTED", controller: CALDARI, occupier: null },
      progress: { state: "CONTESTED", attacker: GURISTAS, defender: CALDARI, ratio: 430, status: "ADVANCING",
        blockers: [], etaMs: 4800000, fallback: null },
      attackerInvasion: { state: "ACTIVE", withdrawMs: 10800000 },
      fleets: { groups: [{ factionId: GURISTAS, role: "invasion", state: "IDLE", fleets: 3, ships: 30 },
        { factionId: CALDARI, role: "garrison", state: "IDLE", fleets: 2, ships: 12 }] },
      sieges: [{ siegeId: "s1" }], battles: [{ open: true }, { open: false }] },
    region: { systems: 87, tracked: 12, byState: [["STABLE", 9], ["CONTESTED", 2], ["INVASION", 1]],
      controllers: [{ factionId: GURISTAS, systems: 7 }, { factionId: CALDARI, systems: 5 }],
      contested: [
        { systemId: 30000144, name: "Perimeter", state: "CONTESTED", attacker: GURISTAS,
          progress: { status: "ADVANCING", ratio: 610, etaMs: 1500000 } },
        { systemId: 30000145, name: "Sobaseki", state: "INVASION", attacker: GURISTAS,
          progress: { status: "BLOCKED", ratio: 200, etaMs: null } }],
      truncated: false, tooLarge: false } };
}

function assertCooldownLive(s, key, say) {
  const now = { t: T0 };
  const refused = (text) => /: wait ~?\d/.test(text);
  assert.ok(!refused(say(now, 1)), `${key}: first reply`);
  now.t += 1500;
  assert.ok(refused(say(now, 1)), `${key}: boot cooldown refuses after 1.5 s`);
  s.setLive(key, 1000);
  now.t += 10;
  assert.ok(!refused(say(now, 1)), `${key}: after the rebuild`);
  now.t += 500;
  assert.ok(refused(say(now, 1)), `${key}: the live 1 s cooldown refuses after 0.5 s`);
  now.t += 1500;
  assert.ok(!refused(say(now, 1)), `${key}: the live 1 s cooldown takes after 1.5 s`);
}

module.exports = ({ test }) => {
  test("ML1 live holder get/swap/version; LIVE_KEYS_LNE pinned, rows of SCHEMA, none locked", () => {
    const boot = Object.freeze({ a: 1 });
    const h = createLiveConfig(boot);
    assert.deepStrictEqual([h.get() === boot, h.version], [true, 0]);
    assert.deepStrictEqual(h.swap(null), { ok: false, reason: "BAD_CONFIG" });
    assert.strictEqual(h.version, 0);
    const next = Object.freeze({ a: 2 });
    assert.deepStrictEqual(h.swap(next), { ok: true, version: 1 });
    assert.deepStrictEqual([h.get() === next, h.version], [true, 1]);
    assert.deepStrictEqual([...LIVE_KEYS_LNE], ["modsHelp.cooldownMs", "modsHelp.maxReplyChars", "frontChat.cooldownMs",
      "frontChat.maxReplyChars", "inGameMap.chatMinIntervalMs"]);
    assert.ok(LIVE_KEYS_LNE.length <= 12);
    const locks = createLocks(LNE_LOCKS);
    for (const key of LIVE_KEYS_LNE) {
      const row = SCHEMA.find((r) => r.key === key);
      assert.ok(row, key);
      assert.strictEqual(locks.locked(row).locked, false, key);
    }
    const p = { locked: () => ({ locked: false }) };
    assert.strictEqual(createLiveApplier({ liveConfig: null, globalObj: {} }).applyOf("livingNewEden",
      "modsHelp.cooldownMs", p), "restart");
  });

  test("ML2 each LNE live key: a write through the writer changes the consumer without a restart", () => withDir((dir) => {
    const s = started(dir);
    const describe = (key) => s.ms.describe("livingNewEden", { key }).rows[0];
    assert.deepStrictEqual([describe("modsHelp.cooldownMs").apply, describe("observer.journalLimit").apply],
      ["live", "restart"]);
    const plain = s.write("livingNewEden", "observer.journalLimit", 60);
    assert.deepStrictEqual([plain.apply, plain.pending, s.liveConfig.version], ["restart", true, 0]);

    const clockOf = { t: T0 };
    const mh = startModsHelp({ config: s.config, adapter: chatAdapter(), clock: { now: () => clockOf.t },
      liveConfig: s.liveConfig });
    assert.strictEqual(mh.ok, true, JSON.stringify(mh));
    assertCooldownLive(s, "modsHelp.cooldownMs", (now, id) => {
      clockOf.t = now.t;
      return mh.modsHelp.handle({ characterId: id }, "!mods");
    });
    clockOf.t += 60000;
    const longMods = mh.modsHelp.handle({ characterId: 2 }, "!mods");
    assert.ok(longMods.length > 200, `!mods reply ${longMods.length} chars`);
    s.setLive("modsHelp.maxReplyChars", 200);
    clockOf.t += 60000;
    assert.ok(mh.modsHelp.handle({ characterId: 3 }, "!mods").length <= 200, "the live cap");
    assert.strictEqual(describe("modsHelp.maxReplyChars").running, 200, "running follows the live value");
    assert.strictEqual(describe("modsHelp.maxReplyChars").pending, false);

    const fcClock = { t: T0 };
    const fcConfig = { ...s.config, frontChat: { ...s.config.frontChat, enabled: true } };
    const fc = startFrontChat({ config: fcConfig, ctx: {}, adapter: chatAdapter(), clock: { now: () => fcClock.t },
      liveConfig: s.liveConfig, readSnapshot: () => ({ ok: true, snapshot: frontSnapshot() }) });
    assert.strictEqual(fc.ok, true, JSON.stringify(fc));
    const front = (id) => fc.frontChat.handle({ characterId: id, systemId: 30000142 });
    assert.ok(front(10).length > 200, "front reply");
    assertCooldownLive(s, "frontChat.cooldownMs", (now, id) => {
      fcClock.t = now.t + 60000;
      return front(id);
    });
    fcClock.t += 120000;
    s.setLive("frontChat.maxReplyChars", 200);
    fcClock.t += 120000;
    assert.ok(front(11).length <= 200, "the live cap of !front");

    const mapClock = { t: T0 };
    const mapConfig = { ...s.config, inGameMap: { ...s.config.inGameMap, enabled: true, chatEnabled: true },
      observer: { ...s.config.observer, enabled: true } };
    const map = startInGameMap({ config: mapConfig, ctx: {}, adapter: chatAdapter(), clock: { now: () => mapClock.t },
      liveConfig: s.liveConfig });
    assert.strictEqual(map.ok, true, JSON.stringify(map));
    assertCooldownLive(s, "inGameMap.chatMinIntervalMs", (now, id) => {
      mapClock.t = now.t + 600000;
      return map.inGameMap.handle({ characterId: id, systemId: 30000142 });
    });

    const before = s.liveConfig.version;
    const reset = s.write("livingNewEden", "modsHelp.maxReplyChars");
    assert.deepStrictEqual([reset.ok, reset.apply, reset.pending, s.liveConfig.version], [true, "live", false,
      before + 1]);
    assert.strictEqual(s.liveConfig.get().modsHelp.maxReplyChars, s.config.modsHelp.maxReplyChars);
    assert.strictEqual(s.config.modsHelp.maxReplyChars, 1000, "ctx.config stays the boot snapshot");
  }));

  test("ML3 registry between the mods + shipWing: lazy Map, its keys live, applied in shipWing, unregister", () =>
    withDir((dir) => {
      const globalObj = {};
      const swConfig = require(path.join(SHIP_WING_DIR, "config.js")).loadConfig({ env: { EVEJS_DATA_ROOT: dir },
        modDir: SHIP_WING_DIR }).config;
      const live = createLiveSettings(swConfig);
      assert.strictEqual(globalObj[LIVE_REGISTRY_KEY], undefined);
      const entry = registerLive(globalObj, live);
      assert.ok(globalObj[LIVE_REGISTRY_KEY] instanceof Map, "made by the first mod that registers");
      assert.strictEqual(LIVE_REGISTRY_KEY, Symbol.for("evejs.modSettings.live"));
      assert.deepStrictEqual([...globalObj[LIVE_REGISTRY_KEY].get("shipWing").keys], ["hpWarnPct", "hpCriticalPct",
        "clientWindowButtonColors", "clientWindowPollMs", "commandCooldownMs"]);
      assert.deepStrictEqual(live.apply({ hpWarnPct: 40, hpCriticalPct: 50 }).ok, false);
      assert.deepStrictEqual(live.apply({ clientWindowPollMs: 500 }).ok, false);
      assert.strictEqual(live.version, 0);

      const s = started(dir, { globalObj });
      const row = (key) => s.ms.describe("shipWing", { key }).rows[0];
      assert.deepStrictEqual([row("hpWarnPct").apply, row("maxWingPerPilot").apply], ["live", "restart"]);
      const r = s.write("shipWing", "hpWarnPct", 80);
      assert.deepStrictEqual([r.ok, r.apply, r.pending], [true, "live", false], JSON.stringify(r));
      assert.strictEqual(live.get().hpWarnPct, 80);
      assert.strictEqual(uiOf(live.get()).hpWarnPct, 80, "the client window ui block reads it");
      assert.strictEqual(swConfig.hpWarnPct, 90, "the boot config is unchanged");
      assert.deepStrictEqual([row("hpWarnPct").running, row("hpWarnPct").pending], [80, false]);
      const cd = s.write("shipWing", "commandCooldownMs", 500);
      assert.deepStrictEqual([cd.apply, live.get().commandCooldownMs], ["live", 500]);
      assert.strictEqual(s.registry.counter("modSettings.liveApplied"), 2);

      unregisterLive(globalObj, entry);
      assert.strictEqual(row("hpWarnPct").apply, "restart", "a stopped shipWing takes no live value");
    }));

  test("ML4 writer: failed live apply = restart + pending + warning, file written; reset under the kill switch; panel",
    () => withDir((dir) => {
      const globalObj = { [LIVE_REGISTRY_KEY]: new Map([["shipWing", { keys: ["hpWarnPct"],
        apply: () => { throw new Error("boom"); } }]]) };
      const s = started(dir, { globalObj });
      const r = s.write("shipWing", "hpWarnPct", 80);
      assert.deepStrictEqual([r.ok, r.changed, r.apply, r.pending], [true, true, "restart", true], JSON.stringify(r));
      assert.ok(r.warnings.some((w) => w.includes("live apply failed") && w.includes("APPLY_FAILED")), r.warnings);
      const file = readOverrideFile(overridePathOf(path.join(dir, "mods", "shipWing")), {});
      assert.deepStrictEqual([file.revision, file.values.hpWarnPct], [1, 80], "the file is written anyway");
      assert.strictEqual(s.registry.counter("modSettings.liveApplied") || 0, 0);
      globalObj[LIVE_REGISTRY_KEY].set("shipWing", { keys: ["hpWarnPct"], apply: () => ({ ok: false }) });
      const refused = s.write("shipWing", "hpWarnPct", 70);
      assert.deepStrictEqual([refused.apply, refused.pending], ["restart", true]);
      const lockedProvider = { locked: () => ({ locked: true, reason: "SECRET" }) };
      assert.strictEqual(createLiveApplier({ liveConfig: null, globalObj }).applyOf("shipWing", "hpWarnPct",
        lockedProvider), "restart");

      const k = started(dir, { env: { [IGNORE_ENV]: "1" } });
      const desc = k.ms.describe("livingNewEden", { key: "modsHelp.cooldownMs" });
      assert.strictEqual(desc.overrideFile.revision, 0);
      const reset = k.ms.reset({ modId: "shipWing", key: "hpWarnPct", expectedRevision: 0, actor: ACTOR });
      assert.deepStrictEqual([reset.ok, reset.reason], [false, "CONFIG_ERROR"], JSON.stringify(reset));

      const sandbox = {};
      vm.runInNewContext(fs.readFileSync(path.join(MOD_DIR, "web", "settings.js"), "utf8"), sandbox);
      const text = sandbox.LneSettings._pure.resultText;
      const liveText = text({ ok: true, changed: true, revision: 2, apply: "live", pending: false, warnings: [] });
      assert.ok(liveText.includes("applied live") && !liveText.includes("waits for restart"), liveText);
      assert.ok(text({ ok: true, changed: true, revision: 2, apply: "restart", pending: true, warnings: [] })
        .includes("waits for restart"));
    }));

  test("ML5 LOWs: LNE swap marks every live key of the file running; same value retries live",
    () => withDir((dir) => {
      const s = started(dir);
      s.setLive("modsHelp.cooldownMs", 1000);
      const lnePath = overridePathOf(path.join(dir, "mods", "livingNewEden"));
      const file = readOverrideFile(lnePath, {});
      assert.strictEqual(writeOverrideFileAtomic(lnePath, { schemaVersion: OVERRIDE_SCHEMA_VERSION,
        revision: file.revision, updatedAtMs: T0, updatedBy: 1,
        values: { ...file.values, "frontChat.cooldownMs": 1234 } }).ok, true);
      s.setLive("modsHelp.maxReplyChars", 300);
      const row = (key) => s.ms.describe("livingNewEden", { key }).rows[0];
      assert.strictEqual(s.liveConfig.get().frontChat.cooldownMs, 1234);
      assert.deepStrictEqual([row("frontChat.cooldownMs").running, row("frontChat.cooldownMs").pending], [1234, false]);

      let refuse = true;
      const applied = [];
      const globalObj = { [LIVE_REGISTRY_KEY]: new Map([["shipWing", { keys: ["hpWarnPct"],
        apply: (values) => (refuse ? { ok: false, reason: "BUSY" } : (applied.push(values), { ok: true,
          applied: Object.keys(values) })) }]]) };
      const w = started(dir, { globalObj });
      const first = w.write("shipWing", "hpWarnPct", 80);
      assert.deepStrictEqual([first.apply, first.pending], ["restart", true]);
      const again = w.write("shipWing", "hpWarnPct", 80);
      assert.deepStrictEqual([again.changed, again.apply, again.pending], [false, "restart", true], JSON.stringify(again));
      assert.ok(again.warnings.some((m) => m.includes("BUSY")), again.warnings);
      refuse = false;
      const retried = w.write("shipWing", "hpWarnPct", 80);
      assert.deepStrictEqual(retried, { ok: true, changed: false, revision: first.revision, apply: "live",
        pending: false, warnings: [] });
      assert.deepStrictEqual(applied, [{ hpWarnPct: 80 }]);
      assert.strictEqual(w.ms.describe("shipWing", { key: "hpWarnPct" }).rows[0].running, 80);
      assert.strictEqual(w.registry.counter("modSettings.liveApplied"), 1);
    }));
};
