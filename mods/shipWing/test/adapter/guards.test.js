"use strict";

const assert = require("node:assert");
const { installGuards, installGuardsFromGame, collectIds, plainTopLevelIds, createGuardErrorReporter, GUARDED,
  READ_ONLY } = require("../../lib/adapter/guards");

const BLOCKED = 1000000501;
const FREE = 1000000502;
const HANGAR = 60003760;

class ShipServiceFixture {
  Handle_Board(args, session, kwargs) {
    return { self: this, args, session, kwargs, from: "Board" };
  }

  Handle_LaunchFromContainer(args) {
    return { args, from: "LaunchFromContainer" };
  }

  Handle_GetModules(args) {
    return { args, from: "GetModules" };
  }

  Handle_SomethingNew(args) {
    return { args, from: "SomethingNew" };
  }
}

function invBrokerFixture() {
  class InvBrokerServiceFixture {
    constructor() {
      this._boundContexts = new Map();
      this.adds = 0;
    }

    _getBoundContext(session) {
      if (!session || !session.currentBoundObjectID) return null;
      return this._boundContexts.get(session.currentBoundObjectID) || null;
    }

    Handle_Add(args) {
      this.adds += 1;
      return { args, from: "Add" };
    }

    Handle_MultiAdd(args, session, kwargs) {
      return args[0].map((id) => this.Handle_Add([id, args[1]], session, kwargs));
    }

    Handle_MultiMerge(args) {
      return { args, from: "MultiMerge" };
    }

    Handle_List(args) {
      return { args, from: "List" };
    }
  }
  for (const [name, fn] of Object.entries({
    Handle_TrashItems(args) {
      return { args, from: "TrashItems" };
    },
    Handle_DeliverToCorpHangar(args, session, kwargs) {
      return { args, kwargs, from: "DeliverToCorpHangar" };
    },
  })) {
    Object.defineProperty(InvBrokerServiceFixture.prototype, name, { value: fn, writable: true, configurable: true });
  }
  return InvBrokerServiceFixture;
}

function fakeWing(ids) {
  const wing = { set: new Set(ids), countCalls: 0, blockedCalls: 0 };
  wing.blockedCount = () => {
    wing.countCalls += 1;
    return wing.set.size;
  };
  wing.isBlocked = (id) => {
    wing.blockedCalls += 1;
    return wing.set.has(id);
  };
  return wing;
}

function throwWrappedUserError(message, values) {
  const err = new Error(`${message}: ${values.notify}`);
  err.userError = { message, values };
  throw err;
}

function setup(ids, config = {}) {
  const InvBrokerService = invBrokerFixture();
  const wing = fakeWing(ids);
  const result = installGuards({
    ShipService: ShipServiceFixture, InvBrokerService, throwWrappedUserError, wing,
    config: { guardMaxScannedIds: 256, chatTrigger: "!wing", ...config },
  });
  return { InvBrokerService, wing, result };
}

function refused(fn) {
  let error = null;
  try {
    fn();
  } catch (err) {
    error = err;
  }
  assert.ok(error && error.userError, "expected a CustomNotify refusal");
  assert.strictEqual(error.userError.message, "CustomNotify");
  return error.userError.values.notify;
}

function unwrapShip(saved) {
  for (const [name, fn] of saved) {
    Object.defineProperty(ShipServiceFixture.prototype, name, { value: fn, writable: true, configurable: true });
  }
}

function saveShip() {
  return Object.getOwnPropertyNames(ShipServiceFixture.prototype)
    .filter((n) => n.startsWith("Handle_")).map((n) => [n, ShipServiceFixture.prototype[n]]);
}

