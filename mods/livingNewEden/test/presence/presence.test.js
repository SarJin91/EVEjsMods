"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const { resolveConfig } = require("../../config");
const { findServerSrcOnDisk } = require("../../lib/adapter/locator");
const { GAME_MODULES } = require("../../lib/adapter/gameModules");
const { readPresenceFrom } = require("../../lib/adapter/sessionPresence");
const { wrapPresenceNudge } = require("../../lib/adapter/presenceHooks");
const { startPresence, createUnavailablePresence } = require("../../lib/presence");
const { buildPlayersLayerView } = require("../../lib/presence/playersLayer");
const { createViewRegistry } = require("../../lib/observer/views");
const { buildUniverseGraph } = require("../../lib/graph/universeGraph");
const { readStaticMapFrom } = require("../../lib/adapter/staticMap");
const { S, rawWorld } = require("../graph/fixtures/routeMap.fixture");
const { loadSecurityBand } = require("../graph/fixtures/staticMap.fixture");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const DEFAULTS = resolveConfig({ modDir: MOD_DIR, env: {} }).config;
const SYS_A = 30000142;
const SYS_B = 30000144;

function configWith(presence = {}, observer = {}) {
  return { ...DEFAULTS, presence: { ...DEFAULTS.presence, ...presence },
    observer: { ...DEFAULTS.observer, ...observer } };
}

function fakeTimers() {
  const pending = [];
  return {
    pending,
    setTimer(fn, ms) {
      const t = { fn, ms, cancelled: false };
      pending.push(t);
      return { cancel: () => { t.cancelled = true; }, hasRef: () => false };
    },
    flush() {
      const due = pending.splice(0).filter((t) => !t.cancelled);
      for (const t of due) t.fn();
      return due.length;
    },
  };
}

function session(characterID, name, extra) {
  return { characterID, characterName: name, ...extra };
}

function fakeAdapter(sessionsRef, extra = {}) {
  return {
    readPresence: (opts) => readPresenceFrom({ getSessions: () => sessionsRef.list() }, opts),
    subscribeSessionNudges: () => ({ ok: true, unwrap() {}, errors: () => 0 }),
    ...extra,
  };
}

function vanillaRuntime(calls) {
  class SpaceRuntime {
    constructor() { this.scenes = new Map(); }
  }
  const mixin = {
    attachSession(sessionArg) {
      calls.push(["attach", sessionArg]);
      if (sessionArg === "boom") throw new Error("original threw");
      this.detachSession(sessionArg, { broadcast: false });
      return { attached: sessionArg };
    },
    detachSession(sessionArg) {
      calls.push(["detach", sessionArg]);
      return null;
    },
  };
  for (const [name, d] of Object.entries(Object.getOwnPropertyDescriptors(mixin))) {
    Object.defineProperty(SpaceRuntime.prototype, name, { ...d, enumerable: false, writable: true,
      configurable: true });
  }
  const singleton = new SpaceRuntime();
  const exportsObject = {};
  Object.setPrototypeOf(exportsObject, Object.getPrototypeOf(singleton));
  Object.assign(exportsObject, singleton);
  return { exportsObject, proto: SpaceRuntime.prototype };
}

