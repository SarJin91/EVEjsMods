"use strict";

const assert = require("node:assert");

const { planWave, pickRefill } = require("../../lib/materialization/wavePlan");
const { createCapitalRules } = require("../../lib/materialization/capitalRules");

function membersOf(side, fleets) {
  const out = [];
  for (const [fleetId, groups] of fleets) {
    for (const [hullGroup, count] of groups) {
      for (let ordinal = 1; ordinal <= count; ordinal += 1) {
        out.push({ memberKey: `${fleetId}:${hullGroup}:0:${ordinal}`, side, hullGroup, typeId: null, fleetId,
          factionId: side === "A" ? 1 : 2, ordinal, profileId: `p_${hullGroup}` });
      }
    }
  }
  return out;
}

module.exports = ({ test }) => {
  test("AV4-T1 wavePlan: 60 vs 40, W 40 -> wave 24/16 in round-robin order, reserve 36/24, quota "
    + "24/16; a capital above maxSlots trims the last member of the bigger side (>= 1 per side); pickRefill lets a "
    + "smaller member pass a capital that does not fit", () => {
    const plain = createCapitalRules({ settings: {} }).slotsOf;
    const A = membersOf("A", [["fa1", [["cruiser", 10], ["frigate", 10]]], ["fa2", [["cruiser", 10], ["frigate", 10]]],
      ["fa3", [["cruiser", 10], ["frigate", 10]]]]);
    const B = membersOf("B", [["fb1", [["cruiser", 20], ["frigate", 20]]]]);
    const r = planWave([...A, ...B], { maxShips: 40, maxSlots: 48, slotsOf: plain });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    const waveA = r.wave.filter((m) => m.side === "A");
    assert.deepStrictEqual({ sides: [waveA.length, r.wave.length - waveA.length],
      reserve: [r.reserve.A.length, r.reserve.B.length], quota: r.quota, slots: r.slots,
      head: waveA.slice(0, 4).map((m) => m.memberKey),
      groups: waveA.reduce((acc, m) => ({ ...acc, [m.hullGroup]: (acc[m.hullGroup] || 0) + 1 }), {}),
      eleventhCruiser: waveA.filter((m) => m.hullGroup === "cruiser")[10].fleetId,
      all: new Set([...r.wave, ...r.reserve.A, ...r.reserve.B].map((m) => m.memberKey)).size },
    { sides: [24, 16], reserve: [36, 24], quota: { A: 24, B: 16 }, slots: 40,
      head: ["fa1:cruiser:0:1", "fa1:frigate:0:1", "fa1:cruiser:0:2", "fa1:frigate:0:2"],
      groups: { cruiser: 12, frigate: 12 }, eleventhCruiser: "fa2", all: 100 });

    const capitalSlots = createCapitalRules({ settings: { capitalBudgetWeight: 3 } }).slotsOf;
    const capA = membersOf("A", [["fc1", [["cruiser", 2], ["titan", 1]]]]);
    const capB = membersOf("B", [["fc2", [["cruiser", 2]]]]);
    const c = planWave([...capA, ...capB], { maxShips: 5, maxSlots: 6, slotsOf: capitalSlots });
    assert.deepStrictEqual(c.ok && { wave: c.wave.map((m) => m.memberKey), reserveA: c.reserve.A.map((m) => m.memberKey),
      quota: c.quota }, { wave: ["fc1:cruiser:0:1", "fc1:titan:0:1", "fc2:cruiser:0:1", "fc2:cruiser:0:2"],
      reserveA: ["fc1:cruiser:0:2"], quota: { A: 4, B: 2 } });
    const titanOnly = membersOf("A", [["fc3", [["titan", 2]]]]);
    assert.strictEqual(planWave([...titanOnly, ...capB], { maxShips: 4, maxSlots: 3, slotsOf: capitalSlots }).reason,
      "LIVE_TOO_LARGE");
    assert.strictEqual(planWave([...A, ...B], { maxShips: 1, maxSlots: 48, slotsOf: plain }).reason, "LIVE_TOO_LARGE");

    const reserveA = [...membersOf("A", [["fd1", [["titan", 1]]]]), ...membersOf("A", [["fd2", [["frigate", 2]]]])];
    const p = pickRefill({ reserve: { A: reserveA, B: membersOf("B", [["fd3", [["cruiser", 1]]]]) },
      quota: { A: 3, B: 2 }, aliveSlots: { A: 1, B: 2 } }, { budget: 8, slotsOf: capitalSlots });
    assert.deepStrictEqual([p.A.map((m) => m.memberKey), p.B.length], [["fd2:frigate:0:1", "fd2:frigate:0:2"], 0]);
    const one = pickRefill({ reserve: { A: reserveA, B: [] }, quota: { A: 3, B: 2 }, aliveSlots: { A: 1, B: 0 } },
      { budget: 1, slotsOf: capitalSlots });
    assert.deepStrictEqual(one.A.map((m) => m.memberKey), ["fd2:frigate:0:1"], "budget 1");
  });
};
