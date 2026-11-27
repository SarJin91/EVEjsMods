"use strict";

const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const { validateCatalog, developedCatalogOf, richVeinCatalogOf, EVENT_CATALOG } = require("../../lib/events/catalog");
const { DEVELOPED_EVENT_CATALOG, DEV_RATS_HIGHSEC_TEMPLATES, DEV_RATS_FRONTIER_TEMPLATES, DEV_ORE_HIGHSEC_TEMPLATES,
  CAUSE } = require("../../lib/events/data/eventCatalog");
const { causesOfSystem, developedCauses } = require("../../lib/events/candidates");
const { gatherPulseContext, buildDirectorInput } = require("../../lib/events/context");
const { causeHolds } = require("../../lib/events/eventMachine");
const { chooseEvents } = require("../../lib/events/director");
const R = require("../../lib/world/devIndices/rules");
const S = require("../../lib/world/devIndices/schema");
const CMD = require("../../lib/world/devIndices/command");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const HOUR = 3600000;
const I = 300000;
const T0 = 5666667 * I;
const AMARR = 500003;
const GURISTAS = 500010;
const BLOOD = 500012;
const DRONES = 500025;
const REGION = 10000060;
const DEV_ON = Object.freeze({ EVEJS_LNE_DEV_INDICES_ENABLED: "1", EVEJS_LNE_DEV_INDICES_ANOMALIES_ENABLED: "1" });
const W100 = "devIndices.anomaliesEnabled with modules.events/sites off - no developed anomaly";

function resolved(env = {}, base = true) {
  return resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(),
    ...(base ? { EVEJS_LNE_EVENTS_ENABLED: "1", EVEJS_LNE_SITES_ENABLED: "1",
      EVEJS_LNE_EVENTS_PRESENCE_ACTIVATION: "0" } : {}), ...env } });
}

function configOf(env = {}) {
  const r = resolved(env);
  assert.deepStrictEqual(r.errors, []);
  return r.config;
}

function catalogOf(entries) {
  const r = validateCatalog(entries);
  assert.ok(r.ok, JSON.stringify(r.errors));
  return r.catalog;
}

const LIMITS = Object.freeze({ maxNewEventsPerPass: 6, maxOpenEvents: 20, maxOpenEventsPerSystem: 1,
  maxNewSitesPerSystemPerWindow: 2, siteWindowMs: HOUR, presenceRadius: 0, presenceBonus: 0, maxSkipped: 50 });
const GRAPH = { getSystem: (id) => ({ id, regionId: REGION, factionId: null }) };
const sys = (systemId, extra = {}) => ({ systemId, securityClass: "nullsec", occupationState: "STABLE",
  occupierFactionId: null, controllerFactionId: AMARR, previousControllerFactionId: null, lastStateChangeAt: 0,
  ...extra });

function settingsOf(config, catalog, more = {}) {
  const D = config.devIndices;
  const dev = catalog.types.filter((t) => t.cause === CAUSE.DEVELOPED_INDUSTRY || t.cause === CAUSE.DEVELOPED_MILITARY);
  return { minLevel: D.anomalyMinLevel, maxOpen: D.anomalyMaxOpen, candidateRows: D.anomalyCandidateRows,
    eventTypes: new Set(dev.map((t) => t.eventType)), oreClasses: ["highsec", "lowsec", "nullsec"],
    ratClasses: ["highsec", "lowsec", "nullsec"], ...more };
}

function developedRead(entries, systems, rats = new Map()) {
  const levels = new Map();
  const rank = new Map();
  for (const [id, ind, mil, pts] of entries) {
    levels.set(id, { ind, mil });
    rank.set(id, [Math.max(ind, mil), pts]);
  }
  return { levels, ratFactions: rats, rank, systems };
}

function readOf({ open = [], occ = [], recent = [], developed, liberated }) {
  const out = { ok: true, open: { events: open }, pending: { events: [] }, openSystems: new Map(), siteStates: new Map(),
    campaigns: { known: true, byId: new Map(), active: [] }, occ: { systems: occ, nextAfterSystemId: null },
    theatre: [], recent: { rows: recent, truncated: false }, stats: { readRefused: 0, siteReadRefused: 0 } };
  if (developed !== undefined) out.developed = developed;
  if (liberated !== undefined) out.liberated = liberated;
  return out;
}

