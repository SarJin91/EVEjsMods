"use strict";

const assert = require("node:assert");
const path = require("node:path");
const { createClientWindowChannel } = require("../../lib/channels/clientWindow");
const { createChatChannel, UI_AUTO_TEXT, WINDOW_TEXT } = require("../../lib/channels/chat");
const { createUiPrefsApi, registerUiPrefsApi, unregisterUiPrefsApi, UI_PREFS_API_KEY } =
  require("../../lib/channels/uiPrefsApi");
const { resolveConfig } = require("../../config");

const CHAR = 90000001;
const OTHER = 90000002;
const MOD_DIR = path.join(__dirname, "..", "..");

function config(extra = {}) {
  return { ...resolveConfig({ modDir: MOD_DIR, env: { EVEJS_SHIPWING_ENABLED: "1" } }).config, ...extra };
}

function fakeTimers() {
  const t = { pending: [] };
  t.setTimeout = (fn, delay) => {
    const handle = { fn, delay, unref() {} };
    t.pending.push(handle);
    return handle;
  };
  t.clearTimeout = (handle) => {
    const at = t.pending.indexOf(handle);
    if (at >= 0) t.pending.splice(at, 1);
  };
  t.fire = () => {
    for (const h of t.pending.splice(0)) h.fn();
  };
  return t;
}

function fakeCore() {
  return { SUPPORTED_VERBS: ["launch", "return"], onWingChanged: () => () => {},
    listWing: (charId) => ({ characterId: charId, limit: 2, deployedCount: 0, refusal: null, ships: [] }) };
}

function setup(extra = {}, prefs = new Set([CHAR])) {
  const clock = { t: 5000000, now() { return this.t; } };
  const timers = fakeTimers();
  const sent = [];
  const channel = createClientWindowChannel({ core: fakeCore(), config: config(extra), clock, timers,
    notify: (charId, token, type) => {
      sent.push({ charId, token, type });
      return { ok: true };
    },
    uiPrefs: { get: (id) => prefs.has(id) }, log: { log() {}, debug() {} } });
  return { clock, timers, sent, channel };
}

