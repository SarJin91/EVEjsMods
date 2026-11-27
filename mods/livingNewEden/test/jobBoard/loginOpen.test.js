"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const { loadDriver, withStore } = require("../notices/storeHelper");
const { MIGRATIONS } = require("../../lib/persistence/migrations");
const { TABLE_POLICY, ACTION } = require("../../lib/persistence/worldReset");
const { registerClientServiceWith } = require("../../lib/adapter/clientService");
const { startJobBoard, createUnavailableJobBoard, FACADE_METHODS } = require("../../lib/jobBoard");
const S = require("../../lib/shipAi/schema");
const { createVoiceQueue } = require("../../lib/shipAi/voice/queue");
const { createVoiceRoutes } = require("../../lib/shipAi/voice/routes");
const { createSessions } = require("../../lib/modSettings/web/sessions");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SRC = path.resolve(MOD_DIR, "..", "..", "server", "src");
const AT = Date.UTC(2026, 10, 16, 12, 0, 0);
const CHAR = 90000001;
const OTHER = 90000002;
const ORIGIN = "http://127.0.0.1:26410";
const OPEN = "OnLneBoardOpen";

function configOf(env = {}) {
  const r = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_JOB_BOARD_ENABLED: "1", ...env } });
  assert.ok(r.ok, JSON.stringify(r.errors));
  return r.config;
}

function fakeTimers() {
  const list = [];
  return { list, setTimer: (fn, ms) => {
    const t = { fn, ms, cancelled: false, cancel() {
      t.cancelled = true;
    } };
    list.push(t);
    return t;
  }, fireAll: () => {
    for (const t of list.splice(0)) if (!t.cancelled) t.fn();
  } };
}

function fakeAdapter() {
  const adapter = {
    handlers: null, chat: null, notify: [],
    boardHookState: () => ({ status: "WRAPPED" }),
    publishBoardDelivery: () => ({ ok: true, bytes: 1, delivery: { setReady() {},
      stats: () => ({ ready: true, composed: 0, skipped: 0 }) } }),
    withdrawBoardDelivery: () => ({ ok: true }),
    registerClientService(_world, spec) {
      adapter.handlers = spec.handlers;
      return { ok: true, unregister() {} };
    },
    sendClientNotification(characterId, type) {
      adapter.notify.push([characterId, type]);
      return { ok: true };
    },
    installChatCommand(opts) {
      adapter.chat = opts;
      return { ok: true };
    },
    uninstallChatCommand: () => ({ ok: true }),
    readFactionNames: () => ({ ok: true, names: new Map() }),
  };
  return adapter;
}

function boardOn(store, clock, timers, env) {
  const adapter = fakeAdapter();
  const r = startJobBoard({ config: configOf(env), ctx: { persistence: { ok: true, store },
    governor: { admits: () => true } }, adapter, clock, world: {}, setTimer: timers.setTimer });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  return { jb: r.jobBoard, adapter };
}

