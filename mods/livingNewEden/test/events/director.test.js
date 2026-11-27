"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { validateCatalog, withoutTemplates, listTemplateIds, getEventType, EVENT_CATALOG, CAUSE, FACTION_LABELS, DENIED_TEMPLATE_IDS } = require("../../lib/events/catalog");
const { campaignsBySystem, causesOfSystem } = require("../../lib/events/candidates");
const { chooseEvents } = require("../../lib/events/director");
const { findPack, packLabel } = require("../_support/contentPacks");
const { buildDirectorInput } = require("../../lib/events/context");
const { STATE, OPEN_STATES, TERMINAL_STATES, RESULT, TRANSITIONS, decideEventStep, causeHolds } = require("../../lib/events/eventMachine");
const { STABLE, RECON, CONTESTED, INVASION, OCCUPIED, CONSOLIDATING, CLAIM_STATES, HELD_STATES } = require("../../lib/world/occupation/schema");

const catalogResult = validateCatalog(EVENT_CATALOG);
assert.strictEqual(catalogResult.ok, true, "EVENT_CATALOG should validate");
const CATALOG = catalogResult.catalog;

function createBaseContext(overrides = {}) {
  const now = 1000000000000;
  const seed = 0x12345678;
  const round = 1;
  const intervalMs = 3600000;

  const baseCandidates = [
    {
      systemId: 30001868,
      securityClass: "nullsec",
      regionId: 10000022,
      causes: [
        { cause: CAUSE.OCCUPATION_CLAIM, factionId: 500019, campaignId: null, occupationState: CONTESTED },
      ],
      observedDistance: 0,
    },
    {
      systemId: 30001893,
      securityClass: "nullsec",
      regionId: 10000022,
      causes: [
        { cause: CAUSE.OCCUPATION_HELD, factionId: 500019, campaignId: null, occupationState: OCCUPIED },
      ],
      observedDistance: 5,
    },
    {
      systemId: 30001923,
      securityClass: "nullsec",
      regionId: 10000022,
      causes: [
        { cause: CAUSE.CAMPAIGN_THEATRE, factionId: 500019, campaignId: "k3-stain", occupationState: STABLE },
      ],
      observedDistance: 10,
    },
  ];

  return {
    now,
    seed,
    round,
    intervalMs,
    catalog: CATALOG,
    excludedRegionIds: [10000070, 100001000],
    limits: {
      maxNewEventsPerPass: 10,
      maxOpenEvents: 100,
      maxOpenEventsPerSystem: 3,
      maxNewSitesPerSystemPerWindow: 10,
      siteWindowMs: 3600000,
      presenceRadius: 10,
      presenceBonus: 500,
      maxSkipped: 100,
    },
    candidates: baseCandidates,
    openEvents: [],
    recent: [],
    recentTruncated: false,
    ...overrides,
  };
}

function testE1Determinism() {
  const ctx = createBaseContext();
  const frozenCtx = deepFreeze(JSON.parse(JSON.stringify(ctx)));

  const result1 = chooseEvents(frozenCtx);
  const result2 = chooseEvents(frozenCtx);

  assert.deepStrictEqual(result1, result2, "Two calls with same context must be deepStrictEqual");

  assert.ok(result1.plans.length > 0, "E1 base context must produce plans");
  for (const plan of result1.plans) {
    const type = getEventType(CATALOG, plan.eventType);
    assert.strictEqual(plan.label, `${FACTION_LABELS[plan.factionId]} ${type.labelNoun}`, "plan.label must use FACTION_LABELS");
  }

  assert.deepStrictEqual(frozenCtx, deepFreeze(JSON.parse(JSON.stringify(ctx))), "Input context must not be mutated");

  const tieCtx = createBaseContext({
    candidates: [
      {
        systemId: 30001868,
        securityClass: "nullsec",
        regionId: 10000022,
        causes: [{ cause: CAUSE.OCCUPATION_CLAIM, factionId: 500019, campaignId: null, occupationState: CONTESTED }],
        observedDistance: 5,
      },
      {
        systemId: 30001893,
        securityClass: "nullsec",
        regionId: 10000022,
        causes: [{ cause: CAUSE.OCCUPATION_CLAIM, factionId: 500019, campaignId: null, occupationState: CONTESTED }],
        observedDistance: 5,
      },
    ],
    limits: { ...createBaseContext().limits, maxNewEventsPerPass: 1 },
  });
  const tieFrozen = deepFreeze(JSON.parse(JSON.stringify(tieCtx)));

  const r1 = chooseEvents({ ...tieFrozen, seed: 0x11111111 });
  const r2 = chooseEvents({ ...tieFrozen, seed: 0x22222222 });

  assert.strictEqual(r1.ok, true);
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(r1.plans.length, 1);
  assert.strictEqual(r2.plans.length, 1);
}

