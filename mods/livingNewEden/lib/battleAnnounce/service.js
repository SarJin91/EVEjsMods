"use strict";

const S = require("./schema");
const { departureDecision, etaOfOperation, selectRecipients, decideOutcome, attackerWonOf } = require("./rules");
const { etaLine, endLine } = require("./format");
const { TERMINAL_OPERATION_STATES } = require("../fleets/schema");
const { UNKNOWN } = require("../names/fallback");

const COUNTER_NAMES = Object.freeze(["listenerQueued", "listenerDuplicate", "listenerShortLead", "listenerRefused",
  "budgetPass", "announced", "recipientsQueued", "recipientsTruncated", "noRecipients", "presenceUnavailable", "capped",
  "tooLate", "dailyCapped", "sameTargetSkipped", "standingReadFailed", "checks", "closed", "endMailed", "endSilent",
  "pruned", "errors"]);
const ANNOUNCE_KEYS = Object.freeze(["factionId", "operationId", "operationType", "targetSystemId"]);
const LEGACY_ANNOUNCE_KEYS = Object.freeze(["etaAt", ...ANNOUNCE_KEYS]);
const CHECK_KEYS = Object.freeze(["operationId", "round"]);
const MAX_DETAIL = 120;

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isOpId = (v) => typeof v === "string" && v.length >= 1 && v.length <= S.MAX_OPERATION_ID;
const messageOf = (err) => String((err && err.message) || err).slice(0, MAX_DETAIL);
const exactKeys = (p, keys) => isPlain(p) && Object.keys(p).sort().join() === keys.join();

function parseAnnounce(p) {
  const legacy = exactKeys(p, LEGACY_ANNOUNCE_KEYS);
  if ((!legacy && !exactKeys(p, ANNOUNCE_KEYS)) || (legacy && !isTime(p.etaAt)) || !isOpId(p.operationId)
    || !isId(p.factionId) || !isId(p.targetSystemId) || typeof p.operationType !== "string"
    || p.operationType.length < 1 || p.operationType.length > S.MAX_OPERATION_TYPE) return null;
  return { operationId: p.operationId, targetSystemId: p.targetSystemId, factionId: p.factionId,
    operationType: p.operationType };
}

function parseCheck(p) {
  if (!exactKeys(p, CHECK_KEYS) || !isOpId(p.operationId) || !Number.isSafeInteger(p.round) || p.round < 0) return null;
  return p;
}

