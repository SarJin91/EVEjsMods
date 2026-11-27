"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const { createChatCommandHook, transportOfStack } = require("../../lib/adapter/chatCommand");
const { matchFrontCommand } = require("../../lib/frontChat");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SERVER_SRC = path.resolve(MOD_DIR, "..", "..", "server", "src");
const AUD_COMMAND = path.resolve(MOD_DIR, "..", "EveJS-AdvancedUtilityDrones-1.0.3", "lib", "chatCommand.js");

function readSource(file) {
  return fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
}

function bodyOf(source, name) {
  const start = source.indexOf(`\nfunction ${name}(`);
  assert.ok(start >= 0, `function ${name} not found`);
  const next = source.slice(start + 1).search(/\n(async )?function /);
  return source.slice(start, next < 0 ? source.length : start + 1 + next);
}

function fakeRuntime(calls) {
  const runtime = {
    broadcastLocalMessage(session, message) {
      calls.push({ self: this, session, message });
      return { entry: { message } };
    },
  };
  const inner = runtime.broadcastLocalMessage;
  runtime.broadcastLocalMessage = function audLayer(session, message) {
    if (/^!\s*aud$/i.test(String(message).trim())) throw new Error("AUD menu");
    return inner.apply(this, arguments);
  };
  return runtime;
}