function deepFreeze(obj) {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) {
    obj.forEach(deepFreeze);
    return Object.freeze(obj);
  }
  Object.values(obj).forEach(deepFreeze);
  return Object.freeze(obj);
}

function testE2CooldownAndDuplicates() {
  const baseCtx = createBaseContext({
    candidates: [
      {
        systemId: 30001868,
        securityClass: "nullsec",
        regionId: 10000022,
        causes: [{ cause: CAUSE.OCCUPATION_CLAIM, factionId: 500019, campaignId: null, occupationState: CONTESTED }],
        observedDistance: 0,
      },
    ],
    limits: { ...createBaseContext().limits, maxNewEventsPerPass: 1 },
  });

  const now = baseCtx.now;
  const cooldownMs = 6 * 3600000;

  const ctxCooldown = {
    ...baseCtx,
    recent: [{ systemId: 30001868, eventType: "pirate_incursion", createdAt: now - cooldownMs + 1, spawnBudget: 1 }],
  };
  const rCooldown = chooseEvents(ctxCooldown);
  assert.strictEqual(rCooldown.ok, true);
  assert.strictEqual(rCooldown.plans.length, 0, "Should have 0 plans due to cooldown");
  assert.strictEqual(rCooldown.skippedByReason.COOLDOWN, 1, "Should have COOLDOWN reason");

  const ctxCooldownEdge = {
    ...baseCtx,
    recent: [{ systemId: 30001868, eventType: "pirate_incursion", createdAt: now - cooldownMs, spawnBudget: 1 }],
  };
  const rCooldownEdge = chooseEvents(ctxCooldownEdge);
  assert.strictEqual(rCooldownEdge.ok, true);
  assert.strictEqual(rCooldownEdge.plans.length, 1, "Should have 1 plan at cooldown boundary");

  const ctxDuplicate = {
    ...baseCtx,
    openEvents: [{ systemId: 30001868, eventType: "pirate_incursion" }],
  };
  const rDuplicate = chooseEvents(ctxDuplicate);
  assert.strictEqual(rDuplicate.ok, true);
  assert.strictEqual(rDuplicate.plans.length, 0, "Should have 0 plans due to duplicate");
  assert.strictEqual(rDuplicate.skippedByReason.DUPLICATE, 1, "Should have DUPLICATE reason");

  const ctxSystemBusy = {
    ...baseCtx,
    limits: { ...baseCtx.limits, maxOpenEventsPerSystem: 1 },
    openEvents: [{ systemId: 30001868, eventType: "pirate_stronghold" }],
  };
  const rSystemBusy = chooseEvents(ctxSystemBusy);
  assert.strictEqual(rSystemBusy.ok, true);
  assert.strictEqual(rSystemBusy.plans.length, 0, "Should have 0 plans due to system busy");
  assert.strictEqual(rSystemBusy.skippedByReason.SYSTEM_BUSY, 1, "Should have SYSTEM_BUSY reason");
}

