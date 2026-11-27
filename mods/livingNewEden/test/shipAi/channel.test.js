"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const { createShipAiChannel, roomNameOf } = require("../../lib/adapter/shipAiChannel");
const shipTap = require("../../lib/adapter/shipAiXmpp");
const lpTap = require("../../lib/adapter/localPilotsXmpp");
const { createAdapter } = require("../../lib/adapter");
const { startShipAi } = require("../../lib/shipAi");
const { STATIC } = require("../../lib/shipAi/data/persona");
const { resolveConfig } = require("../../config");
const loader = require("../../loader");
const SH = require("../notices/storeHelper");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SERVER_SRC = path.resolve(MOD_DIR, "..", "..", "server", "src");
const PLAYER = 9001;
const OTHER = 9002;
const AI = 91000001;
const ROOM = roomNameOf(PLAYER, AI);
const ROOM_JID = `${ROOM}@conference.d`;
const BOUND = `${PLAYER}@d/eveclient`;

function readSource(rel) {
  return fs.readFileSync(path.join(SERVER_SRC, rel), "utf8").replace(/\r\n/g, "\n");
}

function functionBody(source, name) {
  const start = source.indexOf(`\nfunction ${name}(`);
  assert.ok(start >= 0, `function ${name} not found`);
  const next = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

function listJs(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listJs(p));
    else if (e.name.endsWith(".js")) out.push(p);
  }
  return out;
}

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.log = [];
  }

  write(data) {
    this.log.push(String(data));
    return true;
  }
}

function selfPresence(roomJid, nick, bound, unavailable = false) {
  return `<presence from='${roomJid}/${nick}' to='${bound}' id='j1'${unavailable ? " type='unavailable'" : ""}>`
    + "<eve_user_data info='[]' corpid='1000169' role='0' warfactionid='None' allianceid='None'/>"
    + `<x xmlns='http://jabber.org/protocol/muc#user'><item affiliation='member' role='participant' jid='${bound}'/>`
    + "<status code='110'/></x></presence>";
}

function fakeChat() {
  const calls = { send: [], ensure: [] };
  const chat = {
    sendChannelMessage: function sendChannelMessage(session, roomName, message, options) {
      calls.send.push({ self: this, args: [...arguments] });
      return { record: { roomName }, entry: { roomName, message: String(message).trim(), createdAtMs: 5 } };
    },
    ensurePrivateChannelForCharacters(left, right, options) {
      calls.ensure.push([left, right, options]);
      return { roomName: roomNameOf(left, right), persistBacklog: options.persistBacklog !== false };
    },
  };
  return { chat, calls };
}

function fakeXmpp(sent = true) {
  const invites = [];
  return { invites, exports: { inviteCharacterToRoom: (...args) => { invites.push(args); return sent; },
    handleSocketForEdge: function handleSocket() { return { client: true }; } } };
}

const aiRecord = (name = "Jin") => ({ characterName: name, corporationID: 1000169, gender: 0, typeID: 1373 });

