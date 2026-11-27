"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { decideProjection } = require("../../lib/adapter/sovProjection");
const { readPlayerSovFrom } = require("../../lib/adapter/playerSov");
const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
const { FACADE_METHODS, createUnavailablePlayerSov } = require("../../lib/world/playerSov");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SYS = 30004000;
const VIRTUAL = 99500001;
const OTHER_VIRTUAL = 99500002;
const PLAYER = 99000001;

module.exports = ({ test }) => {
  test("PS4 decideProjection: a faction controller over a neutral player hub -> PLAYER_CLAIM_PROTECTED for GAIN and "
    + "TRANSFER; without playerHub GAIN / TRANSFER as before", () => {
    const mod = { controllerFactionId: 500019, occupationState: "OCCUPIED", phaseSeq: 3, capturedAt: 1 };
    const identity = { allianceId: VIRTUAL, executorCorpId: 98500001 };
    const virtualClaim = { allianceID: OTHER_VIRTUAL, corporationID: 98500002, isVirtualAlliance: true };
    const decide = (currentClaim, playerHub) => {
      const d = decideProjection(SYS, mod, identity, { isClaimable: true, currentClaim,
        ...(playerHub === undefined ? {} : { playerHub }) });
      return [d.action, d.reason, d.skip];
    };
    assert.deepStrictEqual({
      gainHub: decide(null, true),
      transferHub: decide(virtualClaim, true),
      gain: decide(null, false),
      gainOld: decide(null),
      transfer: decide(virtualClaim, false),
    }, {
      gainHub: ["NONE", "PLAYER_CLAIM_PROTECTED", true],
      transferHub: ["NONE", "PLAYER_CLAIM_PROTECTED", true],
      gain: ["GAIN", "CONTROLLER_GAINED", false],
      gainOld: ["GAIN", "CONTROLLER_GAINED", false],
      transfer: ["TRANSFER", "CONTROLLER_TRANSFER", false],
    });
  });

  test("PS5 vendor facts (source text) + readPlayerSovFrom primitives + facade methods of the real adapter and of "
    + "the stub (rule unknown-method)", () => {
    const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
    assert.ok(found.ok, JSON.stringify(found));
    const read = (...p) => fs.readFileSync(path.join(found.srcDir, ...p), "utf8").replace(/\r\n/g, "\n");
    const state = read("services", "sovereignty", "sovState.js");
    assert.ok(/^function listAllSovereigntySystemStates\(\)/m.test(state), "listAllSovereigntySystemStates");
    assert.ok(/^ {2}listAllSovereigntySystemStates,$/m.test(state), "exported");
    assert.ok(state.includes("devFlags.sovereigntyNeutralHub === true"), "normalizer keeps devFlags");
    const deploy = read("services", "sovereignty", "sovPlayerDeployment.js");
    assert.ok(deploy.includes("sovereigntyDeployedByAllianceID"), "deployedBy alliance");
    assert.ok(deploy.includes("sovereigntyNeutralHub: true"), "neutral hub flag");
    assert.ok(read("services", "sovereignty", "sovGmState.js")
      .includes("existing ? normalizePositiveInteger(existing.itemID"), "anchor reuses the hub itemID");
    assert.ok(read("services", "sovereignty", "sovConstants.js").includes("TYPE_INFRASTRUCTURE_HUB = 32458"));

    const hub = (itemID, flags) => ({ itemID, typeID: 32458, devFlags: flags });
    const vendor = { sovState: { listAllSovereigntySystemStates: () => [
      { solarSystemID: 1, allianceID: PLAYER, corporationID: 98000001, claimStructureID: 11, structures: [hub(11, {})] },
      { solarSystemID: 2, allianceID: VIRTUAL, corporationID: 98500001, claimStructureID: 12, structures: [] },
      { solarSystemID: 3, allianceID: null, structures: [hub(13, { sovereigntyNeutralHub: true,
        sovereigntyCaptured: false, sovereigntyDeployedByAllianceID: PLAYER,
        sovereigntyDeployedByCorporationID: 98000001 })] },
      { solarSystemID: 4, allianceID: null, structures: [hub(14, { sovereigntyNeutralHub: true,
        sovereigntyDeployedByAllianceID: VIRTUAL, sovereigntyDeployedByCorporationID: 98500001 })] },
      { solarSystemID: 5, allianceID: null, structures: [] },
    ] } };
    const r = readPlayerSovFrom(vendor, { isVirtualAlliance: (id) => id === VIRTUAL });
    assert.deepStrictEqual(r, { ok: true, scanned: 5, rows: [
      { systemId: 1, allianceId: PLAYER, corpId: 98000001, hubItemId: 11, neutralHub: null, virtualClaim: false },
      { systemId: 2, allianceId: null, corpId: null, hubItemId: null, neutralHub: null, virtualClaim: true },
      { systemId: 3, allianceId: null, corpId: null, hubItemId: null,
        neutralHub: { itemId: 13, allianceId: PLAYER, corpId: 98000001 }, virtualClaim: false },
    ] });
    assert.strictEqual(readPlayerSovFrom({}, {}).reason, "PLAYER_SOV_SEAM_UNAVAILABLE");

    const { createAdapter } = require("../../lib/adapter");
    const adapter = createAdapter({ moduleApi: { _cache: {} } });
    for (const name of ["readPlayerSov", "releasePlayerSov", "capturePlayerSov", "readSovereigntyTableUpdatedAt",
      "playerSovSeams"]) {
      assert.strictEqual(typeof adapter[name], "function", name);
    }
    assert.strictEqual(adapter.readPlayerSov({}).reason, "PLAYER_SOV_SEAM_UNAVAILABLE");
    const stub = createUnavailablePlayerSov("disabled_by_config");
    assert.deepStrictEqual(Object.keys(stub), [...FACADE_METHODS]);
    assert.strictEqual(stub.readClaimInTx({}, SYS).reason, "PLAYER_SOV_UNAVAILABLE");
  });
};
