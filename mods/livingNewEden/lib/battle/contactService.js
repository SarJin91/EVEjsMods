"use strict";

const { planContact } = require("./contacts");
const { planGridContact, gridGarrisonOf, gridOfRef } = require("./gridContacts");
const { CONTACTABLE_STATES, OBJECTIVE_MAP, DEFAULT_OBJECTIVE, EVASIVE_ROLES,
  TRIP_FIGHTABLE_ROLES, ASSEMBLY_OPERATION_TYPES, DECLINE_OPERATION_TYPES } = require("./data/contactRules");
const { findRetreatTargets } = require("./retreatTargets");
const { RETREAT_SKIP_REASONS } = require("../fleets/travelService");
const { STRUCTURE_DEFENSE } = require("../stations/data/structureDefense");

const STATIONS_READY = "ready";
const STATION_ONLINE = "ONLINE";
const STATION_KIND_NPC = "npc";
const FAMILY_NPC = "npc";
const STATION_KIND_UPWELL = "upwell";
const STRUCTURE_ASSAULT_STATES = Object.freeze(["HULL_ASSAULT", "ANCHOR_ASSAULT"]);

const CONTACT_EVENT = "BATTLE_CONTACT_CHECK";
const RESOLUTION_EVENT = "BATTLE_RESOLUTION";
const STAYED = Object.freeze(["STAGED", "IDLE"]);
const LOSER_STAYED = Object.freeze(["REFITTING", "STAGED", "IDLE"]);
const RETRY_REASONS = Object.freeze(["FLEET_BUSY", "VERSION_CONFLICT", "ROW_NOT_FOUND", "FLEET_UNAVAILABLE"]);
const PERMANENT_REASONS = Object.freeze(["IDEMPOTENCY_CONFLICT", "INPUT_INVALID", "BATTLE_INPUT_TOO_LARGE"]);

const arrivalKey = (sys, fleetId, legSeq) => `contact:${sys}:arr:${fleetId}:${legSeq}`;
const afterKey = (sys, battleId) => `contact:${sys}:after:${battleId}`;
const coolKey = (sys, battleId) => `contact:${sys}:cool:${battleId}`;
const demoKey = (sys) => `contact:${sys}:demo:v1`;
const releaseKey = (sys, releaseId) => `contact:${sys}:rel:${releaseId}`;
const gridContactKey = (sys, fleetId, legSeq, moveSeq) => `contact:${sys}:grid:${fleetId}:${legSeq}:${moveSeq}`;
const assemblyKey = (sys, fleetId, legSeq) => `contact:${sys}:asm:${fleetId}:${legSeq}`;
const ASSEMBLY_ARRIVAL_STATE = "STAGED";
const ASSEMBLY_OPERATION_STATES = Object.freeze(["PLANNED", "ACTIVE"]);
const TRAVELLING = "TRAVELLING";
const KIND_ANCHOR = "anchor";
const KIND_SYSTEM = "system";
const ANCHORS_LOST = "ANCHORS_LOST";
const resolveKey = (battleId) => `battle:${battleId}:resolve:0`;

const isPositiveId = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const DECLINE_FLEET_STATE = "STAGED";
const PERMILLE = 1000;
const MODE_RETREAT = "retreat";

function messageOf(err) {
  return String((err && err.message) || err);
}

function powerOfFleets(fleets, table) {
  let sum = 0;
  for (const f of fleets) {
    for (const e of f.composition || []) {
      const power = table[e.hullGroup];
      if (Number.isSafeInteger(power) && Number.isSafeInteger(e.count) && e.count > 0) sum += power * e.count;
    }
  }
  return sum;
}

function garrisonPowerOf(points, powerPerPoint) {
  const p = Number.isFinite(points) && points > 0 ? points : 0;
  const k = Number.isFinite(powerPerPoint) && powerPerPoint > 0 ? powerPerPoint : 0;
  return Math.round(p * k);
}

