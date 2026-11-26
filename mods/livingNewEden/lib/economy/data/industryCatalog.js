"use strict";

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

const HEADER = {
  "catalogVersion": 1,
  "sdeBuild": 3396210,
  "sdeReleaseDate": "2026-06-16T12:43:42Z",
  "sourceHash": "1e230d4e7cedbafbd90581af61887690588fc008d765219b013a0a9c68924e03",
  "maxDepth": 6,
  "attributes": {
    "oreHold": 1556,
    "warpSpeedMultiplier": 600,
    "agility": 70,
    "maxVelocity": 37
  },
  "classCount": 9,
  "structureCount": 8,
  "ignoredMaterialTypes": 42,
  "unpricedLeafTypes": 18
};

const HULLS = {
  "mining_frigate": {"members":[32880],"representativeTypeId":32880,"sampleSize":1,"minerals":{"type:34":22400,"type:35":4200,"type:36":1750},"mineralSum":28350,"timeSec":6000,"mineralValueIsk":134400,"componentValueIsk":0,"componentFactorPermille":1000,"unpricedLeaves":0,"cargoM3":50,"cargoMedianM3":50,"oreHoldM3":5000,"travel":{"warpSpeedAu":5,"alignSeconds":6,"maxVelocityMs":335}},
  "mining_barge": {"members":[17476,17478,17480],"representativeTypeId":17476,"sampleSize":3,"minerals":{"type:34":1600000,"type:35":300000,"type:36":75000,"type:37":40000,"type:38":15000,"type:39":2500,"type:40":1400},"mineralSum":2033900,"timeSec":12000,"mineralValueIsk":37388800,"componentValueIsk":0,"componentFactorPermille":1000,"unpricedLeaves":0,"cargoM3":350,"cargoMedianM3":350,"oreHoldM3":9000,"travel":{"warpSpeedAu":3.5,"alignSeconds":12.5,"maxVelocityMs":150}},
  "exhumer": {"members":[22544,22546,22548],"representativeTypeId":22544,"sampleSize":3,"minerals":{"type:34":1600556,"type:35":300444,"type:36":75222,"type:37":40082,"type:38":15036,"type:39":2500,"type:40":1400},"mineralSum":2035240,"timeSec":240000,"mineralValueIsk":37429496,"componentValueIsk":52685830,"componentFactorPermille":2407,"unpricedLeaves":0,"cargoM3":350,"cargoMedianM3":350,"oreHoldM3":11500,"travel":{"warpSpeedAu":3.5,"alignSeconds":12.5,"maxVelocityMs":160}},
  "porpoise": {"members":[42244],"representativeTypeId":42244,"sampleSize":1,"minerals":{"type:34":3600000,"type:35":675000,"type:36":168750,"type:37":90000,"type:38":33750,"type:39":5625,"type:40":3150},"mineralSum":4576275,"timeSec":15000,"mineralValueIsk":84124800,"componentValueIsk":0,"componentFactorPermille":1000,"unpricedLeaves":0,"cargoM3":500,"cargoMedianM3":500,"oreHoldM3":50000,"travel":{"warpSpeedAu":3.5,"alignSeconds":9.4,"maxVelocityMs":100}},
  "orca": {"members":[28606],"representativeTypeId":28606,"sampleSize":1,"minerals":{"type:34":3931500,"type:35":14135250,"type:36":3931500,"type:37":1110000,"type:38":108600,"type:39":55092,"type:40":27654},"mineralSum":23299596,"timeSec":1500000,"mineralValueIsk":783806184,"componentValueIsk":8627822008,"componentFactorPermille":12007,"unpricedLeaves":4,"cargoM3":30000,"cargoMedianM3":30000,"oreHoldM3":150000,"travel":{"warpSpeedAu":2.5,"alignSeconds":41.6,"maxVelocityMs":60}},
  "rorqual": {"members":[28352],"representativeTypeId":28352,"sampleSize":1,"minerals":{"type:34":10363125,"type:35":36952500,"type:36":10085625,"type:37":2844375,"type:38":288005,"type:39":146440,"type:40":73485},"mineralSum":60753555,"timeSec":2000000,"mineralValueIsk":2052523050,"componentValueIsk":14503083208,"componentFactorPermille":8065,"unpricedLeaves":7,"cargoM3":40000,"cargoMedianM3":40000,"oreHoldM3":300000,"travel":{"warpSpeedAu":1.5,"alignSeconds":77.6,"maxVelocityMs":60}},
  "industrial": {"members":[648,649,650,651,652,653,654,655,656,657,1944,2863,2998,4363,4388,19744,32811,81008],"representativeTypeId":653,"sampleSize":17,"minerals":{"type:34":80000,"type:35":15000,"type:36":3750,"type:37":2000,"type:38":750,"type:39":125,"type:40":70},"mineralSum":101695,"timeSec":12000,"mineralValueIsk":1869440,"componentValueIsk":0,"componentFactorPermille":1000,"unpricedLeaves":0,"cargoM3":2900,"cargoMedianM3":2900,"oreHoldM3":0,"travel":{"warpSpeedAu":3.5,"alignSeconds":11.2,"maxVelocityMs":140}},
  "freighter": {"members":[20183,20185,20187,20189,34328,81040],"representativeTypeId":34328,"sampleSize":6,"minerals":{"type:34":3205500,"type:35":11487750,"type:36":3205500,"type:37":888750,"type:38":88125,"type:39":44815,"type:40":22430},"mineralSum":18942870,"timeSec":1500000,"mineralValueIsk":635296680,"componentValueIsk":10928083208,"componentFactorPermille":18201,"unpricedLeaves":4,"cargoM3":4000,"cargoMedianM3":435000,"oreHoldM3":0,"travel":{"warpSpeedAu":1.5,"alignSeconds":59.9,"maxVelocityMs":65}},
  "jump_freighter": {"members":[28844,28846,28848,28850],"representativeTypeId":28850,"sampleSize":4,"minerals":{"type:34":4943056,"type:35":17786694,"type:36":4942722,"type:37":1380082,"type:38":137301,"type:39":71090,"type:40":34665},"mineralSum":29295610,"timeSec":3600000,"mineralValueIsk":986863376,"componentValueIsk":13024776048,"componentFactorPermille":14198,"unpricedLeaves":14,"cargoM3":135000,"cargoMedianM3":135000,"oreHoldM3":0,"travel":{"warpSpeedAu":1.5,"alignSeconds":68.6,"maxVelocityMs":84}},
};

