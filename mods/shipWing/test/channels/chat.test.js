"use strict";

const assert = require("node:assert");
const { REFUSAL } = require("../../lib/core/reasons");
const {
  parse, refusalText, formatStatus, createChatChannel, MISSING_TEXT, WINDOW_TEXT, MISSING_CARGO_TEXT,
} = require("../../lib/channels/chat");
const { createClientWindowChannel } = require("../../lib/channels/clientWindow");

const CHAR = 90000001;

function ship(id, name, extra = {}) {
  return { shipItemId: id, typeId: 22544, name, state: "IN_BAY", eligible: true, refusal: null, entityId: null,
    distanceM: null, targetId: null, ...extra };
}

function fakeCore(ships, limit = 2) {
  const core = { calls: [], launched: 0 };
  core.listWing = (charId) => ({ characterId: charId, hostShipId: 1000000400, limit, deployedCount: core.launched,
    refusal: null, ships: ships.map((s) => ({ ...s })) });
  core.orderCopy = (charId, shipItemId, verb, opts) => {
    core.calls.push([charId, shipItemId, verb, opts ? opts.commandId : undefined]);
    if (verb === "return") return { ok: true, state: "RETURNING" };
    if (core.launched >= limit) return { ok: false, reason: "LIMIT" };
    core.launched += 1;
    return { ok: true, state: "ACTIVE" };
  };
  return core;
}

