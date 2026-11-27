"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const tap = require("../../lib/adapter/localPilotsXmpp");
const localPilots = require("../../lib/adapter/localPilots");
const { GAME_MODULES } = require("../../lib/adapter/gameModules");
const loader = require("../../loader");

const SERVER_SRC = path.resolve(__dirname, "..", "..", "..", "..", "server", "src");
const SYSTEM = 30001990;
const OTHER = 30001991;
const ROOM = `local_${SYSTEM}@conference.d`;
const ROOM_B = `local_${OTHER}@conference.d`;
const BOUND = "9001@d/eveclient";
const PLAYER = 9001;
const A = 91000001;
const B = 91000002;
const C = 91000003;

function readSource(rel) {
  return fs.readFileSync(path.join(SERVER_SRC, rel), "utf8").replace(/\r\n/g, "\n");
}

function functionBody(source, name) {
  const start = source.indexOf(`\nfunction ${name}(`);
  assert.ok(start >= 0, `function ${name} not found`);
  const next = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.log = [];
    this.failOn = null;
  }

  write(data) {
    if (this.failOn && String(data).includes(this.failOn)) throw new Error("socket boom");
    this.log.push(String(data));
    return true;
  }
}

function record(id, corp, alliance = 0) {
  return { characterName: `Pilot ${id}`, typeID: 1376, gender: 1, corporationID: corp, allianceID: alliance };
}

function pilot(id, corp = 98000001, alliance = 0) {
  return { characterId: id, userDataXml: tap.buildUserDataXml(id, record(id, corp, alliance)) };
}

function selfPresence(room, available = true, nick = String(PLAYER)) {
  return `<presence from='${room}/${nick}' to='${BOUND}' id='evejs-1'${available ? "" : " type='unavailable'"}>`
    + "<eve_user_data corpid='1' role='0' warfactionid='None' allianceid='None'/><x xmlns='http://jabber.org/protocol/"
    + `muc#user'><item affiliation='member' role='${available ? "participant" : "none"}' jid='${BOUND}'/>`
    + "<status code='110'/></x></presence>";
}