const STRUCTURES = {
  "raitaru": {"typeId":35825,"minerals":{"type:34":6000000,"type:35":1200000,"type:36":420000,"type:37":48000,"type:38":9000,"type:39":4200,"type:40":1800},"mineralSum":7683000,"timeSec":400000,"mineralValueIsk":69139200,"componentValueIsk":0,"componentFactorPermille":1000,"unpricedLeaves":8},
  "azbel": {"typeId":35826,"minerals":{"type:34":45000000,"type:35":9000000,"type:36":3150000,"type:37":360000,"type:38":67500,"type:39":31500,"type:40":13500},"mineralSum":57622500,"timeSec":1122000,"mineralValueIsk":518544000,"componentValueIsk":0,"componentFactorPermille":1000,"unpricedLeaves":8},
  "sotiyo": {"typeId":35827,"minerals":{"type:34":287500000,"type:35":57500000,"type:36":20125000,"type:37":2300000,"type:38":431250,"type:39":201250,"type:40":86250},"mineralSum":368143750,"timeSec":2300000,"mineralValueIsk":3312920000,"componentValueIsk":250000,"componentFactorPermille":1000,"unpricedLeaves":9},
  "astrahus": {"typeId":35832,"minerals":{"type:34":9500000,"type:35":1900000,"type:36":665000,"type:37":76000,"type:38":14250,"type:39":6650,"type:40":2850},"mineralSum":12164750,"timeSec":600000,"mineralValueIsk":109470400,"componentValueIsk":0,"componentFactorPermille":1000,"unpricedLeaves":8},
  "fortizar": {"typeId":35833,"minerals":{"type:34":111000000,"type:35":22200000,"type:36":7770000,"type:37":888000,"type:38":166500,"type:39":77700,"type:40":33300},"mineralSum":142135500,"timeSec":1700000,"mineralValueIsk":1279075200,"componentValueIsk":0,"componentFactorPermille":1000,"unpricedLeaves":8},
  "keepstar": {"typeId":35834,"minerals":{"type:34":2256000000,"type:35":451200000,"type:36":157920000,"type:37":18048000,"type:38":3384000,"type:39":1579200,"type:40":676800},"mineralSum":2888808000,"timeSec":3500000,"mineralValueIsk":25996339200,"componentValueIsk":1000000,"componentFactorPermille":1000,"unpricedLeaves":9},
  "athanor": {"typeId":35835,"minerals":{"type:34":8500000,"type:35":1700000,"type:36":595000,"type:37":68000,"type:38":12750,"type:39":5950,"type:40":2550},"mineralSum":10884250,"timeSec":600000,"mineralValueIsk":97947200,"componentValueIsk":0,"componentFactorPermille":1000,"unpricedLeaves":8},
  "tatara": {"typeId":35836,"minerals":{"type:34":77000000,"type:35":15400000,"type:36":5390000,"type:37":616000,"type:38":115500,"type:39":53900,"type:40":23100},"mineralSum":98598500,"timeSec":1300000,"mineralValueIsk":887286400,"componentValueIsk":0,"componentFactorPermille":1000,"unpricedLeaves":8},
};

