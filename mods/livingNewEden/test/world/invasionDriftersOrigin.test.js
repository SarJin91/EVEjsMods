"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const P = require("../../lib/world/invasions/rollPlanner");
const { PROFILES, INVADER_PROFILES_VERSION } = require("../../lib/world/invasions/data/invaderProfiles");
const { createInvasionService } = require("../../lib/world/invasions/invasionService");
const { readSystemList } = require("../../lib/adapter/trigDrifterLists");
const { EXPANSION_EXCLUDED_REGION_IDS } = require("../../lib/strategy/data/expansion");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const REPO_ROOT = path.resolve(MOD_DIR, "..", "..");
const AUTHORITY = path.join(REPO_ROOT, "server", "src", "space", "npc", "trigDrifter", "trigDrifterSpawnAuthority.js");
const SETUP_DIR = path.join(REPO_ROOT, "tools", "DatabaseCreator");
const AUTHORITY_POLICY = path.join(SETUP_DIR, "setupInputs", "overrides", "trigDrifterSpawns.json");
const AUTHORITY_BUILDER = path.join(SETUP_DIR, "build-trig-drifter-systems.js");
const SDE_SYSTEMS = path.join(REPO_ROOT, "_local", "sde", "eve-online-static-data-3396210-jsonl", "mapSolarSystems.jsonl");
const LIST_KEY = "knownSpaceJoveObservatorySystemIDs";
const DRF = 500024;
const TRIG = 500026;
const DEATHLESS = 500029;
const SYSTEMS = Array.from({ length: 12 }, (_, i) => 30000001 + i);

const BASE = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir() } });

function configOf(origin) {
  assert.deepStrictEqual(BASE.errors || [], []);
  const c = BASE.config;
  return { ...c, invasions: { ...c.invasions, chancePermille: 1000, maxActivePerFaction: 3,
    drifters: { ...c.invasions.drifters, enabled: true, originObservatories: origin } } };
}

function rig({ origin, active, read }) {
  const logs = [];
  const counted = [];
  const registry = { getFaction: (f) => (active.includes(f) ? { kind: "invader" } : null),
    isActive: (f) => active.includes(f), getDoctrine: () => null };
  const graph = { getSystemsBySecClass: (c) => (c === "nullsec" ? SYSTEMS : []),
    getSystem: (id) => (SYSTEMS.includes(id) ? { systemId: id, secClass: "nullsec", regionId: 10000001 } : null) };
  const fakeTx = { prepare: () => ({ get: () => ({ c: 0 }), all: () => [] }) };
  const svc = createInvasionService({ config: configOf(origin), coreIndex: { enabled: false, systems: new Map() },
    store: { transaction: (_n, fn) => ({ ok: true, value: fn(fakeTx) }) },
    repository: { getSystem: () => ({ ok: true, system: { occupationState: "STABLE", controllerFactionId: null } }) },
    graph: { getGraph: () => ({ ok: true, graph }) },
    stations: { getMode: () => "ready", repository: { countLiveBySystem: () => ({ ok: true, rows: [] }) } },
    sovClaims: { claimOf: () => ({ ok: true, claimed: false }) }, strategy: { registry },
    scheduler: { registerHandler: () => ({ unregister() {} }) },
    telemetry: { count: (name, n) => counted.push([name, n]) }, logger: { log: (l) => logs.push(l) },
    nowMs: () => 0, worldSeed: 77, readTrigDrifterSystemList: read });
  const roll = (round) => {
    const r = svc.rollHandlerFn({ payload: { round } }, { now: 0 });
    assert.ok(r.ok, JSON.stringify(r));
    r.onCommitted({ ok: true });
    return svc.getStatus().lastDecision;
  };
  return { svc, roll, logs, counted };
}

const ROUNDS = [1, 2, 3, 5, 8, 13];

