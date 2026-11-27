"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { wrapDeployForGate, installDeployGate, HUB_TYPE_ID } = require("../../lib/adapter/sovDeployGate");
const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
const { buildHooks } = require("../../loader");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SYS = 30004000;
const HUB_ITEM = 1700000077;
const ALLIANCE = 99000001;
const CORP = 98000001;
const OTHER_TYPE = 35832;
const VENDOR_ERROR = "CustomNotify thrown";

function makeGate(opts = {}) {
  const calls = { vendor: [], check: [], register: [], notify: [], errors: [], outcomes: [] };
  const vendorResult = opts.vendorResult || { success: true, data: { type: "sovereignty_core", solarSystemID: SYS,
    structureID: HUB_ITEM } };
  const original = function vendorDeploy(...args) {
    calls.vendor.push({ self: this, args });
    if (opts.vendorThrows) throw opts.vendorThrows;
    return vendorResult;
  };
  const sink = opts.sink === undefined ? {
    checkDeploy: (input) => {
      calls.check.push(input);
      return opts.refuse ? { ok: false, reason: "PLAYER_SOV_DEPLOY_BLOCKED", notify: opts.refuse } : { ok: true };
    },
    registerDeploy: (input) => {
      calls.register.push(input);
      if (opts.registerThrows) throw new Error("db gone");
      return { ok: true };
    },
  } : opts.sink;
  const items = new Map([[1, HUB_TYPE_ID], [2, OTHER_TYPE]]);
  const w = wrapDeployForGate(original, {
    getSink: () => sink,
    readItemTypeId: (id) => items.get(id) || null,
    readSessionSystemId: (session) => session.solarsystemid2,
    throwNotify: (notify) => {
      calls.notify.push(notify);
      throw new Error(VENDOR_ERROR);
    },
    readNeutralHub: (systemId, hubItemId) => (systemId === SYS && hubItemId === HUB_ITEM
      ? { allianceId: ALLIANCE, corpId: CORP } : null),
    hubTypeId: HUB_TYPE_ID,
    nowMs: () => 5000,
    onError: (where) => calls.errors.push(where),
    onOutcome: (name) => calls.outcomes.push(name),
  });
  assert.strictEqual(w.ok, true, JSON.stringify(w));
  return { wrapped: w.wrapped, calls, vendorResult, original };
}

const session = { solarsystemid2: SYS };