function testE3Budgets() {
  const now = 1000000000000;
  const seed = 0x12345678;

  const ctxWindowFull = createBaseContext({
    now,
    seed,
    candidates: [
      {
        systemId: 30001868,
        securityClass: "nullsec",
        regionId: 10000022,
        causes: [{ cause: CAUSE.OCCUPATION_CLAIM, factionId: 500019, campaignId: null, occupationState: CONTESTED }],
        observedDistance: 0,
      },
    ],
    limits: { ...createBaseContext().limits, maxNewSitesPerSystemPerWindow: 2, maxNewEventsPerPass: 1, siteWindowMs: 86400000 },
    recent: [
      { systemId: 30001868, eventType: "pirate_incursion", createdAt: now - 50000000, spawnBudget: 1 },
      { systemId: 30001868, eventType: "pirate_incursion", createdAt: now - 60000000, spawnBudget: 1 },
    ],
  });
  const rWindowFull = chooseEvents(ctxWindowFull);
  assert.strictEqual(rWindowFull.ok, true);
  assert.strictEqual(rWindowFull.plans.length, 0, "Should have 0 plans due to window full");
  assert.strictEqual(rWindowFull.skippedByReason.WINDOW_FULL, 1, "Should have WINDOW_FULL reason");

  const ctxMaxNew = createBaseContext({
    candidates: [
      { systemId: 30001868, securityClass: "nullsec", regionId: 10000022, causes: [{ cause: CAUSE.OCCUPATION_CLAIM, factionId: 500019, campaignId: null, occupationState: CONTESTED }], observedDistance: 0 },
      { systemId: 30001893, securityClass: "nullsec", regionId: 10000022, causes: [{ cause: CAUSE.OCCUPATION_CLAIM, factionId: 500019, campaignId: null, occupationState: CONTESTED }], observedDistance: 0 },
      { systemId: 30001923, securityClass: "nullsec", regionId: 10000022, causes: [{ cause: CAUSE.OCCUPATION_CLAIM, factionId: 500019, campaignId: null, occupationState: CONTESTED }], observedDistance: 0 },
      { systemId: 30001948, securityClass: "nullsec", regionId: 10000022, causes: [{ cause: CAUSE.OCCUPATION_CLAIM, factionId: 500019, campaignId: null, occupationState: CONTESTED }], observedDistance: 0 },
      { systemId: 30001954, securityClass: "nullsec", regionId: 10000022, causes: [{ cause: CAUSE.OCCUPATION_CLAIM, factionId: 500019, campaignId: null, occupationState: CONTESTED }], observedDistance: 0 },
    ],
    limits: { ...createBaseContext().limits, maxNewEventsPerPass: 2 },
  });
  const rMaxNew = chooseEvents(ctxMaxNew);
  assert.strictEqual(rMaxNew.ok, true);
  assert.strictEqual(rMaxNew.plans.length, 2, "Should have exactly 2 plans due to maxNewEventsPerPass");
  assert.strictEqual(rMaxNew.skippedByReason.ROOM, 3, "Should have 3 ROOM skips");

  const ctxPresence = createBaseContext({
    candidates: [
      { systemId: 30001868, securityClass: "nullsec", regionId: 10000022, causes: [{ cause: CAUSE.OCCUPATION_CLAIM, factionId: 500019, campaignId: null, occupationState: CONTESTED }], observedDistance: 5 },
      { systemId: 30001893, securityClass: "nullsec", regionId: 10000022, causes: [{ cause: CAUSE.OCCUPATION_CLAIM, factionId: 500019, campaignId: null, occupationState: CONTESTED }], observedDistance: 0 },
    ],
    limits: { ...createBaseContext().limits, maxNewEventsPerPass: 1, presenceRadius: 2 },
  });
  const rPresence = chooseEvents(ctxPresence);
  assert.strictEqual(rPresence.ok, true);
  assert.strictEqual(rPresence.plans.length, 1);
  assert.strictEqual(rPresence.plans[0].systemId, 30001893, "System with distance 0 should win due to presence bonus");

  const ctxOpenLimit = createBaseContext({
    limits: { ...createBaseContext().limits, maxOpenEvents: 0 },
  });
  const rOpenLimit = chooseEvents(ctxOpenLimit);
  assert.strictEqual(rOpenLimit.ok, true);
  assert.strictEqual(rOpenLimit.plans.length, 0);
  assert.strictEqual(rOpenLimit.skippedByReason.OPEN_LIMIT, 1);

  const ctxTruncated = createBaseContext({ recentTruncated: true });
  const rTruncated = chooseEvents(ctxTruncated);
  assert.strictEqual(rTruncated.ok, false);
  assert.strictEqual(rTruncated.reason, "RECENT_TRUNCATED");
}

