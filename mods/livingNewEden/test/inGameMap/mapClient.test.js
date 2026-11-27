"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const config = require("../../config");
const clientHook = require("../../clientHook");
const D = require("../../lib/adapter/clientDelivery");
const H = require("../../lib/adapter/clientHandshakeHook");
const S = require("../../lib/inGameMap/window/schema");
const { createMapWindow, MAP_SOURCE, CLIENT_SOURCE } = require("../../lib/inGameMap/window/service");
const { parseMapArgs } = require("../../lib/inGameMap/chat");
const { resolveObserverUrl, formatMapReply } = require("../../lib/inGameMap/format");
const { startInGameMap } = require("../../lib/inGameMap");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const BOARD_PY = path.join(MOD_DIR, "client", "board.py");
const CHAR = 90000001;
const JITA = 30000142;
const BUILD = 3396210;
const WINDOW = { EVEJS_LNE_INGAME_MAP_ENABLED: "1", EVEJS_LNE_INGAME_MAP_WINDOW_ENABLED: "1" };
const BOTH = { ...WINDOW, EVEJS_LNE_INGAME_MAP_CLIENT_PROBE_ENABLED: "1" };

function resolve(env) {
  const r = config.resolveConfig({ modDir: MOD_DIR, env });
  assert.ok(r.ok, JSON.stringify(r.errors));
  return r;
}

function lfText(file) {
  return fs.readFileSync(file).toString("latin1").replace(/\r\n/g, "\n");
}