module.exports = ({ test }) => {
  test("CC1 chat command hook: reply by a throw without code, pass-through, uninstall, double install", () => {
    const calls = [];
    const runtime = fakeRuntime(calls);
    const aud = runtime.broadcastLocalMessage;
    const seen = [];
    const hook = createChatCommandHook({ chatRuntimeExports: runtime, match: matchFrontCommand,
      handle: (rec) => {
        seen.push(rec);
        return "LNE front - Jita<br>System: no LNE front here";
      }, failReply: "LNE: front unavailable (HANDLER_FAILED)" });
    assert.deepStrictEqual(hook.install(), { ok: true });
    assert.deepStrictEqual(hook.install(), { ok: false, reason: "HOOK_ALREADY_INSTALLED" });
    const session = { characterID: 90000001, characterName: "Pilot", solarsystemid2: 30000142, stationid: 60003760 };

    let thrown = null;
    try {
      runtime.broadcastLocalMessage(session, "  !front ");
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof Error);
    assert.strictEqual(thrown.message, "LNE front - Jita<br>System: no LNE front here");
    assert.strictEqual(thrown.code, undefined, "no code: formatChannelAccessError keeps the message");
    assert.strictEqual(calls.length, 0, "the original is not called");
    assert.deepStrictEqual(seen, [{ characterId: 90000001, name: "Pilot", systemId: 30000142, state: "docked" }]);

    const self = { tag: "chatHub" };
    const r1 = runtime.broadcastLocalMessage.call(self, session, "hello");
    assert.deepStrictEqual(r1, { entry: { message: "hello" } });
    assert.strictEqual(calls[0].self, self);
    assert.strictEqual(calls[0].session, session);
    assert.throws(() => runtime.broadcastLocalMessage(session, "!aud"), /AUD menu/);
    const r2 = runtime.broadcastLocalMessage(session, "!aud x");
    const r3 = runtime.broadcastLocalMessage(session, "!frontier");
    assert.deepStrictEqual([r2.entry.message, r3.entry.message], ["!aud x", "!frontier"]);
    assert.strictEqual(seen.length, 1, "only !front reaches handle");

    hook.uninstall();
    assert.strictEqual(runtime.broadcastLocalMessage, aud, "uninstall restores the previous function");

    const failing = createChatCommandHook({ chatRuntimeExports: runtime, match: matchFrontCommand,
      handle: () => {
        throw new Error("boom");
      }, failReply: "LNE: front unavailable (HANDLER_FAILED)" });
    assert.deepStrictEqual(failing.install(), { ok: true });
    assert.throws(() => runtime.broadcastLocalMessage(session, "!front now"),
      (err) => err.message === "LNE: front unavailable (HANDLER_FAILED)" && err.code === undefined);
    const ours = runtime.broadcastLocalMessage;
    const later = function laterLayer() {
      return ours.apply(this, arguments);
    };
    runtime.broadcastLocalMessage = later;
    failing.uninstall();
    assert.strictEqual(runtime.broadcastLocalMessage, later);
    assert.deepStrictEqual(runtime.broadcastLocalMessage(session, "!front").entry.message, "!front");
    assert.deepStrictEqual(createChatCommandHook({ chatRuntimeExports: {}, match: matchFrontCommand,
      handle: () => "x" }).install(), { ok: false, reason: "HOOK_SEAM_UNAVAILABLE" });
  });

  test("JC1 adapter chat registry: two commands, each its line, the rest to the original; uninstall one keeps other",
    () => {
      const { createAdapter } = require("../../lib/adapter");
      const { matchJobsCommand } = require("../../lib/frontJobs/chat");
      const SRC = path.join(MOD_DIR, "test", "_fakeSrc");
      const calls = [];
      const runtime = fakeRuntime(calls);
      const aud = runtime.broadcastLocalMessage;
      const adapter = createAdapter({ moduleApi: { _cache: {
        [path.join(SRC, "_secondary/chat/chatRuntime.js")]: { exports: runtime } } } });
      assert.deepStrictEqual(adapter.setServerSrc(SRC), { ok: true, reason: null });
      const session = { characterID: 90000001, characterName: "Pilot", solarsystemid2: 30000142, stationid: 60003760 };
      const reply = (text) => {
        try {
          return runtime.broadcastLocalMessage(session, text);
        } catch (err) {
          return `ERR:${err.message}`;
        }
      };
      assert.deepStrictEqual(adapter.installChatCommand({ match: matchFrontCommand, handle: () => "front reply" }),
        { ok: true });
      const wrapper = runtime.broadcastLocalMessage;
      assert.deepStrictEqual(adapter.installChatCommand({ name: "jobs", match: matchJobsCommand,
        handle: (rec) => `jobs of ${rec.characterId}` }), { ok: true });
      assert.strictEqual(runtime.broadcastLocalMessage, wrapper, "one wrapper for both");
      assert.deepStrictEqual(adapter.installChatCommand({ name: "jobs", match: matchJobsCommand, handle: () => "x" }),
        { ok: false, reason: "HOOK_ALREADY_INSTALLED" });
      assert.deepStrictEqual(adapter.installChatCommand({ match: matchFrontCommand, handle: () => "x" }),
        { ok: false, reason: "HOOK_ALREADY_INSTALLED" }, "no name = front");
      assert.deepStrictEqual([reply(" !front "), reply("!Zlecenia"), reply("!JOBS all"), reply("hello").entry.message],
        ["ERR:front reply", "ERR:jobs of 90000001", "ERR:jobs of 90000001", "hello"]);
      assert.deepStrictEqual(calls.map((c) => c.message), ["hello"], "only plain text reaches the original");
      adapter.uninstallChatCommand();
      assert.deepStrictEqual([reply("!front").entry.message, reply("!jobs")], ["!front", "ERR:jobs of 90000001"]);
      adapter.uninstallChatCommand("jobs");
      assert.strictEqual(runtime.broadcastLocalMessage, aud, "the last uninstall removes the wrapper");
    });

  test("CC2 vendor facts: xmpp local send catches the throw and answers error.message; front is not an AUD name",
    () => {
      const xmpp = readSource(path.join(SERVER_SRC, "services", "chat", "xmppStubServer.js"));
      const send = /try \{\n\s*if \(descriptor\.kind === "local"\) \{\n\s*sendResult = chatRuntime\.broadcastLocalMessage\(session, body\);[\s\S]{0,200}?\} catch \(error\) \{\n\s*sendSystemMessageToClient\(\n\s*client,\n\s*roomJid,\n\s*formatChannelAccessError\(error, "speak"\),\n\s*\);\n\s*return;/;
      assert.ok(send.test(xmpp), "catch around chatRuntime.broadcastLocalMessage(session, body)");
      const format = bodyOf(xmpp, "formatChannelAccessError");
      assert.ok(/return error && error\.message \? error\.message : "Channel error\.";\n\}\s*$/.test(format.trimEnd()
        + "\n"), format.slice(-200));
      assert.ok(format.includes("const code = error && error.code ? String(error.code) : \"\";"));
      if (!fs.existsSync(AUD_COMMAND)) return;
      const aud = readSource(AUD_COMMAND);
      for (const list of ["TRIGGER_NAMES", "LEGACY_NAMES"]) {
        const m = new RegExp(`const ${list} = Object\\.freeze\\(\\[([^\\]]*)\\]\\)`).exec(aud);
        assert.ok(m, `${list} found`);
        assert.ok(!/["']front["']/.test(m[1]), `${list} has no "front": ${m[1]}`);
      }
    });

  test("CC3 chat transport: ctx.transport by the vendor caller file (xmpp/gateway/lsc/unknown), other commands "
    + "unchanged; vendor facts: the three callers live in the files the hook looks for", () => {
    const runtime = fakeRuntime([]);
    const seen = [];
    const hook = createChatCommandHook({ chatRuntimeExports: runtime, match: matchFrontCommand,
      handle: (_rec, _text, ctx) => {
        seen.push(ctx.transport);
        return "front";
      } });
    assert.deepStrictEqual(hook.install(), { ok: true });
    const dir = path.join(SERVER_SRC, "fake");
    const viaFile = (file) => {
      const caller = vm.runInThisContext("(function vendorCaller(fn, s, m) { return fn(s, m); })",
        { filename: path.join(dir, file) });
      assert.throws(() => caller(runtime.broadcastLocalMessage, {}, "!front"), /^Error: front$/);
    };
    for (const file of ["xmppStubServer.js", "localChatGatewayService.js", "chatHub.js", "lscService.js",
      "xmppStubServerX.js"]) viaFile(file);
    assert.throws(() => runtime.broadcastLocalMessage({}, "!front"), /^Error: front$/);
    assert.deepStrictEqual(seen, ["xmpp", "gateway", "lsc", "lsc", "unknown", "unknown"]);
    hook.uninstall();
    assert.strictEqual(transportOfStack("Error\n    at a (/app/server/src/services/chat/chatHub.js:287:15)\n"
      + "    at b (/app/server/src/services/chat/xmppStubServer.js:2923:5)"), "lsc", "the first known frame wins");
    assert.strictEqual(transportOfStack(undefined), "unknown");

    const sources = {
      xmpp: path.join(SERVER_SRC, "services", "chat", "xmppStubServer.js"),
      gateway: path.join(SERVER_SRC, "_secondary", "express", "gatewayServices", "localChatGatewayService.js"),
      hub: path.join(SERVER_SRC, "services", "chat", "chatHub.js"),
      lsc: path.join(SERVER_SRC, "services", "chat", "lscService.js"),
    };
    assert.ok(readSource(sources.xmpp).includes("chatRuntime.broadcastLocalMessage(session, body)"));
    assert.ok(readSource(sources.gateway).includes("chatRuntime.broadcastLocalMessage(session, payload && payload.message)"));
    assert.ok(/function broadcastLocalMessage\(session, message\) \{\n\s*chatRuntime\.broadcastLocalMessage\(session, message\);/
      .test(readSource(sources.hub)));
    assert.ok(readSource(sources.lsc).includes("chatHub.broadcastLocalMessage(session, message)"));
    const callers = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith(".js") && /\.broadcastLocalMessage\(/.test(fs.readFileSync(full, "utf8"))) {
          callers.push(path.relative(SERVER_SRC, full).split(path.sep).join("/"));
        }
      }
    };
    walk(SERVER_SRC);
    assert.deepStrictEqual(callers.sort(), ["_secondary/express/gatewayServices/localChatGatewayService.js",
      "services/chat/chatHub.js", "services/chat/lscService.js", "services/chat/xmppStubServer.js"]);
  });
};