const ORE_BANDS = {
  "highsec": {"ores":[{"name":"Veldspar","typeId":1230,"sharePermille":330},{"name":"Scordite","typeId":1228,"sharePermille":250},{"name":"Pyroxeres","typeId":1224,"sharePermille":150},{"name":"Plagioclase","typeId":18,"sharePermille":120},{"name":"Omber","typeId":1227,"sharePermille":50},{"name":"Kernite","typeId":20,"sharePermille":40},{"name":"Jaspet","typeId":1226,"sharePermille":10},{"name":"Hemorphite","typeId":1231,"sharePermille":10},{"name":"Hedbergite","typeId":21,"sharePermille":10},{"name":"Crokite","typeId":1225,"sharePermille":10},{"name":"Bistot","typeId":1223,"sharePermille":10},{"name":"Arkonor","typeId":22,"sharePermille":10}],"mineralsPerMillionM3":{"type:34":16300000,"type:35":2418333,"type:36":445000,"type:37":110500,"type:38":14500,"type:39":1000,"type:40":750}},
  "lowsec": {"ores":[{"name":"Veldspar","typeId":1230,"sharePermille":150},{"name":"Scordite","typeId":1228,"sharePermille":150},{"name":"Pyroxeres","typeId":1224,"sharePermille":100},{"name":"Plagioclase","typeId":18,"sharePermille":100},{"name":"Omber","typeId":1227,"sharePermille":120},{"name":"Kernite","typeId":20,"sharePermille":120},{"name":"Jaspet","typeId":1226,"sharePermille":80},{"name":"Hemorphite","typeId":1231,"sharePermille":60},{"name":"Hedbergite","typeId":21,"sharePermille":60},{"name":"Crokite","typeId":1225,"sharePermille":20},{"name":"Bistot","typeId":1223,"sharePermille":20},{"name":"Arkonor","typeId":22,"sharePermille":20}],"mineralsPerMillionM3":{"type:34":8000000,"type:35":1760000,"type:36":475000,"type:37":318000,"type:38":72000,"type:39":2000,"type:40":1500}},
  "nullsec": {"ores":[{"name":"Veldspar","typeId":1230,"sharePermille":100},{"name":"Scordite","typeId":1228,"sharePermille":100},{"name":"Pyroxeres","typeId":1224,"sharePermille":50},{"name":"Plagioclase","typeId":18,"sharePermille":50},{"name":"Hemorphite","typeId":1231,"sharePermille":50},{"name":"Hedbergite","typeId":21,"sharePermille":50},{"name":"Gneiss","typeId":1229,"sharePermille":100},{"name":"Dark Ochre","typeId":1232,"sharePermille":100},{"name":"Spodumain","typeId":19,"sharePermille":100},{"name":"Crokite","typeId":1225,"sharePermille":100},{"name":"Bistot","typeId":1223,"sharePermille":100},{"name":"Arkonor","typeId":22,"sharePermille":100}],"mineralsPerMillionM3":{"type:34":8250000,"type:35":1808333,"type:36":895000,"type:37":412500,"type:38":135000,"type:39":15000,"type:40":10000}},
};

module.exports = deepFreeze({ HEADER, HULLS, STRUCTURES, ORE_BANDS });
