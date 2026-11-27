"use strict";

const { performance } = require("node:perf_hooks");
const S = require("./schema");
const { checkPlacement, checkLimits, checkKindLimits, checkFreeLimits } = require("./policy");
const { SENTRY_TYPE_IDS, defaultAmmoOfType, sentryTypeOfFaction, kindOfType, isPassiveKind, typeIdsOfKind,
  SENTRY_KINDS, sentryTypeOf } = require("../adapter/data/sentryTypes");
const { fingerprint } = require("../util/fingerprint");
const { planSentryBattle } = require("./battlePlan");
const { createSentryHostility } = require("./hostility");
const { SIEGE_ROLES } = require("../stations/siege/schema");
const { parseRef } = require("../stations/siege/gridScope");
const { gridOfRef } = require("../battle/gridContacts");
const { sentryGridScopeOf, sentryAnchorRef } = require("./gridScope");

const HIGHSEC = "highsec";
const MAX_DETAIL = 120;
const ARMED_PAGE = 500;
const RECONCILE_KEYS = "afterSentryId,bucket";
const COUNTER_NAMES = Object.freeze(["anchored", "anchorRefused", "anchorDuplicate", "vendorRefused", "adopted",
  "destroyed", "retired", "healed", "reconcilePasses", "seamRefused", "healDeferred", "vendorPartial",
  "factionRequested", "factionDeployed", "factionDeployFailed", "topUps",
  "receiptsPruned",
  "spawnFailed",
  "battleRounds", "battlesCreated", "battleObservedSkips",
  "battleDamageApplied", "battleKills", "battleDamageStale", "battleDamageRefused",
  "battleFortressSkipped",
  "battleTransitSkipped",
  "battleWorldBossSkipped",
  "battleGridFallback", "battleGridNoAnchor", "battleGridMiss", "gridArrivalQueued",
  "reconcileChainJoined",
  "postOwnerOffline", "kindRefused",
  "heavyAnchored",
  "freeAnchored",
  "lookRefused"]);
const DEFAULT_KIND = "sentry";
const POST_KIND = "listening_post";
const HEAVY_KIND = "heavy_sentry";
const SCENE_LOADED = "SENTRY_SCENE_LOADED";
const DEPLOY_KEYS = "sentryId";
const FEE_SUFFIX = ":sentry:fee";
const SCENE_NOT_LOADED = "SENTRY_SCENE_NOT_LOADED";
const METRIC_ACTIVE = "sentries.active";
const ATTRITION_KEYS = "round,systemId";
const ATTRITION_AGGREGATE = "world_system";
const STALE = "STALE";
const PERMILLE = 1000;

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const messageOf = (err) => String((err && err.message) || err).slice(0, MAX_DETAIL);
const refuse = (reason) => ({ ok: false, reason: String(reason) });

class Rollback {
  constructor(reason) {
    this.reason = String(reason || "REFUSED");
  }
}

function call(fn, fallback) {
  try {
    return fn();
  } catch (_err) {
    return fallback;
  }
}

function parseReconcilePayload(p) {
  if (!isPlain(p) || Object.keys(p).sort().join() !== RECONCILE_KEYS || !isTime(p.bucket)
    || typeof p.afterSentryId !== "string" || p.afterSentryId.length > S.MAX_ID_LENGTH) return null;
  return { bucket: p.bucket, afterSentryId: p.afterSentryId };
}

function parseAttritionPayload(p) {
  if (!isPlain(p) || Object.keys(p).sort().join() !== ATTRITION_KEYS || !isId(p.systemId) || !isTime(p.round)) {
    return null;
  }
  return { systemId: p.systemId, round: p.round };
}

function parseDeployPayload(p) {
  if (!isPlain(p) || Object.keys(p).sort().join() !== DEPLOY_KEYS || typeof p.sentryId !== "string"
    || !p.sentryId.startsWith("sf-") || p.sentryId.length > S.MAX_ID_LENGTH) return null;
  return { sentryId: p.sentryId };
}

function ringPosition(anchor, slot, settings) {
  const p = anchor.position;
  const ring = Math.min(Math.max(settings.ringDistanceM, settings.anchorMinDistanceM), settings.anchorMaxDistanceM);
  const r = Math.max(0, Number(anchor.radius) || 0) + ring;
  const angle = (2 * Math.PI * slot) / Math.max(1, settings.maxPerAnchor);
  return { x: p.x + r * Math.cos(angle), y: p.y, z: p.z + r * Math.sin(angle) };
}

function sessionInfo(session) {
  const s = session || {};
  const space = isPlain(s._space) ? s._space : {};
  const int = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0);
  return { characterId: int(s.characterID || s.charid),
    systemId: int(space.systemID) || int(s.solarsystemid2 || s.solarsystemid) };
}

