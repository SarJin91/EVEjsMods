"use strict";

const assert = require("node:assert");

const { buildPilotCandidates } = require("../../lib/virtualCorps/pilotCandidates");
const virtualCorps = require("../../lib/virtualCorps");
const { IDENTITY_STATES } = require("../../lib/virtualCorps/schema");

function row(kind, ownerKind, ownerId, evejsId, key) {
  return { kind, owner_kind: ownerKind, owner_id: ownerId, evejs_id: evejsId, identity_key: key, name: `n${evejsId}` };
}

const ROWS = [
  row("alliance", "faction", 500001, 99000001, "f:500001:alliance"),
  row("corporation", "faction", 500001, 98000001, "f:500001:corp:0"),
  row("character", "faction", 500001, 91000005, "f:500001:corp:0:char:0"),
  row("character", "faction", 500001, 91000002, "f:500001:corp:0:char:1"),
  row("character", "faction", 500001, null, "f:500001:corp:0:char:2"),
  row("character", "capsuleer", 1, 91000003, "c:1:corp:0:char:0"),
  row("character", "faction", 500001, 91000002, "f:500001:corp:0:char:3"),
  row("character", "other", 7, 91000001, "x:7:corp:0:char:0"),
];

module.exports = ({ test }) => {
  test("VPC1 pilot candidates: LINKED characters with evejs_id (faction and capsuleer), sorted, no duplicates; "
    + "facade from memory (version), empty before maps, stub refuses", () => {
    const list = buildPilotCandidates(ROWS);
    assert.deepStrictEqual(list.map((c) => [c.characterId, c.ownerKind, c.ownerId]),
      [[91000002, "faction", 500001], [91000003, "capsuleer", 1], [91000005, "faction", 500001]]);
    assert.deepStrictEqual(list[0], { characterId: 91000002, ownerKind: "faction", ownerId: 500001, name: "n91000002",
      corporationId: 98000001, allianceId: 99000001 });
    assert.deepStrictEqual(list[1], { characterId: 91000003, ownerKind: "capsuleer", ownerId: 1, name: "n91000003",
      corporationId: null, allianceId: null });
    assert.ok(Object.isFrozen(list) && Object.isFrozen(list[0]), "frozen");
    assert.deepStrictEqual(buildPilotCandidates(null), []);

    virtualCorps.stopVirtualCorps();
    assert.deepStrictEqual(virtualCorps.listPilotCandidates(), { ok: true, version: 0, candidates: [] });
    try {
      virtualCorps.setRepoForTest({
        readByState: (state) => ({ ok: true, rows: state === IDENTITY_STATES.LINKED ? ROWS : [] }),
      });
      const res = virtualCorps.listPilotCandidates();
      assert.strictEqual(res.ok, true);
      assert.ok(virtualCorps.getMapVersion() > 0, "maps built");
      assert.ok(res.version > 0, "list version");
      assert.deepStrictEqual(res.candidates.map((c) => c.characterId), [91000002, 91000003, 91000005]);
    } finally {
      virtualCorps.stopVirtualCorps();
    }
    assert.deepStrictEqual(virtualCorps.createUnavailableVirtualCorps("NOT_STARTED").listPilotCandidates(),
      { ok: false, reason: "NOT_STARTED" });
  });
};
