"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const CP = require("../../lib/world/devIndices/clientProjection");
const DC = require("../../lib/adapter/devIndexClient");

const SRC = path.resolve(__dirname, "..", "..", "..", "..", "server", "src");
const K = Object.freeze({ levelWidth: 9600000, militaryAttr: 1583, industrialAttr: 1584 });
const P = Object.freeze({ levelWidth: 1000, clientMaxSystems: 2 });

const readSrc = (rel) => fs.readFileSync(path.join(SRC, `${rel}.js`), "utf8");
const exportsBlock = (text) => {
  const m = /^module\.exports = \{([\s\S]*?)^\};/m.exec(text.replace(/\r\n/g, "\n"));
  return m ? m[1].split(",").map((s) => s.trim()).filter(Boolean) : [];
};

module.exports = ({ test, skip }) => {
  test("DI19 client projection: scalePoints, projectSystem, rankRows, mergeAll", () => {
    assert.strictEqual(CP.scalePoints(3120, { levelWidth: 1000 }, { levelWidth: 9600000 }), 29952000);
    assert.strictEqual(Math.floor(29952000 / 9600000), 3, "client level 3");
    assert.strictEqual(CP.scalePoints(9000, P, K), 6 * 9600000 - 1, "clamp below 6 W");
    assert.strictEqual(CP.scalePoints(-5, P, K), 0);

    const vendorIdx = { 1583: { points: 0, increasing: false }, 1584: { points: 0, increasing: false },
      1615: { points: 864000, increasing: false } };
    const out = CP.projectSystem({ milPoints: 3120, indPoints: 1040, trend: { mil: 1, ind: -1 } }, vendorIdx, P, K);
    assert.deepStrictEqual(out, { 1583: { points: 29952000, increasing: true },
      1584: { points: 9984000, increasing: false }, 1615: { points: 864000, increasing: false } });
    assert.strictEqual(vendorIdx[1583].points, 0, "the vendor object is not touched");
    assert.strictEqual(CP.projectSystem({ milPoints: 0, indPoints: 0, trend: { mil: 0, ind: 0 } }, vendorIdx, P, K), null);
    assert.strictEqual(CP.projectSystem(null, vendorIdx, P, K), null);

    const ranked = CP.rankRows([{ systemId: 5, mil: 1000, ind: 0 }, { systemId: 3, mil: 500, ind: 500 },
      { systemId: 9, mil: 3000, ind: 0 }, { systemId: 7, mil: 0, ind: 0 }, { systemId: 2, mil: 4000, ind: 1000 }]);
    assert.deepStrictEqual(ranked.map((r) => r.systemId), [2, 9, 3, 5]);
    const vendor = [{ solarSystemID: 1, militaryPoints: 7, industrialPoints: 8, claimedFor: 30 },
      { solarSystemID: 3, militaryPoints: 1, industrialPoints: 1, claimedFor: 4 },
      { solarSystemID: 9, militaryPoints: 0, industrialPoints: 0, claimedFor: 0 }];
    assert.deepStrictEqual(CP.mergeAll(vendor, new Set([2]), ranked, P, K), [
      { solarSystemID: 1, militaryPoints: 7, industrialPoints: 8, claimedFor: 30 },
      { solarSystemID: 3, militaryPoints: 4800000, industrialPoints: 4800000, claimedFor: 4 },
      { solarSystemID: 9, militaryPoints: 28800000, industrialPoints: 0, claimedFor: 0 }]);
    assert.deepStrictEqual(CP.mergeAll(vendor, new Set(), ranked, P, K).map((r) => [r.solarSystemID, r.claimedFor]),
      [[1, 30], [2, 0], [3, 4], [9, 0]]);
    assert.strictEqual(CP.mergeAll(vendor, new Set(), ranked, { ...P, clientMaxSystems: 0 }, K), null);
    assert.strictEqual(CP.mergeAll(vendor, new Set(), [], P, K), null);
  });

  if (!fs.existsSync(path.join(SRC, `${DC.SERVICE_PATH}.js`))) {
    skip("DI20 dev index client vendor facts", "server/src not found above the mod");
  } else {
    test("DI20 vendor facts: handlers, exports, SHA-1 drift, constants", () => {
      const service = readSrc(DC.SERVICE_PATH);
      const methods = [...service.replace(/\r\n/g, "\n").matchAll(/^ {2}(Handle_\w+)\(/gm)].map((m) => m[1]);
      assert.deepStrictEqual(methods, ["Handle_GetDevelopmentIndicesForSystem", "Handle_GetAllDevelopmentIndices"]);
      assert.ok(service.includes("module.exports = DevIndexManagerService;"));
      const texts = { service, payloads: readSrc(DC.PAYLOADS_PATH), state: readSrc(DC.STATE_PATH),
        constants: readSrc(DC.CONSTANTS_PATH) };
      assert.strictEqual(DC.driftDetail(texts), null);
      const changed = service.replace("GetAllDevelopmentIndices called", "GetAllDevelopmentIndices Called");
      assert.notStrictEqual(changed, service);
      assert.strictEqual(DC.driftDetail({ ...texts, service: changed }),
        "services/map/devIndexManagerService.js:Handle_GetAllDevelopmentIndices");
      assert.strictEqual(DC.driftDetail({ ...texts, state: null }), "services/sovereignty/sovState.js:missing");
      assert.ok(texts.constants.includes("const DEV_INDEX_LEVEL_WIDTH = 100000 * 96;"));
      const constExports = exportsBlock(texts.constants);
      for (const n of ["DEV_INDEX_LEVEL_WIDTH", "ATTRIBUTE_DEV_INDEX_MILITARY", "ATTRIBUTE_DEV_INDEX_INDUSTRIAL"]) {
        assert.ok(constExports.includes(n), n);
      }
      const stateExports = exportsBlock(texts.state);
      for (const n of ["getSystemState", "getDevelopmentIndicesForSystem", "listAllDevelopmentIndices",
        "listAllAllianceSystems"]) assert.ok(stateExports.includes(n), n);
      const payloadExports = exportsBlock(texts.payloads);
      for (const n of ["buildDevelopmentIndicesForSystemPayload", "buildAllDevelopmentIndicesPayload"]) {
        assert.ok(payloadExports.includes(n), n);
      }
    });
  }

  test("DI20 wrappers on a fake class: claim, projection, fail-open, uninstall", () => {
    class Fake {
      Handle_GetDevelopmentIndicesForSystem() { return "vendor-system"; }
      Handle_GetAllDevelopmentIndices() { return "vendor-all"; }
    }
    const originals = DC.METHODS.map((m) => Fake.prototype[m]);
    const vendor = {
      getSystemState: (id) => (id === 2 ? { allianceID: 99000001 } : { allianceID: 0 }),
      getDevelopmentIndicesForSystem: () => ({ 1583: { points: 0, increasing: false },
        1584: { points: 0, increasing: false }, 1615: { points: 0, increasing: false } }),
      listAllDevelopmentIndices: () => [{ solarSystemID: 2, militaryPoints: 1, industrialPoints: 1, claimedFor: 5 }],
      listAllAllianceSystems: () => [{ solarSystemID: 2, allianceID: 99000001 }],
      buildSystemPayload: (out) => ({ built: out }),
      buildAllPayload: (recs) => ({ all: recs }),
    };
    let boom = false;
    const levels = { milPoints: 3120, indPoints: 0, trend: { mil: 1, ind: 0 } };
    const provider = {
      projectSystem: (id, idx, k) => {
        if (boom) throw new Error("boom");
        return CP.projectSystem(levels, idx, P, k);
      },
      projectAll: (v, claimed, k) => CP.mergeAll(v, claimed, CP.rankRows([{ systemId: 4, mil: 1000, ind: 0 }]), P, k),
    };
    const events = [];
    const before = DC.devIndexClientStatus();
    assert.deepStrictEqual(DC.installWrappers(Fake, provider, vendor, K, (n) => events.push(n)), { ok: true });
    try {
      assert.strictEqual(DC.installWrappers(Fake, provider, vendor, K).reason, "HOOK_ALREADY_INSTALLED");
      const svc = new Fake();
      assert.strictEqual(svc.Handle_GetDevelopmentIndicesForSystem([2], {}), "vendor-system", "claimed -> vendor");
      const own = svc.Handle_GetDevelopmentIndicesForSystem([], { solarsystemid2: 30000142 });
      assert.deepStrictEqual(own.built[1583], { points: 29952000, increasing: true });
      assert.deepStrictEqual(own.built[1615], { points: 0, increasing: false });
      boom = true;
      assert.strictEqual(svc.Handle_GetDevelopmentIndicesForSystem([5], {}), "vendor-system", "throw -> vendor");
      const all = svc.Handle_GetAllDevelopmentIndices([], {});
      assert.deepStrictEqual(all.all.map((r) => [r.solarSystemID, r.militaryPoints, r.claimedFor]),
        [[2, 1, 5], [4, 9600000, 0]]);
      assert.deepStrictEqual(events, ["claimed", "served", "failed", "served"]);
      const s = DC.devIndexClientStatus();
      assert.deepStrictEqual([s.state, s.served - before.served, s.claimed - before.claimed, s.failed - before.failed],
        ["active", 2, 1, 1]);
    } finally {
      assert.deepStrictEqual(DC.uninstallDevIndexClient(), { ok: true });
    }
    assert.deepStrictEqual(DC.METHODS.map((m) => Fake.prototype[m]), originals, "uninstall restores the methods");
    assert.strictEqual(DC.devIndexClientStatus().state, "off");
    const r = DC.installDevIndexClient(Fake, provider, { texts: { service: "x" }, vendor, K });
    assert.deepStrictEqual([r.ok, r.reason], [false, "DEV_CLIENT_DRIFT"]);
    assert.deepStrictEqual(DC.METHODS.map((m) => Fake.prototype[m]), originals);
  });
};
