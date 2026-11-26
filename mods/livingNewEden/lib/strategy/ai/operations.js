"use strict";

const { bfs } = require("./bfs");
const { strengthOf } = require("./strength");
const { stagingOf, stationCandidates } = require("./mobilize");
const { fitIskOf } = require("./warChest");
const { gateOn, cooledOf, lossesOf, raisedRequired, launchValueIsk, expectedLossIsk } = require("./attackLossGate");
const { gateOn: transitGateOn, riskOf, skippedByRisk, raisedByRisk,
  operationShipCountOf } = require("./transitRiskGate");
const { planCapitalAttach, eligibleClassesOf, byItemKey } = require("./capitalAttach");
const { planCapitalEscort, escortDistOf, CAPITAL_ESCORT_NOTE } = require("./capitalEscort");
const { escalationLevelOf, templateLadderWithDropsOf } = require("./escalation");
const { chooseTargetSystem, usableKinds, effectiveIntel, describe, attackKind, captureOnlyOf, captureBlock, isFresh,
  ttlOf } = require("./targeting");

const IDLE = "IDLE";
const MINING_ROLE = "mining";
const LOGISTICS_ROLE = "logistics";
const HUNTER_ROLE = "hunter";
const GARRISON_ROLE = "garrison";
const ACTIVE = "ACTIVE";
const SCOUT_ROLE = "scout";
const RAID_OPERATION_TYPE = "raid";
const PERMILLE = 1000;
const LIMIT_NOTES = new Set(["MOBILIZE_LIMIT", "FLEET_LIMIT", "SCOUT_LIMIT"]);
const CAPITAL_NOT_AT_STATION = "CAPITAL_NOT_AT_STATION";

function capitalStationsFirst(list, lg, classes) {
  if (classes === null) return list;
  const holds = (st) => classes.some((cls) => lg.available(st.stationId, cls) >= 1);
  return [...list.filter(holds), ...list.filter((st) => !holds(st))];
}

function liveCombatFleets(fleets) {
  return fleets.filter((f) => f.fleetRole !== MINING_ROLE && f.fleetRole !== LOGISTICS_ROLE
    && f.fleetRole !== HUNTER_ROLE && f.fleetRole !== GARRISON_ROLE).length;
}

