"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const S = require("../../lib/shipAi/schema");
const { readAssetsFrom, readFindItemFrom, readWalletHistoryFrom, readSkillQueueFrom, readStandingsFrom } =
  require("../../lib/adapter/shipAiDbRead");
const { toolsFor } = require("../../lib/shipAi/tools/catalog");
const { createToolDeps } = require("../../lib/shipAi/tools/deps");
const { runToolLoop, createToolState } = require("../../lib/shipAi/tools/loop");
const { GAME_MODULES } = require("../../lib/adapter/gameModules");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SERVER_SRC = path.resolve(MOD_DIR, "..", "..", "server", "src");
const PLAYER = 9001;
const OTHER = 9002;
const STATION = 60003760;
const STRUCTURE = 1035466617946;
const RIFTER = 587;
const CAN = 3293;
const TRIT = 34;
const NOW = 1800000000000;
const HOUR = 3600000;

const base = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_SHIP_AI_ENABLED: "1" } }).config;
function settings(over) {
  const r = S.shipAiModelSettingsOf({ shipAi: { ...base.shipAi, minIntervalMs: 0, ...(over || {}) } });
  assert.ok(r.ok, JSON.stringify(r));
  return r.settings;
}

const item = (itemID, typeID, locationID, extra) => ({ itemID, typeID, ownerID: PLAYER, locationID, flagID: 4,
  categoryID: 4, quantity: 1, stacksize: 1, singleton: 0, ...(extra || {}) });

function itemStoreOf(rows) {
  const foreign = item(999, TRIT, STATION, { ownerID: OTHER, quantity: 9999, stacksize: 9999 });
  return {
    listOwnedItems: (owner, opts = {}) => [...rows.filter((r) => r.ownerID === owner
      && (opts.typeID === undefined || r.typeID === opts.typeID)), foreign].map((r) => ({ ...r })),
    findItemById: (id) => {
      const hit = [...rows, foreign].find((r) => r.itemID === id);
      return hit ? { ...hit } : null;
    },
  };
}

const STATION_NAMES = new Map([[STATION, "Jita IV - Moon 4"]]);
function depsOf(db, S2, over) {
  const adapter = {
    readItemTypeFacts: (ids) => ({ ok: true, facts: new Map(ids.filter((id) => [RIFTER, CAN, TRIT].includes(id))
      .map((id) => [id, { name: { [RIFTER]: "Rifter", [CAN]: "Large Secure Container", [TRIT]: "Tritanium" }[id] }])) }),
    readNpcStations: (ids) => ({ ok: true, stations: new Map(ids.filter((id) => STATION_NAMES.has(id))
      .map((id) => [id, { stationId: id, name: STATION_NAMES.get(id) }])) }),
    readFactionNames: () => ({ ok: true, names: new Map([[500001, "Caldari State"], [500010, "Guristas Pirates"]]) }),
    ...((over && over.adapter) || {}),
  };
  const sensors = { itemByName: (name) => (name === "Tritanium"
    ? { ok: true, found: true, item: { typeId: TRIT, name: "Tritanium" } } : { ok: true, found: false }) };
  return createToolDeps({ adapter, sensors, S: S2, getGraph: () => null, getFleets: () => null,
    getWorld: () => null, getStore: () => null, db });
}
const toolOf = (name) => toolsFor(settings()).find((t) => t.name === name);
const fileTime = (ms) => String((BigInt(ms) + 11644473600000n) * 10000n);

