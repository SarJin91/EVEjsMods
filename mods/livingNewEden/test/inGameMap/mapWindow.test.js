"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const config = require("../../config");
const clientHook = require("../../clientHook");
const D = require("../../lib/adapter/clientDelivery");
const H = require("../../lib/adapter/clientHandshakeHook");
const { createAdapter } = require("../../lib/adapter");
const S = require("../../lib/inGameMap/window/schema");
const { createMapWindow } = require("../../lib/inGameMap/window/service");
const { parseMapArgs } = require("../../lib/inGameMap/chat");
const { startInGameMap } = require("../../lib/inGameMap");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const PROBE_PY = path.join(MOD_DIR, "client", "mapProbe.py");
const CHAR = 90000001;
const JITA = 30000142;
const ON = { EVEJS_LNE_INGAME_MAP_ENABLED: "1", EVEJS_LNE_INGAME_MAP_CLIENT_PROBE_ENABLED: "1" };

function marshaled(text) {
  const data = Buffer.from(text, "ascii");
  const header = Buffer.alloc(5);
  header[0] = 0x74;
  header.writeUInt32LE(data.length, 1);
  return Buffer.concat([header, data]);
}

function resolve(env) {
  const r = config.resolveConfig({ modDir: MOD_DIR, env });
  assert.ok(r.ok, JSON.stringify(r.errors));
  return r;
}

function part(source, names) {
  const p = D.buildPayload(source, 4096, names);
  assert.strictEqual(p.ok, true, JSON.stringify(p));
  return D.createClientDelivery({ encoded: p.encoded, names });
}

function fakeAdapter(over = {}) {
  const calls = { events: [], publish: [], withdraw: [], notify: [], unregister: 0, chat: [] };
  const fakePart = { setReady: (f) => calls.events.push(`ready:${f}`), isReady: () => calls.events.includes("ready:true")
    && !calls.events.includes("ready:false"), stats: () => ({ ready: true, composed: 2, skipped: 1 }) };
  const adapter = {
    calls, fakePart, handlers: null,
    boardHookState: () => ({ status: "WRAPPED" }),
    publishClientPart(name, spec) {
      calls.publish.push([name, spec.names, spec.maxOwnBytes]);
      return { ok: true, delivery: fakePart, bytes: 999 };
    },
    withdrawClientPart(name, p) {
      calls.withdraw.push([name, p === fakePart]);
      return { ok: true };
    },
    registerMapClientService(world, spec) {
      calls.events.push(`register:${spec.name}`);
      adapter.handlers = spec.handlers;
      return { ok: true, unregister() {
        calls.unregister += 1;
      } };
    },
    sendMapNotification(characterId, type, payload) {
      calls.notify.push([characterId, type, payload]);
      return { ok: true };
    },
    installChatCommand(opts) {
      calls.chat.push(opts);
      return { ok: true };
    },
    uninstallChatCommand: () => ({ ok: true }),
    ...over,
  };
  return adapter;
}

