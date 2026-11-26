"use strict";

const HOSTILITY_V2 = Object.freeze({
  version: 2,
  defaultHostile: true,
  friendlyPairs: Object.freeze([
    Object.freeze([500011, 500020]),
    Object.freeze([500001, 500006]),
    Object.freeze([500002, 500006]),
    Object.freeze([500003, 500006]),
    Object.freeze([500004, 500006]),
  ]),
});

const HOSTILITY_V3 = Object.freeze({
  version: 3,
  defaultHostile: true,
  friendlyBlocs: Object.freeze([
    Object.freeze([500001, 500002, 500003, 500004, 500006, 500027]),
  ]),
  friendlyPairs: Object.freeze([
    Object.freeze([500011, 500020]),
    Object.freeze([500001, 500006]),
    Object.freeze([500002, 500006]),
    Object.freeze([500003, 500006]),
    Object.freeze([500004, 500006]),
    Object.freeze([500003, 500007]),
    Object.freeze([500001, 500008]),
    Object.freeze([500001, 500018]),
    Object.freeze([500002, 500015]),
    Object.freeze([500004, 500014]),
    Object.freeze([500004, 500016]),
    Object.freeze([500006, 500013]),
    Object.freeze([500005, 500006]),
    Object.freeze([500005, 500017]),
    Object.freeze([500016, 500028]),
  ]),
});

const HOSTILITY_V4 = Object.freeze({
  version: 4,
  defaultHostile: true,
  friendlyBlocs: HOSTILITY_V3.friendlyBlocs,
  friendlyPairs: Object.freeze([
    ...HOSTILITY_V3.friendlyPairs,
    Object.freeze([500002, 500018]),
    Object.freeze([500003, 500018]),
    Object.freeze([500004, 500018]),
    Object.freeze([500006, 500018]),
    Object.freeze([500018, 500027]),
  ]),
});

const HOSTILITY_V5 = Object.freeze({
  version: 5,
  defaultHostile: true,
  friendlyBlocs: Object.freeze([
    Object.freeze([500001, 500002, 500003, 500004, 500006, 500027, 500016]),
  ]),
  friendlyPairs: Object.freeze([...HOSTILITY_V4.friendlyPairs, Object.freeze([500016, 500018])]),
});

const pairKey = (a, b) => (a < b ? `${a}:${b}` : `${b}:${a}`);

function createHostility(table = HOSTILITY_V5) {
  const friendly = new Set(table.friendlyPairs.map(([a, b]) => pairKey(a, b)));
  for (const bloc of table.friendlyBlocs || []) {
    for (let i = 0; i < bloc.length; i += 1) {
      for (let j = i + 1; j < bloc.length; j += 1) friendly.add(pairKey(bloc[i], bloc[j]));
    }
  }
  const byDefault = table.defaultHostile === true;
  return (a, b) => {
    if (a === b) return false;
    if (friendly.has(pairKey(a, b))) return false;
    return byDefault;
  };
}

module.exports = { HOSTILITY_V2, HOSTILITY_V3, HOSTILITY_V4, HOSTILITY_V5, createHostility, pairKey };
