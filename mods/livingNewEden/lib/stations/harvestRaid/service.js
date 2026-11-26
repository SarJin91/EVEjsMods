"use strict";

const S = require("./schema");
const { planRaidStart, decideRaidStep, skyhookWindowOf } = require("./machine");
const { planMetenoxLoss, planSkyhookLoss } = require("./lossPlan");
const { holdOf } = require("../siege/siegeMachine");
const { HOLD_STATES, READ_FLEET_STATES } = require("../siege/schema");
const { OPEN_OPERATION_STATES } = require("../../fleets/schema");
const { relationOf, huntThresholds } = require("../../playerHunt/policy");
const { parseNeutralPolicy } = require("../../playerHunt/schema");
const { STATE: EVENT_STATE } = require("../../scheduler/schema");

const RAID_ROLES = Object.freeze(["invasion", "patrol"]);
const REFINERY_FAMILY = "refinery";
const MAX_DETAIL = 120;
const RECONCILE_CHUNK = 64;
const LOST_EVENT_STATES = Object.freeze([EVENT_STATE.DONE, EVENT_STATE.QUARANTINED]);
const STEP_LOST = "STEP_LOST";
const COUNTER_NAMES = Object.freeze(["checks", "started", "warned", "repelled", "expired", "aborted", "settled",
  "lossUnits", "lossVolumeM3", "linesZero", "receiptDuplicates", "vendorAmbiguous", "ownerOffline", "cooldown",
  "seamRefused", "noOperation", "noTarget", "stale", "enqueueRefused", "reconciled", "stepLost", "advanced",
  "samples",
  "noticesOff",
  "skyhookBusy", "skyhookWindowClosed", "skyhookGenerationChanged", "skyhookTheftUnits"]);
const NO_START_COUNTER = Object.freeze({ NO_OPERATION: "noOperation", OWNER_OFFLINE: "ownerOffline",
  COOLDOWN: "cooldown", OWNER_COOLDOWN: "cooldown", NOTICES_OFF: "noticesOff", WINDOW: "skyhookWindowClosed",
  VENDOR_BUSY: "skyhookBusy" });
const SKYHOOK_NOT_FOUND = "SKYHOOK_NOT_FOUND";
const SKYHOOK_BUSY = "SKYHOOK_BUSY";
const SKYHOOK_GENERATION_CHANGED = "SKYHOOK_GENERATION_CHANGED";
const WINDOW_CLOSED = "WINDOW_CLOSED";
const RAID_READY = "ready";
const NOTICES_RUNNING = "running";
const END_COUNTER = Object.freeze({ [S.REPELLED]: "repelled", [S.EXPIRED]: "expired", [S.ABORTED]: "aborted",
  [S.SETTLED]: "settled" });
const CHECK_KEYS = Object.freeze(["at", "systemId", "triggerFleetId"]);
const STEP_KEYS = Object.freeze(["phaseSeq", "raidId", "round"]);
const SETTLE_KEYS = Object.freeze(["raidId"]);

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const messageOf = (err) => String((err && err.message) || err).slice(0, MAX_DETAIL);
const keysOf = (p) => Object.keys(p).sort().join();

function call(fn, fallback) {
  try {
    return fn();
  } catch (_err) {
    return fallback;
  }
}

function parseCheckPayload(p) {
  if (!isPlain(p) || keysOf(p) !== CHECK_KEYS.join() || !isId(p.systemId) || !isTime(p.at)) return null;
  if (typeof p.triggerFleetId !== "string" || p.triggerFleetId === "") return null;
  return { systemId: p.systemId, at: p.at, triggerFleetId: p.triggerFleetId };
}

function parseStepPayload(p) {
  if (!isPlain(p) || keysOf(p) !== STEP_KEYS.join()) return null;
  if (typeof p.raidId !== "string" || p.raidId === "" || p.raidId.length > S.MAX_ID_LENGTH || !isTime(p.phaseSeq)
    || !isId(p.round)) return null;
  return { raidId: p.raidId, phaseSeq: p.phaseSeq, round: p.round };
}

function parseSettlePayload(p) {
  if (!isPlain(p) || keysOf(p) !== SETTLE_KEYS.join()) return null;
  if (typeof p.raidId !== "string" || p.raidId === "" || p.raidId.length > S.MAX_ID_LENGTH) return null;
  return { raidId: p.raidId };
}

function listOf(text) {
  return [...new Set(String(text || "").split(",").map((p) => p.trim()).filter((p) => p !== ""))];
}

function planOf(raid) {
  if (!Array.isArray(raid.plan)) return null;
  const ok = raid.plan.every((l) => isPlain(l) && isId(l.itemId) && isId(l.typeId) && isId(l.units));
  return ok ? raid.plan : null;
}

function skyhookPlanOf(raid) {
  const p = raid.plan;
  if (!isPlain(p) || typeof p.generation !== "string" || p.generation === ""
    || p.generation.length > S.MAX_ID_LENGTH || !Array.isArray(p.lines)) return null;
  const ok = p.lines.every((l) => isPlain(l) && isId(l.typeId) && isId(l.units) && typeof l.unitVolume === "number"
    && Number.isFinite(l.unitVolume) && l.unitVolume >= 0);
  return ok ? p : null;
}

function lossOf(taken) {
  const byType = new Map();
  for (const t of taken) byType.set(t.typeId, (byType.get(t.typeId) || 0) + t.units);
  return [...byType.entries()].sort((a, b) => a[0] - b[0]).map(([typeId, units]) => ({ typeId, units }));
}

