"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { createSiteScannerHide } = require("../../lib/adapter/siteScannerHide");

const SERVER_SRC = path.resolve(__dirname, "..", "..", "..", "..", "server", "src");

function readSource(relPath) {
  const full = path.join(SERVER_SRC, relPath);
  return fs.existsSync(full) ? fs.readFileSync(full, "utf8") : "";
}

function listJs(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listJs(full, out);
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

function fakeProvider(list) {
  const calls = [];
  const exportsObject = {
    providerID: "sceneAnomalySite",
    listAnomalySites(systemID, options) {
      calls.push([this, systemID, options]);
      return list;
    },
  };
  return { exportsObject, calls };
}

function fakeScanMgr() {
  const deltas = [];
  return { deltas, notifyAnomalyDeltaForSystem(systemId) { deltas.push(systemId); return 1; } };
}

module.exports = ({ test }) => {
  test("SH1 wrap: hidden siteID filtered, no hidden -> the same array, this/args passed, uninstall restores", () => {
    const sites = [{ siteID: 6800000000101 }, { siteID: 6800000000102 }, { siteID: 42 }];
    const { exportsObject, calls } = fakeProvider(sites);
    const original = exportsObject.listAnomalySites;
    const scanMgr = fakeScanMgr();
    const hide = createSiteScannerHide({ providerExports: exportsObject, scanMgr, maxHidden: 16 });
    assert.deepStrictEqual(hide.install(), { ok: true });
    assert.deepStrictEqual(hide.install(), { ok: false, reason: "HOOK_ALREADY_INSTALLED" });
    assert.notStrictEqual(exportsObject.listAnomalySites, original);
    const opts = { allowTemplateDiscovery: false };
    assert.strictEqual(exportsObject.listAnomalySites(30000001, opts), sites, "no hidden site -> same array");
    assert.deepStrictEqual(calls[0].slice(1), [30000001, opts]);
    assert.strictEqual(calls[0][0], exportsObject, "called on the module object");
    assert.deepStrictEqual(hide.hide(30000001, 6800000000101), { ok: true, notified: true });
    assert.deepStrictEqual(exportsObject.listAnomalySites(30000001, opts).map((s) => s.siteID),
      [6800000000102, 42]);
    hide.forget(6800000000101);
    assert.strictEqual(exportsObject.listAnomalySites(30000001, opts), sites, "forget -> visible again");
    hide.hide(30000001, 42);
    const later = exportsObject.listAnomalySites;
    exportsObject.listAnomalySites = function outer(...args) { return later.apply(this, args); };
    assert.deepStrictEqual(exportsObject.listAnomalySites(30000001).map((s) => s.siteID),
      [6800000000101, 6800000000102]);
    exportsObject.listAnomalySites = later;
    hide.uninstall();
    assert.strictEqual(exportsObject.listAnomalySites, original, "uninstall restores the original");
    assert.strictEqual(exportsObject._lneWrapped, false);
    assert.deepStrictEqual(hide.hide(30000001, 42), { ok: false, reason: "NOT_INSTALLED" });
    assert.deepStrictEqual(createSiteScannerHide({ providerExports: {}, scanMgr, maxHidden: 16 }).install(),
      { ok: false, reason: "HOOK_SEAM_UNAVAILABLE" });
  });

  test("SH2 hide: notifyAnomalyDeltaForSystem(systemId), idempotent, FIFO at maxHidden, a throwing "
    + "delta -> notified:false", () => {
    const sites = [1, 2, 3, 4].map((siteID) => ({ siteID }));
    const { exportsObject } = fakeProvider(sites);
    const scanMgr = fakeScanMgr();
    const lines = [];
    const hide = createSiteScannerHide({ providerExports: exportsObject, scanMgr, maxHidden: 2,
      logger: { log: (l) => lines.push(l) } });
    hide.install();
    hide.hide(30000001, 1);
    hide.hide(30000001, 1);
    hide.hide(30000002, 2);
    assert.deepStrictEqual(scanMgr.deltas, [30000001, 30000001, 30000002]);
    assert.strictEqual(hide.size(), 2);
    hide.hide(30000003, 3);
    assert.strictEqual(hide.size(), 2, "maxHidden");
    assert.deepStrictEqual(exportsObject.listAnomalySites(30000001).map((s) => s.siteID), [1, 4], "oldest dropped");
    assert.deepStrictEqual(hide.hide(0, 5), { ok: false, reason: "HIDE_INVALID" });
    scanMgr.notifyAnomalyDeltaForSystem = () => { throw new Error("no session"); };
    assert.deepStrictEqual(hide.hide(30000004, 4), { ok: true, notified: false });
    assert.strictEqual(lines.length, 1);
    hide.uninstall();
  });

  test("SH3 vendor facts: listAnomalySites definer, no internal call / destructuring, called through the module "
    + "object; scanner delta static; occupancy range; player ship filter; wreck isEmpty", () => {
    const provider = readSource("services/exploration/signatures/providers/sceneAnomalySiteProvider.js");
    assert.ok(provider, "provider source");
    assert.match(provider, /^function listAnomalySites\(systemID, options = \{\}\) \{/m, "definition");
    assert.strictEqual((provider.match(/\blistAnomalySites\s*\(/g) || []).length, 1, "no internal call");
    assert.match(provider, /^ {2}listAnomalySites,\r?$/m, "export");
    assert.match(provider, /const siteID = toInt\(entity && entity\.itemID, 0\);/, "siteID = entity itemID");
    const runtime = readSource("services/exploration/signatures/signatureRuntime.js");
    assert.ok(runtime.includes("provider.listAnomalySites(systemID, options)"), "called through the module object");
    assert.match(runtime, /const ANOMALY_PROVIDERS = Object\.freeze\(\[\s*miningAnomalyProvider,\s*sceneAnomalySiteProvider,/);
    const destructured = [...listJs(path.join(SERVER_SRC, "services", "exploration")),
      ...listJs(path.join(SERVER_SRC, "services", "dungeon"))]
      .filter((f) => /\{[^}]*\blistAnomalySites\b[^}]*\}\s*=/.test(fs.readFileSync(f, "utf8")));
    assert.deepStrictEqual(destructured, [], "nobody destructures listAnomalySites");
    const scanMgr = readSource("services/exploration/scanMgrService.js");
    assert.match(scanMgr, /^function notifyAnomalyDeltaForSystem\(systemID, options = \{\}\) \{/m);
    assert.match(scanMgr, /^ScanMgrService\.notifyAnomalyDeltaForSystem = notifyAnomalyDeltaForSystem;\r?$/m);
    assert.match(scanMgr, /^module\.exports = ScanMgrService;\r?$/m);
    const site = readSource("services/dungeon/dungeonUniverseSiteService.js");
    assert.match(site, /^const SITE_OCCUPANCY_GRACE_RANGE_METERS = 250_000;\r?$/m);
    const occupancy = site.slice(site.indexOf("function anyPlayerShipPresentAtSite("));
    assert.ok(occupancy.slice(0, 2500).includes("entity.kind !== \"ship\""), "ship filter");
    assert.ok(/toInt\(entity\.charID, 0\) <= 0 && toInt\(entity\.characterID, 0\) <= 0/.test(occupancy.slice(0, 2500)),
      "player filter");
    assert.match(site, /itemID: Math\.max\(0, toInt\(instance && instance\.metadata && instance\.metadata\.siteID, 0\)\)/,
      "root entity itemID = metadata.siteID");
    const wreck = readSource("space/npc/nativeNpcWreckService.js");
    const refresh = wreck.slice(wreck.indexOf("function refreshNativeWreckRuntimeEntity("));
    assert.ok(refresh.slice(0, 3000).includes("entity.isEmpty ="), "isEmpty refreshed after a content change");
  });
};
