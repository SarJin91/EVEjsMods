"use strict";

const assert = require("node:assert");
const path = require("node:path");

const config = require("../../config");
const format = require("../../lib/inGameMap/format");
const { matchMapCommand } = require("../../lib/inGameMap/chat");
const { startInGameMap, COMMAND_NAME } = require("../../lib/inGameMap");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const JITA = 30000142;

function fakeAdapter() {
  const installs = [];
  const removed = [];
  return { installs, removed,
    installChatCommand(opts) {
      installs.push(opts);
      return { ok: true };
    },
    uninstallChatCommand(name) {
      removed.push(name);
      return { ok: true };
    } };
}

function fakeGraph() {
  const nodes = new Map([[JITA, { name: "Jita" }], [30000001, { name: "A<b>&\"c'" }]]);
  return { getGraph: () => ({ ok: true, graph: { getSystem: (id) => nodes.get(id) || null } }) };
}

function start(over = {}, observer = { enabled: true, port: 26410 }) {
  const adapter = fakeAdapter();
  const now = { t: 1000000 };
  const counts = [];
  const r = startInGameMap({ config: {
    inGameMap: { enabled: true, chatEnabled: true, observerUrl: "", chatMinIntervalMs: 10000, ...over },
    frontChat: { maxRepliesPerMinute: 30, maxTrackedCharacters: 1024, lineBreak: "<br>" }, observer },
  ctx: { graph: fakeGraph() }, adapter, clock: { now: () => now.t },
  telemetry: { count: (name, n) => counts.push([name, n]) } });
  return { r, adapter, now, counts };
}

