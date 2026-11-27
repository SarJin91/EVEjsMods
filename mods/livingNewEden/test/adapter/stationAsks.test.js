"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { readStationAsksFrom } = require("../../lib/adapter/stationAsks");
const { createAdapter } = require("../../lib/adapter");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const PROXY = path.join(REPO_ROOT, "server", "src", "services", "market", "marketProxyService.js");
const RPC = path.join(REPO_ROOT, "externalservices", "market-server", "src", "rpc.rs");
const STATE = path.join(REPO_ROOT, "externalservices", "market-server", "src", "state.rs");
const STATION = 60003760;

const row = (typeId, price, qty = 100) => ({ type_id: typeId, best_ask_price: price, total_ask_quantity: qty,
  best_ask_station_id: STATION, best_bid_price: null });

module.exports = ({ test, skip }) => {
  test("SG1 readStationAsksFrom: requested types only (milli), no row / null price -> null, REJECTED / TRANSPORT / "
    + "SPEC_INVALID, never rejects; the real facade returns readStationAsks", async () => {
    const calls = [];
    const md = { call: async (method, params) => {
      calls.push([method, params]);
      return [row(34, 5.25), row(35, null), row(99, 1)];
    } };
    const r = await readStationAsksFrom(md, { stationId: STATION, typeIds: [34, 35, 36] });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.deepStrictEqual([...r.asks], [[34, 5250], [35, null], [36, null]]);
    assert.deepStrictEqual(calls, [["GetStationAsks", { station_id: STATION }]]);

    const failing = (err) => ({ call: async () => { throw err; } });
    const rej = Object.assign(new Error("no such station"), { code: "MARKET_DAEMON_RPC_REJECTED" });
    assert.deepStrictEqual((await readStationAsksFrom(failing(rej), { stationId: STATION, typeIds: [34] })).reason,
      "REJECTED");
    const down = await readStationAsksFrom(failing(new Error("RPC connection is not ready")),
      { stationId: STATION, typeIds: [34] });
    assert.deepStrictEqual([down.ok, down.reason, down.detail], [false, "TRANSPORT", "RPC connection is not ready"]);
    const before = calls.length;
    for (const spec of [null, { stationId: 0, typeIds: [34] }, { stationId: STATION, typeIds: [] },
      { stationId: STATION, typeIds: [34, 34] }, { stationId: STATION, typeIds: [-1] },
      { stationId: STATION, typeIds: Array.from({ length: 65 }, (_, i) => i + 1) }]) {
      assert.strictEqual((await readStationAsksFrom(md, spec)).reason, "SPEC_INVALID", JSON.stringify(spec));
    }
    assert.strictEqual(calls.length, before, "no call on a bad spec");
    assert.strictEqual((await readStationAsksFrom(null, { stationId: STATION, typeIds: [34] })).reason,
      "SEAM_UNAVAILABLE");

    const adapter = createAdapter({ moduleApi: { _cache: {} } });
    assert.strictEqual(typeof adapter.readStationAsks, "function");
    const blind = adapter.readStationAsks({ stationId: STATION, typeIds: [34] });
    assert.ok(blind instanceof Promise);
    assert.strictEqual((await blind).reason, "SEAM_UNAVAILABLE");
  });

  const daemon = fs.existsSync(RPC) && fs.existsSync(STATE);
  (daemon ? test : (name) => skip(name, "market daemon sources absent (externalservices/market-server)"))(
    "SG2 vendor facts: marketProxyService calls GetStationAsks {station_id}; rpc.rs branch; summary rows read "
      + "seed_stock", () => {
      const proxy = fs.readFileSync(PROXY, "utf8").replace(/\r\n/g, "\n");
      assert.ok(/marketDaemonClient\.call\("GetStationAsks", \{\s*station_id: stationID,?\s*\}\)/.test(proxy),
        "marketProxyService GetStationAsks call");
      const rpc = fs.readFileSync(RPC, "utf8");
      assert.ok(rpc.includes("\"GetStationAsks\" =>"), "rpc.rs branch");
      const state = fs.readFileSync(STATE, "utf8").replace(/\r\n/g, "\n");
      const at = state.indexOf("fn query_station_summary_rows");
      assert.ok(at >= 0, "query_station_summary_rows");
      assert.ok(state.slice(at, at + 4000).includes("FROM seed_stock"), "the summary reads the seed stock");
    });
};
