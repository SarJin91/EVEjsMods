"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const { createAdapter } = require("../../lib/adapter");
const { GAME_MODULES } = require("../../lib/adapter/gameModules");
const { createLocalTalkTap } = require("../../lib/adapter/localTalkTap");
const localPilots = require("../../lib/adapter/localPilots");
const xmppTap = require("../../lib/adapter/localPilotsXmpp");
const { startNpcVoices } = require("../../lib/npcVoices");
const { resolveConfig } = require("../../config");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SERVER_SRC = path.resolve(MOD_DIR, "..", "..", "server", "src");
const SRC = path.join(path.sep, "x", "server", "src");
const EVENT = "local-message";
const T0 = 1700000000000;
const SYS = 30000142;
const PLAYER = 90000001;
const NPC = 91000001;

function readSource(file) {
  return fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
}

function listJs(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listJs(full, out);
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

function fakeChat() {
  const emitter = new EventEmitter();
  return { emitter, exports: { on: emitter.on.bind(emitter), off: emitter.off.bind(emitter) } };
}

const OBSERVER = { set: localPilots.setOccupantLineObserver, clear: localPilots.clearOccupantLineObserver };

function configOf(env) {
  const r = resolveConfig({ env, settings: {}, envFile: {}, modDir: MOD_DIR });
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
  return r.config;
}

module.exports = ({ test, skip }) => {
  test("LT1 vendor facts: broadcastLocalMessage emits local-message after sendChannelMessage, only in chatRuntime; "
    + "exports on / off", () => {
    if (!fs.existsSync(SERVER_SRC)) {
      skip("LT1 vendor facts", "server/src not found above the mod");
      return;
    }
    const file = path.join(SERVER_SRC, "_secondary", "chat", "chatRuntime.js");
    const chat = readSource(file);
    const at = chat.indexOf("\nfunction broadcastLocalMessage(session, message) {");
    assert.ok(at >= 0, "broadcastLocalMessage(session, message)");
    const body = chat.slice(at, chat.indexOf("\n}\n", at));
    const send = body.indexOf("sendChannelMessage(session, roomName, message)");
    const emit = body.indexOf(`runtimeEmitter.emit("${EVENT}", {`);
    assert.ok(send > 0 && emit > send, "the emission after sendChannelMessage");
    for (const field of ["solarSystemID: getCurrentSolarSystemID(session)", "authorCharacterID: getCharacterID(session)",
      "message: result.entry.message"]) {
      assert.ok(body.slice(emit).includes(field), field);
    }
    const exportsAt = chat.lastIndexOf("\nmodule.exports = {");
    const block = chat.slice(exportsAt, chat.indexOf("\n};", exportsAt));
    assert.ok(block.includes("\n  on: runtimeEmitter.on.bind(runtimeEmitter),"), "export on");
    assert.ok(block.includes("\n  off: runtimeEmitter.off.bind(runtimeEmitter),"), "export off");
    const emitters = listJs(SERVER_SRC).filter((f) => fs.readFileSync(f, "utf8").includes(`emit("${EVENT}"`));
    assert.deepStrictEqual(emitters, [file], "the emission only in chatRuntime");
  });

  test("LT2 tap: player line -> fn, NPC line only after ok:true, fn throw swallowed, one tap, uninstall = off", () => {
    const realSend = xmppTap.sendOccupantMessage;
    try {
      localPilots._resetForTest();
      xmppTap._resetForTest();
      assert.deepStrictEqual(xmppTap.install({ [xmppTap.METHOD]: () => null }, {}),
        { ok: true, alreadyInstalled: false });
      let next = { ok: true, sockets: 1 };
      xmppTap.sendOccupantMessage = () => next;
      const seam = localPilots.createLocalPilotsSeam({ requireGame: () => ({ ok: false, reason: "x" }) });
      const chat = fakeChat();
      const lines = [];
      let boom = false;
      const tap = createLocalTalkTap({ chatRuntimeExports: chat.exports, lineObserver: OBSERVER, now: () => T0 });
      assert.deepStrictEqual(tap.install((line) => {
        lines.push(line);
        if (boom) throw new Error("consumer");
      }), { ok: true });
      assert.deepStrictEqual(tap.install(() => {}), { ok: false, reason: "HOOK_ALREADY_INSTALLED" });
      assert.strictEqual(chat.emitter.listenerCount(EVENT), 1);

      chat.emitter.emit(EVENT, { roomName: `local_${SYS}`, solarSystemID: SYS, authorCharacterID: PLAYER,
        message: "hello", entry: {} });
      chat.emitter.emit(EVENT, { solarSystemID: SYS, authorCharacterID: 0, message: "x" });
      chat.emitter.emit(EVENT, { solarSystemID: 0, authorCharacterID: PLAYER, message: "x" });
      chat.emitter.emit(EVENT, null);
      assert.deepStrictEqual(lines, [{ kind: "player", systemId: SYS, characterId: PLAYER, text: "hello", atMs: T0 }]);

      const spec = { systemId: SYS, characterId: NPC, text: "o7" };
      assert.deepStrictEqual(seam.sendOccupantMessage(spec), { ok: true, sockets: 1 });
      next = { ok: false, reason: "NO_SOCKET" };
      assert.deepStrictEqual(seam.sendOccupantMessage(spec), { ok: false, reason: "NO_SOCKET" }, "result unchanged");
      assert.deepStrictEqual(lines.slice(1), [{ kind: "npc", systemId: SYS, characterId: NPC, text: "o7", atMs: T0 }],
        "NO_SOCKET: nobody saw it");

      boom = true;
      next = { ok: true, sockets: 2 };
      assert.doesNotThrow(() => chat.emitter.emit(EVENT, { solarSystemID: SYS, authorCharacterID: PLAYER, message: "y" }));
      assert.deepStrictEqual(seam.sendOccupantMessage(spec), { ok: true, sockets: 2 }, "a consumer throw keeps the result");
      assert.deepStrictEqual(tap.stats(), { installed: true, playerLines: 2, npcLines: 2, ignored: 3, consumerErrors: 2 });

      assert.deepStrictEqual(tap.uninstall(), { ok: true });
      assert.deepStrictEqual(tap.uninstall(), { ok: true }, "idempotent");
      assert.strictEqual(chat.emitter.listenerCount(EVENT), 0, "off with the same listener");
      assert.strictEqual(localPilots.occupantLineObserverState().observed, false, "observer removed");
      const before = lines.length;
      seam.sendOccupantMessage(spec);
      chat.emitter.emit(EVENT, { solarSystemID: SYS, authorCharacterID: PLAYER, message: "z" });
      assert.strictEqual(lines.length, before, "nothing after uninstall");
    } finally {
      xmppTap.sendOccupantMessage = realSend;
      xmppTap._resetForTest();
      localPilots._resetForTest();
    }
  });

  test("LT3 adapter facade: methods, characterNameOf, DRIFT -> SEAM_UNAVAILABLE; tap only with talk.enabled, "
    + "transcript of the snapshot, removed at stop", () => {
    const key = (rel) => path.join(SRC, `${rel}.js`);
    const chat = fakeChat();
    const records = { [PLAYER]: { characterName: `  ${"B".repeat(70)}  ` }, [NPC]: { characterName: "Kiri Despoiler" } };
    const cache = { [key("_secondary/chat/chatRuntime")]: { exports: chat.exports },
      [key("services/character/characterState")]: { exports: { peekCharacterRecord: (id) => records[id] || null } } };
    try {
      localPilots._resetForTest();
      const adapter = createAdapter({ moduleApi: { _cache: cache }, logger: { log() {} } });
      adapter.setServerSrc(SRC);
      assert.strictEqual(typeof adapter.localTalkSeams, "function");
      const res = adapter.localTalkSeams();
      assert.strictEqual(res.ok, true);
      assert.deepStrictEqual(Object.keys(res.seam).sort(), ["characterNameOf", "installTap", "stats", "uninstallTap"]);
      const seam = res.seam;
      assert.deepStrictEqual(seam.characterNameOf(NPC), { ok: true, name: "Kiri Despoiler" });
      assert.deepStrictEqual(seam.characterNameOf(PLAYER), { ok: true, name: "B".repeat(64) }, "trimmed, <= 64");
      assert.deepStrictEqual(seam.characterNameOf(PLAYER + 5), { ok: false, reason: "NO_RECORD" });
      assert.deepStrictEqual(seam.characterNameOf(0), { ok: false, reason: "BAD_ID" });

      const start = (env) => startNpcVoices({ config: configOf(env), clock: { now: () => T0 }, worldSeed: 42, adapter,
        logger: { log() {} }, setTimer: () => ({ cancel() {}, hasRef: () => false }) }).npcVoices;
      for (const env of [{}, { EVEJS_LNE_NPC_VOICES_ENABLED: "1" }, { EVEJS_LNE_NPC_VOICES_TALK_ENABLED: "1" }]) {
        const v = start(env);
        assert.strictEqual(chat.emitter.listenerCount(EVENT), 0, `flags off: no listener ${JSON.stringify(env)}`);
        v.stop("test");
      }
      const on = start({ EVEJS_LNE_NPC_VOICES_ENABLED: "1", EVEJS_LNE_NPC_VOICES_TALK_ENABLED: "1",
        EVEJS_LNE_NPC_VOICES_LOCAL_ENABLED: "1", EVEJS_LNE_LOCAL_PILOTS_ENABLED: "1" });
      assert.strictEqual(on.getStatus().lanes.talk.state, "running");
      assert.strictEqual(chat.emitter.listenerCount(EVENT), 1, "tapped");
      chat.emitter.emit(EVENT, { solarSystemID: SYS, authorCharacterID: PLAYER, message: "before the snapshot" });
      on.noteFactionCrews(new Map([[SYS, [{ characterId: NPC, factionId: 500010 }]]]), T0);
      chat.emitter.emit(EVENT, { solarSystemID: SYS, authorCharacterID: PLAYER, message: "hi <b>all</b>" });
      chat.emitter.emit(EVENT, { solarSystemID: SYS + 1, authorCharacterID: PLAYER, message: "other system" });
      const talk = on.getStatus().lanes.talk;
      assert.deepStrictEqual([talk.systems, talk.transcriptLines, talk.counters.playerLines, talk.counters.noted,
        talk.counters.skipped], [1, 1, 3, 1, 2]);
      assert.ok(!JSON.stringify(talk).includes("hi all") && !JSON.stringify(talk).includes("BBB"), "no text, no name");
      on.stop("test");
      assert.strictEqual(chat.emitter.listenerCount(EVENT), 0, "removed at stop");
      assert.strictEqual(on.getStatus().lanes.talk.state, "stopped");

      const table = GAME_MODULES.map((e) => (e.path === "_secondary/chat/chatRuntime" ? e : { ...e, symbols: [] }));
      const drift = createAdapter({ moduleApi: { _cache: { [key("_secondary/chat/chatRuntime")]: { exports: {} } } },
        logger: { log() {} }, gameModules: table });
      drift.setServerSrc(SRC);
      const report = drift.runProbe();
      assert.ok(Object.keys(report.disabledModules).includes("npcVoicesTalk"), JSON.stringify(report.disabledModules));
      const refused = drift.localTalkSeams();
      assert.deepStrictEqual([refused.ok, refused.reason], [false, "SEAM_UNAVAILABLE"]);
    } finally {
      localPilots._resetForTest();
    }
  });
};
