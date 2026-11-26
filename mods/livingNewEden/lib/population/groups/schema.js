"use strict";

const GROUP_KIND_NAMES = Object.freeze(["MINING_OP", "CONVOY", "RAT_GANG", "ROAM"]);

function codes(names) {
  return Object.freeze(Object.fromEntries(names.map((n, i) => [n, i + 1])));
}
const GROUP_KIND = codes(GROUP_KIND_NAMES);

const A_TRADER = 1;
const A_MINER = 2;
const A_RATTER = 3;
const A_EXPLORER = 4;
const A_COMMUTER = 5;

const KIND_BY_LEADER = Object.freeze({
  [A_MINER]: Object.freeze({ kind: GROUP_KIND.MINING_OP, main: Object.freeze([A_MINER]),
    escort: Object.freeze([A_RATTER]) }),
  [A_TRADER]: Object.freeze({ kind: GROUP_KIND.CONVOY, main: Object.freeze([A_TRADER, A_COMMUTER]),
    escort: Object.freeze([A_RATTER]) }),
  [A_RATTER]: Object.freeze({ kind: GROUP_KIND.RAT_GANG, main: Object.freeze([A_RATTER]), escort: Object.freeze([]) }),
  [A_EXPLORER]: Object.freeze({ kind: GROUP_KIND.ROAM, main: Object.freeze([A_EXPLORER]),
    escort: Object.freeze([A_RATTER]) }),
});

function kindSpecOf(archetype) {
  return Object.prototype.hasOwnProperty.call(KIND_BY_LEADER, archetype) ? KIND_BY_LEADER[archetype] : null;
}

const MEMBER_FIELDS = Object.freeze(["systemId", "prevId", "destId", "intent", "state", "dueAt"]);

const DISSOLVE_REASONS = Object.freeze(["END", "LIFETIME", "POD", "EMPTY"]);

const GROUP_REC_BYTES = 32;
const GROUP_MEMBER_BYTES = 8;

const nameOf = (names, code) => (Number.isInteger(code) && code >= 1 && code <= names.length ? names[code - 1] : null);

function groupsSettingsOf(P) {
  const G = P && P.groups && typeof P.groups === "object" ? P.groups : {};
  const minMembers = Number.isFinite(G.minMembers) && Number.isFinite(G.maxSize) && G.minMembers > G.maxSize
    ? G.maxSize : G.minMembers;
  return Object.freeze({ ...G, enabled: G.enabled === true, minMembers, liveSpawnEnabled: G.liveSpawnEnabled === true });
}

const DDL = `
ALTER TABLE world_npc_pilots ADD COLUMN group_id INTEGER NOT NULL DEFAULT 0;
`;

function upPopulationGroups(db) {
  db.exec(DDL);
}

module.exports = { GROUP_KIND_NAMES, GROUP_KIND, KIND_BY_LEADER, kindSpecOf, MEMBER_FIELDS, DISSOLVE_REASONS,
  GROUP_REC_BYTES, GROUP_MEMBER_BYTES, nameOf, groupsSettingsOf, upPopulationGroups };
