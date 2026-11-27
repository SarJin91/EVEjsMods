"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const { startModSettings } = require("../../lib/modSettings");
const { auditPathOf } = require("../../lib/modSettings/audit");
const { createRegistry } = require("../../lib/telemetry/registry");
const { createHttpRoutes } = require("../../lib/observer/httpRoutes");
const { parseSettingsCommand, formatFindReply, HELP } = require("../../lib/modSettings/web/chatCommands");
const { parseValueText } = require("../../lib/modSettings/providers/rowKit");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const PILOT = 90000001;
const BASE = resolveConfig({ env: {}, settings: {}, envFile: {}, modDir: MOD_DIR }).config;

function withDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lne-modsettings-chat-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function started(dir, modSettings = {}) {
  const now = { t: 1700000000000 };
  const lneDir = path.join(dir, "mods", "livingNewEden");
  const config = { ...BASE, dataDir: lneDir, observer: { ...BASE.observer, enabled: true },
    modSettings: { ...BASE.modSettings, enabled: true, mods: "livingNewEden", allowedCharacterIds: `${PILOT}`,
      ...modSettings } };
  const registry = createRegistry({ histogramSamples: 8, maxMetrics: 64 });
  const installs = [];
  const adapter = { listLoadedModDirs: () => ({ ok: true, dirs: ["livingNewEden"] }),
    loadModConfig: () => ({ ok: false, reason: "CONFIG_MISSING" }),
    installChatCommand: (opts) => { installs.push(opts); return { ok: true }; },
    uninstallChatCommand: () => ({ ok: true }) };
  const r = startModSettings({ config, adapter, env: { EVEJS_DATA_ROOT: dir }, modDir: MOD_DIR,
    clock: { now: () => now.t }, telemetry: registry, logger: { log() {} }, httpRoutes: createHttpRoutes() });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  const chat = installs[0];
  const say = (text, ctx = { transport: "gateway" }, characterId = PILOT) => {
    now.t += config.modSettings.cooldownMs + 1;
    return chat.handle({ characterId, name: "Pilot One" }, text, ctx);
  };
  return { ms: r.modSettings, chat, say, now, lneDir, registry, config };
}