function chooseNextOperation(snapshot, supply, params, rng, ledger) {
  const intents = [];
  const notes = [];
  const targets = [];
  const fronts = new Set(supply.frontTargets);
  const war = supply.war || null;
  const budget = { resourceUnits: supply.affordable.resourceUnits, reserveUnits: supply.affordable.reserveUnits,
    isk: war && Number.isSafeInteger(supply.affordable.isk) ? supply.affordable.isk : null };
  const used = new Set();
  const kinds = usableKinds(snapshot, params);
  const scouting = kinds.find((k) => k.offensive === true && k.needsIntel !== true) || null;
  const intelMap = effectiveIntel(snapshot);
  const baseOk = snapshot.faction.status === ACTIVE && snapshot.faction.homeSystemId !== null
    && snapshot.operationsTruncated !== true;
  const scoutsApart = params.reconUnblockEnabled === true;
  const scoutsOf = (list) => list.filter((f) => f.fleetRole === SCOUT_ROLE).length;
  let liveScouts = scoutsApart ? scoutsOf(snapshot.fleets) : 0;
  let liveFleets = liveCombatFleets(snapshot.fleets) - liveScouts;
  const scoutBudget = supply.scoutAffordable ? { resourceUnits: supply.scoutAffordable.resourceUnits,
    reserveUnits: supply.scoutAffordable.reserveUnits } : null;
  let scoutPoolNoted = false;
  const raidCap = params.raidFrontLimitEnabled === true ? params.maxRaidFronts : null;
  const raidFronts = new Set(supply.raidFrontTargets || []);
  const raidFull = () => raidCap !== null && raidFronts.size >= raidCap;
  let raidLimitNoted = false;
  function noteRaidLimit() {
    if (!raidLimitNoted) notes.push("RAID_FRONT_LIMIT");
    raidLimitNoted = true;
  }
  const fleetCap = snapshot.doctrine.hive === true && params.hive
    ? Math.min(params.maxFleetsPerFaction, params.hive.maxFleets) : params.maxFleetsPerFaction;
  let mobilized = 0;
  let slot = 0;
  let room = supply.captureRoom;
  const farCache = new Map();
  function farOf(target) {
    if (!farCache.has(target)) {
      farCache.set(target, bfs([target], snapshot.neighbors, { maxJumps: params.mobilizeFallbackJumps,
        maxSystems: params.mobilizeFallbackMaxSystems }));
    }
    return farCache.get(target);
  }

  function preferClassesOf(template, role, opts) {
    const A = params.capitalAttach;
    if (!A || A.preferStation !== true || !Array.isArray(A.roles) || !A.roles.includes(role)
      || !(Number.isSafeInteger(A.max) && A.max >= 1)) return null;
    const classes = eligibleClassesOf({ template, capitalClasses: snapshot.capitalClasses, attach: A,
      level: opts && Number.isSafeInteger(opts.capitalLevel) ? opts.capitalLevel : 0 });
    return classes.length > 0 ? classes : null;
  }
  const escortCache = new Map();
  let escortNoted = false;
  const escortMissNoted = new Set();

  function fallbackOn(role) {
    return Boolean(ledger) && ledger.needs(role) && params.mobilizeFallbackJumps > params.maxAssemblyJumps
      && typeof snapshot.neighbors === "function";
  }

  function mobilize(role, distT, target, opts) {
    const lg = (opts && opts.lg) || ledger;
    const allowFar = !opts || opts.allowFar !== false;
    let far = false;
    const template = opts && opts.template !== undefined ? opts.template : snapshot.doctrine.templates[role];
    const step = opts && Number.isSafeInteger(opts.escalation) && opts.escalation > 0 ? opts.escalation : 0;
    if (!Array.isArray(template) || template.length === 0) return { note: "NO_TEMPLATE" };
    if (mobilized >= params.maxMobilizationsPerReview) return { note: "MOBILIZE_LIMIT" };
    if (scoutsApart && role === SCOUT_ROLE) {
      if (liveScouts >= params.maxScoutsPerFaction) return { note: "SCOUT_LIMIT" };
    } else if (liveFleets >= fleetCap) return { note: "FLEET_LIMIT" };
    const ships = template.reduce((s, e) => s + e.count, 0);
    const cost = { resourceUnits: ships * params.mobilizeResourcePerShip,
      reserveUnits: ships * params.mobilizeReservePerShip };
    let fromScout = false;
    if (cost.resourceUnits > budget.resourceUnits || cost.reserveUnits > budget.reserveUnits) {
      if (!(scoutsApart && role === SCOUT_ROLE && scoutBudget && cost.resourceUnits <= scoutBudget.resourceUnits
        && cost.reserveUnits <= scoutBudget.reserveUnits)) return { note: "INSUFFICIENT_RESOURCES" };
      fromScout = true;
    }
    const fit = budget.isk !== null ? fitIskOf(template, war.valueByGroup, war.fitPermille) : 0;
    if (budget.isk !== null && fit > budget.isk) return { note: "WAR_CHEST_SHORT" };
    let systemId;
    let stationId = null;
    let hulls = [];
    let cap = null;
    if (ledger && ledger.needs(role)) {
      const prefer = preferClassesOf(template, role, opts);
      const candidates = capitalStationsFirst(stationCandidates(snapshot, distT, target), lg, prefer);
      const inProduction = (snapshot.production && snapshot.production.inProduction) || {};
      let result = lg.pickWithNote(template, candidates, inProduction);
      if (!result.picked && allowFar && fallbackOn(role)) {
        const others = (snapshot.stations || []).filter((x) => x.systemId !== target);
        if (lg.pick(template, others)) {
          const farDist = farOf(target);
          const farList = capitalStationsFirst(others.filter((x) => farDist.has(x.systemId))
            .sort((a, b) => farDist.get(a.systemId) - farDist.get(b.systemId) || a.systemId - b.systemId
              || (a.stationId < b.stationId ? -1 : a.stationId > b.stationId ? 1 : 0)), lg, prefer);
          const picked = lg.pick(template, farList);
          if (picked) {
            far = true;
            result = { picked, note: null };
          }
        }
      }
      if (!result.picked) return { note: result.note };
      lg.take(result.picked.stationId, result.picked.hulls);
      ({ systemId, stationId, hulls } = result.picked);
      if (params.capitalAttach) {
        cap = planCapitalAttach({ template, role, stationId, lg, capitalClasses: snapshot.capitalClasses,
          attach: params.capitalAttach, iskLeft: budget.isk !== null ? budget.isk - fit : null, war,
          level: opts && Number.isSafeInteger(opts.capitalLevel) ? opts.capitalLevel : 0 });
        if (cap.items.length > 0) {
          lg.take(stationId, cap.items);
          hulls = [...hulls, ...cap.items].sort(byItemKey);
        }
      }
    } else {
      systemId = stagingOf(snapshot, supply, distT, target);
      if (systemId === null) return { note: "NO_STAGING" };
    }
    const capFit = cap ? cap.fitIsk : 0;
    const pay = fromScout ? scoutBudget : budget;
    pay.resourceUnits -= cost.resourceUnits;
    pay.reserveUnits -= cost.reserveUnits;
    if (fromScout && !scoutPoolNoted) notes.push("UPKEEP_SHIP_CAP_SCOUT");
    if (fromScout) scoutPoolNoted = true;
    if (budget.isk !== null) budget.isk -= fit + capFit;
    mobilized += 1;
    if (scoutsApart && role === SCOUT_ROLE) liveScouts += 1;
    else liveFleets += 1;
    const composition = template.map((e) => ({ hullGroup: e.hullGroup, typeId: null, count: e.count }));
    if (cap) for (const e of cap.entries) composition.push({ ...e });
    const intent = { type: "MOBILIZE", slot: slot++, role, systemId, homeSystemId: systemId, composition, cost,
      stationId, hulls, ...(budget.isk !== null ? { warIsk: fit + capFit } : {}),
      ...(step > 0 ? { escalation: step } : {}), ...(cap && cap.gated === true ? { capitalGated: true } : {}) };
    return { intent, strength: strengthOf(composition, params.powerTable), far,
      ...(cap && cap.note ? { capitalNote: cap.note } : {}) };
  }

  function mobilizeLadder(kind, level, distT, target, opts) {
    if (!params.escalation) return mobilize(kind.mobilizeRole, distT, target, opts);
    const targetLevel = Number.isSafeInteger(level) && level > 0 ? level : 0;
    const leveled = (m) => {
      if (m.intent) m.intent.escalationLevel = targetLevel;
      return m;
    };
    if (!(level > 0)) return leveled(mobilize(kind.mobilizeRole, distT, target, opts));
    const { ladder, dropped } = templateLadderWithDropsOf(snapshot.doctrine, kind.mobilizeRole, params.powerTable);
    const marked = (m) => {
      leveled(m);
      if (m.intent && dropped > 0) m.ladderDropped = dropped;
      return m;
    };
    const top = Math.min(level, ladder.length - 1);
    if (top <= 0) return marked(mobilize(kind.mobilizeRole, distT, target, { ...opts, capitalLevel: level }));
    let m = null;
    for (let i = top; i >= 0; i -= 1) {
      m = mobilize(ladder[i].role, distT, target, { ...opts, template: ladder[i].template, escalation: i,
        capitalLevel: level });
      if (m.intent) {
        if (i < top) m.intent.escalationFallback = true;
        return marked(m);
      }
      if (LIMIT_NOTES.has(m.note)) return m;
    }
    return m;
  }

  const escalationNoted = new Set();
  function noteEscalation(m) {
    if (m.ladderDropped > 0 && !escalationNoted.has("ESCALATION_STEP_DROPPED")) {
      notes.push("ESCALATION_STEP_DROPPED");
      escalationNoted.add("ESCALATION_STEP_DROPPED");
    }
    const n = m.intent.escalation;
    if (Number.isSafeInteger(n) && n > 0) {
      const escalationNote = n >= 3 ? "ESCALATION_L3" : n === 2 ? "ESCALATION_L2" : "ESCALATION_L1";
      if (!escalationNoted.has(escalationNote)) notes.push(escalationNote);
      escalationNoted.add(escalationNote);
    }
    if (m.intent.escalationFallback === true && !escalationNoted.has("ESCALATION_FALLBACK")) {
      notes.push("ESCALATION_FALLBACK");
      escalationNoted.add("ESCALATION_FALLBACK");
    }
  }

  const capitalNoted = new Set();
  function noteCapital(m) {
    if (!m.capitalNote || capitalNoted.has(m.capitalNote)) return;
    capitalNoted.add(m.capitalNote);
    notes.push(m.capitalNote);
  }

  function launch(kind, target, chosen, mobs, windowFactor = 1, warIsk = null) {
    const first = chosen.length > 0 ? chosen[0].systemId : mobs[0].systemId;
    intents.push({ type: "LAUNCH", slot: slot++, kind: kind.kind, target: { kind: "system", systemId: target, ref: null },
      originSystemId: first, fleets: chosen.map((f) => ({ fleetId: f.fleetId, expectedVersion: f.version })),
      mobilize: mobs, dueAt: snapshot.at + Math.round(params[kind.windowKey] * windowFactor),
      ...(warIsk !== null ? { warIsk } : {}) });
    for (const f of chosen) used.add(f.fleetId);
    if (kind.opensFront === true) fronts.add(target);
    if (kind.operationType === RAID_OPERATION_TYPE) raidFronts.add(target);
    if (kind.captures === true && snapshot.playerSov instanceof Map && snapshot.playerSov.has(target)) {
      playerSovLaunched.add(target);
    }
  }

  let territoryLimitNoted = false;
  let captureNotAdjacentNoted = false;
  const skip = new Set();
  let reconOnSiteNoted = false;
  const forceNoted = new Set();
  const cooled = new Set((snapshot.reconCooldowns || []).filter((id) =>
    !isFresh(intelMap.get(id), snapshot.at, ttlOf(intelMap.get(id), params))));
  if (cooled.size > 0) notes.push("RECON_COOLDOWN");
  const attackGate = gateOn(snapshot, params);
  const lossCooled = attackGate ? cooledOf(snapshot) : new Set();
  if (lossCooled.size > 0) notes.push("ATTACK_LOSS_COOLDOWN");
  let requiredRaisedNoted = false;
  const transitGate = transitGateOn(snapshot, params);
  const playerSovNotes = new Set();
  const playerSovNoted = new Set();
  const playerSovLaunched = new Set();

  for (let n = 0; n < params.maxOperationsPerReview; n += 1) {
    const frontLimit = supply.frontLimit;
    if (!baseOk || fronts.size >= frontLimit) {
      notes.push("FRONT_LIMIT");
      break;
    }
    const warCaptureShort = budget.isk !== null && budget.isk < war.captureIsk;
    const raidsFull = raidFull();
    if (raidsFull) noteRaidLimit();
    const picked = chooseTargetSystem(snapshot, { ...supply, frontTargets: [...fronts, ...skip, ...cooled, ...lossCooled],
      openFronts: [...fronts], captureRoom: room, ...(warCaptureShort ? { warCaptureShort } : {}),
      ...(raidsFull ? { raidFull: true } : {}), playerSovNotes, playerSovLaunched },
      params, rng);
    for (const code of playerSovNotes) {
      if (playerSovNoted.has(code)) continue;
      playerSovNoted.add(code);
      notes.push(code);
    }
    if (!picked.ok) {
      notes.push(`NO_TARGET:${picked.reason}`);
      if (warCaptureShort && !forceNoted.has("WAR_CHEST_SHORT")) notes.push("WAR_CHEST_SHORT");
      if (warCaptureShort) forceNoted.add("WAR_CHEST_SHORT");
      break;
    }
    const T = picked.systemId;
    targets.push({ systemId: T, score: picked.score, candidates: picked.candidates });
    const facts = describe(snapshot, params, intelMap, T);
    const distT = bfs([T], snapshot.neighbors, { maxJumps: params.maxAssemblyJumps, maxSystems: params.maxBfsSystems });
    const blocked = new Set();
    let kind = facts.fresh ? attackKind(kinds, { ...supply, captureRoom: room, warCaptureShort }, facts, T, { captureOnly: captureOnlyOf(snapshot, T), snapshot, params, blocked }) : scouting;
    if (blocked.has("TERRITORY_LIMIT")) {
      if (!territoryLimitNoted) notes.push("TERRITORY_LIMIT");
      territoryLimitNoted = true;
    } else if (blocked.has("CAPTURE_NOT_ADJACENT")) {
      if (!captureNotAdjacentNoted) notes.push("CAPTURE_NOT_ADJACENT");
      captureNotAdjacentNoted = true;
    } else if (blocked.has("WAR_CHEST_SHORT")) {
      if (!forceNoted.has("WAR_CHEST_SHORT")) notes.push("WAR_CHEST_SHORT");
      forceNoted.add("WAR_CHEST_SHORT");
    }
    if (!kind && blocked.size > 0 && facts.hostileController && facts.hive !== true) {
      kind = kinds.find((k) => k.offensive === true && k.needsIntel === true && k.captures !== true) || null;
    }
    if (facts.fresh && kind && kind.operationType === RAID_OPERATION_TYPE && raidFull()) {
      noteRaidLimit();
      skip.add(T);
      continue;
    }
    if (!kind) {
      notes.push(facts.fresh ? "NO_KIND" : "NO_INTEL");
      break;
    }
    const avail = snapshot.fleets.filter((f) => f.state === IDLE && f.refitPending !== true && f.systemId !== T
      && kind.fleetRoles.includes(f.fleetRole) && distT.has(f.systemId) && !used.has(f.fleetId))
      .sort((a, b) => distT.get(a.systemId) - distT.get(b.systemId) || (a.fleetId < b.fleetId ? -1 : 1));

    if (!facts.fresh) {
      if (snapshot.fleets.some((f) => f.state === IDLE && f.fleetRole === kind.mobilizeRole && f.systemId === T)) {
        if (!reconOnSiteNoted) notes.push("RECON_ON_SITE");
        reconOnSiteNoted = true;
        skip.add(T);
        continue;
      }
      if (avail.length > 0) {
        launch(kind, T, [avail[0]], []);
        continue;
      }
      const m = mobilize(kind.mobilizeRole, distT, T, { allowFar: true });
      if (!m.intent) {
        if (!scoutsApart) {
          notes.push(m.note);
          break;
        }
        if (!forceNoted.has(m.note)) notes.push(m.note);
        forceNoted.add(m.note);
        skip.add(T);
        continue;
      }
      if (m.far) notes.push("MOBILIZE_FAR");
      noteCapital(m);
      launch(kind, T, [], [m.intent]);
      continue;
    }

    let tRisk = null;
    if (transitGate) {
      const from = avail.length > 0 ? avail[0].systemId : snapshot.faction.homeSystemId;
      tRisk = riskOf(snapshot, from, T, { fleetRole: kind.mobilizeRole,
        shipCount: operationShipCountOf(snapshot.doctrine.templates[kind.mobilizeRole], params.transitRisk),
        operationType: kind.operationType });
      if (skippedByRisk(tRisk, params.transitRisk)) {
        if (!forceNoted.has("TRANSIT_RISK_SKIP")) notes.push("TRANSIT_RISK_SKIP");
        forceNoted.add("TRANSIT_RISK_SKIP");
        skip.add(T);
        continue;
      }
    }
    const baseRequired = Math.max(1, Math.ceil(facts.enemyStrength * params.attackStrengthRatio));
    const lossRequired = attackGate ? raisedRequired(baseRequired, lossesOf(snapshot, T), params.attackLoss)
      : baseRequired;
    if (lossRequired > baseRequired && !requiredRaisedNoted) {
      notes.push("ATTACK_LOSS_REQUIRED_RAISED");
      requiredRaisedNoted = true;
    }
    const required = transitGate ? raisedByRisk(lossRequired, tRisk, params.transitRisk) : lossRequired;
    if (required > lossRequired && !forceNoted.has("TRANSIT_RISK_RAISED")) {
      notes.push("TRANSIT_RISK_RAISED");
      forceNoted.add("TRANSIT_RISK_RAISED");
    }
    const level = params.escalation ? escalationLevelOf({ required: baseRequired,
      baseStrength: strengthOf(snapshot.doctrine.templates[kind.mobilizeRole] || [], params.powerTable),
      category: facts.category, hostileStations: facts.sys ? Number(facts.sys.hostileStations) || 0 : 0,
      playerSystem: snapshot.playerSov instanceof Map && snapshot.playerSov.has(T),
      losses: attackGate ? lossesOf(snapshot, T) : 0 }, params.escalation).level : 0;
    const chosen = [];
    let sum = 0;
    for (const f of avail) {
      if (sum >= required || chosen.length >= params.maxFleetsPerOperation) break;
      chosen.push(f);
      sum += f.strength;
    }
    if (params.attackLoss && params.attackLoss.iskGate && budget.isk !== null) {
      const tpl = snapshot.doctrine.templates[kind.mobilizeRole];
      const tplComp = Array.isArray(tpl) ? tpl : [];
      const tplStrength = strengthOf(tplComp, params.powerTable);
      const short = Math.max(0, required - sum);
      const nMob = short === 0 || tplStrength <= 0 ? 0
        : Math.max(0, Math.min(Math.ceil(short / tplStrength), params.maxFleetsPerOperation - chosen.length));
      const value = launchValueIsk([...chosen.map((f) => f.composition), ...Array(nMob).fill(tplComp)], war);
      const expected = expectedLossIsk(value, lossesOf(snapshot, T), params.attackLoss);
      const roomPermille = params.attackLoss.iskGate.maxRoomPermille;
      const lossRoom = Math.floor(budget.isk / PERMILLE) * roomPermille
        + Math.floor(((budget.isk % PERMILLE) * roomPermille) / PERMILLE);
      if (expected > lossRoom) {
        if (!forceNoted.has("ATTACK_LOSS_ISK_GATE")) notes.push("ATTACK_LOSS_ISK_GATE");
        forceNoted.add("ATTACK_LOSS_ISK_GATE");
        skip.add(T);
        continue;
      }
    }
    const reserve = budget.isk !== null && kind.captures === true && facts.category !== "home" ? war.captureIsk : null;
    if (reserve !== null) budget.isk -= reserve;
    const mobs = [];
    let lastNote = null;
    let notAtStation = false;
    while (sum < required && chosen.length + mobs.length < params.maxFleetsPerOperation) {
      const m = mobilizeLadder(kind, level, distT, T, { allowFar: false });
      if (!m.intent) {
        lastNote = m.note;
        break;
      }
      mobs.push(m.intent);
      if (m.capitalNote === CAPITAL_NOT_AT_STATION) notAtStation = true;
      noteCapital(m);
      noteEscalation(m);
      sum += m.strength;
    }
    if (sum < required && chosen.length + mobs.length < params.maxFleetsPerOperation
      && fallbackOn(kind.mobilizeRole)) {
      const saved = { resourceUnits: budget.resourceUnits, reserveUnits: budget.reserveUnits, isk: budget.isk, mobilized,
        liveFleets, liveScouts, slot, scout: scoutBudget ? { ...scoutBudget } : null };
      const trial = ledger.fork();
      const farMobs = [];
      let trialSum = 0;
      while (sum + trialSum < required
        && chosen.length + mobs.length + farMobs.length < params.maxFleetsPerOperation) {
        const m = mobilizeLadder(kind, level, distT, T, { lg: trial, allowFar: true });
        if (!m.intent) break;
        farMobs.push(m);
        trialSum += m.strength;
      }
      if (sum + trialSum >= required) {
        for (const m of farMobs) {
          ledger.take(m.intent.stationId, m.intent.hulls);
          mobs.push(m.intent);
          if (m.far) notes.push("MOBILIZE_FAR");
          if (m.capitalNote === CAPITAL_NOT_AT_STATION) notAtStation = true;
          noteCapital(m);
          noteEscalation(m);
        }
        sum += trialSum;
      } else {
        budget.resourceUnits = saved.resourceUnits;
        budget.reserveUnits = saved.reserveUnits;
        budget.isk = saved.isk;
        mobilized = saved.mobilized;
        liveFleets = saved.liveFleets;
        liveScouts = saved.liveScouts;
        slot = saved.slot;
        if (saved.scout) Object.assign(scoutBudget, saved.scout);
      }
    }
    if (params.capitalEscort && params.capitalAttach && notAtStation && ledger && ledger.needs(kind.mobilizeRole)
      && !mobs.some((x) => x.composition.some((e) => Number.isSafeInteger(e.typeId)))
      && chosen.length + mobs.length < params.maxFleetsPerOperation
      && mobilized < params.maxMobilizationsPerReview && liveFleets < fleetCap) {
      if (!escortCache.has(T)) escortCache.set(T, escortDistOf(snapshot, params, T));
      const e = planCapitalEscort({ snapshot, params, lg: ledger, target: T, level, role: kind.mobilizeRole,
        dist: escortCache.get(T), budget, iskLeft: budget.isk, war });
      if (e.intent && sum + e.strength >= required) {
        ledger.take(e.intent.stationId, e.intent.hulls);
        budget.resourceUnits -= e.intent.cost.resourceUnits;
        budget.reserveUnits -= e.intent.cost.reserveUnits;
        if (budget.isk !== null) budget.isk -= e.fit;
        mobilized += 1;
        liveFleets += 1;
        const { type, ...rest } = e.intent;
        mobs.push({ type, slot: slot++, ...rest,
          ...(params.escalation ? { escalationLevel: Number.isSafeInteger(level) && level > 0 ? level : 0 } : {}) });
        sum += e.strength;
        if (!escortNoted) notes.push(CAPITAL_ESCORT_NOTE);
        escortNoted = true;
      } else if (!e.intent && e.note && !escortMissNoted.has(e.note)) {
        notes.push(e.note);
        escortMissNoted.add(e.note);
      }
    }
    if (sum < required) {
      if (reserve !== null) budget.isk += reserve;
      for (const m of mobs) intents.push(m);
      if (lastNote && !forceNoted.has(lastNote)) notes.push(lastNote);
      if (lastNote) forceNoted.add(lastNote);
      if (!forceNoted.has("INSUFFICIENT_FORCE")) notes.push("INSUFFICIENT_FORCE");
      forceNoted.add("INSUFFICIENT_FORCE");
      skip.add(T);
      continue;
    }
    if (facts.category === "home") {
      notes.push(`RECLAIM:${T}`);
    } else if (kind.captures === true && typeof room === "number" && room > 0) {
      room -= 1;
    }
    launch(kind, T, chosen, mobs,
      facts.hive === true && kind.captures === true && params.hive ? params.hive.captureSlowFactor : 1, reserve);
  }
  return { intents, notes, targets, frontCount: fronts.size };
}

module.exports = { chooseNextOperation, stagingOf, liveCombatFleets };