const inputOf = (read, config, catalog, more) => buildDirectorInput(read, { catalog, P: config.events,
  limits: LIMITS, graph: GRAPH, presence: null, excludedRegionIds: [], ...more },
{ at: T0, seed: 7, round: 1, intervalMs: I, boot: false });

const openRow = (eventId, eventType, systemId, cause) => Object.freeze({ eventId, eventType, systemId, cause,
  factionId: AMARR, campaignId: null, state: "PLANNED", sitesCreated: 0, dueAt: T0 + HOUR, expiresAt: T0 + 24 * HOUR,
  createdAt: T0 - HOUR, version: 1, templateIds: [DEV_ORE_HIGHSEC_TEMPLATES[0]], label: "Prospect Field",
  spawnBudget: 1, resultReference: null });

function pulseDeps(config, { developed = null, devFacade, getSystems, occ = [] } = {}) {
  const calls = { getSystems: [], listTop: [], rats: [] };
  const wr = {
    getSystems: (tx, ids) => {
      calls.getSystems.push([...ids]);
      return getSystems ? getSystems(ids) : { ok: true, systems: ids.map((id) => sys(id)), missing: [] };
    },
    listActiveOccupations: () => ({ ok: true, systems: occ, nextAfterSystemId: null }),
  };
  const repo = { listOpen: () => ({ ok: true, events: [] }), listPendingCleanup: () => ({ ok: true, events: [] }),
    listRecent: () => ({ ok: true, rows: [], truncated: false }) };
  const facade = devFacade || null;
  const deps = { repo, worldRepository: wr, sites: null, strategy: null, P: config.events, maxBatchReadIds: 400,
    lookbackMs: HOUR, cursor: 0 };
  if (developed) {
    deps.developed = { ...developed, getDevIndices: () => facade,
      ratFactionsOf: (ids) => {
        calls.rats.push([...ids]);
        return developed.rats ? developed.rats(ids) : { ok: true, entries: ids.map((id) => ({ systemId: id,
          factionId: GURISTAS })) };
      } };
  }
  return { deps, calls };
}

function devFacadeOf(byKind, calls, mode = S.MODES.ON) {
  return { getMode: () => mode, listTop: (kind, opts) => {
    if (calls) calls.push([kind, opts]);
    return byKind[kind] || [];
  } };
}

