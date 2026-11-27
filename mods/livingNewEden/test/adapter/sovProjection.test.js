"use strict";

const assert = require("node:assert");
const {
  ACTION,
  REASON,
  isFailure,
  isPermanentFailure,
  isTemporaryFailure,
  SovWriteBudget,
  createBudget,
  DEFAULT_INVADER_FACTION_IDS,
  decideProjection,
  buildSovCall,
  decideWithBudget,
} = require("../../lib/adapter/sovProjection");

const SANSASHA = 500016;
const GURISTAS = 500017;
const ANGELS = 500018;
const SERPENTIS = 500019;
const BLOOD_RAIDERS = 500020;
const SLEEPERS = 500021;
const DRIFTERS_1 = 500026;
const DRIFTERS_2 = 500029;
const AMARR = 500001;
const CALDARI = 500003;

const VIRTUAL_ALLIANCE_SANSHA = 99000001;
const VIRTUAL_CORP_SANSHA = 99000011;
const PLAYER_ALLIANCE = 99000099;
const PLAYER_CORP = 99000199;

const SYSTEM_CLAIMABLE = 30000101;
const SYSTEM_NOT_CLAIMABLE = 30000102;

function makeModState(overrides = {}) {
  return {
    controllerFactionId: null,
    occupationState: "STABLE",
    phaseSeq: 0,
    capturedAt: null,
    ...overrides,
  };
}

function makeVirtualIdentity(allianceId, executorCorpId) {
  return { allianceId, executorCorpId };
}

function makeEvejsState(overrides = {}) {
  return {
    isClaimable: true,
    currentClaim: null,
    ...overrides,
  };
}

const INVADER_FACTION_IDS = new Set([SLEEPERS, DRIFTERS_1, DRIFTERS_2]);

function makeMockClock(initial = 1000000) {
  let now = initial;
  return {
    now: () => now,
    advance: (ms) => { now += ms; },
    getNow: () => now,
  };
}

