"use strict";

const stage = (key, role, kind, tier, slots, repeat, prerequisites, unlock) => Object.freeze({ key, role, kind, tier,
  slots, repeat, prerequisites: Object.freeze(prerequisites), unlock });

const HQ_UNLOCK = Object.freeze({ influenceAtLeast: "hqUnlock" });
const COMPLETION = Object.freeze({ stage: "hq" });

const INVADER_STAGES = Object.freeze([
  stage("staging", "staging", "staging", 1, 1, true, [], null),
  stage("vanguard", "vanguard", "breach", 1, 1, true, [], null),
  stage("assault", "assault", "staging", 2, 1, true, [], null),
  stage("hq", "hq", "breach", 3, 1, false, [], HQ_UNLOCK),
]);

const RAIDER_STAGES = Object.freeze([
  stage("staging", "staging", "warcamp", 1, 1, true, [], null),
  stage("vanguard", "vanguard", "hideout", 1, 1, true, [], null),
  stage("assault", "assault", "warcamp", 2, 1, true, [], null),
  stage("hq", "hq", "hideout", 3, 1, false, [], HQ_UNLOCK),
]);

const entry = (label, empire, stages) => Object.freeze({ label, empire, stages, completion: COMPLETION });

const FACTIONS = Object.freeze({
  500001: entry("Caldari State", true, RAIDER_STAGES),
  500002: entry("Minmatar Republic", true, RAIDER_STAGES),
  500003: entry("Amarr Empire", true, RAIDER_STAGES),
  500004: entry("Gallente Federation", true, RAIDER_STAGES),
  500010: entry("Guristas", false, RAIDER_STAGES),
  500011: entry("Angel Cartel", false, RAIDER_STAGES),
  500012: entry("Blood Raiders", false, RAIDER_STAGES),
  500020: entry("Serpentis", false, RAIDER_STAGES),
  500024: entry("Drifters", false, INVADER_STAGES),
  500026: entry("Triglavian", false, INVADER_STAGES),
});

const FACTION_IDS = Object.freeze(Object.keys(FACTIONS).map(Number).sort((a, b) => a - b));
const EMPIRE_FACTION_IDS = Object.freeze(FACTION_IDS.filter((id) => FACTIONS[id].empire === true));

function rulesOf(factionId) {
  const f = Object.prototype.hasOwnProperty.call(FACTIONS, factionId) ? FACTIONS[factionId] : null;
  if (!f) return null;
  return JSON.parse(JSON.stringify({ stages: f.stages, completion: f.completion }));
}

module.exports = { FACTIONS, FACTION_IDS, EMPIRE_FACTION_IDS, rulesOf };
