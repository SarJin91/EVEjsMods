"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { createAdapter } = require("../../lib/adapter");
const { createSiteEntryHook } = require("../../lib/adapter/siteTalk");
const { createChatCommandHook } = require("../../lib/adapter/chatCommand");
const { startNpcVoices } = require("../../lib/npcVoices");
const { ALPHABETS } = require("../../lib/npcVoices/data/glyphs");
const { resolveConfig } = require("../../config");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SERVER_SRC = path.resolve(MOD_DIR, "..", "..", "server", "src");
const SRC = path.join(path.sep, "x", "server", "src");
const T0 = 1700000000000;
const SYS = 30000142;
const PLAYER = 90000001;
const DESTRUCTURE_RE = /\{[^}]*enterDungeonRoomForSession[^}]*\}\s*=/;

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

function exportsBlock(source) {
  const at = source.lastIndexOf("\nmodule.exports = {");
  assert.ok(at >= 0, "module.exports literal not found");
  return source.slice(at, source.indexOf("\n};", at));
}

function fakeTracking(calls) {
  return {
    enterDungeonRoomForSession(scene, session, instance, roomKey, options) {
      calls.push({ self: this, args: [...arguments] });
      if (options && options.boom) throw new Error("vendor boom");
      return options ? options.result : false;
    },
  };
}

const configs = new Map();
function configOf(env) {
  const key = JSON.stringify(env);
  if (!configs.has(key)) {
    const r = resolveConfig({ env, settings: {}, envFile: {}, modDir: MOD_DIR });
    assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
    configs.set(key, r.config);
  }
  return configs.get(key);
}

