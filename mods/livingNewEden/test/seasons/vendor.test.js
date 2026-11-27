"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { GAME_MODULES } = require("../../lib/adapter/gameModules");
const { createAdapter } = require("../../lib/adapter");

const SERVER_SRC = path.resolve(__dirname, "..", "..", "..", "..", "server", "src");
const read = (rel) => fs.readFileSync(path.join(SERVER_SRC, rel), "utf8").replace(/\r\n/g, "\n");
const CONSUMER = "seasonRewards";

module.exports = ({ test }) => {
  test("R5 vendor facts of the reward legs; GAME_MODULES consumer seasonRewards; seasonRewardStation on fakes", () => {
    const items = read("services/inventory/itemStore.js");
    const grantAt = items.indexOf("function grantItemToOwnerLocationIdempotent(");
    assert.ok(grantAt >= 0, "grantItemToOwnerLocationIdempotent");
    assert.ok(items.slice(grantAt, grantAt + 800).includes("options.receiptKey"), "options.receiptKey");
    assert.ok(items.includes("function getIdempotentGrantReceipt("), "getIdempotentGrantReceipt");
    assert.ok(read("services/character/characterState.js").includes("function peekCharacterRecord("));
    assert.ok(read("space/worldData.js").includes("function getStationByID("));

    const want = [["services/inventory/itemStore", "grantItemToOwnerLocationIdempotent"],
      ["services/inventory/itemStore", "getIdempotentGrantReceipt"],
      ["services/character/characterState", "peekCharacterRecord"], ["space/worldData", "getStationByID"]];
    for (const [p, name] of want) {
      const entry = GAME_MODULES.find((e) => e.path === p);
      assert.ok(entry && entry.symbols.some((s) => s.name === name && s.consumers.includes(CONSUMER)), `${p}.${name}`);
    }

    const records = new Map([[1, { homeStationID: 60000001 }], [2, { homeStationID: 1035000000000 }], [3, {}]]);
    const stations = new Set([60000001, 60003760]);
    const fakes = {
      [path.join(SERVER_SRC, "services/character/characterState.js")]: { peekCharacterRecord: (id) => records.get(id) },
      [path.join(SERVER_SRC, "space/worldData.js")]: { getStationByID: (id) => (stations.has(id) ? { stationID: id }
        : null) },
    };
    const adapter = createAdapter({ moduleApi: { _cache: {} }, existsSync: () => true,
      requireFn: (abs) => fakes[abs] || {} });
    adapter.setServerSrc(SERVER_SRC);
    adapter.markBooted();
    assert.deepStrictEqual(adapter.seasonRewardStation(1, 60003760), { ok: true, stationId: 60000001, source: "HOME" });
    assert.deepStrictEqual(adapter.seasonRewardStation(2, 60003760),
      { ok: true, stationId: 60003760, source: "FALLBACK" }, "a structure home = the fallback");
    assert.deepStrictEqual(adapter.seasonRewardStation(3, 0), { ok: false, reason: "NO_STATION" });
    assert.deepStrictEqual(adapter.seasonRewardStation(9, 60003760), { ok: false, reason: "CHARACTER_NOT_FOUND" });
  });
};
