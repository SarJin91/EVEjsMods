"use strict";

const assert = require("node:assert");

const { formatFrontReply, formatRefusal, formatDuration } = require("../../lib/frontChat/format");

const GURISTAS = 500010;
const CALDARI = 500001;
const NAMES = new Map([[GURISTAS, "Guristas"], [CALDARI, "Caldari State"]]);
const OPTS = Object.freeze({ maxLines: 10, maxReplyChars: 1000, lineBreak: "<br>" });
const MIN = 60000;
const HOUR = 60 * MIN;

function contested() {
  return {
    systemId: 30000142, systemName: "Jita", regionId: 10000002, regionName: "The Forge", names: NAMES,
    card: { inWorld: true, system: { state: "CONTESTED", controller: CALDARI, occupier: null },
      progress: { state: "CONTESTED", attacker: GURISTAS, defender: CALDARI, ratio: 430, status: "ADVANCING",
        blockers: [], etaMs: HOUR + 20 * MIN, fallback: null },
      attackerInvasion: { state: "ACTIVE", withdrawMs: 3 * HOUR },
      fleets: { groups: [{ factionId: GURISTAS, role: "invasion", state: "IDLE", fleets: 3, ships: 30 },
        { factionId: CALDARI, role: "garrison", state: "IDLE", fleets: 2, ships: 12 },
        { factionId: GURISTAS, role: "raid", state: "IDLE", fleets: 1, ships: 8 }] },
      sieges: [{ siegeId: "s1" }], battles: [{ open: true }, { open: true }, { open: false }] },
    region: { systems: 87, tracked: 12, byState: [["STABLE", 9], ["CONTESTED", 2], ["INVASION", 1]],
      controllers: [{ factionId: GURISTAS, systems: 7 }, { factionId: CALDARI, systems: 5 }],
      contested: [
        { systemId: 30000144, name: "Perimeter", state: "CONTESTED", attacker: GURISTAS,
          progress: { status: "ADVANCING", ratio: 610, etaMs: 25 * MIN } },
        { systemId: 30000145, name: "Sobaseki", state: "INVASION", attacker: GURISTAS,
          progress: { status: "BLOCKED", ratio: 200, etaMs: null } }],
      truncated: false, tooLarge: false },
  };
}

module.exports = ({ test }) => {
  test("FC1 formatFrontReply: contested + region, outside the world + too large region, blocked + cut", () => {
    assert.deepStrictEqual(formatFrontReply(contested(), OPTS), [
      "LNE front - Jita (The Forge)",
      "System: CONTESTED, held by Caldari State, attacker Guristas",
      "Progress 43% (ADVANCING) - next phase in ~1 h 20 min",
      "Invasion withdraws in ~3 h",
      "Present: Guristas 4 fleets/38 ships, Caldari State 2/12 | Sieges: 1 | Open battles: 2",
      "Region The Forge: 87 systems, 12 tracked - Guristas 7, Caldari State 5; contested 3",
      " - Perimeter CONTESTED Guristas 61% ~25 min",
      " - Sobaseki INVASION Guristas 20% BLOCKED",
    ]);

    const outside = { systemId: 30000001, systemName: "Tanoo", regionId: 10000001, regionName: null, names: new Map(),
      card: { inWorld: false, system: null, progress: null, fleets: null, sieges: null, battles: null },
      region: { systems: 900, tracked: 0, byState: [], controllers: [], contested: [], truncated: false,
        tooLarge: true } };
    assert.deepStrictEqual(formatFrontReply(outside, OPTS), [
      "LNE front - Tanoo (unknown region)",
      "System: no LNE front here",
      "Region unknown region: 900 systems, too large to list",
    ]);
    const empty = { ...outside, regionName: "Derelik", region: { ...outside.region, systems: 3, tooLarge: false } };
    assert.strictEqual(formatFrontReply(empty, OPTS)[2], "Region Derelik: no LNE territory");

    const blocked = contested();
    blocked.card.progress = { ...blocked.card.progress, status: "BLOCKED", etaMs: null,
      blockers: ["NO_ATTACKER_FLEET", "FIELD_DISPUTED"] };
    blocked.card.attackerInvasion = null;
    const full = formatFrontReply(blocked, OPTS);
    assert.deepStrictEqual(full.slice(2, 4), ["Progress 43% (BLOCKED)", "BLOCKED: NO_ATTACKER_FLEET"]);
    assert.deepStrictEqual(formatFrontReply(blocked, { ...OPTS, maxLines: 3 }), full.slice(0, 3));
    const chars = 80;
    const cut = formatFrontReply(blocked, { ...OPTS, maxReplyChars: chars });
    assert.strictEqual(cut[0], "LNE front - Jita (The Forge)");
    assert.ok(cut.join("<br>").length <= chars, cut.join("<br>"));
    assert.ok(cut[cut.length - 1].endsWith("..."), JSON.stringify(cut));
    assert.strictEqual(cut.length, 2);

    const many = contested();
    many.card.fleets = { groups: [
      { factionId: GURISTAS, role: "invasion", state: "IDLE", fleets: 3, ships: 30 },
      { factionId: GURISTAS, role: "invasion", state: "ENGAGED", fleets: 2, ships: 20 },
      { factionId: GURISTAS, role: "raid", state: "IDLE", fleets: 1, ships: 8 },
      { factionId: GURISTAS, role: "patrol", state: "IDLE", fleets: 1, ships: 6 },
      { factionId: GURISTAS, role: "scout", state: "IDLE", fleets: 1, ships: 2 }],
    fleetsTotal: 10, shipsTotal: 67, truncated: true };
    many.fleets = { factions: [{ factionId: GURISTAS, fleets: 8, ships: 66 }, { factionId: CALDARI, fleets: 2,
      ships: 1 }], fleetsTotal: 10, shipsTotal: 67, truncated: false };
    assert.strictEqual(formatFrontReply(many, OPTS)[4],
      "Present: Guristas 8 fleets/66 ships, Caldari State 2/1 | Sieges: 1 | Open battles: 2");
    many.fleets = { ...many.fleets, truncated: true };
    assert.strictEqual(formatFrontReply(many, OPTS)[4],
      "Present: Guristas 8 fleets/66 ships, Caldari State 2/1, +more | Sieges: 1 | Open battles: 2");
    many.fleets = null;
    assert.strictEqual(formatFrontReply(many, OPTS)[4],
      "Present: Guristas 8 fleets/66 ships, +more (total 10/67) | Sieges: 1 | Open battles: 2");

    assert.deepStrictEqual([formatDuration(45000), formatDuration(12 * MIN), formatDuration(HOUR + 20 * MIN),
      formatDuration(51 * HOUR)], ["~45 s", "~12 min", "~1 h 20 min", "~2 d 3 h"]);
    assert.strictEqual(formatRefusal("RATE_LIMITED", { waitMs: 4000 }), "LNE front: wait ~4 s before the next !front");
    assert.strictEqual(formatRefusal("UNAVAILABLE", { detail: "STORE_CLOSED" }), "LNE front unavailable (STORE_CLOSED)");
  });
};
