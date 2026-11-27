"use strict";

const assert = require("node:assert");

const { createContactService, arrivalKey, assemblyKey } = require("../../lib/battle/contactService");
const { createHostility } = require("../../lib/battle/data/hostility");

const SANSHA = 500019;
const SYSTEM = 30000142;
const OTHER = 30000144;
const AT = 1000000;
const LIMITS = Object.freeze({ maxFleetsPerSide: 8, maxSettlementRows: 450 });

const fleet = (fleetId, state, extra = {}) => ({ fleetId, factionId: SANSHA, fleetRole: "patrol", operationId: "op1",
  state, targetSystemId: SYSTEM, nextActionAt: null, shipCount: 2, version: 1,
  composition: [{ hullGroup: "cruiser", typeId: null, count: 2 }], ...extra });

const throwingRepo = () => new Proxy({}, { get: (_t, name) => () => {
  throw new Error(`read ${String(name)}`);
} });

function rig({ enabled = true, grace = 1800000, type = "raid", members = [], repo = null, locals = [],
  getOperation = null } = {}) {
  const enqueued = [];
  const created = [];
  const counters = {};
  const operation = { operationId: "op1", operationType: type, state: "ACTIVE", targetSystemId: SYSTEM,
    objective: "raid" };
  const fleetRepository = repo || {
    getFleet: (tx, id) => ({ ok: true, fleet: members.find((f) => f.fleetId === id) || null }),
    getOperation: getOperation || (() => ({ ok: true, operation })),
    listFleetsOfOperation: () => ({ ok: true, fleets: members, truncated: false }),
    listFleetsInSystem: () => ({ ok: true, fleets: [...members.filter((f) => f.state === "STAGED"), ...locals],
      nextAfterFleetId: null }),
  };
  const svc = createContactService({
    store: { transaction: (name, fn) => ({ ok: true, value: fn({ inTransaction: true }) }) },
    scheduler: { enqueue: (type, aggregateId, dueAt, payload, key) => {
      enqueued.push({ type, dueAt, payload, key });
      return { ok: true, duplicate: false };
    } },
    battleRepository: { createBattle: (tx, spec) => {
      created.push(spec);
      return { ok: true, battleId: "b1", duplicate: false };
    } },
    cooldownRepository: { listForSystem: () => ({ ok: true, cooldowns: new Map() }) },
    fleetRepository,
    getGraph: () => ({ getSystem: (id) => ({ systemId: id, secClass: "lowsec" }) }),
    worldRepository: null, resolverVersion: "internal-v1",
    settings: { engageDelayMs: 1000, recontactCooldownMs: 1, contactScanMaxFleets: 64, maxResolutionMs: 20,
      influenceGarrison: "off", assemblyEnabled: enabled, assemblyGraceMs: grace, assemblyRecheckMs: 60000,
      assemblyMaxRounds: 3 },
    limits: LIMITS, isHostile: createHostility(),
    bump: (name, n = 1) => {
      counters[name] = (counters[name] || 0) + n;
    },
    logger: { log() {} }, isActive: () => true });
  const arrive = () => svc.onArrival({ inTransaction: true },
    { fleetId: "f1", factionId: SANSHA, systemId: SYSTEM, at: AT, state: "STAGED", legSeq: 3, fleetRole: "patrol" });
  return { svc, enqueued, created, counters, arrive };
}

const arrEnqueue = { type: "BATTLE_CONTACT_CHECK", dueAt: AT, key: arrivalKey(SYSTEM, "f1", 3),
  payload: { systemId: SYSTEM, at: AT, triggerFleetId: "f1" } };

