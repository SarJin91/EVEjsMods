"use strict";

const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");

const config = require("../../config");
const { buildTerritory, territorySizes, allocateGangFactions, levelOrder } = require("../../lib/bounty/territory");
const { rollTarget, pickNextSystem } = require("../../lib/bounty/plan");
const { LEVELS, LEVEL_WEIGHTS } = require("../../lib/bounty/data/levels");
const { CANONICAL_GANG_FACTIONS } = require("../../lib/bounty/data/gangNames");
const { createBountyService } = require("../../lib/bounty/service");
const { loadDriver, withStore } = require("../notices/storeHelper");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const T0 = 1760000000000;
const POCHVEN = 10000070;
const F = 500010;
const G = 500011;

const CLASS_BASE = Object.freeze({ highsec: 1000, lowsec: 2000, nullsec: 3000 });
const classOfId = (id) => (id >= 3000 ? "nullsec" : id >= 2000 ? "lowsec" : "highsec");
function bigTerritory(n, over = {}) {
  const lists = { highsec: [], lowsec: [], nullsec: [] };
  for (const c of Object.keys(lists)) {
    if (over[c] === 0) continue;
    for (let i = 0; i < n; i += 1) lists[c].push(CLASS_BASE[c] + i);
  }
  const factionOf = new Map();
  for (const c of Object.keys(lists)) for (const id of lists[c]) factionOf.set(id, F);
  return { factionOf, lists: new Map([[F, lists]]) };
}

function roll(cycle, territory, over = {}) {
  return rollTarget({ worldSeed: 11, slot: 3, cycle, factionId: F, now: 1000, levels: LEVELS, territory,
    busySystems: new Set(), smugglerPermille: 150, minStayMs: 60000, ...over });
}