module.exports = ({ test }) => {
  test("MSC1 parser: subcommands, alias of !mods, value = rest of the line, help; value text of the row types", () => {
    const P = (cmd, mod = null, key = null, value = null) => ({ cmd, mod, key, value });
    const table = [
      [undefined, P("link")],
      ["!settings", P("link")],
      ["! Settings  ", P("link")],
      ["!settings get lne observer.port", P("get", "livingNewEden", "observer.port")],
      ["!settings GET wing chatTrigger", P("get", "shipWing", "chatTrigger")],
      ["!settings get someMod a.b", P("get", "someMod", "a.b")],
      ["!settings set lne frontChat.lineBreak  <br> x ", P("set", "livingNewEden", "frontChat.lineBreak", "<br> x")],
      ["!settings reset LNE observer.journalLimit", P("reset", "livingNewEden", "observer.journalLimit")],
      ["!settings find lne journal limit", P("find", "livingNewEden", "journal limit")],
      ["!settings find lne", P("help")],
      ["!settings get lne", P("help")],
      ["!settings get lne a extra", P("help")],
      ["!settings set lne a", P("help")],
      ["!settings reset lne a b", P("help")],
      ["!settings frobnicate lne a", P("help")],
      ["!settings help", P("help")],
    ];
    for (const [text, want] of table) assert.deepStrictEqual(parseSettingsCommand(text), want, String(text));
    const V = [
      ["boolean", "1", true], ["boolean", "FALSE", false], ["boolean", "yes", null], ["integer", " 60 ", 60],
      ["number", "-1.5e2", -150], ["integer", "6x", null], ["integer", "", null], ["string", "  a b ", "a b"],
      ["enum", "x", "x"],
    ];
    for (const [type, text, want] of V) {
      const r = parseValueText(type, text);
      assert.deepStrictEqual(r, want === null ? { ok: false, reason: "BAD_TYPE" } : { ok: true, value: want },
        `${type} ${text}`);
    }
  });

  test("MSC2 get / find: next, running, source, default, range; secret *** + locked; <= 10 keys + more; "
    + "maxReplyChars; escaped", () => withDir((dir) => {
    const p = started(dir);
    assert.strictEqual(p.say("!settings get lne observer.journalLimit"),
      "observer.journalLimit = 50 (running 50, source default, default 50, range 1-200)");
    const secret = p.say("!settings get lne chatterAi.baseUrl");
    assert.strictEqual(secret, "chatterAi.baseUrl = *** (running ***, source default, default ***, locked SECRET)");
    assert.match(p.say("!settings get lne observer.port"), /, locked BOOT_CRITICAL\)$/);
    assert.strictEqual(p.say("!settings get lne no.such"), "LNE settings: no key livingNewEden no.such (try !settings find)");
    assert.strictEqual(p.say("!settings get aud x"), "LNE settings: mod EveJS-AdvancedUtilityDrones is not in modSettings.mods");
    assert.strictEqual(p.say("!settings help"), HELP);

    const found = p.say("!settings find lne observer").split(BASE.frontChat.lineBreak);
    const total = Number(/^livingNewEden: (\d+) keys match "observer"$/.exec(found[0])[1]);
    assert.ok(total > 10, found[0]);
    assert.strictEqual(found.length, 12, "head + 10 keys + more");
    assert.strictEqual(found[11], `... ${total - 10} more`);
    assert.ok(found.slice(1, 11).every((l) => / = /.test(l)), found.join("\n"));
    assert.strictEqual(p.say("!settings find lne <zz>"), "livingNewEden: no key matches \"&lt;zz&gt;\"");

    const short = started(path.join(dir, "short"), { maxReplyChars: 200 });
    const cut = short.say("!settings find lne observer");
    assert.ok(cut.length <= 200, String(cut.length));
    assert.match(cut, /\.\.\. \d+ more$/);
    const page = { modId: "m", total: 1, rows: [{ key: "a<b>", next: "x&y" }] };
    assert.strictEqual(formatFindReply(page, "a", { maxReplyChars: 1000, lineBreak: "<br>" }),
      "m: 1 keys match \"a\"<br>a&lt;b&gt; = x&amp;y");
  }));

  test("MSC3 set / reset into the writer: ok + audit channel chat, refusals without the value, allowlist, cooldown, "
    + "no token on any transport", () => withDir((dir) => {
    const p = started(dir);
    assert.strictEqual(p.say("!settings set lne observer.journalLimit 60"), "observer.journalLimit: ok (restart needed)");
    assert.strictEqual(p.say("!settings set lne observer.journalLimit 60", { transport: "xmpp" }),
      "observer.journalLimit: ok (restart needed), no change");
    assert.strictEqual(p.say("!settings get lne observer.journalLimit"),
      "observer.journalLimit = 60 (running 50, source override, default 50, range 1-200)");
    assert.strictEqual(p.say("!settings set lne observer.journalLimit 500"), "observer.journalLimit: refused: OUT_OF_RANGE");
    assert.strictEqual(p.say("!settings set lne observer.journalLimit lots"), "observer.journalLimit: refused: BAD_TYPE");
    const locked = p.say("!settings set lne chatterAi.baseUrl http://evil.example/v1");
    assert.strictEqual(locked, "chatterAi.baseUrl: refused: LOCKED (SECRET)");
    assert.ok(!locked.includes("evil"), "the value is never echoed");
    assert.strictEqual(p.say("!settings set lne no.such 1"), "no.such: refused: UNKNOWN_KEY");
    assert.strictEqual(p.say("!settings reset lne observer.journalLimit", undefined),
      "observer.journalLimit: ok (restart needed)");
    const audit = fs.readFileSync(auditPathOf(p.lneDir), "utf8").trim().split("\n").map(JSON.parse);
    assert.deepStrictEqual(audit.map((a) => [a.characterId, a.channel, a.action, a.revision]),
      [[PILOT, "chat", "set", 1], [PILOT, "chat", "reset", 2]]);

    assert.strictEqual(p.say("!settings set lne observer.journalLimit 70", undefined, 42), "LNE settings: not allowed");
    assert.strictEqual(p.registry.counter("modSettings.denied"), 1);
    assert.strictEqual(p.chat.handle({ characterId: PILOT }, "!settings get lne observer.journalLimit", {}),
      "observer.journalLimit = 50 (running 50, source default, default 50, range 1-200)", "cooldown passed by say");
    assert.match(p.chat.handle({ characterId: PILOT }, "!settings get lne observer.journalLimit", {}),
      /^LNE settings: wait \d+ s before the next !settings$/);
    assert.strictEqual(p.chat.handle({ characterId: PILOT }, "!settings x", {}), HELP, "help needs no cooldown");
    assert.deepStrictEqual([p.ms.getStatus().web.issued, p.registry.counter("modSettings.links")], [0, 0],
      "no token was issued by a subcommand");
    p.ms.stop("test");
    assert.strictEqual(p.chat.handle({ characterId: PILOT }, "!settings get lne a", {}),
      "LNE settings unavailable (STOPPED)");
  }));
};
