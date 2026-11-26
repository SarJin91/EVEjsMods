"use strict";

const FACTION_CORES_VERSION = 1;

const FACTION_CORES = Object.freeze([
  Object.freeze({ factionId: 500003, systemIds: Object.freeze([30002187]),
    stationId: "upw-500003-30001721-1", origin: "hq+firstStation" }),
  Object.freeze({ factionId: 500006, systemIds: Object.freeze([30005204]),
    stationId: "upw-500006-30001718-1", origin: "hq+firstStation" }),
  Object.freeze({ factionId: 500019, systemIds: Object.freeze([30001868]),
    stationId: "npc-60014284", origin: "hq+station" }),
  Object.freeze({ factionId: 500020, systemIds: Object.freeze([30004518]),
    stationId: "upw-500020-30004518-1", origin: "hq+station" }),
  Object.freeze({ factionId: 500010, systemIds: Object.freeze([30001290]),
    stationId: "npc-60012556", origin: "hq+station" }),
  Object.freeze({ factionId: 500011, systemIds: Object.freeze([30001045]),
    stationId: "npc-60013069", origin: "hq+station" }),
  Object.freeze({ factionId: 500012, systemIds: Object.freeze([30004709]),
    stationId: "npc-60014942", origin: "hq+station" }),
  Object.freeze({ factionId: 500001, systemIds: Object.freeze([30000145]),
    stationId: "npc-60015106", origin: "hq+firstStation" }),
  Object.freeze({ factionId: 500002, systemIds: Object.freeze([30002544]),
    stationId: "npc-60004870", origin: "hq+firstStation" }),
  Object.freeze({ factionId: 500004, systemIds: Object.freeze([30004993]),
    stationId: "npc-60011773", origin: "hq+firstStation" }),
  Object.freeze({ factionId: 500016, systemIds: Object.freeze([30001978]), stationId: "npc-60012595", origin: "hq+station",
    grantControl: true }),
  Object.freeze({ factionId: 500026, systemIds: Object.freeze([30002797]),
    stationId: null, origin: "hq" }),
  Object.freeze({ factionId: 500029, systemIds: Object.freeze([30100000]),
    stationId: null, origin: "hq" }),
  Object.freeze({ factionId: 500025, systemIds: Object.freeze([30001051]), stationId: null, origin: "hq",
    requiresFlag: "hive" }),
]);

module.exports = { FACTION_CORES_VERSION, FACTION_CORES };
