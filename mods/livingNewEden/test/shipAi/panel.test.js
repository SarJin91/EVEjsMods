"use strict";

const assert = require("node:assert");

const { resolveConfig } = require("../../config");
const S = require("../../lib/shipAi/schema");
const { createVoiceQueue } = require("../../lib/shipAi/voice/queue");
const { createVoiceRoutes } = require("../../lib/shipAi/voice/routes");
const { createSessions } = require("../../lib/modSettings/web/sessions");
const { createHttpRoutes } = require("../../lib/observer/httpRoutes");
const { createShipAiPrefsRepository } = require("../../lib/shipAi/prefsRepository");
const { createShipAiAutostart } = require("../../lib/shipAi/autostart");
const { startShipAi } = require("../../lib/shipAi");
const { createShipWingUi, SHIP_WING_UI_KEY } = require("../../lib/adapter/shipWingUi");
const { createAdapter } = require("../../lib/adapter");
const SH = require("../notices/storeHelper");

const path = require("node:path");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const PLAYER = 9001;
const OTHER = 9002;
const AI = 91000001;
const JITA = 30000142;
const T0 = 1700000000000;
const KEY = "test-key-not-real-0123";
const XMPP = { transport: "xmpp" };
const ORIGIN = "http://127.0.0.1:26410";

const base = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_SHIP_AI_ENABLED: "1" } }).config;
const V = { ...S.shipAiVoiceSettingsOf(base).settings };

const mutableClock = () => {
  let now = T0;
  return { now: () => now, advance: (ms) => { now += ms; } };
};
const counterBytes = () => {
  let n = 0;
  return (size) => {
    n += 1;
    return Buffer.alloc(size, n % 256);
  };
};

function fakeRes() {
  return { writes: 0, status: 0, body: "", writeHead(status) {
    this.writes += 1;
    this.status = status;
  }, end(body) {
    this.body = String(body || "");
  }, json() {
    return JSON.parse(this.body);
  } };
}

function call(route, method, url, opts = {}) {
  const res = fakeRes();
  route.handle({ method, url, headers: opts.headers || {} }, res, opts.body === undefined ? null
    : Buffer.from(JSON.stringify(opts.body)));
  return res;
}

function fakeWingApi() {
  const calls = [];
  const prefs = new Map();
  return { calls, api: { version: 1,
    get: (charId) => {
      calls.push(["get", charId]);
      return { ok: true, openAtLogin: prefs.get(charId) === true };
    },
    set: (charId, on) => {
      calls.push(["set", charId, on]);
      prefs.set(charId, on);
      return { ok: true, openAtLogin: on, persisted: true };
    },
    open: (charId) => {
      calls.push(["open", charId]);
      return { ok: false, reason: "CLIENT_NOT_READY" };
    } } };
}

function panelRig(globalObj, over = {}) {
  const clock = mutableClock();
  const sessions = createSessions({ linkTtlMs: V.voiceLinkTtlMs, sessionTtlMs: V.voiceSessionTtlMs,
    maxSessions: V.voiceMaxSessions, clock, randomBytes: counterBytes() });
  const queue = createVoiceQueue({ S: V, nowMs: clock.now, randomBytes: counterBytes() });
  const switches = new Map();
  const r = { clock, switches, invites: [] };
  r.route = createVoiceRoutes({ sessions, queue, settingsOf: () => ({ aiName: "Jin", lang: "en-US", settings: {} }),
    panel: { S: { ...V, ...(over.S || {}) }, nowMs: clock.now,
      stateOf: (playerId) => ({ paired: true, alerts: switches.get(`${playerId}:alerts`) || "on" }),
      applySwitch: (playerId, id, value) => {
        switches.set(`${playerId}:${id}`, value);
        return { ok: true, value };
      },
      invite: (playerId) => {
        r.invites.push(playerId);
        return { ok: false, reason: "NO_CLIENT" };
      },
      wing: createShipWingUi({ globalObj }) } });
  const token = sessions.issueToken({ characterId: PLAYER, characterName: "Pilot One" }).token;
  const opened = call(r.route, "POST", "/api/shipai/session", { body: { token }, headers: { origin: ORIGIN } });
  r.headers = { "x-lne-voice": opened.json().sid, origin: ORIGIN };
  r.post = (name, body, headers) => {
    const res = call(r.route, "POST", `/api/shipai/${name}`, { body, headers: headers || r.headers });
    clock.advance(V.panelCooldownMs);
    return res;
  };
  return r;
}

