"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { UNKNOWN } = require("../../lib/names/fallback");
const { formatNoticeLine } = require("../../lib/notices/format");
const { formatAwardLine } = require("../../lib/warContracts/format");

const LIB = path.join(__dirname, "..", "..", "lib");
const FILES = [
  "battleAnnounce/service.js",
  "economy/trade/deliveryStanding.js",
  "economy/trade/executorRules.js",
  "escalations/plan.js",
  "frontChat/format.js",
  "frontJobs/rules.js",
  "heavyEvents/planner.js",
  "jobBoard/readModel.js",
  "notices/format.js",
  "shipAi/tools/catalogDb.js",
  "shipAi/tools/deps.js",
  "shipAi/dscan/index.js",
  "shipAi/proactive.js",
  "warContracts/format.js",
  "warContracts/rules.js",
];
const ID_TEXT = /`(system|System|faction|Faction|type|alliance|structure \(type|owner) #?\$\{/;
const HASH_ID = /`#\$\{/;

module.exports = ({ test }) => {
  test("F1 the player-facing files interpolate no bare ID into a fallback text", () => {
    assert.ok(Object.isFrozen(UNKNOWN));
    const hits = [];
    for (const rel of FILES) {
      const lines = fs.readFileSync(path.join(LIB, rel), "utf8").split(/\r?\n/);
      lines.forEach((line, i) => {
        if (ID_TEXT.test(line) || HASH_ID.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    assert.deepStrictEqual(hits, []);
  });

  test("F2 notices/format and warContracts/format with a missing name read UNKNOWN.*", () => {
    const line = formatNoticeLine({ kind: "ATTACK_STARTED", attacker: 777, defender: 500001, systemId: 30001000,
      at: Date.UTC(2026, 0, 1, 14, 5) }, { names: new Map() });
    assert.ok(line.includes(`${UNKNOWN.faction} attack ${UNKNOWN.faction} in ${UNKNOWN.system}.`), line);
    assert.ok(!/\d{6}/.test(line), line);

    const award = formatAwardLine({ quantity: 4, typeId: 621, factionId: 500001, systemId: 30000142,
      rewardIsk: 1000000 }, { outcome: "DONE" }, {});
    assert.ok(award.includes(`4 x ${UNKNOWN.item} for ${UNKNOWN.faction} at ${UNKNOWN.system}`), award);
    for (const id of ["621", "500001", "30000142"]) assert.ok(!award.includes(id), award);
  });
};