module.exports = ({ test }) => {
  test("UP1 a new session token + openAtLogin -> one OnShipWingOpen after clientWindowLoginOpenDelayMs; the same "
    + "token again -> nothing; pref off or the switch off -> nothing; stop clears the timer", () => {
    const t = setup({ clientWindowLoginOpenDelayMs: 2500 }, new Set([CHAR, OTHER]));
    const tokenA = {};
    assert.strictEqual(t.channel.getState(CHAR, tokenA).ok, true);
    assert.strictEqual(t.timers.pending.length, 1);
    assert.strictEqual(t.timers.pending[0].delay, 2500);
    assert.strictEqual(t.sent.length, 0, "nothing before the delay");
    t.clock.t += 2500;
    t.timers.fire();
    assert.deepStrictEqual(t.sent.map((s) => [s.type, s.token === tokenA]), [["OnShipWingOpen", true]]);
    for (let i = 0; i < 3; i += 1) {
      t.clock.t += 5000;
      t.channel.getState(CHAR, tokenA);
    }
    assert.strictEqual(t.timers.pending.length, 0, "no second login open for the same token");
    const tokenB = {};
    t.clock.t += 5000;
    t.channel.getState(CHAR, tokenB);
    t.timers.fire();
    assert.strictEqual(t.sent.length, 2);
    assert.strictEqual(t.sent[1].token, tokenB);
    t.channel.getState(OTHER, tokenB);
    t.timers.fire();
    assert.deepStrictEqual(t.sent.slice(2).map((s) => [s.charId, s.type]), [[OTHER, "OnShipWingOpen"]]);
    const counters = t.channel.stats().counters;
    assert.strictEqual(counters["ui.autoOpen.scheduled"], 3);
    assert.strictEqual(counters["ui.autoOpen.sent"], 3);

    const off = setup({}, new Set());
    off.channel.getState(CHAR, {});
    assert.strictEqual(off.timers.pending.length, 0);
    const disabled = setup({ clientWindowOpenAtLoginEnabled: false });
    disabled.channel.getState(CHAR, {});
    assert.strictEqual(disabled.timers.pending.length, 0);

    const stopped = setup();
    stopped.channel.getState(CHAR, {});
    assert.strictEqual(stopped.timers.pending.length, 1);
    stopped.channel.stop();
    assert.strictEqual(stopped.timers.pending.length, 0, "stop clears the login timer");
  });

  test("UP2 `!wing ui auto` shows the state, `on|off` sets it (not saved / FULL texts); no uiAuto = off; `!wing ui` "
    + "still opens the window; the usage names `ui [auto on|off]`", () => {
    const prefs = new Map();
    let persisted = true;
    const uiAuto = {
      get: (id) => ({ ok: true, openAtLogin: prefs.get(id) === true }),
      set: (id, on) => {
        if (id === OTHER) return { ok: false, reason: "FULL" };
        prefs.set(id, on);
        return { ok: true, openAtLogin: on, persisted };
      },
    };
    const session = { characterID: CHAR };
    const chat = createChatChannel({ core: fakeCore(), trigger: "!wing", characterIdOf: (s) => s.characterID,
      openWindow: () => ({ ok: true }), uiAuto });
    assert.strictEqual(chat.handle(session, "!wing ui auto"), UI_AUTO_TEXT.OFF);
    assert.strictEqual(chat.handle(session, "!wing ui auto on"), "Ship Wing: the wing window will open at each login.");
    assert.strictEqual(chat.handle(session, "!wing ui AUTO"), UI_AUTO_TEXT.ON);
    persisted = false;
    assert.strictEqual(chat.handle(session, "!wing ui auto off"),
      "Ship Wing: the wing window will not open at login (until restart, not saved).");
    assert.strictEqual(chat.handle(session, "!wing ui auto"), UI_AUTO_TEXT.OFF);
    assert.strictEqual(chat.handle({ characterID: OTHER }, "!wing ui auto on"), UI_AUTO_TEXT.FULL);
    assert.strictEqual(chat.handle(session, "!wing ui auto maybe"), "Ship Wing: !wing ui auto on|off");
    assert.strictEqual(chat.handle(session, "!wing ui"), WINDOW_TEXT.OPENED);
    assert.ok(chat.handle(session, "!wing x").endsWith(" | !wing ui [auto on|off]"));

    const bare = createChatChannel({ core: fakeCore(), trigger: "!wing", characterIdOf: (s) => s.characterID });
    assert.strictEqual(bare.handle(session, "!wing ui auto"), UI_AUTO_TEXT.OFF);
    assert.strictEqual(bare.handle(session, "!wing ui auto on"), WINDOW_TEXT.OFF);
  });

  test("UP3 the uiPrefs API: {version:1,get,set,open} frozen; set -> get; BAD_ID / FULL; deactivate -> WINDOW_OFF; "
    + "unregister removes only our object", () => {
    const pilots = new Set();
    const store = { get: (id) => pilots.has(id),
      set: (id, on) => {
        if (id === OTHER) return { ok: false, reason: "FULL" };
        if (on) pilots.add(id); else pilots.delete(id);
        return { ok: true, changed: true, persisted: true };
      } };
    const opened = [];
    const made = createUiPrefsApi({ channel: { open: (id) => { opened.push(id); return { ok: true }; } }, store });
    const g = {};
    assert.strictEqual(registerUiPrefsApi(g, made.api), true);
    const api = g[UI_PREFS_API_KEY];
    assert.strictEqual(api, made.api);
    assert.strictEqual(Object.isFrozen(api), true);
    assert.deepStrictEqual(Object.keys(api).sort(), ["get", "open", "set", "version"]);
    assert.strictEqual(api.version, 1);
    assert.deepStrictEqual(api.get(CHAR), { ok: true, openAtLogin: false });
    assert.deepStrictEqual(api.set(CHAR, true), { ok: true, openAtLogin: true, persisted: true });
    assert.deepStrictEqual(api.get(CHAR), { ok: true, openAtLogin: true });
    assert.deepStrictEqual(api.get("x"), { ok: false, reason: "BAD_ID" });
    assert.deepStrictEqual(api.set(OTHER, true), { ok: false, reason: "FULL" });
    assert.deepStrictEqual(api.open(CHAR), { ok: true });
    assert.deepStrictEqual(opened, [CHAR]);
    const foreign = {};
    assert.strictEqual(unregisterUiPrefsApi({ [UI_PREFS_API_KEY]: foreign }, api), false);
    made.deactivate();
    assert.deepStrictEqual(api.get(CHAR), { ok: false, reason: "WINDOW_OFF" });
    assert.deepStrictEqual(api.open(CHAR), { ok: false, reason: "WINDOW_OFF" });
    assert.strictEqual(unregisterUiPrefsApi(g, api), true);
    assert.strictEqual(UI_PREFS_API_KEY in g, false);
  });
};
