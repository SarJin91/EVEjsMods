"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createClientWindowChannel, MAX_REPORT_LINE_CHARS, MAX_NAME_CHARS, toSnapshot, rowVerbs, uiOf } =
  require("../../lib/channels/clientWindow");
const { UI_CONTINUE, PER_SHIP_REFUSAL, ALL_VERBS } = require("../../lib/core/reasons");
const { formatTelemetry } = require("../../lib/core/telemetry");
const { createWingService, hpPermille } = require("../../lib/core/wingService");
const { createWingStore } = require("../../lib/store/wingStore");
const { resolveConfig } = require("../../config");
const { createChatChannel, WINDOW_TEXT } = require("../../lib/channels/chat");

const CHAR = 90000001;
const OTHER = 90000002;
const MOD_DIR = path.join(__dirname, "..", "..");
const LIMITED = Object.freeze({ ok: false, reason: "RATE_LIMIT" });

function config(extra = {}) {
  return { ...resolveConfig({ modDir: MOD_DIR, env: { EVEJS_SHIPWING_ENABLED: "1" } }).config, ...extra };
}

function fakeClock(t = 5000000) {
  return { t, now() { return this.t; } };
}

function fakeTimers() {
  const t = { pending: [], cleared: 0 };
  t.setTimeout = (fn, delay) => {
    const handle = { fn, delay, unref() { handle.unrefd = true; } };
    t.pending.push(handle);
    return handle;
  };
  t.clearTimeout = (handle) => {
    const at = t.pending.indexOf(handle);
    if (at >= 0) t.pending.splice(at, 1);
    t.cleared += 1;
  };
  t.fire = () => {
    const run = t.pending.splice(0);
    for (const h of run) h.fn();
  };
  return t;
}

function fakeCore(answers = {}) {
  const core = { calls: [], listeners: new Set(), SUPPORTED_VERBS: ["launch", "return"] };
  core.orderCopy = (charId, id, verb, opts) => {
    core.calls.push({ charId, id, verb, commandId: opts.commandId, source: opts.source });
    return answers[id] || { ok: true, state: "ACTIVE" };
  };
  core.listWing = (charId) => ({ characterId: charId, limit: 2, deployedCount: 1, refusal: null, ships: [
    { shipItemId: 501, typeId: 22544, name: "Hulk A", state: "ACTIVE", eligible: false, refusal: "ALREADY_DEPLOYED",
      entityId: 4200000000000001, distanceM: 1520.6, targetId: null },
  ] });
  core.onWingChanged = (fn) => {
    core.listeners.add(fn);
    return () => core.listeners.delete(fn);
  };
  return core;
}

function setup(opts = {}) {
  const core = opts.core || fakeCore(opts.answers);
  const clock = fakeClock();
  const timers = fakeTimers();
  const sent = [];
  const lines = [];
  let notifyResult = { ok: true };
  const channel = createClientWindowChannel({
    core, config: config(opts.config), clock, timers,
    notify: (charId, token, type, snapshot) => {
      sent.push({ charId, token, type, snapshot });
      return notifyResult;
    },
    log: { log: (l) => lines.push(l), debug() {} },
    board: opts.board,
  });
  return { core, clock, timers, sent, lines, channel, setNotify: (r) => { notifyResult = r; } };
}

