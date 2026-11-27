"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const localPilots = require("../../lib/adapter/localPilots");
const { GAME_MODULES } = require("../../lib/adapter/gameModules");
const loader = require("../../loader");

const SERVER_SRC = path.resolve(__dirname, "..", "..", "..", "..", "server", "src");
const SYSTEM = 30000142;
const EVENT = "local-membership-list";

function readSource(rel) {
  return fs.readFileSync(path.join(SERVER_SRC, rel), "utf8").replace(/\r\n/g, "\n");
}

function functionBody(source, name) {
  const start = source.indexOf(`\nfunction ${name}(`);
  assert.ok(start >= 0, `function ${name} not found`);
  const next = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

function exportBlock(source) {
  const start = source.search(/^module\.exports = \{/m);
  assert.ok(start >= 0, "module.exports block");
  const rest = source.slice(start);
  return rest.slice(0, rest.search(/^\};/m));
}

function listJs(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJs(full));
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

function member(id, corp = 1000001, alliance = 0) {
  return { character: { sequential: id }, corporation: { sequential: corp },
    alliance: alliance > 0 ? { sequential: alliance } : null, no_alliance: alliance <= 0, faction: null,
    no_faction: true, classification: "CLASSIFICATION_UNSPECIFIED" };
}

function fakeChatRuntime(membersOf) {
  const emitter = new EventEmitter();
  const published = [];
  const exportsObj = {
    on: emitter.on.bind(emitter),
    publishLocalMembershipListForSession(session) {
      published.push(session);
      if (session && session.boom) throw new Error("publish boom");
      const payload = { roomName: `local_${session.solarSystemID}`, solarSystemID: session.solarSystemID,
        members: membersOf(session) };
      emitter.emit(EVENT, { targetCharacterID: session.characterID, roomName: payload.roomName,
        solarSystemID: payload.solarSystemID, members: payload.members });
      return payload;
    },
  };
  return { emitter, exportsObj, published };
}

function seamOver(modules) {
  return localPilots.createLocalPilotsSeam({
    requireGame: (rel) => (modules[rel] ? { ok: true, exports: modules[rel] } : { ok: false, reason: "not_booted" }),
  });
}

module.exports = ({ test }) => {
  test("LPL1 vendor facts: chatRuntime on/publish share members, gateway listener in bindRuntimeNotices, "
    + "channelRules exports, nobody destructures the four chatRuntime symbols; GAME_MODULES entries", () => {
    const chat = readSource("_secondary/chat/chatRuntime.js");
    assert.ok(chat.includes("  on: runtimeEmitter.on.bind(runtimeEmitter),"), "on export bound to the emitter");
    assert.ok(!/prependListener/.test(exportBlock(chat)), "no prependListener exported");
    const publish = functionBody(chat, "publishLocalMembershipListForSession");
    assert.ok(publish.includes(`runtimeEmitter.emit("${EVENT}", {`), "emit");
    assert.ok(publish.includes("members: payload.members,") && publish.includes("return payload;"), publish);
    const block = exportBlock(chat);
    for (const n of ["buildLocalGatewayMember", "getLocalSessionsForRoom", "publishLocalMembershipListForSession"]) {
      assert.match(block, new RegExp(`^ {2}${n},$`, "m"), n);
    }
    const gateway = readSource("_secondary/express/gatewayServices/localChatGatewayService.js");
    assert.ok(functionBody(gateway, "bindRuntimeNotices").includes(`chatRuntime.on("${EVENT}"`), "gateway listener");
    assert.ok(functionBody(gateway, "createLocalChatGatewayService").includes("bindRuntimeNotices(context)"));
    const rules = exportBlock(readSource("services/chat/channelRules.js"));
    for (const n of ["getLocalChatRoomNameForSolarSystemID", "isDelayedLocalChatRoomName"]) {
      assert.match(rules, new RegExp(`^ {2}${n},$`, "m"), n);
    }
    const destructure = /\{\s*(on|publishLocalMembershipListForSession|getLocalSessionsForRoom|buildLocalGatewayMember)\b/;
    const offenders = [];
    for (const dir of ["_secondary", "services"]) {
      for (const file of listJs(path.join(SERVER_SRC, dir))) {
        const text = fs.readFileSync(file, "utf8");
        if (!text.includes("chatRuntime")) continue;
        if (destructure.test(text)) offenders.push(path.relative(SERVER_SRC, file));
      }
    }
    assert.deepStrictEqual(offenders, [], "a chatRuntime consumer destructures a Local pilots symbol");

    const consumersOf = (p, name) => GAME_MODULES.filter((e) => e.path === p)
      .flatMap((e) => e.symbols.filter((s) => s.name === name && s.consumers.includes("localPilots")));
    const on = consumersOf("_secondary/chat/chatRuntime", "on");
    assert.strictEqual(on.length, 1);
    assert.deepStrictEqual([on[0].firstLoad, on[0].wrap], [true, undefined], "first-load, not a wrap");
    for (const n of ["publishLocalMembershipListForSession", "getLocalSessionsForRoom", "buildLocalGatewayMember"]) {
      assert.strictEqual(consumersOf("_secondary/chat/chatRuntime", n).length, 1, n);
    }
    for (const n of ["getLocalChatRoomNameForSolarSystemID", "isDelayedLocalChatRoomName"]) {
      assert.strictEqual(consumersOf("services/chat/channelRules", n).length, 1, n);
    }
    assert.strictEqual(consumersOf("services/character/characterState", "peekCharacterRecord").length, 1);
    const loaderSource = fs.readFileSync(path.join(__dirname, "..", "..", "loader.js"), "utf8");
    assert.ok(loaderSource.includes("request.includes(\"chatRuntime\")"), "loader.js literal \"chatRuntime\"");
  });

  test("LPL2 augment: our listener first, pilots of the event system appended once (no duplicate), the gateway "
    + "and the returned payload see the same members; another system and an empty roster unchanged", () => {
    localPilots._resetForTest();
    try {
      const player = member(90000001);
      const p1 = member(91000001, 98000001, 99000001);
      const p2 = member(91000002, 98000001);
      const rt = fakeChatRuntime((s) => (s.solarSystemID === SYSTEM ? [player, p1] : [player]));
      assert.deepStrictEqual(localPilots.install(rt.exportsObj), { ok: true, alreadyInstalled: false });
      const seen = [];
      rt.exportsObj.on(EVENT, (event) => seen.push(event.members.map((m) => m.character.sequential)));
      assert.strictEqual(rt.emitter.listeners(EVENT)[0], localPilots.augmentMembershipEvent, "first listener");
      const seam = localPilots.createLocalPilotsSeam({ requireGame: () => ({ ok: false, reason: "x" }) });
      assert.deepStrictEqual(seam.setRoster(SYSTEM, [p1, p2]), { ok: true, size: 2 });

      const payload = rt.exportsObj.publishLocalMembershipListForSession({ characterID: 90000001, solarSystemID: SYSTEM });
      assert.deepStrictEqual(seen[0], [90000001, 91000001, 91000002], "the gateway sees the pilots, p1 once");
      assert.deepStrictEqual(payload.members.map((m) => m.character.sequential), [90000001, 91000001, 91000002]);
      rt.exportsObj.publishLocalMembershipListForSession({ characterID: 90000001, solarSystemID: 30000144 });
      assert.deepStrictEqual(seen[1], [90000001], "another system unchanged");
      assert.deepStrictEqual(seam.setRoster(SYSTEM, []), { ok: true, size: 0 });
      rt.exportsObj.publishLocalMembershipListForSession({ characterID: 90000001, solarSystemID: SYSTEM });
      assert.deepStrictEqual(seen[2], [90000001, 91000001], "empty roster -> vendor list");
      const st = seam.getState();
      assert.deepStrictEqual([st.installed, st.systems, st.pilots, st.appended, st.skippedDuplicates, st.augmentErrors],
        [true, 0, 0, 1, 1, 0]);
    } finally {
      localPilots._resetForTest();
    }
  });

  test("LPL3 robustness: bad event / bad members / a throwing roster entry never throw and count augmentErrors; "
    + "second install -> alreadyInstalled, one listener; setRoster before install -> NOT_INSTALLED", () => {
    localPilots._resetForTest();
    try {
      const seam = localPilots.createLocalPilotsSeam({ requireGame: () => ({ ok: false, reason: "x" }) });
      assert.deepStrictEqual(seam.setRoster(SYSTEM, [member(91000001)]), { ok: false, reason: "NOT_INSTALLED" });
      assert.deepStrictEqual(localPilots.install({}), { ok: false, reason: "NO_ON" });
      const rt = fakeChatRuntime(() => []);
      localPilots.install(rt.exportsObj);
      assert.deepStrictEqual(localPilots.install(rt.exportsObj), { ok: true, alreadyInstalled: true });
      assert.strictEqual(rt.emitter.listenerCount(EVENT), 1);
      assert.deepStrictEqual(seam.setRoster(0, []), { ok: false, reason: "BAD_SYSTEM" });
      assert.deepStrictEqual(seam.setRoster(SYSTEM, [{ character: {} }]), { ok: false, reason: "BAD_MEMBERS" });

      localPilots.augmentMembershipEvent(null);
      const bad = { members: "x" };
      localPilots.augmentMembershipEvent(bad);
      assert.strictEqual(bad.members, "x");
      let reads = 0;
      const tricky = { character: { get sequential() { reads += 1; if (reads > 1) throw new Error("getter"); return 91000009; } } };
      assert.deepStrictEqual(seam.setRoster(SYSTEM, [tricky]), { ok: true, size: 1 });
      const event = { solarSystemID: SYSTEM, members: [member(90000001)] };
      assert.doesNotThrow(() => localPilots.augmentMembershipEvent(event));
      assert.deepStrictEqual(event.members.map((m) => m.character.sequential), [90000001], "event unchanged");
      assert.strictEqual(seam.getState().augmentErrors, 3);
      assert.deepStrictEqual(seam.clearRosters(), { ok: true, systems: [SYSTEM] });
      assert.strictEqual(seam.getState().systems, 0);
    } finally {
      localPilots._resetForTest();
    }
  });

  test("LPL4 seam: repushSystem publishes per session (a throw -> failed:1), missing symbol -> SEAM_UNAVAILABLE; "
    + "isNormalLocal WH -> false; describeCharacter NO_RECORD / member with alliance; facade localPilotsSeams", () => {
    const sessions = [{ characterID: 1, solarSystemID: SYSTEM }, { characterID: 2, solarSystemID: SYSTEM, boom: true }];
    const rt = fakeChatRuntime(() => []);
    const rooms = [];
    const chatRuntime = { ...rt.exportsObj,
      getLocalSessionsForRoom: (roomName) => { rooms.push(roomName); return sessions; },
      buildLocalGatewayMember: (s) => member(s.characterID, s.corporationID, s.allianceID) };
    const channelRules = {
      getLocalChatRoomNameForSolarSystemID: (id) => (id >= 31000000 ? `wormhole_${id}` : `local_${id}`),
      isDelayedLocalChatRoomName: (name) => name.startsWith("wormhole_"),
    };
    const records = { 91000001: { corporationID: 98000001, allianceID: 99000001 }, 91000002: { corporationID: 0 } };
    const characterState = { peekCharacterRecord: (id) => records[id] || null };
    const seam = seamOver({ "_secondary/chat/chatRuntime": chatRuntime, "services/chat/channelRules": channelRules,
      "services/character/characterState": characterState });
    assert.deepStrictEqual(seam.repushSystem(SYSTEM), { ok: true, sessions: 2, failed: 1 });
    assert.deepStrictEqual([rooms, rt.published.length], [[`local_${SYSTEM}`], 2]);
    assert.deepStrictEqual(seam.repushSystem(-1), { ok: false, reason: "BAD_SYSTEM" });
    const noSessions = seamOver({ "_secondary/chat/chatRuntime": rt.exportsObj, "services/chat/channelRules": channelRules });
    assert.deepStrictEqual(noSessions.repushSystem(SYSTEM), { ok: false, reason: "SEAM_UNAVAILABLE",
      detail: "_secondary/chat/chatRuntime.getLocalSessionsForRoom" });
    assert.strictEqual(seamOver({}).isNormalLocal(SYSTEM).reason, "SEAM_UNAVAILABLE");
    assert.deepStrictEqual(seam.isNormalLocal(31000005), { ok: true, normal: false });
    assert.deepStrictEqual(seam.isNormalLocal(SYSTEM), { ok: true, normal: true });

    assert.deepStrictEqual(seam.describeCharacter(91000009), { ok: false, reason: "NO_RECORD" });
    assert.deepStrictEqual(seam.describeCharacter(91000002), { ok: false, reason: "NO_CORPORATION" });
    assert.deepStrictEqual(seam.describeCharacter("x"), { ok: false, reason: "BAD_ID" });
    const d = seam.describeCharacter(91000001);
    assert.deepStrictEqual([d.ok, d.corporationId, d.allianceId, d.member.alliance.sequential], [true, 98000001,
      99000001, 99000001]);
    assert.ok(Object.isFrozen(d.member) && Object.isFrozen(d.member.character), "frozen member");
    assert.strictEqual(seamOver({ "_secondary/chat/chatRuntime": chatRuntime }).describeCharacter(91000001).reason,
      "SEAM_UNAVAILABLE");

    const { createAdapter } = require("../../lib/adapter");
    const adapter = createAdapter({ moduleApi: { _cache: {} } });
    const facade = adapter.localPilotsSeams();
    assert.strictEqual(facade.ok, true);
    assert.strictEqual(adapter.localPilotsSeams().seam, facade.seam, "one seam per adapter");
    assert.strictEqual(facade.seam.repushSystem(SYSTEM).reason, "SEAM_UNAVAILABLE", "server src unknown");
    adapter.runProbe();
    assert.deepStrictEqual(adapter.localPilotsSeams(), { ok: false, reason: "SEAM_UNAVAILABLE",
      detail: "server_src_not_found" });
  });

  test("LPL5 loader hook localPilots on a fake moduleApi: off -> state disabled, zero listeners; on -> installed, "
    + "one listener; modules.world off -> disabled", () => {
    const REQUEST = path.join(path.sep, "x", "server", "src", "_secondary", "chat", "chatRuntime");
    const PARENT = { filename: path.join(path.sep, "x", "server", "src", "index.js") };
    const silent = { log: () => {}, logError: () => {}, debug: () => {} };
    const run = (localPilotsCfg, world = true) => {
      const rt = fakeChatRuntime(() => []);
      const moduleApi = { _cache: {}, _load: (request) => (request === REQUEST ? rt.exportsObj : {}) };
      const ctx = { state: {}, logger: silent, loadConfig: () => ({ ok: true, sources: {}, warnings: [], errors: [],
        config: { enabled: true, debug: false, dataDir: "/x", modules: { world: { enabled: world } },
          localPilots: localPilotsCfg } }) };
      loader.installModuleHook(moduleApi, loader.buildHooks(ctx), silent);
      moduleApi._load(REQUEST, PARENT);
      return [ctx.state.localPilots, rt.emitter.listenerCount(EVENT)];
    };
    localPilots._resetForTest();
    try {
      assert.deepStrictEqual(run({ enabled: false }), ["disabled", 0]);
      assert.deepStrictEqual(run(undefined), ["disabled", 0]);
      assert.deepStrictEqual(run({ enabled: true }, false), ["disabled", 0]);
      assert.deepStrictEqual(run({ enabled: true }), ["installed", 1]);
    } finally {
      localPilots._resetForTest();
    }
  });
};