function testE4Causes() {
  const now = 1000000000000;
  const seed = 0x12345678;

  const ctx = createBaseContext();
  const r = chooseEvents(ctx);
  assert.strictEqual(r.ok, true);
  for (const plan of r.plans) {
    assert.ok(plan.cause, "Plan must have cause");
    assert.ok(plan.factionId > 0, "Plan must have factionId > 0");
    assert.strictEqual(plan.reason.cause, plan.cause, "reason.cause must match plan.cause");
    const type = getEventType(CATALOG, plan.eventType);
    assert.strictEqual(plan.label, `${FACTION_LABELS[plan.factionId]} ${type.labelNoun}`, "plan.label must use FACTION_LABELS");
  }

  const ctxNoCauses = createBaseContext({
    candidates: [{ systemId: 30001868, securityClass: "nullsec", regionId: 10000022, causes: [], observedDistance: 0 }],
  });
  const rNoCauses = chooseEvents(ctxNoCauses);
  assert.strictEqual(rNoCauses.ok, true);
  assert.strictEqual(rNoCauses.plans.length, 0);

  const causesStable = causesOfSystem(
    { systemId: 30001868, occupationState: STABLE, occupierFactionId: null, controllerFactionId: 500019 },
    []
  );
  assert.deepStrictEqual(causesStable, []);

  const causesContested = causesOfSystem(
    { systemId: 30001868, occupationState: CONTESTED, occupierFactionId: 500019, controllerFactionId: 500019 },
    []
  );
  assert.strictEqual(causesContested.length, 1);
  assert.strictEqual(causesContested[0].cause, CAUSE.OCCUPATION_CLAIM);
  assert.strictEqual(causesContested[0].factionId, 500019);

  const ctxImperium = createBaseContext({
    candidates: [
      { systemId: 30001868, securityClass: "nullsec", regionId: 10000022, causes: [{ cause: CAUSE.OCCUPATION_CLAIM, factionId: 500001, campaignId: null, occupationState: CONTESTED }], observedDistance: 0 },
    ],
  });
  const rImperium = chooseEvents(ctxImperium);
  assert.strictEqual(rImperium.ok, true);
  assert.strictEqual(rImperium.plans.length, 0);
  assert.strictEqual(rImperium.skippedByReason.NO_TEMPLATE, 1);

  const ctxRegion = createBaseContext({
    candidates: [
      { systemId: 31000000, securityClass: "nullsec", regionId: 10000070, causes: [{ cause: CAUSE.OCCUPATION_CLAIM, factionId: 500019, campaignId: null, occupationState: CONTESTED }], observedDistance: 0 },
    ],
  });
  const rRegion = chooseEvents(ctxRegion);
  assert.strictEqual(rRegion.ok, true);
  assert.strictEqual(rRegion.plans.length, 0);
  assert.strictEqual(rRegion.skippedByReason.REGION_EXCLUDED, 1);
}

function testE5CatalogAndSource() {
  const result = validateCatalog(EVENT_CATALOG);
  assert.strictEqual(result.ok, true, "EVENT_CATALOG must validate");

  const badCatalog = JSON.parse(JSON.stringify(EVENT_CATALOG));
  badCatalog[0].templatesByFaction[500010].push("client-dungeon:5524");
  const badResult = validateCatalog(badCatalog);
  assert.strictEqual(badResult.ok, false);
  assert.strictEqual(badResult.reason, "CATALOG_INVALID");

  const longLabelCatalog = JSON.parse(JSON.stringify(EVENT_CATALOG));
  longLabelCatalog[0].labelNoun = "X".repeat(60);
  const longLabelResult = validateCatalog(longLabelCatalog);
  assert.strictEqual(longLabelResult.ok, false, "label > 64 chars must fail validation");
  assert.strictEqual(longLabelResult.reason, "CATALOG_INVALID");
  assert.ok(longLabelResult.errors.some((e) => e.includes(".label ") && e.includes("exceeds 64")), "label length error expected");

  assert.strictEqual(withoutTemplates(CATALOG, []).catalog.factionLabels, CATALOG.factionLabels);

  const withoutResult = withoutTemplates(CATALOG, ["client-dungeon:2203"]);
  assert.ok(withoutResult.removed.includes("client-dungeon:2203"));
  const pirateIncursionType = getEventType(withoutResult.catalog, "pirate_incursion");
  assert.ok(pirateIncursionType.templatesByFaction[500010]);
  assert.strictEqual(pirateIncursionType.templatesByFaction[500010].length, 3);

  const directorContent = fs.readFileSync(path.join(__dirname, "../../lib/events/director.js"), "utf8");
  const requireMatches = directorContent.match(/require\(['"][^'"]+['"]\)/g) || [];
  const nonRngRequires = requireMatches.filter((r) => !r.includes("../util/rng"));
  assert.strictEqual(nonRngRequires.length, 0, `director.js must only require ../util/rng, found: ${nonRngRequires.join(", ")}`);
}

const PACK_PATH = findPack("combat-anomalies");
const EXTRA_PACK_PATHS = ["drone-anomalies", "wormhole-sites"].map((name) => findPack(name));

