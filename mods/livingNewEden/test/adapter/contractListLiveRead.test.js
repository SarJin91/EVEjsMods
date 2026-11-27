"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { listTaggedContractsFrom } = require("../../lib/adapter/tradeContracts");
const { createAdapter } = require("../../lib/adapter");
const { findServerSrcOnDisk } = require("../../lib/adapter/locator");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SERVER_SEARCH_MAX_DEPTH = 5;
const CORP = 987654321;
const CHAR = 90000001;

function row(id, over = {}) {
  return { contractID: id, issuerOwnerID: CORP, issuerID: 5, status: 0, reward: 1000 + id,
    description: `buy [LNE:off-${id}]`, issuerWallet: { kind: "corporation", ownerID: CORP, accountKey: 1000 }, ...over };
}

function fixtureTable() {
  return {
    _meta: { version: 1, nextContractID: 980000100 },
    980000030: row(980000030),
    980000010: row(980000010, { issuerOwnerID: CHAR, issuerWallet: undefined }),
    980000020: row(980000020, { status: 4 }),
    980000040: row(980000040, { issuerOwnerID: 1000125 }),
    980000050: row(980000050, { description: "no tag" }),
    980000060: row(980000060),
    980000070: null,
  };
}

function runtimeOver(table, calls) {
  return {
    TABLE: "contractRuntime",
    CONTRACT_STATUS: Object.freeze({ OUTSTANDING: 0, IN_PROGRESS: 1, FINISHED: 4 }),
    listContractRecords() {
      calls.list += 1;
      return Object.entries(table).filter(([key, value]) => key !== "_meta" && value && typeof value === "object")
        .map(([, value]) => JSON.parse(JSON.stringify(value)));
    },
  };
}

function storeOver(table, over = {}) {
  return { read: (t, p) => (t === "contractRuntime" && p === "/" ? { success: true, errorMsg: null, data: table } : null),
    ...over };
}