module.exports = ({ test, skip }) => {
  test("FV3-1 vendor facts: enterDungeonRoomForSession defined, exported, not destructured; sendSystemMessage", () => {
    if (!fs.existsSync(SERVER_SRC)) {
      skip("FV3-1 vendor facts", "server/src not found above the mod");
      return;
    }
    const tracking = readSource(path.join(SERVER_SRC, "services", "dungeon", "dungeonTrackingRuntime.js"));
    assert.ok(tracking.includes("\nfunction enterDungeonRoomForSession(scene, session, instance, roomKey, options"));
    assert.ok(/\n {2}enterDungeonRoomForSession,\n/.test(exportsBlock(tracking)), "export of the literal");
    assert.ok(tracking.includes("const notified = changed || options.forceNotify === true"), "forceNotify (dedup)");
    const inside = tracking.split("enterDungeonRoomForSession(").length - 1;
    assert.strictEqual(inside, 1, "the definer never calls it inside");
    const hits = listJs(SERVER_SRC).filter((f) => {
      const s = fs.readFileSync(f, "utf8");
      return s.includes("enterDungeonRoomForSession") && DESTRUCTURE_RE.test(s);
    });
    assert.deepStrictEqual(hits, [], "nobody destructures enterDungeonRoomForSession");
    const hub = readSource(path.join(SERVER_SRC, "services", "chat", "chatHub.js"));
    assert.ok(hub.includes("\nfunction sendSystemMessage(session, message, specificChannel"));
    assert.ok(/\n {2}sendSystemMessage,\n/.test(exportsBlock(hub)), "chatHub export");
  });

  test("FV3-2 site entry wrap: original once (this, arguments, result), vendor throw passes, event only for true, "
    + "consumer throw swallowed, uninstall restores", () => {
    const calls = [];
    const mod = fakeTracking(calls);
    const original = mod.enterDungeonRoomForSession;
    const events = [];
    let consumerThrows = false;
    const hook = createSiteEntryHook({ trackingExports: mod, now: () => T0, onEnter: (ev) => {
      events.push(ev);
      if (consumerThrows) throw new Error("consumer");
    } });
    assert.deepStrictEqual(hook.install(), { ok: true });
    assert.deepStrictEqual(hook.install(), { ok: false, reason: "HOOK_ALREADY_INSTALLED" });
    assert.notStrictEqual(mod.enterDungeonRoomForSession, original);

    const self = { tag: "self" };
    const scene = { systemID: SYS };
    const session = { characterID: PLAYER, characterName: "Bob" };
    const instance = { instanceID: 7001, siteKind: "anomaly", siteFamily: "combat", metadata: { factionID: 500010 } };
    const opts = { result: true };
    assert.strictEqual(mod.enterDungeonRoomForSession.call(self, scene, session, instance, "room:entry", opts), true);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].self, self);
    assert.deepStrictEqual(calls[0].args, [scene, session, instance, "room:entry", opts]);
    assert.deepStrictEqual(events, [{ characterId: PLAYER, systemId: SYS, instanceId: 7001, roomKey: "room:entry",
      siteKind: "anomaly", siteFamily: "combat", factionId: 500010, pilotName: "Bob", atMs: T0 }]);

    assert.strictEqual(mod.enterDungeonRoomForSession(scene, session, instance, "room:2", { result: false }), false);
    const odd = { result: "yes" };
    assert.strictEqual(mod.enterDungeonRoomForSession(scene, session, instance, "room:2", odd), "yes", "unchanged");
    assert.strictEqual(mod.enterDungeonRoomForSession(scene, { characterID: 0 }, instance, null, opts), true);
    assert.strictEqual(events.length, 1, "false / non-true / no character -> no event");
    assert.throws(() => mod.enterDungeonRoomForSession(scene, session, instance, "x", { boom: true }), /vendor boom/);
    consumerThrows = true;
    assert.strictEqual(mod.enterDungeonRoomForSession(scene, session, instance, "", opts), true);
    assert.strictEqual(events[1].roomKey, "room:entry", "vendor default room");
    assert.deepStrictEqual(hook.stats(), { events: 2, consumerErrors: 1 });
    assert.strictEqual(calls.length, 6, "the original exactly once per call");
    hook.uninstall();
    assert.strictEqual(mod.enterDungeonRoomForSession, original);
  });

  test("FV3-5 adapter facade + service: methods, sendCharacterSystemLine, hook only with site.enabled, !npcvoices "
    + "answers the caller only", () => {
    const calls = [];
    const tracking = fakeTracking(calls);
    const original = tracking.enterDungeonRoomForSession;
    const lines = [];
    const sessions = [{ characterID: PLAYER, characterName: "Bob", _space: { systemID: SYS } },
      { characterID: PLAYER + 1, characterName: "Ann", _space: { systemID: SYS + 1 } }];
    const hub = { throwNext: false, sendSystemMessage(session, text) {
      if (hub.throwNext) throw new Error("hub");
      lines.push({ session, text });
    } };
    const key = (rel) => path.join(SRC, `${rel}.js`);
    const cache = { [key("services/dungeon/dungeonTrackingRuntime")]: { exports: tracking },
      [key("services/chat/sessionRegistry")]: { exports: { getSessions: () => sessions } },
      [key("services/chat/chatHub")]: { exports: hub } };
    const adapter = createAdapter({ moduleApi: { _cache: cache }, logger: { log() {} } });
    adapter.setServerSrc(SRC);
    for (const m of ["installSiteEntryHook", "uninstallSiteEntryHook", "sendCharacterSystemLine"]) {
      assert.strictEqual(typeof adapter[m], "function", m);
    }
    const send = (characterId, systemId, text = "hi") => adapter.sendCharacterSystemLine({ characterId, systemId, text });
    assert.deepStrictEqual(send(PLAYER, SYS), { ok: true });
    assert.deepStrictEqual([lines.length, lines[0].session, lines[0].text], [1, sessions[0], "hi"]);
    assert.deepStrictEqual(send(PLAYER + 1, SYS), { ok: false, reason: "LEFT_SYSTEM" });
    assert.deepStrictEqual(send(PLAYER + 2, SYS), { ok: false, reason: "NO_SESSION" });
    assert.deepStrictEqual(send(PLAYER, SYS, ""), { ok: false, reason: "BAD_INPUT" });
    hub.throwNext = true;
    assert.strictEqual(send(PLAYER, SYS).reason, "SEND_THREW");
    assert.strictEqual(lines.length, 1, "only the first line reached a session");

    const start = (env) => startNpcVoices({ config: configOf(env), clock: { now: () => T0 }, worldSeed: 42, adapter,
      logger: { log() {} }, setTimer: () => ({ cancel() {}, hasRef: () => false }) }).npcVoices;
    for (const env of [{}, { EVEJS_LNE_NPC_VOICES_ENABLED: "1" }, { EVEJS_LNE_NPC_VOICES_SITE_ENABLED: "1" }]) {
      const v = start(env);
      assert.strictEqual(tracking.enterDungeonRoomForSession, original, `flags off: untouched ${JSON.stringify(env)}`);
      v.stop("test");
    }
    const on = start({ EVEJS_LNE_NPC_VOICES_ENABLED: "1", EVEJS_LNE_NPC_VOICES_SITE_ENABLED: "1" });
    assert.strictEqual(on.getStatus().site.state, "running");
    assert.notStrictEqual(tracking.enterDungeonRoomForSession, original, "hooked");
    on.stop("test");
    assert.strictEqual(tracking.enterDungeonRoomForSession, original, "restored at stop");

    const registered = [];
    const fake = { installChatCommand: (o) => {
      registered.push(o);
      return { ok: true };
    }, uninstallChatCommand: () => ({ ok: true }) };
    const v = startNpcVoices({ config: configOf({ EVEJS_LNE_NPC_VOICES_ENABLED: "1" }), clock: { now: () => T0 },
      adapter: fake, logger: { log() {} } }).npcVoices;
    assert.deepStrictEqual([registered.length, registered[0].name, v.getStatus().command.state],
      [1, "npcvoices", "registered"]);
    const broadcast = [];
    const runtime = { broadcastLocalMessage(session, message) {
      broadcast.push(message);
      return { ok: true };
    } };
    const chat = createChatCommandHook({ chatRuntimeExports: runtime, match: registered[0].match,
      handle: registered[0].handle });
    assert.deepStrictEqual(chat.install(), { ok: true });
    let reply = null;
    try {
      runtime.broadcastLocalMessage(sessions[0], "!npcvoices");
    } catch (err) {
      reply = err.message;
    }
    assert.ok(typeof reply === "string", "a reply to the sender (thrown text), not a broadcast");
    assert.deepStrictEqual(broadcast, [], "nobody else sees it");
    const rows = reply.split("<br>");
    assert.strictEqual(rows.length, 8, reply);
    for (const [i, voice] of ["DRIFTER", "SLEEPER", "ROGUE_DRONE"].entries()) {
      const text = rows[1 + i].split(": ").slice(1).join(": ");
      assert.ok(text && [...text.replace(/ /g, "")].every((ch) => ALPHABETS[voice].includes(ch)), rows[1 + i]);
    }
    assert.ok(rows[7].startsWith("Extended signs") && /[Α-ω]/.test(rows[7]), rows[7]);
    runtime.broadcastLocalMessage(sessions[0], "hello");
    assert.deepStrictEqual(broadcast, ["hello"]);
    chat.uninstall();
    v.stop("test");
  });
};
