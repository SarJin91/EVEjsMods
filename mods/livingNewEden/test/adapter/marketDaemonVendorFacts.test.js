"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const SERVER_SRC = path.resolve(__dirname, "..", "..", "..", "..", "server", "src");

function readSource(rel) {
  return fs.readFileSync(path.join(SERVER_SRC, rel), "utf8").replace(/\r\n/g, "\n");
}

function bodyOf(source, name) {
  let start = source.indexOf(`\nfunction ${name}(`);
  if (start < 0) start = source.indexOf(`\nasync function ${name}(`);
  assert.ok(start >= 0, `function ${name} not found`);
  const next = source.slice(start + 1).search(/\n(async )?function /);
  return source.slice(start, next < 0 ? source.length : start + 1 + next);
}

function methodOf(source, signature) {
  const start = source.indexOf(`\n  ${signature}`);
  assert.ok(start >= 0, `method ${signature} not found`);
  const next = source.slice(start + 1).search(/\n {2}[A-Za-z_]+\(/);
  return source.slice(start, next < 0 ? source.length : start + 1 + next);
}

module.exports = ({ test, skip }) => {
  if (!fs.existsSync(SERVER_SRC)) {
    skip("MDF1-4 market daemon vendor facts", "server/src not found");
    return;
  }
  const client = () => readSource("services/market/marketDaemonClient.js");
  const proxy = () => readSource("services/market/marketProxyService.js");

  test("MDF1 vendor: annotateMarketDaemonError sets code / marketDaemonRequestSent / marketDaemonOutcomeUnknown", () => {
    const body = bodyOf(client(), "annotateMarketDaemonError");
    assert.match(body, /if \(details\.code\) annotated\.code = details\.code;/);
    assert.match(body, /annotated\.marketDaemonRequestSent = details\.requestSent === true;/);
    assert.match(body, /annotated\.marketDaemonOutcomeUnknown = details\.outcomeUnknown === true;/);
  });

  test("MDF2 vendor: call() rejects connect / compatibility failures as not sent, outcome known", () => {
    const body = methodOf(client(), "async call(");
    assert.match(body, /code: error && error\.code \|\| "MARKET_DAEMON_CONNECT_FAILED",\s*method,\s*requestSent: false,\s*outcomeUnknown: false,/);
    assert.match(body, /code: error && error\.code \|\| "MARKET_DAEMON_INCOMPATIBLE",\s*method,\s*requestSent: false,\s*outcomeUnknown: false,/);
    assert.match(body, /return this\._sendRequest\(method, params\);/);
  });

  test("MDF3 vendor: ok:false rejects REJECTED (outcome known); success resolves response.result; timeout/write/close unknown", () => {
    const src = client();
    const handle = methodOf(src, "_handleResponseLine(");
    assert.match(handle, /if \(response\.ok === false\) \{\s*pendingRequest\.reject\(/);
    assert.match(handle, /code: "MARKET_DAEMON_RPC_REJECTED",\s*method: pendingRequest\.method,\s*requestSent: true,\s*outcomeUnknown: false,/);
    assert.match(handle, /pendingRequest\.resolve\(\s*Object\.prototype\.hasOwnProperty\.call\(response, "result"\)\s*\? response\.result\s*: null,\s*\)/);
    const send = methodOf(src, "_sendRequest(");
    assert.match(send, /code: "MARKET_DAEMON_RPC_TIMEOUT",\s*method,\s*requestSent: true,\s*outcomeUnknown: true,/);
    assert.match(send, /"MARKET_DAEMON_RPC_WRITE_FAILED",\s*method,\s*requestSent: true,\s*outcomeUnknown: true,/);
    assert.match(send, /return Promise\.reject\(new Error\("market daemon RPC connection is not ready"\)\);/);
    assert.match(methodOf(src, "_failPendingRequests("), /"MARKET_DAEMON_RPC_CONNECTION_CLOSED",\s*method: pendingRequest\.method,\s*requestSent: true,\s*outcomeUnknown: true,/);
  });

  test("MDF4 vendor: missing-order text, unavailable phrases, definitive rejection (marketProxyService)", () => {
    const src = proxy();
    assert.match(bodyOf(src, "isMarketDaemonMissingOrderError"),
      /===\s*`order \$\{normalizeOrderId\(orderID\)\} not found`;/);
    assert.match(bodyOf(src, "normalizeOrderId"), /return normalizeBigInt\(value, 0n\)\.toString\(\);/);
    const unavailable = bodyOf(src, "isMarketDaemonUnavailableError");
    assert.match(unavailable, /if \(error && error\.marketDaemonOutcomeUnknown === true\) \{\s*return true;/);
    for (const phrase of [
      "market daemon rpc connect timeout", "market daemon rpc socket closed before connect",
      "market daemon rpc connection is not ready", "market daemon rpc connection closed",
      "market daemon rpc request timed out", "econnrefused", "econnreset", "enetunreach", "ehostunreach",
    ]) assert.ok(unavailable.includes(`message.includes("${phrase}")`), phrase);
    assert.match(bodyOf(src, "isDefinitiveMarketDaemonRejection"),
      /error\.code === "MARKET_DAEMON_RPC_REJECTED" &&\s*error\.marketDaemonOutcomeUnknown === false,/);
    assert.match(src, /if \(String\(cancelResponse && cancelResponse\.state \|\| ""\) === "cancelled"\) \{/);
  });

  test("MDF5 vendor: a buy order of an NPC corporation fills like a seeded bid (items voided); drift; facade cached", () => {
    const { parseMarketFillRule } = require("../../lib/adapter/tradeMarket");
    const { createAdapter } = require("../../lib/adapter/index");
    const market = proxy();
    const corp = readSource("services/corporation/corporationState.js");
    const ok = { ok: true, mode: "VENDOR_VOID", npcCorpMin: 1000000, npcCorpMax: 2000000 };
    assert.deepStrictEqual(parseMarketFillRule(market, corp), ok);
    const drift = (detail) => ({ ok: false, reason: "MARKET_FILL_RULE_DRIFT", detail });
    const ruleLine = "isSeedBuyOrder = isNpcCorporationID(playerBuyOrder && playerBuyOrder.owner_id);";
    assert.ok(market.includes(ruleLine));
    assert.deepStrictEqual(parseMarketFillRule(market.replace(ruleLine, "isSeedBuyOrder = false;"), corp), drift("rule"));
    const saga = bodyOf(market, "executeSeedBuyFillSagaUnlocked");
    assert.ok(saga.includes("consumeSeedMarketInventoryQuantity("));
    assert.deepStrictEqual(parseMarketFillRule(market.replace(saga,
      saga.split("consumeSeedMarketInventoryQuantity(").join("keepSeedMarketInventoryQuantity(")), corp), drift("consume"));
    assert.deepStrictEqual(parseMarketFillRule(market, corp.replace("numericID < 2000000;", "numericID < limit;")),
      drift("range"));
    const importLine = "const { isNpcCorporationID } = require(";
    assert.ok(market.includes(importLine));
    const reformatted = market
      .replace(importLine, "const {\n  isNpcCorporationID,\n  getCorporationRecord,\n} = require (")
      .replace(ruleLine, "isSeedBuyOrder=isNpcCorporationID( playerBuyOrder&&playerBuyOrder.owner_id );");
    assert.deepStrictEqual(parseMarketFillRule(reformatted, corp), ok);
    assert.ok(corp.includes("numericID < 2000000;"));
    assert.deepStrictEqual(parseMarketFillRule(market, corp.replace("numericID < 2000000;", "numericID<2000000 ;")), ok);
    assert.deepStrictEqual(parseMarketFillRule(market.replace(importLine, "const { getCorporationRecord } = require("), corp),
      drift("import"));
    let reads = 0;
    const adapter = createAdapter({ readFileSync: (p, enc) => { reads += 1; return fs.readFileSync(p, enc); } });
    assert.deepStrictEqual(adapter.tradeMarketFillMode(), { ok: false, reason: "SERVER_SRC_UNKNOWN" });
    adapter.setServerSrc(SERVER_SRC);
    assert.deepStrictEqual(adapter.tradeMarketFillMode(), ok);
    adapter.tradeMarketFillMode();
    assert.strictEqual(reads, 2, "cached");
    const lines = [];
    const broken = createAdapter({ readFileSync: () => { throw new Error("EACCES"); }, logger: { log: (l) => lines.push(l) } });
    broken.setServerSrc(SERVER_SRC);
    assert.deepStrictEqual(broken.tradeMarketFillMode(), { ok: false, reason: "SOURCE_UNREADABLE" });
    broken.tradeMarketFillMode();
    assert.strictEqual(lines.filter((l) => l.includes("market fill rule")).length, 1, "logged once");
  });

  const DAEMON_STATE = path.resolve(SERVER_SRC, "..", "..", "externalservices", "market-server", "src", "state.rs");
  test("HB1-HB3 vendor: a ship sells to a buy order (no ship guard, singleton = 1), fitting voided with it, no daemon category check", () => {
    const market = proxy();
    for (const name of ["resolveSellItemCustodySource", "matchBuyOrdersForSeller"]) {
      const body = bodyOf(market, name);
      for (const word of ["categoryID", "isShip", "repackag"]) assert.ok(!body.includes(word), `${name}: ${word}`);
    }
    assert.match(market, /normalizeInteger\(sourceItem && sourceItem\.singleton, 0\) === 1\s*\?\s*1\s*:\s*normalizePositiveInteger\(sourceItem && sourceItem\.stacksize, 0\);/);
    const consume = bodyOf(readSource("services/inventory/marketItemCustody.js"), "consumeSeedItem");
    assert.match(consume, /return itemCustody\.transfer\(\{[\s\S]*to: itemCustody\.custodyRef\.void\(\),/);
    assert.ok(!consume.includes("removeContents"), "consumeSeedItem: no removeContents option");
    assert.ok(readSource("services/inventory/itemCustody.js").includes("removeContents !== false"));
    if (!fs.existsSync(DAEMON_STATE)) return;
    const rs = fs.readFileSync(DAEMON_STATE, "utf8").replace(/\r\n/g, "\n");
    const start = rs.search(/\n\s*(pub(\([^)]*\))? )?fn insert_order\b/);
    assert.ok(start >= 0, "insert_order not found");
    const next = rs.slice(start + 1).search(/\n\s*(pub(\([^)]*\))? )?fn /);
    const insert = rs.slice(start, next < 0 ? rs.length : start + 1 + next);
    assert.ok(!/category/i.test(insert), "insert_order: no category check");
  });
  if (!fs.existsSync(DAEMON_STATE)) skip("HB3 market daemon insert_order", "market daemon sources absent (externalservices/market-server)");
};
