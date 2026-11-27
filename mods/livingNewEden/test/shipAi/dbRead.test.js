"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const S = require("../../lib/shipAi/schema");
const { readCargoFrom, readFittingFrom, readPilotFrom } = require("../../lib/adapter/shipAiDbRead");
const { toolsFor, TOOLS, unknownDisabledTools } = require("../../lib/shipAi/tools/catalog");
const { createToolDeps, DB_METHODS } = require("../../lib/shipAi/tools/deps");
const { WATCH_DB_METHODS } = require("../../lib/shipAi/watch");
const { runToolLoop, createToolState } = require("../../lib/shipAi/tools/loop");
const { createAdapter } = require("../../lib/adapter");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SERVER_SRC = path.resolve(MOD_DIR, "..", "..", "server", "src");
const PLAYER = 9001;
const OTHER = 9002;
const SHIP = 140000001;
const RIFTER = 587;
const STATION = 60003760;
const CORP = 98000001;
const FLAGS = Object.freeze({ HANGAR: 4, CARGO_HOLD: 5, DRONE_BAY: 87, FLEET_HANGAR: 155 });
const CHARGE_CATEGORY = 8;

const base = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_SHIP_AI_ENABLED: "1" } }).config;

function settings(over) {
  const r = S.shipAiModelSettingsOf({ shipAi: { ...base.shipAi, minIntervalMs: 0, ...(over || {}) } });
  assert.ok(r.ok, JSON.stringify(r));
  return r.settings;
}

const row = (itemID, typeID, flagID, extra) => ({ itemID, typeID, ownerID: PLAYER, locationID: SHIP, flagID,
  quantity: 1, stacksize: 1, singleton: 0, categoryID: 7, volume: 1, ...(extra || {}) });

function vendorMods(rows, sessionOver) {
  const session = sessionOver || { characterID: PLAYER, stationid: STATION, shipID: SHIP };
  const ship = { itemID: SHIP, typeID: RIFTER, ownerID: PLAYER, locationID: STATION, flagID: FLAGS.HANGAR };
  const foreign = row(1, 34, null, { ownerID: OTHER, quantity: 999, stacksize: 999 });
  return {
    sessionRegistry: { getSessions: () => [session] },
    itemStore: {
      ITEM_FLAGS: FLAGS,
      findItemById: (id) => (id === SHIP ? { ...ship } : null),
      listContainerItems: (owner, location, flag = null) => [
        ...rows.filter((r) => r.ownerID === owner && r.locationID === location && (flag === null || r.flagID === flag)),
        { ...foreign, flagID: flag === null ? 27 : flag },
      ].map((r) => ({ ...r })),
    },
    liveFitting: {
      isShipFittingFlag: (f) => [[11, 34], [92, 99], [125, 132], [164, 171]].some(([a, b]) => f >= a && f <= b),
      isChargeItem: (item) => item && item.categoryID === CHARGE_CATEGORY,
      isFittedModuleItem(item) {
        return Boolean(item) && this.isShipFittingFlag(item.flagID) && !this.isChargeItem(item);
      },
    },
  };
}

const NAMES = new Map([[RIFTER, "Rifter"], [34, "Tritanium"], [2488, "Warrior I"], [3082, "125mm Autocannon I"],
  [178, "EMP S"], [2032, "Small Shield Extender I"], [31055, "Small Trimark Armor Pump I"]]);

function adapterFake(spy) {
  return {
    readItemTypeFacts: (ids) => {
      spy.typeReads += 1;
      return { ok: true, facts: new Map(ids.filter((id) => NAMES.has(id)).map((id) => [id, { typeId: id,
        name: NAMES.get(id) }])), missing: [] };
    },
    readNpcStations: (ids) => ({ ok: true, stations: new Map(ids.filter((id) => id === STATION)
      .map((id) => [id, { stationId: id, name: "Jita IV - Moon 4" }])) }),
    tradeReadCharacterWallet: () => ({ ok: true, balanceIsk: 10 }),
  };
}

function depsOf(db, S2, spy = { typeReads: 0 }) {
  return createToolDeps({ adapter: adapterFake(spy), sensors: null, S: S2, getGraph: () => null,
    getFleets: () => null, getWorld: () => null, getStore: () => null, db });
}

