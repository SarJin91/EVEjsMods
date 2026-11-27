"use strict";

const assert = require("node:assert");

const { startArchaeology, createUnavailableArchaeology, ARCHAEOLOGY_METHODS } = require("../../lib/archaeology");
const S = require("../../lib/archaeology/schema");
const { harness: H } = require("./service.test");
const { fakeSites } = require("./fixture");

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  if (!driver.ok) {
    skip("A4 archaeology start / drain", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }
  test("A4 archaeology start: off + empty table = no write / seam / timer / command; off + ACTIVE -> CANCELLED; "
    + "seam refused -> SEAM_UNAVAILABLE without a timer; stub keys", () => H.withStore(driver, (opened) => {
    const real = opened.store;
    const txNames = [];
    const counting = { ...real, transaction: (name, fn) => {
      txNames.push(name);
      return real.transaction(name, fn);
    } };
    const changes = () => real.transaction("arc.changes", (db) => db.prepare("SELECT total_changes() AS n").get().n)
      .value;
    const off = H.cfg({ EVEJS_LNE_ARCHAEOLOGY_ENABLED: "0" });
    const before = changes();
    const r0 = H.rig(opened, off, { store: counting });
    assert.deepStrictEqual(r0.started, { ok: false, reason: "disabled_by_config" });
    assert.deepStrictEqual(txNames, ["archaeology.drain"]);
    assert.strictEqual(changes(), before, "zero changes");
    assert.deepStrictEqual([r0.seam.calls, r0.timers.length, r0.installs.length], [0, 0, 0]);

    const on = H.cfg();
    const r1 = H.rig(opened, on);
    r1.emit(H.hackWin());
    r1.a.runPass(H.T0);
    r1.a.stop();
    assert.strictEqual(H.chains(r1)[0].state, "ACTIVE");
    const r2 = H.rig(opened, off, { clock: { now: () => H.T0 + 5 } });
    assert.strictEqual(r2.started.reason, "disabled_by_config");
    assert.deepStrictEqual(H.chains(r2).map((c) => [c.state, c.end_reason, c.ended_at]),
      [["CANCELLED", "DISABLED", H.T0 + 5]]);
    assert.ok(r2.logger.lines.some((l) => l === "archaeology: drain cancelled=1"), r2.logger.lines.join("\n"));

    const refusing = { onSiteContainerHacked: () => ({ ok: false, reason: "SEAM_UNAVAILABLE", detail: "drift_x" }) };
    const r3 = H.rig(opened, on, { adapter: refusing });
    assert.deepStrictEqual(r3.started, { ok: false, reason: "SEAM_UNAVAILABLE", detail: "drift_x" });
    assert.strictEqual(r3.timers.length, 0);
    assert.strictEqual(startArchaeology({ config: on, persistence: opened, clock: { now: () => H.T0 },
      adapter: {}, getSites: () => fakeSites() }).reason, "SEAM_UNAVAILABLE");
    assert.strictEqual(startArchaeology({ config: on, persistence: opened, clock: { now: () => H.T0 },
      adapter: {} }).reason, "dependency_disabled:sites");
    const full = { ...fakeSites(), registerContentProvider: () => ({ ok: false, reason: "FULL" }) };
    const r4 = H.rig(opened, on, { sites: full });
    assert.deepStrictEqual(r4.started, { ok: false, reason: "dependency_disabled:sites", detail: "provider FULL" });
    assert.strictEqual(r4.timers.length, 0);
    assert.deepStrictEqual(r2.sites.calls.cleanup, [[`${H.chains(r2)[0].chain_id}:s1:r0`, "EVENT_CANCELLED"]]);
    assert.strictEqual(startArchaeology({ config: on, persistence: null, clock: { now: () => H.T0 } }).reason,
      "dependency_disabled:persistence");

    const stub = createUnavailableArchaeology("ARCHAEOLOGY_DISABLED", "disabled_by_config");
    assert.deepStrictEqual(Object.keys(stub).sort(), [...ARCHAEOLOGY_METHODS].sort());
    assert.deepStrictEqual(stub.readChainOf(1), { ok: false, reason: "ARCHAEOLOGY_DISABLED",
      detail: "disabled_by_config" });
    assert.strictEqual(S.VIEW_ID, "archaeology");
  }));
};
