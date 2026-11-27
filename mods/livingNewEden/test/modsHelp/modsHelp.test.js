"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { mask } = require("../_support/sourceScan");
const config = require("../../config");
const modsHelp = require("../../lib/modsHelp");
const { CATALOG } = require("../../lib/modsHelp/catalog");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const MODS_DIR = path.resolve(MOD_DIR, "..");
const LIB = path.join(MOD_DIR, "lib");
const AUD_DIR_RE = /^EveJS-AdvancedUtilityDrones-/;

function readSource(file) {
  return fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
}

function settings(overrides = {}) {
  return { modsHelp: { enabled: true, cooldownMs: 5000, maxReplyChars: 1000, ...overrides },
    frontChat: { maxRepliesPerMinute: 30, maxTrackedCharacters: 1024, lineBreak: "<br>" } };
}

function fakeAdapter(registered, dirs) {
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
    },
    listChatCommands: () => Object.freeze([...registered]),
    listLoadedModDirs: () => ({ ok: true, dirs }) };
}

function start(registered, dirs, over, now = { t: 1000000 }) {
  const adapter = fakeAdapter(registered, dirs);
  const r = modsHelp.startModsHelp({ config: settings(over), adapter, clock: { now: () => now.t } });
  return { r, adapter, now };
}

function libFiles(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) libFiles(full, out);
    else if (ent.name.endsWith(".js")) out.push(full);
  }
  return out;
}