module.exports = ({ test }) => {
  test("DN1 pure: causesOfSystem with developed null = the 5-parameter call; developedCauses thresholds, CONTESTED, "
    + "no controller + no SDE, rat faction null; causeHolds true; validateCatalog takes the catalog, refuses non-STABLE",
  () => {
    const camp = [{ campaignId: "c1", ownerFactionId: AMARR }];
    for (const s of [sys(101), sys(102, { occupationState: "CONTESTED", occupierFactionId: GURISTAS }),
      sys(103, { occupationState: "OCCUPIED", occupierFactionId: GURISTAS, previousControllerFactionId: AMARR })]) {
      assert.deepStrictEqual(causesOfSystem(s, camp, null, null, {}, null), causesOfSystem(s, camp, null, null, {}));
      assert.deepStrictEqual(causesOfSystem(s, camp), causesOfSystem(s, camp, null, null, null, undefined));
    }
    const D = { levels: new Map([[101, { ind: 3, mil: 3 }], [102, { ind: 2, mil: 5 }]]), minLevel: 3,
      ratFactions: new Map([[101, GURISTAS], [102, null]]) };
    assert.deepStrictEqual(developedCauses(sys(101), D).map((c) => [c.cause, c.factionId]),
      [[CAUSE.DEVELOPED_INDUSTRY, AMARR], [CAUSE.DEVELOPED_MILITARY, GURISTAS]]);
    assert.deepStrictEqual(developedCauses(sys(102), D), [], "ind below the level, rat faction null");
    assert.deepStrictEqual(developedCauses(sys(101, { occupationState: "CONTESTED", occupierFactionId: BLOOD }), D), []);
    assert.deepStrictEqual(developedCauses(sys(999), D), [], "no entry in levels");
    assert.deepStrictEqual(developedCauses(sys(101), null), []);
    const noOwner = developedCauses(sys(101, { controllerFactionId: null }), D);
    assert.deepStrictEqual(noOwner.map((c) => c.cause), [CAUSE.DEVELOPED_MILITARY], "no controller, no SDE");
    assert.deepStrictEqual(developedCauses(sys(101, { controllerFactionId: null, sdeFactionId: 500001 }), D)
      .map((c) => [c.cause, c.factionId]), [[CAUSE.DEVELOPED_INDUSTRY, 500001], [CAUSE.DEVELOPED_MILITARY, GURISTAS]]);
    assert.deepStrictEqual(causesOfSystem(sys(101), camp, null, null, null, D).map((c) => c.cause),
      [CAUSE.CAMPAIGN_THEATRE, CAUSE.DEVELOPED_INDUSTRY, CAUSE.DEVELOPED_MILITARY]);
    for (const cause of [CAUSE.DEVELOPED_INDUSTRY, CAUSE.DEVELOPED_MILITARY]) {
      assert.strictEqual(causeHolds({ cause, factionId: AMARR, campaignId: null },
        sys(101, { occupationState: "CONTESTED", occupierFactionId: BLOOD, controllerFactionId: null }), []), true);
    }
    assert.deepStrictEqual(developedCatalogOf(configOf({})), [], "default off");
    assert.deepStrictEqual(developedCatalogOf(configOf({ EVEJS_LNE_DEV_INDICES_ANOMALIES_ENABLED: "1" })), [],
      "anomaliesEnabled without devIndices.enabled");
    const on = configOf(DEV_ON);
    const types = developedCatalogOf(on);
    assert.deepStrictEqual(types.map((t) => t.eventType), DEVELOPED_EVENT_CATALOG.map((t) => t.eventType));
    const cat = catalogOf([...EVENT_CATALOG, ...types]);
    assert.strictEqual(cat.byType.developed_ore_highsec.durationMs, 86400000);
    assert.strictEqual(cat.byType.developed_rats_frontier.durationMs, 14400000);
    assert.deepStrictEqual([cat.byType.developed_rats_frontier.aftermathMs, cat.byType.developed_ore_lowsec.cooldownMs,
      cat.byType.developed_ore_lowsec.clearedConsequence], [600000, 86400000, false]);
    assert.deepStrictEqual(developedCatalogOf(configOf({ ...DEV_ON, EVEJS_LNE_DEV_INDICES_ANOMALY_ORE_WEIGHT: "0" }))
      .map((t) => t.eventType), ["developed_rats_highsec", "developed_rats_frontier"]);
    const bad = validateCatalog([{ ...types[0], startStates: ["CONTESTED"] }, { ...types[3], startStates: ["OCCUPIED"] }]);
    assert.strictEqual(bad.ok, false);
    assert.ok(bad.errors.some((e) => e.includes("startStates for DEVELOPED_INDUSTRY must be [\"STABLE\"]")), bad.errors);
    assert.ok(bad.errors.some((e) => e.includes("startStates for DEVELOPED_MILITARY must be [\"STABLE\"]")), bad.errors);
  });

  test("DN2 gatherPulseContext: off -> the getSystems calls of today, no developed key; on -> one getSystems of the ids "
    + "outside occ, ranked and cut to 2 x candidateRows, one ratFactionsOf; refused getSystems -> developed null + "
    + "refused; stopped facade -> null + cold", () => {
    const config = configOf(DEV_ON);
    const opts = { at: T0, boot: false };
    const off = pulseDeps(config, { occ: [sys(101)] });
    const offRead = gatherPulseContext({}, off.deps, opts);
    assert.ok(offRead.ok);
    assert.strictEqual(off.calls.getSystems.length, 1, "only the open systems read of today");
    assert.ok(!("developed" in offRead) && !("developedStats" in offRead));

    const top = [];
    const facade = devFacadeOf({
      ind: [{ systemId: 101, level: 5, points: 5500 }, { systemId: 102, level: 4, points: 4100 },
        { systemId: 103, level: 3, points: 3900 }, { systemId: 104, level: 3, points: 3000 }],
      mil: [{ systemId: 105, level: 5, points: 5100 }, { systemId: 106, level: 3, points: 3950 },
        { systemId: 107, level: 4, points: 4000 }] }, top);
    const D = settingsOf(config, { types: [] }, { candidateRows: 2, oreClasses: ["highsec"], ratClasses: ["lowsec"] });
    const on = pulseDeps(config, { developed: D, devFacade: facade, occ: [sys(101)] });
    const read = gatherPulseContext({}, on.deps, opts);
    assert.strictEqual(on.calls.getSystems.length, 2, "one more getSystems");
    assert.deepStrictEqual(on.calls.getSystems[1], [105, 102, 107, 106], "level DESC, points DESC, systemId ASC");
    assert.deepStrictEqual(top.map(([k, o]) => [k, o.minLevel, o.limit, o.secClasses]),
      [["ind", 3, 2, ["highsec"]], ["mil", 3, 2, ["lowsec"]]]);
    assert.deepStrictEqual(on.calls.rats, [[105, 106, 107]]);
    assert.deepStrictEqual(read.developedStats, { read: 1, refused: 0, truncated: 1, cold: 0, ratRefused: 0,
      noRatFaction: 0 });
    assert.deepStrictEqual(read.developed.levels.get(101), { ind: 5, mil: 0 }, "occ systems keep their levels");
    assert.deepStrictEqual(read.developed.systems.map((s) => s.systemId), [105, 102, 107, 106]);

    const refused = pulseDeps(config, { developed: D, devFacade: facade, occ: [sys(101)],
      getSystems: (ids) => (ids.includes(105) ? { ok: false, reason: "DB_BUSY" } : { ok: true, systems: [] }) });
    const r2 = gatherPulseContext({}, refused.deps, opts);
    assert.strictEqual(r2.developed, null);
    assert.deepStrictEqual([r2.developedStats.refused, r2.developedStats.read], [1, 0]);

    const rats = pulseDeps(config, { developed: { ...D, rats: () => ({ ok: false, reason: "FACTION_POLICY_DRIFT" }) },
      devFacade: facade, occ: [sys(101)] });
    const r3 = gatherPulseContext({}, rats.deps, opts);
    assert.deepStrictEqual([r3.developedStats.ratRefused, r3.developed.ratFactions.size], [1, 0]);
    const nul = pulseDeps(config, { developed: { ...D, rats: (ids) => ({ ok: true, entries: ids.map((id) => ({
      systemId: id, factionId: null })) }) }, devFacade: facade, occ: [] });
    assert.strictEqual(gatherPulseContext({}, nul.deps, opts).developedStats.noRatFaction, 3);

    const stopped = pulseDeps(config, { developed: D, devFacade: devFacadeOf({}, null, S.MODES.STOPPED) });
    const r4 = gatherPulseContext({}, stopped.deps, opts);
    assert.deepStrictEqual([r4.developed, r4.developedStats.cold, stopped.calls.getSystems.length], [null, 1, 1]);
    const none = pulseDeps(config, { developed: D, devFacade: null });
    assert.strictEqual(gatherPulseContext({}, none.deps, opts).developedStats.cold, 1);
    const cold = pulseDeps(config, { developed: D, devFacade: devFacadeOf({}, null) });
    const r5 = gatherPulseContext({}, cold.deps, opts);
    assert.deepStrictEqual([r5.developed.levels.size, cold.calls.getSystems.length, cold.calls.rats.length], [0, 1, 0]);
    const boot = pulseDeps(config, { developed: D, devFacade: facade });
    assert.ok(!("developed" in gatherPulseContext({}, boot.deps, { at: T0, boot: true })));
  });

  test("DN3 cap: 3 developed systems with anomalyMaxOpen 2 -> the 2 of the highest level plan; 2 open DEVELOPED rows "
    + "-> 0 new; rich veins with liberated + front give the same result with and without the developed input", () => {
    const config = configOf({ ...DEV_ON, EVEJS_LNE_RICH_VEINS_ENABLED: "1", EVEJS_LNE_RICH_VEINS_FRONT_WEIGHT: "1" });
    const catalog = catalogOf([...EVENT_CATALOG, ...richVeinCatalogOf(config), ...developedCatalogOf(config)]);
    const D = settingsOf(config, catalog);
    assert.strictEqual(D.maxOpen, 2);
    const three = [sys(201), sys(202), sys(203)];
    const dev = developedRead([[201, 3, 0, 3100], [202, 5, 0, 5200], [203, 4, 0, 4400]], three);
    const input = inputOf(readOf({ developed: dev }), config, catalog, { developed: D });
    const planned = chooseEvents(input.context).plans.map((p) => [p.systemId, p.eventType]);
    assert.deepStrictEqual(planned.sort((a, b) => a[0] - b[0]),
      [[202, "developed_ore_nullsec"], [203, "developed_ore_nullsec"]]);
    assert.deepStrictEqual([input.developedCauses, input.developedCapped], [2, 1]);

    const full = inputOf(readOf({ developed: dev, open: [openRow("D1", "developed_ore_highsec", 301,
      CAUSE.DEVELOPED_INDUSTRY), openRow("D2", "developed_rats_frontier", 302, CAUSE.DEVELOPED_MILITARY)] }), config,
    catalog, { developed: D });
    assert.deepStrictEqual(chooseEvents(full.context).plans.filter((p) => p.eventType.startsWith("developed_")), []);
    assert.deepStrictEqual([full.developedCauses, full.developedCapped, full.context.candidates.length], [0, 3, 0]);

    const R0 = config.richVeins;
    const veins = { liberated: { windowMs: R0.liberatedWindowMs, maxRows: R0.maxLiberatedRows, maxOpen: R0.maxOpen,
      eventTypes: new Set(["rich_vein_liberated"]) }, front: { maxOpen: R0.maxOpen,
      eventTypes: new Set(["rich_vein_front"]) } };
    const front = sys(401, { occupationState: "CONTESTED", occupierFactionId: GURISTAS, lastStateChangeAt: T0 - HOUR });
    const freed = sys(402, { controllerFactionId: null, previousControllerFactionId: AMARR,
      lastStateChangeAt: T0 - 2 * HOUR });
    const read = (more) => readOf({ occ: [front], liberated: { systems: [freed], truncated: false }, ...more });
    const a = inputOf(read({}), config, catalog, veins);
    const b = inputOf(read({ developed: developedRead([], []) }), config, catalog, { ...veins, developed: D });
    const pick = (x) => [x.liberatedCauses, x.frontCauses, x.richVeinsCapped, x.context.candidates];
    assert.deepStrictEqual(pick(b), pick(a));
    assert.deepStrictEqual([b.developedCauses, b.developedCapped], [0, 0]);
    assert.ok(!("developedCauses" in a), "off = no developed key");
    assert.deepStrictEqual(chooseEvents(b.context).plans.map((p) => p.eventType),
      chooseEvents(a.context).plans.map((p) => p.eventType));
  });

  test("DN4 templates: highsec rats -> Den / Refuge of the rat faction, lowsec -> Rally Point / Port; Rogue Drone in "
    + "highsec -> no plan without a throw (NO_TEMPLATE / SEC_CLASS); every plan has factionId > 0", () => {
    const config = configOf(DEV_ON);
    const catalog = catalogOf([...EVENT_CATALOG, ...developedCatalogOf(config)]);
    const D = settingsOf(config, catalog);
    const systems = [sys(501, { securityClass: "highsec" }), sys(502, { securityClass: "lowsec" }),
      sys(503, { securityClass: "highsec" }), sys(504, { securityClass: "highsec", controllerFactionId: null })];
    const rats = new Map([[501, GURISTAS], [502, BLOOD], [503, DRONES]]);
    const dev = developedRead([[501, 0, 4, 4000], [502, 0, 4, 3900], [503, 0, 5, 5000], [504, 3, 0, 3000]], systems,
      rats);
    const input = inputOf(readOf({ developed: dev }), config, catalog, { developed: { ...D, maxOpen: 10 } });
    const chosen = chooseEvents(input.context);
    assert.ok(chosen.ok);
    const by = new Map(chosen.plans.map((p) => [p.systemId, p]));
    assert.strictEqual(by.get(501).eventType, "developed_rats_highsec");
    assert.ok(by.get(501).templateIds.every((t) => DEV_RATS_HIGHSEC_TEMPLATES[GURISTAS].includes(t)));
    assert.strictEqual(by.get(502).eventType, "developed_rats_frontier");
    assert.ok(by.get(502).templateIds.every((t) => DEV_RATS_FRONTIER_TEMPLATES[BLOOD].includes(t)));
    assert.ok(!by.has(503), "no Rogue Drone highsec template");
    assert.ok(chosen.skipped.some((s) => s.systemId === 503 && s.reason === "SEC_CLASS"), JSON.stringify(chosen.skipped));
    assert.ok(!by.has(504), "no controller, no SDE faction -> no INDUSTRY cause");
    assert.ok(chosen.plans.every((p) => Number.isSafeInteger(p.factionId) && p.factionId > 0));
    assert.deepStrictEqual([by.get(501).factionId, by.get(501).contentFactionId, by.get(501).label],
      [GURISTAS, GURISTAS, "Guristas Raider Den"]);
    const hiOnly = catalogOf([...EVENT_CATALOG, ...developedCatalogOf(config)
      .filter((t) => t.eventType === "developed_rats_highsec")]);
    const drone = chooseEvents(inputOf(readOf({ developed: developedRead([[503, 0, 5, 5000]], [systems[2]], rats) }),
      config, hiOnly, { developed: settingsOf(config, hiOnly) }).context);
    assert.deepStrictEqual(drone.plans, []);
    assert.ok(drone.skipped.some((s) => s.systemId === 503 && s.reason === "NO_TEMPLATE"), JSON.stringify(drone.skipped));
    const ore = chooseEvents(inputOf(readOf({ developed: developedRead([[505, 4, 0, 4000]],
      [sys(505, { securityClass: "highsec" })]) }), config, catalog, { developed: D }).context);
    assert.deepStrictEqual(ore.plans.map((p) => [p.eventType, p.factionId, p.contentFactionId, p.label]),
      [["developed_ore_highsec", AMARR, 0, "Prospect Field"]]);
    assert.ok(DEV_ORE_HIGHSEC_TEMPLATES.includes(ore.plans[0].templateIds[0]));
  });

  test("DN5 config: defaults without W100; anomaliesEnabled + modules.sites off -> W100; without devIndices.enabled -> "
    + "W97; effectsOf.sites and the !dev Effects line only with the flag", () => {
    const def = resolved({});
    assert.deepStrictEqual(def.errors, []);
    assert.ok(!def.warnings.includes(W100));
    const D = def.config.devIndices;
    assert.deepStrictEqual([D.anomaliesEnabled, D.anomalyMinLevel, D.anomalyMaxOpen, D.anomalyCandidateRows,
      D.anomalyOreWeight, D.anomalyRatsWeight, D.anomalyOreDurationMs, D.anomalyRatsDurationMs, D.anomalyCooldownMs,
      D.anomalyAftermathMs], [false, 3, 2, 8, 2, 2, 86400000, 14400000, 86400000, 600000]);
    assert.ok(!resolved(DEV_ON).warnings.includes(W100), "events + sites on");
    assert.ok(resolved({ ...DEV_ON, EVEJS_LNE_SITES_ENABLED: "0" }).warnings.includes(W100));
    assert.ok(resolved(DEV_ON, false).warnings.includes(W100), "both modules off by default");
    assert.ok(resolved({ EVEJS_LNE_DEV_INDICES_ANOMALIES_ENABLED: "1" }).warnings
      .includes("devIndices.anomaliesEnabled without devIndices.enabled - no effect"));
    const Poff = S.devIndicesSettingsOf(configOf({ EVEJS_LNE_DEV_INDICES_ENABLED: "1" })).settings;
    const Pon = S.devIndicesSettingsOf(configOf(DEV_ON)).settings;
    const lv = { mil: 1, ind: 3, trade: 0 };
    assert.deepStrictEqual([R.effectsOf(lv, Poff).sites, R.effectsOf(lv, Pon).sites,
      R.effectsOf({ mil: 2, ind: 2, trade: 5 }, Pon).sites, R.effectsOf({ mil: 4, ind: 0, trade: 0 }, Pon).sites],
    [false, true, false, true]);
    assert.strictEqual(CMD.formatEffectsLine(lv, Poff), null);
    assert.strictEqual(CMD.formatEffectsLine(lv, Pon), "Effects: sites");
  });

  test("DN6 cap rounds: the mixed case (room 2, vein free 1, developed free 0, developed score higher) -> 1 vein "
    + "(newer abandon), 0 developed; the reverse case (vein free 0, developed free 1) -> <= 1 developed; one cap alone "
    + "= the result of the single call", () => {
    const config = configOf({ ...DEV_ON, EVEJS_LNE_RICH_VEINS_ENABLED: "1", EVEJS_LNE_RICH_VEINS_LIBERATED_WEIGHT: "1" });
    const catalog = catalogOf([...EVENT_CATALOG, ...richVeinCatalogOf(config), ...developedCatalogOf(config)]);
    const D = settingsOf(config, catalog);
    const R0 = config.richVeins;
    const veinType = "rich_vein_liberated";
    const liberated = { windowMs: R0.liberatedWindowMs, maxRows: R0.maxLiberatedRows, maxOpen: R0.maxOpen,
      eventTypes: new Set([veinType]) };
    assert.deepStrictEqual([D.maxOpen, R0.maxOpen], [2, 2]);
    const limits = { ...LIMITS, maxNewEventsPerPass: 2 };
    const freed = (systemId, ago) => sys(systemId, { controllerFactionId: null, previousControllerFactionId: AMARR,
      lastStateChangeAt: T0 - ago });
    const abandons = { systems: [freed(402, 2 * HOUR), freed(403, HOUR)], truncated: false };
    const dev = developedRead([[201, 3, 0, 3100], [202, 5, 0, 5200], [203, 4, 0, 4400]], [sys(201), sys(202), sys(203)]);
    const openDev = (id, systemId) => openRow(id, "developed_ore_nullsec", systemId, CAUSE.DEVELOPED_INDUSTRY);
    const openVeinRow = (id, systemId) => openRow(id, veinType, systemId, CAUSE.LIBERATED);
    const plansOf = (input) => chooseEvents(input.context).plans.map((p) => [p.eventType, p.systemId]);

    const jin = inputOf(readOf({ developed: dev, liberated: abandons, open: [openVeinRow("V1", 501), openDev("D1", 601),
      openDev("D2", 602)] }), config, catalog, { limits, liberated, developed: D });
    assert.deepStrictEqual(plansOf(jin), [[veinType, 403]]);
    assert.deepStrictEqual([jin.liberatedCauses, jin.richVeinsCapped, jin.developedCauses, jin.developedCapped],
      [1, 1, 0, 3]);
    assert.ok(!("capRoundsBound" in jin));

    const rev = inputOf(readOf({ developed: dev, liberated: abandons, open: [openVeinRow("V1", 501),
      openVeinRow("V2", 502), openDev("D1", 601)] }), config, catalog, { limits, liberated, developed: D });
    const revPlans = plansOf(rev);
    assert.strictEqual(revPlans.filter(([t]) => t === veinType).length, 0);
    assert.ok(revPlans.filter(([t]) => t.startsWith("developed_")).length <= 1, JSON.stringify(revPlans));
    assert.deepStrictEqual(revPlans, [["developed_ore_nullsec", 202]]);

    const devOnly = inputOf(readOf({ developed: dev }), config, catalog, { developed: D });
    assert.deepStrictEqual([devOnly.developedCauses, devOnly.developedCapped, devOnly.context.candidates
      .map((c) => c.systemId)], [2, 1, [202, 203]]);
    const veinOnly = inputOf(readOf({ liberated: abandons, open: [openVeinRow("V1", 501)] }), config, catalog,
      { liberated });
    assert.deepStrictEqual([veinOnly.liberatedCauses, veinOnly.richVeinsCapped, veinOnly.context.candidates
      .map((c) => c.systemId)], [1, 1, [403]]);
    assert.ok(!("capRoundsBound" in devOnly) && !("capRoundsBound" in veinOnly));
  });
};
