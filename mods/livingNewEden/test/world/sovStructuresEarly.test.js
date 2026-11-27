"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const OS = require("../../lib/world/occupation/schema");
const M = require("../../lib/world/occupation/machine");
const SOV = require("../../lib/world/sovStructures/schema");
const { harness: X } = require("./sovStructures.test");

const { view, sovOf, ref, tick, PARAMS, AMARR, SANSHA, HOUR, configOf } = X;
const MOD_DIR = path.resolve(__dirname, "..", "..");
const REPO_DIR = path.resolve(MOD_DIR, "..", "..");
const STRUCT = "sovg:30002000:500003:1";
const EARLY_AT = 3 * HOUR;

const sovE = (structures, early = true, extra = {}) => ({ ...sovOf(structures), siegeHoldMs: HOUR,
  pauseWhenObserved: true, observed: false, anchorMs: HOUR, adoptPending: false, earlyTimers: early, ...extra });
const at = (o, when) => Object.assign(view({ ...o, at: when }), { evaluatedAt: when - 900000 });
const grandfathered = () => ({ ...ref(AMARR, SOV.ONLINE, STRUCT), origin: SOV.GRANDFATHERED });
const besieged = (since) => ({ ...grandfathered(), version: 2, attackerFactionId: SANSHA, attackStartedAt: since });

