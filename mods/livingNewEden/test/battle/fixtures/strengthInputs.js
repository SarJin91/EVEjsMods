"use strict";

const { METHOD } = require("../../../tools/strength/method");

const HULL_GROUPS = ["frigate", "cruiser", "battleship", "logistics", "industrial"];
const GROUP_IDS = [25, 26, 27, 832, 28];

function hull(hi, t, l, bw, hp, shield, armor, sig, v, recharge) {
  const attrs = { 14: hi, 9: hp, 263: shield, 265: armor, 552: sig, 37: v, 479: recharge,
    271: 1, 274: 0.8, 273: 0.6, 272: 0.5, 267: 0.5, 270: 0.65, 269: 0.75, 268: 0.9, 113: 0.67, 110: 0.67,
    109: 0.67, 111: 0.67 };
  if (t > 0) attrs[102] = t;
  if (l > 0) attrs[101] = l;
  if (bw > 0) attrs[1271] = bw;
  return attrs;
}

function inputs() {
  const ships = [
    [587, 25, true, hull(3, 3, 2, 0, 350, 450, 400, 35, 365, 625000)],
    [603, 25, true, hull(4, 2, 2, 10, 300, 400, 500, 38, 340, 625000)],
    [620, 26, true, hull(5, 4, 0, 25, 1500, 1800, 1700, 120, 220, 1000000)],
    [621, 26, true, hull(5, 0, 4, 0, 1400, 2000, 1500, 130, 230, 1000000)],
    [638, 27, true, hull(7, 4, 6, 75, 6000, 7000, 5500, 410, 110, 2500000)],
    [641, 27, true, hull(8, 6, 0, 75, 6500, 6000, 7500, 400, 105, 2500000)],
    [11978, 832, true, hull(4, 2, 2, 25, 1700, 2000, 2200, 65, 250, 1000000)],
    [11985, 832, true, hull(4, 0, 0, 20, 1600, 2300, 1900, 60, 255, 1000000)],
    [648, 28, true, hull(2, 0, 0, 0, 2500, 800, 900, 160, 150, 1000000)],
    [649, 28, true, hull(2, 0, 0, 5, 2700, 900, 1000, 200, 140, 1000000)],
    [650, 28, false, hull(2, 0, 0, 0, 2700, 900, 1000, 200, 140, 1000000)],
    [23757, 27, true, { ...hull(0, 0, 0, 0, 90000, 80000, 100000, 9000, 80, 5000000), 2216: 4, 2217: 3, 2218: 2 }],
  ];
  const refs = [
    [564, 74, { 51: 3500, 64: 3.675 }], [222, 85, { 117: 7, 118: 5 }],
    [499, 507, { 51: 16000 }], [210, 384, { 117: 83 }],
    [11355, 325, { 73: 4500, 84: 50 }], [3586, 41, { 73: 4000, 68: 40 }],
    [568, 74, { 51: 5250, 64: 3.675 }], [230, 85, { 117: 14, 118: 10 }],
    [501, 510, { 51: 20000 }], [209, 385, { 117: 150 }],
    [11357, 325, { 73: 6000, 84: 196 }], [3596, 41, { 73: 8000, 68: 260 }],
    [573, 74, { 51: 7875, 64: 3.675 }], [238, 85, { 117: 28, 118: 20 }],
    [13320, 506, { 51: 30000 }], [203, 386, { 117: 360 }],
    [11359, 325, { 73: 9000, 84: 520 }], [3606, 41, { 73: 12000, 68: 600 }],
    [2454, 100, { 51: 4000, 64: 1.6, 118: 20, 1272: 5 }],
    [2183, 100, { 51: 4000, 64: 1.6, 118: 32, 1272: 10 }],
    [2444, 100, { 51: 4000, 64: 1.6, 118: 64, 1272: 25 }],
    [23055, 1652, { 2215: 6, 2226: 1, 2227: 97.5, 2233: 5000 }],
    [23061, 1652, { 2215: 6, 2226: 1, 2230: 93, 2233: 5000 }],
    [32340, 1653, { 2215: 6, 2226: 1, 2227: 316, 2233: 5000 }],
  ];
  const dogma = {};
  const types = [];
  for (const [typeId, groupId, published, attrs] of ships) {
    types.push({ typeId, groupId, published });
    dogma[String(typeId)] = attrs;
  }
  for (const [typeId, groupId, attrs] of refs) {
    types.push({ typeId, groupId, published: true });
    dogma[String(typeId)] = attrs;
  }
  const groups = GROUP_IDS.map((groupId) => ({ groupId, categoryId: 6, published: true }));
  for (const groupId of [74, 85, 506, 507, 510, 384, 385, 386, 325, 41, 100]) {
    groups.push({ groupId, categoryId: 7, published: true });
  }
  for (const groupId of [1652, 1653]) groups.push({ groupId, categoryId: 87, published: true });
  return { sde: { buildNumber: 1, releaseDate: "2026-01-01T00:00:00Z" }, evejsVersion: "0.0.0-test",
    groups, types, dogma };
}

function methodFor() {
  const groupMap = {};
  for (const id of GROUP_IDS) groupMap[id] = METHOD.groupMap[id];
  const references = { 1: METHOD.references[1], 2: METHOD.references[2], 3: METHOD.references[3] };
  const referenceFighters = { light: [23055, 23061], heavy: [32340] };
  return { ...METHOD, hullGroups: HULL_GROUPS, groupMap, references, referenceFighters };
}

module.exports = { inputs, methodFor, HULL_GROUPS };
