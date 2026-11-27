"use strict";

const assert = require("node:assert");

const { startLoyalty } = require("../../lib/loyalty");

const AMARR = 500003;

function config(enabled) {
  return { loyalty: { dockDenyEnabled: enabled, dockDenyStandingMax: -5, dockDenyExemptCapsule: true } };
}

function stubAdapter(seams, standing) {
  const calls = { install: 0, uninstall: 0 };
  return {
    calls,
    dockGateSeams: () => seams,
    installDockGate: () => { calls.install += 1; return { ok: true }; },
    uninstallDockGate: () => { calls.uninstall += 1; return { ok: true }; },
    readCharacterStanding: () => standing,
    readFactionNames: () => ({ ok: true, names: new Map([[AMARR, "Amarr Empire"]]) }),
  };
}

module.exports = ({ test }) => {
  test("LS1 loyalty service: off without hook, degraded on a refused seam, running decide deny / fail-open", () => {
    const lines = [];
    const logger = { log: (l) => lines.push(l) };
    const off = stubAdapter({ ok: true }, { ok: true, standing: -9 });
    const a = startLoyalty({ config: config(false), ctx: {}, adapter: off, logger });
    assert.strictEqual(a.ok, true);
    assert.strictEqual(a.loyalty.getStatus().state, "off");
    assert.strictEqual(off.calls.install, 0, "flag off: installDockGate not called");

    const refused = stubAdapter({ ok: false, reason: "SEAM_UNAVAILABLE", detail: "beyonceService_not_booted" }, null);
    const b = startLoyalty({ config: config(true), ctx: {}, adapter: refused, logger });
    assert.strictEqual(b.ok, true, "a missing seam never refuses the start");
    assert.strictEqual(b.loyalty.getStatus().state, "degraded");
    assert.strictEqual(b.loyalty.getStatus().reason, "SEAM_UNAVAILABLE:beyonceService_not_booted");
    assert.strictEqual(refused.calls.install, 0);

    const world = { getControllerMemo: () => ({ ok: true, controllerFactionId: AMARR }) };
    const on = stubAdapter({ ok: true }, { ok: true, found: true, standing: -6.5 });
    const c = startLoyalty({ config: config(true), ctx: { world }, adapter: on, logger });
    assert.strictEqual(c.loyalty.getStatus().state, "running");
    assert.strictEqual(on.calls.install, 1);
    const q = { characterId: 90000001, stationId: 60008494, systemId: 30002187, isCapsule: false };
    assert.deepStrictEqual(c.loyalty.decide(q), { deny: true, message: "Amarr Empire controls this system and "
      + "refuses docking to pilots with standing -5 or lower (yours: -6.50)." });
    assert.deepStrictEqual(c.loyalty.decide({ ...q, isCapsule: true }), { deny: false });
    on.readCharacterStanding = () => ({ ok: false, reason: "SEAM_UNAVAILABLE" });
    assert.deepStrictEqual(c.loyalty.decide(q), { deny: false });
    world.getControllerMemo = () => { throw new Error("boom"); };
    assert.deepStrictEqual(c.loyalty.decide(q), { deny: false });
    assert.deepStrictEqual(c.loyalty.getStatus().counters, { dockChecked: 4, dockDenied: 1, dockCapsuleExempt: 1,
      dockFailOpen: 2, dockNoController: 0, fameDockDenied: 0, fameDockFailOpen: 0 });
    assert.ok(lines.includes("loyalty: dock denied char=90000001 station=60008494 faction=500003 standing=-6.5"),
      lines.join("\n"));
    c.loyalty.stop("test");
    assert.strictEqual(on.calls.uninstall, 1);
    assert.strictEqual(c.loyalty.getStatus().state, "stopped");
  });
};
