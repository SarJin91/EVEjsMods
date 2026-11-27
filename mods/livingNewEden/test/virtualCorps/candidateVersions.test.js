"use strict";

const assert = require("node:assert");

const virtualCorps = require("../../lib/virtualCorps");
const { IDENTITY_STATES, OWNER_KINDS, OWNER_PREFIXES, FLEET_OWNER_KINDS } = require("../../lib/virtualCorps/schema");

const row = (kind, ownerKind, ownerId, evejsId, key) => ({ kind, owner_kind: ownerKind, owner_id: ownerId,
  evejs_id: evejsId, identity_key: key, name: `n${evejsId}`, ticker: kind === "corporation" ? "TCK" : null });

const methodsOf = (facade) => Object.keys(facade).filter((k) => typeof facade[k] === "function").sort();

module.exports = ({ test }) => {
  test("FC2-1 list versions change only with the list; free owner kind never a candidate "
    + "countOwnerCharacters; stub method list = running facade", async () => {
    assert.strictEqual(OWNER_KINDS.FREE, "free");
    assert.strictEqual(OWNER_PREFIXES.free, "i");
    assert.ok(!FLEET_OWNER_KINDS.includes("free"), "FLEET_OWNER_KINDS unchanged");
    const linked = [
      row("corporation", "faction", 500010, 98000001, "f:500010:corp:0"),
      row("character", "faction", 500010, 91000001, "f:500010:corp:0:char:0"),
      row("corporation", "capsuleer", 1, 98000002, "c:1:corp:0"),
      row("character", "capsuleer", 1, 91000002, "c:1:corp:0:char:0"),
      row("corporation", "civilian", 1, 98000003, "v:1:corp:0"),
      row("character", "civilian", 1, 91000003, "v:1:corp:0:char:0"),
    ];
    virtualCorps.stopVirtualCorps();
    try {
      virtualCorps.setRepoForTest({
        readByState: (state) => ({ ok: true, rows: state === IDENTITY_STATES.LINKED ? linked.slice() : [] }),
      });
      const p1 = virtualCorps.listPilotCandidates();
      const c1 = virtualCorps.listCivilianCandidates();
      const m1 = virtualCorps.getMapVersion();
      assert.ok(p1.version > 0 && c1.version > 0, "versions after the first build");
      assert.deepStrictEqual(virtualCorps.countOwnerCharacters(),
        { ok: true, ready: false, total: 2, byKind: { capsuleer: 1, civilian: 1, free: 0, outlaw: 0 } });

      linked.push(row("corporation", "free", 7, 98000007, "i:7:corp:0"),
        row("character", "free", 7, 91000070, "i:7:corp:0:char:0"),
        row("character", "free", 7, 91000071, "i:7:corp:0:char:1"),
        row("character", "free", 7, 91000072, "i:7:corp:0:char:2"));
      virtualCorps.rebuildMaps();
      const p2 = virtualCorps.listPilotCandidates();
      const c2 = virtualCorps.listCivilianCandidates();
      assert.strictEqual(p2.version, p1.version, "pilot version unchanged by a free saga");
      assert.strictEqual(c2.version, c1.version, "civilian version unchanged by a free saga");
      assert.ok(virtualCorps.getMapVersion() > m1, "mapVersion bumped");
      const free = [91000070, 91000071, 91000072];
      assert.ok(!p2.candidates.some((c) => free.includes(c.characterId)), "no free pilot");
      assert.ok(!c2.characterIds.some((id) => free.includes(id)), "no free civilian");
      const oc = virtualCorps.countOwnerCharacters();
      assert.strictEqual(oc.byKind.free, 3);
      assert.strictEqual(oc.total, 5);
      const id = virtualCorps.getOwnerIdentity("free", 7);
      assert.strictEqual(id.state, "LINKED");
      assert.strictEqual(id.corporationId, 98000007);
      assert.deepStrictEqual(id.characterIds, free);

      linked.push(row("character", "faction", 500010, 91000009, "f:500010:corp:0:char:1"));
      virtualCorps.rebuildMaps();
      assert.strictEqual(virtualCorps.listPilotCandidates().version, p1.version + 1, "pilot version +1");
      assert.strictEqual(virtualCorps.listCivilianCandidates().version, c1.version, "civilian version unchanged");
    } finally {
      virtualCorps.stopVirtualCorps();
    }
    assert.deepStrictEqual(virtualCorps.countOwnerCharacters(), { ok: false, reason: "DISABLED" });

    const logs = [];
    const running = virtualCorps.startVirtualCorps({ config: { modules: { virtualCorps: { enabled: true } } },
      adapter: { getProcessRole: () => "world" }, clock: { now: () => 1000 }, logger: { log: (l) => logs.push(l) },
      persistence: { store: { transaction: () => ({ ok: false, reason: "TEST_REFUSED" }),
        isInTransaction: () => false } } });
    try {
      assert.strictEqual(running.ok, true, JSON.stringify(running));
      await running.whenReady();
      const real = methodsOf(running);
      assert.ok(real.includes("countOwnerCharacters"), real.join(","));
      const stub = virtualCorps.createUnavailableVirtualCorps("NOT_STARTED");
      assert.deepStrictEqual(methodsOf(stub), real, "stub method list");
      assert.deepStrictEqual(stub.countOwnerCharacters(), { ok: false, reason: "NOT_STARTED" });
    } finally {
      running.stop();
    }
  });
};
