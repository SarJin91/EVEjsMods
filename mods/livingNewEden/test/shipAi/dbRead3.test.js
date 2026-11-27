"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const S = require("../../lib/shipAi/schema");
const { readKillmailsFrom, readMissionsFrom, readIndustryJobsFrom, readMarketOrdersFrom } =
  require("../../lib/adapter/shipAiDbRead");
const { toolsFor } = require("../../lib/shipAi/tools/catalog");
const { createToolDeps } = require("../../lib/shipAi/tools/deps");
const { GAME_MODULES } = require("../../lib/adapter/gameModules");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SERVER_SRC = path.resolve(MOD_DIR, "..", "..", "server", "src");
const PLAYER = 9001;
const OTHER = 9002;
const THIRD = 9003;
const RIFTER = 587;
const MERLIN = 603;
const TRIT = 34;
const STATION = 60003760;
const JITA = 30000142;
const NOW = 1800000000000;
const MINUTE = 60000;
const HOUR = 3600000;

const base = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_SHIP_AI_ENABLED: "1" } }).config;
function settings(over) {
  const r = S.shipAiModelSettingsOf({ shipAi: { ...base.shipAi, minIntervalMs: 0, ...(over || {}) } });
  assert.ok(r.ok, JSON.stringify(r));
  return r.settings;
}
const fileTime = (ms) => String((BigInt(ms) + 11644473600000n) * 10000n);
const NAMES = { [RIFTER]: "Rifter", [MERLIN]: "Merlin", [TRIT]: "Tritanium" };
function depsOf(db, S2) {
  const adapter = {
    readItemTypeFacts: (ids) => ({ ok: true, facts: new Map(ids.filter((id) => NAMES[id])
      .map((id) => [id, { name: NAMES[id] }])) }),
    readNpcStations: (ids) => ({ ok: true, stations: new Map(ids.filter((id) => id === STATION)
      .map((id) => [id, { stationId: id, name: "Jita IV - Moon 4" }])) }),
  };
  const graph = { getSystem: (id) => (id === JITA ? { name: "Jita" } : undefined) };
  return createToolDeps({ adapter, sensors: null, S: S2, getGraph: () => ({ getGraph: () => ({ ok: true, graph }) }),
    getFleets: () => null, getWorld: () => null, getStore: () => null, db });
}
const toolOf = (name) => toolsFor(settings()).find((t) => t.name === name);
const deepFreeze = (o) => {
  for (const v of Object.values(o)) if (v && typeof v === "object") deepFreeze(v);
  return Object.freeze(o);
};

