"use strict";

const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");

const { resolveConfig, SCHEMA } = require("../../config");
const { validateCatalog, anomalyCatalogOf, listTemplateIds, EVENT_CATALOG, REWARD_EVENT_CATALOG,
  ANOMALY_EVENT_CATALOG, CAUSE } = require("../../lib/events/catalog");
const { DED_COMPLEX_TEMPLATES, BATTLE_RELIC_TEMPLATES, FACTION_LABELS } = require("../../lib/events/data/eventCatalog");
const { causesOfSystem } = require("../../lib/events/candidates");
const { gatherPulseContext, buildDirectorInput } = require("../../lib/events/context");
const { causeHolds } = require("../../lib/events/eventMachine");
const { chooseEvents } = require("../../lib/events/director");
const { createEventService } = require("../../lib/events/eventService");
const { startEvents } = require("../../lib/events");
const { PIRATE_KEY_BY_FACTION_ID } = require("../../lib/adapter/data/liveProfiles");
const { findPack, packLabel, authoredTemplates, isNativeRef } = require("../_support/contentPacks");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const DED_PACK = findPack("ded-rated-sites");
const RELIC_PACK = findPack("pirate-exploration");
const HOUR = 3600000;
const I = 300000;
const T0 = 5666667 * I;
const GURISTAS = 500010;
const ANGEL = 500011;
const BLOOD = 500012;
const AMARR = 500003;
const REGION = 10000060;

const ON = Object.freeze({ EVEJS_LNE_EVENT_ANOMALIES_DIRECTOR_KINDS_ENABLED: "1",
  EVEJS_LNE_EVENT_ANOMALIES_DED_COMPLEX_WEIGHT: "1", EVEJS_LNE_EVENT_ANOMALIES_BATTLE_RELICS_WEIGHT: "1" });

const DED_TABLE = {
  500010: [2265, 5233, 2262, 2257], 500011: [2477, 2246, 2261, 2256], 500012: [2245, 5237, 5221, 2260],
  500019: [2243, 5239, 5235, 2258], 500020: [2455, 5238, 5236, 2259],
};
const RELIC_TABLE = {
  500010: [[1808, 1814, 1819, 1825], [1763, 1793, 1852, 1860]],
  500011: [[1737, 1738, 1739, 1741], [1706, 1775, 1850, 1857]],
  500012: [[1811, 1817, 1822, 1828], [1743, 1791, 1853, 1859]],
  500019: [[1809, 1815, 1820, 1826], [1768, 1792, 1849, 1861]],
  500020: [[1810, 1816, 1821, 1827], [1773, 1830, 1835, 1862]],
  500025: [[12204, 12225, 12239, 12240], []],
};
const ids = (list) => list.map((n) => `client-dungeon:${n}`);

function configOf(env = {}) {
  const r = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(), EVEJS_LNE_EVENTS_ENABLED: "1",
    EVEJS_LNE_SITES_ENABLED: "1", EVEJS_LNE_EVENTS_PRESENCE_ACTIVATION: "0", ...env } });
  assert.deepStrictEqual(r.errors, []);
  return r.config;
}

function fakeTelemetry() {
  const counters = {};
  return { counters, count(name, n = 1) { counters[name] = (counters[name] || 0) + n; return true; },
    gauge() { return true; }, observe() { return true; } };
}

function fakeStore() {
  const tx = { inTransaction: true, transaction: (body) => (...args) => body(...args) };
  return { tx, transaction(name, fn) {
    try {
      return { ok: true, value: fn(tx) };
    } catch (err) {
      return { ok: false, reason: String(err && err.message) };
    }
  } };
}

function fakeWorld(systems, occ) {
  return { limits: { maxBatchReadIds: 400 },
    getSystems: (tx, list) => ({ ok: true, systems: list.filter((id) => systems.has(id)).map((id) => systems.get(id)),
      missing: list.filter((id) => !systems.has(id)) }),
    listActiveOccupations: () => ({ ok: true, systems: occ, nextAfterSystemId: null }) };
}

