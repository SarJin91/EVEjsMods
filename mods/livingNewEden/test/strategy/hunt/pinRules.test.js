"use strict";

const assert = require("node:assert");
const { pinDurationMs, planPin, pickStrike } = require("../../../lib/strategy/hunt/pinRules");

const GROUPS = Object.freeze({
  frigate: { tackleFactor: 0.5, speedClass: 5, power: 1 },
  destroyer: { tackleFactor: 0.25, speedClass: 4, power: 2 },
  cruiser: { tackleFactor: 0, speedClass: 3, power: 3 },
  battlecruiser: { tackleFactor: 0, speedClass: 2, power: 5 },
  battleship: { tackleFactor: 0, speedClass: 2, power: 8 },
  logistics: { tackleFactor: 0, speedClass: 4, power: 1 },
  ewar: { tackleFactor: 0.5, speedClass: 3, power: 2 },
  tackle: { tackleFactor: 1, speedClass: 5, power: 2 },
  industrial: { tackleFactor: 0, speedClass: 2, power: 1 },
  capital: { tackleFactor: 0, speedClass: 1, power: 20 },
});

function strengthOf(composition, strengthGroups) {
  let total = 0;
  for (const entry of composition || []) {
    const g = strengthGroups[entry.hullGroup];
    if (g && g.power) total += entry.count * g.power;
  }
  return total;
}

const CFG = Object.freeze({
  pinBaseMs: 900000,
  pinMinMs: 120000,
  pinMaxMs: 1800000,
  speedPenaltyPermille: 500,
});

function hunterComp(hullGroup, count) {
  return {
    composition: [{ hullGroup, count }],
    strengthGroups: GROUPS,
  };
}

function targetComp(entries) {
  return {
    composition: entries.map(([hullGroup, count]) => ({ hullGroup, count })),
    strengthGroups: GROUPS,
  };
}

