"use strict";

const assert = require("node:assert");
const path = require("node:path");
const { installBoardHook, boardAnchor, BOARD_HOOKED } = require("../../lib/adapter/boardHook");

const CHAR = 90000001;
const HOST = 1000000400;
const SHIP = 1000000501;
const TWIN = 4200000000000001;
const SYSTEM = 30000142;

function fixtureClass() {
  return class ShipServiceFixture {
    Handle_Board(args, session, kwargs) {
      calls.push(["original", args]);
      if (this.throwIt) throw new Error("vendor UserError");
      return { self: this, args, session, kwargs, from: "Board" };
    }
  };
}
let calls = [];

function make(opts = {}) {
  calls = [];
  const Cls = fixtureClass();
  const host = { itemID: HOST, kind: "ship", systemID: SYSTEM, position: { x: 0, y: 0, z: 0 }, radius: 500,
    dungeonSiteInstanceID: 77, airNpeOwnerCharacterID: CHAR, spaceState: { a: 1, abyssalRunID: 9,
      dungeonCurrentRoomKey: "room:entry" }, unrelated: "x" };
  const scene = { id: "scene" };
  const wing = {
    boardOwnerOf: (id) => (id === TWIN ? { shipItemId: SHIP, ownerCharacterId: CHAR } : null),
    releaseForBoard: (charId, id) => {
      calls.push(["release", charId, id]);
      return opts.release || { ok: true, shipItemId: SHIP, hostShipId: HOST, systemId: SYSTEM,
        twin: { position: { x: 3000, y: 0, z: 0 }, direction: { x: 0, y: 2, z: 0 }, radius: 40 } };
    },
  };
  const adapter = {
    boardVendorRefusal: () => opts.vendorRefusal || null,
    sceneOf: () => {
      if (opts.sceneThrows) throw new Error("scene lookup failed");
      return scene;
    },
    hostEntity: (s, id) => (s === scene && id === HOST ? host : null),
    launchFromBay: (session, hostId, shipId, anchor) => {
      calls.push(["launch", hostId, shipId, anchor]);
      return opts.launch || { ok: true, entity: null };
    },
    activeShipId: () => SHIP,
  };
  if (opts.server) {
    adapter.findSession = (charId) => (charId === CHAR ? { characterID: CHAR } : null);
    adapter.boardFromServer = (session, shipId) => {
      calls.push(["boardFromServer", session.characterID, shipId]);
      return opts.boarded || { ok: true };
    };
  }
  const notified = [];
  const installed = installBoardHook(Cls, { wing, adapter, config: { boardRangeMeters: 6550 },
    refuse: (notify) => {
      notified.push(notify);
      throw new Error(`UserError:${notify}`);
    } });
  assert.strictEqual(installed.ok, true, JSON.stringify(installed));
  return { Cls, svc: new Cls(), installed, notified, host };
}