module.exports = ({ test }) => {
  test("DR31 killmails: cold / dirty index = NOT_CACHED without list; roles; no other character in the JSON", () => {
    const records = [
      { killID: 3, killTime: fileTime(NOW - 5 * MINUTE), solarSystemID: JITA, victimCharacterID: PLAYER,
        victimShipTypeID: RIFTER, finalCharacterID: OTHER, finalShipTypeID: MERLIN, iskLost: 1500000.4,
        attackers: [{ characterID: OTHER, shipTypeID: MERLIN }, { characterID: THIRD, shipTypeID: MERLIN }] },
      { killID: 2, killTime: fileTime(NOW - HOUR), solarSystemID: JITA, victimCharacterID: OTHER,
        victimShipTypeID: MERLIN, finalCharacterID: THIRD, finalShipTypeID: MERLIN, iskLost: 900,
        attackers: [{ characterID: THIRD, shipTypeID: MERLIN }, { characterID: PLAYER, shipTypeID: RIFTER }] },
      { killID: 1, killTime: fileTime(NOW - 2 * HOUR), victimCharacterID: OTHER, finalCharacterID: THIRD,
        attackers: [{ characterID: THIRD }] },
    ];
    let stats = { ready: false, dirty: true };
    let calls = 0;
    const m = { killmailState: { getKillmailProjectionStats: () => ({ fullRebuilds: 1, ...stats }),
      listKillmailsForCharacter: (id, o) => {
        calls += 1;
        assert.deepStrictEqual([id, o], [PLAYER, { limit: 9 }]);
        return records.slice();
      } } };
    const opts = { maxRows: 8, nowMs: NOW };
    assert.deepStrictEqual(readKillmailsFrom(m, PLAYER, opts), { ok: false, reason: "NOT_CACHED" });
    stats = { ready: true, dirty: true };
    assert.deepStrictEqual(readKillmailsFrom(m, PLAYER, opts), { ok: false, reason: "NOT_CACHED" });
    assert.strictEqual(calls, 0, "a cold or dirty index is never rebuilt by the tool");
    stats = { ready: true, dirty: false };
    const r = readKillmailsFrom(m, PLAYER, opts);
    assert.deepStrictEqual(r, { ok: true, more: 0, entries: [
      { role: "loss", whenMsAgo: 5 * MINUTE, systemId: JITA, victimShipTypeId: RIFTER, ownShipTypeId: RIFTER,
        attackers: 2, iskLost: 1500000.4 },
      { role: "kill", whenMsAgo: HOUR, systemId: JITA, victimShipTypeId: MERLIN, ownShipTypeId: RIFTER,
        attackers: 2, iskLost: 900 }] }, "killID 1 has no part of the character");
    const tool = toolOf("killmails").run({ playerId: PLAYER, S: settings(), nowMs: () => NOW,
      deps: depsOf({ killmails: (id, o) => readKillmailsFrom(m, id, o) }, settings()) });
    assert.deepStrictEqual(tool.data.entries[0], { role: "loss", minutesAgo: 5, system: "Jita", victimShip: "Rifter",
      ownShip: "Rifter", attackers: 2, iskLost: 1500000 });
    for (const json of [JSON.stringify(r), JSON.stringify(tool)]) {
      for (const id of [OTHER, THIRD]) assert.ok(!json.includes(String(id)), String(id));
    }
    assert.deepStrictEqual(readKillmailsFrom({ killmailState: null }, PLAYER, opts),
      { ok: false, reason: "SEAM_UNAVAILABLE" });
  });

  test("DR32 missions: gameStore.read on a deeply frozen record, field projection; ENTRY_NOT_FOUND = empty", () => {
    const rec = deepFreeze({ characterID: PLAYER, missionsByAgentID: {
      3008416: { missionSequence: 2, agentID: 3008416, missionTitle: "The Blockade", missionKind: "encounter",
        runtimeStatus: "accepted", objectiveCompleted: true, missionSystemID: JITA,
        expiresAtFileTime: fileTime(NOW + 90 * MINUTE), missionReward: 999999 },
      3008417: { missionSequence: 1, agentID: 3008417, missionTitle: "Cargo Delivery", missionKind: "courier",
        runtimeStatus: "offered", objectiveCompleted: false, missionSystemID: 0, expiresAtFileTime: "0" } } });
    const reads = [];
    const gameStore = { read: (table, p) => {
      reads.push([table, p]);
      return p === `/charactersByID/${PLAYER}` ? { success: true, errorMsg: null, data: rec }
        : { success: false, errorMsg: "ENTRY_NOT_FOUND", data: null };
    } };
    const r = readMissionsFrom({ gameStore }, PLAYER, { maxRows: 8, nowMs: NOW });
    assert.deepStrictEqual(r, { ok: true, more: 0, missions: [
      { title: "Cargo Delivery", kind: "courier", status: "offered", done: false, systemId: null, expiresInHours: null,
        agentId: 3008417, expiresAtMs: null },
      { title: "The Blockade", kind: "encounter", status: "accepted", done: true, systemId: JITA,
        expiresInHours: 1.5, agentId: 3008416, expiresAtMs: NOW + 90 * MINUTE }] });
    assert.deepStrictEqual(reads, [["missionRuntimeState", `/charactersByID/${PLAYER}`]]);
    assert.deepStrictEqual(readMissionsFrom({ gameStore }, OTHER, { maxRows: 8, nowMs: NOW }),
      { ok: true, missions: [], more: 0 });
    assert.deepStrictEqual(readMissionsFrom({ gameStore: { read: () => ({ success: false, errorMsg: "READ_ERROR" }) } },
      PLAYER, { maxRows: 8, nowMs: NOW }), { ok: false, reason: "SEAM_UNAVAILABLE" }, "a read fault is no empty list");
    const tool = toolOf("missions").run({ playerId: PLAYER, S: settings(), nowMs: () => NOW,
      deps: depsOf({ missions: (id, o) => readMissionsFrom({ gameStore }, id, o) }, settings()) });
    assert.deepStrictEqual(tool.data.missions[1], { title: "The Blockade", kind: "encounter", status: "accepted",
      done: true, system: "Jita", expiresInHours: 1.5 });
    assert.ok(!JSON.stringify(tool).includes("999999"), "no reward");
  });

  test("DR33 market_orders: never answering = TIMEOUT, rejection = SEAM_UNAVAILABLE, vendor order shape", async () => {
    const timers = [];
    const setTimeoutFn = (cb, ms) => timers.push([cb, ms]);
    const silent = { call: () => new Promise(() => {}) };
    const pending = readMarketOrdersFrom({ marketDaemon: silent }, PLAYER, { maxRows: 8, timeoutMs: 3000,
      setTimeoutFn });
    assert.deepStrictEqual(timers.map((t) => t[1]), [3000]);
    timers[0][0]();
    assert.deepStrictEqual(await pending, { ok: false, reason: "TIMEOUT" });
    const failing = { call: () => Promise.reject(new Error("MARKET_DAEMON_DOWN")) };
    assert.deepStrictEqual(await readMarketOrdersFrom({ marketDaemon: failing }, PLAYER, { maxRows: 8, timeoutMs: 3000,
      setTimeoutFn: () => {} }), { ok: false, reason: "SEAM_UNAVAILABLE" });
    const throwing = { call: () => {
      throw new Error("sync");
    } };
    assert.deepStrictEqual(await readMarketOrdersFrom({ marketDaemon: throwing }, PLAYER, { maxRows: 8,
      timeoutMs: 3000, setTimeoutFn: () => {} }), { ok: false, reason: "SEAM_UNAVAILABLE" });

    const asked = [];
    const daemon = { call: (method, args) => {
      asked.push([method, args]);
      return Promise.resolve([
        { state: "open", owner_id: PLAYER, is_corp: false, row: { order_id: 1, type_id: TRIT, station_id: STATION,
          bid: false, price: 5.25, vol_entered: 1000, vol_remaining: 400 } },
        { state: "open", owner_id: PLAYER, is_corp: false, row: { order_id: 2, type_id: RIFTER,
          station_id: 1035466617946, bid: true, price: 400000, vol_entered: 2, vol_remaining: 2 } },
        { state: "filled", owner_id: PLAYER, row: { order_id: 3, type_id: TRIT, price: 1, vol_remaining: 0 } },
        { state: "open", owner_id: OTHER, row: { order_id: 4, type_id: TRIT, price: 1, vol_remaining: 1 } },
      ]);
    }, syncOpenBuyEscrowRecords: () => assert.fail("a write") };
    const r = await readMarketOrdersFrom({ marketDaemon: daemon }, PLAYER, { maxRows: 8, timeoutMs: 3000,
      setTimeoutFn: () => {} });
    assert.deepStrictEqual(asked, [["GetCharOrders", { owner_id: PLAYER, is_corp: false }]]);
    assert.deepStrictEqual(r, { ok: true, more: 0, orders: [
      { side: "buy", typeId: RIFTER, priceIsk: 400000, remaining: 2, total: 2, stationId: 1035466617946, orderId: 2 },
      { side: "sell", typeId: TRIT, priceIsk: 5.25, remaining: 400, total: 1000, stationId: STATION, orderId: 1 }] },
    "thinking: orderId is additive");
    const S2 = settings();
    const tool = await toolOf("market_orders").run({ playerId: PLAYER, S: S2, nowMs: () => NOW,
      deps: depsOf({ marketOrders: (id, o) => readMarketOrdersFrom({ marketDaemon: daemon }, id,
        { ...o, setTimeoutFn: () => {} }) }, S2) });
    assert.deepStrictEqual(tool.data.orders, [
      { side: "buy", item: "Rifter", priceIsk: 400000, remaining: 2, total: 2, station: "structure" },
      { side: "sell", item: "Tritanium", priceIsk: 5.25, remaining: 400, total: 1000, station: "Jita IV - Moon 4" }]);
    assert.deepStrictEqual(await depsOf(null, S2).marketOrders(PLAYER, 8), { ok: false, reason: "SEAM_UNAVAILABLE" });
  });

  test("DR34 industry_jobs: a foreign ownerID dropped, ready from endDate / nowMs, a paused job never ready", () => {
    const jobs = [
      { jobID: 1, ownerID: PLAYER, activityID: 1, productTypeID: RIFTER, runs: 3, status: 1,
        endDate: fileTime(NOW + 30 * MINUTE) },
      { jobID: 2, ownerID: PLAYER, activityID: 8, productTypeID: 0, runs: 1, status: 1,
        endDate: fileTime(NOW - MINUTE) },
      { jobID: 3, ownerID: OTHER, activityID: 1, productTypeID: RIFTER, runs: 9, status: 1, endDate: fileTime(NOW) },
      { jobID: 4, ownerID: PLAYER, activityID: 4, productTypeID: null, runs: 1, status: 2,
        endDate: fileTime(NOW - HOUR) },
    ];
    const industry = { listJobsByOwner: (id, all) => {
      assert.deepStrictEqual([id, all], [PLAYER, false]);
      return jobs.map((j) => ({ ...j }));
    } };
    const r = readIndustryJobsFrom({ industry }, PLAYER, { maxRows: 8, nowMs: NOW });
    assert.deepStrictEqual(r, { ok: true, more: 0, jobs: [
      { activityId: 4, productTypeId: null, runs: 1, endsInMinutes: 0, ready: false, jobId: 4, endAtMs: NOW - HOUR },
      { activityId: 8, productTypeId: null, runs: 1, endsInMinutes: 0, ready: true, jobId: 2, endAtMs: NOW - MINUTE },
      { activityId: 1, productTypeId: RIFTER, runs: 3, endsInMinutes: 30, ready: false, jobId: 1,
        endAtMs: NOW + 30 * MINUTE }] }, "job 3 is foreign; thinking: jobId / endAtMs are additive");
    assert.strictEqual(readIndustryJobsFrom({ industry }, PLAYER, { maxRows: 1, nowMs: NOW }).more, 2);
    const tool = toolOf("industry_jobs").run({ playerId: PLAYER, S: settings(), nowMs: () => NOW,
      deps: depsOf({ industryJobs: (id, o) => readIndustryJobsFrom({ industry }, id, o) }, settings()) });
    assert.deepStrictEqual(tool.data.jobs[2], { activity: "manufacturing", product: "Rifter", runs: 3,
      endsInMinutes: 30, ready: false });
    assert.strictEqual(tool.data.jobs[0].activity, "material efficiency research");
  });

  test("DR35 vendor facts of the seams; the cores never name a write-capable reader; GAME_MODULES", () => {
    const src = (rel) => fs.readFileSync(path.join(SERVER_SRC, rel), "utf8").replace(/\r\n/g, "\n");
    const from = (text, head, len) => {
      const at = text.indexOf(head);
      assert.ok(at >= 0, head);
      return text.slice(at, at + len);
    };
    const km = src("services/killmail/killmailState.js");
    for (const n of ["getKillmailProjectionStats", "listKillmailsForCharacter"]) assert.ok(km.includes(`\n  ${n},\n`), n);
    assert.ok(from(km, "\nfunction getKillmailProjectionStats() {", 200).includes("ready: Boolean(killmailIndexes),"));
    assert.ok(from(km, "\nfunction ensureKillmailIndexes() {", 200).includes("ensureKillmailTableInitialized()"),
      "a dirty index rebuild initialises (writes) the table: the gate");
    assert.ok(from(km, "\nfunction listKillmailsForCharacter(", 400).includes("ensureKillmailIndexes()"));
    const prep = src("services/killmail/killmailPreparationTasks.js");
    for (const f of ["    characterID: normalizePositiveInteger(entry.characterID, null),",
      "    shipTypeID: normalizePositiveInteger(entry.shipTypeID, null),",
      "    killTime: normalizeFiletimeString(record.killTime, options.fallbackKillTime),",
      "    victimShipTypeID: normalizePositiveInteger(record.victimShipTypeID, null),",
      "    attackers: normalizedAttackers,"]) assert.ok(prep.includes(f), f);

    const mission = src("services/agent/missionRuntimeState.js");
    assert.ok(from(mission, "\nfunction getCharacterStateSnapshot(", 200).includes("ensureCharacterState(state, "),
      "the snapshot reader normalises: never used");
    assert.ok(from(mission, "\nfunction getMutableState() {", 1200).includes("repo.write(MISSION_RUNTIME_TABLE"));
    for (const f of ['const MISSION_RUNTIME_TABLE = "missionRuntimeState";', "    charactersByID: {},",
      "    missionsByAgentID: {},", "    missionTitle: normalizeText(record.missionTitle,",
      "    runtimeStatus: normalizeText(record.runtimeStatus,", "    expiresAtFileTime: normalizeText(",
      "    missionSystemID: toPositiveInteger(record.missionSystemID, 0) || null,",
      "    objectiveCompleted: toBoolean(record.objectiveCompleted, false),"]) assert.ok(mission.includes(f), f);
    const store = src("gameStore/index.js");
    assert.ok(from(store, "\nfunction read(table, pth) {", 1200).includes('errorMsg: "ENTRY_NOT_FOUND"'));

    const market = src("services/market/marketProxyService.js");
    const handler = from(market, "  async Handle_GetCharOrders(args, session) {", 1200);
    assert.ok(handler.includes('marketDaemonClient.call("GetCharOrders", {') && handler.includes("owner_id: characterID,")
      && handler.includes("is_corp: false,") && handler.includes("syncOpenBuyEscrowRecords(openOrders);"),
    "the proxy handler syncs the escrow records (a write): never used");
    const row = from(market, "\nfunction mapOwnerOrderRow(ownerOrder) {", 1600);
    for (const f of ["ownerOrder && ownerOrder.row ? ownerOrder.row : {}", "ownerOrder && ownerOrder.state",
      "ownerOrder && ownerOrder.owner_id", "Number(nestedRow.type_id)", "Number(nestedRow.station_id)",
      "nestedRow.bid ? 1 : 0", "roundIsk(nestedRow.price)", "Number(nestedRow.vol_entered)",
      "Number(nestedRow.vol_remaining)"]) assert.ok(row.includes(f), f);

    const ind = src("services/industry/industryRuntimeState.js");
    assert.ok(ind.includes("\n  listJobsByOwner,\n") && ind.includes("\nfunction listJobsByOwner(ownerID, includeCompleted = false) {"));
    for (const f of ["    endDate: (\n      nowFiletime +", "    productTypeID: quote.productTypeID,", "    runs: quote.runs,",
      "    activityID: quote.activityID,"]) assert.ok(ind.includes(f), f);
    const consts = src("services/industry/industryConstants.js");
    for (const f of ["  PAUSED: 2,", "  READY: 3,", "  MANUFACTURING: 1,", "  RESEARCH_MATERIAL: 4,", "  REACTION: 9,"]) {
      assert.ok(consts.includes(f), f);
    }
    assert.ok(src("services/structure/structureConstants.js").includes("const NEXT_ASSET_WRAP_ID_START = 1040000000000;"));
    assert.ok(src("services/account/walletState.js").includes("const MAX_JOURNAL_ENTRIES = 100;"));

    const own = fs.readFileSync(path.join(MOD_DIR, "lib", "adapter", "shipAiDbRead.js"), "utf8").split("\n")
      .filter((l) => !l.trimStart().startsWith("*"));
    for (const banned of ["Handle_GetCharOrders", "syncOpenBuyEscrowRecords", "getCharacterStateSnapshot",
      "getStateSnapshot", "ensureCharacterState", "KillmailTableInitialized", "getAllKillmailRecords"]) {
      assert.ok(!own.some((l) => l.includes(banned)), banned);
    }
    const symsOf = (p) => (GAME_MODULES.find((e) => e.path === p) || { symbols: [] }).symbols
      .filter((s) => (s.consumers || []).includes("shipAiDb")).map((s) => s.name).sort();
    assert.deepStrictEqual(symsOf("services/killmail/killmailState"),
      ["getKillmailProjectionStats", "listKillmailsForCharacter"]);
    assert.deepStrictEqual(symsOf("gameStore/index"), ["read"]);
    assert.deepStrictEqual(symsOf("services/market/marketDaemonClient"), ["marketDaemonClient"]);
    assert.deepStrictEqual(symsOf("services/industry/industryRuntimeState"), ["listJobsByOwner"]);
  });
};