module.exports = ({ test }) => {
  test("G1 another type: the vendor gets the same this and arguments, its result object is returned, no sink call",
    () => {
      const g = makeGate();
      const self = { service: true };
      const options = { structureName: "x" };
      const r = g.wrapped.call(self, session, 2, options);
      assert.strictEqual(r, g.vendorResult);
      assert.strictEqual(g.calls.vendor.length, 1);
      assert.strictEqual(g.calls.vendor[0].self, self);
      assert.strictEqual(g.calls.vendor[0].args.length, 3);
      assert.deepStrictEqual(g.calls.vendor[0].args.map((a, i) => a === [session, 2, options][i]), [true, true, true]);
      assert.deepStrictEqual([g.calls.check, g.calls.register, g.calls.errors], [[], [], []]);
      assert.strictEqual(wrapDeployForGate(g.wrapped, {}).noop, true);
    });

  test("G2 a hub in a system with a live faction sov structure: throwNotify with the sink's text, the vendor never "
    + "called", () => {
      const text = "Guristas Pirates holds a sovereignty structure in this system. Destroy it before deploying a "
        + "Sovereignty Hub.";
      const g = makeGate({ refuse: text });
      assert.throws(() => g.wrapped(session, 1, {}), { message: VENDOR_ERROR });
      assert.deepStrictEqual(g.calls.notify, [text]);
      assert.deepStrictEqual(g.calls.check, [{ systemId: SYS, at: 5000 }]);
      assert.deepStrictEqual([g.calls.vendor.length, g.calls.register.length], [0, 0]);
      assert.deepStrictEqual(g.calls.outcomes, ["gateChecked", "gateRefused"]);
    });

  test("G3 a hub, vendor success: registerDeploy with structureID and the deployer from devFlags; a throwing sink "
    + "or no sink -> the vendor result anyway + gateError; a vendor exception passes unchanged", () => {
      const g = makeGate();
      assert.strictEqual(g.wrapped(session, 1, {}), g.vendorResult);
      assert.deepStrictEqual(g.calls.register, [{ systemId: SYS, hubItemId: HUB_ITEM, allianceId: ALLIANCE,
        corpId: CORP, at: 5000 }]);
      assert.deepStrictEqual(g.calls.outcomes, ["gateChecked", "gateRegistered"]);

      const thrower = makeGate({ registerThrows: true });
      assert.strictEqual(thrower.wrapped(session, 1, {}), thrower.vendorResult);
      assert.deepStrictEqual(thrower.calls.errors, ["register"]);

      const noSink = makeGate({ sink: null });
      assert.strictEqual(noSink.wrapped(session, 1, {}), noSink.vendorResult);
      assert.deepStrictEqual([noSink.calls.vendor.length, noSink.calls.errors], [1, ["sink"]]);

      const vendorError = new Error("vendor says no");
      const failing = makeGate({ vendorThrows: vendorError });
      assert.throws(() => failing.wrapped(session, 1, {}), (err) => err === vendorError);
      assert.deepStrictEqual(failing.calls.register, []);
    });

  test("G4 vendor facts: both consumers destructure deployStructureFromInventoryItem, the hub result is "
    + "sovereignty_core with structureID; the loader hook matches the real module and swaps the export (off -> no "
    + "wrap)", () => {
      const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
      assert.ok(found.ok, JSON.stringify(found));
      const read = (...p) => fs.readFileSync(path.join(found.srcDir, ...p), "utf8").replace(/\r\n/g, "\n");
      const destructures = /const \{[^}]*\bdeployStructureFromInventoryItem,[^}]*\} = require\(path\.join\(__dirname, "\.\.\/sovereignty\/sovPlayerDeployment"\)\)/;
      assert.ok(destructures.test(read("services", "structure", "structureDeploymentService.js")), "Handle_Anchor");
      assert.ok(destructures.test(read("services", "ship", "orbitalLaunchRuntime.js")), "launch for corp");
      const deploy = read("services", "sovereignty", "sovPlayerDeployment.js");
      assert.ok(/^function deployStructureFromInventoryItem\(session, itemID, options = \{\}\)/m.test(deploy));
      assert.ok(/^ {2}deployStructureFromInventoryItem,$/m.test(deploy), "exported");
      assert.ok(/type: "sovereignty_core",\n\s+solarSystemID,\n\s+kind,\n\s+structureID,/.test(deploy), "core result");
      assert.ok(deploy.includes("const candidateItem = findItemById(itemID);"), "type through findItemById");
      assert.ok(/throwWrappedUserError\("CustomNotify", \{\n\s+notify:/.test(deploy), "CustomNotify refusal");
      assert.strictEqual(deploy.split("deployStructureFromInventoryItem(").length - 1, 1);

      const request = path.join(found.srcDir, "services", "sovereignty", "sovPlayerDeployment");
      const config = (on) => ({ ok: true, config: { enabled: true, modules: { world: { enabled: true } },
        playerSov: { enabled: on, deployGate: { enabled: true } } } });
      for (const on of [true, false]) {
        const lines = [];
        const ctx = { logger: { log: (l) => lines.push(l), debug() {} }, loadConfig: () => config(on), state: {} };
        const hook = buildHooks(ctx).find((h) => h.name === "playerSovDeployGate");
        const vendor = function deployStructureFromInventoryItem() { return "vendor"; };
        const exportsObject = { deployStructureFromInventoryItem: vendor, requireStructureManagementSession() {} };
        assert.strictEqual(hook.match(request, exportsObject), true);
        assert.strictEqual(hook.match(request, {}), false, "partial exports of a cycle");
        assert.strictEqual(hook.match(path.join(found.srcDir, "services", "sovereignty", "sovState"),
          exportsObject), false);
        hook.run(exportsObject, request, null);
        const { deployStructureFromInventoryItem } = exportsObject;
        assert.strictEqual(deployStructureFromInventoryItem !== vendor, on, `wrapped=${on}`);
        assert.strictEqual(ctx.state.playerSovDeployGate, on ? "wrapped" : "disabled");
        assert.strictEqual(deployStructureFromInventoryItem({ solarsystemid2: SYS }, 1, {}), "vendor");
        if (on) assert.ok(lines.some((l) => l.startsWith("playerSovDeployGate: wrapped")), lines.join("\n"));
      }
      assert.deepStrictEqual(installDeployGate(Object.freeze({ deployStructureFromInventoryItem() {} }), () => null),
        { ok: false, reason: "SEAM_NOT_WRITABLE" });
    });
};