const DRONE = 4200000000000002;
const GHOST = 4200000000000000;
function ghostRig(opts = {}) {
  const rig = { calls: [], present: new Set([TWIN, DRONE, HOST]), known: "b1", active: HOST, throwIt: false,
    ret: { from: "Board" }, session: { characterID: CHAR }, nowMs: 1000000 };
  const forget = () => {
    if (opts.forget !== false) rig.known = null;
  };
  class Svc {
    Handle_Board(args) {
      rig.calls.push(["original", args]);
      forget();
      if (rig.throwIt) throw new Error("vendor UserError");
      rig.active = Number(args[0]);
      return rig.ret;
    }
    Handle_ScoopToSMA(args, session, kwargs) {
      rig.calls.push(["vendorScoop", args, session, kwargs]);
      return "vendorScoop";
    }
  }
  const wing = {
    boardOwnerOf: (id) => (id === TWIN && rig.present.has(TWIN) ? { shipItemId: SHIP, ownerCharacterId: opts.owner || CHAR,
      state: opts.twinState || "ACTIVE" } : null),
    releaseForBoard: () => {
      rig.calls.push(["release"]);
      rig.present.delete(TWIN);
      rig.present.delete(DRONE);
      return { ok: true, shipItemId: SHIP, hostShipId: HOST, systemId: SYSTEM,
        twin: { position: { x: 3000, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 }, radius: 40 },
        twinEntityId: TWIN, droneIds: [DRONE] };
    },
    orderCopy: (...a) => {
      rig.calls.push(["orderCopy", ...a]);
      return opts.order || { ok: true, state: "RETURNING" };
    },
  };
  if (opts.lost) wing.hasLossRecord = (id) => opts.lost.has(id);
  const scene = { id: "scene" };
  const adapter = {
    boardVendorRefusal: () => null,
    sceneOf: () => scene,
    hostEntity: (s, id) => (id === HOST ? { itemID: HOST, systemID: SYSTEM, position: { x: 0, y: 0, z: 0 } } : null),
    launchFromBay: () => {
      rig.present.add(SHIP);
      return { ok: true, entity: null };
    },
    activeShipId: () => rig.active,
    entity: (s, id) => (s === scene && rig.present.has(id) ? { itemID: id } : null),
    knownBubbleOf: () => rig.known,
    resendRemoveBalls: (s, session, ids) => {
      rig.calls.push(["resend", ids]);
      return true;
    },
    findSession: (charId) => (charId === CHAR ? rig.session : null),
    boardFromServer: (session, shipId) => {
      rig.calls.push(["boardFromServer", shipId]);
      forget();
      rig.active = shipId;
      return { ok: true };
    },
    stowToActiveBay: (session, shipId) => {
      rig.calls.push(["stow", shipId]);
      if (opts.stow) return opts.stow;
      rig.present.delete(shipId);
      return { ok: true };
    },
    customNotify: (session, text) => {
      rig.calls.push(["notify", text]);
      return true;
    },
  };
  rig.notified = [];
  const stowCargo = opts.unload ? { unloadForStow: (o) => {
    rig.calls.push(["unload", o]);
    return opts.unload(o);
  } } : null;
  rig.installed = installBoardHook(Svc, { wing, adapter, stowCargo, config: { boardRangeMeters: 6550,
    boardResendRemoval: opts.resend !== false, boardBackStowEnabled: true, scoopReturnEnabled: true,
    boardBackStowMaxAgeMs: opts.maxAgeMs === undefined ? 1800000 : opts.maxAgeMs,
    boardBackCargoUnloadEnabled: opts.cargoOn === true, boardBackCargoMaxStacks: 50 },
  now: () => rig.nowMs,
  refuse: (notify) => {
    rig.notified.push(notify);
    throw new Error(`UserError:${notify}`);
  } });
  assert.strictEqual(rig.installed.ok, true, JSON.stringify(rig.installed));
  rig.Svc = Svc;
  rig.svc = new Svc();
  rig.counters = () => rig.installed.hook.stats().counters;
  rig.of = (name) => rig.calls.filter((c) => c[0] === name);
  return rig;
}

function vendorLaunchPosition(source) {
  const d = source.direction;
  const len = Math.sqrt(d.x ** 2 + d.y ** 2 + d.z ** 2);
  const dir = len > 0 ? { x: d.x / len, y: d.y / len, z: d.z / len } : { x: 1, y: 0, z: 0 };
  const radius = Math.max(0, Number(source.radius) || 0);
  const offset = Math.max(50, radius + Math.max(50, 275));
  return { x: source.position.x + dir.x * offset, y: source.position.y + dir.y * offset,
    z: source.position.z + dir.z * offset };
}

