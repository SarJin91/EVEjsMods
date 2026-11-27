"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const { settingsOf, TARGET_REASON } = require("../../lib/highsecLife/schema");
const { computeCivilianTarget, buildHubDistance } = require("../../lib/highsecLife/density");
const { orderCivilians, releasedByChurn } = require("../../lib/highsecLife/churn");
const { startHighsecLife } = require("../../lib/highsecLife");
const { buildPilotCandidates } = require("../../lib/virtualCorps/pilotCandidates");
const { buildOwnerPlan } = require("../../lib/virtualCorps/identityPlan");
const { OWNER_KINDS, OWNER_PREFIXES, IDENTITY_STATES } = require("../../lib/virtualCorps/schema");
const { buildCrewPool } = require("../../lib/crews/pool");
const virtualCorps = require("../../lib/virtualCorps");
const VC_DATA = require("../../lib/strategy/data/virtualCorps");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SEED = 424242;
const PEAK_MS = Date.UTC(2026, 10, 10, 17, 0, 0);

const JITA = 30000142;
const AMARR = 30002187;
const PERIMETER = 30000144;
const SYS_A = 30000145;
const SYS_B = 30000146;
const SYS_C = 30000147;
const SYS_D = 30002188;
const LOW = 30002813;

function baseConfig(patch) {
  const r = resolveConfig({ modDir: MOD_DIR, env: {} });
  assert.strictEqual(r.ok, true);
  const c = r.config;
  const p = patch || {};
  return { ...c, modules: { ...c.modules, virtualCorps: { ...c.modules.virtualCorps, enabled: p.vc !== false } },
    localPilots: { ...c.localPilots, enabled: p.lp !== false },
    highsecLife: { ...c.highsecLife, ...(p.hs || {}), enabled: p.enabled !== false,
      civilians: { enabled: p.civilians !== false } } };
}

function fakeGraph() {
  const edges = [[JITA, PERIMETER], [PERIMETER, SYS_A], [SYS_A, SYS_B], [SYS_B, SYS_C], [AMARR, SYS_D], [SYS_C, LOW]];
  const nb = new Map();
  for (const [a, b] of edges) {
    if (!nb.has(a)) nb.set(a, []);
    if (!nb.has(b)) nb.set(b, []);
    nb.get(a).push(b);
    nb.get(b).push(a);
  }
  const high = [JITA, PERIMETER, SYS_A, SYS_B, SYS_C, AMARR, SYS_D];
  return {
    getNeighbors: (id) => (nb.has(id) ? nb.get(id) : null),
    getSystemsBySecClass: (c) => (c === "highsec" ? high : c === "lowsec" ? [LOW] : []),
    getSystem: (id) => (nb.has(id) ? { systemId: id, constellationId: 20000020, regionId: 10000002 } : null),
  };
}

