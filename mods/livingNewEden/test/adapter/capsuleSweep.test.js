"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { wrapBoardForCapsuleSweep, installCapsuleSweep, createCapsuleSweepTools, PATHS } =
  require("../../lib/adapter/capsuleSweep");
const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
const { buildHooks } = require("../../loader");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const CHAR = 90000001;
const SYS = 30001429;
const CAP = 9988400027100;
const SHIP = 9988400027037;
const CAPSULE_TYPE = 670;
const SHIP_TYPE = 587;

function makeWorld(opts = {}) {
  const calls = { vendor: [], queue: [], removeEntity: [], removeItem: [], tools: 0 };
  const counts = {};
  const lines = [];
  const session = { characterID: CHAR, clientID: 65450, solarsystemid2: SYS };
  let active = { itemID: CAP, typeID: CAPSULE_TYPE };
  let known = "b1";
  const entities = new Map([
    [CAP, { itemID: CAP, kind: "ship", session: opts.entitySession ? session : null }],
    [SHIP, { itemID: SHIP, kind: "ship", session: null }],
  ]);
  const items = new Map([[CAP, { itemID: CAP, typeID: CAPSULE_TYPE, ownerID: CHAR, locationID: SYS, flagID: 0,
    ...(opts.itemPatch || {}) }]]);
  const scene = {
    systemID: SYS,
    getKnownGridBubbleIDForSession: (s) => (s === session ? known : null),
    getEntityByID: (id) => entities.get(Number(id)) || null,
    removeDynamicEntity: (id, options) => {
      calls.removeEntity.push({ id, options });
      const e = entities.get(id);
      if (e && e.session && !(options && options.allowSessionOwned)) {
        return { success: false, errorMsg: "DYNAMIC_ENTITY_SESSION_OWNED" };
      }
      entities.delete(id);
      return { success: true };
    },
    queueCharacterHistory: (s, updates) => {
      calls.queue.push({ session: s, updates });
      return opts.notObserver ? null : 7;
    },
  };
  const tools = {
    getActiveShipRecord: (charId) => (charId === CHAR ? active : null),
    findItemById: (id) => items.get(id) || null,
    isCapsuleTypeID: (t) => t === CAPSULE_TYPE,
    removeInventoryItem: (id, options) => {
      calls.removeItem.push({ id, options });
      items.delete(id);
      return { success: true };
    },
    getSceneForSession: () => scene,
    buildRemoveBallsPayload: (ids) => ["RemoveBalls", [ids.slice()]],
  };
  const vendorResult = opts.vendorResult || { success: true, data: { ship: { itemID: SHIP } } };
  const original = function vendorBoard(...args) {
    calls.vendor.push({ self: this, args });
    if (!opts.stayInCapsule) {
      active = { itemID: SHIP, typeID: SHIP_TYPE };
      if (!opts.keepEntity && !opts.entitySession) entities.delete(CAP);
      if (!opts.keepItem) items.delete(CAP);
      known = opts.knownAfter === undefined ? "b1" : opts.knownAfter;
    }
    if (opts.vendorThrows) throw opts.vendorThrows;
    return vendorResult;
  };
  const w = wrapBoardForCapsuleSweep(original, {
    getTools: () => {
      calls.tools += 1;
      if (opts.toolsThrow) throw new Error("tools gone");
      return tools;
    },
    isEnabled: () => opts.enabled !== false,
    resendEnabled: () => opts.resend !== false,
    count: (name) => { counts[name] = (counts[name] || 0) + 1; },
    logLine: (text) => lines.push(text),
  });
  assert.strictEqual(w.ok, true, JSON.stringify(w));
  return { wrapped: w.wrapped, original, calls, counts, lines, session, vendorResult };
}