module.exports = ({ test }) => {
  test("AS1 flag on, raid of 2, second due +300000 -> one asm at +300000, no arr", () => {
    const r = rig({ members: [fleet("f1", "STAGED"), fleet("f2", "TRAVELLING", { nextActionAt: AT + 300000 })] });
    r.arrive();
    assert.deepStrictEqual(r.enqueued, [{ type: "BATTLE_CONTACT_CHECK", dueAt: AT + 300000,
      key: assemblyKey(SYSTEM, "f1", 3),
      payload: { systemId: SYSTEM, at: AT + 300000, triggerFleetId: "f1", assembly: true } }]);
    assert.strictEqual(assemblyKey(SYSTEM, "f1", 3), `contact:${SYSTEM}:asm:f1:3`);
    assert.deepStrictEqual(r.counters, { "contacts.assemblyDeferred": 1 });
  });

  test("AS2 grace 60000, last fleet at +300000 -> dueAt = at + 60000", () => {
    const r = rig({ grace: 60000, members: [fleet("f1", "STAGED"),
      fleet("f2", "TRAVELLING", { nextActionAt: AT + 100000 }), fleet("f3", "TRAVELLING", { nextActionAt: AT + 300000 })] });
    r.arrive();
    assert.deepStrictEqual([r.enqueued.length, r.enqueued[0].dueAt, r.enqueued[0].payload.at],
      [1, AT + 60000, AT + 60000]);
  });

  test("AS3 no member in flight (other target / already in) or a reinforce operation -> arr as before",
    () => {
      const none = rig({ members: [fleet("f1", "STAGED"), fleet("f2", "STAGED"),
        fleet("f3", "TRAVELLING", { nextActionAt: AT + 5000, targetSystemId: OTHER })] });
      none.arrive();
      assert.deepStrictEqual(none.enqueued, [arrEnqueue]);
      const reinforce = rig({ type: "reinforce",
        members: [fleet("f1", "STAGED"), fleet("f2", "TRAVELLING", { nextActionAt: AT + 300000 })] });
      reinforce.arrive();
      assert.deepStrictEqual([reinforce.enqueued, reinforce.counters], [[arrEnqueue], {}]);
    });

  test("AS4 asm check, a member TRAVELLING due <= p.at -> ASSEMBLY_SUPERSEDED + round 1, no battle", () => {
    const r = rig({ members: [fleet("f1", "STAGED"), fleet("f2", "TRAVELLING", { nextActionAt: AT + 300000 })] });
    const key = assemblyKey(SYSTEM, "f1", 3);
    const out = r.svc.onContactCheck({ idempotencyKey: key, payload: { systemId: SYSTEM, at: AT + 300000,
      triggerFleetId: "f1", assembly: true } });
    assert.deepStrictEqual([out, r.created.length, r.counters["contacts.assemblySuperseded"]],
      [{ ok: true, outcome: "ASSEMBLY_SUPERSEDED", reschedule: { dueAt: AT + 360000, idempotencyKey: `${key}:r1`,
        payload: { systemId: SYSTEM, at: AT + 360000, triggerFleetId: "f1", assembly: true, round: 1 } } }, 0, 1]);
  });

  const amarr = fleet("b1", "IDLE", { factionId: 500003, operationId: null, targetSystemId: null });

  test("AS6 a quarantined member (TRAVELLING, past nextActionAt): round 2 -> r3, round 3 -> the contact",
    () => {
      const members = [fleet("f1", "STAGED"), fleet("f2", "TRAVELLING", { nextActionAt: AT })];
      const key = `${assemblyKey(SYSTEM, "f1", 3)}:r2`;
      const r2 = rig({ members, locals: [amarr] });
      const out2 = r2.svc.onContactCheck({ idempotencyKey: key, payload: { systemId: SYSTEM, at: AT + 120000,
        triggerFleetId: "f1", assembly: true, round: 2 } });
      const r3 = rig({ members, locals: [amarr] });
      const out3 = r3.svc.onContactCheck({ idempotencyKey: `${assemblyKey(SYSTEM, "f1", 3)}:r3`,
        payload: { systemId: SYSTEM, at: AT + 180000, triggerFleetId: "f1", assembly: true, round: 3 } });
      assert.deepStrictEqual([out2.reschedule.idempotencyKey, out2.reschedule.payload.round, out3.outcome,
        typeof out3.effect, r3.counters["contacts.assemblyRoundsExhausted"]],
      [`${assemblyKey(SYSTEM, "f1", 3)}:r3`, 3, "BATTLE", "function", 1]);
    });

  test("AS7: an asm check whose member halted elsewhere (no member due) -> the ordinary contact", () => {
    const r = rig({ members: [fleet("f1", "STAGED"), fleet("f2", "HALTED", { targetSystemId: OTHER })],
      locals: [amarr] });
    const out = r.svc.onContactCheck({ idempotencyKey: `${assemblyKey(SYSTEM, "f1", 3)}:r1`,
      payload: { systemId: SYSTEM, at: AT + 60000, triggerFleetId: "f1", assembly: true, round: 1 } });
    out.effect({ inTransaction: true }, { idempotencyKey: "K" });
    assert.deepStrictEqual([out.outcome, r.created.length, r.created[0].sideA.factionId,
      r.counters["contacts.assemblySuperseded"], r.counters["contacts.assemblyRoundsExhausted"]],
    ["BATTLE", 1, SANSHA, undefined, undefined]);
  });

  test("AS8: a refused read of the operation on arrival -> the arr as before, contacts.assemblyReadFailed", () => {
    const r = rig({ members: [fleet("f1", "STAGED"), fleet("f2", "TRAVELLING", { nextActionAt: AT + 300000 })],
      getOperation: () => ({ ok: false, reason: "DB_BUSY" }) });
    r.arrive();
    assert.deepStrictEqual([r.enqueued, r.counters], [[arrEnqueue], { "contacts.assemblyReadFailed": 1 }]);
  });

  test("AS5 flag off -> the same arr enqueue, zero reads (throwing repository)", () => {
    const r = rig({ enabled: false, repo: throwingRepo() });
    r.arrive();
    assert.deepStrictEqual([r.enqueued, r.counters], [[arrEnqueue], {}]);
  });
};