function declineOf({ fleetsA, fleetsB, gB, operation, systemId, table, powerPerPoint, ratioPermille }) {
  if (!Array.isArray(fleetsA) || fleetsA.length === 0 || !Array.isArray(fleetsB)
    || !fleetsA.every((f) => f && f.state === DECLINE_FLEET_STATE)) return { decline: false };
  if (!operation || !DECLINE_OPERATION_TYPES.includes(operation.operationType)
    || operation.targetSystemId !== systemId) return { decline: false };
  if (!table || typeof table !== "object" || Object.keys(table).length === 0) {
    return { decline: false, reason: "NO_POWER" };
  }
  const powerA = powerOfFleets(fleetsA, table);
  const powerB = powerOfFleets(fleetsB, table) + garrisonPowerOf(gB, powerPerPoint);
  const ratio = Number.isSafeInteger(ratioPermille) && ratioPermille > 0 ? ratioPermille : 0;
  if (!Number.isSafeInteger(powerA * PERMILLE) || !Number.isSafeInteger(powerB * ratio)) return { decline: false };
  return powerA * PERMILLE < powerB * ratio ? { decline: true, powerA, powerB } : { decline: false };
}

function createContactService(deps) {
  const { store, scheduler, battleRepository, cooldownRepository, fleetRepository, settings, limits, isHostile,
    bump, logger } = deps;
  const tooLargeLogged = new Set();
  const devGarrisonOf = (systemId) => {
    if (typeof deps.getDevIndices !== "function") return 0;
    try {
      const dev = deps.getDevIndices();
      const e = dev && typeof dev.effectsOf === "function" ? dev.effectsOf(systemId, "garrison") : null;
      return e && Number.isSafeInteger(e.garrisonPoints) && e.garrisonPoints > 0 ? e.garrisonPoints : 0;
    } catch (_err) {
      return 0;
    }
  };
  const isTripFleet = (f) => TRIP_FIGHTABLE_ROLES.includes(f.fleetRole)
    && f.operationId !== null && f.operationId !== undefined;
  const evasiveOf = settings && settings.capsuleerTripsFightable === true
    ? (f) => EVASIVE_ROLES.includes(f.fleetRole) && !isTripFleet(f)
    : undefined;

  function travellingMembersOf(tx, fleetId, systemId) {
    const f = fleetRepository.getFleet(tx, fleetId);
    if (!f || f.ok !== true) return { ok: false, reason: (f && f.reason) || "FLEET_READ_FAILED" };
    const opId = f.fleet ? f.fleet.operationId : null;
    if (typeof opId !== "string" || opId === "") return { ok: true, members: [] };
    const o = fleetRepository.getOperation(tx, opId);
    if (!o || o.ok !== true) return { ok: false, reason: (o && o.reason) || "OPERATION_READ_FAILED" };
    const op = o.operation;
    if (!op || !ASSEMBLY_OPERATION_STATES.includes(op.state) || !ASSEMBLY_OPERATION_TYPES.includes(op.operationType)
      || op.targetSystemId !== systemId) return { ok: true, members: [] };
    const l = fleetRepository.listFleetsOfOperation(tx, opId);
    if (!l || l.ok !== true || !Array.isArray(l.fleets)) {
      return { ok: false, reason: (l && l.reason) || "OPERATION_FLEETS_READ_FAILED" };
    }
    return { ok: true, members: l.fleets.filter((m) => m.fleetId !== fleetId && m.state === TRAVELLING
      && m.targetSystemId === systemId && isTime(m.nextActionAt)) };
  }

  function assemblyDueOf(tx, arrival) {
    const { fleetId, systemId, at } = arrival;
    if (typeof fleetId !== "string" || !isPositiveId(systemId) || !isTime(at)) return null;
    let r;
    try {
      r = travellingMembersOf(tx, fleetId, systemId);
    } catch (err) {
      if (!tx || tx.inTransaction === false) throw err;
      bump("contacts.assemblyReadFailed");
      return null;
    }
    if (!r.ok) {
      bump("contacts.assemblyReadFailed");
      return null;
    }
    const later = r.members.filter((m) => m.nextActionAt > at);
    if (later.length === 0) return null;
    const last = Math.max(...later.map((m) => m.nextActionAt));
    const grace = Number.isSafeInteger(settings.assemblyGraceMs) && settings.assemblyGraceMs > 0
      ? settings.assemblyGraceMs : 0;
    const due = Math.min(last, at + grace);
    return due > at ? due : null;
  }

  function assemblySuperseded(tx, p) {
    try {
      const r = travellingMembersOf(tx, p.triggerFleetId, p.systemId);
      return r.ok === true && r.members.some((m) => m.nextActionAt <= p.at);
    } catch (err) {
      if (!tx || tx.inTransaction === false) throw err;
      return false;
    }
  }

  function onArrival(tx, arrival) {
    if (!deps.isActive()) return;
    const { fleetId, systemId, at, legSeq } = arrival;
    const due = settings && settings.assemblyEnabled === true && arrival.state === ASSEMBLY_ARRIVAL_STATE
      ? assemblyDueOf(tx, arrival) : null;
    if (due !== null) {
      const a = scheduler.enqueue(CONTACT_EVENT, systemId, due,
        { systemId, at: due, triggerFleetId: fleetId, assembly: true },
        assemblyKey(systemId, fleetId, legSeq), { tx, chained: true });
      if (!a || a.ok !== true) bump("contacts.enqueueRefused");
      else if (a.duplicate !== true) bump("contacts.assemblyDeferred");
      return;
    }
    const r = scheduler.enqueue(CONTACT_EVENT, systemId, at, { systemId, at, triggerFleetId: fleetId },
      arrivalKey(systemId, fleetId, legSeq), { tx, chained: true });
    if (!r || r.ok !== true) bump("contacts.enqueueRefused");
  }

  function onGridArrival(tx, arrival) {
    if (!deps.isActive()) return;
    const { fleetId, systemId, at, legSeq, moveSeq } = arrival;
    const r = scheduler.enqueue(CONTACT_EVENT, systemId, at, { systemId, at, triggerFleetId: fleetId },
      gridContactKey(systemId, fleetId, legSeq, moveSeq), { tx, chained: true });
    if (!r || r.ok !== true) bump("contacts.gridEnqueueRefused");
    else if (r.duplicate !== true) bump("contacts.gridQueued");
  }

  const gridActive = () => settings && settings.gridContactsEnabled === true && deps.grid
    && typeof deps.grid.isEnabled === "function" && deps.grid.isEnabled() === true
    && typeof deps.grid.positionsOf === "function";

  function positionsIn(tx, systemId, fleets, at) {
    try {
      const r = deps.grid.positionsOf(tx, systemId, fleets, at);
      return r && r.ok === true && r.anchorsReason === null && r.positions instanceof Map ? r.positions : null;
    } catch (err) {
      if (!tx || tx.inTransaction !== true) throw err;
      return null;
    }
  }

  function systemGridOf(systemId) {
    try {
      const r = deps.grid.readSystemGrid(systemId);
      if (!r || r.ok !== true || !r.cp) return null;
      const gridOf = gridOfRef(r.grids);
      const cpRef = `${r.cp.kind}:${r.cp.id}`;
      const cpGridKey = gridOf.get(cpRef) || (r.cp.kind === KIND_SYSTEM ? cpRef : `${KIND_SYSTEM}:${systemId}`);
      return { cpGridKey, gridOf };
    } catch (_err) {
      return null;
    }
  }

  function requestContactCheckInTx(tx, spec) {
    const { systemId, at, key } = spec;
    const payload = { systemId, at, triggerFleetId: spec.triggerFleetId === undefined ? null : spec.triggerFleetId };
    if (spec.demo === true) payload.demo = true;
    const r = scheduler.enqueue(CONTACT_EVENT, systemId, at, payload, key, { tx, chained: true });
    if (!r || r.ok !== true) return { ok: false, reason: (r && r.reason) || "ENQUEUE_FAILED", stage: "contact" };
    return { ok: true, duplicate: r.duplicate === true };
  }

  function readPhase(tx, p) {
    let assemblyExhausted = false;
    if (p.assembly === true && typeof p.triggerFleetId === "string" && assemblySuperseded(tx, p)) {
      if (p.yield === true) return { ok: true, superseded: true };
      assemblyExhausted = true;
    }
    const listed = fleetRepository.listFleetsInSystem(tx, p.systemId, { states: [...CONTACTABLE_STATES],
      limit: settings.contactScanMaxFleets });
    if (!listed.ok) return listed;
    const cool = cooldownRepository.listForSystem(tx, p.systemId);
    if (!cool.ok) return cool;
    const planSpec = { fleets: listed.fleets, triggerFleetId: p.triggerFleetId, isHostile,
      cooldowns: cool.cooldowns, at: p.at, limits, evasiveOf };
    let plan;
    let gridFallback = false;
    if (gridActive()) {
      const positions = positionsIn(tx, p.systemId, listed.fleets, p.at);
      gridFallback = positions === null;
      plan = planGridContact({ ...planSpec, positions });
    } else {
      plan = planContact(planSpec);
    }
    const gridKey = plan.contact && typeof plan.gridKey === "string" ? plan.gridKey : null;
    let operation = null;
    let garrisonStrength = 0;
    let stationA = 0;
    let stationB = 0;
    let structure = null;
    let garrisonDropped = false;
    if (plan.contact) {
      const lead = plan.contact.objectiveFleetId === null ? null
        : listed.fleets.find((f) => f.fleetId === plan.contact.objectiveFleetId);
      if (lead && lead.operationId !== null) {
        const o = fleetRepository.getOperation(tx, lead.operationId);
        if (!o.ok) return o;
        operation = o.operation;
      }
      const world = deps.worldRepository;
      const devOn = typeof deps.getDevIndices === "function";
      const records = stationRecordsOf(tx, p.systemId);
      const station = stationGarrisonOf(records, plan.contact.sideA.factionId, plan.contact.sideB.factionId);
      stationA = station.a;
      stationB = station.b;
      const grid = gridKey === null ? null : systemGridOf(p.systemId);
      let influenceAllowed = true;
      let structureRecords = records;
      if (grid !== null) {
        const gridRecords = records === null && gridKey !== grid.cpGridKey
          && (settings.influenceGarrison !== "off" || devOn) ? stationRecordsForGrid(tx, p.systemId) : records;
        const g = gridGarrisonOf({ gridKey, cpGridKey: grid.cpGridKey, gridOf: grid.gridOf, records: gridRecords,
          factionA: plan.contact.sideA.factionId, factionB: plan.contact.sideB.factionId,
          garrisonPoints: (s) => (settings.stationGarrisonEnabled === true ? garrisonPointsOf(s) : 0) });
        if (g.stationB < stationB) garrisonDropped = true;
        stationA = g.stationA;
        stationB = g.stationB;
        influenceAllowed = g.influenceAllowed;
        structureRecords = records === null ? null : g.structureRecords;
      }
      structure = structureOfContact(tx, structureRecords, plan.contact.sideA, plan.contact.sideB);
      const addDevGarrison = (s) => {
        const controller = s && s.ok && s.system ? s.system.controllerFactionId : null;
        if (influenceAllowed && devOn && Number.isSafeInteger(controller)
          && controller > 0 && controller === plan.contact.sideB.factionId) {
          garrisonStrength += devGarrisonOf(p.systemId);
        }
      };
      if (settings.influenceGarrison !== "off" && world && typeof world.getSystem === "function") {
        try {
          const s = world.getSystem(tx, p.systemId, { includeInfluence: true });
          const inf = s && s.ok && s.system && Array.isArray(s.system.influence) ? s.system.influence : [];
          const row = inf.find((i) => i.factionId === plan.contact.sideB.factionId);
          if (row && Number.isSafeInteger(row.garrisonStrength) && row.garrisonStrength > 0) {
            if (influenceAllowed) garrisonStrength = row.garrisonStrength;
            else garrisonDropped = true;
          }
          addDevGarrison(s);
        } catch (_err) {
        }
      } else if (devOn && world && typeof world.getSystem === "function") {
        try {
          addDevGarrison(world.getSystem(tx, p.systemId, { includeInfluence: false }));
        } catch (_err) {
        }
      }
    }
    let tripContact = false;
    if (plan.contact && evasiveOf !== undefined) {
      const ids = new Set([...plan.contact.sideA.fleets, ...plan.contact.sideB.fleets].map((f) => f.fleetId));
      tripContact = listed.fleets.some((f) => ids.has(f.fleetId) && TRIP_FIGHTABLE_ROLES.includes(f.fleetRole));
    }
    const read = { ok: true, plan, operation, garrisonStrength, stationA, stationB, structure, tripContact,
      truncated: listed.nextAfterFleetId !== null };
    if (assemblyExhausted) read.assemblyExhausted = true;
    if (settings.declineEnabled === true && plan.contact) {
      const rowsOf = (side) => side.fleets.map((s) => listed.fleets.find((f) => f.fleetId === s.fleetId))
        .filter(Boolean);
      read.declineFleets = { a: rowsOf(plan.contact.sideA), b: rowsOf(plan.contact.sideB) };
    }
    if (plan.fallback !== undefined) {
      read.gridKey = gridKey;
      read.gridFallback = gridFallback;
      read.garrisonDropped = garrisonDropped;
      read.warpSkipped = Number.isSafeInteger(plan.warpSkipped) ? plan.warpSkipped : 0;
      read.participants = plan.contact
        ? [...plan.contact.sideA.fleets, ...plan.contact.sideB.fleets].map((f) => f.fleetId) : [];
    }
    return read;
  }

  function stationRecordsOf(tx, systemId) {
    if (settings.stationGarrisonEnabled !== true && settings.structureLiveCombatEnabled !== true) return null;
    return stationRecordsForGrid(tx, systemId);
  }

  function stationRecordsForGrid(tx, systemId) {
    if (typeof deps.getStations !== "function") return null;
    try {
      const st = deps.getStations();
      if (!st || typeof st.getMode !== "function" || st.getMode() !== STATIONS_READY || !st.repository) return null;
      const r = st.repository.listStationsInSystem(tx, systemId);
      return r && r.ok === true && Array.isArray(r.records) ? r.records : null;
    } catch (_err) {
      return null;
    }
  }

  function structureOfContact(tx, records, sideA, sideB) {
    if (settings.structureLiveCombatEnabled !== true || records === null || typeof deps.getSiege !== "function") {
      return null;
    }
    try {
      const siege = deps.getSiege();
      const repo = siege && siege.repository;
      if (!repo || typeof repo.getOpenByStation !== "function") return null;
      const pair = [sideA.factionId, sideB.factionId];
      const candidates = records.filter((s) => s.kind === STATION_KIND_UPWELL && isPositiveId(s.evejsItemId)
        && isPositiveId(s.typeId) && pair.includes(s.ownerFactionId))
        .sort((x, y) => (x.stationId < y.stationId ? -1 : x.stationId > y.stationId ? 1 : 0));
      for (const s of candidates) {
        const o = repo.getOpenByStation(tx, s.stationId);
        const g = o && o.ok === true ? o.siege : null;
        if (!g || !STRUCTURE_ASSAULT_STATES.includes(g.state) || g.ownerFactionId !== s.ownerFactionId
          || !pair.includes(g.attackerFactionId) || g.attackerFactionId === g.ownerFactionId) continue;
        return { structureId: s.evejsItemId, structureTypeId: s.typeId,
          structureSide: g.ownerFactionId === sideA.factionId ? "A" : "B" };
      }
      return null;
    } catch (_err) {
      return null;
    }
  }

  function garrisonPointsOf(s) {
    const family = s.kind === STATION_KIND_NPC ? FAMILY_NPC : s.structureFamily;
    const d = typeof family === "string" && Object.prototype.hasOwnProperty.call(STRUCTURE_DEFENSE, family)
      ? STRUCTURE_DEFENSE[family] : null;
    return d && Number.isSafeInteger(d.garrisonPoints) && d.garrisonPoints > 0 ? d.garrisonPoints : 0;
  }

  function stationGarrisonOf(records, factionA, factionB) {
    const none = { a: 0, b: 0 };
    if (settings.stationGarrisonEnabled !== true || records === null) return none;
    try {
      const out = { a: 0, b: 0 };
      for (const s of records) {
        if (s.state !== STATION_ONLINE) continue;
        const points = garrisonPointsOf(s);
        if (s.ownerFactionId === factionA) out.a += points;
        else if (s.ownerFactionId === factionB) out.b += points;
      }
      return out;
    } catch (_err) {
      return none;
    }
  }

  function gridRefOf(gridKey) {
    const i = gridKey.indexOf(":");
    if (i <= 0) return null;
    const kind = gridKey.slice(0, i);
    const id = Number(gridKey.slice(i + 1));
    if (kind === KIND_SYSTEM || !isPositiveId(id)) return null;
    return { kind, id };
  }

  function stillInGrid(etx, p, participants, gridKey) {
    if (!Array.isArray(participants) || participants.length === 0) return false;
    const read = fleetRepository.getFleets(etx, participants);
    if (!read || read.ok !== true || read.fleets.length !== participants.length) return false;
    let r;
    try {
      r = deps.grid.positionsOf(etx, p.systemId, read.fleets, p.at);
    } catch (err) {
      if (!etx || etx.inTransaction !== true) throw err;
      return false;
    }
    if (!r || r.ok !== true || !(r.positions instanceof Map)) return false;
    if (r.anchorsReason !== null && r.anchorsReason !== undefined) return ANCHORS_LOST;
    return participants.every((id) => {
      const pos = r.positions.get(id);
      return Boolean(pos) && pos.kind === KIND_ANCHOR && pos.gridKey === gridKey;
    });
  }

  function assemblyRecheckOf(ev, p) {
    const round = Number.isSafeInteger(p.round) && p.round >= 0 ? p.round : 0;
    const maxRounds = Number.isSafeInteger(settings.assemblyMaxRounds) && settings.assemblyMaxRounds >= 0
      ? settings.assemblyMaxRounds : 0;
    const recheckMs = settings.assemblyRecheckMs;
    if (round >= maxRounds || !Number.isSafeInteger(recheckMs) || recheckMs <= 0
      || typeof ev.idempotencyKey !== "string" || ev.idempotencyKey === "") return null;
    const at = p.at + recheckMs;
    return { dueAt: at, payload: { systemId: p.systemId, at, triggerFleetId: p.triggerFleetId, assembly: true,
      round: round + 1 }, idempotencyKey: `${ev.idempotencyKey.replace(/:r\d+$/, "")}:r${round + 1}` };
  }

  function powerTableOf() {
    if (typeof deps.getStrategy !== "function") return null;
    try {
      const s = deps.getStrategy();
      return s && s.powerTable && typeof s.powerTable === "object" ? s.powerTable : null;
    } catch (_err) {
      return null;
    }
  }

  function declineEffect(etx, event, p, c, rowsA, battle) {
    const travel = deps.travel;
    if (!travel || typeof travel.planInTx !== "function") return { ok: false, reason: "TRAVEL_UNAVAILABLE" };
    const found = findRetreatTargets(etx, { graph: deps.getGraph(), worldRepository: deps.worldRepository,
      systemId: p.systemId, factionId: c.sideA.factionId, limits: settings.retreatLimits });
    if (!found || found.ok !== true) return found || { ok: false, reason: "RETREAT_TARGETS_FAILED" };
    let retreated = 0;
    const stuckFleets = [];
    for (const f of c.sideA.fleets) {
      const row = rowsA.find((x) => x.fleetId === f.fleetId);
      const home = row && isPositiveId(row.homeSystemId) ? [row.homeSystemId] : [];
      const targets = [...new Set([...found.targets, ...home])].filter((id) => id !== p.systemId);
      let done = false;
      for (const targetSystemId of targets) {
        const r = travel.planInTx(etx, { fleetId: f.fleetId, targetSystemId, at: p.at,
          expectedVersion: f.expectedVersion }, `${event.idempotencyKey}:decline:${f.fleetId}`,
        { mode: MODE_RETREAT, chained: true });
        if (r && r.ok === true) {
          if (r.duplicate !== true) retreated += 1;
          done = true;
          break;
        }
        if (r && RETREAT_SKIP_REASONS.includes(r.reason)) continue;
        return r || { ok: false, reason: "RETREAT_FAILED" };
      }
      if (!done) stuckFleets.push(f);
    }
    const stuck = stuckFleets.length;
    let fought = null;
    if (stuck > 0) {
      const stayed = new Set([...stuckFleets, ...c.sideB.fleets].map((f) => f.fleetId));
      const participants = Array.isArray(battle.participants)
        ? battle.participants.filter((id) => stayed.has(id)) : battle.participants;
      const spec = stuck === c.sideA.fleets.length ? battle.spec
        : { ...battle.spec, sideA: { ...battle.spec.sideA, fleets: stuckFleets } };
      fought = battleEffect(etx, event, { ...battle, spec, participants });
      if (!fought || fought.ok !== true) return fought || { ok: false, reason: "BATTLE_FAILED" };
    }
    if (stuck < c.sideA.fleets.length) bump("contacts.declined");
    if (retreated > 0) bump("contacts.declineFleetsRetreated", retreated);
    if (stuck > 0) bump("contacts.declineStuck", stuck);
    const out = { ok: true, declined: retreated };
    if (fought !== null && fought.battleId !== undefined) out.battleId = fought.battleId;
    return out;
  }

  function battleEffect(etx, event, b) {
    const { p, spec, gridKey, read, dueAt } = b;
    const still = gridKey === null ? true : stillInGrid(etx, p, b.participants, gridKey);
    if (still === false) {
      bump("contacts.gridMoved");
      return { ok: true };
    }
    if (still === ANCHORS_LOST) bump("contacts.gridAnchorsLost");
    const created = battleRepository.createBattle(etx, spec, `${event.idempotencyKey}:battle`);
    if (!created.ok) {
      if (created.reason === "BATTLE_TOO_LARGE_TO_SETTLE") {
        bump("contacts.tooLarge");
        return { ok: true };
      }
      if (PERMANENT_REASONS.includes(created.reason)) return { ...created, permanent: true };
      if (RETRY_REASONS.includes(created.reason)) return created;
      return created;
    }
    const payload = { battleId: created.battleId, at: dueAt };
    if (p.demo === true) payload.demo = true;
    const r = scheduler.enqueue(RESOLUTION_EVENT, created.battleId, dueAt, payload, resolveKey(created.battleId),
      { tx: etx, chained: true });
    if (!r || r.ok !== true) return { ok: false, reason: (r && r.reason) || "ENQUEUE_FAILED", stage: "resolve" };
    if (!created.duplicate) bump("contacts.found");
    if (!created.duplicate && read.garrisonDropped === true) bump("contacts.gridGarrisonDropped");
    if (!created.duplicate && settings.influenceGarrison === "off") bump("contacts.influenceGarrisonOff");
    if (!created.duplicate && spec.structureId !== undefined) bump("contacts.structureMarked");
    if (!created.duplicate && read.tripContact === true) bump("contacts.capsuleerTripContacts");
    return { ok: true, battleId: created.battleId };
  }

  function onContactCheck(ev) {
    try {
      const p = ev.payload;
      if (!p || !isPositiveId(p.systemId) || !isTime(p.at)
        || (p.triggerFleetId !== null && p.triggerFleetId !== undefined && typeof p.triggerFleetId !== "string")) {
        return { ok: false, reason: "CONTACT_PAYLOAD_INVALID", permanent: true };
      }
      const g = deps.getGraph();
      if (!g) return { ok: false, reason: "GRAPH_NOT_READY" };
      const system = g.getSystem(p.systemId);
      if (!system) {
        bump("contacts.none");
        return { ok: true, outcome: "UNKNOWN_SYSTEM" };
      }
      bump("contacts.checks");
      const next = p.assembly === true ? assemblyRecheckOf(ev, p) : null;
      const tx = store.transaction("battle.contactRead", (db) => readPhase(db, {
        systemId: p.systemId, at: p.at, triggerFleetId: typeof p.triggerFleetId === "string" ? p.triggerFleetId : null,
        assembly: p.assembly === true, yield: next !== null }));
      if (!tx.ok) return { ok: false, reason: tx.reason || "TX_FAILED" };
      const read = tx.value;
      if (!read.ok) return { ok: false, reason: read.reason || "CONTACT_READ_FAILED" };
      if (read.superseded === true) {
        bump("contacts.assemblySuperseded");
        return { ok: true, outcome: "ASSEMBLY_SUPERSEDED", reschedule: next };
      }
      if (read.assemblyExhausted === true) bump("contacts.assemblyRoundsExhausted");
      if (read.truncated) bump("contacts.truncated");
      const plan = read.plan;
      if (read.gridFallback === true) bump("contacts.gridFallback");
      if (read.warpSkipped > 0) bump("contacts.gridWarpSkipped", read.warpSkipped);
      if (!plan.contact) {
        if (plan.reason === "GRID_APART") bump("contacts.gridApart");
        else if (plan.reason === "ON_COOLDOWN") bump("contacts.cooldown");
        else if (plan.reason === "TOO_LARGE") {
          bump("contacts.tooLarge");
          if (!tooLargeLogged.has(p.systemId)) {
            tooLargeLogged.add(p.systemId);
            logger.log(`battle: contact too large to settle system=${p.systemId}`);
          }
        } else bump("contacts.none");
        return { ok: true, outcome: plan.reason };
      }
      const c = plan.contact;
      if (c.truncated > 0) bump("contacts.truncated");
      const objective = read.operation && Object.prototype.hasOwnProperty.call(OBJECTIVE_MAP, read.operation.objective)
        ? OBJECTIVE_MAP[read.operation.objective] : DEFAULT_OBJECTIVE;
      const gB = read.garrisonStrength + read.stationB;
      const gA = read.stationA;
      let garrison = null;
      if (gB > 0) garrison = { side: "B", factionId: c.sideB.factionId, strength: gB };
      else if (gA > 0) garrison = { side: "A", factionId: c.sideA.factionId, strength: gA };
      if (read.stationA + read.stationB > 0) bump("contacts.stationGarrison");
      const dueAt = p.at + settings.engageDelayMs;
      const spec = { systemId: p.systemId, environment: system.secClass, objective,
        resolverVersion: deps.resolverVersion, maxResolutionMs: settings.maxResolutionMs, garrison,
        sideA: c.sideA, sideB: c.sideB };
      if (read.structure !== null && garrison === null) {
        spec.structureId = read.structure.structureId;
        spec.structureTypeId = read.structure.structureTypeId;
        spec.structureSide = read.structure.structureSide;
      }
      const gridKey = typeof read.gridKey === "string" ? read.gridKey : null;
      const gridRef = gridKey === null ? null : gridRefOf(gridKey);
      if (gridRef !== null) spec.grid = gridRef;
      const battle = { p, spec, gridKey, participants: read.participants, read, dueAt };
      if (settings.declineEnabled === true && read.declineFleets) {
        const d = declineOf({ fleetsA: read.declineFleets.a, fleetsB: read.declineFleets.b, gB,
          operation: read.operation, systemId: p.systemId, table: powerTableOf(),
          powerPerPoint: deps.powerPerPoint, ratioPermille: settings.declineRatioPermille });
        if (d.reason === "NO_POWER") bump("contacts.declineNoPower");
        if (d.decline === true) {
          return { ok: true, outcome: "DECLINED",
            effect: (etx, event) => declineEffect(etx, event, p, c, read.declineFleets.a, battle) };
        }
      }
      return { ok: true, outcome: "BATTLE", effect: (etx, event) => battleEffect(etx, event, battle) };
    } catch (err) {
      return { ok: false, reason: `HANDLER_FAILED: ${messageOf(err)}` };
    }
  }

  function applyConsequence(tx, settled, ck) {
    if (!deps.isActive()) return { ok: false, reason: "BATTLE_STOPPED" };
    try {
      const loserStayed = settled.fleets.some((f) => (settled.winnerSide === null || f.side !== settled.winnerSide)
        && LOSER_STAYED.includes(f.disposition));
      if (settled.outcome === "DRAW" || loserStayed) {
        const factions = [...new Set(settled.fleets.map((f) => f.factionId))];
        if (factions.length !== 2) return { ok: true, skipped: "FACTIONS" };
        const untilAt = settled.at + settings.recontactCooldownMs;
        const cd = cooldownRepository.recordInTx(tx, { systemId: settled.systemId, factionA: factions[0],
          factionB: factions[1], untilAt, battleId: settled.battleId }, `${ck}:cooldown`);
        if (!cd.ok) return cd;
        return requestContactCheckInTx(tx, { systemId: settled.systemId, at: untilAt,
          key: coolKey(settled.systemId, settled.battleId) });
      }
      if (!settled.fleets.some((f) => STAYED.includes(f.disposition))) return { ok: true, skipped: "NONE_LEFT" };
      return requestContactCheckInTx(tx, { systemId: settled.systemId, at: settled.at,
        key: afterKey(settled.systemId, settled.battleId) });
    } catch (err) {
      if (!tx || tx.inTransaction !== true) throw err;
      return { ok: false, reason: "CONTACTS_FAILED", detail: messageOf(err) };
    }
  }

  function requestReleaseCheckInTx(tx, info) {
    if (!deps.isActive()) return { ok: false, reason: "BATTLE_STOPPED" };
    if (settings.releaseContactEnabled !== true) return { ok: true, skipped: "DISABLED" };
    try {
      const i = info || {};
      if (!isPositiveId(i.systemId) || !isTime(i.at) || typeof i.fleetId !== "string" || i.fleetId === ""
        || typeof i.releaseId !== "string" || i.releaseId === "") {
        bump("contacts.releaseRefused");
        return { ok: false, reason: "RELEASE_CONTACT_INVALID" };
      }
      const r = requestContactCheckInTx(tx, { systemId: i.systemId, at: i.at, key: releaseKey(i.systemId, i.releaseId),
        triggerFleetId: i.fleetId });
      if (!r.ok) {
        bump("contacts.releaseRefused");
        return r;
      }
      if (!r.duplicate) bump("contacts.releaseQueued");
      return r;
    } catch (err) {
      if (!tx || tx.inTransaction !== true) throw err;
      bump("contacts.releaseRefused");
      return { ok: false, reason: "RELEASE_CONTACT_FAILED", detail: messageOf(err) };
    }
  }

  return Object.freeze({ onArrival, onGridArrival, onContactCheck, requestContactCheckInTx, requestReleaseCheckInTx,
    consequence: Object.freeze({ name: "contacts", apply: applyConsequence }) });
}

module.exports = { createContactService, CONTACT_EVENT, RESOLUTION_EVENT, arrivalKey, afterKey, coolKey, demoKey,
  releaseKey, resolveKey, gridContactKey, assemblyKey, declineOf };
