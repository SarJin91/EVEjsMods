"use strict";

const assert = require("node:assert");

const { harness: H } = require("../battle/settlement.test");
const { rig } = require("./exposureStep.test");
const R = require("../../lib/fleetExposure/rules");

const { S } = H;
const { setup, stagedMiner, CHAR, PLAYER_SHIP, pos } = rig;
const BELTS = Object.freeze([{ itemId: 40000003, position: pos(3e9) }, { itemId: 40000001, position: pos(1e9) },
  { itemId: 40000002, position: pos(2e9) }]);

function beamRig(base, settings) {
  const t = setup(base, { settings });
  t.beams = [];
  t.w.scene.presentMiningBeams = (systemId, req) => {
    t.beams.push([systemId, req]);
    const started = req.start.map((s) => ({ entityId: s.entityId, rockId: 800 }));
    return { ok: true, started, stopped: req.stop.length, noRock: [], skipped: [],
      fxSent: req.start.length + req.stop.length, budgetCut: 0 };
  };
  return t;
}

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("XMB1 MINER exposure VISIBLE with a player near = beams start on its belt; a player aggression = stop; "
    + "flag off = no call", () => H.withStore(driver, async (reopen) => {
    const t = beamRig(reopen, { minerBeamsEnabled: true });
    const m = stagedMiner(t, "xmb1");
    const belt = R.pickMinerAnchor(BELTS, t.opened.worldSeed, m.fleetId);
    t.w.players = [{ characterId: CHAR, entityId: PLAYER_SHIP, systemId: S.N0, position: belt.position }];
    t.pass();
    assert.strictEqual(t.beams.length, 0, "spawned this pass");
    t.pass(1000);
    const ids = t.w.ids();
    assert.strictEqual(t.beams.length, 1);
    assert.deepStrictEqual([t.beams[0][0], t.beams[0][1].start, t.beams[0][1].stop, t.beams[0][1].maxFx],
      [S.N0, ids.map((entityId) => ({ entityId, beltId: belt.itemId })), [], t.settings.minerBeamMaxFxPerPass]);
    assert.deepStrictEqual([t.counters().minerBeamFx, t.counters().minerBeamRefresh], [ids.length, 1]);
    t.pass(1000);
    assert.strictEqual(t.beams.length, 1, "no change = no call");

    t.w.aggressors.set(ids[0], { aggressorKind: "player", aggressorId: PLAYER_SHIP });
    t.pass(1000);
    assert.strictEqual(t.beams.length, 2);
    assert.deepStrictEqual([t.beams[1][1].start, t.beams[1][1].stop.map((s) => s.entityId).sort()],
      [[], [...ids].sort()]);

    const off = beamRig(t.base, {});
    const m2 = stagedMiner(off, "xmb1off");
    assert.ok(m2.fleetId);
    off.w.players = [{ characterId: CHAR, entityId: PLAYER_SHIP, systemId: S.N0, position: belt.position }];
    off.pass();
    off.pass(1000);
    assert.ok(off.w.ids().length > 0);
    assert.deepStrictEqual([off.beams.length, off.counters().minerBeamFx], [0, 0]);
  }));
};