function testE5bTemplatesInPack() {
  const templateIds = listTemplateIds(CATALOG);
  assert.ok(EXTRA_PACK_PATHS.every((p) => p !== null), "drone-anomalies and wormhole-sites packs");
  const packContent = [PACK_PATH, ...EXTRA_PACK_PATHS].map((p) => fs.readFileSync(p, "utf8")).join("\n");
  for (const tmpl of templateIds) {
    const searchStr = `"templateID": "${tmpl}"`;
    if (!packContent.includes(searchStr)) {
      throw new Error(`Template ${tmpl} not found in content pack`);
    }
  }
}

function testE6StateMachine() {
  const testCases = [
    [STATE.PLANNED, { now: 100, type: null, causeHolds: true, siteStates: null }, "QUARANTINE", STATE.QUARANTINED, RESULT.CATALOG_MISSING, "EVENT_CANCELLED", "PLANNED: type=null -> QUARANTINE"],
    [STATE.PLANNED, { now: 200, type: { expiresAt: 150 }, causeHolds: true, siteStates: null }, "CANCEL", STATE.CANCELLED, RESULT.EXPIRED_UNSTARTED, null, "PLANNED: now>=expiresAt -> CANCEL"],
    [STATE.PLANNED, { now: 100, type: { expiresAt: 200 }, causeHolds: false, siteStates: null }, "CANCEL", STATE.CANCELLED, RESULT.CAUSE_GONE, null, "PLANNED: causeHolds=false -> CANCEL"],
    [STATE.PLANNED, { now: 150, type: { expiresAt: 200 }, causeHolds: true, siteStates: null }, "ACTIVATE", STATE.ACTIVE, null, null, "PLANNED: now>=dueAt -> ACTIVATE"],
    [STATE.ACTIVE, { now: 100, type: null, causeHolds: true, siteStates: null }, "QUARANTINE", STATE.QUARANTINED, RESULT.CATALOG_MISSING, "EVENT_CANCELLED", "ACTIVE: type=null -> QUARANTINE"],
    [STATE.ACTIVE, { now: 200, type: { expiresAt: 150, aftermathMs: 1800000 }, causeHolds: true, siteStates: ["COMPLETED", "COMPLETED"] }, "FINISH", STATE.COMPLETED, RESULT.CLEARED, "EVENT_END", "ACTIVE: sitesCreated=2, all COMPLETED, now>=expiresAt -> FINISH"],
    [STATE.ACTIVE, { now: 100, type: { expiresAt: 200, aftermathMs: 1800000 }, causeHolds: true, siteStates: ["COMPLETED", "COMPLETED"] }, "START_AFTERMATH", STATE.COMPLETING, null, null, "ACTIVE: sitesCreated=2, all COMPLETED, now<expiresAt -> START_AFTERMATH"],
    [STATE.ACTIVE, { now: 200, type: { expiresAt: 150 }, causeHolds: true, siteStates: null }, "EXPIRE", STATE.COMPLETED, RESULT.EXPIRED, "EVENT_END", "ACTIVE: now>=expiresAt -> EXPIRE"],
    [STATE.ACTIVE, { now: 100, type: { expiresAt: 200 }, causeHolds: false, siteStates: null }, "CANCEL", STATE.CANCELLED, RESULT.CAUSE_GONE, "EVENT_CANCELLED", "ACTIVE: causeHolds=false -> CANCEL"],
    [STATE.COMPLETING, { now: 200, type: { aftermathMs: 1800000 }, causeHolds: true, siteStates: null }, "FINISH", STATE.COMPLETED, RESULT.CLEARED, "EVENT_END", "COMPLETING: now>=dueAt -> FINISH"],
    [STATE.COMPLETING, { now: 100, type: { aftermathMs: 1800000 }, causeHolds: true, siteStates: null }, "NONE", null, null, null, "COMPLETING: now<dueAt -> NONE"],
    [STATE.COMPLETED, { now: 100, type: {}, causeHolds: true, siteStates: null }, "NONE", null, null, null, "COMPLETED: terminal -> NONE"],
    [STATE.CANCELLED, { now: 100, type: {}, causeHolds: true, siteStates: null }, "NONE", null, null, null, "CANCELLED: terminal -> NONE"],
    [STATE.QUARANTINED, { now: 100, type: {}, causeHolds: true, siteStates: null }, "NONE", null, null, null, "QUARANTINED: terminal -> NONE"],
  ];

  for (const [state, facts, expectedAction, expectedTo, expectedResult, expectedCleanup, desc] of testCases) {
    const event = {
      state,
      eventType: "pirate_incursion",
      dueAt: 150,
      expiresAt: facts.type?.expiresAt || 200,
      sitesCreated: 2,
    };
    const result = decideEventStep(event, facts);
    assert.strictEqual(result.action, expectedAction, `${desc}: action`);
    assert.strictEqual(result.to, expectedTo, `${desc}: to`);
    assert.strictEqual(result.result, expectedResult, `${desc}: result`);
    assert.strictEqual(result.cleanup, expectedCleanup, `${desc}: cleanup`);

    if (result.action !== "NONE") {
      assert.ok(TRANSITIONS.some(([f, t]) => f === state && t === result.to), `${desc}: transition must be in TRANSITIONS`);
    }
  }

  const eventClaim = { cause: CAUSE.OCCUPATION_CLAIM, factionId: 500019, campaignId: null };
  const eventHeld = { cause: CAUSE.OCCUPATION_HELD, factionId: 500019, campaignId: null };
  const eventCampaign = { cause: CAUSE.CAMPAIGN_THEATRE, factionId: 500019, campaignId: "k3-stain" };

  assert.strictEqual(causeHolds(eventClaim, { occupationState: CONTESTED, occupierFactionId: 500019, controllerFactionId: 500019 }, []), true);
  assert.strictEqual(causeHolds(eventClaim, { occupationState: INVASION, occupierFactionId: 500019, controllerFactionId: 500019 }, []), true);
  assert.strictEqual(causeHolds(eventClaim, { occupationState: OCCUPIED, occupierFactionId: 500019, controllerFactionId: 500019 }, []), true);
  assert.strictEqual(causeHolds(eventClaim, { occupationState: STABLE, occupierFactionId: 500019, controllerFactionId: 500019 }, []), false);
  assert.strictEqual(causeHolds(eventClaim, { occupationState: CONTESTED, occupierFactionId: 500011, controllerFactionId: 500019 }, []), false);
  assert.strictEqual(causeHolds(eventClaim, { occupationState: CONTESTED, occupierFactionId: null, controllerFactionId: 500019 }, []), false);
  assert.strictEqual(causeHolds(eventClaim, null, []), null);

  assert.strictEqual(causeHolds(eventHeld, { occupationState: OCCUPIED, occupierFactionId: 500019, controllerFactionId: 500019 }, []), true);
  assert.strictEqual(causeHolds(eventHeld, { occupationState: CONSOLIDATING, occupierFactionId: 500019, controllerFactionId: 500019 }, []), true);
  assert.strictEqual(causeHolds(eventHeld, { occupationState: STABLE, occupierFactionId: 500019, controllerFactionId: 500019 }, []), false);

  assert.strictEqual(causeHolds(eventCampaign, { occupationState: STABLE, occupierFactionId: null, controllerFactionId: 500019 }, ["k3-stain"]), true);
  assert.strictEqual(causeHolds(eventCampaign, { occupationState: STABLE, occupierFactionId: null, controllerFactionId: 500019 }, []), false);
  assert.strictEqual(causeHolds(eventCampaign, { occupationState: STABLE, occupierFactionId: null, controllerFactionId: 500011 }, ["k3-stain"]), false);
  assert.strictEqual(causeHolds(eventCampaign, null, ["k3-stain"]), null);
}