module.exports = ({ test }) => {
  test("HSL1 density: Jita > hub > 1 jump > 3 stations > none, lowsec BAND_OFF, deterministic, <= cap; hub BFS", () => {
    const S = settingsOf(baseConfig({ hs: { jitterPermille: 0 } })).settings;
    const t = (sys) => computeCivilianTarget({ secClass: "highsec", stationCount: 0, hubJumps: null, isHub: false,
      isPrimeHub: false, ...sys }, PEAK_MS, SEED, S);
    const jita = t({ systemId: JITA, stationCount: 3, hubJumps: 0, isHub: true, isPrimeHub: true });
    const hub = t({ systemId: AMARR, stationCount: 3, hubJumps: 0, isHub: true });
    const near = t({ systemId: PERIMETER, hubJumps: 1 });
    const stations = t({ systemId: SYS_C, stationCount: 3 });
    const none = t({ systemId: SYS_B });
    assert.deepStrictEqual([jita, hub, near, stations, none], [{ wanted: 85, reason: "HUB" },
      { wanted: 50, reason: "HUB" }, { wanted: 18, reason: "NEAR_HUB" }, { wanted: 5, reason: "STATIONS" },
      { wanted: 2, reason: "BASE" }]);
    assert.deepStrictEqual(t({ systemId: LOW, secClass: "lowsec", stationCount: 5 }),
      { wanted: 0, reason: TARGET_REASON.BAND_OFF });
    const J = settingsOf(baseConfig()).settings;
    const sys = { systemId: JITA, secClass: "highsec", stationCount: 3, hubJumps: 0, isHub: true, isPrimeHub: true };
    const seen = new Set();
    for (let b = 0; b < 24; b += 1) {
      const at = PEAK_MS + b * J.bucketMs;
      const one = computeCivilianTarget(sys, at, SEED, J);
      assert.deepStrictEqual(computeCivilianTarget(sys, at, SEED, J), one, "deterministic");
      assert.ok(one.wanted >= 0 && one.wanted <= J.maxCiviliansPerSystem, `cap ${one.wanted}`);
      seen.add(one.wanted);
    }
    assert.ok(seen.size > 1, "jitter moves the value between buckets");
    const capped = settingsOf(baseConfig({ hs: { maxCiviliansPerSystem: 30 } })).settings;
    assert.ok(computeCivilianTarget(sys, PEAK_MS, SEED, capped).wanted <= 30);

    const dist = buildHubDistance(fakeGraph(), [JITA, AMARR, 31999999], 3);
    assert.deepStrictEqual([...dist.entries()].sort((a, b) => a[0] - b[0]),
      [[JITA, 0], [PERIMETER, 1], [SYS_A, 2], [SYS_B, 3], [AMARR, 0], [SYS_D, 1]].sort((a, b) => a[0] - b[0]));
  });

  test("HSL2 churn: ~churnPermille released, deterministic, 0 = none; order changes between buckets", () => {
    const previous = new Map();
    for (let id = 1; id <= 1000; id += 1) previous.set(90000000 + id, { systemId: JITA, poolKey: "civ" });
    const r1 = releasedByChurn(previous, 7, SEED, 150);
    assert.ok(r1.size >= 100 && r1.size <= 200, `released ${r1.size}`);
    assert.deepStrictEqual([...releasedByChurn(previous, 7, SEED, 150)], [...r1], "deterministic");
    assert.notDeepStrictEqual([...releasedByChurn(previous, 8, SEED, 150)], [...r1], "next bucket differs");
    assert.strictEqual(releasedByChurn(previous, 7, SEED, 0).size, 0);
    const ids = [...previous.keys()].slice(0, 50);
    const o1 = orderCivilians(ids, 1, SEED);
    assert.deepStrictEqual(orderCivilians(ids, 1, SEED), o1, "deterministic");
    assert.notDeepStrictEqual(orderCivilians(ids, 2, SEED), o1, "bucket changes the order");
    assert.deepStrictEqual(o1.slice().sort((a, b) => a - b), ids, "same characters");
  });

  test("HSL3 civilian owner kind: prefix v, never a pilot / crew candidate; listCivilianCandidates LINKED only", () => {
    assert.strictEqual(OWNER_KINDS.CIVILIAN, "civilian");
    assert.strictEqual(OWNER_PREFIXES.civilian, "v");
    const plan = buildOwnerPlan({ ownerKind: "civilian", ownerId: 3, corporation: { name: "Jita Freight Collective",
      ticker: "JFCOL" }, members: 10 });
    assert.strictEqual(plan.ok, true);
    assert.deepStrictEqual(plan.entries.slice(0, 2).map((e) => e.key), ["v:3:corp:0", "v:3:corp:0:char:0"]);
    const row = (kind, ownerKind, ownerId, evejsId, key) => ({ kind, owner_kind: ownerKind, owner_id: ownerId,
      evejs_id: evejsId, identity_key: key, name: `n${evejsId}` });
    const linked = [
      row("corporation", "faction", 500010, 98000001, "f:500010:corp:0"),
      row("character", "faction", 500010, 91000001, "f:500010:corp:0:char:0"),
      row("character", "capsuleer", 1, 91000002, "c:1:corp:0:char:0"),
      row("corporation", "civilian", 1, 98000009, "v:1:corp:0"),
      row("character", "civilian", 1, 91000007, "v:1:corp:0:char:0"),
      row("character", "civilian", 1, 91000003, "v:1:corp:0:char:1"),
    ];
    const cands = buildPilotCandidates(linked);
    assert.deepStrictEqual(cands.map((c) => c.characterId), [91000001, 91000002]);
    const pool = buildCrewPool(cands, 2048, 1);
    assert.ok(![91000003, 91000007].some((id) => pool.info.has(id)), "no civilian in the crew pool");
    assert.ok(!pool.byCorp.has(98000009), "no civilian corporation in the crew pool");
    virtualCorps.stopVirtualCorps();
    try {
      virtualCorps.setRepoForTest({ readByState: (state) => ({ ok: true, rows: state === IDENTITY_STATES.LINKED
        ? linked : [row("character", "civilian", 2, 91000099, "v:2:corp:0:char:0")] }) });
      assert.deepStrictEqual(virtualCorps.listPilotCandidates().candidates.map((c) => c.characterId),
        [91000001, 91000002]);
      const civ = virtualCorps.listCivilianCandidates();
      assert.strictEqual(civ.ok, true);
      assert.ok(civ.version > 0);
      assert.deepStrictEqual(civ.characterIds, [91000003, 91000007]);
    } finally {
      virtualCorps.stopVirtualCorps();
    }
    assert.deepStrictEqual(virtualCorps.listCivilianCandidates(), { ok: true, version: 0, characterIds: [] });
    assert.deepStrictEqual(virtualCorps.createUnavailableVirtualCorps("NOT_STARTED").listCivilianCandidates(),
      { ok: false, reason: "NOT_STARTED" });
  });

  test("HSL4 service: off / dependency off -> no ensure; on -> slots 1..N; second start idempotent", async () => {
    const graph = fakeGraph();
    const stationsBy = new Map([[JITA, [60003760, 60003761, 60003762]], [AMARR, [60008494]], [SYS_C, [60000004]],
      [LOW, [60009999]]]);
    const rows = new Map();
    const calls = [];
    const vc = {
      ensureOwnerIdentity(spec) {
        calls.push(spec);
        const k = `${spec.ownerKind}:${spec.ownerId}`;
        if (!rows.has(k)) rows.set(k, { spec, linked: false });
        return { ok: true, queued: true };
      },
      getOwnerIdentity(kind, id) {
        const r = rows.get(`${kind}:${id}`);
        if (!r || !r.linked) return { ok: true, state: "PENDING" };
        return { ok: true, state: "LINKED", characterIds: Array.from({ length: r.linked }, (_, i) => 9000 + i),
          ...(r.refused ? { refusedMemberCount: r.refused } : {}) };
      },
    };
    const deps = (config) => ({ config, worldSeed: SEED,
      getGraph: () => ({ whenReady: () => Promise.resolve({ ok: true, graph }) }), getVirtualCorps: () => vc,
      listStations: (id) => ({ ok: true, stations: (stationsBy.get(id) || []).map((stationId) => ({ stationId,
        corporationId: 1000035, name: null })) }),
      bloodlinesOf: (f) => (VC_DATA.getById(f) ? VC_DATA.getById(f).bloodlineIds : null) });
    assert.deepStrictEqual(startHighsecLife(deps(baseConfig({ enabled: false }))), { ok: false,
      reason: "disabled_by_config" });
    assert.strictEqual(startHighsecLife(deps(baseConfig({ civilians: false }))).reason, "disabled_by_config");
    assert.strictEqual(startHighsecLife(deps(baseConfig({ lp: false }))).reason, "disabled_by_dependency");
    assert.strictEqual(startHighsecLife(deps(baseConfig({ vc: false }))).reason, "disabled_by_dependency");
    assert.strictEqual(calls.length, 0, "off = zero ensureOwnerIdentity");

    const config = baseConfig({ hs: { civilianCorps: 5 } });
    const first = startHighsecLife(deps(config));
    assert.strictEqual(first.ok, true);
    await first.highsecLife.whenReady();
    assert.strictEqual(first.highsecLife.getStatus().state, "running");
    assert.deepStrictEqual(calls.map((s) => s.ownerId), [1, 2, 3, 4, 5]);
    const empire = new Set([500001, 500002, 500003, 500004].flatMap((f) => VC_DATA.getById(f).bloodlineIds));
    for (const s of calls) {
      assert.strictEqual(s.ownerKind, "civilian");
      assert.strictEqual(s.members, 10);
      assert.ok([60000004, 60003760, 60003761, 60003762, 60008494].includes(s.stationId), "highsec NPC station");
      assert.ok(s.bloodlineIds.length === empire.size && s.bloodlineIds.every((b) => empire.has(b)));
      assert.ok(Number.isInteger(s.securityRating) && s.securityRating >= 0 && s.securityRating <= 2);
    }
    const jita = first.highsecLife.describeSystem(JITA);
    assert.deepStrictEqual({ ...jita }, { systemId: JITA, secClass: "highsec", stationCount: 3, hubJumps: 0,
      isHub: true, isPrimeHub: true });
    assert.strictEqual(first.highsecLife.describeSystem(LOW), null, "outside the bands");
    first.highsecLife.stop();

    const before = calls.slice();
    const second = startHighsecLife(deps(config));
    await second.highsecLife.whenReady();
    assert.deepStrictEqual(calls.slice(5), before, "same specs on a restart");
    assert.strictEqual(rows.size, 5, "no new owner");
    second.highsecLife.stop();
    for (const r of rows.values()) r.linked = 10;
    const third = startHighsecLife(deps(config));
    await third.highsecLife.whenReady();
    assert.strictEqual(calls.length, 10, "LINKED owners are skipped");
    assert.strictEqual(third.highsecLife.getStatus().counters.identitiesLinked, 5);
    third.highsecLife.stop();
    rows.get("civilian:2").linked = 3;
    const fourth = startHighsecLife(deps(config));
    await fourth.highsecLife.whenReady();
    assert.deepStrictEqual(calls.slice(10).map((s) => s.ownerId), [2], "short LINKED owner goes to ensure");
    assert.strictEqual(fourth.highsecLife.getStatus().counters.identitiesLinked, 4);
    assert.strictEqual(fourth.highsecLife.getStatus().counters.identitiesEnsured, 1);
    assert.strictEqual(fourth.highsecLife.getStatus().counters.stationsReadFailed, 0);
    fourth.highsecLife.stop();
    Object.assign(rows.get("civilian:2"), { linked: 9, refused: 1 });
    const fifth = startHighsecLife(deps(config));
    await fifth.highsecLife.whenReady();
    assert.strictEqual(calls.length, 11, "LINKED + refused members = closed, no ensure");
    assert.strictEqual(fifth.highsecLife.getStatus().counters.identitiesLinked, 5);
    assert.strictEqual(fifth.highsecLife.getStatus().counters.membersRefused, 1);
    fifth.highsecLife.stop();
    const logs = [];
    const sixth = startHighsecLife({ ...deps(config), logger: { log: (l) => logs.push(l) },
      listStations: () => { throw new Error("boom"); } });
    await sixth.highsecLife.whenReady();
    assert.ok(sixth.highsecLife.getStatus().counters.stationsReadFailed > 0);
    assert.strictEqual(sixth.highsecLife.describeSystem(JITA).stationCount, 0);
    assert.ok(logs.some((l) => /stations read failed in \d+ systems - density falls back to BASE/.test(l)),
      logs.join("|"));
    sixth.highsecLife.stop();
  });
};

module.exports.harness = { fakeGraph, baseConfig, SEED, JITA, PERIMETER, SYS_C, LOW };
