"use strict";

const { createRng } = require("../../util/rng");
const { evaluateSupplyAndFronts } = require("./supply");
const { chooseNextOperation, liveCombatFleets } = require("./operations");
const { planHousekeeping, planTerritoryMarks, planReturns, planLogisticsRetire } = require("./housekeeping");
const { planMining } = require("./mining");
const { planProduction } = require("./production");
const { createHullLedger } = require("./hulls");
const { planUpkeep, shipCapOf, upgradeGrowthOf } = require("./upkeep");
const { planUnitPurchase } = require("./unitPurchase");
const { planMineralSwap } = require("./mineralSwap");
const { planLogistics } = require("./logistics");
const { planReplenish } = require("./replenish");
const { planCapitalReplenish } = require("./capitalReplenish");
const { planReplenishReturns, relabelNoStock } = require("./replenishReturn");
const { planConstruction } = require("./construction");
const { planSentries } = require("./sentries");
const { planTrade } = require("./trade");
const { deferSells } = require("./tradeSell");
const { planHunts } = require("./hunt");
const { planMerges } = require("./merge");
const { planStrandedFleets } = require("./strandedFleets");
const { planDeficitRelief } = require("./deficitRelief");
const { planGarrisonReinforce, planGarrisonRelease } = require("./garrison");
const { planPatrols } = require("./patrol");
const { planMinerRaids } = require("./minerRaids");
const { planCapsuleerPursuit } = require("./capsuleerPursuit");
const { markClaimHolders, defensePseudo, freedHolders, HOLDING } = require("./claimHold");
const { markFootholdHolders } = require("./footholdHold");
const { markHqHolders, planHqReturn } = require("./hqGarrison");
const { planHiveBrood } = require("./hive");
const { planHiveSwarm } = require("./hiveSwarm");
const { markHomePool, planInvaderHomePool, homeYieldOf, invaderRaidNotes } = require("./invaderEconomy");

function yieldOf(snapshot, E) {
  const y = homeYieldOf(snapshot.upkeep, E);
  return { iskDaily: y.iskDaily, unitsPerPeriod: y.unitsPerPeriod };
}
const { planBorderPosts } = require("./borderPosts");
const { planMinerEscorts } = require("./minerEscorts");
const { planIntercepts } = require("./intercepts");
const { planStructureAssault } = require("./structureAssault");
const { planHarvestRaid } = require("./harvestRaid");
const { planInvaderCounter } = require("./invaderCounter");
const { planBossResponse } = require("./bossResponse");

const { planRelief, DEFENDING, pickDefenders, heldStrength } = require("./relief");
const { planDefense } = require("./defense");
const { planIndustry, planUpgrades, minerPriorityOf, reserveForIndustry } = require("./industry");
const { planTerritoryTrim } = require("./territoryTrim");
const { planTreasury, projectTreasury, austerityParams, createFeeLedger, ladderFeeReachOf } = require("./treasury");
const { ladderPlanOf, applyLadder, ladderReserveOf } = require("./capitalLadder");

const REPLENISHING = "REPLENISHING";
const UPGRADING = "UPGRADING";
const SIEGING = "SIEGING";
const RELIEVING = "RELIEVING";
const IDLE = "IDLE";
const SIEGE_READY = "ready";

function markSiegeFleets(snapshot, params, pseudo) {
  const P = params.siege;
  const sg = snapshot.siege;
  const stationOn = Boolean(P && Array.isArray(P.fleetRoles) && sg && sg.mode === SIEGE_READY);
  const PP = params.playerSiege;
  const ps = snapshot.playerSiege;
  const playerOn = Boolean(PP && Array.isArray(PP.fleetRoles) && ps && ps.mode === SIEGE_READY
    && Array.isArray(ps.attacking) && ps.attacking.length > 0);
  if (!stationOn && !playerOn) return;
  const attacked = new Set(stationOn ? (sg.attacking || []).map((a) => a.systemId) : []);
  const defended = new Set(stationOn ? (sg.defending || []).map((d) => d.systemId) : []);
  const live = (a) => !Number.isFinite(PP.liveWindowMs) || !Number.isFinite(a.phaseEndsAt)
    || !Number.isFinite(snapshot.at) || a.phaseEndsAt + PP.liveWindowMs > snapshot.at;
  const playerAttacked = new Set(playerOn ? ps.attacking.filter(live).map((a) => a.systemId) : []);
  for (const x of snapshot.fleets) {
    if (pseudo.has(x.fleetId) || x.state !== IDLE) continue;
    const station = stationOn && P.fleetRoles.includes(x.fleetRole);
    if (station && attacked.has(x.systemId)) pseudo.set(x.fleetId, SIEGING);
    else if (playerOn && PP.fleetRoles.includes(x.fleetRole) && playerAttacked.has(x.systemId)) {
      pseudo.set(x.fleetId, SIEGING);
    } else if (station && defended.has(x.systemId)) pseudo.set(x.fleetId, DEFENDING);
  }
}

