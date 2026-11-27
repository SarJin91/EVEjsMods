"use strict";

const assert = require("node:assert");
const { createChatHook, installChatFromGame, WRAPPED } = require("../../lib/adapter/chatHook");

function chatRuntimeFixture() {
  const sent = [];
  const runtime = {
    sent,
    broadcastLocalMessage(session, message) {
      sent.push([session, message]);
      return { self: this, delivered: message };
    },
  };
  return runtime;
}

function thrown(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return assert.fail("expected a throw");
}

function foreignWrap(runtime, trigger, mark) {
  const found = runtime.broadcastLocalMessage;
  const wrapped = function foreignChat(session, message) {
    if (String(message).trim().startsWith(trigger)) throw new Error(`${trigger} reply`);
    return found.apply(this, arguments);
  };
  wrapped[mark] = true;
  runtime.broadcastLocalMessage = wrapped;
}

module.exports = ({ test }) => {
  test("CHK1 !wing -> throw with the reply (no code), other lines -> original with same this/args/result", () => {
    const runtime = chatRuntimeFixture();
    const seen = [];
    const hook = createChatHook({ chatRuntimeExports: runtime, match: (t) => t.trim().startsWith("!wing"),
      handle: (session, text) => {
        seen.push([session, text]);
        return "Ship Wing: ok";
      } });
    assert.deepStrictEqual(hook.install(), { ok: true });
    assert.deepStrictEqual(hook.install(), { ok: false, reason: "HOOK_ALREADY_INSTALLED" });
    const session = { characterID: 90000001 };
    const err = thrown(() => runtime.broadcastLocalMessage(session, "!wing status"));
    assert.strictEqual(err.message, "Ship Wing: ok");
    assert.strictEqual(err.code, undefined);
    assert.deepStrictEqual(seen, [[session, "!wing status"]]);
    assert.deepStrictEqual(runtime.sent, [], "a command line is never broadcast");
    const result = runtime.broadcastLocalMessage(session, "o7");
    assert.strictEqual(result.self, runtime);
    assert.deepStrictEqual(runtime.sent, [[session, "o7"]]);
    const failing = chatRuntimeFixture();
    createChatHook({ chatRuntimeExports: failing, match: () => true, handle: () => {
      throw new Error("bug");
    } }).install();
    assert.match(thrown(() => failing.broadcastLocalMessage({}, "!wing")).message, /command failed/);
    hook.uninstall();
    assert.strictEqual(runtime.broadcastLocalMessage[WRAPPED], undefined, "uninstall restores the original");
  });

  test("CHK2 chained with AUD-like (inner) and LNE-like (outer) wraps: each trigger reaches its own handler", () => {
    const runtime = chatRuntimeFixture();
    const audMark = Symbol.for("test.aud");
    foreignWrap(runtime, "!aud", audMark);
    const hook = createChatHook({ chatRuntimeExports: runtime, match: (t) => t.trim().startsWith("!wing"),
      handle: () => "wing reply" });
    hook.install();
    assert.strictEqual(runtime.broadcastLocalMessage[audMark], true, "foreign mark kept");
    foreignWrap(runtime, "/lne", Symbol.for("test.lne"));
    assert.strictEqual(thrown(() => runtime.broadcastLocalMessage({}, "!wing status")).message, "wing reply");
    assert.strictEqual(thrown(() => runtime.broadcastLocalMessage({}, "!aud status")).message, "!aud reply");
    assert.strictEqual(thrown(() => runtime.broadcastLocalMessage({}, "/lne front")).message, "/lne reply");
    assert.strictEqual(runtime.broadcastLocalMessage({}, "hello").delivered, "hello");
    hook.uninstall();
    assert.strictEqual(runtime.broadcastLocalMessage({}, "!wing status").delivered, "!wing status",
      "after uninstall under an outer wrap: pass-through");
    const adapter = { isConsumerAvailable: (c) => c !== "chat", requireGame: () => assert.fail("no require") };
    assert.deepStrictEqual(installChatFromGame(adapter, {}), { ok: false, reason: "probe_chat_unavailable" });
  });
};