module.exports = ({ test }) => {
  test("CH1 parse: launch / launch hulk / return / status / other verb -> help / foreign line -> null", () => {
    assert.deepStrictEqual(parse("!wing launch", "!wing"), { verb: "launch", filter: "" });
    assert.deepStrictEqual(parse("  !WING Launch Hulk  Mk2 ", "!wing"), { verb: "launch", filter: "Hulk Mk2" });
    assert.deepStrictEqual(parse("!wing return", "!wing"), { verb: "return", filter: "" });
    assert.deepStrictEqual(parse("!wing status", "!wing"), { verb: "status", filter: "" });
    assert.deepStrictEqual(parse("!wing", "!wing"), { verb: "help", filter: "" });
    assert.deepStrictEqual(parse("!wing fly", "!wing"), { verb: "help", filter: "" });
    assert.strictEqual(parse("hello !wing launch", "!wing"), null);
    assert.strictEqual(parse("!wingman launch", "!wing"), null);
    assert.strictEqual(parse("!aud status", "!wing"), null);
    assert.strictEqual(parse(undefined, "!wing"), null);
  });

  test("CH2 every REFUSAL code has a text; status line formats states, distance and refusals", () => {
    assert.deepStrictEqual(MISSING_TEXT, []);
    for (const code of REFUSAL) assert.notStrictEqual(refusalText(code), code, code);
    const line = formatStatus({ deployedCount: 1, limit: 2, refusal: null, ships: [
      ship(501, "Hulk A", { state: "ACTIVE", eligible: false, refusal: "ALREADY_DEPLOYED", distanceM: 1520.4 }),
      ship(502, "Hulk B"),
      ship(506, "Mackinaw", { eligible: false, refusal: "MISSING_SKILLS" }),
      ship(507, "Covetor", { state: "LOST", eligible: false, refusal: "LOST_UNSETTLED" }),
    ] });
    assert.strictEqual(line, "Ship Wing 1/2 out: Hulk A [out 1520 m] | Hulk B [in bay] | "
      + "Mackinaw [in bay - you cannot fly it (skills)] | Covetor [LOST]");
    assert.strictEqual(formatStatus({ deployedCount: 0, limit: 2, refusal: "NOT_IN_SPACE", ships: [] }),
      "Ship Wing 0/2 out (you must be in space, in a ship with a Ship Maintenance Bay): no ships in the bay.");
  });

  test("CH3 launch loop: eligible ships ascending until LIMIT, one server commandId per line; "
    + "text = first match only; return over ACTIVE", () => {
    const core = fakeCore([ship(501, "Hulk A"), ship(502, "Hulk B"), ship(503, "Covetor"),
      ship(506, "Mackinaw", { eligible: false, refusal: "MISSING_SKILLS" })]);
    const channel = createChatChannel({ core, trigger: "!wing", characterIdOf: (s) => s.characterID });
    const session = { characterID: CHAR };
    assert.strictEqual(channel.match("!wing launch"), true);
    assert.strictEqual(channel.match("o7"), false);
    assert.strictEqual(channel.handle(session, "!wing launch"),
      "Ship Wing: launched Hulk A, Hulk B; not launched: Covetor (wing limit reached).");
    assert.deepStrictEqual(core.calls.map((c) => c[1]), [501, 502, 503]);
    assert.ok(core.calls.every((c) => c[3] === "chat-1"), "one commandId for the whole line");
    core.launched = 0;
    core.calls.length = 0;
    assert.strictEqual(channel.handle(session, "!wing launch cov"), "Ship Wing: launched Covetor.");
    assert.deepStrictEqual(core.calls, [[CHAR, 503, "launch", "chat-2"]], "new line, new commandId");
    assert.strictEqual(channel.handle(session, "!wing launch mack"),
      "Ship Wing: not launched: Mackinaw (you cannot fly it (skills)).");
    assert.strictEqual(channel.handle(session, "!wing launch nothing"),
      "Ship Wing: no ship matching \"nothing\" in your bay.");
    assert.strictEqual(channel.handle(session, "!wing return"), "Ship Wing: no wing copy out.");
    const out = fakeCore([ship(501, "Hulk A", { state: "ACTIVE" }), ship(502, "Hulk B", { state: "ACTIVE" })]);
    const back = createChatChannel({ core: out, trigger: "!wing", characterIdOf: (s) => s.characterID });
    assert.strictEqual(back.handle(session, "!wing return"), "Ship Wing: returning Hulk A, Hulk B.");
    assert.deepStrictEqual(out.calls.map((c) => [c[1], c[2]]), [[501, "return"], [502, "return"]]);
    assert.strictEqual(back.handle({}, "!wing status"), "Ship Wing: no character on this session.");
    assert.strictEqual(back.handle(session, "!wing x"),
      "Ship Wing: !wing launch [name] | !wing return [name] | !wing status");
  });

  test("CH4!wing ui: window off -> 'window is off'; client without GetState -> 'not available on your "
    + "client'; subscribed -> OnShipWingOpen sent (fake notifier)", () => {
    const session = { characterID: CHAR };
    const core = fakeCore([ship(501, "Hulk A")]);
    core.SUPPORTED_VERBS = ["launch", "return"];
    core.onWingChanged = () => () => {};
    const off = createChatChannel({ core, trigger: "!wing", characterIdOf: (s) => s.characterID });
    assert.strictEqual(off.handle(session, "!wing ui"), WINDOW_TEXT.OFF);
    assert.ok(/window is off/.test(WINDOW_TEXT.OFF));
    assert.ok(!off.handle(session, "!wing x").includes(" ui"), "usage without ui while off");

    const sent = [];
    const window = createClientWindowChannel({ core, timers: { setTimeout() {}, clearTimeout() {} },
      notify: (charId, token, type, snapshot) => {
        sent.push([charId, token, type, snapshot.ships.length]);
        return { ok: true };
      },
      config: { clientWindowStateMinIntervalMs: 1000, clientWindowMaxCommandsPerSecond: 5,
        clientWindowMaxShipsPerCommand: 20, clientWindowReportMinIntervalMs: 60000 } });
    const on = createChatChannel({ core, trigger: "!wing", characterIdOf: (s) => s.characterID,
      openWindow: (charId) => window.open(charId) });
    assert.ok(on.handle(session, "!wing x").endsWith(" | !wing ui"), "usage shows ui while on");
    const notReady = on.handle(session, "!wing ui");
    assert.strictEqual(notReady, WINDOW_TEXT.NOT_READY);
    assert.ok(/not available on your client/.test(notReady));
    assert.strictEqual(sent.length, 0);
    window.getState(CHAR, session);
    assert.strictEqual(on.handle(session, "!wing ui"), WINDOW_TEXT.OPENED);
    assert.deepStrictEqual(sent, [[CHAR, session, "OnShipWingOpen", 1]]);
    assert.strictEqual(core.calls.length, 0, "ui never orders a copy");
  });

  test("CH5!wing hold over ACTIVE copies only when the core has `hold`; status shows the task and m3", () => {
    const session = { characterID: CHAR };
    const ships = [ship(501, "Hulk A", { state: "ACTIVE", task: "FOLLOW", holdM3: 0 }),
      ship(502, "Hulk B", { state: "ACTIVE", task: "MINE", holdM3: 1234.6 }), ship(503, "Covetor")];
    const off = fakeCore(ships);
    const noHold = createChatChannel({ core: off, trigger: "!wing", characterIdOf: (s) => s.characterID });
    assert.strictEqual(noHold.handle(session, "!wing hold"), "Ship Wing: unknown order.");
    assert.strictEqual(off.calls.length, 0);
    const core = fakeCore(ships);
    core.SUPPORTED_VERBS = ["launch", "return", "hold"];
    core.orderCopy = (charId, id, verb) => {
      core.calls.push([charId, id, verb]);
      return id === 502 ? { ok: false, reason: "TASK_UNAVAILABLE" } : { ok: true, state: "ACTIVE", task: "HOLD" };
    };
    const on = createChatChannel({ core, trigger: "!wing", characterIdOf: (s) => s.characterID });
    assert.ok(on.handle(session, "!wing x").includes(" | !wing hold [name]"));
    assert.strictEqual(on.handle(session, "!wing hold"),
      "Ship Wing: holding Hulk A; not holding: Hulk B (this order is not available now).");
    assert.deepStrictEqual(core.calls, [[CHAR, 501, "hold"], [CHAR, 502, "hold"]]);
    assert.strictEqual(formatStatus({ deployedCount: 2, limit: 2, refusal: null, ships }),
      "Ship Wing 2/2 out: Hulk A [out, following] | Hulk B [out, mining, 1235 m3] | Covetor [in bay]");
  });

  test("FM-U3 (formations)!wing formation -> current + set;!wing formation line -> setFormation; a "
    + "refusal has a readable text; off -> FORMATION_UNAVAILABLE text and no usage entry", () => {
    const core = fakeCore([ship(501, "Hulk A")]);
    const session = { characterID: CHAR };
    const off = createChatChannel({ core, trigger: "!wing", characterIdOf: (s) => s.characterID });
    assert.strictEqual(off.handle(session, "!wing formation"), "Ship Wing: formations are off on this server.");
    assert.ok(!off.handle(session, "!wing").includes("formation"), "no usage entry while off");

    let current = "none";
    const base = core.listWing;
    core.listWing = (charId) => ({ ...base(charId), formation: current });
    core.formationOn = true;
    core.FORMATIONS = ["none", "wedge", "line", "column", "sphere"];
    core.setCalls = [];
    core.setFormation = (charId, name) => {
      core.setCalls.push([charId, name]);
      if (name !== "line") return { ok: false, reason: "FORMATION_INVALID" };
      current = name;
      return { ok: true, formation: name, persisted: true };
    };
    const chat = createChatChannel({ core, trigger: "!wing", characterIdOf: (s) => s.characterID });
    assert.ok(chat.handle(session, "!wing").includes("| !wing formation [name]"));
    assert.strictEqual(chat.handle(session, "!wing formation"),
      "Ship Wing: formation none (none|wedge|line|column|sphere)");
    assert.strictEqual(chat.handle(session, "!wing formation line"), "Ship Wing: formation line.");
    assert.strictEqual(chat.handle(session, "!wing formation"),
      "Ship Wing: formation line (none|wedge|line|column|sphere)");
    assert.strictEqual(chat.handle(session, "!wing formation diamond"),
      "Ship Wing: formation not set (the formation is none, wedge, line, column or sphere).");
    assert.deepStrictEqual(core.setCalls, [[CHAR, "line"], [CHAR, "diamond"]]);
    core.setFormation = () => ({ ok: true, formation: "wedge", persisted: false });
    assert.strictEqual(chat.handle(session, "!wing formation wedge"),
      "Ship Wing: formation wedge (until restart, not saved).");
  });

  test("CH-SV!wing salvage only when the core has `salvage` (usage and order); a ship "
    + "without a Salvager is skipped, the loop goes on; the status shows salvaging (sub-state)", () => {
    const session = { characterID: CHAR };
    const ships = [ship(501, "Noctis", { state: "ACTIVE", task: "SALVAGE", taskSub: "SALVAGING" }),
      ship(502, "Hulk", { state: "ACTIVE", task: "FOLLOW" }), ship(503, "Destroyer", { state: "ACTIVE" })];
    const off = fakeCore(ships);
    off.SUPPORTED_VERBS = ["launch", "return", "hold", "mine", "attack"];
    const noSalvage = createChatChannel({ core: off, trigger: "!wing", characterIdOf: (s) => s.characterID });
    assert.ok(!noSalvage.handle(session, "!wing x").includes("salvage"), "no usage entry while off");
    assert.strictEqual(noSalvage.handle(session, "!wing salvage"), "Ship Wing: unknown order.");
    assert.strictEqual(off.calls.length, 0);
    const core = fakeCore(ships);
    core.SUPPORTED_VERBS = ["launch", "return", "hold", "salvage"];
    core.orderCopy = (charId, id, verb) => {
      core.calls.push([charId, id, verb]);
      return id === 502 ? { ok: false, reason: "NO_SALVAGER" } : { ok: true, state: "ACTIVE", task: "SALVAGE" };
    };
    const on = createChatChannel({ core, trigger: "!wing", characterIdOf: (s) => s.characterID });
    assert.ok(on.handle(session, "!wing x").includes(" | !wing hold [name] | !wing salvage [name]"));
    assert.strictEqual(on.handle(session, "!wing salvage"),
      "Ship Wing: salvaging Noctis, Destroyer; not salvaging: Hulk (no salvager online).");
    assert.deepStrictEqual(core.calls.map((c) => c[1]), [501, 502, 503]);
    assert.ok(formatStatus({ deployedCount: 3, limit: 3, refusal: null, ships })
      .includes("Noctis [out, salvaging (salvaging)]"));
  });

  test("CH-B1 (board)!wing board: without a name the nearest flying copy, with a name the first match "
    + "ok -> 'you board'; a refusal -> its notify text; no server board -> off text, no usage entry", () => {
    const session = { characterID: CHAR };
    const ships = [ship(501, "Algos A", { state: "ACTIVE", entityId: 4201, distanceM: 3000 }),
      ship(502, "Algos B", { state: "RETURNING", entityId: 4202, distanceM: 1122 }),
      ship(503, "Hulk", { state: "IN_BAY" })];
    const calls = [];
    const board = (charId, twinId, s) => {
      calls.push([charId, twinId, s]);
      return twinId === 4202 ? { ok: true, shipItemId: 502 }
        : { ok: false, reason: "TOO_FAR", text: "You are too far away from the wing copy to board it (max 6550 m)." };
    };
    const chat = createChatChannel({ core: fakeCore(ships), trigger: "!wing", characterIdOf: (s) => s.characterID,
      board });
    assert.ok(chat.handle(session, "!wing x").includes(" | !wing board [name]"));
    assert.strictEqual(chat.handle(session, "!wing board"), "Ship Wing: you board Algos B.");
    assert.strictEqual(chat.handle(session, "!wing board algos"), "Ship Wing: Algos A not boarded - You are too far "
      + "away from the wing copy to board it (max 6550 m).");
    assert.deepStrictEqual(calls, [[CHAR, 4202, session], [CHAR, 4201, session]]);
    assert.strictEqual(chat.handle(session, "!wing board hulk"), "Ship Wing: no wing copy matching \"hulk\" out.");
    const off = createChatChannel({ core: fakeCore(ships), trigger: "!wing", characterIdOf: (s) => s.characterID });
    assert.ok(!off.handle(session, "!wing x").includes("board"));
    assert.strictEqual(off.handle(session, "!wing board"), "Ship Wing: boarding a copy is off on this server.");
  });

  test("CH-RC1!wing store: the current hauler / none; `store off` -> setCargoStore "
    + "null; `store <name>` -> the first bay ship that matches; off (no cargoStoreOn) -> the usage line as before", () => {
    const session = { characterID: CHAR };
    const ships = [ship(501, "Hulk A", { state: "ACTIVE" }), ship(502, "Miasmos"), ship(503, "Epithal")];
    const core = fakeCore(ships);
    const calls = [];
    let current = 0;
    core.cargoStoreOn = true;
    core.cargoStoreOf = (hostShipId) => (hostShipId === 1000000400 ? current : 0);
    core.setCargoStore = (charId, id) => {
      calls.push([charId, id]);
      current = id || 0;
      return { ok: true, hostShipId: 1000000400, storeShipItemId: id };
    };
    const chat = createChatChannel({ core, trigger: "!wing", characterIdOf: (s) => s.characterID });
    assert.ok(chat.handle(session, "!wing x").includes(" | !wing store [name|off]"));
    assert.ok(/hauler none/.test(chat.handle(session, "!wing store")));
    assert.strictEqual(chat.handle(session, "!wing store epi"), "Ship Wing: hauler Epithal.");
    assert.strictEqual(chat.handle(session, "!wing store"), "Ship Wing: hauler Epithal.");
    assert.ok(/hauler off/.test(chat.handle(session, "!wing store off")));
    assert.strictEqual(chat.handle(session, "!wing store hulk"), "Ship Wing: no ship matching \"hulk\" in your bay.",
      "a flying copy is not a hauler");
    assert.deepStrictEqual(calls, [[CHAR, 503], [CHAR, null]]);
    core.setCargoStore = () => ({ ok: false, reason: "NOT_IN_SPACE" });
    assert.ok(chat.handle(session, "!wing store mias").startsWith("Ship Wing: hauler not set (you must be in space"));
    const offCore = fakeCore(ships);
    const off = createChatChannel({ core: offCore, trigger: "!wing", characterIdOf: (s) => s.characterID });
    const usage = off.handle(session, "!wing x");
    assert.ok(!usage.includes("store"));
    assert.strictEqual(off.handle(session, "!wing store miasmos"), usage, "flag off: the usage as before");
  });

  test("CH-CG1!wing cargo: one line of the holds; `move <from> to <to|host> [type]` "
    + "-> core.moveCargo with the stacks of `from` (of the type) and the target; refusal texts; every cargo code has "
    + "a text; off (no cargoOn) -> the usage line as before", () => {
    const session = { characterID: CHAR };
    const item = (itemId, name, qty) => ({ itemId, typeId: name === "Veldspar" ? 1230 : 3651, name, qty, m3: qty });
    const view = { ok: true, hostShipId: 1000000400, truncated: 0, ships: [
      { shipItemId: 1000000400, typeId: 28606, name: "Orca", host: true, holds: [
        { flag: 134, kind: "mining", capacityM3: 50000, usedM3: 0, items: [] },
        { flag: 5, kind: "cargo", capacityM3: 3000, usedM3: 10, items: [item(602, "Gyro", 2)] }] },
      { shipItemId: 501, typeId: 22544, name: "Hulk A", host: false, holds: [
        { flag: 134, kind: "mining", capacityM3: 8500, usedM3: 3000.4, items: [item(601, "Veldspar", 200),
          item(604, "Veldspar", 100), item(605, "Scordite", 5)] }] }] };
    const core = fakeCore([]);
    const moves = [];
    core.cargoOn = true;
    core.cargoOf = () => view;
    core.moveCargo = (charId, input) => {
      moves.push([charId, input.items.map((i) => i.itemId), input.toShipItemId, input.toFlag]);
      return { ok: true, movedQty: 300, movedM3: 3000, skipped: 0, results: [
        { itemId: 601, ok: true, reason: null, typeId: 1230, name: "Veldspar", movedQty: 200, leftQty: 0 },
        { itemId: 604, ok: true, reason: null, typeId: 1230, name: "Veldspar", movedQty: 100, leftQty: 20 }] };
    };
    const chat = createChatChannel({ core, trigger: "!wing", characterIdOf: (s) => s.characterID });
    assert.ok(chat.handle(session, "!wing x").endsWith(" | !wing cargo [name] | !wing move <from> to <to|host> [type]"));
    assert.strictEqual(chat.handle(session, "!wing cargo"), "Ship Wing cargo: Orca (your ship) [mining 0/50000 m3; "
      + "cargo 10/3000 m3: Gyro x2] | Hulk A [mining 3000/8500 m3: Veldspar x300, Scordite x5]");
    assert.ok(chat.handle(session, "!wing cargo host").startsWith("Ship Wing cargo: Orca (your ship) ["));
    assert.strictEqual(chat.handle(session, "!wing move hulk a to host veld"),
      "Ship Wing: moved Veldspar x300 (3000 m3) from Hulk A to Orca; the rest not moved (no room there).");
    assert.deepStrictEqual(moves, [[CHAR, [601, 604], 1000000400, null]], "the type filter, the target, toFlag auto");
    assert.strictEqual(chat.handle(session, "!wing move host to hulk"), "Ship Wing: moved Veldspar x300 (3000 m3) "
      + "from Orca to Hulk A; the rest not moved (no room there).");
    assert.deepStrictEqual(moves[1], [CHAR, [602], 501, null], "every stack of the host, the longest target name");
    assert.strictEqual(chat.handle(session, "!wing move hulk to hulk"), "Ship Wing: from and to are the same ship.");
    assert.strictEqual(chat.handle(session, "!wing move hulk host"),
      "Ship Wing: !wing move <from> to <to|host> [type]");
    assert.strictEqual(chat.handle(session, "!wing move orca to hulk tritanium"),
      "Ship Wing: no cargo matching \"tritanium\" in Orca.");
    assert.strictEqual(chat.handle(session, "!wing move rorqual to host"),
      "Ship Wing: no ship matching \"rorqual\" (your ship or its bay).");
    core.moveCargo = () => ({ ok: false, reason: "COOLDOWN", skipped: 0, results: [] });
    assert.strictEqual(chat.handle(session, "!wing move hulk to host"),
      "Ship Wing: cargo not moved (wait a moment before the next move).");
    core.cargoOf = () => ({ ok: false, reason: "NOT_IN_SPACE" });
    assert.ok(chat.handle(session, "!wing cargo").startsWith("Ship Wing: no cargo list (you must be in space"));
    assert.deepStrictEqual(MISSING_CARGO_TEXT, []);
    const off = createChatChannel({ core: fakeCore([]), trigger: "!wing", characterIdOf: (s) => s.characterID });
    const usage = off.handle(session, "!wing x");
    assert.ok(!usage.includes("cargo") && !usage.includes("move"));
    assert.strictEqual(off.handle(session, "!wing cargo"), usage, "flag off: the usage as before");
    assert.strictEqual(off.handle(session, "!wing move hulk to host"), usage);
  });

  test("CH-CG2!wing move: a part left by a vendor failure "
    + "says \"the server refused the move\", not \"no room there\"; `from` with stacks over the list -> cargoOf again "
    + "with `from` first, its stacks moved; still over -> a \"not listed\" note", () => {
    const session = { characterID: CHAR };
    const ship = (shipItemId, name, host, items, truncated) => ({ shipItemId, typeId: 1, name, host, truncated,
      holds: [{ flag: 5, kind: "cargo", capacityM3: 100, usedM3: 0, items }] });
    const veld = (itemId) => ({ itemId, typeId: 1230, name: "Veldspar", qty: 10, m3: 10 });
    const lists = [];
    const core = fakeCore([]);
    core.cargoOn = true;
    let hidden = 0;
    core.cargoOf = (charId, first) => {
      lists.push(first);
      return { ok: true, hostShipId: 400, truncated: 1, ships: [ship(400, "Orca", true, [], first ? 1 : 0),
        ship(501, "Hulk A", false, first ? [veld(601), veld(602)] : [veld(601)], first ? hidden : 1)] };
    };
    const moves = [];
    core.moveCargo = (charId, input) => {
      moves.push(input.items.map((i) => i.itemId));
      return { ok: true, movedQty: 15, movedM3: 15, skipped: 0, results: [
        { itemId: 601, ok: true, reason: null, typeId: 1230, name: "Veldspar", movedQty: 5, leftQty: 5,
          stopReason: "MOVE_FAILED" },
        { itemId: 602, ok: true, reason: null, typeId: 1230, name: "Veldspar", movedQty: 10, leftQty: 0 }] };
    };
    const chat = createChatChannel({ core, trigger: "!wing", characterIdOf: (s) => s.characterID });
    assert.strictEqual(chat.handle(session, "!wing move hulk to host"), "Ship Wing: moved Veldspar x15 (15 m3) from "
      + "Hulk A to Orca; the rest not moved (the server refused the move).");
    assert.deepStrictEqual([lists, moves], [[undefined, 501], [[601, 602]]], "the list again with Hulk A first");
    hidden = 3;
    assert.ok(chat.handle(session, "!wing move hulk to host").endsWith("; 3 stacks not listed, move again for them."));
  });

  test("ES1 status of an ACTIVE copy with EWAR: `, EWAR 2 (on: web, scram)`; a kind "
    + "outside EWAR_KIND skipped; no EWAR fields -> the text of today", () => {
    const line = (active) => formatStatus({ deployedCount: 1, limit: 2, refusal: null,
      ships: [ship(501, "Vexor", { state: "ACTIVE", active })] });
    const today = line({ cap: "stable" });
    assert.strictEqual(today, "Ship Wing 1/2 out: Vexor [out, cap stable]");
    assert.strictEqual(line({ cap: "stable", ewar: 2, ewarOn: ["web", "scram"] }),
      "Ship Wing 1/2 out: Vexor [out, cap stable, EWAR 2 (on: web, scram)]");
    assert.strictEqual(line({ cap: "stable", ewar: 2, ewarOn: ["web", "ecm"] }),
      "Ship Wing 1/2 out: Vexor [out, cap stable, EWAR 2 (on: web)]");
    assert.strictEqual(line({ cap: "stable", ewar: 1, ewarOn: [] }), "Ship Wing 1/2 out: Vexor [out, cap stable, EWAR 1]");
    assert.strictEqual(line({ cap: "stable", ewarOn: ["web"] }), today, "no summary.ewar (flag off) -> as today");
  });
};
