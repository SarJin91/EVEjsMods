"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const { startAmbientRats, createUnavailableAmbientRats } = require("../../lib/ambientRats");
const { parseGatePicketTiers, gatePicketCount } = require("../../lib/ambientRats/gatePickets");
const { COUNTER_NAMES } = require("../../lib/ambientRats/schema");
const { buildDefaultServiceDefs } = require("../../lib/runtime/services");
const { PIRATE_KEY_BY_FACTION_ID } = require("../../lib/adapter/data/liveProfiles");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const BASE = resolveConfig({ modDir: MOD_DIR, env: {} }).config;
const GURISTAS = 500010;
const SYS = 30001001;
const T0 = 1_000_000;
const FAR = 5_000_000;
const P = (x) => ({ x, y: 0, z: 0 });
const ANCHORS = [
  { itemId: 40000001, kind: "planet", position: P(FAR * 4) },
  { itemId: 40000002, kind: "planet", position: P(FAR * 5) },
  { itemId: 50000001, kind: "stargate", position: P(0) },
  { itemId: 50000002, kind: "stargate", position: P(FAR * 2) },
  { itemId: 50000003, kind: "stargate", position: P(FAR * 3) },
];

function rig(overrides, risk) {
  const config = { ...BASE, ambientRats: { ...BASE.ambientRats, enabled: true, groupsNullsec: 2, ...overrides } };
  let now = T0;
  const calls = { spawn: [], snapshot: [], risk: 0 };
  const counts = new Map();
  const bad = [];
  const live = new Set();
  let nextId = 9000;
  const seam = {
    bandOf: () => ({ ok: true, band: "nullsec", eligible: true }),
    snapshot: (_systemId, opts) => {
      calls.snapshot.push(opts.anchorKinds);
      const kinds = new Set(String(opts.anchorKinds).split(",").map((k) => k.trim()));
      return { ok: true, anchors: ANCHORS.filter((a) => kinds.has(a.kind)), blockers: [], ambientIds: [...live] };
    },
    spawnGroup: (input) => {
      calls.spawn.push(input.anchorId);
      nextId += 1;
      live.add(nextId);
      return { ok: true, entityIds: [nextId] };
    },
    classifyIds: (_s, ids) => ({ ok: true, live: ids.filter((id) => live.has(id)), dormant: [], gone: [] }),
    setAggro: () => ({ ok: true, changed: 0 }),
  };
  const anchorOf = (id) => ANCHORS.find((a) => a.itemId === id) || ANCHORS[0];
  const started = startAmbientRats({ config, clock: { now: () => now }, logger: { log() {} },
    telemetry: { count: (name, n) => {
      const short = name.replace(/^world\.ambientRats\./, "");
      if (!COUNTER_NAMES.includes(short)) bad.push(name);
      counts.set(short, (counts.get(short) || 0) + n);
    }, gauge() {}, observe() {} },
    getPresence: () => ({ observedSystems: () => [SYS], getSystemPresence: () => ({ space: 1, characters: [] }) }),
    getWorld: () => ({ getControllerMemo: () => ({ ok: true, controllerFactionId: GURISTAS }) }),
    getFactionKind: () => "pirate", seam,
    hunt: { readPlayerShips: () => ({ ok: true, ships: [{ characterId: 7, entityId: 70, position: P(0) }] }) },
    scene: { readGroup: (_s, ids) => ({ ok: true, ships: ids.map((id) => ({ entityId: id,
      position: anchorOf(calls.spawn[id - 9001]).position })) }), orderGroup: () => ({ ok: true, failed: [] }) },
    spawn: { despawn: () => ({ ok: true }), setRelation: () => ({ ok: true, changed: 0 }) },
    readStanding: () => ({ ok: true, standing: 0 }),
    tables: { pirateKeyByFactionId: PIRATE_KEY_BY_FACTION_ID, navyFactionIds: [] },
    getTransit: () => ({ riskOf: (systemId) => {
      calls.risk += 1;
      return typeof risk === "function" ? risk(systemId) : risk;
    } }),
    rng: () => 0, setTimer: () => ({ cancel() {}, hasRef: () => false }), nowMs: () => 0 });
  assert.strictEqual(started.ok, true, JSON.stringify(started));
  const svc = started.ambientRats;
  const passes = (n) => {
    for (let i = 0; i < n; i += 1) {
      now = T0 + i * config.ambientRats.spawnIntervalMs;
      svc.runPass();
    }
  };
  const polls = (n) => {
    for (let i = 0; i < n; i += 1) {
      now += config.ambientRats.pollMs;
      svc.runPass();
    }
  };
  return { svc, calls, counts, bad, passes, polls, config };
}