module.exports = ({ test }) => {
  test("T1 the proven error path: observer known before, forgotten after, capsule consumed -> exactly one "
    + "RemoveBalls([capsule]) to the pilot, the vendor result unchanged, no sweep", () => {
    const w = makeWorld({ knownAfter: null });
    const self = { service: true };
    const r = w.wrapped.call(self, w.session, SHIP);
    assert.strictEqual(r, w.vendorResult);
    assert.strictEqual(w.calls.vendor.length, 1);
    assert.strictEqual(w.calls.vendor[0].self, self);
    assert.deepStrictEqual(w.calls.vendor[0].args, [w.session, SHIP]);
    assert.strictEqual(w.calls.queue.length, 1);
    assert.strictEqual(w.calls.queue[0].session, w.session);
    assert.deepStrictEqual(w.calls.queue[0].updates, [{ payload: ["RemoveBalls", [[CAP]]] }]);
    assert.deepStrictEqual([w.calls.removeEntity, w.calls.removeItem], [[], []]);
    assert.deepStrictEqual(w.counts, { boardsFromCapsule: 1, observerForgotten: 1, resent: 1 });
    assert.deepStrictEqual(w.lines, [`capsuleSweep: ship=${SHIP} capsule=${CAP} vendor=ok observerForgotten=true `
      + "resent=true swept=none"]);
    const refused = makeWorld({ knownAfter: null, notObserver: true });
    refused.wrapped(refused.session, SHIP);
    assert.deepStrictEqual(refused.counts, { boardsFromCapsule: 1, observerForgotten: 1, resendRefused: 1 });
  });

  test("T2 a normal board (another player in the system): the observer stays known -> no resend, clean; "
    + "resendRemoval=false with a forgotten observer -> counted, nothing sent", () => {
    const w = makeWorld();
    assert.strictEqual(w.wrapped(w.session, SHIP), w.vendorResult);
    assert.deepStrictEqual(w.calls.queue, []);
    assert.deepStrictEqual(w.counts, { boardsFromCapsule: 1, clean: 1 });
    assert.ok(w.lines[0].includes("observerForgotten=false resent=false swept=none"), w.lines.join("\n"));

    const off = makeWorld({ knownAfter: null, resend: false });
    off.wrapped(off.session, SHIP);
    assert.deepStrictEqual(off.calls.queue, []);
    assert.deepStrictEqual(off.counts, { boardsFromCapsule: 1, observerForgotten: 1 });
  });

  test("T3 the safety sweep (B) and its guards", () => {
    const failed = { success: false, errorMsg: "CAPSULE_REMOVAL_DELIVERY_FAILED" };
    const b = makeWorld({ vendorResult: failed, keepEntity: true, keepItem: true, knownAfter: null });
    assert.strictEqual(b.wrapped(b.session, SHIP), failed);
    assert.deepStrictEqual(b.calls.removeEntity, [{ id: CAP, options: {} }]);
    assert.deepStrictEqual(b.calls.removeItem, [{ id: CAP, options: { removeContents: true } }]);
    assert.strictEqual(b.calls.queue.length, 1);
    assert.deepStrictEqual(b.counts, { boardsFromCapsule: 1, observerForgotten: 1, resent: 1, swept: 1,
      sweptAfterVendorFailure: 1 });
    assert.ok(b.lines[0].includes("vendor=CAPSULE_REMOVAL_DELIVERY_FAILED") && b.lines[0].endsWith("swept=entity+item"));
    const known = makeWorld({ vendorResult: failed, keepEntity: true, keepItem: true });
    known.wrapped(known.session, SHIP);
    assert.deepStrictEqual([known.calls.removeEntity.length, known.calls.removeItem.length, known.calls.queue.length],
      [1, 1, 0]);

    const stay = makeWorld({ stayInCapsule: true, vendorResult: { success: false, errorMsg: "TOO_FAR" } });
    stay.wrapped(stay.session, SHIP);
    assert.deepStrictEqual([stay.calls.removeEntity, stay.calls.removeItem, stay.calls.queue, stay.lines],
      [[], [], [], []]);
    const owned = makeWorld({ entitySession: true, knownAfter: null });
    owned.wrapped(owned.session, SHIP);
    assert.deepStrictEqual([owned.calls.removeEntity, owned.calls.queue], [[], []]);
    assert.strictEqual(owned.counts.entityRefused, 1);
    for (const itemPatch of [{ flagID: 4 }, { locationID: SYS + 1 }, { ownerID: CHAR + 1 }]) {
      const keep = makeWorld({ keepItem: true, itemPatch });
      keep.wrapped(keep.session, SHIP);
      assert.deepStrictEqual(keep.calls.removeItem, [], JSON.stringify(itemPatch));
      assert.strictEqual(keep.counts.itemRefused, 1, JSON.stringify(itemPatch));
    }
    const self = makeWorld();
    const before = self.calls.tools;
    self.wrapped(self.session, CAP);
    assert.deepStrictEqual([self.calls.vendor.length, self.calls.tools - before, self.calls.queue, self.counts],
      [1, 1, [], {}]);
  });

  test("T4 exceptions and flags: a vendor exception passes unchanged, a throwing reader never reaches the caller, "
    + "off -> no tools read, a second install is alreadyInstalled; the loader hook wraps only when on", () => {
    const boom = new Error("vendor says no");
    const thrower = makeWorld({ vendorThrows: boom });
    assert.throws(() => thrower.wrapped(thrower.session, SHIP), (err) => err === boom);
    assert.ok(thrower.lines[0].includes("vendor=threw"), thrower.lines.join("\n"));

    const broken = makeWorld({ toolsThrow: true });
    assert.strictEqual(broken.wrapped(broken.session, SHIP), broken.vendorResult);
    assert.deepStrictEqual([broken.counts, broken.calls.vendor.length], [{ errors: 1 }, 1]);

    const off = makeWorld({ enabled: false });
    assert.strictEqual(off.wrapped(off.session, SHIP), off.vendorResult);
    assert.deepStrictEqual([off.calls.tools, off.counts], [0, {}]);

    const exportsObject = { boardSpaceShip: off.wrapped };
    assert.deepStrictEqual(installCapsuleSweep(exportsObject, (o) => wrapBoardForCapsuleSweep(o, {})),
      { ok: true, alreadyInstalled: true });
    assert.deepStrictEqual(installCapsuleSweep(Object.freeze({ boardSpaceShip() {} }), () => null),
      { ok: false, reason: "SEAM_NOT_WRITABLE" });

    const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
    assert.ok(found.ok, JSON.stringify(found));
    const request = path.join(found.srcDir, "space", "transitions");
    for (const on of [true, false]) {
      const lines = [];
      const ctx = { logger: { log: (l) => lines.push(l), debug() {} }, state: {},
        loadConfig: () => ({ ok: true, config: { enabled: true,
          capsuleSweep: { enabled: on, resendRemoval: true, logIntervalMs: 60000 } } }) };
      const hook = buildHooks(ctx).find((h) => h.name === "capsuleSweep");
      const vendor = function boardSpaceShip() { return "vendor"; };
      const ex = { boardSpaceShip: vendor, ejectSession() {} };
      assert.strictEqual(hook.match(request, ex), true);
      assert.strictEqual(hook.match(request, {}), false, "partial exports of a cycle");
      assert.strictEqual(hook.match(path.join(found.srcDir, "space", "runtime"), { boardSpaceShip() {} }), false);
      hook.run(ex, request, null);
      const { boardSpaceShip } = ex;
      assert.strictEqual(boardSpaceShip !== vendor, on, `wrapped=${on}`);
      assert.strictEqual(ctx.state.capsuleSweep, on ? "wrapped" : "disabled");
      assert.strictEqual(boardSpaceShip({ characterID: CHAR }, SHIP), "vendor");
      if (on) assert.ok(lines.some((l) => l.startsWith("capsuleSweep: wrapped")), lines.join("\n"));
    }
  });

  test("T5 vendor facts of the cause and the seam; the tools over fake vendor exports", () => {
    const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
    assert.ok(found.ok, JSON.stringify(found));
    const read = (...p) => fs.readFileSync(path.join(found.srcDir, ...p), "utf8").replace(/\r\n/g, "\n");
    const block = (text, header) => {
      const at = text.indexOf(`\n${header}`);
      assert.ok(at >= 0, header);
      const rest = text.slice(at + 1);
      const end = rest.slice(header.length).search(/\n\S/);
      return end === -1 ? rest : rest.slice(0, header.length + end);
    };

    const transitions = read("space", "transitions.js");
    assert.ok(/^function boardSpaceShip\(session, shipID, \{ abandonCurrentHull = false \} = \{\}\) \{/m.test(transitions),
      "definer");
    assert.ok(read("services", "ship", "shipService.js")
      .includes("boardSpaceShip(session, shipID, { abandonCurrentHull: true })"), "the options argument passes through");
    assert.strictEqual(transitions.split("boardSpaceShip(").length - 1, 1, "no internal call");
    assert.ok(/^ {2}boardSpaceShip,$/m.test(transitions) && /^ {2}ejectSession,$/m.test(transitions), "exported");
    const destructures = /const \{[^}]*\bboardSpaceShip,[^}]*\} = require\(path\.join\(__dirname, "\.\.\/\.\.\/space\/transitions"\)\)/;
    for (const file of ["shipService.js", "ejectRuntime.js", "spaceShipSwapRuntime.js"]) {
      assert.ok(destructures.test(read("services", "ship", file)), file);
    }

    const runtime = path.join("space", "runtime");
    assert.ok(block(read(runtime, "scene", "sessions.js"), "disembarkSession(session, options = {}) {")
      .includes("this.sessions.delete(session.clientID)"), "disembark empties scene.sessions");
    assert.ok(read(runtime, "spaceRuntime", "universeSites.js").includes("existingScene.sessions.size <= 0"));
    const registry = read(runtime, "spaceRuntime", "sceneRegistry.js");
    assert.ok(registry.includes("before.sessionCount === 0") && registry.includes("scene.tick("), "wake tick");
    assert.ok(block(read(runtime, "scene", "visibility.js"), "updateGridBubbles(frame = null) {")
      .includes("gridBubbles.forgetObserver(park, id)"), "the bubble update forgets a session outside the scene");
    assert.ok(read("space", "destiny", "visibility", "gridBubbles.js")
      .includes("const oldMarks = oldBubble === null ? new Map()"), "diff from null has no removals");
    const actions = read("space", "destiny", "stream", "actions.js");
    assert.ok(actions.includes("function buildRemoveBallsPayload(entityIDs) {") && /^ {2}buildRemoveBallsPayload,$/m
      .test(actions));
    assert.ok(read("space", "destiny", "index.js").includes("  ...actions,"), "re-exported by destiny/index");
    assert.ok(read(runtime, "scene", "destinyHistory.js").includes("queueCharacterHistory(session, updates, options"));

    const fake = {
      [PATHS.characterState]: { getActiveShipRecord: (id) => ({ itemID: id }) },
      [PATHS.itemStore]: { findItemById: () => null, isCapsuleTypeID: (t) => t === CAPSULE_TYPE,
        removeInventoryItem: () => ({ success: true }) },
      [PATHS.runtime]: { getSceneForSession: () => "scene" },
      [PATHS.actions]: { buildRemoveBallsPayload: (ids) => ["RemoveBalls", [ids]] },
    };
    const requireGame = (rel) => (fake[rel] ? { ok: true, exports: fake[rel] } : { ok: false, reason: "x" });
    const got = createCapsuleSweepTools({ requireGame, disabledReason: () => null }).get();
    assert.strictEqual(got.ok, true, JSON.stringify(got));
    assert.deepStrictEqual(Object.keys(got.tools).sort(), ["buildRemoveBallsPayload", "findItemById",
      "getActiveShipRecord", "getSceneForSession", "isCapsuleTypeID", "removeInventoryItem"]);
    assert.deepStrictEqual([got.tools.getActiveShipRecord(5), got.tools.isCapsuleTypeID(CAPSULE_TYPE),
      got.tools.getSceneForSession({})], [{ itemID: 5 }, true, "scene"]);
    delete fake[PATHS.actions].buildRemoveBallsPayload;
    assert.deepStrictEqual(createCapsuleSweepTools({ requireGame }).get(),
      { ok: false, reason: "CAPSULE_SWEEP_UNAVAILABLE", detail: "buildRemoveBallsPayload" });
    assert.strictEqual(createCapsuleSweepTools({ requireGame, disabledReason: () => "DRIFT" }).get().ok, false);
  });
};