module.exports = ({ test, bench }) => {
  function vendorFacts(full) {
    const found = findServerSrcOnDisk(MOD_DIR, 5, fs.existsSync);
    assert.ok(found.ok, "EveJS server/src not found above the mod");
    const read = (...p) => fs.readFileSync(path.join(found.srcDir, ...p), "utf8");
    const sessions = read("space", "runtime", "spaceRuntime", "sessions.js");
    assert.match(sessions, /^attachSession\(/m);
    assert.match(sessions, /^detachSession\(/m);
    const docked = sessions.slice(sessions.indexOf("bootstrapDockedStructureView("));
    assert.ok(docked.includes("session._space = session._structureViewSpace"), "structure dock sets _space");
    const registry = read("services", "chat", "sessionRegistry.js");
    const block = registry.slice(registry.search(/^module\.exports = \{/m));
    assert.match(block.slice(0, block.search(/^\};/m)), /^ {2}getSessions,/m);
    const character = read("services", "character", "characterState.js");
    for (const field of ["session.characterName =", "session.stationid =", "session.structureid =",
      "session.solarsystemid2 ="]) assert.ok(character.includes(field), field);
    assert.strictEqual(new Set(GAME_MODULES.map((e) => e.path)).size, 159);
    if (!full) return;
    const destructured = /\{[^}]*\b(attachSession|detachSession)\b[^}]*\}\s*=/;
    const offenders = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith(".js") && destructured.test(fs.readFileSync(full, "utf8"))) offenders.push(full);
      }
    };
    walk(found.srcDir);
    assert.deepStrictEqual(offenders, []);
  }
  bench("P1 presence vendor facts: attach/detach mixins, docked structure _space, getSessions, session fields, "
    + "no destructuring in server/src", () => vendorFacts(true));
  test("P1s presence vendor facts short: attach/detach mixins, docked structure _space, getSessions, session fields",
    () => vendorFacts(false));

  test("P2 presence nudge: chained wrap on the prototype, double wrap, throws, unwrap under a foreign wrap", () => {
    const calls = [];
    const { exportsObject, proto } = vanillaRuntime(calls);
    const nudges = [];
    let throwNudge = false;
    const w = wrapPresenceNudge(exportsObject, (name) => {
      nudges.push(name);
      if (throwNudge) throw new Error("mod boom");
    });
    assert.strictEqual(w.ok, true);
    assert.deepStrictEqual(exportsObject.attachSession("s1"), { attached: "s1" });
    assert.deepStrictEqual(calls, [["attach", "s1"], ["detach", "s1"]], "original once, internal detach too");
    assert.deepStrictEqual(nudges, ["detachSession", "attachSession"]);

    const foreign = [];
    const below = proto.attachSession;
    proto.attachSession = function otherMod(...args) {
      foreign.push(args[0]);
      return below.apply(this, args);
    };
    calls.length = 0;
    nudges.length = 0;
    assert.deepStrictEqual(exportsObject.attachSession("s2"), { attached: "s2" });
    assert.deepStrictEqual(foreign, ["s2"]);
    assert.strictEqual(calls.filter((c) => c[0] === "attach").length, 1);
    assert.deepStrictEqual(nudges, ["detachSession", "attachSession"]);

    throwNudge = true;
    assert.deepStrictEqual(exportsObject.attachSession("s3"), { attached: "s3" }, "a throwing nudge is swallowed");
    assert.strictEqual(w.errors(), 2);
    throwNudge = false;
    nudges.length = 0;
    assert.throws(() => exportsObject.attachSession("boom"), /original threw/);
    assert.deepStrictEqual(nudges, ["attachSession"], "nudge also after a throw of the original");
    assert.deepStrictEqual(wrapPresenceNudge(exportsObject, () => {}), { ok: false, reason: "already_wrapped" });

    w.unwrap();
    assert.strictEqual(proto.attachSession.name, "otherMod", "foreign wrapper stays on top");
    nudges.length = 0;
    calls.length = 0;
    assert.deepStrictEqual(exportsObject.attachSession("s4"), { attached: "s4" });
    assert.deepStrictEqual(nudges, [], "pass-through after unwrap");
    assert.strictEqual(calls.length, 2, "chain intact");
    assert.notStrictEqual(Object.getOwnPropertyDescriptor(proto, "detachSession").value.name,
      "livingNewEdenPresenceNudge", "detachSession restored (we were on top)");

    let asked = 0;
    const list = { list: () => [] };
    const timers = fakeTimers();
    const started = startPresence({ config: configWith({ hookEnabled: false }),
      adapter: fakeAdapter(list, { subscribeSessionNudges: () => { asked += 1; return { ok: true }; } }),
      setTimer: timers.setTimer, now: () => 0 });
    assert.strictEqual(started.ok, true);
    assert.strictEqual(asked, 0);
    assert.strictEqual(started.presence.getStatus().hook, "off");
    started.presence.stop("test");
  });

  test("P3 presence index: states, events order, versions, callback errors, stale, truncation, nudge", () => {
    let sessions = [];
    const ref = { list: () => sessions };
    let throwRead = false;
    const timers = fakeTimers();
    let nudge = null;
    const adapter = fakeAdapter(ref, {
      readPresence: (opts) => (throwRead ? { ok: false, reason: "SESSIONS_UNAVAILABLE", detail: "x" }
        : readPresenceFrom({ getSessions: () => ref.list() }, opts)),
      subscribeSessionNudges: (fn) => { nudge = fn; return { ok: true, unwrap() {}, errors: () => 0 }; },
    });
    const lines = [];
    const started = startPresence({ config: configWith(), adapter, setTimer: timers.setTimer, now: () => 0,
      logger: { log: (l) => lines.push(l) } });
    assert.strictEqual(started.ok, true);
    const p = started.presence;
    assert.ok(lines.some((l) => l.startsWith("presence: running characters=0 systems=0 hook=on poll=1000ms")),
      lines.join("\n"));
    const events = [];
    p.onSystemObserved((id, info) => events.push(["in", id, info.total]));
    p.onSystemUnobserved((id) => events.push(["out", id]));
    const v0 = p.getVersion();

    sessions = [session(1, "Alpha", { _space: { systemID: SYS_A }, solarsystemid2: SYS_A })];
    p.refreshNow();
    assert.strictEqual(p.isObserved(SYS_A), true);
    assert.deepStrictEqual(events, [["in", SYS_A, 1]]);
    const v1 = p.getVersion();
    assert.ok(v1 > v0);

    sessions.push(session(2, "Bravo", { stationid: 60003760, solarsystemid2: SYS_A }));
    sessions.push(session(3, "Charlie", { structureid: 1035466617946, solarsystemid2: SYS_A,
      _space: { systemID: SYS_A } }));
    sessions.push(session(4, "Delta", { solarsystemid2: SYS_A }));
    sessions.push(session(0, "", { solarsystemid2: SYS_A }));
    p.refreshNow();
    assert.strictEqual(events.length, 1, "no event for a second character");
    assert.strictEqual(p.getVersion(), v1 + 1);
    const a = p.getSystemPresence(SYS_A);
    assert.deepStrictEqual([a.total, a.space, a.docked, a.transit], [4, 1, 2, 1]);
    assert.deepStrictEqual(a.characters.map((c) => [c.name, c.state]),
      [["Alpha", "space"], ["Bravo", "docked"], ["Charlie", "docked"], ["Delta", "transit"]]);
    p.refreshNow();
    assert.strictEqual(p.getVersion(), v1 + 1, "same state twice -> same version");

    sessions = [session(1, "Alpha", { _space: { systemID: SYS_B }, solarsystemid2: SYS_B })];
    events.length = 0;
    p.onSystemObserved(() => { throw new Error("consumer boom"); });
    const late = [];
    p.onSystemObserved((id) => late.push(id));
    p.refreshNow();
    assert.deepStrictEqual(events, [["out", SYS_A], ["in", SYS_B, 1]], "leave A, then enter B");
    assert.deepStrictEqual(late, [SYS_B], "the next callback still runs");
    assert.strictEqual(p.getStatus().callbackErrors, 1);

    throwRead = true;
    events.length = 0;
    p.refreshNow();
    assert.strictEqual(p.getStatus().stale, true);
    assert.strictEqual(p.isObserved(SYS_B), true, "D-f: the last known state stays");
    assert.deepStrictEqual(events, [], "no unobserved on a read error");
    throwRead = false;

    const small = readPresenceFrom({ getSessions: () => [
      session(1, "A", { solarsystemid2: SYS_A, stationid: 1 }),
      session(2, "B", { solarsystemid2: SYS_B, stationid: 1 }),
    ] }, { maxCharacters: 1 });
    assert.deepStrictEqual([small.truncated, small.characters.length, small.overflowSystems], [true, 1, [SYS_B]]);

    sessions = [];
    p.refreshNow();
    assert.strictEqual(p.getStatus().stale, false);
    assert.strictEqual(p.isObserved(SYS_B), false, "last one gone -> unobserved");

    const before = p.getStatus().lastPollMs;
    const passesBefore = timers.pending.length;
    sessions = [session(9, "Echo", { _space: { systemID: SYS_A } })];
    nudge("attachSession");
    assert.strictEqual(p.isObserved(SYS_A), false, "nothing read synchronously");
    assert.ok(timers.pending.length > passesBefore && timers.pending.some((t) => t.ms === 0 && !t.cancelled));
    timers.flush();
    assert.strictEqual(p.isObserved(SYS_A), true);
    assert.strictEqual(p.getStatus().nudges, 1);
    assert.ok(before !== undefined);

    p.stop("test");
    const off = createUnavailablePresence("PRESENCE_DISABLED");
    assert.strictEqual(off.getStatus().available, false);
    assert.deepStrictEqual(off.distanceToObserved(SYS_A), { ok: false, reason: "PRESENCE_UNAVAILABLE" });
  });

  test("P4 presence radius: distances 0/1/null, observedWithin, clamp to maxRadius, graph not ready", () => {
    const built = buildUniverseGraph(readStaticMapFrom({ ensureLoaded: () => rawWorld() }, loadSecurityBand()).map);
    let ready = false;
    const graph = { getGraph: () => (ready ? { ok: true, graph: built.graph }
      : { ok: false, reason: "GRAPH_NOT_READY" }) };
    const ref = { list: () => [session(1, "A", { _space: { systemID: S.N0 } })] };
    const timers = fakeTimers();
    const p = startPresence({ config: configWith({ neighborRadius: 1, maxRadius: 2 }), adapter: fakeAdapter(ref),
      graph, setTimer: timers.setTimer, now: () => 0 }).presence;
    assert.deepStrictEqual(p.distanceToObserved(S.N0), { ok: false, reason: "GRAPH_NOT_READY" });
    ready = true;
    assert.deepStrictEqual(p.distanceToObserved(S.N0), { ok: true, distance: 0 });
    assert.deepStrictEqual(p.distanceToObserved(S.H1), { ok: true, distance: 1 });
    assert.deepStrictEqual(p.distanceToObserved(S.N9), { ok: true, distance: null }, "2 jumps > radius 1");
    assert.deepStrictEqual(p.observedWithin(2).systems.map((e) => [...e]),
      [[S.N0, 0], [S.H1, 1], [S.L1, 1], [S.L2, 2], [S.N5, 1], [S.N6, 2], [S.N9, 2]]);
    assert.deepStrictEqual(p.distanceToObserved(S.N7, 9), { ok: true, distance: null }, "radius clamped to 2");
    p.stop("test");
  });

  test("P5 players layer + page: MarksData, cacheKey, switch, ingestMarks, retryAfter", () => {
    let sessions = [
      session(1, "Alpha", { _space: { systemID: SYS_A } }),
      session(2, "Bravo", { stationid: 1, solarsystemid2: SYS_A }),
      session(3, "Charlie", { stationid: 1, solarsystemid2: SYS_B }),
    ];
    const timers = fakeTimers();
    const views = createViewRegistry();
    const p = startPresence({ config: configWith({}, { galaxyPlayersMaxNames: 1 }),
      adapter: fakeAdapter({ list: () => sessions }), views, setTimer: timers.setTimer, now: () => 0 }).presence;
    assert.deepStrictEqual(views.listMapLayers().map((l) => [l.id, l.kind]), [["layer-players", "marks"]]);
    const view = views.getView("layer-players");
    const data = view.getData();
    assert.deepStrictEqual(data.legend, [["space", "in space", "#3ee07a"], ["docked", "docked", "#5aa0ff"]]);
    assert.deepStrictEqual(data.items, [
      [SYS_A, "space", "2", ["Alpha - in space", "+1 more"]],
      [SYS_B, "docked", "1", ["Charlie - docked"]],
    ]);
    assert.strictEqual(data.note, "3 players in 2 systems");
    const k1 = view.cacheKey();
    p.refreshNow();
    assert.strictEqual(view.cacheKey(), k1, "same presence -> same key");
    sessions = sessions.slice(0, 2);
    p.refreshNow();
    assert.notStrictEqual(view.cacheKey(), k1);
    const noNames = buildPlayersLayerView({ presence: p, maxNames: 0 }).getData();
    assert.strictEqual(noNames.items[0][3], null);
    p.stop("test");
    assert.strictEqual(views.getView("layer-players"), null, "unregistered on stop");

    const views2 = createViewRegistry();
    const p2 = startPresence({ config: configWith({}, { galaxyPlayersEnabled: false }),
      adapter: fakeAdapter({ list: () => [] }), views: views2, setTimer: timers.setTimer, now: () => 0 }).presence;
    assert.deepStrictEqual(views2.listMapLayers(), []);
    p2.stop("test");

    const sandbox = { window: {} };
    vm.runInNewContext(fs.readFileSync(path.join(MOD_DIR, "web", "galaxy.js"), "utf8"), sandbox,
      { filename: "galaxy.js" });
    const pure = sandbox.window.LneGalaxy._pure;
    const marks = pure.ingestMarks({ legend: [["space", "in space", "#3ee07a"], ["bad", "bad", "red"]],
      items: [[SYS_A, "space", "2", ["x"]], [SYS_B, "bad", "1", null], [99, "space", "1", null],
        [SYS_A + 1, "nope", null, null]] }, new Map([[SYS_A, 0], [SYS_B, 1], [SYS_A + 1, 2]]));
    assert.strictEqual(marks.offMap, 1);
    assert.strictEqual(marks.byIndex.get(0).color, "#3ee07a");
    assert.strictEqual(marks.byIndex.get(1).color, "#ffffff", "bad colour -> default");
    assert.strictEqual(marks.byIndex.get(2).color, "#ffffff", "unknown style -> default");
    assert.strictEqual(marks.byIndex.get(0).lines[0], "x");
    assert.strictEqual(marks.byIndex.get(2).label, null);
    assert.deepStrictEqual([1, 2, 3, 4, 5, 6].map((n) => pure.retryAfter(n)), [1, 2, 4, 8, 12, 12]);
  });
};
