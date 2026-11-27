"use strict";

const assert = require("node:assert");

const { planSentryBattle } = require("../../lib/sentries/battlePlan");
const { sentryGridScopeOf } = require("../../lib/sentries/gridScope");
const { GROUPS: STRENGTH_GROUPS } = require("../../lib/battle/data/strengthCatalog");
const { expandStrengthGroups } = require("../../lib/battle/strength");
const { capitalPowerOverlayOf } = require("../../lib/battle/data/capitalStrengthRows");

const GROUPS = expandStrengthGroups(STRENGTH_GROUPS, null, capitalPowerOverlayOf(undefined));
const SYS = 30002000;
const OWNER = 500020;
const ENEMY = 500010;
const GATE = 50001001;
const STATION = 60001001;
const GATE_GRID = `gate:${GATE}`;
const STATION_GRID = `station:${STATION}`;
const SETTINGS = Object.freeze({ maxFleetsPerSide: 4, maxSentriesPerBattle: 4, damageTakenPermille: 1000,
  attackerRetreatLossPermille: 300 });

const fleet = (fleetId, count) => ({ fleetId, factionId: ENEMY, version: 2, fleetRole: "patrol", state: "STAGED",
  shipCount: count, currentSystemId: SYS, composition: [{ hullGroup: "cruiser", count }] });
const sentry = (n, anchorKind, anchorId) => ({ sentryId: `sf-${n}`, itemId: 7000 + n, typeId: 340501,
  ownerKind: "faction", factionId: OWNER, characterId: null, systemId: SYS, anchorKind, anchorId, hp: 1000, dps: 50,
  signature: 6000, designSig: 125 });

const GRIDS = Object.freeze([{ gridKey: GATE_GRID, anchors: [{ kind: "gate", id: GATE }] },
  { gridKey: STATION_GRID, anchors: [{ kind: "station", id: STATION }] }]);

module.exports = ({ test }) => {
  test("T1 grid planSentryBattle: the battle only in the grid of the fleet (gridKey), warp -> NO_GRID_CONTACT "
    + "without input.grid the result of before", () => {
    const sentries = [sentry(1, "gate", GATE), sentry(2, "station", STATION)];
    const fleets = [fleet("f-a", 10), fleet("f-warp", 30)];
    const base = { fleets, sentries, isHostileTo: (s, g) => g === ENEMY, groups: GROUPS, settings: SETTINGS };
    const positions = new Map([["f-a", { kind: "anchor", gridKey: STATION_GRID }], ["f-warp", { kind: "warp" }]]);
    const scope = sentryGridScopeOf({ positions, grids: GRIDS, sentries });
    assert.deepStrictEqual([...scope.gridOfSentry], [["sf-1", GATE_GRID], ["sf-2", STATION_GRID]]);

    const a = planSentryBattle({ ...base, grid: scope });
    assert.deepStrictEqual([a.battle.gridKey, a.battle.fleets, a.battle.fixedDefenses.entries.map((e) => e.sentryId),
      a.more], [STATION_GRID, [{ fleetId: "f-a", expectedVersion: 2 }], ["sf-2"], false]);

    const warp = sentryGridScopeOf({ positions: new Map([["f-a", { kind: "warp" }], ["f-warp", { kind: "warp" }]]),
      grids: GRIDS, sentries });
    assert.deepStrictEqual(planSentryBattle({ ...base, grid: warp }), { battle: null, reason: "NO_GRID_CONTACT" });

    const expected = { battle: { factionId: ENEMY, fleets: [{ fleetId: "f-warp", expectedVersion: 2 },
      { fleetId: "f-a", expectedVersion: 2 }], fixedDefenses: { attackerRetreatLossPermille: 300,
      entries: [1, 2].map((n) => ({ sentryId: `sf-${n}`, itemId: 7000 + n, typeId: 340501, ownerKind: "faction",
        ownerId: OWNER, hp: 1000, ehp: 1000, dps: 50, signature: 6000, designSig: 125 })) } }, more: false };
    assert.deepStrictEqual(planSentryBattle(base), expected);
    assert.deepStrictEqual(planSentryBattle({ ...base, grid: null }), expected);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(planSentryBattle(base).battle, "gridKey"), false);
  });
};