module.exports = ({ test }) => {
  test("IGM1 format: URL from the port / observerUrl, escaped name, #map without a system, OBSERVER_OFF", () => {
    assert.deepStrictEqual(format.resolveObserverUrl({ observerUrl: "" }, { enabled: true, port: 26410 }),
      { ok: true, url: "http://127.0.0.1:26410/" });
    assert.deepStrictEqual(format.resolveObserverUrl({ observerUrl: "https://lne.example:8443/obs" },
      { enabled: true, port: 26410 }), { ok: true, url: "https://lne.example:8443/obs/" });
    assert.deepStrictEqual(format.resolveObserverUrl({ observerUrl: "http://10.0.0.5:26410/" },
      { enabled: true, port: 1 }), { ok: true, url: "http://10.0.0.5:26410/" });
    assert.deepStrictEqual(format.resolveObserverUrl({ observerUrl: "" }, { enabled: false, port: 26410 }),
      { ok: false, reason: "OBSERVER_OFF" });
    const url = "http://127.0.0.1:26410/";
    assert.strictEqual(format.formatMapReply({ url, systemId: 30000001, systemName: "A<b>&\"c'", lineBreak: "<br>" }),
      "LNE map: <a href=\"http://127.0.0.1:26410/#map/30000001\">Living New Eden map - A&lt;b&gt;&amp;&quot;c&#39;</a>"
      + "<br>(http://127.0.0.1:26410/#map/30000001 - opens in your browser)");
    assert.strictEqual(format.formatMapReply({ url, systemId: null, systemName: null, lineBreak: "\n" }),
      "LNE map: <a href=\"http://127.0.0.1:26410/#map\">Living New Eden map</a>"
      + "\n(http://127.0.0.1:26410/#map - opens in your browser)");
    assert.strictEqual(format.formatMapRefusal("OBSERVER_OFF"), "LNE map: the observer is off (observer.enabled)");
    assert.strictEqual(format.formatMapRefusal("RATE_LIMITED", { waitMs: 4200 }), "LNE map: wait 5 s before the next !map");
  });

  test("IGM2 service: off = no registration; on = registered map, limiter, observer off, stop uninstalls", () => {
    const off = start({ enabled: false });
    assert.deepStrictEqual(off.r, { ok: false, reason: "disabled_by_config" });
    assert.strictEqual(off.adapter.installs.length, 0);

    const { r, adapter, now, counts } = start();
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(adapter.installs.length, 1);
    assert.strictEqual(adapter.installs[0].name, COMMAND_NAME);
    assert.strictEqual(COMMAND_NAME, "map");
    const handle = adapter.installs[0].handle;
    const rec = { characterId: 90000001, systemId: JITA };
    assert.strictEqual(handle(rec), "LNE map: <a href=\"http://127.0.0.1:26410/#map/30000142\">Living New Eden map - "
      + "Jita</a><br>(http://127.0.0.1:26410/#map/30000142 - opens in your browser)");
    assert.strictEqual(handle(rec), "LNE map: wait 10 s before the next !map");
    assert.ok(handle({ characterId: 90000002, systemId: 30009999 }).includes("#map/30009999\">Living New Eden map</a>"),
      "unknown node: link with the id, no name");
    assert.strictEqual(handle(null), "LNE map unavailable (NO_CHARACTER)");
    now.t += 10000;
    assert.ok(handle(rec).startsWith("LNE map: <a href="), "after the interval");
    assert.deepStrictEqual(r.inGameMap.getStatus(), { state: "running", chat: { registered: true },
      counters: { replies: 3, rateLimited: 1, refused: 1, errors: 0 },
      starmap: { jumps: "off", reason: null, tracker: null },
      starmapKills: { state: "off", reason: null, losses: null },
      window: { state: "off" } });
    assert.ok(counts.some(([name]) => name === "inGameMap.chat.replies"), JSON.stringify(counts));
    r.inGameMap.stop("test");
    assert.deepStrictEqual(adapter.removed, ["map"]);
    assert.strictEqual(handle(rec), "LNE map unavailable (STOPPED)");
    r.inGameMap.stop("again");
    assert.deepStrictEqual(adapter.removed, ["map"], "stop once");

    const dark = start({}, { enabled: false, port: 26410 });
    assert.strictEqual(dark.r.inGameMap.handle(rec), "LNE map: the observer is off (observer.enabled)");
    const custom = start({ observerUrl: "http://192.168.1.10:26410" });
    assert.ok(custom.r.inGameMap.handle(rec).includes("<a href=\"http://192.168.1.10:26410/#map/30000142\">"));
    const noChat = start({ chatEnabled: false });
    assert.strictEqual(noChat.r.ok, true);
    assert.strictEqual(noChat.adapter.installs.length, 0);
    assert.deepStrictEqual(noChat.r.inGameMap.getStatus().chat, { registered: false });
  });

  test("IGM3 match + config: regex, bad observerUrl refused, defaults, W55 and W56", () => {
    for (const t of ["!map", "!MAPA", "! map", "!map foo", "!MAP", "!mapa"]) assert.strictEqual(matchMapCommand(t), true, t);
    for (const t of ["!mapx", "map", "!maps", "mapa", "!!map"]) assert.strictEqual(matchMapCommand(t), false, t);

    const resolve = (env) => config.resolveConfig({ modDir: MOD_DIR, env });
    const def = resolve({});
    assert.deepStrictEqual(def.config.inGameMap, { enabled: false, chatEnabled: true, observerUrl: "",
      chatMinIntervalMs: 10000, starmapJumpsEnabled: true, starmapJumpsPerShip: true, starmapScanMs: 30000,
      starmapScanPageSize: 500, starmapMaxScanFleets: 5000, starmapMaxTrackedLegs: 20000,
      starmapKillsEnabled: true, starmapKillsRefreshMs: 60000, starmapMaxLossRows: 2000, starmapMaxSyntheticKills: 5000,
      starmapFallbackShipTypeId: 587,
      clientProbeEnabled: false, maxClientPayloadBytes: 24576, reportMinIntervalMs: 10000, probeDefaultNodes: 100,
      probeMaxNodes: 2000, windowMaxTrackedCharacters: 512,
      windowEnabled: false, windowPollMs: 30000, windowMinIntervalMs: 5000, windowMaxReadsPerMinute: 120,
      windowMaxSystems: 300, windowMaxMarkers: 200, windowNeighborJumps: 1, windowCacheEntries: 64,
      windowClientCacheRegions: 8, windowMaxLabels: 150, windowStateMinRefreshMs: 10000,
      windowCorpMarksRefreshMs: 30000 });
    const W = (x) => x.warnings.filter((w) => w.startsWith("inGameMap."));
    assert.deepStrictEqual(W(def), [], "defaults: chatEnabled true without the master is no warning");
    for (const bad of ["ftp://x", "127.0.0.1:26410", "http://a\"b", "http://a<b", "http://a>b", "http://a'b",
      "http://a b", `http://${"a".repeat(200)}`]) {
      const r = resolve({ EVEJS_LNE_INGAME_MAP_OBSERVER_URL: bad });
      assert.strictEqual(r.config.inGameMap.observerUrl, "", bad);
      assert.ok(r.warnings.some((w) => w.includes("INGAME_MAP_OBSERVER_URL") || w.includes("observerUrl")), bad);
    }
    assert.strictEqual(resolve({ EVEJS_LNE_INGAME_MAP_OBSERVER_URL: "https://lne.example/x" }).config.inGameMap
      .observerUrl, "https://lne.example/x");
    assert.strictEqual(W(resolve({ EVEJS_LNE_INGAME_MAP_CHAT_ENABLED: "1" })).length, 1, "W55");
    assert.strictEqual(W(resolve({ EVEJS_LNE_INGAME_MAP_ENABLED: "1", EVEJS_LNE_OBSERVER_ENABLED: "0" })).length, 1,
      "W56");
    assert.deepStrictEqual(W(resolve({ EVEJS_LNE_INGAME_MAP_ENABLED: "1" })), []);
  });
};
