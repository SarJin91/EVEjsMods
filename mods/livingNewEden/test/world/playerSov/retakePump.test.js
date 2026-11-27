"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createRetakePump } = require("../../../lib/world/playerSov/retakePump");
const { createPlayerSovSiege } = require("../../../lib/world/playerSov/siege");
const { createPlayerSovClockRepository } = require("../../../lib/world/playerSov/clock");
const { createPlayerSovRepository } = require("../../../lib/world/playerSov/repository");
const { createJournal } = require("../../../lib/persistence/journal");
const { readPlayerOrgNamesFrom } = require("../../../lib/adapter/playerOrgNames");
const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../../lib/adapter/locator");
const { resolveConfig } = require("../../../config");
const { harness: H } = require("../../battle/settlement.test");

const MOD_DIR = path.resolve(__dirname, "..", "..", "..");
const HOUR = 3600000;
const A = 99000001;
const CORP = 98000001;
const SANSHA = 500019;

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("R4 retake pump: released -> LOST RETAKEN + clock removed; a throw -> RETAKING, deferred, no second try "
    + "in the window; alreadyGone -> LOST RETAKEN; owner offline -> no vendor call; names seam null-safe + vendor "
    + "facts + facade", () => H.withStore(driver, async (reopen) => {
    const { store } = reopen();
    let t = 10 * HOUR;
    const clock = { now: () => t };
    const r = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(), EVEJS_LNE_PLAYER_SOV_ENABLED: "1" } });
    assert.deepStrictEqual(r.errors || [], []);
    const config = r.config;
    const repo = createPlayerSovRepository();
    const clockRepo = createPlayerSovClockRepository();
    const journal = createJournal({ clock, maxPayloadBytes: 8192, maxRows: 500 });
    const siege = createPlayerSovSiege({ journal, getPlayerSov: () => ({ getRepository: () => repo }), clockRepo,
      ownerOnline: { ownerOnline: () => ({ online: true, reason: null }) }, adapter: null, config });
    const tx = (fn) => {
      const res = store.transaction("test", fn);
      assert.ok(res.ok, JSON.stringify(res));
      return res.value;
    };
    const retaking = (sys, hub) => tx((db) => {
      let c = repo.insertClaim(db, { systemId: sys, allianceId: A, corpId: CORP, hubItemId: hub, origin: "MIRROR",
        state: "HELD", at: t }).claim;
      c = repo.transition(db, { claim: c, to: "SIEGED", at: t, attackerFactionId: SANSHA }).claim;
      c = repo.transition(db, { claim: c, to: "REINFORCED", at: t, reinforcedUntil: t + HOUR }).claim;
      assert.ok(clockRepo.put(db, { claimId: c.claimId, phase: "REINFORCED", phaseKey: t, creditedMs: HOUR,
        sampledAt: t, expectVersion: null }).ok);
      return repo.transition(db, { claim: c, to: "RETAKING", at: t }).claim;
    });
    const stateOf = (c) => tx((db) => repo.getById(db, c.claimId)).claim;
    const clockOf = (c) => tx((db) => clockRepo.get(db, c.claimId)).clock;
    const calls = [];
    const outcome = new Map();
    let online = true;
    const counts = {};
    const pump = createRetakePump({ store, getRepository: () => repo, clockRepo, config, clock,
      ownerOnline: { ownerOnline: () => ({ online, reason: null }) }, transitionInTx: siege.transitionInTx,
      bump: (name, n = 1) => { counts[name] = (counts[name] || 0) + n; },
      adapter: { releasePlayerSov: async (systemId) => {
        calls.push(systemId);
        const o = outcome.get(systemId);
        if (o === "throw") throw new Error("vendor down");
        return { ok: true, outcome: o };
      } } });

    const c1 = retaking(30004001, 1700000001);
    outcome.set(30004001, "released");
    const p1 = pump.runPass();
    assert.strictEqual(p1.started, 1);
    await p1.settled;
    assert.deepStrictEqual([stateOf(c1).state, stateOf(c1).endReason, stateOf(c1).retakeAttempts, clockOf(c1)],
      ["LOST", "RETAKEN", 1, null]);

    const c2 = retaking(30004002, 1700000002);
    outcome.set(30004002, "throw");
    t += 1000;
    await pump.runPass().settled;
    assert.deepStrictEqual([stateOf(c2).state, stateOf(c2).retakeAttempts, calls], ["RETAKING", 1, [30004001, 30004002]]);
    t += config.playerSov.retakeRetryMs - 2000;
    assert.strictEqual(pump.runPass().started, 0, "deferred inside the window");
    assert.deepStrictEqual(calls, [30004001, 30004002]);
    outcome.set(30004002, "alreadyGone");
    t += 2000;
    await pump.runPass().settled;
    assert.deepStrictEqual([stateOf(c2).state, stateOf(c2).endReason, clockOf(c2)], ["LOST", "RETAKEN", null]);

    const c3 = retaking(30004003, 1700000003);
    online = false;
    t += 1000;
    assert.strictEqual(pump.runPass().started, 0);
    assert.deepStrictEqual([stateOf(c3).state, calls.length], ["RETAKING", 3]);
    assert.deepStrictEqual([counts.retakeReleased, counts.retakeAlreadyGone, counts.retakeFailed,
      counts.retakeOwnerOffline], [1, 1, 1, 1]);
    const lost = tx((db) => db.prepare("SELECT count(*) AS n FROM world_event_journal WHERE event_type = ?")
      .get("PLAYER_SOV_LOST")).n;
    assert.strictEqual(lost, 2);

    const ids = { allianceIds: [A, A + 1], corpIds: [CORP] };
    const none = readPlayerOrgNamesFrom({}, ids);
    assert.deepStrictEqual([none.ok, [...none.alliances], [...none.corps]], [true, [[A, null], [A + 1, null]],
      [[CORP, null]]]);
    const thrown = readPlayerOrgNamesFrom({ getAllianceRecord() { throw new Error("x"); },
      getCorporationRecord: () => null }, ids);
    assert.deepStrictEqual([thrown.ok, thrown.alliances.get(A), thrown.corps.get(CORP)], [true, null, null]);
    const good = readPlayerOrgNamesFrom({ getAllianceRecord: (id) => (id === A ? { allianceName: "Tést\u0007 Alliance" }
      : null), getCorporationRecord: () => ({ corporationName: "x".repeat(80) }) }, ids);
    assert.deepStrictEqual([good.alliances.get(A), good.alliances.get(A + 1), good.corps.get(CORP)],
      ["Tst Alliance", null, "x".repeat(64)]);
    assert.strictEqual(readPlayerOrgNamesFrom({}, { allianceIds: Array.from({ length: 33 }, (_, i) => i + 1) }).reason,
      "INVALID_INPUT");
    const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
    assert.ok(found.ok, JSON.stringify(found));
    const cs = fs.readFileSync(path.join(found.srcDir, "services", "corporation", "corporationState.js"), "utf8")
      .replace(/\r\n/g, "\n");
    for (const re of [/^function getAllianceRecord\(/m, /^function getCorporationRecord\(/m, /^ {2}getAllianceRecord,$/m,
      /^ {2}getCorporationRecord,$/m, /\ballianceName\b/, /\bcorporationName\b/]) {
      assert.ok(re.test(cs), String(re));
    }
    const { createAdapter } = require("../../../lib/adapter");
    const adapter = createAdapter({ moduleApi: { _cache: {} } });
    assert.strictEqual(typeof adapter.readPlayerOrgNames, "function");
    const viaFacade = adapter.readPlayerOrgNames({ allianceIds: [A] });
    assert.deepStrictEqual([viaFacade.ok, viaFacade.alliances.get(A)], [true, null]);
  }));
};