module.exports = ({ test }) => {
  test("DR1 assets / find_item: grouping by site, nested stacks, kind ship with holder and site, foreign row dropped",
    () => {
      const rows = [
        item(501, RIFTER, STATION, { categoryID: 6, singleton: 1 }),
        item(502, RIFTER, STRUCTURE, { categoryID: 6, singleton: 1 }),
        item(601, TRIT, STATION, { quantity: 500, stacksize: 500 }),
        item(602, TRIT, 501, { flagID: 5, quantity: 300, stacksize: 300 }),
        item(603, CAN, STATION, { categoryID: 2, singleton: 1 }),
        item(604, TRIT, 603, { quantity: 100, stacksize: 100 }),
        item(605, TRIT, STRUCTURE, { quantity: 50, stacksize: 50 }),
        item(606, 178, STATION, { categoryID: 8, quantity: 10, stacksize: 10 }),
      ];
      const m = { itemStore: itemStoreOf(rows) };
      assert.deepStrictEqual(readAssetsFrom(m, PLAYER, { maxRows: 8 }), { ok: true, totalItems: 4, more: 0,
        locations: [{ locationId: STATION, kind: "station", items: 3, ships: 1 },
          { locationId: STRUCTURE, kind: "structure", items: 1, ships: 1 }] }, "602/604 nested, foreign 999 dropped");
      assert.strictEqual(readAssetsFrom(m, PLAYER, { maxRows: 1 }).more, 1);
      const found = readFindItemFrom(m, PLAYER, TRIT, { maxRows: 8 });
      assert.deepStrictEqual(found, { ok: true, totalQty: 950, more: 0, places: [
        { locationId: STATION, kind: "station", qty: 500, holderTypeId: null, siteId: STATION, siteKind: "station" },
        { locationId: 501, kind: "ship", qty: 300, holderTypeId: RIFTER, siteId: STATION, siteKind: "station" },
        { locationId: 603, kind: "container", qty: 100, holderTypeId: CAN, siteId: STATION, siteKind: "station" },
        { locationId: STRUCTURE, kind: "structure", qty: 50, holderTypeId: null, siteId: STRUCTURE,
          siteKind: "structure" }] });
      assert.deepStrictEqual(readAssetsFrom({ itemStore: null }, PLAYER, { maxRows: 8 }),
        { ok: false, reason: "SEAM_UNAVAILABLE" });
      const WRAP = 1040000000007;
      const wrapped = { itemStore: itemStoreOf([item(WRAP, 60, STATION, { categoryID: 2, singleton: 1 }),
        item(703, TRIT, WRAP, { quantity: 7, stacksize: 7 })]) };
      assert.deepStrictEqual(readFindItemFrom(wrapped, PLAYER, TRIT, { maxRows: 8 }).places, [{ locationId: WRAP,
        kind: "container", qty: 7, holderTypeId: 60, siteId: STATION, siteKind: "station" }]);
      assert.deepStrictEqual(readAssetsFrom(wrapped, PLAYER, { maxRows: 8 }).locations,
        [{ locationId: STATION, kind: "station", items: 1, ships: 0 }], "the wrap at the station, its content nested");

      const db = { assets: (id, o) => readAssetsFrom(m, id, o), findItem: (id, t, o) => readFindItemFrom(m, id, t, o) };
      const ctx = { playerId: PLAYER, deps: depsOf(db, settings()), S: settings(), nowMs: () => NOW };
      assert.deepStrictEqual(toolOf("assets").run(ctx).data, { totalItems: 4, more: 0, locations: [
        { place: "Jita IV - Moon 4", kind: "station", items: 3, ships: 1 },
        { place: "structure", kind: "structure", items: 1, ships: 1 }] });
      assert.deepStrictEqual(toolOf("find_item").run(ctx, { item: "Tritanium" }).data.places.slice(0, 2), [
        { place: "Jita IV - Moon 4", in: "station", qty: 500 },
        { place: "Jita IV - Moon 4", in: "ship", holder: "Rifter", qty: 300 }]);
      assert.deepStrictEqual(toolOf("find_item").run(ctx, { item: "Unobtainium" }),
        { ok: false, reason: "UNKNOWN_ITEM" });
    });

  test("DR2 wallet_history: projection / fallback peek, cash only, alias type, no description or counterparty",
    () => {
      const journal = [
        { transactionDate: fileTime(NOW - 60000), entryTypeID: 16, accountKey: 1000, amount: 1000, balance: 5000,
          description: "SECRET-DESC-1 from Bob", ownerID1: PLAYER, ownerID2: 777123, referenceID: 777123 },
        { transactionDate: fileTime(NOW - 2 * HOUR), entryTypeID: 2, accountKey: 1000, amount: -400, balance: 4000,
          description: "SECRET-DESC-2" },
        { transactionDate: fileTime(NOW - 48 * HOUR), entryTypeID: 99, accountKey: 1000, amount: 200, balance: 4400 },
        { transactionDate: fileTime(NOW - HOUR), entryTypeID: 2, accountKey: 1200, amount: 5, balance: 5 },
      ];
      const walletState = { JOURNAL_ENTRY_TYPE: { PLAYER_TRADING: 1, MARKET_TRANSACTION: 2, BOUNTY: 16, ALIAS: 16 },
        ACCOUNT_KEY: { CASH: 1000, AURUM: 1200 },
        getCharacterWalletJournal: () => assert.fail("getCharacterWalletJournal may write") };
      const characterState = { getCharacterRecord: () => assert.fail("getCharacterRecord may write"),
        peekCharacterRecord: (id) => (id === PLAYER ? { walletJournal: journal } : null) };
      const withProjection = { walletState, characterState: { ...characterState,
        peekCharacterRecord: () => assert.fail("projection first") },
      walletProjection: { getCharacterProjection: (id) => (id === PLAYER
        ? { characterID: PLAYER, balance: 5000, walletJournal: journal } : null) } };
      const fallback = { walletState, characterState, walletProjection: { getCharacterProjection: () => null } };
      const opts = { maxRows: 2, nowMs: NOW, sumWindowMs: 24 * HOUR };
      const expected = { ok: true, more: 1, window: { inIsk: 1000, outIsk: 400, truncated: false }, entries: [
        { whenMsAgo: 60000, type: "bounty", amountIsk: 1000, balanceIsk: 5000 },
        { whenMsAgo: 2 * HOUR, type: "market_transaction", amountIsk: -400, balanceIsk: 4000 }] };
      assert.deepStrictEqual(readWalletHistoryFrom(withProjection, PLAYER, opts), expected);
      assert.deepStrictEqual(readWalletHistoryFrom(fallback, PLAYER, opts), expected);
      assert.strictEqual(readWalletHistoryFrom(fallback, PLAYER, { ...opts, maxRows: 8 }).entries[2].type, "other");
      assert.deepStrictEqual(readWalletHistoryFrom(fallback, OTHER, opts), { ok: false, reason: "NO_RECORD" });

      const db = { walletHistory: (id, o) => readWalletHistoryFrom(fallback, id, o) };
      const S2 = settings({ walletSumWindowMs: 24 * HOUR, toolMaxRows: 2 });
      const r = toolOf("wallet_history").run({ playerId: PLAYER, deps: depsOf(db, S2), S: S2, nowMs: () => NOW });
      assert.deepStrictEqual(r.data, { windowHours: 24, incomeIsk: 1000, spendingIsk: 400, more: 1, entries: [
        { minutesAgo: 1, type: "bounty", amountIsk: 1000, balanceIsk: 5000 },
        { minutesAgo: 120, type: "market_transaction", amountIsk: -400, balanceIsk: 4000 }] });
      for (const json of [JSON.stringify(readWalletHistoryFrom(fallback, PLAYER, { ...opts, maxRows: 8 })),
        JSON.stringify(r)]) {
        for (const secret of ["SECRET-DESC", "Bob", "777123"]) assert.ok(!json.includes(secret), secret);
      }
      const full = Array.from({ length: 100 }, (_, i) => ({ transactionDate: fileTime(NOW - (i + 1) * 60000),
        entryTypeID: 16, accountKey: 1000, amount: 10, balance: 10 }));
      const fullM = { walletState, characterState: { peekCharacterRecord: () => ({ walletJournal: full }) },
        walletProjection: { getCharacterProjection: () => null } };
      assert.strictEqual(readWalletHistoryFrom(fullM, PLAYER, opts).window.truncated, true);
      assert.strictEqual(readWalletHistoryFrom(fullM, PLAYER, { ...opts, sumWindowMs: 60000 }).window.truncated, false,
        "the oldest entry is older than the window: complete");
      const tool = toolOf("wallet_history").run({ playerId: PLAYER, S: S2, nowMs: () => NOW,
        deps: depsOf({ walletHistory: (id, o) => readWalletHistoryFrom(fullM, id, o) }, S2) });
      assert.strictEqual(tool.data.windowTruncated, true);
    });

  test("DR3 standings: only NPC owners (player row dropped), char row over npc row, top / bottom sorted", () => {
    const standingData = {
      char: [{ fromID: 500001, toID: PLAYER, standing: 5.5 }, { fromID: 1000125, toID: PLAYER, standing: -3 },
        { fromID: 90000123, toID: PLAYER, standing: 10 }, { fromID: 1000180, toID: OTHER, standing: 9 }],
      npc: [{ fromID: 500001, toID: PLAYER, standing: -9 }, { fromID: 1000035, toID: PLAYER, standing: 2.25 },
        { fromID: 500010, toID: PLAYER, standing: -7.123 }],
    };
    const names = new Map([[500001, "Caldari State"], [500010, "Guristas Pirates"], [1000125, "CONCORD"],
      [1000035, "Caldari Navy"]]);
    const m = { characterState: { peekCharacterRecord: (id) => (id === PLAYER ? { standingData } : null),
      getCharacterRecord: () => assert.fail("getCharacterRecord may write") },
    corporationState: { getOwnerLookupRecord: (id) => (names.has(id) ? { ownerID: id, ownerName: names.get(id) }
      : null) } };
    const deps = depsOf({ standings: (id, o) => readStandingsFrom(m, id, o) }, settings());
    assert.deepStrictEqual(deps.standings(PLAYER, 8), { ok: true,
      top: [{ ownerId: 500001, standing: 5.5, name: "Caldari State" },
        { ownerId: 1000035, standing: 2.25, name: "Caldari Navy" }],
      bottom: [{ ownerId: 500010, standing: -7.123, name: "Guristas Pirates" },
        { ownerId: 1000125, standing: -3, name: "CONCORD" }] }, "90000123 (a player) never");
    const one = deps.standings(PLAYER, 2);
    assert.deepStrictEqual([one.top.map((r) => r.ownerId), one.bottom.map((r) => r.ownerId)], [[500001], [500010]]);
    assert.deepStrictEqual(readStandingsFrom(m, PLAYER, { maxRows: 8 }), { ok: false, reason: "SEAM_UNAVAILABLE" },
      "no NPC predicate = refused, never unfiltered");
    const r = toolOf("standings").run({ playerId: PLAYER, deps, S: settings(), nowMs: () => NOW });
    assert.deepStrictEqual(r.data.worst, [{ owner: "Guristas Pirates", standing: -7.12 },
      { owner: "CONCORD", standing: -3 }]);
    let down = true;
    let reads = 0;
    const flaky = depsOf({ standings: (id, o) => readStandingsFrom(m, id, o) }, settings(), { adapter: {
      readFactionNames: () => {
        reads += 1;
        return down ? { ok: false, reason: "SEAM_UNAVAILABLE" }
          : { ok: true, names: new Map([[500001, "Caldari State"], [500010, "Guristas Pirates"]]) };
      } } });
    assert.deepStrictEqual(flaky.standings(PLAYER, 8).top.map((x) => x.ownerId), [1000035], "factions out (fail-closed)");
    down = false;
    assert.deepStrictEqual(flaky.standings(PLAYER, 8).top.map((x) => x.ownerId), [500001, 1000035], "read again");
    const kept = reads;
    flaky.standings(PLAYER, 8);
    assert.strictEqual(reads, kept, "a successful read is kept");
  });

  test("DR4 vendor facts of the seams; the cores never name a write-capable reader; GAME_MODULES", () => {
    const src = (rel) => fs.readFileSync(path.join(SERVER_SRC, rel), "utf8").replace(/\r\n/g, "\n");
    const body = (text, head) => {
      const at = text.indexOf(`\nfunction ${head}`);
      assert.ok(at >= 0, head);
      const end = text.indexOf("\nfunction ", at + 1);
      return text.slice(at, end < 0 ? undefined : end);
    };
    const queue = src("services/skills/training/skillQueueState.js");
    assert.ok(queue.includes("\n  getCharacterQueueState,\n"));
    const read = body(queue, "getCharacterQueueState(characterID) {");
    assert.ok(!/write/i.test(read) && read.includes("return normalizeQueueState(result.data || {});")
      && read.includes("database.read(SKILL_QUEUE_TABLE, `/${numericCharacterID}`)"), "a fresh copy, no write");
    const normalized = body(queue, "normalizeQueueState(rawState = {}) {");
    assert.ok(normalized.includes(".map(normalizeQueueEntry).filter(Boolean),") && !/write/i.test(normalized),
      "normalizeQueueState builds new rows");
    assert.ok(body(queue, "normalizeQueueEntry(entry) {").includes("toLevel,"));
    const runtime = src("services/skills/training/skillQueueRuntime.js");
    assert.ok(body(runtime, "getQueueSnapshot(characterID, options = {}) {")
      .includes("return readQueueDetails(characterID, options).snapshot;")
      && body(runtime, "readQueueDetails(characterID, options = {}, previousSkillData = null) {")
        .includes("settleQueueTraining("), "getQueueSnapshot settles (writes): never used");
    const proj = src("services/account/walletAuthorityProjection.js");
    assert.ok(proj.includes("\n  getCharacterProjection,\n")
      && body(proj, "getCharacterProjection(characterID) {").includes("return entry ? cloneValue(entry) : null;"));
    const wallet = src("services/account/walletState.js");
    assert.ok(body(wallet, "getCharacterWalletJournal(charId, options = {}) {").includes("getCharacterRecord(charId)"),
      "the vendor journal reader goes through getCharacterRecord without a projection");
    for (const f of ["\n  ACCOUNT_KEY,\n", "\n  JOURNAL_ENTRY_TYPE,\n", "  CASH: 1000,", "  BOUNTY: 16,",
      "    transactionDate: getFileTimeNowString(),", "    accountKey: Number(options.accountKey || ACCOUNT_KEY.CASH)",
      "    description: resolveLedgerReason(options, ", "    amount: delta,", "    balance: normalizedBalance,",
      "nextEntries.unshift(cloneValue(entry));"]) assert.ok(wallet.includes(f), f);
    const items = src("services/inventory/itemStore.js");
    const owned = body(items, "listOwnedItems(ownerId, options = {}) {");
    for (const f of ["ensureItemIndexes().byOwner.get(numericOwnerId)", "(typeID === null || entry.typeID === typeID)",
      ".map((entry) => cloneValue(entry));"]) assert.ok(owned.includes(f), f);
    assert.ok(items.includes("\n  listOwnedItems,\n") && items.includes("const SHIP_CATEGORY_ID = 6;"));
    const stand = src("services/character/standingRuntime.js");
    assert.ok(body(stand, "buildCharacterStandingBuckets(record) {").includes('getLegacyOrBucketStandingRows(record, "npc")'));
    assert.ok(body(stand, "normalizeStandingEntry(entry) {").includes("standing: clampStanding(entry.standing),"));

    const own = fs.readFileSync(path.join(MOD_DIR, "lib", "adapter", "shipAiDbRead.js"), "utf8").split("\n")
      .filter((l) => !l.trimStart().startsWith("*"));
    for (const banned of ["getCharacterRecord", "getCharacterWalletJournal", "getQueueSnapshot",
      "listCharacterStandings"]) assert.ok(!own.some((l) => l.includes(banned)), banned);

    const symsOf = (p) => (GAME_MODULES.find((e) => e.path === p) || { symbols: [] }).symbols
      .filter((s) => (s.consumers || []).includes("shipAiDb")).map((s) => s.name);
    assert.deepStrictEqual(symsOf("services/account/walletAuthorityProjection"), ["getCharacterProjection"]);
    assert.deepStrictEqual(symsOf("services/skills/training/skillQueueState"), ["getCharacterQueueState"]);
    assert.deepStrictEqual(symsOf("services/account/walletState").sort(), ["ACCOUNT_KEY", "JOURNAL_ENTRY_TYPE"]);
    assert.ok(symsOf("services/inventory/itemStore").includes("listOwnedItems"));
    assert.deepStrictEqual(readSkillQueueFrom({ skillQueueState: { getCharacterQueueState: () => ({ active: true,
      queue: [{ typeID: 3300, toLevel: 4 }, { typeID: 0, toLevel: 1 }, { typeID: 3301, toLevel: 2 }] }) } },
    PLAYER, { maxRows: 1 }), { ok: true, active: true, queue: [{ typeId: 3300, toLevel: 4 }], more: 1 });
  });

  test("DR5 loop end to end: ASK: find_item {\"item\":\"Tritanium\"} fits toolResultMaxChars", async () => {
    const rows = [];
    for (let i = 0; i < 40; i += 1) {
      STATION_NAMES.set(60000100 + i, `Some Rather Long NPC Station Name ${i} - Moon ${i} - Federation Navy`);
      rows.push(item(7000 + i, TRIT, 60000100 + i, { quantity: 10 + i, stacksize: 10 + i }));
    }
    const m = { itemStore: itemStoreOf(rows) };
    const S2 = settings({ toolMaxRows: 32 });
    const db = { findItem: (id, t, o) => readFindItemFrom(m, id, t, o) };
    const specs = [];
    const replies = [{ ok: true, text: 'ASK: find_item {"item":"Tritanium"}', toolCalls: null, totalTokens: 1 },
      { ok: true, text: "Ok.", toolCalls: null, totalTokens: 1 }];
    const client = { request(spec) {
      specs.push(spec);
      return Promise.resolve(replies.shift());
    } };
    await runToolLoop({ client, messages: [{ role: "system", content: "persona" }, { role: "user", content: "trit?" }],
      mode: "text", S: S2, state: createToolState(S2), ctx: { playerId: PLAYER, deps: depsOf(db, S2), nowMs: () => NOW } });
    const line = specs[1].messages.filter((x) => x.role === "user").at(-1).content.split("\n")
      .find((l) => l.startsWith("TOOL_RESULT find_item: "));
    assert.ok(line, "a TOOL_RESULT line");
    const json = line.slice("TOOL_RESULT find_item: ".length);
    assert.ok(json.length <= S2.toolResultMaxChars, String(json.length));
    const v = JSON.parse(json);
    assert.strictEqual(v.ok, true, json);
    assert.strictEqual(v.data.item, "Tritanium");
    assert.ok(v.data.places.length > 0 && v.data.places.length < 32, "cut to fit");
  });
};
