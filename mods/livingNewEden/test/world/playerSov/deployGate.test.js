"use strict";

const assert = require("node:assert");

const { createDeployGate, blockedNotify } = require("../../../lib/world/playerSov/deployGate");
const { createPlayerSovRepository } = require("../../../lib/world/playerSov/repository");
const { createSovStructureRepository } = require("../../../lib/world/sovStructures/repository");
const { harness: H } = require("../../battle/settlement.test");

const SYS = 30004000;
const FREE_SYS = 30004001;
const GURISTAS = 500010;
const ALLIANCE = 99000001;
const CORP = 98000001;
const HUB = 1700000001;

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const name = "G5 deployGate on a migrated store: a live LNE sov structure -> refusal naming the faction (ASCII, "
    + "<= 200 chars), a free system -> ok, registerDeploy CAPTURING origin GATE, twice -> DUPLICATE";
  if (!driver.ok) {
    skip(name, `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }
  test(name, () => H.withStore(driver, async (reopen) => {
    const { store } = reopen();
    const sovRepository = createSovStructureRepository();
    const seeded = store.transaction("test", (db) => sovRepository.insertAnchoring(db, { structureId: "sov:test:1",
      systemId: SYS, factionId: GURISTAS, claimSeq: 1, attempt: 1, costIsk: 0, dueAt: 2000, at: 1000 }));
    assert.ok(seeded.ok && seeded.value.ok, JSON.stringify(seeded));
    const gate = createDeployGate({ store, repository: createPlayerSovRepository(), sovRepository,
      clock: { now: () => 7000 }, factionNames: new Map([[GURISTAS, "Guristas Pirates"]]) });

    const refused = gate.checkDeploy({ systemId: SYS, at: 3000 });
    assert.deepStrictEqual(refused, { ok: false, reason: "PLAYER_SOV_DEPLOY_BLOCKED", factionId: GURISTAS,
      notify: "Guristas Pirates holds a sovereignty structure in this system. Destroy it before deploying a "
        + "Sovereignty Hub." });
    assert.ok(/^[\x20-\x7e]+$/.test(refused.notify) && refused.notify.length <= 200);
    const longName = blockedNotify(`Café ${"X".repeat(300)}`);
    assert.ok(/^[\x20-\x7e]+$/.test(longName) && longName.length <= 200, longName);
    assert.deepStrictEqual(gate.checkDeploy({ systemId: FREE_SYS, at: 3000 }), { ok: true });

    const spec = { systemId: FREE_SYS, hubItemId: HUB, allianceId: ALLIANCE, corpId: CORP };
    const first = gate.registerDeploy(spec);
    assert.strictEqual(first.ok, true, JSON.stringify(first));
    assert.deepStrictEqual([first.claim.claimId, first.claim.state, first.claim.origin, first.claim.firstSeenAt],
      [`psov:${FREE_SYS}:${ALLIANCE}:${HUB}`, "CAPTURING", "GATE", 7000]);
    assert.strictEqual(gate.registerDeploy({ ...spec, at: 8000 }).reason, "DUPLICATE");
  }));
};