function markDefenseFleets(snapshot, params, pseudo) {
  const threats = snapshot.threats;
  if (!threats || threats.mode !== "ready" || !Array.isArray(threats.items) || threats.items.length === 0) return;
  const kind = params.kinds && params.kinds.find ? params.kinds.find((k) => k.kind === "defense") : null;
  if (!kind || !Array.isArray(kind.fleetRoles) || kind.fleetRoles.length === 0) return;
  const threatened = new Set(threats.items.map((t) => t.systemId));
  for (const x of snapshot.fleets) {
    if (pseudo.has(x.fleetId) || x.state !== IDLE || !kind.fleetRoles.includes(x.fleetRole)) continue;
    if (threatened.has(x.systemId)) pseudo.set(x.fleetId, DEFENDING);
  }
}

function withPseudo(snapshot, pseudo) {
  if (pseudo.size === 0) return snapshot;
  return { ...snapshot, fleets: snapshot.fleets.map((x) => (pseudo.has(x.fleetId)
    ? { ...x, state: pseudo.get(x.fleetId) } : x)) };
}

const DECISION_VERSION = 1;
const MAX_REASON_LENGTH = 200;
const DECIDE_THREW = "DECIDE_THREW";

function firstFrameOf(err) {
  try {
    const stack = err && typeof err.stack === "string" ? err.stack : "";
    const line = stack.split("\n").find((l) => /^\s+at\s/.test(l));
    return line ? line.trim().replace(/^at\s+/, "").slice(0, MAX_REASON_LENGTH) : null;
  } catch (_err) {
    return null;
  }
}

function threw(err) {
  let message;
  try {
    message = String((err && err.message) || err);
  } catch (_err) {
    message = "unprintable error";
  }
  return { outcome: "SKIPPED", reason: `${DECIDE_THREW}: ${message}`.slice(0, MAX_REASON_LENGTH),
    threwAt: firstFrameOf(err) };
}

function withIsk(budget, isk) {
  return Number.isSafeInteger(isk) ? { ...budget, isk } : budget;
}

function iskMinus(isk, cost) {
  if (!Number.isSafeInteger(isk)) return null;
  const c = cost && Number.isSafeInteger(cost.isk) && cost.isk > 0 ? cost.isk : 0;
  return Math.max(0, isk - c);
}

function withCapitalReplenish(snapshot, supply, params, ledger, replenish) {
  if (!params.capitalReplenish || !params.replenish) return replenish;
  const cap = planCapitalReplenish({ snapshot, params, ledger,
    budget: { resourceUnits: supply.affordable.resourceUnits - replenish.cost.resourceUnits,
      reserveUnits: supply.affordable.reserveUnits - replenish.cost.reserveUnits },
    room: params.replenish.maxReplenishPerReview - replenish.intents.length, slotBase: replenish.intents.length,
    skip: new Set(replenish.fleetIds) });
  if (cap.intents.length === 0 && cap.notes.length === 0) return replenish;
  return { intents: [...replenish.intents, ...cap.intents], notes: [...replenish.notes, ...cap.notes],
    cost: { resourceUnits: replenish.cost.resourceUnits + cap.cost.resourceUnits,
      reserveUnits: replenish.cost.reserveUnits + cap.cost.reserveUnits },
    fleetIds: [...replenish.fleetIds, ...cap.fleetIds] };
}

function warIskOf(intents) {
  const of = (i) => (i && Number.isSafeInteger(i.warIsk) && i.warIsk > 0 ? i.warIsk : 0);
  let sum = 0;
  for (const i of intents) {
    if (i.type === "MOBILIZE") sum += of(i);
    else if (i.type === "LAUNCH") {
      sum += of(i);
      for (const m of Array.isArray(i.mobilize) ? i.mobilize : []) sum += of(m);
    }
  }
  return sum;
}

function supplySummary(supply) {
  return { anchors: supply.anchors, bases: supply.bases, frontTargets: supply.frontTargets,
    frontCount: supply.frontCount, frontLimit: supply.frontLimit, canOpenFront: supply.canOpenFront,
    reachJumps: supply.reachJumps, reachSystems: supply.reach.size, captureJumps: supply.captureJumps,
    captureSystems: supply.captureReach.size, borderSystems: supply.border ? supply.border.size : 0,
    affordable: supply.affordable, capturedCount: supply.capturedCount, ownClaims: supply.ownClaims,
    captureRoomKnown: supply.captureRoomKnown, captureRoom: supply.captureRoom };
}

function ladderDiagOf(ladder, notes) {
  const first = (Array.isArray(notes) ? notes : []).find((n) => typeof n === "string" && n.startsWith("LADDER_"));
  return { note: first === undefined ? null : first.split(":")[0], cls: ladder.cls || null,
    bufferPermille: Number.isSafeInteger(ladder.bufferPermille) ? ladder.bufferPermille : null };
}

