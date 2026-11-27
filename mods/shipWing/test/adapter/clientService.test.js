"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const {
  SERVICE_NAME, NOTIFY, fromWire, toWire, createShipWingServiceClass, installClientServiceFromGame, createNotifier,
} = require("../../lib/adapter/clientService");
const { createClientWindowChannel } = require("../../lib/channels/clientWindow");

const CHAR = 90000001;
const MARSHAL = path.resolve(__dirname, "..", "..", "..", "..", "server", "src", "network", "tcp", "utils",
  "marshal.js");

class FakeBaseService {
  constructor(name) {
    this._name = name;
  }

  get name() {
    return this._name;
  }

  callMethod(method, args, session, kwargs) {
    const handler = `Handle_${method}`;
    return typeof this[handler] === "function" ? this[handler](args, session, kwargs, null) : null;
  }
}

function fakeManager() {
  const services = new Map();
  return {
    services,
    register(service) {
      if (!service.name) throw new Error("service must have a 'name' property!");
      service.serviceManager = this;
      services.set(service.name, service);
    },
    lookup: (name) => services.get(name) || null,
  };
}

function fakeAdapter(available = true) {
  return {
    isConsumerAvailable: (consumer) => available && consumer === "clientWindow",
    requireGame: (rel) => (rel === "services/baseService" ? { ok: true, exports: FakeBaseService }
      : { ok: false, reason: "not_in_game_modules" }),
  };
}

function fakeCore() {
  const core = { calls: [], SUPPORTED_VERBS: ["launch", "return"] };
  core.orderCopy = (charId, id, verb, opts) => {
    core.calls.push([charId, id, verb, opts.commandId]);
    return { ok: true, state: "ACTIVE" };
  };
  core.listWing = () => ({ limit: 2, deployedCount: 0, refusal: "GUARDS_UNAVAILABLE", ships: [] });
  core.onWingChanged = () => () => {};
  return core;
}

function channelOf(core) {
  return createClientWindowChannel({ core, notify: () => ({ ok: true }), timers: { setTimeout() {}, clearTimeout() {} },
    config: { clientWindowStateMinIntervalMs: 1000, clientWindowMaxCommandsPerSecond: 50,
      clientWindowMaxShipsPerCommand: 20, clientWindowReportMinIntervalMs: 60000 } });
}

function plain(value) {
  if (Buffer.isBuffer(value)) return value.toString("latin1");
  if (typeof value === "bigint") return Number(value);
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === "object") {
    if (value.type === "wstring") return value.value;
    if (value.type === "list") return value.items.map(plain);
    if (value.type === "dict") return Object.fromEntries(value.entries.map(([k, v]) => [plain(k), plain(v)]));
  }
  return value;
}

function entriesOf(wire) {
  return Object.fromEntries(wire.entries);
}