module.exports = ({ test }) => {
  test("pinRules pinDurationMs: hunter with tackle 2 vs 3 frigates -> cover 666‰, speed 1000‰, pin = 599400ms", () => {
    const hunter = hunterComp("tackle", 2);
    const target = targetComp([["frigate", 3]]);
    const r = pinDurationMs(hunter, target, CFG);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.tackle, 2);
    assert.strictEqual(r.coverPermille, 666);
    assert.strictEqual(r.vH, 5);
    assert.strictEqual(r.vT, 5);
    assert.strictEqual(r.k, 0);
    assert.strictEqual(r.speedPermille, 1000);
    assert.strictEqual(r.pinMs, 599400);
  });

  test("pinRules pinDurationMs: hunter with tackle 2 + frigate 2 vs 6 frigates -> cover 500‰", () => {
    const hunter = {
      composition: [{ hullGroup: "tackle", count: 2 }, { hullGroup: "frigate", count: 2 }],
      strengthGroups: GROUPS,
    };
    const target = targetComp([["frigate", 6]]);
    const r = pinDurationMs(hunter, target, CFG);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.tackle, 2 * 1 + 2 * 0.5);
    assert.strictEqual(r.coverPermille, 500);
    assert.strictEqual(r.vH, 5);
    assert.strictEqual(r.vT, 5);
    assert.strictEqual(r.k, 0);
    assert.strictEqual(r.speedPermille, 1000);
    assert.strictEqual(r.pinMs, 450000);
  });

  test("pinRules pinDurationMs: target faster than hunter -> speed penalty reduces pin", () => {
    const hunter = hunterComp("cruiser", 5);
    const target = targetComp([["frigate", 3]]);
    const r = pinDurationMs(hunter, target, CFG);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, "NO_TACKLE");
  });

  test("pinRules pinDurationMs: hunter ewar (tackleFactor 0.5, speedClass 3) vs target frigate (5) -> k=2", () => {
    const hunter = hunterComp("ewar", 4);
    const target = targetComp([["frigate", 3]]);
    const r = pinDurationMs(hunter, target, CFG);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.tackle, 2);
    assert.strictEqual(r.coverPermille, 666);
    assert.strictEqual(r.vH, 3);
    assert.strictEqual(r.vT, 5);
    assert.strictEqual(r.k, 2);
    assert.strictEqual(r.speedPermille, 500);
    assert.strictEqual(r.pinMs, 299700);
  });

  test("pinRules pinDurationMs: pinMs < pinMinMs -> NO_TACKLE", () => {
    const hunter = hunterComp("tackle", 1);
    const target = targetComp([["frigate", 20]]);
    const r = pinDurationMs(hunter, target, CFG);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, "NO_TACKLE");
    assert.ok(r.pinMs < CFG.pinMinMs);
  });

  test("pinRules pinDurationMs: empty target or hunter -> NO_TACKLE", () => {
    const hunter = hunterComp("tackle", 2);
    const emptyTarget = { composition: [], strengthGroups: GROUPS };
    let r = pinDurationMs(hunter, emptyTarget, CFG);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, "NO_TACKLE");

    const emptyHunter = { composition: [], strengthGroups: GROUPS };
    r = pinDurationMs(emptyHunter, targetComp([["frigate", 3]]), CFG);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, "NO_TACKLE");
  });

  test("pinRules planPin: returns pin row with correct fields (accepts pinId and idempotencyKey)", () => {
    const pin = planPin({
      hunterFleetId: "hunter-1",
      targetFleetId: "target-1",
      systemId: 30000001,
      hunterFactionId: 500019,
      targetFactionId: 500010,
      at: 1000000,
      pinMs: 900000,
      pinId: "hp1234567890123456",
      idempotencyKey: "hunt:scan:30000001:arr:hunter-1:1:pin",
    });
    assert.strictEqual(pin.ok, true);
    assert.strictEqual(pin.hunterFleetId, "hunter-1");
    assert.strictEqual(pin.targetFleetId, "target-1");
    assert.strictEqual(pin.systemId, 30000001);
    assert.strictEqual(pin.hunterFactionId, 500019);
    assert.strictEqual(pin.targetFactionId, 500010);
    assert.strictEqual(pin.pinnedAt, 1000000);
    assert.strictEqual(pin.untilAt, 1000000 + 900000);
    assert.strictEqual(pin.pinMs, 900000);
    assert.strictEqual(pin.state, "ACTIVE");
    assert.strictEqual(pin.pinId, "hp1234567890123456");
    assert.strictEqual(pin.idempotencyKey, "hunt:scan:30000001:arr:hunter-1:1:pin");
  });

  test("pinRules planPin: returns INVALID_PIN_MS for pinMs <= 0", () => {
    const pin = planPin({
      hunterFleetId: "hunter-1",
      targetFleetId: "target-1",
      systemId: 30000001,
      hunterFactionId: 500019,
      targetFactionId: 500010,
      at: 1000000,
      pinMs: 0,
      pinId: "hp1234567890123456",
      idempotencyKey: "hunt:scan:30000001:arr:hunter-1:1:pin",
    });
    assert.strictEqual(pin.ok, false);
    assert.strictEqual(pin.reason, "INVALID_PIN_MS");
  });

  test("pinRules pickStrike: picks first candidate with sufficient strength and ETA", () => {
    const candidates = [
      { fleetId: "strike-1", fleetRole: "patrol", systemId: 30000002, composition: [{ hullGroup: "frigate", count: 5 }], shipCount: 5, refitPending: false, jumps: 2, strengthGroups: GROUPS },
      { fleetId: "strike-2", fleetRole: "invasion", systemId: 30000003, composition: [{ hullGroup: "cruiser", count: 3 }], shipCount: 3, refitPending: false, jumps: 1, strengthGroups: GROUPS },
    ];
    const jumpMsForComposition = () => ({ ok: true, baseJumpMs: 60000 });
    const r = pickStrike({
      candidateFleets: candidates,
      targetSystemId: 30000001,
      targetStrength: 10,
      hunterStrength: 3,
      pinMs: 900000,
      cfg: {
        strikeRoles: ["invasion", "patrol"],
        strikeMaxJumps: 5,
        pinGraceMs: 30000,
        attackStrengthRatio: 1.5,
        travelTimeFactor: 1,
        jumpMsForComposition,
        strengthOf,
      },
    });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, "NO_SUITABLE_STRIKE");
  });

  test("pinRules pickStrike: picks candidate when strength sufficient", () => {
    const candidates = [
      { fleetId: "strike-1", fleetRole: "invasion", systemId: 30000002, composition: [{ hullGroup: "cruiser", count: 10 }], shipCount: 10, refitPending: false, jumps: 2, strengthGroups: GROUPS },
      { fleetId: "strike-2", fleetRole: "patrol", systemId: 30000003, composition: [{ hullGroup: "frigate", count: 5 }], shipCount: 5, refitPending: false, jumps: 1, strengthGroups: GROUPS },
    ];
    const jumpMsForComposition = () => ({ ok: true, baseJumpMs: 60000 });
    const r = pickStrike({
      candidateFleets: candidates,
      targetSystemId: 30000001,
      targetStrength: 5,
      hunterStrength: 2,
      pinMs: 900000,
      cfg: {
        strikeRoles: ["invasion", "patrol"],
        strikeMaxJumps: 5,
        pinGraceMs: 30000,
        attackStrengthRatio: 1.5,
        travelTimeFactor: 1,
        jumpMsForComposition,
        strengthOf,
      },
    });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.fleetId, "strike-1");
    assert.strictEqual(r.jumps, 2);
    assert.strictEqual(r.etaMs, 120000);
    assert.strictEqual(r.strength, 30);
  });

  test("pinRules pickStrike: respects strikeMaxJumps", () => {
    const candidates = [
      { fleetId: "strike-far", fleetRole: "invasion", systemId: 30000002, composition: [{ hullGroup: "cruiser", count: 10 }], shipCount: 10, refitPending: false, jumps: 10, strengthGroups: GROUPS },
    ];
    const jumpMsForComposition = () => ({ ok: true, baseJumpMs: 60000 });
    const r = pickStrike({
      candidateFleets: candidates,
      targetSystemId: 30000001,
      targetStrength: 5,
      hunterStrength: 2,
      pinMs: 900000,
      cfg: {
        strikeRoles: ["invasion", "patrol"],
        strikeMaxJumps: 5,
        pinGraceMs: 30000,
        attackStrengthRatio: 1.5,
        travelTimeFactor: 1,
        jumpMsForComposition,
        strengthOf,
      },
    });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, "NO_SUITABLE_STRIKE");
  });

  test("pinRules pickStrike: respects refit_pending", () => {
    const candidates = [
      { fleetId: "strike-refit", fleetRole: "invasion", systemId: 30000002, composition: [{ hullGroup: "cruiser", count: 10 }], shipCount: 10, refitPending: true, jumps: 1, strengthGroups: GROUPS },
    ];
    const jumpMsForComposition = () => ({ ok: true, baseJumpMs: 60000 });
    const r = pickStrike({
      candidateFleets: candidates,
      targetSystemId: 30000001,
      targetStrength: 5,
      hunterStrength: 2,
      pinMs: 900000,
      cfg: {
        strikeRoles: ["invasion", "patrol"],
        strikeMaxJumps: 5,
        pinGraceMs: 30000,
        attackStrengthRatio: 1.5,
        travelTimeFactor: 1,
        jumpMsForComposition,
        strengthOf,
      },
    });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, "NO_SUITABLE_STRIKE");
  });

  test("pinRules pickStrike: respects pinGraceMs + eta <= pinMs", () => {
    const candidates = [
      { fleetId: "strike-slow", fleetRole: "invasion", systemId: 30000002, composition: [{ hullGroup: "cruiser", count: 10 }], shipCount: 10, refitPending: false, jumps: 20, strengthGroups: GROUPS },
    ];
    const jumpMsForComposition = () => ({ ok: true, baseJumpMs: 60000 });
    const r = pickStrike({
      candidateFleets: candidates,
      targetSystemId: 30000001,
      targetStrength: 5,
      hunterStrength: 2,
      pinMs: 900000,
      cfg: {
        strikeRoles: ["invasion", "patrol"],
        strikeMaxJumps: 25,
        pinGraceMs: 30000,
        attackStrengthRatio: 1.5,
        travelTimeFactor: 1,
        jumpMsForComposition,
        strengthOf,
      },
    });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, "NO_SUITABLE_STRIKE");
  });

  test("pinRules pickStrike: uses travelTimeFactor for ETA (fix)", () => {
    const candidates = [
      { fleetId: "strike-normal", fleetRole: "invasion", systemId: 30000002, composition: [{ hullGroup: "cruiser", count: 10 }], shipCount: 10, refitPending: false, jumps: 5, strengthGroups: GROUPS },
    ];
    const jumpMsForComposition = (comp, opts) => ({ ok: true, baseJumpMs: 60000 * (opts?.timeFactor || 1) });
    const r1 = pickStrike({
      candidateFleets: candidates,
      targetSystemId: 30000001,
      targetStrength: 5,
      hunterStrength: 2,
      pinMs: 900000,
      cfg: {
        strikeRoles: ["invasion", "patrol"],
        strikeMaxJumps: 10,
        pinGraceMs: 30000,
        attackStrengthRatio: 1.5,
        travelTimeFactor: 1,
        jumpMsForComposition,
        strengthOf,
      },
    });
    assert.strictEqual(r1.ok, true, "should pick with travelTimeFactor=1");
    assert.strictEqual(r1.etaMs, 300000);

    const r2 = pickStrike({
      candidateFleets: candidates,
      targetSystemId: 30000001,
      targetStrength: 5,
      hunterStrength: 2,
      pinMs: 900000,
      cfg: {
        strikeRoles: ["invasion", "patrol"],
        strikeMaxJumps: 10,
        pinGraceMs: 30000,
        attackStrengthRatio: 1.5,
        travelTimeFactor: 2,
        jumpMsForComposition,
        strengthOf,
      },
    });
    assert.strictEqual(r2.ok, true, "should pick with travelTimeFactor=2");
    assert.strictEqual(r2.etaMs, 600000);

    const r3 = pickStrike({
      candidateFleets: candidates,
      targetSystemId: 30000001,
      targetStrength: 5,
      hunterStrength: 2,
      pinMs: 900000,
      cfg: {
        strikeRoles: ["invasion", "patrol"],
        strikeMaxJumps: 10,
        pinGraceMs: 30000,
        attackStrengthRatio: 1.5,
        travelTimeFactor: 4,
        jumpMsForComposition,
        strengthOf,
      },
    });
    assert.strictEqual(r3.ok, false);
    assert.strictEqual(r3.reason, "NO_SUITABLE_STRIKE");
  });

  const { decideScan, decideExpire } = require("../../../lib/strategy/hunt/pinRules");
  const { GROUPS: CATALOG } = require("../../../lib/battle/data/strengthCatalog");
  const { createHostility } = require("../../../lib/battle/data/hostility");
  const { pairKeyOf } = require("../../../lib/battle/contacts");
  const { TARGET_ROLES, STRIKE_ROLES, HOLD_STATES } = require("../../../lib/strategy/hunt/data/huntRules");
  const SYS = 30000206;
  const fleet = (fleetId, factionId, fleetRole, composition, o = {}) => ({ fleetId, factionId, fleetRole, composition,
    currentSystemId: SYS, state: "IDLE", version: 1, operationId: null, refitPending: false, legSeq: 0, ...o });
  const hunter = fleet("fleet_h", 500019, "hunter", [{ hullGroup: "tackle", count: 10 }], { state: "STAGED" });
  const target = fleet("fleet_t", 500010, "patrol", [{ hullGroup: "cruiser", count: 4 }]);
  const strike = fleet("fleet_s", 500019, "invasion", [{ hullGroup: "battleship", count: 20 }], { currentSystemId: 1 });
  const scanInput = (o = {}) => ({ at: 1000, systemId: SYS, hunters: [hunter], fleets: [hunter, target],
    truncated: false, pinnedHunters: new Set(), pinnedTargets: new Set(), activeTotal: 0, activeByFaction: new Map(),
    cooldowns: new Map(), candidates: new Map([[500019, [{ fleet: strike, jumps: 2, etaEstimateMs: 200000 }]]]),
    isHostile: createHostility(), groups: CATALOG, strengthOf: (c) => c.reduce((n, e) => n + e.count, 0), pairKeyOf,
    params: { targetRoles: TARGET_ROLES, strikeRoles: STRIKE_ROLES, holdStates: HOLD_STATES, pinBaseMs: 900000,
      pinMinMs: 120000, pinMaxMs: 1800000, speedPenaltyPermille: 500, maxActivePins: 64, maxActivePinsPerFaction: 2,
      strikeMaxJumps: 5, pinGraceMs: 30000, attackStrengthRatio: 1.2, maxHuntersPerScan: 4 }, ...o });

  test("pinRules decideScan (hunt): PIN baseline; SCAN_TRUNCATED, ALREADY_PINNING, NO_TARGET (friendly "
    + "pinned), NO_TACKLE, LIMIT_EXCEEDED, NO_STRIKE (jumps 0 / on an operation), ON_COOLDOWN past the ETA", () => {
    const ok = decideScan(scanInput());
    assert.strictEqual(ok.reason, "PIN");
    assert.deepStrictEqual([ok.pin.target.fleetId, ok.pin.strike.fleetId, ok.pin.pinMs], ["fleet_t", "fleet_s", 900000]);
    const reason = (o) => decideScan(scanInput(o)).reason;
    assert.strictEqual(reason({ truncated: true }), "SCAN_TRUNCATED");
    assert.strictEqual(reason({ pinnedHunters: new Set(["fleet_h"]) }), "ALREADY_PINNING");
    assert.strictEqual(reason({ pinnedTargets: new Set(["fleet_t"]) }), "NO_TARGET");
    assert.strictEqual(reason({ fleets: [hunter, { ...target, factionId: 500019 }] }), "NO_TARGET");
    assert.strictEqual(reason({ hunters: [{ ...hunter, composition: [{ hullGroup: "battleship", count: 1 }] }] }),
      "NO_TACKLE");
    assert.strictEqual(reason({ activeByFaction: new Map([[500019, 2]]) }), "LIMIT_EXCEEDED");
    assert.strictEqual(reason({ activeTotal: 64 }), "LIMIT_EXCEEDED");
    assert.strictEqual(reason({ candidates: new Map([[500019, [{ fleet: strike, jumps: 0, etaEstimateMs: 1 }]]]) }),
      "NO_STRIKE");
    assert.strictEqual(reason({ candidates: new Map([[500019, [{ fleet: { ...strike, operationId: "op_x" }, jumps: 2,
      etaEstimateMs: 200000 }]]]) }), "NO_STRIKE");
    const key = pairKeyOf(500019, 500010);
    assert.strictEqual(reason({ cooldowns: new Map([[key, 1000 + 200001]]) }), "ON_COOLDOWN");
    assert.strictEqual(reason({ cooldowns: new Map([[key, 1000 + 200000]]) }), "PIN", "cooldown over by the ETA");
  });

  test("pinRules decideExpire (hunt): PIN_GONE, ALREADY_CLOSED, CANCELLED (target gone / destroyed), ESCAPED "
    + "STRUCK by a later leg; strike in flight is not STRUCK", () => {
    const pin = { pinId: "hp_1", state: "ACTIVE", systemId: SYS, version: 1, detail: { strikeLegSeq: 3 } };
    const flying = { ...strike, state: "TRAVELLING", legSeq: 3 };
    const d = (o) => decideExpire({ pin, hunter, target, strike: flying, ...o });
    assert.deepStrictEqual(decideExpire({ pin: null }), { outcome: "PIN_GONE", close: false });
    assert.strictEqual(d({ pin: { ...pin, state: "CLOSED" } }).outcome, "ALREADY_CLOSED");
    assert.strictEqual(d({ target: null }).outcome, "CANCELLED");
    assert.strictEqual(d({ target: { ...target, state: "DESTROYED" } }).outcome, "CANCELLED");
    assert.deepStrictEqual(d({}), { outcome: "ESCAPED", close: true });
    assert.strictEqual(d({ strike: { ...flying, currentSystemId: SYS, state: "RETREATING", legSeq: 4 } }).outcome,
      "STRUCK");
    assert.strictEqual(d({ strike: { ...flying, currentSystemId: SYS } }).outcome, "ESCAPED", "still on its leg");
    assert.strictEqual(d({ hunter: { ...hunter, state: "TRAVELLING" } }).outcome, "BROKEN");
  });

  test("pinRules decideScan (hunt): one pin per scan - the first hunter by fleetId; a hunter outside the "
    + "system or in flight is skipped (NO_HUNTER)", () => {
    const h2 = { ...hunter, fleetId: "fleet_a" };
    const two = decideScan(scanInput({ hunters: [hunter, h2], fleets: [hunter, h2, target] }));
    assert.strictEqual(two.pin.hunter.fleetId, "fleet_a");
    assert.strictEqual(decideScan(scanInput({ hunters: [{ ...hunter, currentSystemId: 1 }] })).reason, "NO_HUNTER");
    assert.strictEqual(decideScan(scanInput({ hunters: [{ ...hunter, state: "TRAVELLING" }] })).reason, "NO_HUNTER");
  });
};