module.exports = ({ test, skip }) => {
  test("TDO1 filter only for the profile with targetListKey: Trig/Deathless rolls equal on/off; DRF only on the list", () => {
    assert.strictEqual(INVADER_PROFILES_VERSION, 7);
    assert.deepStrictEqual(PROFILES.filter((p) => p.targetListKey).map((p) => [p.profileId, p.targetListKey]),
      [["drifter-wormhole-v1", LIST_KEY]]);
    const list = () => ({ ok: true, systemIds: [30000004, 30000009] });
    const off = rig({ origin: false, active: [TRIG, DEATHLESS], read: list });
    const on = rig({ origin: true, active: [TRIG, DEATHLESS], read: list });
    for (const round of ROUNDS) {
      const a = off.roll(round);
      assert.strictEqual(a.outcome, "SPAWN", JSON.stringify(a));
      assert.deepStrictEqual(on.roll(round), a, `round ${round}`);
    }
    const drf = rig({ origin: true, active: [DRF], read: list });
    for (const round of ROUNDS) {
      const d = drf.roll(round);
      assert.strictEqual(d.factionId, DRF);
      assert.ok([30000004, 30000009].includes(d.targetSystemId), JSON.stringify(d));
    }
    assert.strictEqual(drf.svc.getStatus().counters.targetListFiltered, ROUNDS.length);
    assert.strictEqual(drf.svc.getStatus().counters.targetListUnavailable, 0);
    const s = { systemId: 1, row: { occupationState: "STABLE", controllerFactionId: null }, lists: { "drifter-wormhole-v1": false } };
    const prof = PROFILES.find((p) => p.factionId === DRF);
    assert.strictEqual(P.eligibleTarget(s, DRF, {}, prof), false);
    const { targetListKey: _k, ...bare } = prof;
    assert.strictEqual(P.eligibleTarget(s, DRF, {}, bare), true);
    assert.strictEqual(P.eligibleTarget(s, DRF, {}), true);
  });

  test("TDO2 adapter refuses -> DRF rolls without the filter, targetListUnavailable 1, one WARN in two rolls", () => {
    let calls = 0;
    const refuse = () => { calls += 1; return { ok: false, reason: "SEAM_UNAVAILABLE", detail: "drift" }; };
    const free = rig({ origin: false, active: [DRF], read: null });
    const failed = rig({ origin: true, active: [DRF], read: refuse });
    const d1 = failed.roll(1);
    assert.deepStrictEqual(d1, free.roll(1));
    assert.strictEqual(d1.outcome, "SPAWN");
    assert.strictEqual(failed.svc.getStatus().counters.targetListUnavailable, 1);
    assert.deepStrictEqual(failed.svc.getStatus().counters.targetListFiltered, 0);
    assert.deepStrictEqual(failed.roll(2), free.roll(2));
    assert.strictEqual(calls, 2, "a refusal is asked again by the next roll");
    assert.strictEqual(failed.logs.filter((l) => l.includes("target list unavailable")).length, 1, failed.logs.join("\n"));
    assert.deepStrictEqual(failed.counted.filter(([n]) => n === "world.invasions.targetListUnavailable"),
      [["world.invasions.targetListUnavailable", 1], ["world.invasions.targetListUnavailable", 1]]);
    assert.deepStrictEqual(readSystemList(null, LIST_KEY), { ok: false, reason: "SEAM_UNAVAILABLE", detail: "getSystemList" });
    assert.deepStrictEqual(readSystemList({ getSystemList: () => [] }, LIST_KEY), { ok: false, reason: "EMPTY", detail: LIST_KEY });
    assert.strictEqual(readSystemList({ getSystemList: () => [1] }, "").reason, "INVALID_INPUT");
    assert.strictEqual(readSystemList({ getSystemList: () => { throw new Error("x"); } }, LIST_KEY).reason, "SEAM_UNAVAILABLE");
    assert.deepStrictEqual(readSystemList({ getSystemList: () => [5, "3", 5, -1, 2.5] }, LIST_KEY), { ok: true, systemIds: [3, 5] });
  });

  test("TDO3 flag off: the adapter is never called, the decision = no adapter, no list counters", () => {
    let calls = 0;
    const spy = () => { calls += 1; return { ok: true, systemIds: [30000004] }; };
    const off = rig({ origin: false, active: [DRF, TRIG], read: spy });
    const bare = rig({ origin: false, active: [DRF, TRIG], read: null });
    assert.ok(off.svc.start().ok);
    for (const round of ROUNDS) assert.deepStrictEqual(off.roll(round), bare.roll(round), `round ${round}`);
    assert.strictEqual(calls, 0);
    const counters = off.svc.getStatus().counters;
    assert.ok(!("targetListUnavailable" in counters) && !("targetListFiltered" in counters), Object.keys(counters).join());
  });

  const authorityInputs = [AUTHORITY, AUTHORITY_POLICY, AUTHORITY_BUILDER, SDE_SYSTEMS];
  if (!authorityInputs.every((file) => fs.existsSync(file))) {
    skip("TDO4 vendor fact", "server/src, the trig drifter setup policy / builder or the local SDE not found");
  } else {
    test("TDO4 vendor fact: getSystemList export, gameStore at require, list key, list ∩ nullsec >= 50", () => {
      const src = fs.readFileSync(AUTHORITY, "utf8").replace(/\r\n/g, "\n");
      assert.match(src, /module\.exports = \{\n {2}SYSTEM_LISTS,\n {2}getSystemList,\n\};/);
      assert.match(src, /const database = require\(path\.join\(__dirname, "\.\.\/\.\.\/\.\.\/gameStore"\)\);/);
      assert.match(src, /database\.read\("trigDrifterSpawnAuthority", "\/"\)/);
      assert.match(src, /const authorityRoot = readAuthorityRoot\(\);/);
      assert.match(src, /return Array\.isArray\(list\) \? \[\.\.\.list\] : \[\];/);
      const builder = fs.readFileSync(AUTHORITY_BUILDER, "utf8").replace(/\r\n/g, "\n");
      assert.ok(builder.includes("const observatories = selection(policy.observatorySystemIDs, \"observatory\");")
        && builder.includes(`    ${LIST_KEY}: observatories,`), "the setup table list comes from the policy");
      const setupTables = fs.readFileSync(path.join(SETUP_DIR, "build-setup-tables.js"), "utf8");
      assert.ok(setupTables.includes("trigDrifterSpawnAuthority: buildTrigDrifterSystems(authority, generatedAt),"));
      const list = JSON.parse(fs.readFileSync(AUTHORITY_POLICY, "utf8")).observatorySystemIDs;
      assert.ok(Array.isArray(list) && list.length > 0, "observatorySystemIDs in the setup policy");
      const excluded = new Set(EXPANSION_EXCLUDED_REGION_IDS);
      const nullsec = new Set();
      for (const line of fs.readFileSync(SDE_SYSTEMS, "utf8").split("\n")) {
        if (!line.trim()) continue;
        const r = JSON.parse(line);
        if (r._key < 31000000 && r.securityStatus < 0 && !excluded.has(r.regionID)) nullsec.add(r._key);
      }
      const hits = list.filter((id) => nullsec.has(id)).length;
      assert.ok(hits >= 50, `list ∩ nullsec = ${hits}`);
    });
  }
};