const IMPERIUM = 500001;
const GURISTAS = 500010;
const ANGEL = 500011;

function imperiumClaim(opponents, extra = {}) {
  return { systemId: 30001868, securityClass: "nullsec", regionId: 10000022, observedDistance: 0, ...extra,
    causes: [{ cause: CAUSE.OCCUPATION_CLAIM, factionId: IMPERIUM, campaignId: null, occupationState: CONTESTED,
      opponents }] };
}

function testWEC2Opponent() {
  const claim = causesOfSystem({ systemId: 30001868, occupationState: CONTESTED, occupierFactionId: IMPERIUM,
    controllerFactionId: GURISTAS, sdeFactionId: ANGEL }, []);
  assert.deepStrictEqual(claim[0].opponents, [GURISTAS, ANGEL]);
  const r = chooseEvents(createBaseContext({ candidates: [imperiumClaim(claim[0].opponents)] }));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.plans.length, 1);
  const p = r.plans[0];
  assert.deepStrictEqual([p.eventType, p.factionId, p.contentFactionId, p.reason.contentFactionId, p.label],
    ["insurgent_resistance", IMPERIUM, GURISTAS, GURISTAS, "Guristas Resistance"]);
  assert.strictEqual(r.skippedByReason.NO_TEMPLATE, undefined, JSON.stringify(r.skippedByReason));
  const guristas = getEventType(CATALOG, "insurgent_resistance").templatesByFaction[GURISTAS];
  assert.ok(p.templateIds.length > 0 && p.templateIds.every((t) => guristas.includes(t)), p.templateIds.join(","));

  const free = causesOfSystem({ systemId: 30001868, occupationState: CONTESTED, occupierFactionId: IMPERIUM,
    controllerFactionId: null, sdeFactionId: ANGEL }, []);
  assert.deepStrictEqual(free[0].opponents, [ANGEL]);
  const rFree = chooseEvents(createBaseContext({ candidates: [imperiumClaim(free[0].opponents)] }));
  assert.deepStrictEqual(rFree.plans.map((x) => [x.contentFactionId, x.label]), [[ANGEL, "Angel Resistance"]]);
  assert.strictEqual(rFree.skippedByReason.NO_TEMPLATE, undefined, JSON.stringify(rFree.skippedByReason));

  const none = causesOfSystem({ systemId: 30001868, occupationState: CONTESTED, occupierFactionId: IMPERIUM,
    controllerFactionId: null, sdeFactionId: null }, []);
  assert.deepStrictEqual(none[0].opponents, []);
  const rNone = chooseEvents(createBaseContext({ candidates: [imperiumClaim(none[0].opponents)] }));
  assert.deepStrictEqual([rNone.plans.length, rNone.skippedByReason.NO_TEMPLATE > 0], [0, true]);
}