function createBattleAnnounceService(deps) {
  const { store, scheduler, fleetRepository, repo, settings: C, types } = deps;
  const clock = deps.clock;
  const nowMs = deps.nowMs;
  const names = deps.names instanceof Map ? deps.names : new Map();
  const telemetry = deps.telemetry || null;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
  const counters = Object.fromEntries(COUNTER_NAMES.map((n) => [n, 0]));
  let stopped = false;
  let lastRefusal = null;
  const budget = { seq: null, used: 0 };

  function metric(kind, name, value) {
    if (!telemetry || typeof telemetry[kind] !== "function") return;
    try {
      telemetry[kind](name, value);
    } catch (_err) {
    }
  }

  function bump(name, n = 1) {
    if (!(n > 0) || !Object.prototype.hasOwnProperty.call(counters, name)) return;
    counters[name] += n;
    metric("count", `battleAnnounce.${name}`, n);
  }

  function safe(fn, fallback) {
    try {
      return fn();
    } catch (_err) {
      return fallback;
    }
  }

  function noticesNow() {
    return safe(() => {
      const n = deps.notices();
      return n && typeof n.getStatus === "function" && n.getStatus().state === "running"
        && typeof n.enqueueItemsInTx === "function" ? n : null;
    }, null);
  }

  function graphNow() {
    return safe(() => {
      const g = deps.getGraph();
      if (!g || typeof g.getGraph !== "function") return null;
      const r = g.getGraph();
      return r && r.ok && r.graph ? r.graph : null;
    }, null);
  }

  function placeOf(graph, systemId) {
    const sys = safe(() => (graph && typeof graph.getSystem === "function" ? graph.getSystem(systemId) : null), null);
    const regionName = sys && sys.regionId != null && typeof graph.getRegionName === "function"
      ? safe(() => graph.getRegionName(sys.regionId), null) : null;
    return { systemName: sys && sys.name ? sys.name : UNKNOWN.system, regionName: regionName || null };
  }

  const nameOf = (id) => (isId(id) ? names.get(id) || null : null);

  function onDeparture(tx, d) {
    if (stopped || !d || d.operationId === null || d.operationId === undefined) return;
    try {
      const seq = store.getTxSeq();
      if (seq !== budget.seq) {
        budget.seq = seq;
        budget.used = 0;
      }
      if (budget.used >= C.maxAnnouncementsPerTransaction) {
        bump("budgetPass");
        lastRefusal = "BUDGET";
        return;
      }
      const op = fleetRepository.getOperation(tx, d.operationId);
      if (!op || op.ok !== true) {
        bump("listenerRefused");
        lastRefusal = String((op && op.reason) || "OPERATION_READ_FAILED");
        return;
      }
      const decision = departureDecision(d, op.operation, { types, minLeadMs: C.minLeadMs });
      if (!decision.announce) {
        if (decision.reason === "SHORT_LEAD") bump("listenerShortLead");
        return;
      }
      const o = op.operation;
      const payload = { operationId: o.operationId, targetSystemId: o.targetSystemId, factionId: o.factionId,
        operationType: o.operationType };
      const r = scheduler.enqueue(S.ANNOUNCE_EVENT, o.operationId, d.leg.departAt, payload,
        S.announceKeyOf(o.operationId), { tx, chained: d.chained === true });
      if (r && r.ok === true && r.duplicate !== true) {
        budget.used += 1;
        bump("listenerQueued");
        return;
      }
      if ((r && r.ok === true) || (r && r.reason === "IDEMPOTENCY_CONFLICT")) {
        bump("listenerDuplicate");
        return;
      }
      bump("listenerRefused");
      lastRefusal = String((r && r.reason) || "ENQUEUE_FAILED");
    } catch (err) {
      if (!tx || tx.inTransaction === false) throw err;
      bump("errors");
      lastRefusal = messageOf(err);
    }
  }

  function defenderOf(system, attacker) {
    if (!system) return null;
    const controller = isId(system.controllerFactionId) ? system.controllerFactionId : null;
    if (controller !== null && controller !== attacker) return controller;
    const occupier = isId(system.occupierFactionId) ? system.occupierFactionId : null;
    return controller === attacker && occupier !== null && occupier !== attacker ? occupier : null;
  }

  function readAnnounce(p) {
    const t0 = nowMs();
    const r = store.transaction("battleAnnounce.read", (db) => {
      const op = fleetRepository.getOperation(db, p.operationId);
      if (!op.ok) return op;
      if (!op.operation || TERMINAL_OPERATION_STATES.includes(op.operation.state)) return { ok: true, closed: true };
      const members = fleetRepository.listFleetsOfOperation(db, p.operationId);
      if (!members || members.ok !== true) {
        return { ok: false, reason: String((members && members.reason) || "FLEET_READ_FAILED") };
      }
      const etaAt = etaOfOperation(members.fleets, p.targetSystemId);
      if (etaAt === null) return { ok: true, closed: false, etaAt: null };
      const world = safe(() => deps.getWorldRepository(), null);
      let system = null;
      if (world && typeof world.getSystem === "function") {
        const s = world.getSystem(db, p.targetSystemId, { includeInfluence: false });
        system = s && s.ok ? s.system : null;
      }
      const open = repo.countOpenInTx(db);
      if (!open.ok) return open;
      return { ok: true, closed: false, etaAt, defender: defenderOf(system, p.factionId), open: open.open };
    });
    metric("observe", "battleAnnounce.readMs", Math.max(0, nowMs() - t0));
    if (!r || r.ok !== true) return { ok: false, reason: String((r && (r.reason || r.code)) || "TX_FAILED") };
    return r.value;
  }

  function onAnnounce(ev) {
    try {
      const p = parseAnnounce(ev && ev.payload);
      if (!p) return { ok: false, reason: "BATTLE_ANNOUNCE_PAYLOAD_INVALID", permanent: true };
      if (stopped) return { ok: false, reason: "BATTLE_ANNOUNCE_STOPPED" };
      const now = clock.now();
      const notices = noticesNow();
      if (!notices) return { ok: true, outcome: "NOTICES_UNAVAILABLE" };
      const read = readAnnounce(p);
      if (!read || read.ok !== true) return { ok: false, reason: String((read && read.reason) || "READ_FAILED") };
      if (read.closed) return { ok: true, outcome: "OP_CLOSED" };
      if (read.etaAt === null || read.etaAt - now < C.minLeadMs) {
        return { ok: true, outcome: "TOO_LATE", onCommitted: () => bump("tooLate") };
      }
      const etaAt = read.etaAt;
      if (read.open >= C.maxOpenWatches) return { ok: true, outcome: "CAPPED", onCommitted: () => bump("capped") };
      const graph = graphNow();
      const picked = selectRecipients({ graph, presence: safe(() => deps.getPresence(), null),
        readStanding: deps.readStanding, targetSystemId: p.targetSystemId, attackerFactionId: p.factionId,
        defenderFactionId: read.defender, settings: C });
      if (!picked.ok) {
        return { ok: true, outcome: "NO_PRESENCE", onCommitted: () => bump("presenceUnavailable") };
      }
      const standingFailed = picked.standingFailed;
      if (picked.characterIds.length === 0) {
        return { ok: true, outcome: "NO_RECIPIENTS", onCommitted: () => {
          bump("noRecipients");
          bump("standingReadFailed", standingFailed);
        } };
      }
      const place = placeOf(graph, p.targetSystemId);
      const line = etaLine({ attackerName: nameOf(p.factionId), defenderName: nameOf(read.defender),
        systemName: place.systemName, regionName: place.regionName, etaAt, now });
      const candidates = picked.characterIds;
      return {
        ok: true,
        outcome: "ANNOUNCED",
        effect: (tx) => announceEffect(tx, { ...p, etaAt }, read.defender, candidates, line, now, notices),
        onCommitted: (v) => {
          bump("standingReadFailed", standingFailed);
          if (picked.truncated) bump("recipientsTruncated");
          if (!v) return;
          bump("dailyCapped", v.dailyCapped || 0);
          bump("sameTargetSkipped", v.sameTarget || 0);
          if (v.announced) {
            bump("announced");
            bump("recipientsQueued", v.recipients);
          } else if (v.empty) bump("noRecipients");
        },
      };
    } catch (err) {
      bump("errors");
      lastRefusal = messageOf(err);
      return { ok: false, reason: "BATTLE_ANNOUNCE_THREW", detail: messageOf(err) };
    }
  }

  function announceEffect(tx, p, defender, candidates, line, now, notices) {
    const existing = repo.getInTx(tx, p.operationId);
    if (!existing.ok) return existing;
    if (existing.announcement) return { ok: true, duplicate: true };
    const op = fleetRepository.getOperation(tx, p.operationId);
    if (!op.ok) return op;
    if (!op.operation || TERMINAL_OPERATION_STATES.includes(op.operation.state)) return { ok: true, closed: true };
    const facts = repo.recipientFactsInTx(tx, { characterIds: candidates, since: Math.max(0, now - C.capWindowMs),
      targetSystemId: p.targetSystemId });
    if (!facts.ok) return facts;
    let dailyCapped = 0;
    let sameTarget = 0;
    const chosen = [];
    for (const cid of candidates) {
      if (facts.openSameTarget.has(cid)) sameTarget += 1;
      else if ((facts.dayCount.get(cid) || 0) >= C.maxPerCharacterPerDay) dailyCapped += 1;
      else chosen.push(cid);
    }
    if (chosen.length === 0) return { ok: true, empty: true, dailyCapped, sameTarget };
    const created = repo.createInTx(tx, { operationId: p.operationId, operationType: p.operationType,
      factionId: p.factionId, defenderFactionId: defender, targetSystemId: p.targetSystemId, etaAt: p.etaAt,
      announcedAt: now, characterIds: chosen });
    if (!created.ok) return created;
    const eventKey = S.noticeKeyOf(p.operationId, "eta");
    const items = chosen.map((characterId) => ({ eventKey, characterId, kind: S.KIND_ETA, systemId: p.targetSystemId,
      line, eventAt: now }));
    const q = notices.enqueueItemsInTx(tx, items, now);
    if (!q || q.ok !== true) return { ok: false, reason: String((q && q.reason) || "NOTICES_REFUSED") };
    const ev = scheduler.enqueue(S.CHECK_EVENT, p.operationId, Math.min(p.etaAt, now + C.checkIntervalMs),
      { operationId: p.operationId, round: 0 }, S.checkKeyOf(p.operationId, 0), { tx, chained: true });
    if (!ev || ev.ok !== true) return { ok: false, reason: String((ev && ev.reason) || "ENQUEUE_FAILED") };
    return { ok: true, announced: true, recipients: chosen.length, dailyCapped, sameTarget };
  }

  function battlesOf(tx, operation, announcedAt) {
    const battleRepo = safe(() => deps.getBattleRepository(), null);
    if (!operation || !battleRepo || typeof battleRepo.getByFleet !== "function") return { ok: true, battles: [] };
    const byId = new Map();
    for (const fleetId of operation.fleetIds || []) {
      const r = battleRepo.getByFleet(tx, fleetId, { limit: C.battleScanLimit });
      if (!r || r.ok !== true) return { ok: false, reason: String((r && r.reason) || "BATTLE_READ_FAILED") };
      for (const b of r.battles) if (b.createdAt >= announcedAt && !byId.has(b.battleId)) byId.set(b.battleId, b);
    }
    return { ok: true, battles: [...byId.values()] };
  }

  function prune(tx, now) {
    if (!(C.pruneBatch > 0)) return { ok: true, deleted: 0 };
    return repo.pruneInTx(tx, { before: Math.max(0, now - C.retentionMs), batch: C.pruneBatch });
  }

  function checkEffect(tx, p, now, notices) {
    const got = repo.getInTx(tx, p.operationId);
    if (!got.ok) return got;
    const a = got.announcement;
    if (!a || a.state !== S.STATE.OPEN || a.checkRound !== p.round) {
      const pr = prune(tx, now);
      return pr.ok ? { ok: true, stale: true, pruned: pr.deleted } : pr;
    }
    const op = fleetRepository.getOperation(tx, p.operationId);
    if (!op.ok) return op;
    const read = battlesOf(tx, op.operation, a.announcedAt);
    if (!read.ok) return read;
    const d = decideOutcome({ announcement: a, operation: op.operation, battles: read.battles, now, settings: C });
    if (!d.close) {
      const adv = repo.advanceRoundInTx(tx, { operationId: a.operationId, expectedVersion: a.version, now });
      if (!adv.ok) return adv;
      const next = p.round + 1;
      const ev = scheduler.enqueue(S.CHECK_EVENT, a.operationId, now + C.checkIntervalMs,
        { operationId: a.operationId, round: next }, S.checkKeyOf(a.operationId, next), { tx, chained: true });
      if (!ev || ev.ok !== true) return { ok: false, reason: String((ev && ev.reason) || "ENQUEUE_FAILED") };
      const pr = prune(tx, now);
      return pr.ok ? { ok: true, advanced: true, pruned: pr.deleted } : pr;
    }
    let mailed = 0;
    const wantMail = now - d.factAt <= C.staleAfterMs && (d.outcome !== S.OUTCOME.EXPIRED || C.mailOnExpired);
    if (wantMail) {
      const list = repo.listRecipientsInTx(tx, a.operationId, C.maxRecipientsPerAnnouncement);
      if (!list.ok) return list;
      if (list.characterIds.length > 0) {
        const battle = d.battleId === null ? null : read.battles.find((b) => b.battleId === d.battleId) || null;
        const graph = graphNow();
        const place = placeOf(graph, a.targetSystemId);
        const line = endLine({ outcome: d.outcome,
          attackerWon: d.outcome === S.OUTCOME.SETTLED ? attackerWonOf(battle, a.factionId) : null,
          attackerName: nameOf(a.factionId), systemName: place.systemName, regionName: place.regionName });
        const eventKey = S.noticeKeyOf(a.operationId, "end");
        const items = list.characterIds.map((characterId) => ({ eventKey, characterId, kind: S.KIND_END,
          systemId: a.targetSystemId, line, eventAt: now }));
        const q = notices.enqueueItemsInTx(tx, items, now);
        if (!q || q.ok !== true) return { ok: false, reason: String((q && q.reason) || "NOTICES_REFUSED") };
        mailed = items.length;
      }
    }
    const closed = repo.closeInTx(tx, { operationId: a.operationId, expectedVersion: a.version, outcome: d.outcome,
      battleId: d.battleId, endMailed: mailed > 0, now });
    if (!closed.ok) return closed;
    const pr = prune(tx, now);
    if (!pr.ok) return pr;
    return { ok: true, closed: true, outcome: d.outcome, mailed, pruned: pr.deleted };
  }

  function onCheck(ev) {
    try {
      const p = parseCheck(ev && ev.payload);
      if (!p) return { ok: false, reason: "BATTLE_ANNOUNCE_PAYLOAD_INVALID", permanent: true };
      if (stopped) return { ok: false, reason: "BATTLE_ANNOUNCE_STOPPED" };
      const now = clock.now();
      const notices = noticesNow();
      if (!notices) return { ok: false, reason: "NOTICES_UNAVAILABLE", deferUntil: now + C.checkIntervalMs };
      return {
        ok: true,
        outcome: "CHECKED",
        effect: (tx) => checkEffect(tx, p, now, notices),
        onCommitted: (v) => {
          bump("checks");
          if (!v) return;
          bump("pruned", v.pruned || 0);
          if (!v.closed) return;
          bump("closed");
          if (v.mailed > 0) bump("endMailed");
          else bump("endSilent");
        },
      };
    } catch (err) {
      bump("errors");
      lastRefusal = messageOf(err);
      return { ok: false, reason: "BATTLE_ANNOUNCE_THREW", detail: messageOf(err) };
    }
  }

  return Object.freeze({
    onDeparture,
    onAnnounce,
    onCheck,
    getStatus: () => Object.freeze({ state: stopped ? "stopped" : "running", mode: "on", lastRefusal, ...counters }),
    isStopped: () => stopped,
    stop() {
      if (stopped) return;
      stopped = true;
      logger.log("battleAnnounce: stopped");
    },
  });
}

module.exports = { createBattleAnnounceService, COUNTER_NAMES };