module.exports = ({ test, skip }) => {
  test("BT1 buildTerritory: vendor faction / regionId % 5, highsec kept, WH / other / excluded out; sizes ignore highsec",
    () => {
      const R1 = 10000002;
      const R2 = 10000003;
      const systems = [[1, "lowsec", R1], [2, "lowsec", R1], [3, "nullsec", R1], [4, "nullsec", R2], [5, "nullsec", R2],
        [6, "highsec", R1], [7, "highsec", R2], [8, "highsec", POCHVEN], [9, "wormhole", R1], [10, "lowsec", POCHVEN],
        [11, "other", R2], [12, "nullsec", R2]].map(([systemId, secClass, regionId]) => ({ systemId, secClass, regionId,
        gated: true }));
      systems.push({ systemId: 13, secClass: "nullsec", regionId: R2, gated: false },
        { systemId: 14, secClass: "lowsec", regionId: R1 });
      const factionOfSystem = new Map([[1, 500010], [2, null], [3, 500025], [4, 500020], [6, 500011], [12, 500010],
        [13, 500010], [14, 500010]]);
      const p = { systems, factionOfSystem, usableFactionIds: CANONICAL_GANG_FACTIONS,
        excludedRegionIds: new Set([POCHVEN]) };
      const t = buildTerritory(p);
      assert.strictEqual(t.ok, true, JSON.stringify(t));
      assert.deepStrictEqual([...t.factionOf].sort((a, b) => a[0] - b[0]),
        [[1, 500010], [2, 500012], [3, 500012], [4, 500020], [5, 500019], [6, 500011], [7, 500019], [12, 500010]]);
      assert.deepStrictEqual(t.lists.get(500010), { highsec: [], lowsec: [1], nullsec: [12] });
      assert.deepStrictEqual(t.lists.get(500019), { highsec: [7], lowsec: [], nullsec: [5] });
      assert.deepStrictEqual(t.lists.get(500011), { highsec: [6], lowsec: [], nullsec: [] });
      const sizes = [...territorySizes(t.lists)];
      assert.deepStrictEqual(sizes, [[500010, 2], [500011, 0], [500012, 2], [500019, 1], [500020, 1]]);
      const noHigh = buildTerritory({ ...p, systems: systems.filter((s) => s.secClass !== "highsec") });
      assert.deepStrictEqual([...territorySizes(noHigh.lists)], sizes, "Highsec never in the D'Hondt sizes");
      assert.deepStrictEqual(buildTerritory({ ...p, usableFactionIds: [] }), { ok: false, reason: "NO_FACTIONS" });
      assert.deepStrictEqual(buildTerritory({ ...p, systems: null }), { ok: false, reason: "INVALID_INPUT" });
    });

  test("BT2 allocateGangFactions D'Hondt 6/2, prefix stable, 0 systems -> 0 gangs; levelOrder", () => {
    const A = 500010;
    const B = 500011;
    const C = 500012;
    const sizes = new Map([[A, 300], [B, 100], [C, 0]]);
    const eight = allocateGangFactions(sizes, [A, B, C], 8);
    assert.strictEqual(eight.length, 8);
    assert.deepStrictEqual([eight.filter((f) => f === A).length, eight.filter((f) => f === B).length,
      eight.filter((f) => f === C).length], [6, 2, 0]);
    assert.deepStrictEqual(allocateGangFactions(sizes, [A, B, C], 4), eight.slice(0, 4), "prefix");
    assert.deepStrictEqual(allocateGangFactions(new Map([[A, 0]]), [A], 5), [], "no systems -> no gang");
    assert.deepStrictEqual(levelOrder(1, 6), [1, 2, 3, 4, 5, 6]);
    assert.deepStrictEqual(levelOrder(3, 6), [3, 2, 4, 1, 5, 6]);
    assert.deepStrictEqual(levelOrder(6, 6), [6, 5, 4, 3, 2, 1]);
  });

  test("BT3 rollTarget: highsec by highsecPermille, classFallback, level fallback, highsec off, NO_SYSTEM, replay", () => {
    const N = 600;
    const big = bigTerritory(200);
    const hs = { 1: [0, 0], 2: [0, 0] };
    for (let cycle = 1; cycle <= N; cycle += 1) {
      const r = roll(cycle, big);
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      assert.deepStrictEqual([r.fallback, r.classFallback], [false, false], "free systems everywhere");
      const cls = classOfId(r.row.systemId);
      assert.ok(LEVELS[r.row.level].secClasses.includes(cls), `cycle ${cycle}`);
      if (r.row.level >= 3) assert.notStrictEqual(cls, "highsec", "L3+ never in highsec");
      if (r.row.level <= 2) hs[r.row.level][cls === "highsec" ? 0 : 1] += 1;
    }
    const share = (l) => hs[l][0] / (hs[l][0] + hs[l][1]);
    assert.ok(share(1) > 0.5 && share(1) < 0.7, `L1 highsec share ${share(1)} ~ 0.6`);
    assert.ok(share(2) > 0.3 && share(2) < 0.5, `L2 highsec share ${share(2)} ~ 0.4`);
    assert.deepStrictEqual(roll(17, big), roll(17, big), "same inputs -> same row");

    const busyHigh = new Set(big.lists.get(F).highsec);
    let classFallbacks = 0;
    for (let cycle = 1; cycle <= 200; cycle += 1) {
      const r = roll(cycle, big, { busySystems: busyHigh });
      assert.strictEqual(r.fallback, false);
      if (r.row.level <= 2) assert.strictEqual(classOfId(r.row.systemId), "lowsec");
      if (r.classFallback) classFallbacks += 1;
    }
    assert.ok(classFallbacks > 0, "classFallback counted");
    const nullOnly = bigTerritory(50, { highsec: 0, lowsec: 0 });
    let fallbacks = 0;
    for (let cycle = 1; cycle <= 100; cycle += 1) {
      const r = roll(cycle, nullOnly);
      assert.ok(r.row.level >= 3 && classOfId(r.row.systemId) === "nullsec");
      if (r.fallback) {
        fallbacks += 1;
        assert.strictEqual(r.row.expiresAt, 1000 + LEVELS[r.row.level].lifetimeMs, "data of the level found");
        assert.notStrictEqual(r.row.archetype, undefined);
      }
    }
    assert.ok(fallbacks > 0, "L1 / L2 rolled -> fallback");
    const lvl1 = (r) => r.fallback && r.row.level === 3;
    assert.ok(Array.from({ length: 100 }, (_v, i) => roll(i + 1, nullOnly)).some(lvl1), "L1 / L2 -> L3 (nearest)");
    for (let cycle = 1; cycle <= 200; cycle += 1) {
      assert.notStrictEqual(classOfId(roll(cycle, big, { highsecEnabled: false }).row.systemId), "highsec");
    }
    const all = new Set([...big.factionOf.keys()]);
    assert.deepStrictEqual(roll(1, big, { busySystems: all }), { ok: false, reason: "NO_SYSTEM" });
    assert.deepStrictEqual(roll(1, null), { ok: false, reason: "INVALID_INPUT" });
  });

  test("BT4 pickNextSystem keeps class and territory, highsec off -> lowsec; state share of the levels", () => {
    const CLS = { 1: "highsec", 2: "highsec", 3: "highsec", 4: "lowsec", 5: "lowsec", 6: "highsec" };
    const LINKS = { 1: [2, 6], 2: [1, 3], 3: [2, 4], 4: [3, 5], 5: [4], 6: [1] };
    const graph = { getSystem: (id) => (CLS[id] ? { secClass: CLS[id], regionId: 10000002 } : null),
      getNeighbors: (id) => (LINKS[id] || []).slice() };
    const territory = { factionOf: new Map([[1, F], [2, F], [3, F], [4, F], [5, F], [6, G]]), lists: new Map() };
    const move = (over) => pickNextSystem({ seed: 99, stayIndex: 0, systemId: 2, level: 1, factionId: F, levels: LEVELS,
      territory, graph, busySystems: new Set(), now: 5000, ...over });
    for (let i = 0; i < 30; i += 1) {
      assert.ok([1, 3].includes(move({ stayIndex: i }).systemId), "highsec stays highsec");
      assert.strictEqual(move({ systemId: 1, stayIndex: i }).systemId, 2, "never the territory of G");
      assert.strictEqual(move({ systemId: 4, stayIndex: i }).systemId, 5, "lowsec stays lowsec");
      assert.strictEqual(move({ systemId: 3, stayIndex: i, highsecEnabled: false }).systemId, 4, "highsec off");
    }
    assert.deepStrictEqual(move({ systemId: 5, busySystems: new Set([4]) }), { ok: false, reason: "NO_NEIGHBOR" });
    const mass = LEVEL_WEIGHTS.map(([l, w]) => w * LEVELS[l].lifetimeMs);
    const total = mass.reduce((a, b) => a + b, 0);
    const target = [30, 25, 20, 12, 8, 5];
    mass.forEach((m, i) => assert.ok(Math.abs((100 * m) / total - target[i]) <= 2, `L${i + 1} ${(100 * m) / total}`));
  });

  const driver = loadDriver();
  if (!driver.ok) {
    skip("BT5 bounty territory service", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }

  test("BT5 service on 2 factions, 20 slots: targets in their territory, census, factionIds filter, territory retry",
    () => {
      const r = config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir() } });
      assert.deepStrictEqual(r.errors || [], []);
      const base = { ...r.config.bountyHunters, enabled: true, maxGangs: 4, gangMembers: 5, maxActive: 20 };
      const SIDE = 10;
      const JOVE = [101, 102, 103];
      const sysOf = (id) => {
        if (JOVE.includes(id)) return { id, secClass: "nullsec", regionId: 10000017, constellationId: 20000002 };
        if (!(Number.isInteger(id) && id >= 1 && id <= SIDE * SIDE)) return null;
        const x = (id - 1) % SIDE;
        const y = Math.floor((id - 1) / SIDE);
        return { id, secClass: y < 3 ? "highsec" : y < 6 ? "lowsec" : "nullsec", regionId: x < 5 ? 10000002 : 10000003,
          constellationId: 20000001 };
      };
      const graph = { getSystem: sysOf,
        getSystemIds: () => [...Array.from({ length: SIDE * SIDE }, (_v, i) => i + 1), ...JOVE],
        getNeighbors: (id) => {
          if (JOVE.includes(id)) return id === 103 ? null : [];
          const x = (id - 1) % SIDE;
          const out = [];
          if (x > 0) out.push(id - 1);
          if (x < SIDE - 1) out.push(id + 1);
          if (id > SIDE) out.push(id - SIDE);
          if (id <= SIDE * (SIDE - 1)) out.push(id + SIDE);
          return out;
        } };
      const factionOf = (id) => ((id - 1) % SIDE < 5 ? F : G);
      const vc = { getOwnerIdentity: (_k, gangId) => ({ ok: true, state: "LINKED", corporationId: 98000000 + gangId,
        characterIds: [0, 1, 2, 3, 4].map((n) => gangId * 100 + n), memberIndexes: [0, 1, 2, 3, 4], refusedMemberCount: 0 }),
      ensureOwnerIdentity: () => ({ ok: true, queued: true }),
      countOwnerCharacters: () => ({ ok: true, ready: true, total: 0 }) };
      const run = (opened, P, policy) => {
        const svc = createBountyService({ store: opened.store, worldSeed: 5, settings: P, factionIds: P.ids,
          levels: LEVELS, getGraph: () => graph, getVirtualCorps: () => vc,
          homeStationOf: () => ({ stationId: 60000001, corporationId: 1000127, systemId: 1 }),
          bloodlinesOf: () => [1, 2, 11], ownerCharacterBudget: 2048, systemFactionsOf: policy });
        assert.strictEqual(svc.boot(T0).ok, true);
        return svc;
      };
      const policy = (ids) => ({ ok: true, entries: ids.map((systemId) => ({ systemId, factionId: factionOf(systemId) })) });
      const rowsOf = (opened) => {
        const q = opened.store.transaction("bt5", (db) => db.prepare("SELECT faction_id AS f, system_id AS s, level "
          + "FROM world_bounty_targets WHERE state = 'ROAMING'").all().map((x) => ({ ...x })));
        assert.ok(q.ok, JSON.stringify(q));
        return q.value;
      };
      let both = null;
      withStore(driver, (opened) => {
        const P = { ...base, ids: CANONICAL_GANG_FACTIONS };
        const svc = run(opened, P, policy);
        for (let i = 0; i < 20 && svc.getStatus().active < 20; i += 1) svc.runPass(T0 + 1000 * (i + 1));
        const st = svc.getStatus();
        assert.strictEqual(st.active, 20, JSON.stringify(st.counters));
        for (const row of rowsOf(opened)) {
          assert.ok(!JOVE.includes(row.s), "Never a gateless system");
          assert.strictEqual(factionOf(row.s), row.f, "target in the territory of its faction");
          assert.ok(LEVELS[row.level].secClasses.includes(sysOf(row.s).secClass));
        }
        const c = st.census;
        assert.strictEqual(c.byClass.highsec + c.byClass.lowsec + c.byClass.nullsec, 20);
        assert.ok(c.regions >= 1 && c.regions <= 2);
        assert.deepStrictEqual(c.territory[F], { highsec: 15, lowsec: 15, nullsec: 20, gangs: 2 });
        assert.deepStrictEqual(c.territory[G], { highsec: 15, lowsec: 15, nullsec: 20, gangs: 2 });
        both = c.territory;
      });
      withStore(driver, (opened) => {
        const svc = run(opened, { ...base, ids: [F] }, policy);
        for (let i = 0; i < 20; i += 1) svc.runPass(T0 + 1000 * (i + 1));
        const st = svc.getStatus();
        assert.deepStrictEqual(st.census.territory, both, "The filter never moves a gang");
        assert.strictEqual(st.gangs.off, 2);
        assert.strictEqual(st.active, 10);
        assert.ok(rowsOf(opened).every((row) => row.f === F));
      });
      withStore(driver, (opened) => {
        let calls = 0;
        const flaky = (ids) => {
          calls += 1;
          return calls === 1 ? { ok: false, reason: "FACTION_POLICY_DRIFT" } : policy(ids);
        };
        const svc = run(opened, { ...base, ids: CANONICAL_GANG_FACTIONS }, flaky);
        const first = svc.runPass(T0 + 1000);
        assert.deepStrictEqual([first.ok, first.reason], [false, "NOT_READY"]);
        assert.strictEqual(svc.getStatus().counters.territoryFailed, 1);
        svc.runPass(T0 + 2000);
        assert.strictEqual(calls, 1, "no retry before territoryRetryMs");
        assert.strictEqual(svc.runPass(T0 + 1000 + base.territoryRetryMs).ok, true);
        assert.strictEqual(calls, 2);
        assert.ok(svc.getStatus().census.territory);
      });
    });
};
