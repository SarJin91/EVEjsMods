"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const { claimHoldGuardOf, heldClaimSystemsOf, readClaimHoldInTx } = require("../../lib/strategy/claimHoldGuard");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const F = 500019;
const cfgOf = (env = {}) => resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(), ...env } }).config;

module.exports = ({ test }) => {
  test("CHG1 guard from config; claim systems: own occupier, hold state, age < claimHoldMaxMs", () => {
    const cfg = cfgOf();
    const g = claimHoldGuardOf(cfg);
    assert.deepStrictEqual([g.states, g.maxMs, g.readLimit],
      [["CONTESTED", "INVASION"], cfg.strategy.claimHoldMaxMs, cfg.strategy.maxOpenOperationsRead]);
    assert.ok(g.roles.includes("patrol") && g.roles.includes("invasion"));
    assert.strictEqual(claimHoldGuardOf({ strategy: { ...cfg.strategy, claimHoldEnabled: false } }), null);
    assert.strictEqual(claimHoldGuardOf({ strategy: { ...cfg.strategy, claimHoldStates: "none" } }), null);
    assert.strictEqual(claimHoldGuardOf({}), null);
    const at = 10000000;
    const row = (systemId, o) => ({ systemId, occupationState: "INVASION", occupierFactionId: F,
      lastStateChangeAt: at - 1000, ...o });
    const set = heldClaimSystemsOf([row(1), row(2, { occupationState: "OCCUPIED" }), row(3, { occupierFactionId: 7 }),
      row(4, { lastStateChangeAt: at - g.maxMs }), row(5, { lastStateChangeAt: null }),
      row(6, { occupationState: "CONTESTED", lastStateChangeAt: at - g.maxMs + 1 })], F, at, g);
    assert.deepStrictEqual([...set].sort(), [1, 6]);
  });

  test("CHG2 readClaimHoldInTx: held role in a held claim; free otherwise; no world / guard -> no read; refusal "
    + "passed on; services pass getWorld", () => {
    const g = claimHoldGuardOf(cfgOf());
    const at = 5000000;
    const reads = [];
    const world = { listByOccupier: (db, f, o) => {
      reads.push([db, f, o.limit]);
      return { ok: true, systems: [{ systemId: 30, occupationState: "CONTESTED", occupierFactionId: F,
        lastStateChangeAt: at - 1 }] };
    } };
    const r = readClaimHoldInTx("db", world, F, at, g);
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(reads, [["db", F, g.readLimit]]);
    assert.deepStrictEqual([r.holds({ currentSystemId: 30, fleetRole: "patrol" }),
      r.holds({ currentSystemId: 30, fleetRole: "mining" }), r.holds({ currentSystemId: 31, fleetRole: "patrol" })],
    [true, false, false]);
    for (const [w, gg] of [[null, g], [world, null], [{}, g]]) {
      const x = readClaimHoldInTx("db", w, F, at, gg);
      assert.deepStrictEqual([x.ok, x.holds({ currentSystemId: 30, fleetRole: "patrol" })], [true, false]);
    }
    assert.strictEqual(reads.length, 1);
    const refused = readClaimHoldInTx("db", { listByOccupier: () => ({ ok: false, reason: "TX_REQUIRED" }) }, F, at, g);
    assert.deepStrictEqual(refused, { ok: false, reason: "TX_REQUIRED" });
    const services = fs.readFileSync(path.join(MOD_DIR, "lib", "runtime", "services.js"), "utf8");
    assert.strictEqual((services.match(/getWorld: \(\) => ctx\.world \|\| null/g) || []).length >= 3, true);
    for (const m of ["lowsec", "expeditions", "hunt"]) {
      const src = fs.readFileSync(path.join(MOD_DIR, "lib", "strategy", m, "index.js"), "utf8");
      assert.ok(src.includes("getWorld: deps.getWorld"), m);
    }
  });
};
