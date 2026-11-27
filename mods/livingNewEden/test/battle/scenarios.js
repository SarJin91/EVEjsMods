"use strict";

const FACTION_A = 500001;
const FACTION_B = 500002;

const battleIdOf = (n) => `battle_${n.toString(36)}_0001_test`;
const ships = (hullGroup, count, typeId = null) => ({ hullGroup, typeId, count });

function side(factionId, prefix, fleets) {
  return {
    factionId,
    fleets: fleets.map((f, i) => ({ fleetId: `fleet_${prefix}${i}`, factionId, fleetRole: f.role || "patrol",
      doctrineId: null, supplyState: f.supply === undefined ? 100 : f.supply,
      composition: f.ships.map((s) => ({ hullGroup: s.hullGroup, typeId: s.typeId, count: s.count })) })),
  };
}

function makeInput(spec) {
  const g = spec.garrison || null;
  return {
    v: 1, battleId: battleIdOf(spec.battleNo || 1), seed: spec.seed === undefined ? 1 : spec.seed,
    systemId: 30000142, environment: spec.environment || "nullsec",
    sideA: side(FACTION_A, "a", spec.sideA), sideB: side(FACTION_B, "b", spec.sideB),
    objective: spec.objective || "destroy",
    garrison: g ? { side: g.side, factionId: g.side === "A" ? FACTION_A : FACTION_B, strength: g.strength } : null,
    resolverVersion: spec.resolverVersion || "internal-v1", maxResolutionMs: spec.maxResolutionMs || 50,
  };
}

const one = (s) => [{ ships: s }];

const SCENARIOS = Object.freeze({
  similar: (seed) => makeInput({ seed, sideA: one([ships("cruiser", 10)]), sideB: one([ships("cruiser", 10)]) }),
  outnumber: (seed, swap) => makeInput({ seed,
    sideA: one([ships("cruiser", swap ? 10 : 30)]), sideB: one([ships("cruiser", swap ? 30 : 10)]) }),
  logistics: (seed, withLogi) => makeInput({ seed,
    sideA: one(withLogi ? [ships("battlecruiser", 10), ships("logistics", 3)] : [ships("battlecruiser", 10)]),
    sideB: one([ships("battlecruiser", 10)]) }),
  scout: (seed, withTackle) => makeInput({ seed,
    sideA: one(withTackle ? [ships("battleship", 10), ships("tackle", 4)] : [ships("battleship", 10)]),
    sideB: [{ role: "scout", ships: [ships("frigate", 3)] }] }),
  escort: (seed) => makeInput({ seed, objective: "escort",
    sideA: [{ role: "logistics", ships: [ships("industrial", 5)] }, { ships: [ships("cruiser", 6)] }],
    sideB: one([ships("cruiser", 8)]) }),
  capture: (seed, withGarrison) => makeInput({ seed, objective: "capture",
    garrison: withGarrison ? { side: "B", strength: 40 } : null,
    sideA: one([ships("cruiser", 10)]), sideB: one([ships("cruiser", 10)]) }),
  delay: (seed) => makeInput({ seed, objective: "delay",
    sideA: one([ships("cruiser", 5)]), sideB: one([ships("cruiser", 15)]) }),
  stalemate: (seed) => makeInput({ seed,
    sideA: one([ships("industrial", 3, 20183)]), sideB: one([ships("industrial", 3, 2863)]) }),
  carrierVsHauler: (seed) => makeInput({ seed,
    sideA: one([ships("capital", 3, 23757)]), sideB: one([ships("industrial", 3, 2863)]) }),
});

const MEDIUM_GROUPS = Object.freeze(["frigate", "destroyer", "cruiser", "battlecruiser", "battleship", "logistics",
  "ewar", "tackle"]);

function mediumBattle(rng, n) {
  const fleets = () => [0, 1, 2].map(() => {
    const start = rng.nextInt(0, MEDIUM_GROUPS.length - 4);
    return { ships: MEDIUM_GROUPS.slice(start, start + 4).map((h) => ships(h, rng.nextInt(20, 40))) };
  });
  return makeInput({ seed: rng.nextUint32(), battleNo: n + 1, sideA: fleets(), sideB: fleets() });
}

function randomInput(rng, n, lists) {
  const { hullGroups, typesByGroup, objectives, environments, roles } = lists;
  let unknownType = 900000000;
  const randomSide = () => {
    const fleets = [];
    for (let f = rng.nextInt(1, 4); f > 0; f -= 1) {
      const seen = new Set();
      const s = [];
      for (let e = rng.nextInt(1, 6); e > 0; e -= 1) {
        const hullGroup = rng.pick(hullGroups);
        const kind = rng.nextInt(0, 2);
        const known = typesByGroup[hullGroup] || [];
        let typeId = null;
        if (kind === 1 && known.length > 0) typeId = rng.pick(known);
        else if (kind === 2) { unknownType += 1; typeId = unknownType; }
        const key = `${hullGroup}|${typeId || 0}`;
        if (seen.has(key)) continue;
        seen.add(key);
        s.push(ships(hullGroup, rng.nextInt(1, 60), typeId));
      }
      fleets.push({ role: rng.pick(roles), supply: rng.nextInt(0, 100), ships: s });
    }
    return fleets;
  };
  const garrisonKind = rng.nextInt(0, 2);
  return makeInput({ seed: rng.nextUint32(), battleNo: n + 1, sideA: randomSide(), sideB: randomSide(),
    objective: rng.pick(objectives), environment: rng.pick(environments),
    garrison: garrisonKind === 0 ? null : { side: garrisonKind === 1 ? "A" : "B", strength: rng.nextInt(0, 60) } });
}

module.exports = { FACTION_A, FACTION_B, battleIdOf, ships, makeInput, SCENARIOS, mediumBattle, randomInput };
