"use strict";

const assert = require("node:assert");

const { planContact } = require("../../lib/battle/contacts");
const { createContactService } = require("../../lib/battle/contactService");
const { EVASIVE_ROLES, TRIP_FIGHTABLE_ROLES } = require("../../lib/battle/data/contactRules");
const { createHostility } = require("../../lib/battle/data/hostility");
const { SCHEMA } = require("../../config");

const CAPS = 500018;
const SANSHA = 500019;
const SYSTEM = 30000142;
const isHostile = createHostility();
const LIMITS = Object.freeze({ maxFleetsPerSide: 8, maxSettlementRows: 450 });

const fl = (fleetId, factionId, fleetRole, operationId) => ({ fleetId, factionId, fleetRole, operationId,
  state: "STAGED", shipCount: 2, version: 1, composition: [{ hullGroup: "cruiser", typeId: null, count: 2 }] });

const tripEvasive = (f) => EVASIVE_ROLES.includes(f.fleetRole)
  && !(TRIP_FIGHTABLE_ROLES.includes(f.fleetRole) && f.operationId !== null && f.operationId !== undefined);

const plan = (fleets, evasiveOf) => planContact({ fleets, triggerFleetId: "p1", isHostile, cooldowns: new Map(),
  at: 0, limits: LIMITS, evasiveOf });

function contactOf(fightable) {
  const created = [];
  const counters = {};
  const fleets = [fl("p1", SANSHA, "patrol", "op-raid"), fl("c1", CAPS, "capsuleer", "op-rat")];
  const svc = createContactService({
    store: { transaction: (name, fn) => ({ ok: true, value: fn({ inTransaction: true }) }) },
    scheduler: { enqueue: () => ({ ok: true }) },
    battleRepository: { createBattle: (tx, spec) => {
      created.push(spec);
      return { ok: true, battleId: "b1", duplicate: false };
    } },
    cooldownRepository: { listForSystem: () => ({ ok: true, cooldowns: new Map() }) },
    fleetRepository: { listFleetsInSystem: () => ({ ok: true, fleets, nextAfterFleetId: null }),
      getOperation: (tx, operationId) => ({ ok: true, operation: { operationId, objective: "raid" } }) },
    getGraph: () => ({ getSystem: (id) => ({ systemId: id, secClass: "lowsec" }) }),
    worldRepository: null, resolverVersion: "internal-v1",
    settings: { engageDelayMs: 1000, recontactCooldownMs: 1, contactScanMaxFleets: 64, maxResolutionMs: 20,
      influenceGarrison: "off", capsuleerTripsFightable: fightable },
    limits: LIMITS, isHostile,
    bump: (name, n = 1) => {
      counters[name] = (counters[name] || 0) + n;
    },
    logger: { log() {} }, isActive: () => true });
  const r = svc.onContactCheck({ payload: { systemId: SYSTEM, at: 0, triggerFleetId: "p1" } });
  if (r.outcome === "BATTLE") assert.ok(r.effect({ inTransaction: true }, { idempotencyKey: "contact:k" }).ok);
  return { outcome: r.outcome, created, counters };
}

module.exports = ({ test }) => {
  test("T1 planContact: pirate trigger + capsuleer on a trip, evasiveOf override -> A pirate, B 500018",
    () => {
      const r = plan([fl("p1", SANSHA, "patrol", "op-raid"), fl("c1", CAPS, "capsuleer", "op-rat")], tripEvasive);
      assert.ok(r.ok && r.contact, JSON.stringify(r));
      assert.deepStrictEqual([r.contact.sideA.factionId, r.contact.sideB.factionId,
        r.contact.sideB.fleets.map((f) => f.fleetId), r.contact.objectiveFleetId], [SANSHA, CAPS, ["c1"], "p1"]);
    });

  test("T2 planContact without evasiveOf: capsuleer on a trip stays evasive -> NO_HOSTILES (regression)", () => {
    const r = plan([fl("p1", SANSHA, "patrol", "op-raid"), fl("c1", CAPS, "capsuleer", "op-rat")], undefined);
    assert.deepStrictEqual([r.ok, r.contact, r.reason], [true, null, "NO_HOSTILES"]);
  });

  test("T3 planContact override, capsuleer without an operation (at base) -> NO_HOSTILES", () => {
    const r = plan([fl("p1", SANSHA, "patrol", "op-raid"), fl("c1", CAPS, "capsuleer", null)], tripEvasive);
    assert.deepStrictEqual([r.contact, r.reason], [null, "NO_HOSTILES"]);
  });

  test("T4 contactService: flag on -> battle + contacts.capsuleerTripContacts 1; off -> no battle; config "
    + "default false", () => {
    const on = contactOf(true);
    assert.strictEqual(on.outcome, "BATTLE");
    assert.deepStrictEqual([on.created.length, on.created[0].sideA.factionId, on.created[0].sideB.factionId,
      on.created[0].objective, on.counters["contacts.capsuleerTripContacts"]], [1, SANSHA, CAPS, "destroy", 1]);
    const off = contactOf(false);
    assert.deepStrictEqual([off.outcome, off.created.length, off.counters["contacts.capsuleerTripContacts"]],
      ["NO_HOSTILES", 0, undefined]);
    const row = SCHEMA.find((r) => r.key === "battle.capsuleerTripsFightable.enabled");
    assert.deepStrictEqual([row.type, row.default, row.env],
      ["boolean", false, "EVEJS_LNE_BATTLE_CAPSULEER_TRIPS_FIGHTABLE_ENABLED"]);
  });
};