module.exports = ({ test, skip }) => {

  test("isFailure: permanent reasons return true", () => {
    assert.strictEqual(isFailure(REASON.NOT_CLAIMABLE), true);
    assert.strictEqual(isFailure(REASON.INVADER_FACTION), true);
    assert.strictEqual(isFailure(REASON.PLAYER_CLAIM_PROTECTED), true);
  });

  test("isFailure: temporary reasons return true", () => {
    assert.strictEqual(isFailure(REASON.NO_VIRTUAL_IDENTITY), true);
    assert.strictEqual(isFailure(REASON.ALREADY_SYNCED), true);
    assert.strictEqual(isFailure(REASON.BUDGET_EXCEEDED), true);
  });

  test("isFailure: action reasons return false (not failures)", () => {
    assert.strictEqual(isFailure(REASON.CONTROLLER_GAINED), false);
    assert.strictEqual(isFailure(REASON.CONTROLLER_LOST), false);
    assert.strictEqual(isFailure(REASON.CONTROLLER_TRANSFER), false);
    assert.strictEqual(isFailure(REASON.HUB_REINFORCE), false);
  });

  test("isFailure: unknown reason returns false", () => {
    assert.strictEqual(isFailure("UNKNOWN_REASON"), false);
    assert.strictEqual(isFailure(""), false);
    assert.strictEqual(isFailure(null), false);
    assert.strictEqual(isFailure(123), false);
  });

  test("isPermanentFailure: only permanent reasons return true", () => {
    assert.strictEqual(isPermanentFailure(REASON.NOT_CLAIMABLE), true);
    assert.strictEqual(isPermanentFailure(REASON.INVADER_FACTION), true);
    assert.strictEqual(isPermanentFailure(REASON.PLAYER_CLAIM_PROTECTED), true);
    assert.strictEqual(isPermanentFailure(REASON.NO_VIRTUAL_IDENTITY), false);
    assert.strictEqual(isPermanentFailure(REASON.ALREADY_SYNCED), false);
    assert.strictEqual(isPermanentFailure(REASON.BUDGET_EXCEEDED), false);
  });

  test("isTemporaryFailure: only temporary reasons return true", () => {
    assert.strictEqual(isTemporaryFailure(REASON.NO_VIRTUAL_IDENTITY), true);
    assert.strictEqual(isTemporaryFailure(REASON.ALREADY_SYNCED), true);
    assert.strictEqual(isTemporaryFailure(REASON.BUDGET_EXCEEDED), true);
    assert.strictEqual(isTemporaryFailure(REASON.NOT_CLAIMABLE), false);
    assert.strictEqual(isTemporaryFailure(REASON.INVADER_FACTION), false);
  });

  test("SovWriteBudget: default config (8 tokens, 5min window) requires now function", () => {
    const clock = makeMockClock();
    const budget = new SovWriteBudget({ now: clock.now });
    const status = budget.getStatus();
    assert.strictEqual(status.tokens, 8);
    assert.strictEqual(status.maxTokens, 8);
    assert.strictEqual(status.windowMs, 300000);
    assert.ok(!("retryQueueLength" in status), "getStatus should not have retryQueueLength");
  });

  test("SovWriteBudget: throws without now function", () => {
    assert.throws(
      () => new SovWriteBudget({}),
      /requires a 'now' function/
    );
  });

  test("SovWriteBudget: custom config with now", () => {
    const clock = makeMockClock();
    const budget = new SovWriteBudget({ maxTokens: 5, windowMs: 60000, now: clock.now });
    const status = budget.getStatus();
    assert.strictEqual(status.tokens, 5);
    assert.strictEqual(status.maxTokens, 5);
    assert.strictEqual(status.windowMs, 60000);
  });

  test("SovWriteBudget: tryConsume succeeds while tokens available", () => {
    const clock = makeMockClock();
    const budget = new SovWriteBudget({ maxTokens: 3, windowMs: 60000, now: clock.now });
    const r1 = budget.tryConsume();
    const r2 = budget.tryConsume();
    const r3 = budget.tryConsume();

    assert.strictEqual(r1.ok, true);
    assert.strictEqual(r1.tokensRemaining, 2);
    assert.strictEqual(r2.ok, true);
    assert.strictEqual(r2.tokensRemaining, 1);
    assert.strictEqual(r3.ok, true);
    assert.strictEqual(r3.tokensRemaining, 0);
  });

  test("SovWriteBudget: tryConsume fails when exhausted", () => {
    const clock = makeMockClock();
    const budget = new SovWriteBudget({ maxTokens: 2, windowMs: 60000, now: clock.now });
    budget.tryConsume();
    budget.tryConsume();
    const r = budget.tryConsume();

    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.tokensRemaining, 0);
    assert.strictEqual(r.retryAfterMs, 60000);
    assert.strictEqual(r.queued, false);
  });

  test("SovWriteBudget: tokens refill at window boundary", () => {
    const clock = makeMockClock(1000000);
    const budget = new SovWriteBudget({ maxTokens: 2, windowMs: 1000, now: clock.now });

    budget.tryConsume();
    budget.tryConsume();
    assert.strictEqual(budget.getStatus().tokens, 0);

    clock.advance(1500);
    const status = budget.getStatus();
    assert.strictEqual(status.tokens, 2);
    assert.strictEqual(status.windowStart, 1001500);
  });

  test("createBudget: factory creates budget with config and now", () => {
    const clock = makeMockClock();
    const budget = createBudget({ maxSovWritesPerWindow: 10, sovWriteWindowMs: 120000, now: clock.now });
    const status = budget.getStatus();
    assert.strictEqual(status.maxTokens, 10);
    assert.strictEqual(status.windowMs, 120000);
  });

  test("createBudget: throws without now function", () => {
    assert.throws(
      () => createBudget({ maxSovWritesPerWindow: 10, sovWriteWindowMs: 120000 }),
      /requires config.now/
    );
  });

  test("DEFAULT_INVADER_FACTION_IDS contains expected IDs", () => {
    assert.strictEqual(DEFAULT_INVADER_FACTION_IDS.has(SLEEPERS), true);
    assert.strictEqual(DEFAULT_INVADER_FACTION_IDS.has(DRIFTERS_1), true);
    assert.strictEqual(DEFAULT_INVADER_FACTION_IDS.has(DRIFTERS_2), true);
    assert.strictEqual(DEFAULT_INVADER_FACTION_IDS.has(SANSASHA), false);
    assert.strictEqual(DEFAULT_INVADER_FACTION_IDS.has(AMARR), false);
  });

  test("decideProjection: GAIN - claimable nullsec, controller=Sansha, virtualIdentity ok, EveJS claim=null", () => {
    const decision = decideProjection(
      SYSTEM_CLAIMABLE,
      makeModState({ controllerFactionId: SANSASHA, phaseSeq: 5 }),
      makeVirtualIdentity(VIRTUAL_ALLIANCE_SANSHA, VIRTUAL_CORP_SANSHA),
      makeEvejsState({ isClaimable: true, currentClaim: null }),
      INVADER_FACTION_IDS
    );

    assert.strictEqual(decision.action, ACTION.GAIN);
    assert.strictEqual(decision.reason, REASON.CONTROLLER_GAINED);
    assert.strictEqual(decision.allianceId, VIRTUAL_ALLIANCE_SANSHA);
    assert.strictEqual(decision.executorCorpId, VIRTUAL_CORP_SANSHA);
    assert.strictEqual(decision.skip, false);
  });

  test("decideProjection: NONE - player claim protection (EveJS claim by non-virtual alliance)", () => {
    const decision = decideProjection(
      SYSTEM_CLAIMABLE,
      makeModState({ controllerFactionId: SANSASHA, phaseSeq: 5 }),
      makeVirtualIdentity(VIRTUAL_ALLIANCE_SANSHA, VIRTUAL_CORP_SANSHA),
      makeEvejsState({
        isClaimable: true,
        currentClaim: { allianceID: PLAYER_ALLIANCE, corporationID: PLAYER_CORP, isVirtualAlliance: false },
      }),
      INVADER_FACTION_IDS
    );

    assert.strictEqual(decision.action, ACTION.NONE);
    assert.strictEqual(decision.reason, REASON.PLAYER_CLAIM_PROTECTED);
    assert.strictEqual(decision.skip, true);
  });

  test("decideProjection: TRANSFER - controller A -> B, both have virtualIdentity, EveJS claim is our A (virtual)", () => {
    const decision = decideProjection(
      SYSTEM_CLAIMABLE,
      makeModState({ controllerFactionId: GURISTAS, phaseSeq: 10 }),
      makeVirtualIdentity(99000002, 99000012),
      makeEvejsState({
        isClaimable: true,
        currentClaim: { allianceID: VIRTUAL_ALLIANCE_SANSHA, corporationID: VIRTUAL_CORP_SANSHA, isVirtualAlliance: true },
      }),
      INVADER_FACTION_IDS
    );

    assert.strictEqual(decision.action, ACTION.TRANSFER);
    assert.strictEqual(decision.reason, REASON.CONTROLLER_TRANSFER);
    assert.strictEqual(decision.allianceId, 99000002);
    assert.strictEqual(decision.executorCorpId, 99000012);
    assert.strictEqual(decision.skip, false);
  });

  test("decideProjection: NONE - invader faction controller (Sleepers)", () => {
    const decision = decideProjection(
      SYSTEM_CLAIMABLE,
      makeModState({ controllerFactionId: SLEEPERS, phaseSeq: 1 }),
      makeVirtualIdentity(99000003, 99000013),
      makeEvejsState({ isClaimable: true, currentClaim: null }),
      INVADER_FACTION_IDS
    );

    assert.strictEqual(decision.action, ACTION.NONE);
    assert.strictEqual(decision.reason, REASON.INVADER_FACTION);
    assert.strictEqual(decision.skip, true);
  });

  test("decideProjection: NONE - invader faction controller (Drifters 500026)", () => {
    const decision = decideProjection(
      SYSTEM_CLAIMABLE,
      makeModState({ controllerFactionId: DRIFTERS_1, phaseSeq: 1 }),
      null,
      makeEvejsState({ isClaimable: true, currentClaim: null }),
      INVADER_FACTION_IDS
    );

    assert.strictEqual(decision.action, ACTION.NONE);
    assert.strictEqual(decision.reason, REASON.INVADER_FACTION);
  });

  test("decideProjection: NONE - invader faction controller (Drifters 500029)", () => {
    const decision = decideProjection(
      SYSTEM_CLAIMABLE,
      makeModState({ controllerFactionId: DRIFTERS_2, phaseSeq: 1 }),
      null,
      makeEvejsState({ isClaimable: true, currentClaim: null }),
      INVADER_FACTION_IDS
    );

    assert.strictEqual(decision.action, ACTION.NONE);
    assert.strictEqual(decision.reason, REASON.INVADER_FACTION);
  });

  test("decideProjection: NONE - system not claimable (factionID>0, e.g., Amarr)", () => {
    const decision = decideProjection(
      SYSTEM_NOT_CLAIMABLE,
      makeModState({ controllerFactionId: SANSASHA, phaseSeq: 1 }),
      makeVirtualIdentity(VIRTUAL_ALLIANCE_SANSHA, VIRTUAL_CORP_SANSHA),
      makeEvejsState({ isClaimable: false, currentClaim: null }),
      INVADER_FACTION_IDS
    );

    assert.strictEqual(decision.action, ACTION.NONE);
    assert.strictEqual(decision.reason, REASON.NOT_CLAIMABLE);
    assert.strictEqual(decision.skip, true);
  });

  test("decideProjection: NONE - no virtual identity (getFactionIdentity returns REFUSED)", () => {
    const decision = decideProjection(
      SYSTEM_CLAIMABLE,
      makeModState({ controllerFactionId: SANSASHA, phaseSeq: 1 }),
      null,
      makeEvejsState({ isClaimable: true, currentClaim: null }),
      INVADER_FACTION_IDS
    );

    assert.strictEqual(decision.action, ACTION.NONE);
    assert.strictEqual(decision.reason, REASON.NO_VIRTUAL_IDENTITY);
    assert.strictEqual(decision.skip, true);
  });

  test("decideProjection: NONE - virtual identity missing executorCorpId", () => {
    const decision = decideProjection(
      SYSTEM_CLAIMABLE,
      makeModState({ controllerFactionId: SANSASHA, phaseSeq: 1 }),
      { allianceId: VIRTUAL_ALLIANCE_SANSHA, executorCorpId: null },
      makeEvejsState({ isClaimable: true, currentClaim: null }),
      INVADER_FACTION_IDS
    );

    assert.strictEqual(decision.action, ACTION.NONE);
    assert.strictEqual(decision.reason, REASON.NO_VIRTUAL_IDENTITY);
    assert.strictEqual(decision.skip, true);
  });

  test("decideProjection: NONE - already synced (EveJS claim matches our virtual alliance)", () => {
    const decision = decideProjection(
      SYSTEM_CLAIMABLE,
      makeModState({ controllerFactionId: SANSASHA, phaseSeq: 5 }),
      makeVirtualIdentity(VIRTUAL_ALLIANCE_SANSHA, VIRTUAL_CORP_SANSHA),
      makeEvejsState({
        isClaimable: true,
        currentClaim: { allianceID: VIRTUAL_ALLIANCE_SANSHA, corporationID: VIRTUAL_CORP_SANSHA, isVirtualAlliance: true },
      }),
      INVADER_FACTION_IDS
    );

    assert.strictEqual(decision.action, ACTION.NONE);
    assert.strictEqual(decision.reason, REASON.ALREADY_SYNCED);
    assert.strictEqual(decision.skip, true);
  });

  test("decideProjection: LOSS - controller becomes null, EveJS claim is our virtual alliance", () => {
    const decision = decideProjection(
      SYSTEM_CLAIMABLE,
      makeModState({ controllerFactionId: null, phaseSeq: 6 }),
      makeVirtualIdentity(VIRTUAL_ALLIANCE_SANSHA, VIRTUAL_CORP_SANSHA),
      makeEvejsState({
        isClaimable: true,
        currentClaim: { allianceID: VIRTUAL_ALLIANCE_SANSHA, corporationID: VIRTUAL_CORP_SANSHA, isVirtualAlliance: true },
      }),
      INVADER_FACTION_IDS
    );

    assert.strictEqual(decision.action, ACTION.LOSS);
    assert.strictEqual(decision.reason, REASON.CONTROLLER_LOST);
    assert.strictEqual(decision.allianceId, VIRTUAL_ALLIANCE_SANSHA);
    assert.strictEqual(decision.executorCorpId, VIRTUAL_CORP_SANSHA);
    assert.strictEqual(decision.skip, false);
  });

  test("decideWithBudget: returns decision with budget result when tokens available", () => {
    const clock = makeMockClock();
    const budget = createBudget({ maxSovWritesPerWindow: 5, sovWriteWindowMs: 60000, now: clock.now });

    const result = decideWithBudget(
      SYSTEM_CLAIMABLE,
      makeModState({ controllerFactionId: SANSASHA, phaseSeq: 1 }),
      makeVirtualIdentity(VIRTUAL_ALLIANCE_SANSHA, VIRTUAL_CORP_SANSHA),
      makeEvejsState({ isClaimable: true, currentClaim: null }),
      INVADER_FACTION_IDS,
      budget
    );

    assert.strictEqual(result.decision.action, ACTION.GAIN);
    assert.strictEqual(result.budgetResult.ok, true);
    assert.strictEqual(result.budgetResult.tokensRemaining, 4);
    assert.strictEqual(result.budgetResult.queued, false);
  });

  test("decideWithBudget: BUDGET_EXCEEDED when no tokens", () => {
    const clock = makeMockClock();
    const budget = createBudget({ maxSovWritesPerWindow: 1, sovWriteWindowMs: 60000, now: clock.now });
    budget.tryConsume();

    const result = decideWithBudget(
      SYSTEM_CLAIMABLE,
      makeModState({ controllerFactionId: SANSASHA, phaseSeq: 1 }),
      makeVirtualIdentity(VIRTUAL_ALLIANCE_SANSHA, VIRTUAL_CORP_SANSHA),
      makeEvejsState({ isClaimable: true, currentClaim: null }),
      INVADER_FACTION_IDS,
      budget
    );

    assert.strictEqual(result.decision.action, ACTION.NONE);
    assert.strictEqual(result.decision.reason, REASON.BUDGET_EXCEEDED);
    assert.strictEqual(result.decision.skip, true);
    assert.strictEqual(result.budgetResult.ok, false);
    assert.strictEqual(result.budgetResult.queued, false);
  });

  test("decideWithBudget: skip decisions don't consume budget", () => {
    const clock = makeMockClock();
    const budget = createBudget({ maxSovWritesPerWindow: 1, sovWriteWindowMs: 60000, now: clock.now });

    const result = decideWithBudget(
      SYSTEM_CLAIMABLE,
      makeModState({ controllerFactionId: SANSASHA, phaseSeq: 1 }),
      makeVirtualIdentity(VIRTUAL_ALLIANCE_SANSHA, VIRTUAL_CORP_SANSHA),
      makeEvejsState({ isClaimable: false, currentClaim: null }),
      INVADER_FACTION_IDS,
      budget
    );

    assert.strictEqual(result.decision.action, ACTION.NONE);
    assert.strictEqual(result.decision.reason, REASON.NOT_CLAIMABLE);
    assert.strictEqual(result.decision.skip, true);
    assert.strictEqual(result.budgetResult.ok, true);
    assert.strictEqual(result.budgetResult.skipped, true);
    assert.strictEqual(budget.getStatus().tokens, 1);
  });

  test("buildSovCall: GAIN -> anchorSovereigntyHub with alliance and corp", () => {
    const call = buildSovCall(
      { action: ACTION.GAIN, allianceId: VIRTUAL_ALLIANCE_SANSHA, executorCorpId: VIRTUAL_CORP_SANSHA, skip: false },
      SYSTEM_CLAIMABLE
    );

    assert.deepStrictEqual(call, {
      functionName: "anchorSovereigntyHub",
      args: [SYSTEM_CLAIMABLE, VIRTUAL_ALLIANCE_SANSHA, VIRTUAL_CORP_SANSHA],
    });
  });

  test("buildSovCall: LOSS -> loseSystemSovereignty", () => {
    const call = buildSovCall(
      { action: ACTION.LOSS, allianceId: VIRTUAL_ALLIANCE_SANSHA, executorCorpId: VIRTUAL_CORP_SANSHA, skip: false },
      SYSTEM_CLAIMABLE
    );

    assert.deepStrictEqual(call, {
      functionName: "loseSystemSovereignty",
      args: [SYSTEM_CLAIMABLE],
    });
  });

  test("buildSovCall: TRANSFER -> loseSystemSovereignty (first step)", () => {
    const call = buildSovCall(
      { action: ACTION.TRANSFER, allianceId: VIRTUAL_ALLIANCE_SANSHA, executorCorpId: VIRTUAL_CORP_SANSHA, skip: false },
      SYSTEM_CLAIMABLE
    );

    assert.deepStrictEqual(call, {
      functionName: "loseSystemSovereignty",
      args: [SYSTEM_CLAIMABLE],
    });
  });

  test("buildSovCall: REINFORCE -> reinforceSystemHub", () => {
    const call = buildSovCall(
      { action: ACTION.REINFORCE, allianceId: VIRTUAL_ALLIANCE_SANSHA, executorCorpId: VIRTUAL_CORP_SANSHA, skip: false },
      SYSTEM_CLAIMABLE
    );

    assert.deepStrictEqual(call, {
      functionName: "reinforceSystemHub",
      args: [SYSTEM_CLAIMABLE],
    });
  });

  test("buildSovCall: NONE or skip -> null", () => {
    assert.strictEqual(buildSovCall({ action: ACTION.NONE, skip: true }, SYSTEM_CLAIMABLE), null);
    assert.strictEqual(buildSovCall({ action: ACTION.GAIN, skip: true }, SYSTEM_CLAIMABLE), null);
    assert.strictEqual(buildSovCall({ action: ACTION.GAIN, allianceId: null, executorCorpId: null, skip: false }, SYSTEM_CLAIMABLE), null);
  });

  test("decideProjection: invalid systemId -> NOT_CLAIMABLE", () => {
    const decision = decideProjection(
      "abc",
      makeModState({ controllerFactionId: SANSASHA }),
      makeVirtualIdentity(VIRTUAL_ALLIANCE_SANSHA, VIRTUAL_CORP_SANSHA),
      makeEvejsState({ isClaimable: true }),
      INVADER_FACTION_IDS
    );

    assert.strictEqual(decision.action, ACTION.NONE);
    assert.strictEqual(decision.reason, REASON.NOT_CLAIMABLE);
  });

  test("decideProjection: negative systemId -> NOT_CLAIMABLE", () => {
    const decision = decideProjection(
      -1,
      makeModState({ controllerFactionId: SANSASHA }),
      makeVirtualIdentity(VIRTUAL_ALLIANCE_SANSHA, VIRTUAL_CORP_SANSHA),
      makeEvejsState({ isClaimable: true }),
      INVADER_FACTION_IDS
    );

    assert.strictEqual(decision.action, ACTION.NONE);
    assert.strictEqual(decision.reason, REASON.NOT_CLAIMABLE);
  });

  test("decideProjection: zero systemId -> NOT_CLAIMABLE", () => {
    const decision = decideProjection(
      0,
      makeModState({ controllerFactionId: SANSASHA }),
      makeVirtualIdentity(VIRTUAL_ALLIANCE_SANSHA, VIRTUAL_CORP_SANSHA),
      makeEvejsState({ isClaimable: true }),
      INVADER_FACTION_IDS
    );

    assert.strictEqual(decision.action, ACTION.NONE);
    assert.strictEqual(decision.reason, REASON.NOT_CLAIMABLE);
  });

  test("decideProjection: controller null but EveJS claim is player alliance -> PLAYER_CLAIM_PROTECTED", () => {
    const decision = decideProjection(
      SYSTEM_CLAIMABLE,
      makeModState({ controllerFactionId: null, phaseSeq: 10 }),
      makeVirtualIdentity(VIRTUAL_ALLIANCE_SANSHA, VIRTUAL_CORP_SANSHA),
      makeEvejsState({
        isClaimable: true,
        currentClaim: { allianceID: PLAYER_ALLIANCE, corporationID: PLAYER_CORP, isVirtualAlliance: false },
      }),
      INVADER_FACTION_IDS
    );

    assert.strictEqual(decision.action, ACTION.NONE);
    assert.strictEqual(decision.reason, REASON.PLAYER_CLAIM_PROTECTED);
  });

  test("decideProjection: controller null, no EveJS claim -> NO_CLAIM (nothing to do)", () => {
    const decision = decideProjection(
      SYSTEM_CLAIMABLE,
      makeModState({ controllerFactionId: null, phaseSeq: 10 }),
      makeVirtualIdentity(VIRTUAL_ALLIANCE_SANSHA, VIRTUAL_CORP_SANSHA),
      makeEvejsState({ isClaimable: true, currentClaim: null }),
      INVADER_FACTION_IDS
    );

    assert.strictEqual(decision.action, ACTION.NONE);
    assert.strictEqual(decision.reason, REASON.NO_CLAIM);
  });

  test("decideProjection: identical inputs produce identical outputs (deterministic)", () => {
    const modState = makeModState({ controllerFactionId: SANSASHA, phaseSeq: 5 });
    const virtualIdentity = makeVirtualIdentity(VIRTUAL_ALLIANCE_SANSHA, VIRTUAL_CORP_SANSHA);
    const evejsState = makeEvejsState({ isClaimable: true, currentClaim: null });

    const d1 = decideProjection(SYSTEM_CLAIMABLE, modState, virtualIdentity, evejsState, INVADER_FACTION_IDS);
    const d2 = decideProjection(SYSTEM_CLAIMABLE, modState, virtualIdentity, evejsState, INVADER_FACTION_IDS);

    assert.deepStrictEqual(d1, d2);
  });

  test("ACTION constants are frozen and correct", () => {
    assert.strictEqual(Object.isFrozen(ACTION), true);
    assert.strictEqual(ACTION.GAIN, "GAIN");
    assert.strictEqual(ACTION.LOSS, "LOSS");
    assert.strictEqual(ACTION.TRANSFER, "TRANSFER");
    assert.strictEqual(ACTION.REINFORCE, "REINFORCE");
    assert.strictEqual(ACTION.NONE, "NONE");
  });

  test("REASON constants are frozen and correct", () => {
    assert.strictEqual(Object.isFrozen(REASON), true);
    assert.strictEqual(REASON.CONTROLLER_GAINED, "CONTROLLER_GAINED");
    assert.strictEqual(REASON.CONTROLLER_LOST, "CONTROLLER_LOST");
    assert.strictEqual(REASON.CONTROLLER_TRANSFER, "CONTROLLER_TRANSFER");
    assert.strictEqual(REASON.HUB_REINFORCE, "HUB_REINFORCE");
    assert.strictEqual(REASON.NOT_CLAIMABLE, "NOT_CLAIMABLE");
    assert.strictEqual(REASON.INVADER_FACTION, "INVADER_FACTION");
    assert.strictEqual(REASON.NO_VIRTUAL_IDENTITY, "NO_VIRTUAL_IDENTITY");
    assert.strictEqual(REASON.PLAYER_CLAIM_PROTECTED, "PLAYER_CLAIM_PROTECTED");
    assert.strictEqual(REASON.ALREADY_SYNCED, "ALREADY_SYNCED");
    assert.strictEqual(REASON.BUDGET_EXCEEDED, "BUDGET_EXCEEDED");
    assert.strictEqual(REASON.NO_CLAIM, "NO_CLAIM");
  });

  test("decideProjection: LOSS - controller null, virtualIdentity=null, EveJS claim is virtual alliance (fix)", () => {
    const decision = decideProjection(
      SYSTEM_CLAIMABLE,
      makeModState({ controllerFactionId: null, phaseSeq: 6 }),
      null,
      makeEvejsState({
        isClaimable: true,
        currentClaim: { allianceID: VIRTUAL_ALLIANCE_SANSHA, corporationID: VIRTUAL_CORP_SANSHA, isVirtualAlliance: true },
      }),
      INVADER_FACTION_IDS
    );

    assert.strictEqual(decision.action, ACTION.LOSS);
    assert.strictEqual(decision.reason, REASON.CONTROLLER_LOST);
    assert.strictEqual(decision.allianceId, VIRTUAL_ALLIANCE_SANSHA);
    assert.strictEqual(decision.executorCorpId, VIRTUAL_CORP_SANSHA);
    assert.strictEqual(decision.skip, false);
  });

  test("decideProjection: LOSS - controller null, virtualIdentity=null, EveJS claim is another faction's virtual hub (fix)", () => {
    const decision = decideProjection(
      SYSTEM_CLAIMABLE,
      makeModState({ controllerFactionId: null, phaseSeq: 6 }),
      null,
      makeEvejsState({
        isClaimable: true,
        currentClaim: { allianceID: 99000002, corporationID: 99000012, isVirtualAlliance: true },
      }),
      INVADER_FACTION_IDS
    );

    assert.strictEqual(decision.action, ACTION.LOSS);
    assert.strictEqual(decision.reason, REASON.CONTROLLER_LOST);
    assert.strictEqual(decision.allianceId, 99000002);
    assert.strictEqual(decision.executorCorpId, 99000012);
    assert.strictEqual(decision.skip, false);
  });

  test("decideProjection: REINFORCE - controller lost with reinforceOnLoss=true", () => {
    const decision = decideProjection(
      SYSTEM_CLAIMABLE,
      makeModState({ controllerFactionId: null, phaseSeq: 6 }),
      null,
      makeEvejsState({
        isClaimable: true,
        currentClaim: { allianceID: VIRTUAL_ALLIANCE_SANSHA, corporationID: VIRTUAL_CORP_SANSHA, isVirtualAlliance: true },
      }),
      INVADER_FACTION_IDS,
      { reinforceOnLoss: true }
    );

    assert.strictEqual(decision.action, ACTION.REINFORCE);
    assert.strictEqual(decision.reason, REASON.HUB_REINFORCE);
    assert.strictEqual(decision.allianceId, VIRTUAL_ALLIANCE_SANSHA);
    assert.strictEqual(decision.executorCorpId, VIRTUAL_CORP_SANSHA);
    assert.strictEqual(decision.skip, false);
  });

  test("decideProjection: REINFORCE - controller lost with reinforceOnLoss=true, another faction's virtual hub", () => {
    const decision = decideProjection(
      SYSTEM_CLAIMABLE,
      makeModState({ controllerFactionId: null, phaseSeq: 6 }),
      null,
      makeEvejsState({
        isClaimable: true,
        currentClaim: { allianceID: 99000002, corporationID: 99000012, isVirtualAlliance: true },
      }),
      INVADER_FACTION_IDS,
      { reinforceOnLoss: true }
    );

    assert.strictEqual(decision.action, ACTION.REINFORCE);
    assert.strictEqual(decision.reason, REASON.HUB_REINFORCE);
    assert.strictEqual(decision.allianceId, 99000002);
    assert.strictEqual(decision.executorCorpId, 99000012);
    assert.strictEqual(decision.skip, false);
  });

  test("decideProjection: NO_CLAIM - controller null, no EveJS claim", () => {
    const decision = decideProjection(
      SYSTEM_CLAIMABLE,
      makeModState({ controllerFactionId: null, phaseSeq: 10 }),
      makeVirtualIdentity(VIRTUAL_ALLIANCE_SANSHA, VIRTUAL_CORP_SANSHA),
      makeEvejsState({ isClaimable: true, currentClaim: null }),
      INVADER_FACTION_IDS
    );

    assert.strictEqual(decision.action, ACTION.NONE);
    assert.strictEqual(decision.reason, REASON.NO_CLAIM);
    assert.strictEqual(decision.skip, true);
  });

  test("isTemporaryFailure: NO_CLAIM is temporary", () => {
    assert.strictEqual(isTemporaryFailure(REASON.NO_CLAIM), true);
    assert.strictEqual(isPermanentFailure(REASON.NO_CLAIM), false);
  });

};