module.exports = ({ test }) => {
  test("BH1 an ID that is not a twin -> the original with the same this, arguments, result and throw; marker set, "
    + "a second install refused", () => {
    const t = make();
    const session = { characterID: CHAR };
    const out = t.svc.Handle_Board([SHIP, HOST], session, { k: 1 });
    assert.strictEqual(out.self, t.svc);
    assert.deepStrictEqual([out.args, out.session, out.kwargs], [[SHIP, HOST], session, { k: 1 }]);
    assert.deepStrictEqual(calls.map((c) => c[0]), ["original"], "no release, no launch");
    t.svc.throwIt = true;
    assert.throws(() => t.svc.Handle_Board([SHIP, HOST], session, null), /vendor UserError/);
    assert.strictEqual(t.Cls.prototype.Handle_Board[BOARD_HOOKED], true);
    assert.strictEqual(installBoardHook(t.Cls, { wing: { boardOwnerOf() {}, releaseForBoard() {} },
      adapter: { boardVendorRefusal() {}, launchFromBay() {}, sceneOf() {}, hostEntity() {} }, refuse() {} }).reason,
    "BOARD_ALREADY_INSTALLED");
  });

  test("BH2 a twin -> release, launchFromBay with the anchor (abyssal/AIR scope copied by name, no dungeon fields - "
    + "), then the original with args[0] = the real ship; its result back unchanged, board.ok", () => {
    const t = make();
    const session = { characterID: CHAR };
    const out = t.svc.Handle_Board([String(TWIN), HOST], session, { k: 2 });
    assert.deepStrictEqual(calls.map((c) => c[0]), ["release", "launch", "original"]);
    assert.deepStrictEqual(calls[0], ["release", CHAR, TWIN]);
    const [, hostId, shipId, anchor] = calls[1];
    assert.deepStrictEqual([hostId, shipId], [HOST, SHIP]);
    assert.deepStrictEqual([anchor.dungeonSiteInstanceID, anchor.airNpeOwnerCharacterID, anchor.spaceState,
      anchor.systemID, anchor.kind, anchor.unrelated, anchor.radius],
    [undefined, CHAR, { abyssalRunID: 9 }, SYSTEM, "ship", undefined, 0]);
    assert.deepStrictEqual(calls[2], ["original", [SHIP, HOST]]);
    assert.strictEqual(out.self, t.svc);
    assert.deepStrictEqual([out.args, out.session, out.kwargs, out.from], [[SHIP, HOST], session, { k: 2 }, "Board"]);
    assert.strictEqual(t.installed.hook.stats().counters["board.ok"], 1);
  });

  test("BH3 launch {ok:false} -> CustomNotify, the original NOT called, board.launchFailed; a vendor refusal "
    + "(ABYSSAL) and a core refusal (TOO_FAR) -> CustomNotify before any launch", () => {
    const t = make({ launch: { ok: false, reason: "SPACE_SPAWN_FAILED" } });
    assert.throws(() => t.svc.Handle_Board([TWIN, HOST], { characterID: CHAR }, null), /UserError:/);
    assert.deepStrictEqual(t.notified, ["The copy's ship could not be launched - it is back in the maintenance bay."]);
    assert.deepStrictEqual(calls.map((c) => c[0]), ["release", "launch"]);
    assert.strictEqual(t.installed.hook.stats().counters["board.launchFailed"], 1);

    const a = make({ vendorRefusal: "ABYSSAL" });
    assert.throws(() => a.svc.Handle_Board([TWIN, HOST], { characterID: CHAR }, null), /Abyssal/);
    assert.deepStrictEqual(calls, [], "no release, no launch, no original");
    assert.strictEqual(a.installed.hook.stats().counters["board.refused.ABYSSAL"], 1);
    const f = make({ release: { ok: false, reason: "TOO_FAR" } });
    assert.throws(() => f.svc.Handle_Board([TWIN, HOST], { characterID: CHAR }, null), /UserError:/);
    assert.deepStrictEqual(f.notified, ["You are too far away from the wing copy to board it (max 6550 m)."]);
    assert.deepStrictEqual(calls.map((c) => c[0]), ["release"]);
    const s = make({ sceneThrows: true });
    assert.throws(() => s.svc.Handle_Board([TWIN, HOST], { characterID: CHAR }, null), /UserError:/);
    assert.deepStrictEqual(s.notified, ["The copy's ship could not be launched - it is back in the maintenance bay."]);
    assert.deepStrictEqual(calls.map((c) => c[0]), ["release"]);
    assert.strictEqual(s.installed.hook.stats().counters["board.launchFailed"], 1);
  });

  test("BH3b a pursuit refusal comes before releaseForBoard on both paths: the client Board gets the vendor "
    + "CustomNotify text, the server board gets the same text; no release, no launch, no vendor board", () => {
    const texts = {
      CONCORD_PURSUIT: "You cannot board another ship while CONCORD is pursuing you.",
      FACTION_POLICE_PURSUIT: "You cannot board another ship while faction police are pursuing you.",
    };
    for (const [reason, text] of Object.entries(texts)) {
      const c = make({ vendorRefusal: reason });
      assert.throws(() => c.svc.Handle_Board([TWIN, HOST], { characterID: CHAR }, null), /UserError:/);
      assert.deepStrictEqual(c.notified, [text]);
      assert.deepStrictEqual(calls, [], `${reason}: client path keeps the twin`);
      assert.strictEqual(c.installed.hook.stats().counters[`board.refused.${reason}`], 1);

      const s = make({ server: true, vendorRefusal: reason });
      assert.deepStrictEqual(s.installed.hook.serverBoard(CHAR, TWIN), { ok: false, reason, text });
      assert.deepStrictEqual(calls, [], `${reason}: server path keeps the twin`);
      assert.deepStrictEqual(s.notified, []);
    }
  });

  test("BH4 boardAnchor + the vendor launch formula (275 m, buildLaunchStateNearSource) = the twin's position "
    + "(+-1e-6); no twin position -> null (the vendor launches beside the host)", () => {
    const host = { systemID: SYSTEM, position: { x: 0, y: 0, z: 0 } };
    for (const twin of [
      { position: { x: 3000, y: -20, z: 7.5 }, direction: { x: 0.3, y: -2, z: 1 } },
      { position: { x: -1e6, y: 2e5, z: 3 }, direction: { x: 0, y: 0, z: 0 } },
    ]) {
      const p = vendorLaunchPosition(boardAnchor(host, twin));
      for (const k of ["x", "y", "z"]) assert.ok(Math.abs(p[k] - twin.position[k]) <= 1e-6, `${k}: ${p[k]}`);
    }
    assert.strictEqual(boardAnchor(host, { position: null, direction: { x: 1, y: 0, z: 0 } }), null);
    const flagged = boardAnchor({ ...host, entityInteractionScopeInvalid: true, playerCompanionScopeInvalid: true },
      { position: { x: 1, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 } });
    assert.deepStrictEqual([flagged.entityInteractionScopeInvalid, flagged.playerCompanionScopeInvalid], [true, true]);
  });

  test("BH5 (board) server board: release -> launch -> boardFromServer(session of the pilot, the real "
    + "ship), no Handle_Board; a refusal = its text, nothing launched; a vendor refusal after the launch = BOARD_FAILED; "
    + "no boardFromServer = no serverBoard", () => {
    assert.strictEqual(make().installed.hook.serverBoard, null, "adapter without boardFromServer");
    const t = make({ server: true });
    const out = t.installed.hook.serverBoard(CHAR, TWIN);
    assert.deepStrictEqual(out, { ok: true, shipItemId: SHIP });
    assert.deepStrictEqual(calls.map((c) => c[0]), ["release", "launch", "boardFromServer"]);
    assert.deepStrictEqual(calls[2], ["boardFromServer", CHAR, SHIP]);
    const c = t.installed.hook.stats().counters;
    assert.deepStrictEqual([c["board.server"], c["board.ok"]], [1, 1]);
    assert.deepStrictEqual(t.installed.hook.serverBoard(CHAR, SHIP), { ok: false, reason: "NOT_DEPLOYED",
      text: "That wing copy is not available to board." }, "not a twin");

    const f = make({ server: true, release: { ok: false, reason: "TOO_FAR" } });
    assert.deepStrictEqual(f.installed.hook.serverBoard(CHAR, TWIN), { ok: false, reason: "TOO_FAR",
      text: "You are too far away from the wing copy to board it (max 6550 m)." });
    assert.deepStrictEqual(calls.map((x) => x[0]), ["release"]);
    assert.deepStrictEqual(f.notified, [], "no CustomNotify (no RPC to answer)");

    const v = make({ server: true, boarded: { ok: false, reason: "TOO_FAR_AWAY" } });
    const failed = v.installed.hook.serverBoard(CHAR, TWIN);
    assert.strictEqual(failed.reason, "BOARD_FAILED");
    assert.strictEqual(v.installed.hook.stats().counters["board.vendorFailed"], 1);
  });

  test("BG1 server board: known before, forgotten after boardFromServer, twin + drone gone -> "
    + "exactly one RemoveBalls([twin, drone]), board.ghost.resent, the result unchanged; the observer kept -> none; "
    + "boardResendRemoval=false -> board.ghost.forgotten only", () => {
    const r = ghostRig();
    assert.deepStrictEqual(r.installed.hook.serverBoard(CHAR, TWIN), { ok: true, shipItemId: SHIP });
    assert.deepStrictEqual(r.of("resend"), [["resend", [TWIN, DRONE]]]);
    assert.deepStrictEqual(r.calls.map((c) => c[0]), ["release", "boardFromServer", "resend"]);
    assert.deepStrictEqual([r.counters()["board.ghost.forgotten"], r.counters()["board.ghost.resent"]], [1, 1]);
    assert.deepStrictEqual([r.installed.hook.ghostReason, r.installed.hook.stowReason, r.installed.hook.scoopReason],
      [null, null, null]);

    const kept = ghostRig({ forget: false });
    assert.strictEqual(kept.installed.hook.serverBoard(CHAR, TWIN).ok, true);
    assert.deepStrictEqual(kept.of("resend"), [], "the vendor diff carries the removal");
    assert.strictEqual(kept.counters()["board.ghost.forgotten"], 0);

    const off = ghostRig({ resend: false });
    assert.strictEqual(off.installed.hook.serverBoard(CHAR, TWIN).ok, true);
    assert.deepStrictEqual(off.of("resend"), []);
    assert.deepStrictEqual([off.counters()["board.ghost.forgotten"], off.counters()["board.ghost.resent"]], [1, 0]);
    assert.strictEqual(off.installed.hook.ghostReason, "off");
  });

  test("BG2 Handle_Board hook: the vendor forgets the observer -> one RemoveBalls([twin, drone]), the "
    + "vendor result passes ===; the vendor throws -> the throw passes, the sweep still runs once", () => {
    const r = ghostRig();
    assert.strictEqual(r.svc.Handle_Board([TWIN, HOST], r.session, null), r.ret);
    assert.deepStrictEqual(r.calls.map((c) => c[0]), ["release", "original", "resend"]);
    assert.deepStrictEqual(r.of("resend"), [["resend", [TWIN, DRONE]]]);
    assert.deepStrictEqual(r.of("original"), [["original", [SHIP, HOST]]]);
    assert.strictEqual(r.counters()["board.ghost.resent"], 1);

    const t = ghostRig();
    t.throwIt = true;
    assert.throws(() => t.svc.Handle_Board([TWIN, HOST], t.session, null), /vendor UserError/);
    assert.deepStrictEqual(t.of("resend"), [["resend", [TWIN, DRONE]]]);
    assert.deepStrictEqual([t.counters()["board.ghost.resent"], t.counters()["board.vendorFailed"]], [1, 1]);
  });

  test("BB1 launch -> board -> Board back on the host -> stowToActiveBay once, board.back.stowed (and the "
    + "scooped ball re-sent to a forgotten observer); a second Board back -> no stow; TARGET_TOO_FAR -> board.back.tooFar, "
    + "no throw, the vendor result unchanged; Board on another ship -> the entry dropped, no stow", () => {
    const r = ghostRig();
    assert.strictEqual(r.installed.hook.serverBoard(CHAR, TWIN).ok, true);
    r.known = "b2";
    assert.strictEqual(r.svc.Handle_Board([HOST, SHIP], r.session, null), r.ret);
    assert.deepStrictEqual(r.of("stow"), [["stow", SHIP]]);
    assert.strictEqual(r.counters()["board.back.stowed"], 1);
    assert.deepStrictEqual(r.of("resend").at(-1), ["resend", [SHIP]]);
    r.active = SHIP;
    r.svc.Handle_Board([HOST, SHIP], r.session, null);
    assert.strictEqual(r.of("stow").length, 1, "the entry is used once");

    const far = ghostRig({ stow: { ok: false, reason: "TARGET_TOO_FAR" } });
    assert.strictEqual(far.installed.hook.serverBoard(CHAR, TWIN).ok, true);
    assert.strictEqual(far.svc.Handle_Board([HOST, SHIP], far.session, null), far.ret);
    assert.deepStrictEqual([far.of("stow").length, far.counters()["board.back.tooFar"],
      far.counters()["board.back.stowed"]], [1, 1, 0]);

    const other = ghostRig();
    assert.strictEqual(other.svc.Handle_Board([TWIN, HOST], other.session, null), other.ret);
    other.svc.Handle_Board([1000000777, SHIP], other.session, null);
    other.svc.Handle_Board([HOST, 1000000777], other.session, null);
    assert.deepStrictEqual(other.of("stow"), [], "another target first -> no stow");
  });

  test("SC1 Handle_ScoopToSMA: a live twin of the pilot -> orderCopy(char, ship, return, {source:scoop}) "
    + "no vendor, null (also through the guard); a refusal -> CustomNotify + throw; a ball not in the scene -> "
    + "RemoveBalls([id]) and the vendor with the same arguments; a real ship in the scene -> the vendor only", () => {
    const { createGuardFactory, guardPrototype } = require("../../lib/adapter/guards");
    const r = ghostRig();
    const guard = createGuardFactory({ counters: {}, maxScannedIds: 64, notifyText: "blocked", overflowText: "many",
      wing: { blockedCount: () => 1, isBlocked: (id) => id === SHIP }, refuse: () => {} });
    guardPrototype(r.Svc.prototype, [], guard);
    assert.strictEqual(r.svc.Handle_ScoopToSMA([TWIN], r.session, null), null);
    assert.deepStrictEqual(r.of("orderCopy"), [["orderCopy", CHAR, SHIP, "return", { source: "scoop" }]]);
    assert.deepStrictEqual([r.of("vendorScoop").length, r.counters()["scoop.return"]], [0, 1]);

    const no = ghostRig({ order: { ok: false, reason: "NOT_DEPLOYED" } });
    assert.throws(() => no.svc.Handle_ScoopToSMA([TWIN], no.session, null), /UserError:/);
    assert.deepStrictEqual(no.notified, ["That wing copy cannot return now."]);
    assert.deepStrictEqual([no.of("vendorScoop").length, no.counters()["scoop.refused"]], [0, 1]);

    const g = ghostRig();
    const kwargs = { k: 1 };
    assert.strictEqual(g.svc.Handle_ScoopToSMA([GHOST], g.session, kwargs), "vendorScoop");
    assert.deepStrictEqual(g.of("resend"), [["resend", [GHOST]]]);
    assert.deepStrictEqual(g.of("vendorScoop"), [["vendorScoop", [GHOST], g.session, kwargs]]);
    assert.strictEqual(g.counters()["scoop.ghostCleared"], 1);
    g.svc.Handle_ScoopToSMA([HOST], g.session, null);
    assert.deepStrictEqual([g.of("resend").length, g.of("vendorScoop").length], [1, 2], "a ship in the scene");
  });

  test("SC2 (board-low-sweep) Scoop on the pilot's twin that is RETURNING -> \"already returning\" CustomNotify "
    + "+ throw, scoop.alreadyReturning, no orderCopy (the state stays), no vendor, scoop.refused 0", () => {
    const r = ghostRig({ twinState: "RETURNING" });
    assert.throws(() => r.svc.Handle_ScoopToSMA([TWIN], r.session, null), /UserError:/);
    assert.deepStrictEqual(r.notified, ["That wing copy is already returning."]);
    assert.deepStrictEqual([r.of("orderCopy").length, r.of("vendorScoop").length], [0, 0]);
    assert.deepStrictEqual([r.counters()["scoop.alreadyReturning"], r.counters()["scoop.refused"]], [1, 0]);
  });

  test("BB2 (board-low-sweep) the Board back entry expires: older than boardBackStowMaxAgeMs -> no stow "
    + "board.back.expired; at the limit -> stow; 0 = no limit; a new board drops the old entries first", () => {
    const old = ghostRig();
    assert.strictEqual(old.installed.hook.serverBoard(CHAR, TWIN).ok, true);
    old.nowMs += 1800001;
    assert.strictEqual(old.svc.Handle_Board([HOST, SHIP], old.session, null), old.ret);
    assert.deepStrictEqual([old.of("stow").length, old.counters()["board.back.expired"]], [0, 1]);
    old.active = SHIP;
    old.svc.Handle_Board([HOST, SHIP], old.session, null);
    assert.strictEqual(old.of("stow").length, 0, "the entry is gone");

    const edge = ghostRig();
    assert.strictEqual(edge.installed.hook.serverBoard(CHAR, TWIN).ok, true);
    edge.nowMs += 1800000;
    edge.svc.Handle_Board([HOST, SHIP], edge.session, null);
    assert.deepStrictEqual([edge.of("stow").length, edge.counters()["board.back.expired"]], [1, 0]);

    const off = ghostRig({ maxAgeMs: 0 });
    assert.strictEqual(off.installed.hook.serverBoard(CHAR, TWIN).ok, true);
    off.nowMs += 86400000 * 3;
    off.svc.Handle_Board([HOST, SHIP], off.session, null);
    assert.deepStrictEqual([off.of("stow").length, off.counters()["board.back.expired"]], [1, 0]);

    const again = ghostRig();
    assert.strictEqual(again.installed.hook.serverBoard(CHAR, TWIN).ok, true);
    again.nowMs += 1800001;
    again.present.add(TWIN);
    again.present.add(DRONE);
    again.known = "b2";
    assert.strictEqual(again.installed.hook.serverBoard(CHAR, TWIN).ok, true);
    assert.strictEqual(again.counters()["board.back.expired"], 1, "pruned at the new board");
    again.known = "b3";
    again.svc.Handle_Board([HOST, SHIP], again.session, null);
    assert.strictEqual(again.of("stow").length, 1, "the new entry is fresh");
  });

  test("BB3 Board back with cargo: unload ok -> unload before stow "
    + "board.back.cargo.moved + board.back.stowed, a \"stored\" notify; NO_ROOM -> no stow, a notify with Scoop, "
    + "board.back.cargo.noRoom, a second Board back does nothing; an unload throw -> skipped + the stow as today; "
    + "flag off -> no unload, the stow as BB1", () => {
    const back = (r) => {
      assert.strictEqual(r.installed.hook.serverBoard(CHAR, TWIN).ok, true);
      r.known = "b2";
      assert.strictEqual(r.svc.Handle_Board([HOST, SHIP], r.session, null), r.ret);
    };
    const ok = ghostRig({ cargoOn: true, unload: () => ({ ok: true, name: "Hulk", movedStacks: 2, movedM3: 1234.56,
      changes: [] }) });
    back(ok);
    assert.deepStrictEqual(ok.calls.filter((c) => ["unload", "stow", "notify"].includes(c[0])).map((c) => c[0]),
      ["unload", "stow", "notify"]);
    assert.deepStrictEqual(ok.of("unload")[0][1], { ownerCharacterId: CHAR, hostShipId: HOST, shipItemId: SHIP,
      maxStacks: 50 });
    assert.deepStrictEqual([ok.counters()["board.back.cargo.moved"], ok.counters()["board.back.stowed"]], [1, 1]);
    assert.match(ok.of("notify")[0][1], /^Moved 1234\.6 m3 of cargo from Hulk into this ship and stored Hulk/);
    assert.strictEqual(ok.installed.hook.stowCargoReason, null);

    const full = ghostRig({ cargoOn: true, unload: () => ({ ok: false, name: "Hulk", reason: "NO_ROOM",
      neededM3: 9000, freeM3: 2500 }) });
    back(full);
    assert.deepStrictEqual([full.of("stow").length, full.counters()["board.back.cargo.noRoom"]], [0, 1]);
    assert.match(full.of("notify")[0][1], /needs 9000 m3, free 2500 m3\)\. Empty it and use Scoop/);
    full.active = SHIP;
    full.svc.Handle_Board([HOST, SHIP], full.session, null);
    assert.deepStrictEqual([full.of("unload").length, full.of("stow").length], [1, 0], "the entry is used once");

    const boom = ghostRig({ cargoOn: true, unload: () => {
      throw new Error("mod bug");
    } });
    back(boom);
    assert.deepStrictEqual([boom.counters()["board.back.cargo.skipped"], boom.of("stow").length,
      boom.counters()["board.back.stowed"], boom.of("notify").length], [1, 1, 1, 0]);

    const off = ghostRig({ unload: () => assert.fail("unload with the flag off") });
    back(off);
    assert.deepStrictEqual([off.of("unload").length, off.of("stow"), off.counters()["board.back.stowed"]],
      [0, [["stow", SHIP]], 1]);
    assert.strictEqual(off.installed.hook.stowCargoReason, "off");

    const lock = ghostRig({ cargoOn: true, lost: new Set([SHIP]), unload: (o) => (o.isLocked(SHIP)
      ? { ok: false, name: "Hulk", reason: "LOST_UNSETTLED" } : assert.fail("not locked")) });
    back(lock);
    assert.deepStrictEqual([lock.of("unload")[0][1].isLocked(HOST), lock.counters()["board.back.cargo.skipped"],
      lock.of("stow").length, lock.of("notify").length], [false, 1, 1, 0]);
  });

  test("MS1 (board-malformed-scope) on the REAL vendor scope functions: a host tracked in a dungeon room "
    + "(log 30001978) -> the old anchor (dungeon fields copied) gives a hull the scene refuses (scope not valid, "
    + "dungeonCurrentInstanceID poisoned); boardAnchor now -> a valid hull; adapter.launchScopeRefusal HULL / null / "
    + "HOST", () => {
    const game = vendorScope();
    const { scope } = game;
    const host = { itemID: HOST, kind: "ship", systemID: 30001978, position: { x: 0, y: 0, z: 0 }, radius: 500,
      dungeonCurrentInstanceID: 4242, dungeonCurrentDungeonID: 77, dungeonCurrentRoomKey: "room:entry",
      dungeonCurrentRoomID: 0, dungeonCurrentSiteID: 900001, dungeonCurrentRoomPosition: [1, 2, 3],
      dungeonCurrentUpdatedAtMs: 5 };
    const twin = { position: { x: 3000, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 } };
    assert.strictEqual(scope.resolveEntityInteractionScope(host).valid, true, "the host itself is valid");
    const oldAnchor = { ...boardAnchor(host, twin) };
    for (const name of Object.keys(host)) if (/^dungeon/.test(name)) oldAnchor[name] = host[name];
    assert.strictEqual(scope.resolveEntityInteractionScope(oldAnchor).valid, true, "the old anchor is valid too");
    const before = launchedHull(game, oldAnchor);
    assert.strictEqual(scope.resolveEntityInteractionScope(before).valid, false, "the old hull: MALFORMED");
    assert.strictEqual(before.dungeonCurrentInstanceID, "invalid-persistent-identity");
    const after = launchedHull(game, boardAnchor(host, twin));
    assert.strictEqual(scope.resolveEntityInteractionScope(after).valid, true, JSON.stringify(after));
    const { createWingAdapterCore } = require("../../lib/adapter/vendor");
    const a = createWingAdapterCore({ itemStore: { ITEM_FLAGS: { SHIP_HANGAR: 4 } }, board: { launchScope: game } });
    assert.strictEqual(a.launchScopeRefusal(host, oldAnchor), "HULL");
    assert.strictEqual(a.launchScopeRefusal(host, boardAnchor(host, twin)), null);
    const plain = { itemID: HOST, kind: "ship", systemID: 30001978, position: { x: 0, y: 0, z: 0 } };
    assert.strictEqual(a.launchScopeRefusal(plain, boardAnchor(plain, twin)), null, "a host in open space");
    for (const bad of [{ ...plain, entityInteractionScopeInvalid: true },
      { ...plain, dungeonCurrentInstanceID: "invalid-persistent-identity" }]) {
      assert.strictEqual(a.launchScopeRefusal(bad, boardAnchor(bad, twin)), "HOST", JSON.stringify(bad));
    }
    const air = { ...plain, airNpeInstanceID: 55, airNpeOwnerCharacterID: CHAR };
    const airHull = launchedHull(game, boardAnchor(air, twin));
    assert.deepStrictEqual([airHull.airNpeInstanceID, airHull.airNpeOwnerCharacterID], [55, CHAR]);
    assert.strictEqual(a.launchScopeRefusal(air, boardAnchor(air, twin)), null);
  });

  test("MS2 a host whose launch scope is invalid -> refused BEFORE the end: the hook passes hostCheck "
    + "to releaseForBoard, the twin stays (no launch, no original), CustomNotify of SCOPE_INVALID, board.scope.host "
    + "counted apart from board.launchFailed; a throw of the check = no opinion (the board goes on)", () => {
    const run = (refusal) => {
      calls = [];
      const Cls = fixtureClass();
      const host = { itemID: HOST, kind: "ship", systemID: SYSTEM, position: { x: 0, y: 0, z: 0 } };
      const wing = {
        boardOwnerOf: (id) => (id === TWIN ? { shipItemId: SHIP, ownerCharacterId: CHAR } : null),
        releaseForBoard: (charId, id, opts) => {
          const verdict = opts && typeof opts.hostCheck === "function" ? opts.hostCheck(host) : null;
          calls.push(["release", verdict]);
          if (verdict === "SCOPE_INVALID") return { ok: false, reason: "SCOPE_INVALID" };
          return { ok: true, shipItemId: SHIP, hostShipId: HOST, systemId: SYSTEM,
            twin: { position: { x: 3000, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 } } };
        },
      };
      const adapter = { boardVendorRefusal: () => null, sceneOf: () => ({}), hostEntity: () => host,
        launchFromBay: () => {
          calls.push(["launch"]);
          return { ok: true, entity: null };
        },
        activeShipId: () => SHIP,
        launchScopeRefusal: (h, anchor) => {
          calls.push(["scope", h === host, anchor.dungeonCurrentInstanceID]);
          if (refusal === "THROW") throw new Error("scope read failed");
          return refusal;
        } };
      const notified = [];
      const errors = [];
      const installed = installBoardHook(Cls, { wing, adapter, config: {}, onError: (e) => errors.push(e.message),
        refuse: (notify) => {
          notified.push(notify);
          throw new Error(`UserError:${notify}`);
        } });
      return { svc: new Cls(), installed, notified, errors };
    };
    const t = run("HOST");
    assert.throws(() => t.svc.Handle_Board([TWIN, HOST], { characterID: CHAR }, null), /UserError:/);
    assert.deepStrictEqual(calls.map((c) => c[0]), ["scope", "release"], "no launch, no original");
    assert.deepStrictEqual(calls[0], ["scope", true, undefined]);
    assert.deepStrictEqual(t.notified,
      ["The copy's ship cannot be launched here - move away from this site and try again."]);
    const c = t.installed.hook.stats().counters;
    assert.deepStrictEqual([c["board.scope.host"], c["board.scope.hull"], c["board.launchFailed"], c["board.ok"]],
      [1, 0, 0, 0]);
    const h = run("HULL");
    assert.throws(() => h.svc.Handle_Board([TWIN, HOST], { characterID: CHAR }, null), /UserError:/);
    assert.strictEqual(h.installed.hook.stats().counters["board.scope.hull"], 1);
    const ok = run(null);
    ok.svc.Handle_Board([TWIN, HOST], { characterID: CHAR }, null);
    assert.deepStrictEqual(calls.map((x) => x[0]), ["scope", "release", "launch", "original"]);
    const thrown = run("THROW");
    thrown.svc.Handle_Board([TWIN, HOST], { characterID: CHAR }, null);
    assert.deepStrictEqual(thrown.errors, ["scope read failed"]);
    assert.strictEqual(thrown.installed.hook.stats().counters["board.ok"], 1);
  });
};

function vendorScope() {
  const src = path.join(__dirname, "..", "..", "..", "..", "server", "src");
  return { scope: require(path.join(src, "space", "destiny", "identity", "interactionScope.js")),
    tags: require(path.join(src, "space", "runtime", "entityScopeTags.js")) };
}

function launchedHull(game, anchor) {
  const hull = { kind: "ship", itemID: SHIP };
  const launchState = game.scope.buildChildEntityScopeMetadata(anchor);
  game.tags.applyRuntimeEntityScopeMetadata(hull, launchState);
  game.tags.applyRuntimeDungeonTrackingState(hull, launchState);
  game.tags.clearPlayerShipGenericDungeonScope(hull, { playerOwned: true });
  return hull;
}