function fakeAdapter(over = {}) {
  const calls = { publish: [], withdraw: [], notify: [], chat: [] };
  const parts = {};
  const adapter = {
    calls, parts, handlers: null, sendResult: { ok: true },
    boardHookState: () => ({ status: "WRAPPED" }),
    publishClientPart(name, spec) {
      calls.publish.push([name, spec.names]);
      let ready = false;
      parts[name] = { setReady: (f) => {
        ready = f === true;
      }, isReady: () => ready, stats: () => ({ ready, composed: 0, skipped: 0 }) };
      return { ok: true, delivery: parts[name], bytes: 100 };
    },
    withdrawClientPart(name, p) {
      calls.withdraw.push([name, p === parts[name]]);
      return { ok: true };
    },
    registerMapClientService(world, spec) {
      adapter.handlers = spec.handlers;
      return { ok: true, unregister() {} };
    },
    sendMapNotification(characterId, type, payload) {
      calls.notify.push([characterId, type, payload]);
      return adapter.sendResult;
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
  test("IGC1 client/map.py: ASCII, spaces, <= 40960 B raw, payload in budget, anchors; composite of 3 real parts", () => {
    const source = lfText(MAP_SOURCE);
    assert.ok(source.length <= 40960, `map.py ${source.length} B > 40960`);
    assert.ok(/^[\x00-\x7f]*$/.test(source), "ASCII");
    assert.ok(!source.includes("\t"), "spaces only");
    const cfg = resolve(WINDOW).config;
    const payload = D.buildPayload(source, cfg.inGameMap.maxClientPayloadBytes, S.MAP_NAMES);
    assert.strictEqual(payload.ok, true, JSON.stringify(payload));
    for (const anchor of ["'m.ready=1'", "'OnLneMapOpen'", "GetMap(", "BUILDS = (3396210, 3724492)", "'__lne_map_instance'",
      "'lneMapSvc'", "'m.build=0:UNSUPPORTED_BUILD'", "'lneMapWindow1'"]) {
      assert.ok(source.includes(anchor), anchor);
    }
    for (const banned of ["exec(", "eval(", "compile("]) assert.ok(!source.includes(banned), banned);
    for (const anchor of ["self.pending", "self.view != view"]) assert.ok(source.includes(anchor), anchor);
    for (const gone of ["NOT_ON_MAP", "force"]) assert.ok(!source.includes(gone), gone);
    assert.deepStrictEqual(S.MAP_NAMES, D.PART_NAMES.map);

    const composite = D.createCompositeDelivery();
    const specs = [["board", lfText(BOARD_PY), cfg.jobBoard.maxClientPayloadBytes, D.PART_NAMES.board],
      ["map", source, cfg.inGameMap.maxClientPayloadBytes, S.MAP_NAMES],
      ["mapProbe", lfText(CLIENT_SOURCE), cfg.inGameMap.maxClientPayloadBytes, S.PROBE_NAMES]];
    for (const [name, text, budget, names] of specs) {
      const p = D.buildPayload(text, budget, names);
      assert.strictEqual(p.ok, true, `${name} ${JSON.stringify(p)}`);
      const part = D.createClientDelivery({ encoded: p.encoded, names });
      part.setReady(true);
      assert.deepStrictEqual(composite.setPart(name, part, D.PART_PRIORITY[name]), { ok: true });
    }
    const data = Buffer.from("(0)", "ascii");
    const header = Buffer.alloc(5);
    header[0] = 0x74;
    header.writeUInt32LE(data.length, 1);
    const out = composite.compose(Buffer.concat([header, data]));
    const text = out.toString("latin1", 5);
    for (const stub of ["<lne-board-stub>", "<lne-map-stub>", "<lne-map-probe-stub>"]) assert.ok(text.includes(stub), stub);
    assert.ok(out.length < D.MAX_SIGNED_FUNC_BYTES, `signedFunc ${out.length} B`);
  });

  test("IGC2 routing: off = link bit for bit, fallback link before m.ready=1, opened after, `!map link` = link", () => {
    const now = { t: 1000000 };
    const clock = { now: () => now.t };
    const rec = { characterId: CHAR, systemId: JITA };
    const link = (cfg) => {
      const fc = cfg.frontChat || {};
      const lineBreak = fc.lineBreak === "\\n" ? "\n" : String(fc.lineBreak ?? "\n");
      return formatMapReply({ url: resolveObserverUrl(cfg.inGameMap, cfg.observer).url, systemId: JITA,
        systemName: null, lineBreak });
    };

    const offCfg = resolve({ EVEJS_LNE_INGAME_MAP_ENABLED: "1" }).config;
    const off = fakeAdapter();
    const offStarted = startInGameMap({ config: offCfg, ctx: {}, adapter: off, clock, world: {} });
    assert.strictEqual(offStarted.ok, true);
    assert.strictEqual(off.calls.chat[0].handle(rec, "!map"), link(offCfg), "flag off = the link bit for bit");
    assert.deepStrictEqual([off.calls.publish, off.calls.notify], [[], []]);

    const cfg = resolve(WINDOW).config;
    const on = fakeAdapter();
    const started = startInGameMap({ config: cfg, ctx: {}, adapter: on, clock, world: {} });
    assert.strictEqual(started.ok, true, JSON.stringify(started));
    assert.deepStrictEqual(on.calls.publish, [["map", S.MAP_NAMES]]);
    const handle = on.calls.chat[0].handle;
    const counters = () => started.inGameMap.getStatus().window.counters;
    assert.strictEqual(handle(rec, "!map"), link(cfg), "not ready -> the link");
    assert.deepStrictEqual([counters().openFallbackLink, on.calls.notify.length], [1, 0]);
    on.handlers.Report({ characterId: CHAR, args: [1, BUILD, ["m.node=fill", "m.ready=1"]] });
    now.t += 10000;
    assert.strictEqual(handle(rec, "!map"), "LNE map window opened");
    assert.deepStrictEqual(on.calls.notify, [[CHAR, "OnLneMapOpen", { v: 1 }]]);
    assert.strictEqual(counters().opens, 1);
    now.t += 10000;
    assert.strictEqual(handle(rec, "!mapa link"), link(cfg), "`!map link` = the link although ready");
    assert.strictEqual(on.calls.notify.length, 1);
    now.t += 10000;
    on.sendResult = { ok: false, reason: "NO_SESSION" };
    assert.strictEqual(handle(rec, "!map"), link(cfg), "NO_SESSION -> the link");
    assert.deepStrictEqual([counters().openNoSession, counters().openFallbackLink], [1, 2]);
    assert.deepStrictEqual(parseMapArgs("!map link", {}), { cmd: "link" });
    assert.deepStrictEqual(parseMapArgs("!map links", {}), { cmd: "default" });
    started.inGameMap.stop("test");
    assert.deepStrictEqual(on.calls.withdraw, [["map", true]]);
  });

  test("IGC3 ready per part: p.ready=1 only mapProbe, m.ready=1 only map, m. UNSUPPORTED_BUILD clears only map", () => {
    const now = { t: 1000000 };
    const adapter = fakeAdapter();
    const w = createMapWindow({ config: resolve(BOTH).config, ctx: {}, adapter, world: {}, clock: { now: () => now.t },
      log: () => {}, readProbeSource: () => "p = 1\n", readMapSource: () => "m = 1\n" });
    assert.strictEqual(w.ok, true, JSON.stringify(w));
    assert.deepStrictEqual(adapter.calls.publish, [["mapProbe", S.PROBE_NAMES], ["map", S.MAP_NAMES]]);
    const win = w.window;
    const { Report } = adapter.handlers;
    const both = () => [win.isReady(CHAR, "mapProbe"), win.isReady(CHAR, "map")];
    Report({ characterId: CHAR, args: [1, BUILD, ["p.ready=1"]] });
    assert.deepStrictEqual(both(), [true, false], "p.ready=1 = the probe only");
    Report({ characterId: CHAR, args: [1, BUILD, ["m.ready=1"]] });
    assert.deepStrictEqual(both(), [true, true]);
    Report({ characterId: CHAR, args: [1, 1, ["m.build=0:UNSUPPORTED_BUILD"]] });
    assert.deepStrictEqual(both(), [true, false], "m. clears only the map part");
    Report({ characterId: CHAR + 1, args: [1, BUILD, ["m.ready=1"]] });
    assert.deepStrictEqual([win.isReady(CHAR + 1, "map"), win.isReady(CHAR + 1, "mapProbe")], [true, false]);
    assert.strictEqual(win.status().state, "on");
    win.stop("test");
    assert.deepStrictEqual(adapter.calls.withdraw, [["mapProbe", true], ["map", true]]);
    assert.deepStrictEqual([both(), win.open(CHAR).reason], [[false, false], "OFF"]);
  });

  test("IGC4 hook: clientHook installs with inGameMap.enabled + windowEnabled and jobBoard.enabled=false", () => {
    const baseline = "function buildTidiSignedFunc(id) { return id; }\n"
      + "const x = [buildTidiSignedFunc(this.clientId, { accountRole: this.accountRole }), 0];\n";
    const env = { ...WINDOW, EVEJS_LNE_JOB_BOARD_HANDSHAKE_HASHES: H.sha256(baseline) };
    const loaded = resolve(env);
    assert.deepStrictEqual([loaded.config.jobBoard.enabled, loaded.config.inGameMap.clientProbeEnabled], [false, false]);
    const base = function baseCompile() {
      return "compiled";
    };
    const moduleApi = { _cache: {}, prototype: { _compile: base } };
    const r = clientHook.install({ moduleApi, globalObj: {}, env: {}, isMainThread: true, loadConfig: () => loaded,
      root: MOD_DIR, readFile: () => baseline, logger: { log() {} } });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.notStrictEqual(moduleApi.prototype._compile, base, "hook installed (window only)");
  });

  test("IGC5 client build gate: board.py, map.py and mapProbe.py accept the same BUILDS, which hold the server "
    + "protocol build; the gate is a membership test and every Report after it sends the checked build", () => {
    const profile = path.resolve(MOD_DIR, "..", "..", "server", "src", "network", "protocolProfile.js");
    const served = fs.existsSync(profile) ? /clientBuild:\s*([\d_]+)/.exec(fs.readFileSync(profile, "utf8")) : null;
    const checks = [
      [BOARD_PY, "if build not in BUILDS:", "self.client_no = build", "Report(PROTO, self.client_no, batch)"],
      [MAP_SOURCE, "if build not in BUILDS:", "self.client_no = build", "Report(PROTO, self.client_no, batch)"],
      [CLIENT_SOURCE, "if b not in BUILDS:", "s.bn=b", "Report(PROTO,s.bn,b)"],
    ];
    for (const [file, gate, keep, report] of checks) {
      const source = lfText(file);
      const name = path.basename(file);
      const m = /^ +BUILDS = \(([\d, ]+)\)$/m.exec(source);
      assert.ok(m, `${name} BUILDS`);
      const builds = m[1].split(",").map((s) => Number(s.trim()));
      assert.deepStrictEqual(builds, [3396210, 3724492], name);
      if (served) assert.ok(builds.includes(Number(served[1].replace(/_/g, ""))), `${name} accepts the server build`);
      assert.ok(!/\bBUILD\b/.test(source), `${name} has no single-build constant`);
      const at = source.indexOf(gate);
      assert.ok(at > 0, `${name} gate`);
      assert.ok(source.indexOf(keep, at) > at, `${name} keeps the checked build`);
      assert.ok(source.includes(report), `${name} reports the checked build`);
    }
  });
};