function createHarvestRaidService(deps) {
  const { store, raids, scheduler, fleetRepository, registry, structures, bays, config, groups, clock } = deps;
  const C = config.harvestRaid;
  const PS = config.playerSiege || {};
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
  const telemetry = deps.telemetry || null;
  const secClasses = listOf(C.secClasses);
  const hunt = config.playerHunt || {};
  const thresholds = huntThresholds(hunt);
  const neutralPolicy = parseNeutralPolicy(hunt.neutralPolicy) || {};
  const params = Object.freeze({ targetCooldownMs: C.targetCooldownMs, ownerCooldownMs: C.ownerCooldownMs,
    maxOpen: C.maxOpen, maxOpenPerFaction: C.maxOpenPerFaction, minLootVolumeM3: C.minLootVolumeM3,
    wallDeadlineMs: C.wallDeadlineMs, warningMs: C.warningMs, sampleMs: C.sampleMs, raidMs: C.raidMs,
    skyhookMinLootUnits: C.skyhookMinLootUnits });
  const skyhooks = C.skyhookEnabled === true && deps.skyhooks ? deps.skyhooks : null;
  const skyhookOn = skyhooks !== null;
  const skyhookMode = C.skyhookEnabled !== true ? "disabled" : skyhookOn ? "on"
    : typeof deps.skyhookMode === "string" && deps.skyhookMode.startsWith("off:") ? deps.skyhookMode : "off:seam";

  const counters = Object.fromEntries(COUNTER_NAMES.map((n) => [n, 0]));
  let state = "ready";
  let lastRefusal = null;
  let seq = 0;
  let openCount = 0;
  let skyIndex = null;

  function metric(kind, name, value) {
    if (!telemetry || typeof telemetry[kind] !== "function") return;
    try {
      telemetry[kind](name, value);
    } catch (_err) {
    }
  }

  function bump(name, n = 1) {
    if (!(n > 0) || !own(counters, name)) return;
    counters[name] += n;
    seq += 1;
    metric("count", `harvestRaid.${name}`, n);
  }

  function setOpen(n) {
    openCount = Math.max(0, n);
    metric("gauge", "harvestRaid.open", openCount);
  }

  function log(line) {
    try {
      logger.log(line);
    } catch (_err) {
    }
  }

  const stopped = () => state === "stopped";
  const now = () => call(() => clock.now(), 0);
  const isHostileFaction = (a, b) => isId(a) && isId(b) && a !== b && call(() => deps.hostility(a, b) === true, false);
  const kindOf = (f) => call(() => {
    const entry = registry.getFaction(f);
    return entry && typeof entry.kind === "string" && entry.kind !== "" ? entry.kind : null;
  }, null);
  const isActive = (f) => call(() => registry.isActive(f) === true, false);

  function graphNow() {
    const r = typeof deps.getGraph === "function" ? call(deps.getGraph, null) : null;
    return r && r.ok === true && r.graph ? r.graph : null;
  }

  function secClassOf(graph, systemId) {
    const sys = graph && typeof graph.getSystem === "function" ? call(() => graph.getSystem(systemId), null) : null;
    return sys ? sys.secClass : null;
  }

  function virtualOf(corpId) {
    const vc = typeof deps.getVirtualCorps === "function" ? call(deps.getVirtualCorps, null) : null;
    if (!vc || typeof vc.isVirtualCorporation !== "function") return true;
    return call(() => vc.isVirtualCorporation(corpId) === true, true);
  }

  function seamCall(seam, name, ...args) {
    if (!seam || typeof seam[name] !== "function") return { ok: false, reason: "HARVEST_BAYS_SEAM_UNAVAILABLE" };
    return call(() => seam[name](...args) || { ok: false, reason: "SEAM_ERROR" }, { ok: false, reason: "SEAM_ERROR" });
  }

  function metenoxesIn(systemId) {
    const index = seamCall(structures, "listCandidates", { nowMs: now(), ttlMs: PS.indexTtlMs,
      families: [REFINERY_FAMILY], maxStructures: PS.maxIndexStructures });
    if (!index.ok || !(index.bySystem instanceof Map)) return index.ok ? { ok: false, reason: "INDEX_FAILED" } : index;
    const list = (index.bySystem.get(systemId) || []).filter((s) => s && s.typeId === S.METENOX_TYPE_ID)
      .sort((a, b) => a.structureId - b.structureId);
    return { ok: true, list };
  }

  function skyIndexNow() {
    if (!skyhookOn) return { ok: true, bySystem: new Map(), truncated: false };
    const t = now();
    if (skyIndex && t >= skyIndex.at && t - skyIndex.at < PS.indexTtlMs) return skyIndex;
    const r = seamCall(skyhooks, "listPlayerSkyhooks", { max: C.maxSkyhooksIndexed });
    if (!r.ok || !Array.isArray(r.skyhooks)) return r.ok ? { ok: false, reason: "INDEX_FAILED" } : r;
    const bySystem = new Map();
    for (const s of r.skyhooks) {
      if (!s || s.active !== true || s.destroyed === true || !isId(s.skyhookId) || !isId(s.systemId)
        || !isId(s.corpId)) continue;
      if (!bySystem.has(s.systemId)) bySystem.set(s.systemId, []);
      bySystem.get(s.systemId).push(s);
    }
    for (const list of bySystem.values()) list.sort((a, b) => a.skyhookId - b.skyhookId);
    skyIndex = { ok: true, at: t, bySystem, truncated: r.truncated === true };
    return skyIndex;
  }

  function skyhooksIn(systemId) {
    const index = skyIndexNow();
    return index.ok ? { ok: true, list: index.bySystem.get(systemId) || [] } : index;
  }

  const windowOf = (sk, at) => skyhookWindowOf(sk, at, C.skyhookLaunchLeadMs);

  function hostileOf(ownerCorpId, factionId) {
    if (!isActive(factionId)) return false;
    const face = seamCall(structures, "readOwnerFace", ownerCorpId);
    if (face.ok !== true || face.npc === true || !isId(face.ceoId)) return false;
    const r = typeof deps.readStanding === "function" ? call(() => deps.readStanding(face.ceoId, factionId), null)
      : null;
    const standing = r && r.ok === true && typeof r.standing === "number" ? r.standing : null;
    return standing !== null && relationOf(standing, kindOf(factionId), thresholds, neutralPolicy) === "hostile";
  }

  function onlineOf(corpId, at) {
    const r = typeof deps.ownerOnline === "function" ? call(() => deps.ownerOnline(corpId, at), null) : null;
    return Boolean(r && r.online === true);
  }

  function siegedIn(tx) {
    const ps = typeof deps.getPlayerSiege === "function" ? call(deps.getPlayerSiege, null) : null;
    if (!ps || typeof ps.listOpen !== "function" || call(() => ps.getMode(), "off") === "off") {
      return { ok: true, ids: new Set() };
    }
    const r = ps.listOpen(tx, { limit: Number.isSafeInteger(PS.maxOpen) ? PS.maxOpen : 0 });
    if (!r || r.ok !== true) return { ok: false, reason: (r && r.reason) || "PLAYER_SIEGE_READ_FAILED" };
    return { ok: true, ids: new Set(r.sieges.map((s) => s.structureId)) };
  }

  function readFleets(tx, systemId) {
    const listed = fleetRepository.listFleetsInSystem(tx, systemId, { states: [...READ_FLEET_STATES],
      limit: C.maxFleetsReadPerCheck });
    if (!listed || !listed.ok) return listed || { ok: false, reason: "FLEETS_READ_FAILED" };
    return { ok: true, fleets: listed.fleets };
  }

  function operationOf(tx, fleetId, systemId) {
    const f = fleetRepository.getFleet(tx, fleetId);
    if (!f || !f.ok) return f || { ok: false, reason: "FLEETS_READ_FAILED" };
    if (!f.fleet || typeof f.fleet.operationId !== "string" || f.fleet.operationId === "") {
      return { ok: true, operation: null };
    }
    const o = fleetRepository.getOperation(tx, f.fleet.operationId);
    if (!o || !o.ok) return o || { ok: false, reason: "FLEETS_READ_FAILED" };
    const op = o.operation;
    if (!op || op.operationType !== S.OPERATION_TYPE || !OPEN_OPERATION_STATES.includes(op.state)
      || op.targetSystemId !== systemId) return { ok: true, operation: null };
    return { ok: true, operation: op };
  }

  function noticesRunning() {
    return call(() => {
      const n = typeof deps.getNotices === "function" ? deps.getNotices() : null;
      const st = n && typeof n.getStatus === "function" ? n.getStatus() : null;
      return Boolean(st) && st.state === NOTICES_RUNNING;
    }, false);
  }

  function getMode() {
    if (stopped()) return "off";
    return graphNow() ? "ready" : "pending";
  }

  function enqueueStep(tx, raidId, phaseSeq, round, dueAt) {
    const r = scheduler.enqueue(S.STEP_EVENT_TYPE, raidId, dueAt, { raidId, phaseSeq, round },
      S.stepKey(raidId, phaseSeq, round), { tx, chained: true });
    if (!r || r.ok !== true) return { ok: false, reason: (r && r.reason) || "ENQUEUE_FAILED", stage: "step" };
    return { ok: true };
  }

  function enqueueSettle(tx, raidId, dueAt) {
    const r = scheduler.enqueue(S.SETTLE_EVENT_TYPE, raidId, dueAt, { raidId }, S.settleKey(raidId),
      { tx, chained: true });
    if (!r || r.ok !== true) return { ok: false, reason: (r && r.reason) || "ENQUEUE_FAILED", stage: "settle" };
    return { ok: true };
  }

  function onArrival(tx, arrival) {
    try {
      if (stopped() || (C.metenoxEnabled !== true && !skyhookOn) || !arrival) return;
      if (!HOLD_STATES.includes(arrival.state) || !RAID_ROLES.includes(arrival.fleetRole)) return;
      if (!secClasses.includes(secClassOf(graphNow(), arrival.systemId))) return;
      const op = operationOf(tx, arrival.fleetId, arrival.systemId);
      if (!op.ok || !op.operation) return;
      const m = C.metenoxEnabled === true ? metenoxesIn(arrival.systemId) : { ok: true, list: [] };
      const hasMetenox = m.ok && m.list.length > 0;
      const sky = !hasMetenox && skyhookOn ? skyhooksIn(arrival.systemId) : null;
      if (!hasMetenox && !(sky && sky.ok && sky.list.length > 0)) return;
      const r = scheduler.enqueue(S.CHECK_EVENT_TYPE, String(arrival.systemId), arrival.at, { systemId:
        arrival.systemId, at: arrival.at, triggerFleetId: arrival.fleetId },
      S.arrivalCheckKey(arrival.systemId, arrival.fleetId, arrival.legSeq), { tx, chained: true });
      if (!r || r.ok !== true) bump("enqueueRefused");
    } catch (_err) {
      bump("enqueueRefused");
    }
  }

  function readCheck(tx, p, candidates) {
    const op = operationOf(tx, p.triggerFleetId, p.systemId);
    if (!op.ok) return op;
    if (!op.operation) return { ok: true, operation: null };
    const fl = readFleets(tx, p.systemId);
    if (!fl.ok) return fl;
    const total = raids.countOpen(tx);
    if (!total.ok) return total;
    const byFaction = raids.countOpen(tx, { attackerFactionId: op.operation.factionId });
    if (!byFaction.ok) return byFaction;
    const sieged = siegedIn(tx);
    if (!sieged.ok) return sieged;
    const perTarget = new Map();
    const lastOwner = new Map();
    for (const s of candidates) {
      const last = raids.getLastByTarget(tx, s.kind, s.id);
      if (!last.ok) return last;
      if (!lastOwner.has(s.ownerCorpId)) {
        const o = raids.getLastOwnerStart(tx, s.ownerCorpId);
        if (!o.ok) return o;
        lastOwner.set(s.ownerCorpId, o.startedAt);
      }
      perTarget.set(`${s.kind}:${s.id}`, { openOnTarget: Boolean(last.raid && last.raid.open),
        lastTargetEndedAt: last.raid && isTime(last.raid.endedAt) ? last.raid.endedAt : null });
    }
    return { ok: true, operation: op.operation, fleets: fl.fleets, openTotal: total.count,
      openByFaction: byFaction.count, sieged: sieged.ids, perTarget, lastOwner };
  }

  function startEffect(tx, start) {
    const open = raids.getOpenByTarget(tx, start.targetKind, start.targetId);
    if (!open.ok) return open;
    if (open.raid) return { ok: true, started: false, reason: "BUSY" };
    const total = raids.countOpen(tx);
    if (!total.ok) return total;
    const byFaction = raids.countOpen(tx, { attackerFactionId: start.attackerFactionId });
    if (!byFaction.ok) return byFaction;
    if (total.count >= C.maxOpen || byFaction.count >= C.maxOpenPerFaction) {
      return { ok: true, started: false, reason: "LIMIT" };
    }
    const created = raids.createRaid(tx, start);
    if (!created.ok) return created;
    if (created.duplicate) return { ok: true, started: false, reason: "DUPLICATE" };
    if (C.pruneBatch > 0) {
      const pruned = raids.pruneEnded(tx, { before: Math.max(0, start.at - C.retentionMs), limit: C.pruneBatch });
      if (!pruned.ok) return pruned;
    }
    const e = enqueueStep(tx, start.raidId, 0, 1, start.firstStepAt);
    if (!e.ok) return e;
    return { ok: true, started: true, raidId: start.raidId, targetId: start.targetId, systemId: start.systemId,
      attackerFactionId: start.attackerFactionId, ownerCorpId: start.ownerCorpId };
  }

  function onCheck(ev) {
    try {
      const p = parseCheckPayload(ev && ev.payload);
      if (!p) return { ok: false, reason: "HARVEST_RAID_PAYLOAD_INVALID", permanent: true };
      if (stopped()) return { ok: false, reason: "HARVEST_RAID_STOPPED" };
      const graph = graphNow();
      if (!graph) return { ok: false, reason: "GRAPH_NOT_READY" };
      const at = ev.dueAt;
      const noStart = (reason) => ({ ok: true, outcome: reason, onCommitted: () => {
        bump("checks");
        bump(NO_START_COUNTER[reason] || "noTarget");
      } });
      if (C.metenoxEnabled !== true && !skyhookOn) return noStart("NO_TARGET");
      if (!noticesRunning()) return noStart("NOTICES_OFF");
      const secClass = secClassOf(graph, p.systemId);
      if (!secClasses.includes(secClass)) return noStart("SEC_CLASS");
      const m = C.metenoxEnabled === true ? metenoxesIn(p.systemId) : { ok: true, list: [] };
      if (!m.ok) return { ok: false, reason: String(m.reason || "INDEX_FAILED") };
      let skys = [];
      if (skyhookOn) {
        const sky = skyhooksIn(p.systemId);
        if (sky.ok) skys = sky.list;
        else if (m.list.length === 0) return { ok: false, reason: String(sky.reason || "INDEX_FAILED") };
        else {
          lastRefusal = String(sky.reason || "INDEX_FAILED");
          bump("seamRefused");
        }
      }
      if (m.list.length === 0 && skys.length === 0) return noStart("NO_TARGET");
      const candidates = [...m.list.map((s) => ({ kind: S.KIND_METENOX, id: s.structureId, ownerCorpId: s.ownerCorpId })),
        ...skys.map((s) => ({ kind: S.KIND_SKYHOOK, id: s.skyhookId, ownerCorpId: s.corpId }))];
      const tx = store.transaction("hraid.checkRead", (db) => readCheck(db, p, candidates));
      if (!tx.ok) return { ok: false, reason: tx.reason || "TX_FAILED" };
      const read = tx.value;
      if (!read || !read.ok) return { ok: false, reason: (read && read.reason) || "HARVEST_RAID_READ_FAILED" };
      if (!read.operation) return noStart("NO_OPERATION");
      const factionId = read.operation.factionId;
      const hold = holdOf(read.fleets, factionId, isHostileFaction, groups);
      const perOf = (kind, id) => read.perTarget.get(`${kind}:${id}`) || { openOnTarget: false, lastTargetEndedAt: null };
      const common = (ownerCorpId, virtualOwner) => ({ at, secClass, secClasses, operation: read.operation,
        hostile: !virtualOwner && hostileOf(ownerCorpId, factionId), ownerOnline: onlineOf(ownerCorpId, at),
        lastOwnerStartedAt: read.lastOwner.has(ownerCorpId) ? read.lastOwner.get(ownerCorpId) : null,
        openTotal: read.openTotal, openByFaction: read.openByFaction, attackerShips: hold.attackerShips, params });
      const startOf = (start) => ({ ok: true, outcome: "START", effect: (etx) => startEffect(etx, start),
        onCommitted: (v) => {
          bump("checks");
          if (!v || v.started !== true) {
            bump("stale");
            return;
          }
          bump("started");
          bump("warned");
          setOpen(openCount + 1);
          log(`harvestRaid: ${v.raidId} WARNED structure=${v.targetId} system=${v.systemId} attacker=`
            + `${v.attackerFactionId} owner=${v.ownerCorpId}`);
        } });
      let refusal = "NO_TARGET";
      for (const s of m.list) {
        const bay = seamCall(bays, "readMetenoxBay", s.structureId, { maxLines: C.maxBayLines });
        if (!bay.ok) {
          if (bay.reason !== "NOT_FOUND" && bay.reason !== "NOT_METENOX") {
            lastRefusal = String(bay.reason || "SEAM_ERROR");
            bump("seamRefused");
          }
          continue;
        }
        const st = bay.structure;
        if (st.systemId !== p.systemId) continue;
        const loss = planMetenoxLoss({ lines: bay.lines, ownerCorpId: st.ownerCorpId, lossPermille: C.lossPermille,
          maxLossVolumeM3: C.maxLossVolumeM3, maxPlanLines: C.maxPlanLines });
        const per = perOf(S.KIND_METENOX, s.structureId);
        const virtualOwner = virtualOf(st.ownerCorpId);
        const plan = planRaidStart({ ...common(st.ownerCorpId, virtualOwner), target: { ...st, virtualOwner },
          siegeOpen: read.sieged.has(s.structureId), openOnTarget: per.openOnTarget,
          lastTargetEndedAt: per.lastTargetEndedAt, lootVolumeM3: loss.ok ? loss.volumeM3 : 0 });
        if (plan.start) return startOf(plan.start);
        refusal = plan.reason;
      }
      for (const s of skys) {
        const r = seamCall(skyhooks, "readSkyhook", s.skyhookId, { nowMs: at });
        if (!r.ok) {
          if (r.reason !== SKYHOOK_NOT_FOUND) {
            lastRefusal = String(r.reason || "SEAM_ERROR");
            bump("seamRefused");
          }
          continue;
        }
        const sk = r.skyhook;
        if (sk.systemId !== p.systemId) continue;
        const loss = planSkyhookLoss({ unsecured: sk.unsecured, lossPermille: C.skyhookLossPermille,
          maxPlanLines: C.maxPlanLines });
        const per = perOf(S.KIND_SKYHOOK, sk.skyhookId);
        const virtualOwner = virtualOf(sk.corpId);
        const plan = planRaidStart({ ...common(sk.corpId, virtualOwner),
          target: { kind: S.KIND_SKYHOOK, structureId: sk.skyhookId, systemId: sk.systemId, ownerCorpId: sk.corpId,
            destroyed: sk.destroyed, active: sk.active, raidState: sk.raidState, busy: sk.busy, virtualOwner },
          window: windowOf(sk, at), siegeOpen: false, openOnTarget: per.openOnTarget,
          lastTargetEndedAt: per.lastTargetEndedAt, lootUnits: loss.ok ? loss.units : 0,
          lootVolumeM3: loss.ok ? loss.volumeM3 : 0 });
        if (plan.start) return startOf(plan.start);
        refusal = plan.reason;
      }
      return noStart(refusal);
    } catch (err) {
      return { ok: false, reason: `HARVEST_RAID_CHECK_FAILED: ${messageOf(err)}` };
    }
  }

  function readStep(tx, p) {
    const g = raids.getRaid(tx, p.raidId);
    if (!g.ok) return g;
    const raid = g.raid;
    if (!raid || raid.open !== true || raid.phaseSeq !== p.phaseSeq || raid.version !== p.round
      || (raid.state !== S.WARNED && raid.state !== S.RAIDING)) return { ok: true, raid: null };
    const fl = readFleets(tx, raid.systemId);
    if (!fl.ok) return fl;
    const sieged = siegedIn(tx);
    if (!sieged.ok) return sieged;
    const hold = holdOf(fl.fleets, raid.attackerFactionId, isHostileFaction, groups);
    return { ok: true, raid, hold, siegeOpen: sieged.ids.has(raid.targetId) };
  }

  function targetNow(raid, at) {
    if (raid.targetKind === S.KIND_SKYHOOK) {
      const s = seamCall(skyhooks, "readSkyhook", raid.targetId, { nowMs: at });
      if (s.ok) {
        const sk = s.skyhook;
        return { ok: true, target: { destroyed: sk.destroyed, ownerCorpId: sk.corpId, active: sk.active },
          window: windowOf(sk, at), skyhook: sk };
      }
      if (s.reason === SKYHOOK_NOT_FOUND) return { ok: true, target: null, window: null };
      return s;
    }
    const structureId = raid.targetId;
    const r = seamCall(bays, "readMetenoxBay", structureId, { maxLines: 0 });
    if (r.ok) return { ok: true, target: { destroyed: r.structure.destroyed, ownerCorpId: r.structure.ownerCorpId } };
    if (r.reason === "NOT_FOUND" || r.reason === "NOT_METENOX") return { ok: true, target: null };
    return r;
  }

  function stepEffect(tx, raidSeen, d, at, planJson) {
    const g = raids.getRaid(tx, raidSeen.raidId);
    if (!g.ok) return g;
    const raid = g.raid;
    if (!raid || raid.open !== true || raid.version !== raidSeen.version || raid.state !== raidSeen.state) {
      return { ok: true, stale: true };
    }
    const base = { ok: true, stale: false, action: d.action, raidId: raid.raidId, targetId: raid.targetId,
      systemId: raid.systemId, attackerFactionId: raid.attackerFactionId, ownerCorpId: raid.ownerCorpId,
      credited: d.credited === true };
    if (d.action === "SAMPLE") {
      const s = raids.sample(tx, { raid, creditedMs: d.creditedMs, lastSampleAt: d.lastSampleAt, at });
      if (!s.ok) return s;
      const e = enqueueStep(tx, raid.raidId, raid.phaseSeq, s.version, d.dueAt);
      return e.ok ? base : e;
    }
    const patch = d.action === "END" ? { endedAt: at, endReason: d.reason }
      : { creditedMs: d.creditedMs, lastSampleAt: d.lastSampleAt, ...(d.action === "SETTLE" ? { planJson } : {}) };
    const t = raids.transition(tx, { raid, to: d.to, at, patch });
    if (!t.ok) return t;
    if (t.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", detail: S.transitionKey(raid.raidId,
      raid.phaseSeq) };
    if (d.action === "ADVANCE") {
      const e = enqueueStep(tx, raid.raidId, t.raid.phaseSeq, t.raid.version, d.dueAt);
      return e.ok ? { ...base, to: d.to } : e;
    }
    if (d.action === "SETTLE") {
      const e = enqueueSettle(tx, raid.raidId, at);
      return e.ok ? { ...base, to: d.to } : e;
    }
    return { ...base, to: d.to, reason: d.reason };
  }

  function onStepCommitted(v) {
    if (!v || v.ok !== true) return;
    if (v.stale === true) {
      bump("stale");
      return;
    }
    if (v.action === "SAMPLE") {
      bump("samples");
      return;
    }
    if (v.action === "ADVANCE") {
      bump("advanced");
      log(`harvestRaid: ${v.raidId} RAIDING structure=${v.targetId} system=${v.systemId}`);
      return;
    }
    if (v.action === "SETTLE") {
      log(`harvestRaid: ${v.raidId} SETTLING structure=${v.targetId} system=${v.systemId}`);
      return;
    }
    if (v.action !== "END") return;
    bump(END_COUNTER[v.to]);
    if (v.reason === WINDOW_CLOSED) bump("skyhookWindowClosed");
    setOpen(openCount - 1);
    log(`harvestRaid: ${v.raidId} ${v.to} ${v.reason} structure=${v.targetId} system=${v.systemId} attacker=`
      + `${v.attackerFactionId} owner=${v.ownerCorpId}`);
  }

  function onStep(ev) {
    try {
      const p = parseStepPayload(ev && ev.payload);
      if (!p) return { ok: false, reason: "HARVEST_RAID_PAYLOAD_INVALID", permanent: true };
      if (stopped()) return { ok: false, reason: "HARVEST_RAID_STOPPED" };
      const at = ev.dueAt;
      const tx = store.transaction("hraid.stepRead", (db) => readStep(db, p));
      if (!tx.ok) return { ok: false, reason: tx.reason || "TX_FAILED" };
      const read = tx.value;
      if (!read || !read.ok) return { ok: false, reason: (read && read.reason) || "HARVEST_RAID_READ_FAILED" };
      if (!read.raid) return { ok: true, outcome: "STALE", onCommitted: () => bump("stale") };
      const raid = read.raid;
      const defer = (reason) => {
        lastRefusal = String(reason || "SEAM_ERROR");
        bump("seamRefused");
        return { ok: false, reason: lastRefusal, deferUntil: now() + C.sampleMs };
      };
      const tn = at >= raid.wallDeadlineAt ? { ok: true, target: null } : targetNow(raid, at);
      if (!tn.ok) return defer(tn.reason);
      const online = onlineOf(raid.ownerCorpId, at);
      const d = decideRaidStep(raid, { at, ownerOnline: online,
        attackerShips: read.hold.attackerShips, engaged: read.hold.engaged === true, target: tn.target,
        siegeOpen: read.siegeOpen, window: tn.window || null, params });
      if (d.action === "STALE") return { ok: true, outcome: "STALE", onCommitted: () => bump("stale") };
      let planJson = null;
      if (d.action === "SETTLE" && raid.targetKind === S.KIND_SKYHOOK) {
        const sk = tn.skyhook;
        if (sk.raidState !== RAID_READY || sk.generation === null) {
          return defer(sk.generation === null && sk.raidState === RAID_READY ? "SKYHOOK_RAID_NO_GENERATION"
            : `SKYHOOK_RAID_${String(sk.raidState).toUpperCase()}`);
        }
        const loss = planSkyhookLoss({ unsecured: sk.unsecured, lossPermille: C.skyhookLossPermille,
          maxPlanLines: C.maxPlanLines });
        if (!loss.ok) return { ok: false, reason: `HARVEST_RAID_PLAN_${loss.reason}`, deferUntil: now() + C.sampleMs };
        planJson = JSON.stringify({ generation: sk.generation, lines: loss.plan.map((l) => ({ typeId: l.typeId,
          units: l.units, unitVolume: l.unitVolume })) });
      } else if (d.action === "SETTLE") {
        const bay = seamCall(bays, "readMetenoxBay", raid.targetId, { maxLines: C.maxBayLines });
        if (!bay.ok) return defer(bay.reason);
        const loss = planMetenoxLoss({ lines: bay.lines, ownerCorpId: raid.ownerCorpId, lossPermille: C.lossPermille,
          maxLossVolumeM3: C.maxLossVolumeM3, maxPlanLines: C.maxPlanLines });
        if (!loss.ok) return { ok: false, reason: `HARVEST_RAID_PLAN_${loss.reason}`, deferUntil: now() + C.sampleMs };
        planJson = JSON.stringify(loss.plan.map((l) => ({ itemId: l.itemId, typeId: l.typeId, units: l.units })));
      }
      return { ok: true, outcome: d.action, effect: (etx) => {
        const r = stepEffect(etx, raid, d, at, planJson);
        if (!r || r.ok !== true) lastRefusal = String((r && r.reason) || "STEP_FAILED");
        return r;
      }, onCommitted: (v) => {
        if (v && v.ok === true && v.stale !== true && v.action !== "END" && !online) bump("ownerOffline");
        onStepCommitted(v);
      } };
    } catch (err) {
      return { ok: false, reason: `HARVEST_RAID_STEP_FAILED: ${messageOf(err)}` };
    }
  }

  function runLines(raid, plan, receiptsOnly) {
    const taken = [];
    const pending = [];
    let zero = 0;
    let duplicates = 0;
    let ambiguous = 0;
    let volumeM3 = 0;
    for (const line of plan) {
      if (!receiptsOnly) {
        const r = seamCall(bays, "takeMetenoxLine", { raidId: raid.raidId, itemId: line.itemId, typeId: line.typeId,
          units: line.units, structureId: raid.targetId, ownerCorpId: raid.ownerCorpId });
        if (r.ok === true) {
          taken.push({ typeId: line.typeId, units: line.units });
          if (r.duplicate === true) duplicates += 1;
          if (Number.isFinite(r.volumeM3)) volumeM3 += r.volumeM3;
          continue;
        }
        if (r.permanent === true) {
          zero += 1;
          continue;
        }
        ambiguous += 1;
      }
      const rc = seamCall(bays, "readTakeReceipt", { raidId: raid.raidId, itemId: line.itemId });
      if (rc.ok === true && rc.found === true) taken.push({ typeId: line.typeId, units: line.units });
      else if (rc.ok === true && receiptsOnly) zero += 1;
      else pending.push(line);
    }
    return { taken, pending, zero, duplicates, ambiguous, volumeM3 };
  }

  function runSkyhook(raid, plan, receiptsOnly) {
    const out = { taken: [], pending: [], zero: 0, duplicates: 0, ambiguous: 0, volumeM3: 0, busy: 0,
      generationChanged: 0 };
    if (!plan || plan.lines.length === 0) return out;
    const volumeOf = (taken) => taken.reduce((sum, t) => {
      const line = plan.lines.find((l) => l.typeId === t.typeId);
      return sum + (line ? t.units * line.unitVolume : 0);
    }, 0);
    const takenOf = (list) => (Array.isArray(list) ? list.filter((t) => isPlain(t) && isId(t.typeId) && isId(t.units))
      .map((t) => ({ typeId: t.typeId, units: t.units })) : []);
    if (!receiptsOnly) {
      const r = seamCall(skyhooks, "stealSkyhookReagents", { skyhookId: raid.targetId, raidId: raid.raidId,
        generation: plan.generation, lines: plan.lines.map((l) => ({ typeId: l.typeId, units: l.units })),
        nowMs: now() });
      if (typeof r.writeMs === "number" && Number.isFinite(r.writeMs)) {
        metric("gauge", "harvestRaid.skyhookWriteMs", r.writeMs);
      }
      if (r.ok === true) {
        out.taken = takenOf(r.taken);
        if (r.duplicate === true) out.duplicates = 1;
        out.volumeM3 = volumeOf(out.taken);
        return out;
      }
      lastRefusal = String(r.reason || "SEAM_ERROR");
      if (r.permanent === true) {
        out.zero = plan.lines.length;
        if (r.reason === SKYHOOK_GENERATION_CHANGED) out.generationChanged = 1;
        return out;
      }
      if (r.reason === SKYHOOK_BUSY) out.busy = 1;
      else out.ambiguous = 1;
      out.pending = [...plan.lines];
      return out;
    }
    const rc = seamCall(skyhooks, "readSkyhookTheft", { skyhookId: raid.targetId, raidId: raid.raidId });
    if (rc.ok === true && rc.found === true) {
      if (!Array.isArray(rc.taken)) out.ambiguous = 1;
      out.taken = takenOf(rc.taken);
      out.volumeM3 = volumeOf(out.taken);
    } else if (rc.ok === true) out.zero = plan.lines.length;
    else out.pending = [...plan.lines];
    return out;
  }

  function settleEffect(tx, raidSeen, at, out, reason) {
    const g = raids.getRaid(tx, raidSeen.raidId);
    if (!g.ok) return g;
    const raid = g.raid;
    if (!raid || raid.state !== S.SETTLING || raid.version !== raidSeen.version) return { ok: true, stale: true };
    const loss = lossOf(out.taken);
    const t = raids.transition(tx, { raid, to: S.SETTLED, at, loss, patch: { endedAt: at, endReason: reason,
      lossJson: JSON.stringify(loss) } });
    if (!t.ok) return t;
    if (t.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", detail: S.transitionKey(raid.raidId,
      raid.phaseSeq) };
    return { ok: true, stale: false, raidId: raid.raidId, targetId: raid.targetId, systemId: raid.systemId,
      targetKind: raid.targetKind, lossUnits: loss.reduce((n, l) => n + l.units, 0), lines: loss.length };
  }

  function onSettleCommitted(out) {
    return (v) => {
      if (!v || v.ok !== true) return;
      bump("receiptDuplicates", out.duplicates);
      bump("vendorAmbiguous", out.ambiguous);
      bump("linesZero", out.zero);
      bump("skyhookBusy", out.busy || 0);
      bump("skyhookGenerationChanged", out.generationChanged || 0);
      if (v.stale === true) {
        bump("stale");
        return;
      }
      bump("settled");
      bump("lossUnits", v.lossUnits);
      if (v.targetKind === S.KIND_SKYHOOK) bump("skyhookTheftUnits", v.lossUnits);
      bump("lossVolumeM3", Math.round(out.volumeM3));
      setOpen(openCount - 1);
      log(`harvestRaid: ${v.raidId} SETTLED structure=${v.targetId} system=${v.systemId} units=${v.lossUnits} `
        + `types=${v.lines}`);
    };
  }

  function onSettle(ev) {
    try {
      const p = parseSettlePayload(ev && ev.payload);
      if (!p) return { ok: false, reason: "HARVEST_RAID_PAYLOAD_INVALID", permanent: true };
      if (stopped()) return { ok: false, reason: "HARVEST_RAID_STOPPED" };
      const tx = store.transaction("hraid.settleRead", (db) => raids.getRaid(db, p.raidId));
      if (!tx.ok) return { ok: false, reason: tx.reason || "TX_FAILED" };
      const read = tx.value;
      if (!read || !read.ok) return { ok: false, reason: (read && read.reason) || "HARVEST_RAID_READ_FAILED" };
      const raid = read.raid;
      if (!raid || raid.state !== S.SETTLING) return { ok: true, outcome: "STALE", onCommitted: () => bump("stale") };
      const skyhook = raid.targetKind === S.KIND_SKYHOOK;
      const skyPlan = skyhook ? skyhookPlanOf(raid) : null;
      const out = skyhook ? runSkyhook(raid, skyPlan, false) : runLines(raid, planOf(raid) || [], false);
      const at = ev.dueAt;
      if (out.pending.length > 0) {
        const deadline = raid.updatedAt + C.settleWallMs;
        const t = now();
        if (t < deadline) {
          lastRefusal = out.busy > 0 ? SKYHOOK_BUSY : "VENDOR_UNCERTAIN";
          bump("vendorAmbiguous", out.ambiguous);
          bump("skyhookBusy", out.busy || 0);
          return { ok: false, reason: "HARVEST_RAID_VENDOR_UNCERTAIN", deferUntil: Math.min(t + C.sampleMs,
            deadline) };
        }
        if (skyhook) {
          const late = runSkyhook(raid, skyPlan, true);
          out.taken = late.taken;
          out.volumeM3 = late.volumeM3;
          out.ambiguous += late.ambiguous;
          out.zero += late.zero + late.pending.length;
          out.pending = [];
        } else {
          out.zero += out.pending.length;
        }
      }
      const reason = out.taken.length > 0 ? "TAKEN" : "NOTHING_TAKEN";
      return { ok: true, outcome: "SETTLED", effect: (etx) => settleEffect(etx, raid, at, out, reason),
        onCommitted: onSettleCommitted(out) };
    } catch (err) {
      return { ok: false, reason: `HARVEST_RAID_SETTLE_FAILED: ${messageOf(err)}` };
    }
  }

  function listOpen(tx, opts) {
    if (stopped()) return { ok: false, reason: "HARVEST_RAID_UNAVAILABLE", detail: "stopped" };
    if (!tx || tx.inTransaction !== true) return { ok: false, reason: "TX_REQUIRED" };
    const limit = opts && Number.isSafeInteger(opts.limit) && opts.limit >= 0 ? opts.limit : C.maxOpen;
    return raids.listOpen(tx, { limit });
  }

  function readTargetsForFaction(tx, factionId, opts) {
    if (stopped()) return { ok: false, reason: "HARVEST_RAID_UNAVAILABLE", detail: "stopped" };
    if (!tx || tx.inTransaction !== true) return { ok: false, reason: "TX_REQUIRED" };
    if (!isId(factionId) || !opts || !(opts.systems instanceof Set || Array.isArray(opts.systems))) {
      return { ok: false, reason: "INVALID_INPUT" };
    }
    const at = isTime(opts.at) ? opts.at : now();
    const limit = Number.isSafeInteger(opts.limit) && opts.limit >= 0 ? opts.limit : C.maxTargetsReadPerReview;
    const mine = raids.countOpen(tx, { attackerFactionId: factionId });
    if (!mine.ok) return mine;
    const none = { ok: true, open: mine.count, targets: [], truncated: false };
    const metenoxOn = C.metenoxEnabled === true;
    if (mine.count > 0 || limit === 0 || (!metenoxOn && !skyhookOn) || !isActive(factionId)) return none;
    const total = raids.countOpen(tx);
    if (!total.ok) return total;
    if (total.count >= C.maxOpen || mine.count >= C.maxOpenPerFaction) return none;
    const graph = graphNow();
    if (!graph) return { ok: false, reason: "GRAPH_NOT_READY" };
    const reach = opts.systems instanceof Set ? opts.systems : new Set(opts.systems);
    const inScope = (id) => reach.has(id) && secClasses.includes(secClassOf(graph, id));
    let index = { ok: true, bySystem: new Map(), truncated: false };
    if (metenoxOn) {
      index = seamCall(structures, "listCandidates", { nowMs: now(), ttlMs: PS.indexTtlMs,
        families: [REFINERY_FAMILY], maxStructures: PS.maxIndexStructures });
      if (!index.ok || !(index.bySystem instanceof Map)) {
        return { ok: false, reason: String((index.ok ? "INDEX_FAILED" : index.reason) || "INDEX_FAILED") };
      }
    }
    const systems = [...index.bySystem.keys()].filter(inScope).sort((a, b) => a - b);
    let sky = { ok: true, bySystem: new Map(), truncated: false };
    if (skyhookOn) {
      sky = skyIndexNow();
      if (!sky.ok) {
        lastRefusal = String(sky.reason || "INDEX_FAILED");
        sky = { ok: true, bySystem: new Map(), truncated: false };
      }
    }
    const skySystems = [...sky.bySystem.keys()].filter(inScope).sort((a, b) => a - b);
    if (systems.length === 0 && skySystems.length === 0) return none;
    const sieged = metenoxOn ? siegedIn(tx) : { ok: true, ids: new Set() };
    if (!sieged.ok) return sieged;
    const owners = new Map();
    const targets = [];
    let reads = 0;
    let truncated = index.truncated === true || sky.truncated === true;
    const ownerOk = (ownerCorpId) => {
      if (owners.has(ownerCorpId)) return owners.get(ownerCorpId);
      let ok = !virtualOf(ownerCorpId);
      if (ok) {
        const o = raids.getLastOwnerStart(tx, ownerCorpId);
        if (!o.ok) return o;
        ok = !(isTime(o.startedAt) && at - o.startedAt < C.ownerCooldownMs);
      }
      ok = ok && hostileOf(ownerCorpId, factionId) && onlineOf(ownerCorpId, at);
      owners.set(ownerCorpId, ok);
      return ok;
    };
    for (const systemId of systems) {
      const list = (index.bySystem.get(systemId) || []).filter((s) => s && s.typeId === S.METENOX_TYPE_ID
        && isId(s.structureId) && isId(s.ownerCorpId)).sort((a, b) => a.structureId - b.structureId);
      for (const s of list) {
        if (targets.length >= limit || reads >= C.maxTargetsReadPerReview) {
          truncated = true;
          break;
        }
        if (sieged.ids.has(s.structureId)) continue;
        const last = raids.getLastByTarget(tx, S.KIND_METENOX, s.structureId);
        if (!last.ok) return last;
        if (last.raid && (last.raid.open === true || (isTime(last.raid.endedAt)
          && at - last.raid.endedAt < C.targetCooldownMs))) continue;
        const owner = ownerOk(s.ownerCorpId);
        if (owner !== true) {
          if (owner && owner.ok === false) return owner;
          continue;
        }
        reads += 1;
        const bay = seamCall(bays, "readMetenoxBay", s.structureId, { maxLines: C.maxBayLines });
        if (!bay.ok || !bay.structure || bay.structure.systemId !== systemId || bay.structure.destroyed === true
          || bay.structure.ownerCorpId !== s.ownerCorpId) continue;
        const loss = planMetenoxLoss({ lines: bay.lines, ownerCorpId: s.ownerCorpId, lossPermille: C.lossPermille,
          maxLossVolumeM3: C.maxLossVolumeM3, maxPlanLines: C.maxPlanLines });
        const volume = loss.ok ? loss.volumeM3 : 0;
        if (!(volume > 0) || volume < C.minLootVolumeM3) continue;
        targets.push({ targetKind: S.KIND_METENOX, targetId: s.structureId, systemId, ownerCorpId: s.ownerCorpId,
          lootVolumeM3: volume });
      }
      if (targets.length >= limit || reads >= C.maxTargetsReadPerReview) {
        if (systemId !== systems[systems.length - 1]) truncated = true;
        break;
      }
    }
    const budgetOver = () => targets.length >= limit || reads >= C.maxTargetsReadPerReview;
    for (const systemId of skySystems) {
      if (budgetOver()) {
        truncated = true;
        break;
      }
      for (const s of sky.bySystem.get(systemId) || []) {
        if (budgetOver()) {
          truncated = true;
          break;
        }
        const last = raids.getLastByTarget(tx, S.KIND_SKYHOOK, s.skyhookId);
        if (!last.ok) return last;
        if (last.raid && (last.raid.open === true || (isTime(last.raid.endedAt)
          && at - last.raid.endedAt < C.targetCooldownMs))) continue;
        const owner = ownerOk(s.corpId);
        if (owner !== true) {
          if (owner && owner.ok === false) return owner;
          continue;
        }
        reads += 1;
        const r = seamCall(skyhooks, "readSkyhook", s.skyhookId, { nowMs: at });
        if (!r.ok) continue;
        const sk = r.skyhook;
        if (sk.systemId !== systemId || sk.corpId !== s.corpId || sk.active !== true || sk.destroyed === true
          || sk.raidState !== RAID_READY || sk.busy === true) continue;
        const w = windowOf(sk, at);
        if (!w.open && !w.imminent) continue;
        const loss = planSkyhookLoss({ unsecured: sk.unsecured, lossPermille: C.skyhookLossPermille,
          maxPlanLines: C.maxPlanLines });
        if (!loss.ok || !(loss.units > 0) || loss.units < C.skyhookMinLootUnits) continue;
        targets.push({ targetKind: S.KIND_SKYHOOK, targetId: sk.skyhookId, systemId, ownerCorpId: sk.corpId,
          lootVolumeM3: loss.volumeM3 });
      }
    }
    return { ok: true, open: mine.count, targets, truncated };
  }

  const currentKeyOf = (r) => (r.state === S.SETTLING ? S.settleKey(r.raidId) : S.stepKey(r.raidId, r.phaseSeq,
    r.version));

  function specOf(r) {
    if (r.state === S.SETTLING) {
      return { eventType: S.SETTLE_EVENT_TYPE, aggregateId: r.raidId, dueAt: r.updatedAt, payload: { raidId: r.raidId },
        idempotencyKey: S.settleKey(r.raidId) };
    }
    return { eventType: S.STEP_EVENT_TYPE, aggregateId: r.raidId,
      dueAt: Math.min(r.lastSampleAt + C.sampleMs, Math.max(r.lastSampleAt, r.wallDeadlineAt)),
      payload: { raidId: r.raidId, phaseSeq: r.phaseSeq, round: r.version }, idempotencyKey: currentKeyOf(r) };
  }

  function lostStepEffect(tx, seen, at) {
    const g = raids.getRaid(tx, seen.raidId);
    if (!g.ok) return g;
    const raid = g.raid;
    if (!raid || raid.open !== true || raid.version !== seen.version) return { ok: true, stale: true };
    const t = raids.transition(tx, { raid, to: S.ABORTED, at, patch: { endedAt: at, endReason: STEP_LOST } });
    if (!t.ok) return t;
    return { ok: true, stale: t.duplicate === true };
  }

  function closeLost(list) {
    let closed = 0;
    for (const r of list) {
      const found = call(() => scheduler.findByKey(currentKeyOf(r)), null);
      if (!found || found.ok !== true || found.found !== true || !LOST_EVENT_STATES.includes(found.event.state)) {
        continue;
      }
      const at = Math.max(now(), r.updatedAt);
      let res;
      if (r.state === S.SETTLING) {
        const out = r.targetKind === S.KIND_SKYHOOK ? runSkyhook(r, skyhookPlanOf(r), true)
          : runLines(r, planOf(r) || [], true);
        out.zero += out.pending.length;
        const committed = onSettleCommitted(out);
        res = store.transaction("hraid.settleLost", (db) => settleEffect(db, r, at, out, STEP_LOST));
        if (res.ok && res.value && res.value.ok === true) committed(res.value);
      } else {
        res = store.transaction("hraid.stepLost", (db) => lostStepEffect(db, r, at));
        if (res.ok && res.value && res.value.ok === true && res.value.stale !== true) {
          bump("aborted");
          setOpen(openCount - 1);
        }
      }
      if (!res.ok || !res.value || res.value.ok !== true) {
        log(`harvestRaid: lost ${r.raidId} refused ${(res.value && res.value.reason) || res.reason || "TX_FAILED"}`);
        continue;
      }
      if (res.value.stale === true) continue;
      closed += 1;
      bump("stepLost");
      log(`harvestRaid: ${r.raidId} ${r.state} ${STEP_LOST} event=${found.event.state} structure=${r.targetId}`);
    }
    return { closed };
  }

  function reconcile() {
    try {
      if (stopped()) return { ok: false, reason: "HARVEST_RAID_UNAVAILABLE" };
      const all = [];
      let after = "";
      for (;;) {
        const t = store.transaction("hraid.reconcileRead", (db) => raids.listOpen(db, { limit: RECONCILE_CHUNK,
          afterRaidId: after }));
        const r = t.ok ? t.value : t;
        if (!r || !r.ok) return { ok: false, reason: (r && r.reason) || "TX_FAILED" };
        all.push(...r.raids);
        if (!r.truncated || r.raids.length === 0) break;
        after = r.raids[r.raids.length - 1].raidId;
      }
      setOpen(all.length);
      let enqueued = 0;
      let duplicates = 0;
      for (let i = 0; i < all.length; i += RECONCILE_CHUNK) {
        const e = scheduler.enqueueMany(all.slice(i, i + RECONCILE_CHUNK).map(specOf));
        if (!e || !e.ok) return { ok: false, reason: (e && e.reason) || "ENQUEUE_FAILED", enqueued, duplicates };
        enqueued += e.enqueued;
        duplicates += e.duplicates;
        if (e.refusal) {
          log(`harvestRaid: reconcile refused ${e.refusal.reason || "?"}`);
          break;
        }
      }
      bump("reconciled", enqueued);
      const lost = closeLost(all);
      return { ok: true, open: Math.max(0, all.length - lost.closed), enqueued, duplicates, lost: lost.closed };
    } catch (err) {
      return { ok: false, reason: `RECONCILE_FAILED: ${messageOf(err)}` };
    }
  }

  function getStatus() {
    return Object.freeze({ state, seq, mode: getMode(), open: openCount, counters: Object.freeze({ ...counters }),
      lastRefusal, skyhook: skyhookMode });
  }

  return Object.freeze({
    getMode,
    getStatus,
    onArrival,
    onCheck,
    onStep,
    onSettle,
    reconcile,
    listOpen,
    readTargetsForFaction,
    stop() {
      state = "stopped";
      seq += 1;
    },
    isStopped: stopped,
  });
}

module.exports = { createHarvestRaidService, parseCheckPayload, parseStepPayload, parseSettlePayload, listOf,
  COUNTER_NAMES, RAID_ROLES };