module.exports = ({ test }) => {
  test("SOVE1 free system: hold not over, no structure -> flag on ANCHOR {P, claimSeq}, to null; flag off -> no op, "
    + "the same notes and statePatch as without the field", () => {
    const plain = M.evaluate(at({ controller: null, influence: { [SANSHA]: 80 } }, EARLY_AT), tick, PARAMS);
    const onSov = M.evaluate(at({ controller: null, influence: { [SANSHA]: 80 }, sov: sovE([]) }, EARLY_AT),
      tick, PARAMS);
    const off = M.evaluate(at({ controller: null, influence: { [SANSHA]: 80 }, sov: sovE([], false) }, EARLY_AT),
      tick, PARAMS);
    const today = M.evaluate(at({ controller: null, influence: { [SANSHA]: 80 },
      sov: (({ earlyTimers, ...rest }) => rest)(sovE([])) }, EARLY_AT), tick, PARAMS);
    assert.deepStrictEqual([onSov.to, onSov.sovOps, onSov.notes.includes(SOV.NOTES.ANCHOR_REQUESTED)],
      [null, [{ op: "ANCHOR", factionId: SANSHA, claimSeq: 4 }], true]);
    assert.deepStrictEqual([off.to, off.sovOps], [null, []]);
    assert.deepStrictEqual(off, today, "earlyTimers false = bit for bit as before");
    assert.deepStrictEqual([off.notes, off.statePatch], [plain.notes, plain.statePatch]);
  });

  test("SOVE2 captured system: live GRANDFATHERED of C, hold not over -> ATTACK; hold + siege over but score(P) < "
    + "occupyMinScore -> no DESTROY, controller C; every condition -> DESTROY SIEGE + controller null", () => {
    const attack = M.evaluate(at({ sov: sovE([grandfathered()]) }, EARLY_AT), tick, PARAMS);
    const weak = M.evaluate(at({ influence: { [SANSHA]: 40, [AMARR]: 10 }, sov: sovE([besieged(EARLY_AT)]) },
      7 * HOUR), tick, PARAMS);
    const ready = M.evaluate(at({ sov: sovE([besieged(EARLY_AT)]) }, 7 * HOUR), tick, PARAMS);
    assert.deepStrictEqual({
      attack: [attack.to, attack.sovOps, attack.notes.includes(SOV.NOTES.SIEGE_STARTED)],
      weak: [weak.to, weak.sovOps, weak.statePatch.controllerFactionId],
      ready: [ready.to, ready.sovOps, ready.statePatch.controllerFactionId, ready.statePatch.previousControllerFactionId],
    }, {
      attack: [null, [{ op: "ATTACK", structureId: STRUCT, factionId: SANSHA, version: 1 }], true],
      weak: [null, [], AMARR],
      ready: [null, [{ op: "DESTROY", structureId: STRUCT, reason: "SIEGE", byFactionId: SANSHA, version: 2 }],
        null, AMARR],
    });
  });

  test("SOVE3 own structure ONLINE before the hold: to null, no BIND; every condition -> OCCUPIED + BIND", () => {
    const own = ref(SANSHA, SOV.ONLINE);
    const early = M.evaluate(at({ controller: null, influence: { [SANSHA]: 80 }, sov: sovE([own]) }, EARLY_AT),
      tick, PARAMS);
    const done = M.evaluate(at({ controller: null, influence: { [SANSHA]: 80 }, sov: sovE([own]) }, 7 * HOUR),
      tick, PARAMS);
    assert.deepStrictEqual({ early: [early.to, early.sovOps], done: [done.to, done.sovOps] }, {
      early: [null, []],
      done: [OS.OCCUPIED, [{ op: "BIND", structureId: own.structureId, capturedAt: 7 * HOUR }]],
    });
  });

  test("SOVE4 exclusions: adoptPending -> note only; player claim, defender station, exempt kind, home reclaim -> "
    + "no op; H !== P -> CONTESTED + INTERRUPTED without an early op", () => {
    const ev = (o, sov) => M.evaluate(at({ controller: null, influence: { [SANSHA]: 80 }, ...o, sov }, EARLY_AT),
      tick, PARAMS);
    const adopt = M.evaluate(at({ sov: sovE([], true, { adoptPending: true }) }, EARLY_AT), tick, PARAMS);
    const player = M.evaluate(Object.assign(at({ controller: null, influence: { [SANSHA]: 80 }, sov: sovE([]) },
      EARLY_AT), { playerClaim: { claimId: "pc:1", state: "ONLINE", version: 1 } }), tick, PARAMS);
    const station = M.evaluate(Object.assign(at({ sov: sovE([]) }, EARLY_AT), { stations: new Map([[AMARR, 1]]) }),
      tick, PARAMS);
    const exempt = ev({}, { ...sovE([]), needs: (f) => f !== SANSHA });
    const home = M.evaluate(Object.assign(at({ controller: null, influence: { [SANSHA]: 80 }, sov: sovE([]) },
      EARLY_AT), { home: SANSHA }), tick, PARAMS);
    const lost = M.evaluate(at({ presence: { [AMARR]: 100 }, sov: sovE([]) }, EARLY_AT), tick, PARAMS);
    assert.deepStrictEqual({
      adopt: [adopt.sovOps, adopt.notes.includes(SOV.NOTES.ADOPT_PENDING)],
      player: player.sovOps, station: station.sovOps, exempt: exempt.sovOps, home: home.sovOps,
      lost: [lost.to, lost.sovOps, lost.notes.includes("INTERRUPTED")],
    }, {
      adopt: [[], true], player: [], station: [], exempt: [], home: [], lost: [OS.CONTESTED, [], true],
    });
  });

  test("SOVE5 config: earlyTimersEnabled true, anchorMs 3600000, maxAnchoringPerFaction 6; env 0 -> false; "
    + "compose passes the three keys", () => {
    const d = configOf().sovStructures;
    const off = configOf({ EVEJS_LNE_SOV_STRUCTURES_EARLY_TIMERS_ENABLED: "0" }).sovStructures;
    const blank = configOf({ EVEJS_LNE_SOV_STRUCTURES_ANCHOR_MS: "",
      EVEJS_LNE_SOV_STRUCTURES_MAX_ANCHORING_PER_FACTION: "" }).sovStructures;
    assert.deepStrictEqual([d.earlyTimersEnabled, d.anchorMs, d.maxAnchoringPerFaction, off.earlyTimersEnabled,
      blank.anchorMs, blank.maxAnchoringPerFaction], [true, 3600000, 6, false, 3600000, 6]);
    const compose = fs.readFileSync(path.join(REPO_DIR, "compose.yaml"), "utf8");
    for (const line of [
      "EVEJS_LNE_SOV_STRUCTURES_EARLY_TIMERS_ENABLED: ${EVEJS_LNE_SOV_STRUCTURES_EARLY_TIMERS_ENABLED:-1}",
      "EVEJS_LNE_SOV_STRUCTURES_ANCHOR_MS: ${EVEJS_LNE_SOV_STRUCTURES_ANCHOR_MS:-}",
      "EVEJS_LNE_SOV_STRUCTURES_MAX_ANCHORING_PER_FACTION: ${EVEJS_LNE_SOV_STRUCTURES_MAX_ANCHORING_PER_FACTION:-}",
    ]) assert.ok(compose.includes(line), line);
  });

  test("SOVE6: C without a structure, score(C) > occupyMaxDefenderScore -> no early ANCHOR (also "
    + "after the hold); score(C) <= threshold -> ANCHOR; flag off bit for bit as before", () => {
    const exemptC = { needs: (f) => f !== AMARR };
    const ev = (amarr, sov, when) => M.evaluate(at({ influence: { [SANSHA]: 80, [AMARR]: amarr }, sov }, when),
      tick, PARAMS);
    const strong = ev(70, sovE([], true, exemptC), EARLY_AT);
    const weak = ev(10, sovE([], true, exemptC), EARLY_AT);
    const afterHold = ev(70, sovE([], true, exemptC), 7 * HOUR);
    const off = ev(70, sovE([], false, exemptC), EARLY_AT);
    const today = ev(70, (({ earlyTimers, ...rest }) => rest)(sovE([], true, exemptC)), EARLY_AT);
    assert.deepStrictEqual({
      strong: [strong.sovOps, strong.notes.includes(SOV.NOTES.ANCHOR_REQUESTED)],
      weak: weak.sovOps,
      afterHold: [afterHold.sovOps, afterHold.notes.includes(SOV.NOTES.ANCHOR_REQUESTED)],
    }, {
      strong: [[], false],
      weak: [{ op: "ANCHOR", factionId: SANSHA, claimSeq: 4 }],
      afterHold: [[], false],
    });
    assert.deepStrictEqual(off, today, "earlyTimers false = bit for bit as before");
  });
};