module.exports = ({ test }) => {
  test("MDH1 !mods: short list with off / GM marks and CLI line, hidden external mods, one mod, unknown mod", () => {
    const rec = { characterId: 90000001, systemId: 30000142 };
    const all = ["shipWing", "EveJS-AdvancedUtilityDrones-1.0.3", "livingNewEden"];
    const { r, adapter } = start(["front", "mods"], all);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(adapter.installs.length, 1);
    assert.strictEqual(adapter.installs[0].name, modsHelp.COMMAND_NAME);
    assert.strictEqual(adapter.installs[0].match("!MODS aud"), true);
    assert.strictEqual(adapter.installs[0].match("!modsy"), false);
    const text = r.modsHelp.handle(rec, "!mods");
    const lines = text.split("<br>");
    assert.strictEqual(lines[0], "Mod commands (type in Local):");
    assert.ok(lines.includes("[LNE] !front - war state of this system and its region"), text);
    assert.ok(lines.some((l) => l.startsWith("[LNE] !zlecenia") && l.endsWith(" (off)")), text);
    assert.ok(lines.some((l) => l.startsWith("[Wing] !wing")), text);
    assert.ok(lines.some((l) => l.startsWith("[AUD] !aud")), text);
    assert.ok(lines.some((l) => l.startsWith("[GM] [AUD] /aud")), text);
    assert.strictEqual(lines[lines.length - 1],
      "CLI tools: mods/livingNewEden/README.md, section \"Operator tools\"");
    assert.ok(text.length <= 1000 && !text.includes("for more"), String(text.length));

    const lneOnly = start(["front", "jobs", "war", "board", "map", "settings", "npcvoices", "ai", "news", "trigbridge",
      "dev", "invest", "relic", "season", "mods"],
      ["livingNewEden"]).r.modsHelp.handle(rec, "!mods");
    assert.ok(!/!wing|!aud/.test(lneOnly), lneOnly);
    assert.ok(!lneOnly.includes("(off)"), lneOnly);
    const aud = start(["mods"], all).r.modsHelp.handle(rec, "!mods AUD");
    const audLines = aud.split("<br>").slice(1, -2);
    assert.ok(audLines.length >= 5 && audLines.every((l) => /^(\[GM\] )?\[AUD\] [!/]aud/.test(l)), aud);
    const wing = start(["mods"], all).r.modsHelp.handle(rec, "!mods wing");
    const cargoUsages = ["!wing store [name|off]", "!wing cargo [name|host]", "!wing move <from> to <to|host> [type]"];
    for (const usage of cargoUsages) assert.ok(wing.includes(usage), `${usage} in ${wing}`);
    assert.strictEqual(start(["mods"], all).r.modsHelp.handle(rec, "!mods xyz"),
      "Unknown mod xyz. Mods: lne, wing, aud.");
    const rows = require("../../lib/modsHelp/catalog").resolveCatalog({ registered: [], loadedDirs: null });
    const page = (p, filter) => modsHelp.formatModsReply(rows, { lineBreak: "<br>", maxReplyChars: 200, page: p,
      filter });
    const full = modsHelp.formatModsReply(rows, { lineBreak: "<br>", maxReplyChars: 100000 }).split("<br>");
    const pages = [];
    for (let p = 1; !page(p).startsWith("LNE mods: no page"); p += 1) pages.push(page(p));
    assert.ok(pages.length >= 2, String(pages.length));
    const joined = pages.flatMap((t, i) => {
      assert.ok(t.length <= 200, t);
      const ls = t.split("<br>");
      if (i > 0) assert.strictEqual(ls.shift(), `Mod commands, page ${i + 1}:`);
      if (i < pages.length - 1) assert.strictEqual(ls.pop(), `... !mods ${i + 2} for more`);
      return ls;
    });
    assert.deepStrictEqual(joined, full, "pages = the whole list, texts not shortened");
    assert.strictEqual(page(pages.length + 1), `LNE mods: no page ${pages.length + 1} of !mods (${pages.length} pages)`);
    assert.ok(page(1, "lne").endsWith("... !mods lne 2 for more"), page(1, "lne"));
    const small = start(["mods"], all, { maxReplyChars: 200 }).r.modsHelp;
    assert.strictEqual(small.handle(rec, "!mods 2"), small.handle({ characterId: 90000002 }, "!mods 2"));
    assert.ok(small.handle({ characterId: 90000003 }, "!mods 2").startsWith("Mod commands, page 2:"));
    assert.ok(small.handle({ characterId: 90000004 }, "!mods aud 2").startsWith("Mod commands, page 2:"));
    assert.strictEqual(start(["mods"], all).r.modsHelp.handle(rec, "!mods 2"),
      "LNE mods: no page 2 of !mods (1 page)", "the current list is one page");
  });

  test("MDH2 !mods: cooldown per character; flag off = no registration; defaults and W50", () => {
    const { r, now } = start(["mods"], []);
    const rec = { characterId: 90000001 };
    assert.ok(r.modsHelp.handle(rec, "!mods").startsWith("Mod commands"));
    assert.match(r.modsHelp.handle(rec, "!mods"), /^LNE mods: wait 5s before the next !mods$/);
    assert.ok(r.modsHelp.handle({ characterId: 90000002 }, "!mods").startsWith("Mod commands"), "another pilot");
    assert.ok(r.modsHelp.handle(null, "!mods").startsWith("Mod commands"), "no character: no cooldown");
    now.t += 5000;
    assert.ok(r.modsHelp.handle(rec, "!mods").startsWith("Mod commands"), "after the cooldown");
    assert.deepStrictEqual(r.modsHelp.getStatus(), { state: "running", replies: 4, rateLimited: 1, errors: 0,
      loadedMods: 0, tracked: 1 }, "entries older than the cooldown pruned");
    r.modsHelp.stop("test");
    assert.strictEqual(r.modsHelp.handle(rec, "!mods"), "LNE: !mods unavailable (STOPPED)");

    const off = start(["mods"], [], { enabled: false });
    assert.deepStrictEqual(off.r, { ok: false, reason: "disabled_by_config" });
    assert.strictEqual(off.adapter.installs.length, 0);

    const resolve = (env) => config.resolveConfig({ modDir: MOD_DIR, env });
    const def = resolve({});
    assert.deepStrictEqual(def.config.modsHelp, { enabled: true, cooldownMs: 5000, maxReplyChars: 1000 });
    const W = (x) => x.warnings.filter((w) => w.startsWith("modsHelp."));
    assert.deepStrictEqual(W(def), []);
    assert.strictEqual(W(resolve({ EVEJS_LNE_WORLD_ENABLED: "0" })).length, 1, "W50");
  });

  test("MDH3 pin: every chat command of lib/** has a modsHelp catalog entry and back", () => {
    const frontChat = require("../../lib/frontChat");
    const jobsChat = require("../../lib/frontJobs/chat");
    const MAP = { "frontChat/index.js": "front", "frontJobs/index.js": jobsChat.COMMAND_NAME,
      "modsHelp/index.js": modsHelp.COMMAND_NAME, "inGameMap/index.js": require("../../lib/inGameMap").COMMAND_NAME,
      "modSettings/web/index.js": require("../../lib/modSettings/web").COMMAND_NAME,
      "npcVoices/index.js": require("../../lib/npcVoices").COMMAND_NAME,
      "shipAi/index.js": require("../../lib/shipAi").COMMAND_NAME,
      "news/command.js": require("../../lib/news/command").COMMAND_NAME,
      "warContracts/index.js": require("../../lib/warContracts/chat").COMMAND_NAME,
      "jobBoard/index.js": require("../../lib/jobBoard/chat").COMMAND_NAME,
      "trigBridge/index.js": require("../../lib/trigBridge").COMMAND_NAME,
      "world/devIndices/command.js": require("../../lib/world/devIndices/command").COMMAND_NAME,
      "world/devIndices/investCommand.js": require("../../lib/world/devIndices/investCommand").COMMAND_NAME,
      "archaeology/command.js": require("../../lib/archaeology/command").COMMAND_NAME,
      "seasons/command.js": require("../../lib/seasons/command").COMMAND_NAME };
    const found = libFiles(LIB)
      .map((f) => path.relative(LIB, f).replace(/\\/g, "/"))
      .filter((rel) => !rel.startsWith("adapter/"))
      .filter((rel) => /\binstallChatCommand\s*\(/.test(mask(fs.readFileSync(path.join(LIB, rel), "utf8"))));
    for (const rel of found) {
      assert.ok(Object.hasOwn(MAP, rel), `${rel}: new chat command without a modsHelp catalog entry`);
    }
    assert.deepStrictEqual(found.sort(), Object.keys(MAP).sort(), "every mapped file still installs a command");
    const lneNames = CATALOG.filter((e) => e.owner === "lne").map((e) => e.registryName).sort();
    assert.deepStrictEqual(lneNames, Object.values(MAP).sort());
    const firstUsage = (name) => CATALOG.find((e) => e.registryName === name).lines[0].usage.split(" (")[0]
      .replace(/ \[.*$/, "");
    assert.strictEqual(frontChat.COMMAND_RE.test(firstUsage("front")), true);
    assert.strictEqual(jobsChat.COMMAND_RE.test(firstUsage(jobsChat.COMMAND_NAME)), true);
    assert.strictEqual(jobsChat.COMMAND_RE.test("!jobs"), true, "alias of the usage");
    assert.strictEqual(modsHelp.COMMAND_RE.test(firstUsage("mods")), true);
    assert.strictEqual(require("../../lib/inGameMap/chat").COMMAND_RE.test(firstUsage("map")), true);
    assert.strictEqual(require("../../lib/modSettings/web/chat").COMMAND_RE.test(firstUsage("settings")), true);
    assert.strictEqual(require("../../lib/npcVoices").COMMAND_RE.test(firstUsage("npcvoices")), true);
    assert.strictEqual(require("../../lib/shipAi").COMMAND_RE.test(firstUsage("ai")), true);
    assert.strictEqual(require("../../lib/news/command").COMMAND_RE.test(firstUsage("news")), true);
    assert.strictEqual(require("../../lib/trigBridge").COMMAND_RE.test("!trigbridge status"), true);
    assert.strictEqual(require("../../lib/world/devIndices/command").COMMAND_RE.test(firstUsage("dev")), true);
    assert.strictEqual(require("../../lib/world/devIndices/investCommand").COMMAND_RE.test(firstUsage("invest")), true);
    assert.strictEqual(require("../../lib/archaeology/command").COMMAND_RE.test(firstUsage("relic")), true);
    assert.strictEqual(require("../../lib/archaeology/command").COMMAND_RE.test("!relikt"), true, "alias");
    assert.strictEqual(require("../../lib/seasons/command").COMMAND_RE.test(firstUsage("season")), true);
    const warChat = require("../../lib/warContracts/chat");
    assert.strictEqual(warChat.COMMAND_RE.test(firstUsage(warChat.COMMAND_NAME)), true);
    assert.strictEqual(warChat.COMMAND_RE.test("!war"), true, "alias of the usage");
    assert.ok(CATALOG.some((e) => e.lines.some((l) => l.usage === "!kontrakty (alias !war)")));
  });

  test("MDH4 external mod facts: shipWing trigger, AUD trigger name and root help line (skip when absent)", () => {
    const wing = path.join(MODS_DIR, "shipWing", "config.js");
    if (fs.existsSync(wing)) {
      assert.ok(readSource(wing).includes("row(\"chatTrigger\", \"trigger\", \"!wing\")"),
        "shipWing: chatTrigger default changed - update lib/modsHelp/catalog.js");
    }
    const audDir = fs.existsSync(MODS_DIR) ? fs.readdirSync(MODS_DIR).find((d) => AUD_DIR_RE.test(d)) : null;
    const audFile = audDir ? path.join(MODS_DIR, audDir, "lib", "chatCommand.js") : null;
    if (audFile && fs.existsSync(audFile)) {
      const src = readSource(audFile);
      assert.ok(src.includes("TRIGGER_NAMES = Object.freeze([\"aud\"])"),
        "AdvancedUtilityDrones: trigger name changed - update lib/modsHelp/catalog.js");
      const root = /const ROOT_HELP_LINES = Object\.freeze\(\[([\s\S]*?)\]\);/.exec(src);
      assert.ok(root && root[1].includes("\"/aud mi [command]\""),
        "AdvancedUtilityDrones: ROOT_HELP_LINES changed - update lib/modsHelp/catalog.js");
    }
  });

  test("MDH5 adapter: listChatCommands, dispatch passes the text, listLoadedModDirs Windows / Docker / unreadable",
    () => {
      const { createAdapter } = require("../../lib/adapter");
      const SRC = path.join(MOD_DIR, "test", "_fakeSrc");
      const runtime = { broadcastLocalMessage: (session, message) => ({ entry: { message } }) };
      const adapter = createAdapter({ moduleApi: { _cache: {
        [path.join(SRC, "_secondary/chat/chatRuntime.js")]: { exports: runtime } } } });
      assert.deepStrictEqual(adapter.setServerSrc(SRC), { ok: true, reason: null });
      assert.deepStrictEqual(adapter.listChatCommands(), []);
      const seen = [];
      adapter.installChatCommand({ match: (t) => /^!front$/.test(t), handle: () => "f" });
      adapter.installChatCommand({ name: "mods", match: modsHelp.matchModsCommand,
        handle: (rec, text) => {
          seen.push(text);
          return `mods ${text}`;
        } });
      assert.deepStrictEqual(adapter.listChatCommands(), ["front", "mods"]);
      const session = { characterID: 90000001, characterName: "Pilot", solarsystemid2: 30000142 };
      assert.throws(() => runtime.broadcastLocalMessage(session, "  !mods wing "), /^Error: mods !mods wing$/);
      assert.deepStrictEqual(seen, ["!mods wing"]);
      adapter.uninstallChatCommand();
      assert.deepStrictEqual(adapter.listChatCommands(), ["mods"]);
      adapter.uninstallChatCommand("mods");
      assert.deepStrictEqual(adapter.listChatCommands(), []);

      const cache = { "C:\\EveJS\\mods\\shipWing\\loader.js": {}, "/app/mods/x/loader.js": {},
        "/app/mods/x/lib/loader.js": {}, "C:\\EveJS\\server\\src\\loader.js": {}, "/app/mods/a/loader.js": {} };
      assert.deepStrictEqual(adapter.listLoadedModDirs(cache), { ok: true, dirs: ["a", "shipWing", "x"] });
      assert.strictEqual(adapter.listLoadedModDirs(null).reason, "CACHE_UNREADABLE");
      const broken = new Proxy({}, { ownKeys() {
        throw new Error("no keys");
      } });
      assert.deepStrictEqual(adapter.listLoadedModDirs(broken), { ok: false, reason: "CACHE_UNREADABLE",
        detail: "no keys" });
      assert.strictEqual(adapter.listLoadedModDirs().ok, true, "default: require.cache");
    });
};