function fakeEventRepo(state) {
  return {
    listOpen: () => ({ ok: true, events: state.open, truncated: false }),
    listPendingCleanup: () => ({ ok: true, events: [] }),
    listRecent: () => ({ ok: true, truncated: false, rows: state.recent }),
    transitionInTx: (tx, id, version, patch) => {
      state.transitions.push([id, patch.state]);
      return { ok: true, version: version + 1 };
    },
    countOpenInSystem: () => ({ ok: true, count: 0 }),
    insertPlannedInTx: (tx, p) => {
      state.inserted.push(p);
      return { ok: true, inserted: true };
    },
    deleteEndedBefore: () => ({ ok: true, deleted: 0 }),
  };
}

const GRAPH = { getGraph: () => ({ ok: true, graph: { getSystem: (id) => ({ id, regionId: REGION, factionId: null }) } }) };
const sys = (systemId, extra = {}) => ({ systemId, securityClass: "nullsec", occupationState: "STABLE",
  occupierFactionId: null, controllerFactionId: AMARR, ...extra });

function settingsOf(config, catalog, battleRepo) {
  const factions = new Set();
  for (const t of catalog.types) {
    if (t.cause === CAUSE.BATTLE_AFTERMATH) for (const f of Object.keys(t.templatesByFaction)) factions.add(Number(f));
  }
  const A = config.eventAnomalies;
  return { windowMs: A.battleRelicsWindowMs, minLosses: A.battleRelicsMinLosses, maxLossRows: A.maxLossRows,
    maxSystems: A.battleRelicsMaxSystems, factions, getBattleRepository: () => battleRepo };
}

function rig({ config, catalog, aftermath = null, systems = new Map(), occ = [], open = [], recent = [],
  occupation = null, siteStates = {} }) {
  const store = fakeStore();
  const state = { open, recent, transitions: [], inserted: [] };
  const telemetry = fakeTelemetry();
  const lines = [];
  const world = fakeWorld(systems, occ);
  const sites = { listSitesByEvent: (id) => ({ ok: true, sites: (siteStates[id] || []).map((s) => ({ state: s })) }) };
  const svc = createEventService({ config, store, clock: { now: () => T0 }, ids: { next: () => "ev-new" },
    scheduler: { enqueue: () => ({ ok: true }), registerHandler: () => ({ ok: true }) }, catalog,
    world: () => ({ repository: world }), strategy: () => ({ listActiveCampaigns: () => ({ ok: true, campaigns: [] }) }),
    presence: () => null, graph: () => GRAPH, sites: () => sites, occupation: () => occupation, telemetry,
    logger: { log: (l) => lines.push(l) }, worldSeed: 1, nowMs: () => 0, repository: fakeEventRepo(state),
    ...(aftermath ? { aftermath } : {}) });
  return { state, telemetry, lines, svc, store,
    pulse(at) {
      const res = svc.pulseHandler({ payload: { intervalMs: config.events.refreshIntervalMs } },
        { now: at, anchorAt: at, lateMs: 0, catchUp: false });
      assert.ok(res.ok, JSON.stringify(res));
      const value = res.effect(store.tx);
      res.onCommitted(value);
      return value;
    } };
}

function catalogOf(env) {
  const r = validateCatalog([...EVENT_CATALOG, ...anomalyCatalogOf(configOf(env))]);
  assert.ok(r.ok, JSON.stringify(r.errors));
  return r.catalog;
}

function startTypes(config, extra = {}) {
  const store = fakeStore();
  const lines = [];
  const started = startEvents({ config, persistence: { ok: true, store, worldSeed: 1 }, clock: { now: () => T0 },
    ids: { next: () => "id" }, scheduler: { registerHandler: () => ({ ok: true, unregister() {} }),
      enqueue: () => ({ ok: true }) }, logger: { log: (l) => lines.push(l) }, ...extra });
  assert.ok(started.ok, JSON.stringify(started));
  started.events.stop("test");
  return { types: started.catalog.types.map((t) => t.eventType), catalog: started.catalog, lines, started };
}