module.exports = ({ test }) => {
  test("G1 blocked ID in args, array, marshal list/tuple, kwargs dict or bound context -> CustomNotify; "
    + "READ_ONLY and other IDs pass with the same this/args/result", () => {
    const saved = saveShip();
    try {
      const { InvBrokerService, result } = setup([BLOCKED]);
      assert.strictEqual(result.ok, true);
      assert.deepStrictEqual(result.ship.guarded,
        ["Handle_Board", "Handle_LaunchFromContainer", "Handle_SomethingNew"]);
      assert.deepStrictEqual(result.ship.readOnly, ["Handle_GetModules"]);
      assert.deepStrictEqual(result.invBroker.readOnly, ["Handle_List"]);
      const ship = new ShipServiceFixture();
      const notify = refused(() => ship.Handle_Board([BLOCKED, 1], {}, null));
      assert.strictEqual(notify, "Ship is deployed as a wing copy. Use !wing return first.");
      refused(() => ship.Handle_LaunchFromContainer([HANGAR, BigInt(BLOCKED)]));
      refused(() => ship.Handle_SomethingNew([String(BLOCKED)]));
      const session = { id: 1 };
      const passed = ship.Handle_Board([FREE, 1], session, { k: 1 });
      assert.strictEqual(passed.self, ship);
      assert.deepStrictEqual([passed.args, passed.session, passed.kwargs], [[FREE, 1], session, { k: 1 }]);
      assert.strictEqual(ship.Handle_GetModules([BLOCKED]).from, "GetModules", "READ_ONLY passes");

      const inv = new InvBrokerService();
      refused(() => inv.Handle_MultiAdd([[FREE, BLOCKED], HANGAR], {}, null));
      assert.strictEqual(inv.adds, 0, "nothing added");
      refused(() => inv.Handle_TrashItems([{ type: "list", items: [BigInt(FREE), BigInt(BLOCKED)] }, HANGAR]));
      refused(() => inv.Handle_MultiMerge([{ type: "list", items: [{ type: "tuple", items: [FREE, BLOCKED, 1] }] }]));
      refused(() => inv.Handle_DeliverToCorpHangar([], {}, { type: "dict", entries: [["itemIDs", [BLOCKED]]] }));
      inv._boundContexts.set("N=1:5", { inventoryID: BLOCKED, locationID: BLOCKED, flagID: 5, kind: "boundInventory" });
      const bound = { currentBoundObjectID: "N=1:5" };
      refused(() => inv.Handle_Add([FREE, HANGAR], bound, null));
      assert.strictEqual(inv.Handle_List([], bound, null).from, "List", "READ_ONLY on the bound ship passes");
      assert.strictEqual(inv.Handle_Add([FREE, HANGAR], { currentBoundObjectID: "none" }, null).from, "Add");
      assert.strictEqual(inv.Handle_MultiAdd([[FREE], HANGAR], {}, null).length, 1);
      assert.strictEqual(result.counters["guard.refused.Handle_Board"], 1);
      assert.strictEqual(result.counters["guard.refused.Handle_Add"], 1);
    } finally {
      unwrapShip(saved);
    }
  });

  test("G2 empty blocked set -> original without a scan (no isBlocked, no bound context read)", () => {
    const saved = saveShip();
    try {
      const { InvBrokerService, wing } = setup([]);
      const inv = new InvBrokerService();
      let contextReads = 0;
      inv._getBoundContext = () => {
        contextReads += 1;
        return null;
      };
      assert.strictEqual(inv.Handle_Add([BLOCKED, HANGAR], {}, null).from, "Add");
      assert.strictEqual(new ShipServiceFixture().Handle_Board([BLOCKED]).from, "Board");
      assert.strictEqual(wing.countCalls, 2);
      assert.strictEqual(wing.blockedCalls, 0);
      assert.strictEqual(contextReads, 0);
    } finally {
      unwrapShip(saved);
    }
  });

  test("G3 double install leaves the wrap alone and is refused GUARDS_ALREADY_INSTALLED ("
    + "another core object gets no ok); chained over another mod's wrapper (its mark kept)", () => {
    const saved = saveShip();
    try {
      const foreignMark = Symbol.for("otherMod.wrapped");
      const before = ShipServiceFixture.prototype.Handle_Board;
      let foreignCalls = 0;
      function otherModBoard() {
        foreignCalls += 1;
        return before.apply(this, arguments);
      }
      otherModBoard[foreignMark] = true;
      ShipServiceFixture.prototype.Handle_Board = otherModBoard;
      const first = setup([BLOCKED]);
      const wrapped = ShipServiceFixture.prototype.Handle_Board;
      assert.strictEqual(wrapped[GUARDED], true);
      assert.strictEqual(wrapped[foreignMark], true);
      const otherWing = fakeWing([BLOCKED + 1]);
      const second = installGuards({ ShipService: ShipServiceFixture, InvBrokerService: first.InvBrokerService,
        throwWrappedUserError, wing: otherWing, config: { guardMaxScannedIds: 256 } });
      assert.deepStrictEqual([second.ok, second.reason], [false, "GUARDS_ALREADY_INSTALLED"]);
      assert.deepStrictEqual(second.ship.guarded, []);
      assert.strictEqual(second.ship.already.length, 3);
      assert.deepStrictEqual(second.invBroker.already, first.result.invBroker.guarded);
      const InvBrokerFresh = invBrokerFixture();
      const third = installGuards({ ShipService: ShipServiceFixture, InvBrokerService: InvBrokerFresh,
        throwWrappedUserError, wing: otherWing, config: { guardMaxScannedIds: 256 } });
      assert.deepStrictEqual([third.ok, third.reason], [false, "GUARDS_ALREADY_INSTALLED"]);
      assert.strictEqual(InvBrokerFresh.prototype.Handle_TrashItems[GUARDED], undefined, "nothing wrapped");
      assert.strictEqual(ShipServiceFixture.prototype.Handle_Board, wrapped, "not wrapped twice");
      assert.strictEqual(otherWing.countCalls, 0, "the second core is never asked");
      assert.strictEqual(new ShipServiceFixture().Handle_Board([FREE]).from, "Board");
      assert.strictEqual(foreignCalls, 1);
      refused(() => new ShipServiceFixture().Handle_Board([BLOCKED]));
      assert.strictEqual(foreignCalls, 1, "refused before the chain");
    } finally {
      unwrapShip(saved);
    }
  });

  test("G4 more IDs than guardMaxScannedIds -> refused while a wing is out "
    + "guard bug, no session character -> original runs (c); probe guards unavailable -> nothing wrapped", () => {
    const saved = saveShip();
    try {
      assert.deepStrictEqual(collectIds([[1, 2], 3], null, 2), { ids: [1, 2], overflow: true });
      const { InvBrokerService, wing, result } = setup([BLOCKED], { guardMaxScannedIds: 3 });
      const inv = new InvBrokerService();
      const notify = refused(() => inv.Handle_TrashItems([[1, 2, 3, 4], HANGAR]));
      assert.ok(notify.startsWith("Too many items"), notify);
      assert.strictEqual(result.counters["guard.overflow"], 1);
      wing.isBlocked = () => {
        throw new Error("bug");
      };
      assert.strictEqual(inv.Handle_TrashItems([[BLOCKED]]).from, "TrashItems");
      assert.strictEqual(result.counters["guard.error"], 1);
    } finally {
      unwrapShip(saved);
    }
    const proto = invBrokerFixture().prototype;
    const original = proto.Handle_Add;
    const adapter = { isConsumerAvailable: (c) => c !== "guards", requireGame: () => assert.fail("no require") };
    assert.deepStrictEqual(installGuardsFromGame(adapter, fakeWing([]), {}),
      { ok: false, reason: "probe_guards_unavailable", counters: {} });
    assert.strictEqual(proto.Handle_Add, original);
    assert.ok(Object.isFrozen(READ_ONLY.ShipService) && Object.isFrozen(READ_ONLY.InvBrokerService));
  });

  test("G5: guard error -> plain top-level scan refuses a blocked ID, other IDs pass; scan fails too -> "
    + "refused only when the session's character owns a record; first error logged, next ones rate-limited", () => {
    const saved = saveShip();
    try {
      const InvBrokerService = invBrokerFixture();
      const wing = fakeWing([BLOCKED]);
      const lines = [];
      const clock = { t: 0 };
      const result = installGuards({ ShipService: ShipServiceFixture, InvBrokerService, throwWrappedUserError, wing,
        config: { guardMaxScannedIds: 256 },
        onError: createGuardErrorReporter({ log: { log: (l) => lines.push(l) }, intervalMs: 60000,
          now: () => clock.t }) });
      const ship = new ShipServiceFixture();
      let throwNext = true;
      wing.isBlocked = (id) => {
        if (throwNext) {
          throwNext = false;
          throw new Error("bug");
        }
        return wing.set.has(id);
      };
      refused(() => ship.Handle_Board([BLOCKED, 1], {}, null));
      throwNext = true;
      assert.strictEqual(ship.Handle_Board([FREE, 1], {}, null).from, "Board", "(a) other IDs -> original");
      wing.isBlocked = () => {
        throw new Error("bug");
      };
      wing.ownsBlocked = (charId) => charId === 90000001;
      refused(() => ship.Handle_Board([FREE], { characterID: 90000001 }, null));
      assert.strictEqual(ship.Handle_Board([FREE], { characterID: 90000002 }, null).from, "Board", "(c)");
      assert.strictEqual(result.counters["guard.error"], 4);
      assert.strictEqual(result.counters["guard.refused.Handle_Board"], 2);
      assert.deepStrictEqual(lines, ["guard error in Handle_Board - bug"], "first at once, the rest rate-limited");
      clock.t = 60000;
      assert.strictEqual(ship.Handle_Board([FREE], {}, null).from, "Board");
      assert.deepStrictEqual(lines[1], "guard error in Handle_Board - bug (3 more since the last line)");
      assert.deepStrictEqual(plainTopLevelIds([[1, 2], 3, "x", { type: "list" }], 10), [1, 2, 3]);
      assert.strictEqual(plainTopLevelIds([[1, 2, 3]], 2), null);
    } finally {
      unwrapShip(saved);
    }
  });
};
