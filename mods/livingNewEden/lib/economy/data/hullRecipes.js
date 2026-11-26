"use strict";

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

const HEADER = {
  "recipesVersion": 1,
  "sdeBuild": 3396210,
  "sdeReleaseDate": "2026-06-16T12:43:42Z",
  "sourceHash": "42ea16d65b0f0e03d264ffc9192c04370bfbb00ebe74036e3d093b5e33033049",
  "maxDepth": 4,
  "sourceGroups": {
    "frigate": [
      25,
      324,
      830,
      834
    ],
    "destroyer": [
      420,
      1305,
      1534
    ],
    "cruiser": [
      26,
      358
    ],
    "battlecruiser": [
      419,
      1201
    ],
    "battleship": [
      27
    ],
    "logistics": [
      832,
      1527
    ],
    "ewar": [
      833,
      893,
      906
    ],
    "tackle": [
      541,
      831,
      894
    ],
    "industrial": [
      28,
      463
    ],
    "capital": [
      485,
      547,
      1538,
      4594
    ]
  },
  "typeCount": 311,
  "ignoredMaterialTypes": 94
};

const GROUPS = {
  "frigate": {"minerals":{"type:34":32000,"type:35":6000,"type:36":2500,"type:37":500,"type:38":30,"type:39":20,"type:40":10},"timeSec":6000,"representativeTypeId":17841,"sampleSize":74,"mineralSum":41060},
  "destroyer": {"minerals":{"type:34":80000,"type:35":15000,"type:36":5000,"type:37":1000,"type:38":30,"type:39":20,"type:40":10},"timeSec":9000,"representativeTypeId":73796,"sampleSize":34,"mineralSum":101060},
  "cruiser": {"minerals":{"type:34":540000,"type:35":180000,"type:36":36000,"type:37":10000,"type:38":1500,"type:39":1000,"type:40":500},"timeSec":12000,"representativeTypeId":17843,"sampleSize":48,"mineralSum":769000},
  "battlecruiser": {"minerals":{"type:34":2800000,"type:35":1000000,"type:36":180000,"type:37":20000,"type:38":10000,"type:39":4000,"type:40":2000},"timeSec":15000,"representativeTypeId":33157,"sampleSize":25,"mineralSum":4016000},
  "battleship": {"minerals":{"type:34":8419596,"type:35":2105337,"type:36":527416,"type:37":131693,"type:38":32913,"type:39":15928,"type:40":5962},"timeSec":18000,"representativeTypeId":11936,"sampleSize":34,"mineralSum":11238845},
  "logistics": {"minerals":{"type:34":405556,"type:35":135444,"type:36":27222,"type:37":7582,"type:38":1161,"type:39":263,"type:40":105},"timeSec":240000,"representativeTypeId":11978,"sampleSize":11,"mineralSum":577333},
  "ewar": {"minerals":{"type:34":405556,"type:35":135444,"type:36":27222,"type:37":7582,"type:38":1161,"type:39":263,"type:40":105},"timeSec":240000,"representativeTypeId":11959,"sampleSize":18,"mineralSum":577333},
  "tackle": {"minerals":{"type:34":32556,"type:35":6444,"type:36":2722,"type:37":582,"type:38":36},"timeSec":120000,"representativeTypeId":11200,"sampleSize":20,"mineralSum":42340},
  "industrial": {"minerals":{"type:34":80000,"type:35":15000,"type:36":3750,"type:37":2000,"type:38":750,"type:39":125,"type:40":70},"timeSec":12000,"representativeTypeId":654,"sampleSize":20,"mineralSum":101695},
  "capital": {"minerals":{"type:34":2605500,"type:35":9390750,"type:36":2635500,"type:37":717000,"type:38":71401,"type:39":36543,"type:40":17958},"timeSec":2000000,"representativeTypeId":73790,"sampleSize":27,"mineralSum":15474652},
};

module.exports = deepFreeze({ HEADER, GROUPS });