function decideReview(snapshot, params) {
  const base = { v: DECISION_VERSION, factionId: snapshot && snapshot.factionId, round: snapshot && snapshot.round,
    seed: snapshot && snapshot.seed };
  try {
    const rng = createRng(snapshot.seed);
    const hk = planHousekeeping(snapshot, params);
    const closed = new Set(hk.closed);
    const open = { ...snapshot, operations: snapshot.operations.filter((op) => !closed.has(op.operationId)) };
    const supply = evaluateSupplyAndFronts(open, params);
    hk.intents.push(...planTerritoryMarks(snapshot, supply, params));
    const doctrineId = snapshot.doctrine && snapshot.doctrine.doctrineId;
    const entryFronts = snapshot.entry ? snapshot.entry.maxActiveFronts : undefined;
    const wantFronts = Number.isSafeInteger(entryFronts) && Number.isSafeInteger(params.frontLimitCap)
      ? Math.max(0, Math.min(entryFronts, params.frontLimitCap)) : null;
    const touch = { type: "FACTION_TOUCH", lastReviewAt: snapshot.at,
      ...(typeof doctrineId === "string" && doctrineId !== snapshot.faction.doctrineId ? { doctrineId } : {}),
      ...(wantFronts !== null && wantFronts !== snapshot.faction.frontLimit ? { frontLimit: wantFronts } : {}) };
    if (snapshot.stationsMode === "pending") {
      return { ...base, outcome: "DEFERRED", reason: "STATIONS_PENDING", supply: supplySummary(supply), target: null,
        notes: ["STATIONS_PENDING"], stuck: hk.stuck, intents: [...hk.intents, touch] };
    }
    const trim = planTerritoryTrim(open, params.trim || null);
    hk.intents.push(...trim.intents);
    const upkeep0 = planUpkeep(open, supply, params);
    const proj0 = projectTreasury(snapshot, params);
    const bought = planUnitPurchase(open, upkeep0, proj0, params);
    const upkeep = bought.notes.length > 0
      ? { ...bought.upkeep, notes: [...bought.upkeep.notes, ...bought.notes] } : bought.upkeep;
    const proj = bought.proj;
    const brake = upkeep.offensiveAllowed !== true && supply.canOpenFront === true;
    const austerity = proj !== null && proj.austerity === true;
    const homeOnly = austerity && !brake;
    const war = proj !== null && proj.war ? proj.war : null;
    const shipCap = shipCapOf(open, upkeep, war ? { ...upkeep.projected, isk: war.room } : upkeep.projected, params);
    if (shipCap.capped) upkeep.notes.push("UPKEEP_SHIP_CAP");
    const upkept = { ...supply, affordable: shipCap.affordable,
      ...(shipCap.scoutRoom && params.reconUnblockEnabled === true ? { scoutAffordable: shipCap.scoutRoom } : {}),
      canOpenFront: supply.canOpenFront && upkeep.offensiveAllowed && !austerity,
      frontLimit: brake ? Math.min(supply.frontLimit, supply.frontCount) : supply.frontLimit,
      ...(homeOnly ? { homeOnly: true } : {}), ...(war ? { war } : {}) };
    const ledger = createHullLedger(open, params);
    const replenish = withCapitalReplenish(open, upkept, params, ledger, planReplenish(open, upkept, params, ledger));
    const pseudo = new Map(replenish.fleetIds.map((id) => [id, REPLENISHING]));
    markSiegeFleets(open, params, pseudo);
    markDefenseFleets(open, params, pseudo);
    const holdNotes = markClaimHolders(open, params, pseudo);
    holdNotes.push(...markFootholdHolders(open, params, pseudo));
    holdNotes.push(...markHqHolders(open, params, pseudo));
    holdNotes.push(...markHomePool(open, params.invaderEconomy || null, pseudo));
    holdNotes.push(...invaderRaidNotes(open, params.invaderEconomy || null));
    const guard = defensePseudo(open, pseudo);
    const holders = freedHolders(pseudo, guard);
    const relief = planRelief(withPseudo(open, guard), upkept, params, { holders });
    const yielded = [];
    for (const id of relief.fleetIds) {
      if (pseudo.get(id) === HOLDING) yielded.push(id);
      pseudo.set(id, RELIEVING);
      guard.set(id, RELIEVING);
    }
    const defenseOpts = { targets: new Set(relief.intents.map((i) => i.target.systemId)), holders };
    const defense = planDefense(withPseudo(open, guard), upkept, params, defenseOpts);
    for (const id of defense.fleetIds) {
      if (pseudo.get(id) === HOLDING) yielded.push(id);
      pseudo.set(id, RELIEVING);
    }
    if (yielded.length > 0) holdNotes.push("CLAIM_HOLD_YIELDED");
    const maxGrowth = upgradeGrowthOf(open, upkeep, params.upkeep);
    const upgrades = maxGrowth === undefined ? planUpgrades(withPseudo(open, pseudo), params, ledger)
      : planUpgrades(withPseudo(open, pseudo), params, ledger, { maxGrowth });
    for (const id of upgrades.fleetIds) pseudo.set(id, UPGRADING);
    const rest = withPseudo(open, pseudo);
    const funded = { ...upkept, affordable: withIsk({ resourceUnits: upkept.affordable.resourceUnits
      - replenish.cost.resourceUnits, reserveUnits: upkept.affordable.reserveUnits - replenish.cost.reserveUnits },
    iskMinus(upkept.affordable.isk, replenish.cost)) };
    const mining = planMining(rest, funded, params, ledger);
    const jobParams = austerityParams(params, proj);
    const fees = createFeeLedger(proj, war ? war.productionCap : null);
    const prio = minerPriorityOf(rest, jobParams, mining);
    const ladder = ladderPlanOf(rest, jobParams);
    let ladderProduce = null;
    let ladderReserve = ladder.reserve;
    let ladderNotes = ladder.notes;
    const reach = ladder.cls && jobParams.production.ladderOverRoomEnabled === true
      ? ladderFeeReachOf(proj, war, ladder.cls, params.treasury) : null;
    const unreachable = () => {
      ladderProduce = null;
      ladderReserve = null;
      ladderNotes = [...ladderNotes.filter((n) => !n.startsWith("LADDER_PRODUCE:")
        && !n.startsWith("LADDER_SAVING:")), `LADDER_FEE_UNREACHABLE:${ladder.cls}`];
    };
    if (reach === "UNREACHABLE" && (ladder.produce || ladder.reserve)) unreachable();
    else if (reach === "BALANCE" && ladder.produce) {
      const over = fees.capOverRoom({ intents: [ladder.produce], notes: [] });
      if (over.intents.length > 0) {
        ladderProduce = over.intents[0];
        ladderNotes = [...ladderNotes, ...over.notes];
      } else unreachable();
    } else if (ladder.produce) {
      const capped = fees.cap({ intents: [ladder.produce], notes: [] });
      if (capped.intents.length > 0) ladderProduce = capped.intents[0];
      else {
        ladderReserve = ladderReserveOf(rest.production, ladder.stationId, ladder.cls);
        ladderNotes = ladderNotes.filter((n) => !n.startsWith("LADDER_PRODUCE:"));
      }
      ladderNotes = [...ladderNotes, ...capped.notes];
    }
    const lrest = ladderProduce || ladderReserve
      ? { ...rest, production: applyLadder(rest.production, ladderProduce, ladderReserve) } : rest;
    const lp = ladderProduce ? { ...jobParams, production: { ...jobParams.production,
      maxJobsPerReview: jobParams.production.maxJobsPerReview - 1,
      maxActiveJobsPerFaction: jobParams.production.maxActiveJobsPerFaction - 1 } } : jobParams;
    const ladderIntents = ladderProduce ? [ladderProduce] : [];
    const slotOpts = ladderProduce ? { slotBase: 1 } : undefined;
    let production;
    let industry;
    let produced;
    const priority = { notes: [] };
    let industryBlocked = null;
    if (!prio.on) {
      production = fees.cap(planProduction(lrest, funded, lp, slotOpts));
      const plannedIndustry = planIndustry(lrest, lp, production, mining, slotOpts);
      industryBlocked = plannedIndustry.blocked || null;
      industry = fees.cap(plannedIndustry);
      produced = { intents: [...ladderIntents, ...production.intents, ...industry.intents],
        ...(ladderReserve ? { reserve: [ladderReserve] } : {}) };
    } else {
      const planned = planIndustry(lrest, lp, null, mining, slotOpts);
      industryBlocked = planned.blocked || null;
      industry = fees.cap(planned);
      const r = reserveForIndustry(lrest.production, industry.intents, planned.blocked || null,
        jobParams.production.minerReserveRuns);
      production = fees.cap(planProduction({ ...lrest, production: r.production }, funded, lp,
        { slotBase: ladderIntents.length + planned.intents.length }));
      produced = { intents: [...ladderIntents, ...industry.intents, ...production.intents],
        reserve: ladderReserve ? [...r.reserve, ladderReserve] : r.reserve };
      priority.notes.push("INDUSTRY_PRIORITY");
      if (r.reserve.length > 0) priority.notes.push(`INDUSTRY_RESERVE:${planned.blocked.hullGroup}`);
    }
    const swaps = params.mineralSwap && jobParams.production
      ? planMineralSwap(lrest, { intents: [...production.intents, ...industry.intents],
        ladderStationId: ladderReserve ? ladderReserve.stationId : null }, industryBlocked,
        production.notes, params.mineralSwap,
        jobParams.production.maxJobsPerReview - ladderIntents.length - production.intents.length)
      : { intents: [], notes: [] };
    const afterMining = { ...funded, affordable: withIsk({ resourceUnits: funded.affordable.resourceUnits
      - mining.cost.resourceUnits, reserveUnits: funded.affordable.reserveUnits - mining.cost.reserveUnits },
    iskMinus(funded.affordable.isk, { isk: fees.used() + ((mining.cost && mining.cost.isk) || 0) })) };
    const logistics = planLogistics(rest, afterMining, params, produced, ledger, replenish);
    const trade = planTrade(rest, params, produced, logistics);
    const left = { ...afterMining, affordable: withIsk({ resourceUnits: afterMining.affordable.resourceUnits
      - logistics.cost.resourceUnits, reserveUnits: afterMining.affordable.reserveUnits - logistics.cost.reserveUnits },
    iskMinus(afterMining.affordable.isk, logistics.cost)) };
    const next = chooseNextOperation(rest, left, params, rng, ledger);
    const spent = next.intents.flatMap((i) => (i.type === "MOBILIZE" ? [i] : i.type === "LAUNCH" ? i.mobilize : []));
    const nextIsk = warIskOf(next.intents);
    const afterNext = withIsk({ resourceUnits: Math.max(0, left.affordable.resourceUnits
      - spent.reduce((s, m) => s + m.cost.resourceUnits, 0)),
    reserveUnits: Math.max(0, left.affordable.reserveUnits - spent.reduce((s, m) => s + m.cost.reserveUnits, 0)) },
    iskMinus(left.affordable.isk, { isk: nextIsk }));
    const reactive = [...relief.intents, ...defense.intents].filter((i) => i.type === "LAUNCH" && i.target);
    const dispatched = new Map(reactive.flatMap((i) => i.fleets.map((x) => [x.fleetId, i.target.systemId])));
    const garrison = planGarrisonReinforce({ snapshot: rest, supply: left, params, ledger, budget: afterNext, dispatched,
      slots: { operations: params.maxOperationsPerReview - next.intents.filter((i) => i.type === "LAUNCH").length,
        mobilizations: params.maxMobilizationsPerReview - spent.length } });
    const reinforced = garrison.intents.flatMap((i) => i.mobilize);
    const fleetsOf = (i) => (i.type === "LAUNCH" ? i.fleets.map((x) => x.fleetId) : i.type === "MOBILIZE" ? [i.fleetId] : []);
    const launchTargets = (list) => new Set(list.filter((i) => i.type === "LAUNCH" && i.target)
      .map((i) => i.target.systemId));
    const invader = planInvaderCounter(rest, params,
      new Set([...next.intents, ...garrison.intents, ...reactive].flatMap(fleetsOf)),
      Math.max(0, params.maxOperationsPerReview
        - [...next.intents, ...garrison.intents].filter((i) => i.type === "LAUNCH").length),
      { targets: launchTargets([...next.intents, ...garrison.intents, ...reactive]) });
    const bossResponse = planBossResponse(rest, params,
      new Set([...next.intents, ...garrison.intents, ...invader.intents, ...reactive].flatMap(fleetsOf)),
      Math.max(0, params.maxOperationsPerReview
        - [...next.intents, ...garrison.intents, ...invader.intents].filter((i) => i.type === "LAUNCH").length),
      { targets: launchTargets([...next.intents, ...garrison.intents, ...invader.intents, ...reactive]) });
    const counter = bossResponse.intents.length === 0 && bossResponse.notes.length === 0 ? invader
      : { intents: [...invader.intents, ...bossResponse.intents], notes: [...invader.notes, ...bossResponse.notes],
        fleetIds: [...invader.fleetIds, ...bossResponse.fleetIds] };
    const structureAssault = planStructureAssault(rest, params,
      new Set([...next.intents, ...garrison.intents, ...counter.intents, ...reactive].flatMap(fleetsOf)),
      Math.max(0, params.maxOperationsPerReview
        - [...next.intents, ...garrison.intents, ...counter.intents].filter((i) => i.type === "LAUNCH").length),
      { targets: launchTargets([...next.intents, ...garrison.intents, ...counter.intents, ...reactive]) });
    const preHarvest = [...next.intents, ...garrison.intents, ...counter.intents, ...structureAssault.intents];
    const harvest = planHarvestRaid(rest, params, new Set([...preHarvest, ...reactive].flatMap(fleetsOf)),
      Math.max(0, params.maxOperationsPerReview - preHarvest.filter((i) => i.type === "LAUNCH").length),
      { targets: launchTargets([...preHarvest, ...reactive]) });
    const assault = { intents: [...structureAssault.intents, ...harvest.intents],
      notes: [...structureAssault.notes, ...harvest.notes],
      fleetIds: [...structureAssault.fleetIds, ...harvest.fleetIds] };
    const offensiveFleets = new Set([...next.intents, ...garrison.intents, ...counter.intents, ...assault.intents]
      .flatMap(fleetsOf));
    const raidRoom = Math.max(0, params.maxOperationsPerReview
      - [...next.intents, ...garrison.intents, ...counter.intents, ...assault.intents]
        .filter((i) => i.type === "LAUNCH").length);
    const pursuit = planCapsuleerPursuit(rest, left, params, offensiveFleets, raidRoom,
      { targets: launchTargets([...next.intents, ...garrison.intents, ...counter.intents, ...assault.intents,
        ...reactive]) });
    const raids = planMinerRaids(rest, left, params, offensiveFleets, Math.max(0, raidRoom - pursuit.intents.length),
      { targets: launchTargets([...next.intents, ...garrison.intents, ...counter.intents, ...assault.intents,
        ...pursuit.intents, ...reactive]) });
    const afterGarrison = withIsk({ resourceUnits: afterNext.resourceUnits - garrison.cost.resourceUnits,
      reserveUnits: afterNext.reserveUnits - garrison.cost.reserveUnits }, iskMinus(afterNext.isk, garrison.cost));
    const brood = planHiveBrood({ snapshot: rest, params, budget: afterGarrison, mobilized: spent.length,
      slots: { mobilizations: params.maxMobilizationsPerReview - spent.length - reinforced.length } });
    const pool = planInvaderHomePool({ snapshot: rest, E: params.invaderEconomy || null, params,
      budget: { resourceUnits: afterGarrison.resourceUnits - brood.cost.resourceUnits,
        reserveUnits: afterGarrison.reserveUnits - brood.cost.reserveUnits },
      slots: { mobilizations: params.maxMobilizationsPerReview - spent.length - reinforced.length
        - brood.intents.length } });
    const swarm = planHiveSwarm({ snapshot: rest, supply: left, params,
      budget: { resourceUnits: afterGarrison.resourceUnits - brood.cost.resourceUnits - pool.cost.resourceUnits,
        reserveUnits: afterGarrison.reserveUnits - brood.cost.reserveUnits - pool.cost.reserveUnits },
      slots: { operations: params.maxOperationsPerReview - [...next.intents, ...garrison.intents, ...counter.intents,
        ...assault.intents, ...pursuit.intents, ...raids.intents].filter((i) => i.type === "LAUNCH").length,
      mobilizations: params.maxMobilizationsPerReview - spent.length - reinforced.length - brood.intents.length
        - pool.intents.length } });
    const construction = planConstruction(rest, upkept, params);
    const sentries = planSentries(snapshot, params,
      { stationBuilds: construction.intents.filter((i) => i.type === "BUILD_PLAN").length });
    const huntBudget = withIsk({ resourceUnits: afterGarrison.resourceUnits - brood.cost.resourceUnits
      - pool.cost.resourceUnits - swarm.cost.resourceUnits, reserveUnits: afterGarrison.reserveUnits
      - brood.cost.reserveUnits - pool.cost.reserveUnits - swarm.cost.reserveUnits },
    iskMinus(afterGarrison.isk, brood.cost));
    const hunts = snapshot.huntReady === true ? planHunts({ snapshot: rest, params, budget: huntBudget, ledger, war })
      : { intents: [], notes: [], cost: { resourceUnits: 0, reserveUnits: 0 } };
    const preLaunch = [...next.intents, ...garrison.intents, ...counter.intents, ...assault.intents, ...pursuit.intents,
      ...raids.intents, ...swarm.intents, ...hunts.intents];
    const postUsed = new Set(preLaunch.flatMap((i) => (i.type === "LAUNCH" ? i.fleets.map((x) => x.fleetId)
      : i.type === "MOBILIZE" ? [i.fleetId] : [])));
    const postRoom = Math.max(0, params.maxOperationsPerReview
      - preLaunch.filter((i) => i.type === "LAUNCH").length);
    const posts = planBorderPosts(rest, left, params, postUsed, postRoom,
      { targets: new Set([...preLaunch, ...reactive].filter((i) => i.type === "LAUNCH" && i.target)
        .map((i) => i.target.systemId)) });
    const postLaunches = posts.intents.filter((i) => i.type === "LAUNCH");
    const escorts = planMinerEscorts(rest, left, params, postUsed, Math.max(0, postRoom - postLaunches.length),
      { targets: new Set([...preLaunch, ...reactive, ...posts.intents].filter((i) => i.type === "LAUNCH" && i.target)
        .map((i) => i.target.systemId)), busy: postLaunches.reduce((s, i) => s + i.fleets.length, 0) });
    const wts = deferSells(trade, [...spent, ...reinforced, ...hunts.intents.flatMap((i) => (i.type === "MOBILIZE" ? [i]
      : i.type === "LAUNCH" && Array.isArray(i.mobilize) ? i.mobilize : []))]);
    const used = new Set(next.intents
      .filter((i) => i.type === "LAUNCH").flatMap((i) => i.fleets.map((f) => f.fleetId))
      .concat(next.intents.filter((i) => i.type === "MOBILIZE").map((i) => i.fleetId))
      .concat(hunts.intents.filter((i) => i.type === "LAUNCH").flatMap((i) => i.fleets.map((f) => f.fleetId)))
      .concat(garrison.intents.filter((i) => i.type === "LAUNCH").flatMap((i) => i.fleets.map((f) => f.fleetId)))
      .concat(counter.intents.flatMap((i) => i.fleets.map((f) => f.fleetId)))
      .concat(assault.intents.flatMap((i) => i.fleets.map((f) => f.fleetId)))
      .concat(pursuit.intents.flatMap((i) => i.fleets.map((f) => f.fleetId)))
      .concat(raids.intents.flatMap((i) => i.fleets.map((f) => f.fleetId)))
      .concat(swarm.intents.flatMap((i) => i.fleets.map((f) => f.fleetId)))
      .concat(posts.intents.flatMap((i) => i.fleets.map((f) => f.fleetId)))
      .concat(escorts.intents.flatMap((i) => i.fleets.map((f) => f.fleetId))));
    const returns = planReturns(rest, upkept, params, used);
    for (const i of logistics.intents) if (i.type === "CONVOY_DISPATCH") used.add(i.fleetId);
    const retire = planLogisticsRetire(rest, upkept, params, used);
    for (const i of hk.intents) if (i.type === "REQUEST_REFIT") used.add(i.fleetId);
    const replenishReturns = planReplenishReturns(rest, params, ledger, used);
    const release = planGarrisonRelease({ snapshot: rest, params, used, dispatched,
      combatRoom: Math.max(0, (params.maxFleetsPerFaction || 0) - liveCombatFleets(rest.fleets) - spent.length) });
    const patrolOpts = { targets: new Set([...next.intents, ...garrison.intents, ...counter.intents, ...assault.intents,
      ...pursuit.intents,
      ...raids.intents,
      ...swarm.intents,
      ...hunts.intents,
      ...posts.intents, ...escorts.intents, ...reactive]
      .filter((i) => i.type === "LAUNCH" && i.target).map((i) => i.target.systemId)),
    dispatched };
    const hqRoom = Math.max(0, (params.maxReturnsPerReview || 0) - returns.intents.length);
    const hqReturn = planHqReturn(rest, params, used, hqRoom);
    const patrols = planPatrols(rest, upkept, params, used,
      Math.max(0, hqRoom - hqReturn.intents.length), patrolOpts);
    const merges = planMerges(rest, params, used);
    const stranded = planStrandedFleets(rest, upkept, params, used);
    const demobilize = planDeficitRelief(rest, upkept, params, upkeep.relief, used);

    const treasury = planTreasury(snapshot, params,
      { produce: ladderIntents.length + production.intents.length + industry.intents.length,
        war: war ? nextIsk + warIskOf(garrison.intents) + warIskOf(hunts.intents) : 0,
        roomLeft: war ? iskMinus(huntBudget.isk, hunts.cost) : null });
    const brakeNote = upkeep.unpaidPeriods > 0 ? "UPKEEP_UNPAID" : "UPKEEP_RESERVE";
    const nextNotes = brake ? next.notes.map((n) => (n === "FRONT_LIMIT" ? brakeNote : n)) : next.notes;
    return { ...base, outcome: "REVIEWED", reason: null, supply: supplySummary(upkept),
      target: next.targets.length > 0 ? next.targets[0] : null,
      defenseTargets: defense.targets,
      lostHomeCursorNext: snapshot.lostHome && snapshot.lostHome.nextAfterSystemId,
      trimCursor: trim.cursor,
      ...(ladder.on === true ? { ladderDiag: ladderDiagOf(ladder, ladderNotes) } : {}),
      ...(params.minerRaid ? { minerRaidsSeen: raids.seen } : {}),
      ...(params.invaderEconomy ? { invaderYield: yieldOf(open, params.invaderEconomy) } : {}),
      ...(params.capsuleerPursuit ? { capsuleerPursuitsSeen: pursuit.seen } : {}),
      ...(Number.isSafeInteger(raids.tooStrong) ? { minerRaidTooStrong: raids.tooStrong } : {}),
      ...(Number.isSafeInteger(raids.reordered) ? { minerRaidReordered: raids.reordered } : {}),
      notes: [...trim.notes, ...upkeep.notes, ...relabelNoStock(replenish.notes, params), ...holdNotes, ...relief.notes, ...defense.notes, ...upgrades.notes, ...mining.notes,
        ...ladderNotes, ...production.notes, ...industry.notes, ...swaps.notes, ...priority.notes, ...logistics.notes, ...wts.notes, ...nextNotes, ...garrison.notes,
        ...counter.notes, ...assault.notes, ...pursuit.notes, ...raids.notes, ...brood.notes, ...pool.notes, ...swarm.notes, ...construction.notes, ...sentries.notes, ...hunts.notes, ...posts.notes, ...escorts.notes,
        ...returns.notes,
        ...retire.notes,
        ...replenishReturns.notes,
        ...release.notes.filter((n) => !garrison.notes.includes(n)), ...hqReturn.notes, ...patrols.notes, ...merges.notes,
        ...stranded.notes, ...demobilize.notes,
        ...treasury.notes],
      stuck: hk.stuck,
      hullPolicy: ledger.policy, upkeep: upkeep.rates ? { ...upkeep.rates, round: snapshot.round,
        unpaidPeriods: upkeep.unpaidPeriods, offensiveAllowed: upkeep.offensiveAllowed,
        ...(upkeep.shipRoom === undefined ? {} : { shipRoom: upkeep.shipRoom }) } : null,
      ...(war ? { warChest: { dayBudget: war.dayBudget, room: war.room, spentToday: war.spentToday,
        ...(war.spentWindow !== undefined ? { spentWindow: war.spentWindow } : {}) } } : {}),
      intents: [...hk.intents, ...upkeep.intents, ...replenish.intents, ...relief.intents, ...defense.intents, ...upgrades.intents,
        ...mining.intents, ...produced.intents, ...swaps.intents, ...logistics.intents,
        ...wts.intents, ...next.intents, ...garrison.intents, ...counter.intents, ...assault.intents, ...pursuit.intents, ...raids.intents, ...brood.intents, ...pool.intents, ...swarm.intents, ...construction.intents, ...sentries.intents, ...hunts.intents, ...posts.intents,
        ...escorts.intents, ...wts.sells, ...returns.intents,
        ...retire.intents, ...replenishReturns.intents, ...release.intents, ...hqReturn.intents, ...patrols.intents,
        ...merges.intents, ...stranded.intents, ...demobilize.intents,
        ...treasury.intents, touch] };
  } catch (err) {
    return { ...base, ...threw(err), supply: null, target: null, notes: [], stuck: 0, intents: [] };
  }
}