function testWEC3UnobservedCap() {
  const base = createBaseContext().limits;
  const limits = { ...base, observeRadius: 1, maxUnobservedOpen: 1 };
  const sansha = (systemId, observedDistance) => ({ systemId, securityClass: "nullsec", regionId: 10000022,
    observedDistance, causes: [{ cause: CAUSE.OCCUPATION_CLAIM, factionId: 500019, campaignId: null,
      occupationState: CONTESTED }] });
  const r = chooseEvents(createBaseContext({ limits, openUnobserved: 1,
    candidates: [sansha(30001868, null), sansha(30001893, 1), imperiumClaim([], { systemId: 30001923 })] }));
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.plans.map((p) => p.systemId), [30001893]);
  assert.deepStrictEqual(r.skipped.filter((x) => x.reason === "NOT_OBSERVED").map((x) => x.systemId), [30001868]);
  assert.deepStrictEqual(r.skipped.filter((x) => x.systemId === 30001923).map((x) => x.reason),
    ["NO_TEMPLATE"]);
  const rFree = chooseEvents(createBaseContext({ limits: { ...limits, maxUnobservedOpen: null }, openUnobserved: 1,
    candidates: [sansha(30001868, null), sansha(30001893, 1)] }));
  assert.deepStrictEqual(rFree.plans.map((p) => p.systemId).sort(), [30001868, 30001893]);
}

const STICKY_ROW = Object.freeze({ eventId: "ev-sticky", eventType: "pirate_incursion", systemId: 30001868,
  cause: CAUSE.OCCUPATION_CLAIM, factionId: 500019, campaignId: null, state: STATE.ACTIVE, sitesCreated: 1,
  dueAt: 100, expiresAt: 1000, createdAt: 50, corrupt: false });

function testEVS1StickyActive() {
  const type = getEventType(CATALOG, "pirate_incursion");
  const facts = { now: 500, type, causeHolds: false, siteStates: ["ACTIVE"], causeSticky: true };
  const keep = decideEventStep(STICKY_ROW, facts);
  assert.deepStrictEqual([keep.action, keep.to, keep.result, keep.cleanup], ["NONE", null, null, null]);
  const noSites = decideEventStep({ ...STICKY_ROW, sitesCreated: 0 }, { ...facts, siteStates: [] });
  assert.deepStrictEqual([noSites.action, noSites.to, noSites.result, noSites.cleanup],
    ["CANCEL", STATE.CANCELLED, RESULT.CAUSE_GONE, "EVENT_CANCELLED"]);
  const planned = decideEventStep({ ...STICKY_ROW, state: STATE.PLANNED }, facts);
  assert.deepStrictEqual([planned.action, planned.result], ["CANCEL", RESULT.CAUSE_GONE]);
}