function createSentryService(deps) {
  const { store, repository, seam, scheduler, config, clock } = deps;
  const C = config.sentries;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
  const telemetry = deps.telemetry || null;
  const limits = Object.freeze({ maxPerAnchor: C.maxPerAnchor, maxPerSystemPerOwner: C.player.maxPerSystemPerOwner,
    maxPerOwner: C.player.maxPerOwner, maxTotal: C.maxTotal });
  const LP = isPlain(config.listeningPost) ? config.listeningPost : { enabled: false };
  const postSecClasses = Object.freeze(String(LP.secClasses || "").split(",").map((s) => s.trim())
    .filter((s) => s !== ""));
  const postLimits = Object.freeze({ maxPerAnchor: C.maxPerAnchor, maxPerSystemPerOwner: LP.maxPerSystemPerOwner,
    maxPerOwner: LP.maxPerOwner, maxPerSystem: LP.maxPerSystem, maxTotal: C.maxTotal });
  const HV = isPlain(C.heavy) ? C.heavy : { enabled: false };
  const heavySecClasses = Object.freeze(String(HV.secClasses || "").split(",").map((s) => s.trim())
    .filter((s) => s !== ""));
  const heavyLimits = Object.freeze({ maxPerAnchor: C.maxPerAnchor, maxPerSystemPerOwner: HV.maxPerSystemPerOwner,
    maxPerOwner: HV.maxPerOwner, maxPerSystem: HV.maxPerSystem, maxTotal: C.maxTotal });
  const KIND_RULES = Object.freeze({
    [POST_KIND]: Object.freeze({ enabled: LP.enabled === true, secClasses: postSecClasses, limits: postLimits }),
    [HEAVY_KIND]: Object.freeze({ enabled: HV.enabled === true, secClasses: heavySecClasses, limits: heavyLimits }),
  });
  const kindRuleOf = (kind) => (own(KIND_RULES, kind) ? KIND_RULES[kind] : null);
  const freeOn = (kind) => C.player.freeEnabled === true
    && (kind === DEFAULT_KIND || (kind === HEAVY_KIND && HV.allowFree === true));
  const freeLimits = Object.freeze({ maxPerSystemPerOwner: C.player.freeMaxPerSystemPerOwner,
    maxPerOwner: C.player.freeMaxPerOwner });
  const freeClearanceM = () => Math.max(Number(C.player.freeClearanceM) || 0, C.anchorMinDistanceM);
  const counters = Object.fromEntries(COUNTER_NAMES.map((n) => [n, 0]));
  const armed = new Map();
  const refs = new Map();
  const bySystem = new Map();
  const healedMarks = new Map();
  const F = C.faction && typeof C.faction === "object" ? C.faction : { enabled: false };
  const factionOn = () => F.enabled === true && !stopped();
  const noAmmoTypes = new Set();
  const topUpSeen = new Map();
  const memoryProbe = telemetry && typeof telemetry.registerMemoryProbe === "function"
    ? telemetry.registerMemoryProbe("sentries.armed", () => ({ entries: armed.size + refs.size + healedMarks.size
      + topUpSeen.size })) : null;
  let topUpPass = 0;
  let receiptPruneDue = true;
  let state = "ready";
  let lastRefusal = null;

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
    metric("count", `sentries.${name}`, n);
  }

  function log(line) {
    try {
      logger.log(line);
    } catch (_err) {
    }
  }

  const PASS_THROUGH = Object.freeze({ measure: (_phase, operation) => operation(), report: () => {} });

  function deployTimer(row) {
    const thresholdMs = C.slowDeployLogMs;
    if (!(thresholdMs > 0)) return PASS_THROUGH;
    const startedMs = nowMs();
    const phases = [];
    const measure = (phase, operation) => {
      const t0 = nowMs();
      try {
        return operation();
      } finally {
        phases.push(`${phase}=${(nowMs() - t0).toFixed(1)}`);
      }
    };
    const report = (outcome) => {
      const totalMs = nowMs() - startedMs;
      if (totalMs < thresholdMs) return;
      log(`sentries: slow SENTRY_DEPLOY sentry=${row.sentryId} system=${row.systemId} outcome=${String(outcome)} `
        + `totalMs=${totalMs.toFixed(1)} phaseMs ${phases.join(" ")}`);
    };
    return { measure, report };
  }

  const stopped = () => state === "stopped";
  const now = () => call(() => clock.now(), 0);

  function seamCall(name, ...args) {
    if (!seam || typeof seam[name] !== "function") return refuse(S.CODES.POLICY_FAILED);
    const r = call(() => seam[name](...args), null);
    return isPlain(r) ? r : refuse(S.CODES.POLICY_FAILED);
  }

  function secClassOf(systemId) {
    const g = typeof deps.getGraph === "function" ? call(deps.getGraph, null) : null;
    const graph = g && g.ok === true && g.graph ? g.graph : null;
    const sys = graph && typeof graph.getSystem === "function" ? call(() => graph.getSystem(systemId), null) : null;
    return sys && typeof sys.secClass === "string" ? sys.secClass : null;
  }

  function tx(name, fn) {
    const r = store.transaction(name, fn);
    if (r && r.ok === true) return { ok: true, value: r.value };
    if (r && r.error instanceof Rollback) return refuse(r.error.reason);
    return refuse((r && r.reason) || "TX_FAILED");
  }

  function detach(sentryId) {
    const ref = refs.get(sentryId);
    if (ref === undefined) return null;
    refs.delete(sentryId);
    const list = bySystem.get(ref.systemId);
    if (list) {
      list.delete(sentryId);
      if (list.size === 0) bySystem.delete(ref.systemId);
    }
    return ref;
  }

  function unindex(sentryId) {
    const ref = detach(sentryId);
    if (ref !== null) healedMarks.delete(ref.itemId);
    topUpSeen.delete(sentryId);
  }

  function indexRow(row) {
    if (!row || typeof row.sentryId !== "string") return;
    if (row.state !== S.ACTIVE || !isId(row.itemId) || !isId(row.systemId)) {
      unindex(row.sentryId);
      return;
    }
    detach(row.sentryId);
    const anchored = S.ANCHOR_KINDS.includes(row.anchorKind) && isId(row.anchorId);
    const ref = Object.freeze({ sentryId: row.sentryId, itemId: row.itemId, ownerKind: row.ownerKind,
      factionId: isId(row.factionId) ? row.factionId : null, characterId: isId(row.characterId) ? row.characterId : null,
      ownerCorpId: isId(row.ownerCorpId) ? row.ownerCorpId : null, typeId: row.typeId, kind: kindOf(row),
      systemId: row.systemId,
      anchorKind: anchored ? row.anchorKind : null, anchorId: anchored ? row.anchorId : null });
    refs.set(row.sentryId, ref);
    if (!bySystem.has(row.systemId)) bySystem.set(row.systemId, new Map());
    bySystem.get(row.systemId).set(row.sentryId, ref);
  }

  function listLiveInSystem(systemId) {
    const list = bySystem.get(systemId);
    if (!list || stopped()) return [];
    return [...list.values()].sort((a, b) => (a.sentryId < b.sentryId ? -1 : a.sentryId > b.sentryId ? 1 : 0));
  }

  function kindOf(ref) {
    const kind = ref && typeof ref === "object" ? kindOfType(ref.typeId) : null;
    return kind === null ? DEFAULT_KIND : kind;
  }

  function listLiveOfKind(kind) {
    if (stopped() || !SENTRY_KINDS.includes(kind)) return [];
    const out = [];
    for (const ref of refs.values()) if (ref.kind === kind) out.push(ref);
    return out.sort((a, b) => (a.sentryId < b.sentryId ? -1 : a.sentryId > b.sentryId ? 1 : 0));
  }

  function ownerOnlineOf(ref, at) {
    if (!ref || typeof ref !== "object" || !isPassiveKind(kindOf(ref))) return true;
    if (!isId(ref.ownerCorpId)) return false;
    const o = typeof deps.getOwnerOnline === "function" ? call(deps.getOwnerOnline, null) : null;
    if (!o || typeof o.ownerOnline !== "function") return false;
    const r = call(() => o.ownerOnline(ref.ownerCorpId, isTime(at) ? at : now()), null);
    return isPlain(r) && r.online === true;
  }

  function postGateOf(at) {
    const memo = new Map();
    let offline = 0;
    return {
      allow(ref) {
        if (!isPassiveKind(kindOf(ref))) return true;
        const key = isId(ref.ownerCorpId) ? ref.ownerCorpId : 0;
        if (!memo.has(key)) memo.set(key, ownerOnlineOf(ref, at));
        const online = memo.get(key);
        if (!online) offline += 1;
        return online;
      },
      offline: () => offline,
    };
  }

  function setActiveGauge() {
    const r = tx("sentries.count", (db) => repository.countAllLive(db));
    if (r.ok && r.value && r.value.ok) metric("gauge", METRIC_ACTIVE, r.value.count);
  }

  function checkOwnerAndItem(req, operation) {
    const info = sessionInfo(req.session);
    const read = seamCall("readSentryItem", req.itemId);
    if (!read.ok) return refuse(read.reason === "NOT_FOUND" ? "STARBASE_MODULE_NOT_IN_SPACE" : S.CODES.POLICY_FAILED);
    const item = read.item;
    if (!item.inSpace || item.systemId !== info.systemId) return refuse("STARBASE_MODULE_NOT_IN_SPACE");
    if (item.destroyed) return refuse("MODULE_INCAPACITATED");
    const npc = seamCall("isNpcCorporation", item.ownerCorpId);
    if (!npc.ok) return refuse(S.CODES.POLICY_FAILED);
    if (npc.npc) return refuse("STARBASE_PLAYER_CORPORATION_REQUIRED");
    const auth = seamCall("validateAuthority", req.session, item.ownerCorpId, operation);
    if (!auth.ok) return refuse(auth.reason);
    return { ok: true, item, info };
  }

  function placementOf(item, kind) {
    const sec = secClassOf(item.systemId);
    if (sec === null) return refuse(S.CODES.DISABLED);
    if (sec === HIGHSEC && C.player.allowHighsec !== true) return refuse(S.CODES.HIGHSEC);
    const anchors = seamCall("readAnchors", item.systemId, { maxAnchors: C.maxAnchorsRead });
    if (!anchors.ok) return refuse(S.CODES.POLICY_FAILED);
    const listed = seamCall("listSentryItems", { systemId: item.systemId });
    if (!listed.ok) return refuse(S.CODES.POLICY_FAILED);
    const others = listed.items.filter((o) => o.itemId !== item.itemId && o.inSpace && o.anchorState !== "unanchored");
    return checkPlacement({ position: item.position, anchors: anchors.anchors, others, ownerCorpId: item.ownerCorpId,
      ownerKind: "player", minM: C.anchorMinDistanceM, maxM: C.anchorMaxDistanceM, spacingM: C.minSpacingM,
      itemId: item.itemId, free: { enabled: freeOn(kind), clearanceM: freeClearanceM() },
      anchorsTruncated: anchors.truncated === true });
  }

  function anchorWrite(db, item, info, anchor, at, kind) {
    const found = repository.getByItem(db, item.itemId);
    if (!found.ok) throw new Rollback(found.reason);
    const row = found.sentry;
    if (row && S.LIVE_STATES.includes(row.state)) return { duplicate: true, sentry: row };
    if (row && row.state !== S.RETIRED) throw new Rollback(S.CODES.POLICY_FAILED);
    const counted = repository.countLive(db, { anchorKind: anchor.kind, anchorId: anchor.id, systemId: item.systemId,
      ownerCorpId: item.ownerCorpId, typeIds: typeIdsOfKind(kind) });
    if (!counted.ok) throw new Rollback(counted.reason);
    const rule = kindRuleOf(kind);
    const lim = rule !== null ? checkKindLimits(counted.counts, rule.limits) : checkLimits(counted.counts, limits);
    if (!lim.ok) throw new Rollback(lim.reason);
    if (anchor.kind === S.SPACE_ANCHOR) {
      const free = repository.countFreeLive(db, { systemId: item.systemId, ownerCorpId: item.ownerCorpId });
      if (!free.ok) throw new Rollback(free.reason);
      const freeLim = checkFreeLimits(free.counts, freeLimits);
      if (!freeLim.ok) throw new Rollback(freeLim.reason);
    }
    const armedAt = at + C.armDelayMs;
    const characterId = isId(info.characterId) ? info.characterId : null;
    const r = row
      ? repository.transition(db, { sentry: row, to: S.ACTIVE, at, reason: S.REANCHORED, armedAt,
        placement: { systemId: item.systemId, anchorKind: anchor.kind, anchorId: anchor.id,
          ownerCorpId: item.ownerCorpId, characterId } })
      : repository.insertActive(db, { sentryId: S.playerSentryId(item.itemId), ownerKind: "player", factionId: null,
        ownerCorpId: item.ownerCorpId, characterId, itemId: item.itemId, typeId: item.typeId, systemId: item.systemId,
        anchorKind: anchor.kind, anchorId: anchor.id, armedAt, at });
    if (!r.ok) throw new Rollback(r.reason);
    return { duplicate: false, sentry: r.sentry };
  }

  function retireRefused(sentry, at) {
    return tx("sentries.vendorRefused", (db) => {
      const found = repository.getById(db, sentry.sentryId);
      if (!found.ok || !found.sentry || found.sentry.state !== S.ACTIVE) return { ok: true, skipped: true };
      const r = repository.transition(db, { sentry: found.sentry, to: S.RETIRED, at, reason: "VENDOR_REFUSED" });
      if (!r.ok) throw new Rollback(r.reason);
      return r;
    });
  }

  function anchor(req) {
    try {
      if (stopped() || C.player.enabled !== true) return refuse(S.CODES.DISABLED);
      if (!req || !isId(req.itemId)) return refuse(S.CODES.POLICY_FAILED);
      const checked = checkOwnerAndItem(req, "anchor");
      const refused = (reason) => {
        bump("anchorRefused");
        lastRefusal = reason;
        return refuse(reason);
      };
      if (!checked.ok) return refused(checked.reason);
      const { item, info } = checked;
      const kind = kindOf(item);
      const rule = kindRuleOf(kind);
      if (rule !== null) {
        const sec = secClassOf(item.systemId);
        const why = rule.enabled !== true ? S.CODES.KIND_DISABLED
          : sec !== null && !rule.secClasses.includes(sec) ? S.CODES.KIND_SEC : null;
        if (why !== null) {
          bump("kindRefused");
          return refused(why);
        }
      }
      const placed = placementOf(item, kind);
      if (!placed.ok) return refused(placed.reason);
      const at = now();
      const written = tx("sentries.anchor", (db) => anchorWrite(db, item, info, placed.anchor, at, kind));
      if (!written.ok) return refused(written.reason);
      const { sentry, duplicate } = written.value;
      if (duplicate && item.anchorState === "anchored" && item.onlineState === "online") {
        if (!armed.has(item.itemId) && isTime(sentry.armedAt)) armed.set(item.itemId, sentry.armedAt);
        indexRow(sentry);
        bump("anchorDuplicate");
        return { ok: true, sentryId: sentry.sentryId, duplicate: true };
      }
      const online = seamCall("forceOnline", item.itemId);
      if (!online.ok) {
        const retired = retireRefused(sentry, now());
        if (!retired.ok) log(`sentries: retire of ${sentry.sentryId} after a vendor refusal failed ${retired.reason}`);
        unindex(sentry.sentryId);
        bump("vendorRefused");
        lastRefusal = online.reason;
        return refuse(online.reason);
      }
      if (online.partial === true) bump("vendorPartial");
      if (isTime(sentry.armedAt)) armed.set(item.itemId, sentry.armedAt);
      indexRow(sentry);
      bump(duplicate ? "anchorDuplicate" : "anchored");
      if (!duplicate && kind === HEAVY_KIND) bump("heavyAnchored");
      if (!duplicate && sentry.anchorKind === S.SPACE_ANCHOR) bump("freeAnchored");
      if (!duplicate) setActiveGauge();
      return { ok: true, sentryId: sentry.sentryId, duplicate };
    } catch (err) {
      lastRefusal = messageOf(err);
      return refuse(S.CODES.POLICY_FAILED);
    }
  }

  function online(req) {
    try {
      if (stopped()) return refuse(S.CODES.DISABLED);
      if (!req || !isId(req.itemId)) return refuse(S.CODES.POLICY_FAILED);
      const checked = checkOwnerAndItem(req, "online");
      if (!checked.ok) return checked;
      if (checked.item.anchorState !== "anchored") return refuse("STARBASE_MODULE_NOT_ANCHORED");
      const found = tx("sentries.onlineRead", (db) => repository.getByItem(db, req.itemId));
      if (!found.ok || !found.value || !found.value.ok) return refuse(S.CODES.POLICY_FAILED);
      const row = found.value.sentry;
      if (!row || row.state !== S.ACTIVE) return refuse("STARBASE_MODULE_NOT_ANCHORED");
      const r = seamCall("forceOnline", req.itemId);
      if (!r.ok) return refuse(r.reason);
      if (isTime(row.armedAt)) armed.set(req.itemId, row.armedAt);
      indexRow(row);
      return { ok: true, sentryId: row.sentryId, duplicate: false };
    } catch (err) {
      lastRefusal = messageOf(err);
      return refuse(S.CODES.POLICY_FAILED);
    }
  }

  function isArmed(itemId) {
    const at = armed.get(itemId);
    return at !== undefined && at <= now();
  }

  function markEndedInTx(db, sentryId, reason, at) {
    if (!S.LIVE_END_REASONS.includes(reason) || !isTime(at)) return refuse("INVALID_INPUT");
    const found = repository.getById(db, sentryId);
    if (!found.ok) return refuse(found.reason);
    const row = found.sentry;
    if (!row || row.state !== S.ACTIVE) return refuse(STALE);
    const r = repository.transition(db, { sentry: row, to: S.DESTROYED, at, reason });
    if (!r.ok) return refuse(r.reason);
    if (r.duplicate) return refuse(STALE);
    return { ok: true, sentryId: row.sentryId, itemId: row.itemId };
  }

  function markEnded(sentryId, reason) {
    try {
      if (stopped()) return refuse("SENTRIES_STOPPED");
      if (typeof sentryId !== "string" || sentryId === "") return refuse("INVALID_INPUT");
      const at = now();
      const r = tx("sentries.markEnded", (db) => {
        const v = markEndedInTx(db, sentryId, reason, at);
        if (!v.ok && v.reason !== STALE) throw new Rollback(v.reason);
        return v;
      });
      if (!r.ok) return r;
      const ref = refs.get(sentryId);
      if (ref) armed.delete(ref.itemId);
      unindex(sentryId);
      if (!r.value.ok) return r.value;
      bump("destroyed");
      setActiveGauge();
      return r.value;
    } catch (err) {
      return refuse(`SENTRY_MARK_FAILED: ${messageOf(err)}`);
    }
  }

  function vendorMarkOf(item) {
    if (typeof item.disabledReason !== "string" || item.disabledReason === "") return null;
    const mark = `${item.disabledReason}@${item.disabledAtMs === null ? "" : item.disabledAtMs}`;
    return healedMarks.get(item.itemId) === mark ? null : mark;
  }

  function findAnchor(anchors, anchorKind, anchorRef) {
    const ref = isPlain(anchorRef) ? anchorRef : {};
    for (const a of anchors) {
      if (anchorKind === "gate" && a.kind === "gate" && isId(ref.toSystemId) && a.toSystemId === ref.toSystemId) return a;
      if (anchorKind === "station" && a.kind === "structure" && typeof ref.stationId === "string"
        && a.lneStationId === ref.stationId) return a;
    }
    return null;
  }

  function refOfAnchor(anchors, row) {
    const a = anchors.find((x) => x.kind === row.anchorKind && x.id === row.anchorId);
    if (!a) return null;
    if (a.kind === "gate" && isId(a.toSystemId)) return { anchorKind: "gate", anchorRef: { toSystemId: a.toSystemId } };
    if (a.kind === "structure" && typeof a.lneStationId === "string") {
      return { anchorKind: "station", anchorRef: { stationId: a.lneStationId } };
    }
    return null;
  }

  function readForReview(db, factionId, opts) {
    if (!factionOn()) return { ok: true, mode: "off", factionLive: 0, total: 0, rows: [], truncated: false };
    if (!isId(factionId)) return refuse("INVALID_INPUT");
    const maxSystems = opts && isId(opts.maxCandidateSystems) ? opts.maxCandidateSystems : 1;
    const listed = repository.listFactionLive(db, factionId, F.maxPerFaction);
    if (!listed.ok) return listed;
    const total = repository.countAllLive(db);
    if (!total.ok) return total;
    const anchorsOf = new Map();
    const systemIds = opts && Array.isArray(opts.systemIds)
      ? [...new Set(opts.systemIds.filter(isId))].slice(0, maxSystems) : null;
    const anchors = [];
    for (const systemId of systemIds || []) {
      const counted = repository.countAnchorsInSystem(db, systemId);
      if (!counted.ok) return counted;
      if (counted.anchors.length === 0) {
        anchorsOf.set(systemId, []);
        continue;
      }
      const a = seamCall("readAnchors", systemId, { maxAnchors: C.maxAnchorsRead });
      const list = a.ok ? a.anchors : [];
      anchorsOf.set(systemId, list);
      for (const c of counted.anchors) {
        const ref = refOfAnchor(list, c);
        if (ref !== null) anchors.push({ systemId, anchorKind: ref.anchorKind, anchorRef: ref.anchorRef, live: c.count });
      }
    }
    const rows = [];
    for (const row of listed.sentries) {
      if (systemIds === null && !anchorsOf.has(row.systemId) && anchorsOf.size < maxSystems) {
        const a = seamCall("readAnchors", row.systemId, { maxAnchors: C.maxAnchorsRead });
        anchorsOf.set(row.systemId, a.ok ? a.anchors : []);
      }
      const ref = anchorsOf.has(row.systemId) ? refOfAnchor(anchorsOf.get(row.systemId), row) : null;
      rows.push({ systemId: row.systemId, anchorKind: ref ? ref.anchorKind : null, anchorRef: ref ? ref.anchorRef : null });
    }
    return { ok: true, mode: "ready", typeId: sentryTypeOfFaction(factionId),
      factionLive: listed.sentries.length + (listed.truncated ? 1 : 0), total: total.count, rows,
      ...(systemIds === null ? {} : { anchors }), truncated: listed.truncated };
  }

  function requestBuildInTx(db, spec, ik) {
    if (!factionOn()) return refuse("SENTRY_OFF");
    const s = isPlain(spec) ? spec : {};
    if (typeof ik !== "string" || ik === "" || !isId(s.factionId) || !isId(s.ownerCorpId) || !isId(s.systemId)
      || !isId(s.typeId) || !isTime(s.at) || !["station", "gate"].includes(s.anchorKind)) {
      return { ok: false, reason: "INVALID_INPUT", detail: "spec" };
    }
    const sentryId = S.factionSentryId(fingerprint(ik));
    const found = repository.getById(db, sentryId);
    if (!found.ok) return found;
    if (found.sentry) return { ok: true, sentryId, duplicate: true, systemId: found.sentry.systemId,
      slot: found.sentry.slot };
    const read = seamCall("readAnchors", s.systemId, { maxAnchors: C.maxAnchorsRead });
    if (!read.ok) return { ok: false, reason: "ANCHOR_UNKNOWN", detail: String(read.reason) };
    const anchor = findAnchor(read.anchors, s.anchorKind, s.anchorRef);
    if (anchor === null) return { ok: false, reason: "ANCHOR_UNKNOWN" };
    const counted = repository.countFactionLive(db, { factionId: s.factionId, systemId: s.systemId,
      anchorKind: anchor.kind, anchorId: anchor.id });
    if (!counted.ok) return counted;
    const n = counted.counts;
    const over = n.perAnchor >= C.maxPerAnchor ? "anchor" : n.perFactionSystem >= F.maxPerSystem ? "system"
      : n.perFaction >= F.maxPerFaction ? "faction" : n.total >= C.maxTotal ? "total" : null;
    if (over !== null) return { ok: false, reason: S.CODES.LIMIT, detail: over };
    let slot = 0;
    while (n.slots.includes(slot)) slot += 1;
    if (slot >= C.maxPerAnchor) return { ok: false, reason: S.CODES.LIMIT, detail: "slot" };
    if (F.costIsk > 0) {
      const t = typeof deps.getTreasury === "function" ? call(deps.getTreasury, null) : null;
      if (!t || typeof t.chargeWarSpendInTx !== "function") return refuse("TREASURY_OFF");
      const paid = t.chargeWarSpendInTx(db, { factionId: s.factionId, isk: F.costIsk, at: s.at }, `${ik}${FEE_SUFFIX}`);
      if (!paid || paid.ok !== true) return paid || refuse("TREASURY_OFF");
    }
    const ins = repository.insertPending(db, { sentryId, factionId: s.factionId, ownerCorpId: s.ownerCorpId,
      typeId: s.typeId, systemId: s.systemId, anchorKind: anchor.kind, anchorId: anchor.id, slot, costIsk: F.costIsk,
      at: s.at });
    if (!ins.ok) return ins;
    const e = scheduler.enqueue(S.DEPLOY_EVENT_TYPE, sentryId, s.at + F.buildDelayMs, { sentryId },
      S.deployKey(sentryId), { tx: db, chained: true });
    if (!e || e.ok !== true) return { ok: false, reason: (e && e.reason) || "ENQUEUE_FAILED", detail: "deploy" };
    return { ok: true, sentryId, duplicate: false, systemId: s.systemId, slot };
  }

  function noteCommitted(value) {
    if (isPlain(value) && value.ok !== false && value.duplicate !== true) bump("factionRequested");
  }

  function onDeploy(ev, hctx) {
    try {
      const p = parseDeployPayload(ev && ev.payload);
      if (!p) return { ok: false, reason: "SENTRY_PAYLOAD_INVALID", permanent: true };
      if (stopped()) return { ok: false, reason: "SENTRIES_STOPPED" };
      const at = hctx && isTime(hctx.now) ? hctx.now : now();
      const got = tx("sentries.deployRead", (db) => repository.getById(db, p.sentryId));
      if (!got.ok || !got.value || !got.value.ok) return refuse((got.value && got.value.reason) || got.reason);
      const row = got.value.sentry;
      if (!row || row.state !== S.PENDING_DEPLOY) return { ok: true, outcome: "STALE" };
      const cancel = (reason, detail) => ({ ok: true, outcome: "DEPLOY_FAILED",
        effect: (db) => {
          const cur = repository.getById(db, row.sentryId);
          if (!cur.ok) return cur;
          if (!cur.sentry || cur.sentry.state !== S.PENDING_DEPLOY) return { ok: true, skipped: true };
          const r = repository.transition(db, { sentry: cur.sentry, to: S.CANCELLED, at, reason: "DEPLOY_FAILED" });
          return r.ok ? { ok: true, cancelled: true } : r;
        },
        onCommitted: (v) => {
          if (!v || v.cancelled !== true) return;
          bump("factionDeployFailed");
          lastRefusal = `deploy:${reason}`;
          log(`sentries: faction sentry ${row.sentryId} of ${row.factionId} in ${row.systemId} not deployed `
            + `(${reason}${detail ? ` ${detail}` : ""}) - CANCELLED, no refund`);
        } });
      const timer = deployTimer(row);
      const anchors = timer.measure("readAnchors",
        () => seamCall("readAnchors", row.systemId, { maxAnchors: C.maxAnchorsRead }));
      if (!anchors.ok) {
        timer.report(anchors.reason);
        return { ok: false, reason: String(anchors.reason) };
      }
      const anchor = anchors.anchors.find((a) => a.kind === row.anchorKind && a.id === row.anchorId) || null;
      if (anchor === null) {
        timer.report("ANCHOR_GONE");
        return cancel("ANCHOR_GONE");
      }
      const ammo = noAmmoTypes.has(row.typeId) ? null : defaultAmmoOfType(row.typeId);
      const d = seamCall("deployFactionSentry", { sentryId: row.sentryId, ownerCorpId: row.ownerCorpId,
        systemId: row.systemId, typeId: row.typeId, position: ringPosition(anchor, row.slot, { ...C, ...F }), ammo },
      timer.measure);
      timer.report(d.ok ? (d.duplicate ? "REPLAY" : "OK") : d.reason);
      if (!d.ok) return d.permanent === true ? cancel(d.reason, d.detail) : { ok: false, reason: String(d.reason) };
      const armedAt = at + C.armDelayMs;
      return { ok: true, outcome: d.duplicate ? "DEPLOYED_REPLAY" : "DEPLOYED",
        effect: (db) => {
          const cur = repository.getById(db, row.sentryId);
          if (!cur.ok) return cur;
          if (!cur.sentry || cur.sentry.state !== S.PENDING_DEPLOY) return { ok: true, skipped: true };
          const r = repository.activatePending(db, { sentry: cur.sentry, itemId: d.itemId, armedAt, ammoGrants: 1, at });
          return r.ok ? { ok: true, sentry: r.sentry } : r;
        },
        onCommitted: (v) => {
          if (!v || !v.sentry) return;
          armed.set(v.sentry.itemId, armedAt);
          indexRow(v.sentry);
          bump("factionDeployed");
          if (d.spawnFailed === true) {
            bump("spawnFailed");
            log(`sentries: faction sentry ${row.sentryId} (item ${d.itemId}) deployed in ${row.systemId} but the `
              + "loaded scene refused its entity - it appears after the scene reloads");
          }
          setActiveGauge();
        } };
    } catch (err) {
      return { ok: false, reason: `SENTRY_DEPLOY_FAILED: ${messageOf(err)}` };
    }
  }

  function topUpsOf(rows, skip) {
    const out = [];
    if (!factionOn() || !(F.maxTopUpsPerPass > 0)) return out;
    topUpPass += 1;
    const seenOf = (row) => (topUpSeen.has(row.sentryId) ? topUpSeen.get(row.sentryId) : 0);
    const candidates = [];
    for (const row of rows) {
      if (row.ownerKind !== "faction" || skip.has(row.sentryId) || !isId(row.itemId)) continue;
      const ammo = noAmmoTypes.has(row.typeId) ? null : defaultAmmoOfType(row.typeId);
      if (ammo !== null) candidates.push({ row, ammo });
    }
    candidates.sort((a, b) => seenOf(a.row) - seenOf(b.row));
    let tried = 0;
    for (const { row, ammo } of candidates) {
      if (tried >= F.maxTopUpsPerPass) break;
      const r = seamCall("topUpAmmo", { sentryId: row.sentryId, n: row.ammoGrants, ownerCorpId: row.ownerCorpId,
        itemId: row.itemId, systemId: row.systemId, ammo, belowPermille: F.topUpBelowPermille });
      if (!r.ok && r.reason === SCENE_LOADED) continue;
      tried += 1;
      topUpSeen.set(row.sentryId, topUpPass);
      if (r.ok && (r.granted > 0 || r.duplicate === true)) out.push(row);
    }
    return out;
  }

  function pruneReceipts() {
    if (!factionOn() || !receiptPruneDue) return 0;
    const r = tx("sentries.receiptPrune", (db) => seamCall("pruneReceipts", (sentryId) => {
      const got = repository.getById(db, sentryId);
      return got.ok === true && got.sentry === null;
    }, C.pruneBatch));
    if (!r.ok || !r.value || r.value.ok !== true) {
      if (r.ok && r.value) lastRefusal = `receiptPrune:${r.value.reason}`;
      return 0;
    }
    receiptPruneDue = r.value.capped === true;
    return r.value.removed;
  }

  function orphansOf(room) {
    const out = [];
    for (const typeId of SENTRY_TYPE_IDS) {
      const listed = seamCall("listSentryItems", { typeId });
      if (!listed.ok) continue;
      for (const item of listed.items) {
        if (out.length >= room) return out;
        if (item.inSpace && item.anchorState === "anchored" && !item.destroyed && item.position !== null) out.push(item);
      }
    }
    return out;
  }

  function adoptionAnchor(item) {
    const anchors = seamCall("readAnchors", item.systemId, { maxAnchors: C.maxAnchorsRead });
    if (!anchors.ok) return null;
    const placed = checkPlacement({ position: item.position, anchors: anchors.anchors, others: [],
      ownerCorpId: item.ownerCorpId, ownerKind: "player", minM: 0, maxM: Number.MAX_SAFE_INTEGER, spacingM: 0 });
    if (freeOn(kindOf(item)) && isId(item.itemId) && (!placed.ok || placed.anchor.surfaceM > C.anchorMaxDistanceM)) {
      return { kind: S.SPACE_ANCHOR, id: item.itemId, surfaceM: placed.ok ? placed.anchor.surfaceM : null };
    }
    return placed.ok ? placed.anchor : null;
  }

  function reconcile(at, cursor) {
    try {
      if (stopped()) return refuse("SENTRIES_STOPPED");
      const t = isTime(at) ? at : now();
      const after = typeof cursor === "string" ? cursor : "";
      const page = tx("sentries.reconcileRead", (db) => repository.listActive(db, { afterSentryId: after,
        limit: C.reconcileMaxRows }));
      if (!page.ok || !page.value || !page.value.ok) return refuse((page.value && page.value.reason) || page.reason);
      const ends = [];
      const heals = [];
      const standing = [];
      for (const row of page.value.sentries) {
        indexRow(row);
        const read = seamCall("readSentryItem", row.itemId);
        if (!read.ok) {
          if (read.reason === "NOT_FOUND") ends.push({ row, to: S.DESTROYED, reason: "VANISHED" });
          continue;
        }
        const item = read.item;
        if (item.inSpace && item.anchorState === "anchored" && !item.destroyed) standing.push(row);
        if (!item.inSpace || item.anchorState === "unanchored") {
          ends.push({ row, to: S.RETIRED, reason: "UNANCHORED" });
        } else if (item.anchorState === "anchored" && item.onlineState !== "online" && !item.destroyed) {
          const mark = vendorMarkOf(item);
          if (mark !== null) heals.push({ itemId: row.itemId, armedAt: row.armedAt, mark });
        } else if (!armed.has(row.itemId) && isTime(row.armedAt)) {
          armed.set(row.itemId, row.armedAt);
        }
      }
      let orphans = [];
      if (after === "") {
        const anchored = orphansOf(C.maxTotal + C.reconcileMaxRows);
        const rd = tx("sentries.orphanRead", (db) => anchored.filter((item) => {
          const has = repository.getByItem(db, item.itemId);
          return has.ok && has.sentry === null;
        }));
        if (rd.ok && Array.isArray(rd.value)) orphans = rd.value.slice(0, C.reconcileMaxRows);
      }
      const adoptions = [];
      for (const item of orphans) {
        const anchorOf = adoptionAnchor(item);
        if (anchorOf !== null) adoptions.push({ item, anchor: anchorOf });
      }
      const topped = topUpsOf(standing, new Set(ends.map((e) => e.row.sentryId)));
      const written = tx("sentries.reconcile", (db) => {
        const out = { destroyed: 0, retired: 0, adopted: 0, pruned: 0, adoptedItems: [], adoptedRows: [], topUps: 0 };
        for (const row of topped) {
          const r = repository.noteAmmoGrant(db, { sentry: row, at: t });
          if (r.ok && !r.duplicate) out.topUps += 1;
        }
        for (const e of ends) {
          const r = repository.transition(db, { sentry: e.row, to: e.to, at: t, reason: e.reason });
          if (!r.ok || r.duplicate) continue;
          if (e.to === S.DESTROYED) out.destroyed += 1;
          else out.retired += 1;
        }
        for (const a of adoptions) {
          const has = repository.getByItem(db, a.item.itemId);
          if (!has.ok || has.sentry !== null) continue;
          const r = repository.insertActive(db, { sentryId: S.adoptedSentryId(a.item.itemId), ownerKind: "player",
            factionId: null, ownerCorpId: a.item.ownerCorpId, characterId: null, itemId: a.item.itemId,
            typeId: a.item.typeId, systemId: a.item.systemId, anchorKind: a.anchor.kind, anchorId: a.anchor.id,
            armedAt: t, at: t, adopted: true });
          if (r.ok && !r.duplicate) {
            out.adopted += 1;
            out.adoptedItems.push(a.item);
            if (r.sentry) out.adoptedRows.push(r.sentry);
          }
        }
        const pruned = repository.pruneEnded(db, { before: Math.max(0, t - C.retentionMs), limit: C.pruneBatch });
        if (pruned.ok) out.pruned = pruned.deleted;
        return out;
      });
      if (!written.ok) return refuse(written.reason);
      const w = written.value;
      if (w.pruned > 0) receiptPruneDue = true;
      for (const e of ends) {
        armed.delete(e.row.itemId);
        unindex(e.row.sentryId);
      }
      for (const row of w.adoptedRows) indexRow(row);
      for (const item of w.adoptedItems) {
        armed.set(item.itemId, t);
        const mark = item.onlineState !== "online" ? vendorMarkOf(item) : null;
        if (mark !== null) heals.push({ itemId: item.itemId, armedAt: t, mark });
      }
      let healed = 0;
      let deferred = 0;
      let partial = 0;
      let tried = 0;
      for (const row of heals) {
        if (tried >= C.maxHealsPerPass) break;
        const r = seamCall("forceOnline", row.itemId, { loadedSceneOnly: true });
        if (!r.ok && r.reason === SCENE_NOT_LOADED) {
          deferred += 1;
          continue;
        }
        tried += 1;
        if (!r.ok) continue;
        healed += 1;
        healedMarks.set(row.itemId, row.mark);
        if (r.partial === true) partial += 1;
        if (isTime(row.armedAt)) armed.set(row.itemId, row.armedAt);
      }
      bump("destroyed", w.destroyed);
      bump("retired", w.retired);
      bump("adopted", w.adopted);
      bump("healed", healed);
      bump("healDeferred", deferred);
      bump("vendorPartial", partial);
      bump("topUps", w.topUps);
      bump("receiptsPruned", after === "" ? pruneReceipts() : 0);
      if (after === "") {
        const k = kickBattle(t);
        if (!k.ok) lastRefusal = `battleKick:${k.reason}`;
      }
      bump("reconcilePasses");
      setActiveGauge();
      const list = page.value.sentries;
      return { ok: true, checked: list.length, destroyed: w.destroyed, retired: w.retired, adopted: w.adopted, healed,
        deferred, pruned: w.pruned, topUps: w.topUps, next: page.value.truncated && list.length > 0 ? list[list.length - 1].sentryId : null };
    } catch (err) {
      return refuse(`SENTRY_RECONCILE_FAILED: ${messageOf(err)}`);
    }
  }

  function rebuildArmed() {
    let after = "";
    for (let guard = 0; guard < 1000; guard += 1) {
      const page = tx("sentries.armedRead", (db) => repository.listActive(db, { afterSentryId: after,
        limit: ARMED_PAGE }));
      if (!page.ok || !page.value || !page.value.ok) return refuse(page.reason || "READ_FAILED");
      for (const row of page.value.sentries) {
        if (isTime(row.armedAt)) armed.set(row.itemId, row.armedAt);
        indexRow(row);
      }
      if (!page.value.truncated || page.value.sentries.length === 0) return { ok: true, armed: armed.size };
      after = page.value.sentries[page.value.sentries.length - 1].sentryId;
    }
    return { ok: true, armed: armed.size };
  }

  const B = isPlain(C.battle) ? C.battle : { enabled: false };
  const battleSettings = isPlain(config.battle) ? config.battle : {};
  const fleetRepository = deps.fleetRepository || null;
  const journal = deps.journal || null;
  const groups = deps.groups || {};
  let kickAfter = 0;
  const chainReady = (K) => !stopped() && journal !== null && fleetRepository !== null
    && typeof fleetRepository.listFleetsInSystem === "function" && isId(K.roundMs);
  const battleOn = () => B.enabled === true && chainReady(B);
  const roundOf = (t) => Math.floor(t / B.roundMs);
  const chainStates = () => S.BATTLE_FLEET_STATES;

  function hostilityOf() {
    const h = isPlain(deps.hostility) ? deps.hostility : {};
    return createSentryHostility({ ...h, maxReads: B.maxStandingReads });
  }

  function holdFleets(db, systemId) {
    const out = [];
    const max = B.maxFleetsRead;
    const states = [...chainStates()];
    let after;
    for (let page = 0; page < max && out.length < max; page += 1) {
      const listed = fleetRepository.listFleetsInSystem(db, systemId, { states,
        limit: max, ...(after === undefined ? {} : { afterFleetId: after }) });
      if (!listed || listed.ok !== true) return listed || refuse("FLEETS_READ_FAILED");
      for (const f of listed.fleets) if (SIEGE_ROLES.includes(f.fleetRole) && out.length < max) out.push(f);
      if (listed.nextAfterFleetId === null || listed.nextAfterFleetId === undefined || listed.fleets.length === 0) break;
      after = listed.nextAfterFleetId;
    }
    return { ok: true, fleets: out };
  }

  const hostileTo = (hostility, refs, fleets) => fleets.some((f) => refs.some((r) => hostility.isHostile(r,
    f.factionId)));

  const grid = deps.grid || null;

  function gridOn() {
    if (B.gridEnabled !== true || grid === null || typeof grid.isEnabled !== "function") return false;
    return call(() => grid.isEnabled() === true, false);
  }

  function gridScopeIn(db, systemId, fleets, sentryRefs, at) {
    if (B.gridEnabled !== true) return { grid: null, fallback: false, noAnchor: 0 };
    const fallback = { grid: null, fallback: true, noAnchor: 0 };
    if (!gridOn()) return fallback;
    try {
      const pos = grid.positionsOf(db, systemId, fleets, at);
      if (!pos || pos.ok !== true || pos.anchorsReason !== null || !(pos.positions instanceof Map)) return fallback;
      const sg = grid.readSystemGrid(systemId);
      if (!sg || sg.ok !== true) return fallback;
      const scope = sentryGridScopeOf({ positions: pos.positions, grids: sg.grids, sentries: sentryRefs });
      return { grid: { gridOfFleet: scope.gridOfFleet, gridOfSentry: scope.gridOfSentry }, fallback: false,
        noAnchor: scope.noAnchor };
    } catch (err) {
      if (!db || db.inTransaction === false) throw err;
      return fallback;
    }
  }

  function onGridArrival(dbTx, payload) {
    try {
      if (!battleOn() || !gridOn() || !isPlain(payload)) return;
      if (!SIEGE_ROLES.includes(payload.fleetRole) || !isId(payload.systemId) || !isId(payload.factionId)
        || !isTime(payload.at) || typeof payload.gridKey !== "string") return;
      const live = listLiveInSystem(payload.systemId);
      if (live.length === 0) return;
      const sg = grid.readSystemGrid(payload.systemId);
      if (!sg || sg.ok !== true) return;
      const gridOf = gridOfRef(sg.grids);
      const inGrid = live.filter((r) => {
        const ref = sentryAnchorRef(r);
        return ref !== null && gridOf.get(ref) === payload.gridKey;
      });
      if (inGrid.length === 0 || !hostileTo(hostilityOf(), inGrid, [payload])) return;
      const r = enqueueRound(dbTx, payload.systemId, roundOf(payload.at) + 1, true);
      if (!r.ok) lastRefusal = `battle:${r.reason}`;
      else if (r.duplicate !== true) bump("gridArrivalQueued");
    } catch (err) {
      if (!dbTx || dbTx.inTransaction === false) throw err;
      lastRefusal = `battle:${messageOf(err)}`;
    }
  }

  function onArrival(dbTx, arrival) {
    try {
      if (!battleOn() || !isPlain(arrival)) return;
      if (!chainStates().includes(arrival.state) || !SIEGE_ROLES.includes(arrival.fleetRole)) return;
      if (!isId(arrival.systemId) || !isId(arrival.factionId) || !isTime(arrival.at)) return;
      const refs = listLiveInSystem(arrival.systemId);
      if (refs.length === 0) return;
      if (!hostileTo(hostilityOf(), refs, [arrival])) return;
      const r = enqueueRound(dbTx, arrival.systemId, roundOf(arrival.at) + 1, true);
      if (!r.ok) lastRefusal = `battle:${r.reason}`;
    } catch (err) {
      if (!dbTx || dbTx.inTransaction === false) throw err;
      lastRefusal = `battle:${messageOf(err)}`;
    }
  }

  function enqueueRound(db, systemId, round, chained) {
    const r = scheduler.enqueue(S.ATTRITION_EVENT_TYPE, String(systemId), round * B.roundMs, { systemId, round },
      S.attritionKey(systemId, round), chained ? { tx: db, chained: true } : { tx: db });
    if (!r || r.ok !== true) return refuse((r && r.reason) || "ENQUEUE_FAILED");
    return { ok: true, duplicate: r.duplicate === true };
  }

  function kickBattle(at) {
    try {
      if (!battleOn()) return { ok: true, enqueued: 0, checked: 0 };
      const systems = [...bySystem.keys()].sort((a, b) => a - b);
      const take = [...systems.filter((s) => s > kickAfter), ...systems.filter((s) => s <= kickAfter)]
        .slice(0, B.maxSystemsPerBootstrap);
      if (take.length === 0) return { ok: true, enqueued: 0, checked: 0 };
      kickAfter = take.length < systems.length ? take[take.length - 1] : 0;
      const round = roundOf(isTime(at) ? at : now()) + 1;
      const hostility = hostilityOf();
      const r = tx("sentries.battleKick", (db) => {
        let enqueued = 0;
        for (const systemId of take) {
          const fl = holdFleets(db, systemId);
          if (!fl.ok) throw new Rollback(fl.reason);
          if (!hostileTo(hostility, listLiveInSystem(systemId), fl.fleets)) continue;
          const e = enqueueRound(db, systemId, round, false);
          if (!e.ok) throw new Rollback(e.reason);
          if (!e.duplicate) enqueued += 1;
        }
        return { enqueued };
      });
      if (!r.ok) return r;
      return { ok: true, enqueued: r.value.enqueued, checked: take.length };
    } catch (err) {
      return refuse(`SENTRY_BATTLE_KICK_FAILED: ${messageOf(err)}`);
    }
  }

  function battleFacade() {
    const b = typeof deps.getBattle === "function" ? call(deps.getBattle, null) : null;
    if (!b || typeof b.createFixedDefenseBattleInTx !== "function" || typeof b.getStatus !== "function") return null;
    const st = call(() => b.getStatus(), null);
    return st && st.state === "ready" ? b : null;
  }

  function battleDpsOf(ref, item, profileDps) {
    if (!isArmed(ref.itemId) || item.incapacitated === true) return 0;
    const ammo = defaultAmmoOfType(ref.typeId);
    const units = ammo ? seamCall("readAmmo", ref.itemId, ammo.typeId) : null;
    if (!units || units.ok !== true || !(units.units > 0)) return 0;
    const dps = (profileDps * B.dpsPermille) / PERMILLE;
    if (kindOf(ref) !== HEAVY_KIND) return dps;
    const heavy = Number.isFinite(HV.battleDpsPermille) ? (dps * HV.battleDpsPermille) / PERMILLE : dps;
    const t = sentryTypeOf(ref.typeId);
    return t && t.family === "missile" && Number.isFinite(HV.missileDpsPermille)
      ? (heavy * HV.missileDpsPermille) / PERMILLE : heavy;
  }

  function battleDesignSigOf(ref, profile) {
    if (kindOf(ref) === HEAVY_KIND && Number.isSafeInteger(HV.designSig) && HV.designSig > 0) return HV.designSig;
    return Number.isFinite(profile.designSig) && profile.designSig > 0 ? profile.designSig : B.defaultDesignSig;
  }

  function observedNow(systemId) {
    const p = typeof deps.getPresence === "function" ? call(deps.getPresence, null) : null;
    if (!p || typeof p.distanceToObserved !== "function") return false;
    const d = call(() => p.distanceToObserved(systemId, 0), null);
    if (d && d.ok === true) return d.distance === 0;
    return !(d && d.reason === "PRESENCE_UNAVAILABLE");
  }

  function battleRound(ev, hctx, p) {
    const live = listLiveInSystem(p.systemId);
    if (live.length === 0) return { ok: true, outcome: "NO_SENTRIES" };
    const battle = battleFacade();
    if (battle === null) {
      lastRefusal = "battle:BATTLE_OFF";
      return { ok: true, outcome: "BATTLE_OFF", onCommitted: () => bump("battleRounds") };
    }
    const at = hctx && isTime(hctx.anchorAt) ? hctx.anchorAt : ev.dueAt;
    const gate = postGateOf(at);
    const refs = live.filter((r) => gate.allow(r));
    const offlinePosts = gate.offline();
    const jkey = S.attritionJournalKey(p.systemId, p.round);
    const read = tx("sentries.battleRead", (db) => {
      const seen = journal.findByKey(db, jkey);
      if (!seen || seen.ok !== true) throw new Rollback((seen && seen.reason) || "JOURNAL_READ_FAILED");
      if (seen.found) return { done: true };
      const fl = holdFleets(db, p.systemId);
      if (!fl.ok) throw new Rollback(fl.reason);
      return { done: false, fleets: fl.fleets, scope: gridScopeIn(db, p.systemId, fl.fleets, refs, at) };
    });
    if (!read.ok) return { ok: false, reason: read.reason };
    if (read.value.done) return { ok: true, outcome: STALE };
    const scope = read.value.scope;
    const noteScope = () => {
      if (scope.fallback) bump("battleGridFallback");
      bump("battleGridNoAnchor", scope.noAnchor);
    };
    const next = Math.max(p.round, roundOf(at)) + 1;
    const reschedule = { eventType: S.ATTRITION_EVENT_TYPE, aggregateId: String(p.systemId), dueAt: next * B.roundMs,
      payload: { systemId: p.systemId, round: next }, idempotencyKey: S.attritionKey(p.systemId, next) };
    const hostility = hostilityOf();
    const spec = { fleets: read.value.fleets, isHostileTo: (s, g) => hostility.isHostile(s, g), groups,
      settings: { maxFleetsPerSide: battleSettings.maxFleetsPerSide, maxSentriesPerBattle: B.maxSentriesPerBattle,
        damageTakenPermille: B.damageTakenPermille, attackerRetreatLossPermille: B.attackerRetreatLossPermille },
      ...(scope.grid !== null ? { grid: scope.grid } : {}) };
    const withScope = (r) => {
      if (B.gridEnabled !== true && offlinePosts === 0) return r;
      const inner = r.onCommitted;
      return { ...r, onCommitted: (v) => {
        if (B.gridEnabled === true) noteScope();
        bump("postOwnerOffline", offlinePosts);
        if (typeof inner === "function") inner(v);
      } };
    };
    if (observedNow(p.systemId)) {
      const plan = planSentryBattle({ ...spec, sentries: refs.map((r) => ({ ...r, hp: 1, dps: 0, signature: 1,
        designSig: 1 })) });
      if (plan.battle === null) return withScope({ ok: true, outcome: "ENDED" });
      return withScope({ ok: true, outcome: "OBSERVED", reschedule, onCommitted: () => bump("battleObservedSkips") });
    }
    const sentries = [];
    for (const ref of refs) {
      const r = seamCall("readSentryItem", ref.itemId);
      if (!r.ok || r.item.destroyed === true || !(Number.isSafeInteger(r.item.hp) && r.item.hp >= 1)) continue;
      const profile = seamCall("readSentryCombat", ref.typeId);
      if (!profile.ok) continue;
      const dps = profile.passive === true ? 0 : battleDpsOf(ref, r.item, profile.dps);
      sentries.push({ ...ref, hp: r.item.hp, dps, signature: profile.signature,
        designSig: battleDesignSigOf(ref, profile) });
    }
    const plan = planSentryBattle({ ...spec, sentries });
    if (plan.battle === null) {
      const miss = plan.reason === "NO_GRID_CONTACT";
      return withScope({ ok: true, outcome: plan.reason, onCommitted: () => {
        bump("battleRounds");
        if (miss) bump("battleGridMiss");
      } });
    }
    const b = plan.battle;
    const key = S.battleKey(p.systemId, p.round);
    const battleSpec = { systemId: p.systemId, at, sideA: { factionId: b.factionId, fleets: b.fleets },
      fixedDefenses: b.fixedDefenses };
    const gridRef = typeof b.gridKey === "string" ? parseRef(b.gridKey) : null;
    if (gridRef !== null && gridRef.kind !== "system") battleSpec.grid = gridRef;
    const payload = { systemId: p.systemId, round: p.round, factionId: b.factionId,
      fleetIds: b.fleets.map((f) => f.fleetId), sentryIds: b.fixedDefenses.entries.map((e) => e.sentryId) };
    return withScope({ ok: true, outcome: "BATTLE",
      effect: (db) => {
        let created = null;
        const j = journal.applyOnce(db, { key: jkey, aggregate: { type: ATTRITION_AGGREGATE, id: p.systemId },
          eventType: S.ATTRITION_EVENT_TYPE, payload }, (inner) => {
          const c = battle.createFixedDefenseBattleInTx(inner, battleSpec, key);
          if (!isPlain(c) || c.ok !== true) return isPlain(c) ? c : refuse("BATTLE_CREATE_FAILED");
          created = c;
          return { ok: true };
        });
        if (!j.ok) {
          const why = j.reason === "APPLY_REFUSED" && isPlain(j.refusal) ? j.refusal : j;
          lastRefusal = `battle:${why.reason}`;
          return { ok: false, reason: String(why.reason || "BATTLE_CREATE_FAILED"), permanent: why.permanent === true };
        }
        if (j.duplicate || created === null) return { ok: true, stale: true };
        return { ok: true, stale: false, battleId: created.battleId, duplicate: created.duplicate === true };
      },
      reschedule,
      onCommitted: (v) => {
        if (!isPlain(v) || v.stale === true) return;
        bump("battleRounds");
        if (v.duplicate !== true) bump("battlesCreated");
        log(`sentries: battle ${v.battleId} in ${p.systemId} round ${p.round} faction ${b.factionId} fleets `
          + `${b.fleets.length} sentries ${b.fixedDefenses.entries.length}${plan.more ? " (more holders wait)" : ""}`);
      } });
  }

  function onAttrition(ev, hctx) {
    try {
      const p = parseAttritionPayload(ev && ev.payload);
      if (!p) return { ok: false, reason: "SENTRY_PAYLOAD_INVALID", permanent: true };
      if (stopped()) return { ok: false, reason: "SENTRIES_STOPPED" };
      if (!battleOn()) return { ok: true, outcome: "BATTLE_OFF" };
      return battleRound(ev, hctx, p);
    } catch (err) {
      return { ok: false, reason: `SENTRY_ATTRITION_FAILED: ${messageOf(err)}` };
    }
  }

  function battleConsequence(tx, settled, ck) {
    if (!settled || !Array.isArray(settled.fixedDefenses) || settled.fixedDefenses.length === 0) {
      return { ok: true, skipped: true };
    }
    const withPrefix = (prefix) => settled.fixedDefenses.filter((e) => e && typeof e.sentryId === "string"
      && e.sentryId.startsWith(prefix)).length;
    if (withPrefix(S.FORTRESS_SENTRY_PREFIX) > 0) bump("battleFortressSkipped");
    if (withPrefix(S.TRANSIT_PICKET_PREFIX) > 0) bump("battleTransitSkipped");
    if (withPrefix(S.WORLD_BOSS_PREFIX) > 0) bump("battleWorldBossSkipped");
    const virtual = (id) => S.VIRTUAL_DEFENSE_PREFIXES.some((prefix) => id.startsWith(prefix));
    const entries = settled.fixedDefenses.filter((e) => e && typeof e.sentryId === "string" && isId(e.itemId)
      && !virtual(e.sentryId) && Number.isFinite(e.damage) && e.damage > 0);
    if (entries.length === 0) {
      return { ok: true, skipped: true };
    }
    const battleId = settled.battleId;
    if (!battleId || typeof battleId !== "string") {
      return { ok: false, reason: "INVALID_BATTLE_ID" };
    }
    const systemId = settled.systemId;
    if (!isId(systemId)) {
      return { ok: false, reason: "INVALID_SYSTEM_ID" };
    }
    const hits = [];
    for (const e of entries) {
      if (!Number.isSafeInteger(e.hp) || e.hp < 1 || !Number.isSafeInteger(e.ehp) || e.ehp < 1) continue;
      const destroyed = e.destroyed === true;
      const targetHp = destroyed ? 0 : Math.max(0, e.hp - Math.floor(e.damage * e.hp / e.ehp));
      hits.push({ sentryId: e.sentryId, itemId: e.itemId, targetHp });
    }
    if (hits.length === 0) {
      return { ok: true, skipped: true };
    }
    const at = isTime(settled.at) ? settled.at : now();
    const payload = { battleId, systemId, hits };
    const idempotencyKey = `sbdmg:${battleId}`;
    const r = scheduler.enqueue("SENTRY_BATTLE_DAMAGE",
      String(systemId), at, payload, idempotencyKey, { tx, chained: true });
    if (!r || r.ok !== true) {
      return { ok: false, reason: (r && r.reason) || "ENQUEUE_FAILED" };
    }
    return { ok: true, duplicate: r.duplicate === true, enqueued: idempotencyKey };
  }

  function onBattleDamage(ev, hctx) {
    try {
      const p = ev && ev.payload;
      if (!isPlain(p) || typeof p.battleId !== "string" || !isId(p.systemId) || !Array.isArray(p.hits)) {
        return { ok: false, reason: "SENTRY_PAYLOAD_INVALID", permanent: true };
      }
      if (stopped()) return { ok: false, reason: "SENTRIES_STOPPED" };
      const battleId = p.battleId;
      const systemId = p.systemId;
      const hits = p.hits;
      const atMs = hctx && isTime(hctx.now) ? hctx.now : (isTime(ev.dueAt) ? ev.dueAt : now());

      const jkey = S.battleJournalKey(battleId);
      const journalCheck = tx("sentries.battleDamageJournalCheck", (db) => {
        const seen = journal.findByKey(db, jkey);
        if (!seen || seen.ok !== true) throw new Rollback((seen && seen.reason) || "JOURNAL_READ_FAILED");
        return seen.found ? { stale: true } : { stale: false };
      });
      if (!journalCheck.ok) return { ok: false, reason: journalCheck.reason };
      if (journalCheck.value.stale) {
        bump("battleDamageStale");
        return { ok: true, outcome: "STALE" };
      }

      const liveRefs = new Map();
      for (const ref of listLiveInSystem(systemId)) {
        liveRefs.set(ref.sentryId, ref);
      }
      const validHits = [];
      for (const h of hits) {
        const ref = liveRefs.get(h.sentryId);
        if (!ref) continue;
        if (!isId(h.itemId) || h.itemId !== ref.itemId) continue;
        if (!Number.isSafeInteger(h.targetHp)) continue;
        validHits.push({ ref, targetHp: h.targetHp });
      }

      const applied = [];
      const destroyed = [];
      let refused = 0;
      for (const { ref, targetHp } of validHits) {
        const read = seamCall("readSentryItem", ref.itemId);
        if (!read.ok) {
          if (read.reason === "NOT_FOUND" || read.reason === "NOT_SENTRY") continue;
          refused += 1;
          lastRefusal = `battleDamage:${read.reason}`;
          continue;
        }
        const hp = read.item && Number.isSafeInteger(read.item.hp) ? read.item.hp : null;
        if (read.item.destroyed === true || hp === 0) {
          if (targetHp === 0) destroyed.push(ref.sentryId);
          continue;
        }
        if (hp === null) continue;
        const delta = hp - targetHp;
        if (delta < 1) continue;
        const r = seamCall("applySentryDamage", ref.itemId, delta, { offScene: true, atMs });
        if (!r.ok) {
          refused += 1;
          lastRefusal = `battleDamage:${r.reason}`;
          continue;
        }
        applied.push({ sentryId: ref.sentryId, itemId: ref.itemId, delta, destroyed: r.destroyed === true });
        if (r.destroyed === true) destroyed.push(ref.sentryId);
      }

      if (refused > 0) {
        bump("battleDamageRefused", refused);
        return { ok: false, reason: "NO_HITS_LANDED" };
      }

      return {
        ok: true,
        outcome: applied.length > 0 || destroyed.length > 0 ? "DAMAGE" : "NO_EFFECT",
        effect: (db) => {
          const j = journal.applyOnce(db, { key: jkey, aggregate: { type: S.AGGREGATE, id: battleId },
            eventType: "SENTRY_BATTLE_DAMAGE", payload: { battleId, systemId, hits: validHits.map((h) => ({
              sentryId: h.ref.sentryId, itemId: h.ref.itemId, targetHp: h.targetHp
            })) } }, () => ({ ok: true }));
          if (!j.ok) return j;
          if (j.duplicate) return { ok: true, stale: true, ended: [] };
          const ended = [];
          for (const sentryId of destroyed) {
            const m = markEndedInTx(db, sentryId, "BATTLE", atMs);
            if (m.ok) ended.push({ sentryId, itemId: m.itemId });
            else if (m.reason !== STALE) return m;
          }
          return { ok: true, stale: false, ended };
        },
        onCommitted: (v) => {
          if (!isPlain(v)) return;
          if (v.stale === true) {
            bump("battleDamageStale");
            return;
          }
          bump("battleDamageApplied", applied.length);
          for (const e of v.ended) {
            armed.delete(e.itemId);
            unindex(e.sentryId);
          }
          bump("battleKills", v.ended.length);
          bump("destroyed", v.ended.length);
          if (v.ended.length > 0) {
            setActiveGauge();
            log(`sentries: battle damage ${battleId} in ${systemId} destroyed ${v.ended.map((e) => e.sentryId).join(",")}`);
          }
        }
      };
    } catch (err) {
      return { ok: false, reason: `SENTRY_BATTLE_DAMAGE_FAILED: ${messageOf(err)}` };
    }
  }

  const bucketOf = (t) => Math.floor(t / C.reconcileIntervalMs);

  function onReconcile(ev, hctx) {
    try {
      const p = parseReconcilePayload(ev && ev.payload);
      if (!p) return { ok: false, reason: "SENTRY_PAYLOAD_INVALID", permanent: true };
      if (stopped()) return { ok: false, reason: "SENTRIES_STOPPED" };
      const at = hctx && isTime(hctx.anchorAt) ? hctx.anchorAt : ev.dueAt;
      const r = reconcile(at, p.afterSentryId);
      if (!r.ok) lastRefusal = r.reason;
      const next = Math.max(p.bucket, bucketOf(at)) + 1;
      return { ok: true, outcome: r.ok ? "RECONCILED" : "RECONCILE_FAILED",
        reschedule: { eventType: S.RECONCILE_EVENT_TYPE, aggregateId: S.RECONCILE_AGGREGATE_ID,
          dueAt: next * C.reconcileIntervalMs, payload: { bucket: next, afterSentryId: r.ok && r.next ? r.next : "" },
          idempotencyKey: S.reconcileKey(next) } };
    } catch (err) {
      return { ok: false, reason: `SENTRY_RECONCILE_FAILED: ${messageOf(err)}` };
    }
  }

  function bootstrap() {
    try {
      const bucket = bucketOf(now()) + 1;
      const t = tx("sentries.bootstrap", (db) => {
        const live = scheduler.findLiveOfType(S.RECONCILE_EVENT_TYPE, { tx: db });
        if (!live || live.ok !== true) return live || refuse("FIND_LIVE_FAILED");
        if (live.found) return { ok: true, joined: true, eventId: live.event.eventId };
        return scheduler.enqueue(S.RECONCILE_EVENT_TYPE, S.RECONCILE_AGGREGATE_ID, bucket * C.reconcileIntervalMs,
          { bucket, afterSentryId: "" }, S.reconcileKey(bucket), { tx: db });
      });
      if (!t.ok) return t;
      const r = t.value;
      if (r && r.ok === true && r.joined === true) {
        bump("reconcileChainJoined");
        return { ok: true, duplicate: true, joined: true, bucket };
      }
      if (r && r.ok === false && r.reason === "IDEMPOTENCY_CONFLICT") return { ok: true, duplicate: true, bucket };
      if (!r || !r.ok) return refuse((r && r.reason) || "ENQUEUE_FAILED");
      return { ok: true, duplicate: r.duplicate === true, bucket };
    } catch (err) {
      return refuse(`SENTRY_BOOTSTRAP_FAILED: ${messageOf(err)}`);
    }
  }

  function getStatus() {
    return Object.freeze({ state, armed: armed.size, lastRefusal, counters: Object.freeze({ ...counters }) });
  }

  return Object.freeze({
    anchor,
    online,
    isArmed,
    listLiveInSystem,
    kindOf,
    listLiveOfKind,
    ownerOnlineOf,
    markEnded,
    markEndedInTx,
    reconcile,
    rebuildArmed,
    onReconcile,
    bootstrap,
    getStatus,
    readForReview,
    requestBuildInTx,
    noteCommitted,
    onDeploy,
    onAttrition,
    onArrival,
    kickBattle,
    battleEnabled: () => battleOn(),
    chainEnabled: () => battleOn(),
    onGridArrival,
    battleGridEnabled: () => B.gridEnabled === true,
    battleConsequence,
    onBattleDamage,
    setNoAmmoTypes(typeIds) {
      noAmmoTypes.clear();
      for (const id of Array.isArray(typeIds) ? typeIds : []) if (isId(id)) noAmmoTypes.add(id);
    },
    noteSeamRefused: () => bump("seamRefused"),
    noteLookRefused: () => bump("lookRefused"),
    getMode: () => (stopped() ? "off" : "ready"),
    isStopped: stopped,
    stop() {
      state = "stopped";
      armed.clear();
      refs.clear();
      bySystem.clear();
      healedMarks.clear();
      topUpSeen.clear();
      if (memoryProbe && memoryProbe.ok === true) memoryProbe.unregister();
    },
  });
}

module.exports = { createSentryService, parseReconcilePayload, parseDeployPayload, parseAttritionPayload, ringPosition,
  sessionInfo, COUNTER_NAMES };