module.exports = ({ test, skip }) => {
  const haveSrc = fs.existsSync(path.join(SERVER_SRC, "services", "chat", "xmppStubServer.js"));
  (haveSrc ? test : (name) => skip(name, "EveJS server/src not found"))("SAI1 vendor facts: exports, the only "
    + ".sendChannelMessage( caller, persistBacklog in syncEnsuredChannel, pair room name, echo createdAtMs, self 110; "
    + "the real adapter facade lists its methods", () => {
    const chat = readSource("_secondary/chat/chatRuntime.js");
    const xmpp = readSource("services/chat/xmppStubServer.js");
    for (const name of ["sendChannelMessage", "ensurePrivateChannelForCharacters"]) {
      assert.ok(chat.includes(`\n  ${name},\n`), `chatRuntime exports ${name}`);
    }
    assert.ok(xmpp.includes("\n  inviteCharacterToRoom,\n"), "xmppStubServer exports inviteCharacterToRoom");
    assert.ok(xmpp.includes("\n  handleSocketForEdge: handleSocket,\n"), "xmppStubServer exports handleSocketForEdge");
    const callers = [];
    for (const dir of ["_secondary", path.join("services", "chat"), "network"]) {
      for (const f of listJs(path.join(SERVER_SRC, dir))) {
        if (f.endsWith(`${path.sep}chatRuntime.js`)) continue;
        const n = (fs.readFileSync(f, "utf8").match(/\.sendChannelMessage\(/g) || []).length;
        if (n > 0) callers.push(`${path.relative(SERVER_SRC, f).replace(/\\/g, "/")}:${n}`);
      }
    }
    assert.deepStrictEqual(callers, ["services/chat/xmppStubServer.js:1"]);
    assert.ok(xmpp.includes("sendResult = chatRuntime.sendChannelMessage(session, descriptor.roomName, body);"));
    assert.ok(xmpp.includes("Number(sendResult && sendResult.entry && sendResult.entry.createdAtMs) || Date.now(),"));
    assert.strictEqual((chat.match(/\bsendChannelMessage\(/g) || []).length, 2);
    assert.ok(functionBody(chat, "broadcastLocalMessage").includes("sendChannelMessage(session, roomName, message)"));
    assert.ok(functionBody(chat, "syncEnsuredChannel").includes("hasOwnOption(options, \"persistBacklog\")"));
    const pair = functionBody(chat, "ensurePrivateChannelForCharacters");
    assert.ok(pair.includes("const roomName = `private_${pairMembers[0]}_${pairMembers[1]}`;"));
    assert.ok(pair.includes("allowedParticipantCharacterIDs: pairMembers,"));
    assert.ok(functionBody(chat, "dedupePositiveIntegers").includes(".sort((left, right) => left - right)"));
    assert.ok(functionBody(chat, "sendChannelMessage").includes("if (record.persistBacklog !== false) {"));
    assert.ok(functionBody(xmpp, "inviteCharacterToRoom").includes("return sendRoomInvite("));
    assert.ok(functionBody(xmpp, "sendXml").includes("const writable = client.socket.write(xml);"));
    assert.ok(functionBody(xmpp, "handleJoinPresence").includes("<status code='110'/></x></presence>`,"));
    assert.ok(functionBody(xmpp, "buildRoomMessageXml").includes("\" type='groupchat'\","), "room message format");
    const write = functionBody(readSource("services/character/characterState.js"), "writeCharacterRecord");
    assert.ok(!write.includes("characterName"), "writeCharacterRecord checks no name");

    const SRC = path.join(path.sep, "x", "server", "src");
    const key = (rel) => path.join(SRC, `${rel}.js`);
    const cache = { [key("_secondary/chat/chatRuntime")]: { exports: fakeChat().chat },
      [key("services/chat/xmppStubServer")]: { exports: fakeXmpp().exports } };
    const adapter = createAdapter({ moduleApi: { _cache: cache }, logger: { log() {} } });
    adapter.setServerSrc(SRC);
    const r = adapter.shipAiSeams();
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.deepStrictEqual(Object.keys(r.seam).sort(), ["activity", "channel", "db", "identities", "portrait",
      "sensors", "telemetry", "xmpp"]);
    assert.deepStrictEqual(Object.keys(r.seam.xmpp).sort(), ["clearPairs", "getState", "hasOpenRoom", "isInstalled",
      "registerPair", "sendAiMessage", "userDataOf"]);
    assert.deepStrictEqual(Object.keys(r.seam.identities).sort(), ["corporationExists", "findByMarker", "flush",
      "reserveCharacterId", "writeCharacter"]);
    const ch = r.seam.channel({ isAiRoom: () => false, onRoomMessage: () => {} });
    assert.deepStrictEqual(Object.keys(ch).sort(), ["ensureRoom", "install", "invite", "isActive", "uninstall"]);
  });

  test("SAI2 wrap: AI room of the sender -> original NOT called, synthetic {record, entry} (message \"\"), handler "
    + "on defer; any other room / sender / empty line -> the current value with the same this/args, its result", () => {
    const { chat, calls } = fakeChat();
    const vendor = chat.sendChannelMessage;
    const prior = [];
    chat.sendChannelMessage = function audLike() {
      prior.push(arguments.length);
      return vendor.apply(this, arguments);
    };
    const before = chat.sendChannelMessage;
    const deferred = [];
    const got = [];
    let throwRoom = false;
    const channel = createShipAiChannel({ chatRuntimeExports: chat, xmppExports: fakeXmpp().exports,
      isAiRoom: (room, id) => {
        if (throwRoom) throw new Error("room boom");
        return id === PLAYER && room === ROOM;
      },
      onRoomMessage: (playerId, text) => {
        got.push([playerId, text]);
        if (text === "boom") throw new Error("handler boom");
      },
      now: () => 777, defer: (fn) => deferred.push(fn), logger: { log() {} } });
    assert.deepStrictEqual(channel.install(), { ok: true });
    assert.deepStrictEqual(channel.install(), { ok: false, reason: "HOOK_ALREADY_INSTALLED" });
    const self = { tag: "this" };
    const res = chat.sendChannelMessage.call(self, { characterID: PLAYER }, ROOM, "  hi there ");
    assert.deepStrictEqual(res, { record: { roomName: ROOM },
      entry: { roomName: ROOM, characterID: PLAYER, message: "", createdAtMs: 777 } });
    assert.deepStrictEqual([calls.send.length, prior.length, got.length, deferred.length], [0, 0, 0, 1]);
    deferred.shift()();
    assert.deepStrictEqual(got, [[PLAYER, "hi there"]]);

    const opts = { providedPassword: "x" };
    for (const [session, room, msg] of [[{ characterID: PLAYER }, "player_5", "hi"],
      [{ characterID: OTHER }, ROOM, "hi"], [{ characterID: PLAYER }, ROOM, "   "]]) {
      const n = calls.send.length;
      const out = chat.sendChannelMessage.call(self, session, room, msg, opts);
      assert.strictEqual(calls.send.length, n + 1, room);
      const call = calls.send[n];
      assert.strictEqual(call.self, self);
      assert.deepStrictEqual(call.args, [session, room, msg, opts]);
      assert.deepStrictEqual(out, { record: { roomName: room }, entry: { roomName: room, message: msg.trim(),
        createdAtMs: 5 } });
    }
    assert.strictEqual(prior.length, 3, "the prior wrap sees every passed call");
    throwRoom = true;
    assert.strictEqual(chat.sendChannelMessage({ characterID: PLAYER }, ROOM, "x").entry.createdAtMs, 5,
      "a throwing room check passes to the original");
    throwRoom = false;
    chat.sendChannelMessage({ characterID: PLAYER }, ROOM, "boom");
    assert.doesNotThrow(() => deferred.shift()(), "a throwing handler stays in the adapter");
    assert.deepStrictEqual(deferred, []);

    assert.deepStrictEqual(channel.ensureRoom(PLAYER, AI).ok, true);
    assert.deepStrictEqual(calls.ensure, [[PLAYER, AI, { persistBacklog: false }]]);
    assert.deepStrictEqual(channel.ensureRoom(PLAYER, PLAYER), { ok: false, reason: "ROOM_FAILED", detail: "pair" });
    channel.uninstall();
    assert.strictEqual(chat.sendChannelMessage, before, "uninstall restores the value it found");
    assert.strictEqual(channel.isActive(), false);
    const noClient = createShipAiChannel({ chatRuntimeExports: chat, xmppExports: fakeXmpp(false).exports,
      isAiRoom: () => false, onRoomMessage: () => {} });
    assert.deepStrictEqual(noClient.invite(PLAYER, AI, "r"), { ok: false, reason: "NO_CLIENT" });
  });

  test("SAI3 tap: self 110 in the pair room -> one AI presence on that socket; sendAiMessage only to that player's "
    + "sockets; chained with the Local pilots tap (one vendor write per write); unavailable drops the room", () => {
    shipTap._resetForTest();
    lpTap._resetForTest();
    try {
      const xmpp = fakeXmpp().exports;
      assert.strictEqual(lpTap.install(xmpp, { maxBatchBytes: 32768 }).ok, true);
      assert.deepStrictEqual(shipTap.install(xmpp, { maxBatchBytes: 32768 }), { ok: true, alreadyInstalled: false });
      assert.deepStrictEqual(shipTap.install(xmpp, {}), { ok: true, alreadyInstalled: true });
      const socket = new FakeSocket();
      const other = new FakeSocket();
      xmpp.handleSocketForEdge(socket);
      xmpp.handleSocketForEdge(other);
      assert.strictEqual(socket[shipTap.TAPPED], true);
      const userDataXml = lpTap.buildUserDataXml(AI, aiRecord());
      assert.deepStrictEqual(shipTap.registerPair({ playerId: PLAYER, aiId: AI, userDataXml }), { ok: true });
      assert.deepStrictEqual(shipTap.registerPair({ playerId: PLAYER, aiId: PLAYER, userDataXml }),
        { ok: false, reason: "BAD_INPUT" });

      socket.write("<iq type='result'/>");
      assert.deepStrictEqual(socket.log, ["<iq type='result'/>"], "both taps pass one write once");
      const self = selfPresence(ROOM_JID, PLAYER, BOUND);
      assert.strictEqual(socket.write(self), true, "vendor result");
      assert.strictEqual(socket.log.length, 3);
      assert.strictEqual(socket.log[1], self);
      const presence = socket.log[2];
      assert.ok(presence.startsWith(`<presence from='${ROOM_JID}/${AI}' to='${BOUND}'`), presence);
      assert.ok(presence.includes(userDataXml) && presence.includes(`jid='${AI}@d'`)
        && presence.includes("participant"), presence);
      socket.write(self);
      assert.strictEqual(socket.log.filter((l) => l.includes(`${ROOM_JID}/${AI}'`)).length, 1, "one AI presence");
      other.write(selfPresence(`${roomNameOf(OTHER, AI + 1)}@conference.d`, OTHER, `${OTHER}@d/eveclient`));
      assert.strictEqual(other.log.length, 1);
      assert.strictEqual(shipTap.hasOpenRoom(PLAYER), true);
      assert.strictEqual(shipTap.hasOpenRoom(OTHER), false);

      const sent = shipTap.sendAiMessage({ playerId: PLAYER, aiId: AI, text: "hello <captain>" });
      assert.deepStrictEqual(sent, { ok: true, sockets: 1 });
      const line = socket.log[socket.log.length - 1];
      assert.ok(line.startsWith(`<message from='${ROOM_JID}/${AI}' to='${BOUND}' type='groupchat'`), line);
      assert.ok(line.includes("<body>hello &lt;captain&gt;</body>"));
      assert.strictEqual(other.log.length, 1, "no AI line to another player");
      assert.deepStrictEqual(shipTap.sendAiMessage({ playerId: OTHER, aiId: AI, text: "x" }),
        { ok: false, reason: "NO_ROOM" });
      assert.deepStrictEqual(shipTap.sendAiMessage({ playerId: PLAYER, aiId: AI, text: "x".repeat(40000) }),
        { ok: false, reason: "TOO_LONG" });
      assert.deepStrictEqual(shipTap.sendAiMessage({ playerId: PLAYER, aiId: AI, text: "" }),
        { ok: false, reason: "BAD_INPUT" });

      socket.write(selfPresence(ROOM_JID, PLAYER, BOUND, true));
      assert.strictEqual(shipTap.hasOpenRoom(PLAYER), false);
      assert.deepStrictEqual(shipTap.sendAiMessage({ playerId: PLAYER, aiId: AI, text: "x" }),
        { ok: false, reason: "NO_ROOM" });
      const st = shipTap.getState();
      assert.deepStrictEqual([st.installed, st.pairs, st.sockets, st.presences, st.sent, st.errors],
        [true, 1, 0, 1, 1, 0]);
    } finally {
      shipTap._resetForTest();
      lpTap._resetForTest();
    }
  });

  const driver = SH.loadDriver();
  const name4 = "SAI4 !ai: gateway -> NOT_PRIVATE (no identity), allowlist \"\" = nobody / \"*\" = everybody, xmpp "
    + "open -> record + room (persistBacklog false) + invite, a room line -> static AI line; off -> no command, no "
    + "record, no loader wrap";
  if (!driver.ok) {
    skip(name4, `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }
  test(name4, () => SH.withStoreAsync(driver, async (persistence) => {
    shipTap._resetForTest();
    try {
      const base = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_SHIP_AI_ENABLED: "1" } });
      assert.deepStrictEqual(base.warnings.filter((w) => w.startsWith("shipAi")), []);
      assert.deepStrictEqual(base.config.shipAi.defaultName, "Jin");
      const cfg = (shipAi) => ({ ...base.config, shipAi: { ...base.config.shipAi, ...shipAi } });
      const xmpp = fakeXmpp();
      assert.strictEqual(shipTap.install(xmpp.exports, {}).ok, true);
      const { chat, calls } = fakeChat();
      const records = new Map();
      let next = AI;
      const identities = {
        reserveCharacterId: () => ({ ok: true, characterId: next++ }),
        writeCharacter: (rec) => { records.set(rec.characterId, rec); return { ok: true }; },
        flush: () => ({ ok: true }),
        findByMarker: (k) => {
          const hit = [...records.values()].find((r) => r.lneIdentityKey === k);
          return hit ? { ok: true, found: true, characterId: hit.characterId, name: hit.characterName }
            : { ok: true, found: false };
        },
        corporationExists: (id) => ({ ok: true, exists: id === 1000169 }),
      };
      const installs = [];
      let seamsAsked = 0;
      const adapter = {
        shipAiSeams: () => {
          seamsAsked += 1;
          return { ok: true, seam: { identities,
            channel: (opts) => createShipAiChannel({ ...opts, chatRuntimeExports: chat, xmppExports: xmpp.exports }),
            xmpp: { isInstalled: shipTap.isInstalled, registerPair: shipTap.registerPair,
              clearPairs: shipTap.clearPairs,
              sendAiMessage: shipTap.sendAiMessage, hasOpenRoom: shipTap.hasOpenRoom, getState: shipTap.getState,
              userDataOf: (id) => (records.has(id) ? lpTap.buildUserDataXml(id, records.get(id)) : null) } } };
        },
        installChatCommand: (opts) => { installs.push(opts); return { ok: true }; },
        uninstallChatCommand: () => ({ ok: true }),
      };
      const start = (shipAi) => startShipAi({ config: cfg(shipAi), persistence, adapter, clock: { now: () => 1000 } });
      const rec = { characterId: PLAYER };
      const gw = { transport: "gateway" };
      const xm = { transport: "xmpp" };

      assert.deepStrictEqual(start({ enabled: false }), { ok: false, reason: "disabled_by_config" });
      assert.deepStrictEqual([seamsAsked, installs.length, records.size], [0, 0, 0]);
      assert.strictEqual(chat.sendChannelMessage.name, "sendChannelMessage", "no wrap");
      assert.deepStrictEqual(start({ corporationId: 1000001 }), { ok: false, reason: "INVALID_SETTINGS",
        detail: "corporationId" });

      const nobody = start({ allowCharacterIds: "" });
      assert.strictEqual(nobody.ok, true, JSON.stringify(nobody));
      assert.match(installs[0].handle(rec, "!ai", xm), /not enabled for you/);
      assert.strictEqual(nobody.shipAi.getStatus().counters.denied, 1);
      nobody.shipAi.stop("test");
      assert.strictEqual(chat.sendChannelMessage.name, "sendChannelMessage", "stop removes the wrap");

      const on = start({ allowCharacterIds: "*" });
      assert.strictEqual(on.ok, true);
      const handle = installs[1].handle;
      assert.strictEqual(installs[1].match("!ai"), true);
      assert.strictEqual(installs[1].match("!aid"), false);
      assert.match(handle(rec, "!ai", gw), /private chat only on this chat path \(NOT_PRIVATE\)$/);
      assert.match(handle(rec, "!ai", { transport: "unknown" }), /NOT_PRIVATE/);
      assert.deepStrictEqual([records.size, on.shipAi.getStatus().counters.refusedNotPrivate], [0, 2]);
      assert.strictEqual(handle(rec, "!ai", xm), "Jin: invitation sent, accept it to talk");
      assert.match(handle(rec, "!ai", xm), /^Jin: wait 4s before the next !ai$/, "cooldown");
      assert.deepStrictEqual([...records.keys()], [AI]);
      assert.deepStrictEqual([records.get(AI).lneIdentityKey, records.get(AI).corporationID], [`shipai:${PLAYER}`,
        1000169]);
      assert.deepStrictEqual(calls.ensure, [[PLAYER, AI, { persistBacklog: false }]]);
      assert.deepStrictEqual(xmpp.invites, [[ROOM, AI, PLAYER, "Jin: your ship AI"]]);

      const socket = new FakeSocket();
      xmpp.exports.handleSocketForEdge(socket);
      socket.write(selfPresence(ROOM_JID, PLAYER, BOUND));
      assert.strictEqual(socket.log.length, 2, "self + AI presence");
      const out = chat.sendChannelMessage({ characterID: PLAYER }, ROOM, "hello");
      assert.deepStrictEqual([out.entry.message, calls.send.length], ["", 0]);
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      const body = (socket.log[2] || "").replace(/&apos;/g, "'");
      assert.ok(STATIC.en.SIGNAL_LOST.some((l) => body.includes(`<body>${l}</body>`)), socket.log[2]);
      const st = on.shipAi.getStatus();
      assert.deepStrictEqual([st.state, st.identities, st.roomsOpen, st.counters], ["running", 1, 1,
        { invites: 1, roomMessages: 1, refusedNotPrivate: 2, denied: 0, recordsRestored: 0, roomCommands: 0,
          roomDenied: 0, memoryCommands: 0, renames: 0, personaCommands: 0, personaChanges: 0, personaRefused: 0,
          personaCustomSkipped: 0 }]);
      assert.deepStrictEqual([st.model.state, st.model.lastError, st.model.counters.requests], ["disabled",
        "NO_API_KEY", 0]);
      on.shipAi.stop("test");

      records.clear();
      const again = start({ allowCharacterIds: "*" });
      assert.strictEqual(again.ok, true);
      chat.sendChannelMessage({ characterID: PLAYER }, ROOM, "lost?");
      assert.strictEqual(calls.send.length, 1, "no pair -> the vendor gets the line");
      assert.strictEqual(installs[2].handle(rec, "!ai", xm), "Jin: invitation sent, accept it to talk");
      assert.deepStrictEqual([[...records.keys()], records.get(AI).lneIdentityKey], [[AI], `shipai:${PLAYER}`]);
      assert.strictEqual(again.shipAi.getStatus().counters.recordsRestored, 1);
      assert.strictEqual(chat.sendChannelMessage({ characterID: PLAYER }, ROOM, "back").entry.message, "");
      assert.strictEqual(calls.send.length, 1, "the pair is back: the line stays out of the vendor");
      again.shipAi.stop("test");

      const REQUEST = path.join(path.sep, "x", "server", "src", "services", "chat", "xmppStubServer");
      const PARENT = { filename: path.join(path.sep, "x", "server", "src", "_secondary", "chat", "server.js") };
      const silent = { log: () => {}, logError: () => {}, debug: () => {} };
      for (const [enabled, want] of [[false, "disabled"], [true, "installed"]]) {
        shipTap._resetForTest();
        const original = function handleSocket() { return 1; };
        const exportsObj = { handleSocketForEdge: original };
        const moduleApi = { _cache: {}, _load: (request) => (request === REQUEST ? exportsObj : {}) };
        const ctx = { state: {}, logger: silent, loadConfig: () => ({ ok: true, sources: {}, warnings: [], errors: [],
          config: cfg({ enabled }) }) };
        loader.installModuleHook(moduleApi, loader.buildHooks(ctx), silent);
        moduleApi._load(REQUEST, PARENT);
        assert.deepStrictEqual([ctx.state.shipAiXmpp, exportsObj.handleSocketForEdge === original],
          [want, !enabled], String(enabled));
      }
    } finally {
      shipTap._resetForTest();
    }
  }));
};