const fakeClient = (replies) => {
  const specs = [];
  return { specs, request(spec) {
    specs.push(spec);
    return Promise.resolve(replies.shift() || { ok: true, text: "Done.", toolCalls: null, totalTokens: 1 });
  } };
};
const reply = (t) => ({ ok: true, text: t, toolCalls: null, totalTokens: 1 });
const PROMPT = Object.freeze([{ role: "system", content: "persona" }, { role: "user", content: "cargo?" }]);
function resultsOf(spec) {
  const msg = spec.messages.filter((m) => m.role === "user").at(-1);
  return msg.content.split("\n").map((line) => {
    const m = /^TOOL_RESULT ([a-z_]+): (.*)$/.exec(line);
    assert.ok(m, line);
    return [m[1], JSON.parse(m[2])];
  });
}

module.exports = ({ test }) => {
  test("DB1 readCargoFrom / readFittingFrom: grouping by type, racks, the charge at its module, more past maxRows, "
    + "a foreign row dropped", () => {
    const rows = [
      row(11, 34, FLAGS.CARGO_HOLD, { quantity: 500, stacksize: 500, volume: 0.01 }),
      row(12, 34, FLAGS.CARGO_HOLD, { quantity: 250, stacksize: 250, volume: 0.01 }),
      row(13, 178, FLAGS.CARGO_HOLD, { quantity: 200, stacksize: 200, categoryID: CHARGE_CATEGORY, volume: 0.0025 }),
      row(14, 2032, FLAGS.CARGO_HOLD, { quantity: -1, stacksize: 1, singleton: 1, volume: 5 }),
      row(15, 2488, FLAGS.DRONE_BAY, { quantity: 2, stacksize: 2, volume: 5 }),
      row(21, 3082, 27), row(22, 178, 27, { quantity: 100, stacksize: 100, categoryID: CHARGE_CATEGORY }),
      row(23, 3082, 28), row(24, 178, 28, { quantity: 80, stacksize: 80, categoryID: CHARGE_CATEGORY }),
      row(25, 3082, 29), row(26, 2032, 19), row(27, 31055, 92), row(28, 2032, 164),
    ];
    const m = vendorMods(rows);
    const cargo = readCargoFrom(m, PLAYER, { maxRows: 2 });
    assert.deepStrictEqual(cargo, { ok: true, docked: true, shipTypeId: RIFTER, volumeM3: 13,
      holds: [{ hold: "cargo", items: [{ typeId: 34, qty: 750 }, { typeId: 178, qty: 200 }], more: 1 },
        { hold: "drones", items: [{ typeId: 2488, qty: 2 }], more: 0 }] }, "no fleet hangar row, foreign 999 dropped");
    const fit = readFittingFrom(m, PLAYER, { maxRows: 8 });
    assert.deepStrictEqual(fit, { ok: true, shipTypeId: RIFTER, racks: [
      { rack: "high", modules: [{ typeId: 3082, count: 2, chargeTypeId: 178, chargeQty: 180 },
        { typeId: 3082, count: 1, chargeTypeId: null, chargeQty: 0 }], more: 0 },
      { rack: "med", modules: [{ typeId: 2032, count: 1, chargeTypeId: null, chargeQty: 0 }], more: 0 },
      { rack: "rig", modules: [{ typeId: 31055, count: 1, chargeTypeId: null, chargeQty: 0 }], more: 0 }] });
    assert.strictEqual(readFittingFrom(m, PLAYER, { maxRows: 1 }).racks[0].more, 1);
    const space = vendorMods(rows, { characterID: PLAYER, _space: { shipID: SHIP } });
    assert.strictEqual(readCargoFrom(space, PLAYER, { maxRows: 8 }).docked, false);
    assert.deepStrictEqual(readCargoFrom(m, 4242, { maxRows: 8 }), { ok: false, reason: "NO_SESSION" });
    const stolen = vendorMods(rows);
    stolen.itemStore.findItemById = (id) => ({ itemID: id, typeID: RIFTER, ownerID: OTHER });
    assert.deepStrictEqual(readFittingFrom(stolen, PLAYER, { maxRows: 8 }), { ok: false, reason: "NO_SHIP" });
    assert.deepStrictEqual(readFittingFrom({ ...m, liveFitting: null }, PLAYER, { maxRows: 8 }),
      { ok: false, reason: "SEAM_UNAVAILABLE" });

    const db = { cargo: (id, o) => readCargoFrom(m, id, o), fitting: (id, o) => readFittingFrom(m, id, o) };
    const spy = { typeReads: 0 };
    const deps = depsOf(db, settings(), spy);
    const tool = (name) => toolsFor(settings()).find((t) => t.name === name);
    const ctx = { playerId: PLAYER, deps, S: settings({ toolMaxRows: 2 }) };
    assert.deepStrictEqual(tool("cargo").run(ctx).data, { ship: "Rifter", docked: true, cargoUsedM3: 13,
      holds: [{ hold: "cargo", items: [{ item: "Tritanium", qty: 750 }, { item: "EMP S", qty: 200 }], more: 1 },
        { hold: "drones", items: [{ item: "Warrior I", qty: 2 }], more: 0 }] });
    assert.deepStrictEqual(tool("fitting").run(ctx).data.racks[0], { rack: "high", modules: [
      { module: "125mm Autocannon I", count: 2, charge: "EMP S", chargeQty: 180 },
      { module: "125mm Autocannon I", count: 1 }], more: 0 });
    assert.strictEqual(spy.typeReads, 2, "one type facts read per tool call");
  });

  test("DB2 readPilotFrom: never getCharacterRecord (it throws here), peekCharacterRecord with the fallback fields; "
    + "pilot_info names corporation, NPC station, creation date", () => {
    const peeked = [];
    const characterState = {
      getCharacterRecord: () => {
        throw new Error("getCharacterRecord may write");
      },
      peekCharacterRecord: (id) => {
        peeked.push(id);
        return id === PLAYER ? { characterName: "Pilot One", corporationID: CORP, securityRating: -2.345,
          cloneStationID: STATION, createDateTime: "132000000000000000", description: "my bio" } : null;
      },
    };
    const lookups = [];
    const corporationState = { getOwnerLookupRecord: (id) => {
      lookups.push(id);
      return { ownerID: id, ownerName: "Own Corp" };
    } };
    const mods = { characterState, corporationState };
    assert.deepStrictEqual(readPilotFrom(mods, PLAYER), { ok: true, corporationName: "Own Corp",
      securityStatus: -2.345, homeStationId: STATION, createdFileTime: "132000000000000000" });
    assert.deepStrictEqual(readPilotFrom(mods, 4242), { ok: false, reason: "NO_RECORD" });
    assert.deepStrictEqual([peeked, lookups], [[PLAYER, 4242], [CORP]]);
    const r = readPilotFrom({ characterState: { peekCharacterRecord: () => ({ corporationID: CORP, securityStatus: 1.5,
      securityRating: -9, homeStationID: 60000004 }) }, corporationState: { getOwnerLookupRecord: () => {
      throw new Error("pending");
    } } }, PLAYER);
    assert.deepStrictEqual(r, { ok: true, corporationName: null, securityStatus: 1.5, homeStationId: 60000004,
      createdFileTime: null });

    const deps = depsOf({ pilot: (id) => readPilotFrom(mods, id) }, settings());
    const pilot = toolsFor(settings()).find((t) => t.name === "pilot_info");
    assert.deepStrictEqual(pilot.run({ playerId: PLAYER, deps, S: settings() }).data, { corporation: "Own Corp",
      securityStatus: -2.35, homeStation: "Jita IV - Moon 4", created: "2019-04-17" }, "no bio, no name of the pilot");
    const structure = depsOf({ pilot: () => ({ ...readPilotFrom(mods, PLAYER), homeStationId: 1035466617946 }) },
      settings());
    assert.strictEqual(pilot.run({ playerId: PLAYER, deps: structure, S: settings() }).data.homeStation, "structure");
    const failing = createToolDeps({ adapter: { ...adapterFake({ typeReads: 0 }),
      readNpcStations: () => ({ ok: false, reason: "WORLD_DATA_UNAVAILABLE" }) }, sensors: null, S: settings(),
    getGraph: () => null, getFleets: () => null, getWorld: () => null, getStore: () => null,
    db: { pilot: (id) => readPilotFrom(mods, id) } });
    assert.strictEqual(pilot.run({ playerId: PLAYER, deps: failing, S: settings() }).data.homeStation, null);
    assert.deepStrictEqual(depsOf(null, settings()).pilot(PLAYER), { ok: false, reason: "SEAM_UNAVAILABLE" });
  });

  test("DB3 toolsFor: dbReadEnabled false = exactly v1; CSV 'fitting' drops only fitting, the loop answers "
    + "UNKNOWN_TOOL; unknown CSV names", async () => {
    const v1 = TOOLS.map((t) => t.name);
    assert.deepStrictEqual(toolsFor(settings({ dbReadEnabled: false })).map((t) => t.name), v1);
    const sub2 = ["assets", "find_item", "wallet_history", "skill_queue", "standings", "killmails", "missions",
      "industry_jobs", "market_orders", "battles_nearby", "invasions", "dscan"];
    assert.deepStrictEqual(toolsFor(settings()).map((t) => t.name), [...v1, "cargo", "fitting", "pilot_info", ...sub2]);
    const off = settings({ dbReadDisabledTools: " fitting " });
    assert.deepStrictEqual(toolsFor(off).map((t) => t.name), [...v1, "cargo", "pilot_info", ...sub2]);
    assert.ok(toolsFor(off) === toolsFor(settings({ dbReadDisabledTools: " fitting " })), "memo per (enabled, CSV)");
    for (const t of toolsFor(settings()).filter((x) => x.db === true)) assert.ok(t.description.length <= 70, t.name);

    const db = { fitting: () => assert.fail("a disabled tool never runs"),
      cargo: () => ({ ok: true, docked: true, shipTypeId: RIFTER, holds: [], volumeM3: 0 }) };
    const fc = fakeClient([reply("ASK: fitting\nASK: cargo"), reply("Ok.")]);
    const st = createToolState(off);
    await runToolLoop({ client: fc, messages: PROMPT, mode: "text", S: off, state: st,
      ctx: { playerId: PLAYER, deps: depsOf(db, off), nowMs: () => 1 } });
    const results = resultsOf(fc.specs[1]);
    assert.deepStrictEqual(results[0], ["fitting", { ok: false, reason: "UNKNOWN_TOOL" }]);
    assert.strictEqual(results[1][1].ok, true);
    assert.ok(!fc.specs[0].messages.some((m) => m.content.includes("- fitting:")), "not in the catalogue lines");
    assert.ok(fc.specs[0].messages.some((m) => m.content.includes("- cargo: cargo, drone bay and fleet hangar")));
    assert.deepStrictEqual([st.counters.unknownTool, Object.keys(st.byTool).includes("fitting")], [1, false]);

    assert.deepStrictEqual(unknownDisabledTools(settings({ dbReadDisabledTools: "fitting,wallet,nope" })),
      ["wallet", "nope"], "only v2 names can be disabled");
    assert.deepStrictEqual(unknownDisabledTools(settings({ dbReadEnabled: false, dbReadDisabledTools: "nope" })), []);
    const bad = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_SHIP_AI_DB_READ_DISABLED_TOOLS: "a;b" } });
    assert.ok(bad.warnings.some((w) => w.includes("DB_READ_DISABLED_TOOLS") && w.endsWith("- ignored")),
      JSON.stringify(bad.warnings));
    assert.strictEqual(bad.config.shipAi.dbReadDisabledTools, "");
  });

  test("DB4 vendor facts of the game data seams + the methods of seam.db on the real adapter facade", () => {
    const src = (rel) => fs.readFileSync(path.join(SERVER_SRC, rel), "utf8").replace(/\r\n/g, "\n");
    const body = (text, head) => {
      const at = text.indexOf(`\nfunction ${head}`);
      assert.ok(at >= 0, head);
      const end = text.indexOf("\nfunction ", at + 1);
      return text.slice(at, end < 0 ? undefined : end);
    };
    const items = src("services/inventory/itemStore.js");
    const list = body(items, "listContainerItems(ownerId, locationId, flagId = null, typeIds = null) {");
    assert.ok(list.includes("ensureItemIndexes().byLocation.get(numericLocationId)"));
    assert.ok(list.includes("(numericOwnerId === null || entry.ownerID === numericOwnerId)"));
    assert.ok(list.includes(".map((entry) => cloneValue(entry));"), "clones, never the live rows");
    for (const n of ["listContainerItems", "findItemById", "ITEM_FLAGS"]) assert.ok(items.includes(`\n  ${n},\n`), n);
    for (const f of ["  CARGO_HOLD: 5,", "  DRONE_BAY: 87,", "  FLEET_HANGAR: 155,"]) assert.ok(items.includes(f), f);
    assert.ok(body(items, "buildInventoryItem").includes("stacksize: normalizedSingleton > 0 ? 1 : normalizedUnits,"));
    const fit = src("services/fitting/liveFittingState.js");
    for (const n of ["isShipFittingFlag", "isChargeItem", "isFittedModuleItem"]) {
      assert.ok(fit.includes(`\n  ${n},\n`) && fit.includes(`\nfunction ${n}(`), n);
    }
    assert.ok(fit.includes("const CHARGE_CATEGORY_ID = 8;") && fit.includes("Object.freeze([11, 34]),"));
    const chars = src("services/character/characterState.js");
    const peek = body(chars, "peekCharacterRecord(charId) {");
    assert.ok(!/write/i.test(peek) && chars.includes("\n  peekCharacterRecord,\n"), "peek reads only");
    assert.ok(chars.includes("normalized.securityStatus ?? normalized.securityRating ?? 0,"));
    assert.ok(chars.includes("Number(charData.homeStationID || charData.cloneStationID || 0) || 0;"));
    const corp = src("services/corporation/corporationState.js");
    assert.ok(corp.includes("\nfunction getOwnerLookupRecord(ownerID) {") && corp.includes("\n  getOwnerLookupRecord,\n"));
    assert.ok(body(corp, "getCorporationOwnerRecord").includes("ownerName: record.corporationName,"));
    const own = fs.readFileSync(path.join(MOD_DIR, "lib", "adapter", "shipAiDbRead.js"), "utf8");
    for (const banned of ["getCharacterRecord", "getActiveShipItem", "ensure"]) {
      assert.ok(!own.split("\n").some((l) => !l.trimStart().startsWith("*") && l.includes(banned)), banned);
    }

    const SRC = path.join(path.sep, "x", "server", "src");
    const key = (rel) => path.join(SRC, `${rel}.js`);
    const m = vendorMods([row(11, 34, FLAGS.CARGO_HOLD, { quantity: 3, stacksize: 3 })]);
    const chat = { sendChannelMessage() {}, ensurePrivateChannelForCharacters() {} };
    const cache = {
      [key("_secondary/chat/chatRuntime")]: { exports: chat },
      [key("services/chat/xmppStubServer")]: { exports: { inviteCharacterToRoom: () => true,
        handleSocketForEdge: () => ({}) } },
      [key("services/chat/sessionRegistry")]: { exports: m.sessionRegistry },
      [key("services/inventory/itemStore")]: { exports: m.itemStore },
    };
    const adapter = createAdapter({ moduleApi: { _cache: cache }, logger: { log() {} } });
    adapter.setServerSrc(SRC);
    const r = adapter.shipAiSeams();
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.deepStrictEqual(Object.keys(r.seam.db).sort(), [...DB_METHODS, ...WATCH_DB_METHODS].sort());
    assert.deepStrictEqual(r.seam.db.cargo(PLAYER, { maxRows: 8 }).holds,
      [{ hold: "cargo", items: [{ typeId: 34, qty: 3 }], more: 0 }]);
    assert.deepStrictEqual(r.seam.db.fitting(PLAYER, { maxRows: 8 }), { ok: false, reason: "SEAM_UNAVAILABLE" },
      "liveFittingState not loaded");
  });

  test("DB5 runCalls: a game data call longer than dbReadSlowMs counts shipAi.dbReadSlow once, a v1 call never",
    async () => {
      let t = 0;
      const S2 = settings({ dbReadSlowMs: 20, toolCacheMs: 0 });
      const db = { cargo: () => {
        t += 25;
        return { ok: true, docked: true, shipTypeId: RIFTER, holds: [], volumeM3: 0 };
      } };
      const counts = [];
      const telemetry = { count: (name, n) => counts.push([name, n]) };
      const st = createToolState(S2);
      const fc = fakeClient([reply("ASK: wallet\nASK: cargo"), reply("Ok.")]);
      await runToolLoop({ client: fc, messages: PROMPT, mode: "text", S: S2, state: st, perfNow: () => t, telemetry,
        ctx: { playerId: PLAYER, deps: depsOf(db, S2), nowMs: () => 1 } });
      assert.deepStrictEqual(resultsOf(fc.specs[1]).map(([n, v]) => [n, v.ok]), [["wallet", true], ["cargo", true]]);
      assert.deepStrictEqual(counts.filter(([n]) => n === S.METRIC.dbReadSlow), [["shipAi.dbReadSlow", 1]]);
      assert.strictEqual(counts.filter(([n]) => n === S.METRIC.toolCalls).length, 2);
      assert.deepStrictEqual([st.counters.dbReadSlow, st.byTool.cargo], [1, { ok: 1, refused: 0 }]);
      assert.ok(S.METRICS.includes("shipAi.dbReadSlow"));
    });
};