module.exports = ({ test }) => {
  test("CW1 Command validation: NO_CHARACTER, BAD_ARGS (types), TOO_MANY_SHIPS after dedup, UNSUPPORTED_VERB "
    + "without a core call", () => {
    const t = setup();
    const c = t.channel;
    assert.deepStrictEqual(c.command(0, { ids: [501], verb: "launch" }), { ok: false, reason: "NO_CHARACTER" });
    for (const input of [
      { ids: "501", verb: "launch" }, { ids: [], verb: "launch" }, { ids: [1.5], verb: "launch" },
      { ids: [-1], verb: "launch" }, { ids: [2 ** 60], verb: "launch" }, { ids: [501], verb: 5 },
      { ids: [501], verb: "x".repeat(17) }, { ids: [501], verb: "launch", targetId: "a" },
      { ids: [501], verb: "launch", targetId: Number.NaN },
    ]) {
      t.clock.t += 1000;
      assert.deepStrictEqual(c.command(CHAR, input), { ok: false, reason: "BAD_ARGS" }, JSON.stringify(input));
    }
    t.clock.t += 1000;
    const many = Array.from({ length: 21 }, (_v, i) => 1000 + i);
    assert.deepStrictEqual(c.command(CHAR, { ids: many, verb: "launch" }), { ok: false, reason: "TOO_MANY_SHIPS" });
    t.clock.t += 1000;
    assert.deepStrictEqual(c.command(CHAR, { ids: [501], verb: "mine" }), { ok: false, reason: "UNSUPPORTED_VERB" });
    assert.strictEqual(t.core.calls.length, 0, "no core call on a refused command");
    t.clock.t += 1000;
    const dup = [...many.slice(0, 20), ...many.slice(0, 20)];
    assert.strictEqual(c.command(CHAR, { ids: dup, verb: "launch" }).ok, true, "20 after dedup is fine");
    assert.strictEqual(t.core.calls.length, 20);
  });

  test("CW2 rate limit: one 1 s window for every method, 6th call -> RATE_LIMIT, after 1 s OK again "
    + "telemetry client.*", () => {
    const t = setup();
    const token = {};
    assert.strictEqual(t.channel.getState(CHAR, token).ok, true);
    assert.strictEqual(t.channel.report(CHAR, { proto: 1, clientBuild: 3396210, items: [] }).ok, true);
    for (let i = 0; i < 3; i += 1) assert.strictEqual(t.channel.command(CHAR, { ids: [501], verb: "return" }).ok, true);
    assert.deepStrictEqual(t.channel.command(CHAR, { ids: [501], verb: "return" }), LIMITED);
    assert.deepStrictEqual(t.channel.getState(CHAR, token), LIMITED);
    assert.strictEqual(t.channel.command(OTHER, { ids: [501], verb: "return" }).ok, true, "per pilot");
    t.clock.t += 999;
    assert.deepStrictEqual(t.channel.command(CHAR, { ids: [501], verb: "return" }), LIMITED);
    t.clock.t += 1;
    assert.strictEqual(t.channel.command(CHAR, { ids: [501], verb: "return" }).ok, true);
    const line = formatTelemetry({ client: t.channel.stats() });
    assert.ok(line.includes("client.refused.RATE_LIMIT=3"), line);
    assert.ok(line.includes("client.rpc.Command=7") && line.includes("client.rpc.GetState=2"), line);
  });

  test("CW3 Command result per copy {shipItemID, ok, reason, state}; one server commandId ui-<n> per call; "
    + "UI_CONTINUE goes on; source window", () => {
    const t = setup({ answers: { 502: { ok: false, reason: "NOT_OWNER" } } });
    const r = t.channel.command(CHAR, { ids: [501, 502, 501, 503], verb: "launch", commandId: "chat-9",
      charId: OTHER });
    assert.deepStrictEqual(r, { ok: true, result: { v: 2, ok: false, reason: "NOT_OWNER", commandID: "ui-1", results: [
      { shipItemID: 501, ok: true, reason: null, state: "ACTIVE" },
      { shipItemID: 502, ok: false, reason: "NOT_OWNER", state: null },
      { shipItemID: 503, ok: true, reason: null, state: "ACTIVE" },
    ] } });
    assert.deepStrictEqual(t.core.calls.map((c) => [c.charId, c.id, c.commandId]),
      [[CHAR, 501, "ui-1"], [CHAR, 502, "ui-1"], [CHAR, 503, "ui-1"]], "charId of the caller, our commandId");
    assert.ok(t.core.calls.every((c) => c.source === "window"), "source window");
    assert.strictEqual(t.channel.command(CHAR, { ids: [504], verb: "launch" }).result.commandID, "ui-2");
    assert.deepStrictEqual([...UI_CONTINUE].sort(),
      PER_SHIP_REFUSAL.filter((c) => c !== "SPAWN_FAILED" && c !== "STORE_WRITE_FAILED").sort());
  });

  test("CW4 SPAWN_FAILED / STORE_WRITE_FAILED / LIMIT end the loop: SKIPPED for the rest, no core call", () => {
    for (const reason of ["SPAWN_FAILED", "STORE_WRITE_FAILED", "LIMIT"]) {
      const t = setup({ answers: { 2: { ok: false, reason } } });
      const r = t.channel.command(CHAR, { ids: [1, 2, 3, 4], verb: "launch" });
      assert.deepStrictEqual(r.result.results.map((x) => x.reason), [null, reason, "SKIPPED", "SKIPPED"], reason);
      assert.strictEqual(r.result.reason, reason);
      assert.deepStrictEqual(t.core.calls.map((c) => c.id), [1, 2], reason);
      assert.strictEqual(t.channel.stats().counters["refused.SKIPPED"], 2);
    }
  });

  test("CW5 notifications: 3 changes in 1 s -> 1 send at once + 1 after the interval; no GetState -> 0 sends; "
    + "SESSION_CHANGED drops the subscription; stop() clears the timer and the listener", () => {
    const t = setup();
    const token = { id: "session" };
    assert.strictEqual(t.core.listeners.size, 1, "listener attached");
    t.channel.onWingChanged(OTHER);
    assert.strictEqual(t.timers.pending.length, 0, "no subscription -> no timer");
    t.channel.getState(CHAR, token);
    const notifyCore = [...t.core.listeners][0];
    notifyCore(CHAR);
    assert.strictEqual(t.timers.pending.length, 1);
    assert.strictEqual(t.timers.pending[0].delay, 0);
    assert.strictEqual(t.timers.pending[0].unrefd, true, "timer is unref'd");
    t.timers.fire();
    assert.strictEqual(t.sent.length, 1);
    assert.strictEqual(t.sent[0].type, "OnShipWingState");
    assert.strictEqual(t.sent[0].token, token);
    assert.strictEqual(t.sent[0].snapshot.ships[0].distanceM, 1521);
    t.clock.t += 100;
    notifyCore(CHAR);
    t.clock.t += 100;
    notifyCore(CHAR);
    assert.strictEqual(t.timers.pending.length, 1, "one shared timer");
    assert.strictEqual(t.timers.pending[0].delay, 900, "due = last send + interval");
    assert.strictEqual(t.sent.length, 1, "nothing sent before the interval");
    t.clock.t += 800;
    t.timers.fire();
    assert.strictEqual(t.sent.length, 2);
    assert.strictEqual(t.channel.stats().counters["notify.coalesced"], 1);
    assert.ok(!t.sent.some((s) => s.charId === OTHER), "never to a pilot without GetState");

    t.setNotify({ ok: false, reason: "SESSION_CHANGED" });
    t.clock.t += 1000;
    notifyCore(CHAR);
    t.timers.fire();
    assert.strictEqual(t.channel.stats().subscribers, 0, "subscription removed");
    notifyCore(CHAR);
    assert.strictEqual(t.timers.pending.length, 0);

    t.setNotify({ ok: true });
    t.clock.t += 1000;
    t.channel.getState(CHAR, token);
    t.clock.t += 10;
    notifyCore(CHAR);
    assert.strictEqual(t.timers.pending.length, 1);
    t.channel.stop();
    assert.strictEqual(t.timers.pending.length, 0, "timer cleared");
    assert.strictEqual(t.timers.cleared, 1);
    assert.strictEqual(t.core.listeners.size, 0, "listener detached");
    t.channel.onWingChanged(CHAR);
    assert.strictEqual(t.timers.pending.length, 0);
    assert.deepStrictEqual(t.channel.command(CHAR, { ids: [1], verb: "launch" }), { ok: false, reason: "DISABLED" });
    assert.deepStrictEqual(t.channel.open(CHAR), { ok: false, reason: "WINDOW_OFF" });
  });

  test("CW6 report: BAD_ARGS, sanitized items, one line per interval, line <= 2048", () => {
    const t = setup();
    assert.deepStrictEqual(t.channel.report(CHAR, { proto: 2, clientBuild: 1, items: [] }),
      { ok: false, reason: "BAD_ARGS" });
    assert.deepStrictEqual(t.channel.report(CHAR, { proto: 1, clientBuild: 1, items: "x" }),
      { ok: false, reason: "BAD_ARGS" });
    const items = ["win.carbon=1", "scroll.eve=0:ImportError", "dcb=0", "bad item=1", "<b>=1", 7, "x".repeat(97),
      "noequals", ...Array.from({ length: 60 }, (_v, i) => `k${i}=1`)];
    assert.deepStrictEqual(t.channel.report(CHAR, { proto: 1, clientBuild: 3396210, items }), { ok: true });
    assert.strictEqual(t.lines.length, 1);
    const line = t.lines[0];
    assert.ok(line.startsWith("SHIPWING_UI:PROBE char=90000001 build=3396210 proto=1 ok=win.carbon,k0,"), line);
    assert.ok(line.includes(" missing=scroll.eve:ImportError,dcb dropped=9"), line);
    assert.ok(!line.includes("<b>"));
    t.clock.t += 1000;
    t.channel.report(CHAR, { proto: 1, clientBuild: 3396210, items: [] });
    assert.strictEqual(t.lines.length, 1, "suppressed inside the interval");
    t.clock.t += 60000;
    const long = Array.from({ length: 64 }, () => `${"a".repeat(94)}=1`);
    t.channel.report(CHAR, { proto: 1, clientBuild: "x", items: long });
    assert.strictEqual(t.lines.length, 2);
    assert.ok(t.lines[1].length <= MAX_REPORT_LINE_CHARS && t.lines[1].includes("build=0"));
    const counters = t.channel.stats().counters;
    assert.strictEqual(counters["report.logged"], 2);
    assert.strictEqual(counters["report.suppressed"], 1);
  });

  test("CW7 open: no GetState -> CLIENT_NOT_READY; subscribed -> OnShipWingOpen now", () => {
    const t = setup();
    assert.deepStrictEqual(t.channel.open(CHAR), { ok: false, reason: "CLIENT_NOT_READY" });
    const token = {};
    t.channel.getState(CHAR, token);
    assert.deepStrictEqual(t.channel.open(CHAR), { ok: true });
    assert.strictEqual(t.sent.length, 1);
    assert.strictEqual(t.sent[0].type, "OnShipWingOpen");
    assert.deepStrictEqual(t.sent[0].snapshot.verbs, ["launch", "return"]);
  });

  test("CW9 open: one send per clientWindowOpenMinIntervalMs -> RATE_LIMIT inside, 0 = no "
    + "limit, chat answers 'try again'; report: negative build logged as 0", () => {
    const t = setup();
    t.channel.getState(CHAR, {});
    assert.deepStrictEqual(t.channel.open(CHAR), { ok: true });
    t.clock.t += 999;
    assert.deepStrictEqual(t.channel.open(CHAR), LIMITED);
    assert.strictEqual(t.sent.length, 1);
    t.clock.t += 1;
    assert.deepStrictEqual(t.channel.open(CHAR), { ok: true });
    assert.strictEqual(t.channel.stats().counters["refused.RATE_LIMIT"], 1);
    const chat = createChatChannel({ core: t.core, trigger: "!wing", characterIdOf: (s) => s.characterID,
      openWindow: () => LIMITED });
    assert.strictEqual(chat.handle({ characterID: CHAR }, "!wing ui"), WINDOW_TEXT.FAILED);
    const free = setup({ config: { clientWindowOpenMinIntervalMs: 0 } });
    free.channel.getState(CHAR, {});
    for (let i = 0; i < 3; i += 1) assert.deepStrictEqual(free.channel.open(CHAR), { ok: true });
    t.channel.report(OTHER, { proto: 1, clientBuild: -5, items: ["build=0:UNSUPPORTED_BUILD"] });
    assert.ok(t.lines[0].startsWith(`SHIPWING_UI:PROBE char=${OTHER} build=0 proto=1 ok= `
      + "missing=build:UNSUPPORTED_BUILD dropped=0"), t.lines[0]);
  });

  test("CW10 client events: only `ui.*` items -> SHIPWING_UI:EVENT, not hidden by the probe interval, one per "
    + "clientWindowEventMinIntervalMs; a mixed report stays a probe", () => {
    const t = setup();
    t.channel.report(CHAR, { proto: 1, clientBuild: 3396210, items: ["win.carbon=1"] });
    t.clock.t += 10;
    t.channel.report(CHAR, { proto: 1, clientBuild: 3396210,
      items: ["ui.open.message=0:RuntimeError", "ui.open.say=1", "ui.open=1"] });
    assert.strictEqual(t.lines.length, 2, "the event is not suppressed by the probe interval");
    assert.strictEqual(t.lines[1], "SHIPWING_UI:EVENT char=90000001 build=3396210 proto=1 ok=ui.open.say,ui.open "
      + "missing=ui.open.message:RuntimeError dropped=0");
    t.clock.t += 999;
    t.channel.report(CHAR, { proto: 1, clientBuild: 3396210, items: ["ui.error.state=0:TypeError"] });
    assert.strictEqual(t.lines.length, 2, "inside clientWindowEventMinIntervalMs");
    t.clock.t += 1;
    t.channel.report(CHAR, { proto: 1, clientBuild: 3396210, items: ["ui.error.state=0:TypeError"] });
    assert.ok(t.lines[2].startsWith("SHIPWING_UI:EVENT ") && t.lines[2].includes("missing=ui.error.state:TypeError"));
    t.clock.t += 60000;
    t.channel.report(CHAR, { proto: 1, clientBuild: 3396210, items: ["ui.open=1", "win.eve=0:ImportError"] });
    assert.ok(t.lines[3].startsWith("SHIPWING_UI:PROBE "), "mixed = probe");
    const counters = t.channel.stats().counters;
    assert.deepStrictEqual([counters["report.event"], counters["report.eventSuppressed"], counters["report.logged"]],
      [2, 1, 2]);
  });

  test("CW11 wire v2 snapshot: fields and types, ui block from the config, names <= 64, hp of a "
    + "twin / bay item / none; hpPermille clamps and rejects NaN; rowVerbs table and the SUPPORTED_VERBS subset", () => {
    const ui = uiOf(config());
    assert.deepStrictEqual(ui, { pollMs: 5000, hpRefreshMs: 1000, rowReasonMs: 8000, autoOpen: true, maxRows: 30,
      maxShips: 20, hpWarnPct: 90, hpCriticalPct: 50, buttonColors: true, activeChars: 24 });
    const long = "N".repeat(MAX_NAME_CHARS + 10);
    const row = (extra) => ({ shipItemId: 502, typeId: 22544, typeName: "Hulk", name: "Hulk B", state: "IN_BAY",
      task: null, eligible: true, refusal: null, entityId: null, distanceM: null, targetId: null, targetName: null,
      hp: null, ...extra });
    const view = { limit: 2, deployedCount: 1, refusal: null, ships: [
      row({ shipItemId: 501, typeName: long, name: "Hulk A", state: "ACTIVE", task: "ATTACK", eligible: false,
        refusal: "ALREADY_DEPLOYED", entityId: 42, distanceM: 10.4, targetId: 777, targetName: long,
        hp: hpPermille({ shieldCharge: 0.5, armorDamage: 0.25, damage: 0 }) }),
      row({ hp: hpPermille({ shieldCharge: 1, armorDamage: 0, damage: 0.1 }) }),
      row({ shipItemId: 503, eligible: false, refusal: "MISSING_SKILLS" }),
    ] };
    const snap = toSnapshot(view, ["launch", "return", "hold", "attack"], ui);
    assert.deepStrictEqual(Object.keys(snap).sort(),
      ["deployed", "limit", "refusal", "ships", "truncated", "ui", "v", "verbs"]);
    assert.deepStrictEqual([snap.v, snap.truncated, snap.ui],
      [2, 0, { pollMs: 5000, hpRefreshMs: 1000, rowReasonMs: 8000, autoOpen: true, maxShips: 20, hpWarnPct: 90,
        hpCriticalPct: 50, buttonColors: true, activeChars: 24 }]);
    const [a, b, c] = snap.ships;
    assert.deepStrictEqual(Object.keys(a).sort(), ["distanceM", "eligible", "entityID", "hp", "name", "refusal",
      "shipItemID", "state", "targetID", "targetName", "task", "typeID", "typeName", "verbs"]);
    assert.deepStrictEqual([a.typeName.length, a.targetName.length, a.task, a.distanceM, a.hp, a.verbs],
      [MAX_NAME_CHARS, MAX_NAME_CHARS, "ATTACK", 10, [500, 750, 1000], ["return", "hold", "attack"]]);
    assert.deepStrictEqual([b.typeName, b.task, b.targetName, b.hp, b.verbs], ["Hulk", null, null, [1000, 1000, 900],
      ["launch"]]);
    assert.deepStrictEqual([c.hp, c.verbs], [null, []]);
    assert.deepStrictEqual(hpPermille({ shieldCharge: 1.7, armorDamage: -0.5, damage: 2 }), [1000, 1000, 0]);
    for (const bad of [null, undefined, 7, { shieldCharge: NaN, armorDamage: 0, damage: 0 },
      { shieldCharge: "x", armorDamage: 0, damage: 0 }, { shieldCharge: 1, armorDamage: 0 }]) {
      assert.strictEqual(hpPermille(bad), null, JSON.stringify(bad));
    }
    const hpOf = (hp) => toSnapshot({ ships: [row({ hp })] }, [], ui).ships[0].hp;
    assert.deepStrictEqual([hpOf([1200, -3, 5.6]), hpOf([1, 2]), hpOf([1, NaN, 2]), hpOf("x")],
      [[1000, 0, 6], null, null, null]);
    const table = [
      [{ state: "IN_BAY", eligible: true }, ["launch"]],
      [{ state: "IN_BAY", eligible: false }, []],
      [{ state: "ACTIVE", eligible: false }, ["return", "mine", "hold", "attack", "salvage"]],
      ...["LAUNCHING", "RETURNING", "LOST", "SETTLED", "OTHER"].map((state) => [{ state, eligible: true }, []]),
    ];
    for (const [ship, expected] of table) assert.deepStrictEqual(rowVerbs(ship, ALL_VERBS), expected, ship.state);
    assert.deepStrictEqual(rowVerbs({ state: "ACTIVE" }, ["launch", "return", "hold", "attack"]),
      ["return", "hold", "attack"], "no mine in SUPPORTED_VERBS");
    assert.deepStrictEqual(rowVerbs({ state: "ACTIVE" }, ["attack", "return"]), ["return", "attack"], "ALL_VERBS order");
    assert.deepStrictEqual(rowVerbs({ state: "IN_BAY", eligible: true }, ["return"]), []);
  });

  test("CW12 clientWindowMaxRows: 12 bay rows + 2 ACTIVE at the end, maxRows 10 -> both ACTIVE kept "
    + "truncated 4, counters snapshot.truncated and snapshot.hpMissing", () => {
    const core = fakeCore();
    const bay = Array.from({ length: 12 }, (_v, i) => ({ shipItemId: 600 + i, typeId: 22544, name: `B${i}`,
      state: "IN_BAY", eligible: true, hp: [1000, 1000, 1000] }));
    core.listWing = () => ({ limit: 2, deployedCount: 2, refusal: null, ships: [...bay,
      { shipItemId: 701, typeId: 22544, name: "A1", state: "ACTIVE", eligible: false, hp: [1000, 900, 800] },
      { shipItemId: 702, typeId: 22544, name: "A2", state: "ACTIVE", eligible: false, hp: null }] });
    const t = setup({ core, config: { clientWindowMaxRows: 10 } });
    const r = t.channel.getState(CHAR, {});
    assert.strictEqual(r.ok, true);
    const ids = r.snapshot.ships.map((s) => s.shipItemID);
    assert.deepStrictEqual(ids, [600, 601, 602, 603, 604, 605, 606, 607, 701, 702]);
    assert.strictEqual(r.snapshot.truncated, 4);
    const counters = t.channel.stats().counters;
    assert.deepStrictEqual([counters["snapshot.truncated"], counters["snapshot.hpMissing"]], [4, 1]);
    assert.ok(formatTelemetry({ client: t.channel.stats() }).includes("client.snapshot.truncated=4"));
  });

  test("CW13 SHIPWING_UI:EVENT uses clientWindowEventMinIntervalMs, not clientWindowOpenMinIntervalMs "
    + "open() keeps clientWindowOpenMinIntervalMs; 0 = only the RPC rate window", () => {
    const ev = (t) => t.channel.report(CHAR, { proto: 1, clientBuild: 3396210, items: ["ui.open=1"] });
    const t = setup({ config: { clientWindowEventMinIntervalMs: 5000, clientWindowOpenMinIntervalMs: 1000 } });
    ev(t);
    t.clock.t += 1000;
    ev(t);
    assert.strictEqual(t.lines.length, 1, "inside the event interval although the open interval passed");
    t.clock.t += 4000;
    ev(t);
    assert.strictEqual(t.lines.length, 2);
    t.channel.getState(CHAR, {});
    assert.deepStrictEqual(t.channel.open(CHAR), { ok: true });
    t.clock.t += 1000;
    assert.deepStrictEqual(t.channel.open(CHAR), { ok: true }, "open uses its own 1000 ms");
    const free = setup({ config: { clientWindowEventMinIntervalMs: 0, clientWindowOpenMinIntervalMs: 60000 } });
    for (let i = 0; i < 5; i += 1) assert.deepStrictEqual(ev(free), { ok: true });
    assert.strictEqual(free.lines.length, 5, "0 = every event line inside the rate window");
    assert.deepStrictEqual(ev(free), LIMITED);
  });

  test("CW14 a bay row without an entity has entityID, distanceM, targetID = null "
    + "(not 0); the ui block carries maxShips = clientWindowMaxShipsPerCommand (the client caps a command by it)", () => {
    const bay = { shipItemId: 502, typeId: 22544, name: "Hulk B", state: "IN_BAY", eligible: true, entityId: null,
      distanceM: undefined, targetId: null };
    const snap = toSnapshot({ ships: [bay] }, ["launch"], uiOf(config({ clientWindowMaxShipsPerCommand: 7 })));
    const [row] = snap.ships;
    assert.deepStrictEqual([row.entityID, row.distanceM, row.targetID], [null, null, null]);
    assert.strictEqual(snap.ui.maxShips, 7);
    const flying = toSnapshot({ ships: [{ ...bay, state: "ACTIVE", entityId: 42, distanceM: 0, targetId: 0 }] },
      [], {}).ships[0];
    assert.deepStrictEqual([flying.entityID, flying.distanceM, flying.targetID], [42, 0, 0], "a real 0 stays 0");
    assert.strictEqual(toSnapshot({ ships: [] }, [], {}).ui.maxShips, 0, "no ui value -> 0 = no client cap");
  });

  test("CW15 the sweep drops subscribers of a dead session (WeakRef empty, dropSubscriber) "
    + "a live subscriber stays", () => {
    const RealWeakRef = globalThis.WeakRef;
    class TestRef {
      constructor(target) { this.target = target; }
      deref() { return this.target; }
    }
    const refs = [];
    globalThis.WeakRef = class extends TestRef {
      constructor(target) { super(target); refs.push(this); }
    };
    try {
      const t = setup();
      t.channel.getState(CHAR, { id: "a" });
      t.channel.getState(OTHER, { id: "b" });
      [...t.core.listeners][0](CHAR);
      t.timers.fire();
      assert.strictEqual(t.sent.length, 1);
      assert.strictEqual(t.channel.stats().subscribers, 2);
      refs[0].target = undefined;
      t.clock.t += 10000;
      t.channel.report(OTHER, { proto: 1, clientBuild: 3396210, items: ["a=1"] });
      assert.strictEqual(t.channel.stats().subscribers, 1, "dead subscriber dropped");
      assert.deepStrictEqual(t.channel.open(CHAR), { ok: false, reason: "CLIENT_NOT_READY" });
      assert.deepStrictEqual(t.channel.open(OTHER), { ok: true }, "live subscriber kept");
    } finally {
      globalThis.WeakRef = RealWeakRef;
    }
  });

  test("CW16 SEND_FAILED keeps the change: the pilot stays dirty, one retry after "
    + "clientWindowStateMinIntervalMs (also with clientWindowPollMs=0), then sent; SESSION_CHANGED ends it", () => {
    const t = setup({ config: { clientWindowPollMs: 0, clientWindowStateMinIntervalMs: 1000 } });
    t.channel.getState(CHAR, { id: "s" });
    const notifyCore = [...t.core.listeners][0];
    t.setNotify({ ok: false, reason: "SEND_FAILED" });
    notifyCore(CHAR);
    t.timers.fire();
    assert.strictEqual(t.sent.length, 1, "first try");
    assert.strictEqual(t.channel.stats().dirty, 1, "still dirty after SEND_FAILED");
    assert.strictEqual(t.timers.pending.length, 1, "retry armed");
    assert.strictEqual(t.timers.pending[0].delay, 1000, "retry after the state interval");
    assert.strictEqual(t.channel.stats().counters["notify.retry"], 1);
    notifyCore(CHAR);
    assert.strictEqual(t.timers.pending.length, 1, "a new change joins the retry");
    t.setNotify({ ok: true });
    t.clock.t += 1000;
    t.timers.fire();
    assert.strictEqual(t.sent.length, 2, "the change is sent again");
    assert.strictEqual(t.channel.stats().dirty, 0);
    assert.strictEqual(t.timers.pending.length, 0);
    t.setNotify({ ok: false, reason: "SESSION_CHANGED" });
    t.clock.t += 1000;
    notifyCore(CHAR);
    t.timers.fire();
    assert.deepStrictEqual([t.channel.stats().dirty, t.channel.stats().subscribers, t.timers.pending.length],
      [0, 0, 0], "no retry for a changed session");
  });

  test("CW8 real core on a fake adapter: foreign shipItemID -> NOT_IN_SMB / NOT_OWNER per copy; return of "
    + "another pilot's copy -> NOT_OWNER, of a copy not out -> NOT_DEPLOYED", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shipwing-cw-"));
    try {
      const host = 1000000400;
      const sceneKey = "system:30000142";
      const scene = { entities: new Map([[host, { itemID: host, position: { x: 0, y: 0, z: 0 },
        direction: { x: 1, y: 0, z: 0 }, radius: 500, mode: "STOP" }]]) };
      const bay = [501, 502, 504].map((id) => ({ itemID: id, typeID: 22544, groupID: 543, categoryID: 6,
        ownerID: id === 504 ? OTHER : CHAR, singleton: 1, itemName: `Hulk ${id}` }));
      const sessions = new Map([[CHAR, { space: { systemId: 30000142, sceneKey, shipId: host } }],
        [OTHER, { space: { systemId: 30000142, sceneKey, shipId: 1000000999 } }]]);
      let nextId = 4.2e15;
      const adapter = {
        findSession: (id) => sessions.get(id) || null,
        spaceOf: (s) => s.space,
        sceneOf: () => scene,
        isSceneLoaded: (key, sc) => key === sceneKey && sc === scene,
        hostEntity: (sc, id) => sc.entities.get(id) || null,
        hostStatus: () => ({ warping: false, docking: false }),
        listBayShips: (hostId) => (hostId === host ? bay : []),
        readFit: () => [],
        isCharge: () => false,
        missingSkills: () => [],
        skillMap: () => new Map(),
        ownerIdentity: () => ({ characterId: CHAR, corporationId: 98000001, allianceId: 0, warFactionId: 0 }),
        allocId: () => {
          nextId += 1;
          return nextId;
        },
        typeName: () => "Hulk",
        spawn: (sc, _systemId, spec) => {
          const entity = { itemID: spec.itemID, spec };
          sc.entities.set(spec.itemID, entity);
          return { ok: true, entity };
        },
        follow: () => true,
        remove: (sc, id) => sc.entities.delete(id),
        entity: (sc, id) => sc.entities.get(id) || null,
        surfaceDistance: () => 1000,
      };
      const store = createWingStore({ filePath: path.join(dir, "wings.json") });
      store.load();
      const cfg = config();
      const wing = createWingService({ adapter, store, config: cfg, clock: fakeClock(), guardsReady: () => true,
        lossReady: () => true, derivedReady: () => true, tickReady: () => true });
      const channel = createClientWindowChannel({ core: wing, config: cfg, clock: fakeClock(), timers: fakeTimers(),
        notify: () => ({ ok: true }) });
      const r = channel.command(CHAR, { ids: [999, 504, 501], verb: "launch" });
      assert.deepStrictEqual(r.result.results.map((x) => [x.shipItemID, x.reason, x.state]),
        [[999, "NOT_IN_SMB", null], [504, "NOT_OWNER", null], [501, null, "ACTIVE"]]);
      assert.strictEqual(r.result.reason, "NOT_IN_SMB");
      const back = channel.command(OTHER, { ids: [501, 502], verb: "return" });
      assert.deepStrictEqual(back.result.results.map((x) => x.reason), ["NOT_OWNER", "NOT_DEPLOYED"]);
      assert.strictEqual(store.get(501).state, "ACTIVE", "the copy of CHAR is untouched");
      wing.stop();
      channel.stop();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("CW17 (copy drones) snapshot: `drones` {mode, out, max} only on an ACTIVE row with WingView.drones "
    + "no field without it, on a bay row or with a bad mode; wire stays v2", () => {
    const row = (extra) => ({ shipItemId: 501, typeId: 627, name: "Vexor", state: "ACTIVE", eligible: false, ...extra });
    const snap = toSnapshot({ ships: [
      row({ drones: { mode: "auto", out: 2, max: 5, phase: "OUT" } }),
      row({ shipItemId: 502, drones: { mode: "off", out: 0, max: null, phase: "NONE" } }),
      row({ shipItemId: 503 }),
      row({ shipItemId: 504, state: "IN_BAY", eligible: true, drones: { mode: "auto", out: 0, max: 5 } }),
      row({ shipItemId: 505, drones: { mode: "x", out: 1, max: 5 } }),
    ] }, ALL_VERBS, uiOf(config()));
    assert.strictEqual(snap.v, 2);
    assert.deepStrictEqual(snap.ships.map((s) => s.drones),
      [{ mode: "auto", out: 2, max: 5 }, { mode: "off", out: 0, max: null }, undefined, undefined, undefined]);
    assert.ok(snap.ships.slice(2).every((s) => !Object.prototype.hasOwnProperty.call(s, "drones")), "field left out");
  });

  test("CW18 (copy drones) SetDrones: core.setDroneMode per ship with the caller's charId; a per-ship "
    + "refusal goes on, any other ends the loop (SKIPPED); BAD_ARGS / TOO_MANY_SHIPS / RATE_LIMIT like Command; "
    + "a success marks the pilot dirty; telemetry client.setDrones.*", () => {
    const core = fakeCore();
    core.modes = [];
    core.setDroneMode = (charId, id, mode) => {
      core.modes.push([charId, id, mode]);
      if (id === 502) return { ok: false, reason: "DRONES_UNAVAILABLE" };
      if (id === 503) return { ok: false, reason: "DISABLED" };
      return { ok: true, state: "ACTIVE", mode };
    };
    const t = setup({ core });
    const token = {};
    assert.strictEqual(t.channel.getState(CHAR, token).ok, true);
    t.sent.length = 0;
    const r = t.channel.setDrones(CHAR, { ids: [501, 502, 501, 503, 504], mode: "off", charId: OTHER });
    assert.deepStrictEqual(r, { ok: true, result: { v: 2, ok: false, reason: "DRONES_UNAVAILABLE", results: [
      { shipItemID: 501, ok: true, reason: null, state: "ACTIVE" },
      { shipItemID: 502, ok: false, reason: "DRONES_UNAVAILABLE", state: null },
      { shipItemID: 503, ok: false, reason: "DISABLED", state: null },
      { shipItemID: 504, ok: false, reason: "SKIPPED", state: null },
    ] } });
    assert.deepStrictEqual(core.modes, [[CHAR, 501, "off"], [CHAR, 502, "off"], [CHAR, 503, "off"]]);
    t.timers.fire();
    assert.deepStrictEqual(t.sent.map((s) => [s.charId, s.type]), [[CHAR, "OnShipWingState"]], "notified after a success");
    t.clock.t += 1000;
    for (const input of [{ ids: [501], mode: "on" }, { ids: [501] }, { ids: [], mode: "auto" }, { ids: [1.5], mode: "off" }]) {
      assert.deepStrictEqual(t.channel.setDrones(CHAR, input), { ok: false, reason: "BAD_ARGS" }, JSON.stringify(input));
    }
    t.clock.t += 1000;
    const many = Array.from({ length: 21 }, (_v, i) => 1000 + i);
    assert.deepStrictEqual(t.channel.setDrones(CHAR, { ids: many, mode: "auto" }), { ok: false, reason: "TOO_MANY_SHIPS" });
    for (let i = 0; i < 4; i += 1) t.channel.setDrones(CHAR, { ids: [501], mode: "auto" });
    assert.deepStrictEqual(t.channel.setDrones(CHAR, { ids: [501], mode: "auto" }), LIMITED);
    assert.deepStrictEqual(t.channel.setDrones(0, { ids: [501], mode: "auto" }), { ok: false, reason: "NO_CHARACTER" });
    const line = formatTelemetry({ client: t.channel.stats() });
    for (const part of ["client.setDrones.ok=5", "client.setDrones.refused.DRONES_UNAVAILABLE=1",
      "client.setDrones.refused.DISABLED=1", "client.rpc.SetDrones="]) {
      assert.ok(line.includes(part), `${part} in ${line}`);
    }
    const noCore = setup();
    assert.deepStrictEqual(noCore.channel.setDrones(CHAR, { ids: [501], mode: "auto" }),
      { ok: false, reason: "UNSUPPORTED_VERB" }, "a core without setDroneMode");
  });

  test("CW19 the HP colour marks go from the config into ui of the state (uiOf -> toSnapshot); no marks in "
    + "the ui object = 0 (the client keeps 70/40)", () => {
    const ui = uiOf(config({ hpWarnPct: 85, hpCriticalPct: 25 }));
    assert.deepStrictEqual([ui.hpWarnPct, ui.hpCriticalPct], [85, 25]);
    const snap = toSnapshot({ ships: [] }, ALL_VERBS, ui);
    assert.deepStrictEqual([snap.ui.hpWarnPct, snap.ui.hpCriticalPct], [85, 25]);
    const old = toSnapshot({ ships: [] }, ALL_VERBS, { pollMs: 5000 });
    assert.deepStrictEqual([old.ui.hpWarnPct, old.ui.hpCriticalPct], [0, 0]);
  });

  test("CW20 button colour switch: uiOf({}) on, clientWindowButtonColors false off "
    + "toSnapshot ui.buttonColors is a bool in both cases", () => {
    assert.strictEqual(uiOf({}).buttonColors, true);
    assert.strictEqual(uiOf({ clientWindowButtonColors: false }).buttonColors, false);
    const on = toSnapshot({ ships: [] }, ALL_VERBS, uiOf({}));
    const off = toSnapshot({ ships: [] }, ALL_VERBS, uiOf({ clientWindowButtonColors: false }));
    assert.deepStrictEqual([on.ui.buttonColors, off.ui.buttonColors], [true, false]);
    assert.strictEqual(on.v, 2, "WIRE stays 2");
  });

  test("CW-active row `active` = WingView.running in ACTIVE_ORDER for an ACTIVE row; IN_BAY, an "
    + "empty list or activeChars 0 -> no field; ui.activeChars in the snapshot, WIRE stays 2", () => {
    const row = (extra) => ({ shipItemId: 501, typeId: 627, name: "Vexor", state: "ACTIVE", eligible: false, ...extra });
    const view = { ships: [
      row({ running: ["web", "weapons", "bogus", "weapons", "hardeners"] }), row({ shipItemId: 502, running: [] }),
      row({ shipItemId: 503, state: "IN_BAY", eligible: true, running: ["weapons"] }), row({ shipItemId: 504 }),
    ] };
    const snap = toSnapshot(view, ALL_VERBS, uiOf(config()));
    assert.deepStrictEqual([snap.v, snap.ui.activeChars, snap.ships.map((s) => s.active)],
      [2, 24, [["weapons", "hardeners", "web"], undefined, undefined, undefined]]);
    assert.ok(snap.ships.slice(1).every((s) => !Object.prototype.hasOwnProperty.call(s, "active")), "field left out");
    const off = toSnapshot(view, ALL_VERBS, uiOf({ ...config(), clientWindowActiveChars: 0 }));
    assert.deepStrictEqual([off.ui.activeChars, off.ships.some((s) => "active" in s)], [0, false]);
  });

  test("CW-engage row `engage` only for ACTIVE + boolean mirrorEngage; SetEngage: BAD_ARGS (mode x) "
    + "ENGAGE_UNAVAILABLE goes on, another refusal ends the loop; telemetry client.setEngage.*; a core without "
    + "setMirrorEngage -> UNSUPPORTED_VERB", () => {
    const row = (extra) => ({ shipItemId: 501, typeId: 627, name: "Vexor", state: "ACTIVE", eligible: false, ...extra });
    const snap = toSnapshot({ ships: [
      row({ mirrorEngage: true }), row({ shipItemId: 502, mirrorEngage: false }), row({ shipItemId: 503 }),
      row({ shipItemId: 504, mirrorEngage: null }), row({ shipItemId: 505, state: "RETURNING", mirrorEngage: true }),
    ] }, ALL_VERBS, uiOf(config()));
    assert.deepStrictEqual(snap.ships.map((s) => s.engage), ["on", "off", undefined, undefined, undefined]);
    assert.ok(snap.ships.slice(2).every((s) => !Object.prototype.hasOwnProperty.call(s, "engage")), "field left out");

    const core = fakeCore();
    core.calls = [];
    core.setMirrorEngage = (charId, id, on) => {
      core.calls.push([charId, id, on]);
      if (id === 502) return { ok: false, reason: "ENGAGE_UNAVAILABLE" };
      if (id === 503) return { ok: false, reason: "DISABLED" };
      return { ok: true, state: "ACTIVE", on };
    };
    const t = setup({ core });
    const r = t.channel.setEngage(CHAR, { ids: [501, 502, 503, 504], mode: "on" });
    assert.deepStrictEqual(r, { ok: true, result: { v: 2, ok: false, reason: "ENGAGE_UNAVAILABLE", results: [
      { shipItemID: 501, ok: true, reason: null, state: "ACTIVE" },
      { shipItemID: 502, ok: false, reason: "ENGAGE_UNAVAILABLE", state: null },
      { shipItemID: 503, ok: false, reason: "DISABLED", state: null },
      { shipItemID: 504, ok: false, reason: "SKIPPED", state: null },
    ] } });
    assert.deepStrictEqual(core.calls, [[CHAR, 501, true], [CHAR, 502, true], [CHAR, 503, true]]);
    assert.deepStrictEqual(t.channel.setEngage(CHAR, { ids: [501], mode: "x" }), { ok: false, reason: "BAD_ARGS" });
    const line = formatTelemetry({ client: t.channel.stats() });
    for (const part of ["client.setEngage.ok=1", "client.setEngage.refused.ENGAGE_UNAVAILABLE=1",
      "client.setEngage.refused.DISABLED=1", "client.rpc.SetEngage="]) {
      assert.ok(line.includes(part), `${part} in ${line}`);
    }
    assert.deepStrictEqual(setup().channel.setEngage(CHAR, { ids: [501], mode: "off" }),
      { ok: false, reason: "UNSUPPORTED_VERB" });
  });

  test("FM-U1 (formations) snapshot `formation` only with core.formationOn; SetFormation: gate "
    + "(NO_CHARACTER, RATE_LIMIT), BAD_ARGS outside ^[a-z]{1,16}$, the core result passed on, a success marks dirty", () => {
    const off = setup();
    off.core.listWing = () => ({ limit: 1, deployedCount: 0, ships: [], formation: null });
    assert.ok(!Object.prototype.hasOwnProperty.call(off.channel.getState(CHAR, {}).snapshot, "formation"));

    const core = fakeCore();
    core.formationOn = true;
    core.FORMATIONS = ["none", "wedge", "line", "column", "sphere"];
    let current = "none";
    const base = core.listWing;
    core.listWing = (charId) => ({ ...base(charId), formation: current });
    core.setFormation = (charId, name) => {
      if (name === "foo") return { ok: false, reason: "FORMATION_INVALID" };
      current = name;
      return { ok: true, formation: name, persisted: false };
    };
    const t = setup({ core });
    const token = {};
    assert.deepStrictEqual(t.channel.getState(CHAR, token).snapshot.formation,
      { current: "none", options: ["none", "wedge", "line", "column", "sphere"] });
    assert.deepStrictEqual(t.channel.setFormation(0, { name: "wedge" }), { ok: false, reason: "NO_CHARACTER" });
    for (const name of [undefined, 5, "", "Wedge", "a".repeat(17), "line 2"]) {
      t.clock.t += 1000;
      assert.deepStrictEqual(t.channel.setFormation(CHAR, { name }), { ok: false, reason: "BAD_ARGS" }, String(name));
    }
    t.clock.t += 1000;
    assert.deepStrictEqual(t.channel.setFormation(CHAR, { name: "foo" }), { ok: true, result: { v: 2, ok: false,
      reason: "FORMATION_INVALID", formation: null, persisted: null } });
    assert.strictEqual(t.channel.stats().dirty, 0, "a refusal marks nothing");
    assert.deepStrictEqual(t.channel.setFormation(CHAR, { name: "wedge" }), { ok: true, result: { v: 2, ok: true,
      reason: null, formation: "wedge", persisted: false } });
    assert.strictEqual(t.channel.stats().dirty, 1, "success -> dirty");
    t.timers.fire();
    assert.strictEqual(t.sent.at(-1).snapshot.formation.current, "wedge");
    const max = config().clientWindowMaxCommandsPerSecond;
    t.clock.t += 1000;
    for (let i = 0; i < max; i += 1) t.channel.setFormation(CHAR, { name: "line" });
    assert.deepStrictEqual(t.channel.setFormation(CHAR, { name: "line" }), LIMITED);
    const line = formatTelemetry({ client: t.channel.stats() });
    for (const part of ["client.setFormation.ok=", "client.setFormation.refused.FORMATION_INVALID=1",
      "client.rpc.SetFormation="]) {
      assert.ok(line.includes(part), `${part} in ${line}`);
    }
    t.clock.t += 1000;
    assert.deepStrictEqual(setup().channel.setFormation(CHAR, { name: "line" }), { ok: false, reason: "UNSUPPORTED_VERB" });
  });

  test("CW-B1 (board) rowVerbs: board last for an ACTIVE / RETURNING copy within the range, none "
    + "without the server board or out of range; Command board -> the server board with the row's twin, a refusal "
    + "as the per-ship reason, the rest SKIPPED; without the server board UNSUPPORTED_VERB", () => {
    const board = { rangeM: 6550 };
    const row = (state, distanceM) => ({ state, eligible: false, entityId: 4200000000000001, distanceM });
    assert.deepStrictEqual(rowVerbs(row("ACTIVE", 1122), ALL_VERBS, board), [...rowVerbs(row("ACTIVE", 1122),
      ALL_VERBS), "board"]);
    assert.deepStrictEqual(rowVerbs(row("RETURNING", 6550), ALL_VERBS, board), ["board"]);
    assert.deepStrictEqual(rowVerbs(row("ACTIVE", 7000), ["return"], board), ["return"], "out of range");
    assert.deepStrictEqual(rowVerbs(row("ACTIVE", null), ["return"], board), ["return"], "unknown distance");
    assert.deepStrictEqual(rowVerbs(row("LOST", 10), ALL_VERBS, board), []);
    assert.deepStrictEqual(rowVerbs(row("ACTIVE", 10), ["return"]), ["return"], "server board off");

    const calls = [];
    const t = setup({ board: (charId, twinId) => {
      calls.push([charId, twinId]);
      return calls.length === 1 ? { ok: true, shipItemId: 501 } : { ok: false, reason: "TOO_FAR", text: "x" };
    } });
    assert.deepStrictEqual(t.channel.getState(CHAR, {}).snapshot.ships[0].verbs, ["return", "board"]);
    const ok = t.channel.command(CHAR, { ids: [501], verb: "board" });
    assert.deepStrictEqual([ok.result.ok, ok.result.results], [true, [{ shipItemID: 501, ok: true, reason: null,
      state: null }]]);
    const no = t.channel.command(CHAR, { ids: [501, 502], verb: "board" });
    assert.deepStrictEqual(no.result.results.map((r) => r.reason), ["TOO_FAR", "SKIPPED"]);
    assert.deepStrictEqual(calls, [[CHAR, 4200000000000001], [CHAR, 4200000000000001]]);
    assert.strictEqual(t.core.calls.length, 0, "no orderCopy");
    assert.deepStrictEqual(setup().channel.command(CHAR, { ids: [501], verb: "board" }),
      { ok: false, reason: "UNSUPPORTED_VERB" });
  });
};