const REACTIVE_KINDS = new Set(["defense", "intercept_post"]);
const REACTIVE_CAPPED = "REACTIVE_CAPPED";

function decideReactive(snapshot, params) {
  const base = { v: DECISION_VERSION, factionId: snapshot && snapshot.factionId, round: snapshot && snapshot.round };
  try {
    const pseudo = new Map();
    markSiegeFleets(snapshot, params, pseudo);
    markDefenseFleets(snapshot, params, pseudo);
    markClaimHolders(snapshot, params, pseudo);
    const guard = defensePseudo(snapshot, pseudo);
    const holders = freedHolders(pseudo, guard);
    const relief = planRelief(withPseudo(snapshot, guard), null, params, { holders });
    for (const id of relief.fleetIds) guard.set(id, RELIEVING);
    const defense = planDefense(withPseudo(snapshot, guard), null, params,
      { targets: new Set(relief.intents.map((i) => i.target.systemId)), holders });
    const r = snapshot.reactive && Number.isSafeInteger(snapshot.reactive.room) ? snapshot.reactive.room : 0;
    const room = Math.max(0, r);
    const used = new Set([...relief.intents, ...defense.intents]
      .flatMap((i) => (i.fleets || []).map((x) => x.fleetId)));
    const intercepts = planIntercepts(withPseudo(snapshot, guard), params, used,
      Math.max(0, room - (relief.intents.length + defense.intents.length)));
    const all = [...relief.intents, ...defense.intents, ...intercepts.intents];
    const intents = all.slice(0, room);
    if (intents.some((i) => i.type !== "LAUNCH" || !REACTIVE_KINDS.has(i.kind) || !Array.isArray(i.mobilize)
      || i.mobilize.length !== 0)) {
      return { ...base, outcome: "SKIPPED", reason: "REACTIVE_INTENT_FORBIDDEN", notes: [], intents: [] };
    }
    return { ...base, outcome: intents.length > 0 ? "REACTED" : "IDLE", reason: null,
      notes: [...relief.notes, ...defense.notes, ...intercepts.notes, ...(all.length > room ? [REACTIVE_CAPPED] : [])],
      intents };
  } catch (err) {
    return { ...base, ...threw(err), notes: [], intents: [] };
  }
}

function reactiveCanAct(threatCount, siege, incomingCount = 0) {
  if (threatCount > 0 || incomingCount > 0) return true;
  return Boolean(siege && siege.mode === SIEGE_READY && Array.isArray(siege.defending) && siege.defending.length > 0);
}

function idleReactive(factionId, round) {
  return { v: DECISION_VERSION, factionId, round, outcome: "IDLE", reason: null, notes: [], intents: [] };
}

module.exports = { decideReview, decideReactive, reactiveCanAct, idleReactive, DECISION_VERSION, DECIDE_THREW };