const entry = (chanceBase, controllerFactionId = GURISTAS) => ({ systemId: SYS, controllerFactionId,
  secClass: "nullsec", influence: 100, garrison: 0, gateSentries: 0, chanceBase });

module.exports = ({ test }) => {
  test("GP1 tiers: parse valid / bad lists, tier -> gates <= maxGates, bad env -> warning and default", () => {
    const tiers = parseGatePicketTiers("100:1, 200:2,300:3");
    assert.deepStrictEqual(tiers, [{ chancePermille: 100, gates: 1 }, { chancePermille: 200, gates: 2 },
      { chancePermille: 300, gates: 3 }]);
    for (const bad of ["", "100", "100:1,100:2", "200:2,100:1", "100:2,200:1", "100:0", "1001:1", "100:9", "a:1",
      "100:1,,200:2", "1:1,2:1,3:1,4:1,5:1,6:1,7:1,8:1,9:1", null]) {
      assert.strictEqual(parseGatePicketTiers(bad), null, String(bad));
    }
    assert.deepStrictEqual([0, 99, 100, 199, 200, 299, 300, 1000].map((c) => gatePicketCount(c, tiers, 3)),
      [0, 0, 1, 1, 2, 2, 3, 3]);
    assert.deepStrictEqual([gatePicketCount(500, tiers, 2), gatePicketCount(500, tiers, 0),
      gatePicketCount(NaN, tiers, 3), gatePicketCount(500, null, 3)], [2, 0, 0, 0]);
    assert.deepStrictEqual([BASE.ambientRats.gatePicketsEnabled, BASE.ambientRats.gatePicketTiers,
      BASE.ambientRats.gatePicketMaxGates], [false, "100:1,200:2,300:3", 3]);
    const r = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_AMBIENT_RATS_GATE_PICKET_TIERS: "300:1,200:2",
      EVEJS_LNE_AMBIENT_RATS_GATE_PICKET_MAX_GATES: "20" } });
    assert.ok(r.warnings.some((w) => w.includes("EVEJS_LNE_AMBIENT_RATS_GATE_PICKET_TIERS")), r.warnings.join("\n"));
    assert.deepStrictEqual([r.config.ambientRats.gatePicketTiers, r.config.ambientRats.gatePicketMaxGates],
      ["100:1,200:2,300:3", 8]);
  });

  test("GP2 flag off = regular path bit for bit, zero riskOf reads; flag on + cold index = the same", () => {
    const off = rig({}, entry(350));
    off.passes(4);
    assert.deepStrictEqual(off.calls.spawn, [40000001, 40000002], "regular groups on planets, target 2");
    assert.strictEqual(off.calls.risk, 0, "flag off: riskOf never read");
    assert.ok(off.calls.snapshot.every((k) => k === BASE.ambientRats.anchorKinds));
    assert.strictEqual(off.svc.getStatus().gatePickets, undefined, "status additive only with the flag");
    assert.strictEqual(off.counts.get("gatePicketsSpawned"), undefined);

    const cold = rig({ gatePicketsEnabled: true }, null);
    cold.passes(4);
    assert.deepStrictEqual([cold.calls.spawn, cold.calls.snapshot], [off.calls.spawn, off.calls.snapshot]);
    assert.ok(cold.calls.risk > 0, "the cold index was asked");
    assert.deepStrictEqual(cold.svc.getStatus().gatePickets, { active: true, groups: 0 });
    assert.deepStrictEqual([...off.bad, ...cold.bad], []);
  });

  test("GP3 warm index: pickets on free gates first, apart from groupsNullsec, fallback, other controller", () => {
    const h = rig({ gatePicketsEnabled: true }, entry(350));
    h.passes(5);
    assert.deepStrictEqual(h.calls.spawn, [50000002, 50000003, 40000001, 40000002]);
    assert.ok(!h.calls.spawn.includes(50000001), "no picket on the arrival gate");
    assert.strictEqual(h.counts.get("gatePicketsSpawned"), 2);
    assert.strictEqual(h.counts.get("spawned"), 4);
    assert.deepStrictEqual(h.svc.getStatus().gatePickets, { active: true, groups: 2 });
    assert.deepStrictEqual(h.svc.getStatus().groups, 4, "2 pickets + groupsNullsec 2");
    assert.ok(h.counts.get("deferred.NO_ANCHOR") >= 1, "picket wanted, no gate, regular slots full");

    const one = rig({ gatePicketsEnabled: true }, entry(150));
    one.passes(4);
    assert.deepStrictEqual(one.calls.spawn, [50000002, 40000001, 40000002]);
    assert.strictEqual(one.counts.get("gatePicketsSpawned"), 1);

    const other = rig({ gatePicketsEnabled: true }, entry(350, 500011));
    other.passes(3);
    assert.deepStrictEqual(other.calls.spawn, [40000001, 40000002]);
    const zero = rig({ gatePicketsEnabled: true, gatePicketMaxGates: 0 }, entry(350));
    zero.passes(3);
    assert.deepStrictEqual([zero.calls.spawn, zero.calls.risk], [[40000001, 40000002], 0]);
    assert.deepStrictEqual(zero.svc.getStatus().gatePickets, { active: false, groups: 0 });
    assert.deepStrictEqual([...h.bad, ...one.bad, ...other.bad, ...zero.bad], []);
  });

  test("GP5 picket with no free gate, regular slots full: at most one snapshot per spawnIntervalMs", () => {
    const h = rig({ gatePicketsEnabled: true }, entry(350));
    h.passes(5);
    assert.strictEqual(h.svc.getStatus().groups, 4, "steady state: 2 pickets + 2 regular, third picket wanted");
    const snaps = h.calls.snapshot.length;
    const misses = h.counts.get("deferred.NO_ANCHOR");
    const n = 24;
    h.polls(n);
    const cap = Math.ceil((n * h.config.ambientRats.pollMs) / h.config.ambientRats.spawnIntervalMs);
    const extra = h.calls.snapshot.length - snaps;
    assert.ok(extra >= 1 && extra <= cap, `snapshots ${extra} in ${n} polls, cap ${cap}`);
    assert.strictEqual(h.counts.get("deferred.NO_ANCHOR") - misses, extra, "one NO_ANCHOR per real attempt");
    assert.ok(h.counts.get("deferred.SPAWN_INTERVAL") >= n - cap, "the other passes wait for the interval");
    assert.strictEqual(h.svc.getStatus().groups, 4);
    assert.deepStrictEqual(h.bad, []);
  });

  test("GP4 W66 / W63 warnings; services.js passes getTransit = ctx.transit", () => {
    const W66 = "ambientRats.gatePicketsEnabled without ambientRats.enabled";
    const W63 = "ambientRats.gatePicketsEnabled without transit.enabled";
    const ours = (env) => resolveConfig({ modDir: MOD_DIR, env }).warnings
      .filter((w) => w.startsWith("ambientRats.gatePicketsEnabled"));
    assert.deepStrictEqual(ours({}), []);
    const alone = ours({ EVEJS_LNE_AMBIENT_RATS_GATE_PICKETS_ENABLED: "1" });
    assert.ok(alone.length === 2 && alone[0].startsWith(W66) && alone[1].startsWith(W63), alone.join("\n"));
    assert.deepStrictEqual(ours({ EVEJS_LNE_AMBIENT_RATS_GATE_PICKETS_ENABLED: "1",
      EVEJS_LNE_AMBIENT_RATS_ENABLED: "1", EVEJS_LNE_TRANSIT_ENABLED: "1" }), []);

    const seen = [];
    const defs = buildDefaultServiceDefs({ startAmbientRats: (deps) => {
      seen.push(deps);
      return { ok: true, ambientRats: createUnavailableAmbientRats("x") };
    } });
    const def = defs.find((d) => d.name === "ambientRats");
    const transit = { riskOf: () => null };
    const ctx = { config: BASE, clock: { now: () => T0 }, adapter: {} };
    assert.deepStrictEqual(def.start(ctx, { logger: { log() {} } }), { ok: true });
    assert.strictEqual(seen[0].getTransit(), null, "no transit yet");
    ctx.transit = transit;
    assert.strictEqual(seen[0].getTransit(), transit, "read lazily");
  });
};