function testEVS2StickyExpires() {
  const type = getEventType(CATALOG, "pirate_incursion");
  const r = decideEventStep(STICKY_ROW, { now: 1000, type, causeHolds: false, siteStates: ["ACTIVE"], causeSticky: true });
  assert.deepStrictEqual([r.action, r.to, r.result, r.cleanup], ["EXPIRE", STATE.COMPLETED, RESULT.EXPIRED, "EVENT_END"]);
}

function testEVS3FlagOffFacts() {
  const read = { open: { events: [STICKY_ROW] }, siteStates: new Map([["ev-sticky", ["ACTIVE"]]]),
    openSystems: new Map([[30001868, { systemId: 30001868, occupationState: STABLE, occupierFactionId: 500019,
      controllerFactionId: 500019 }]]), campaigns: { known: true, byId: new Map(), active: [] } };
  const opts = { at: 500, seed: 1, round: 1, intervalMs: 60000, boot: true };
  const today = decideEventStep(STICKY_ROW, { now: 500, type: getEventType(CATALOG, "pirate_incursion"),
    causeHolds: false, siteStates: ["ACTIVE"] });
  for (const P of [{ presenceActivation: false }, { presenceActivation: false, activeCauseStickyEnabled: false }]) {
    const off = buildDirectorInput(read, { catalog: CATALOG, P, graph: null, presence: null }, opts);
    assert.deepStrictEqual(off.facts[0].decision, today);
    assert.strictEqual(off.facts[0].decision.result, RESULT.CAUSE_GONE);
  }
  const on = buildDirectorInput(read, { catalog: CATALOG, P: { presenceActivation: false,
    activeCauseStickyEnabled: true }, graph: null, presence: null }, opts);
  assert.strictEqual(on.facts[0].decision.action, "NONE");
}

function testEVS4NearPlayerWins() {
  const claim = (systemId, observedDistance) => ({ systemId, securityClass: "nullsec", regionId: 10000022,
    observedDistance, causes: [{ cause: CAUSE.OCCUPATION_CLAIM, factionId: 500019, campaignId: null,
      occupationState: CONTESTED }] });
  const limits = { ...createBaseContext().limits, maxNewEventsPerPass: 1, presenceRadius: 2, presenceBonus: 1000 };
  for (const far of [null, 8]) {
    const r = chooseEvents(createBaseContext({ limits, candidates: [claim(30001893, far), claim(30001868, 0)] }));
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.plans.map((p) => p.systemId), [30001868], `far=${far}`);
  }
}

module.exports = function register({ test, skip, bench }) {
  test("E1 director: determinism, frozen input, plan.label from FACTION_LABELS", testE1Determinism);
  test("E2 director: cooldown boundary, DUPLICATE, SYSTEM_BUSY", testE2CooldownAndDuplicates);
  test("E3 director: WINDOW_FULL, ROOM, presence bonus, OPEN_LIMIT, RECENT_TRUNCATED", testE3Budgets);
  test("E4 director: causes, NO_TEMPLATE, REGION_EXCLUDED", testE4Causes);
  test("E5 catalog: validation, denied/long label, withoutTemplates, director requires only rng", testE5CatalogAndSource);
  if (PACK_PATH === null) {
    skip("E5b catalog: template IDs present in combat-anomalies content pack", `${packLabel("combat-anomalies")} not found`);
  }
  else bench("E5b catalog: template IDs present in combat-anomalies content pack", testE5bTemplatesInPack);
  test("E6 eventMachine: TRANSITIONS table and causeHolds", testE6StateMachine);
  test("WEC2 director OPPONENT: imperium claim -> insurgent_resistance with the controller NPCs, SDE "
    + "fallback, none -> NO_TEMPLATE", testWEC2Opponent);
  test("WEC3 director unobserved cap: NOT_OBSERVED after the gates, an observed candidate still planned",
    testWEC3UnobservedCap);
  test("EV-S1 eventMachine causeSticky: ACTIVE with a site waits, without sites / PLANNED -> CAUSE_GONE",
    testEVS1StickyActive);
  test("EV-S2 eventMachine causeSticky: now >= expiresAt -> EXPIRE/COMPLETED", testEVS2StickyExpires);
  test("EV-S3 buildDirectorInput flag off: decision as with today's facts (CAUSE_GONE); on -> NONE",
    testEVS3FlagOffFacts);
  test("EV-S4 director: a candidate near the player wins over a far one of the same weight "
    + "(presenceBonus 1000 permille)", testEVS4NearPlayerWins);
};