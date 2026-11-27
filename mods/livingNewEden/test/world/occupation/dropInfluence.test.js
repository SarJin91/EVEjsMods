"use strict";

const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");

const { createOccupationService } = require("../../../lib/world/occupation/occupationService");
const { resolveConfig } = require("../../../config");

const MOD_DIR = path.resolve(__dirname, "..", "..", "..");
const AMARR = 500003;
const SANSHA = 500019;
const SYSTEM = 30001001;
const TX = Object.freeze({ inTransaction: true });

function serviceWith(writes) {
  const config = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir() } }).config;
  const system = { systemId: SYSTEM, occupationState: "CONTESTED", controllerFactionId: AMARR,
    occupierFactionId: SANSHA, previousControllerFactionId: null, lastStateChangeAt: 0, phaseSeq: 3,
    influenceEvaluatedAt: null, capturedAt: null, detachedSinceAt: null, homeFactionId: null, version: 7,
    influence: [{ factionId: AMARR, influenceScore: 40, garrisonStrength: 0 },
      { factionId: SANSHA, influenceScore: 60, garrisonStrength: 0 }] };
  const repository = {
    isApplied: () => ({ ok: true, applied: false }),
    getSystem: () => ({ ok: true, system }),
    applyChange: (tx, change, key) => {
      writes.push([change, key]);
      return { ok: true, duplicate: false };
    },
  };
  return createOccupationService({ store: {}, journal: {}, scheduler: {}, clock: { now: () => 0 }, config,
    repository, fleets: null, getStations: () => null });
}

module.exports = ({ test }) => {
  test("WEC5 dropInfluenceInTx on a claimant: no flag -> NOT_CONTROLLER, allowNonController true -> APPLIED "
    + "on its row, a non-boolean flag -> OCCUPATION_INVALID_INPUT", () => {
    const writes = [];
    const svc = serviceWith(writes);
    const spec = { systemId: SYSTEM, factionId: SANSHA, points: 20, at: 1000, reason: "EVENT_CLEARED" };
    const got = [
      svc.dropInfluenceInTx(TX, spec, "k:plain"),
      svc.dropInfluenceInTx(TX, { ...spec, allowNonController: false }, "k:false"),
      svc.dropInfluenceInTx(TX, { ...spec, allowNonController: "yes" }, "k:yes"),
    ];
    assert.deepStrictEqual(got, [{ ok: false, reason: "NOT_CONTROLLER" }, { ok: false, reason: "NOT_CONTROLLER" },
      { ok: false, reason: "OCCUPATION_INVALID_INPUT" }]);
    assert.deepStrictEqual(writes, []);
    const applied = svc.dropInfluenceInTx(TX, { ...spec, allowNonController: true }, "k:true");
    assert.deepStrictEqual(applied, { ok: true, outcome: "APPLIED", written: true, before: 60, next: 40, drifted: 0,
      banked: false, state: "CONTESTED", phaseSeq: 3 });
    assert.deepStrictEqual(writes, [[{ systemId: SYSTEM, expectedVersion: 7, reason: "EVENT_CLEARED", state: {},
      influence: [{ factionId: SANSHA, influenceScore: 40 }] }, "k:true"]]);
  });
};