module.exports = ({ test }) => {
  test("IGW1 composite: priority order, probe not ready = board bit for bit, budget drops the probe, same object", () => {
    const board = part("x = 1\n");
    const probe = part("y = 2\n", D.PART_NAMES.mapProbe);
    const c = D.createCompositeDelivery();
    assert.deepStrictEqual(c.setPart("mapProbe", probe, D.PART_PRIORITY.mapProbe), { ok: true });
    assert.deepStrictEqual(c.setPart("board", board, D.PART_PRIORITY.board), { ok: true });
    assert.deepStrictEqual(c.setPart("bad", {}, 1), { ok: false, reason: "BAD_PART" });
    const original = marshaled("(0)");
    assert.strictEqual(c.compose(original), original, "no part ready");
    board.setReady(true);
    probe.setReady(true);
    const out = c.compose(original);
    assert.strictEqual(out[0], 0x74);
    assert.strictEqual(out.readUInt32LE(1), out.length - 5);
    const text = out.toString("latin1", 5);
    assert.strictEqual(text, probe.wrapInner(board.wrapInner("(0)")), "board innermost, probe outside");
    assert.ok(text.startsWith("(lambda _lne_r: (eval(compile('try:") && text.indexOf("<lne-map-probe-stub>")
      < text.indexOf("<lne-board-stub>"), "probe stub first");
    assert.ok(text.includes("LNE_MAP_UI:UNAVAILABLE:COMPILE") && text.includes("LNE_BOARD_UI:UNAVAILABLE:COMPILE"));
    assert.deepStrictEqual(c.parts(), [{ name: "board", priority: 10, ready: true },
      { name: "mapProbe", priority: 30, ready: true }]);
    probe.setReady(false);
    const alone = part("x = 1\n");
    alone.setReady(true);
    assert.ok(c.compose(original).equals(alone.compose(original)), "probe not ready = the board alone");
    probe.setReady(true);
    const fitsBoard = marshaled(`(${"1".repeat(D.MAX_SIGNED_FUNC_BYTES - board.extraBytes() - 2)})`);
    const skipped = probe.stats().skipped;
    const onlyBoard = c.compose(fitsBoard);
    assert.notStrictEqual(onlyBoard, fitsBoard);
    assert.strictEqual(probe.stats().skipped, skipped + 1, "probe skipped");
    assert.ok(onlyBoard.toString("latin1", 5).startsWith(board.wrapInner("").slice(0, 60)), "board kept");
    assert.strictEqual(onlyBoard.length - 5, D.MAX_SIGNED_FUNC_BYTES);
    const tooBig = marshaled(`(${"1".repeat(D.MAX_SIGNED_FUNC_BYTES - board.extraBytes() - 1)})`);
    assert.strictEqual(c.compose(tooBig), tooBig, "too big for both");
    const bad = Buffer.from(original);
    bad[0] = 0x75;
    assert.strictEqual(c.compose(bad), bad, "bad header");
    assert.deepStrictEqual(c.removePart("board", probe), { ok: true, empty: false }, "foreign reference");
    assert.deepStrictEqual(c.removePart("mapProbe", probe), { ok: true, empty: false });
    assert.deepStrictEqual(c.removePart("board", board), { ok: true, empty: true });
    assert.strictEqual(D.STUB_SOURCE, D.stubSource(D.PART_NAMES.board));
  });

  test("IGW2 adapter: one composite with two parts, foreign withdraw ignored, both withdrawn = no key", () => {
    const g = {};
    const adapter = createAdapter({ moduleApi: { _cache: {} }, globalObj: g });
    const source = fs.readFileSync(PROBE_PY, "utf8");
    const p = adapter.publishClientPart(S.PART_PROBE, { source, maxOwnBytes: 24576, names: S.PROBE_NAMES });
    assert.strictEqual(p.ok, true, JSON.stringify(p));
    const b = adapter.publishBoardDelivery({ source: "x = 1\n", maxOwnBytes: 4096 });
    assert.strictEqual(b.ok, true, JSON.stringify(b));
    assert.deepStrictEqual(Object.getOwnPropertySymbols(g), [D.DELIVERY_KEY]);
    const composite = g[D.DELIVERY_KEY];
    assert.deepStrictEqual(composite.parts().map((x) => x.name), ["board", "mapProbe"]);
    assert.deepStrictEqual(adapter.publishClientPart("nope", { source }), { ok: false, reason: "BAD_PART",
      detail: "name=nope" });
    adapter.withdrawClientPart(S.PART_PROBE, b.delivery);
    assert.strictEqual(composite.parts().length, 2, "a foreign reference is not withdrawn");
    adapter.withdrawBoardDelivery(b.delivery);
    assert.deepStrictEqual(composite.parts().map((x) => x.name), ["mapProbe"]);
    assert.strictEqual(g[D.DELIVERY_KEY], composite);
    adapter.withdrawClientPart(S.PART_PROBE, p.delivery);
    assert.deepStrictEqual(Object.getOwnPropertySymbols(g), [], "no key after the last part");
    assert.deepStrictEqual(S.PROBE_NAMES, D.PART_NAMES.mapProbe);
    assert.strictEqual(adapter.registerMapClientService({}, { name: S.SERVICE_NAME, handlers: { Report: () => true } })
      .ok, false);
  });

  test("IGW3 service and chat: ready before the limiter, 64 x 96, !map probe, off = link, refused register", () => {
    const settings = resolve(ON).config;
    const now = { t: 1000000 };
    const clock = { now: () => now.t };
    const lines = [];
    const adapter = fakeAdapter();
    const w = createMapWindow({ config: settings, ctx: {}, adapter, world: {}, clock, log: (l) => lines.push(l),
      readProbeSource: () => "z = 1\n" });
    assert.strictEqual(w.ok, true, JSON.stringify(w));
    assert.deepStrictEqual(adapter.calls.events, ["register:lneMapSvc", "ready:true"], "ready after the register");
    assert.deepStrictEqual(adapter.calls.publish, [["mapProbe", S.PROBE_NAMES, 24576]]);
    const win = w.window;
    assert.deepStrictEqual(win.openProbe(CHAR, { mode: "nodes", n: 5 }), { ok: false, reason: "NOT_DELIVERED" });
    const { Report } = adapter.handlers;
    assert.deepStrictEqual(Report({ characterId: 0, args: [] }), { ok: false, reason: "NO_CHARACTER" });
    assert.deepStrictEqual(Report({ characterId: CHAR, args: [1, 3396210, ["p.fill=1"]] }), { ok: true });
    const limited = Report({ characterId: CHAR, args: [1, 3396210, ["p.ready=1"]] });
    assert.deepStrictEqual([limited.ok, limited.reason], [false, "RATE_LIMIT"]);
    assert.ok(limited.retryMs > 0, JSON.stringify(limited));
    assert.strictEqual(win.isReady(CHAR, "mapProbe"), true, "ready although RATE_LIMIT");
    assert.strictEqual(win.isReady(CHAR, "map"), false);
    now.t += 10000;
    const long = Array.from({ length: 70 }, (_v, i) => `k ${i}=${"x".repeat(200)}`);
    assert.deepStrictEqual(Report({ characterId: CHAR, args: [1, 3396210, long] }), { ok: true });
    const probeLine = lines.filter((l) => l.startsWith("LNE_MAP_UI:PROBE ")).pop();
    const tokens = probeLine.split(" ");
    assert.deepStrictEqual(tokens.slice(0, 4), ["LNE_MAP_UI:PROBE", String(CHAR), "proto=1", "build=3396210"]);
    assert.strictEqual(tokens.length - 4, 64);
    assert.ok(tokens.slice(4).every((t) => t.length <= 96 && t.startsWith("k_")), tokens[4]);
    assert.deepStrictEqual(win.openProbe(CHAR, { mode: "attrs", n: 9 }), { ok: true });
    assert.deepStrictEqual(adapter.calls.notify.pop(), [CHAR, "OnLneMapProbe", { v: 1, mode: "attrs", n: 0 }]);
    now.t += 10000;
    Report({ characterId: CHAR, args: [1, 1, ["p.build=0:UNSUPPORTED_BUILD"]] });
    assert.strictEqual(win.isReady(CHAR, "mapProbe"), false, "unsupported build clears the mark");
    assert.deepStrictEqual([win.status().state, win.status().readyCharacters], ["on", 0]);
    win.stop("test");
    win.stop("again");
    assert.deepStrictEqual(adapter.calls.withdraw, [["mapProbe", true]]);
    assert.strictEqual(adapter.calls.unregister, 1);
    assert.deepStrictEqual(adapter.calls.events.slice(-1), ["ready:false"]);
    assert.deepStrictEqual(win.openProbe(CHAR, { mode: "nodes", n: 1 }), { ok: false, reason: "STOPPED" });

    const lim = { defaultNodes: 100, maxNodes: 2000 };
    assert.deepStrictEqual(parseMapArgs("!map probe 999999", lim), { cmd: "probe", mode: "nodes", n: 2000 });
    assert.deepStrictEqual(parseMapArgs("!mapa probe", lim), { cmd: "probe", mode: "nodes", n: 100 });
    assert.deepStrictEqual(parseMapArgs("!map probe attrs", lim), { cmd: "probe", mode: "attrs", n: 0 });
    assert.deepStrictEqual(parseMapArgs("!map probe 0", lim), { cmd: "probe", mode: "nodes", n: 1 });
    for (const t of ["!map", "!map foo", "!map probe x", "!map probes"]) {
      assert.deepStrictEqual(parseMapArgs(t, lim), { cmd: "default" }, t);
    }

    const rec = { characterId: CHAR, systemId: JITA };
    const on = fakeAdapter();
    const started = startInGameMap({ config: settings, ctx: {}, adapter: on, clock, world: {} });
    assert.strictEqual(started.ok, true, JSON.stringify(started));
    const handle = on.calls.chat[0].handle;
    assert.strictEqual(handle(rec, "!map probe"), "LNE map probe unavailable (NOT_DELIVERED) - relog after enabling");
    on.handlers.Report({ characterId: CHAR, args: [1, 3396210, ["p.ready=1"]] });
    now.t += 10000;
    assert.strictEqual(handle(rec, "!map probe 999999"), "LNE map probe sent (nodes, 2000)");
    assert.deepStrictEqual(on.calls.notify.pop(), [CHAR, "OnLneMapProbe", { v: 1, mode: "nodes", n: 2000 }]);
    now.t += 10000;
    assert.strictEqual(handle(rec, "!map probe attrs"), "LNE map probe sent (attrs, 0)");
    assert.strictEqual(started.inGameMap.getStatus().window.state, "on");
    started.inGameMap.stop("test");
    assert.deepStrictEqual(on.calls.withdraw, [["mapProbe", true]]);

    const off = fakeAdapter();
    const offStarted = startInGameMap({ config: resolve({ EVEJS_LNE_INGAME_MAP_ENABLED: "1" }).config, ctx: {},
      adapter: off, clock, world: {} });
    assert.strictEqual(offStarted.ok, true);
    assert.deepStrictEqual([off.calls.publish, off.calls.events], [[], []], "flag off: no part, no service");
    assert.ok(off.calls.chat[0].handle(rec, "!map probe 5").startsWith("LNE map: <a href="), "the link");
    assert.deepStrictEqual(offStarted.inGameMap.getStatus().window, { state: "off" });

    const refused = fakeAdapter({ registerMapClientService: () => ({ ok: false, reason: "SERVICE_NAME_TAKEN" }) });
    const r = createMapWindow({ config: settings, ctx: {}, adapter: refused, world: {}, clock, log: () => {},
      readProbeSource: () => "z = 1\n" });
    assert.deepStrictEqual(refused.calls.events, [], "setReady never called");
    assert.strictEqual(r.window.status().state, "refused:svc:SERVICE_NAME_TAKEN");
    const noHook = fakeAdapter({ boardHookState: () => ({ status: "ABSENT" }) });
    const nh = createMapWindow({ config: settings, ctx: {}, adapter: noHook, world: {}, clock, log: () => {} });
    assert.deepStrictEqual([noHook.calls.publish, nh.window.status().state], [[], "refused:hook:ABSENT"]);

    const wa = fakeAdapter();
    const winCfg = resolve({ EVEJS_LNE_INGAME_MAP_ENABLED: "1", EVEJS_LNE_INGAME_MAP_WINDOW_ENABLED: "1" }).config;
    const mw = createMapWindow({ config: winCfg, ctx: {}, adapter: wa, world: {}, clock, log: () => {},
      readMapSource: () => "m = 1\n" }).window;
    const rep = (item) => wa.handlers.Report({ characterId: CHAR, args: [1, 3396210, [item]] });
    rep("m.ready=1");
    assert.strictEqual(mw.isReady(CHAR, "map"), true);
    assert.strictEqual(rep("m.ui.layout=0:TypeError").reason, "RATE_LIMIT", "under the report limiter");
    assert.strictEqual(mw.isReady(CHAR, "map"), false, "a build step clears the mark");
    assert.deepStrictEqual(mw.open(CHAR), { ok: false, reason: "NOT_DELIVERED" });
    rep("m.ready=1");
    rep("m.ui.draw=0:KeyError");
    assert.strictEqual(mw.isReady(CHAR, "map"), true, "a runtime step keeps it");
    assert.deepStrictEqual(S.MAP_BUILD_FAIL_STEPS, ["class", "window", "parent", "layout"]);
    mw.stop("test");
  });

  test("IGW4 client/mapProbe.py: ASCII, spaces, <= 8192 B raw, payload in budget, anchors, no exec/eval/compile", () => {
    const source = fs.readFileSync(PROBE_PY).toString("latin1").replace(/\r\n/g, "\n");
    assert.ok(source.length <= 8192, `mapProbe.py ${source.length} B > 8192`);
    assert.ok(/^[\x00-\x7f]*$/.test(source), "ASCII");
    assert.ok(!source.includes("\t"), "spaces only");
    const budget = resolve(ON).config.inGameMap.maxClientPayloadBytes;
    const payload = D.buildPayload(source, budget, S.PROBE_NAMES);
    assert.strictEqual(payload.ok, true, JSON.stringify(payload));
    for (const anchor of ["'p.ready=1'", "IsServiceRunning", "OnLneMapProbe", "BUILD = 3396210",
      "'__lne_map_probe_instance'", "'lneMapSvc'"]) {
      assert.ok(source.includes(anchor), anchor);
    }
    for (const banned of ["exec(", "eval(", "compile("]) assert.ok(!source.includes(banned), banned);
    const setattrs = source.match(/setattr\([^,]*,/g) || [];
    assert.deepStrictEqual(setattrs, ["setattr(_B,"], "setattr only on the builtins key");
    assert.ok(/import __builtin__ as _B\b/.test(source), "_B is __builtin__");
  });

  test("IGW5 config + hook: 6 defaults, W60, W61 not on defaults, clientHook installs with the map flags only", () => {
    const def = resolve({}).config.inGameMap;
    assert.deepStrictEqual([def.clientProbeEnabled, def.maxClientPayloadBytes, def.reportMinIntervalMs,
      def.probeDefaultNodes, def.probeMaxNodes, def.windowMaxTrackedCharacters], [false, 24576, 10000, 100, 2000, 512]);
    const W = (r) => r.warnings.filter((w) => w.startsWith("inGameMap.clientProbeEnabled"));
    assert.deepStrictEqual(W(resolve(ON)), [], "on with the defaults");
    assert.deepStrictEqual(W(resolve({ ...ON, EVEJS_LNE_INGAME_MAP_CHAT_ENABLED: "0" })),
      ["inGameMap.clientProbeEnabled with inGameMap.chatEnabled=false - no !map probe / !map window command"], "W60");
    assert.deepStrictEqual(resolve({ ...ON, EVEJS_LNE_INGAME_MAP_CHAT_ENABLED: "0",
      EVEJS_LNE_INGAME_MAP_WINDOW_ENABLED: "1" }).warnings.filter((w) => w.includes("chatEnabled=false - no !map")),
    ["inGameMap.clientProbeEnabled, inGameMap.windowEnabled with inGameMap.chatEnabled=false - no !map probe / "
      + "!map window command"], "W60 both flags");
    assert.strictEqual(resolve({ EVEJS_LNE_INGAME_MAP_CLIENT_PROBE_ENABLED: "1" }).warnings
      .filter((w) => w.includes("inGameMap.clientProbeEnabled")).length, 1, "W55 covers it without the master");

    const baseline = "function buildTidiSignedFunc(id) { return id; }\n"
      + "const x = [buildTidiSignedFunc(this.clientId, { accountRole: this.accountRole }), 0];\n";
    const env = { ...ON, EVEJS_LNE_JOB_BOARD_HANDSHAKE_HASHES: H.sha256(baseline) };
    const host = () => {
      const base = function baseCompile() {
        return "compiled";
      };
      return { base, moduleApi: { _cache: {}, prototype: { _compile: base } } };
    };
    const h = host();
    const g = {};
    const r = clientHook.install({ moduleApi: h.moduleApi, globalObj: g, env: {}, isMainThread: true,
      loadConfig: () => resolve(env), root: MOD_DIR, readFile: () => baseline, logger: { log() {} } });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.notStrictEqual(h.moduleApi.prototype._compile, h.base, "hook installed (jobBoard off)");
    const off = host();
    const r2 = clientHook.install({ moduleApi: off.moduleApi, globalObj: {}, env: {}, isMainThread: true,
      loadConfig: () => resolve({ EVEJS_LNE_INGAME_MAP_ENABLED: "1" }), root: MOD_DIR, readFile: () => baseline });
    assert.deepStrictEqual([r2.ok, r2.reason, off.moduleApi.prototype._compile === off.base],
      [false, "disabled_by_config", true]);
  });
};