module.exports = ({ test, skip, bench }) => {
  test("AN1 flag off bit for bit: anomalyCatalogOf [] (flag off + weights 100, flag on + weights 0), startEvents "
    + "catalog = v2 (+ rewards), causesOfSystem without / with null equal, zero loss reads", () => {
    const off = configOf({ EVEJS_LNE_EVENT_ANOMALIES_DED_COMPLEX_WEIGHT: "100",
      EVEJS_LNE_EVENT_ANOMALIES_BATTLE_RELICS_WEIGHT: "100" });
    assert.strictEqual(off.eventAnomalies.directorKindsEnabled, false, "default off");
    assert.deepStrictEqual(anomalyCatalogOf(off), []);
    const zero = configOf({ EVEJS_LNE_EVENT_ANOMALIES_DIRECTOR_KINDS_ENABLED: "1" });
    assert.deepStrictEqual([zero.eventAnomalies.dedComplexWeight, zero.eventAnomalies.battleRelicsWeight], [0, 0]);
    assert.deepStrictEqual(anomalyCatalogOf(zero), []);
    const v2 = EVENT_CATALOG.map((t) => t.eventType);
    for (const cfg of [off, zero]) {
      const s = startTypes(cfg);
      assert.deepStrictEqual(s.types, v2);
      assert.strictEqual(s.catalog.version, 2);
      assert.ok(s.lines.some((l) => /^events: running .* director-kinds=none$/.test(l)), s.lines.join("\n"));
    }
    assert.deepStrictEqual(startTypes(configOf({ EVEJS_LNE_EVENT_REWARDS_ENABLED: "1",
      EVEJS_LNE_EVENT_ANOMALIES_DED_COMPLEX_WEIGHT: "100" })).types,
    [...EVENT_CATALOG, ...REWARD_EVENT_CATALOG].map((t) => t.eventType));

    const systems = [sys(1, { occupationState: "OCCUPIED", occupierFactionId: GURISTAS }),
      sys(2, { occupationState: "CONTESTED", occupierFactionId: AMARR, controllerFactionId: ANGEL, sdeFactionId: 500002 }),
      sys(3)];
    for (const s of systems) {
      const theatre = s.systemId === 3 ? [{ campaignId: "c1", ownerFactionId: AMARR }] : [];
      assert.deepStrictEqual(causesOfSystem(s, theatre, null), causesOfSystem(s, theatre));
      assert.deepStrictEqual(causesOfSystem(s, theatre, undefined), causesOfSystem(s, theatre));
    }

    let getterCalls = 0;
    const getBattleRepository = () => {
      getterCalls += 1;
      return { listVirtualLossesSince: () => ({ ok: true, losses: [], truncated: false }) };
    };
    const config = configOf();
    startTypes(config, { getBattleRepository });
    const r = rig({ config, catalog: catalogOf({}), systems: new Map([[1, systems[0]]]), occ: [systems[0]] });
    r.pulse(T0);
    const store = fakeStore();
    const read = store.transaction("t", (tx) => gatherPulseContext(tx, { repo: fakeEventRepo({ open: [], recent: [] }),
      worldRepository: fakeWorld(new Map(), []), sites: null, strategy: null, P: config.events, maxBatchReadIds: 400,
      lookbackMs: HOUR, cursor: 0, aftermath: null, getBattleRepository }, { at: T0, boot: false })).value;
    assert.strictEqual(read.ok, true);
    assert.ok(!("aftermath" in read) && !("aftermathStats" in read));
    assert.strictEqual(getterCalls, 0);
    assert.deepStrictEqual(Object.keys(r.telemetry.counters).filter((k) => k.startsWith("events.aftermath")), []);
    assert.deepStrictEqual(r.state.inserted.map((x) => x.eventType), ["pirate_stronghold"]);
  });

  test("AN2 catalog with the flag: validates with v2 + rewards, expected template tables, no 500021, "
    + "battle_relics without consequence, window max <= cooldown, labels <= 64", () => {
    const config = configOf({ ...ON, EVEJS_LNE_EVENT_ANOMALIES_DED_COMPLEX_WEIGHT: "7" });
    const kinds = anomalyCatalogOf(config);
    assert.deepStrictEqual(kinds.map((t) => [t.eventType, t.cause, t.weight, "weightKey" in t]),
      [["ded_complex", "OCCUPATION_HELD", 7, false], ["battle_relics", "BATTLE_AFTERMATH", 1, false]]);
    const r = validateCatalog([...EVENT_CATALOG, ...REWARD_EVENT_CATALOG, ...kinds]);
    assert.ok(r.ok, JSON.stringify(r.errors));
    assert.strictEqual(r.catalog.version, 2);
    const ded = r.catalog.byType.ded_complex;
    const relics = r.catalog.byType.battle_relics;
    assert.deepStrictEqual(Object.fromEntries(Object.entries(ded.templatesByFaction).map(([k, v]) => [k, [...v]])),
      Object.fromEntries(Object.entries(DED_TABLE).map(([k, v]) => [k, ids(v)])));
    assert.deepStrictEqual(Object.fromEntries(Object.entries(relics.templatesByFaction).map(([k, v]) => [k, [...v]])),
      Object.fromEntries(Object.entries(RELIC_TABLE).map(([k, [rel, data]]) => [k, ids([...rel, ...data])])));
    assert.strictEqual(Object.values(DED_COMPLEX_TEMPLATES).flat().length, 20);
    assert.strictEqual(Object.values(BATTLE_RELIC_TEMPLATES).flat().length, 44);
    assert.ok(!("500021" in DED_COMPLEX_TEMPLATES) && !("500021" in BATTLE_RELIC_TEMPLATES), "no templates for faction 500021");
    assert.deepStrictEqual([...ded.causeFactions], Object.keys(DED_TABLE).map(Number));
    assert.deepStrictEqual([...relics.causeFactions], Object.keys(RELIC_TABLE).map(Number));
    assert.strictEqual(relics.clearedConsequence, false);
    assert.strictEqual(ded.clearedConsequence, undefined);
    assert.deepStrictEqual([ded.securityClasses, relics.securityClasses].map((s) => [...s]), [["nullsec"], ["nullsec"]]);
    const windowRow = SCHEMA.find((row) => row.key === "eventAnomalies.battleRelicsWindowMs");
    assert.ok(windowRow.max <= relics.cooldownMs, `window max ${windowRow.max} > cooldown ${relics.cooldownMs}`);
    for (const t of ANOMALY_EVENT_CATALOG) {
      for (const f of Object.keys(t.templatesByFaction)) {
        assert.ok(`${FACTION_LABELS[f]} ${t.labelNoun}`.length <= 64);
      }
    }
    assert.deepStrictEqual(validateCatalog([{ ...kinds[1], clearedConsequence: "no" }]).errors,
      ["catalog[0].clearedConsequence must be a boolean"]);
  });

  const packsPresent = DED_PACK !== null && RELIC_PACK !== null;
  const an3 = "AN3 vendor fact (pack authoring): every DED ID is a nullsec combat signature of the faction key of "
    + "its faction, every relic / data ID a signature of the right family bound to the native pirate layout";
  if (!packsPresent) skip(an3, `${packLabel("ded-rated-sites")} or ${packLabel("pirate-exploration")} not found`);
  else {
    bench(an3, () => {
      const problems = [];
      const ded = authoredTemplates(DED_PACK);
      for (const [f, list] of Object.entries(DED_COMPLEX_TEMPLATES)) {
        for (const id of list) {
          const h = ded.get(id);
          if (!h) {
            problems.push(`${id} missing`);
            continue;
          }
          const bands = Array.isArray(h.securityBands) ? h.securityBands : [];
          if (h.siteKind !== "signature" || h.siteFamily !== "combat" || h.factionKey !== PIRATE_KEY_BY_FACTION_ID[f]
            || !isNativeRef(h.factionID) || !bands.includes("nullsec")) {
            problems.push(`${id} kind=${h.siteKind} family=${h.siteFamily} key=${h.factionKey} bands=${bands}`);
          }
        }
      }
      const relic = authoredTemplates(RELIC_PACK);
      const checkRelic = (id, family) => {
        const h = relic.get(id);
        if (!h) return problems.push(`${id} missing`);
        if (h.siteKind !== "signature" || h.siteFamily !== family || !h.nativePirateBinding) {
          problems.push(`${id} kind=${h.siteKind} family=${h.siteFamily} binding=${Boolean(h.nativePirateBinding)}`);
        }
        return null;
      };
      for (const [rel, data] of Object.values(RELIC_TABLE)) {
        for (const id of ids(rel)) checkRelic(id, "relic");
        for (const id of ids(data)) checkRelic(id, "data");
      }
      assert.deepStrictEqual(problems, []);
    });
  }

  test("AN4 BATTLE_AFTERMATH: pirate losses >= min in nullsec -> battle_relics of the pirate; empire / below min / "
    + "settled before the last relic site -> no cause; refused read -> null + aftermath.refused, others still plan", () => {
    const config = configOf(ON);
    const catalog = catalogOf(ON);
    const A = config.eventAnomalies;
    assert.deepStrictEqual([A.battleRelicsMinLosses, A.battleRelicsWindowMs, A.battleRelicsMaxSystems], [3, 3 * HOUR, 16]);
    const at = T0;
    const losses = [
      { systemId: 101, factionId: GURISTAS, typeId: 1, count: 2, settledAt: at - HOUR },
      { systemId: 101, factionId: GURISTAS, typeId: 2, count: 1, settledAt: at - 2 * HOUR },
      { systemId: 102, factionId: AMARR, typeId: 3, count: 10, settledAt: at - HOUR },
      { systemId: 103, factionId: ANGEL, typeId: 4, count: 2, settledAt: at - HOUR },
      { systemId: 104, factionId: BLOOD, typeId: 5, count: 5, settledAt: at - 2 * HOUR },
    ];
    let reads = 0;
    let sinceSeen = null;
    const battleRepo = { listVirtualLossesSince: (tx, opts) => {
      reads += 1;
      sinceSeen = opts;
      return { ok: true, losses, truncated: false };
    } };
    const systems = new Map([[101, sys(101)], [102, sys(102)], [103, sys(103)], [104, sys(104)]]);
    const recent = [{ systemId: 104, eventType: "battle_relics", createdAt: at - 90 * 60000, spawnBudget: 1,
      resultReference: null }];
    const aftermath = settingsOf(config, catalog, battleRepo);
    const store = fakeStore();
    const read = store.transaction("events.read", (tx) => gatherPulseContext(tx, {
      repo: fakeEventRepo({ open: [], recent }), worldRepository: fakeWorld(systems, []), sites: null, strategy: null,
      P: config.events, maxBatchReadIds: 400, lookbackMs: 12 * HOUR, cursor: 0, aftermath, catalog,
      graph: GRAPH.getGraph().graph }, { at, boot: false })).value;
    assert.strictEqual(reads, 1);
    assert.deepStrictEqual(sinceSeen, { sinceMs: at - 3 * HOUR, limit: A.maxLossRows });
    assert.deepStrictEqual(read.aftermath.systems.map((s) => s.systemId), [101],
      "empire losses, below min and settled before the last relic not read");
    assert.deepStrictEqual(read.aftermathStats, { read: 1, refused: 0, truncated: 0, systemsTruncated: 0 });
    const limits = { maxNewEventsPerPass: 4, maxOpenEvents: 10, maxOpenEventsPerSystem: 1,
      maxNewSitesPerSystemPerWindow: 2, siteWindowMs: HOUR, presenceRadius: 0, presenceBonus: 0, maxSkipped: 50 };
    const input = buildDirectorInput(read, { catalog, P: config.events, limits, graph: GRAPH.getGraph().graph,
      presence: null, excludedRegionIds: [], aftermath }, { at, seed: 7, round: 1, intervalMs: I, boot: false });
    assert.deepStrictEqual(input.context.candidates.map((c) => [c.systemId, c.causes.map((x) => `${x.cause}:${x.factionId}`)]),
      [[101, [`BATTLE_AFTERMATH:${GURISTAS}`]]]);
    assert.strictEqual(input.aftermathCauses, 1);
    const chosen = chooseEvents(input.context);
    assert.ok(chosen.ok);
    assert.strictEqual(chosen.plans.length, 1);
    const p = chosen.plans[0];
    assert.deepStrictEqual([p.eventType, p.cause, p.systemId, p.factionId, p.contentFactionId, p.label, p.spawnBudget],
      ["battle_relics", "BATTLE_AFTERMATH", 101, GURISTAS, GURISTAS, "Guristas Battlefield Ruins", 1]);
    assert.ok(BATTLE_RELIC_TEMPLATES[GURISTAS].includes(p.templateIds[0]));
    const later = { ...read, aftermath: { ...read.aftermath, systems: [...read.aftermath.systems, sys(104)],
      losses: [...read.aftermath.losses, { systemId: 104, factionId: BLOOD, count: 3, settledAt: at - HOUR }] } };
    const again = buildDirectorInput(later, { catalog, P: config.events, limits, graph: GRAPH.getGraph().graph,
      presence: null, excludedRegionIds: [], aftermath }, { at, seed: 7, round: 1, intervalMs: I, boot: false });
    assert.deepStrictEqual(again.context.candidates.map((c) => c.systemId), [101, 104]);
    assert.strictEqual(chooseEvents(again.context).skippedByReason.COOLDOWN, 1);

    const held = sys(201, { occupationState: "OCCUPIED", occupierFactionId: GURISTAS });
    const refusing = { listVirtualLossesSince: () => ({ ok: false, reason: "TX_REQUIRED" }) };
    const r = rig({ config, catalog: catalogOf({ EVEJS_LNE_EVENT_ANOMALIES_DIRECTOR_KINDS_ENABLED: "1",
      EVEJS_LNE_EVENT_ANOMALIES_BATTLE_RELICS_WEIGHT: "1" }), aftermath: settingsOf(config, catalog, refusing),
    systems: new Map([[201, held]]), occ: [held] });
    r.pulse(at);
    assert.strictEqual(r.telemetry.counters["events.aftermath.refused"], 1);
    assert.strictEqual(r.telemetry.counters["events.aftermath.read"], undefined);
    assert.deepStrictEqual(r.state.inserted.map((x) => [x.eventType, x.systemId]), [["pirate_stronghold", 201]]);
    const noRepo = store.transaction("events.read", (tx) => gatherPulseContext(tx, {
      repo: fakeEventRepo({ open: [], recent: [] }), worldRepository: fakeWorld(systems, []), sites: null,
      strategy: null, P: config.events, maxBatchReadIds: 400, lookbackMs: HOUR, cursor: 0,
      aftermath: settingsOf(config, catalog, null) }, { at, boot: false })).value;
    assert.strictEqual(noRepo.aftermath, null);
    assert.strictEqual(noRepo.aftermathStats.refused, 1);
  });

  test("AN5 consequence and resilience: causeHolds BATTLE_AFTERMATH true; CLEARED battle_relics no drop, ded_complex "
    + "one drop event:<id>:cleared; missing DED templates -> NO_TEMPLATE, templatesMissing, others plan", () => {
    const row = { cause: "BATTLE_AFTERMATH", factionId: GURISTAS, campaignId: null };
    assert.strictEqual(causeHolds(row, sys(1), []), true);
    assert.strictEqual(causeHolds(row, sys(1, { occupationState: "OCCUPIED", occupierFactionId: AMARR }), []), true);
    assert.strictEqual(causeHolds(row, null, []), null);

    const config = configOf(ON);
    const catalog = catalogOf(ON);
    const calls = [];
    const occupation = { dropInfluenceInTx: (tx, spec, key) => {
      calls.push([spec.factionId, key]);
      return { ok: true, outcome: "APPLIED", written: true, before: 30, next: 10 };
    } };
    const active = (eventId, eventType, systemId, cause) => Object.freeze({ eventId, eventType, systemId, cause,
      factionId: GURISTAS, campaignId: null, state: "ACTIVE", sitesCreated: 1, dueAt: T0 - HOUR,
      expiresAt: T0 + HOUR, createdAt: T0 - HOUR, version: 2, templateIds: ["client-dungeon:1808"], label: "x",
      reason: { contentFactionId: GURISTAS }, result: null, corrupt: false, spawnBudget: 1 });
    const held = sys(302, { occupationState: "OCCUPIED", occupierFactionId: GURISTAS });
    const r = rig({ config, catalog, occupation,
      open: [active("E1", "battle_relics", 301, "BATTLE_AFTERMATH"), active("E2", "ded_complex", 302, "OCCUPATION_HELD")],
      systems: new Map([[301, sys(301)], [302, held]]), siteStates: { E1: ["COMPLETED"], E2: ["COMPLETED"] } });
    const v = r.pulse(T0);
    assert.deepStrictEqual(r.state.transitions, [["E1", "COMPLETING"], ["E2", "COMPLETING"]]);
    assert.deepStrictEqual(calls, [[GURISTAS, "event:E2:cleared"]]);
    assert.deepStrictEqual(v.consequence, { APPLIED: 1 });

    const dedIds = Object.values(DED_COMPLEX_TEMPLATES).flat();
    const telemetry = fakeTelemetry();
    let checked = null;
    const s = startTypes(config, { telemetry, adapter: { getDungeonSites: () => ({ ok: true, checkTemplates: (list) => {
      checked = list;
      return { ok: true, missing: dedIds };
    } }) } });
    assert.ok(dedIds.every((id) => checked.includes(id)) && checked.length === listTemplateIds(s.catalog).length + 20);
    assert.strictEqual(telemetry.counters["events.templatesMissing"], 20);
    assert.deepStrictEqual(s.catalog.byType.ded_complex.templatesByFaction, {});
    assert.ok(s.lines.some((l) => / director-kinds=battle_relics$/.test(l)), s.lines.join("\n"));
    const limits = { maxNewEventsPerPass: 4, maxOpenEvents: 10, maxOpenEventsPerSystem: 1,
      maxNewSitesPerSystemPerWindow: 2, siteWindowMs: HOUR, presenceRadius: 0, presenceBonus: 0, maxSkipped: 50 };
    const chosen = chooseEvents({ now: T0, seed: 3, round: 1, intervalMs: I, catalog: s.catalog, excludedRegionIds: [],
      limits, candidates: [{ systemId: 302, securityClass: "nullsec", regionId: REGION, observedDistance: null,
        causes: causesOfSystem(held, []) }], openEvents: [], recent: [], recentTruncated: false });
    assert.ok(chosen.ok);
    assert.strictEqual(chosen.skippedByReason.NO_TEMPLATE, 1);
    assert.ok(chosen.skipped.some((x) => x.eventType === "ded_complex" && x.reason === "NO_TEMPLATE"));
    assert.strictEqual(chosen.plans.length, 1);
    assert.notStrictEqual(chosen.plans[0].eventType, "ded_complex");
  });

  test("AN6: the battleRelicsMaxSystems cut after the filters (min, last relic, class), newest "
    + "first; a loss-path system carries only BATTLE_AFTERMATH", () => {
    const config = configOf(ON);
    const catalog = catalogOf(ON);
    const at = T0;
    const losses = [];
    for (let id = 1; id <= 17; id += 1) losses.push({ systemId: id, factionId: GURISTAS, count: 1, settledAt: at - HOUR });
    losses.push({ systemId: 18, factionId: GURISTAS, count: 5, settledAt: at - HOUR });
    losses.push({ systemId: 19, factionId: GURISTAS, count: 5, settledAt: at - 2 * HOUR });
    losses.push({ systemId: 900, factionId: GURISTAS, count: 3, settledAt: at - 2 * HOUR });
    losses.push({ systemId: 901, factionId: ANGEL, count: 3, settledAt: at - HOUR });
    const battleRepo = { listVirtualLossesSince: () => ({ ok: true, losses, truncated: false }) };
    const systems = new Map(losses.map((l) => [l.systemId, sys(l.systemId)]));
    systems.set(18, sys(18, { securityClass: "highsec" }));
    systems.set(901, sys(901, { occupationState: "OCCUPIED", occupierFactionId: GURISTAS }));
    const graph = { getSystem: (id) => ({ id, regionId: REGION, factionId: null, secClass: id === 18 ? "highsec" : "nullsec" }) };
    const recent = [{ systemId: 19, eventType: "battle_relics", createdAt: at - 90 * 60000, spawnBudget: 1,
      resultReference: null }];
    let getSystemsIds = null;
    const world = fakeWorld(systems, []);
    const spyWorld = { ...world, getSystems: (tx, list, o) => {
      getSystemsIds = list;
      return world.getSystems(tx, list, o);
    } };
    const gather = (aftermath) => fakeStore().transaction("events.read", (tx) => gatherPulseContext(tx, {
      repo: fakeEventRepo({ open: [], recent }), worldRepository: spyWorld, sites: null, strategy: null,
      P: config.events, maxBatchReadIds: 400, lookbackMs: 12 * HOUR, cursor: 0, aftermath, catalog, graph },
    { at, boot: false })).value;
    const aftermath = settingsOf(config, catalog, battleRepo);
    assert.strictEqual(aftermath.maxSystems, 16);
    const read = gather(aftermath);
    assert.deepStrictEqual(read.aftermath.systems.map((s) => s.systemId), [901, 900], "newest loss first");
    assert.deepStrictEqual(getSystemsIds, [901, 900]);
    assert.strictEqual(read.aftermath.systemsTruncated, false);
    assert.strictEqual(read.aftermathStats.systemsTruncated, 0);
    const limits = { maxNewEventsPerPass: 4, maxOpenEvents: 10, maxOpenEventsPerSystem: 1,
      maxNewSitesPerSystemPerWindow: 2, siteWindowMs: HOUR, presenceRadius: 0, presenceBonus: 0, maxSkipped: 50 };
    const input = buildDirectorInput(read, { catalog, P: config.events, limits, graph, presence: null,
      excludedRegionIds: [], aftermath }, { at, seed: 7, round: 1, intervalMs: I, boot: false });
    assert.deepStrictEqual(input.context.candidates.map((c) => [c.systemId, c.causes.map((x) => `${x.cause}:${x.factionId}`)]),
      [[901, [`BATTLE_AFTERMATH:${ANGEL}`]], [900, [`BATTLE_AFTERMATH:${GURISTAS}`]]], "no OCCUPATION_HELD");
    assert.strictEqual(input.aftermathCauses, 2);
    const chosen = chooseEvents(input.context);
    assert.ok(chosen.ok);
    assert.deepStrictEqual(chosen.plans.map((p) => [p.eventType, p.systemId]).sort((a, b) => a[1] - b[1]),
      [["battle_relics", 900], ["battle_relics", 901]]);
    const one = gather({ ...aftermath, maxSystems: 1 });
    assert.deepStrictEqual(one.aftermath.systems.map((s) => s.systemId), [901]);
    assert.strictEqual(one.aftermathStats.systemsTruncated, 1);
  });
};
