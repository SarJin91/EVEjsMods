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
  "sdeBuild": 3724492,
  "sdeReleaseDate": "2026-11-19T11:07:08Z",
  "strengthSourceHash": "e7fc65e3eac3abee70433e5b131d78a1e8cddd0878c0d946b5deb2ac89bc7c95",
  "sourceHash": "2e1d3408acab975aeca5d113b231ddedfbe5767fae98917279727f81b674a9e8",
  "maxDepth": 4,
  "missingBlueprints": 0,
  "ignoredMaterialTypes": 53
};

const GROUPS = {
  "carrier": {"minerals":{"type:34":2254500,"type:35":8083500,"type:36":2254500,"type:37":630000,"type:38":62402,"type:39":31601,"type:40":15771},"timeSec":1800000,"representativeTypeId":23911,"sampleSize":4,"mineralSum":13332274},
  "dreadnought": {"minerals":{"type:34":2148000,"type:35":7736250,"type:36":2170500,"type:37":592500,"type:38":58951,"type:39":30138,"type:40":14825},"timeSec":2000000,"representativeTypeId":19724,"sampleSize":4,"mineralSum":12751164},
  "force_auxiliary": {"minerals":{"type:34":6500625,"type:35":23280000,"type:36":6519375,"type:37":1810125,"type:38":179515,"type:39":90844,"type:40":45259},"timeSec":2000000,"representativeTypeId":37605,"sampleSize":4,"mineralSum":38425743},
  "supercarrier": {"minerals":{"type:34":41231250,"type:35":148050000,"type:36":41231250,"type:37":11550000,"type:38":1147550,"type:39":579600,"type:40":288650},"timeSec":6000000,"representativeTypeId":23913,"sampleSize":4,"mineralSum":244078300},
  "titan": {"minerals":{"type:34":315015000,"type:35":1114500000,"type:36":299377500,"type:37":84337500,"type:38":9041400,"type:39":4541150,"type:40":2268300},"timeSec":9000000,"representativeTypeId":11567,"sampleSize":4,"mineralSum":1829080850},
};

module.exports = deepFreeze({ HEADER, GROUPS });