module.exports = ({ test }) => {
  test("CL1 contract list live read: parity with listContractRecords (truncated, cursor), adapter only with liveRead", () => {
    const table = fixtureTable();
    const calls = { list: 0 };
    const cr = runtimeOver(table, calls);
    const store = storeOver(table);
    const specs = [{ ownerIds: [CHAR], corporationIds: [CORP], limit: 10 }, { corporationIds: [CORP], limit: 1 },
      { ownerIds: [CHAR], corporationIds: [CORP], limit: 2, afterContractId: 980000010 }];
    for (const spec of specs) {
      const vendor = listTaggedContractsFrom(cr, spec);
      const before = calls.list;
      const live = listTaggedContractsFrom(cr, spec, { gameStore: store });
      assert.strictEqual(calls.list, before, "no listContractRecords call on the live path");
      assert.deepStrictEqual(live, vendor, JSON.stringify(spec));
    }
    const all = listTaggedContractsFrom(cr, specs[0], { gameStore: store });
    assert.deepStrictEqual(all.contracts.map((c) => c.contractId), [980000010, 980000030, 980000060]);
    assert.strictEqual(listTaggedContractsFrom(cr, specs[1], { gameStore: store }).truncated, true);
    assert.deepStrictEqual(table, fixtureTable(), "the live rows are not written");

    const reads = [];
    const adapter = (() => {
      const SRC = path.join(path.sep, "x", "server", "src");
      const byAbs = {
        [path.join(SRC, "services/contracts/contractRuntimeState.js")]: cr,
        [path.join(SRC, "gameStore/index.js")]: storeOver(table, { read: (t, p) => {
          reads.push(`${t}${p}`);
          return { success: true, errorMsg: null, data: table };
        } }),
      };
      const a = createAdapter({ moduleApi: { _cache: {} }, existsSync: () => true, requireFn: (abs) => byAbs[abs] || {} });
      a.setServerSrc(SRC);
      a.markBooted();
      return a;
    })();
    const listBefore = calls.list;
    assert.deepStrictEqual(adapter.tradeListTaggedContracts(specs[0]), all);
    assert.deepStrictEqual([reads.length, calls.list - listBefore], [0, 1], "flag off: the vendor list");
    assert.deepStrictEqual(adapter.tradeListTaggedContracts({ ...specs[0], liveRead: true }), all);
    assert.deepStrictEqual([reads, calls.list - listBefore], [["contractRuntime/"], 1], "liveRead: the gameStore rows");
  });

  test("CL2 contract list live read: failed / bad read, no TABLE, throwing gameStore = the listContractRecords path", () => {
    const table = fixtureTable();
    const calls = { list: 0 };
    const cr = runtimeOver(table, calls);
    const spec = { ownerIds: [CHAR], corporationIds: [CORP], limit: 10 };
    const vendor = listTaggedContractsFrom(cr, spec);
    const bad = [
      storeOver(table, { read: () => ({ success: false, errorMsg: "TABLE_NOT_FOUND", data: null }) }),
      storeOver(table, { read: () => ({ success: true, data: [] }) }),
      storeOver(table, { read: () => ({ success: true, data: null }) }),
      storeOver(table, { read: () => { throw new Error("boom"); } }),
      {},
    ];
    for (const store of bad) {
      const before = calls.list;
      assert.deepStrictEqual(listTaggedContractsFrom(cr, spec, { gameStore: store }), vendor);
      assert.strictEqual(calls.list, before + 1, "fallback = listContractRecords");
    }
    const noTable = { ...cr, TABLE: undefined };
    const before = calls.list;
    assert.deepStrictEqual(listTaggedContractsFrom(noTable, spec, { gameStore: storeOver(table) }), vendor);
    assert.strictEqual(calls.list, before + 1);
    assert.deepStrictEqual(listTaggedContractsFrom({ ...cr, listContractRecords: () => { throw new Error("x"); } }, spec),
      { ok: false, reason: "SEAM_UNAVAILABLE" });
  });

  test("CL3 contract list live read vendor facts 261108.1: TABLE, ensureRuntimeTable live object, list clones rows", () => {
    const real = findServerSrcOnDisk(MOD_DIR, SERVER_SEARCH_MAX_DEPTH, fs.existsSync);
    assert.ok(real.ok, "EveJS server/src not found above the mod");
    const read = (...rel) => fs.readFileSync(path.join(real.srcDir, ...rel), "utf8").replace(/\r\n/g, "\n");
    const crs = read("services", "contracts", "contractRuntimeState.js");
    assert.ok(crs.includes("\nconst TABLE = \"contractRuntime\";\n"), "table name");
    assert.match(crs, /\nmodule\.exports = \{\n {2}TABLE,\n/, "TABLE exported");
    assert.ok(crs.includes("function ensureRuntimeTable() {\n  const result = repo.read(TABLE, \"/\");\n  const table =\n"
      + "    result.success && result.data && typeof result.data === \"object\"\n      ? result.data\n      : {};\n"),
      "ensureRuntimeTable uses the read data itself");
    assert.ok(crs.includes("function* iterateContractRecords() {\n  const table = ensureRuntimeTable();\n"
      + "  for (const key of Object.keys(table)) {\n    const value = table[key];\n"
      + "    if (key !== \"_meta\" && value && typeof value === \"object\") {\n      yield value;\n"), "rows of the live table");
    assert.ok(crs.includes("function listContractRecords(predicate = null) {\n  const records = [];\n"
      + "  for (const record of iterateContractRecords()) {\n    if (!predicate || predicate(record)) {\n"
      + "      records.push(cloneValue(record));\n"), "listContractRecords: filter, then a clone of every row");
    assert.ok(read("gameStore", "tableRepository.js").includes("read: (table, pathArg) => store.read(table, pathArg),"));
    assert.ok(read("gameStore", "index.js").includes("    if (segments.length === 0) {\n"
      + "      return { success: true, errorMsg: null, data: db };\n"), "the root read is the live cache object");
  });
};