module.exports = ({ test, skip }) => {
  const driver = SH.loadDriver();
  const cmp1 = "CMP1 applySwitch = command: !ai alerts off and POST panel alerts off leave the same row; GET panel "
    + "without the ShipWing API = wing.available false; config panelEnabled true / panelCooldownMs 1000";
  if (!driver.ok) skip(cmp1, `better-sqlite3 unavailable (${driver.detail})`);
  else {
    test(cmp1, () => SH.withStoreAsync(driver, async (persistence) => {
      assert.deepStrictEqual([V.panelEnabled, V.panelCooldownMs], [true, 1000]);
      const { store } = persistence;
      const tx = (fn) => {
        const r = store.transaction("t.panel", fn);
        assert.ok(r.ok, JSON.stringify(r));
        return r.value;
      };
      const repo = createShipAiPrefsRepository();
      const rowOf = () => {
        const { version, updatedAt, ...rest } = tx((db) => repo.getByPlayer(db, PLAYER)).row;
        return { rest, version };
      };
      assert.ok(tx((db) => repo.insert(db, { playerId: PLAYER, aiId: AI, name: "Jin", nowMs: 1000 })).ok);
      const clock = mutableClock();
      const httpRoutes = createHttpRoutes();
      const adapter = { shipAiSeams: () => ({ ok: true, seam: { identities: {
        corporationExists: () => ({ ok: true, exists: true }), writeCharacter: () => ({ ok: true }),
        flush: () => ({ ok: true }) }, xmpp: {}, channel: () => null } }),
      installChatCommand: () => ({ ok: true }), uninstallChatCommand: () => ({ ok: true }),
      readPresence: () => ({ ok: true, characters: [] }), sendCharacterSystemLine: () => ({ ok: true }),
      readStaticMap: () => ({ ok: false, reason: "TEST" }), shipWingUi: () => createShipWingUi({ globalObj: {} }) };
      const config = { ...base, observer: { ...base.observer, enabled: true, port: 26410 },
        inGameMap: { ...(base.inGameMap || {}), observerUrl: "" },
        shipAi: { ...base.shipAi, channel: "local", allowCharacterIds: "*", apiKey: KEY, minIntervalMs: 0,
          toolMode: "off", memoryEnabled: false, proactiveEnabled: false, mailEnabled: false, portraitEnabled: false,
          voiceEnabled: true, autostartEnabled: false } };
      const started = startShipAi({ config, persistence, adapter, clock, httpRoutes, randomBytes: counterBytes(),
        transport: { post: () => new Promise(() => {}) }, setTimer: () => ({ cancel() {}, hasRef: () => false }) });
      assert.strictEqual(started.ok, true, JSON.stringify(started));
      const ai = started.shipAi;
      const say = (text) => ai.handle({ characterId: PLAYER, name: "Pilot One", systemId: JITA }, text, XMPP);
      const m = /#t=([A-Za-z0-9_-]{43})"/.exec(say("!ai voice"));
      assert.ok(m, "voice link");
      const route = httpRoutes.match("/api/shipai/session");
      const opened = call(route, "POST", "/api/shipai/session", { body: { token: m[1] }, headers: { origin: ORIGIN } });
      const headers = { "x-lne-voice": opened.json().sid, origin: ORIGIN };

      const v0 = rowOf().version;
      const byCommand = say("!ai alerts off");
      const afterCommand = rowOf();
      assert.deepStrictEqual([afterCommand.rest.calloutMode, afterCommand.version], ["off", v0 + 1], byCommand);
      say("!ai alerts on");
      assert.strictEqual(rowOf().rest.calloutMode, "on");
      const posted = call(route, "POST", "/api/shipai/panel", { body: { id: "alerts", value: "off",
        characterId: OTHER }, headers });
      assert.strictEqual(posted.status, 200, posted.body);
      const afterPost = rowOf();
      assert.deepStrictEqual(afterPost.rest, afterCommand.rest, "the same row by the command and by the panel");
      assert.deepStrictEqual([afterPost.version, posted.json().value, posted.json().panel.alerts], [v0 + 3, "off",
        "off"]);
      const got = call(route, "GET", "/api/shipai/panel", { headers });
      assert.strictEqual(got.status, 200, got.body);
      const view = got.json().panel;
      assert.deepStrictEqual([view.paired, view.alerts, view.scan, view.quiet, view.mail, view.autoRoom, view.wing],
        [true, "off", "on", "off", null, "off", { available: false }]);
      ai.stop("test");
    }));

    test("CMP5 debt-sweep: startShipAi getJobBoard -> GET panel board.available true (prefsOf of the facade); "
      + "without getJobBoard -> board.available false", () => SH.withStoreAsync(driver, async (persistence) => {
      const { store } = persistence;
      const r0 = store.transaction("t.panel5", (db) => createShipAiPrefsRepository().insert(db, { playerId: PLAYER,
        aiId: AI, name: "Jin", nowMs: 1000 }));
      assert.ok(r0.ok && r0.value.ok, JSON.stringify(r0));
      const asked = [];
      const facade = { getStatus: () => ({ state: "running" }), open: () => ({ ok: true }),
        applySwitch: () => ({ ok: true }), prefsOf: (id) => {
          asked.push(id);
          return { ok: true, openAtLogin: true, serverOn: false };
        } };
      const adapter = { shipAiSeams: () => ({ ok: true, seam: { identities: {
        corporationExists: () => ({ ok: true, exists: true }), writeCharacter: () => ({ ok: true }),
        flush: () => ({ ok: true }) }, xmpp: {}, channel: () => null } }),
      installChatCommand: () => ({ ok: true }), uninstallChatCommand: () => ({ ok: true }),
      readPresence: () => ({ ok: true, characters: [] }), sendCharacterSystemLine: () => ({ ok: true }),
      readStaticMap: () => ({ ok: false, reason: "TEST" }) };
      const config = { ...base, observer: { ...base.observer, enabled: true, port: 26410 },
        inGameMap: { ...(base.inGameMap || {}), observerUrl: "" },
        shipAi: { ...base.shipAi, channel: "local", allowCharacterIds: "*", apiKey: KEY, minIntervalMs: 0,
          toolMode: "off", memoryEnabled: false, proactiveEnabled: false, mailEnabled: false, portraitEnabled: false,
          voiceEnabled: true, autostartEnabled: false } };
      const boardOf = (extra) => {
        const httpRoutes = createHttpRoutes();
        const started = startShipAi({ config, persistence, adapter, clock: mutableClock(), httpRoutes,
          randomBytes: counterBytes(), transport: { post: () => new Promise(() => {}) },
          setTimer: () => ({ cancel() {}, hasRef: () => false }), ...extra });
        assert.strictEqual(started.ok, true, JSON.stringify(started));
        const ai = started.shipAi;
        try {
          const m = /#t=([A-Za-z0-9_-]{43})"/.exec(ai.handle({ characterId: PLAYER, name: "Pilot One",
            systemId: JITA }, "!ai voice", XMPP));
          assert.ok(m, "voice link");
          const route = httpRoutes.match("/api/shipai/session");
          const opened = call(route, "POST", "/api/shipai/session", { body: { token: m[1] },
            headers: { origin: ORIGIN } });
          const got = call(route, "GET", "/api/shipai/panel", { headers: { "x-lne-voice": opened.json().sid,
            origin: ORIGIN } });
          assert.strictEqual(got.status, 200, got.body);
          return got.json().panel.board;
        } finally {
          ai.stop("test");
        }
      };
      assert.deepStrictEqual(boardOf({ getJobBoard: () => facade }),
        { available: true, openAtLogin: true, serverOn: false });
      assert.deepStrictEqual(asked, [PLAYER]);
      assert.deepStrictEqual(boardOf({}), { available: false });
    }));
  }

  test("CMP2 routes with a fake ShipWing API: GET reads get(), POST wingOpenAtLogin = set() of the session "
    + "character, openWing / inviteRoom return the code of the result, a switch goes to applySwitch", () => {
    const wing = fakeWingApi();
    const globalObj = { [SHIP_WING_UI_KEY]: wing.api };
    const r = panelRig(globalObj);
    const got = call(r.route, "GET", "/api/shipai/panel", { headers: r.headers });
    assert.deepStrictEqual([got.status, got.json().panel.wing], [200, { available: true, openAtLogin: false }]);
    const set = r.post("panel", { id: "wingOpenAtLogin", value: "on", characterId: OTHER });
    assert.strictEqual(set.status, 200, set.body);
    assert.deepStrictEqual([set.json().value, set.json().panel.wing.openAtLogin], ["on", true]);
    assert.deepStrictEqual(wing.calls.filter((c) => c[0] === "set"), [["set", PLAYER, true]]);
    const sw = r.post("panel", { id: "alerts", value: "off" });
    assert.deepStrictEqual([sw.status, r.switches.get(`${PLAYER}:alerts`), sw.json().panel.alerts], [200, "off", "off"]);
    const open = r.post("panel/action", { id: "openWing" });
    assert.deepStrictEqual([open.status, open.json().reason, open.json().id], [409, "CLIENT_NOT_READY", "openWing"]);
    const inv = r.post("panel/action", { id: "inviteRoom" });
    assert.deepStrictEqual([inv.status, inv.json().reason, r.invites], [409, "NO_CLIENT", [PLAYER]]);
    assert.deepStrictEqual([r.post("panel/action", { id: "nuke" }).status, r.post("panel", { value: 1 }).status,
      r.post("panel", { id: "wingOpenAtLogin", value: 7 }).status], [400, 400, 400]);
    delete globalObj[SHIP_WING_UI_KEY];
    assert.deepStrictEqual(call(r.route, "GET", "/api/shipai/panel", { headers: r.headers }).json().panel.wing,
      { available: false });
    const gone = r.post("panel", { id: "wingOpenAtLogin", value: "off" });
    assert.deepStrictEqual([gone.status, gone.json().reason], [409, "WING_UNAVAILABLE"]);
    const st = r.route.status().panel;
    assert.deepStrictEqual([st.reads, st.writes, st.actions, st.refused_WING_UNAVAILABLE], [2, 2, 2, 1]);
  });

  test("CMP3 adapter shipWingUi: missing key / version 2 / missing function = available false (WING_UNAVAILABLE), "
    + "a throw = WING_FAILED, BAD_ID, a foreign reason as a code, the real adapter returns the facade", () => {
    const wing = fakeWingApi();
    const cases = [{}, { [SHIP_WING_UI_KEY]: { ...wing.api, version: 2 } },
      { [SHIP_WING_UI_KEY]: { version: 1, get: wing.api.get, set: wing.api.set } }, { [SHIP_WING_UI_KEY]: "x" }];
    for (const globalObj of cases) {
      const ui = createShipWingUi({ globalObj });
      assert.strictEqual(ui.available(), false);
      for (const r of [ui.get(PLAYER), ui.set(PLAYER, true), ui.open(PLAYER)]) {
        assert.deepStrictEqual(r, { ok: false, available: false, reason: "WING_UNAVAILABLE" });
      }
    }
    const boom = () => {
      throw new Error("foreign");
    };
    const thrower = createShipWingUi({ globalObj: { [SHIP_WING_UI_KEY]: { version: 1, get: boom, set: boom,
      open: boom } } });
    assert.deepStrictEqual([thrower.available(), thrower.get(PLAYER), thrower.open(PLAYER).reason],
      [true, { ok: false, available: true, reason: "WING_FAILED" }, "WING_FAILED"]);
    const odd = createShipWingUi({ globalObj: { [SHIP_WING_UI_KEY]: { version: 1, get: () => null,
      set: () => ({ ok: false, reason: "FULL <x>" }), open: () => ({ ok: true }) } } });
    assert.deepStrictEqual([odd.get(PLAYER).reason, odd.set(PLAYER, true).reason, odd.open(PLAYER), odd.get(0).reason],
      ["WING_FAILED", "FULL__x_", { ok: true, available: true }, "BAD_ID"]);
    const live = createAdapter({ moduleApi: { _cache: {} } });
    assert.strictEqual(typeof live.shipWingUi, "function");
    assert.deepStrictEqual(Object.keys(live.shipWingUi()).sort(), ["available", "get", "open", "set"]);
  });

  test("CMP4 Origin 403, no session 401, panelCooldownMs 429 with waitMs, panelEnabled false = 404: "
    + "autostart.forget makes an online character with a DONE entry a fresh sight", () => {
    const r = panelRig({});
    assert.strictEqual(call(r.route, "GET", "/api/shipai/panel").status, 401);
    assert.strictEqual(call(r.route, "POST", "/api/shipai/panel", { body: { id: "alerts", value: "on" },
      headers: { ...r.headers, origin: "http://evil.example" } }).status, 403);
    const first = call(r.route, "POST", "/api/shipai/panel", { body: { id: "alerts", value: "on" },
      headers: r.headers });
    const second = call(r.route, "POST", "/api/shipai/panel/action", { body: { id: "inviteRoom" },
      headers: r.headers });
    assert.deepStrictEqual([first.status, second.status, second.json().reason, second.json().waitMs > 0],
      [200, 429, "RATE_LIMITED", true]);
    assert.strictEqual(call(r.route, "PUT", "/api/shipai/panel", { headers: r.headers }).status, 405);
    const off = panelRig({}, { S: { panelEnabled: false } });
    assert.deepStrictEqual([call(off.route, "GET", "/api/shipai/panel", { headers: off.headers }).status,
      off.post("panel", { id: "alerts", value: "on" }).status,
      off.post("panel/action", { id: "inviteRoom" }).status], [404, 404, 404]);

    let now = 1000000;
    const invites = [];
    const auto = createShipAiAutostart({ S: { autostartEnabled: true, autostartPollMs: 5000,
      autostartLoginDelayMs: 0, autostartMaxWaitMs: 60000 }, nowMs: () => now,
    readPresence: () => ({ ok: true, characters: [{ characterId: PLAYER, name: "Pilot One" }] }),
    prefsOf: () => ({ room: true, voice: false }), anyEnabled: () => true, isAllowed: () => true,
    isRunning: () => true, invite: (id) => {
      invites.push(id);
      return { ok: true };
    }, voiceLink: () => ({ ok: false, reason: "VOICE_OFF" }), sendSystem: () => ({ system: 0, failed: 0 }),
    setTimer: () => ({ cancel: () => {}, hasRef: () => false }) });
    auto.runPass();
    now += 5000;
    auto.runPass();
    assert.deepStrictEqual(invites, [PLAYER], "DONE: no second invitation while online");
    auto.forget(PLAYER);
    auto.runPass();
    assert.deepStrictEqual(invites, [PLAYER, PLAYER]);
  });
};