const prefRows = (store) => {
  const r = store.transaction("t", (db) => db.prepare("SELECT character_id, open_at_login FROM job_board_prefs "
    + "ORDER BY character_id").all().map((row) => [Number(row.character_id), Number(row.open_at_login)]));
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
};

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("JA1 window at login: one OnLneBoardOpen per new session token after the delay; poll, UNSUPPORTED_BUILD, "
    + "off, no row, off while PENDING, stop, openAtLoginEnabled=false -> nothing", () => withStore(driver, ({ store }) => {
    let now = AT;
    const clock = { now: () => now };
    const timers = fakeTimers();
    const { jb, adapter } = boardOn(store, clock, timers);
    const { Report, GetBoard } = adapter.handlers;
    const report = (session, items = ["win=1"], characterId = CHAR) => Report({ characterId, systemId: null,
      args: [1, 3396210, items], badArgs: false, session });
    assert.deepStrictEqual(jb.applySwitch(CHAR, "openAtLogin", "on"), { ok: true, value: "on" });
    const s1 = Object.freeze({});
    report(s1);
    assert.deepStrictEqual(timers.list.map((t) => t.ms), [configOf().jobBoard.loginOpenDelayMs]);
    assert.strictEqual(configOf().jobBoard.loginOpenDelayMs, 3000);
    assert.deepStrictEqual(adapter.notify, [], "nothing before the delay");
    timers.fireAll();
    assert.deepStrictEqual(adapter.notify, [[CHAR, OPEN]]);
    now += 1000;
    report(s1);
    GetBoard({ characterId: CHAR, systemId: null, args: [], badArgs: false, session: s1 });
    assert.strictEqual(timers.list.length, 0);
    report(Object.freeze({}));
    timers.fireAll();
    assert.deepStrictEqual(adapter.notify, [[CHAR, OPEN], [CHAR, OPEN]]);
    report(Object.freeze({}), ["build=0:UNSUPPORTED_BUILD"]);
    report(Object.freeze({}), ["win=1"], OTHER);
    assert.deepStrictEqual(jb.applySwitch(OTHER, "openAtLogin", false), { ok: true, value: "off" });
    report(Object.freeze({}), ["win=1"], OTHER);
    report(null);
    assert.strictEqual(timers.list.length, 0);
    report(Object.freeze({}));
    assert.strictEqual(jb.getStatus().pendingOpens, 1);
    jb.applySwitch(CHAR, "openAtLogin", "off");
    assert.deepStrictEqual([timers.list[0].cancelled, jb.getStatus().pendingOpens], [true, 0]);
    timers.fireAll();
    jb.applySwitch(CHAR, "openAtLogin", "on");
    report(Object.freeze({}));
    const [pending] = timers.list.splice(0);
    jb.stop("test");
    assert.strictEqual(pending.cancelled, true);
    pending.fn();
    assert.deepStrictEqual(adapter.notify.length, 2);
    const c = jb.getStatus().counters;
    assert.deepStrictEqual([c.autoOpenScheduled, c.autoOpenSent, c.prefsWrites, jb.getStatus().login],
      [4, 2, 4, "on"]);
    const off = boardOn(store, clock, timers, { EVEJS_LNE_JOB_BOARD_OPEN_AT_LOGIN_ENABLED: "0" });
    off.adapter.handlers.Report({ characterId: CHAR, args: [1, 1, ["win=1"]], session: Object.freeze({}) });
    assert.deepStrictEqual([timers.list.length, off.jb.getStatus().login], [0, "off"]);
    off.jb.stop("test");
  }));

  needsDriver("JA2 preference: migration 102, `!board auto on|off` row, restart keeps it, `!board auto` = state line "
    + "without an open, reset KEEP, BAD_VALUE, stub keys", () => withStore(driver, ({ store }) => {
    assert.deepStrictEqual([MIGRATIONS[101].version, MIGRATIONS[101].name], [102, "job_board_prefs"]);
    assert.strictEqual(TABLE_POLICY.job_board_prefs, ACTION.KEEP);
    let now = AT;
    const clock = { now: () => now };
    const timers = fakeTimers();
    const first = boardOn(store, clock, timers);
    const say = (board, text) => {
      now += 1000;
      return board.adapter.chat.handle({ characterId: CHAR }, text);
    };
    assert.strictEqual(say(first, "!board auto"), "LNE board: window at login off");
    assert.strictEqual(say(first, "!board auto on"), "LNE board: window at login on");
    assert.deepStrictEqual(prefRows(store), [[CHAR, 1]]);
    first.jb.stop("test");
    const second = boardOn(store, clock, timers);
    assert.deepStrictEqual(second.jb.prefsOf(CHAR), { ok: true, openAtLogin: true, serverOn: true });
    assert.strictEqual(say(second, "!tablica auto OFF"), "LNE board: window at login off");
    assert.deepStrictEqual(prefRows(store), [[CHAR, 0]]);
    assert.strictEqual(say(second, "!board auto"), "LNE board: window at login off");
    assert.strictEqual(say(second, "!board auto maybe"), "LNE board: switch failed (BAD_VALUE)");
    assert.deepStrictEqual(second.adapter.notify, [], "!board auto never opens");
    assert.strictEqual(say(second, "!board"), "LNE board: opening window");
    assert.deepStrictEqual(second.adapter.notify, [[CHAR, OPEN]]);
    assert.deepStrictEqual(second.jb.applySwitch(CHAR, "x", "on"), { ok: false, reason: "BAD_VALUE" });
    assert.deepStrictEqual(second.jb.applySwitch(CHAR, "openAtLogin", "toggle"), { ok: false, reason: "BAD_VALUE" });
    assert.deepStrictEqual(second.jb.applySwitch(0, "openAtLogin", "on"), { ok: false, reason: "NO_CHARACTER" });
    second.jb.stop("test");
    assert.deepStrictEqual(second.jb.applySwitch(CHAR, "openAtLogin", "on"),
      { ok: false, reason: "JOB_BOARD_UNAVAILABLE" });
    const serverOff = boardOn(store, clock, timers, { EVEJS_LNE_JOB_BOARD_OPEN_AT_LOGIN_ENABLED: "0" });
    assert.strictEqual(say(serverOff, "!board auto"), "LNE board: window at login off - off on this server");
    serverOff.jb.stop("test");
    const stub = createUnavailableJobBoard("x");
    assert.deepStrictEqual(Object.keys(stub).sort(), [...FACADE_METHODS].sort());
    assert.deepStrictEqual([stub.prefsOf(CHAR).reason, stub.applySwitch(CHAR, "openAtLogin", "on").reason],
      ["JOB_BOARD_UNAVAILABLE", "JOB_BOARD_UNAVAILABLE"]);
  }));

  needsDriver("JA3 voice panel with the real jobBoard facade: boardOpenAtLogin = the path of `!board auto`, openBoard "
    + "-> one OnLneBoardOpen, the stub -> available false + 409 BOARD_UNAVAILABLE", () => withStore(driver, ({ store }) => {
    let now = AT;
    const clock = { now: () => now };
    const board = boardOn(store, clock, fakeTimers());
    const base = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_SHIP_AI_ENABLED: "1" } }).config;
    const V = { ...S.shipAiVoiceSettingsOf(base).settings };
    let n = 0;
    const bytes = (size) => Buffer.alloc(size, (n += 1) % 256);
    const sessions = createSessions({ linkTtlMs: V.voiceLinkTtlMs, sessionTtlMs: V.voiceSessionTtlMs,
      maxSessions: V.voiceMaxSessions, clock, randomBytes: bytes });
    let facade = board.jb;
    const route = createVoiceRoutes({ sessions, queue: createVoiceQueue({ S: V, nowMs: clock.now, randomBytes: bytes }),
      settingsOf: () => ({ aiName: "Jin", lang: "en-US", settings: {} }),
      panel: { S: V, nowMs: clock.now, stateOf: () => ({ paired: true }), applySwitch: () => ({ ok: false }),
        invite: () => ({ ok: false }), wing: null, board: () => facade } });
    const call = (method, name, body, headers) => {
      const res = { status: 0, body: "", writeHead(s) {
        res.status = s;
      }, end(b) {
        res.body = String(b || "");
      } };
      route.handle({ method, url: `/api/shipai/${name}`, headers: headers || {} }, res,
        body === undefined ? null : Buffer.from(JSON.stringify(body)));
      now += V.panelCooldownMs;
      return { status: res.status, json: res.body ? JSON.parse(res.body) : null };
    };
    const token = sessions.issueToken({ characterId: CHAR, characterName: "Pilot One" }).token;
    const h = { "x-lne-voice": call("POST", "session", { token }, { origin: ORIGIN }).json.sid, origin: ORIGIN };
    assert.deepStrictEqual(call("GET", "panel", undefined, h).json.panel.board,
      { available: true, openAtLogin: false, serverOn: true });
    const set = call("POST", "panel", { id: "boardOpenAtLogin", value: "on", characterId: OTHER }, h);
    assert.strictEqual(set.status, 200, JSON.stringify(set.json));
    assert.deepStrictEqual([set.json.value, set.json.panel.board.openAtLogin], ["on", true]);
    assert.deepStrictEqual(prefRows(store), [[CHAR, 1]], "the session character, the row of `!board auto on`");
    assert.strictEqual(board.adapter.chat.handle({ characterId: CHAR }, "!board auto"), "LNE board: window at login on");
    const act = call("POST", "panel/action", { id: "openBoard" }, h);
    assert.deepStrictEqual([act.status, board.adapter.notify], [200, [[CHAR, OPEN]]]);
    assert.strictEqual(call("POST", "panel", { id: "boardOpenAtLogin", value: 3 }, h).status, 400);
    board.jb.stop("test");
    facade = createUnavailableJobBoard("JOB_BOARD_UNAVAILABLE", "stopped");
    assert.deepStrictEqual(call("GET", "panel", undefined, h).json.panel.board, { available: false });
    for (const [name, body] of [["panel", { id: "boardOpenAtLogin", value: "off" }],
      ["panel/action", { id: "openBoard" }]]) {
      const r = call("POST", name, body, h);
      assert.deepStrictEqual([r.status, r.json.reason], [409, "BOARD_UNAVAILABLE"]);
    }
    assert.deepStrictEqual(prefRows(store), [[CHAR, 1]]);
  }));

  test("JA4 vendor facts + adapter session token: one token per (session object, character), frozen, no keys, "
    + "non-object -> null", () => {
    if (fs.existsSync(path.join(SRC, "services", "baseService.js"))) {
      const read = (...rel) => fs.readFileSync(path.join(SRC, ...rel), "utf8");
      assert.ok(read("network", "tcp", "index.js").includes("new ClientSession("), "new ClientSession(");
      assert.ok(read("services", "baseService.js").includes("callMethod(method, args, session"), "callMethod");
    }
    class FakeBase {
      constructor(name) {
        this.name = name;
      }

      callMethod() {}
    }
    const services = new Map();
    const world = { serviceManager: { register: (s) => services.set(s.name, s), lookup: (x) => services.get(x) } };
    const seen = [];
    const reg = registerClientServiceWith(FakeBase, world, { name: "lneBoardSvc", handlers: {
      GetBoard: (req) => {
        seen.push(req.session);
        return { v: 1, who: req.characterId };
      } } });
    assert.strictEqual(reg.ok, true, JSON.stringify(reg));
    const svc = services.get("lneBoardSvc");
    const getBoard = (session) => svc[`Handle_${"GetBoard"}`]([], session);
    const a = { charid: CHAR };
    const b = { charid: CHAR };
    assert.deepStrictEqual(getBoard(a), { type: "dict", entries: [["v", 1], ["who", CHAR]] });
    getBoard(a);
    getBoard(b);
    a.charid = OTHER;
    getBoard(a);
    a.charid = CHAR;
    getBoard(a);
    getBoard(undefined);
    assert.strictEqual(seen[0], seen[1], "the same session and character");
    assert.notStrictEqual(seen[2], seen[0], "another session object");
    assert.notStrictEqual(seen[3], seen[0], "another character on the same session");
    assert.ok(seen[4] !== seen[0] && seen[4] !== seen[3], "A -> B -> A = a new login of A");
    assert.ok(seen.slice(0, 5).every((t) => Object.isFrozen(t) && Object.keys(t).length === 0 && t !== a && t !== b));
    assert.strictEqual(seen[5], null, "a non-object session");
  });
};