function presences(batch) {
  return [...batch.matchAll(/<presence from='([^']*)' to='([^']*)' id='[^']*'( type='unavailable')?>.*?jid='([^']*)'\/>/g)]
    .map((m) => [m[3] ? "unavailable" : "available", m[1], m[4]]);
}

function leaves(batch) {
  return [...batch.matchAll(/<message from='([^']*)\/admin'[^>]*><body>([^<]*)<\/body><\/message>/g)]
    .map((m) => JSON.parse(m[2].replace(/&quot;/g, "\"")).charid);
}

function stanzaKinds(batch) {
  return [...batch.matchAll(/<message [^>]*><body>([^<]*)<\/body><\/message>|<presence from='[^']*\/(\d+)' [^>]*?( type='unavailable')?>/g)]
    .map((m) => (m[1] !== undefined ? ["leave", JSON.parse(m[1].replace(/&quot;/g, "\"")).charid]
      : [m[3] ? "unavailable" : "available", Number(m[2])]));
}

function setup(opts = {}) {
  tap._resetForTest();
  const calls = [];
  const xmppExports = { handleSocketForEdge(socket) { calls.push(socket); return "vendor-result"; } };
  assert.deepStrictEqual(tap.install(xmppExports, { maxBatchBytes: opts.maxBatchBytes || 32768 }),
    { ok: true, alreadyInstalled: false });
  const socket = new FakeSocket();
  assert.strictEqual(xmppExports.handleSocketForEdge(socket), "vendor-result");
  return { xmppExports, socket, calls };
}

module.exports = ({ test }) => {
  test("LPX1 join: self-110 in local_<id> -> the vendor stanza, then one batch with an available per roster pilot "
    + "(vendor format, nick of the player skipped); corp / wormhole / triglavian rooms untouched", () => {
    try {
      const { socket, calls } = setup();
      assert.strictEqual(calls[0], socket, "the original gets the same socket");
      assert.ok(Object.prototype.hasOwnProperty.call(socket, "write"), "own write property on the instance");
      const roster = [pilot(A, 98000001, 99000001), pilot(B), { characterId: PLAYER, userDataXml: "<eve_user_data/>" }];
      assert.deepStrictEqual(tap.syncSystem(SYSTEM, roster), { ok: true, sockets: 0, added: 0, removed: 0 });
      const self = selfPresence(ROOM);
      assert.strictEqual(socket.write(self), true, "the result of the original");
      assert.strictEqual(socket.log.length, 2);
      assert.strictEqual(socket.log[0], self, "vendor stanza first, unchanged");
      assert.deepStrictEqual(presences(socket.log[1]), [["available", `${ROOM}/${A}`, `${A}@d`],
        ["available", `${ROOM}/${B}`, `${B}@d`]]);
      const first = socket.log[1].slice(0, socket.log[1].indexOf("</presence>") + "</presence>".length);
      assert.strictEqual(first, `<presence from='${ROOM}/${A}' to='${BOUND}' id='lne-lp-1'><eve_user_data info='`
        + `[${A},&quot;Pilot ${A}&quot;,1376,true,null]' corpid='98000001' role='0' warfactionid='None' `
        + `allianceid='99000001'/><x xmlns='http://jabber.org/protocol/muc#user'><item affiliation='member' `
        + `role='participant' jid='${A}@d'/></x></presence>`);
      assert.ok(socket.log[1].includes(`corpid='98000001' role='0' warfactionid='None' allianceid='None'/>`), "B");
      assert.strictEqual(tap.buildUserDataXml(C, { characterName: "x" }), null, "no corporation -> null");
      assert.strictEqual(tap.buildUserDataXml(C, null), null);
      for (const room of ["corp_98000001@conference.d", "fleet_123@conference.d"]) {
        const before = socket.log.length;
        socket.write(selfPresence(room));
        assert.strictEqual(socket.log.length, before + 1, `${room}: only the vendor stanza`);
      }
      const st = tap.getState();
      assert.deepStrictEqual([st.sockets, st.shown, st.joins, st.sent], [1, 2, 1, 2]);
    } finally {
      tap._resetForTest();
    }
  });

  test("LPX2 diff and idempotence: {A,B} -> {B,C} = admin leave + unavailable A, available C; the same roster = zero "
    + "writes; clearAll = leave + unavailable B, C; reassert(1) budget and cursor; batches <= maxBatchBytes; "
    + "seam setRoster feeds the tap (noRecord, xmpp state, reassertXmpp)", () => {
    try {
      const { socket } = setup();
      tap.syncSystem(SYSTEM, [pilot(A), pilot(B)]);
      socket.write(selfPresence(ROOM));
      socket.log.length = 0;
      assert.deepStrictEqual(tap.syncSystem(SYSTEM, [pilot(B), pilot(C)]), { ok: true, sockets: 1, added: 1, removed: 1 });
      assert.strictEqual(socket.log.length, 1, "one batch");
      assert.deepStrictEqual(leaves(socket.log[0]), [A]);
      assert.ok(socket.log[0].indexOf("<message") < socket.log[0].indexOf("type='unavailable'"), "leave first");
      assert.deepStrictEqual(presences(socket.log[0]), [["unavailable", `${ROOM}/${A}`, `${A}@d`],
        ["available", `${ROOM}/${C}`, `${C}@d`]]);
      socket.log.length = 0;
      assert.deepStrictEqual(tap.syncSystem(SYSTEM, [pilot(B), pilot(C)]), { ok: true, sockets: 1, added: 0, removed: 0 });
      assert.strictEqual(tap.syncSystem(OTHER, [pilot(A)]).sockets, 0, "another system");
      assert.deepStrictEqual(socket.log, [], "same roster -> zero writes");

      const r1 = tap.reassert(1);
      const r2 = tap.reassert(1);
      assert.deepStrictEqual([r1, r2], [{ ok: true, stanzas: 1, sockets: 1 }, { ok: true, stanzas: 1, sockets: 1 }]);
      assert.deepStrictEqual(socket.log.map((x) => presences(x)[0][2]), [`${B}@d`, `${C}@d`], "cursor advances");
      socket.log.length = 0;

      assert.deepStrictEqual(tap.clearAll(), { ok: true, sockets: 1, removed: 2 });
      assert.deepStrictEqual(leaves(socket.log[0]), [B, C]);
      assert.deepStrictEqual(presences(socket.log[0]).map((p) => p[0]), ["unavailable", "unavailable"]);
      assert.deepStrictEqual([tap.getState().sockets, tap.getState().shown], [1, 0], "the entry stays, nothing shown");
      assert.deepStrictEqual(tap.reassert(512), { ok: true, stanzas: 0, sockets: 0 });

      const small = setup({ maxBatchBytes: 600 });
      tap.syncSystem(SYSTEM, [pilot(A), pilot(B), pilot(C)]);
      small.socket.write(selfPresence(ROOM));
      assert.ok(small.socket.log.length >= 3, "self + at least two batches");
      assert.ok(small.socket.log.slice(1).every((b) => Buffer.byteLength(b) <= 600 || presences(b).length === 1));
      assert.strictEqual(small.socket.log.slice(1).flatMap(presences).length, 3);

      const fresh = setup();
      localPilots._resetForTest();
      const chat = { on: () => {} };
      localPilots.install(chat);
      const records = { [A]: record(A, 98000001), [B]: record(B, 98000002, 99000002) };
      const seam = localPilots.createLocalPilotsSeam({ requireGame: (rel) => (rel === "services/character/characterState"
        ? { ok: true, exports: { peekCharacterRecord: (id) => records[id] || null } } : { ok: false, reason: "x" }) });
      fresh.socket.write(selfPresence(ROOM));
      const member = (id) => ({ character: { sequential: id } });
      assert.deepStrictEqual(seam.setRoster(SYSTEM, [member(A), member(B), member(C)]), { ok: true, size: 3 });
      assert.deepStrictEqual(presences(fresh.socket.log[1]).map((p) => p[2]), [`${A}@d`, `${B}@d`]);
      const st = seam.getState();
      assert.deepStrictEqual([st.pilots, st.xmpp.shown, st.xmpp.noRecord], [3, 2, 1]);
      assert.strictEqual(seam.reassertXmpp(16).stanzas, 2);
      assert.deepStrictEqual(seam.clearRosters(), { ok: true, systems: [SYSTEM] });
      assert.strictEqual(seam.getState().xmpp.shown, 0, "clearRosters -> clearAll");
      tap._resetForTest();
      assert.deepStrictEqual(seam.reassertXmpp(16), { ok: false, reason: "NOT_INSTALLED" });
      assert.deepStrictEqual(seam.setRoster(SYSTEM, [member(A)]), { ok: true, size: 1 }, "no tap: gateway only");
    } finally {
      tap._resetForTest();
      localPilots._resetForTest();
    }
  });

  test("LPX3 leave and close: self-unavailable 110 -> unavailable of the pilots BEFORE the vendor stanza, then no "
    + "tracking; local_A -> local_B = unavailable in A, available in B; close / destroyed = zero writes; a throwing "
    + "injection write -> the vendor stanza written once, errors++", () => {
    try {
      const { socket } = setup();
      tap.syncSystem(SYSTEM, [pilot(A), pilot(B)]);
      tap.syncSystem(OTHER, [pilot(C)]);
      socket.write(selfPresence(ROOM));
      socket.log.length = 0;
      const bye = selfPresence(ROOM, false);
      socket.write(bye);
      assert.strictEqual(socket.log.length, 2);
      assert.deepStrictEqual(presences(socket.log[0]).map((p) => p[0]), ["unavailable", "unavailable"]);
      assert.deepStrictEqual(leaves(socket.log[0]), [A, B], "admin leave on our own exit");
      assert.deepStrictEqual(stanzaKinds(socket.log[0]), [["leave", A], ["unavailable", A], ["leave", B],
        ["unavailable", B]]);
      assert.strictEqual(socket.log[1], bye, "vendor stanza after ours");
      socket.log.length = 0;
      tap.syncSystem(SYSTEM, [pilot(A)]);
      assert.deepStrictEqual(socket.log, [], "not tracked any more");
      assert.strictEqual(tap.getState().leftRooms, 1);

      socket.write(selfPresence(ROOM));
      socket.log.length = 0;
      socket.write(selfPresence(ROOM_B));
      assert.strictEqual(socket.log[0], selfPresence(ROOM_B));
      assert.deepStrictEqual(presences(socket.log[1]), [["unavailable", `${ROOM}/${A}`, `${A}@d`]]);
      assert.deepStrictEqual(stanzaKinds(socket.log[1]), [["leave", A], ["unavailable", A]], "Room change");
      assert.deepStrictEqual(presences(socket.log[2]), [["available", `${ROOM_B}/${C}`, `${C}@d`]]);

      socket.emit("close");
      socket.log.length = 0;
      tap.syncSystem(OTHER, []);
      assert.deepStrictEqual([socket.log, tap.getState().sockets], [[], 0], "close -> entry gone, zero writes");

      const second = setup();
      tap.syncSystem(SYSTEM, [pilot(A)]);
      second.socket.write(selfPresence(ROOM));
      second.socket.destroyed = true;
      second.socket.log.length = 0;
      tap.syncSystem(SYSTEM, [pilot(B)]);
      assert.deepStrictEqual([second.socket.log, tap.getState().sockets], [[], 0], "destroyed -> zero writes");

      const third = setup();
      tap.syncSystem(SYSTEM, [pilot(A)]);
      third.socket.failOn = "lne-lp-";
      const self = selfPresence(ROOM);
      assert.doesNotThrow(() => assert.strictEqual(third.socket.write(self), true));
      assert.deepStrictEqual(third.socket.log, [self], "vendor stanza written exactly once");
      assert.strictEqual(tap.getState().errors, 1);
      assert.deepStrictEqual(third.socket.write("<iq type='result'/>"), true, "fast path");
    } finally {
      tap._resetForTest();
    }
  });

  test("LPX4 loader hook localPilotsXmpp: either flag off -> handleSocketForEdge is the vendor function; on -> one "
    + "wrap (second install = alreadyInstalled), same socket, vendor result; a socket without write -> original", () => {
    const REQUEST = path.join(path.sep, "x", "server", "src", "services", "chat", "xmppStubServer");
    const PARENT = { filename: path.join(path.sep, "x", "server", "src", "_secondary", "chat", "server.js") };
    const silent = { log: () => {}, logError: () => {}, debug: () => {} };
    const run = (localPilotsCfg) => {
      const seen = [];
      const original = function handleSocket(socket) { seen.push(socket); return { client: true }; };
      const xmppExports = { handleSocketForEdge: original };
      const moduleApi = { _cache: {}, _load: (request) => (request === REQUEST ? xmppExports : {}) };
      const ctx = { state: {}, logger: silent, loadConfig: () => ({ ok: true, sources: {}, warnings: [], errors: [],
        config: { enabled: true, debug: false, dataDir: "/x", modules: { world: { enabled: true } },
          localPilots: localPilotsCfg } }) };
      loader.installModuleHook(moduleApi, loader.buildHooks(ctx), silent);
      moduleApi._load(REQUEST, PARENT);
      return { state: ctx.state.localPilotsXmpp, xmppExports, original, seen };
    };
    tap._resetForTest();
    try {
      for (const cfg of [{ enabled: false, xmppEnabled: true }, { enabled: true, xmppEnabled: false }, undefined]) {
        const r = run(cfg);
        assert.deepStrictEqual([r.state, r.xmppExports.handleSocketForEdge === r.original], ["disabled", true],
          JSON.stringify(cfg));
      }
      assert.strictEqual(tap.isInstalled(), false);
      const on = run({ enabled: true, xmppEnabled: true, xmppMaxBatchBytes: 32768 });
      assert.strictEqual(on.state, "installed");
      const wrapper = on.xmppExports.handleSocketForEdge;
      assert.notStrictEqual(wrapper, on.original);
      assert.deepStrictEqual(tap.install(on.xmppExports, { maxBatchBytes: 32768 }), { ok: true, alreadyInstalled: true });
      assert.strictEqual(on.xmppExports.handleSocketForEdge, wrapper, "one wrap");
      const socket = new FakeSocket();
      assert.deepStrictEqual(wrapper(socket), { client: true });
      assert.strictEqual(on.seen[0], socket);
      const bare = { on() {} };
      assert.deepStrictEqual(wrapper(bare), { client: true }, "socket without write -> original");
      assert.strictEqual(on.seen[1], bare);
      assert.strictEqual(tap.getState().attachSkipped, 1);
      assert.deepStrictEqual(tap.install({}, {}), { ok: false, reason: "NO_HANDLER" });
    } finally {
      tap._resetForTest();
    }
  });

  test("LPX5 vendor facts: server.js destructures handleSocketForEdge, sendXml -> client.socket.write(xml), self-110 "
    + "/ self-unavailable / buildRoomPresenceXml / admin leave templates, eve_user_data order, channelRules local, "
    + "AuthoritySocket.write on the prototype; GAME_MODULES first-load entry", () => {
    const server = readSource("_secondary/chat/server.js");
    assert.ok(server.includes("const { handleSocketForEdge } = require(\"../../services/chat/xmppStubServer\");"));
    const xmpp = readSource("services/chat/xmppStubServer.js");
    assert.ok(xmpp.includes("\n  handleSocketForEdge: handleSocket,\n"), "export");
    assert.ok(functionBody(xmpp, "sendXml").includes("const writable = client.socket.write(xml);"), "sendXml");
    assert.ok(functionBody(xmpp, "handleSocket").includes("const client = {\n    socket,\n"), "client.socket");
    assert.ok(xmpp.includes("`<presence from='${escapeXml(descriptor.normalizedRoomJid)}/${escapeXml(client.nick)}' "
      + "to='${escapeXml(client.boundJid)}' id='${escapeXml(requestId)}'>${buildEveUserDataElement(userData)}"), "self-110");
    assert.ok(xmpp.includes("role='${escapeXml(getRoleForCharacter(roomRecord, charId))}' jid='${escapeXml(client.boundJid)}'/>"
      + "<status code='110'/></x></presence>`"));
    const selfOff = functionBody(xmpp, "buildSelfUnavailablePresenceXml");
    assert.ok(selfOff.includes("\" type='unavailable'>\"") && selfOff.includes("<status code='110'/>"), "self-off");
    const occupant = functionBody(xmpp, "buildRoomPresenceXml");
    for (const t of ["`<presence from='${escapeXml(roomJid)}/${escapeXml(nick)}'`", "` to='${escapeXml(recipient.boundJid)}'`",
      "const userJid = buildXmppUserJid(nick);", "\" type='unavailable'\"",
      "<item affiliation='${escapeXml(affiliation)}' role='${escapeXml(itemRole)}' jid='${escapeXml(userJid)}'/></x></presence>`",
      "const itemRole = available ? getRoleForCharacter(record, charId) : \"none\";", "const affiliation = options.affiliation || \"member\";"]) {
      assert.ok(occupant.includes(t), t);
    }
    const leave = functionBody(xmpp, "sendLocalAdminLeave");
    assert.ok(leave.includes("cmd: \"leave\",") && leave.includes("charid: normalizedCharacterID,"), "admin leave");
    const message = functionBody(xmpp, "buildRoomMessageXml");
    for (const t of ["`<message from='${escapeXml(roomJid)}/${escapeXml(sender)}'`", "\" type='groupchat'\"",
      "`<body>${escapeXml(message)}</body>`"]) assert.ok(message.includes(t), t);
    assert.ok(functionBody(xmpp, "sendAdminCommand").includes("buildRoomMessageXml(roomJid, \"admin\", messageText"));
    const remove = functionBody(xmpp, "removeClientFromRoom");
    assert.ok(remove.indexOf("sendLocalAdminLeave(") < remove.indexOf("{ available: false }"), "leave, then unavailable");
    const leaveAt = remove.indexOf("sendLocalAdminLeave(normalizedRoomJid, charId, recipients);");
    const offAt = remove.indexOf("buildRoomPresenceXml(normalizedRoomJid, charId, recipient, { available: false })");
    assert.ok(leaveAt > 0 && offAt > leaveAt, `removeClientFromRoom order ${leaveAt} ${offAt}`);
    const userData = functionBody(xmpp, "buildEveUserDataElement");
    const order = ["` info='", "` corpid='", "` role='", "` warfactionid='", "` allianceid='"]
      .map((a) => userData.indexOf(a));
    assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])), `order ${order}`);
    const info = functionBody(xmpp, "buildOwnerInfo");
    for (const t of ["Number(charData.typeID || 1373)", "Boolean(Number(genderValue))", "charData.ownerNameID ?? null",
      "charData.gender ?? charData.genderID ?? null"]) assert.ok(info.includes(t), t);
    assert.strictEqual((xmpp.match(/<status code='110'\/>/g) || []).length, 2, "two self-110 templates");
    const jid = readSource("services/chat/xmppConfig.js");
    assert.ok(functionBody(jid, "buildXmppUserJid").includes("`${String(userName || \"\").trim()}@${getXmppDomain()}`"));
    const rules = readSource("services/chat/channelRules.js");
    assert.ok(rules.includes("const LOCAL_CHAT_CATEGORY_LOCAL = \"local\";"));
    assert.ok(rules.includes("(local|wormhole|triglavian|nullsec|nolocal)_"), "channelRules room categories");
    assert.ok(functionBody(rules, "getLocalChatRoomNameForSolarSystemID").includes("return `${category}_${normalizedSolarSystemID}`;"));
    const bridge = readSource("edge/chat/chatSocketAuthorityBridge.js");
    const cls = bridge.slice(bridge.indexOf("class AuthoritySocket extends EventEmitter {"));
    assert.ok(cls.length > 0 && /\n {4}write\(data\) \{/.test(cls.slice(0, cls.indexOf("\n  }\n"))), "prototype write");

    const entries = GAME_MODULES.filter((e) => e.path === "services/chat/xmppStubServer")
      .flatMap((e) => e.symbols.filter((s) => s.name === "handleSocketForEdge"));
    assert.strictEqual(entries.length, 1);
    assert.deepStrictEqual([entries[0].firstLoad, entries[0].wrap, [...entries[0].consumers]],
      [true, undefined, ["localPilots", "shipAi"]]);
    const loaderSource = fs.readFileSync(path.join(__dirname, "..", "..", "loader.js"), "utf8");
    assert.ok(loaderSource.includes("request.includes(\"xmppStubServer\")"), "loader.js literal \"xmppStubServer\"");
  });

  test("LPX8: local_A tracked -> self-available wormhole_30100000 (Zarzakh) = admin leave "
    + "+ unavailable of the old pilots, no entry, no injection for the wormhole room", () => {
    try {
      const { socket } = setup();
      tap.syncSystem(SYSTEM, [pilot(A), pilot(B)]);
      tap.syncSystem(30100000, [pilot(C)]);
      socket.write(selfPresence(ROOM));
      socket.log.length = 0;
      const zarzakh = selfPresence("wormhole_30100000@conference.d");
      assert.strictEqual(socket.write(zarzakh), true);
      assert.strictEqual(socket.log.length, 2, "vendor stanza + one batch of ours");
      assert.strictEqual(socket.log[0], zarzakh, "vendor stanza unchanged");
      assert.deepStrictEqual(stanzaKinds(socket.log[1]), [["leave", A], ["unavailable", A], ["leave", B],
        ["unavailable", B]]);
      assert.ok(presences(socket.log[1]).every((p) => p[1].startsWith(`${ROOM}/`)), "the old room");
      const st = tap.getState();
      assert.deepStrictEqual([st.sockets, st.shown, st.rooms, st.leftRooms], [0, 0, 0, 1]);
      socket.log.length = 0;
      tap.syncSystem(30100000, [pilot(C), pilot(A)]);
      assert.deepStrictEqual(socket.log, [], "no injection for Zarzakh");
    } finally {
      tap._resetForTest();
    }
  });

  test("LPX9: one character on two sockets, S1 tracks local_A, S2 self-available local_B -> S1 "
    + "gets leave + unavailable of A, twinsClosed 1; reassert writes only on S2; the same room on both stays", () => {
    try {
      const NICK = "140000008";
      const { xmppExports, socket: s1 } = setup();
      const s2 = new FakeSocket();
      xmppExports.handleSocketForEdge(s2);
      tap.syncSystem(SYSTEM, [pilot(A)]);
      tap.syncSystem(OTHER, [pilot(C)]);
      s1.write(selfPresence(ROOM, true, NICK));
      s1.log.length = 0;
      s2.write(selfPresence(ROOM_B, true, NICK));
      assert.strictEqual(s1.log.length, 1);
      assert.deepStrictEqual(stanzaKinds(s1.log[0]), [["leave", A], ["unavailable", A]]);
      assert.ok(presences(s1.log[0])[0][1].startsWith(`${ROOM}/`));
      let st = tap.getState();
      assert.deepStrictEqual([st.sockets, st.rooms, st.twinsClosed], [1, 1, 1]);
      s1.log.length = 0;
      s2.log.length = 0;
      assert.deepStrictEqual(tap.reassert(512), { ok: true, stanzas: 1, sockets: 1 });
      assert.deepStrictEqual([s1.log.length, presences(s2.log[0])], [0, [["available", `${ROOM_B}/${C}`, `${C}@d`]]]);

      s1.write(selfPresence(ROOM_B, true, NICK));
      st = tap.getState();
      assert.deepStrictEqual([st.sockets, st.rooms, st.twinsClosed], [2, 1, 1]);
    } finally {
      tap._resetForTest();
    }
  });

  test("CH3 highsec life: sendOccupantMessage = one groupchat stanza from room/<charId> with XML escaping "
    + "only to the Local sockets of that system that show the pilot; NOT_OCCUPANT / NO_SOCKET / destroyed socket "
    + "without a throw; seam sendOccupantMessage", () => {
    try {
      const JITA = 30000142;
      const PERI = 30000144;
      const roomJ = `local_${JITA}@conference.d`;
      const roomP = `local_${PERI}@conference.d`;
      const { xmppExports, socket: s1 } = setup();
      const s2 = new FakeSocket();
      const s3 = new FakeSocket();
      xmppExports.handleSocketForEdge(s2);
      xmppExports.handleSocketForEdge(s3);
      tap.syncSystem(JITA, [pilot(A), pilot(B)]);
      tap.syncSystem(PERI, [pilot(A)]);
      s1.write(selfPresence(roomJ));
      s2.write(selfPresence(roomJ, true, String(A)));
      s3.write(selfPresence(roomP, true, "9002"));
      for (const s of [s1, s2, s3]) s.log.length = 0;
      const id = tap.getState().sent + 1;
      assert.deepStrictEqual(tap.sendOccupantMessage({ systemId: JITA, characterId: A, text: "a<b & 'c'" }),
        { ok: true, sockets: 1 });
      assert.deepStrictEqual(s1.log, [`<message from='${roomJ}/${A}' to='${BOUND}' type='groupchat' id='lne-lp-${id}'>`
        + "<body>a&lt;b &amp; &apos;c&apos;</body></message>"]);
      assert.deepStrictEqual([s2.log, s3.log], [[], []], "the pilot himself and another system: nothing");
      assert.deepStrictEqual(tap.sendOccupantMessage({ systemId: JITA, characterId: C, text: "x" }),
        { ok: false, reason: "NOT_OCCUPANT" });
      tap.syncSystem(30000145, [pilot(C)]);
      assert.deepStrictEqual(tap.sendOccupantMessage({ systemId: 30000145, characterId: C, text: "x" }),
        { ok: false, reason: "NO_SOCKET" });
      assert.deepStrictEqual(tap.sendOccupantMessage({ systemId: JITA, characterId: A, text: "" }),
        { ok: false, reason: "BAD_INPUT" });
      s1.destroyed = true;
      assert.deepStrictEqual(tap.sendOccupantMessage({ systemId: JITA, characterId: A, text: "y" }),
        { ok: false, reason: "NO_SOCKET" });
      assert.strictEqual(s1.log.length, 1, "destroyed: zero writes");
      const st = tap.getState();
      assert.deepStrictEqual([st.sockets, st.chatSent, st.chatRefused], [2, 1, 4], "destroyed entry dropped");

      localPilots._resetForTest();
      const seam = localPilots.createLocalPilotsSeam({ requireGame: () => ({ ok: false, reason: "x" }) });
      assert.strictEqual(typeof seam.sendOccupantMessage, "function");
      assert.deepStrictEqual(seam.sendOccupantMessage({ systemId: PERI, characterId: A, text: "hi" }),
        { ok: true, sockets: 1 });
      const real = tap.sendOccupantMessage;
      tap.sendOccupantMessage = () => { throw new Error("boom"); };
      try {
        assert.deepStrictEqual(seam.sendOccupantMessage({ systemId: PERI, characterId: A, text: "hi" }),
          { ok: false, reason: "SEND_FAILED" });
      } finally {
        tap.sendOccupantMessage = real;
      }
      tap._resetForTest();
      assert.deepStrictEqual(seam.sendOccupantMessage({ systemId: PERI, characterId: A, text: "hi" }),
        { ok: false, reason: "NOT_INSTALLED" });
    } finally {
      tap._resetForTest();
      localPilots._resetForTest();
    }
  });

  test("CH4 vendor facts (highsec life): buildRoomMessageXml signature and stanza, groupchat, body escaping "
    + "deliverRoomMessage with the sender characterID of a player line", () => {
    const xmpp = readSource("services/chat/xmppStubServer.js");
    for (const t of ["function buildRoomMessageXml(roomJid, sender, message, recipient",
      "`<message from='${escapeXml(roomJid)}/${escapeXml(sender)}'`", "\" type='groupchat'\"",
      "<body>${escapeXml(message)}</body>", "deliverRoomMessage(roomJid, senderCharacterId, body"]) {
      assert.ok(xmpp.includes(t), t);
    }
    const esc = functionBody(xmpp, "escapeXml");
    const order = ["&amp;", "&lt;", "&gt;", "&quot;", "&apos;"].map((e) => esc.indexOf(e));
    assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])), `escapeXml order ${order}`);
  });

  test("LPX7: bridge release(key,'error') (destroyed, error, no close) -> entry gone; a destroyed socket in a "
    + "system without pilots is dropped by inject on an empty list; a fault in the seam syncXmpp -> errors++", () => {
    try {
      const { socket } = setup();
      socket.write(selfPresence(ROOM));
      assert.strictEqual(tap.getState().sockets, 1, "tracked with an empty roster");
      socket.destroyed = true;
      socket.emit("error", new Error("edge write failed"));
      assert.strictEqual(tap.getState().sockets, 0, "error without close -> untracked");

      const second = setup();
      second.socket.write(selfPresence(ROOM));
      second.socket.destroyed = true;
      second.socket.log.length = 0;
      assert.deepStrictEqual(tap.syncSystem(SYSTEM, []), { ok: true, sockets: 0, added: 0, removed: 0 });
      assert.deepStrictEqual([second.socket.log, tap.getState().sockets], [[], 0], "empty list, destroyed -> dropped");

      setup();
      localPilots._resetForTest();
      localPilots.install({ on: () => {} });
      const seam = localPilots.createLocalPilotsSeam({ requireGame: () => ({ ok: true,
        exports: { peekCharacterRecord: () => record(A, 98000001) } }) });
      const before = tap.getState().errors;
      const real = tap.syncSystem;
      tap.syncSystem = () => { throw new Error("tap boom"); };
      try {
        assert.deepStrictEqual(seam.setRoster(SYSTEM, [{ character: { sequential: A } }]), { ok: true, size: 1 });
      } finally {
        tap.syncSystem = real;
      }
      assert.strictEqual(tap.getState().errors, before + 1, "Counted");
    } finally {
      tap._resetForTest();
      localPilots._resetForTest();
    }
  });
};