module.exports = ({ test, skip }) => {
  test("CS1 class extends the fake BaseService directly (not ShipService/InvBrokerService); name shipWingSvc; "
    + "Handle_* never throws; charId from the session, extra args and kwargs ignored", () => {
    const core = fakeCore();
    const ServiceClass = createShipWingServiceClass(FakeBaseService, channelOf(core));
    assert.strictEqual(Object.getPrototypeOf(ServiceClass), FakeBaseService, "direct subclass");
    assert.strictEqual(Object.getPrototypeOf(ServiceClass.prototype), FakeBaseService.prototype);
    const service = new ServiceClass();
    assert.strictEqual(service.name, SERVICE_NAME);
    const handlers = Object.getOwnPropertyNames(ServiceClass.prototype).filter((n) => n.startsWith("Handle_"));
    assert.deepStrictEqual(handlers.sort(), ["Handle_Command", "Handle_GetState", "Handle_Report", "Handle_SetDrones",
      "Handle_SetEngage", "Handle_SetFormation"]);
    const session = { characterID: CHAR };
    core.setMirrorEngage = (charId, id, on) => ({ ok: true, state: "ACTIVE", on, charId, id });
    const engage = entriesOf(service.callMethod("SetEngage", [{ type: "list", items: [501n] }, "on"], session));
    assert.deepStrictEqual([engage.ok, engage.reason, engage.results.length], [true, null, 1]);
    delete core.setMirrorEngage;
    const out = service.callMethod("Command", [{ type: "list", items: [501n, 502] }, "launch", null, "extra", 9],
      session, { charId: 1, commandId: "x" });
    const result = entriesOf(out);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.commandID, "ui-1");
    assert.deepStrictEqual(core.calls, [[CHAR, 501, "launch", "ui-1"], [CHAR, 502, "launch", "ui-1"]]);
    const state = entriesOf(service.callMethod("GetState", [], session));
    assert.strictEqual(state.refusal, "GUARDS_UNAVAILABLE", "WingView.refusal goes to the window unchanged");
    assert.strictEqual(service.callMethod("Report", [1, 3396210, { type: "list", items: [Buffer.from("a=1")] }],
      session), true);

    const bad = entriesOf(service.callMethod("Command", [{ type: "dict", entries: "x" }, Buffer.alloc(300)], session));
    assert.deepStrictEqual([bad.ok, bad.reason, bad.commandID, bad.results], [false, "BAD_ARGS", null, []]);
    const noChar = entriesOf(service.callMethod("Command", [[501], "launch"], {}));
    assert.strictEqual(noChar.reason, "NO_CHARACTER");
    const throwing = { getState() { throw new Error("x"); }, command() { throw new Error("x"); },
      report() { throw new Error("x"); } };
    const broken = new (createShipWingServiceClass(FakeBaseService, throwing))();
    for (const args of [undefined, null, [], [[1], "launch"], "junk"]) {
      assert.strictEqual(entriesOf(broken.Handle_GetState(args, session)).reason, "INTERNAL");
      assert.strictEqual(entriesOf(broken.Handle_Command(args, session)).reason, "INTERNAL");
      assert.strictEqual(entriesOf(broken.Handle_SetDrones(args, session)).reason, "INTERNAL");
      assert.strictEqual(entriesOf(broken.Handle_SetEngage(args, session)).reason, "INTERNAL");
      assert.strictEqual(broken.Handle_Report(args, session), true);
    }
  });

  test("FM-U2 (formations) Handle_SetFormation([\"wedge\"]) -> channel.setFormation(char, {name}) and the "
    + "wire of its result; a throwing channel -> refusal INTERNAL", () => {
    const calls = [];
    const channel = { setFormation(charId, input) {
      calls.push([charId, input]);
      return { ok: true, result: { v: 2, ok: true, reason: null, formation: "wedge", persisted: true } };
    } };
    const service = new (createShipWingServiceClass(FakeBaseService, channel))();
    const session = { characterID: CHAR };
    const out = entriesOf(service.callMethod("SetFormation", ["wedge"], session));
    assert.deepStrictEqual(calls, [[CHAR, { name: "wedge" }]]);
    assert.deepStrictEqual([out.ok, out.reason, plain(out.formation), out.persisted], [true, null, "wedge", true]);
    const broken = new (createShipWingServiceClass(FakeBaseService, { setFormation() { throw new Error("x"); } }))();
    const refused = entriesOf(broken.Handle_SetFormation(["wedge"], session));
    assert.deepStrictEqual([refused.ok, refused.reason], [false, "INTERNAL"]);
  });

  test("CS-CG1 core without cargoOn -> no getCargo/moveCargo in the channel, no "
    + "Handle_GetCargo/MoveCargo, no `cargo` in the state; with it: GetCargo -> the wire of core.cargoOf, MoveCargo -> "
    + "core.moveCargo (ids, target, toFlag None = auto), bad args -> BAD_ARGS, a throwing core -> INTERNAL", () => {
    const session = { characterID: CHAR };
    const handlers = (core) => Object.getOwnPropertyNames(createShipWingServiceClass(FakeBaseService,
      channelOf(core)).prototype).filter((n) => n.includes("Cargo"));
    const plainCore = fakeCore();
    assert.deepStrictEqual([handlers(plainCore), "getCargo" in channelOf(plainCore)], [[], false]);
    assert.ok(!("cargo" in channelOf(plainCore).getState(CHAR, session).snapshot), "flag off: the state as before");
    const core = fakeCore();
    const moves = [];
    core.cargoOn = true;
    core.cargoOf = () => ({ ok: true, hostShipId: 1000000400, truncated: 0, ships: [{ shipItemId: 501, name: "Hulk A",
      host: false, holds: [{ flag: 134, kind: "mining", capacityM3: 8500, usedM3: 3000.4, items: [{ itemId: 601,
        typeId: 1230, name: "Veldspar", qty: 300, m3: 3000 }] }] }] });
    core.moveCargo = (charId, input) => {
      moves.push([charId, input]);
      return { ok: true, movedQty: 300, movedM3: 3000, skipped: 0, results: [{ itemId: 601, ok: true, reason: null,
        movedQty: 300 }] };
    };
    assert.deepStrictEqual(handlers(core).sort(), ["Handle_GetCargo", "Handle_MoveCargo"]);
    const channel = channelOf(core);
    assert.strictEqual(channel.getState(CHAR, session).snapshot.cargo, true);
    const service = new (createShipWingServiceClass(FakeBaseService, channel))();
    const list = plain(service.callMethod("GetCargo", [], session));
    assert.deepStrictEqual([list.v, list.ok, list.hostShipID, list.ships[0].holds[0].used,
      list.ships[0].holds[0].items[0]], [2, true, 1000000400, 3000, { itemID: 601, typeID: 1230, name: "Veldspar",
      qty: 300, m3: 3000 }]);
    const moved = plain(service.callMethod("MoveCargo", [{ type: "list", items: [601n] }, 1000000400, null, null],
      session));
    assert.deepStrictEqual([moved.ok, moved.movedQty, moved.results], [true, 300, [{ itemID: 601, ok: true,
      reason: null, movedQty: 300 }]]);
    assert.deepStrictEqual(moves, [[CHAR, { items: [{ itemId: 601, quantity: null }], toShipItemId: 1000000400,
      toFlag: null }]]);
    const bad = plain(service.callMethod("MoveCargo", [[601, 602], 1000000400, null, 5], session));
    assert.deepStrictEqual([bad.ok, bad.reason], [false, "BAD_ARGS"], "a quantity only with one stack");
    core.cargoOf = () => { throw new Error("x"); };
    assert.deepStrictEqual([plain(service.callMethod("GetCargo", [], session)).reason], ["INTERNAL"]);
  });

  test("CS2 registration on world.serviceManager: ok, then SERVICE_NAME_TAKEN without overwrite "
    + "no probe / no manager -> refusal", () => {
    const manager = fakeManager();
    const world = { serviceManager: manager };
    const first = installClientServiceFromGame(fakeAdapter(), world, channelOf(fakeCore()), {});
    assert.strictEqual(first.ok, true);
    assert.strictEqual(manager.lookup(SERVICE_NAME), first.service);
    assert.strictEqual(first.service.serviceManager, manager);
    const second = installClientServiceFromGame(fakeAdapter(), world, channelOf(fakeCore()), {});
    assert.deepStrictEqual(second, { ok: false, reason: "SERVICE_NAME_TAKEN" });
    assert.strictEqual(manager.lookup(SERVICE_NAME), first.service, "the first one stays");
    assert.deepStrictEqual(installClientServiceFromGame(fakeAdapter(false), { serviceManager: fakeManager() },
      channelOf(fakeCore())), { ok: false, reason: "probe_clientWindow_unavailable" });
    assert.deepStrictEqual(installClientServiceFromGame(fakeAdapter(), {}, channelOf(fakeCore())),
      { ok: false, reason: "NO_SERVICE_MANAGER" });
  });

  test("CS3 notifier: other session -> SESSION_CHANGED; closed socket -> SESSION_CHANGED; ok -> sendNotification"
    + "(type, clientID, [dict]); no live adapter -> SEND_FAILED", () => {
    const calls = [];
    const session = { socket: { destroyed: false }, sendNotification: (...a) => calls.push(a) };
    let current = session;
    const notify = createNotifier({ findSession: () => current });
    assert.deepStrictEqual(notify(CHAR, session, NOTIFY.OPEN, { v: 1, ok: true }), { ok: true });
    const payload = [{ type: "dict", entries: [["v", 1], ["ok", true]] }];
    assert.deepStrictEqual(calls, [["OnShipWingOpen", "clientID", payload]]);
    current = {};
    assert.deepStrictEqual(notify(CHAR, session, NOTIFY.STATE, {}), { ok: false, reason: "SESSION_CHANGED" });
    current = session;
    session.socket.destroyed = true;
    assert.deepStrictEqual(notify(CHAR, session, NOTIFY.STATE, {}), { ok: false, reason: "SESSION_CHANGED" });
    assert.deepStrictEqual(createNotifier(null)(CHAR, session, NOTIFY.STATE, {}), { ok: false, reason: "SEND_FAILED" });
  });

  test("CS4 fromWire strict: list/tuple/Buffer/wstring/bigint ok; float, unsafe bigint, depth > 3, > 128 items, "
    + "string > 256 bytes, unknown object -> BAD_ARGS", () => {
    assert.deepStrictEqual(fromWire({ type: "list", items: [1, 2n, Buffer.from("ab"), { type: "wstring", value: "c" },
      null, true] }), { ok: true, value: [1, 2, "ab", "c", null, true] });
    const dict = fromWire({ type: "dict", entries: [["a", 1]] });
    assert.ok(dict.ok && dict.value instanceof Map && dict.value.get("a") === 1);
    for (const v of [1.5, 2n ** 60n, [[[[1]]]], Array.from({ length: 129 }, () => 1), "x".repeat(257),
      { type: "object", value: 1 }, { foo: 1 }, () => 1]) {
      assert.deepStrictEqual(fromWire(v), { ok: false, reason: "BAD_ARGS" }, String(v).slice(0, 20));
    }
    assert.deepStrictEqual(toWire([1.6, undefined, () => 1, 5n, new Map(), "s"]), [2, null, null, null, null, "s"]);
  });

  if (!fs.existsSync(MARSHAL)) {
    skip("CS5 marshal round trip", `no EveJS tree at ${MARSHAL}`);
    return;
  }

  test("CS5 marshal round trip: snapshot and Command result through toWire -> marshalEncode -> "
    + "marshalDecode give the same values; a `type` field in data stays data", () => {
    const { marshalEncode, marshalDecode } = require(MARSHAL);
    const snapshot = { v: 1, verbs: ["launch", "return"], limit: 2, deployed: 1, refusal: null, ships: [
      { shipItemID: 1000000501, typeID: 22544, name: "Hulk Łódź", state: "ACTIVE", eligible: false,
        refusal: "ALREADY_DEPLOYED", entityID: 4200000000000001, distanceM: 1521, targetID: null },
      { shipItemID: 1000000502, typeID: 22544, name: "dict", state: "IN_BAY", eligible: true, refusal: null,
        entityID: null, distanceM: null, targetID: null },
    ] };
    const result = { v: 1, ok: false, reason: "NOT_OWNER", commandID: "ui-7", results: [
      { shipItemID: 1000000501, ok: true, reason: null, state: "ACTIVE" },
      { shipItemID: 1000000504, ok: false, reason: "NOT_OWNER", state: null },
    ] };
    const tricky = { type: "list", items: [1, 2], entries: "x", value: "y" };
    for (const value of [snapshot, result, tricky]) {
      const decoded = marshalDecode(marshalEncode(toWire(value)));
      assert.strictEqual(decoded.type, "dict", "a dict on the wire");
      assert.deepStrictEqual(plain(decoded), value);
    }
  });
};
